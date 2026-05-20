// Cross-product daily streak. Ticks for ANY ecosystem action on a given
// ET day (chat, count, /sr-add, encounter, suggest, trivia, etc.). Patron
// roles get a 2x weight visible on the passport, but the streak day itself
// is binary — you either acted today or you didn't.
//
// Storage: D1 `streaks` table, one row per (guild, user).
//
// Public API:
//   tickStreak(env, guildId, userId)               -> { current, longest, gained }
//   getStreak(env, guildId, userId)                -> row | null
//
// Callers (all best-effort, non-blocking):
//   - counting.js   on successful count
//   - song-prequeue.js on /sr-add
//   - suggestions.js   on /suggest
//   - encounter.js     on roll
//   - trivia.js        on first-correct
//   - viewer-hub clicks (encounter, suggest, add song)
//
// All ticks share one fast-path: read current row, compare last_tick_et to
// today_et, write back if changed. ~5 ms in steady state.

import { getETInfo } from './util.js';

// Returns yyyy-mm-dd in ET for the given Date (or now).
function todayET(date = new Date()) {
  const { year, month, day } = getETInfo(date);
  const pad = (n) => n < 10 ? '0' + n : '' + n;
  return year + '-' + pad(month) + '-' + pad(day);
}

// Distance in days between two yyyy-mm-dd strings (b - a). Works across
// month/year boundaries via Date.UTC.
function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  const aMs = Date.UTC(ay, am - 1, ad);
  const bMs = Date.UTC(by, bm - 1, bd);
  return Math.round((bMs - aMs) / 86400000);
}

/**
 * Credit a streak day. Idempotent within the same ET day.
 *
 * Returns:
 *   { current, longest, gained }
 *     - gained:true  if this call advanced the streak
 *     - gained:false if already ticked today (no-op)
 *
 * The "gained" flag is what callers want for "streak +1 today!" feedback.
 */
export async function tickStreak(env, guildId, userId) {
  if (!env?.DB) return { current: 0, longest: 0, gained: false };
  if (!guildId || !userId) return { current: 0, longest: 0, gained: false };

  const today = todayET();
  const row = await env.DB.prepare(
    'SELECT current_days, longest_days, last_tick_et, total_ticks FROM streaks WHERE guild_id = ? AND user_id = ?'
  ).bind(guildId, userId).first();

  if (!row) {
    // First-ever tick for this user.
    await env.DB.prepare(
      'INSERT INTO streaks (guild_id, user_id, current_days, longest_days, last_tick_et, total_ticks) VALUES (?, ?, 1, 1, ?, 1)'
    ).bind(guildId, userId, today).run();
    return { current: 1, longest: 1, gained: true };
  }

  const delta = daysBetween(row.last_tick_et, today);
  if (delta === 0) {
    // Already ticked today — no-op.
    return { current: row.current_days, longest: row.longest_days, gained: false };
  }

  let current = row.current_days;
  if (delta === 1) {
    current += 1;             // consecutive day, extends streak
  } else {
    current = 1;              // gap — reset and start fresh
  }
  const longest = Math.max(row.longest_days, current);

  await env.DB.prepare(
    'UPDATE streaks SET current_days = ?, longest_days = ?, last_tick_et = ?, total_ticks = total_ticks + 1 WHERE guild_id = ? AND user_id = ?'
  ).bind(current, longest, today, guildId, userId).run();

  return { current, longest, gained: true };
}

/** Read a user's streak without modifying it. */
export async function getStreak(env, guildId, userId) {
  if (!env?.DB || !guildId || !userId) return null;
  return env.DB.prepare(
    'SELECT current_days, longest_days, last_tick_et, total_ticks FROM streaks WHERE guild_id = ? AND user_id = ?'
  ).bind(guildId, userId).first();
}

/** Top N current streakers for the leaderboard channel. */
export async function topStreaks(env, guildId, limit = 10) {
  if (!env?.DB || !guildId) return [];
  const { results } = await env.DB.prepare(
    'SELECT user_id, current_days, longest_days FROM streaks WHERE guild_id = ? ORDER BY current_days DESC, longest_days DESC LIMIT ?'
  ).bind(guildId, limit).all();
  return results || [];
}

/**
 * Fire-and-forget tick wrapper for handlers that don't want to await.
 * Drops the promise on the floor — callers should ctx.waitUntil() it
 * when running inside the Worker request lifecycle.
 */
export function tickAsync(env, guildId, userId) {
  return tickStreak(env, guildId, userId).catch(e => {
    console.error('[streak] tick failed', e?.message || e);
    return { current: 0, longest: 0, gained: false };
  });
}
