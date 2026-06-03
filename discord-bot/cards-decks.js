// Boltbound — deck building service.
//
// Thin layer on top of cards-state's storage helpers + cards-content's
// validateDeck. Owns the "auto-build a starter deck" path so a
// first-time viewer's collection contains a playable deck after they
// open their welcome Common Pack.
//
// Slash-command-facing operations live here so cards.js stays as a
// dispatch shell. KV writes are still in cards-state.js — this module
// is glue + validation.

import {
  CARDS, RARITY_DECK_CAP, RARITY_POOLS, CHAMPIONS, championForClass,
  DECK_SIZE, validateDeck,
} from './cards-content.js';
import {
  getCollection, listDecks, putDeck, deleteDeck, getDeck,
  setActiveDeckId, getActiveDeckId, newId,
} from './cards-state.js';
import { releasedSetIds } from './boltbound-release.js';

const MAX_SAVED_DECKS = 6;

// ── Public: build a starter deck from the viewer's collection ───────
//
// Greedy fill: start with the viewer's champion, then drain the
// collection by rarity (lowest first — commons are the abundant glue)
// honouring the deck cap. Returns a deck object ready to be saved.
//
// Called after the welcome Common Pack lands so the first /boltbound
// experience already has a playable deck pre-built. Caller is
// responsible for saving + setting active.

export function buildStarterDeck(collection, championClass, opts = {}) {
  const champId = championForClass(championClass || 'warrior');
  const out = [champId];
  const remaining = DECK_SIZE - 1;
  const own = collection?.cards || {};

  // Bucket owned cards by rarity, capped at the deck cap.
  const byRarity = { common: [], uncommon: [], rare: [], legendary: [] };
  for (const [cardId, count] of Object.entries(own)) {
    const c = CARDS[cardId];
    if (!c || c.rarity === 'champion' || c.token) continue;
    const cap = RARITY_DECK_CAP[c.rarity] || 1;
    const usable = Math.min(count, cap);
    for (let i = 0; i < usable; i++) (byRarity[c.rarity] || byRarity.common).push(cardId);
  }
  // Sort each bucket by ascending mana so the deck has a sensible
  // curve even from a small early collection. The Champion's mana
  // anchors the curve roughly at 4.
  for (const k of Object.keys(byRarity)) {
    byRarity[k].sort((a, b) => (CARDS[a].mana || 0) - (CARDS[b].mana || 0));
  }
  // Fill order: common → uncommon → rare → legendary. Commons are the
  // bulk; rares and legends are rare bonuses.
  const order = ['common', 'uncommon', 'rare', 'legendary'];
  for (const r of order) {
    for (const id of byRarity[r]) {
      if (out.length - 1 >= remaining) break;
      out.push(id);
    }
  }
  // If the viewer's collection can't fill 20 cards, top up with vanilla
  // commons from the catalogue (cheap glue, no abilities). Capped to
  // deck-cap-per-card so we don't end up with 19× Acolyte.
  if (out.length < DECK_SIZE) {
    const vanillaCommons = Object.values(CARDS).filter(c => c.rarity === 'common' && c.type === 'minion' && (!c.abilities || c.abilities.length === 0));
    vanillaCommons.sort((a, b) => (a.mana || 0) - (b.mana || 0));
    const useCount = {};
    for (const v of vanillaCommons) {
      const cap = RARITY_DECK_CAP[v.rarity] || 4;
      // Account for any copies already added from collection.
      useCount[v.id] = out.filter(x => x === v.id).length;
      while (useCount[v.id] < cap && out.length < DECK_SIZE) {
        out.push(v.id);
        useCount[v.id]++;
      }
      if (out.length >= DECK_SIZE) break;
    }
  }

  const deck = {
    id: opts.deckId || newId().slice(0, 12),
    name: opts.name || 'Starter Deck',
    cards: out,
    championClass: championClass || 'warrior',
    ts: 0,
  };
  return deck;
}

// ── Public: pool-based starter deck (for brand-new players) ─────────
//
// Unlike buildStarterDeck (which draws from what the viewer already
// owns), this builds a weak, balanced 20-card deck straight from the
// global catalogue pools — used by the one-click "Get a starter deck"
// CTA for players with no deck (and possibly no collection). The caller
// GRANTS the returned `grantIds` into the collection before saveDeck so
// ownership validation passes. Composition (19 non-champion cards):
// ~70% common / 25% uncommon / 5% rare; NO legendaries/epics (weak by
// design). Champion is chosen by the caller (equal-weighted) + passed in.
//
// Returns { deck, grantIds } where deck.cards includes the champion
// (saveDeck strips + re-adds) and grantIds are the 19 cards to grant.
export function buildPoolStarterDeck(championClass, rng = Math.random) {
  const cls = championClass || 'warrior';
  const champId = championForClass(cls);
  // 13 + 5 + 1 = 19 → 68% / 26% / 5%, matching the ~70/25/5 target.
  const plan = [['common', 13], ['uncommon', 5], ['rare', 1]];
  const grantIds = [];
  for (const [rarity, want] of plan) {
    const pool = (RARITY_POOLS[rarity] || []).filter(
      c => !c.token && (c.type === 'minion' || c.type === 'spell'));
    if (!pool.length) continue;
    // Cap copies-per-card for variety (≤2, never above the deck cap).
    const cap = Math.min(RARITY_DECK_CAP[rarity] || 1, 2);
    const used = {};
    let added = 0, guard = 0;
    while (added < want && guard++ < 5000) {
      const c = pool[Math.floor(rng() * pool.length)];
      if ((used[c.id] || 0) >= cap) continue;
      used[c.id] = (used[c.id] || 0) + 1;
      grantIds.push(c.id);
      added++;
    }
  }
  const deck = {
    id: newId().slice(0, 12),
    name: 'Starter Deck',
    cards: [champId, ...grantIds],
    championClass: cls,
    ts: 0,
  };
  return { deck, grantIds };
}

// ── Public: save a deck + run validation ────────────────────────────
//
// The deck `cards` array can either include the Champion as one of its
// entries OR omit it (we'll insert based on championClass). Either way
// validation runs against the *materialised* deck (champion included).

export async function saveDeck(env, guildId, userId, deck, championClass) {
  if (!deck || !Array.isArray(deck.cards)) return { ok: false, error: 'deck-required' };

  // Drop any champion entries the caller may have included and re-add
  // the canonical one — keeps the saved record portable across class
  // swaps (the resolveDeckChampion helper rewrites on read).
  const cls = championClass || deck.championClass || 'warrior';
  const stripped = deck.cards.filter(id => CARDS[id]?.rarity !== 'champion');
  const champId = championForClass(cls);
  const materialised = [champId, ...stripped];

  // Enforce deck size BEFORE validation so the error is clearer.
  if (materialised.length !== DECK_SIZE) {
    return { ok: false, error: `deck must be exactly ${DECK_SIZE} cards (you have ${materialised.length} including champion)` };
  }
  const v = validateDeck({ cards: materialised });
  if (!v.ok) return { ok: false, error: v.error };

  // Unreleased-set gate (KV-aware — see boltbound-release.js). A card from
  // an expansion that hasn't been flipped live yet can't be decked. core
  // is always allowed.
  const released = new Set(await releasedSetIds(env));
  for (const id of materialised) {
    const c = CARDS[id];
    const set = c?.set || 'core';
    if (set !== 'core' && !released.has(set)) {
      return { ok: false, error: `${c?.name || id} is from an unreleased set` };
    }
  }

  // Check ownership — viewer must own every non-champion, non-token card
  // in the requested quantity.
  const col = await getCollection(env, guildId, userId);
  const counts = {};
  for (const id of materialised) {
    if (CARDS[id]?.rarity === 'champion') continue;
    counts[id] = (counts[id] || 0) + 1;
  }
  for (const [id, n] of Object.entries(counts)) {
    const own = col.cards?.[id] || 0;
    if (own < n) {
      const name = CARDS[id]?.name || id;
      return { ok: false, error: `you don't own ${n}× ${name} (have ${own})` };
    }
  }

  // Enforce per-viewer saved-deck cap. If the caller is updating an
  // existing deck (deck.id matches), don't count it against the cap.
  const existing = await listDecks(env, guildId, userId);
  const isUpdate = deck.id && existing.some(d => d.id === deck.id);
  if (!isUpdate && existing.length >= MAX_SAVED_DECKS) {
    return { ok: false, error: `you've hit the ${MAX_SAVED_DECKS}-deck save limit` };
  }

  const record = {
    id: deck.id || newId().slice(0, 12),
    name: (deck.name || '').slice(0, 32) || 'Deck',
    cards: stripped,                          // store WITHOUT champion (re-inserted on read)
    championClass: cls,
    ts: Date.now(),
  };
  await putDeck(env, guildId, userId, record);
  return { ok: true, deck: record };
}

// ── Public: delete a deck (unsetting active if it was) ──────────────

export async function dropDeck(env, guildId, userId, deckId) {
  const active = await getActiveDeckId(env, guildId, userId);
  await deleteDeck(env, guildId, userId, deckId);
  if (active === deckId) await setActiveDeckId(env, guildId, userId, '');
  return { ok: true };
}

// ── Public: pick the active deck ────────────────────────────────────

export async function activateDeck(env, guildId, userId, deckId) {
  const d = await getDeck(env, guildId, userId, deckId);
  if (!d) return { ok: false, error: 'no-such-deck' };
  await setActiveDeckId(env, guildId, userId, deckId);
  return { ok: true, deck: d };
}

// ── Public: list with summaries (used by /boltbound deck list) ──────

export async function listDeckSummaries(env, guildId, userId) {
  const decks = await listDecks(env, guildId, userId);
  const activeId = await getActiveDeckId(env, guildId, userId);
  return decks.map(d => ({
    id: d.id, name: d.name, championClass: d.championClass,
    cardsCount: (d.cards?.length || 0) + 1,    // +1 for the champion
    active: d.id === activeId,
    ts: d.ts,
  }));
}

export { MAX_SAVED_DECKS };
