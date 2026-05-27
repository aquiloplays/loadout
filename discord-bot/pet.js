// Pets — Patreon-gated cosmetic companions with a tamagotchi care
// loop. Spec lives in CHARACTER-SYSTEM-DESIGN.md §12.
//
// Pets are PURELY COSMETIC. They render in-frame alongside the
// viewer's character (paper-doll z=15, between cape and body) but
// have no gameplay effect — no stats, no equipped-slot conflict,
// no Champion bonus, no Bolts payout. The hook is the daily care
// micro-loop + the visible mood overlay on the render.
//
// Storage:
//   pet:<guildId>:<userId>   single record per viewer per channel
//
// Decay model: timestamp-only. Stats persist as
// `{ value: 0..100, lastSetUtc: number }`. On every read we
// compute `current = max(0, value - decayPerHour × hoursSince)`.
// No background tick required — same pattern as the Clash cooldown
// queue.

import { getWallet, applyVaultDelta } from './wallet.js';

// ── Catalogue (cosmetic-only) ────────────────────────────────────
export const SPECIES = [
  'cat', 'dog', 'owl', 'fox', 'slime', 'dragonling', 'frog', 'bunny',
];

// Colour palette per species. Patreon tier (1/2/3) gates the rarer
// rows — the per-tier cutoffs live in PATREON_TIER_GATE below.
export const SPECIES_COLOURS = {
  cat:         ['black', 'tabby', 'ginger', 'calico'],
  dog:         ['cream', 'spotted', 'amber', 'midnight'],
  owl:         ['barn', 'snowy', 'sage', 'twilight'],
  fox:         ['rust', 'arctic', 'plum', 'gold'],
  slime:       ['mint', 'cobalt', 'rose', 'aurora'],
  dragonling:  ['emerald', 'ember', 'storm', 'voltaic'],   // voltaic = brand
  frog:        ['leaf', 'lily', 'inkblot', 'sunburst'],
  bunny:       ['ash', 'cocoa', 'meadow', 'starlight'],
};

// Patreon-tier gate per colour. Index 0 = tier 1+ (any patron),
// 1 = tier 2+, 2 = tier 3+, 3 = tier 3+ (rare). Lets the adoption
// flow surface the right colour set per viewer without a separate
// per-pet lookup table.
const COLOUR_TIER = [1, 1, 2, 3];

// ── Care decay rates (CHARACTER-SYSTEM-DESIGN.md §12) ────────────
const DECAY = {
  hunger:      2,   // /hour
  happiness:   1,   // /hour
  cleanliness: 0.5, // /hour (decays /2h in design doc)
};

// v2 rebalance: paced via economy-pace.js. v1 = 30 min per action;
// v2 = 75 min. Re-adopt cooldown left at 24h (release punishment,
// not a grind knob).
import { PET_CARE_COOLDOWN_MS } from './economy-pace.js';
const COOLDOWN_MS = PET_CARE_COOLDOWN_MS;
const RELEASE_COOLDOWN_MS = 24 * 3_600_000;

const ACTION_COST = {
  feed:  10,
  play:  5,
  clean: 5,
};

// ── KV helpers ──────────────────────────────────────────────────
function petKey(guildId, userId) { return `pet:${guildId}:${userId}`; }
function releaseKey(guildId, userId) { return `pet:released:${guildId}:${userId}`; }

export async function getPet(env, guildId, userId) {
  const raw = await env.LOADOUT_BOLTS.get(petKey(guildId, userId), { type: 'json' });
  return raw || null;
}

async function putPet(env, guildId, userId, pet) {
  pet.lastUpdatedUtc = Date.now();
  await env.LOADOUT_BOLTS.put(petKey(guildId, userId), JSON.stringify(pet));
}

// ── Stat math ───────────────────────────────────────────────────
//
// Stats are stored as `{ value, lastSetUtc }` snapshots. The current
// "what would the bar show right now" value is computed on every
// read by decaying from the last set timestamp. We never mutate
// stored stats on read — that would create write storms.
function currentStat(stat, decayPerHour) {
  if (!stat) return 0;
  const hoursSince = (Date.now() - (stat.lastSetUtc || 0)) / 3_600_000;
  const decayed = (stat.value || 0) - decayPerHour * hoursSince;
  return Math.max(0, Math.min(100, decayed));
}

export function computeMood(pet) {
  if (!pet) return null;
  const hunger      = currentStat(pet.hunger,      DECAY.hunger);
  const happiness   = currentStat(pet.happiness,   DECAY.happiness);
  const cleanliness = currentStat(pet.cleanliness, DECAY.cleanliness);
  const avg = (hunger + happiness + cleanliness) / 3;
  let label = 'happy';
  let hint = null;
  if (avg < 20) {
    label = 'sad';
    const min = Math.min(hunger, happiness, cleanliness);
    if (min === hunger)      hint = 'hungry';
    else if (min === cleanliness) hint = 'dirty';
    else                          hint = 'sad';
  } else if (avg < 50) {
    label = 'sad';
    const min = Math.min(hunger, happiness, cleanliness);
    if (min === hunger)      hint = 'hungry';
    else if (min === cleanliness) hint = 'dirty';
    else                          hint = 'sad';
  } else if (avg < 80) {
    label = 'content';
  } else {
    label = 'happy';
  }
  return {
    label, hint, avg,
    stats: { hunger, happiness, cleanliness },
  };
}

// ── Patreon gate ─────────────────────────────────────────────────
//
// Per CHARACTER-SYSTEM-DESIGN.md §12, /pet adopt is open only to
// wallet records with an active Patreon link. The gate consults
// the existing wallet.links[] array — same model as every other
// Patreon-touched feature.
//
// Tier is inferred from the link entry's `tier` field when present
// (Patreon scope returns the entitled-amount cents, which we
// bucket here). When the linker hasn't written tier metadata we
// default to tier 1 — strictly worse-case for gating colours.
function patreonTierFromWallet(wallet) {
  const links = Array.isArray(wallet?.links) ? wallet.links : [];
  const patreon = links.find(l => (l.platform || '').toLowerCase() === 'patreon');
  if (!patreon) return 0;
  const tier = parseInt(patreon.tier || patreon.tierLevel || '1', 10);
  if (!Number.isFinite(tier) || tier < 1) return 1;
  return Math.min(3, tier);
}

export function isColourUnlocked(species, colour, tier) {
  const colours = SPECIES_COLOURS[species];
  if (!colours) return false;
  const idx = colours.indexOf(colour);
  if (idx < 0) return false;
  return tier >= COLOUR_TIER[idx];
}

export function unlockedColoursForTier(species, tier) {
  const colours = SPECIES_COLOURS[species] || [];
  return colours.filter((_, i) => tier >= COLOUR_TIER[i]);
}

// ── Care actions ────────────────────────────────────────────────
async function checkCooldown(pet, action) {
  const last = pet['last' + action + 'Utc'] || 0;
  if (Date.now() - last < COOLDOWN_MS) {
    const waitMin = Math.ceil((COOLDOWN_MS - (Date.now() - last)) / 60_000);
    return { ok: false, waitMin };
  }
  return { ok: true };
}

async function chargeBolts(env, guildId, userId, amount, reason) {
  const w = await getWallet(env, guildId, userId);
  if ((w.balance || 0) < amount) {
    return { ok: false, error: 'insufficient-bolts', need: amount, have: w.balance || 0 };
  }
  await applyVaultDelta(env, guildId, userId, -amount, reason);
  return { ok: true };
}

// PROGRESSION (P1 trailing) — pet fed XP. Wraps the original
// feed/play/clean entry points: dedup by the UTC date so 1 grant
// per day per pet action.
async function _emitPetCare(env, userId, guildId, kind, petId) {
  try {
    const { emitProgressionEvent } = await import('./progression/event-bus.js');
    const ymd = new Date().toISOString().slice(0, 10);
    await emitProgressionEvent(env, {
      kind, userId, guildId,
      meta: { petId, ymd }, stableKeys: ['ymd', 'petId'],
    });
  } catch { /* non-fatal */ }
}

export async function feedPet(env, guildId, userId) {
  const pet = await getPet(env, guildId, userId);
  if (!pet) return { ok: false, error: 'no-pet' };
  const cd = await checkCooldown(pet, 'Fed');
  if (!cd.ok) return { ok: false, error: 'cooldown', action: 'feed', waitMin: cd.waitMin };
  const charge = await chargeBolts(env, guildId, userId, ACTION_COST.feed, 'pet:feed');
  if (!charge.ok) return charge;
  pet.hunger = { value: 100, lastSetUtc: Date.now() };
  pet.lastFedUtc = Date.now();
  await putPet(env, guildId, userId, pet);
  await _emitPetCare(env, userId, guildId, 'pet.fed', pet.species);
  return { ok: true, pet, mood: computeMood(pet), spent: ACTION_COST.feed };
}

export async function playWithPet(env, guildId, userId) {
  const pet = await getPet(env, guildId, userId);
  if (!pet) return { ok: false, error: 'no-pet' };
  const cd = await checkCooldown(pet, 'Played');
  if (!cd.ok) return { ok: false, error: 'cooldown', action: 'play', waitMin: cd.waitMin };
  const charge = await chargeBolts(env, guildId, userId, ACTION_COST.play, 'pet:play');
  if (!charge.ok) return charge;
  pet.happiness = { value: 100, lastSetUtc: Date.now() };
  pet.lastPlayedUtc = Date.now();
  await putPet(env, guildId, userId, pet);
  return { ok: true, pet, mood: computeMood(pet), spent: ACTION_COST.play };
}

export async function cleanPet(env, guildId, userId) {
  const pet = await getPet(env, guildId, userId);
  if (!pet) return { ok: false, error: 'no-pet' };
  const cd = await checkCooldown(pet, 'Cleaned');
  if (!cd.ok) return { ok: false, error: 'cooldown', action: 'clean', waitMin: cd.waitMin };
  const charge = await chargeBolts(env, guildId, userId, ACTION_COST.clean, 'pet:clean');
  if (!charge.ok) return charge;
  pet.cleanliness = { value: 100, lastSetUtc: Date.now() };
  pet.lastCleanedUtc = Date.now();
  await putPet(env, guildId, userId, pet);
  return { ok: true, pet, mood: computeMood(pet), spent: ACTION_COST.clean };
}

// ── Adoption / rename / release ──────────────────────────────────
export async function adoptPet(env, guildId, userId, species, colour, name) {
  // Refuse if a release-cooldown is still active.
  const releasedRec = await env.LOADOUT_BOLTS.get(releaseKey(guildId, userId), { type: 'json' });
  if (releasedRec?.until && releasedRec.until > Date.now()) {
    const hours = Math.ceil((releasedRec.until - Date.now()) / 3_600_000);
    return { ok: false, error: 'release-cooldown', hours };
  }
  // One pet per viewer per channel — re-adopting overwrites is NOT
  // allowed by design; surface the existing pet so the viewer knows.
  const existing = await getPet(env, guildId, userId);
  if (existing) return { ok: false, error: 'already-have-pet', pet: existing };
  // Patreon gate
  const wallet = await getWallet(env, guildId, userId);
  const tier = patreonTierFromWallet(wallet);
  if (tier === 0) return { ok: false, error: 'not-a-patron' };
  if (!SPECIES.includes(species)) return { ok: false, error: 'bad-species' };
  if (!isColourUnlocked(species, colour, tier)) {
    return { ok: false, error: 'colour-locked', tierNeeded: COLOUR_TIER[(SPECIES_COLOURS[species] || []).indexOf(colour)] };
  }
  const cleanName = String(name || '').trim().slice(0, 16) || species[0].toUpperCase() + species.slice(1);
  const now = Date.now();
  const pet = {
    species, colour, name: cleanName,
    adoptedUtc: now,
    hunger:      { value: 100, lastSetUtc: now },
    happiness:   { value: 100, lastSetUtc: now },
    cleanliness: { value: 100, lastSetUtc: now },
    lastFedUtc: 0, lastPlayedUtc: 0, lastCleanedUtc: 0,
  };
  await putPet(env, guildId, userId, pet);
  // PROGRESSION (P1 trailing) — pet tame XP. Per-species dedup so
  // re-adopting the same species after release grants once.
  try {
    const { emitProgressionEvent } = await import('./progression/event-bus.js');
    await emitProgressionEvent(env, {
      kind: 'pet.tamed', userId, guildId,
      meta: { species, colour, rarity: tier === 3 ? 'legendary' : 'common' },
      stableKeys: ['species'],
    });
  } catch { /* non-fatal */ }
  return { ok: true, pet, mood: computeMood(pet) };
}

export async function renamePet(env, guildId, userId, newName) {
  const pet = await getPet(env, guildId, userId);
  if (!pet) return { ok: false, error: 'no-pet' };
  const cleaned = String(newName || '').trim().slice(0, 16);
  if (!cleaned) return { ok: false, error: 'bad-name' };
  pet.name = cleaned;
  await putPet(env, guildId, userId, pet);
  return { ok: true, pet };
}

export async function releasePet(env, guildId, userId) {
  const pet = await getPet(env, guildId, userId);
  if (!pet) return { ok: false, error: 'no-pet' };
  await env.LOADOUT_BOLTS.delete(petKey(guildId, userId));
  await env.LOADOUT_BOLTS.put(releaseKey(guildId, userId), JSON.stringify({
    species: pet.species,
    releasedUtc: Date.now(),
    until: Date.now() + RELEASE_COOLDOWN_MS,
  }), { expirationTtl: Math.ceil(RELEASE_COOLDOWN_MS / 1000) + 60 });
  return { ok: true, released: pet };
}

// Wallet-side patreon-tier helper, re-exported for the adoption UI.
export async function patreonTierFor(env, guildId, userId) {
  const w = await getWallet(env, guildId, userId);
  return patreonTierFromWallet(w);
}

// ── I2: Pet deliveries (random rewards over time) ───────────────
//
// Pets passively earn "deliveries" — small surprise drops the player
// collects. Cadence is mood-aware: a happy pet brings something
// every 4 h, a sad pet only every 8 h. Up to PET_DELIVERY_CAP
// deliveries can stack while the player is away (≈ 2 days at the
// fast rate). One claim collects all pending and rolls a reward for
// each.
//
// Drop table (per delivery, weighted):
//   bolts-small      40%  20–50 bolts
//   clash-material   20%  50–200 wood/stone/iron/scrap
//   bolts-medium     12%  60–160 bolts
//   fragments        10%  6–15 Boltbound fragments
//   bolts-large       7%  180–400 bolts
//   pack-common       5%  one common Boltbound pack
//   cores             3%  1–3 Clash cores
//   pack-rare         2%  one rare Boltbound pack
//   gear-seed         1%  hero gear-rarity seed (logged for now)
//
// All rewards land in the same systems other features write to —
// no new currencies, no separate inventory. The player just gets a
// nice little pile of stuff when they /pet collect.

const PET_DELIVERY_MS_HAPPY = 4 * 3_600_000;   // 4 h when mood ≥ content
const PET_DELIVERY_MS_SAD   = 8 * 3_600_000;   // 8 h when sad
const PET_DELIVERY_CAP      = 12;              // 48 h at fast rate

export function pendingDeliveriesFor(pet, now = Date.now()) {
  if (!pet) return { count: 0, nextInMs: null };
  const mood = computeMood(pet);
  const intervalMs = (mood?.avg || 0) >= 50 ? PET_DELIVERY_MS_HAPPY : PET_DELIVERY_MS_SAD;
  const last = pet.lastDeliveryUtc || pet.adoptedUtc || now;
  const elapsed = Math.max(0, now - last);
  const count = Math.min(PET_DELIVERY_CAP, Math.floor(elapsed / intervalMs));
  const consumed = count * intervalMs;
  const nextInMs = count >= PET_DELIVERY_CAP ? 0 : (intervalMs - (elapsed - consumed));
  return { count, nextInMs, intervalMs };
}

const DELIVERY_TABLE = [
  { weight: 40, kind: 'bolts-small'    },
  { weight: 20, kind: 'clash-material' },
  { weight: 12, kind: 'bolts-medium'   },
  { weight: 10, kind: 'fragments'      },
  { weight:  7, kind: 'bolts-large'    },
  { weight:  5, kind: 'pack-common'    },
  { weight:  3, kind: 'cores'          },
  { weight:  2, kind: 'pack-rare'      },
  { weight:  1, kind: 'gear-seed'      },
];

function rollDeliveryKind(rand) {
  const total = DELIVERY_TABLE.reduce((s, e) => s + e.weight, 0);
  let r = rand() * total;
  for (const entry of DELIVERY_TABLE) {
    r -= entry.weight;
    if (r <= 0) return entry.kind;
  }
  return DELIVERY_TABLE[0].kind;
}

function randInt(rand, lo, hi) { return lo + Math.floor(rand() * (hi - lo + 1)); }

// Roll one delivery into a concrete reward shape. Pure — no KV writes.
// The mutating side runs in claimPetDeliveries.
function rollOneDelivery(rand) {
  const kind = rollDeliveryKind(rand);
  switch (kind) {
    case 'bolts-small':  return { kind, bolts: randInt(rand, 20, 50) };
    case 'bolts-medium': return { kind, bolts: randInt(rand, 60, 160) };
    case 'bolts-large':  return { kind, bolts: randInt(rand, 180, 400) };
    case 'clash-material': {
      const mats = ['wood', 'stone', 'iron', 'scrap'];
      const mat = mats[Math.floor(rand() * mats.length)];
      return { kind, material: mat, amount: randInt(rand, 50, 200) };
    }
    case 'fragments': return { kind, fragments: randInt(rand, 6, 15) };
    case 'pack-common': return { kind, packType: 'common' };
    case 'pack-rare':   return { kind, packType: 'rare' };
    case 'cores':       return { kind, cores: randInt(rand, 1, 3) };
    case 'gear-seed':   return { kind, gearRarity: 'rare' };
    default:            return { kind: 'bolts-small', bolts: 20 };
  }
}

export async function claimPetDeliveries(env, guildId, userId) {
  const pet = await getPet(env, guildId, userId);
  if (!pet) return { ok: false, error: 'no-pet' };
  const pending = pendingDeliveriesFor(pet);
  if (pending.count <= 0) {
    return {
      ok: true,
      claimed: 0,
      rewards: [],
      nextInMs: pending.nextInMs,
      nextDeliveryUtc: Date.now() + (pending.nextInMs || 0),
      petName: pet.name,
    };
  }
  // Deterministic-ish PRNG seeded by pet + lastDeliveryUtc so a retry
  // (e.g. KV write failure on a flaky network) doesn't double-issue
  // a different set of rewards. Mulberry32-style scrambled seed.
  let seed = ((pet.lastDeliveryUtc || pet.adoptedUtc || 1) ^ 0x9E3779B9) >>> 0;
  const rand = () => {
    seed = (seed + 0x6D2B79F5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rewards = [];
  for (let i = 0; i < pending.count; i++) rewards.push(rollOneDelivery(rand));

  // Apply each reward through the canonical helper.
  let totalBolts = 0;
  const summary = { bolts: 0, materials: {}, fragments: 0, cores: 0, packs: [] };
  for (const r of rewards) {
    try {
      if (r.bolts) {
        totalBolts += r.bolts;
        summary.bolts += r.bolts;
      } else if (r.material) {
        const { addResources } = await import('./clash-resources.js');
        await addResources(env, guildId, { [r.material]: r.amount });
        summary.materials[r.material] = (summary.materials[r.material] || 0) + r.amount;
      } else if (r.cores) {
        const { addResources } = await import('./clash-resources.js');
        await addResources(env, guildId, { cores: r.cores });
        summary.cores += r.cores;
      } else if (r.fragments) {
        const { addFragments } = await import('./cards-fragments.js');
        await addFragments(env, userId, r.fragments, 'pet:delivery');
        summary.fragments += r.fragments;
      } else if (r.packType) {
        const { creditPack } = await import('./cards-packs.js');
        await creditPack(env, guildId, userId, r.packType, 'pet:delivery');
        summary.packs.push(r.packType);
      } else if (r.gearRarity) {
        // Logged-only for now — gear seeding requires a hero context
        // that the random-drop path doesn't have. Tracked as a future
        // hook into dungeon.js shop rolls.
        summary.gearSeed = r.gearRarity;
      }
    } catch (e) {
      console.warn('[pet] delivery apply failed:', r.kind, e && e.message);
    }
  }
  if (totalBolts > 0) {
    await applyVaultDelta(env, guildId, userId, totalBolts, 'pet:delivery');
  }

  // Advance the lastDeliveryUtc by (count × interval) so leftover
  // partial progress carries into the next cycle. Don't reset to
  // Date.now() — that would silently discard up to 4 h of accrual on
  // every claim.
  pet.lastDeliveryUtc = (pet.lastDeliveryUtc || pet.adoptedUtc || Date.now())
    + pending.count * pending.intervalMs;
  await putPet(env, guildId, userId, pet);

  return {
    ok: true,
    claimed: pending.count,
    rewards,
    summary,
    nextInMs: pending.intervalMs,
    nextDeliveryUtc: Date.now() + pending.intervalMs,
    petName: pet.name,
  };
}

// PROGRESSION (P2) — pet collection headline.
export async function getStatsFor(env, userId, _guildId = null) {
  let tamed = 0;
  const species = new Set();
  let legendary = 0;
  let cursor;
  for (let i = 0; i < 5; i++) {
    const r = await env.LOADOUT_BOLTS.list({ prefix: 'pet:', cursor, limit: 1000 });
    for (const k of r.keys) {
      if (k.name.startsWith('pet:released:')) continue;
      if (!k.name.endsWith(':' + userId)) continue;
      const p = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
      if (!p) continue;
      tamed++;
      if (p.species) species.add(p.species);
      if (p.rarity === 'legendary') legendary++;
    }
    if (r.list_complete) break;
    cursor = r.cursor;
  }
  return {
    primary: { label: 'Pets', value: tamed },
    secondary: [
      { label: 'Species', value: species.size },
      { label: 'Legendary', value: legendary },
    ],
    iconKind: 'pet-paw',
  };
}
