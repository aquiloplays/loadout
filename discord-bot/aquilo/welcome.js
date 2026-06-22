// Welcome ritual, fires once per (guild, user) the first time we see
// them act. Posts a celebratory card in #engagement and unlocks the
// "First Light" achievement.
//
// Trigger surface: any handler that wants to mark "this user is now
// active", viewer-hub clicks, /suggest, /sr-add, first count, first
// /passport. Idempotent: once-per-user via the `welcomed` D1 table.
//
// Public API:
//   maybeWelcome(env, guildId, userId, member) -> { welcomed: bool, ... }

import { postChannelMessage, discordFetch, COLOR_SCHEDULE } from './util.js';
import { bumpAndAnnounce } from './achievements.js';

// (Bolts economy sunset: removed STARTER_BOLTS + starter-bolt grant)

/**
 * Best-effort welcome ritual. Returns { welcomed: true } on first call
 * per user; { welcomed: false, reason } afterward.
 *
 * Caller passes `member` (Discord interaction member object) when
 * available, used for the welcome card's pretty name + avatar.
 */
export async function maybeWelcome(env, guildId, userId, member = null) {
  if (!env?.DB || !guildId || !userId) {
    return { welcomed: false, reason: 'env_unset' };
  }

  // Atomic "first ever" check: INSERT OR IGNORE.
  const ins = await env.DB.prepare(
    'INSERT OR IGNORE INTO welcomed (guild_id, user_id) VALUES (?, ?)'
  ).bind(guildId, userId).run();

  if (!ins.meta?.changes) {
    return { welcomed: false, reason: 'already_welcomed' };
  }

  // 1) Grant First Light achievement.
  try { await bumpAndAnnounce(env, guildId, userId, 'first_light'); }
  catch (e) { console.error('[welcome] achievement bump failed', e?.message || e); }

  // (Bolts economy sunset: removed starter-bolt grant POST block)

  // 2) Post welcome card in #engagement.
  if (env.ENGAGEMENT_CHANNEL_ID) {
    try {
      const username = member?.user?.global_name ||
                       member?.user?.username ||
                       member?.nick ||
                       `<@${userId}>`;
      const avatar = member?.user?.avatar
        ? `https://cdn.discordapp.com/avatars/${userId}/${member.user.avatar}.png?size=128`
        : null;

      const lines = [
        `🌩️ **Welcome to Aquilo, ${username}!**`,
        '',
        '🪪 Run `/passport` any time to see your streak + achievements.',
        '🎲 Try `/encounter` for a random roll, or use the viewer hub.',
        '✨ React to this message with the storm emoji to say hi.',
        '🎵 Add songs to the next stream via the viewer hub.',
        '',
        `Welcome to the storm. _<@${userId}>_`,
      ];

      const embed = {
        color: COLOR_SCHEDULE,
        title: `🪪 New face`,
        description: lines.join('\n'),
        thumbnail: avatar ? { url: avatar } : undefined,
        timestamp: new Date().toISOString(),
      };

      const msg = await postChannelMessage(env, env.ENGAGEMENT_CHANNEL_ID, {
        embeds: [embed],
        allowed_mentions: { users: [userId] },
      });

      // Add the storm-clap reaction so newcomers can join in.
      if (msg?.id) {
        try {
          await discordFetch(env,
            `/channels/${env.ENGAGEMENT_CHANNEL_ID}/messages/${msg.id}/reactions/${encodeURIComponent('⚡')}/@me`,
            { method: 'PUT' });
        } catch { /* reaction-add is non-critical */ }
      }
    } catch (e) {
      console.error('[welcome] post failed', e?.message || e);
    }
  }

  return { welcomed: true };
}
