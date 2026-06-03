// Rolling-window per-viewer recap stats for the Twitch panel.
//
// One KV row per viewer:
//   recap:<guild>:tw:<id>  ->  { windowStart, lastUpdated, stats: {...} }
//
// The window is a rolling 24h approximation of "last session" until
// stream.online / stream.offline EventSub boundaries land, at which
// point getRecap's roll logic is the only thing that changes. The
// stats schema and the route shape stay the same, so the panel and
// the hook sites don't move when the switch happens.
//
// Stream-live signal: recap:streamLiveStamp is written by the
// aquilo-site EventSub receiver (which shares this KV namespace) on
// stream.online and deleted on stream.offline, single source of
// truth, no cross-Worker POST needed.

const WINDOW_MS = 24 * 60 * 60 * 1000;
const RECAP_TTL = 48 * 60 * 60; // KV auto-clean after 48h idle
const LIVE_KEY = 'recap:streamLiveStamp';

// All counter keys. New kinds (e.g. dungeon_* once B3's DLL→cloud
// relay lands) can be appended, emptyStats/normalize fill them in
// for existing rows, so old recap data stays readable.
const STAT_KEYS = [
  'bolts_earned',
  'bolts_spent',
  'songs_requested',
  'checkins',
  'dungeon_wins',
  'dungeon_losses',
  'games_won',
  'games_lost',
];

function emptyStats() {
  const s = {};
  for (const k of STAT_KEYS) s[k] = 0;
  return s;
}

function freshRecap(now) {
  return { windowStart: now, lastUpdated: now, stats: emptyStats() };
}

// Return a normalized recap, fresh window if the stored one is stale
// (older than WINDOW_MS) or missing; otherwise the stored stats with
// every known key guaranteed present.
function rollIfStale(recap, now) {
  if (!recap || !recap.stats || now - (recap.lastUpdated || 0) > WINDOW_MS) {
    return freshRecap(now);
  }
  const stats = emptyStats();
  for (const k of STAT_KEYS) stats[k] = Number(recap.stats[k]) || 0;
  return {
    windowStart: recap.windowStart || now,
    lastUpdated: recap.lastUpdated,
    stats,
  };
}

// Apply a batch of increments. `deltas` = { stat_key: amount, ... }.
// Best-effort, never throws, so a KV hiccup can't break the action
// that called it. `userId` is the resolved tw:<id> identity.
export async function recordStat(env, guild, userId, deltas) {
  if (!userId || !deltas) return;
  const key = `recap:${guild}:${userId}`;
  const now = Date.now();
  try {
    const recap = rollIfStale(await env.LOADOUT_BOLTS.get(key, { type: 'json' }), now);
    for (const k of Object.keys(deltas)) {
      if (STAT_KEYS.indexOf(k) === -1) continue;
      recap.stats[k] = (recap.stats[k] || 0) + (Number(deltas[k]) || 0);
    }
    recap.lastUpdated = now;
    await env.LOADOUT_BOLTS.put(key, JSON.stringify(recap), { expirationTtl: RECAP_TTL });
  } catch {
    /* best-effort, recap must never block a viewer action */
  }
}

export async function getRecap(env, guild, userId) {
  const key = `recap:${guild}:${userId}`;
  let stored = null;
  try {
    stored = await env.LOADOUT_BOLTS.get(key, { type: 'json' });
  } catch {
    /* fall through to a fresh window */
  }
  return rollIfStale(stored, Date.now());
}

export async function isStreamLive(env) {
  try {
    return !!(await env.LOADOUT_BOLTS.get(LIVE_KEY));
  } catch {
    return false;
  }
}
