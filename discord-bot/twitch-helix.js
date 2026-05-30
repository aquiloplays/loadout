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

// Distinct from ext-loadout.js's `twitch:apptoken` (which stores
// the raw token string only — no JSON wrapper, no expiry tracked
// on our side). Using a separate key prevents
// `KV.get(.., type:'json')` from blowing up on the legacy string
// shape and keeps each module's cache lifecycle independent.
const TOKEN_KEY = 'twitch:apptoken-helix';

// User-token cache key (separate from the app-token cache because the
// auth shape + lifetime differ — user tokens are minted by refresh
// against env.TWITCH_USER_REFRESH_TOKEN and rotate every ~4h).
const USER_TOKEN_KEY = 'twitch:user-token-helix';
// User-token refresh rotation: Twitch returns a NEW refresh_token
// every time we exchange the old one. Stored back at this KV key so
// the next refresh has the freshest. Falls back to env.TWITCH_USER_REFRESH_TOKEN
// when KV is empty.
const USER_REFRESH_KEY = 'twitch:user-refresh-helix';

export function isTwitchConfigured(env) {
  return !!(env && env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET);
}

// True iff we have everything required to mint a USER access token —
// app-token isConfigured() returns true alone doesn't imply user-token
// subs can be created. Used by setupTwitchSubscriptions to skip
// user-token-requiring subs cleanly when only the app token is set.
// Async because KV reads are async — the OAuth self-serve flow stores
// the refresh token in KV (not as a worker secret), so a sync env-only
// check would miss it and incorrectly skip every user-token sub right
// after the operator finished OAuth.
export async function hasTwitchUserAuth(env) {
  if (!isTwitchConfigured(env)) return false;
  if (env.TWITCH_USER_REFRESH_TOKEN) return true;
  try {
    const kv = await env.LOADOUT_BOLTS.get(USER_REFRESH_KEY);
    return !!kv;
  } catch { return false; }
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

// ── User Access Token ─────────────────────────────────────────────
//
// Some EventSub topics (channel.follow v2, channel.subscribe,
// channel.cheer, channel.poll.*, channel.prediction.*,
// channel.hype_train.*, channel.channel_points_custom_reward_redemption.add,
// channel.ban/unban) REQUIRE a user access token from the broadcaster
// — app token won't authorize the subscription.
//
// We bootstrap with env.TWITCH_USER_REFRESH_TOKEN (set once via
// `wrangler secret put`); each subsequent refresh rotates the
// refresh_token, and we persist the new one to KV. The KV value
// takes precedence over env on read.
//
// Returns null when:
//   - twitch isn't configured (CLIENT_ID/SECRET missing), OR
//   - no refresh token has ever been provided, OR
//   - refresh exchange failed (e.g. refresh token revoked)
// Callers MUST handle null without throwing.
export async function getUserAccessToken(env) {
  if (!isTwitchConfigured(env)) return null;
  // Warm cache first.
  const cached = await env.LOADOUT_BOLTS.get(USER_TOKEN_KEY, { type: 'json' });
  if (cached && cached.token && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }
  // Refresh — prefer the KV-rotated refresh token, fall back to env.
  let refresh = null;
  try {
    refresh = await env.LOADOUT_BOLTS.get(USER_REFRESH_KEY);
  } catch { /* ignore */ }
  if (!refresh) refresh = env.TWITCH_USER_REFRESH_TOKEN || null;
  if (!refresh) return null;
  const params = new URLSearchParams({
    client_id:     env.TWITCH_CLIENT_ID,
    client_secret: env.TWITCH_CLIENT_SECRET,
    grant_type:    'refresh_token',
    refresh_token: refresh,
  });
  const resp = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!resp.ok) {
    console.warn('[twitch-helix] user token refresh failed', resp.status,
      (await resp.text()).slice(0, 300));
    return null;
  }
  const j = await resp.json();
  if (!j.access_token) return null;
  const ttlS = Math.max(60, Number(j.expires_in || 0) - 300);
  await env.LOADOUT_BOLTS.put(USER_TOKEN_KEY, JSON.stringify({
    token: j.access_token,
    expiresAt: Date.now() + ttlS * 1000,
  }), { expirationTtl: ttlS });
  if (j.refresh_token && j.refresh_token !== refresh) {
    // Persist the rotated refresh token so the next exchange uses
    // the freshest one. (Twitch rotates per-exchange.)
    await env.LOADOUT_BOLTS.put(USER_REFRESH_KEY, j.refresh_token);
  }
  return j.access_token;
}

// Generic Helix fetch — handles the Bearer + Client-Id headers, one
// retry on 401 (token rotated under us). Returns the parsed JSON
// body or null on failure. Caller decides whether null is an error
// or a no-op.
//
// `opts.userToken: true` swaps in the user access token (for endpoints
// that require user-context auth — currently only used by EventSub
// subscription creation for the user-token-only topics).
export async function helixFetch(env, path, params, opts = {}) {
  if (!isTwitchConfigured(env)) return null;
  const token = opts.userToken
    ? await getUserAccessToken(env)
    : await getAppAccessToken(env);
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
    const cacheKey = opts.userToken ? USER_TOKEN_KEY : TOKEN_KEY;
    await env.LOADOUT_BOLTS.delete(cacheKey).catch(() => {});
    const fresh = opts.userToken
      ? await getUserAccessToken(env)
      : await getAppAccessToken(env);
    if (!fresh) return null;
    init.headers['Authorization'] = 'Bearer ' + fresh;
    resp = await fetch(u.toString(), init);
  }
  if (resp.status === 204) return { ok: true, status: 204 };
  let body = null;
  try { body = await resp.json(); } catch { /* not JSON */ }
  if (!resp.ok) {
    console.warn('[twitch-helix]', resp.status, path, body ? JSON.stringify(body).slice(0, 200) : '');
    // 2026-05-29 — callers that need the actual Twitch error body to
    // diagnose can pass returnErrors:true. Default behavior (null on
    // error) preserved for everything else.
    if (opts.returnErrors) {
      return { _error: true, status: resp.status,
               body, message: body?.message || body?.error || resp.statusText };
    }
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
//
// `opts.userToken: true` mints the subscription under the broadcaster
// user OAuth token (required for channel.follow v2 / channel.subscribe
// / channel.cheer / channel.hype_train.* / channel.poll.* /
// channel.prediction.* / channel.channel_points_custom_reward_redemption.add
// / channel.ban/unban). `opts.version` overrides the default '1'
// (channel.follow now requires '2').
export async function createSubscription(env, type, condition, callbackUrl, secret, opts = {}) {
  // 2026-05-29 fix — webhook-transport EventSub ALWAYS uses the app
  // access token, regardless of which scopes the subscription type
  // needs. The user OAuth flow is still required (so Clay grants the
  // scopes against our client_id and Twitch remembers them for the
  // (client_id, broadcaster) pair), but the create call itself is
  // app-token. User-token is for WebSocket transport, not webhook.
  // opts.userToken is preserved as a no-op for callers + as docs for
  // which subs need a prior user-grant.
  const j = await helixFetch(env, '/eventsub/subscriptions', null, {
    method: 'POST',
    userToken: false,
    returnErrors: true,
    body: {
      type,
      version: String(opts.version || '1'),
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

// Validate the currently-stored user access token against Twitch's
// validate endpoint. Returns { ok, login, user_id, scopes:[...],
// expires_in } or { ok:false, error, ... }. Useful for diagnosing
// scope-mismatch failures on EventSub create.
export async function validateUserToken(env) {
  const token = await getUserAccessToken(env);
  if (!token) return { ok: false, error: 'no-user-token' };
  const resp = await fetch('https://id.twitch.tv/oauth2/validate', {
    headers: { 'Authorization': 'OAuth ' + token },
  });
  let body = null;
  try { body = await resp.json(); } catch { /* not JSON */ }
  if (!resp.ok) return { ok: false, status: resp.status, body };
  return { ok: true, ...body };
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
