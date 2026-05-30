// Boltbound — /web/boltbound/* + /ext/boltbound/* route handlers.
//
// Authoritative game logic lives in cards-*.js. This module is the
// thin web glue: bootstrap one read for the page-load surface
// (`state`), then thin wrappers around each user action that the
// site / panel can call.
//
// Auth is enforced upstream by web.js (HMAC) and ext.js (JWT). Both
// dispatch into routeBoltbound() below with a `(env, guildId, userId,
// route, body)` signature; we don't re-check auth here.

import { CARDS, CHAMPIONS } from './cards-content.js';
import {
  getCollection, ensureCollection,
  getActiveDeckId,
  listPendingPacks,
  getActiveMatch, readLog, getTrophies,
  hasClaimedFreePackToday,
  newId,
} from './cards-state.js';
import {
  saveDeck, dropDeck, activateDeck, listDeckSummaries, buildStarterDeck,
} from './cards-decks.js';
import {
  buyPack, openPack, claimDailyFreePack, creditPack,
} from './cards-packs.js';
import {
  proposeTrade, acceptTrade, declineTrade, cancelTrade,
  getTrade, listTrades, tradeableCollection,
} from './cards-trade.js';
import { sendDm } from './aquilo/util.js';
import {
  getFragments, recycleCard, craftPack,
  RECYCLE_YIELD, CRAFT_COST,
} from './cards-fragments.js';
import {
  startNpcMatch, queueOrMatchPvp, challengeUser, acceptChallenge,
  takeAction, takeMulligan, renderableState, sideOf,
} from './cards-match.js';
import { loadHero } from './dungeon.js';
import { getWallet } from './wallet.js';

const ROUTES = new Set([
  'boltbound/state',
  'boltbound/catalogue',
  'boltbound/decks/save',
  'boltbound/decks/delete',
  'boltbound/decks/activate',
  'boltbound/decks/starter',
  'boltbound/packs/buy',
  'boltbound/packs/open',
  'boltbound/packs/free-daily',
  'boltbound/match/start-npc',
  'boltbound/match/queue',
  'boltbound/match/challenge',
  'boltbound/match/accept',
  'boltbound/match/state',
  'boltbound/match/action',
  'boltbound/match/mulligan',
  'boltbound/match/concede',
  'boltbound/log',
  // CR-1: recycle/craft surface
  'boltbound/fragments',
  'boltbound/recycle',
  'boltbound/craft',
  // T-1: player-to-player card trading
  'boltbound/trade/propose',
  'boltbound/trade/list',
  'boltbound/trade/get',
  'boltbound/trade/accept',
  'boltbound/trade/decline',
  'boltbound/trade/cancel',
  'boltbound/trade/collection',
]);

// Read-only sub-routes the proxy may skip rate-limit for.
const READ_ROUTES = new Set([
  'boltbound/state',
  'boltbound/catalogue',
  'boltbound/match/state',
  'boltbound/log',
  'boltbound/fragments',
  'boltbound/trade/list',
  'boltbound/trade/get',
  'boltbound/trade/collection',
]);

export function isBoltboundRoute(r) { return ROUTES.has(r); }
export function isBoltboundReadRoute(r) { return READ_ROUTES.has(r); }

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
function jsonCors(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'Authorization, Content-Type',
    },
  });
}

// ── Routes ──────────────────────────────────────────────────────────

// Page-load bootstrap. One round-trip: everything the deck-builder +
// match UI need to render without follow-ups.
async function routeState(env, guildId, userId) {
  const hero = await loadHero(env, guildId, userId).catch(() => null);
  const className = (hero && hero.className) || 'warrior';
  const champId = CHAMPIONS[className]?.id || CHAMPIONS.warrior.id;

  // Bootstrap a collection if first-time (mirrors what /boltbound status
  // does on Discord) so the website is the same kind of "I just opened
  // the game" experience.
  const { isNew, collection } = await ensureCollection(env, guildId, userId, className);
  let welcomePack = null;
  if (isNew) {
    // First-time on this guild: credit a welcome Common Pack
    // (same rule as cards.js renderStatus).
    welcomePack = await creditPack(env, guildId, userId, 'common', 'welcome-web');
  }

  const { listAllGlobalArt }     = await import('./cards-global-art.js');
  const { listAllPixelArtMaps }  = await import('./pixel-art-maps.js');

  // 2026-05-30 — per-user meme-skin override feature removed. The
  // bootstrap no longer reads cards-art-override or includes an
  // `artOverrides` map. globalArt + pixelArtMaps remain as the only
  // art-override layers. The cards-art-override.js module stays on
  // disk for historical reference; its read paths are dead code.
  const [deckSummaries, activeDeckId, pendingPacks, log, trophies, wallet, freeClaimed, fragments, globalArt, pixelArtMaps] = await Promise.all([
    listDeckSummaries(env, guildId, userId),
    getActiveDeckId(env, guildId, userId),
    listPendingPacks(env, guildId, userId, 30),
    readLog(env, guildId, userId),
    getTrophies(env, userId),
    getWallet(env, guildId, userId),
    hasClaimedFreePackToday(env, guildId, userId),
    getFragments(env, userId),
    listAllGlobalArt(env),
    // 2026-05-29 asset overhaul P3-P6 — four new globalArt sibling
    // maps (hero / gear / clash / pet). Cheap: 4 parallel KV list
    // calls, no per-key GETs (URLs are deterministic from key names).
    listAllPixelArtMaps(env),
  ]);

  const activeMatch = await getActiveMatch(env, guildId, userId);
  const matchView = activeMatch ? renderableState(activeMatch, userId) : null;

  return json({
    ok: true,
    champion: { id: champId, className },
    collection: {
      cards: collection.cards || {},
      total: Object.values(collection.cards || {}).reduce((a, b) => a + b, 0),
    },
    decks: deckSummaries,
    activeDeckId: activeDeckId || null,
    // Pending packs are stored as { id, packType, source, mintedUtc,
    // rolled } in KV (see cards-state.js mintPendingPack). The client
    // contract uses `packId` for the key, so map id -> packId here.
    pendingPacks: pendingPacks.map(p => ({
      packId: p.id,
      packType: p.packType,
      source: p.source,
      opened: !!(p.rolled && p.rolled.length),
      mintedUtc: p.mintedUtc,
    })),
    // creditPack() returns { ok, pack: rec }; pull packId + packType out
    // of the inner record, not the outer wrapper.
    welcomePack: welcomePack && welcomePack.pack
      ? { packId: welcomePack.pack.id, packType: welcomePack.pack.packType }
      : null,
    log: (log || []).slice(0, 10),
    trophies: trophies || { trophies: 0, peak: 0, season: 1 },
    wallet: { balance: wallet.balance || 0 },
    freePackClaimedToday: !!freeClaimed,
    // CR-1 — fragment balance + craft economy constants. Page can
    // render the "Craft Pack" CTA + balance chip without follow-up.
    fragments: {
      balance: fragments || 0,
      recycleYield: RECYCLE_YIELD,
      craftCost: CRAFT_COST,
    },
    // 2026-05-30 — `artOverrides` removed alongside the meme-skin
    // feature pull. Site renderer precedence is now just:
    //   gifUrl = globalArt[cardId] || baked
    // Global card-art defaults — backfilled via the Giphy auto-match.
    globalArt,
    // 2026-05-29 asset overhaul P3-P6 — pixel-art maps for hero,
    // gear, clash, and pet renderers. Same precedence pattern as
    // globalArt: site renderer checks the map first, falls back to
    // baked sprite on a miss. See pixel-art-maps.js for shape.
    ...pixelArtMaps,
    match: matchView,
  });
}

// Card catalogue — public read-only (no per-viewer state). Cached on
// the worker side via a long s-maxage so the page-load fetch is cheap.
async function routeCatalogue() {
  const cards = Object.fromEntries(
    Object.values(CARDS).map(c => [c.id, {
      id: c.id, name: c.name, rarity: c.rarity, type: c.type,
      mana: c.mana, atk: c.atk, hp: c.hp,
      keywords: c.keywords, text: c.text, token: c.token,
      needsTarget: c.needsTarget,
      spriteId: c.spriteId,
    }]),
  );
  return new Response(JSON.stringify({ ok: true, version: 1, cards }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=60, s-maxage=300',
    },
  });
}

async function routeDecksSave(env, guildId, userId, body) {
  const deckId = String((body && body.deckId) || '').trim() || newId();
  const name   = String((body && body.name)   || 'Deck').slice(0, 32);
  const cards  = Array.isArray(body?.cards) ? body.cards.map(String) : [];
  const hero = await loadHero(env, guildId, userId).catch(() => null);
  const className = (hero && hero.className) || 'warrior';
  const r = await saveDeck(env, guildId, userId, { id: deckId, name, cards }, className);
  return json(r);
}
async function routeDecksDelete(env, guildId, userId, body) {
  const deckId = String((body && body.deckId) || '');
  if (!deckId) return json({ ok: false, error: 'bad-deck' }, 400);
  const r = await dropDeck(env, guildId, userId, deckId);
  return json(r);
}
async function routeDecksActivate(env, guildId, userId, body) {
  const deckId = String((body && body.deckId) || '');
  if (!deckId) return json({ ok: false, error: 'bad-deck' }, 400);
  const r = await activateDeck(env, guildId, userId, deckId);
  return json(r);
}
async function routeDecksStarter(env, guildId, userId) {
  const hero = await loadHero(env, guildId, userId).catch(() => null);
  const className = (hero && hero.className) || 'warrior';
  const col = await getCollection(env, guildId, userId);
  const deck = buildStarterDeck(col, className);
  const r = await saveDeck(env, guildId, userId, deck, className);
  if (r.ok) await activateDeck(env, guildId, userId, r.deck.id);
  return json(r);
}

async function routePacksBuy(env, guildId, userId, body) {
  const packType = String((body && body.packType) || 'bolt');
  const r = await buyPack(env, guildId, userId, packType);
  return json(r);
}
async function routePacksOpen(env, guildId, userId, body) {
  const packId = String((body && body.packId) || '');
  if (!packId) return json({ ok: false, error: 'bad-pack' }, 400);
  const r = await openPack(env, guildId, userId, packId);
  return json(r);
}
async function routePacksFreeDaily(env, guildId, userId) {
  const r = await claimDailyFreePack(env, guildId, userId);
  return json(r);
}

async function routeMatchStartNpc(env, guildId, userId, body) {
  const archetype = String((body && body.archetype) || '');
  const r = await startNpcMatch(env, guildId, userId, archetype || null);
  if (r.ok) return json({ ok: true, match: renderableState(r.match, userId) });
  return json(r);
}
async function routeMatchQueue(env, guildId, userId) {
  const r = await queueOrMatchPvp(env, guildId, userId);
  if (r.ok && r.match) return json({ ok: true, match: renderableState(r.match, userId) });
  return json(r);
}
async function routeMatchChallenge(env, guildId, userId, body) {
  const recipientId = String((body && body.recipientId) || '');
  if (!/^\d{5,25}$/.test(recipientId)) return json({ ok: false, error: 'bad-recipient' }, 400);
  const r = await challengeUser(env, guildId, userId, recipientId);
  return json(r);
}
async function routeMatchAccept(env, guildId, userId, body) {
  const senderId = String((body && body.senderId) || '');
  if (!/^\d{5,25}$/.test(senderId)) return json({ ok: false, error: 'bad-sender' }, 400);
  const r = await acceptChallenge(env, guildId, userId, senderId);
  if (r.ok) return json({ ok: true, match: renderableState(r.match, userId) });
  return json(r);
}
async function routeMatchState(env, guildId, userId) {
  const m = await getActiveMatch(env, guildId, userId);
  if (!m) return json({ ok: true, match: null });
  return json({ ok: true, match: renderableState(m, userId) });
}
async function routeMatchAction(env, guildId, userId, body) {
  const m = await getActiveMatch(env, guildId, userId);
  if (!m) return json({ ok: false, error: 'no-active-match' });
  const side = sideOf(m, userId);
  if (!side) return json({ ok: false, error: 'not-in-match' });

  const kind = String((body && body.kind) || '');
  // The web client speaks a simplified vocabulary; translate into the
  // shape applyAction() expects in cards-battle.js.
  //   play     -> playCard { handIdx, targetUid }
  //   attack   -> attack   { attackerUid, defenderUid }
  // Targets are uid strings (board minion uid) or the sentinels
  // "hero" / "selfHero" (the resolver maps "hero" -> opp hero on a
  // play-card targeting context, and "hero" -> opp hero on an attack;
  // explicit "selfHero" is for self-target spells like Iron Skin).
  let action = null;
  if (kind === 'play') {
    const handIdx = Number(body && body.handIndex);
    if (!Number.isInteger(handIdx) || handIdx < 0) return json({ ok: false, error: 'bad-hand-index' });
    const t = body && body.target;
    const targetUid = (t === null || t === undefined || t === '') ? null : String(t);
    action = { kind: 'playCard', handIdx, targetUid };
  } else if (kind === 'attack') {
    const attackerUid = String((body && body.attackerUid) || '');
    if (!attackerUid) return json({ ok: false, error: 'bad-attacker' });
    const t = body && body.target;
    const defenderUid = (t === null || t === undefined || t === '') ? 'hero' : String(t);
    action = { kind: 'attack', attackerUid, defenderUid };
  } else if (kind === 'endTurn') {
    action = { kind: 'endTurn' };
  } else if (kind === 'concede') {
    action = { kind: 'concede' };
  } else {
    return json({ ok: false, error: 'bad-kind' });
  }
  const r = await takeAction(env, m, side, action);
  return json({ ok: !!r.ok, error: r.error || null, match: r.match ? renderableState(r.match, userId) : null, ended: !!r.ended });
}
async function routeMatchMulligan(env, guildId, userId, body) {
  const m = await getActiveMatch(env, guildId, userId);
  if (!m) return json({ ok: false, error: 'no-active-match' });
  const side = sideOf(m, userId);
  if (!side) return json({ ok: false, error: 'not-in-match' });
  const keep = Array.isArray(body?.keep) ? body.keep.map(Number).filter(n => Number.isInteger(n) && n >= 0) : [];
  // The handIndices param to takeMulligan is "indices to redraw" — caller
  // passes "keep"; we invert to "redraw everything not in keep".
  const handSize = m.hands[side].length;
  const redraw = [];
  for (let i = 0; i < handSize; i++) if (!keep.includes(i)) redraw.push(i);
  const r = await takeMulligan(env, m, side, redraw);
  return json({ ok: !!r.ok, match: r.match ? renderableState(r.match, userId) : null });
}
async function routeMatchConcede(env, guildId, userId) {
  const m = await getActiveMatch(env, guildId, userId);
  if (!m) return json({ ok: false, error: 'no-active-match' });
  const side = sideOf(m, userId);
  if (!side) return json({ ok: false, error: 'not-in-match' });
  const r = await takeAction(env, m, side, { kind: 'concede' });
  return json({ ok: !!r.ok, match: r.match ? renderableState(r.match, userId) : null, ended: true });
}
async function routeLog(env, guildId, userId) {
  const log = await readLog(env, guildId, userId);
  return json({ ok: true, log: (log || []).slice(0, 25) });
}

// ── CR-1: recycle/craft routes ──────────────────────────────────────
//
// `boltbound/fragments` (read-only) → balance + economy constants.
// `boltbound/recycle` (POST) → recycle owned cards into frags.
// `boltbound/craft`   (POST) → spend frags to mint a pack.

async function routeFragments(env, guildId, userId) {
  const frags = await getFragments(env, userId);
  return json({
    ok: true,
    fragments: frags,
    recycleYield: RECYCLE_YIELD,
    craftCost: CRAFT_COST,
  });
}

async function routeRecycle(env, guildId, userId, body) {
  const cardId = String((body && body.cardId) || '').trim();
  const count = Math.max(1, parseInt(body?.count || '1', 10) || 1);
  if (!cardId) return json({ ok: false, error: 'bad-cardId' }, 400);
  const r = await recycleCard(env, guildId, userId, cardId, count);
  return json(r);
}

async function routeCraft(env, guildId, userId, body) {
  const packType = String((body && body.packType) || '').trim();
  if (!packType) return json({ ok: false, error: 'bad-packType' }, 400);
  const r = await craftPack(env, guildId, userId, packType);
  return json(r);
}

// ── Trade routes ───────────────────────────────────────────────────
//
// Auth is already enforced upstream by web.js (HMAC) — `userId` here
// is the signed-in viewer, used as the actor for every trade action.
// The HTTP-level `discordId` becomes the proposer (propose), the
// acceptor/decliner (accept/decline), or the canceller (cancel).

async function routeTradePropose(env, guildId, userId, body) {
  const toUserId = String((body && body.toUserId) || '').trim();
  const result = await proposeTrade(env, {
    guildId,
    fromUserId: userId,
    toUserId,
    fromCards: body?.fromCards || [],
    toCards:   body?.toCards   || [],
    fromBolts: body?.fromBolts || 0,
    toBolts:   body?.toBolts   || 0,
    note:      body?.note || '',
  });
  if (!result.ok) return json(result, 400);

  // Fire-and-forget DM to the recipient. Respects per-user push prefs
  // via the same path /push/dm uses (pprofile.pushPrefs.discordDm +
  // pprofile.pushPrefs.kinds['boltbound-trade-offer']).
  notifyRecipient(env, result.trade).catch((e) =>
    console.warn('[trade] notify failed', e && e.message)
  );

  return json({ ok: true, trade: result.trade });
}

async function routeTradeList(env, guildId, userId, body) {
  const direction = (body && body.direction) || 'both';
  if (!['incoming', 'outgoing', 'both'].includes(direction)) {
    return json({ ok: false, error: 'bad-direction' }, 400);
  }
  const trades = await listTrades(env, guildId, userId, direction);
  return json({ ok: true, trades });
}

async function routeTradeGet(env, guildId, userId, body) {
  const tradeId = String((body && body.tradeId) || '').trim();
  if (!tradeId) return json({ ok: false, error: 'bad-trade-id' }, 400);
  const trade = await getTrade(env, guildId, tradeId);
  if (!trade) return json({ ok: false, error: 'not-found' }, 404);
  // Only allow the proposer or the recipient to view the trade. This
  // hides offer contents from third parties.
  if (String(trade.fromUserId) !== String(userId) &&
      String(trade.toUserId)   !== String(userId)) {
    return json({ ok: false, error: 'forbidden' }, 403);
  }
  return json({ ok: true, trade });
}

async function routeTradeAccept(env, guildId, userId, body) {
  const tradeId = String((body && body.tradeId) || '').trim();
  if (!tradeId) return json({ ok: false, error: 'bad-trade-id' }, 400);
  const result = await acceptTrade(env, guildId, tradeId, userId);
  if (!result.ok) return json(result, 400);
  return json(result);
}

async function routeTradeDecline(env, guildId, userId, body) {
  const tradeId = String((body && body.tradeId) || '').trim();
  if (!tradeId) return json({ ok: false, error: 'bad-trade-id' }, 400);
  const result = await declineTrade(env, guildId, tradeId, userId);
  if (!result.ok) return json(result, 400);
  return json(result);
}

async function routeTradeCancel(env, guildId, userId, body) {
  const tradeId = String((body && body.tradeId) || '').trim();
  if (!tradeId) return json({ ok: false, error: 'bad-trade-id' }, 400);
  const result = await cancelTrade(env, guildId, tradeId, userId);
  if (!result.ok) return json(result, 400);
  return json(result);
}

async function routeTradeCollection(env, guildId, userId, body) {
  const ownerId = String((body && body.ownerId) || '').trim();
  if (!/^\d{5,25}$/.test(ownerId)) return json({ ok: false, error: 'bad-owner-id' }, 400);
  const view = await tradeableCollection(env, guildId, ownerId);
  return json({ ok: true, viewerId: userId, ...view });
}

// Send a Discord DM to the trade recipient. Mirrors the format used
// elsewhere (LFG / friend requests). Respects per-user push prefs
// the same way /push/dm does — if the recipient opted out of DMs
// or specifically opted out of kind='boltbound-trade-offer', the
// notification is silently skipped.
async function notifyRecipient(env, trade) {
  if (!env.DISCORD_BOT_TOKEN) return;
  // Re-check prefs inline (no helper export exists; same shape as push-dm.js).
  let prefs = { discordDm: true, web: true, kinds: {} };
  try {
    const p = await env.LOADOUT_BOLTS.get(`pprofile:${trade.toUserId}`, { type: 'json' });
    if (p?.pushPrefs) prefs = { ...prefs, ...p.pushPrefs };
  } catch { /* fall through to defaults */ }
  if (prefs.discordDm === false) return;
  if (prefs.kinds && prefs.kinds['boltbound-trade-offer'] === false) return;

  const fromName = `<@${trade.fromUserId}>`;
  const summary = describeTradeOffer(trade);
  const url = `https://aquilo.gg/play/boltbound/trade/${encodeURIComponent(trade.tradeId)}`;
  const content = `**${fromName} sent you a Boltbound trade offer**\n${summary}\n${url}`;
  await sendDm(env, trade.toUserId, { content: content.slice(0, 1900) });
}

function describeTradeOffer(trade) {
  const offer = describeSide(trade.fromCards, trade.fromBolts);
  const want  = describeSide(trade.toCards,   trade.toBolts);
  let s = `Offers: ${offer}\nWants: ${want}`;
  if (trade.note) s += `\nNote: ${trade.note}`;
  return s;
}
function describeSide(cardIds, bolts) {
  const parts = [];
  if (cardIds && cardIds.length) {
    const tally = {};
    for (const cid of cardIds) tally[cid] = (tally[cid] || 0) + 1;
    for (const [cid, n] of Object.entries(tally)) {
      const card = CARDS[cid];
      const name = card?.name || cid;
      parts.push(n > 1 ? `${n}× ${name}` : name);
    }
  }
  if (bolts > 0) parts.push(`${bolts} bolts`);
  if (parts.length === 0) parts.push('nothing');
  return parts.join(', ');
}

// ── Public dispatch ────────────────────────────────────────────────

export async function routeBoltbound(env, guildId, userId, route, body, opts) {
  const cors = !!(opts && opts.cors);
  const wrap = cors ? jsonCors : json;
  try {
    if (route === 'boltbound/state')           return await routeState(env, guildId, userId);
    if (route === 'boltbound/catalogue')       return await routeCatalogue();
    if (route === 'boltbound/decks/save')      return await routeDecksSave(env, guildId, userId, body);
    if (route === 'boltbound/decks/delete')    return await routeDecksDelete(env, guildId, userId, body);
    if (route === 'boltbound/decks/activate')  return await routeDecksActivate(env, guildId, userId, body);
    if (route === 'boltbound/decks/starter')   return await routeDecksStarter(env, guildId, userId);
    if (route === 'boltbound/packs/buy')       return await routePacksBuy(env, guildId, userId, body);
    if (route === 'boltbound/packs/open')      return await routePacksOpen(env, guildId, userId, body);
    if (route === 'boltbound/packs/free-daily') return await routePacksFreeDaily(env, guildId, userId);
    if (route === 'boltbound/match/start-npc') return await routeMatchStartNpc(env, guildId, userId, body);
    if (route === 'boltbound/match/queue')     return await routeMatchQueue(env, guildId, userId);
    if (route === 'boltbound/match/challenge') return await routeMatchChallenge(env, guildId, userId, body);
    if (route === 'boltbound/match/accept')    return await routeMatchAccept(env, guildId, userId, body);
    if (route === 'boltbound/match/state')     return await routeMatchState(env, guildId, userId);
    if (route === 'boltbound/match/action')    return await routeMatchAction(env, guildId, userId, body);
    if (route === 'boltbound/match/mulligan')  return await routeMatchMulligan(env, guildId, userId, body);
    if (route === 'boltbound/match/concede')   return await routeMatchConcede(env, guildId, userId);
    if (route === 'boltbound/log')             return await routeLog(env, guildId, userId);
    if (route === 'boltbound/fragments')       return await routeFragments(env, guildId, userId);
    if (route === 'boltbound/recycle')         return await routeRecycle(env, guildId, userId, body);
    if (route === 'boltbound/craft')           return await routeCraft(env, guildId, userId, body);
    if (route === 'boltbound/trade/propose')    return await routeTradePropose(env, guildId, userId, body);
    if (route === 'boltbound/trade/list')       return await routeTradeList(env, guildId, userId, body);
    if (route === 'boltbound/trade/get')        return await routeTradeGet(env, guildId, userId, body);
    if (route === 'boltbound/trade/accept')     return await routeTradeAccept(env, guildId, userId, body);
    if (route === 'boltbound/trade/decline')    return await routeTradeDecline(env, guildId, userId, body);
    if (route === 'boltbound/trade/cancel')     return await routeTradeCancel(env, guildId, userId, body);
    if (route === 'boltbound/trade/collection') return await routeTradeCollection(env, guildId, userId, body);
    return wrap({ error: 'not-found' }, 404);
  } catch (e) {
    return wrap({ error: 'server', message: String((e && e.message) || e) }, 500);
  }
}
