// /web/stats/* — owner streamer-dashboard analytics for aquilo.gg.
//
// Standalone HMAC-gated module claimed in worker.js BEFORE the generic
// /web/* dispatcher (same pattern as warden-router.js): the generic
// handleWeb in web.js requires discordId/guildId in the body, but these
// routes take an empty body ({}). Auth is the same site HMAC scheme
// (x-aquilo-web-ts / x-aquilo-web-sig over AQUILO_SITE_WEB_SECRET);
// owner gating (sess.o === 1) happens site-side in the Pages Functions
// (/api/dash/overview, /api/dash/youtube-videos) before they sign.
//
// Routes (both POST, body {}):
//   /web/stats/overview        → cross-platform overview + revenue estimates
//   /web/stats/youtube-videos  → newest 12 uploads with per-video stats
//
// Design rules:
//   • EVERY sub-fetch is independent: try/catch each one, null the field
//     and push a human-readable note on failure. The route never 500s
//     because one platform is down.
//   • Revenue figures are ESTIMATES derived from counts; the site labels
//     them as such. Missing sources explain WHY in revenue.notes.
//   • Whole payloads are KV-cached: overview 5 min, videos 30 min.
//
// Data sources:
//   Twitch  — Clay user token via twitch-helix.js getUserAccessToken
//             (scopes: channel:read:subscriptions, bits:read,
//             moderator:read:followers per twitch-oauth.js).
//   YouTube — Clay broadcaster token from the auth.aquilo.gg vault
//             (broker /youtube/vault/token, same flow as the platform
//             avatar endpoint in worker.js; local vault:yt:<id> record
//             via link:tw2youtube:<twitchId> as fallback, mirroring
//             goals-api.js ytVaultToken).
//   TikTok  — rolling-30d gift diamonds from the gifter-roles.js
//             precomputed snapshot (gifter-top:<guild>:tiktok), with a
//             live rolling30dLeaderboard walk as fallback.

import { verifyHmac } from './auth.js';
import {
  helixFetch,
  isTwitchConfigured,
  hasTwitchUserAuth,
  getStreamInfo,
} from './twitch-helix.js';

const BROKER = 'https://auth.aquilo.gg';

const OVERVIEW_CACHE_KEY = 'web-stats:overview';
const VIDEOS_CACHE_KEY   = 'web-stats:videos';
const OVERVIEW_TTL_S = 300;   // 5 min
const VIDEOS_TTL_S   = 1800;  // 30 min

const MAX_SUB_PAGES = 30;     // up to 3000 subs @ 100/page (mirrors twitch-community-stats.js)
const MAX_SC_PAGES  = 5;      // superChatEvents pages (50/page)

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export async function handleWebStats(req, env, path) {
  if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405);
  if (!env.AQUILO_SITE_WEB_SECRET) {
    return json({ ok: false, error: 'not-configured', message: 'AQUILO_SITE_WEB_SECRET missing on the bot' }, 503);
  }
  // Read the body once; verify HMAC against the raw bytes (same scheme
  // as web.js handleWeb: SHA-256 over ts + "\n" + body, hex).
  const bodyText = await req.text();
  const ts  = req.headers.get('x-aquilo-web-ts');
  const sig = req.headers.get('x-aquilo-web-sig');
  const ok = await verifyHmac(env.AQUILO_SITE_WEB_SECRET, ts || '', bodyText, sig || '');
  if (!ok) return json({ ok: false, error: 'unauthorized' }, 401);

  try {
    if (path === '/web/stats/overview')       return await routeOverview(env);
    if (path === '/web/stats/youtube-videos') return await routeYoutubeVideos(env);
  } catch (e) {
    return json({ ok: false, error: 'server', message: String((e && e.message) || e) }, 500);
  }
  return json({ ok: false, error: 'not-found' }, 404);
}

// ── Overview ────────────────────────────────────────────────────────

async function routeOverview(env) {
  // Cache shape: { at, payload }. Stored WITHOUT relying on TTL for
  // freshness so a degraded rebuild can fall back to the last GOOD
  // payload (same lesson as the /clips cache: a transient upstream
  // failure must never poison the cache or blank the dashboard).
  let cachedRec = null;
  try {
    const hit = await env.LOADOUT_BOLTS.get(OVERVIEW_CACHE_KEY, { type: 'json' });
    if (hit && hit.payload && hit.payload.ok) cachedRec = hit;
    else if (hit && hit.ok) cachedRec = { at: 0, payload: hit }; // legacy shape
  } catch { /* cache miss */ }
  if (cachedRec && (Date.now() - (cachedRec.at || 0)) < OVERVIEW_TTL_S * 1000) {
    return json(cachedRec.payload);
  }

  const notes = [];

  // Every block below is independent and best-effort.
  const [twitch, youtube, superChatUsd30d, tiktok] = await Promise.all([
    twitchOverview(env, notes),
    youtubeChannelStats(env, notes),
    superChatTotal30d(env, notes),
    tiktokDiamonds30d(env, notes),
  ]);

  // Revenue estimates, derived from counts. All figures are estimates;
  // the site labels them as such.
  const t = twitch.tiers;
  const subsUsdMoEst = t
    ? round2(t.t1 * 2.5 + t.t2 * 5 + t.t3 * 12.5)   // ~50% share of $4.99/$9.99/$24.99
    : null;
  if (!t) notes.push('Twitch sub revenue estimate unavailable: the tier breakdown could not be read (Helix /subscriptions with the broadcaster user token).');

  const bitsUsd30d = twitch.bitsSumMonth == null ? null : round2(twitch.bitsSumMonth * 0.01);
  if (twitch.bitsSumMonth == null) {
    notes.push('Bits revenue estimate unavailable: the Helix bits leaderboard could not be read (needs the bits:read broadcaster token).');
  } else {
    notes.push('Bits figure sums the top 100 of the current-calendar-month leaderboard at 1 cent per bit; Twitch exposes no exact payout API.');
  }

  const tiktokUsdEst30d = tiktok == null ? null : round2(tiktok * 0.005);
  if (tiktok == null) notes.push('TikTok diamonds unavailable: no gift data recorded in the last 30 days (TikFinity must be running and relaying during streams).');
  else notes.push('TikTok estimate values diamonds at half a cent each, before TikTok\'s cut; actual payout varies.');

  // The dashboard renders a static "Not available here, and why" section
  // covering YouTube ad revenue (monetary scope) and Twitch payout APIs -
  // do not duplicate those as notes; notes are for DYNAMIC conditions.

  const payload = {
    ok: true,
    twitch: {
      followers: twitch.followers,
      subsTotal: twitch.subsTotal,
      subPoints: twitch.subPoints,
      tiers: twitch.tiers,
      bitsTop30d: twitch.bitsTop,
      live: twitch.live,
    },
    youtube,
    revenue: {
      subsUsdMoEst,
      bitsUsd30d,
      superChatUsd30d,
      tiktokDiamonds30d: tiktok,
      tiktokUsdEst30d,
      notes,
    },
  };

  // Only cache a HEALTHY payload (at least one core block delivered
  // real data); a degraded build serves the stale-but-good cache
  // (up to 24h) instead of persisting nulls for every viewer of the
  // next 5 minutes.
  const healthy =
    payload.twitch.followers != null ||
    payload.twitch.subsTotal != null ||
    (payload.youtube && payload.youtube.subs != null);
  if (healthy) {
    try {
      await env.LOADOUT_BOLTS.put(
        OVERVIEW_CACHE_KEY,
        JSON.stringify({ at: Date.now(), payload }),
        { expirationTtl: 24 * 60 * 60 },
      );
    } catch { /* best effort */ }
    return json(payload);
  }
  if (cachedRec && (Date.now() - (cachedRec.at || 0)) < 24 * 60 * 60 * 1000) {
    return json(cachedRec.payload);
  }
  return json(payload);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ── Twitch ──────────────────────────────────────────────────────────

async function twitchOverview(env, notes) {
  const out = {
    followers: null,
    subsTotal: null,
    subPoints: null,
    tiers: null,
    bitsTop: [],
    bitsSumMonth: null,
    live: { live: false, title: null, game: null, viewers: null, startedAt: null },
  };
  const broadcasterId = String(env.CLAY_TWITCH_CHANNEL_ID || '').trim();
  if (!isTwitchConfigured(env) || !broadcasterId) {
    notes.push('Twitch stats unavailable: Twitch client credentials or the channel id are not configured on the worker.');
    return out;
  }

  let userAuth = false;
  try { userAuth = await hasTwitchUserAuth(env); } catch { /* treated as false */ }
  if (!userAuth) {
    notes.push('Twitch subs, bits, and follower counts need the broadcaster user token; the Twitch reconnect on the worker has not completed.');
  }

  // Followers (moderator:read:followers, user token). first=1 keeps the
  // payload tiny; `total` carries the full count.
  if (userAuth) {
    try {
      const j = await helixFetch(env, '/channels/followers', { broadcaster_id: broadcasterId, first: 1 }, { userToken: true });
      if (j && Number.isFinite(Number(j.total))) out.followers = Number(j.total);
    } catch { /* best-effort */ }
    if (out.followers == null) notes.push('Twitch follower count could not be read from Helix.');

    // Subscriptions (channel:read:subscriptions, user token). Paginate to
    // build the tier breakdown; Helix's own `points` field (first page) is
    // authoritative, with t1 + 2*t2 + 6*t3 as the fallback.
    try {
      const tiers = { t1: 0, t2: 0, t3: 0 };
      let helixPoints = null;
      let counted = 0;
      let anyPage = false;
      let cursor;
      for (let page = 0; page < MAX_SUB_PAGES; page++) {
        const params = { broadcaster_id: broadcasterId, first: 100 };
        if (cursor) params.after = cursor;
        const j = await helixFetch(env, '/subscriptions', params, { userToken: true });
        if (!j || !Array.isArray(j.data)) break;
        anyPage = true;
        if (page === 0 && Number.isFinite(Number(j.points))) helixPoints = Number(j.points);
        for (const s of j.data) {
          if (String(s.user_id) === broadcasterId) continue;  // broadcaster's own auto-entry
          counted++;
          const tier = Number(s.tier) || 1000;
          if (tier >= 3000) tiers.t3++;
          else if (tier >= 2000) tiers.t2++;
          else tiers.t1++;
        }
        cursor = j.pagination && j.pagination.cursor;
        if (!cursor) break;
      }
      if (anyPage) {
        out.subsTotal = counted;
        out.tiers = tiers;
        out.subPoints = helixPoints != null ? helixPoints : (tiers.t1 + tiers.t2 * 2 + tiers.t3 * 6);
      }
    } catch { /* best-effort */ }
    if (out.subsTotal == null) notes.push('Twitch subscription list could not be read from Helix.');

    // Bits leaderboard, current calendar month (closest window Helix
    // offers to a rolling 30 days). Top 10 for display, top 100 summed
    // for the revenue estimate.
    try {
      const j = await helixFetch(env, '/bits/leaderboard', { count: 100, period: 'month' }, { userToken: true });
      if (j && Array.isArray(j.data)) {
        let sum = 0;
        const rows = [];
        for (const e of j.data) {
          const bits = Number(e.score) || 0;
          if (bits <= 0) continue;
          sum += bits;
          if (rows.length < 10) rows.push({ name: e.user_name || e.user_login || 'viewer', bits });
        }
        out.bitsTop = rows;
        out.bitsSumMonth = sum;
      }
    } catch { /* best-effort */ }
  }

  // Live state rides the app token; works even without the user token.
  try {
    const s = await getStreamInfo(env, broadcasterId);
    if (s) {
      out.live = {
        live: true,
        title: s.title || null,
        game: s.game_name || null,
        viewers: Number.isFinite(Number(s.viewer_count)) ? Number(s.viewer_count) : null,
        startedAt: s.started_at || null,
      };
    }
    // null = genuinely offline (default shape stands); undefined = Helix
    // error, keep the conservative offline default silently.
  } catch { /* best-effort */ }

  return out;
}

// ── YouTube ─────────────────────────────────────────────────────────

// Fresh broadcaster token from the auth.aquilo.gg vault. Broker first
// (it holds the Google client secret and refreshes in place; same call
// shape as the platform-avatar endpoint and aquilo-dock.js), then the
// locally mirrored vault:yt record via link:tw2youtube (goals-api.js
// ytVaultToken pattern) as fallback.
async function ytVaultToken(env) {
  const twitchId = String(env.CLAY_TWITCH_CHANNEL_ID || '').trim();

  if (env.VAULT_SERVICE_SECRET && twitchId) {
    try {
      const r = await fetch(BROKER + '/youtube/vault/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ service: env.VAULT_SERVICE_SECRET, twitchId, role: 'broadcaster' }),
      });
      if (r.ok) {
        const j = await r.json();
        if (j && j.access_token) return j.access_token;
      }
    } catch { /* fall through to local vault */ }
  }

  try {
    if (!twitchId) return null;
    const ytId = await env.LOADOUT_BOLTS.get('link:tw2youtube:' + twitchId);
    if (!ytId) return null;
    const rec = await env.LOADOUT_BOLTS.get('vault:yt:' + ytId, { type: 'json' });
    const b = rec && rec.broadcaster;
    if (!b) return null;
    if (b.access_token && Number(b.expires_at || 0) > Date.now() + 60_000) return b.access_token;
    if (!b.refresh_token || !env.YOUTUBE_CLIENT_ID || !env.YOUTUBE_CLIENT_SECRET) return null;
    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.YOUTUBE_CLIENT_ID,
        client_secret: env.YOUTUBE_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: b.refresh_token,
      }).toString(),
    });
    if (!resp.ok) return null;
    const t = await resp.json();
    if (!t || !t.access_token) return null;
    b.access_token = t.access_token;
    b.expires_at = Date.now() + Math.max(60, Number(t.expires_in || 0) - 120) * 1000;
    b.updatedAt = Date.now();
    rec.updatedAt = Date.now();
    try { await env.LOADOUT_BOLTS.put('vault:yt:' + ytId, JSON.stringify(rec)); } catch { /* best effort */ }
    return t.access_token;
  } catch { return null; }
}

async function ytApi(token, path, params) {
  const u = new URL('https://www.googleapis.com/youtube/v3/' + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v != null) u.searchParams.set(k, String(v));
  }
  const r = await fetch(u.toString(), { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) return null;
  try { return await r.json(); } catch { return null; }
}

async function youtubeChannelStats(env, notes) {
  const out = { subs: null, views: null, videoCount: null };
  try {
    const token = await ytVaultToken(env);
    if (!token) {
      notes.push('YouTube stats unavailable: no broadcaster token in the vault. Connecting YouTube on auth.aquilo.gg unlocks them.');
      return out;
    }
    const j = await ytApi(token, 'channels', { part: 'statistics', mine: 'true' });
    const st = j && Array.isArray(j.items) && j.items[0] && j.items[0].statistics;
    if (!st) {
      notes.push('YouTube channel statistics could not be read from the Data API.');
      return out;
    }
    const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    out.subs = n(st.subscriberCount);
    out.views = n(st.viewCount);
    out.videoCount = n(st.videoCount);
  } catch {
    notes.push('YouTube channel statistics could not be read from the Data API.');
  }
  return out;
}

// Super Chat revenue, rolling 30 days, from superChatEvents.list. The
// only real YouTube revenue signal readable with the current scopes
// (youtube.readonly + force-ssl). amountMicros arrives in the event's
// own currency; sums treat every currency at face value, which is fine
// for an estimate on a mostly-USD channel. Creator share is 70%.
async function superChatTotal30d(env, notes) {
  try {
    const token = await ytVaultToken(env);
    if (!token) {
      notes.push('Super Chat totals unavailable: no YouTube broadcaster token in the vault.');
      return null;
    }
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    let micros = 0;
    let sawAny = false;
    let pageToken;
    for (let page = 0; page < MAX_SC_PAGES; page++) {
      const params = { part: 'snippet', maxResults: 50 };
      if (pageToken) params.pageToken = pageToken;
      const j = await ytApi(token, 'superChatEvents', params);
      if (!j || !Array.isArray(j.items)) {
        if (page === 0) {
          // The API rejects the call on channels with no live history;
          // report 0 with a note rather than failing the payload.
          notes.push('Super Chat: the API returned no data (none received yet, or the channel has no eligible live history); showing 0.');
          return 0;
        }
        break;
      }
      let pastWindow = false;
      for (const it of j.items) {
        const sn = it && it.snippet;
        if (!sn) continue;
        const created = Date.parse(sn.createdAt || '');
        if (Number.isFinite(created) && created < cutoff) { pastWindow = true; continue; }
        const m = Number(sn.amountMicros);
        if (Number.isFinite(m) && m > 0) { micros += m; sawAny = true; }
      }
      pageToken = j.nextPageToken;
      if (!pageToken || pastWindow) break;
    }
    if (!sawAny) {
      notes.push('Super Chat: no Super Chats recorded in the last 30 days.');
      return 0;
    }
    return round2((micros * 0.7) / 1e6);
  } catch {
    // Honest-null on transient failure: a hard $0.00 would read as
    // "no revenue" when the truth is "could not be read right now".
    notes.push('Super Chat totals could not be read from the Data API right now.');
    return null;
  }
}

// ── TikTok ──────────────────────────────────────────────────────────

// Rolling-30d gift diamonds. The gifter-roles daily tick precomputes
// gifter-top:<guild>:tiktok (top 50 supporters with per-supporter
// diamond totals); summing it covers effectively all volume. If the
// snapshot has never been written, fall back to the bounded
// rolling30dLeaderboard walk.
async function tiktokDiamonds30d(env, notes) {
  const guildId = String(env.AQUILO_VAULT_GUILD_ID || '').trim();
  if (!guildId) {
    notes.push('TikTok diamonds unavailable: the vault guild id is not configured on the worker.');
    return null;
  }
  try {
    const snap = await env.LOADOUT_BOLTS.get('gifter-top:' + guildId + ':tiktok', { type: 'json' });
    if (Array.isArray(snap)) {
      return snap.reduce((sum, r) => sum + (Number(r && r.total) || 0), 0);
    }
    const { rolling30dLeaderboard } = await import('./gifter-roles.js');
    const board = await rolling30dLeaderboard(env, 'tiktok', guildId, 50);
    if (Array.isArray(board)) {
      return board.reduce((sum, r) => sum + (Number(r && r.total) || 0), 0);
    }
  } catch { /* fall through */ }
  return null;
}

// ── YouTube videos route ────────────────────────────────────────────

async function routeYoutubeVideos(env) {
  // Same cache discipline as routeOverview: {at, payload} record,
  // never persist a degraded/empty result over a good one.
  let cachedRec = null;
  try {
    const hit = await env.LOADOUT_BOLTS.get(VIDEOS_CACHE_KEY, { type: 'json' });
    if (hit && hit.payload && hit.payload.ok) cachedRec = hit;
    else if (hit && hit.ok) cachedRec = { at: 0, payload: hit }; // legacy shape
  } catch { /* cache miss */ }
  if (cachedRec && (Date.now() - (cachedRec.at || 0)) < VIDEOS_TTL_S * 1000) {
    return json(cachedRec.payload);
  }

  const token = await ytVaultToken(env);
  if (!token) {
    return json({ ok: true, videos: [], note: 'No YouTube broadcaster token in the vault. Connecting YouTube on auth.aquilo.gg unlocks video stats.' });
  }

  let videos = [];
  try {
    // channels.list → uploads playlist → playlistItems (newest 12) →
    // videos.list for per-video statistics. ~4 quota units total; no
    // search.list (100 units) anywhere near this path.
    const ch = await ytApi(token, 'channels', { part: 'contentDetails', mine: 'true' });
    const uploads = ch && ch.items && ch.items[0] && ch.items[0].contentDetails
      && ch.items[0].contentDetails.relatedPlaylists
      && ch.items[0].contentDetails.relatedPlaylists.uploads;
    if (uploads) {
      const pl = await ytApi(token, 'playlistItems', { part: 'contentDetails', playlistId: uploads, maxResults: 12 });
      const ids = (pl && Array.isArray(pl.items) ? pl.items : [])
        .map((it) => it && it.contentDetails && it.contentDetails.videoId)
        .filter(Boolean);
      if (ids.length) {
        const vj = await ytApi(token, 'videos', { part: 'snippet,statistics', id: ids.join(','), maxResults: 12 });
        const byId = new Map();
        for (const v of (vj && Array.isArray(vj.items) ? vj.items : [])) byId.set(v.id, v);
        videos = ids.map((id) => {
          const v = byId.get(id);
          if (!v) return null;
          const sn = v.snippet || {};
          const st = v.statistics || {};
          const th = sn.thumbnails || {};
          const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);
          return {
            id: v.id,
            title: sn.title || '',
            publishedAt: sn.publishedAt || null,
            views: n(st.viewCount) || 0,
            likes: n(st.likeCount),
            comments: n(st.commentCount),
            thumbnail: (th.medium && th.medium.url) || (th.default && th.default.url) || '',
          };
        }).filter(Boolean);
      }
    }
  } catch { /* degrade to empty list */ }

  const payload = { ok: true, videos };
  // Only cache a non-empty list: one transient Data API failure must
  // not pin "No videos returned" for 30 minutes. Degraded builds serve
  // the stale-but-good cache (up to 24h) instead.
  if (videos.length > 0) {
    try {
      await env.LOADOUT_BOLTS.put(
        VIDEOS_CACHE_KEY,
        JSON.stringify({ at: Date.now(), payload }),
        { expirationTtl: 24 * 60 * 60 },
      );
    } catch { /* best effort */ }
    return json(payload);
  }
  if (cachedRec && (Date.now() - (cachedRec.at || 0)) < 24 * 60 * 60 * 1000) {
    return json(cachedRec.payload);
  }
  return json(payload);
}
