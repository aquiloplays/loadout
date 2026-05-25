// Boltbound CR-1 — Recycle → Fragments → Craft.
//
// Players recycle owned cards into per-user fragment balance, then
// craft new packs from fragments. The Bolts purchase path stays.
// Crafting from fragments is the SLOW path: per design doc §14 the
// craft cost is set so the frag-equivalent value exceeds the Bolts
// price (60% more for Bolt Packs).
//
// Module surface:
//   getFragments(env, userId) → balance
//   addFragments(env, userId, delta, reason) → balance after
//   recycleCard(env, guildId, userId, cardId, count) → result
//   craftPack(env, guildId, userId, packType) → result
//
// Storage:
//   cards:frags:<userId> → integer balance (per-user, same scope as trophies)
//
// Each consumer (Discord cards.js, web cards-web.js, panel) calls these
// helpers; ownership/gate checks live here so every surface enforces
// the same rules.

import { CARDS } from './cards-content.js';
import { getCollection, putCollection, listDecks, getActiveDeckId, getDeck } from './cards-state.js';
import { creditPack } from './cards-packs.js';

// ── Locked yield + craft tables (CARD-GAME-DESIGN.md §14) ────────────

export const RECYCLE_YIELD = {
  common:    5,
  uncommon:  20,
  rare:      100,
  legendary: 500,
  // champion / token: not recyclable (enforced in recycleCard).
};

export const CRAFT_COST = {
  common:  100,   // common pack — frag-only path; commons stream in via daily/lootbox
  bolt:    400,   // bolt pack — 60% more value than the 250-Bolts purchase
  voltaic: 1500,  // voltaic pack — drop-only otherwise, so this is also a frag-only path
};

// ── KV ───────────────────────────────────────────────────────────────

const FRAGS_KEY = (userId) => `cards:frags:${userId}`;

export async function getFragments(env, userId) {
  const v = await env.LOADOUT_BOLTS.get(FRAGS_KEY(userId));
  return parseInt(v || '0', 10) || 0;
}

export async function setFragments(env, userId, value) {
  await env.LOADOUT_BOLTS.put(FRAGS_KEY(userId), String(Math.max(0, value | 0)));
}

export async function addFragments(env, userId, delta, _reason) {
  const cur = await getFragments(env, userId);
  const next = Math.max(0, cur + (delta | 0));
  await setFragments(env, userId, next);
  return next;
}

// ── Recycle ─────────────────────────────────────────────────────────
//
// `count` copies of `cardId` are removed from the viewer's collection
// and converted to fragments. Gating:
//   - card must exist
//   - cannot recycle champions or tokens
//   - viewer must own at least `count` of the card
//   - recycling cannot drop the count below the most-used copy in any
//     of the viewer's saved decks (the active deck included). If
//     recycling would invalidate a saved deck, refuse with a clear
//     error pointing at that deck.
//
// Returns { ok, error?, yield, balanceAfter, ownedAfter }.

export async function recycleCard(env, guildId, userId, cardId, count) {
  const card = CARDS[cardId];
  if (!card) return { ok: false, error: 'unknown-card' };
  if (card.rarity === 'champion') return { ok: false, error: 'champions-not-recyclable' };
  if (card.token) return { ok: false, error: 'tokens-not-recyclable' };

  const n = Math.max(1, count | 0);
  const col = await getCollection(env, guildId, userId);
  const owned = (col.cards && col.cards[cardId]) || 0;
  if (owned < n) return { ok: false, error: 'insufficient-copies', owned };

  // Compute max usage across saved decks. The owned-after must be ≥
  // every saved deck's count of this card, otherwise the deck would
  // become illegal at next read.
  const decks = await listDecks(env, guildId, userId);
  let maxDeckUse = 0;
  let blockedBy = null;
  for (const d of decks) {
    const used = (d.cards || []).filter(id => id === cardId).length;
    if (used > maxDeckUse) { maxDeckUse = used; blockedBy = d.name; }
  }
  if ((owned - n) < maxDeckUse) {
    return {
      ok: false,
      error: 'deck-uses-this-card',
      blockedBy,
      need: maxDeckUse,
      ownedAfter: owned - n,
      message: `Recycling that many would leave your deck "${blockedBy}" with too few copies (${owned - n} left, deck uses ${maxDeckUse}).`,
    };
  }

  // Mutate collection.
  col.cards[cardId] = owned - n;
  if (col.cards[cardId] <= 0) delete col.cards[cardId];
  await putCollection(env, guildId, userId, col);

  // Credit fragments.
  const yieldPer = RECYCLE_YIELD[card.rarity] || 0;
  const totalYield = yieldPer * n;
  const balanceAfter = await addFragments(env, userId, totalYield, 'recycle');

  return {
    ok: true,
    yield: totalYield,
    yieldPer,
    rarity: card.rarity,
    cardId,
    cardName: card.name,
    recycled: n,
    ownedAfter: owned - n,
    balanceAfter,
  };
}

// ── Craft ────────────────────────────────────────────────────────────
//
// Spend fragments to mint a pending pack. Calls creditPack with
// source='craft' so downstream surfaces can show provenance.
//
// Returns { ok, error?, packId, packType, fragmentsAfter, cost }.

export async function craftPack(env, guildId, userId, packType) {
  const cost = CRAFT_COST[packType];
  if (cost == null) return { ok: false, error: 'unknown-pack-type' };
  const cur = await getFragments(env, userId);
  if (cur < cost) {
    return { ok: false, error: 'insufficient-fragments', need: cost, have: cur };
  }
  // Debit first, mint second — if the credit fails for any reason the
  // viewer's fragments are NOT lost (we refund on the failure path).
  const after = await addFragments(env, userId, -cost, 'craft:' + packType);
  const credited = await creditPack(env, guildId, userId, packType, 'craft');
  if (!credited.ok) {
    // Refund.
    await addFragments(env, userId, cost, 'craft:refund:' + credited.error);
    return { ok: false, error: credited.error };
  }
  // PROGRESSION (P1) — craft XP.
  try {
    const { emitProgressionEvent } = await import('./progression/event-bus.js');
    await emitProgressionEvent(env, {
      kind: 'cards.crafted', userId, guildId,
      meta: { packId: credited.pack.id, packType, cost },
      stableKeys: ['packId'],
    });
  } catch { /* non-fatal */ }
  return {
    ok: true,
    packId: credited.pack.id,
    packType,
    cost,
    fragmentsAfter: after,
  };
}

// ── Recycle-all helper ───────────────────────────────────────────────
//
// Convenience: recycle EVERY copy of cards in `cardIds`. Used by the
// web "select N cards, recycle" UI without needing a separate route
// per card. Returns per-card results + total yield.

export async function recycleBulk(env, guildId, userId, cardIds) {
  const results = [];
  let total = 0;
  for (const cardId of cardIds) {
    const col = await getCollection(env, guildId, userId);
    const owned = (col.cards && col.cards[cardId]) || 0;
    if (!owned) continue;
    // Try to recycle as many as gating allows.
    // Recursive: recycle one at a time so partial recycling works
    // if a saved deck constrains the max.
    let recycledHere = 0;
    let yieldHere = 0;
    let lastErr = null;
    while (true) {
      const r = await recycleCard(env, guildId, userId, cardId, 1);
      if (!r.ok) { lastErr = r.error; break; }
      recycledHere++;
      yieldHere += r.yieldPer;
    }
    total += yieldHere;
    results.push({ cardId, recycled: recycledHere, yield: yieldHere, error: recycledHere === 0 ? lastErr : null });
  }
  const balanceAfter = await getFragments(env, userId);
  return { ok: true, results, totalYield: total, balanceAfter };
}
