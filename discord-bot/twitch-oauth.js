// Self-serve Twitch OAuth flow — Clay clicks one URL, authorizes the
// broadcaster account against the required EventSub scopes, and the
// worker persists the resulting refresh token to KV (the same key the
// existing twitch-helix.js getUserAccessToken reads as the primary
// source). After the token lands, we immediately call
// setupTwitchSubscriptions so every EventSub topic that requires user
// auth gets registered without a second round-trip from Clay.
//
// Two endpoints (both auth-gated, see worker.js wiring):
//   • /admin/_twitch-oauth-start/<bootstrapToken>
//     One-shot KV-token gate (same pattern as bootstrap-clay-batch).
//     Generates a CSRF state, writes it to KV with a 10-minute TTL,
//     302s the user-agent to id.twitch.tv/oauth2/authorize.
//
//   • /admin/twitch-oauth/callback?code=...&state=...
//     No HMAC — the CSRF state is the auth. Verifies state was issued,
//     deletes it on first use, exchanges the authorization code for
//     access + refresh tokens, persists refresh to KV, then calls
//     setupTwitchSubscriptions and returns an HTML summary page.
//
// KV keys used:
//   twitch-oauth:state:<state>            — CSRF nonce, 10-min TTL
//   twitch:user-refresh-helix             — refresh token (consumed by
//                                            twitch-helix.getUserAccessToken)
//
// The refresh token lives in KV (not as a worker secret) on purpose —
// Twitch rotates the refresh token on every exchange, and twitch-helix
// already writes the new value back to that same KV key. Persisting
// to a worker secret instead would require a privileged Cloudflare
// API call from inside the worker, which we don't want and don't need.

import { setupTwitchSubscriptions } from './twitch-eventsub.js';
import { isTwitchConfigured } from './twitch-helix.js';

const STATE_PREFIX     = 'twitch-oauth:state:';
const REFRESH_KEY      = 'twitch:user-refresh-helix';   // matches twitch-helix.js USER_REFRESH_KEY
const STATE_TTL_SEC    = 600;                            // 10 minutes
const TOKEN_KEY        = 'twitch:user-token-helix';      // matches twitch-helix.js USER_TOKEN_KEY
const BOOTSTRAP_KEY    = 'bootstrap-twitch-oauth-token'; // one-shot KV token gate

// Scopes — derived from twitch-eventsub.js buildWantTypes user-token
// subscriptions. The user:read:email scope isn't strictly required for
// any EventSub topic but is included so the access token can confirm
// the authenticated user against env.CLAY_TWITCH_CHANNEL_ID.
const REQUIRED_SCOPES = [
  'user:read:email',
  'moderator:read:followers',
  'channel:read:subscriptions',
  'bits:read',
  'channel:read:redemptions',
  'channel:read:hype_train',
  'channel:read:polls',
  'channel:read:predictions',
  'channel:moderate',
];

function publicWorkerOrigin(env) {
  return (env.PUBLIC_WORKER_URL || 'https://loadout-discord.aquiloplays.workers.dev').replace(/\/$/, '');
}

function callbackUrlFor(env) {
  return publicWorkerOrigin(env) + '/admin/twitch-oauth/callback';
}

function randomState() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── /admin/_twitch-oauth-start/:token ────────────────────────────
//
// One-shot bootstrap. The KV token gate is consumed on first hit so
// the start URL can't be replayed; if the OAuth flow then aborts mid-
// way, just re-mint via `wrangler kv key put bootstrap-twitch-oauth-token <value>`.
export async function handleTwitchOauthStart(req, env, token) {
  if (!isTwitchConfigured(env)) {
    return new Response('Twitch CLIENT_ID/SECRET not configured.', { status: 500 });
  }
  if (!token) return new Response('missing token', { status: 400 });

  const expected = await env.LOADOUT_BOLTS.get(BOOTSTRAP_KEY);
  if (!expected || expected !== token) {
    return new Response('bootstrap token invalid or already used', { status: 403 });
  }
  // Consume the bootstrap token so the start URL is one-shot.
  await env.LOADOUT_BOLTS.delete(BOOTSTRAP_KEY);

  const state = randomState();
  await env.LOADOUT_BOLTS.put(`${STATE_PREFIX}${state}`, '1',
    { expirationTtl: STATE_TTL_SEC });

  const url = new URL('https://id.twitch.tv/oauth2/authorize');
  url.searchParams.set('client_id',     env.TWITCH_CLIENT_ID);
  url.searchParams.set('redirect_uri',  callbackUrlFor(env));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope',         REQUIRED_SCOPES.join(' '));
  url.searchParams.set('state',         state);
  url.searchParams.set('force_verify',  'true');  // always show consent page so Clay confirms the broadcaster account

  return new Response(null, { status: 302, headers: { Location: url.toString() } });
}

// ── /admin/twitch-oauth/callback ─────────────────────────────────
//
// Twitch redirects the browser here after consent. The state CSRF
// nonce is the authorization — no HMAC, no bootstrap token needed.
// On success we persist the rotated refresh token, then chain straight
// into setupTwitchSubscriptions so the EventSub topics that required
// user auth all light up in the same trip.
export async function handleTwitchOauthCallback(req, env) {
  if (!isTwitchConfigured(env)) {
    return htmlPage('Twitch CLIENT_ID/SECRET not configured.', 500);
  }
  const u = new URL(req.url);
  const code  = u.searchParams.get('code');
  const state = u.searchParams.get('state');
  const error = u.searchParams.get('error');
  const errorDescription = u.searchParams.get('error_description');

  if (error) {
    return htmlPage(`Twitch returned an error: <code>${escapeHtml(error)}</code>` +
      (errorDescription ? `<br><br>${escapeHtml(errorDescription)}` : ''), 400);
  }
  if (!code || !state) {
    return htmlPage('Missing <code>code</code> or <code>state</code> in callback URL.', 400);
  }

  // Verify + consume the CSRF state. Single-use so a leaked state
  // can't be replayed.
  const stateKey = `${STATE_PREFIX}${state}`;
  const stateRec = await env.LOADOUT_BOLTS.get(stateKey);
  if (!stateRec) {
    return htmlPage('That OAuth state is unknown or expired. ' +
      'Start the flow again from a fresh bootstrap URL.', 400);
  }
  await env.LOADOUT_BOLTS.delete(stateKey);

  // Exchange the authorization code for tokens.
  const tokenParams = new URLSearchParams({
    client_id:     env.TWITCH_CLIENT_ID,
    client_secret: env.TWITCH_CLIENT_SECRET,
    code,
    grant_type:    'authorization_code',
    redirect_uri:  callbackUrlFor(env),
  });
  const tokenResp = await fetch('https://id.twitch.tv/oauth2/token', {
    method:  'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body:    tokenParams.toString(),
  });
  if (!tokenResp.ok) {
    const detail = (await tokenResp.text()).slice(0, 500);
    return htmlPage(
      `Token exchange failed (HTTP ${tokenResp.status}).<br><pre>${escapeHtml(detail)}</pre>`, 502);
  }
  const tokenJson = await tokenResp.json();
  if (!tokenJson.refresh_token || !tokenJson.access_token) {
    return htmlPage('Token exchange returned no refresh_token. ' +
      'Re-check the Twitch app\'s OAuth Redirect URL matches ' +
      `<code>${escapeHtml(callbackUrlFor(env))}</code>.`, 500);
  }

  // Persist the refresh token at the same KV key twitch-helix reads
  // from. Also clear the user-token cache so the very next call to
  // getUserAccessToken refreshes against the new token instead of
  // serving a stale cached one.
  await env.LOADOUT_BOLTS.put(REFRESH_KEY, tokenJson.refresh_token);
  await env.LOADOUT_BOLTS.delete(TOKEN_KEY);

  // Validate the access token so we can show Clay which Twitch
  // account they just authorized — guards against accidentally
  // wiring a different login than CLAY_TWITCH_CHANNEL_ID.
  let validation = null;
  try {
    const v = await fetch('https://id.twitch.tv/oauth2/validate', {
      headers: { Authorization: `OAuth ${tokenJson.access_token}` },
    });
    if (v.ok) validation = await v.json();
  } catch { /* non-fatal */ }

  // Auto-chain into setupTwitchSubscriptions so the user-token-only
  // topics all subscribe in the same hit Clay just authorized.
  let setup = null;
  try {
    setup = await setupTwitchSubscriptions(env);
  } catch (e) {
    setup = { ok: false, error: String(e?.message || e) };
  }

  return successPage({ env, validation, setup });
}

// ── HTML rendering helpers ───────────────────────────────────────

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function htmlPage(bodyHtml, status = 200) {
  const doc = `<!doctype html>
<html><head><meta charset="utf-8"><title>Twitch OAuth · Aquilo</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 720px; margin: 48px auto;
         padding: 0 16px; color: #e7e3ff; background: #0f0c1a; line-height: 1.5; }
  h1   { color: #a5b4fc; font-size: 22px; }
  code { background: #1c1730; padding: 2px 6px; border-radius: 4px; }
  pre  { background: #1c1730; padding: 12px; border-radius: 6px; overflow-x: auto;
         white-space: pre-wrap; word-break: break-all; }
  .ok    { color: #4ade80; }
  .warn  { color: #facc15; }
  .err   { color: #f87171; }
  ul   { padding-left: 20px; }
</style></head><body>${bodyHtml}</body></html>`;
  return new Response(doc, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function successPage({ env, validation, setup }) {
  const expectedBroadcaster = env.CLAY_TWITCH_CHANNEL_ID || null;
  const authorizedAs        = validation?.login || validation?.user_id || 'unknown';
  const matchOk             = expectedBroadcaster && validation?.user_id
    && String(validation.user_id) === String(expectedBroadcaster);

  const setupOk = setup?.ok;
  const created  = Array.isArray(setup?.created)  ? setup.created  : [];
  const existing = Array.isArray(setup?.existing) ? setup.existing : [];
  const failed   = Array.isArray(setup?.failed)   ? setup.failed   : [];
  const skipped  = Array.isArray(setup?.skipped)  ? setup.skipped  : [];

  const summary = setupOk
    ? `<p class="ok">EventSub subscriptions provisioned.</p>
       <ul>
         <li>Created: <strong>${created.length}</strong></li>
         <li>Already existed: <strong>${existing.length}</strong></li>
         <li>Failed: <strong>${failed.length}</strong></li>
         <li>Skipped: <strong>${skipped.length}</strong></li>
       </ul>`
    : `<p class="err">EventSub setup failed: <code>${escapeHtml(setup?.error || 'unknown')}</code></p>`;

  const failedList = failed.length
    ? `<h2>Failed</h2><ul>${failed.map(f =>
        `<li><code>${escapeHtml(f.type)}</code> — ${escapeHtml(f.reason)}</li>`).join('')}</ul>`
    : '';
  const skippedList = skipped.length
    ? `<h2>Skipped</h2><ul>${skipped.map(s =>
        `<li><code>${escapeHtml(s.type)}</code> — ${escapeHtml(s.reason)}</li>`).join('')}</ul>`
    : '';

  const matchBlock = expectedBroadcaster
    ? (matchOk
        ? `<p class="ok">Authorized account matches <code>CLAY_TWITCH_CHANNEL_ID</code>.</p>`
        : `<p class="warn">Authorized user_id <code>${escapeHtml(validation?.user_id || '?')}</code> ` +
          `does NOT match <code>CLAY_TWITCH_CHANNEL_ID=${escapeHtml(expectedBroadcaster)}</code>. ` +
          `Re-run the flow signed in as the broadcaster account.</p>`)
    : '';

  const body = `
<h1>Twitch OAuth — connected</h1>
<p>Authorized as: <code>${escapeHtml(authorizedAs)}</code></p>
${matchBlock}
${summary}
${failedList}
${skippedList}
<hr>
<p>You can close this tab. The bot is now subscribed to every event listed above.</p>`;
  return htmlPage(body, 200);
}
