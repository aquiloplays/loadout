// Boltbound — per-card "dust" economy primitive.
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
// Locked tables (CARD-GAME-DESIGN.md §14b — per-card dust). These match
// the client defaults baked into the site crafting UI so the worker is
// authoritative without the UI having to re-fetch a cost table.

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
