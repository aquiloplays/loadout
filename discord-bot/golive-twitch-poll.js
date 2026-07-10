// Auto-announce aquilo.gg-Twitch-linked streamers when they go live.
//
// Unlike sf-community.js (which relies on a StreamFusion heartbeat), this
// polls Twitch Helix directly for EVERY user who signed in with Twitch on
// aquilo.gg — so any linked streamer's go-live posts to the self-promo
// channel with no app required. Runs on the per-minute cron.
//
// Index (written by the aquilo.gg Twitch sign-in Pages fn on each login):
//   golive:tw:link:<twitchId> = <login>     one key per linked streamer
//
// Per-streamer state (dedupe by stream session):
//   golive:tw:live:<twitchId> = <streamId currently announced>
//   Posted once per stream session; cleared when the streamer goes offline
//   so their NEXT stream re-announces. Posts are NOT deleted (self-promo
//   record). Ping-free — the owner's own go-live is the only @everyone ping
//   (handled by live-status-embed.js), and the owner is excluded here.

import { helixFetch, isTwitchConfigured } from './twitch-helix.js';
import { liveEmbed, resolveGoLiveChannel } from './sf-community.js';

const LINK_PREFIX   = 'golive:tw:link:';
const STATE_KEY     = (id) => 'golive:tw:live:' + id;
// Current-live set published for aquilo.gg's /community/live radar (merged
// in by sf-community.js handlePublicCommunityLive). Keep the string in sync.
const TW_LIVEMAP_KEY = 'golive:tw:livemap';
const STATE_TTL_S = 24 * 60 * 60;   // self-heals if an offline transition is ever missed

export async function pollTwitchGoLive(env) {
  if (!isTwitchConfigured(env) || !env.DISCORD_BOT_TOKEN) return { skipped: 'not-configured' };
  const channel = await resolveGoLiveChannel(env);
  if (!channel || !channel.channelId) return { skipped: 'no-channel' };

  const clayId = String(env.CLAY_TWITCH_CHANNEL_ID || '').trim();
  const ids = (await listLinkedIds(env)).filter((id) => id && id !== clayId);
  if (!ids.length) return { skipped: 'no-linked' };

  // Batch Helix /streams (max 100 user_id per call). Absent from the
  // response = offline.
  const liveById = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const j = await helixFetch(env, '/streams', { user_id: chunk });
    for (const s of (j && Array.isArray(j.data) ? j.data : [])) {
      if (s && s.user_id) liveById.set(String(s.user_id), s);
    }
  }

  let posted = 0, cleared = 0;
  for (const id of ids) {
    const stream = liveById.get(String(id));
    const stored = await env.LOADOUT_BOLTS.get(STATE_KEY(id));
    if (stream) {
      if (stored === String(stream.id)) continue;     // already announced this session
      const ok = await postGoLive(env, channel.channelId, stream);
      if (ok) {
        await env.LOADOUT_BOLTS.put(STATE_KEY(id), String(stream.id), { expirationTtl: STATE_TTL_S });
        posted++;
      }
    } else if (stored) {
      await env.LOADOUT_BOLTS.delete(STATE_KEY(id));
      cleared++;
    }
  }

  // Publish the current live set for aquilo.gg's /community/live radar, so
  // the site shows live aquilo.gg-Twitch-linked streamers even without
  // StreamFusion (the homepage grid renders these when the owner is
  // offline). Single writer (this poller), rewritten each tick — no races.
  const liveMap = {};
  for (const id of ids) {
    const s = liveById.get(String(id));
    if (!s) continue;
    const login = s.user_login || '';
    liveMap[String(id)] = {
      name:         s.user_name || login,
      platform:     'twitch',
      channel:      login,
      url:          login ? 'https://twitch.tv/' + login : undefined,
      title:        s.title || '',
      game:         s.game_name || '',
      viewers:      Number.isFinite(+s.viewer_count) ? +s.viewer_count : null,
      thumbnailUrl: (s.thumbnail_url || '').replace('{width}', '440').replace('{height}', '248') || undefined,
      startedAt:    Date.parse(s.started_at || '') || Date.now(),
      lastSeen:     Date.now(),
      live:         true,
    };
  }
  // Write only on change (per-minute cron): overnight the map is a
  // stable '{}', and skipping identical writes keeps this poller off
  // the KV write budget. When someone IS live, lastSeen moves every
  // tick so the write happens anyway — that's the useful case.
  const nextRaw = JSON.stringify(liveMap);
  const prevRaw = await env.LOADOUT_BOLTS.get(TW_LIVEMAP_KEY).catch(() => null);
  if (prevRaw !== nextRaw) await env.LOADOUT_BOLTS.put(TW_LIVEMAP_KEY, nextRaw).catch(() => {});

  return { ok: true, linked: ids.length, live: liveById.size, posted, cleared };
}

async function listLinkedIds(env) {
  const out = [];
  let cursor;
  for (let i = 0; i < 10; i++) {          // up to ~10k linked streamers
    const res = await env.LOADOUT_BOLTS.list({ prefix: LINK_PREFIX, cursor });
    for (const k of (res.keys || [])) {
      const id = k.name.slice(LINK_PREFIX.length);
      if (id) out.push(id);
    }
    if (res.list_complete) break;
    cursor = res.cursor;
  }
  return out;
}

async function postGoLive(env, channelId, stream) {
  const login = stream.user_login || '';
  const entry = {
    name:     stream.user_name || login,
    platform: 'twitch',
    title:    stream.title || '',
    game:     stream.game_name || '',
    viewers:  Number.isFinite(+stream.viewer_count) ? +stream.viewer_count : null,
    url:      login ? 'https://twitch.tv/' + login : undefined,
  };
  try {
    const r = await fetch('https://discord.com/api/v10/channels/' + channelId + '/messages', {
      method: 'POST',
      headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json' },
      // Embed only, NO ping — only the owner's own go-live pings @everyone.
      body: JSON.stringify({ embeds: [liveEmbed(entry)], allowed_mentions: { parse: [] } }),
    });
    return r.ok;
  } catch (e) {
    console.warn('[golive-poll] post failed', e?.message || e);
    return false;
  }
}
