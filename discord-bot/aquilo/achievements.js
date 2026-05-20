// Achievement / badge system. D1-backed, callable from any module that
// wants to bump progress on a key. Earned achievements grant a cosmetic
// role (mapped via ACHIEVEMENT_ROLES_JSON env var) and surface on the
// passport.
//
// Public API:
//   bump(env, guildId, userId, key, delta=1)  -> { newly_earned, progress, threshold }
//   listEarned(env, guildId, userId)         -> [{ key, earned_at }, ...]
//   listAll()                                -> CATALOG (for /passport progress view)
//
// Adding a new achievement: append to CATALOG. No DB migration needed —
// the achievements table is keyed by (guild, user, key) string.

import { discordFetch } from './util.js';

// ---- Catalog of 25 achievements ---------------------------------------
//
// Categories: identity (first-X) · stream · social · economy · longevity
//
// Fields:
//   key       - DB primary-key fragment (snake_case)
//   name      - display name
//   icon      - emoji shown in passport
//   threshold - progress value at which it unlocks (1 for one-shots)
//   tagline   - short description shown on unlock + in catalog
//   secret    - if true, hidden from progress lists until earned

export const CATALOG = [
  // --- Identity (first-X one-shots) ----------------------------------
  { key: 'first_light',    name: 'First Light',     icon: '🌅', threshold: 1, tagline: 'Linked your stream identity for the first time.' },
  { key: 'first_word',     name: 'First Word',      icon: '💬', threshold: 1, tagline: 'Posted your first message in the server.' },
  { key: 'first_count',    name: 'First Count',     icon: '🔢', threshold: 1, tagline: 'Counted at least once in #counting.' },
  { key: 'first_song',     name: 'First Track',     icon: '🎵', threshold: 1, tagline: 'Added a song to Rotation pre-queue.' },
  { key: 'first_vote',     name: 'First Vote',      icon: '🗳️', threshold: 1, tagline: 'Voted in a community-night poll.' },
  { key: 'first_suggest',  name: 'First Suggest',   icon: '💡', threshold: 1, tagline: 'Suggested a game via the viewer hub.' },
  { key: 'first_encounter',name: 'First Encounter', icon: '🎲', threshold: 1, tagline: 'Rolled an encounter on the viewer hub.' },
  { key: 'first_purchase', name: 'First Purchase',  icon: '🛍️', threshold: 1, tagline: 'Spent Bolts at the Discord shop.' },

  // --- Stream-time engagement ---------------------------------------
  { key: 'cartographer',   name: 'Cartographer',    icon: '🗺️', threshold: 30,  tagline: 'Voted in 30 community-night polls.' },
  { key: 'roadie',         name: 'Roadie',          icon: '🎤', threshold: 50,  tagline: 'Added 50 songs to Rotation.' },
  { key: 'trivia_master',  name: 'Trivia Master',   icon: '🧠', threshold: 25,  tagline: 'Won 25 daily trivia rounds.' },
  { key: 'clip_curator',   name: 'Clip Curator',    icon: '🎬', threshold: 20,  tagline: 'Submitted 20 clips to #clips.' },
  { key: 'queue_regular',  name: 'Queue Regular',   icon: '🪑', threshold: 15,  tagline: 'Joined 15 community-night queues.' },

  // --- Social / community ------------------------------------------
  { key: 'lighthouse',     name: 'Lighthouse',      icon: '🏠', threshold: 50,  tagline: 'Posted 50 messages in #mc-help.' },
  { key: 'gifter',         name: 'Gifter',          icon: '🎁', threshold: 10,  tagline: 'Gifted Bolts to 10 different users.' },
  { key: 'birthday_bash',  name: 'Birthday Bash',   icon: '🎂', threshold: 1,   tagline: 'Set your birthday.' },

  // --- Economy / Bolts ----------------------------------------------
  { key: 'sparkler',       name: 'Sparkler',        icon: '✨', threshold: 1000,    tagline: 'Earned 1,000 Bolts lifetime.' },
  { key: 'hurricane_hunter',name: 'Hurricane Hunter', icon: '🌀', threshold: 100000, tagline: 'Earned 100k Bolts lifetime.' },
  { key: 'big_spender',    name: 'Big Spender',     icon: '💸', threshold: 5000,   tagline: 'Spent 5,000 Bolts at the Discord shop.' },

  // --- Longevity / streaks -----------------------------------------
  { key: 'stormrider',     name: 'Stormrider',      icon: '⚡', threshold: 7,    tagline: 'Maintained a 7-day cross-product streak.' },
  { key: 'gale_force',     name: 'Gale Force',      icon: '🌬️', threshold: 30,   tagline: 'Maintained a 30-day streak.' },
  { key: 'tempest',        name: 'Tempest',         icon: '🌪️', threshold: 100,  tagline: 'Maintained a 100-day streak.' },
  { key: 'veteran',        name: 'Veteran',         icon: '🎖️', threshold: 365,  tagline: 'A full year of Aquilo membership.' },
  { key: 'patron_of_storm',name: 'Patron of the Storm', icon: '🌩️', threshold: 1, tagline: 'Pledged to Patreon at any tier.' },

  // --- Secret (don't show progress until earned) -----------------
  { key: 'first_dragon',   name: 'First Dragon',    icon: '🐉', threshold: 1, tagline: 'Killed the Ender Dragon on the Aquilo SMP.', secret: true },
];

const CATALOG_BY_KEY = Object.fromEntries(CATALOG.map(a => [a.key, a]));

export function getAchievement(key) {
  return CATALOG_BY_KEY[key] || null;
}

export function listAll() {
  return CATALOG;
}

/**
 * Bump progress on an achievement. Returns:
 *   { progress, threshold, newly_earned, achievement }
 * where newly_earned:true means this call crossed the threshold.
 *
 * Idempotent on duplicate-but-already-earned: no-ops.
 */
export async function bump(env, guildId, userId, key, delta = 1) {
  if (!env?.DB || !guildId || !userId) {
    return { progress: 0, threshold: 0, newly_earned: false, achievement: null };
  }
  const ach = CATALOG_BY_KEY[key];
  if (!ach) return { progress: 0, threshold: 0, newly_earned: false, achievement: null };

  // UPSERT — track progress even before unlock.
  await env.DB.prepare(
    `INSERT INTO achievements (guild_id, user_id, key, progress)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(guild_id, user_id, key) DO UPDATE SET
         progress = CASE
           WHEN achievements.earned_at IS NOT NULL THEN achievements.progress
           ELSE achievements.progress + excluded.progress
         END`
  ).bind(guildId, userId, key, delta).run();

  const row = await env.DB.prepare(
    'SELECT progress, earned_at FROM achievements WHERE guild_id = ? AND user_id = ? AND key = ?'
  ).bind(guildId, userId, key).first();

  if (!row) return { progress: 0, threshold: ach.threshold, newly_earned: false, achievement: ach };

  const alreadyEarned = !!row.earned_at;
  const justEarned = !alreadyEarned && row.progress >= ach.threshold;

  if (justEarned) {
    await env.DB.prepare(
      'UPDATE achievements SET earned_at = datetime(\'now\') WHERE guild_id = ? AND user_id = ? AND key = ?'
    ).bind(guildId, userId, key).run();

    // Best-effort role grant.
    if (env.ACHIEVEMENT_ROLES_JSON) {
      try {
        const map = JSON.parse(env.ACHIEVEMENT_ROLES_JSON);
        const roleId = map[key];
        if (roleId) {
          await discordFetch(env,
            '/guilds/' + encodeURIComponent(guildId) +
            '/members/' + encodeURIComponent(userId) +
            '/roles/' + encodeURIComponent(roleId),
            { method: 'PUT' });
        }
      } catch (e) {
        console.error('[achievements] role grant failed', key, e?.message || e);
      }
    }
  }

  return {
    progress: row.progress,
    threshold: ach.threshold,
    newly_earned: justEarned,
    achievement: ach,
  };
}

/** Bump and announce in the engagement channel if newly earned. */
export async function bumpAndAnnounce(env, guildId, userId, key, delta = 1) {
  const r = await bump(env, guildId, userId, key, delta);
  if (r.newly_earned && env.ENGAGEMENT_CHANNEL_ID) {
    try {
      const { postChannelMessage } = await import('./util.js');
      await postChannelMessage(env, env.ENGAGEMENT_CHANNEL_ID, {
        content: `🏆 <@${userId}> earned **${r.achievement.icon} ${r.achievement.name}** — ${r.achievement.tagline}`,
        allowed_mentions: { users: [userId] }
      });
    } catch (e) {
      console.error('[achievements] announce failed', e?.message || e);
    }
  }
  return r;
}

/** Earned achievements for a single user, newest first. */
export async function listEarned(env, guildId, userId) {
  if (!env?.DB || !guildId || !userId) return [];
  const { results } = await env.DB.prepare(
    'SELECT key, earned_at FROM achievements WHERE guild_id = ? AND user_id = ? AND earned_at IS NOT NULL ORDER BY earned_at DESC'
  ).bind(guildId, userId).all();
  return results || [];
}

/** All achievements for a user (earned + in-progress). */
export async function listAllForUser(env, guildId, userId) {
  if (!env?.DB || !guildId || !userId) return [];
  const { results } = await env.DB.prepare(
    'SELECT key, progress, earned_at FROM achievements WHERE guild_id = ? AND user_id = ?'
  ).bind(guildId, userId).all();
  return results || [];
}

/** Top achievement-earners (count of earned) for leaderboard. */
export async function topEarners(env, guildId, limit = 10) {
  if (!env?.DB || !guildId) return [];
  const { results } = await env.DB.prepare(
    'SELECT user_id, COUNT(*) as earned FROM achievements WHERE guild_id = ? AND earned_at IS NOT NULL GROUP BY user_id ORDER BY earned DESC LIMIT ?'
  ).bind(guildId, limit).all();
  return results || [];
}
