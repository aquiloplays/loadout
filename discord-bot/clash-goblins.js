// Clash Expansion E2 — random goblin raids on player towns.
//
// CLASH-EXPANSION-DESIGN.md §4: NPC goblin raids hit every active
// town 1–4 times per UTC day, scaled to TH. The simulator and damage
// writeback are shared with PvP raids, so a town that just got hit by
// goblins behaves identically (damaged buildings need repair,
// def-snapshot regenerates against the damaged layout) when a real
// player comes calling next.
//
// Scheduling lives here (not in clash-cron.js) so the per-town
// scheduler state + the fire path are colocated. clash-cron's hourly
// tick just calls `scheduleGoblinRaids(env)` which walks the mm-tier
// buckets, advances each town's `clash:goblinsched:<guildId>` record,
// and fires raids whose `nextRaidUtc` has passed.

import {
  getTown, putTown, getTreasury, putTreasury,
  getShield, getDefenseSnapshot, refreshDefenseSnapshot,
  putRaid, appendRaidLog,
  isTownExcluded,
} from './clash-state.js';
import {
  BUILDINGS, generateGoblinArmy, repairBuildingCost,
} from './clash-content.js';
import { simulate } from './clash-raid.js';
import { appendClashEvent } from './clash-http.js';

// ── Tunables ─────────────────────────────────────────────────────────

// Daily raid counts per TH, per design §4.2. Range -> picks a random
// integer in [min, max] at each midnight reset.
const DAILY_RAIDS_BY_TH = {
  1: [0, 0], 2: [1, 1], 3: [1, 2], 4: [2, 2], 5: [2, 3],
  6: [3, 3], 7: [3, 3], 8: [3, 4], 9: [4, 4], 10: [4, 4],
};
// Each raid is timed to land in a random window so streamers can't
// predict ticks. Window length = 4h per design.
const WINDOW_MS = 4 * 3_600_000;
// At TH 8+, one of the day's raids is a Warband. Picked when the
// scheduler is generating the day's slot list.
const WARBAND_TH_MIN = 8;
// Goblins skip these states.
function townInGracePeriod(town) {
  // First 24h after townhall L1 ensure-create — kept simple by
  // looking at the THL=1 status.
  return (town?.thLevel || 1) === 1;
}

// ── Scheduler ────────────────────────────────────────────────────────

const SCHED_KEY = guildId => `clash:goblinsched:${guildId}`;

async function getSchedule(env, guildId) {
  const raw = await env.LOADOUT_BOLTS.get(SCHED_KEY(guildId), { type: 'json' });
  return raw || null;
}

async function putSchedule(env, guildId, sched) {
  // 48h TTL — the schedule self-heals at every midnight reset, so we
  // don't need permanent storage. TTL cleanup keeps KV tidy.
  await env.LOADOUT_BOLTS.put(SCHED_KEY(guildId), JSON.stringify(sched), {
    expirationTtl: 60 * 60 * 48,
  });
}

// Plan the day's raid slot timestamps for a given TH level. Returns
// an array of `{ atUtc, mode }`. Mode is 'warband' for one slot per
// day at TH 8+, 'normal' otherwise. Slots are sorted ascending.
function planDay(thLevel, nowUtc) {
  const [lo, hi] = DAILY_RAIDS_BY_TH[Math.max(1, Math.min(10, thLevel))] || [0, 0];
  const count = lo + Math.floor(Math.random() * (hi - lo + 1));
  if (count === 0) return [];
  // Spread slots across the next 24h, each in its own ~4h window so
  // they don't clump. Slot i lands at slotStart + jitter where
  // slotStart = i × (24h / count).
  const startOfDay = Math.floor(nowUtc / 86_400_000) * 86_400_000;
  const slotSpan = 86_400_000 / count;
  const slots = [];
  for (let i = 0; i < count; i++) {
    const slotStart = startOfDay + Math.round(i * slotSpan);
    const jitter = Math.floor(Math.random() * Math.min(WINDOW_MS, slotSpan));
    slots.push({ atUtc: slotStart + jitter, mode: 'normal' });
  }
  // Promote one slot to 'warband' at TH 8+.
  if (thLevel >= WARBAND_TH_MIN && slots.length > 0) {
    const wi = Math.floor(Math.random() * slots.length);
    slots[wi].mode = 'warband';
  }
  // Slots in the past (we're mid-day) get pushed to "right now" so
  // they fire on the next scheduler tick instead of being dropped —
  // important when a town gets its first schedule mid-day.
  for (const s of slots) {
    if (s.atUtc < nowUtc - 60_000) s.atUtc = nowUtc + Math.floor(Math.random() * 600_000);
  }
  slots.sort((a, b) => a.atUtc - b.atUtc);
  return slots;
}

// Reset/rebuild a town's schedule at midnight UTC, or initialise it
// the first time we see this town.
function freshSchedule(town, nowUtc) {
  const slots = planDay(town.thLevel || 1, nowUtc);
  return {
    dailyResetUtc: Math.floor(nowUtc / 86_400_000) * 86_400_000 + 86_400_000,
    pending: slots,
    fired: [],
  };
}

// Top-level: called from the hourly cron. Walks every active town
// (via the mm tier buckets — same source the matchmaker uses) and
// fires any raid whose schedule slot is due. Bounded — runs in well
// under the 30s cron CPU budget at community sizes <10k towns.
//
// Returns a summary array of `{ guildId, fired: bool, reason }` for
// logging.
export async function scheduleGoblinRaids(env) {
  const now = Date.now();
  const out = [];
  const tiers = ['bronze', 'silver', 'gold', 'platinum', 'diamond'];
  const seen = new Set();
  for (const tier of tiers) {
    const bucket = await env.LOADOUT_BOLTS.get('clash:mm:tier:' + tier, { type: 'json' });
    if (!Array.isArray(bucket)) continue;
    for (const entry of bucket) {
      const guildId = entry?.guildId;
      if (!guildId || seen.has(guildId)) continue;
      seen.add(guildId);
      try {
        const r = await tickTown(env, guildId, now);
        out.push({ guildId, ...r });
      } catch (e) {
        console.warn('[clash-goblins] tick failed for', guildId, e && e.message);
        out.push({ guildId, fired: false, reason: 'error:' + (e && e.message || 'unknown') });
      }
    }
  }
  return out;
}

// Single-town tick: advance schedule, fire one raid if due, persist.
async function tickTown(env, guildId, now) {
  const town = await getTown(env, guildId);
  if (!town) return { fired: false, reason: 'no-town' };
  if (await isTownExcluded(env, guildId)) return { fired: false, reason: 'excluded' };
  if (townInGracePeriod(town)) return { fired: false, reason: 'grace' };
  if (town.matchmakingPaused) return { fired: false, reason: 'paused' };
  const shield = await getShield(env, guildId);
  if (shield && shield.endsAt > now) return { fired: false, reason: 'shielded' };
  let sched = await getSchedule(env, guildId);
  if (!sched || now >= (sched.dailyResetUtc || 0)) {
    sched = freshSchedule(town, now);
    await putSchedule(env, guildId, sched);
  }
  if (!sched.pending?.length) return { fired: false, reason: 'no-slots' };
  // Find the earliest slot that's due (atUtc <= now).
  const dueIdx = sched.pending.findIndex(s => s.atUtc <= now);
  if (dueIdx === -1) return { fired: false, reason: 'not-due' };
  const due = sched.pending[dueIdx];
  // Pop from pending into fired; persist immediately so a partial
  // failure inside executeGoblinRaid doesn't re-fire the same slot.
  sched.pending.splice(dueIdx, 1);
  sched.fired.push({ ...due, executedAtUtc: now });
  await putSchedule(env, guildId, sched);
  // Fire the raid.
  await executeGoblinRaid(env, guildId, town, due.mode || 'normal', now);
  return { fired: true, mode: due.mode, reason: 'fired' };
}

// ── Fire one raid ────────────────────────────────────────────────────

export async function executeGoblinRaid(env, guildId, town, mode = 'normal', nowUtc = Date.now()) {
  // Build a snapshot (use the cached one if fresh, else regenerate).
  let snapshot = await getDefenseSnapshot(env, guildId);
  if (!snapshot) snapshot = await refreshDefenseSnapshot(env, guildId);
  if (!snapshot) return { error: 'no-snapshot' };

  // Deterministic seed: guildId char codes XOR'd with minute bucket.
  const minuteBucket = Math.floor(nowUtc / 60_000);
  let h = 0;
  for (let i = 0; i < guildId.length; i++) h = ((h << 5) - h + guildId.charCodeAt(i)) | 0;
  const seed = (h ^ minuteBucket) >>> 0;
  const army = generateGoblinArmy(town.thLevel || 1, seed, { mode });
  if (!army.troops || Object.keys(army.troops).length === 0) {
    return { error: 'no-army', reason: 'th-1 grace period or unknown TH' };
  }

  // Goblins skip defender-Champion deployment by default (per §4.8 —
  // see also clash-state.getActiveDefenderChampion which already
  // applies the "warband-only" gate). We pass mode through so the
  // simulator-side opts can be set when the defender Champion opts in.
  const raidId = 'gbn_' + nowUtc.toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  const attacker = { userId: 'goblin', army: army.troops };
  const sim = simulate(attacker, snapshot, raidId, { source: 'goblin', mode });

  // ── Damage writeback ───────────────────────────────────────────────
  // Mutate the live town so subsequent /clash town view + defense
  // snapshots reflect the new HP/status. This is the central E2
  // mechanic. Walls drop to status:'damaged' below 100%, status:
  // 'destroyed' at 0.
  applyDamageWriteback(town, sim);
  town.lastGoblinRaidUtc = nowUtc;
  town.layoutVersion = (town.layoutVersion || 0) + 1;
  await putTown(env, guildId, town);
  // Regenerate the def-snapshot so the next raid attacks the
  // damaged town. Cheap — single town read.
  await refreshDefenseSnapshot(env, guildId).catch(() => {});

  // ── Loot rules — goblin raids steal a slice (§4.6) ─────────────────
  const treasury = await getTreasury(env, guildId);
  const stolen = applyGoblinLoot(treasury, sim);
  await putTreasury(env, guildId, treasury);

  // ── Raid receipt + log + event ─────────────────────────────────────
  const receipt = {
    raidId,
    attackerUserId: 'goblin',
    attackerName: army.label || 'Goblin raid',
    targetGuildId: guildId,
    targetSnapshot: { thLevel: town.thLevel, layoutVersion: town.layoutVersion },
    army: army.troops,
    sim,
    stolen,
    mode,
    source: 'goblin',
    isWarband: army.hasWarband,
    createdUtc: nowUtc,
  };
  await putRaid(env, receipt);
  await appendRaidLog(env, `clash:raidlog:town:${guildId}`, raidId);

  // Append the event for the live feed (web + Twitch panel).
  try {
    const kind = sim.stars === 0 ? 'clash.raid.goblin.repelled' : 'clash.raid.goblin.result';
    await appendClashEvent(env, guildId, kind, {
      title: army.label || 'Goblin raid',
      stars: sim.stars,
      raidId,
      mode,
    });
  } catch { /* event-log failure shouldn't drop the raid */ }

  // Push notifications — incoming + result. Lazy-imported to avoid
  // circular deps. (clash-push imports clash-state which is fine, but
  // we import clash-push lazily for symmetry with the other modules.)
  try {
    const push = await import('./clash-push.js');
    if (push.pushGoblinRaidResult) {
      await push.pushGoblinRaidResult(env, {
        guildId, stars: sim.stars, label: army.label,
        isWarband: army.hasWarband, stolen,
      });
    }
  } catch (e) { console.warn('[clash-goblins] push failed:', e && e.message); }

  // PROGRESSION (P1) — town owner gets defender XP on a 0★ goblin
  // repel. We don't grant XP for losing (no XP from being raided).
  try {
    if (sim.stars === 0 && town?.ownerUserId) {
      const { emitProgressionEvent } = await import('./progression/event-bus.js');
      await emitProgressionEvent(env, {
        kind: 'clash.defended.goblin',
        userId: town.ownerUserId, guildId,
        meta: { raidId, mode }, stableKeys: ['raidId'],
      });
    }
  } catch { /* non-fatal */ }

  return { ok: true, raidId, stars: sim.stars, stolen };
}

// ── Damage writeback ─────────────────────────────────────────────────
//
// Map sim.finalBuildings (built by clash-raid.simulate()) onto the
// live town.buildings[] entries by id. HP and status both update.
// Walls / cannons / archerTowers / townhall all get the same shape.

export function applyDamageWriteback(town, sim) {
  if (!town || !Array.isArray(town.buildings) || !sim) return false;
  const finalById = new Map();
  for (const f of sim.finalBuildings || []) {
    finalById.set(f.id, f);
  }
  let changed = false;
  for (const b of town.buildings) {
    const f = finalById.get(b.id);
    if (!f) continue;
    const maxHp = f.maxHp || BUILDINGS[b.kind]?.hp?.[b.level] || b.hp || 100;
    const hp = Math.max(0, Math.min(maxHp, f.hp));
    const wasAlive = (b.hp || 0) > 0 && b.status !== 'destroyed';
    const nowAlive = f.alive && hp > 0;
    b.hp = hp;
    if (!nowAlive) {
      b.status = 'destroyed';
    } else if (hp < maxHp) {
      b.status = 'damaged';
    } else if (b.status === 'damaged' || b.status === 'destroyed') {
      b.status = 'idle';
    }
    if (b.hp !== hp || wasAlive !== nowAlive) changed = true;
  }
  return changed;
}

// ── Loot rules — goblins steal a non-bolt slice (§4.6) ───────────────
//
// 0★: nothing. 1★: 5% of one random non-bolt non-core resource.
// 2★: 8% of two. 3★: 12% of three. Mutates the passed treasury and
// returns the stolen map.
export function applyGoblinLoot(treasury, sim) {
  const stars = sim?.stars || 0;
  if (stars === 0) return {};
  const pool = ['scrap', 'wood', 'stone', 'iron', 'gold'];
  const pct = stars === 1 ? 0.05 : stars === 2 ? 0.08 : 0.12;
  const n   = stars === 1 ? 1 : stars === 2 ? 2 : 3;
  // Pick n distinct resources from the pool, weighted by availability
  // (no point "stealing" a resource the town has zero of).
  const have = pool.filter(k => (treasury[k] || 0) > 0);
  if (!have.length) return {};
  const shuffled = have.slice().sort(() => Math.random() - 0.5);
  const picks = shuffled.slice(0, Math.min(n, shuffled.length));
  const stolen = {};
  for (const k of picks) {
    const v = Math.floor((treasury[k] || 0) * pct);
    if (v > 0) {
      treasury[k] = Math.max(0, (treasury[k] || 0) - v);
      stolen[k] = v;
    }
  }
  return stolen;
}

// ── Storage leak — damaged storages bleed 2%/min until repaired ──────
//
// Called from syncCollectors (clash-resources.js) on every read tick.
// Returns true if any leak happened (caller should write the town).
export function applyDamagedStorageLeak(town, nowUtc = Date.now()) {
  if (!town || !Array.isArray(town.buildings)) return false;
  const lastLeak = town.lastStorageLeakUtc || nowUtc;
  const minutes = Math.floor((nowUtc - lastLeak) / 60_000);
  if (minutes <= 0) return false;
  // Only storage/reserve kinds count for leak. Look these up by their
  // collectorOf field OR by name pattern.
  const VAULT_KINDS = new Set([
    'storage', 'lumberVault', 'stoneVault', 'ironVault', 'goldVault',
  ]);
  const damaged = town.buildings.filter(b =>
    VAULT_KINDS.has(b.kind) && (b.status === 'damaged' || b.status === 'destroyed')
  );
  if (!damaged.length) {
    // Still update the timestamp so a future leak doesn't bill all
    // accumulated minutes at once.
    town.lastStorageLeakUtc = nowUtc;
    return false;
  }
  // 2% per minute, applied to the treasury, capped at 30% per leak
  // pass (so a 1-day idle doesn't wipe a treasury when the storage
  // has been damaged the whole time).
  const factor = Math.min(0.30, 0.02 * minutes);
  town._pendingLeakFactor = factor;     // consumed by clash-resources
  town.lastStorageLeakUtc = nowUtc;
  return true;
}

// ── Repair queue helpers ─────────────────────────────────────────────
//
// Used by /clash repair to compute cost + time given the current
// HP ratio. Returns the same shape as townBuildCost so callers can
// reuse the chargeResources + enqueue flow.
export function computeRepair(building) {
  if (!building) return null;
  const maxHp = BUILDINGS[building.kind]?.hp?.[building.level] || 100;
  const hpRatio = Math.max(0, Math.min(1, (building.hp || 0) / maxHp));
  return repairBuildingCost(building.kind, building.level, hpRatio);
}
