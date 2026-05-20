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
]);

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
