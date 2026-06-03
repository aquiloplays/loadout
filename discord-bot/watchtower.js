// Streamer Watchtower — live-stats JSON for an OBS Browser Source.
//
// 2026-05-31 sprint. A public, unauthenticated, CORS-open endpoint the
// streamer drops into OBS as a Browser Source (or the site renders as a
// widget). GET /watchtower/stream/:channel returns the current live
// snapshot — viewer count, game, title, uptime, hype-train state.
//
// Distinct from stream-bonus.js's Watchtower (a virtual Clash building
// that lights up while live). This one is the *broadcast stats panel*.
//
// Cached for 5s in KV (watchtower:cache:<key>) so a busy OBS source
// polling every second can't hammer the Helix rate limit — at most one
// upstream fetch per channel per 5s window regardless of viewer count.

import { getStreamInfo, helixFetch, isTwitchConfigured } from './twitch-helix.js';

const CACHE_KEY = (k) => `watchtower:cache:${k}`;
const CACHE_TTL_MS = 5000;

// Resolve a channel param (login string, numeric id, or 'me') to a
// broadcaster { id, login, displayName }.
async function resolveBroadcaster(env, channel) {
  const raw = String(channel || '').trim().toLowerCase();
  if (!raw || raw === 'me') {
    const id = String(env.CLAY_TWITCH_CHANNEL_ID || '').trim();
    if (!id) return null;
    return { id, login: env.CLAY_TWITCH_LOGIN || 'prodigalttv', displayName: null };
  }
  if (/^\d+$/.test(raw)) {
    const j = await helixFetch(env, '/users', { id: raw }).catch(() => null);
    const u = j?.data?.[0];
    return { id: raw, login: u?.login || null, displayName: u?.display_name || null };
  }
  // Treat as a login.
  const j = await helixFetch(env, '/users', { login: raw }).catch(() => null);
  const u = j?.data?.[0];
  if (!u) return null;
  return { id: u.id, login: u.login, displayName: u.display_name };
}

function thumbUrl(login) {
  if (!login) return null;
  const bust = Math.floor(Date.now() / CACHE_TTL_MS);
  return `https://static-cdn.jtvnw.net/previews-ttv/live_user_${login}-1920x1080.jpg?t=${bust}`;
}

// Hype-train state is tracked by live-status-embed.js on the active
// guild's rec — surface it here too so the OBS panel can show it.
async function hypeTrainState(env) {
  const guildId = String(env.AQUILO_VAULT_GUILD_ID || '').trim();
  if (!guildId) return null;
  const rec = await env.LOADOUT_BOLTS.get(`live-status-embed:${guildId}`, { type: 'json' })
    .catch(() => null);
  const ht = rec?.hypeTrain;
  if (!ht) return null;
  if (ht.expiresUtc && Date.parse(ht.expiresUtc) < Date.now()) return null;
  return { level: ht.level, percent: ht.percent };
}

// Build the live snapshot (uncached). Returns the panel payload.
async function buildSnapshot(env, channel) {
  if (!isTwitchConfigured(env)) {
    return { ok: false, error: 'twitch-not-configured' };
  }
  const b = await resolveBroadcaster(env, channel);
  if (!b) return { ok: false, error: 'channel-not-found' };

  const stream = await getStreamInfo(env, b.id).catch(() => null);
  const now = Date.now();
  if (!stream) {
    return {
      ok: true, live: false,
      channel: b.login, displayName: b.displayName,
      fetchedAt: now,
    };
  }
  const startedAt = stream.started_at || null;
  const startMs = startedAt ? Date.parse(startedAt) : 0;
  const uptimeSec = startMs ? Math.max(0, Math.floor((now - startMs) / 1000)) : null;
  return {
    ok: true,
    live: true,
    channel: b.login || stream.user_login,
    displayName: b.displayName || stream.user_name,
    viewerCount: stream.viewer_count ?? 0,
    gameName: stream.game_name || null,
    title: stream.title || null,
    startedAt,
    uptimeSec,
    hypeTrain: await hypeTrainState(env),
    thumbnailUrl: thumbUrl(b.login || stream.user_login),
    fetchedAt: now,
  };
}

// Public: cached snapshot. Reuses a KV-cached payload when it's younger
// than CACHE_TTL_MS; otherwise refreshes + restamps. Cache failures are
// non-fatal (falls through to a live fetch).
export async function getWatchtowerStats(env, channel) {
  const key = CACHE_KEY(String(channel || 'me').toLowerCase());
  try {
    const cached = await env.LOADOUT_BOLTS.get(key, { type: 'json' });
    if (cached && cached.ts && (Date.now() - cached.ts) < CACHE_TTL_MS) {
      return { ...cached.data, cached: true };
    }
  } catch { /* fall through */ }

  const data = await buildSnapshot(env, channel);
  // Only cache successful snapshots; transient Helix failures shouldn't
  // be pinned for 5s.
  if (data.ok) {
    try {
      await env.LOADOUT_BOLTS.put(key, JSON.stringify({ ts: Date.now(), data }),
        { expirationTtl: 60 });
    } catch { /* best-effort cache */ }
  }
  return { ...data, cached: false };
}
