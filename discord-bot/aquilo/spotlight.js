// Patron spotlight. Friday 10 AM ET cron fires this: pick a random
// member with one of the eligible (Patron/Booster) roles and post a
// "Spotlight" embed in ENGAGEMENT_CHANNEL_ID.
//
// Requires Server Members Intent (same as notify.js). Without it, the
// member fetch silently fails and we no-op.

import { discordFetch, postChannelMessage, COLOR_SCHEDULE } from './util.js';
import { getEligibleRoles, getGuildId } from './bootstrap.js';

const KV_LAST_SPOTLIGHT = 'spotlight:last_user';

async function fetchEligibleMembers(env, guildId, eligibleRoles) {
  let after = '0';
  const matched = [];
  for (let safety = 0; safety < 50; safety++) {
    let page;
    try {
      page = await discordFetch(env,
        '/guilds/' + encodeURIComponent(guildId) +
        '/members?limit=1000&after=' + encodeURIComponent(after));
    } catch (e) {
      console.error('[spotlight] members fetch (intent enabled?)', e?.message || e);
      return matched;
    }
    if (!page || page.length === 0) break;
    for (const m of page) {
      if (m.user?.bot) continue;
      const has = (m.roles || []).some(r => eligibleRoles.includes(r));
      if (has) matched.push(m);
    }
    if (page.length < 1000) break;
    after = page[page.length - 1].user.id;
  }
  return matched;
}

function tierLabel(member, eligibleRolesOrdered) {
  const total = eligibleRolesOrdered.length;
  for (let i = 0; i < total; i++) {
    if ((member.roles || []).includes(eligibleRolesOrdered[i])) {
      const tier = total - i;
      const stars = '⭐'.repeat(Math.min(tier, 5));
      return 'Tier ' + tier + ' ' + stars;
    }
  }
  return 'Patron';
}

export async function postPatronSpotlight(env) {
  if (!env.ENGAGEMENT_CHANNEL_ID) return { skipped: 'no_channel' };
  const guildId = await getGuildId(env);
  const eligible = getEligibleRoles(env);
  if (!eligible.length) return { skipped: 'no_eligible_roles' };

  const members = await fetchEligibleMembers(env, guildId, eligible);
  if (!members.length) return { skipped: 'no_eligible_members' };

  // Avoid picking the same person two weeks in a row (if we can avoid it).
  const last = await env.STATE.get(KV_LAST_SPOTLIGHT);
  let pool = members.length > 1 ? members.filter(m => m.user.id !== last) : members;
  const pick = pool[Math.floor(Math.random() * pool.length)];

  const userId = pick.user.id;
  const username = pick.nick || pick.user.global_name || pick.user.username || 'Patron';
  const tier = tierLabel(pick, eligible);
  const joinedAt = pick.joined_at ? new Date(pick.joined_at) : null;
  const memberSinceDays = joinedAt ? Math.floor((Date.now() - joinedAt.getTime()) / 86400000) : null;

  const lines = ['🎉 **<@' + userId + '>** — _' + tier + '_'];
  if (memberSinceDays !== null) {
    lines.push('Member for ' + memberSinceDays + ' day' + (memberSinceDays === 1 ? '' : 's'));
  }
  lines.push('');
  lines.push('Drop a 👋 in the replies — show some love!');

  const embed = {
    title: '🌟 Patron Spotlight',
    description: lines.join('\n'),
    color: COLOR_SCHEDULE,
    thumbnail: pick.user.avatar
      ? { url: 'https://cdn.discordapp.com/avatars/' + userId + '/' + pick.user.avatar + '.png?size=256' }
      : undefined,
    footer: { text: 'Aquilo · Patron Spotlight · Fridays' }
  };
  await postChannelMessage(env, env.ENGAGEMENT_CHANNEL_ID, {
    content: '<@' + userId + '>',
    allowed_mentions: { parse: [], users: [userId] },
    embeds: [embed]
  });
  await env.STATE.put(KV_LAST_SPOTLIGHT, userId);
  return { spotlighted: userId };
}
