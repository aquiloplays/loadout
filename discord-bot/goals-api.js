// MultiGoal: cross-platform follower/sub counts for the rotating goals
// overlay (widget.aquilo.gg/overlays/multigoal). One public read endpoint,
// keyed by Twitch login, that fans out to every platform the streamer has
// connected and returns whatever numbers are reachable:
//
//   GET /api/goals/state?ch=<twitch login>[&kick=<slug>][&yt=<channelId>]
//
//   → { ok, ch, ts,
//       twitch:  { connected, followers, subs },
//       youtube: { connected, subs },
//       kick:    { connected, followers, slug },
//       tiktok:  { followers } | null }
//
// Platform sources (each independent, null when unreachable):
//   • Twitch  — vault:tw broadcaster token (vaultHelix): /channels/followers
//               total + /subscriptions total. The Aquilo ID connect scopes
//               already include moderator:read:followers +
//               channel:read:subscriptions.
//   • Kick    — no follower count on the official public API yet, so the
//               public site endpoint (kick.com/api/v2/channels/<slug>) is
//               primary. Slug comes from ?kick= (overlay config) or the
//               vault back-pointer (link:tw2kick → vault:kick record login).
//   • YouTube — vault:yt token via link:tw2youtube (fresh or refreshable
//               when YOUTUBE_CLIENT_ID/SECRET are set), else public
//               channels?part=statistics with env.YOUTUBE_API_KEY + ?yt=id.
//               Dark until the Google app secrets land; returns
//               connected:false meanwhile.
//   • TikTok  — no API. The overlay owns TikTok: manual baseline from its
//               config + live TikFinity follow events. Server-side value
//               only if something ever writes goals:tt:<login> to KV.
//
// Whole response is KV-cached 120s per (ch,kick,yt) so an OBS source
// polling every minute costs ~1 Helix call pair per 2 minutes per channel.

import { loginToId, vaultHelix } from './warden-twitch.js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
  });
}

const CACHE_TTL_S = 120;
const cacheKey = (ch, kick, yt) => `goals:cache:${ch}:${kick || '-'}:${yt || '-'}`;

// ── Twitch ──────────────────────────────────────────────────────────
// Both endpoints return a `total` field even with first=1, so each count
// is one cheap call under the broadcaster's vault token.
async function twitchCounts(env, twitchId) {
  const [fol, subs] = await Promise.all([
    vaultHelix(env, twitchId, '/channels/followers', { params: { broadcaster_id: twitchId, first: 1 } }),
    vaultHelix(env, twitchId, '/subscriptions', { params: { broadcaster_id: twitchId, first: 1 } }),
  ]);
  const num = (r) => (r && r.ok && r.data && Number.isFinite(Number(r.data.total))) ? Number(r.data.total) : null;
  if (!fol && !subs) return { connected: false, followers: null, subs: null };
  return {
    connected: !!((fol && fol.ok) || (subs && subs.ok)),
    followers: num(fol),
    subs: num(subs),
  };
}

// ── Kick ────────────────────────────────────────────────────────────
// Resolve the slug (explicit param wins, else the connected vault record),
// then read followers_count off the public site API. That endpoint sits
// behind Cloudflare and occasionally challenges non-browser clients, so a
// failure is just { connected, followers:null } — the overlay hides the
// number rather than showing 0.
async function kickVaultLogin(env, twitchId) {
  try {
    const kickId = await env.LOADOUT_BOLTS.get('link:tw2kick:' + twitchId);
    if (!kickId) return null;
    const rec = await env.LOADOUT_BOLTS.get('vault:kick:' + kickId, { type: 'json' });
    const b = rec && rec.broadcaster;
    return (b && (b.login || b.display_name)) || (rec && (rec.login || rec.display_name)) || null;
  } catch { return null; }
}

async function kickCounts(env, twitchId, slugParam) {
  const vaultSlug = twitchId ? await kickVaultLogin(env, twitchId) : null;
  const slug = String(slugParam || vaultSlug || '').trim().toLowerCase().replace(/^@/, '');
  if (!/^[a-z0-9_-]{1,60}$/.test(slug)) return { connected: !!vaultSlug, followers: null, slug: null };
  try {
    const r = await fetch('https://kick.com/api/v2/channels/' + encodeURIComponent(slug), {
      headers: { 'accept': 'application/json', 'user-agent': 'Mozilla/5.0 (aquilo.gg multigoal)' },
    });
    if (!r.ok) return { connected: !!vaultSlug, followers: null, slug };
    const j = await r.json();
    const n = Number(j && (j.followers_count ?? j.followersCount));
    return { connected: !!vaultSlug || Number.isFinite(n), followers: Number.isFinite(n) ? n : null, slug };
  } catch {
    return { connected: !!vaultSlug, followers: null, slug };
  }
}

// ── YouTube ─────────────────────────────────────────────────────────
async function ytVaultToken(env, twitchId) {
  try {
    const ytId = await env.LOADOUT_BOLTS.get('link:tw2youtube:' + twitchId);
    if (!ytId) return null;
    const rec = await env.LOADOUT_BOLTS.get('vault:yt:' + ytId, { type: 'json' });
    const b = rec && rec.broadcaster;
    if (!b) return null;
    if (b.access_token && Number(b.expires_at || 0) > Date.now() + 60_000) {
      return { token: b.access_token, ytId };
    }
    // Refresh only works once the same Google app's secrets are set here
    // (they're the broker's; mirrored on this worker when YT activates).
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
    return { token: t.access_token, ytId };
  } catch { return null; }
}

async function ytCounts(env, twitchId, channelIdParam) {
  const base = 'https://www.googleapis.com/youtube/v3/channels?part=statistics';
  const subsFrom = (j) => {
    const it = j && Array.isArray(j.items) && j.items[0];
    const n = it && it.statistics && Number(it.statistics.subscriberCount);
    return Number.isFinite(n) ? n : null;
  };
  // Connected path: the streamer's own OAuth token, no channel id needed.
  const tok = twitchId ? await ytVaultToken(env, twitchId) : null;
  if (tok) {
    try {
      const r = await fetch(base + '&mine=true', { headers: { authorization: 'Bearer ' + tok.token } });
      if (r.ok) return { connected: true, subs: subsFrom(await r.json()) };
    } catch { /* fall through */ }
  }
  // Public path: explicit channel id + a plain API key.
  const cid = String(channelIdParam || '').trim();
  if (env.YOUTUBE_API_KEY && /^[A-Za-z0-9_-]{10,64}$/.test(cid)) {
    try {
      const r = await fetch(base + '&id=' + encodeURIComponent(cid) + '&key=' + encodeURIComponent(env.YOUTUBE_API_KEY));
      if (r.ok) return { connected: true, subs: subsFrom(await r.json()) };
    } catch { /* fall through */ }
  }
  return { connected: !!tok, subs: null };
}

// ── Router ──────────────────────────────────────────────────────────
export async function handleGoals(req, env, path) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);
  if (req.method === 'GET' && path === '/api/goals/state') {
    const ch = String(url.searchParams.get('ch') || '').trim().toLowerCase().replace(/^@/, '');
    if (!/^[a-z0-9_]{1,25}$/.test(ch)) return json({ ok: false, error: 'bad-channel' }, 400);
    const kickSlug = url.searchParams.get('kick') || '';
    const ytChan = url.searchParams.get('yt') || '';

    const ck = cacheKey(ch, kickSlug, ytChan);
    if (!url.searchParams.get('nocache')) {
      try {
        const hit = await env.LOADOUT_BOLTS.get(ck, { type: 'json' });
        if (hit) return json({ ...hit, cached: true });
      } catch { /* miss */ }
    }

    const who = await loginToId(env, ch);
    const twitchId = who && who.id;
    const [twitch, kick, youtube] = await Promise.all([
      twitchId ? twitchCounts(env, twitchId) : { connected: false, followers: null, subs: null },
      kickCounts(env, twitchId, kickSlug),
      ytCounts(env, twitchId, ytChan),
    ]);
    let tiktok = null;
    try { tiktok = await env.LOADOUT_BOLTS.get('goals:tt:' + ch, { type: 'json' }); } catch { /* none */ }

    const body = { ok: true, ch, ts: Date.now(), twitch, kick, youtube, tiktok };
    try { await env.LOADOUT_BOLTS.put(ck, JSON.stringify(body), { expirationTtl: CACHE_TTL_S }); } catch { /* best effort */ }
    return json(body);
  }

  return json({ ok: false, error: 'not-found' }, 404);
}
