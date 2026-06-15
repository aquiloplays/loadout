// dock.js
//
// Aquilo Dock backend. The dock is a single OBS browser source (or
// always-on browser tab) at aquilo.gg/dock that surfaces status + quick
// actions for every Aquilo product a streamer uses. This module owns
// the per-user "which tools are enabled" state and serves the public
// tool catalog.
//
// Endpoints (mounted in worker.js under /api/dock/*):
//
//   GET  /api/dock/registry
//     Public read of the tool catalog (id, name, blurb, glyph, tier
//     gate, admin path, marketing path). Static + cache-friendly so
//     the dock UI can render the "Available tools" drawer without a
//     round-trip for every tool's metadata.
//
//   GET  /api/dock/state/:userId
//     Owner-only read of the enabled-tool list + layout pref. Returns
//     { ok, enabledTools, layoutPref, tier, owner, limits, updatedAt }.
//     enabledTools is filtered to the tool ids that currently exist in
//     the registry so a removed module never returns a phantom card.
//
//   POST /api/dock/toggle/:toolId
//     Owner-only toggle. Body { userId, enabled? } where enabled is the
//     explicit target state; if omitted, flips the current value. The
//     toggle is the only mutation, so the layout pref + enabled list
//     have a single writer.
//
//   PUT  /api/dock/layout
//     Owner-only. Body { userId, layoutPref }. Saves the OBS-vs-popout
//     density preference. Kept separate from toggle so a layout flip
//     doesn't accidentally touch enabledTools.
//
// All write endpoints require the site HMAC envelope
// (x-aquilo-web-{ts,sig} signed with AQUILO_SITE_WEB_SECRET) plus the
// x-aquilo-owner-id / x-aquilo-owner-email forwarded by the site's
// /api/admin/dock/* proxies. The owner check is the strict v1 gate
// (Clay's discord id / email); the tier-limit shape below is the v2
// Patreon-gating hook so the UI can already show "you used 3 of 3 free
// slots" copy.
//
// D1 schema (lazily created on first hit):
//
//   CREATE TABLE dock_user_state (
//     user_id           TEXT PRIMARY KEY,
//     enabled_tools_json TEXT NOT NULL DEFAULT '[]',
//     layout_pref       TEXT NOT NULL DEFAULT 'compact',
//     created_at        INTEGER NOT NULL,
//     updated_at        INTEGER NOT NULL
//   );
//
// The enabled list is a JSON array of registry tool ids (small, max
// dozen entries) so we never have to migrate when a tool is added or
// removed. layout_pref is 'compact' (OBS 400px dock) or 'roomy'
// (popout tab).

const SCHEMA_VERSION = 1;
const USER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const TOOL_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_BODY = 16 * 1024;
const LAYOUT_PREFS = new Set(['compact', 'roomy']);

// Owner identity (matches scene-themer / overlay-canvas).
const OWNER_DISCORD_IDS = new Set(['1107161695262085210']);
const OWNER_EMAILS = new Set(['bisherclay@gmail.com']);

// Tier slot limits. Free is 3 enabled tools, T1 is 6, T2+ is unlimited.
// Owner short-circuits all limits. Limits are evaluated on enable; an
// existing enabled tool stays visible even if a downgrade pushes the
// count over the cap (the UI surfaces the over-limit warning).
const TIER_LIMITS = Object.freeze({
  free: { slots: 3 },
  t1:   { slots: 6 },
  t2:   { slots: Infinity },
  t3:   { slots: Infinity },
});
const TIER_RANK = { none: 0, free: 0, t1: 1, t2: 2, t3: 3 };

// Tool registry. Each tool is self-contained metadata the dock UI can
// use to render a card without any per-tool special-casing. Adding a
// new tool here makes it appear in "Available tools" on next reload,
// no code redeploy on the worker side and no migration on the site
// side. Keep the list sorted by surface area; the UI orders by id
// alphabetically for stable layout.
//
// Fields:
//   id           kebab-case stable handle (matches the front-end module name)
//   name         display label
//   blurb        one-line summary for the drawer
//   glyph        aurora glyph slug (front-end maps to an inline SVG)
//   adminPath    /something on aquilo.gg the "open admin" action links to
//   marketing    /free-tools/... or null for owner-only tools
//   ownerOnly    true = always hidden from non-owners regardless of tier
//   defaultEnabled  true = pre-checked in the setup wizard for new users
//   statusKind   how the front-end probes status (registry hint only;
//                the actual check lives in the front-end tool module)
const TOOL_REGISTRY = Object.freeze([
  {
    id: 'cam-border',
    name: 'Aquilo Cam Border',
    blurb: 'Owner-configurable webcam border overlay with live updates.',
    glyph: 'frame',
    adminPath: '/cam-border',
    marketing: '/free-tools/cam-border',
    ownerOnly: false,
    defaultEnabled: true,
    statusKind: 'worker',
  },
  {
    id: 'overlay-composer',
    name: 'Aquilo Overlay Composer',
    blurb: 'One OBS source, every widget. Drag-and-drop builder.',
    glyph: 'grid',
    adminPath: '/overlay-composer',
    marketing: '/free-tools/overlay-composer',
    ownerOnly: false,
    defaultEnabled: true,
    statusKind: 'worker',
  },
  {
    id: 'scene-themer',
    name: 'Aquilo Scene Themer',
    blurb: 'One scene, every game. Twitch category to source group.',
    glyph: 'palette',
    adminPath: '/scene-themer',
    marketing: '/free-tools/scene-themer',
    ownerOnly: false,
    defaultEnabled: true,
    statusKind: 'worker',
  },
  {
    id: 'streamkey-companion',
    name: 'Aquilo Streamkey Companion',
    blurb: 'Local tray app for TikTok key paste-into-Aitum flows.',
    glyph: 'key',
    adminPath: '/dock/streamkey/',
    marketing: '/free-tools/streamkey-companion',
    ownerOnly: false,
    defaultEnabled: false,
    statusKind: 'local',
  },
  {
    id: 'kindle-companion',
    name: 'Aquilo Kindle Companion',
    blurb: 'Browser extension that ingests Kindle highlights into the Vault.',
    glyph: 'book',
    adminPath: '/vault',
    marketing: null,
    ownerOnly: true,
    defaultEnabled: false,
    statusKind: 'local',
  },
  {
    id: 'knowledge-vault',
    name: 'Knowledge Vault',
    blurb: 'Private corpus + daily digest. Owner-only.',
    glyph: 'archive',
    adminPath: '/vault',
    marketing: null,
    ownerOnly: true,
    defaultEnabled: false,
    statusKind: 'worker',
  },
  {
    id: 'kitchen',
    name: 'Aquilo Kitchen',
    blurb: "This week's plan + weekly pick. Owner-only.",
    glyph: 'pot',
    adminPath: '/kitchen',
    marketing: null,
    ownerOnly: true,
    defaultEnabled: false,
    statusKind: 'worker',
  },
  {
    id: 'tikfinity-bridge',
    name: 'TikFinity / Streamer.bot bridge',
    blurb: 'Passive readout of bridge health for cross-platform events.',
    glyph: 'link',
    adminPath: '/dock/streamfusion-chat/',
    marketing: null,
    ownerOnly: false,
    defaultEnabled: false,
    statusKind: 'local',
  },
]);

const REGISTRY_IDS = new Set(TOOL_REGISTRY.map((t) => t.id));

class HttpError extends Error {
  constructor(status, code, extra) { super(code); this.status = status; this.code = code; this.extra = extra; }
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
  'access-control-allow-headers': 'content-type, x-aquilo-web-ts, x-aquilo-web-sig, x-aquilo-owner-id, x-aquilo-owner-email, x-aquilo-patreon-token',
};

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...CORS,
      ...extraHeaders,
    },
  });
}

async function readJson(request) {
  const len = Number(request.headers.get('content-length') || '0');
  if (len > MAX_BODY) throw new HttpError(413, 'too-large');
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'bad-json');
  }
}

async function verifyWebHmac(secret, ts, body, sigHex) {
  try {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
    );
    const cleanHex = String(sigHex || '').replace(/[^0-9a-fA-F]/g, '');
    if (cleanHex.length === 0 || cleanHex.length % 2 !== 0) return false;
    const buf = new Uint8Array(cleanHex.match(/.{1,2}/g).map((b) => parseInt(b, 16)));
    const msg = new TextEncoder().encode(`${ts}\n${body}`);
    return await crypto.subtle.verify('HMAC', key, buf, msg);
  } catch {
    return false;
  }
}

async function requireOwner(env, request, rawBody) {
  const wts = request.headers.get('x-aquilo-web-ts');
  const wsig = request.headers.get('x-aquilo-web-sig');
  if (wts && wsig && env.AQUILO_SITE_WEB_SECRET) {
    const stale = Math.abs(Date.now() / 1000 - Number(wts)) > 300;
    if (!stale) {
      const ok = await verifyWebHmac(env.AQUILO_SITE_WEB_SECRET, wts, rawBody || '', wsig);
      if (ok) {
        const ownerId = request.headers.get('x-aquilo-owner-id') || 'owner';
        const ownerEmail = (request.headers.get('x-aquilo-owner-email') || '').toLowerCase().trim();
        const patreonToken = request.headers.get('x-aquilo-patreon-token') || '';
        const isOwner = OWNER_DISCORD_IDS.has(String(ownerId)) || OWNER_EMAILS.has(ownerEmail);
        if (!isOwner) throw new HttpError(403, 'owner-required');
        return { ownerId, ownerEmail, patreonToken, owner: true };
      }
    }
  }
  if (env.DOCK_OWNER_OVERRIDE) {
    return {
      ownerId: String(env.DOCK_OWNER_OVERRIDE),
      ownerEmail: '',
      patreonToken: '',
      owner: true,
    };
  }
  throw new HttpError(401, 'owner-required');
}

async function resolveTier(env, who) {
  if (who && who.owner) {
    return { tier: 't3', owner: true, limits: TIER_LIMITS.t3 };
  }
  if (!who || !who.patreonToken) {
    return { tier: 'free', owner: false, limits: TIER_LIMITS.free };
  }
  try {
    const { getWidgetPresetAccess } = await import('./widget-presets.js');
    const access = await getWidgetPresetAccess(env, who.patreonToken);
    const raw = (access && access.tier) || 'none';
    const norm = raw === 'none' ? 'free' : raw;
    return { tier: norm, owner: false, limits: TIER_LIMITS[norm] || TIER_LIMITS.free };
  } catch {
    return { tier: 'free', owner: false, limits: TIER_LIMITS.free };
  }
}

async function ensureSchema(env) {
  if (!env.DB) return;
  try {
    await env.DB.exec(
      `CREATE TABLE IF NOT EXISTS dock_user_state (`
      + ` user_id TEXT PRIMARY KEY,`
      + ` enabled_tools_json TEXT NOT NULL DEFAULT '[]',`
      + ` layout_pref TEXT NOT NULL DEFAULT 'compact',`
      + ` created_at INTEGER NOT NULL,`
      + ` updated_at INTEGER NOT NULL`
      + `)`.replace(/\s+/g, ' ').trim(),
    );
  } catch (e) {
    console.warn('[dock] ensureSchema', e?.message || e);
  }
}

function parseEnabled(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(String(raw));
    if (!Array.isArray(arr)) return [];
    return arr
      .map((s) => String(s || '').toLowerCase())
      .filter((s) => TOOL_ID_RE.test(s) && REGISTRY_IDS.has(s));
  } catch {
    return [];
  }
}

function uniq(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function defaultEnabledFor(who) {
  return TOOL_REGISTRY
    .filter((t) => t.defaultEnabled && (!t.ownerOnly || (who && who.owner)))
    .map((t) => t.id);
}

function publicRegistryFor(who) {
  const ownerView = !!(who && who.owner);
  return TOOL_REGISTRY
    .filter((t) => ownerView || !t.ownerOnly)
    .map((t) => ({
      id: t.id,
      name: t.name,
      blurb: t.blurb,
      glyph: t.glyph,
      adminPath: t.adminPath,
      marketing: t.marketing,
      ownerOnly: t.ownerOnly,
      defaultEnabled: t.defaultEnabled,
      statusKind: t.statusKind,
    }));
}

async function loadState(env, userId) {
  if (!env.DB) {
    return { userId, enabledTools: [], layoutPref: 'compact', createdAt: 0, updatedAt: 0 };
  }
  await ensureSchema(env);
  const row = await env.DB
    .prepare(`SELECT user_id, enabled_tools_json, layout_pref, created_at, updated_at FROM dock_user_state WHERE user_id = ?`)
    .bind(userId)
    .first();
  if (!row) {
    return { userId, enabledTools: [], layoutPref: 'compact', createdAt: 0, updatedAt: 0 };
  }
  return {
    userId,
    enabledTools: parseEnabled(row.enabled_tools_json),
    layoutPref: LAYOUT_PREFS.has(row.layout_pref) ? row.layout_pref : 'compact',
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  };
}

async function saveState(env, state) {
  if (!env.DB) return;
  await ensureSchema(env);
  const now = Date.now();
  const created = state.createdAt || now;
  await env.DB
    .prepare(
      `INSERT INTO dock_user_state (user_id, enabled_tools_json, layout_pref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         enabled_tools_json = excluded.enabled_tools_json,
         layout_pref = excluded.layout_pref,
         updated_at = excluded.updated_at`,
    )
    .bind(state.userId, JSON.stringify(state.enabledTools || []), state.layoutPref || 'compact', created, now)
    .run();
}

function viewState(state, tierInfo) {
  // Hide owner-only tools from non-owners even if the row stored one.
  const ownerView = !!(tierInfo && tierInfo.owner);
  const visible = state.enabledTools.filter((id) => {
    const meta = TOOL_REGISTRY.find((t) => t.id === id);
    if (!meta) return false;
    if (meta.ownerOnly && !ownerView) return false;
    return true;
  });
  return {
    ok: true,
    userId: state.userId,
    enabledTools: visible,
    layoutPref: state.layoutPref,
    tier: tierInfo.tier,
    owner: tierInfo.owner,
    limits: {
      slots: tierInfo.limits.slots === Infinity ? null : tierInfo.limits.slots,
    },
    updatedAt: state.updatedAt,
    schemaVersion: SCHEMA_VERSION,
  };
}

// ── Route handlers ───────────────────────────────────────────────────

async function handleRegistry(req, env) {
  // Public read. The registry itself contains no secrets; ownerOnly
  // tools are still listed (with the flag) so the marketing page can
  // describe the full surface. The owner-state filter in /state hides
  // ownerOnly cards from non-owners' actual dock.
  return json({
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    tools: publicRegistryFor({ owner: false }),
    tierLimits: {
      free: TIER_LIMITS.free.slots,
      t1: TIER_LIMITS.t1.slots,
      t2: TIER_LIMITS.t2.slots === Infinity ? null : TIER_LIMITS.t2.slots,
      t3: TIER_LIMITS.t3.slots === Infinity ? null : TIER_LIMITS.t3.slots,
    },
  });
}

async function handleState(req, env, userId) {
  if (!USER_ID_RE.test(userId)) throw new HttpError(400, 'bad-user-id');
  const who = await requireOwner(env, req, '');
  const tierInfo = await resolveTier(env, who);
  let state = await loadState(env, userId);
  // First load for an owner -> seed the defaults so the wizard can
  // skip step 2 if they want.
  if (state.updatedAt === 0 && (state.enabledTools.length === 0)) {
    state = { ...state, enabledTools: defaultEnabledFor(who) };
  }
  return json(viewState(state, tierInfo));
}

async function handleToggle(req, env, toolId) {
  if (!TOOL_ID_RE.test(toolId)) throw new HttpError(400, 'bad-tool-id');
  if (!REGISTRY_IDS.has(toolId)) throw new HttpError(404, 'tool-not-found');
  const rawBody = await req.text();
  const body = rawBody ? JSON.parse(rawBody) : {};
  const userId = String(body.userId || '').toLowerCase();
  if (!USER_ID_RE.test(userId)) throw new HttpError(400, 'bad-user-id');

  const reqWithBody = new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: rawBody,
  });
  const who = await requireOwner(env, reqWithBody, rawBody);
  const tierInfo = await resolveTier(env, who);
  const meta = TOOL_REGISTRY.find((t) => t.id === toolId);
  if (meta.ownerOnly && !who.owner) throw new HttpError(403, 'owner-only');

  const state = await loadState(env, userId);
  const currently = state.enabledTools.includes(toolId);
  const target = typeof body.enabled === 'boolean' ? body.enabled : !currently;

  let nextList = state.enabledTools.slice();
  if (target) {
    // Enforce slot limits on enable. The owner bypass is already baked
    // into tierInfo.limits.slots (Infinity for t3+owner).
    if (!nextList.includes(toolId)) nextList.push(toolId);
    const limit = tierInfo.limits.slots;
    if (Number.isFinite(limit) && nextList.length > limit) {
      throw new HttpError(409, 'tier-slot-limit', { limit, currentTier: tierInfo.tier });
    }
  } else {
    nextList = nextList.filter((id) => id !== toolId);
  }
  nextList = uniq(nextList);
  const nextState = { ...state, enabledTools: nextList };
  await saveState(env, nextState);
  return json({
    ok: true,
    toolId,
    enabled: nextList.includes(toolId),
    ...viewState({ ...nextState, updatedAt: Date.now() }, tierInfo),
  });
}

async function handleLayout(req, env) {
  const rawBody = await req.text();
  const body = rawBody ? JSON.parse(rawBody) : {};
  const userId = String(body.userId || '').toLowerCase();
  if (!USER_ID_RE.test(userId)) throw new HttpError(400, 'bad-user-id');
  const layoutPref = String(body.layoutPref || 'compact').toLowerCase();
  if (!LAYOUT_PREFS.has(layoutPref)) throw new HttpError(400, 'bad-layout');

  const reqWithBody = new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: rawBody,
  });
  const who = await requireOwner(env, reqWithBody, rawBody);
  const tierInfo = await resolveTier(env, who);
  const state = await loadState(env, userId);
  const nextState = { ...state, layoutPref };
  await saveState(env, nextState);
  return json(viewState({ ...nextState, updatedAt: Date.now() }, tierInfo));
}

export async function handleDock(req, env, ctx, url) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  const path = (url && url.pathname) || new URL(req.url).pathname;
  try {
    if (path === '/api/dock/registry' && req.method === 'GET') {
      return await handleRegistry(req, env);
    }
    if (req.method === 'GET' && path.startsWith('/api/dock/state/')) {
      const userId = decodeURIComponent(path.slice('/api/dock/state/'.length)).toLowerCase();
      return await handleState(req, env, userId);
    }
    if (req.method === 'POST' && path.startsWith('/api/dock/toggle/')) {
      const toolId = decodeURIComponent(path.slice('/api/dock/toggle/'.length)).toLowerCase();
      return await handleToggle(req, env, toolId);
    }
    if (req.method === 'PUT' && path === '/api/dock/layout') {
      return await handleLayout(req, env);
    }
    return json({ ok: false, error: 'not-found' }, 404);
  } catch (e) {
    if (e instanceof HttpError) {
      return json({ ok: false, error: e.code, ...(e.extra || {}) }, e.status);
    }
    console.warn('[dock] error', e?.message || e);
    return json({ ok: false, error: 'internal' }, 500);
  }
}

// Exported so other modules can read the catalog without re-parsing.
export const DOCK_TOOL_REGISTRY = TOOL_REGISTRY;
export const DOCK_TIER_LIMITS = TIER_LIMITS;
