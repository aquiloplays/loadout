/**
 * Loadout Link Worker — additive routes for the existing
 * streamfusion-patreon-proxy worker. Drop these handlers into the existing
 * worker (or merge as a separate route under the same domain) and bind:
 *
 *   - LINK_KV (Workers KV namespace)         stores tokens + handle mappings
 *   - PATREON_CLIENT_ID                       env var (already used)
 *   - PATREON_CLIENT_SECRET                   env var (already used)
 *
 * Routes added:
 *
 *   POST /api/link/exchange
 *     body: { code, redirect_uri }
 *     -> exchanges the OAuth code, fetches identity + memberships, stores
 *        a session token in KV, returns { token, name, tier, handles }
 *
 *   POST /api/link/handles            (Authorization: Bearer <token>)
 *     body: { platform, handle }
 *     -> adds a platform handle to the supporter's list
 *
 *   DELETE /api/link/handles          (Authorization: Bearer <token>)
 *     body: { platform, handle }
 *     -> removes a platform handle
 *
 *   GET /api/link/lookup?platform=twitch&handle=foo
 *     -> { tier: "tier3" | "tier2" | "tier1" | null }    (anonymous, no auth)
 *
 * Token lifetime: 24 hours. Identity refresh runs server-side every 6h to
 * make sure cancellations propagate even if the supporter never re-opens the
 * page. Handle mappings are public-readable by tier, but the user's name
 * and Patreon ID are not exposed via /api/link/lookup.
 */

// ---- Shared helpers (use existing worker's secrets) -------------------------
const PATREON_TIER_IDS = {
  tier2: '28147937',     // $6 — Early Access
  tier3: '28147942'      // $10 — Contributor
};
const PATREON_CAMPAIGN_ID = '3410750';
const TOKEN_TTL_SEC = 24 * 60 * 60;
const SUPPORTED_PLATFORMS = ['twitch', 'youtube', 'kick', 'tiktok'];

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      ...init.headers
    }
  });
}
function corsPreflight() {
  return new Response(null, {
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization'
    }
  });
}
async function randomToken() {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return Array.from(buf).map(b => b.toString(16).padStart(2,'0')).join('');
}

// ---- Patreon API ------------------------------------------------------------
async function exchangeCode(env, code, redirectUri) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: env.PATREON_CLIENT_ID,
    client_secret: env.PATREON_CLIENT_SECRET
  });
  const r = await fetch('https://www.patreon.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!r.ok) throw new Error('Patreon token exchange failed: ' + await r.text());
  return await r.json();
}

async function fetchIdentity(accessToken) {
  const url = 'https://www.patreon.com/api/oauth2/v2/identity'
    + '?include=memberships,memberships.currently_entitled_tiers,memberships.campaign'
    + '&fields%5Buser%5D=full_name,email'
    + '&fields%5Bmember%5D=patron_status,currently_entitled_amount_cents';
  const r = await fetch(url, { headers: { 'authorization': 'Bearer ' + accessToken } });
  if (!r.ok) throw new Error('Patreon identity fetch failed: ' + await r.text());
  return await r.json();
}

function decideTier(identity) {
  const data = identity.data;
  const memRefs = (data?.relationships?.memberships?.data) || [];
  const included = identity.included || [];
  let tier = 'none';
  let patronStatus = null;
  for (const ref of memRefs) {
    const m = included.find(o => o.id === ref.id && o.type === 'member');
    if (!m) continue;
    if (m.relationships?.campaign?.data?.id !== PATREON_CAMPAIGN_ID) continue;
    patronStatus = m.attributes?.patron_status || patronStatus;
    const cents = m.attributes?.currently_entitled_amount_cents || 0;
    const tierIds = (m.relationships?.currently_entitled_tiers?.data || []).map(t => t.id);
    if (tierIds.includes(PATREON_TIER_IDS.tier3))      tier = 'tier3';
    else if (tierIds.includes(PATREON_TIER_IDS.tier2)) tier = 'tier2';
    else if (tier === 'none' && cents >= 1000) tier = 'tier3';
    else if (tier === 'none' && cents >= 600)  tier = 'tier2';
    else if (tier === 'none' && cents > 0)     tier = 'tier1';
  }
  const blocked = patronStatus === 'declined_patron' || patronStatus === 'former_patron';
  return blocked ? 'none' : tier;
}

// ---- KV layout --------------------------------------------------------------
//   token:<sessionToken>           → { patreonUserId, name, tier, exp }
//   user:<patreonUserId>           → { name, tier, handles: [{platform, handle}] }
//   handle:<platform>:<handle>     → patreonUserId   (lowercased)
//
// /api/link/lookup reads handle:<...> → user:<...>.tier in two reads. ~2ms total.

async function loadUser(env, patreonUserId) {
  const raw = await env.LINK_KV.get('user:' + patreonUserId);
  return raw ? JSON.parse(raw) : { name: '', tier: 'none', handles: [] };
}
async function saveUser(env, patreonUserId, user) {
  await env.LINK_KV.put('user:' + patreonUserId, JSON.stringify(user));
}
async function loadSession(env, token) {
  const raw = await env.LINK_KV.get('token:' + token);
  if (!raw) return null;
  const s = JSON.parse(raw);
  if (s.exp && Date.now() / 1000 > s.exp) return null;
  return s;
}
async function saveSession(env, token, session) {
  await env.LINK_KV.put('token:' + token, JSON.stringify(session), { expirationTtl: TOKEN_TTL_SEC });
}

// ---- Request handlers -------------------------------------------------------
async function handleExchange(req, env) {
  const { code, redirect_uri } = await req.json();
  if (!code || !redirect_uri) return jsonResponse({ error: 'missing code/redirect_uri' }, { status: 400 });

  const tok = await exchangeCode(env, code, redirect_uri);
  const ident = await fetchIdentity(tok.access_token);
  const patreonUserId = ident.data.id;
  const name = ident.data.attributes?.full_name || '';
  const tier = decideTier(ident);

  // Merge with existing handles, refresh tier.
  const user = await loadUser(env, patreonUserId);
  user.name = name;
  user.tier = tier;
  await saveUser(env, patreonUserId, user);

  // Mint a session token.
  const sessionToken = await randomToken();
  await saveSession(env, sessionToken, {
    patreonUserId, name, tier,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC
  });

  return jsonResponse({ token: sessionToken, name, tier, handles: user.handles });
}

async function handleAddHandle(req, env) {
  const session = await requireSession(req, env);
  if (session instanceof Response) return session;
  const { platform, handle } = await req.json();
  if (!SUPPORTED_PLATFORMS.includes(platform)) return jsonResponse({ error: 'bad platform' }, { status: 400 });
  const norm = (handle || '').trim().toLowerCase().replace(/^@+/, '');
  if (!norm || norm.length > 64 || !/^[\w._-]+$/.test(norm)) return jsonResponse({ error: 'bad handle' }, { status: 400 });

  const user = await loadUser(env, session.patreonUserId);
  user.handles = user.handles || [];
  if (!user.handles.some(h => h.platform === platform && h.handle === norm)) {
    user.handles.push({ platform, handle: norm });
  }
  await saveUser(env, session.patreonUserId, user);

  // Reverse index for fast lookup.
  await env.LINK_KV.put('handle:' + platform + ':' + norm, session.patreonUserId);

  return jsonResponse({ handles: user.handles });
}

async function handleDeleteHandle(req, env) {
  const session = await requireSession(req, env);
  if (session instanceof Response) return session;
  const { platform, handle } = await req.json();
  const norm = (handle || '').trim().toLowerCase().replace(/^@+/, '');

  const user = await loadUser(env, session.patreonUserId);
  user.handles = (user.handles || []).filter(h => !(h.platform === platform && h.handle === norm));
  await saveUser(env, session.patreonUserId, user);
  await env.LINK_KV.delete('handle:' + platform + ':' + norm);

  return jsonResponse({ handles: user.handles });
}

async function handleLookup(url, env) {
  const platform = (url.searchParams.get('platform') || '').toLowerCase();
  const handle = (url.searchParams.get('handle') || '').trim().toLowerCase().replace(/^@+/, '');
  if (!SUPPORTED_PLATFORMS.includes(platform) || !handle) return jsonResponse({ tier: null });

  const patreonUserId = await env.LINK_KV.get('handle:' + platform + ':' + handle);
  if (!patreonUserId) return jsonResponse({ tier: null });
  const user = await loadUser(env, patreonUserId);
  return jsonResponse({ tier: user.tier || 'none' });
}

async function requireSession(req, env) {
  const auth = req.headers.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return jsonResponse({ error: 'unauthorized' }, { status: 401 });
  const s = await loadSession(env, token);
  if (!s) return jsonResponse({ error: 'unauthorized' }, { status: 401 });
  return s;
}

// ---- Router fragment to merge into the existing worker ----------------------
//
// In your existing fetch handler, dispatch any path starting with /api/link/
// to handleLink(req, env). Everything else falls through to the existing
// proxy / recap routes.
//
// Example merge:
//   if (url.pathname.startsWith('/api/link/')) return handleLink(request, env);
//
export async function handleLink(request, env) {
  if (request.method === 'OPTIONS') return corsPreflight();
  const url = new URL(request.url);
  try {
    if (url.pathname === '/api/link/exchange' && request.method === 'POST') return handleExchange(request, env);
    if (url.pathname === '/api/link/handles' && request.method === 'POST')  return handleAddHandle(request, env);
    if (url.pathname === '/api/link/handles' && request.method === 'DELETE') return handleDeleteHandle(request, env);
    if (url.pathname === '/api/link/lookup'  && request.method === 'GET')   return handleLookup(url, env);
    return jsonResponse({ error: 'not found' }, { status: 404 });
  } catch (e) {
    return jsonResponse({ error: String(e?.message || e) }, { status: 500 });
  }
}
