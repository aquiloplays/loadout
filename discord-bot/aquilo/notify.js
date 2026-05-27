// DM eligible patrons + boosters when a CN queue opens. Driven by
// poll.js's closeCnPoll path. Best-effort: failures (DMs disabled,
// rate limits, etc.) are logged and skipped, not surfaced to the user.
//
// IMPORTANT: requires the **Server Members Intent** to be enabled in
// the dev portal under Bot → Privileged Gateway Intents. Without it,
// /guilds/{id}/members returns 401 and we can't list eligible members.
//
// Per-poll dedupe + per-user opt-out lives in KV:
//   dm_optout       → JSON array of user_ids who muted these DMs
//   dm_sent:<poll>  → JSON array of user_ids already DM'd for that poll

import { discordFetch, sendDm, sleep } from './util.js';
import { getEligibleRoles } from './bootstrap.js';

const KV_OPTOUT  = 'dm_optout';
const KV_DM_SENT = (pollId) => 'dm_sent:' + pollId;

async function getOptOuts(env) {
  const raw = await env.STATE.get(KV_OPTOUT);
  try { return new Set(raw ? JSON.parse(raw) : []); }
  catch { return new Set(); }
}

async function addOptOut(env, userId) {
  const opt = await getOptOuts(env);
  opt.add(userId);
  await env.STATE.put(KV_OPTOUT, JSON.stringify([...opt]));
}

// Walk all guild members 1000 at a time, keeping just those whose role
// list intersects `eligibleRoles`. Bot users skipped.
async function fetchEligibleMembers(env, guildId, eligibleRoles) {
  let after = '0';
  const matched = [];
  for (let safety = 0; safety < 50; safety++) {  // hard cap @ 50k members
    let page;
    try {
      page = await discordFetch(env,
        '/guilds/' + encodeURIComponent(guildId) +
        '/members?limit=1000&after=' + encodeURIComponent(after));
    } catch (e) {
      console.error('[notify] members fetch (intent enabled?)', e?.message || e);
      return matched;
    }
    if (!page || page.length === 0) break;
    for (const m of page) {
      if (m.user?.bot) continue;
      const has = (m.roles || []).some(r => eligibleRoles.includes(r));
      if (has) matched.push(m.user.id);
    }
    if (page.length < 1000) break;
    after = page[page.length - 1].user.id;
  }
  return matched;
}

// Notify all eligible patrons that the queue is open. Skips opt-outs and
// users we already DM'd for this poll. Designed for ctx.waitUntil — runs
// async after the close response.
export async function notifyEligibleQueueOpen(env, guildId, pollId, dayOfWeek, gameName, queueChannelId, queueMessageId) {
  const eligible = getEligibleRoles(env);
  if (!eligible.length) return { skipped: 'no_eligible_roles' };

  const optOuts = await getOptOuts(env);
  const sentRaw = await env.STATE.get(KV_DM_SENT(pollId));
  let sent;
  try { sent = new Set(sentRaw ? JSON.parse(sentRaw) : []); }
  catch { sent = new Set(); }

  const userIds = await fetchEligibleMembers(env, guildId, eligible);
  if (!userIds.length) return { skipped: 'no_eligible_members' };

  const dayLabel = dayOfWeek.charAt(0).toUpperCase() + dayOfWeek.slice(1);
  const jumpUrl = 'https://discord.com/channels/' + guildId + '/' + queueChannelId + '/' + queueMessageId;
  const content = '🎮 Tonight is **' + dayLabel + ' Community Night** · **' + gameName + '**.\n\n' +
                  'The queue is open. Click below to jump there and join.';
  const components = [{
    type: 1,
    components: [
      { type: 2, style: 5, label: 'Open Queue',     url: jumpUrl, emoji: { name: '🎮' } },
      { type: 2, style: 2, label: 'Mute these DMs', custom_id: 'notify:optout', emoji: { name: '🔕' } }
    ]
  }];

  let dispatched = 0;
  for (const uid of userIds) {
    if (optOuts.has(uid) || sent.has(uid)) continue;
    try {
      await sendDm(env, uid, { content, components });
      sent.add(uid);
      dispatched++;
    } catch (e) {
      // Common: 50007 (Cannot send messages to this user). Skip silently.
      console.warn('[notify] DM ' + uid + ' failed: ' + (e?.message || e));
    }
    // Pace ~4 DMs/sec to stay under Discord's per-bot DM limit.
    await sleep(250);
  }
  // Persist sent list with a 7-day TTL so re-runs don't double-DM but the
  // KV doesn't grow unbounded.
  await env.STATE.put(KV_DM_SENT(pollId), JSON.stringify([...sent]), { expirationTtl: 86400 * 7 });
  return { dispatched, total: userIds.length };
}

// Vote-reminder DM. Fires at 8 PM ET on Wed/Fri/Sat (1 hour before poll
// closes at 9 PM). DMs each eligible patron who has NOT voted in the
// currently-open poll. Skips opt-outs and already-reminded users.
//
// Requires Server Members Intent (same as notifyEligibleQueueOpen).
const KV_REMIND_SENT = (pollId) => 'dm_remind_sent:' + pollId;

export async function notifyUnvotedEligibles(env, guildId) {
  const eligible = getEligibleRoles(env);
  if (!eligible.length) return { skipped: 'no_eligible_roles' };

  // Find the currently-open poll for this guild.
  const open = await env.DB.prepare(
    'SELECT id, channel_id, message_id, day_of_week FROM polls WHERE guild_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1'
  ).bind(guildId).first();
  if (!open) return { skipped: 'no_open_poll' };
  if (!open.message_id) return { skipped: 'poll_has_no_message' };

  // Who has voted already?
  const { results: voted } = await env.DB.prepare(
    'SELECT user_id FROM poll_votes WHERE poll_id = ?'
  ).bind(open.id).all();
  const votedSet = new Set((voted || []).map(r => r.user_id));

  const optOuts = await getOptOuts(env);
  const remindRaw = await env.STATE.get(KV_REMIND_SENT(open.id));
  let reminded;
  try { reminded = new Set(remindRaw ? JSON.parse(remindRaw) : []); }
  catch { reminded = new Set(); }

  const userIds = await fetchEligibleMembers(env, guildId, eligible);
  if (!userIds.length) return { skipped: 'no_eligible_members' };

  const dayLabel = open.day_of_week.charAt(0).toUpperCase() + open.day_of_week.slice(1);
  const jumpUrl = 'https://discord.com/channels/' + guildId + '/' + open.channel_id + '/' + open.message_id;
  const { nextEventTimestamp } = await import('../vote-hub.js');
  const closeTs = nextEventTimestamp(Date.now(), open.day_of_week, 21);
  const closeTag = closeTs
    ? `(closes <t:${Math.floor(closeTs / 1000)}:R>)`
    : '(closes in ~1 hour)';
  const content = `⏰ **${dayLabel} Community Night poll closes soon** ${closeTag}.\n\n` +
                  'You haven\'t voted yet — your pick decides what we play tonight!';
  const components = [{
    type: 1,
    components: [
      { type: 2, style: 5, label: 'Go vote',         url: jumpUrl, emoji: { name: '🗳️' } },
      { type: 2, style: 2, label: 'Mute these DMs',  custom_id: 'notify:optout', emoji: { name: '🔕' } }
    ]
  }];

  let dispatched = 0;
  for (const uid of userIds) {
    if (votedSet.has(uid)) continue;
    if (optOuts.has(uid))  continue;
    if (reminded.has(uid)) continue;
    try {
      await sendDm(env, uid, { content, components });
      reminded.add(uid);
      dispatched++;
    } catch (e) {
      console.warn('[notify-vote-reminder] DM ' + uid + ' failed: ' + (e?.message || e));
    }
    await sleep(250);
  }
  await env.STATE.put(KV_REMIND_SENT(open.id), JSON.stringify([...reminded]), { expirationTtl: 86400 * 7 });
  return { dispatched, total: userIds.length, voted: votedSet.size };
}

// Component handler for any custom_id starting "notify:".
export async function handleNotifyButton(env, data) {
  const action = (data.data?.custom_id || '').split(':')[1];
  const userId = data.user?.id || data.member?.user?.id;
  if (!userId) return { type: 4, data: { content: 'Couldn\'t identify you.', flags: 64 } };
  if (action === 'optout') {
    await addOptOut(env, userId);
    return { type: 4, data: { content: '🔕 Muted. You won\'t get queue-open DMs from this bot anymore.', flags: 64 } };
  }
  return { type: 4, data: { content: 'Unknown notify action.', flags: 64 } };
}
