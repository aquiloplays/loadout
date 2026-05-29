// Boltbound card crafting (dust system) — MVP unblocking the site UI.
//
// 2026-05-29. Hearthstone-tier economy:
//   common    disenchant=5    craft=40
//   uncommon  disenchant=20   craft=100
//   rare      disenchant=100  craft=400
//   epic      disenchant=400  craft=1600
//   legendary disenchant=1600 craft=3200
//
// Champion / token kinds are not craftable nor disenchantable.
//
// Storage: dust balance lives on the existing wallet record alongside
// bolts + bannerCoins. Adds wallet.dust + wallet.lifetimeDustEarned +
// wallet.lifetimeDustSpent.

import { getWallet, putWallet } from './wallet.js';
import { getCollection, putCollection } from './cards-state.js';
import { CARDS } from './cards-content.js';

export const DUST_DISENCHANT_BY_RARITY = Object.freeze({
  common:    5,   uncommon: 20,  rare:    100,
  epic:      400, legendary: 1600,
});
export const DUST_CRAFT_BY_RARITY = Object.freeze({
  common:    40,  uncommon: 100, rare:    400,
  epic:      1600, legendary: 3200,
});

function craftableRarity(card) {
  if (!card || !card.rarity) return null;
  // Champion + token cards are not craftable/disenchantable.
  const kind = (card.kind || '').toLowerCase();
  if (kind === 'champion' || kind === 'token') return null;
  const r = String(card.rarity).toLowerCase();
  if (!(r in DUST_DISENCHANT_BY_RARITY)) return null;
  return r;
}

export async function getDust(env, guildId, userId) {
  const w = await getWallet(env, guildId, userId);
  return {
    dust:               w.dust || 0,
    lifetimeDustEarned: w.lifetimeDustEarned || 0,
    lifetimeDustSpent:  w.lifetimeDustSpent || 0,
  };
}

async function adjustDust(env, guildId, userId, delta, reason) {
  const w = await getWallet(env, guildId, userId);
  const cur = w.dust || 0;
  if (delta < 0 && cur + delta < 0) {
    return { ok: false, error: 'insufficient-dust', dust: cur };
  }
  w.dust = Math.max(0, cur + delta);
  if (delta > 0) w.lifetimeDustEarned = (w.lifetimeDustEarned || 0) + delta;
  else           w.lifetimeDustSpent  = (w.lifetimeDustSpent  || 0) + (-delta);
  await putWallet(env, guildId, userId, w);
  return { ok: true, dust: w.dust, reason };
}

// Returns dust based on rarity. Decrements collection by 1. Refuses if
// the card is the last copy unless `force: true` is passed.
export async function disenchant(env, guildId, userId, cardId, opts = {}) {
  const card = CARDS[cardId];
  if (!card) return { ok: false, error: 'unknown-card' };
  const rarity = craftableRarity(card);
  if (!rarity) return { ok: false, error: 'not-disenchantable' };
  const col = await getCollection(env, guildId, userId);
  const owned = (col.cards && col.cards[cardId]) || 0;
  if (owned <= 0) return { ok: false, error: 'not-owned' };
  if (owned === 1 && !opts.force) {
    return { ok: false, error: 'last-copy',
             message: 'Last copy — pass force:true to disenchant your only copy.' };
  }
  col.cards[cardId] = owned - 1;
  if (col.cards[cardId] === 0) delete col.cards[cardId];
  await putCollection(env, guildId, userId, col);
  const gain = DUST_DISENCHANT_BY_RARITY[rarity];
  const dustRes = await adjustDust(env, guildId, userId, gain, `disenchant:${cardId}`);
  return {
    ok: true, cardId, rarity, gain,
    newOwned: col.cards[cardId] || 0, newDust: dustRes.dust,
  };
}

// Charges dust based on rarity. Increments collection by 1.
export async function craft(env, guildId, userId, cardId) {
  const card = CARDS[cardId];
  if (!card) return { ok: false, error: 'unknown-card' };
  const rarity = craftableRarity(card);
  if (!rarity) return { ok: false, error: 'not-craftable' };
  const cost = DUST_CRAFT_BY_RARITY[rarity];

  const w = await getWallet(env, guildId, userId);
  if ((w.dust || 0) < cost) {
    return { ok: false, error: 'insufficient-dust', need: cost, have: w.dust || 0 };
  }
  const col = await getCollection(env, guildId, userId);
  col.cards = col.cards || {};
  col.cards[cardId] = (col.cards[cardId] || 0) + 1;
  await putCollection(env, guildId, userId, col);
  const dustRes = await adjustDust(env, guildId, userId, -cost, `craft:${cardId}`);
  return {
    ok: true, cardId, rarity, cost,
    newOwned: col.cards[cardId], newDust: dustRes.dust,
  };
}
