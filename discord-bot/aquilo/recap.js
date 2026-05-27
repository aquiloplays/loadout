// Weekly community-night recap. Fires from cron Sunday 10 AM ET. Looks
// back 7 days of CN polls and posts a summary embed to the schedule
// channel. Idempotent guard: if no closed polls exist in the window,
// silent no-op (so empty weeks don't post empty recaps).

import { postChannelMessage, COLOR_SCHEDULE, cap } from './util.js';
import { ensureBootstrap } from './bootstrap.js';
import { getChannelBinding } from '../channel-bindings.js';

export async function postWeeklyRecap(env) {
  const guildId = await ensureBootstrap(env);
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000)
    .toISOString().slice(0, 19).replace('T', ' ');

  const { results: polls } = await env.DB.prepare(
    `SELECT p.id, p.day_of_week, g.name AS winner_name
     FROM polls p
     LEFT JOIN games g ON g.id = p.winner_game_id
     WHERE p.guild_id = ? AND p.posted_at >= ? AND p.closed_at IS NOT NULL
     ORDER BY p.posted_at ASC`
  ).bind(guildId, sevenDaysAgo).all();

  if (!polls?.length) return { skipped: 'no_polls' };

  const pollIds = polls.map(p => p.id);
  const placeholders = pollIds.map(() => '?').join(',');

  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM poll_votes WHERE poll_id IN (${placeholders})`
  ).bind(...pollIds).first();
  const totalVotes = totalRow?.c || 0;

  // Top voter = participated in the most polls this week (ties → arbitrary).
  const topRow = await env.DB.prepare(
    `SELECT user_id, COUNT(DISTINCT poll_id) AS c FROM poll_votes
     WHERE poll_id IN (${placeholders})
     GROUP BY user_id
     ORDER BY c DESC, MIN(voted_at) ASC
     LIMIT 1`
  ).bind(...pollIds).first();

  const fields = polls.map(p => ({
    name: cap(p.day_of_week),
    value: p.winner_name ? '**' + p.winner_name + '**' : '_no votes_',
    inline: true
  }));

  const lines = [];
  lines.push('**' + totalVotes + '** vote' + (totalVotes === 1 ? '' : 's') +
             ' across ' + polls.length + ' poll' + (polls.length === 1 ? '' : 's') + '.');
  if (topRow?.user_id) {
    lines.push('🏅 Most-active voter: <@' + topRow.user_id + '> (' + topRow.c + ' poll' + (topRow.c === 1 ? '' : 's') + ')');
  }

  const embed = {
    title: '📊 Community Nights · Weekly Recap',
    description: lines.join('\n'),
    color: COLOR_SCHEDULE,
    fields,
    timestamp: new Date().toISOString(),
    // Footer points users at the live voting embed instead of
    // hardcoding the v1 "6 PM ET on stream day" cadence (schedule v2
    // uses Wed-noon → Fri 23:59 multi-day windows). Exact timestamps
    // are rendered by vote-hub.js's buildPhaseEmbed in viewers' local
    // timezones, so the footer just nudges users to that channel.
    footer: { text: 'Vote in the community-night voting channel — timestamps render in your local timezone.' }
  };

  const scheduleChannelId = await getChannelBinding(env, guildId, 'schedule');
  if (!scheduleChannelId) return { skipped: 'no_schedule_channel' };
  await postChannelMessage(env, scheduleChannelId, { embeds: [embed] });
  return { polls: polls.length, totalVotes, topVoterId: topRow?.user_id || null, channelId: scheduleChannelId };
}
