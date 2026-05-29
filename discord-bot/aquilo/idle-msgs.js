// Idle CTA messages that live in the poll + queue channels when those
// features aren't actively running. They swap out for the live content
// (poll embed / queue post) and swap back in when the cycle ends.
//
// Lifecycle:
//   - Voting idle (in POLL_CHANNEL_ID): persistent. Deleted when a poll
//     posts (6 PM ET), re-posted with updated "played this week" list
//     when the poll closes (9 PM ET).
//   - Queue idle  (in QUEUE_CHANNEL_ID): persistent CTA pointing patrons
//     + boosters at the queue. Deleted when a queue posts (9 PM ET on
//     CN days), re-posted at 12:30 AM ET the next day after the queue
//     post is itself deleted.
//
// Both idle msgs' message_ids live in KV so we can delete-then-repost
// without having to scroll history.

import {
  postChannelMessage, discordFetch, weekStartET,
  COLOR_QUEUE, COLOR_POLL, cap, steamStoreUrl
} from './util.js';
import { getChannelBinding } from '../channel-bindings.js';

// Resolve the queue / poll channels via the per-guild binding (KV)
// with QUEUE_CHANNEL_ID / POLL_CHANNEL_ID env fallback. aquilo is
// single-tenant via AQUILO_VAULT_GUILD_ID, so we read the binding
// for that guild.
async function resolveQueueChannel(env) {
  return getChannelBinding(env, env.AQUILO_VAULT_GUILD_ID, 'queue');
}
async function resolvePollChannel(env) {
  return getChannelBinding(env, env.AQUILO_VAULT_GUILD_ID, 'poll');
}
import { ensureBootstrap } from './bootstrap.js';

// `idle:voting` (legacy): single message id from the v1 layout. We still
// look it up + delete during refresh so old idles don't pile up after the
// migration to multi-message.
// `idle:voting:msgs`: JSON array of message ids — header + N cards chunks.
const KV_VOTING_IDLE_LEGACY = 'idle:voting';
const KV_VOTING_IDLE_MSGS   = 'idle:voting:msgs';
const KV_QUEUE_IDLE         = 'idle:queue';

async function deleteMessageSafely(env, channelId, messageId) {
  if (!channelId || !messageId) return;
  try {
    await discordFetch(env,
      '/channels/' + encodeURIComponent(channelId) +
      '/messages/' + encodeURIComponent(messageId),
      { method: 'DELETE' });
  } catch { /* already deleted, perms changed, or 404 — fine */ }
}

// ---- Voting idle -------------------------------------------------------

// Build the voting idle payloads. Discord caps a single message at 10
// embeds, so we split across multiple messages:
//   msg 0 (header): intro + full text list of games + "played this week"
//   msg 1+        : game cards (one embed per game, thumbnail = cover art)
//                   chunked at 10 cards per message
// All games get a card regardless of pool size.
async function buildVotingIdlePayloads(env, guildId) {
  const { results: active } = await env.DB.prepare(
    'SELECT name, art_url FROM games WHERE guild_id = ? AND active = 1 ORDER BY name'
  ).bind(guildId).all();

  const weekStart = weekStartET();
  const { results: played } = await env.DB.prepare(
    `SELECT g.name, p.day_of_week FROM polls p
     JOIN games g ON g.id = p.winner_game_id
     WHERE p.guild_id = ? AND p.posted_at >= ? AND p.closed_at IS NOT NULL
     ORDER BY p.posted_at ASC`
  ).bind(guildId, weekStart).all();

  const inRotation = (active || []).length
    ? active.map(g => '• ' + g.name).join('\n')
    : '_no active games — use ➕ Add Game on the hub_';
  const playedList = (played || []).length
    ? played.map(p => '• **' + p.name + '** (' + cap(p.day_of_week) + ')').join('\n')
    : '_none yet — vote at 6 PM ET on stream day_';

  const headerEmbed = {
    title: '📊 Community Night · Game Pool',
    description: 'Voting opens at **6 PM ET** on **Wed / Fri / Sat** in this channel and closes at **9 PM ET**.\n\nA game that won earlier this week is excluded until the next week.',
    color: COLOR_POLL,
    fields: [
      { name: '🎮 In rotation (' + (active?.length || 0) + ')', value: inRotation.slice(0, 1024), inline: false },
      { name: '✅ Played this week',                              value: playedList.slice(0, 1024), inline: false }
    ],
    footer: { text: 'Want a game added? /suggest <game>' },
    timestamp: new Date().toISOString()
  };

  // Use `image` (full-width, ~460px wide) instead of `thumbnail` (small
  // corner crop) so each card shows the cover art prominently. The `url`
  // field makes the title a clickable Steam-store link when we can pull
  // an app id from the art URL.
  const cards = (active || []).map(g => {
    const e = { title: g.name, color: COLOR_POLL };
    if (g.art_url) e.image = { url: g.art_url };
    const store = steamStoreUrl(g.art_url);
    if (store) e.url = store;
    return e;
  });

  // Chunk cards into messages of <= 10 embeds each.
  const cardMessages = [];
  for (let i = 0; i < cards.length; i += 10) {
    cardMessages.push({ embeds: cards.slice(i, i + 10) });
  }

  return {
    header: { embeds: [headerEmbed] },
    cardMessages
  };
}

// Wipe whatever the bot last posted as the voting idle: legacy single-id
// (pre-multi-msg layout) AND the new multi-id list. Safe to call any time.
async function deleteAllVotingIdleMsgs(env) {
  const pollChannelId = await resolvePollChannel(env);
  if (!pollChannelId) return;
  // Legacy single-id from the v1 layout. Delete + drop the key.
  const legacyId = await env.STATE.get(KV_VOTING_IDLE_LEGACY);
  if (legacyId) {
    await deleteMessageSafely(env, pollChannelId, legacyId);
    await env.STATE.delete(KV_VOTING_IDLE_LEGACY);
  }
  // Current multi-message list.
  const raw = await env.STATE.get(KV_VOTING_IDLE_MSGS);
  if (raw) {
    let ids = [];
    try { ids = JSON.parse(raw); } catch {}
    for (const id of ids) {
      await deleteMessageSafely(env, pollChannelId, id);
    }
    await env.STATE.delete(KV_VOTING_IDLE_MSGS);
  }
}

export async function refreshVotingIdle(env) {
  const pollChannelId = await resolvePollChannel(env);
  if (!pollChannelId) return { skipped: 'no_channel' };
  const guildId = await ensureBootstrap(env);
  await deleteAllVotingIdleMsgs(env);

  const { header, cardMessages } = await buildVotingIdlePayloads(env, guildId);
  const ids = [];
  const headerMsg = await postChannelMessage(env, pollChannelId, header);
  ids.push(headerMsg.id);
  for (const chunk of cardMessages) {
    const msg = await postChannelMessage(env, pollChannelId, chunk);
    ids.push(msg.id);
  }
  await env.STATE.put(KV_VOTING_IDLE_MSGS, JSON.stringify(ids));
  return { messageIds: ids, channelId: pollChannelId };
}

export async function deleteVotingIdle(env) {
  await deleteAllVotingIdleMsgs(env);
}

// ---- Queue idle --------------------------------------------------------

function buildQueueIdlePayload(env) {
  const url = env.PATREON_URL || 'https://www.patreon.com/cw/aquilo/membership';
  const embed = {
    title: '🎮 Community Night Queue',
    description:
      'The queue is **closed** right now.\n\n' +
      'It opens automatically at **9 PM ET** on **Wed / Fri / Sat** for these roles:\n' +
      '🥇 **Patrons** (priority by tier)\n' +
      '⭐ **Server Boosters**\n\n' +
      'Become a patron or boost the server to play with us on community nights — see you in the queue!',
    color: COLOR_QUEUE
  };
  const components = [{
    type: 1,
    components: [
      { type: 2, style: 5, label: 'Become a Patron', url, emoji: { name: '💛' } }
    ]
  }];
  return { embeds: [embed], components };
}

export async function refreshQueueIdle(env) {
  const channelId = await resolveQueueChannel(env);
  if (!channelId) return { skipped: 'no_channel' };
  const oldId = await env.STATE.get(KV_QUEUE_IDLE);
  if (oldId) await deleteMessageSafely(env, channelId, oldId);
  const payload = buildQueueIdlePayload(env);
  const msg = await postChannelMessage(env, channelId, payload);
  await env.STATE.put(KV_QUEUE_IDLE, msg.id);
  return { messageId: msg.id, channelId };
}

export async function deleteQueueIdle(env) {
  const channelId = await resolveQueueChannel(env);
  if (!channelId) return;
  const oldId = await env.STATE.get(KV_QUEUE_IDLE);
  if (!oldId) return;
  await deleteMessageSafely(env, channelId, oldId);
  await env.STATE.delete(KV_QUEUE_IDLE);
}
