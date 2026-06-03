// Discord guild scheduled events mirrored from the stream schedule.
//
// 2026-06 schedule update (Chunk 6). For each stream in the next
// horizon (default 7 days) we ensure a Discord *external* scheduled
// event exists, name = "<show>: <game>", location = the Twitch URL,
// thumbnail = the game's Steam header art. Discord then handles
// "Interested" subscriptions + its own pre-event reminders natively.
//
// On top of that, an optional 30-minute pre-stream ping posts a short
// embed to env.STREAM_PING_CHANNEL (opt-in, no ping is sent if that
// var is unset, so we never spam an unknown channel).
//
// KV:
//   stream-events:synced:<g>  { [dateKey]: { eventId, name, startsAt } }
//   stream-events:pinged:<g>   { [dateKey]: pingedUtc }
//
// Idempotent: a dateKey already in the synced map is skipped, so the
// daily cron can call this safely. Past keys are pruned.

import { readSchedule, upcomingStreams } from './schedule.js';
import { resolveTwitchLogin } from './twitch-login-resolver.js';

const SYNC_KEY = (g) => `stream-events:synced:${g}`;
const PING_KEY = (g) => `stream-events:pinged:${g}`;

// Dynamic, resolves the current login from the canonical broadcaster
// id (KV-cached 1h) so a username rename needs no code change.
async function twitchUrl(env) {
  return `https://twitch.tv/${await resolveTwitchLogin(env, env.CLAY_TWITCH_CHANNEL_ID)}`;
}

function gid(env, guildId) {
  return guildId || String(env.AQUILO_VAULT_GUILD_ID || '').trim();
}

// Resolve the game (name + art) showing on a given schedule day.
//   fixed     → the locked-in Triple-C campaign game
//   variety   → the stored variety-vote winner
//   community → the stored community-vote winner
async function gameForDay(env, guildId, kind) {
  try {
    if (kind === 'fixed') {
      const { getCurrentTripleC } = await import('./triple-c.js');
      const c = await getCurrentTripleC(env, guildId);
      return { name: c?.name || null, art: c?.artUrl || null };
    }
    const winnerKind = kind === 'variety' ? 'variety' : 'cn';
    const w = await env.LOADOUT_BOLTS.get(`vote-hub:winner:${guildId}:${winnerKind}`, { type: 'json' });
    return { name: w?.name || null, art: w?.art_url || null };
  } catch {
    return { name: null, art: null };
  }
}

// Fetch an image and return a Discord-ready data URI, or null. Capped
// well under Discord's limit to avoid oversized-payload rejections.
async function fetchImageDataUri(url) {
  if (!url) return null;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 7_000_000) return null;
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const ct = r.headers.get('content-type') || 'image/jpeg';
    return `data:${ct};base64,${btoa(bin)}`;
  } catch {
    return null;
  }
}

// Create / refresh Discord scheduled events for the upcoming schedule.
export async function syncStreamEvents(env, guildId, { horizonDays = 7 } = {}) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  const g = gid(env, guildId);
  if (!g) return { ok: false, error: 'no-guild' };

  const schedule = await readSchedule(env, g);
  const streams = upcomingStreams(schedule, horizonDays);
  const synced = (await env.LOADOUT_BOLTS.get(SYNC_KEY(g), { type: 'json' })) || {};
  const auth = { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'Content-Type': 'application/json' };
  const url = await twitchUrl(env);
  const out = { created: [], existing: [], failed: [] };

  for (const s of streams) {
    if (synced[s.dateKey]?.eventId) { out.existing.push(s.dateKey); continue; }

    const game = await gameForDay(env, g, s.kind);
    const name = (game.name ? `${s.label}: ${game.name}` : s.label).slice(0, 100);
    const startIso = new Date(s.startsAt).toISOString();
    const endIso = new Date(s.endsAt || (s.startsAt + 2 * 3600 * 1000)).toISOString();
    const body = {
      name,
      privacy_level: 2,            // GUILD_ONLY
      entity_type: 3,              // EXTERNAL
      scheduled_start_time: startIso,
      scheduled_end_time: endIso,
      entity_metadata: { location: url },
      description: `Live on ${url}`.slice(0, 1000),
    };
    const img = await fetchImageDataUri(game.art);
    if (img) body.image = img;

    const r = await fetch(`https://discord.com/api/v10/guilds/${g}/scheduled-events`, {
      method: 'POST', headers: auth, body: JSON.stringify(body),
    });
    if (r.ok) {
      const j = await r.json();
      synced[s.dateKey] = { eventId: j.id, name, startsAt: s.startsAt };
      out.created.push({ dateKey: s.dateKey, eventId: j.id, name });
    } else {
      out.failed.push({ dateKey: s.dateKey, status: r.status, body: (await r.text()).slice(0, 160) });
    }
  }

  // Prune events that started > 12h ago.
  const cutoff = Date.now() - 12 * 3600 * 1000;
  for (const k of Object.keys(synced)) {
    if ((synced[k].startsAt || 0) < cutoff) delete synced[k];
  }
  await env.LOADOUT_BOLTS.put(SYNC_KEY(g), JSON.stringify(synced));

  return { ok: true, total: streams.length, ...out };
}

// 30-minute pre-stream ping. Opt-in: only fires when STREAM_PING_CHANNEL
// is configured. Safe to call every minute, a per-event KV marker
// guarantees exactly one ping per stream.
export async function preStreamPings(env, guildId) {
  const channelId = String(env.STREAM_PING_CHANNEL || '').trim();
  if (!channelId || !env.DISCORD_BOT_TOKEN) return { ok: true, skipped: 'not-configured' };
  const g = gid(env, guildId);
  if (!g) return { ok: false, error: 'no-guild' };

  const synced = (await env.LOADOUT_BOLTS.get(SYNC_KEY(g), { type: 'json' })) || {};
  const pinged = (await env.LOADOUT_BOLTS.get(PING_KEY(g), { type: 'json' })) || {};
  const now = Date.now();
  const url = await twitchUrl(env);
  const sent = [];

  for (const [dateKey, ev] of Object.entries(synced)) {
    const mins = (ev.startsAt - now) / 60000;
    if (mins <= 30 && mins > 0 && !pinged[dateKey]) {
      const embed = {
        title: `🔴 Live in ~30 minutes, ${ev.name}`,
        description: `Stream starts <t:${Math.floor(ev.startsAt / 1000)}:R> on ${url}`,
        color: 0x9b6cff,
      };
      const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
      });
      if (r.ok) { pinged[dateKey] = now; sent.push(dateKey); }
    }
  }

  // Drop markers for events that have already started.
  for (const k of Object.keys(pinged)) {
    if (!synced[k] || (synced[k].startsAt || 0) < now) delete pinged[k];
  }
  await env.LOADOUT_BOLTS.put(PING_KEY(g), JSON.stringify(pinged));

  return { ok: true, sent };
}
