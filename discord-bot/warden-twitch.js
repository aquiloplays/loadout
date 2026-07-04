// warden-twitch.js — Twitch token vault + low-level Helix mod ops (BE-1)
//
// The central-vault (auth.aquilo.gg broker) writes per-user Twitch tokens
// to shared KV LOADOUT_BOLTS at `vault:tw:<twitchId>`:
//
//   { twitchId, login, display_name, connectedAt, updatedAt,
//     broadcaster: { twitchId, login, display_name, access_token,
//                    refresh_token, expires_at, scope, updatedAt },
//     bot?: { …same shape } }
//
// vaultHelix() reads that record's broadcaster token, refreshes+persists
// when it's close to expiry (mirrors punchcard.js channelAccessToken),
// and calls Helix with Bearer + Client-Id, retrying once on 401.
//
// resolveActingToken() implements the HYBRID mod-auth model: prefer the
// acting MOD's OWN vault token (native attribution — Twitch enforces the
// mod actually mods that channel) when it carries the manage scope, else
// fall back to the broadcaster's token. All Helix WRITES route through it.
//
// Graceful-degrade: every op returns { ok:false, error, needsReconnect? }
// rather than throwing. A missing/scope-poor token → { needsReconnect:true }
// so the UI can prompt a re-connect instead of silently failing.

// The manage scope that lets a token act as a moderator on someone else's
// channel. If a token has this, it can ban/timeout/delete natively.
const MANAGE_SCOPE = 'moderator:manage:banned_users';

const VAULT_KEY = (id) => `vault:tw:${id}`;

// ── vault read/write ──────────────────────────────────────────────────
async function readVault(env, twitchId) {
  if (!env || !env.LOADOUT_BOLTS || !twitchId) return null;
  try {
    return await env.LOADOUT_BOLTS.get(VAULT_KEY(twitchId), { type: 'json' });
  } catch {
    return null;
  }
}

async function writeVault(env, twitchId, rec) {
  try {
    await env.LOADOUT_BOLTS.put(VAULT_KEY(twitchId), JSON.stringify(rec));
  } catch { /* best effort — a failed persist just means we refresh again next call */ }
}

// scope on a vault broadcaster/bot slot is stored as a space-joined
// string OR an array (broker versions differ). Normalise to a Set.
function scopeSet(slot) {
  if (!slot) return new Set();
  const raw = slot.scope;
  if (Array.isArray(raw)) return new Set(raw.map((s) => String(s)));
  if (typeof raw === 'string') return new Set(raw.split(/\s+/).filter(Boolean));
  return new Set();
}

function slotHasManageScope(slot) {
  return scopeSet(slot).has(MANAGE_SCOPE);
}

// Return a live access token for `twitchId`'s broadcaster slot, refreshing
// + persisting when expires_at is within 120s. { token, rec, slot } | null.
async function broadcasterToken(env, twitchId, force) {
  const rec = await readVault(env, twitchId);
  const slot = rec && rec.broadcaster;
  if (!slot || !slot.access_token) return null;
  const expMs = Number(slot.expires_at || 0);
  // expires_at may be epoch-seconds or epoch-millis depending on broker
  // version; normalise anything < 1e12 as seconds.
  const expiresAtMs = expMs > 0 && expMs < 1e12 ? expMs * 1000 : expMs;
  if (!force && expiresAtMs > Date.now() + 120_000) {
    return { token: slot.access_token, rec, slot };
  }
  if (!slot.refresh_token || !env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) {
    // Can't refresh — hand back the (possibly stale) token; the 401
    // retry path in vaultHelix will still surface needsReconnect.
    return slot.access_token ? { token: slot.access_token, rec, slot } : null;
  }
  const params = new URLSearchParams({
    client_id: env.TWITCH_CLIENT_ID,
    client_secret: env.TWITCH_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: slot.refresh_token,
  });
  let resp;
  try {
    resp = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
  } catch {
    return slot.access_token ? { token: slot.access_token, rec, slot } : null;
  }
  if (!resp.ok) {
    console.warn('[warden] vault token refresh failed', twitchId, resp.status);
    return null;
  }
  let j = null;
  try { j = await resp.json(); } catch { /* not JSON */ }
  if (!j || !j.access_token) return null;
  slot.access_token = j.access_token;
  slot.expires_at = Date.now() + Math.max(60, Number(j.expires_in || 0) - 120) * 1000;
  if (j.refresh_token) slot.refresh_token = j.refresh_token;  // Twitch rotates per exchange
  if (typeof j.scope !== 'undefined') slot.scope = j.scope;    // keep scope fresh
  slot.updatedAt = Date.now();
  rec.updatedAt = Date.now();
  await writeVault(env, twitchId, rec);
  return { token: slot.access_token, rec, slot };
}

// ── vaultHelix ────────────────────────────────────────────────────────
// Generic Helix call under `twitchId`'s broadcaster token. One retry on
// 401 (forced refresh). Returns { ok, status, data }. Never throws.
export async function vaultHelix(env, twitchId, path, { method = 'GET', params = null, body = null } = {}) {
  if (!env || !env.TWITCH_CLIENT_ID) return { ok: false, status: 0, data: { error: 'twitch-not-configured' } };
  let tok = await broadcasterToken(env, twitchId);
  if (!tok) return { ok: false, status: 0, data: { error: 'no-token' } };
  for (let attempt = 0; attempt < 2; attempt++) {
    const u = new URL('https://api.twitch.tv/helix' + path);
    for (const [k, v] of Object.entries(params || {})) {
      if (v != null) u.searchParams.set(k, String(v));
    }
    let resp;
    try {
      resp = await fetch(u.toString(), {
        method,
        headers: {
          'Authorization': 'Bearer ' + tok.token,
          'Client-Id': env.TWITCH_CLIENT_ID,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      return { ok: false, status: 0, data: { error: 'fetch-failed', message: String(e && e.message || e) } };
    }
    if (resp.status === 401 && attempt === 0) {
      tok = await broadcasterToken(env, twitchId, true);
      if (!tok) return { ok: false, status: 401, data: { error: 'token-expired' } };
      continue;
    }
    if (resp.status === 204) return { ok: true, status: 204, data: null };
    let data = null;
    try { data = await resp.json(); } catch { /* not JSON */ }
    return { ok: resp.ok, status: resp.status, data };
  }
  return { ok: false, status: 401, data: { error: 'token-expired' } };
}

// ── resolveActingToken (HYBRID) ───────────────────────────────────────
// 1. mod's OWN vault token, IF it carries moderator:manage:banned_users →
//    native attribution ({ token, moderatorId: actorModId, ownToken:true }).
// 2. else broadcaster's own token acting as itself
//    ({ token, moderatorId: streamerId, ownToken:false }).
// 3. neither usable → { needsReconnect:true }.
export async function resolveActingToken(env, streamerId, actorModId) {
  if (!env || !streamerId) return null;

  // 1. mod's own token with manage scope (native).
  if (actorModId && String(actorModId) !== String(streamerId)) {
    const modRec = await readVault(env, actorModId);
    if (modRec && slotHasManageScope(modRec.broadcaster)) {
      const tok = await broadcasterToken(env, actorModId);
      if (tok) {
        return { token: tok.token, moderatorId: String(actorModId), ownToken: true };
      }
    }
  }

  // 2. broadcaster acting as itself. Requires the broadcaster's own slot
  //    to carry the manage scope (streamers connected before the scope
  //    was added must re-connect).
  const bRec = await readVault(env, streamerId);
  if (bRec && slotHasManageScope(bRec.broadcaster)) {
    const tok = await broadcasterToken(env, streamerId);
    if (tok) {
      return { token: tok.token, moderatorId: String(streamerId), ownToken: false };
    }
  }

  // 3. nothing usable — a token exists but lacks scope, or none at all.
  if (bRec || (actorModId && await readVault(env, actorModId))) {
    return { needsReconnect: true };
  }
  return null;
}

// Low-level Helix call using an already-resolved acting token. Kept
// separate from vaultHelix (which is broadcaster-scoped) because writes
// carry an explicit moderator_id. One retry is not attempted here — the
// acting token was just resolved (fresh) by resolveActingToken.
async function actingHelix(env, token, path, { method = 'GET', params = null, body = null } = {}) {
  const u = new URL('https://api.twitch.tv/helix' + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v != null) u.searchParams.set(k, String(v));
  }
  let resp;
  try {
    resp = await fetch(u.toString(), {
      method,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Client-Id': env.TWITCH_CLIENT_ID,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    return { ok: false, status: 0, data: { error: 'fetch-failed', message: String(e && e.message || e) } };
  }
  if (resp.status === 204) return { ok: true, status: 204, data: null };
  let data = null;
  try { data = await resp.json(); } catch { /* not JSON */ }
  return { ok: resp.ok, status: resp.status, data };
}

// A resolved-token failure is authorization-shaped when Twitch rejects it
// (401/403) — surface needsReconnect so the mod re-auths.
function authFailed(status) {
  return status === 401 || status === 403;
}

// ── login → id ────────────────────────────────────────────────────────
// Resolve a Twitch login to its numeric id + display, via the app token
// (helixFetch in twitch-helix.js handles app-token caching). Returns
// { id, login, display } | null.
export async function loginToId(env, login) {
  const clean = String(login || '').trim().toLowerCase().replace(/^@/, '');
  if (!/^[a-z0-9_]{1,25}$/.test(clean)) return null;
  try {
    const { helixFetch } = await import('./twitch-helix.js');
    const j = await helixFetch(env, '/users', { login: clean });
    const u = j && Array.isArray(j.data) && j.data[0];
    if (!u || !u.id) return null;
    return { id: String(u.id), login: String(u.login || clean), display: String(u.display_name || u.login || clean) };
  } catch {
    return null;
  }
}

// Resolve targetId, preferring an explicit id, else looking up targetLogin.
async function resolveTargetId(env, targetId, targetLogin) {
  if (targetId && /^\d{1,20}$/.test(String(targetId))) return String(targetId);
  if (targetLogin) {
    const u = await loginToId(env, targetLogin);
    if (u) return u.id;
  }
  return null;
}

// ── Twitch mod ops (pinned signatures) ────────────────────────────────
// Each resolves the acting token, then hits the matching Helix endpoint,
// broadcaster_id = streamerId, moderator_id = resolved moderatorId.

// timeout (seconds present) or permaban (seconds absent). POST /moderation/bans
export async function twitchBan(env, streamerId, actorId, { targetId, targetLogin, seconds, reason } = {}) {
  const acting = await resolveActingToken(env, streamerId, actorId);
  if (!acting) return { ok: false, error: 'no-token', needsReconnect: true };
  if (acting.needsReconnect) return { ok: false, error: 'needs-reconnect', needsReconnect: true };
  const uid = await resolveTargetId(env, targetId, targetLogin);
  if (!uid) return { ok: false, error: 'unknown-target' };
  const data = { user_id: uid };
  const secs = Number(seconds);
  if (Number.isFinite(secs) && secs > 0) data.duration = Math.min(1209600, Math.max(1, Math.round(secs)));
  if (reason) data.reason = String(reason).slice(0, 500);
  const r = await actingHelix(env, acting.token, '/moderation/bans', {
    method: 'POST',
    params: { broadcaster_id: streamerId, moderator_id: acting.moderatorId },
    body: { data },
  });
  if (r.ok) return { ok: true };
  if (authFailed(r.status)) return { ok: false, error: 'unauthorized', needsReconnect: true };
  return { ok: false, error: (r.data && (r.data.message || r.data.error)) || `helix-${r.status}` };
}

// DELETE /moderation/bans?...&user_id=
export async function twitchUnban(env, streamerId, actorId, { targetId, targetLogin } = {}) {
  const acting = await resolveActingToken(env, streamerId, actorId);
  if (!acting) return { ok: false, error: 'no-token', needsReconnect: true };
  if (acting.needsReconnect) return { ok: false, error: 'needs-reconnect', needsReconnect: true };
  const uid = await resolveTargetId(env, targetId, targetLogin);
  if (!uid) return { ok: false, error: 'unknown-target' };
  const r = await actingHelix(env, acting.token, '/moderation/bans', {
    method: 'DELETE',
    params: { broadcaster_id: streamerId, moderator_id: acting.moderatorId, user_id: uid },
  });
  if (r.ok) return { ok: true };
  if (authFailed(r.status)) return { ok: false, error: 'unauthorized', needsReconnect: true };
  return { ok: false, error: (r.data && (r.data.message || r.data.error)) || `helix-${r.status}` };
}

// DELETE /moderation/chat?...&message_id=
export async function twitchDelete(env, streamerId, actorId, { messageId } = {}) {
  const acting = await resolveActingToken(env, streamerId, actorId);
  if (!acting) return { ok: false, error: 'no-token', needsReconnect: true };
  if (acting.needsReconnect) return { ok: false, error: 'needs-reconnect', needsReconnect: true };
  const mid = String(messageId || '');
  if (!/^[a-zA-Z0-9\-]{8,64}$/.test(mid)) return { ok: false, error: 'bad-message-id' };
  const r = await actingHelix(env, acting.token, '/moderation/chat', {
    method: 'DELETE',
    params: { broadcaster_id: streamerId, moderator_id: acting.moderatorId, message_id: mid },
  });
  if (r.ok) return { ok: true };
  if (authFailed(r.status)) return { ok: false, error: 'unauthorized', needsReconnect: true };
  return { ok: false, error: (r.data && (r.data.message || r.data.error)) || `helix-${r.status}` };
}

// DELETE /moderation/chat (no message_id) — clear entire chat.
export async function twitchClear(env, streamerId, actorId) {
  const acting = await resolveActingToken(env, streamerId, actorId);
  if (!acting) return { ok: false, error: 'no-token', needsReconnect: true };
  if (acting.needsReconnect) return { ok: false, error: 'needs-reconnect', needsReconnect: true };
  const r = await actingHelix(env, acting.token, '/moderation/chat', {
    method: 'DELETE',
    params: { broadcaster_id: streamerId, moderator_id: acting.moderatorId },
  });
  if (r.ok) return { ok: true };
  if (authFailed(r.status)) return { ok: false, error: 'unauthorized', needsReconnect: true };
  return { ok: false, error: (r.data && (r.data.message || r.data.error)) || `helix-${r.status}` };
}

// Map the suite's normalized settings object → Helix /chat/settings body.
// settings: { slow?, followers?, subscribers?, emote?, unique?, nonModDelay? }
//   slow: seconds (>0 on) | 0/false (off)
//   followers: minutes (>=0 on, min-follow duration) | false/null (off)
//   subscribers/emote/unique: bool
//   nonModDelay: seconds (2|4|6 on) | 0/false (off)
function modesToBody(settings) {
  const body = {};
  const s = settings || {};
  if ('slow' in s) {
    const v = Number(s.slow);
    if (Number.isFinite(v) && v > 0) { body.slow_mode = true; body.slow_mode_wait_time = Math.min(120, Math.max(3, Math.round(v))); }
    else body.slow_mode = false;
  }
  if ('followers' in s) {
    if (s.followers === false || s.followers == null) body.follower_mode = false;
    else {
      const v = Number(s.followers);
      body.follower_mode = true;
      body.follower_mode_duration = Number.isFinite(v) ? Math.min(129600, Math.max(0, Math.round(v))) : 0;
    }
  }
  if ('subscribers' in s) body.subscriber_mode = !!s.subscribers;
  if ('emote' in s) body.emote_mode = !!s.emote;
  if ('unique' in s) body.unique_chat_mode = !!s.unique;
  if ('nonModDelay' in s) {
    const v = Number(s.nonModDelay);
    if (Number.isFinite(v) && v > 0) { body.non_moderator_chat_delay = true; body.non_moderator_chat_delay_duration = [2, 4, 6].includes(Math.round(v)) ? Math.round(v) : 2; }
    else body.non_moderator_chat_delay = false;
  }
  return body;
}

// Map a Helix /chat/settings response → the suite's normalized shape.
function bodyToModes(data) {
  const d = (data && Array.isArray(data.data) && data.data[0]) || data || {};
  return {
    slow: d.slow_mode ? Number(d.slow_mode_wait_time || 0) : 0,
    followers: d.follower_mode ? Number(d.follower_mode_duration || 0) : false,
    subscribers: !!d.subscriber_mode,
    emote: !!d.emote_mode,
    unique: !!d.unique_chat_mode,
    nonModDelay: d.non_moderator_chat_delay ? Number(d.non_moderator_chat_delay_duration || 0) : 0,
  };
}

// PATCH /chat/settings — apply chat modes, returns resulting settings.
export async function twitchSetModes(env, streamerId, actorId, settings) {
  const acting = await resolveActingToken(env, streamerId, actorId);
  if (!acting) return { ok: false, error: 'no-token', needsReconnect: true };
  if (acting.needsReconnect) return { ok: false, error: 'needs-reconnect', needsReconnect: true };
  const r = await actingHelix(env, acting.token, '/chat/settings', {
    method: 'PATCH',
    params: { broadcaster_id: streamerId, moderator_id: acting.moderatorId },
    body: modesToBody(settings),
  });
  if (r.ok) return { ok: true, settings: bodyToModes(r.data) };
  if (authFailed(r.status)) return { ok: false, error: 'unauthorized', needsReconnect: true };
  return { ok: false, error: (r.data && (r.data.message || r.data.error)) || `helix-${r.status}` };
}

// GET /chat/settings — read current chat modes.
export async function twitchGetModes(env, streamerId, actorId) {
  const acting = await resolveActingToken(env, streamerId, actorId);
  if (!acting) return { ok: false, error: 'no-token', needsReconnect: true, settings: null };
  if (acting.needsReconnect) return { ok: false, error: 'needs-reconnect', needsReconnect: true, settings: null };
  const r = await actingHelix(env, acting.token, '/chat/settings', {
    method: 'GET',
    params: { broadcaster_id: streamerId, moderator_id: acting.moderatorId },
  });
  if (r.ok) return { ok: true, settings: bodyToModes(r.data) };
  if (authFailed(r.status)) return { ok: false, error: 'unauthorized', needsReconnect: true, settings: null };
  return { ok: false, error: (r.data && (r.data.message || r.data.error)) || `helix-${r.status}`, settings: null };
}
