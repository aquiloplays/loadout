// Community-night queue v2: persistent message in QUEUE_CHANNEL_ID with
// Join/Leave/View buttons. Posted automatically by poll.js when each CN
// poll closes (Wed/Fri/Sat 9 PM ET). Eligibility is gated by Patreon +
// server-booster roles; non-eligible users get an ephemeral with the
// Patreon link they can dismiss.
//
// Priority within the queue: highest-listed eligible role the user has
// determines their priority (5 down to 1 in the standard config). Sort
// rule: priority DESC, joined_at ASC.

import {
  ephemeral, postChannelMessage, editChannelMessage, openThread, sendDm,
  discordFetch, btn, row, BTN_SUCCESS, BTN_DANGER, BTN_SECONDARY, BTN_PRIMARY,
  COLOR_QUEUE, cap, updateMessage, isAdmin
} from './util.js';
import { getEligibleRoles, ensureBootstrap } from './bootstrap.js';
import { deleteQueueIdle, refreshQueueIdle } from './idle-msgs.js';
import { getChannelBinding } from '../channel-bindings.js';

const KEY = (gid) => 'queue:' + gid;
const DEFAULT_CAP = 100;

// Resolves the queue channel via the per-guild binding (KV) with
// QUEUE_CHANNEL_ID env fallback. See channel-bindings.js.
async function resolveQueueChannel(env, guildId) {
  return getChannelBinding(env, guildId, 'queue');
}

async function loadQueue(env, guildId) {
  const queueChannel = await resolveQueueChannel(env, guildId);
  const empty = () => ({ entries: [], cap: DEFAULT_CAP, message_id: null, channel_id: queueChannel, day_of_week: null, game: null, art_url: null });
  const raw = await env.STATE.get(KEY(guildId));
  if (!raw) return empty();
  try { return JSON.parse(raw); }
  catch { return empty(); }
}

async function saveQueue(env, guildId, q) {
  q.updated_at = new Date().toISOString();
  await env.STATE.put(KEY(guildId), JSON.stringify(q));
}

// Highest-priority eligible role the user has. ELIGIBLE list is ordered
// "highest tier first", so we iterate top-down and the first hit wins.
// Returns 0 if no eligible role; 1..N otherwise (N = list length).
function priorityFor(memberRoles, eligibleRolesOrdered) {
  if (!Array.isArray(memberRoles) || !eligibleRolesOrdered.length) return 0;
  const total = eligibleRolesOrdered.length;
  for (let i = 0; i < total; i++) {
    if (memberRoles.includes(eligibleRolesOrdered[i])) {
      return total - i; // first listed = highest = N
    }
  }
  return 0;
}

// Stable insertion: walk back from end, find first user with priority >=
// new entry, insert after them. Keeps high-pri above lower-pri but
// preserves FIFO within the same priority.
function insertWithPriority(entries, entry) {
  let idx = entries.length;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].priority >= entry.priority) break;
    idx = i;
  }
  entries.splice(idx, 0, entry);
  return idx;
}

function priorityBadge(p, total) {
  if (!p) return '';
  if (p === total) return '🥇';
  if (p === total - 1) return '🥈';
  if (p === total - 2) return '🥉';
  return '⭐';
}

function buildQueueMessage(q, eligibleCount) {
  const dayLabel = q.day_of_week ? cap(q.day_of_week) + ' Community Night' : 'Community Night';
  const headerDesc = q.game
    ? '**Tonight\'s game:** ' + q.game + '\n_Patron + Server Boost roles only._\nClick **Join** to enter the queue.'
    : '_Patron + Server Boost roles only._\nClick **Join** to enter the queue.';
  const header = {
    title: '🎮 ' + dayLabel + ' · Queue',
    description: headerDesc,
    color: COLOR_QUEUE
  };
  if (q.art_url) header.image = { url: q.art_url };

  const list = q.entries.length === 0
    ? ['_Queue is empty — first to click joins._']
    : q.entries.map((e, i) => {
        const badge = priorityBadge(e.priority, eligibleCount);
        return (i + 1) + '. ' + (badge ? badge + ' ' : '') + '<@' + e.user_id + '>';
      });
  const listEmbed = {
    title: 'In Queue (' + q.entries.length + ')',
    description: list.join('\n').slice(0, 4000),
    color: COLOR_QUEUE,
    footer: { text: '🥇 highest tier · ⭐ tier patrons · last to join shows at the bottom' }
  };

  const components = [row(
    btn('queue:join',  'Join Queue', { style: BTN_SUCCESS,   emoji: '🙋' }),
    btn('queue:leave', 'Leave',      { style: BTN_DANGER,    emoji: '✋' }),
    btn('queue:view',  'View',       { style: BTN_SECONDARY, emoji: '📋' }),
    btn('queue:next',  'Pull Next',  { style: BTN_PRIMARY,   emoji: '⏭️' })
  )];

  return { embeds: [header, listEmbed], components };
}

// Called by poll.js when a CN poll closes. Resets the queue and posts a
// fresh interactive message in QUEUE_CHANNEL_ID. Also deletes the queue
// idle CTA so the channel doesn't show both at once.
//
// Also creates a discussion thread on the new queue post so chatter
// about tonight's game stays organized — no manual setup needed.
export async function postQueueMessage(env, guildId, dayOfWeek, gameName, artUrl) {
  const eligibleRoles = getEligibleRoles(env);

  // Hide the idle CTA before posting the live queue so users only see one.
  try { await deleteQueueIdle(env); }
  catch (e) { console.warn('[queue] idle delete', e?.message || e); }

  const channelId = await resolveQueueChannel(env, guildId);
  if (!channelId) {
    console.warn('[queue] postQueueMessage: no queue channel bound');
    return { error: 'no-queue-channel' };
  }
  const q = {
    entries: [],
    cap: DEFAULT_CAP,
    message_id: null,
    channel_id: channelId,
    day_of_week: dayOfWeek,
    game: gameName,
    art_url: artUrl
  };
  const payload = buildQueueMessage(q, eligibleRoles.length);
  const msg = await postChannelMessage(env, channelId, payload);
  q.message_id = msg.id;
  await saveQueue(env, guildId, q);

  // Best-effort: create a discussion thread on the queue post. If the
  // bot lacks Create Public Threads perm, this fails silently.
  try {
    await openThread(env, channelId, msg.id,
      cap(dayOfWeek) + ' · ' + gameName + ' Discussion');
  } catch (e) { console.warn('[queue] thread create:', e?.message || e); }

  return { messageId: msg.id, channelId };
}

// Called from cron at 12:30 AM ET. After community-night stream ends
// (10:30 PM - 12:30 AM), wipe the live queue post and bring the idle
// CTA message back. No-op if no live queue exists.
export async function cleanupQueueAfterStream(env) {
  const guildId = await ensureBootstrap(env);
  const q = await loadQueue(env, guildId);

  if (q.channel_id && q.message_id) {
    try {
      await discordFetch(env,
        '/channels/' + encodeURIComponent(q.channel_id) +
        '/messages/' + encodeURIComponent(q.message_id),
        { method: 'DELETE' });
    } catch (e) { console.warn('[queue] cleanup delete:', e?.message || e); }
  }

  // Reset state
  q.entries = [];
  q.message_id = null;
  q.day_of_week = null;
  q.game = null;
  q.art_url = null;
  await saveQueue(env, guildId, q);

  // Bring idle CTA back
  try { await refreshQueueIdle(env); }
  catch (e) { console.warn('[queue] idle refresh:', e?.message || e); }

  return { ok: true };
}

async function refreshQueueMessage(env, guildId, q) {
  if (!q.channel_id || !q.message_id) return;
  const eligibleRoles = getEligibleRoles(env);
  const payload = buildQueueMessage(q, eligibleRoles.length);
  try { await editChannelMessage(env, q.channel_id, q.message_id, payload); }
  catch (e) { console.error('[queue] refresh', e?.message || e); }
}

// ---- Component handler -------------------------------------------------

// Called from worker.js when a button with custom_id starting "queue:" fires.
export async function handleQueueButton(env, data, guildId) {
  const action = (data.data?.custom_id || '').split(':')[1];
  const q = await loadQueue(env, guildId);
  const userId = data.member?.user?.id;

  if (action === 'join') {
    if (!userId) return ephemeral('Couldn\'t identify you.');

    const eligibleRoles = getEligibleRoles(env);
    const memberRoles = data.member?.roles || [];
    const priority = priorityFor(memberRoles, eligibleRoles);
    if (priority === 0) {
      // Direct-to-signup URL. The base /cw/aquilo lands on the tier
      // browser; /membership goes straight to the join flow.
      const url = env.PATREON_URL || 'https://www.patreon.com/cw/aquilo/membership';
      return ephemeral(
        '🔒 The community-night queue is for **patrons** and **server boosters**.\n\n' +
        '• Become a patron: ' + url + '\n' +
        '• Or boost the server in **Server Boosts**\n\n' +
        '_Already a patron?_ Make sure your Discord is linked to your Patreon account so the role is assigned automatically.'
      );
    }

    if (q.entries.some(e => e.user_id === userId)) {
      const pos = q.entries.findIndex(e => e.user_id === userId) + 1;
      return ephemeral('You\'re already in the queue at position **' + pos + '**.');
    }
    if (q.entries.length >= q.cap) return ephemeral('Queue is full (' + q.cap + ').');

    insertWithPriority(q.entries, {
      user_id: userId,
      username: data.member.user.username,
      priority,
      joined_at: new Date().toISOString()
    });
    await saveQueue(env, guildId, q);
    await refreshQueueMessage(env, guildId, q);
    const pos = q.entries.findIndex(e => e.user_id === userId) + 1;
    return ephemeral('🎮 Joined the queue at position **' + pos + '** (priority **' + priority + '**).');
  }

  if (action === 'leave') {
    if (!userId) return ephemeral('Couldn\'t identify you.');
    const before = q.entries.length;
    q.entries = q.entries.filter(e => e.user_id !== userId);
    if (q.entries.length === before) return ephemeral('You weren\'t in the queue.');
    await saveQueue(env, guildId, q);
    await refreshQueueMessage(env, guildId, q);
    return ephemeral('Left the queue.');
  }

  if (action === 'view') {
    const eligibleRoles = getEligibleRoles(env);
    const lines = q.entries.length === 0
      ? '_Queue is empty._'
      : q.entries.map((e, i) => {
          const badge = priorityBadge(e.priority, eligibleRoles.length);
          return (i + 1) + '. ' + (badge ? badge + ' ' : '') + '<@' + e.user_id + '> _(p' + e.priority + ')_';
        }).join('\n');
    return ephemeral('**Queue (' + q.entries.length + '):**\n' + lines);
  }

  if (action === 'next') {
    if (!isAdmin(data)) return ephemeral('Admin only.');
    if (q.entries.length === 0) return ephemeral('Queue is empty.');
    const next = q.entries.shift();
    await saveQueue(env, guildId, q);
    await refreshQueueMessage(env, guildId, q);

    // Public callout in the queue channel so the player knows it's their turn.
    try {
      await postChannelMessage(env, q.channel_id, {
        content: '⏭️ **Up next:** <@' + next.user_id + '>' +
                 (q.game ? ' · _' + q.game + '_' : ''),
        allowed_mentions: { parse: [], users: [next.user_id] }
      });
    } catch (e) { console.error('[queue:next] callout', e?.message || e); }

    // Best-effort DM the player so they don't miss the call (most users
    // won't see a channel mention if they're afk in another window).
    try {
      const dayLabel = q.day_of_week ? cap(q.day_of_week) + ' Community Night' : 'Community Night';
      await sendDm(env, next.user_id, {
        content: '🎮 **You\'re up!** ' + dayLabel + (q.game ? ' · **' + q.game + '**' : '') +
                 '\n\nGet to chat / VC — the streamer just pulled you from the queue.'
      });
    } catch (e) { /* DMs disabled on user side - silent */ }

    return ephemeral('⏭️ Pulled <@' + next.user_id + '> _(was priority ' + next.priority + ')_.');
  }

  return ephemeral('Unknown queue action.');
}

// Admin-only: reset the queue (called from hub button).
export async function resetQueue(env, guildId) {
  const q = await loadQueue(env, guildId);
  q.entries = [];
  await saveQueue(env, guildId, q);
  await refreshQueueMessage(env, guildId, q);
  return { ok: true };
}

// Admin: get a snapshot for hub "View Queue" ephemeral.
export async function snapshotQueue(env, guildId) {
  return loadQueue(env, guildId);
}
