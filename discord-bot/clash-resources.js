// Clash Expansion — resource economy: treasury extension, gather
// tasks, collector buildings, capacity helpers.
//
// See CLASH-EXPANSION-DESIGN.md §3. Bolts/Scrap/Cores are the legacy
// resources (clash-state.js owns them); this module layers Wood,
// Stone, Iron, Gold on top with the same read-time-walker discipline
// the rest of Clash uses (no background ticks; everything reconciles
// on next read).
//
// Why separate from clash-state.js: state.js is already 568 lines
// and the resource economy is large enough to deserve its own
// surface. Storage helpers live here; clash-state.js's getTreasury /
// addTreasury get patched in-place to forward through these so
// callers don't have to know there are seven resources now.

import { getTown, getTreasury, putTreasury, putTown, adjustTrophies } from './clash-state.js';
import { BUILDINGS } from './clash-content.js';

// ── The new resource keys ─────────────────────────────────────────────
//
// Plus the legacy three (bolts/scrap/cores) which still live on the
// treasury but are managed by clash-state.js. RES_NEW is what this
// module owns end-to-end.

export const RES_NEW = ['wood', 'stone', 'iron', 'gold'];
export const RES_ALL = ['bolts', 'scrap', 'cores', 'wood', 'stone', 'iron', 'gold'];

// Per-resource default cap when no storage building exists for that
// resource. Picked so a first-day TH1 town can hoard one short gather
// without immediate overflow.
const DEFAULT_CAP = {
  bolts: 2000,
  scrap: 2000,
  cores: 50,
  wood: 1500,
  stone: 800,
  iron: 200,
  gold: 80,
};

// ── Treasury — extended shape ─────────────────────────────────────────
//
// Pre-expansion shape: { bolts, scrap, cores, capacity }
// Post-expansion:      { bolts, scrap, cores, wood, stone, iron, gold,
//                        capacity: { bolts, scrap, cores, wood, stone, iron, gold } }
//
// Backfill on read: any old treasury doc with `capacity: <number>`
// (scalar) is rewritten to the object shape with the scalar applied to
// bolts/scrap/wood/stone, defaults applied to the rest. Cores has its
// own historical default (2000 in v1 → 50 in v2 because cores is rare
// loot, not a stocked resource); we preserve the existing cores number
// if any are present.

export function normaliseTreasury(t, townBuildings) {
  if (!t || typeof t !== 'object') t = {};
  const out = { ...t };
  for (const k of RES_ALL) {
    if (!Number.isFinite(out[k])) out[k] = 0;
  }
  // Capacity migration: scalar number → object keyed by resource.
  if (typeof out.capacity === 'number' || !out.capacity) {
    const legacyCap = typeof out.capacity === 'number' ? out.capacity : 0;
    out.capacity = capacityFromBuildings(townBuildings || [], legacyCap);
  } else {
    // Already an object — make sure every key is present, fill
    // missing ones from collector storage + defaults.
    const fresh = capacityFromBuildings(townBuildings || [], 0);
    for (const k of RES_ALL) {
      if (!Number.isFinite(out.capacity[k])) out.capacity[k] = fresh[k];
    }
  }
  return out;
}

// Compute per-resource capacity from the town's storages + collectors.
// Each Storage / Reserve building contributes its capacityBonus; each
// collector contributes its built-in buffer cap.
export function capacityFromBuildings(buildings, legacyBoltsCap = 0) {
  const cap = { ...DEFAULT_CAP };
  if (legacyBoltsCap > 0) {
    // Honour a streamer's existing bolts/scrap headroom from v1.
    cap.bolts = legacyBoltsCap;
    cap.scrap = legacyBoltsCap;
  }
  for (const b of buildings) {
    if (!b || b.status === 'destroyed') continue;
    const def = BUILDINGS[b.kind];
    if (!def) continue;
    const level = Math.max(1, b.level || 1);
    // Generic Storage building (legacy) — applies to bolts/scrap/wood/stone
    // proportionally. Keeps existing storage upgrades meaningful in v2.
    if (b.kind === 'storage' && Array.isArray(def.capacityBonus)) {
      const bonus = def.capacityBonus[level] || 0;
      cap.bolts += bonus;
      cap.scrap += bonus;
      cap.wood  += bonus;
      cap.stone += Math.floor(bonus / 2);
    }
    // New per-resource Reserve buildings (slug 'xVault' kept for KV back-compat).
    const vaultMap = {
      lumberVault: 'wood',
      stoneVault:  'stone',
      ironVault:   'iron',
      goldVault:   'gold',
    };
    if (vaultMap[b.kind] && Array.isArray(def.capacityBonus)) {
      const bonus = def.capacityBonus[level] || 0;
      cap[vaultMap[b.kind]] += bonus;
    }
    // Collector buildings carry a built-in storage component.
    // §3.4: Sawmill 800 / Quarry 400 / Forge 100 / Mint 60 at L1, scaling.
    if (def.collectorOf && Array.isArray(def.collectorStorage)) {
      const slot = def.collectorOf;
      cap[slot] += def.collectorStorage[level] || 0;
    }
  }
  return cap;
}

// Add to one or more resources, clamping each to its cap. Used by
// gather completion, collector tap, raid loot. Returns the patched
// treasury.
export async function addResources(env, guildId, delta) {
  const town = await getTown(env, guildId);
  const tRaw = await getTreasury(env, guildId);
  const t = normaliseTreasury(tRaw, town?.buildings || []);
  for (const k of RES_ALL) {
    if (!Number.isFinite(delta[k])) continue;
    const cap = t.capacity[k] || 0;
    t[k] = Math.max(0, Math.min(cap || Number.MAX_SAFE_INTEGER, (t[k] || 0) + delta[k]));
  }
  await putTreasury(env, guildId, t);
  return t;
}

// Charge a build/repair cost. Returns { ok, treasury, missing? }.
// Missing is the resources the treasury is short on (so callers can
// render a clear "need 240 more wood" message).
export async function chargeResources(env, guildId, cost) {
  const town = await getTown(env, guildId);
  const tRaw = await getTreasury(env, guildId);
  const t = normaliseTreasury(tRaw, town?.buildings || []);
  const missing = {};
  let short = false;
  for (const k of RES_ALL) {
    const need = Number(cost[k]) || 0;
    if (need <= 0) continue;
    if ((t[k] || 0) < need) {
      missing[k] = need - (t[k] || 0);
      short = true;
    }
  }
  if (short) return { ok: false, treasury: t, missing };
  for (const k of RES_ALL) {
    const need = Number(cost[k]) || 0;
    if (need > 0) t[k] = Math.max(0, (t[k] || 0) - need);
  }
  await putTreasury(env, guildId, t);
  return { ok: true, treasury: t };
}

// ── Collectors (passive resource stream) ──────────────────────────────
//
// Each Sawmill / Quarry / Forge / Mint accrues its resource into a
// per-building buffer until tapped (manually via /clash tap or
// automatically every 4h) or the building's own buffer cap is hit.
// Damaged collectors produce at 50% rate. Destroyed collectors don't
// produce.
//
// Read-time walker: syncCollectors(town) mutates each collector's
// storedYield in place based on elapsed time × productionRate. Caller
// is responsible for writing the town back after the walk.

const COLLECTOR_AUTO_FLUSH_MS = 4 * 60 * 60 * 1000;   // 4h
const DAMAGED_PRODUCTION_MULT = 0.5;

export function syncCollectors(town, nowUtc = Date.now()) {
  if (!town || !Array.isArray(town.buildings)) return town;
  let mutated = false;
  for (const b of town.buildings) {
    const def = BUILDINGS[b.kind];
    if (!def?.collectorOf) continue;
    if (!b.collector) {
      b.collector = { storedYield: 0, lastTickUtc: nowUtc };
      mutated = true;
      continue;
    }
    if (b.status === 'destroyed') {
      // Frozen — don't accrue while destroyed.
      b.collector.lastTickUtc = nowUtc;
      continue;
    }
    const lvl = Math.max(1, b.level || 1);
    const ratePerMin = def.productionRate?.[lvl] || 0;
    if (ratePerMin <= 0) continue;
    const cap = def.collectorStorage?.[lvl] || 0;
    const mult = b.status === 'damaged' ? DAMAGED_PRODUCTION_MULT : 1.0;
    const elapsedMs = Math.max(0, nowUtc - (b.collector.lastTickUtc || nowUtc));
    const gained = Math.floor((elapsedMs / 60_000) * ratePerMin * mult);
    if (gained > 0) {
      const wasStored = b.collector.storedYield || 0;
      b.collector.storedYield = Math.min(cap, wasStored + gained);
      b.collector.lastTickUtc = nowUtc;
      mutated = true;
    } else if (elapsedMs > 30_000) {
      // Refresh the tick stamp so very-small-rate collectors don't
      // perma-stall their elapsedMs forever (floor(0.001 × 5min) = 0).
      b.collector.lastTickUtc = nowUtc;
      mutated = true;
    }
  }
  return mutated;
}

// E2: storage leak walker — for every damaged/destroyed reserve or
// storage, drain 2% of held resources per elapsed minute since the
// last walk, capped at 30% per pass. Called from syncCooldowns just
// like syncCollectors. Returns true if treasury changed (caller
// should syncCollectors-style write).
//
// Treasury is mutated in place. The town carries
// `lastStorageLeakUtc` so partial-minute walks aren't double-billed.
const STORAGE_LEAK_VAULTS = new Set([
  'storage', 'lumberVault', 'stoneVault', 'ironVault', 'goldVault',
]);
const STORAGE_LEAK_RATE_PER_MIN = 0.02;
const STORAGE_LEAK_CAP = 0.30;

export function applyStorageLeak(town, treasury, nowUtc = Date.now()) {
  if (!town || !treasury) return false;
  const damaged = (town.buildings || []).filter(b =>
    STORAGE_LEAK_VAULTS.has(b.kind) && (b.status === 'damaged' || b.status === 'destroyed')
  );
  const last = town.lastStorageLeakUtc || nowUtc;
  const minutes = Math.floor((nowUtc - last) / 60_000);
  if (minutes <= 0) {
    town.lastStorageLeakUtc = nowUtc;
    return false;
  }
  if (!damaged.length) {
    // Even with no damaged storage, advance the timestamp so a
    // future bout of damage doesn't claim hours of "stored" minutes.
    town.lastStorageLeakUtc = nowUtc;
    return false;
  }
  const factor = Math.min(STORAGE_LEAK_CAP, STORAGE_LEAK_RATE_PER_MIN * minutes);
  let changed = false;
  for (const k of ['wood', 'stone', 'iron', 'gold', 'scrap']) {
    const cur = treasury[k] || 0;
    if (cur > 0) {
      const lost = Math.floor(cur * factor);
      if (lost > 0) {
        treasury[k] = cur - lost;
        changed = true;
      }
    }
  }
  town.lastStorageLeakUtc = nowUtc;
  return changed;
}

// Tap one or all collectors into the treasury. Returns the per-resource
// collected map so the caller can show a "you collected ..." message.
export async function tapCollectors(env, guildId, buildingId = null) {
  const town = await getTown(env, guildId);
  if (!town) return { collected: {}, treasury: null };
  syncCollectors(town);
  const collected = { wood: 0, stone: 0, iron: 0, gold: 0 };
  for (const b of town.buildings) {
    if (buildingId && b.id !== buildingId) continue;
    const def = BUILDINGS[b.kind];
    if (!def?.collectorOf) continue;
    const slot = def.collectorOf;
    const stored = b.collector?.storedYield || 0;
    if (stored > 0) {
      collected[slot] = (collected[slot] || 0) + stored;
      b.collector.storedYield = 0;
    }
  }
  await putTown(env, guildId, town);
  if (Object.values(collected).some(v => v > 0)) {
    const t = await addResources(env, guildId, collected);
    return { collected, treasury: t };
  }
  const t = await getTreasury(env, guildId);
  return { collected, treasury: normaliseTreasury(t, town.buildings) };
}

// Auto-flush any collector whose lastTickUtc is older than 4h. Called
// from the cron tick + opportunistically on every status read.
export async function autoFlushIfDue(env, guildId, nowUtc = Date.now()) {
  const town = await getTown(env, guildId);
  if (!town) return null;
  const due = (town.buildings || []).some(b => {
    const def = BUILDINGS[b.kind];
    if (!def?.collectorOf) return false;
    const last = b.collector?.lastTickUtc || 0;
    return nowUtc - last > COLLECTOR_AUTO_FLUSH_MS;
  });
  if (!due) return null;
  return tapCollectors(env, guildId);
}

// ── Gather tasks (per-viewer timed jobs) ──────────────────────────────
//
// A viewer runs `/clash gather <resource> <tier>`; a task lands in
// their personal queue and pays the town treasury when complete.
// Same read-time-walker model: every status/town read calls
// syncGatherTasks() to fire completions.

export const GATHER_RESOURCES = ['wood', 'stone', 'iron', 'gold'];

// (tier, resource) → { ms, yield }. Per §3.3.
export const GATHER_TIERS = {
  short: {
    ms: 5 * 60_000,
    yield: { wood: 80,   stone: 30,   iron: 8,    gold: 2   },
  },
  medium: {
    ms: 30 * 60_000,
    yield: { wood: 600,  stone: 250,  iron: 70,   gold: 18  },
  },
  long: {
    ms: 2 * 60 * 60_000,
    yield: { wood: 3000, stone: 1400, iron: 380,  gold: 100 },
  },
  overnight: {
    ms: 8 * 60 * 60_000,
    yield: { wood: 14000, stone: 6500, iron: 1700, gold: 480 },
  },
};

// Trophies awarded on each gather completion (small per-viewer reward
// for communal labour — see §3.3 deposit rule).
const GATHER_TROPHY = { short: 5, medium: 15, long: 40, overnight: 120 };

// Daily caps — §14 anti-abuse. 8 gathers per resource per UTC day.
const GATHER_DAILY_CAP = 8;

// Concurrency cap: 1 active gather per viewer at TH1, +1 per Workshop
// up to 4. Workshop building level doesn't matter; the level field
// caps at the Workshop's max level (4) by design.
function gatherSlots(town) {
  if (!town) return 1;
  const workshops = (town.buildings || []).filter(b => b.kind === 'workshop' && b.status !== 'destroyed');
  return Math.min(4, 1 + workshops.length);
}

function gatherKey(guildId, userId) {
  return `clash:gather:${guildId}:${userId}`;
}
function gatherDailyKey(guildId, userId, ymd, resource) {
  return `clash:gathercount:${guildId}:${userId}:${ymd}:${resource}`;
}

function todayYmdUtc(now = Date.now()) {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

export async function getGatherQueue(env, guildId, userId) {
  const raw = await env.LOADOUT_BOLTS.get(gatherKey(guildId, userId), { type: 'json' });
  return raw || { items: [] };
}

async function putGatherQueue(env, guildId, userId, q) {
  await env.LOADOUT_BOLTS.put(gatherKey(guildId, userId), JSON.stringify(q));
}

// Start a gather task. Returns { ok, task?, error? }.
export async function startGather(env, guildId, userId, resource, tier) {
  if (!GATHER_RESOURCES.includes(resource)) {
    return { ok: false, error: 'unknown-resource' };
  }
  if (!GATHER_TIERS[tier]) {
    return { ok: false, error: 'unknown-tier' };
  }
  const town = await getTown(env, guildId);
  if (!town) return { ok: false, error: 'no-town' };
  const slots = gatherSlots(town);
  const q = await getGatherQueue(env, guildId, userId);
  if ((q.items || []).length >= slots) {
    return { ok: false, error: 'no-slots', slots, used: q.items.length };
  }
  // Daily cap per (user, resource).
  const ymd = todayYmdUtc();
  const dkey = gatherDailyKey(guildId, userId, ymd, resource);
  const usedToday = parseInt((await env.LOADOUT_BOLTS.get(dkey)) || '0', 10) || 0;
  if (usedToday >= GATHER_DAILY_CAP) {
    return { ok: false, error: 'daily-cap-hit', cap: GATHER_DAILY_CAP, resource };
  }

  const def = GATHER_TIERS[tier];
  const now = Date.now();
  const task = {
    id: 'gather:' + now + ':' + Math.floor(Math.random() * 1e6),
    resource,
    tier,
    startedUtc: now,
    endsAt: now + def.ms,
    yield: def.yield[resource] || 0,
    trophy: GATHER_TROPHY[tier] || 0,
  };
  q.items = (q.items || []).concat(task);
  await putGatherQueue(env, guildId, userId, q);
  await env.LOADOUT_BOLTS.put(dkey, String(usedToday + 1), { expirationTtl: 26 * 60 * 60 });
  return { ok: true, task, slots, used: q.items.length };
}

// Walk a viewer's gather queue, complete any tasks past endsAt, deposit
// yield to the town treasury, grant trophies. Returns the list of
// completed task records so the caller can fire push notifications.
//
// Idempotent — repeated calls past completion are no-ops (the completed
// task is removed from the queue inside this call).
export async function syncGatherTasks(env, guildId, userId, nowUtc = Date.now()) {
  const q = await getGatherQueue(env, guildId, userId);
  if (!q.items || !q.items.length) return [];
  const completed = [];
  const remaining = [];
  for (const it of q.items) {
    if (it.endsAt && it.endsAt <= nowUtc) {
      completed.push(it);
    } else {
      remaining.push(it);
    }
  }
  if (!completed.length) return [];
  // Deposit each completed task's yield. Batch so we hit treasury KV
  // a single time even if a viewer completed multiple tasks at once.
  const delta = { wood: 0, stone: 0, iron: 0, gold: 0 };
  for (const c of completed) {
    delta[c.resource] = (delta[c.resource] || 0) + (c.yield || 0);
  }
  if (Object.values(delta).some(v => v > 0)) {
    await addResources(env, guildId, delta);
  }
  // Trophies are per-viewer.
  let trophyTotal = 0;
  for (const c of completed) trophyTotal += c.trophy || 0;
  if (trophyTotal > 0) {
    await adjustTrophies(env, guildId, userId, trophyTotal);
  }
  q.items = remaining;
  await putGatherQueue(env, guildId, userId, q);
  return completed;
}

// Cancel a gather task. No partial credit. Returns true if a task was
// found + removed.
export async function cancelGather(env, guildId, userId, taskId) {
  const q = await getGatherQueue(env, guildId, userId);
  const before = (q.items || []).length;
  q.items = (q.items || []).filter(it => it.id !== taskId);
  if (q.items.length === before) return false;
  await putGatherQueue(env, guildId, userId, q);
  return true;
}

// Helper for status renderers — minutes-until-completion per task.
export function gatherProgressLines(queue, nowUtc = Date.now()) {
  if (!queue || !queue.items || !queue.items.length) return [];
  return queue.items.map(it => {
    const msLeft = Math.max(0, (it.endsAt || 0) - nowUtc);
    const minLeft = Math.ceil(msLeft / 60_000);
    return {
      id: it.id,
      resource: it.resource,
      tier: it.tier,
      yield: it.yield,
      minutesLeft: minLeft,
      done: minLeft === 0,
    };
  });
}
