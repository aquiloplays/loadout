// Weekly leaderboard channel post. Mondays at 10 AM ET — edit-in-place
// embed listing top-10 streaks, top-10 achievement earners, and top-3
// clip submitters for the past week.
//
// Public API:
//   refreshLeaderboardChannel(env)   -> cron: post or edit

import {
  postChannelMessage, editChannelMessage, COLOR_SCHEDULE, weekStartET
} from './util.js';
import { topStreaks } from './streak.js';
import { topEarners } from './achievements.js';

const KV_LB_MSG = 'leaderboard:msg';   // { channel_id, message_id }

export async function refreshLeaderboardChannel(env) {
  if (!env?.DB || !env.LEADERBOARD_CHANNEL_ID) return;
  // Pick a guild id from the bot's known active guild. (Cron context.)
  const guildId = await pickGuildId(env);
  if (!guildId) return;

  const streaks = await topStreaks(env, guildId, 10);
  const earners = await topEarners(env, guildId, 10);
  const topClips = await fetchTopClipAuthors(env, guildId);

  const embed = {
    color: COLOR_SCHEDULE,
    title: '⚡ Aquilo Leaderboards',
    description: 'Updated weekly — Mondays at 10 AM ET.',
    fields: [
      {
        name: '⚡ Top streaks',
        value: streaks.length
          ? streaks.map((r, i) => `**${i + 1}.** <@${r.user_id}> — ${r.current_days}d`).join('\n')
          : '_no streaks yet_',
        inline: false,
      },
      {
        name: '🏆 Most achievements',
        value: earners.length
          ? earners.map((r, i) => `**${i + 1}.** <@${r.user_id}> — ${r.earned} earned`).join('\n')
          : '_no achievements unlocked yet_',
        inline: false,
      },
      {
        name: '🎬 Top clip submitters this week',
        value: topClips.length
          ? topClips.map((r, i) => `**${i + 1}.** <@${r.author_id}> — ${r.n} clips`).join('\n')
          : '_no clips yet this week_',
        inline: false,
      },
    ],
    footer: { text: 'Run /passport to see your own streak + achievements.' },
    timestamp: new Date().toISOString(),
  };

  const raw = await env.STATE.get(KV_LB_MSG);
  let stored = null;
  try { stored = raw ? JSON.parse(raw) : null; } catch {}

  if (stored?.channel_id === env.LEADERBOARD_CHANNEL_ID && stored?.message_id) {
    try {
      await editChannelMessage(env, env.LEADERBOARD_CHANNEL_ID, stored.message_id, { embeds: [embed] });
      return;
    } catch { /* fall through to repost */ }
  }
  const msg = await postChannelMessage(env, env.LEADERBOARD_CHANNEL_ID, { embeds: [embed] });
  if (msg?.id) {
    await env.STATE.put(KV_LB_MSG, JSON.stringify({
      channel_id: env.LEADERBOARD_CHANNEL_ID, message_id: msg.id
    }));
  }
}

async function pickGuildId(env) {
  // Best-effort — read from KV. Set by bootstrap on first command.
  try {
    const raw = await env.STATE.get('active_guild_id');
    if (raw) return raw;
  } catch {}
  return null;
}

async function fetchTopClipAuthors(env, guildId) {
  const since = weekStartET();
  try {
    const { results } = await env.DB.prepare(
      `SELECT author_id, COUNT(*) AS n FROM clips
         WHERE guild_id = ? AND posted_at >= ?
         GROUP BY author_id ORDER BY n DESC LIMIT 3`
    ).bind(guildId, since).all();
    return results || [];
  } catch { return []; }
}
