// Thin Twitch Helix client, App Access Token cached in KV, no-config
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
// three Twitch env secrets aren't set, callers MUST handle a null
// return rather than throwing. Cron tasks check isTwitchConfigured()
// up front and warn-+-skip cleanly.

// Distinct from ext-loadout.js's `twitch:apptoken` (which stores
// the raw token string only, no JSON wrapper, no expiry tracked
// on our side). Using a separate key prevents
// `KV.get(.., type:'json')` from blowing up on the legacy string
// shape and keeps each module's cache lifecycle independent.
const TOKEN_KEY = 'twitch:apptoken-helix';

// User-token cache key (separate from the app-token cache because the
// auth shape + lifetime differ, user tokens are minted by refresh
// against env.TWITCH_USER_REFRESH_TOKEN and rotate every ~4h).
const USER_TOKEN_KEY = 'twitch:user-token-helix';
// User-token refresh rotation: Twitch returns a NEW refresh_token
// every time we exchange the old one. Stored back at this KV key so
// the next refresh has the freshest. Falls back to env.TWITCH_USER_REFRESH_TOKEN
// when KV is empty.
const USER_REFRESH_KEY = 'twitch:user-refresh-helix';

// Central Aquilo ID vault (aquilo.gg/connect). When a broadcaster has
// connected, their token lives in the shared vault, MINTED BY THE BROKER'S
// Twitch app — so it must be used with the broker's client_id (a Twitch token
// is bound to the app that issued it). We fetch it via the service API +
// cache it locally, and fall back to the legacy self-serve refresh token (this
// worker's own app) when the vault isn't wired yet or the streamer hasn't
// connected. This is the Aquilo-ID Phase-2 migration point.
const BROKER_VAULT_URL = 'https://auth.aquilo.gg/twitch/vault/token';
const USER_AUTH_KEY = 'twitch:user-auth-vault'; // { token, clientId, expiresAt }

export function isTwitchConfigured(env) {
  return !!(env && env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET);
}

// True iff we have everything required to mint a USER access token, // app-token isConfigured() returns true alone doesn't imply user-token
// subs can be created. Used by setupTwitchSubscriptions to skip
// user-token-requiring subs cleanly when only the app token is set.
// Async because KV reads are async, the OAuth self-serve flow stores
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
//, app token won't authorize the subscription.
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
  // Refresh, prefer the KV-rotated refresh token, fall back to env.
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

// Resolve a broadcaster's USER auth as { token, clientId } for a SPECIFIC
// Twitch channel — vault first (Aquilo ID), then (Clay only, allowLegacy) the
// legacy self-serve refresh token. Returning the clientId alongside the token
// is essential: a vault token is issued by the broker's app and 401s if sent
// with the wrong client_id. Cache is per-channel so multiple connected
// streamers don't clobber each other.
export async function getUserAuthFor(env, twitchId, allowLegacy) {
  const id = String(twitchId || env.CLAY_TWITCH_CHANNEL_ID || '');
  if (env.VAULT_SERVICE_SECRET && id) {
    const cacheKey = USER_AUTH_KEY + ':' + id;
    try {
      const cached = await env.LOADOUT_BOLTS.get(cacheKey, { type: 'json' });
      if (cached && cached.token && cached.clientId && cached.expiresAt > Date.now() + 60_000) {
        return { token: cached.token, clientId: cached.clientId, source: 'vault' };
      }
    } catch { /* ignore cache miss */ }
    try {
      const res = await fetch(BROKER_VAULT_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ service: env.VAULT_SERVICE_SECRET, twitchId: id, role: 'broadcaster' }),
      });
      if (res.ok) {
        const j = await res.json();
        if (j && j.ok && j.access_token && j.client_id) {
          const expiresAt = Number(j.expires_at) || (Date.now() + 3000 * 1000);
          const ttlS = Math.max(60, Math.floor((expiresAt - Date.now()) / 1000) - 60);
          await env.LOADOUT_BOLTS.put(cacheKey, JSON.stringify({ token: j.access_token, clientId: j.client_id, expiresAt }), { expirationTtl: ttlS });
          return { token: j.access_token, clientId: j.client_id, source: 'vault' };
        }
      }
    } catch { /* fall through to legacy */ }
  }
  // Legacy self-serve refresh token (this worker's own app) — Clay only.
  if (allowLegacy) {
    const token = await getUserAccessToken(env);
    if (token) return { token, clientId: env.TWITCH_CLIENT_ID, source: 'legacy' };
  }
  return null;
}

// Clay's broadcaster auth (used by helixFetch for his subs/bits reads).
export async function getUserAuth(env) {
  return getUserAuthFor(env, env.CLAY_TWITCH_CHANNEL_ID, true);
}

// Generic Helix fetch, handles the Bearer + Client-Id headers, one
// retry on 401 (token rotated under us). Returns the parsed JSON
// body or null on failure. Caller decides whether null is an error
// or a no-op.
//
// `opts.userToken: true` swaps in the user access token (for endpoints
// that require user-context auth, currently only used by EventSub
// subscription creation for the user-token-only topics).
export async function helixFetch(env, path, params, opts = {}) {
  if (!isTwitchConfigured(env)) return null;
  // User-context calls resolve { token, clientId } together — a vault token is
  // bound to the broker's app, so its client_id must travel with it. App-token
  // calls use this worker's own client_id.
  let token;
  let clientId = env.TWITCH_CLIENT_ID;
  if (opts.userToken) {
    const auth = await getUserAuth(env);
    if (!auth) return null;
    token = auth.token;
    clientId = auth.clientId;
  } else {
    token = await getAppAccessToken(env);
  }
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
      'Client-Id':     clientId,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(opts.body ? { body: typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body) } : {}),
  };
  let resp = await fetch(u.toString(), init);
  if (resp.status === 401) {
    // Token died under us, wipe caches + try once more with a fresh one.
    if (opts.userToken) {
      await env.LOADOUT_BOLTS.delete(USER_AUTH_KEY + ':' + String(env.CLAY_TWITCH_CHANNEL_ID || '')).catch(() => {});
      await env.LOADOUT_BOLTS.delete(USER_TOKEN_KEY).catch(() => {});
      const auth2 = await getUserAuth(env);
      if (!auth2) return null;
      init.headers['Authorization'] = 'Bearer ' + auth2.token;
      init.headers['Client-Id'] = auth2.clientId;
    } else {
      await env.LOADOUT_BOLTS.delete(TOKEN_KEY).catch(() => {});
      const fresh = await getAppAccessToken(env);
      if (!fresh) return null;
      init.headers['Authorization'] = 'Bearer ' + fresh;
    }
    resp = await fetch(u.toString(), init);
  }
  if (resp.status === 204) return { ok: true, status: 204 };
  let body = null;
  try { body = await resp.json(); } catch { /* not JSON */ }
  if (!resp.ok) {
    console.warn('[twitch-helix]', resp.status, path, body ? JSON.stringify(body).slice(0, 200) : '');
    // 2026-05-29, callers that need the actual Twitch error body to
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
// channels, we flatten that to null so callers can just `if (stream)`.
export async function getStreamInfo(env, broadcasterId) {
  const j = await helixFetch(env, '/streams', { user_id: broadcasterId });
  if (!j || !Array.isArray(j.data) || j.data.length === 0) return null;
  return j.data[0];
}

// Returns the broadcaster's CURRENTLY-SET category, { gameId, gameName,
// title }, which works even when the channel is OFFLINE (unlike
// getStreamInfo). Used by the death counter to know which game's
// counter to bump. null on error / not configured.
export async function getChannelGame(env, broadcasterId) {
  const j = await helixFetch(env, '/channels', { broadcaster_id: broadcasterId });
  if (!j || !Array.isArray(j.data) || j.data.length === 0) return null;
  const c = j.data[0];
  return { gameId: c.game_id || null, gameName: c.game_name || null, title: c.title || null };
}

// Returns the User object for a numeric broadcaster id (used to
// surface profile_image_url + display_name on the live embed).
export async function getUserById(env, userId) {
  const j = await helixFetch(env, '/users', { id: userId });
  if (!j || !Array.isArray(j.data) || j.data.length === 0) return null;
  return j.data[0];
}

// Returns clips created since `startedAtIso` (ISO 8601 string).
// Pagination ignored, for a 10-min polling window we'll never get
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

// Returns the broadcaster's most-recent ARCHIVE video (a past-broadcast
// VOD) or null. Used by the stream-offline path to drop the VOD link in
// the videos channel. `type=archive` filters out highlights/uploads;
// `sort=time` + `first=1` gives just the newest. null when VOD storage
// is off (no archives exist) or Twitch isn't configured.
export async function getRecentVod(env, broadcasterId) {
  const j = await helixFetch(env, '/videos', {
    user_id: broadcasterId,
    type:    'archive',
    sort:    'time',
    first:   1,
  });
  if (!j || !Array.isArray(j.data) || j.data.length === 0) return null;
  return j.data[0];
}

// ── Send a chat message (Helix) ───────────────────────────────────
//
// POST /helix/chat/messages as the broadcaster of a SPECIFIC channel (default
// Clay). Multi-tenant: resolves that channel's own auth (its vault token + the
// broker client_id, or Clay's legacy token) so any CONNECTED streamer's game
// events post in THEIR chat — and channels that haven't connected simply
// no-op. Requires user:write:chat on the token (in the connect scope union).
// Best-effort; returns { ok, ... }.
export async function sendChatMessage(env, text, opts = {}) {
  const chanId = String(opts.broadcasterId || env.CLAY_TWITCH_CHANNEL_ID || '');
  const msg = String(text || '').slice(0, 480).trim();
  if (!chanId || !msg) return { ok: false, skipped: 'unconfigured' };
  const isClay = env.CLAY_TWITCH_CHANNEL_ID && chanId === String(env.CLAY_TWITCH_CHANNEL_ID);
  const auth = await getUserAuthFor(env, chanId, isClay); // legacy fallback only for Clay
  if (!auth || !auth.token) return { ok: false, skipped: 'not-connected' };
  if (!isTwitchConfigured(env)) return { ok: false, skipped: 'unconfigured' };
  let resp;
  try {
    resp = await fetch('https://api.twitch.tv/helix/chat/messages', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + auth.token,
        'Client-Id': auth.clientId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ broadcaster_id: chanId, sender_id: String(opts.senderId || chanId), message: msg }),
    });
  } catch (e) { return { ok: false, skipped: 'fetch-failed' }; }
  if (!resp.ok) return { ok: false, status: resp.status };
  let j = null; try { j = await resp.json(); } catch { /* not JSON */ }
  const d = j && Array.isArray(j.data) ? j.data[0] : null;
  if (d && d.is_sent === false) return { ok: false, dropped: d.drop_reason };
  return { ok: true, id: d && d.message_id };
}

// ── EventSub subscriptions ────────────────────────────────────────
//
// Create a subscription for a given (type, condition) pair. Idempotent
// at the cost of an extra GET, caller can deduplicate via
// listSubscriptions() before posting. Twitch's POST itself rejects
// dupes with `409 Conflict`, which we treat as success here.
//
// `callbackUrl` is the public URL of THIS worker's /twitch/eventsub
// route. `secret` is the HMAC secret Twitch will use to sign every
// notification, must match env.TWITCH_EVENTSUB_SECRET on the
// worker side or signature verification will fail.
//
// `opts.userToken: true` mints the subscription under the broadcaster
// user OAuth token (required for channel.follow v2 / channel.subscribe
// / channel.cheer / channel.hype_train.* / channel.poll.* /
// channel.prediction.* / channel.channel_points_custom_reward_redemption.add
// / channel.ban/unban). `opts.version` overrides the default '1'
// (channel.follow now requires '2').
export async function createSubscription(env, type, condition, callbackUrl, secret, opts = {}) {
  // 2026-05-29 fix, webhook-transport EventSub ALWAYS uses the app
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
