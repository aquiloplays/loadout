// Animated Boltbound card backs — Patreon-exclusive cosmetic.
//
// 2026-05-29 sprint. 15 designs across 3 Patreon tiers. Per-user
// selection persists; bootstrap surfaces the pick so the renderer
// applies it to face-down displays.
//
// KV layout:
//   card-back-pref:<userId>           { backId, setUtc }
//   pixel-art-card-back:<backId>      raw PNG bytes (when assets land)

import { getPatreonTier } from './patreon-link.js';

const WORKER_HOST = 'loadout-discord.aquiloplays.workers.dev';
const DEFAULT_BACK = 'universal';
const PATREON_URL  = 'https://www.patreon.com/cw/aquilo/membership';

// Tier ordering — higher number unlocks all entries at or below.
const TIER_RANK = { 'tier-1': 1, 'tier-2': 2, 'tier-3': 3 };

// 15 designs, mix of pulse / spin / drift / glow animations. The
// universal back is always available to everyone (no tier req).
export const ANIMATED_CARD_BACKS = Object.freeze([
  { id: 'universal',         name: 'Universal',         tier: null,     animationKind: 'static' },
  // Tier 1 — 5 backs
  { id: 'aurora-pulse',      name: 'Aurora Pulse',      tier: 'tier-1', animationKind: 'pulse' },
  { id: 'twilight-fade',     name: 'Twilight Fade',     tier: 'tier-1', animationKind: 'pulse' },
  { id: 'firefly-drift',     name: 'Firefly Drift',     tier: 'tier-1', animationKind: 'drift' },
  { id: 'wave-cascade',      name: 'Wave Cascade',      tier: 'tier-1', animationKind: 'drift' },
  { id: 'starfield-soft',    name: 'Starfield Soft',    tier: 'tier-1', animationKind: 'pulse' },
  // Tier 2 — 5 backs
  { id: 'cosmic-spiral',     name: 'Cosmic Spiral',     tier: 'tier-2', animationKind: 'spin' },
  { id: 'phoenix-rise',      name: 'Phoenix Rise',      tier: 'tier-2', animationKind: 'glow' },
  { id: 'lunar-cycle',       name: 'Lunar Cycle',       tier: 'tier-2', animationKind: 'spin' },
  { id: 'thundercrash',      name: 'Thundercrash',      tier: 'tier-2', animationKind: 'flash' },
  { id: 'glacier-bloom',     name: 'Glacier Bloom',     tier: 'tier-2', animationKind: 'pulse' },
  // Tier 3 — 5 backs
  { id: 'aurora-imperial',   name: 'Aurora Imperial',   tier: 'tier-3', animationKind: 'glow' },
  { id: 'celestial-throne',  name: 'Celestial Throne',  tier: 'tier-3', animationKind: 'glow' },
  { id: 'voidwalker',        name: 'Voidwalker',        tier: 'tier-3', animationKind: 'spin' },
  { id: 'apex-aurora',       name: 'Apex Aurora',       tier: 'tier-3', animationKind: 'glow' },
  { id: 'patron-aquilo',     name: 'Patron Aquilo',     tier: 'tier-3', animationKind: 'glow' },
]);

const BY_ID = Object.fromEntries(ANIMATED_CARD_BACKS.map(b => [b.id, b]));

function spriteUrl(id) { return `https://${WORKER_HOST}/asset/card-back-art/${id}.png`; }

function tierMatch(callerTier, requiredTier) {
  if (!requiredTier) return true;          // universal — anyone
  const cur = TIER_RANK[callerTier] || 0;
  const req = TIER_RANK[requiredTier] || 99;
  return cur >= req;
}

async function callerTier(env, userId) {
  try {
    const r = await getPatreonTier(env, userId);
    if (!r?.linked || !r?.paid || !r?.tier) return null;
    // Normalise to tier-1/2/3 if the catalogue uses other naming.
    const lower = String(r.tier).toLowerCase();
    const m = lower.match(/tier[\s-]?(\d)/);
    if (m) return `tier-${m[1]}`;
    return null;
  } catch { return null; }
}

// Backs catalogue projected for the caller — unlocks marked, locked
// entries carry unlock_url instead of asset_url.
export async function listCardBacksForUser(env, userId) {
  const tier = await callerTier(env, userId);
  const pref = await env.LOADOUT_BOLTS.get(`card-back-pref:${userId}`, { type: 'json' });
  const selectedId = pref?.backId && BY_ID[pref.backId] && tierMatch(tier, BY_ID[pref.backId].tier)
    ? pref.backId : DEFAULT_BACK;
  const backs = ANIMATED_CARD_BACKS.map(b => {
    const unlocked = tierMatch(tier, b.tier);
    return {
      id:        b.id,
      name:      b.name,
      tier:      b.tier,
      animationKind: b.animationKind,
      unlocked,
      selected:  b.id === selectedId,
      asset_url: unlocked ? spriteUrl(b.id) : null,
      ...(unlocked ? {} : { unlock_url: PATREON_URL }),
    };
  });
  return {
    ok: true,
    callerTier: tier,
    selectedId,
    backs,
  };
}

// Set the caller's preferred back. Server validates tier ownership.
export async function setCardBackForUser(env, userId, opts = {}) {
  const backId = String(opts.backId || '').trim();
  const back = BY_ID[backId];
  if (!back) return { ok: false, error: 'bad-back-id' };
  const tier = await callerTier(env, userId);
  if (!tierMatch(tier, back.tier)) {
    return { ok: false, error: 'patreon-tier-required',
             message: `${back.name} requires ${back.tier}.`,
             unlockUrl: PATREON_URL };
  }
  await env.LOADOUT_BOLTS.put(`card-back-pref:${userId}`,
    JSON.stringify({ backId, setUtc: new Date().toISOString() }));
  return { ok: true, backId, back };
}

// Compact bootstrap snippet — the routeState in cards-web.js spreads
// this into its response so the site renderer has the user's pick
// without a follow-up call.
export async function resolveBootstrapCardBack(env, userId) {
  const pref = await env.LOADOUT_BOLTS.get(`card-back-pref:${userId}`, { type: 'json' });
  const tier = await callerTier(env, userId);
  let backId = pref?.backId && BY_ID[pref.backId] && tierMatch(tier, BY_ID[pref.backId].tier)
    ? pref.backId : DEFAULT_BACK;
  const back = BY_ID[backId];
  return {
    backId,
    isAnimated:    back.animationKind !== 'static',
    spriteUrl:     spriteUrl(backId),
    animationKind: back.animationKind,
  };
}
