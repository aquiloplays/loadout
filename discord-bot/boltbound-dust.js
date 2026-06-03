// Boltbound, per-card "dust" economy primitive.
//
// Hearthstone-style disenchant currency, distinct from the pack-craft
// `fragments` in cards-fragments.js. Dust is earned by disenchanting
// duplicate cards and spent crafting individual missing cards. The
// per-card craft/disenchant routes live in cards-web.js (CR-2); this
// module is just the balance store so login-reward milestones and the
// crafting surface mutate one source of truth.
//
// Storage (per-user, account-wide like trophies / fragments):
//   cards:dust:<userId> -> integer balance
//
// Locked tables (CARD-GAME-DESIGN.md §14b, per-card dust). These match
// the client defaults baked into the site crafting UI so the worker is
// authoritative without the UI having to re-fetch a cost table.

import { CARDS } from './cards-content.js';
import { getCollection, putCollection, listDecks } from './cards-state.js';

const DUST_KEY = (userId) => `cards:dust:${userId}`;

// Disenchant value (refund when destroying a dupe).
export const DISENCHANT_VALUE = Object.freeze({
  common:    5,
  uncommon:  20,
  rare:      100,
  legendary: 400,
  // champion / token: not disenchantable (enforced at the route).
});

// Craft cost (spend to mint a single copy).
export const CRAFT_COST = Object.freeze({
  common:    40,
  uncommon:  100,
  rare:      400,
  legendary: 1600,
});

export async function getDust(env, userId) {
  const v = await env.LOADOUT_BOLTS.get(DUST_KEY(userId));
  return parseInt(v || '0', 10) || 0;
}

export async function setDust(env, userId, value) {
  await env.LOADOUT_BOLTS.put(DUST_KEY(userId), String(Math.max(0, value | 0)));
}

// Signed delta, clamped at 0. Returns the post-write balance.
export async function addDust(env, userId, delta, _reason) {
  const cur = await getDust(env, userId);
  const next = Math.max(0, cur + (delta | 0));
  await setDust(env, userId, next);
  return next;
}

// ── CR-2: per-card craft / disenchant ───────────────────────────────
//
// disenchant destroys one copy for DISENCHANT_VALUE dust; craft mints
// one copy for CRAFT_COST dust. Champions and tokens are neither.
// Disenchanting is blocked if it would drop a copy below what a saved
// deck uses (same guard as the pack-recycle path in cards-fragments).

function craftableRarity(card) {
  return card && !card.token && card.rarity !== 'champion' && card.rarity !== 'token';
}

export async function disenchantCard(env, guildId, userId, cardId) {
  const card = CARDS[cardId];
  if (!card) return { ok: false, error: 'unknown-card' };
  if (!craftableRarity(card)) return { ok: false, error: 'not-disenchantable' };
  const value = DISENCHANT_VALUE[card.rarity];
  if (value == null) return { ok: false, error: 'not-disenchantable' };

  const col = await getCollection(env, guildId, userId);
  const owned = (col.cards && col.cards[cardId]) || 0;
  if (owned < 1) return { ok: false, error: 'not-owned' };

  // Protect saved decks, can't disenchant below their usage.
  const decks = await listDecks(env, guildId, userId);
  let maxUse = 0, blockedBy = null;
  for (const d of decks) {
    const used = (d.cards || []).filter(id => id === cardId).length;
    if (used > maxUse) { maxUse = used; blockedBy = d.name; }
  }
  if ((owned - 1) < maxUse) {
    return { ok: false, error: 'deck-uses-this-card', blockedBy, need: maxUse };
  }

  col.cards[cardId] = owned - 1;
  if (col.cards[cardId] <= 0) delete col.cards[cardId];
  await putCollection(env, guildId, userId, col);
  const dust = await addDust(env, userId, value, 'disenchant:' + cardId);
  return { ok: true, action: 'dust', cardId, rarity: card.rarity, refunded: value, ownedAfter: owned - 1, dust };
}

export async function craftCard(env, guildId, userId, cardId) {
  const card = CARDS[cardId];
  if (!card) return { ok: false, error: 'unknown-card' };
  if (!craftableRarity(card)) return { ok: false, error: 'not-craftable' };
  const cost = CRAFT_COST[card.rarity];
  if (cost == null) return { ok: false, error: 'not-craftable' };

  const cur = await getDust(env, userId);
  if (cur < cost) return { ok: false, error: 'insufficient-dust', need: cost, have: cur };

  // Debit first; on a collection-write failure the dust is refunded.
  const after = await addDust(env, userId, -cost, 'craft:' + cardId);
  try {
    const col = await getCollection(env, guildId, userId);
    col.cards = col.cards || {};
    col.cards[cardId] = (col.cards[cardId] || 0) + 1;
    await putCollection(env, guildId, userId, col);
    return { ok: true, action: 'craft', cardId, rarity: card.rarity, spent: cost, ownedAfter: col.cards[cardId], dust: after };
  } catch (e) {
    await addDust(env, userId, cost, 'craft:refund');
    return { ok: false, error: 'craft-write-failed', message: e?.message || String(e) };
  }
}
