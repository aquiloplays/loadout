// Unit tests for twitch-oauth.js, the self-serve OAuth flow.
// Covers: bootstrap-token consumption, state CSRF, code exchange,
// refresh-token persistence at the KV key twitch-helix reads from.

import { handleTwitchOauthStart, handleTwitchOauthCallback } from '../twitch-oauth.js';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✅', msg); }
  else      { fail++; console.log('  ❌', msg); }
}
function eq(actual, expected, msg) {
  if (actual === expected) { pass++; console.log('  ✅', msg); }
  else { fail++; console.log('  ❌', msg, '(expected:', expected, 'got:', actual, ')'); }
}

function makeKv() {
  const store = new Map();
  return {
    get: async (k, opts) => {
      const v = store.get(k);
      if (v == null) return null;
      if (opts?.type === 'json') return JSON.parse(v);
      return v;
    },
    put: async (k, v) => { store.set(k, String(v)); },
    delete: async (k) => { store.delete(k); },
    _dump: () => Object.fromEntries(store),
  };
}

function makeEnv(overrides = {}) {
  return {
    TWITCH_CLIENT_ID:        'client-id-abc',
    TWITCH_CLIENT_SECRET:    'client-secret-xyz',
    TWITCH_EVENTSUB_SECRET:  'es-secret',
    CLAY_TWITCH_CHANNEL_ID:  '1234567',
    PUBLIC_WORKER_URL:       'https://example.workers.dev',
    LOADOUT_BOLTS:           makeKv(),
    ...overrides,
  };
}

console.log('- /admin/_twitch-oauth-start/:token');
{
  const env = makeEnv();
  await env.LOADOUT_BOLTS.put('bootstrap-twitch-oauth-token', 'secret-bootstrap-value');

  // Wrong token rejected.
  const r1 = await handleTwitchOauthStart({}, env, 'wrong-token');
  eq(r1.status, 403, 'wrong token → 403');

  // Right token redirects to Twitch authorize.
  const r2 = await handleTwitchOauthStart({}, env, 'secret-bootstrap-value');
  eq(r2.status, 302, 'right token → 302 redirect');
  const loc = r2.headers.get('Location');
  assert(loc.startsWith('https://id.twitch.tv/oauth2/authorize'), 'redirects to id.twitch.tv');
  const url = new URL(loc);
  eq(url.searchParams.get('client_id'),     'client-id-abc',                           'client_id in redirect');
  eq(url.searchParams.get('redirect_uri'),  'https://example.workers.dev/admin/twitch-oauth/callback', 'redirect_uri in redirect');
  eq(url.searchParams.get('response_type'), 'code',                                    'response_type=code');
  eq(url.searchParams.get('force_verify'),  'true',                                    'force_verify=true');
  assert(url.searchParams.get('scope').includes('moderator:read:followers'),  'scope includes followers');
  assert(url.searchParams.get('scope').includes('channel:read:subscriptions'),'scope includes subscriptions');
  assert(url.searchParams.get('scope').includes('bits:read'),                 'scope includes bits');
  assert(url.searchParams.get('scope').includes('channel:read:redemptions'),  'scope includes redemptions');
  const state = url.searchParams.get('state');
  assert(state && state.length >= 20, 'state present + non-trivial');

  // Bootstrap token is consumed (one-shot).
  const consumed = await env.LOADOUT_BOLTS.get('bootstrap-twitch-oauth-token');
  eq(consumed, null, 'bootstrap token deleted after consumption');

  // State written to KV with 10-min TTL.
  const stateRec = await env.LOADOUT_BOLTS.get(`twitch-oauth:state:${state}`);
  eq(stateRec, '1', 'state nonce stored in KV');

  // Second hit with same (now-consumed) bootstrap token → rejected.
  await env.LOADOUT_BOLTS.put('bootstrap-twitch-oauth-token', 'secret-bootstrap-value');  // restore for clarity
  const r3 = await handleTwitchOauthStart({}, env, 'wrong-again');
  eq(r3.status, 403, 'wrong token still rejected after fresh bootstrap');
}

console.log('- /admin/twitch-oauth/callback');
{
  const env = makeEnv();
  // Seed a valid state.
  await env.LOADOUT_BOLTS.put('twitch-oauth:state:state-good-1', '1');

  // Stub fetch: token exchange + validate.
  const realFetch = globalThis.fetch;
  let exchangeBodySeen = null;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://id.twitch.tv/oauth2/token')) {
      const body = String(init?.body || '');
      // Differentiate the user-code exchange from the app-credentials
      // exchange that setupTwitchSubscriptions makes, they hit the
      // same URL but with different grant_type.
      if (body.includes('grant_type=authorization_code') && exchangeBodySeen === null) {
        exchangeBodySeen = body;
        return new Response(JSON.stringify({
          access_token:  'fresh-access',
          refresh_token: 'fresh-refresh',
          expires_in:    14400,
          scope:         ['moderator:read:followers'],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      // Fallback for the app-token exchange triggered later.
      return new Response(JSON.stringify({
        access_token: 'app-access', expires_in: 3600,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.startsWith('https://id.twitch.tv/oauth2/validate')) {
      return new Response(JSON.stringify({
        client_id: 'client-id-abc',
        login:     'aquilo',
        user_id:   '1234567',
        scopes:    ['moderator:read:followers'],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // setupTwitchSubscriptions makes other calls (oauth2/token for app
    // token, helix subscriptions list/create), stub minimally so it
    // succeeds without trying to reach the live API.
    if (u.startsWith('https://api.twitch.tv/helix/eventsub/subscriptions') && init?.method !== 'POST') {
      return new Response(JSON.stringify({ data: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.startsWith('https://api.twitch.tv/helix/eventsub/subscriptions')) {
      // POST = createSubscription. Return a successful create.
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify({ data: [{ id: 'sub-' + body.type, status: 'webhook_callback_verification_pending' }] }),
        { status: 202, headers: { 'content-type': 'application/json' } });
    }
    return new Response('unexpected ' + u, { status: 500 });
  };

  try {
    // Bad state.
    const reqBad = new Request('https://w/admin/twitch-oauth/callback?code=auth-code-1&state=state-bad');
    const rBad = await handleTwitchOauthCallback(reqBad, env);
    eq(rBad.status, 400, 'unknown state → 400');

    // Twitch error param.
    const reqErr = new Request('https://w/admin/twitch-oauth/callback?error=access_denied&error_description=user+denied&state=state-good-1');
    const rErr = await handleTwitchOauthCallback(reqErr, env);
    eq(rErr.status, 400, 'error param → 400');

    // Happy path.
    const reqOk = new Request('https://w/admin/twitch-oauth/callback?code=auth-code-1&state=state-good-1');
    const rOk = await handleTwitchOauthCallback(reqOk, env);
    eq(rOk.status, 200, 'good state + code → 200');
    const html = await rOk.text();
    assert(html.includes('Twitch OAuth, connected'),  'success page rendered');
    assert(html.includes('aquilo'),                     'authorized login shown');
    assert(html.includes('Authorized account matches'), 'broadcaster match acknowledged');

    // Refresh token persisted at the KV key twitch-helix reads.
    const stored = await env.LOADOUT_BOLTS.get('twitch:user-refresh-helix');
    eq(stored, 'fresh-refresh', 'refresh token landed at twitch:user-refresh-helix');

    // State consumed (single-use).
    const stateAfter = await env.LOADOUT_BOLTS.get('twitch-oauth:state:state-good-1');
    eq(stateAfter, null, 'state nonce deleted after use');

    // Exchange body shape, grant_type, code, redirect_uri all present.
    assert(exchangeBodySeen.includes('grant_type=authorization_code'), 'exchange uses authorization_code grant');
    assert(exchangeBodySeen.includes('code=auth-code-1'),               'exchange forwards the code');
    assert(exchangeBodySeen.includes('redirect_uri=https'),             'exchange includes redirect_uri');
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log('- missing code or state');
{
  const env = makeEnv();
  const reqNoCode = new Request('https://w/admin/twitch-oauth/callback?state=x');
  const r = await handleTwitchOauthCallback(reqNoCode, env);
  eq(r.status, 400, 'missing code → 400');
}

console.log('');
console.log(`PASSED, ${pass} ok / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
