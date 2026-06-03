// Twitch OAuth, authorization code flow.
//
// Requires env.TWITCH_CLIENT_ID + env.TWITCH_CLIENT_SECRET (already
// set for the panel extension JWT verification). Scope is `user:read`
//, just need login + id.

const AUTH_URL = 'https://id.twitch.tv/oauth2/authorize';
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const USERS_URL = 'https://api.twitch.tv/helix/users';

export async function oauth_start(env, userId, returnUrl) {
  const callbackBase = env.PROGRESSION_CALLBACK_BASE
    || 'https://loadout-discord.aquiloplays.workers.dev';
  const clientId = env.TWITCH_CLIENT_ID;
  if (!clientId) return { ok: false, error: 'no-twitch-client-id' };
  const state = crypto.randomUUID();
  await env.LOADOUT_BOLTS.put(
    `plink:state:twitch:${state}`,
    JSON.stringify({ userId, returnUrl: returnUrl || '' }),
    { expirationTtl: 600 },
  );
  const ret = `${callbackBase}/web/profile/link/callback?platform=twitch&state=${state}`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: ret,
    response_type: 'code',
    scope: '',
    state,
  });
  return {
    ok: true,
    redirect: `${AUTH_URL}?${params.toString()}`,
  };
}

export async function oauth_callback(env, query) {
  const state = query.state;
  if (!state) return { ok: false, error: 'missing-state' };
  const stateRec = await env.LOADOUT_BOLTS.get(`plink:state:twitch:${state}`, { type: 'json' });
  if (!stateRec) return { ok: false, error: 'state-expired' };
  const { userId, returnUrl } = stateRec;
  const code = query.code;
  if (!code) return { ok: false, error: 'missing-code' };

  const callbackBase = env.PROGRESSION_CALLBACK_BASE
    || 'https://loadout-discord.aquiloplays.workers.dev';
  const ret = `${callbackBase}/web/profile/link/callback?platform=twitch&state=${state}`;
  const tokenResp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: ret,
    }).toString(),
  });
  if (!tokenResp.ok) return { ok: false, error: 'token-exchange-failed' };
  const tok = await tokenResp.json();
  const userResp = await fetch(USERS_URL, {
    headers: {
      'Authorization': `Bearer ${tok.access_token}`,
      'Client-Id': env.TWITCH_CLIENT_ID,
    },
  });
  if (!userResp.ok) return { ok: false, error: 'users-fetch-failed' };
  const userJson = await userResp.json();
  const u = userJson?.data?.[0];
  if (!u?.id) return { ok: false, error: 'no-user' };

  const { applyLink } = await import('../linking.js');
  const r = await applyLink(env, userId, 'twitch', {
    externalId: u.id,
    handle: u.login || '',
    displayName: u.display_name || '',
  });
  try { await env.LOADOUT_BOLTS.delete(`plink:state:twitch:${state}`); }
  catch { /* non-fatal */ }
  return { ...r, returnUrl };
}
