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
]);

// Read-only sub-routes the proxy may skip rate-limit for.
const READ_ROUTES = new Set([
  'boltbound/state',
  'boltbound/catalogue',
  'boltbound/match/state',
  'boltbound/log',
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

  const [deckSummaries, activeDeckId, pendingPacks, log, trophies, wallet, freeClaimed] = await Promise.all([
    listDeckSummaries(env, guildId, userId),
    getActiveDeckId(env, guildId, userId),
    listPendingPacks(env, guildId, userId, 30),
    readLog(env, guildId, userId),
    getTrophies(env, userId),
    getWallet(env, guildId, userId),
    hasClaimedFreePackToday(env, guildId, userId),
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
    pendingPacks: pendingPacks.map(p => ({
      packId: p.packId,
      packType: p.packType,
      source: p.source,
      opened: !!(p.rolled && p.rolled.length),
      mintedUtc: p.mintedUtc,
    })),
    welcomePack: welcomePack ? { packId: welcomePack.packId, packType: welcomePack.packType } : null,
    log: (log || []).slice(0, 10),
    trophies: trophies || { trophies: 0, peak: 0, season: 1 },
    wallet: { balance: wallet.balance || 0 },
    freePackClaimedToday: !!freeClaimed,
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
  let action = null;
  if (kind === 'play') {
    const handIndex = Number(body.handIndex);
    const target = (body.target === null || body.target === undefined) ? null
                 : (typeof body.target === 'number') ? body.target
                 : Number(body.target);
    if (!Number.isInteger(handIndex) || handIndex < 0) return json({ ok: false, error: 'bad-hand-index' });
    action = { kind: 'play', handIndex, target: Number.isFinite(target) ? target : null };
  } else if (kind === 'attack') {
    const attackerUid = String(body.attackerUid || '');
    const target = (body.target === null || body.target === undefined) ? null : body.target;
    if (!attackerUid) return json({ ok: false, error: 'bad-attacker' });
    action = { kind: 'attack', attackerUid, target };
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
    return wrap({ error: 'not-found' }, 404);
  } catch (e) {
    return wrap({ error: 'server', message: String((e && e.message) || e) }, 500);
  }
}
