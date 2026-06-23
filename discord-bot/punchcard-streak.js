// PunchCard streak engine. Pure functions, zero imports, so the same
// logic can be byte-compared against the client copy embedded in
// aquilo-site/public/punchcard/overlay/pc-engine.js (PCEngine.streak).
// The selftest (aquilo-site/scripts/pc-selftest.mjs) imports this file
// directly and asserts parity on a shared vector set. If you change a
// rule here, change pc-engine.js too or the selftest fails.
//
// A "day" is the channel-local calendar date of (now - rolloverHours),
// so a stream that crosses midnight stays one day. Two streak modes:
//   active:   consecutive CHANNEL-ACTIVE days (days where anyone
//             checked in). The streamer skipping a day breaks nobody.
//   calendar: strict consecutive calendar days.

export const MILESTONES = [3, 7, 14, 30, 50, 100, 180, 365];
export const DATES_CAP = 60;     // per-viewer recent check-in dates ring
export const DAYS_CAP = 400;     // per-channel active-day list cap

// 'YYYY-MM-DD' in tz with the rollover applied. Invalid tz falls back
// to America/New_York rather than throwing mid-checkin.
export function dayIdx(nowMs, tz, rolloverHour) {
  const shifted = new Date(Number(nowMs) - (Number(rolloverHour) || 0) * 3600000);
  for (const zone of [tz, 'America/New_York', 'UTC']) {
    if (!zone) continue;
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(shifted);
    } catch { /* try next zone */ }
  }
  return shifted.toISOString().slice(0, 10);
}

// Previous calendar day of a 'YYYY-MM-DD' string (UTC date math; the
// strings are already channel-local).
export function yesterday(day) {
  const t = Date.parse(day + 'T00:00:00Z');
  if (!Number.isFinite(t)) return null;
  return new Date(t - 86400000).toISOString().slice(0, 10);
}

// Latest channel-active day strictly before `today`. `days` is the
// channel list, may be unsorted and may already include today.
export function prevActiveDay(days, today) {
  let best = null;
  for (const d of (days || [])) {
    if (d < today && (!best || d > best)) best = d;
  }
  return best;
}

// Insert today into the active-day list. Returns { days, changed } with
// the list deduped, sorted ascending, and capped to the newest DAYS_CAP.
export function withToday(days, today) {
  const set = new Set(days || []);
  if (set.has(today)) return { days: (days || []).slice(), changed: false };
  set.add(today);
  const out = [...set].sort();
  return { days: out.slice(Math.max(0, out.length - DAYS_CAP)), changed: true };
}

export const FREEZE_CAP = 3;

// One check-in. `user` is { t, s, b, l, d, f } (total, streak, best,
// last day, dates ring, freezes held); missing fields default to
// zero/empty. `prev2Active` is the channel-active day BEFORE
// prevActive (callers compute it; only used by freezes). Returns the
// next user fields plus { dup, milestone, freezeUsed }. Never mutates
// inputs.
//
// Freezes: earned one per milestone (cap FREEZE_CAP), auto-spent to
// bridge EXACTLY one missed day, so a single slip keeps the streak
// alive but a long absence still resets.
export function advance(user, today, prevActive, mode, prev2Active) {
  const u = user || {};
  const t = Number(u.t) || 0;
  const s = Number(u.s) || 0;
  const b = Number(u.b) || 0;
  const l = u.l || null;
  const d = Array.isArray(u.d) ? u.d.slice() : [];
  let f = Math.max(0, Math.min(FREEZE_CAP, Number(u.f) || 0));

  if (l === today) {
    return { t, s, b, l, d, f, dup: true, milestone: 0, freezeUsed: false };
  }

  const anchor = mode === 'calendar' ? yesterday(today) : prevActive;
  let streak;
  let freezeUsed = false;
  if (l && anchor && l === anchor) {
    streak = s + 1;
  } else {
    const bridge = mode === 'calendar'
      ? (anchor ? yesterday(anchor) : null)
      : (prev2Active || null);
    if (l && bridge && l === bridge && f > 0) {
      f -= 1;
      freezeUsed = true;
      streak = s + 1;
    } else {
      streak = 1;
    }
  }
  const best = Math.max(b, streak);
  d.push(today);
  const dates = d.slice(Math.max(0, d.length - DATES_CAP));
  const milestone = MILESTONES.includes(streak) ? streak : 0;
  if (milestone) f = Math.min(FREEZE_CAP, f + 1);
  return { t: t + 1, s: streak, b: best, l: today, d: dates, f, dup: false, milestone, freezeUsed };
}

// Permanent ring tier earned by BEST streak (a broken streak keeps the
// ring). Order matters: highest first.
export function ringFor(best) {
  const b = Number(best) || 0;
  if (b >= 365) return 'aurora';
  if (b >= 100) return 'gold';
  if (b >= 30) return 'silver';
  if (b >= 7) return 'bronze';
  return null;
}
