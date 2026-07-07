// ── Warden: Kick moderation (Phase 2) ────────────────────────────────────
// Kick actions go live: ban / timeout / unban through Kick's public API,
// acting as the broadcaster. The token comes from the auth broker's vault
// (auth.aquilo.gg /kick/vault/token — the same flow the Aquilo Dock uses;
// the broker holds the client secret and refreshes in place). Message
// delete / clear have no public Kick API yet, so those kinds remain
// platform-unavailable for Kick.
//
// Identity notes: Kick timeouts are expressed in MINUTES (Twitch uses
// seconds); target logins are channel slugs, resolved to user ids via the
// channels endpoint.

const BROKER = 'https://auth.aquilo.gg';

async function kickToken(env, streamerId) {
  if (!env.VAULT_SERVICE_SECRET) return null;
  try {
    const r = await fetch(BROKER + '/kick/vault/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ service: env.VAULT_SERVICE_SECRET, twitchId: String(streamerId), role: 'broadcaster' }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return (j && j.access_token) ? j.access_token : null;
  } catch { return null; }
}

async function kickBroadcasterId(env, streamerId) {
  // The broker writes link:tw2kick:<twitchId> = kick user id at connect.
  try { return (await env.LOADOUT_BOLTS.get('link:tw2kick:' + String(streamerId))) || null; }
  catch { return null; }
}

async function kickResolveUser(token, login) {
  // Kick logins are channel slugs; channels?slug= resolves to the user id.
  try {
    const r = await fetch('https://api.kick.com/public/v1/channels?slug=' + encodeURIComponent(String(login).toLowerCase()), {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (!r.ok) return null;
    const j = await r.json();
    const c = j && j.data && j.data[0];
    return c ? String(c.broadcaster_user_id || c.user_id || '') : null;
  } catch { return null; }
}

async function kickModCall(env, streamerId, method, { targetId, targetLogin, seconds, reason } = {}) {
  const token = await kickToken(env, streamerId);
  if (!token) return { ok: false, error: 'kick-not-connected', needsReconnect: true, platform: 'kick' };
  const bid = await kickBroadcasterId(env, streamerId);
  if (!bid) return { ok: false, error: 'kick-not-connected', needsReconnect: true, platform: 'kick' };
  let userId = targetId || null;
  if (!userId && targetLogin) userId = await kickResolveUser(token, targetLogin);
  if (!userId || !/^\d+$/.test(String(userId))) return { ok: false, error: 'target-not-found', platform: 'kick' };
  const body = { broadcaster_user_id: Number(bid), user_id: Number(userId) };
  if (method === 'POST') {
    if (seconds) body.duration = Math.max(1, Math.round(Number(seconds) / 60));
    if (reason) body.reason = String(reason).slice(0, 100);
  }
  try {
    const r = await fetch('https://api.kick.com/public/v1/moderation/bans', {
      method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.status === 401 || r.status === 403) {
      // Token lacks the moderation scope — the streamer needs to reconnect
      // Kick on the broker with the newer scope set.
      return { ok: false, error: 'kick-scope', needsReconnect: true, platform: 'kick' };
    }
    if (!r.ok) return { ok: false, error: 'kick-' + r.status, platform: 'kick' };
    return { ok: true, platform: 'kick', targetId: String(userId) };
  } catch { return { ok: false, error: 'kick-unreachable', platform: 'kick' }; }
}

export async function kickBan(env, streamerId, opts) {
  return kickModCall(env, streamerId, 'POST', opts || {});
}

export async function kickUnban(env, streamerId, opts) {
  return kickModCall(env, streamerId, 'DELETE', opts || {});
}
