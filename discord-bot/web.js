// /web/* — site → bot RPC for the aquilo.gg minigames page.
//
// aquilo-site's Pages Functions own the Patreon auth (aq_link cookie +
// per-session webSig CSRF token). When a logged-in patron clicks
// "Daily" / "Coinflip" / "Dice" on the website, the site Pages
// Function verifies the cookie, then HMAC-signs a request here. We
// trust the discordId the site claims as long as the HMAC verifies.
//
// Routes:
//   POST /web/wallet      { discordId, guildId }                  -> wallet snapshot
//   POST /web/daily       { discordId, guildId }                  -> daily claim
//   POST /web/coinflip    { discordId, guildId, bet }             -> { won, payout, balance }
//   POST /web/dice        { discordId, guildId, bet, target }     -> { won, roll, payout, balance }
//
// All POST so the HMAC body is always present and the signing
// scheme is uniform. HMAC = SHA-256 over `ts + "\n" + body`,
// hex-encoded. Headers: x-aquilo-web-ts, x-aquilo-web-sig. 5-min
// timestamp skew. Mirrors the /sync/:guildId scheme exactly.
//
// games.js is the single source of truth for daily / coinflip /
// dice — same code path that Discord's /loadout and the Twitch
// panel's /ext/daily already use. No surface drift possible.

import { coinflip, dice, daily } from './games.js';
import { getWallet } from './wallet.js';
import { recordStat } from './recap.js';
import { verifyHmac } from './auth.js';
import {
  getCatalog,
  getPrice,
  getHistory,
  getHoldings,
  runBuyJson,
  runSellJson,
} from './stocks.js';
import {
  publicSportsSnapshot,
  readGamesCache,
  refreshGamesCache,
  runPlaceJson,
  getUserBetsPublic,
} from './bet.js';
import {
  snapshotQueue,
  openQueue,
  closeQueue,
  closeNight,
  notifyQueueOpened,
} from './queue.js';
import {
  loadHero,
  attackOf,
  defenseOf,
  doInventory,
  doEquip,
  doUnequip,
  doSell,
  getDailyShop,
  doShopBuy,
} from './dungeon.js';
import {
  executeRaid,
  _editorTownBuild,
  _editorTownGarrison,
  canManageTown,
} from './clash.js';
import {
  BUILDINGS, TROOPS_GARRISON,
  withBuildingSprites, withGarrisonSprites,
  townBuildCost, townGarrisonCost,
} from './clash-content.js';
import { getTown, getTreasury } from './clash-state.js';

const ROUTES = new Set([
  'wallet',
  'daily',
  'coinflip',
  'dice',
  'stocks/snapshot',
  'stocks/buy',
  'stocks/sell',
  'bet/snapshot',
  'bet/place',
  'queues/snapshot',
  'queues/open',
  'queues/close',
  'queues/close-night',
  'hero',
  'equip',
  'unequip',
  'sell',
  'shop',
  'shop/buy',
  'dungeon/skip-cooldown',
  'clash/raid',
  'clash/build',
  'clash/garrison',
  'clash/town',
]);

// Only the bisherclay@gmail.com session is currently allowed to open
// or close queues from aquilo-site /admin. Owner-side gating happens
// on the site (functions/api/admin/queues/*) — we double-check here
// by requiring the request to carry a `_owner: true` flag the site
// stamps after verifying the aq_link cookie's `o:1` field.
function ownerCheck(body) {
  return body && body._owner === true;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export async function handleWeb(req, env) {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);

  if (!env.AQUILO_SITE_WEB_SECRET) {
    return json({ error: 'not-configured', message: 'AQUILO_SITE_WEB_SECRET missing on the bot' }, 503);
  }

  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/web\//, '').replace(/\/+$/, '');
  if (!ROUTES.has(route)) return json({ error: 'not-found' }, 404);

  // Read body once; verify HMAC against the raw bytes; only then parse.
  const bodyText = await req.text();
  const ts = req.headers.get('x-aquilo-web-ts');
  const sig = req.headers.get('x-aquilo-web-sig');
  const ok = await verifyHmac(env.AQUILO_SITE_WEB_SECRET, ts || '', bodyText, sig || '');
  if (!ok) return json({ error: 'unauthorized' }, 401);

  let body;
  try { body = JSON.parse(bodyText); } catch { return json({ error: 'bad-json' }, 400); }

  const discordId = String((body && body.discordId) || '').trim();
  const guildId = String((body && body.guildId) || '').trim();
  if (!/^\d{5,25}$/.test(discordId)) return json({ error: 'bad-discord-id' }, 400);
  if (!/^\d{5,25}$/.test(guildId))   return json({ error: 'bad-guild-id' }, 400);

  // Bot-side allow-list: only the Aquilo guild for now (matches /ext/*
  // and the Patreon-link flow on the site). Other guilds calling here
  // would imply someone forged a session, but we double-belt anyway.
  if (env.AQUILO_VAULT_GUILD_ID && guildId !== String(env.AQUILO_VAULT_GUILD_ID)) {
    return json({ error: 'forbidden-guild' }, 403);
  }

  try {
    if (route === 'wallet') return await routeWallet(env, guildId, discordId);
    if (route === 'daily')  return await routeDaily(env, guildId, discordId);
    if (route === 'coinflip') return await routeCoinflip(env, guildId, discordId, body);
    if (route === 'dice')   return await routeDice(env, guildId, discordId, body);
    if (route === 'stocks/snapshot') return await routeStocksSnapshot(env, guildId, discordId);
    if (route === 'stocks/buy')  return await routeStocksBuy(env, guildId, discordId, body);
    if (route === 'stocks/sell') return await routeStocksSell(env, guildId, discordId, body);
    if (route === 'bet/snapshot') return await routeBetSnapshot(env, guildId, discordId);
    if (route === 'bet/place')    return await routeBetPlace(env, guildId, discordId, body);
    if (route === 'queues/snapshot') return await routeQueuesSnapshot(env, guildId, body);
    if (route === 'queues/open') {
      if (!ownerCheck(body)) return json({ error: 'forbidden' }, 403);
      return await routeQueuesOpen(env, guildId, body);
    }
    if (route === 'queues/close') {
      if (!ownerCheck(body)) return json({ error: 'forbidden' }, 403);
      return await routeQueuesClose(env, guildId, body);
    }
    if (route === 'queues/close-night') {
      if (!ownerCheck(body)) return json({ error: 'forbidden' }, 403);
      return await routeQueuesCloseNight(env, guildId);
    }
    if (route === 'hero')     return await routeHero(env, guildId, discordId);
    if (route === 'equip')    return await routeEquip(env, guildId, discordId, body);
    if (route === 'unequip')  return await routeUnequip(env, guildId, discordId, body);
    if (route === 'sell')     return await routeSell(env, guildId, discordId, body);
    if (route === 'shop')     return await routeShop(env, guildId, discordId);
    if (route === 'shop/buy') return await routeShopBuy(env, guildId, discordId, body);
    if (route === 'dungeon/skip-cooldown') return await routeDungeonSkip(env, guildId, discordId);
    if (route === 'clash/raid')            return await routeClashRaid(env, guildId, discordId, body);
    if (route === 'clash/build')           return await routeClashBuild(env, guildId, discordId, body);
    if (route === 'clash/garrison')        return await routeClashGarrison(env, guildId, discordId, body);
    if (route === 'clash/town')            return await routeClashTown(env, guildId, discordId);
  } catch (e) {
    return json({ error: 'server', message: String((e && e.message) || e) }, 500);
  }
  return json({ error: 'not-found' }, 404);
}

async function routeWallet(env, guildId, userId) {
  const w = await getWallet(env, guildId, userId);
  return json({
    ok: true,
    wallet: {
      balance: w.balance || 0,
      lifetimeEarned: w.lifetimeEarned || 0,
      lifetimeSpent: w.lifetimeSpent || 0,
      dailyStreak: w.dailyStreak || 0,
      lastDailyUtc: w.lastDailyUtc || 0,
      lastDailyEtDate: w.lastDailyEtDate || null,
    },
  });
}

async function routeDaily(env, guildId, userId) {
  const r = await daily(env, guildId, userId);
  if (r.won) {
    // games_won bumps on a successful daily so the recap card's
    // "won X today" field reflects Daily claims too. bolts_earned
    // separately tracks the bolts the claim added.
    await recordStat(env, guildId, userId, {
      bolts_earned: r.payout || 0,
      games_won: 1,
    });
  }
  // Surface the post-claim wallet so the UI doesn't need a follow-up
  // round trip.
  const w = await getWallet(env, guildId, userId);
  return json({
    ok: r.won,
    error: r.won ? undefined : 'already-claimed',
    explanation: r.explanation,
    payout: r.payout || 0,
    streak: r.streak || w.dailyStreak || 0,
    balance: w.balance || 0,
  });
}

async function routeCoinflip(env, guildId, userId, body) {
  const bet = Number(body && body.bet);
  if (!Number.isFinite(bet) || bet <= 0) {
    return json({ ok: false, error: 'bad-bet', explanation: 'Bet must be a positive number.' }, 400);
  }
  const r = await coinflip(env, guildId, userId, bet);
  if (typeof r.payout !== 'number') {
    return json({ ok: false, error: 'rejected', explanation: r.explanation || 'Couldn\'t place that bet.' }, 400);
  }
  if (r.won) await recordStat(env, guildId, userId, { games_won: 1, bolts_earned: r.payout });
  else await recordStat(env, guildId, userId, { games_lost: 1, bolts_spent: -r.payout });
  const w = await getWallet(env, guildId, userId);
  return json({
    ok: true,
    won: r.won,
    payout: r.payout,
    balance: w.balance || 0,
    explanation: r.explanation,
  });
}

// ── Stocks ────────────────────────────────────────────────────────────
// Mirror the panel's read pattern (catalog + per-ticker price + tiny
// recent-history slice for sparklines), plus the caller's holdings +
// balance so the trade panel can render position size & cost basis.

async function routeStocksSnapshot(env, guildId, userId) {
  const [catalog, holdings, wallet] = await Promise.all([
    getCatalog(env),
    getHoldings(env, guildId, userId),
    getWallet(env, guildId, userId),
  ]);
  // Pull prices + a short history per ticker so the UI can chart trends
  // without a second call. The list is small (~20 tickers).
  const tickers = (catalog && catalog.tickers) || [];
  const priced = await Promise.all(
    tickers.map(async (def) => {
      const ticker = def && def.ticker;
      if (!ticker) return null;
      const [rec, history] = await Promise.all([
        getPrice(env, ticker),
        getHistory(env, ticker),
      ]);
      return {
        ticker,
        name: def.name || ticker,
        source: def.source || null,
        sourceRef: def.sourceRef || null,
        price: (rec && rec.price) || null,
        updatedAt: (rec && rec.updatedAt) || null,
        history: Array.isArray(history) ? history.slice(-24) : [],
        held: Number(holdings[ticker]) || 0,
      };
    }),
  );
  return json({
    ok: true,
    tickers: priced.filter(Boolean),
    balance: wallet.balance || 0,
    feePct: 1,
  });
}

async function routeStocksBuy(env, guildId, userId, body) {
  const ticker = String(body && body.ticker || '').toUpperCase();
  const bolts = Number(body && body.bolts);
  if (!ticker) return json({ ok: false, error: 'bad-ticker', message: 'Pick a ticker.' }, 400);
  if (!Number.isFinite(bolts) || bolts <= 0) {
    return json({ ok: false, error: 'bad-bolts', message: 'Bolts must be a positive number.' }, 400);
  }
  const r = await runBuyJson(env, guildId, userId, { ticker, bolts: Math.floor(bolts) });
  // Buy and sell don't write to recap stats today (Discord's stock
  // command never has either). Leave it that way for now -- stocks
  // are a separate ledger from the "games_won/lost" win-rate stat.
  return json(r, r.ok ? 200 : 400);
}

async function routeStocksSell(env, guildId, userId, body) {
  const ticker = String(body && body.ticker || '').toUpperCase();
  const shares = Number(body && body.shares);
  if (!ticker) return json({ ok: false, error: 'bad-ticker', message: 'Pick a ticker.' }, 400);
  if (!Number.isInteger(shares) || shares <= 0) {
    return json({ ok: false, error: 'bad-shares', message: 'Shares must be a positive integer.' }, 400);
  }
  const r = await runSellJson(env, guildId, userId, { ticker, shares });
  return json(r, r.ok ? 200 : 400);
}

// ── Sports betting ────────────────────────────────────────────────────
// Snapshot pulls the public games list (~48h window) and the caller's
// active + recent-history bets. /web/bet/place runs the same runPlace
// flow Discord's /bet sports place uses; settlement still happens via
// the existing :23 cron tick (betCronTick).

async function routeBetSnapshot(env, guildId, userId) {
  let games = await readGamesCache(env);
  if (games.length === 0) games = await refreshGamesCache(env);
  const [bets, wallet] = await Promise.all([
    getUserBetsPublic(env, guildId, userId),
    getWallet(env, guildId, userId),
  ]);
  // 48h pre-game window only -- same slice the panel surfaces.
  const cutoff = Date.now() + 48 * 60 * 60 * 1000;
  const upcoming = games.filter((g) => g && g.state === 'pre' && (g.startUtc || 0) <= cutoff);
  return json({
    ok: true,
    games: upcoming,
    active: Array.isArray(bets.active) ? bets.active : [],
    history: Array.isArray(bets.history) ? bets.history.slice(-20).reverse() : [],
    balance: wallet.balance || 0,
  });
}

async function routeBetPlace(env, guildId, userId, body) {
  const gameId = String(body && body.gameId || '').trim();
  const side = String(body && body.side || '').toLowerCase();
  const bolts = Number(body && body.bolts);
  if (!gameId) return json({ ok: false, error: 'bad-game', message: 'Pick a game.' }, 400);
  if (side !== 'home' && side !== 'away') {
    return json({ ok: false, error: 'bad-side', message: 'Side must be home or away.' }, 400);
  }
  if (!Number.isFinite(bolts) || bolts <= 0) {
    return json({ ok: false, error: 'bad-bolts', message: 'Bolts must be a positive number.' }, 400);
  }
  const r = await runPlaceJson(env, guildId, userId, {
    game: gameId,
    side,
    bolts: Math.floor(bolts),
  });
  return json(r, r.ok ? 200 : 400);
}

// ── Queue (Community / Variety Night) ─────────────────────────────────

async function routeQueuesSnapshot(env, guildId, body) {
  const date = body && body.streamDate ? String(body.streamDate) : null;
  const snap = await snapshotQueue(env, guildId, date);
  return json({ ok: true, ...snap });
}

async function routeQueuesOpen(env, guildId, body) {
  const r = await openQueue(env, guildId, {
    gameId: String(body && body.gameId || '').trim(),
    capMode: body && body.capMode,
    cap: body && body.cap,
    source: 'web',
  });
  // If this is the FIRST queue of the night, fire the PWA push fan-out
  // via the site's /api/push/queue-open receiver. Best-effort -- a
  // failed push doesn't block the queue from opening.
  if (r.ok) {
    try {
      await notifyQueueOpened(env, guildId, r.streamDate, r.gameId);
    } catch (e) {
      console.error('queue-open push notify failed:', e && e.message);
    }
  }
  return json(r, r.ok ? 200 : 400);
}

async function routeQueuesClose(env, guildId, body) {
  const r = await closeQueue(env, guildId, String(body && body.gameId || '').trim());
  return json(r, r.ok ? 200 : 400);
}

async function routeQueuesCloseNight(env, guildId) {
  const r = await closeNight(env, guildId);
  return json(r, r.ok ? 200 : 400);
}

// ── Hero / Inventory / Equip / Unequip / Sell (Phase 2) ───────────────

async function routeHero(env, guildId, userId) {
  const hero = await loadHero(env, guildId, userId);
  const { bag, equipped } = await doInventory(env, guildId, userId);
  return json({
    ok: true,
    hero: {
      name: hero.name || '',
      class: hero.class || 'rogue',
      level: hero.level || 1,
      hp: hero.hp || 0,
      maxHp: hero.maxHp || 0,
      attack: attackOf(hero),
      defense: defenseOf(hero),
      portrait: hero.portrait || null,
    },
    bag: Array.isArray(bag) ? bag : [],
    equipped: equipped || {},
  });
}

async function routeEquip(env, guildId, userId, body) {
  const id = String(body && body.itemId || '').trim();
  if (!id) return json({ ok: false, error: 'bad-args', message: 'Pick an item.' }, 400);
  const r = await doEquip(env, guildId, userId, id);
  if (!r.ok) {
    const msg = r.reason === 'not-found'
      ? `No item starting with \`${id}\` in your bag.`
      : 'That item has no equip slot.';
    return json({ ok: false, error: r.reason, message: msg }, 400);
  }
  return json({ ok: true, item: r.item, message: `Equipped ${r.item.name}.` });
}

async function routeUnequip(env, guildId, userId, body) {
  const slot = String(body && body.slot || '').trim().toLowerCase();
  if (!slot) return json({ ok: false, error: 'bad-args', message: 'Pick a slot.' }, 400);
  const r = await doUnequip(env, guildId, userId, slot);
  if (!r.ok) return json({ ok: false, error: r.reason, message: `Nothing equipped in ${slot}.` }, 400);
  return json({ ok: true, slot, message: `Unequipped ${slot}.` });
}

async function routeSell(env, guildId, userId, body) {
  const id = String(body && body.itemId || '').trim();
  if (!id) return json({ ok: false, error: 'bad-args', message: 'Pick an item.' }, 400);
  const r = await doSell(env, guildId, userId, id);
  if (!r.ok) return json({ ok: false, error: r.reason, message: `No item starting with \`${id}\`.` }, 400);
  return json({ ok: true, item: r.item, refund: r.refund, message: `Sold for ${r.refund} bolts.` });
}

// ── Shop (Phase 3) ────────────────────────────────────────────────────

async function routeShop(env, guildId, userId) {
  const stock = await getDailyShop(env, guildId);
  // getDailyShop returns { date, items: [[slot, rarity, name, glyph, atk, def, price, setName, weaponType, preferredClass, ability], ...] }
  // Reshape to JSON-friendly objects.
  const items = (stock && stock.items ? stock.items : []).map((row) => ({
    slot: row[0],
    rarity: row[1],
    name: row[2],
    glyph: row[3],
    powerBonus: row[4] || 0,
    defenseBonus: row[5] || 0,
    price: row[6] || 0,
    setName: row[7] || '',
    weaponType: row[8] || '',
    preferredClass: row[9] || '',
    ability: row[10] || '',
  }));
  const w = await getWallet(env, guildId, userId);
  return json({
    ok: true,
    date: stock && stock.date,
    items,
    balance: w.balance || 0,
  });
}

async function routeShopBuy(env, guildId, userId, body) {
  const name = String(body && body.name || '').trim();
  if (!name) return json({ ok: false, error: 'bad-args', message: 'Pick an item.' }, 400);
  const r = await doShopBuy(env, guildId, userId, name);
  if (!r.ok) {
    const msg = r.reason === 'not-in-stock'
      ? "That item isn't in today's shop stock."
      : r.reason === 'insufficient'
      ? `Need ${r.price} bolts; you have ${r.balance}.`
      : 'Couldn\'t buy — try again.';
    return json({ ok: false, error: r.reason, message: msg, ...r }, 400);
  }
  const w = await getWallet(env, guildId, userId);
  return json({
    ok: true,
    item: r.item || null,
    balance: w.balance || 0,
    message: `Bought ${r.item ? r.item.name : 'item'}.`,
  });
}

// ── Dungeon skip-cooldown (Phase 4 — patron-gated) ────────────────────
//
// Patron-only at the moment. Any active aq_link session is treated
// as "patron" (the cookie's `o:1` is the only stored flag; a proper
// tier lookup belongs in a separate effort). Once per 10-min stream
// cooldown per viewer, enforced by a webskip:<userId> TTL key.
//
// On success we enqueue the same relay:dll-pending record the panel's
// /ext/dungeon/skip-cooldown writes, so the DLL processes web-side
// skips identically to Bits-paid panel skips.

const WEB_SKIP_TTL_S = 10 * 60; // 10 minutes
const WEB_SKIP_KEY = (uid) => `webskip:${uid}`;

async function routeDungeonSkip(env, guildId, userId) {
  // Allow-list check: prevent users without a Patreon tier from
  // exhausting the cooldown skip every 10 minutes. Today we trust
  // any linked Discord session (Clay's signed-off "Patron-gated"
  // assumes the /link callback minted the cookie). TODO: tighten
  // to active-tier check when Patreon tier lands in the session.
  const recent = await env.LOADOUT_BOLTS.get(WEB_SKIP_KEY(userId));
  if (recent) {
    return json({
      ok: false,
      error: 'cooldown',
      message: 'Already used your skip this cooldown.',
    }, 429);
  }
  await env.LOADOUT_BOLTS.put(WEB_SKIP_KEY(userId), String(Date.now()), {
    expirationTtl: WEB_SKIP_TTL_S,
  });

  // Enqueue the skip command for the DLL. Same shape ext-panelbridge
  // uses; PanelBridgeModule stamps the trusted skip flag.
  const record = {
    kind: 'dungeon',
    action: 'skip',
    arg: '',
    user: { id: String(userId), name: 'web-patron', role: 'viewer' },
    ts: Date.now(),
  };
  const key = 'relay:dll-pending:' + record.ts + '-' + Math.random().toString(36).slice(2, 8);
  await env.LOADOUT_BOLTS.put(key, JSON.stringify(record), { expirationTtl: 90 });

  return json({ ok: true, message: 'Cooldown skip queued. Watch the stream.' });
}

async function routeDice(env, guildId, userId, body) {
  const bet = Number(body && body.bet);
  const target = Number(body && body.target);
  if (!Number.isFinite(bet) || bet <= 0) {
    return json({ ok: false, error: 'bad-bet', explanation: 'Bet must be a positive number.' }, 400);
  }
  if (!Number.isInteger(target) || target < 1 || target > 6) {
    return json({ ok: false, error: 'bad-target', explanation: 'Target must be 1-6.' }, 400);
  }
  const r = await dice(env, guildId, userId, bet, target);
  if (typeof r.payout !== 'number') {
    return json({ ok: false, error: 'rejected', explanation: r.explanation || 'Couldn\'t place that bet.' }, 400);
  }
  if (r.won) await recordStat(env, guildId, userId, { games_won: 1, bolts_earned: r.payout });
  else await recordStat(env, guildId, userId, { games_lost: 1, bolts_spent: -r.payout });
  const w = await getWallet(env, guildId, userId);
  return json({
    ok: true,
    won: r.won,
    roll: r.roll,
    payout: r.payout,
    balance: w.balance || 0,
    explanation: r.explanation,
  });
}

// POST /web/clash/raid
//
// Web mirror of the `/clash raid` Discord slash command. Same code
// path (clash.js executeRaid) — same token-consume, same simulator,
// same loot economy, same shields + war scoring + push notifications
// and bus events. The only difference is the response shape:
// structured JSON the web UI can render directly, no Discord-flavoured
// formatting.
//
// Body fields:
//   discordId   the attacker (set by the site session)
//   guildId     the attacker's home channel (set by the site session,
//               guild-allow-list checked above)
//   kind        'goblin' | 'npc' | 'player'
//   userName    optional display name; defaults to "viewer" if absent.
//               Used in push titles + ring-buffer events so the OBS
//               overlay shows the right person.
//
// Returns the executeRaid structured result verbatim (see clash.js).
// HTTP status is always 200 — errors come back as `{ ok:false, error,
// ... }` so the UI can render specific copy per case.
async function routeClashRaid(env, guildId, userId, body) {
  const kind = String((body && body.kind) || '').toLowerCase();
  if (kind !== 'goblin' && kind !== 'npc' && kind !== 'player') {
    return json({ ok: false, error: 'bad-kind', message: 'kind must be goblin, npc, or player' }, 400);
  }
  const userName = String((body && body.userName) || '').trim() || 'viewer';
  const r = await executeRaid(env, guildId, userId, userName, kind);
  return json({ ok: !!r.ok, ...r });
}

// ── /web/clash/build ─────────────────────────────────────────────
//
// Drop-in for the slash command `/clash town build kind:<...>
// buildingId:<...?>` — same code path (clash.js handleTownBuild via
// _editorTownBuild adapter) so all the validation, treasury maths,
// hero-level gate, build-queue mutation, and cooldown plumbing
// happen exactly once.
//
// Gated by canManageTown — only the streamer + designated mods can
// queue town builds. The site verifies the Patreon session → Discord
// link before signing this request, so the discordId we receive has
// already been authenticated. We re-check ownership/mod status here
// against the bot-side town record (defence-in-depth).
//
// Body fields:
//   discordId   the acting user (mod or streamer, set by site session)
//   guildId     the target town's guild
//   kind        building kind — townhall|wall|cannon|archerTower|trap|
//               storage|barracks|warTent
//   buildingId  (optional) numeric id of an existing building. If
//               present → upgrade that building one level. If absent
//               → build a new one of `kind` at the next free tile.
//
// Response:
//   { ok: true,  message: "🏗 Upgrading Wall #4 → L3. Ready in 30 min." }
//   { ok: false, error: 'permission', message: "🔒 ..." }
//   { ok: false, error: 'badkind'|'treasury'|'maxlevel'|'herogate'|'badbuilding',
//     message: "❌ ..." }
//
// HTTP status is always 200 — the structured `ok` flag is the source
// of truth; the message string is the Discord-formatted user copy
// the UI can display verbatim. (Mirrors /web/clash/raid contract.)
function classifyBuildMessage(msg) {
  if (typeof msg !== 'string' || !msg) return { ok: false, error: 'unknown' };
  if (msg.startsWith('🏗') || msg.startsWith('⛺')) return { ok: true };
  if (msg.startsWith('🔒')) return { ok: false, error: 'permission' };
  if (msg.includes('Treasury short'))     return { ok: false, error: 'treasury' };
  if (msg.includes('maxed') || msg.includes('Max level')) return { ok: false, error: 'maxlevel' };
  if (msg.includes('needs at least one community hero')) return { ok: false, error: 'herogate' };
  if (msg.includes('Unknown building'))   return { ok: false, error: 'badkind' };
  if (msg.includes('Unknown garrison'))   return { ok: false, error: 'badtroop' };
  if (msg.includes('No building with id')) return { ok: false, error: 'badbuilding' };
  return { ok: false, error: 'other' };
}

async function routeClashBuild(env, guildId, userId, body) {
  const kind = String((body && body.kind) || '').trim();
  const buildingId = body && body.buildingId != null ? String(body.buildingId).trim() : null;
  if (!kind || !BUILDINGS[kind]) {
    return json({ ok: false, error: 'badkind', message: '❌ Unknown building. Try: ' + Object.keys(BUILDINGS).join(', ') }, 200);
  }
  // Belt-and-braces — _editorTownBuild also checks but we want a
  // distinct error code instead of leaning on the embedded copy.
  if (!await canManageTown(env, guildId, userId)) {
    return json({ ok: false, error: 'permission', message: '🔒 Only the streamer + designated mods can queue town builds.' }, 200);
  }
  const message = await _editorTownBuild(env, guildId, userId, kind, buildingId);
  const cls = classifyBuildMessage(message);
  return json({ ...cls, message });
}

// ── /web/clash/garrison ──────────────────────────────────────────
//
// Mirror of `/clash town garrison troop:<...> count:<n>`. Same gate,
// same code path (handleTownGarrison via _editorTownGarrison).
//
// Body fields:
//   discordId   the acting user
//   guildId     the target town
//   troopId     scrapper | boltKnight | voltaicMage | archerLite
//   count       1..20 (clamped server-side)
async function routeClashGarrison(env, guildId, userId, body) {
  const troopId = String((body && body.troopId) || '').trim();
  const count = Math.max(1, Math.min(20, Number((body && body.count) || 1) || 1));
  if (!troopId || !TROOPS_GARRISON[troopId]) {
    return json({ ok: false, error: 'badtroop', message: '❌ Unknown garrison troop. Try: ' + Object.keys(TROOPS_GARRISON).join(', ') }, 200);
  }
  if (!await canManageTown(env, guildId, userId)) {
    return json({ ok: false, error: 'permission', message: '🔒 Only the streamer + designated mods can train town garrison.' }, 200);
  }
  const message = await _editorTownGarrison(env, guildId, userId, troopId, count);
  const cls = classifyBuildMessage(message);
  return json({ ...cls, message });
}

// ── /web/clash/town ──────────────────────────────────────────────
//
// Convenience read for the website's town-management UI — same
// payload as the public GET /clash/town/<guildId> route but reached
// through the /web/* HMAC channel (so the site can hide private
// details from public callers later without breaking its own UI).
// Buildings come pre-enriched with spriteId per entry; garrison
// counts come with a parallel sprites map.
async function routeClashTown(env, guildId, userId) {
  const town = await getTown(env, guildId);
  if (!town) return json({ ok: false, error: 'no-town', message: 'no town for this guild' }, 200);
  if (!await canManageTown(env, guildId, userId)) {
    return json({ ok: false, error: 'permission', message: '🔒 Only the streamer + designated mods can read the management view.' }, 200);
  }
  const treasury = await getTreasury(env, guildId);
  // Pre-compute upgrade preview per building (cost + time for next
  // level) so the UI can render "Upgrade →" buttons without a second
  // round trip per building.
  const buildings = (town.buildings || []).map(b => {
    const def = BUILDINGS[b.kind] || {};
    const maxLevel = (def.hp?.length || 2) - 1;
    const nextLevel = (b.level || 1) + 1;
    const nextCost = nextLevel <= maxLevel ? townBuildCost(b.kind, nextLevel) : null;
    return {
      ...b,
      spriteId: `clash/buildings/${b.kind}-L${b.level || 1}.png`,
      maxLevel,
      nextLevel: nextLevel <= maxLevel ? nextLevel : null,
      nextCost: nextCost ? { cost: nextCost.cost, timeMs: nextCost.timeMs } : null,
    };
  });
  // Available "new build" kinds + their L1 costs.
  const newBuildOptions = Object.keys(BUILDINGS).map(k => {
    const c = townBuildCost(k, 1);
    return {
      kind: k,
      name: BUILDINGS[k].name,
      glyph: BUILDINGS[k].glyph,
      spriteId: `clash/buildings/${k}-L1.png`,
      cost: c ? c.cost : null,
      timeMs: c ? c.timeMs : null,
    };
  });
  const garrison = town.garrison || {};
  const garrisonSprites = withGarrisonSprites(garrison).sprites;
  const garrisonOptions = Object.keys(TROOPS_GARRISON).map(t => {
    const c = townGarrisonCost(t, 1);
    return {
      troopId: t,
      name: TROOPS_GARRISON[t].name,
      glyph: TROOPS_GARRISON[t].glyph,
      spriteId: `clash/troops/${t}.png`,
      bolts: c ? c.bolts : null,
      timeMs: c ? c.timeMs : null,
    };
  });
  return json({
    ok: true,
    guildId,
    thLevel: town.thLevel,
    treasury,
    buildings,
    garrison,
    garrisonSprites,
    newBuildOptions,
    garrisonOptions,
    layoutVersion: town.layoutVersion,
  });
}
