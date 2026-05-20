// Welcome ritual — fires once per (guild, user) the first time we see
// them act. Posts a celebratory card in #engagement, grants 100 starter
// Bolts via Loadout's award-bolts endpoint, and unlocks the "First Light"
// achievement.
//
// Trigger surface: any handler that wants to mark "this user is now
// active" — viewer-hub clicks, /suggest, /sr-add, first count, first
// /passport. Idempotent: once-per-user via the `welcomed` D1 table.
//
// Public API:
//   maybeWelcome(env, guildId, userId, member) -> { welcomed: bool, ... }

import { postChannelMessage, discordFetch, COLOR_SCHEDULE } from './util.js';
import { bumpAndAnnounce } from './achievements.js';

const STARTER_BOLTS = 100;

/**
 * Best-effort welcome ritual. Returns { welcomed: true } on first call
 * per user; { welcomed: false, reason } afterward.
 *
 * Caller passes `member` (Discord interaction member object) when
 * available — used for the welcome card's pretty name + avatar.
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

  // 2) Credit 100 starter Bolts via Loadout's cross-bot endpoint.
  let boltsCredited = false;
  if (env.LOADOUT_BOLT_API && env.LOADOUT_BOLT_API_SECRET) {
    try {
      const resp = await fetch(env.LOADOUT_BOLT_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-loadout-bolt-secret': env.LOADOUT_BOLT_API_SECRET,
        },
        body: JSON.stringify({
          user_id: userId,
          amount: STARTER_BOLTS,
          reason: 'welcome',
        }),
      });
      boltsCredited = resp.ok;
      if (!resp.ok) console.error('[welcome] bolts grant failed', resp.status, await resp.text());
    } catch (e) { console.error('[welcome] bolts grant exception', e?.message || e); }
  }

  // 3) Post welcome card in #engagement.
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
        boltsCredited
          ? `You've been credited **${STARTER_BOLTS} starter Bolts** — run \`/loadout\` to claim your daily, peek the shop, or flip a coin.`
          : `Run \`/loadout\` to set up your hero and start earning Bolts.`,
        '',
        '✨ React to this message with the storm emoji to say hi.',
        '🪪 Run `/passport` any time to see your streak + achievements.',
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

  return { welcomed: true, bolts_credited: boltsCredited };
}
