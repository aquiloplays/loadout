// Aquilo account + cross-product settings, Cloudflare Worker module.
//
// One lightweight sign-in shared by every aquilo.gg product (Gift Guide,
// overlays, etc.) so a streamer's settings follow them across devices.
// FREE for anyone signed in; patron status is just a flag, never a gate.
//
// Two ways to sign in, both producing the same kind of session:
//   • Twitch  — full OAuth here, reusing the Twitch app already registered
//               in this worker. Its CSRF state carries the 'ac1.' prefix so
//               worker.js routes the shared /admin/twitch-oauth/callback to
//               us (never colliding with PunchCard's 'pc1.' or the admin
//               flow). NO new Twitch provisioning needed.
//   • Patreon — reuses aquilo-site's already-live Patreon login. That side
//               verifies the patron, then calls our /api/account/bridge
//               (shared-secret, server-to-server) to mint a session. It
//               unifies with Twitch when the Patreon account has a Twitch
//               social connection (same uid).
//
// Token model mirrors PunchCard's viewer sessions: a random bearer token
// stored in KV, handed to the client via a one-time code (#acct=<code>),
// then sent as `Authorization: Bearer <token>`. No cookies → works
// cross-origin from any *.aquilo.gg product with zero CORS cookie pain.
//
// Routes (mounted in worker.js):
//   GET  /api/account/oauth/start?provider=twitch&return=<url>
//   POST /api/account/oauth/finish   { code }      -> { token, uid, ... }
//   GET  /api/account/me             (Bearer)      -> identity
//   POST /api/account/logout         (Bearer)
//   POST /api/account/bridge         { secret, ... } (aquilo-site → here)
//   GET  /api/settings/<product>     (Bearer)      -> saved JSON or {}
//   PUT  /api/settings/<product>     (Bearer, JSON body)
//
// KV (LOADOUT_BOLTS), keys prefixed acct:
//   acct:sess:<tok>            session { uid, provider, login, display, avatar, patron, iat }
//   acct:code:<code>           one-time handover (300s)
//   acct:oauth:<state>         CSRF state (600s)
//   acct:set:<uid>:<product>   the product's saved settings blob

const STATE_PREFIX = 'ac1.';
const SESS_TTL = 30 * 24 * 3600;   // 30 days
const CODE_TTL = 300;
const STATE_TTL = 600;
const MAX_SETTINGS = 64 * 1024;    // 64 KB per product blob

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS },
  });
}
function genHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function kvGet(env, key) {
  try { return await env.LOADOUT_BOLTS.get(key, { type: 'json' }); } catch { return null; }
}
async function kvPut(env, key, val, opts) {
  await env.LOADOUT_BOLTS.put(key, JSON.stringify(val), opts || {});
}

const KEY = {
  sess: (t) => `acct:sess:${t}`,
  code: (c) => `acct:code:${c}`,
  oauth: (s) => `acct:oauth:${s}`,
  set: (uid, p) => `acct:set:${uid}:${p}`,
};

function workerOrigin(env) {
  return (env.PUBLIC_WORKER_URL || 'https://loadout-discord.aquiloplays.workers.dev').replace(/\/$/, '');
}
// Must byte-match the Twitch app's registered redirect (shared with the
// admin + PunchCard flows).
function callbackUrl(env) {
  return workerOrigin(env) + '/admin/twitch-oauth/callback';
}

function cleanText(s, n) {
  return String(s || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, n || 60);
}
function validProduct(s) {
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(String(s || '')) ? String(s) : null;
}
// Only ever bounce back to our own properties.
function safeReturn(raw, env) {
  try {
    const u = new URL(String(raw || ''));
    const host = u.hostname.toLowerCase();
    const ok = host === 'aquilo.gg' || host.endsWith('.aquilo.gg') ||
               host === 'localhost' || host === '127.0.0.1';
    if (ok && (u.protocol === 'https:' || host === 'localhost' || host === '127.0.0.1')) return u.toString();
  } catch { /* fall through */ }
  return (env.PUBLIC_SITE_URL || 'https://aquilo.gg').replace(/\/$/, '') + '/';
}

// ── session helpers ────────────────────────────────────────────────────
async function sessionFrom(req, env) {
  const h = req.headers.get('authorization') || '';
  const m = /^Bearer\s+([a-f0-9]{24,64})$/i.exec(h.trim());
  if (!m) return null;
  const sess = await kvGet(env, KEY.sess(m[1]));
  if (sess) sess._tok = m[1];
  return sess;
}

// Mint a session + a one-time handover code; return the code. Used by both
// the Twitch callback and the Patreon bridge so the client picks it up the
// same way (#acct=<code> → POST /oauth/finish).
async function mintSessionCode(env, identity) {
  const token = genHex(24);
  const sess = {
    uid: identity.uid,
    provider: identity.provider,
    login: identity.login || '',
    display: identity.display || identity.login || '',
    avatar: identity.avatar || null,
    patron: !!identity.patron,
    iat: Date.now(),
  };
  await kvPut(env, KEY.sess(token), sess, { expirationTtl: SESS_TTL });
  const code = genHex(20);
  await kvPut(env, KEY.code(code), { token, ...publicIdentity(sess) }, { expirationTtl: CODE_TTL });
  return code;
}
function publicIdentity(sess) {
  return {
    uid: sess.uid, provider: sess.provider, login: sess.login,
    display: sess.display, avatar: sess.avatar, patron: !!sess.patron,
  };
}

// ── Twitch OAuth ───────────────────────────────────────────────────────
async function handleOauthStart(env, url) {
  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) {
    return json({ ok: false, error: 'twitch-not-configured' }, 500);
  }
  const ret = safeReturn(url.searchParams.get('return'), env);
  const state = STATE_PREFIX + genHex(16);
  await kvPut(env, KEY.oauth(state), { provider: 'twitch', ret }, { expirationTtl: STATE_TTL });

  const a = new URL('https://id.twitch.tv/oauth2/authorize');
  a.searchParams.set('client_id', env.TWITCH_CLIENT_ID);
  a.searchParams.set('redirect_uri', callbackUrl(env));
  a.searchParams.set('response_type', 'code');
  a.searchParams.set('scope', '');          // identity only — we just need who they are
  a.searchParams.set('state', state);
  return new Response(null, { status: 302, headers: { Location: a.toString(), ...CORS } });
}

// Routed from worker.js when the callback state starts with 'ac1.'.
export async function handleAccountOauthCallback(req, env) {
  const u = new URL(req.url);
  const code = u.searchParams.get('code');
  const state = u.searchParams.get('state') || '';
  const err = u.searchParams.get('error');

  const rec = await kvGet(env, KEY.oauth(state));
  if (rec) await env.LOADOUT_BOLTS.delete(KEY.oauth(state)).catch(() => {});
  const ret = (rec && rec.ret) || ((env.PUBLIC_SITE_URL || 'https://aquilo.gg') + '/');

  const bounce = (frag) => new Response(null, { status: 302, headers: { Location: ret + (frag.startsWith('#') ? '' : '#') + frag } });
  if (err) return bounce('#accterr=' + encodeURIComponent(err));
  if (!rec || !code) return bounce('#accterr=expired');

  const tokenResp = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: callbackUrl(env),
    }).toString(),
  });
  if (!tokenResp.ok) return bounce('#accterr=exchange');
  const tok = await tokenResp.json();
  if (!tok.access_token) return bounce('#accterr=exchange');

  const meResp = await fetch('https://api.twitch.tv/helix/users', {
    headers: { 'Authorization': 'Bearer ' + tok.access_token, 'Client-Id': env.TWITCH_CLIENT_ID },
  });
  const meJson = meResp.ok ? await meResp.json() : null;
  const me = meJson && meJson.data && meJson.data[0];
  if (!me || !me.id) return bounce('#accterr=identity');

  // We don't store the Twitch token; we only needed the identity.
  const codeOut = await mintSessionCode(env, {
    uid: 'tw:' + String(me.id),
    provider: 'twitch',
    login: String(me.login || '').toLowerCase(),
    display: cleanText(me.display_name || me.login, 40),
    avatar: me.profile_image_url || null,
    patron: false,
  });
  return bounce('#acct=' + codeOut);
}

// Exchange the one-time handover code for the real bearer token + identity.
async function handleOauthFinish(env, body) {
  const code = String(body.code || '');
  if (!/^[a-f0-9]{20,64}$/.test(code)) return json({ ok: false, error: 'bad-code' }, 400);
  const rec = await kvGet(env, KEY.code(code));
  if (!rec) return json({ ok: false, error: 'expired' }, 404);
  await env.LOADOUT_BOLTS.delete(KEY.code(code)).catch(() => {});
  return json({ ok: true, ...rec });
}

// ── Patreon bridge (aquilo-site → here, shared secret) ──────────────────
// aquilo-site verifies the aq_link Patreon session, then posts the derived
// identity here so a Patreon sign-in produces the same kind of account
// session. uid is unified to tw:<id> when the Patreon account has a Twitch
// connection (resolved site-side), else pat:<patreonId>.
async function handleBridge(env, body) {
  const secret = env.ACCOUNT_BRIDGE_SECRET;
  if (!secret || body.secret !== secret) return json({ ok: false, error: 'forbidden' }, 403);
  const uid = String(body.uid || '');
  if (!/^(tw|pat|dc):[a-z0-9_]{1,40}$/i.test(uid)) return json({ ok: false, error: 'bad-uid' }, 400);
  const code = await mintSessionCode(env, {
    uid: uid.toLowerCase(),
    provider: 'patreon',
    login: cleanText(body.login, 40),
    display: cleanText(body.display || body.login, 40),
    avatar: body.avatar || null,
    patron: !!body.patron,
  });
  return json({ ok: true, code });
}

// ── identity / session ─────────────────────────────────────────────────
async function handleMe(req, env) {
  const sess = await sessionFrom(req, env);
  if (!sess) return json({ signedIn: false });
  return json({ signedIn: true, ...publicIdentity(sess) });
}
async function handleLogout(req, env) {
  const sess = await sessionFrom(req, env);
  if (sess && sess._tok) await env.LOADOUT_BOLTS.delete(KEY.sess(sess._tok)).catch(() => {});
  return json({ ok: true });
}

// ── per-product settings ───────────────────────────────────────────────
async function handleSettingsGet(req, env, product) {
  const p = validProduct(product);
  if (!p) return json({ ok: false, error: 'bad-product' }, 400);
  const sess = await sessionFrom(req, env);
  if (!sess) return json({ ok: false, error: 'signin' }, 401);
  const data = await kvGet(env, KEY.set(sess.uid, p));
  return json({ ok: true, product: p, data: data || null });
}
async function handleSettingsPut(req, env, product) {
  const p = validProduct(product);
  if (!p) return json({ ok: false, error: 'bad-product' }, 400);
  const sess = await sessionFrom(req, env);
  if (!sess) return json({ ok: false, error: 'signin' }, 401);
  let text;
  try { text = await req.text(); } catch { return json({ ok: false, error: 'bad-body' }, 400); }
  if (text.length > MAX_SETTINGS) return json({ ok: false, error: 'too-large' }, 413);
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { return json({ ok: false, error: 'bad-json' }, 400); }
  await kvPut(env, KEY.set(sess.uid, p), data);
  return json({ ok: true, product: p });
}

// ── dispatchers (mounted in worker.js) ─────────────────────────────────
export async function handleAccount(req, env, path) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const route = path.replace(/^\/api\/account\//, '').replace(/\/+$/, '');
  try {
    if (req.method === 'GET' && route === 'oauth/start') return await handleOauthStart(env, url);
    if (req.method === 'GET' && route === 'me') return await handleMe(req, env);
    if (req.method === 'POST') {
      let body = {};
      try { const t = await req.text(); body = t ? JSON.parse(t) : {}; } catch { return json({ ok: false, error: 'bad-json' }, 400); }
      if (route === 'oauth/finish') return await handleOauthFinish(env, body);
      if (route === 'logout') return await handleLogout(req, env);
      if (route === 'bridge') return await handleBridge(env, body);
    }
    return json({ ok: false, error: 'not-found' }, 404);
  } catch (e) {
    console.warn('[account]', route, String(e && e.message || e).slice(0, 200));
    return json({ ok: false, error: 'internal' }, 500);
  }
}

export async function handleSettings(req, env, path) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const product = path.replace(/^\/api\/settings\//, '').replace(/\/+$/, '');
  try {
    if (req.method === 'GET') return await handleSettingsGet(req, env, product);
    if (req.method === 'PUT') return await handleSettingsPut(req, env, product);
    return json({ ok: false, error: 'method' }, 405);
  } catch (e) {
    console.warn('[settings]', product, String(e && e.message || e).slice(0, 200));
    return json({ ok: false, error: 'internal' }, 500);
  }
}
