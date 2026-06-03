// Steam OpenID 2.0, sign-in flow.
//
// Steam doesn't offer OAuth, but their OpenID flow is stable + the
// industry standard. Round trip:
//   1. /web/profile/link/start?platform=steam&userId=<id>
//      → redirect to https://steamcommunity.com/openid/login with
//        return_to pointing at our callback.
//   2. /web/profile/link/callback?platform=steam&... (Steam appends
//      a bunch of openid.* params, including openid.identity which
//      contains the user's SteamID64).
//   3. We verify the response by POSTing openid.mode=check_authentication
//      back to Steam (no API key needed for sign-in).
//   4. (optional) Use STEAM_API_KEY to fetch the persona name from
//      the Steam Web API for display.
//
// Verification by check_authentication is the simplest path; we don't
// need to implement full OpenID Diffie-Hellman.

const STEAM_OPENID_URL = 'https://steamcommunity.com/openid/login';
const STEAM_IDENTITY_PREFIX = 'https://steamcommunity.com/openid/id/';

export async function oauth_start(env, userId, returnUrl) {
  const callbackBase = env.PROGRESSION_CALLBACK_BASE
    || 'https://loadout-discord.aquiloplays.workers.dev';
  // Stash userId + final returnUrl in a short-lived state record so
  // we can retrieve them when Steam redirects back (Steam's OpenID
  // round-trip doesn't carry custom state by default).
  const state = crypto.randomUUID();
  await env.LOADOUT_BOLTS.put(
    `plink:state:steam:${state}`,
    JSON.stringify({ userId, returnUrl: returnUrl || '' }),
    { expirationTtl: 600 },   // 10 min
  );
  const ret = `${callbackBase}/web/profile/link/callback?platform=steam&state=${state}`;
  const params = new URLSearchParams({
    'openid.ns':           'http://specs.openid.net/auth/2.0',
    'openid.mode':         'checkid_setup',
    'openid.return_to':    ret,
    'openid.realm':        callbackBase,
    'openid.identity':     'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id':   'http://specs.openid.net/auth/2.0/identifier_select',
  });
  return {
    ok: true,
    redirect: `${STEAM_OPENID_URL}?${params.toString()}`,
  };
}

export async function oauth_callback(env, query) {
  // Steam appends openid.* params; verify by re-posting them back.
  const state = query.state;
  if (!state) return { ok: false, error: 'missing-state' };
  const stateRecRaw = await env.LOADOUT_BOLTS.get(`plink:state:steam:${state}`, { type: 'json' });
  if (!stateRecRaw) return { ok: false, error: 'state-expired' };
  const { userId, returnUrl } = stateRecRaw;
  // check_authentication round trip.
  const verifyParams = new URLSearchParams();
  for (const k of Object.keys(query)) {
    if (k.startsWith('openid.')) verifyParams.append(k, query[k]);
  }
  verifyParams.set('openid.mode', 'check_authentication');
  const verifyResp = await fetch(STEAM_OPENID_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: verifyParams.toString(),
  });
  const verifyText = await verifyResp.text();
  if (!/is_valid:\s*true/i.test(verifyText)) {
    return { ok: false, error: 'invalid-openid-response' };
  }
  const claimed = query['openid.claimed_id'] || query['openid.identity'] || '';
  if (!claimed.startsWith(STEAM_IDENTITY_PREFIX)) {
    return { ok: false, error: 'unexpected-identity-prefix' };
  }
  const steamId64 = claimed.slice(STEAM_IDENTITY_PREFIX.length);
  // Optional persona fetch (requires STEAM_API_KEY). Best-effort.
  let persona = '';
  try {
    if (env.STEAM_API_KEY) {
      const r = await fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${env.STEAM_API_KEY}&steamids=${steamId64}`);
      if (r.ok) {
        const d = await r.json();
        persona = d?.response?.players?.[0]?.personaname || '';
      }
    }
  } catch { /* persona is decoration; link works without it */ }
  // Apply the link.
  const { applyLink } = await import('../linking.js');
  const r = await applyLink(env, userId, 'steam', {
    externalId: steamId64,
    handle: persona,
    displayName: persona,
  });
  // Clean up the state record.
  try { await env.LOADOUT_BOLTS.delete(`plink:state:steam:${state}`); }
  catch { /* non-fatal */ }
  return { ...r, returnUrl };
}
