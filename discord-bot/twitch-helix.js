// Thin Twitch Helix client — App Access Token cached in KV, no-config
// graceful fall-through. Imported by:
//   • twitch-eventsub.js  (subscription manager + revocation)
//   • twitch-live.js      (live-embed post/refresh)
//   • twitch-clips.js     (clip polling)
//
// Auth model: client-credentials grant. Cached at `twitch:apptoken` in
// LOADOUT_BOLTS with TTL ≈ token-lifetime - 5min so we always renew
// before expiry. Mirrors the same caching shape rotation.js's Spotify
// token uses.
//
// All exported helpers return null (or { ok: false, ... }) when the
// three Twitch env secrets aren't set — callers MUST handle a null
// return rather than throwing. Cron tasks check isTwitchConfigured()
// up front and warn-+-skip cleanly.

const TOKEN_KEY = 'twitch:apptoken';

export function isTwitchConfigured(env) {
  return !!(env && env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET);
}

// ── App Access Token ──────────────────────────────────────────────
//
// Cached for (expires_in - 300) seconds. Twitch usually returns a
// ~60-day token; we still pin a short cache_max because Cloudflare
// KV expirationTtl is best-effort beyond ~hours anyway. The
// "renew 5 min early" buffer is the standard safety margin.
export async function getAppAccessToken(env) {
  if (!isTwitchConfigured(env)) return null;
  const cached = await env.LOADOUT_BOLTS.get(TOKEN_KEY, { type: 'json' });
  if (cached && cached.token && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }
  const params = new URLSearchParams({
    client_id:     env.TWITCH_CLIENT_ID,
    client_secret: env.TWITCH_CLIENT_SECRET,
    grant_type:    'client_credentials',
  });
  const resp = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!resp.ok) {
    console.warn('[twitch-helix] token fetch failed', resp.status, (await resp.text()).slice(0, 200));
    return null;
  }
  const j = await resp.json();
  if (!j.access_token) return null;
  const ttlS = Math.max(60, Number(j.expires_in || 0) - 300);
  await env.LOADOUT_BOLTS.put(TOKEN_KEY, JSON.stringify({
    token: j.access_token,
    expiresAt: Date.now() + ttlS * 1000,
  }), { expirationTtl: ttlS });
  return j.access_token;
}

// Generic Helix fetch — handles the Bearer + Client-Id headers, one
// retry on 401 (token rotated under us). Returns the parsed JSON
// body or null on failure. Caller decides whether null is an error
// or a no-op.
export async function helixFetch(env, path, params, opts = {}) {
  if (!isTwitchConfigured(env)) return null;
  const token = await getAppAccessToken(env);
  if (!token) return null;
  const u = new URL('https://api.twitch.tv/helix' + path);
  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params)) {
      if (v == null) continue;
      if (Array.isArray(v)) for (const item of v) u.searchParams.append(k, String(item));
      else u.searchParams.set(k, String(v));
    }
  }
  const init = {
    method: opts.method || 'GET',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Client-Id':     env.TWITCH_CLIENT_ID,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(opts.body ? { body: typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body) } : {}),
  };
  let resp = await fetch(u.toString(), init);
  if (resp.status === 401) {
    // Token died under us — wipe + try once more with a fresh one.
    await env.LOADOUT_BOLTS.delete(TOKEN_KEY).catch(() => {});
    const fresh = await getAppAccessToken(env);
    if (!fresh) return null;
    init.headers['Authorization'] = 'Bearer ' + fresh;
    resp = await fetch(u.toString(), init);
  }
  if (resp.status === 204) return { ok: true, status: 204 };
  let body = null;
  try { body = await resp.json(); } catch { /* not JSON */ }
  if (!resp.ok) {
    console.warn('[twitch-helix]', resp.status, path, body ? JSON.stringify(body).slice(0, 200) : '');
    return null;
  }
  return body;
}

// ── Endpoint wrappers ─────────────────────────────────────────────

// Returns the active stream object (live) OR null (offline / not
// configured). Helix returns an empty `data` array for offline
// channels — we flatten that to null so callers can just `if (stream)`.
export async function getStreamInfo(env, broadcasterId) {
  const j = await helixFetch(env, '/streams', { user_id: broadcasterId });
  if (!j || !Array.isArray(j.data) || j.data.length === 0) return null;
  return j.data[0];
}

// Returns the User object for a numeric broadcaster id (used to
// surface profile_image_url + display_name on the live embed).
export async function getUserById(env, userId) {
  const j = await helixFetch(env, '/users', { id: userId });
  if (!j || !Array.isArray(j.data) || j.data.length === 0) return null;
  return j.data[0];
}

// Returns clips created since `startedAtIso` (ISO 8601 string).
// Pagination ignored — for a 10-min polling window we'll never get
// more than a handful of clips.
export async function getRecentClips(env, broadcasterId, startedAtIso) {
  const j = await helixFetch(env, '/clips', {
    broadcaster_id: broadcasterId,
    started_at:     startedAtIso,
    first:          50,
  });
  if (!j || !Array.isArray(j.data)) return [];
  return j.data;
}

// ── EventSub subscriptions ────────────────────────────────────────
//
// Create a subscription for a given (type, condition) pair. Idempotent
// at the cost of an extra GET — caller can deduplicate via
// listSubscriptions() before posting. Twitch's POST itself rejects
// dupes with `409 Conflict`, which we treat as success here.
//
// `callbackUrl` is the public URL of THIS worker's /twitch/eventsub
// route. `secret` is the HMAC secret Twitch will use to sign every
// notification — must match env.TWITCH_EVENTSUB_SECRET on the
// worker side or signature verification will fail.
export async function createSubscription(env, type, condition, callbackUrl, secret) {
  const j = await helixFetch(env, '/eventsub/subscriptions', null, {
    method: 'POST',
    body: {
      type,
      version: '1',
      condition,
      transport: {
        method:   'webhook',
        callback: callbackUrl,
        secret,
      },
    },
  });
  return j;
}

export async function listSubscriptions(env) {
  const j = await helixFetch(env, '/eventsub/subscriptions');
  if (!j || !Array.isArray(j.data)) return [];
  return j.data;
}

export async function deleteSubscription(env, subscriptionId) {
  return helixFetch(env, '/eventsub/subscriptions', { id: subscriptionId }, {
    method: 'DELETE',
  });
}
