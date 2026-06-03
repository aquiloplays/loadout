// Achievements, root-level, D1-backed event-driven unlock engine.
//
// 2026-05-30 sprint. Lives at discord-bot/achievements.js so any
// gameplay module (checkin, boltbound, counting, …) can call
// checkAndUnlock(env, userId, { type, count?, value? }) right after
// the event that might satisfy an achievement trigger. Idempotent, // the user_achievement table's composite primary key (user_id +
// achievement_id) makes re-unlocks a no-op INSERT OR IGNORE.
//
// Two complementary read APIs:
//   listAchievements(env)             → definitions (catalog)
//   getUserAchievements(env, userId)  → that user's unlocks w/ timestamps
//
// And two write APIs:
//   tryUnlock(env, userId, achId)     → idempotent direct unlock
//   checkAndUnlock(env, userId, evt)  → trigger-driven cascade
//
// NOTE: this is a deliberately separate, simpler engine from
// discord-bot/progression/achievements.js, that one is the deep
// XP+badge progression catalog wired through event-bus.js with KV
// counter tracking. This module is the lightweight D1 alternative
// that gameplay modules can hit directly without going through the
// event bus, with a row-per-definition catalogue stored in
// achievement_def. Seed via achievements-migration.sql.

// ── D1 helpers ────────────────────────────────────────────────────

async function db(env) {
  if (!env || !env.DB) throw new Error('achievements: no D1 binding (env.DB missing)');
  return env.DB;
}

// ── Read API ──────────────────────────────────────────────────────

// All ACTIVE definitions in the catalogue. The migration seeds ~15
// entries; admins can flip `active=0` to retire one without losing
// historic user_achievement rows.
export async function listAchievements(env) {
  const D = await db(env);
  const { results } = await D.prepare(
    `SELECT id, name, description, icon, tier, points,
            trigger_type, trigger_threshold
       FROM achievement_def
      WHERE active = 1
      ORDER BY tier, id`
  ).all();
  return (results || []).map(r => ({
    id: r.id,
    name: r.name,
    description: r.description,
    icon: r.icon,
    tier: r.tier,
    points: r.points,
    trigger: {
      type: r.trigger_type,
      threshold: r.trigger_threshold,
    },
  }));
}

// Joined view: unlocked definitions for a user, newest first. Filters
// out any orphan rows whose definition has been deleted.
export async function getUserAchievements(env, userId) {
  if (!userId) return [];
  const D = await db(env);
  const { results } = await D.prepare(
    `SELECT a.id, a.name, a.description, a.icon, a.tier, a.points,
            u.unlocked_at
       FROM user_achievement u
       JOIN achievement_def a ON a.id = u.achievement_id
      WHERE u.user_id = ?
      ORDER BY u.unlocked_at DESC`
  ).bind(userId).all();
  return (results || []).map(r => ({
    id: r.id,
    name: r.name,
    description: r.description,
    icon: r.icon,
    tier: r.tier,
    points: r.points,
    unlockedAt: r.unlocked_at,
  }));
}

// ── Write API ─────────────────────────────────────────────────────

// Direct unlock by id. Idempotent, INSERT OR IGNORE on the composite
// PK means the second call is a no-op (newlyUnlocked=false). Returns
// the full achievement payload so callers can announce.
export async function tryUnlock(env, userId, achievementId, _ctx) {
  if (!userId || !achievementId) {
    return { newlyUnlocked: false, achievement: null };
  }
  const D = await db(env);
  const def = await D.prepare(
    `SELECT id, name, description, icon, tier, points
       FROM achievement_def
      WHERE id = ? AND active = 1
      LIMIT 1`
  ).bind(achievementId).first();
  if (!def) return { newlyUnlocked: false, achievement: null };

  const now = Date.now();
  // SQLite quirk: D1 doesn't surface a portable "did I insert" flag
  // through `meta.changes` reliably on INSERT OR IGNORE across all
  // versions, so we do a SELECT first to determine newness. Cheap, // the PK lookup is O(log n).
  const existing = await D.prepare(
    'SELECT unlocked_at FROM user_achievement WHERE user_id = ? AND achievement_id = ? LIMIT 1'
  ).bind(userId, achievementId).first();
  if (existing) {
    return {
      newlyUnlocked: false,
      achievement: { ...def, unlockedAt: existing.unlocked_at },
    };
  }

  await D.prepare(
    `INSERT OR IGNORE INTO user_achievement (user_id, achievement_id, unlocked_at)
     VALUES (?, ?, ?)`
  ).bind(userId, achievementId, now).run();

  return {
    newlyUnlocked: true,
    achievement: { ...def, unlockedAt: now },
  };
}

// ── Trigger matching ──────────────────────────────────────────────
//
// Event shape: { type, count?, value? }
//   type, required, matches achievement_def.trigger_type
//   count, for cumulative-count triggers ("10-checkins"); if the
//           event's count >= threshold, unlock fires
//   value, for sum-style triggers ("50-bolts-counted"); if the
//           running event value >= threshold, unlock fires
//
// We don't track per-user counters here on purpose. The caller is the
// authority on "how many checkins does this user have now"; they pass
// the *current cumulative* count/value in. Keeps this module
// stateless except for the actual unlocks table.

function eventSatisfies(def, event) {
  if (!def || !event) return false;
  if (def.trigger_type !== event.type) return false;
  const threshold = def.trigger_threshold;
  // No threshold = one-shot trigger; matching the type alone fires.
  if (threshold == null || threshold <= 1) return true;
  // For threshold > 1, prefer count, fall back to value.
  const observed = event.count != null ? Number(event.count)
                 : event.value != null ? Number(event.value)
                 : null;
  if (observed == null) return false;
  return observed >= threshold;
}

// Fan-out: scan every active definition with the event's type,
// fire tryUnlock for each that's satisfied AND not already owned by
// this user. Returns the list of *newly* unlocked achievements (empty
// if none changed state). Errors on individual defs don't abort the
// rest.
export async function checkAndUnlock(env, userId, event) {
  if (!userId || !event || !event.type) return [];
  const D = await db(env);
  const { results: defs } = await D.prepare(
    `SELECT id, name, description, icon, tier, points,
            trigger_type, trigger_threshold
       FROM achievement_def
      WHERE active = 1 AND trigger_type = ?`
  ).bind(event.type).all();
  if (!defs || !defs.length) return [];

  // Skip defs the user already owns, single query is cheaper than
  // N round-trips inside tryUnlock when most are already unlocked.
  const { results: owned } = await D.prepare(
    'SELECT achievement_id FROM user_achievement WHERE user_id = ?'
  ).bind(userId).all();
  const ownedSet = new Set((owned || []).map(r => r.achievement_id));

  const unlocked = [];
  for (const def of defs) {
    if (ownedSet.has(def.id)) continue;
    if (!eventSatisfies(def, event)) continue;
    try {
      const r = await tryUnlock(env, userId, def.id, { event });
      if (r.newlyUnlocked && r.achievement) unlocked.push(r.achievement);
    } catch (e) {
      console.warn('[achievements] tryUnlock failed for', def.id, e && e.message);
    }
  }
  return unlocked;
}
