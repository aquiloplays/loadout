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
// is one cheap call per token. Token preference:
//   1. vault:tw broadcaster token (multi-tenant, the real path once the
//      streamer has done the /connect click)
//   2. the worker's EventSub user token — Clay's own grant, which carries
//      moderator:read:followers + channel:read:subscriptions, so the
//      canonical channel works before /connect exists
//   3. the PunchCard channel token (channel:read:subscriptions only, so
//      it can fill in subs for any punchcard-claimed channel)
const HELIX_COUNT = {
  followers: (id) => `/channels/followers?broadcaster_id=${id}&first=1`,
  subs: (id) => `/subscriptions?broadcaster_id=${id}&first=1`,
};

async function helixTotal(env, token, pathQ, dbg, clientId) {
  if (!token) return null;
  try {
    const r = await fetch('https://api.twitch.tv/helix' + pathQ, {
      headers: { 'Authorization': 'Bearer ' + token, 'Client-Id': clientId || env.TWITCH_CLIENT_ID },
    });
    if (dbg) dbg[pathQ.slice(1, pathQ.indexOf('?'))] = r.status;
    if (!r.ok) return null;
    const j = await r.json();
    const n = Number(j && j.total);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

// The auth broker refreshes vault tokens with ITS OWN (known-good) Twitch
// app secret, so this path keeps working even when the local
// TWITCH_CLIENT_SECRET drifts stale (which it currently is — Helix mints
// here fail with "invalid client secret" until Clay re-puts the secret).
// Returns { token, clientId } for a connected broadcaster, else null.
async function brokerVaultToken(env, twitchId, dbg) {
  if (!env.VAULT_SERVICE_SECRET) return null;
  try {
    const r = await fetch('https://auth.aquilo.gg/twitch/vault/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ service: env.VAULT_SERVICE_SECRET, twitchId: String(twitchId), role: 'broadcaster' }),
    });
    if (dbg) dbg.broker = r.status;
    if (!r.ok) return null;
    const j = await r.json();
    return (j && j.access_token) ? { token: j.access_token, clientId: j.client_id } : null;
  } catch { return null; }
}

// PunchCard stores a per-channel token (pc:chan:<login>.tw) minted against
// the same Twitch app; refresh it in place the same way punchcard does.
async function punchcardToken(env, ch, dbg) {
  try {
    const chan = await env.LOADOUT_BOLTS.get('pc:chan:' + ch, { type: 'json' });
    const tw = chan && chan.tw;
    if (dbg) dbg.pcRecord = chan ? (tw && tw.rt ? 'has-token' : 'no-tw-token') : 'no-record';
    if (!tw || !tw.rt) return null;
    if (tw.at && Number(tw.atExp || 0) > Date.now() + 60_000) return tw.at;
    const resp = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.TWITCH_CLIENT_ID,
        client_secret: env.TWITCH_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: tw.rt,
      }).toString(),
    });
    if (!resp.ok) return null;
    const t = await resp.json();
    if (!t || !t.access_token) return null;
    tw.at = t.access_token;
    tw.atExp = Date.now() + Math.max(60, Number(t.expires_in || 0) - 120) * 1000;
    if (t.refresh_token) tw.rt = t.refresh_token;
    try { await env.LOADOUT_BOLTS.put('pc:chan:' + ch, JSON.stringify(chan)); } catch { /* best effort */ }
    return tw.at;
  } catch { return null; }
}

async function twitchCounts(env, twitchId, ch, dbg) {
  const num = (r) => (r && r.ok && r.data && Number.isFinite(Number(r.data.total))) ? Number(r.data.total) : null;
  // 1. Broker-refreshed vault token (survives local secret drift).
  const out = { connected: false, followers: null, subs: null };
  const bt = await brokerVaultToken(env, twitchId, dbg);
  if (bt) {
    const [f, s] = await Promise.all([
      helixTotal(env, bt.token, HELIX_COUNT.followers(twitchId), dbg && (dbg.brokerHelix = {}), bt.clientId),
      helixTotal(env, bt.token, HELIX_COUNT.subs(twitchId), dbg && dbg.brokerHelix, bt.clientId),
    ]);
    out.connected = true;
    if (f != null) out.followers = f;
    if (s != null) out.subs = s;
    if (out.followers != null && out.subs != null) return out;
  }
  // 1b. Locally-refreshed vault token (works once the local secret is fixed;
  //     cheap no-op when the vault record doesn't exist).
  const [vf, vs] = await Promise.all([
    out.followers == null ? vaultHelix(env, twitchId, '/channels/followers', { params: { broadcaster_id: twitchId, first: 1 } }) : null,
    out.subs == null ? vaultHelix(env, twitchId, '/subscriptions', { params: { broadcaster_id: twitchId, first: 1 } }) : null,
  ]);
  if (dbg) dbg.vault = { followers: vf && vf.status, subs: vs && vs.status, err: vf && vf.data && vf.data.error };
  out.connected = out.connected || !!((vf && vf.ok) || (vs && vs.ok));
  if (num(vf) != null) out.followers = num(vf);
  if (num(vs) != null) out.subs = num(vs);
  if (out.followers != null && out.subs != null) return out;
  // 2. Canonical-channel user token (Clay pre-/connect).
  if (String(env.CLAY_TWITCH_CHANNEL_ID || '') === String(twitchId)) {
    try {
      const { getUserAccessToken } = await import('./twitch-helix.js');
      const tok = await getUserAccessToken(env);
      if (dbg) dbg.userToken = tok ? 'ok' : 'none';
      if (tok) {
        const [f, s] = await Promise.all([
          out.followers == null ? helixTotal(env, tok, HELIX_COUNT.followers(twitchId), dbg && (dbg.user = {})) : null,
          out.subs == null ? helixTotal(env, tok, HELIX_COUNT.subs(twitchId), dbg && dbg.user) : null,
        ]);
        if (f != null) out.followers = f;
        if (s != null) out.subs = s;
      }
    } catch (e) { if (dbg) dbg.userToken = 'threw: ' + String(e && e.message || e).slice(0, 80); }
  } else if (dbg) {
    dbg.userToken = 'skipped (CLAY_TWITCH_CHANNEL_ID=' + String(env.CLAY_TWITCH_CHANNEL_ID || 'unset') + ' vs ' + twitchId + ')';
  }
  // 3. PunchCard channel token (subs scope only, but try both).
  if (out.followers == null || out.subs == null) {
    const tok = await punchcardToken(env, ch, dbg);
    if (dbg) dbg.pcToken = tok ? 'ok' : 'none';
    if (tok) {
      const [f, s] = await Promise.all([
        out.followers == null ? helixTotal(env, tok, HELIX_COUNT.followers(twitchId), dbg && (dbg.pc = {})) : null,
        out.subs == null ? helixTotal(env, tok, HELIX_COUNT.subs(twitchId), dbg && dbg.pc) : null,
      ]);
      if (f != null) out.followers = f;
      if (s != null) out.subs = s;
    }
  }
  out.connected = out.connected || out.followers != null || out.subs != null;
  return out;
}

// ── Kick ────────────────────────────────────────────────────────────
async function kickCounts(env, twitchId, slugParam, dbg) {
  // The public site endpoint (kick.com/api/v2) is hard-blocked for
  // non-browser clients, so followers come from the OFFICIAL API under the
  // streamer's Kick token. Two token sources, both already maintained by
  // other products: rotation-bot's streamer record (jukebox Kick connect,
  // live today) and the Aquilo ID vault (once Kick connect activates).
  let slug = String(slugParam || '').trim().toLowerCase().replace(/^@/, '');
  let token = null;
  if (dbg) dbg.kick = { hasKv: !!env.ROTATION_KV, twitchId: twitchId || null };
  try {
    const rec = (twitchId && env.ROTATION_KV) ? await env.ROTATION_KV.get('streamer:' + twitchId, { type: 'json' }) : null;
    if (rec) {
      if (!slug && rec.kickSlug) slug = String(rec.kickSlug).toLowerCase();
      if (rec.kickAccess && Number(rec.kickAccessExp || 0) > Date.now() + 60_000) token = rec.kickAccess;
      if (dbg) Object.assign(dbg.kick, { rec: true, tokenFresh: !!token, exp: rec.kickAccessExp || 0, slug });
    } else if (dbg) dbg.kick.rec = false;
  } catch (e) { if (dbg) dbg.kick.err = String(e && e.message || e).slice(0, 80); }
  if (!token && twitchId) {
    try {
      const kickId = await env.LOADOUT_BOLTS.get('link:tw2kick:' + twitchId);
      const rec = kickId ? await env.LOADOUT_BOLTS.get('vault:kick:' + kickId, { type: 'json' }) : null;
      const b = rec && rec.broadcaster;
      if (b && b.access_token && Number(b.expires_at || 0) > Date.now() + 60_000) token = b.access_token;
      if (!slug && b && b.login) slug = String(b.login).toLowerCase();
    } catch { /* not connected */ }
  }
  if (!token) return { connected: false, followers: null, slug: slug || null };
  try {
    const q = slug ? '?slug=' + encodeURIComponent(slug) : '';
    const r = await fetch('https://api.kick.com/public/v1/channels' + q, {
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
    });
    if (dbg && dbg.kick) dbg.kick.status = r.status;
    if (!r.ok) return { connected: true, followers: null, slug: slug || null };
    const j = await r.json();
    const c = (j && Array.isArray(j.data) && j.data[0]) || (j && j.data) || j || {};
    if (!slug && c.slug) slug = String(c.slug).toLowerCase();
    const n = Number(c.followers_count ?? c.followersCount ?? (c.followers && c.followers.count) ?? c.follower_count);
    if (dbg && dbg.kick && !Number.isFinite(n)) dbg.kick.fields = Object.keys(c).join(',').slice(0, 200);
    return { connected: true, followers: Number.isFinite(n) ? n : null, slug: slug || null };
  } catch {
    return { connected: true, followers: null, slug: slug || null };
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

    const dbg = url.searchParams.get('debug') ? {} : null;
    // login → id: Helix app token first. When Helix is unreachable (the
    // local TWITCH_CLIENT_SECRET is stale as of 2026-07 — mints 403) fall
    // back to ids already on record: the punchcard claim stores userId.
    const who = await loginToId(env, ch);
    let twitchId = who && who.id;
    if (!twitchId) {
      try {
        const pc = await env.LOADOUT_BOLTS.get('pc:chan:' + ch, { type: 'json' });
        if (pc && pc.userId) twitchId = String(pc.userId);
      } catch { /* stay unresolved */ }
    }
    if (dbg) dbg.twitchId = twitchId ? twitchId + (who ? '' : ' (via punchcard)') : 'unresolved';
    const [twitch, kick, youtube] = await Promise.all([
      twitchId ? twitchCounts(env, twitchId, ch, dbg) : { connected: false, followers: null, subs: null },
      kickCounts(env, twitchId, kickSlug, dbg),
      ytCounts(env, twitchId, ytChan),
    ]);
    let tiktok = null;
    try { tiktok = await env.LOADOUT_BOLTS.get('goals:tt:' + ch, { type: 'json' }); } catch { /* none */ }

    const body = { ok: true, ch, ts: Date.now(), twitch, kick, youtube, tiktok, ...(dbg ? { debug: dbg } : {}) };

    // Platform fetches flake (token rotation races, Kick/Helix hiccups).
    // Rather than blanking the overlay, backfill nulls from the last good
    // read (kept 7 days) and mark them stale; then persist the improved
    // snapshot as the new last-good.
    const LAST_KEY = 'goals:last:' + ch;
    try {
      const last = await env.LOADOUT_BOLTS.get(LAST_KEY, { type: 'json' });
      if (last) {
        for (const [p, fields] of [['twitch', ['followers', 'subs']], ['kick', ['followers']], ['youtube', ['subs']]]) {
          for (const f of fields) {
            if (body[p][f] == null && last[p] && last[p][f] != null) {
              body[p][f] = last[p][f];
              body[p].stale = true;
              body[p].connected = body[p].connected || !!last[p].connected;
            }
          }
        }
        if (!body.tiktok && last.tiktok) body.tiktok = last.tiktok;
      }
      await env.LOADOUT_BOLTS.put(LAST_KEY, JSON.stringify(body), { expirationTtl: 7 * 86400 });
    } catch { /* best effort */ }

    try { await env.LOADOUT_BOLTS.put(ck, JSON.stringify(body), { expirationTtl: CACHE_TTL_S }); } catch { /* best effort */ }
    return json(body);
  }

  return json({ ok: false, error: 'not-found' }, 404);
}
