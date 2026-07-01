// Dynamic live-status dashboard embed.
//
// 2026-05-29 sprint addition. Distinct from the existing "going live"
// announcement card in twitch-live.js, this is a per-minute refreshing
// dashboard embed in a separate channel (1507973917350957067 by
// default) that the community can glance at to see viewer count, hype
// train state, etc.
//
// Lifecycle:
//   stream.online   -> handleStreamOnline   posts the embed, KV-tracks it
//   per-minute cron -> refreshLiveEmbed     edits embed with fresh data
//   hype_train.*    -> handleHypeTrain*     update hype-train field
//   stream.offline  -> handleStreamOffline  deletes embed + clears KV
//
// KV layout:
//   live-status-embed:<guildId> -> {
//     messageId, channelId, broadcasterId, startedAtIso,
//     hypeTrain?: { level, percent, expiresUtc }, updatedUtc
//   }

import { getStreamInfo, getUserById, getRecentVod } from './twitch-helix.js';
import { resolveTwitchLogin } from './twitch-login-resolver.js';
import { getChannelBinding } from './channel-bindings.js';

const DEFAULT_CHANNEL_ID = '1507973917350957067';
const KEY = (g) => `live-status-embed:${g}`;
// Role pinged once on go-live + channel the VOD drops in. Both fall back
// to the live ids if the env vars aren't set (e.g. pre-redeploy).
const STREAM_PING_ROLE_ID = (env) => String(env.STREAM_PING_ROLE_ID || '1507973871872114709').trim();
const VOD_CHANNEL_ID      = (env) => String(env.VOD_CHANNEL_ID      || '1507973921851576462').trim();
// VOD-drop lifecycle. On stream.offline we arm a pending record and the
// per-minute cron retries getRecentVod until the recording is ready
// (Twitch often isn't done processing the instant the stream ends) or
// the retry window lapses.
const VOD_PENDING_KEY = (g)  => `twitch:vod-pending:${g}`;
const VOD_POSTED_KEY  = (id) => `twitch:vod-posted:${id}`;
const VOD_RETRY_WINDOW_MS = 20 * 60 * 1000;   // give up posting after 20m
// Embed cache TTL, Discord caches embed images by URL; cache-bust
// query bumps every minute so the thumbnail re-fetches.

async function activeGuildId(env) {
  return String(env.AQUILO_VAULT_GUILD_ID || '').trim() || null;
}

async function targetChannelId(env, guildId) {
  // Channel binding takes precedence (so Clay can rebind via admin
  // panel later). Falls back to hardcoded default if unset.
  try {
    const bound = await getChannelBinding(env, guildId, 'live-status-embed');
    if (bound) return bound;
  } catch { /* swallow */ }
  return DEFAULT_CHANNEL_ID;
}

function liveThumbUrl(login, ts) {
  // Bust per-minute so Discord re-fetches; same login slug as the
  // Twitch URL.
  return `https://static-cdn.jtvnw.net/previews-ttv/live_user_${login}-1920x1080.jpg?t=${ts}`;
}

function buildEmbed({ stream, login, hypeTrain }) {
  const startedTsSec = Math.floor(Date.parse(stream.started_at || '') / 1000) || null;
  const cacheBust = Math.floor(Date.now() / 60000);   // changes every minute

  const fields = [
    { name: '👀 Viewers',  value: String(stream.viewer_count ?? 0), inline: true },
  ];
  if (startedTsSec) {
    fields.push({ name: '⏱ Started', value: `<t:${startedTsSec}:R>`, inline: true });
  }
  if (hypeTrain && hypeTrain.level) {
    const pct = Math.max(0, Math.min(100, Math.round(hypeTrain.percent || 0)));
    fields.push({
      name: '🚂 Hype Train',
      value: `Level ${hypeTrain.level} · ${pct}%`,
      inline: true,
    });
  }
  if (stream.game_name) {
    fields.push({ name: '🎯 Game', value: stream.game_name, inline: true });
  }
  const embed = {
    title: `🔴 Aquilo is LIVE, ${stream.title || 'Streaming now'}`.slice(0, 256),
    description: stream.game_name ? `Playing **${stream.game_name}**` : 'Stream is live',
    color: 0xFF4757,
    image: { url: liveThumbUrl(login, cacheBust) },
    fields,
    footer: { text: `twitch.tv/${login} · Updates every minute` },
  };
  const row = [
    { type: 2, style: 5, label: 'Watch on Twitch',
      url: `https://twitch.tv/${login}`, emoji: { name: '📺' } },
  ];
  const components = [{ type: 1, components: row }];
  return { embeds: [embed], components };
}

// VOD-drop embed posted to the videos channel after a stream ends.
function buildVodEmbed(vod, login) {
  const thumb = (vod.thumbnail_url || '')
    .replace('%{width}', '1280').replace('%{height}', '720')
    .replace('{width}',  '1280').replace('{height}', '720');
  const createdSec = vod.created_at ? Math.floor(Date.parse(vod.created_at) / 1000) : null;
  // Twitch duration is e.g. "3h21m4s", space it out for readability.
  const dur = (vod.duration || '').replace(/([a-z])(?=\d)/gi, '$1 ');
  const fields = [];
  if (dur)        fields.push({ name: '⏱ Duration', value: dur, inline: true });
  if (createdSec) fields.push({ name: '📅 Streamed', value: `<t:${createdSec}:D>`, inline: true });
  const embed = {
    title: (vod.title || 'Past Broadcast').slice(0, 256),
    url: vod.url || (login ? `https://twitch.tv/${login}/videos` : undefined),
    description: '📼 The VOD from the last stream is up, catch anything you missed.',
    color: 0x9146FF,
    image: thumb ? { url: thumb } : undefined,
    fields: fields.length ? fields : undefined,
    footer: { text: login ? `twitch.tv/${login}` : 'Twitch' },
    timestamp: vod.created_at || undefined,
  };
  const components = vod.url
    ? [{ type: 1, components: [
        { type: 2, style: 5, label: 'Watch VOD', url: vod.url, emoji: { name: '📺' } },
      ] }]
    : undefined;
  return { embeds: [embed], ...(components ? { components } : {}) };
}

async function discordPost(env, channelId, payload) {
  const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    return { ok: false, status: r.status, detail: txt.slice(0, 200) };
  }
  return { ok: true, msg: await r.json() };
}

async function discordPatch(env, channelId, messageId, payload) {
  const r = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
    { method: 'PATCH',
      headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify(payload) },
  );
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    return { ok: false, status: r.status, detail: txt.slice(0, 200) };
  }
  return { ok: true };
}

async function discordDelete(env, channelId, messageId) {
  const r = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
    { method: 'DELETE', headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN } },
  );
  return { ok: r.ok || r.status === 404, status: r.status };
}

// ── Lifecycle handlers ──────────────────────────────────────────

// Resolve the broadcaster login slug (twitch.tv/<login>) from the
// broadcaster user_id. Dynamic + KV-cached so a username rename needs
// no code/env change; resolveTwitchLogin falls back to env on failure.
async function loginFor(env, broadcasterId) {
  const user = await getUserById(env, broadcasterId).catch(() => null);
  return user?.login || await resolveTwitchLogin(env, broadcasterId);
}

export async function handleStreamOnline(env, broadcasterId) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  const guildId = await activeGuildId(env);
  if (!guildId) return { ok: false, error: 'no-guild' };
  const channelId = await targetChannelId(env, guildId);
  if (!channelId) return { ok: false, error: 'no-channel' };

  const stream = await getStreamInfo(env, broadcasterId);
  if (!stream) return { ok: false, error: 'stream-offline' };
  const login = await loginFor(env, broadcasterId);
  const payload = buildEmbed({ stream, login });
  // Owner go-live pings @everyone (per Clay 2026-07-01, replacing the old
  // Stream Pings role). Only the owner's stream reaches this handler —
  // EventSub subs exist for Clay's channel only; community streamers
  // announce via sf-community.js, which never pings. The mention lives
  // ONLY on this first POST; refresh PATCHes reuse `payload` (no content
  // field) so Discord never re-notifies.
  const postPayload = { ...payload, content: '@everyone', allowed_mentions: { parse: ['everyone'] } };

  // Idempotent: if KV already tracks a message, PATCH instead of POST.
  const existing = await env.LOADOUT_BOLTS.get(KEY(guildId), { type: 'json' });
  if (existing?.messageId && existing.channelId === channelId) {
    const r = await discordPatch(env, channelId, existing.messageId, payload);
    if (r.ok) {
      await env.LOADOUT_BOLTS.put(KEY(guildId), JSON.stringify({
        ...existing, broadcasterId, startedAtIso: stream.started_at,
        updatedUtc: new Date().toISOString(),
      }));
      return { ok: true, action: 'patched', messageId: existing.messageId };
    }
    // Patch failed (likely 404, message deleted). Fall through to POST.
    await env.LOADOUT_BOLTS.delete(KEY(guildId));
  }

  const r = await discordPost(env, channelId, postPayload);
  if (!r.ok) return { ok: false, error: 'post-failed', ...r };
  const rec = {
    messageId:    r.msg.id,
    channelId,
    broadcasterId,
    startedAtIso: stream.started_at,
    updatedUtc:   new Date().toISOString(),
  };
  await env.LOADOUT_BOLTS.put(KEY(guildId), JSON.stringify(rec));
  return { ok: true, action: 'created', messageId: r.msg.id };
}

// Per-minute cron tick. No-op if no tracked embed. If Helix says
// stream is offline, treats that as a missed offline event and runs
// the cleanup path.
export async function refreshLiveStatusEmbed(env) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: true, skipped: 'no-bot-token' };
  const guildId = await activeGuildId(env);
  if (!guildId) return { ok: true, skipped: 'no-guild' };
  // VOD drop runs every tick, independent of the dashboard embed: once
  // the stream ends the dashboard KV is gone, but a pending-VOD record
  // may still be waiting for Twitch to finish the recording. Cheap (one
  // KV read) and no-ops fast when nothing is pending.
  const vod = await tryPostPendingVod(env).catch(e => ({ ok: false, error: String(e?.message || e) }));
  const rec = await env.LOADOUT_BOLTS.get(KEY(guildId), { type: 'json' });
  if (!rec?.messageId) return { ok: true, skipped: 'no-tracked-embed', vod };

  const stream = await getStreamInfo(env, rec.broadcasterId);
  if (!stream) {
    // Stream went offline, Helix returned nothing. Clean up.
    return handleStreamOffline(env, rec.broadcasterId);
  }
  const login = await loginFor(env, rec.broadcasterId);
  // Decay hype train when expired (per-minute check).
  let hypeTrain = rec.hypeTrain;
  if (hypeTrain?.expiresUtc && Date.parse(hypeTrain.expiresUtc) < Date.now()) {
    hypeTrain = null;
  }
  const payload = buildEmbed({ stream, login, hypeTrain });
  const r = await discordPatch(env, rec.channelId, rec.messageId, payload);
  if (!r.ok) {
    if (r.status === 404) {
      // Message gone, clear KV so a future stream.online posts fresh.
      await env.LOADOUT_BOLTS.delete(KEY(guildId));
      return { ok: true, action: 'cleared-stale' };
    }
    return { ok: false, error: 'patch-failed', ...r };
  }
  const next = { ...rec, updatedUtc: new Date().toISOString() };
  if (hypeTrain !== rec.hypeTrain) next.hypeTrain = hypeTrain || undefined;
  await env.LOADOUT_BOLTS.put(KEY(guildId), JSON.stringify(next));
  return { ok: true, action: 'refreshed', viewerCount: stream.viewer_count };
}

export async function handleHypeTrainBegin(env, payload) {
  return _hypeUpdate(env, payload, { level: 1, percent: 0 });
}

export async function handleHypeTrainProgress(env, payload) {
  const ev = payload?.event || {};
  // Twitch carries total + goal, derive percent. Falls back to 0.
  const total = Number(ev.total || ev.progress || 0);
  const goal  = Number(ev.goal || 1) || 1;
  const level = Number(ev.level || 1);
  const percent = Math.max(0, Math.min(100, Math.round(total / goal * 100)));
  return _hypeUpdate(env, payload, { level, percent });
}

export async function handleHypeTrainEnd(env, payload) {
  return _hypeUpdate(env, payload, null);
}

async function _hypeUpdate(env, payload, hypeTrain) {
  const guildId = await activeGuildId(env);
  if (!guildId) return { ok: true, skipped: 'no-guild' };
  const rec = await env.LOADOUT_BOLTS.get(KEY(guildId), { type: 'json' });
  if (!rec?.messageId) return { ok: true, skipped: 'no-tracked-embed' };
  // Stamp a 30-min expiry on the hype train so progress events stop
  // being stale if `end` is missed, refresh cron clears expired state.
  const next = { ...rec };
  if (hypeTrain) {
    next.hypeTrain = { ...hypeTrain, expiresUtc: new Date(Date.now() + 30 * 60_000).toISOString() };
  } else {
    delete next.hypeTrain;
  }
  await env.LOADOUT_BOLTS.put(KEY(guildId), JSON.stringify(next));
  // Trigger an immediate refresh so the embed reflects the change
  // without waiting for the per-minute cron.
  return refreshLiveStatusEmbed(env);
}

export async function handleStreamOffline(env, broadcasterId) {
  const guildId = await activeGuildId(env);
  if (!guildId) return { ok: true, skipped: 'no-guild' };
  const rec = await env.LOADOUT_BOLTS.get(KEY(guildId), { type: 'json' });

  // Arm the VOD-drop BEFORE deleting the dashboard so the per-minute cron
  // can post the VOD once Twitch finishes processing it (the recording
  // usually isn't ready the instant stream.offline fires). The pending
  // record carries the stream start so we can tell this stream's VOD
  // apart from an older one. Self-expiring KV TTL is a backstop in case
  // the cron path is ever disabled.
  if (VOD_CHANNEL_ID(env)) {
    await env.LOADOUT_BOLTS.put(VOD_PENDING_KEY(guildId), JSON.stringify({
      broadcasterId,
      startedAtIso: rec?.startedAtIso || null,
      deadlineUtc:  Date.now() + VOD_RETRY_WINDOW_MS,
    }), { expirationTtl: Math.ceil(VOD_RETRY_WINDOW_MS / 1000) + 120 });
  }

  // Delete the live dashboard post (the "going live" message goes away
  // when the stream ends).
  let deleted = false;
  if (rec?.messageId) {
    await discordDelete(env, rec.channelId, rec.messageId);
    await env.LOADOUT_BOLTS.delete(KEY(guildId));
    deleted = true;
  }

  // Best-effort immediate VOD attempt, the archive is often already
  // available; if not, the per-minute cron keeps retrying.
  const vod = await tryPostPendingVod(env).catch(() => null);
  return { ok: true, action: deleted ? 'deleted' : 'no-embed',
    messageId: rec?.messageId || null, vod };
}

// Post the pending stream's VOD to the videos channel, with retry. Reads
// the pending record armed by handleStreamOffline; no-ops when nothing is
// pending. Returns a status the cron logs. Self-clears on success, on a
// confirmed duplicate, or once the retry window lapses.
export async function tryPostPendingVod(env) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: true, skipped: 'no-bot-token' };
  const guildId = await activeGuildId(env);
  if (!guildId) return { ok: true, skipped: 'no-guild' };
  const pend = await env.LOADOUT_BOLTS.get(VOD_PENDING_KEY(guildId), { type: 'json' });
  if (!pend) return { ok: true, skipped: 'no-pending' };

  // Retry window lapsed (VOD storage off, or processing never finished).
  if (pend.deadlineUtc && Date.now() > pend.deadlineUtc) {
    await env.LOADOUT_BOLTS.delete(VOD_PENDING_KEY(guildId));
    return { ok: true, action: 'gave-up', reason: 'deadline' };
  }
  const vodChannelId = VOD_CHANNEL_ID(env);
  if (!vodChannelId) {
    await env.LOADOUT_BOLTS.delete(VOD_PENDING_KEY(guildId));
    return { ok: true, skipped: 'no-vod-channel' };
  }

  const vod = await getRecentVod(env, pend.broadcasterId).catch(() => null);
  if (!vod) return { ok: true, action: 'waiting', reason: 'no-vod-yet' };

  // Make sure this is the just-ended stream's VOD, not a leftover from a
  // previous broadcast: its created_at should be at/after the stream
  // start (with a 10-min grace). If it's older, keep waiting for the
  // right one to finish processing.
  if (pend.startedAtIso) {
    const floor = Date.parse(pend.startedAtIso) - 10 * 60_000;
    if (Number.isFinite(floor) && Date.parse(vod.created_at || '') < floor) {
      return { ok: true, action: 'waiting', reason: 'vod-older-than-stream' };
    }
  }

  // Dedupe so a retry (or a missed-offline re-fire) can't double-post.
  const dedupeKey = VOD_POSTED_KEY(vod.id);
  if (await env.LOADOUT_BOLTS.get(dedupeKey)) {
    await env.LOADOUT_BOLTS.delete(VOD_PENDING_KEY(guildId));
    return { ok: true, action: 'already-posted', vodId: vod.id };
  }

  const login = await loginFor(env, pend.broadcasterId);
  const r = await discordPost(env, vodChannelId, buildVodEmbed(vod, login));
  if (!r.ok) return { ok: false, error: 'vod-post-failed', ...r };
  await env.LOADOUT_BOLTS.put(dedupeKey, '1', { expirationTtl: 7 * 24 * 60 * 60 });
  await env.LOADOUT_BOLTS.delete(VOD_PENDING_KEY(guildId));
  return { ok: true, action: 'posted', vodId: vod.id, messageId: r.msg.id };
}
