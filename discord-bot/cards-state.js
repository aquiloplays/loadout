// Boltbound — KV state module.
//
// Owns every read/write against the `cards:*` family of keys in the
// shared LOADOUT_BOLTS namespace. Same posture as clash-state.js — the
// schema lives in exactly one place and every other Boltbound module
// (cards-packs, cards-battle, cards-match, cards.js) goes through these
// helpers.
//
// See CARD-GAME-DESIGN.md §6 for the key layout. All writes return the
// post-write object so callers can react without a second read.

import { CARDS, CHAMPIONS, championForClass, RARITY_DECK_CAP } from './cards-content.js';

// ── Key builders ─────────────────────────────────────────────────────

const COL_KEY        = (g, u)       => `cards:col:${g}:${u}`;
const DECK_KEY       = (g, u, d)    => `cards:deck:${g}:${u}:${d}`;
const DECK_PREFIX    = (g, u)       => `cards:deck:${g}:${u}:`;
const ACTIVE_KEY     = (g, u)       => `cards:active:${g}:${u}`;
const PENDING_KEY    = (g, u, pid)  => `cards:pending:${g}:${u}:${pid}`;
const PENDING_PREFIX = (g, u)       => `cards:pending:${g}:${u}:`;
const FREEPACK_KEY   = (g, u, ymd)  => `cards:freepack:${g}:${u}:${ymd}`;
const PITY_KEY       = (u)          => `cards:pity:${u}`;
const MATCH_KEY      = (mid)        => `cards:match:${mid}`;
const QUEUE_KEY      = (g)          => `cards:queue:${g}`;
const MATCHREF_KEY   = (g, u)       => `cards:matchref:${g}:${u}`;
const LOG_KEY        = (g, u)       => `cards:log:${g}:${u}`;
const TROPHIES_KEY   = (u)          => `cards:trophies:${u}`;
const LADDER_KEY     = (u, ymd)     => `cards:ladder:${u}:${ymd}`;
const CHALLENGE_KEY  = (g, recipient, sender) => `cards:challenge:${g}:${recipient}:${sender}`;
const CHALLENGE_PREFIX = (g, recipient)       => `cards:challenge:${g}:${recipient}:`;

// ── Collections ──────────────────────────────────────────────────────
//
// Shape: { cards: { cardId: count }, ts, championClass? }
// `championClass` is a hint of what dungeon class the viewer's
// HeroState was when their collection was last touched — used to
// pick the default champion for a freshly-built deck. The Champion
// card itself is NOT stored in the collection (it's granted at
// play-time based on current class).

export async function getCollection(env, guildId, userId) {
  const raw = await env.LOADOUT_BOLTS.get(COL_KEY(guildId, userId), { type: 'json' });
  return raw || { cards: {}, ts: 0 };
}

export async function putCollection(env, guildId, userId, col) {
  col.ts = Date.now();
  await env.LOADOUT_BOLTS.put(COL_KEY(guildId, userId), JSON.stringify(col));
  return col;
}

// First-/boltbound bootstrap. Idempotent — if the row already exists,
// no-op. Returns { isNew, collection } so the welcome flow knows
// whether to credit the welcome pack.
export async function ensureCollection(env, guildId, userId, championClass) {
  const existing = await env.LOADOUT_BOLTS.get(COL_KEY(guildId, userId), { type: 'json' });
  if (existing) return { isNew: false, collection: existing };
  const col = { cards: {}, ts: Date.now(), championClass: championClass || 'warrior' };
  await env.LOADOUT_BOLTS.put(COL_KEY(guildId, userId), JSON.stringify(col));
  return { isNew: true, collection: col };
}

// Add a single card to a viewer's collection.
//   - Returns { credited: true, count: <newCount> } when the card was added.
//   - Returns { credited: false, dupeBolts: <N> } when the deck cap was
//     already met and the card is converted to Bolts. Caller does the
//     actual wallet credit (we don't want to import the wallet module
//     here and create a circular dep).
//
// Champions are never collected — they're granted at play-time. If a
// pack roller somehow asks to credit a champion id, we drop it.
export async function addCardToCollection(env, guildId, userId, cardId) {
  const card = CARDS[cardId];
  if (!card) return { credited: false, dupeBolts: 0, reason: 'unknown-card' };
  if (card.rarity === 'champion' || card.token) {
    return { credited: false, dupeBolts: 0, reason: 'untradable' };
  }
  const col = await getCollection(env, guildId, userId);
  const have = col.cards[cardId] || 0;
  const cap = RARITY_DECK_CAP[card.rarity] || 1;
  if (have >= cap) {
    // Past cap — duplicate refund instead of adding a card.
    const { DUPE_BOLTS } = await import('./cards-content.js');
    return { credited: false, dupeBolts: DUPE_BOLTS[card.rarity] || 0, cardId };
  }
  col.cards[cardId] = have + 1;
  await putCollection(env, guildId, userId, col);
  return { credited: true, count: col.cards[cardId], cardId };
}

// Bulk add — same return shape per card. Used when opening a pack so
// the redemption summary can show "you got 5 cards: X (new), Y
// (duplicate → 5 Bolts), Z (new), ..."
export async function addCardsToCollection(env, guildId, userId, cardIds) {
  const col = await getCollection(env, guildId, userId);
  const results = [];
  let touched = false;
  const { DUPE_BOLTS } = await import('./cards-content.js');
  for (const cardId of cardIds) {
    const card = CARDS[cardId];
    if (!card || card.rarity === 'champion' || card.token) {
      results.push({ credited: false, dupeBolts: 0, cardId, reason: 'untradable' });
      continue;
    }
    const have = col.cards[cardId] || 0;
    const cap = RARITY_DECK_CAP[card.rarity] || 1;
    if (have >= cap) {
      results.push({ credited: false, dupeBolts: DUPE_BOLTS[card.rarity] || 0, cardId });
      continue;
    }
    col.cards[cardId] = have + 1;
    touched = true;
    results.push({ credited: true, count: col.cards[cardId], cardId });
  }
  if (touched) await putCollection(env, guildId, userId, col);
  return results;
}

// How many copies of (cardId) does this viewer own, post-deck-cap?
export async function ownedCount(env, guildId, userId, cardId) {
  const col = await getCollection(env, guildId, userId);
  return col.cards[cardId] || 0;
}

// ── Decks ────────────────────────────────────────────────────────────
//
// Shape: { id, name, cards: [cardId,...], championClass, ts }
// championClass is stored on the deck so a deck record stays portable
// (and re-classing in dungeon land updates the deck's champion lazily).

export async function getDeck(env, guildId, userId, deckId) {
  const raw = await env.LOADOUT_BOLTS.get(DECK_KEY(guildId, userId, deckId), { type: 'json' });
  return raw || null;
}

export async function putDeck(env, guildId, userId, deck) {
  deck.ts = Date.now();
  await env.LOADOUT_BOLTS.put(DECK_KEY(guildId, userId, deck.id), JSON.stringify(deck));
  return deck;
}

export async function deleteDeck(env, guildId, userId, deckId) {
  await env.LOADOUT_BOLTS.delete(DECK_KEY(guildId, userId, deckId));
}

export async function listDecks(env, guildId, userId) {
  const prefix = DECK_PREFIX(guildId, userId);
  const out = [];
  let cursor;
  for (let i = 0; i < 3; i++) {
    const r = await env.LOADOUT_BOLTS.list({ prefix, cursor, limit: 100 });
    const fetches = r.keys.map(k => env.LOADOUT_BOLTS.get(k.name, { type: 'json' }));
    for (const d of await Promise.all(fetches)) if (d) out.push(d);
    if (r.list_complete || !r.cursor) break;
    cursor = r.cursor;
  }
  return out;
}

export async function getActiveDeckId(env, guildId, userId) {
  const v = await env.LOADOUT_BOLTS.get(ACTIVE_KEY(guildId, userId));
  return v || null;
}

export async function setActiveDeckId(env, guildId, userId, deckId) {
  await env.LOADOUT_BOLTS.put(ACTIVE_KEY(guildId, userId), deckId);
}

// Returns the active deck object, OR null if none is active.
// Champion card id is patched in fresh from the championClass on
// every read so a class change in the dungeon module is reflected
// without rewriting saved decks.
export async function getActiveDeck(env, guildId, userId) {
  const id = await getActiveDeckId(env, guildId, userId);
  if (!id) return null;
  const deck = await getDeck(env, guildId, userId, id);
  if (!deck) return null;
  return resolveDeckChampion(deck);
}

// Replace the deck's champion slot with the one matching its
// championClass. The deck record itself stores the class, NOT the
// champion card id — that way a class swap doesn't require rewriting
// every saved deck.
export function resolveDeckChampion(deck) {
  if (!deck || !Array.isArray(deck.cards)) return deck;
  const out = { ...deck, cards: deck.cards.slice() };
  // Find the existing champion slot (any 'champ.*' id) and replace
  // it with the champion for the deck's recorded class. If no
  // champion is present at all, prepend one — protects against
  // pre-validate-fix decks.
  let foundIdx = -1;
  for (let i = 0; i < out.cards.length; i++) {
    if (CARDS[out.cards[i]]?.rarity === 'champion') { foundIdx = i; break; }
  }
  const champId = championForClass(out.championClass || 'warrior');
  if (foundIdx >= 0) out.cards[foundIdx] = champId;
  else out.cards.unshift(champId);
  return out;
}

// ── Pending packs ────────────────────────────────────────────────────
//
// Shape: { id, packType, source, mintedUtc, rolled?: [cardId,...] }
// `rolled` is null when the pack is unopened. Server pre-rolls at
// redeem-time using rng seeded by the pack id, then freezes the
// pulls. A second open call returns the same five cards — supports
// the future web reveal page consuming a server-pre-rolled list.

export async function mintPendingPack(env, guildId, userId, packType, source) {
  const id = newId();
  const pack = {
    id, packType, source,
    mintedUtc: Date.now(),
    rolled: null,
  };
  await env.LOADOUT_BOLTS.put(PENDING_KEY(guildId, userId, id), JSON.stringify(pack));
  return pack;
}

export async function getPendingPack(env, guildId, userId, packId) {
  const raw = await env.LOADOUT_BOLTS.get(PENDING_KEY(guildId, userId, packId), { type: 'json' });
  return raw || null;
}

export async function freezePendingPack(env, guildId, userId, packId, rolledCards) {
  const p = await getPendingPack(env, guildId, userId, packId);
  if (!p) return null;
  p.rolled = rolledCards;
  p.openedUtc = Date.now();
  await env.LOADOUT_BOLTS.put(PENDING_KEY(guildId, userId, packId), JSON.stringify(p));
  return p;
}

export async function deletePendingPack(env, guildId, userId, packId) {
  await env.LOADOUT_BOLTS.delete(PENDING_KEY(guildId, userId, packId));
}

export async function listPendingPacks(env, guildId, userId, limit = 20) {
  const prefix = PENDING_PREFIX(guildId, userId);
  const out = [];
  let cursor;
  for (let i = 0; i < 3 && out.length < limit; i++) {
    const r = await env.LOADOUT_BOLTS.list({ prefix, cursor, limit: 100 });
    const fetches = r.keys.map(k => env.LOADOUT_BOLTS.get(k.name, { type: 'json' }));
    for (const p of await Promise.all(fetches)) {
      if (p) out.push(p);
      if (out.length >= limit) break;
    }
    if (r.list_complete || !r.cursor) break;
    cursor = r.cursor;
  }
  // Oldest first so the redeem queue is FIFO.
  out.sort((a, b) => (a.mintedUtc || 0) - (b.mintedUtc || 0));
  return out;
}

// ── Daily free pack ──────────────────────────────────────────────────
//
// Gate is a YYYYMMDD-keyed flag with 26h TTL. The viewer can claim
// once per UTC day. Resets at 00:00 UTC.

export function todayYmd(now = Date.now()) {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

export async function hasClaimedFreePackToday(env, guildId, userId) {
  const v = await env.LOADOUT_BOLTS.get(FREEPACK_KEY(guildId, userId, todayYmd()));
  return !!v;
}

export async function markFreePackClaimed(env, guildId, userId) {
  await env.LOADOUT_BOLTS.put(
    FREEPACK_KEY(guildId, userId, todayYmd()),
    '1',
    { expirationTtl: 26 * 60 * 60 }
  );
}

// ── Bad-luck pity counter ────────────────────────────────────────────
//
// Per-user (NOT per-guild). Increments on every Bolt or Voltaic pack
// opened. On every 30th of those without a legendary pulled, the next
// pack guarantees a legendary slot — see cards-packs.js for the
// consumer.

export async function getPity(env, userId) {
  const raw = await env.LOADOUT_BOLTS.get(PITY_KEY(userId), { type: 'json' });
  return raw || { packs: 0, lastLegendaryUtc: 0 };
}

export async function bumpPity(env, userId, delta = 1) {
  const p = await getPity(env, userId);
  p.packs = (p.packs || 0) + delta;
  await env.LOADOUT_BOLTS.put(PITY_KEY(userId), JSON.stringify(p));
  return p;
}

export async function resetPity(env, userId) {
  const p = await getPity(env, userId);
  p.packs = 0;
  p.lastLegendaryUtc = Date.now();
  await env.LOADOUT_BOLTS.put(PITY_KEY(userId), JSON.stringify(p));
  return p;
}

// ── Matches ──────────────────────────────────────────────────────────

export async function getMatch(env, matchId) {
  const raw = await env.LOADOUT_BOLTS.get(MATCH_KEY(matchId), { type: 'json' });
  return raw || null;
}

export async function putMatch(env, match) {
  match.lastTurnUtc = Date.now();
  await env.LOADOUT_BOLTS.put(MATCH_KEY(match.matchId), JSON.stringify(match));
  return match;
}

export async function deleteMatch(env, matchId) {
  await env.LOADOUT_BOLTS.delete(MATCH_KEY(matchId));
}

export async function getActiveMatchId(env, guildId, userId) {
  return await env.LOADOUT_BOLTS.get(MATCHREF_KEY(guildId, userId));
}

export async function setActiveMatchId(env, guildId, userId, matchId) {
  if (!matchId) await env.LOADOUT_BOLTS.delete(MATCHREF_KEY(guildId, userId));
  else await env.LOADOUT_BOLTS.put(MATCHREF_KEY(guildId, userId), matchId);
}

export async function getActiveMatch(env, guildId, userId) {
  const id = await getActiveMatchId(env, guildId, userId);
  if (!id) return null;
  return await getMatch(env, id);
}

// ── PvP queue ────────────────────────────────────────────────────────
//
// Channel-scoped wait queue. Stored as a single JSON value because
// the queue is small (< 20 entries in practice) and we want atomic
// "pop a partner" semantics. Entries with queuedUtc older than 30min
// are evicted lazily on every read.

const QUEUE_ENTRY_TTL_MS = 30 * 60 * 1000;

export async function getQueue(env, guildId) {
  const raw = await env.LOADOUT_BOLTS.get(QUEUE_KEY(guildId), { type: 'json' });
  const arr = Array.isArray(raw) ? raw : [];
  const now = Date.now();
  return arr.filter(e => (now - (e.queuedUtc || 0)) < QUEUE_ENTRY_TTL_MS);
}

export async function putQueue(env, guildId, arr) {
  await env.LOADOUT_BOLTS.put(QUEUE_KEY(guildId), JSON.stringify(arr));
}

export async function enqueueQueue(env, guildId, userId, deckId) {
  const q = await getQueue(env, guildId);
  // Replace any prior entry from this user with the fresh one.
  const filtered = q.filter(e => e.userId !== userId);
  filtered.push({ userId, deckId, queuedUtc: Date.now() });
  await putQueue(env, guildId, filtered);
  return filtered;
}

export async function dequeuePartner(env, guildId, selfId) {
  const q = await getQueue(env, guildId);
  const idx = q.findIndex(e => e.userId !== selfId);
  if (idx < 0) return null;
  const partner = q[idx];
  q.splice(idx, 1);
  // Also pull the requester out of the queue if they're in there.
  const filtered = q.filter(e => e.userId !== selfId);
  await putQueue(env, guildId, filtered);
  return partner;
}

export async function removeFromQueue(env, guildId, userId) {
  const q = await getQueue(env, guildId);
  const filtered = q.filter(e => e.userId !== userId);
  if (filtered.length === q.length) return false;
  await putQueue(env, guildId, filtered);
  return true;
}

// ── Match-log ring buffer ────────────────────────────────────────────
//
// Per-viewer, capped at 10 recent receipts. Same shape as Clash's
// raid log.

const LOG_CAP = 10;

export async function appendLog(env, guildId, userId, receipt) {
  const raw = await env.LOADOUT_BOLTS.get(LOG_KEY(guildId, userId), { type: 'json' });
  const arr = Array.isArray(raw) ? raw : [];
  arr.unshift(receipt);
  while (arr.length > LOG_CAP) arr.pop();
  await env.LOADOUT_BOLTS.put(LOG_KEY(guildId, userId), JSON.stringify(arr));
  return arr;
}

export async function readLog(env, guildId, userId) {
  const raw = await env.LOADOUT_BOLTS.get(LOG_KEY(guildId, userId), { type: 'json' });
  return Array.isArray(raw) ? raw : [];
}

// ── Trophies + tier ──────────────────────────────────────────────────

const TROPHY_TIERS = [
  [0,    'bronze'],
  [200,  'silver'],
  [500,  'gold'],
  [1000, 'platinum'],
  [2000, 'diamond'],
];

export function tierOf(trophies) {
  let t = 'bronze';
  for (const [floor, name] of TROPHY_TIERS) if (trophies >= floor) t = name;
  return t;
}

export async function getTrophies(env, userId) {
  const raw = await env.LOADOUT_BOLTS.get(TROPHIES_KEY(userId), { type: 'json' });
  const tr = raw || { trophies: 0, peak: 0, season: 1 };
  return { ...tr, tier: tierOf(tr.trophies) };
}

export async function adjustTrophies(env, userId, delta) {
  const t = await getTrophies(env, userId);
  t.trophies = Math.max(0, (t.trophies || 0) + delta);
  t.peak = Math.max(t.peak || 0, t.trophies);
  await env.LOADOUT_BOLTS.put(TROPHIES_KEY(userId), JSON.stringify({
    trophies: t.trophies, peak: t.peak, season: t.season || 1,
  }));
  return { ...t, tier: tierOf(t.trophies) };
}

// ── Ladder bolts cap ─────────────────────────────────────────────────
//
// Per-user (not per-guild) daily Bolts earnings counter. Tracked with
// a 26h-TTL row keyed by YYYYMMDD. Caller checks remaining capacity
// before crediting Bolts.
//
// Returns { earnedToday, remaining } where remaining clamps at 0.

const LADDER_CAP_PER_DAY = 500;

export async function getLadderEarned(env, userId) {
  const v = await env.LOADOUT_BOLTS.get(LADDER_KEY(userId, todayYmd()));
  return parseInt(v || '0', 10) || 0;
}

export async function ladderCapacity(env, userId) {
  const earned = await getLadderEarned(env, userId);
  return { earnedToday: earned, remaining: Math.max(0, LADDER_CAP_PER_DAY - earned), cap: LADDER_CAP_PER_DAY };
}

// Commit a credit against the daily cap. Returns the actually-creditable
// amount (clamped at remaining), and bumps the counter. Caller is
// responsible for the wallet write.
export async function commitLadderCredit(env, userId, want) {
  const earned = await getLadderEarned(env, userId);
  const remaining = Math.max(0, LADDER_CAP_PER_DAY - earned);
  const credit = Math.max(0, Math.min(want, remaining));
  if (credit > 0) {
    await env.LOADOUT_BOLTS.put(
      LADDER_KEY(userId, todayYmd()),
      String(earned + credit),
      { expirationTtl: 26 * 60 * 60 }
    );
  }
  return { credit, capped: credit < want, earnedTotal: earned + credit };
}

export { LADDER_CAP_PER_DAY };

// ── Direct challenges ────────────────────────────────────────────────
//
// Pending direct challenge from <sender> to <recipient>. Three at a
// time per recipient (anti-spam). 24h TTL.

const CHALLENGE_TTL_S = 24 * 60 * 60;
const MAX_OUTSTANDING_CHALLENGES = 3;

export async function listChallenges(env, guildId, recipientId) {
  const prefix = CHALLENGE_PREFIX(guildId, recipientId);
  const out = [];
  let cursor;
  for (let i = 0; i < 2; i++) {
    const r = await env.LOADOUT_BOLTS.list({ prefix, cursor, limit: 50 });
    for (const k of r.keys) {
      const sender = k.name.slice(prefix.length);
      const c = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
      if (c) out.push({ ...c, sender });
    }
    if (r.list_complete || !r.cursor) break;
    cursor = r.cursor;
  }
  return out;
}

export async function mintChallenge(env, guildId, senderId, recipientId, deckId) {
  if (senderId === recipientId) return { ok: false, error: 'cannot-challenge-self' };
  const outstanding = await listChallenges(env, guildId, recipientId);
  if (outstanding.length >= MAX_OUTSTANDING_CHALLENGES) {
    return { ok: false, error: 'recipient-inbox-full' };
  }
  await env.LOADOUT_BOLTS.put(
    CHALLENGE_KEY(guildId, recipientId, senderId),
    JSON.stringify({ deckId, ts: Date.now() }),
    { expirationTtl: CHALLENGE_TTL_S }
  );
  return { ok: true };
}

export async function consumeChallenge(env, guildId, senderId, recipientId) {
  const raw = await env.LOADOUT_BOLTS.get(CHALLENGE_KEY(guildId, recipientId, senderId), { type: 'json' });
  if (!raw) return null;
  await env.LOADOUT_BOLTS.delete(CHALLENGE_KEY(guildId, recipientId, senderId));
  return raw;
}

// ── Utility ──────────────────────────────────────────────────────────

export function newId() {
  // Same shape ext-lootbox.js uses for item ids — 32-char lower-hex.
  // Used for pack ids, match ids, etc.
  const arr = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}
