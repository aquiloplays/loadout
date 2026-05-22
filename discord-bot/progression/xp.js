// Progression — XP grant + level math + per-user storage.
//
// PROGRESSION-SYSTEM-DESIGN.md §4 — owns the pxp:<userId> hot record
// and the level curve. The event bus (event-bus.js) calls grantXp()
// after dedup; this module handles per-kind caps, the global daily
// soft cap (500 XP/day with 1/3 accrual beyond), and level math.

import { loadXpTable, xpForKind, dailyCapForKind } from './xp-table.js';

// Polynomial curve from §4.3: xpToReach(level) = 100×level + 30×level^1.6
// At L1 the math returns 100+30=130 XP to reach L2 (cumulative). We
// store cumulative XP in pxp:<userId>.xp and recompute level on each
// grant — pure function of cumulative XP.
export function xpToReach(level) {
  if (level <= 1) return 0;
  return Math.round(100 * level + 30 * Math.pow(level, 1.6));
}

// Cumulative XP needed to *reach* level N — i.e. once xp >= xpAtLevel(N)
// the user is at L N. xpAtLevel(1) === 0, xpAtLevel(2) === 130, etc.
export function xpAtLevel(level) {
  let total = 0;
  for (let i = 2; i <= level; i++) total += xpToReach(i);
  return total;
}

// Level for a given cumulative XP. Tight loop; no caching — runs in
// microseconds at any practical XP value.
export function levelForXp(xp) {
  if (xp <= 0) return 1;
  let lv = 1;
  let cum = 0;
  while (true) {
    const cost = xpToReach(lv + 1);
    if (cum + cost > xp) return lv;
    cum += cost;
    lv++;
    if (lv > 200) return lv;   // safety floor — practical ceiling well below
  }
}

// Progress fraction within the current level — used by the UI XP bar.
export function progressInLevel(xp) {
  const lv = levelForXp(xp);
  const floor = xpAtLevel(lv);
  const ceiling = xpAtLevel(lv + 1);
  if (ceiling === floor) return { level: lv, xpIntoLevel: 0, xpForLevel: 0, pct: 1.0 };
  const xpIntoLevel = xp - floor;
  const xpForLevel = ceiling - floor;
  return {
    level: lv,
    xpIntoLevel,
    xpForLevel,
    pct: Math.min(1.0, xpIntoLevel / xpForLevel),
  };
}

// ── Storage ─────────────────────────────────────────────────────────

const SOFT_DAILY_CAP = 500;       // §4.2 — beyond this, accrual at 1/3
const SOFT_CAP_RATE  = 1 / 3;

function ymdUtc(nowUtc = Date.now()) {
  return new Date(nowUtc).toISOString().slice(0, 10);
}

const RECORD_KEY = (userId) => `pxp:${userId}`;

// Default record shape. Tiny — kept lean for hot reads on every grant
// + every profile load.
function freshRecord() {
  return {
    xp: 0,
    level: 1,
    lastLevelUtc: 0,
    dailyXp: { ymd: ymdUtc(), total: 0 },
    perKindToday: {},     // { kind: count } resets at UTC midnight
  };
}

export async function getXp(env, userId) {
  const raw = await env.LOADOUT_BOLTS.get(RECORD_KEY(userId), { type: 'json' });
  if (!raw) return freshRecord();
  // Reset daily counters if the day rolled over.
  const today = ymdUtc();
  if (raw.dailyXp?.ymd !== today) {
    raw.dailyXp = { ymd: today, total: 0 };
    raw.perKindToday = {};
  }
  return { ...freshRecord(), ...raw };
}

export async function putXp(env, userId, rec) {
  await env.LOADOUT_BOLTS.put(RECORD_KEY(userId), JSON.stringify(rec));
}

// ── Grant ──────────────────────────────────────────────────────────
//
// Called by event-bus.js after dedup passes. Returns:
//   { granted, capped, newXp, newLevel, levelsCrossed: [N, N+1, ...], record }
// `granted` is the actual XP added (may be less than baseGrant due to
// per-kind cap or global soft cap).
//
// Pure-ish: mutates + persists the record. Idempotency is the caller's
// job (event-bus dedup table).

export async function grantXp(env, userId, kind, opts = {}) {
  const { boost = 1, overrideXp = null, nowUtc = Date.now() } = opts;
  const table = await loadXpTable(env, nowUtc);
  const baseSpec = table[kind];
  if (!baseSpec) return { granted: 0, capped: 'unknown-kind', record: null };

  const rec = await getXp(env, userId);
  const baseXp = overrideXp != null ? overrideXp : (baseSpec.xp || 0);
  let proposed = Math.round(baseXp * boost);
  if (proposed <= 0) return { granted: 0, capped: 'zero', record: rec };

  // Per-kind daily cap.
  if (baseSpec.dailyCap) {
    const todaySoFar = (rec.perKindToday[kind] || 0);
    const remaining = Math.max(0, baseSpec.dailyCap - todaySoFar);
    if (proposed > remaining) proposed = remaining;
    if (proposed <= 0) return { granted: 0, capped: 'per-kind-cap', record: rec };
  }

  // Global soft daily cap. Tournament rewards are exempt.
  let granted = proposed;
  let cappedReason = null;
  if (!baseSpec.exemptDailyCap) {
    const usedToday = rec.dailyXp.total || 0;
    if (usedToday >= SOFT_DAILY_CAP) {
      granted = Math.max(1, Math.round(proposed * SOFT_CAP_RATE));
      cappedReason = 'soft-cap-saturated';
    } else if (usedToday + proposed > SOFT_DAILY_CAP) {
      const undercap = SOFT_DAILY_CAP - usedToday;
      const overcap = proposed - undercap;
      granted = undercap + Math.max(0, Math.round(overcap * SOFT_CAP_RATE));
      cappedReason = 'soft-cap-partial';
    }
  }

  // Apply.
  const oldLevel = rec.level;
  rec.xp += granted;
  rec.dailyXp.total = (rec.dailyXp.total || 0) + granted;
  rec.perKindToday[kind] = (rec.perKindToday[kind] || 0) + granted;
  const newLevel = levelForXp(rec.xp);
  const levelsCrossed = [];
  if (newLevel > oldLevel) {
    for (let lv = oldLevel + 1; lv <= newLevel; lv++) levelsCrossed.push(lv);
    rec.level = newLevel;
    rec.lastLevelUtc = nowUtc;
  }

  await putXp(env, userId, rec);

  return {
    granted,
    capped: cappedReason,
    newXp: rec.xp,
    newLevel,
    levelsCrossed,
    record: rec,
  };
}

// ── Read-side helpers ──────────────────────────────────────────────

// Light wrapper for profile + leaderboards. Returns { xp, level, pct, dailyXp }.
export async function readXpDisplay(env, userId) {
  const rec = await getXp(env, userId);
  const prog = progressInLevel(rec.xp);
  return {
    xp: rec.xp,
    level: rec.level,
    nextLevel: rec.level + 1,
    xpIntoLevel: prog.xpIntoLevel,
    xpForLevel: prog.xpForLevel,
    pct: prog.pct,
    dailyXp: rec.dailyXp.total,
    lastLevelUtc: rec.lastLevelUtc,
  };
}

// Top-N leaderboard by total XP. Walks pxp:* — bounded (≤ 5 pages).
// Called by /web/xp/leaderboard at most once a minute (cached upstream).
export async function topXp(env, limit = 25) {
  const rows = [];
  let cursor;
  for (let i = 0; i < 5; i++) {
    const r = await env.LOADOUT_BOLTS.list({ prefix: 'pxp:', cursor, limit: 1000 });
    for (const k of r.keys) {
      if (k.name === 'pxp:table') continue;        // skip the singleton
      const rec = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
      if (!rec) continue;
      const userId = k.name.slice('pxp:'.length);
      rows.push({ userId, xp: rec.xp || 0, level: rec.level || 1 });
    }
    if (r.list_complete) break;
    cursor = r.cursor;
  }
  rows.sort((a, b) => b.xp - a.xp);
  return rows.slice(0, limit);
}
