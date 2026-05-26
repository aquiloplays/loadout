// Progression — the cross-cutting event bus.
//
// PROGRESSION-SYSTEM-DESIGN.md §3 — the single emit point every
// feature talks to. Adding XP / achievement / season-pass plumbing
// to a new feature means one call to emitProgressionEvent() at the
// success path; everything downstream (XP grant, achievement check,
// season-pass progress, ring-buffer recording) is handled here.
//
// Fire-and-forget pattern: the bus is wrapped in try/catch at every
// emit site so a failed grant never breaks the feature it's emitted
// from. Pure additive.

import { grantXp } from './xp.js';

// Stable event-identity hash for dedup. Two events with the same
// (kind, userId, stable meta fields) are treated as the same event;
// the second emit grants XP zero times. Caller marks stable fields
// by listing them in `event.stableKeys` (default: ['id']).
async function eventIdentity(event) {
  const stableKeys = event.stableKeys || ['id', 'raidId', 'matchId', 'gameId', 'betId'];
  const parts = [event.kind, event.userId];
  for (const k of stableKeys) {
    if (event.meta?.[k] != null) parts.push(`${k}=${event.meta[k]}`);
  }
  // No stable id? fall back to per-minute bucket (so two emits in the
  // same minute dedup, but spacings beyond that don't).
  if (parts.length === 2) parts.push(`m=${Math.floor((event.utc || Date.now()) / 60_000)}`);
  const input = parts.join('|');
  return sha256Hex(input);
}

async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const arr = Array.from(new Uint8Array(digest));
  return arr.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Per-user ring buffer of recent events for the profile page ────
//
// Cap 32 entries. ~3 KB at full. Surfaced on the profile as
// "Recent activity".
const RING_CAP = 32;

async function pushEventToRing(env, userId, event) {
  const key = `pevents:${userId}`;
  const all = (await env.LOADOUT_BOLTS.get(key, { type: 'json' })) || [];
  all.push({
    kind: event.kind,
    guildId: event.guildId || null,
    meta: event.meta || {},
    utc: event.utc || Date.now(),
  });
  if (all.length > RING_CAP) all.splice(0, all.length - RING_CAP);
  await env.LOADOUT_BOLTS.put(key, JSON.stringify(all));
}

// ── Public emit ────────────────────────────────────────────────────
//
// Returns a result object the caller can ignore. Errors never throw —
// the only thing that matters is that the feature's own state-write
// already succeeded.

export async function emitProgressionEvent(env, event) {
  try {
    if (!event || !event.kind || !event.userId) return { ok: false, error: 'bad-event' };
    event.utc = event.utc || Date.now();
    // Dedup gate.
    const identity = event.identity || await eventIdentity(event);
    const dedupKey = `pevent:dedup:${identity}`;
    const seen = await env.LOADOUT_BOLTS.get(dedupKey);
    if (seen) return { ok: true, deduped: true, identity };
    // 24h TTL on dedup marker — long enough that retries inside a day
    // are caught, short enough that stale markers self-clean.
    await env.LOADOUT_BOLTS.put(dedupKey, '1', { expirationTtl: 86400 });

    // ── Consumer #1: XP grant ──
    let xpResult = null;
    try {
      xpResult = await grantXp(env, event.userId, event.kind, {
        nowUtc: event.utc,
        overrideXp: event.overrideXp || null,
        boost: event.boost || 1,
      });
    } catch (e) {
      console.warn('[progression] xp grant failed:', e && e.message);
    }

    // Re-emit level.reached for every crossed level so the meta-level
    // achievements (Top of the Class, Veteran, Living Legend) trigger.
    // Skip if this event IS already a level.reached (no infinite loop).
    if (xpResult?.levelsCrossed?.length && event.kind !== 'level.reached') {
      for (const lv of xpResult.levelsCrossed) {
        // Direct grant — bypass the bus so we don't re-trigger the
        // XP consumer (level-reached doesn't grant XP itself).
        try {
          const { checkAchievements } = await import('./achievements.js');
          if (checkAchievements) {
            await checkAchievements(env, {
              kind: 'level.reached',
              userId: event.userId,
              meta: { level: lv },
              utc: event.utc,
            });
          }
        } catch { /* non-fatal */ }
      }
      // Level-tier roles — grant Discord roles for every L5/L25/L50/L100
      // crossed in this event. Stacks (higher tier doesn't remove
      // lower) — see level-tier-roles.js. No-op if the guild hasn't
      // run /admin/level-tier-roles/ensure yet.
      try {
        const { grantTierRolesForCrossedLevels } = await import('../level-tier-roles.js');
        await grantTierRolesForCrossedLevels(env, event.userId,
          xpResult.levelsCrossed, event.guildId);
      } catch (e) {
        console.warn('[progression] tier-role grant failed:', e?.message || e);
      }
    }

    // ── Consumer #2: Achievement check ──
    // Stub until P3. The function exists so the wiring is in place;
    // it does nothing until the achievement engine lands.
    let achResult = null;
    try {
      const { checkAchievements } = await import('./achievements.js');
      if (checkAchievements) achResult = await checkAchievements(env, event);
    } catch { /* module not present yet — that's fine, P3 wires it */ }

    // ── Consumer #3: Season-pass progress ──
    let seasonResult = null;
    try {
      const { recordSeasonProgress } = await import('./season.js');
      if (recordSeasonProgress) seasonResult = await recordSeasonProgress(env, event, xpResult);
    } catch (e) {
      console.warn('[progression] season progress failed:', e && e.message);
    }

    // ── Recent-activity ring buffer (per-user) ──
    try { await pushEventToRing(env, event.userId, event); } catch { /* non-fatal */ }

    // ── Consumer #4: Community activity feed (filtered ring) ──
    // Only highlight-worthy kinds make it in — see activity-feed.js
    // for the kind/condition filter.
    try {
      const { appendIfNoteworthy } = await import('../activity-feed.js');
      await appendIfNoteworthy(env, event);
    } catch { /* non-fatal */ }

    // ── Consumer #5: Weekly community challenge progress ──
    // Contributes to the currently-active challenge if the event kind
    // matches the active template's kinds list. No-op otherwise.
    try {
      const { contributeToChallenge } = await import('../challenges.js');
      await contributeToChallenge(env, event);
    } catch { /* non-fatal */ }

    return {
      ok: true,
      identity,
      xp: xpResult,
      ach: achResult,
      season: seasonResult,
    };
  } catch (e) {
    console.warn('[progression] emit failed:', e && e.message);
    return { ok: false, error: String(e && e.message) };
  }
}

// ── Convenience batch emit ─────────────────────────────────────────
//
// For features that fire multiple kinds at once (e.g. Clash raid:
// `clash.raid.played` + `clash.raid.won.<N>`). Each event still goes
// through dedup individually.

export async function emitProgressionEvents(env, events) {
  const out = [];
  for (const e of events) {
    out.push(await emitProgressionEvent(env, e));
  }
  return out;
}

// ── Read-side: recent-activity ring ────────────────────────────────

export async function getRecentEvents(env, userId, limit = 10) {
  const all = (await env.LOADOUT_BOLTS.get(`pevents:${userId}`, { type: 'json' })) || [];
  return all.slice(-limit).reverse();
}
