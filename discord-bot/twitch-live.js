// Live-announce embed lifecycle. Three entry points:
//   • postLiveEmbed(env, broadcasterId)
//       Called from EventSub stream.online. Fetches the current
//       stream + posts a fresh embed to LIVE_CHANNEL_ID, persists
//       { messageId, channelId, startedAt, streamId } at
//       twitch:live:state:<broadcasterId>.
//   • refreshLiveEmbed(env, broadcasterId)
//       Called from the :17 hourly cron. If the live-state record
//       exists, fetches the current stream and PATCHes the embed.
//       If Helix says the stream is offline but our state says
//       live, treat as a missed stream.offline and finalise.
//   • markStreamOffline(env, broadcasterId)
//       Called from EventSub stream.offline. Edits the embed to
//       "stream ended" copy + clears the state.
//
// 2-minute cadence note: Cloudflare's free-tier cron cap is 4
// triggers, all currently in use. EventSub gives us instant
// on/off transitions; mid-stream refresh rides the :17 hourly
// cron. A Durable Object alarm would unlock the 2-min cadence;
// that's a follow-up if Clay wants the viewer count fresher than
// "once an hour" while live.
//
// KV: twitch:live:state:<broadcasterId> → { channelId, messageId,
//   startedAt, streamId, lastRefreshAt, broadcasterUserName,
//   broadcasterDisplayName, profileImageUrl, login }

import { getStreamInfo, getUserById, isTwitchConfigured } from './twitch-helix.js';
import { getChannelBinding } from './channel-bindings.js';

const STATE_KEY = (b) => `twitch:live:state:${b}`;
const TWITCH_PURPLE = 0x9146FF;

function liveEmbed({ stream, user, login }) {
  const title       = stream.title || '(no title)';
  const game        = stream.game_name || 'Unknown game';
  const viewerCount = Number(stream.viewer_count || 0);
  const thumb       = (stream.thumbnail_url || '')
    .replace('{width}',  '1280')
    .replace('{height}', '720');
  const url = login ? `https://twitch.tv/${login}` : null;
  return {
    title: '🔴 ' + (user?.display_name || login || 'Streamer') + ' is LIVE',
    url,
    description: '**' + title + '**\n\n🎮 _' + game + '_\n👥 ' + viewerCount.toLocaleString() + ' watching',
    color: TWITCH_PURPLE,
    image: thumb ? { url: thumb + '?cb=' + Date.now() } : undefined,
    thumbnail: user?.profile_image_url ? { url: user.profile_image_url } : undefined,
    timestamp: stream.started_at || new Date().toISOString(),
    footer: { text: url ? 'twitch.tv/' + login : 'Twitch' },
  };
}

function endedEmbed({ user, login, startedAt, lastTitle, lastGame, lastPeakViewers }) {
  const durationMs = startedAt ? (Date.now() - Date.parse(startedAt)) : 0;
  const hrs = Math.floor(durationMs / 3_600_000);
  const mins = Math.floor((durationMs % 3_600_000) / 60_000);
  const dur = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
  const lines = [];
  if (lastTitle) lines.push('**' + lastTitle + '**');
  if (lastGame)  lines.push('🎮 _' + lastGame + '_');
  if (lastPeakViewers) lines.push('👥 peak: ' + lastPeakViewers.toLocaleString());
  if (durationMs > 0)  lines.push('⏱ streamed for ' + dur);
  lines.push('');
  lines.push('Catch the next one at https://twitch.tv/' + (login || 'aquilogg'));
  return {
    title: '⚫ ' + (user?.display_name || login || 'Streamer') + ' is offline',
    description: lines.join('\n'),
    color: 0x444444,
    thumbnail: user?.profile_image_url ? { url: user.profile_image_url } : undefined,
    timestamp: new Date().toISOString(),
    footer: { text: 'See you next stream' },
  };
}

async function discordRest(env, method, path, body) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, status: 503, body: 'no-bot-token' };
  const r = await fetch('https://discord.com/api/v10' + path, {
    method,
    headers: {
      'Authorization': 'Bot ' + env.DISCORD_BOT_TOKEN,
      'Content-Type':  'application/json',
      'User-Agent':    'loadout-discord twitch-live',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* idle */ }
  return { ok: r.ok, status: r.status, body: parsed ?? text };
}

async function loadState(env, broadcasterId) {
  return env.LOADOUT_BOLTS.get(STATE_KEY(broadcasterId), { type: 'json' });
}
async function saveState(env, broadcasterId, state) {
  await env.LOADOUT_BOLTS.put(STATE_KEY(broadcasterId), JSON.stringify(state));
}
async function clearState(env, broadcasterId) {
  await env.LOADOUT_BOLTS.delete(STATE_KEY(broadcasterId)).catch(() => {});
}

// ── Public lifecycle ──────────────────────────────────────────────

export async function postLiveEmbed(env, broadcasterId) {
  if (!isTwitchConfigured(env)) return { skipped: 'twitch-not-configured' };
  const liveChannelId = await getChannelBinding(env, env.AQUILO_VAULT_GUILD_ID, 'live');
  if (!liveChannelId)     return { skipped: 'no-live-channel' };
  // Belt-and-braces: if the EventSub fired but Helix isn't showing
  // the stream yet (rare race), bail rather than posting an empty
  // embed. The next :17 cron tick will catch it if the stream is
  // genuinely live.
  const stream = await getStreamInfo(env, broadcasterId);
  if (!stream) return { skipped: 'helix-says-offline' };
  const user = await getUserById(env, broadcasterId);
  const login = (user && user.login) || (stream.user_login) || null;

  // If we already have a live state for THIS stream (same streamId)
  // — e.g. EventSub delivered the same event twice — edit instead of
  // double-posting. Different streamId = legit new stream, post fresh.
  const prior = await loadState(env, broadcasterId);
  if (prior && prior.streamId === stream.id) {
    const upd = await discordRest(env, 'PATCH',
      `/channels/${prior.channelId}/messages/${prior.messageId}`,
      { embeds: [liveEmbed({ stream, user, login })], content: stream.game_name ? '🎮 ' + stream.game_name : '' });
    if (upd.ok) {
      await saveState(env, broadcasterId, {
        ...prior, lastRefreshAt: Date.now(),
        lastTitle: stream.title, lastGame: stream.game_name,
        lastPeakViewers: Math.max(prior.lastPeakViewers || 0, Number(stream.viewer_count || 0)),
      });
      return { ok: true, action: 'edited-existing', messageId: prior.messageId, channelId: prior.channelId };
    }
    // Edit failed (message deleted?) — fall through and post fresh.
  }

  const post = await discordRest(env, 'POST',
    `/channels/${liveChannelId}/messages`,
    {
      content: '🔴 Live now: https://twitch.tv/' + (login || 'aquilogg'),
      embeds: [liveEmbed({ stream, user, login })],
      allowed_mentions: { parse: [] },
    });
  if (!post.ok) return { error: 'post-failed', status: post.status, body: post.body };
  await saveState(env, broadcasterId, {
    channelId: liveChannelId,
    messageId: post.body.id,
    streamId:  stream.id,
    startedAt: stream.started_at,
    lastRefreshAt: Date.now(),
    login,
    broadcasterDisplayName: user?.display_name || stream.user_name || null,
    profileImageUrl: user?.profile_image_url || null,
    lastTitle: stream.title,
    lastGame: stream.game_name,
    lastPeakViewers: Number(stream.viewer_count || 0),
  });
  return { ok: true, action: 'posted-new', messageId: post.body.id, channelId: liveChannelId };
}

export async function refreshLiveEmbed(env, broadcasterId) {
  if (!isTwitchConfigured(env)) return { skipped: 'twitch-not-configured' };
  const state = await loadState(env, broadcasterId);
  if (!state) return { skipped: 'no-live-state' };
  const stream = await getStreamInfo(env, broadcasterId);
  if (!stream) {
    // Stream gone offline while we weren't looking — treat as a
    // missed stream.offline event and finalise.
    return await markStreamOffline(env, broadcasterId);
  }
  if (state.streamId && stream.id !== state.streamId) {
    // The "live state" we have is for a previous stream that ended
    // and a new one started before we noticed. Finalise the old, post
    // fresh.
    await markStreamOffline(env, broadcasterId);
    return await postLiveEmbed(env, broadcasterId);
  }
  const user = await getUserById(env, broadcasterId);
  const login = state.login || (user && user.login) || stream.user_login || null;
  const upd = await discordRest(env, 'PATCH',
    `/channels/${state.channelId}/messages/${state.messageId}`,
    { embeds: [liveEmbed({ stream, user, login })] });
  if (!upd.ok) return { error: 'patch-failed', status: upd.status };
  await saveState(env, broadcasterId, {
    ...state,
    lastRefreshAt: Date.now(),
    lastTitle: stream.title,
    lastGame: stream.game_name,
    lastPeakViewers: Math.max(state.lastPeakViewers || 0, Number(stream.viewer_count || 0)),
  });
  return { ok: true, viewerCount: stream.viewer_count };
}

export async function markStreamOffline(env, broadcasterId) {
  const state = await loadState(env, broadcasterId);
  if (!state) return { skipped: 'no-live-state' };
  const user = state.profileImageUrl
    ? { display_name: state.broadcasterDisplayName, profile_image_url: state.profileImageUrl }
    : (await getUserById(env, broadcasterId).catch(() => null));
  const upd = await discordRest(env, 'PATCH',
    `/channels/${state.channelId}/messages/${state.messageId}`,
    {
      content: '',
      embeds: [endedEmbed({
        user, login: state.login,
        startedAt: state.startedAt,
        lastTitle: state.lastTitle,
        lastGame: state.lastGame,
        lastPeakViewers: state.lastPeakViewers,
      })],
    });
  // Clear state regardless of edit success — we don't want a stuck
  // live record if the message itself was deleted. A failed edit is
  // logged but doesn't block the state cleanup.
  if (!upd.ok) console.warn('[twitch-live] offline edit failed', upd.status);
  await clearState(env, broadcasterId);
  return { ok: true, edited: upd.ok };
}
