// Server milestone celebrations. Fully automatic: bot fetches the
// guild's approximate member count daily and posts a celebration when
// it crosses a defined threshold. Tracks the highest already-celebrated
// milestone in KV so the same one doesn't fire twice.
//
// No admin configuration needed. The thresholds are baked in but easy
// to tune if you want different milestones.

import { discordFetch, postChannelMessage, COLOR_SCHEDULE } from './util.js';
import { getGuildId } from './bootstrap.js';

const KV_LAST_MILESTONE = 'goals:last_member_milestone';

// Powers-of-friendly numbers. Add or remove freely.
const MEMBER_MILESTONES = [
  25, 50, 75, 100, 150, 200, 300, 500, 750,
  1000, 1500, 2000, 3000, 5000, 7500,
  10000, 15000, 25000, 50000, 100000
];

function pickMilestoneFlavor(n) {
  if (n >= 10000) return ['🏆 Massive', 'You\'re officially a phenomenon.'];
  if (n >= 1000)  return ['🎊 Huge',    'A whole-ass community now.'];
  if (n >= 500)   return ['🎉 Big',     'The vibes are immaculate.'];
  if (n >= 100)   return ['🎈 Sweet',   'Triple digits!'];
  return ['🪅 Cozy', 'We\'re growing.'];
}

export async function checkMemberMilestones(env) {
  if (!env.ENGAGEMENT_CHANNEL_ID) return { skipped: 'no_channel' };

  const guildId = await getGuildId(env);
  let guild;
  try {
    guild = await discordFetch(env,
      '/guilds/' + encodeURIComponent(guildId) + '?with_counts=true');
  } catch (e) {
    console.warn('[goals] guild fetch failed:', e?.message || e);
    return { skipped: 'fetch_failed' };
  }
  const count = guild.approximate_member_count || guild.member_count || 0;
  if (!count) return { skipped: 'zero_count' };

  const lastRaw = await env.STATE.get(KV_LAST_MILESTONE);
  const last = lastRaw ? parseInt(lastRaw, 10) : 0;

  // Find the highest milestone we've crossed but not yet celebrated.
  // If multiple new ones (e.g. server seeded with 1k members), pick the
  // largest crossed one and skip the smaller ones, celebrating "100,
  // 150, 200, 500, 1000" in sequence is spammy.
  let next = null;
  for (const m of MEMBER_MILESTONES) {
    if (m <= last) continue;
    if (count >= m) next = m;
  }
  if (!next) return { skipped: 'no_new_milestone', count, last };

  const [headline, flavor] = pickMilestoneFlavor(next);
  await postChannelMessage(env, env.ENGAGEMENT_CHANNEL_ID, {
    embeds: [{
      title: headline + ' · ' + next + ' members!',
      description: '🎉 We just crossed **' + next + ' members** in the Discord!\n\n' + flavor + ' Thanks for being here.',
      color: COLOR_SCHEDULE,
      timestamp: new Date().toISOString(),
      footer: { text: 'Aquilo · Server Milestone' }
    }]
  });

  await env.STATE.put(KV_LAST_MILESTONE, String(next));
  return { celebrated: next, current: count };
}
