// scene-themer.js
//
// Free-tools product: one OBS scene, many themed source groups, swap by
// active Twitch category. The streamer keeps a single base scene (default
// name "Game") in OBS containing source groups like theme_fallout,
// theme_elden_ring, theme_default. They map "Twitch category -> group"
// here; the worker resolves the active group from the broadcaster's live
// category and the OBS-side Streamer.bot poll toggles which group is
// visible. Zero scene-switching, completely different look per game from
// one scene.
//
// Wire-up in worker.js (right after the overlay-canvas block at ~L780):
//   if (path.startsWith('/api/scene-themer/')) {
//     const { handleSceneThemer } = await import('./scene-themer.js');
//     return handleSceneThemer(req, env, ctx, url);
//   }
//
// And from twitch-eventsub.js, dispatch channel.update notifications by
// calling:
//   const { handleChannelUpdate } = await import('./scene-themer.js');
//   await handleChannelUpdate(env, payload);
// so the worker remembers the current category per broadcaster (and pushes
// to the optional Streamer.bot webhook for instant swaps).
//
// Routes (all paths begin /api/scene-themer/):
//
//   GET /api/scene-themer/config/:id
//     Public read of the mapping config. Used by the admin UI to load and
//     by anyone forking a template later (v2).
//
//   PUT /api/scene-themer/config/:id   (owner, HMAC)
//     Replace the mapping config. Validates against tier limits, precomputes
//     the category-id -> group lookup, indexes the config by broadcaster id
//     so /active/:broadcaster is an O(1) read.
//
//   GET /api/scene-themer/configs?owner=<id>   (owner)
//     List configs the owner has saved.
//
//   GET /api/scene-themer/active/:broadcaster
//     The Streamer.bot poll target. Resolves the current Twitch category
//     for that broadcaster (cached via channel.update + helix fallback),
//     looks up the configured group, returns { group, scene, source,
//     category, customOps }. Returns 404-shape JSON { ok: false } if no
//     mapping exists; SB swallows it and leaves the current state in place.
//
//   GET /api/scene-themer/categories?q=...   (owner)
//     Twitch Helix search/categories autocomplete passthrough so the admin
//     UI can pick real game ids without exposing the Twitch app token to
//     the browser. Cached 24h in LOADOUT_BOLTS under helix:cat:<q>.
//
//   POST /api/scene-themer/test/:id   (owner)
//     Simulate a category change without affecting live stream. The body
//     contains { categoryId, categoryName }; we DO NOT write
//     scene-themer:current-cat:<broadcaster>, we just resolve and return
//     what the live response WOULD be. The admin UI uses this for the
//     "Test mapping" button.
//
// Tier model (enforced server-side on PUT):
//   free : up to 5 mappings per config, visibility commands only
//   t1   : up to 15 mappings, visibility commands only
//   t2   : unlimited mappings, custom OBS WebSocket commands per mapping
//          (opacity, filter toggles, raw WS calls)
//   t3   : same as t2 + can mark the config as a featured community
//          template (template page lives in v2; the row column is wired)
//   Owner bypass: Clay's discord id and email skip every limit.

import { getTwitchAppToken, helixGet } from './ext-loadout.js';

const SCHEMA_VERSION = 1;
const MAX_BODY = 32 * 1024;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SCENE_NAME_MAX = 64;
const GROUP_NAME_MAX = 64;
const LABEL_MAX = 80;
const CATEGORY_NAME_MAX = 80;
const WEBHOOK_URL_MAX = 512;
const TWITCH_ID_RE = /^[0-9]{1,32}$/;
const CATEGORY_ID_RE = /^[0-9]{1,32}$/;

// Owner identity (matches overlay-canvas.js + widget-presets.js).
const OWNER_DISCORD_IDS = new Set(['1107161695262085210']);
const OWNER_EMAILS = new Set(['bisherclay@gmail.com']);

const TIER_LIMITS = Object.freeze({
  free: { mappings: 5, customOps: false, featurable: false, webhookPush: false },
  t1:   { mappings: 15, customOps: false, featurable: false, webhookPush: true },
  t2:   { mappings: Infinity, customOps: true, featurable: false, webhookPush: true },
  t3:   { mappings: Infinity, customOps: true, featurable: true, webhookPush: true },
});

const TIER_RANK = { free: 0, t1: 1, t2: 2, t3: 3 };

class HttpError extends Error {
  constructor(status, code, extra) { super(code); this.status = status; this.code = code; this.extra = extra; }
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

function validSlug(s) { return typeof s === 'string' && SLUG_RE.test(s); }

// Em dash scrubber. Project rule: no em dashes anywhere in user-visible
// strings. Replaces U+2014 (em dash) and U+2013 (en dash) with a spaced
// hyphen. Character classes use Unicode escapes so this file stays
// em-dash-free itself.
const EM_DASH_RE = new RegExp('[\\u2014\\u2013]', 'g');
function scrubEmDash(s) {
  if (typeof s !== 'string') return s;
  return s.replace(EM_DASH_RE, ' - ');
}
function scrubDeep(value) {
  if (value == null) return value;
  if (typeof value === 'string') return scrubEmDash(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v);
    return out;
  }
  return value;
}

// ── HMAC owner envelope ──────────────────────────────────────────────
// Identical wire format to cam-border / overlay-canvas: the site signs
// `${ts}\n${rawBody}` with AQUILO_SITE_WEB_SECRET, sends headers
// x-aquilo-web-{ts,sig}, plus x-aquilo-owner-id / email / patreon-token.

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
        return { ownerId, ownerEmail, patreonToken };
      }
    }
  }
  if (env.SCENE_THEMER_OWNER_OVERRIDE) {
    return {
      ownerId: String(env.SCENE_THEMER_OWNER_OVERRIDE),
      ownerEmail: '',
      patreonToken: '',
    };
  }
  throw new HttpError(401, 'owner-required');
}

async function resolveTier(env, who) {
  const isOwner = OWNER_DISCORD_IDS.has(String(who.ownerId)) || OWNER_EMAILS.has(who.ownerEmail);
  if (isOwner) {
    return { tier: 't3', owner: true, limits: TIER_LIMITS.t3 };
  }
  if (!who.patreonToken) {
    return { tier: 'free', owner: false, limits: TIER_LIMITS.free };
  }
  // widget-presets.js handles the patreon token to tier resolution and
  // caches it; we reuse the same cache so a /scene-themer save and a
  // /overlay-canvas save share patreon lookups for the same user.
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

async function rateLimit(env, request, scope, limit = 60, windowSec = 60) {
  if (!env.STATE) return true;
  const ip = request.headers.get('cf-connecting-ip')
    || request.headers.get('x-forwarded-for')
    || '0.0.0.0';
  const key = `scene-themer:rl:${scope}:${ip}`;
  const raw = await env.STATE.get(key);
  const count = raw ? Number(raw) || 0 : 0;
  if (count >= limit) return false;
  await env.STATE.put(key, String(count + 1), { expirationTtl: windowSec });
  return true;
}

// ── D1 schema ────────────────────────────────────────────────────────
//
// Pattern mirrors cam_border_configs. The mapping payload lives in
// mappings_json (the source-of-truth, snake_case keys inside it). On PUT
// we precompute a derived broadcaster -> { byCategoryId, byCategoryName,
// defaultGroup, sceneName, customOps } lookup that the active-group
// endpoint consults; we keep that derived blob in KV under
// scene-themer:lookup:<configId> so a hot read never touches D1.

async function ensureSchema(env) {
  if (!env.DB) return;
  try {
    await env.DB.exec(
      `CREATE TABLE IF NOT EXISTS scene_themer_configs (`
      + ` id TEXT PRIMARY KEY,`
      + ` owner_id TEXT NOT NULL,`
      + ` owner_type TEXT NOT NULL DEFAULT 'twitch',`
      + ` owner_email TEXT,`
      + ` broadcaster_id TEXT,`
      + ` label TEXT NOT NULL DEFAULT '',`
      + ` mappings_json TEXT NOT NULL DEFAULT '[]',`
      + ` default_group TEXT NOT NULL DEFAULT 'theme_default',`
      + ` scene_name TEXT NOT NULL DEFAULT 'Game',`
      + ` webhook_url TEXT,`
      + ` visibility TEXT NOT NULL DEFAULT 'private',`
      + ` required_tier TEXT NOT NULL DEFAULT '',`
      + ` mapping_count INTEGER NOT NULL DEFAULT 0,`
      + ` created_at INTEGER NOT NULL,`
      + ` updated_at INTEGER NOT NULL`
      + `)`,
    );
    await env.DB.exec(`CREATE INDEX IF NOT EXISTS idx_scene_themer_owner ON scene_themer_configs(owner_id, owner_type)`);
    await env.DB.exec(`CREATE INDEX IF NOT EXISTS idx_scene_themer_broadcaster ON scene_themer_configs(broadcaster_id)`);
    await env.DB.exec(`CREATE INDEX IF NOT EXISTS idx_scene_themer_updated ON scene_themer_configs(updated_at)`);
  } catch (e) {
    console.warn('[scene-themer] ensureSchema', e?.message || e);
  }
}

// ── Validation ───────────────────────────────────────────────────────

function safeString(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[ -]/g, '').slice(0, max);
}

// Group name is the OBS source-group name the streamer typed inside their
// scene. OBS allows almost any string; we restrict to printable ASCII +
// spaces / dashes / underscores / digits up to GROUP_NAME_MAX.
function safeGroupName(v) {
  if (typeof v !== 'string') return '';
  const cleaned = v.replace(/[^A-Za-z0-9 _\-:.]/g, '').trim();
  return cleaned.slice(0, GROUP_NAME_MAX);
}

function safeSceneName(v) {
  if (typeof v !== 'string') return 'Game';
  const cleaned = v.replace(/[^A-Za-z0-9 _\-:.]/g, '').trim();
  return cleaned.slice(0, SCENE_NAME_MAX) || 'Game';
}

function safeWebhookUrl(v) {
  if (typeof v !== 'string' || !v) return '';
  const trimmed = v.trim();
  if (!/^https?:\/\//i.test(trimmed)) return '';
  return trimmed.slice(0, WEBHOOK_URL_MAX);
}

// Custom OBS ops are a small whitelisted shape so a Patreon T2 user can
// flip opacity / filter visibility without us shipping raw WS calls to
// arbitrary endpoints from their stream. Each op is one of:
//   { kind: 'visibility', source: 'theme_fallout/pip-boy', visible: true }
//   { kind: 'opacity',    source: 'theme_fallout/pip-boy', opacity: 0.85 }
//   { kind: 'filter',     source: 'cam',  filter: 'bw',  enabled: true }
//   { kind: 'transform',  source: 'cam',  rotation: 0, x: 0, y: 0, scaleX: 1, scaleY: 1 }
function validateCustomOp(input) {
  if (!input || typeof input !== 'object') return null;
  const kind = String(input.kind || '');
  if (kind === 'visibility') {
    const source = safeGroupName(input.source);
    if (!source) return null;
    return { kind, source, visible: !!input.visible };
  }
  if (kind === 'opacity') {
    const source = safeGroupName(input.source);
    if (!source) return null;
    const opacity = Math.max(0, Math.min(1, Number(input.opacity)));
    if (!Number.isFinite(opacity)) return null;
    return { kind, source, opacity };
  }
  if (kind === 'filter') {
    const source = safeGroupName(input.source);
    const filter = safeGroupName(input.filter);
    if (!source || !filter) return null;
    return { kind, source, filter, enabled: !!input.enabled };
  }
  if (kind === 'transform') {
    const source = safeGroupName(input.source);
    if (!source) return null;
    const num = (v, lo, hi, fb) => {
      const n = Number(v); if (!Number.isFinite(n)) return fb; return Math.max(lo, Math.min(hi, n));
    };
    return {
      kind, source,
      rotation: num(input.rotation, -360, 360, 0),
      x: num(input.x, -10000, 10000, 0),
      y: num(input.y, -10000, 10000, 0),
      scaleX: num(input.scaleX, 0.01, 100, 1),
      scaleY: num(input.scaleY, 0.01, 100, 1),
    };
  }
  return null;
}

function validateMapping(input, allowCustomOps) {
  if (!input || typeof input !== 'object') return null;
  const categoryId = String(input.categoryId || input.category_id || '').trim();
  const categoryName = safeString(input.categoryName || input.category_name || '', CATEGORY_NAME_MAX);
  const group = safeGroupName(input.group);
  if (!group) return null;
  if (!categoryId && !categoryName) return null;
  if (categoryId && !CATEGORY_ID_RE.test(categoryId)) return null;
  const mapping = { categoryId, categoryName, group };
  if (allowCustomOps && Array.isArray(input.customOps)) {
    const ops = input.customOps.map(validateCustomOp).filter(Boolean).slice(0, 12);
    if (ops.length) mapping.customOps = ops;
  }
  return mapping;
}

function validateConfig(input, tierInfo) {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'config-not-object');
  const limit = tierInfo.limits.mappings;
  const rawMappings = Array.isArray(input.mappings) ? input.mappings : [];
  const mappings = [];
  for (const raw of rawMappings) {
    const m = validateMapping(raw, tierInfo.limits.customOps);
    if (m) mappings.push(m);
    if (mappings.length > limit) {
      throw new HttpError(402, 'mapping-tier-limit', {
        current_tier: tierInfo.tier,
        limit,
        upgrade_url: '/become-a-supporter',
      });
    }
  }
  const defaultGroup = safeGroupName(input.defaultGroup || input.default_group || 'theme_default') || 'theme_default';
  const sceneName = safeSceneName(input.sceneName || input.scene_name || 'Game');
  let broadcasterId = String(input.broadcasterId || input.broadcaster_id || '').trim();
  if (broadcasterId && !TWITCH_ID_RE.test(broadcasterId)) broadcasterId = '';
  let webhookUrl = safeWebhookUrl(input.webhookUrl || input.webhook_url);
  if (webhookUrl && !tierInfo.limits.webhookPush) webhookUrl = '';
  const label = safeString(input.label || '', LABEL_MAX);
  const visibility = ['private', 'unlisted', 'public'].includes(input.visibility)
    ? input.visibility : 'private';
  const requiredTier = ['', 'tier-1', 'tier-2', 'tier-3'].includes(input.requiredTier || input.required_tier)
    ? (input.requiredTier || input.required_tier || '') : '';
  return scrubDeep({
    schemaVersion: SCHEMA_VERSION,
    label,
    sceneName,
    defaultGroup,
    broadcasterId,
    webhookUrl,
    visibility,
    requiredTier,
    mappings,
  });
}

// ── Precomputed lookup ───────────────────────────────────────────────
//
// Given a validated config, build the O(1) lookup the active-group
// endpoint reads on every poll. Indexed by both category_id (preferred)
// and lowercased category_name (fallback for old configs that never got a
// numeric id from Twitch search). Stored in KV under two keys:
//   scene-themer:lookup:<configId>     <- the lookup object
//   scene-themer:broadcaster:<bc-id>   <- the configId currently bound to
//                                        that broadcaster (for /active reads)

function buildLookup(config) {
  const byCategoryId = {};
  const byCategoryName = {};
  for (const m of config.mappings) {
    if (m.categoryId) byCategoryId[m.categoryId] = m;
    if (m.categoryName) byCategoryName[m.categoryName.toLowerCase()] = m;
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    sceneName: config.sceneName,
    defaultGroup: config.defaultGroup,
    broadcasterId: config.broadcasterId,
    webhookUrl: config.webhookUrl,
    byCategoryId,
    byCategoryName,
  };
}

async function writeLookup(env, configId, config) {
  if (!env.STATE) return;
  const lookup = buildLookup(config);
  await env.STATE.put(`scene-themer:lookup:${configId}`, JSON.stringify(lookup));
  if (lookup.broadcasterId) {
    await env.STATE.put(`scene-themer:broadcaster:${lookup.broadcasterId}`, configId);
  }
}

async function readLookupByConfig(env, configId) {
  if (!env.STATE) return null;
  const raw = await env.STATE.get(`scene-themer:lookup:${configId}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function readLookupByBroadcaster(env, broadcasterId) {
  if (!env.STATE) return null;
  const configId = await env.STATE.get(`scene-themer:broadcaster:${broadcasterId}`);
  if (!configId) return null;
  const lookup = await readLookupByConfig(env, configId);
  if (lookup) lookup.configId = configId;
  return lookup;
}

// ── Twitch category state ────────────────────────────────────────────
//
// We track "what is broadcaster X currently streaming?" two ways:
//
//   1. channel.update EventSub fires whenever the streamer changes the
//      category from the dashboard. handleChannelUpdate() persists the
//      new category to KV under scene-themer:current-cat:<bc-id> and
//      pushes to the optional webhook for instant SB swaps.
//
//   2. If KV has nothing (first ever read, or worker just deployed),
//      /active falls back to Helix get channels?broadcaster_id=<id>
//      with a 30 s cache so repeated polls don't burn the rate limit.

async function getCurrentCategory(env, broadcasterId) {
  if (env.STATE) {
    const raw = await env.STATE.get(`scene-themer:current-cat:${broadcasterId}`);
    if (raw) {
      try { return JSON.parse(raw); } catch { /* fall through */ }
    }
  }
  // Helix fallback. Cached short so a high-frequency SB poll (every 10s)
  // doesn't hammer Twitch.
  const cacheKey = `scene-themer:helix-cat:${broadcasterId}`;
  if (env.STATE) {
    const cached = await env.STATE.get(cacheKey);
    if (cached) {
      try { return JSON.parse(cached); } catch { /* */ }
    }
  }
  const token = await getTwitchAppToken(env);
  if (!token || !env.TWITCH_CLIENT_ID) return null;
  try {
    const res = await fetch(
      'https://api.twitch.tv/helix/channels?broadcaster_id=' + encodeURIComponent(broadcasterId),
      { headers: { 'Client-Id': env.TWITCH_CLIENT_ID, Authorization: 'Bearer ' + token } },
    );
    if (!res.ok) return null;
    const d = await res.json();
    const ch = d && d.data && d.data[0];
    if (!ch) return null;
    const cat = {
      categoryId: String(ch.game_id || ''),
      categoryName: String(ch.game_name || ''),
      ts: Date.now(),
      source: 'helix',
    };
    if (env.STATE) {
      await env.STATE.put(cacheKey, JSON.stringify(cat), { expirationTtl: 30 });
    }
    return cat;
  } catch {
    return null;
  }
}

function resolveActive(lookup, current) {
  const empty = {
    group: lookup.defaultGroup,
    scene: lookup.sceneName,
    customOps: [],
    category: current || null,
    matched: false,
    source: 'default',
  };
  if (!current) return empty;
  let m = null;
  if (current.categoryId && lookup.byCategoryId[current.categoryId]) {
    m = lookup.byCategoryId[current.categoryId];
  } else if (current.categoryName) {
    m = lookup.byCategoryName[current.categoryName.toLowerCase()] || null;
  }
  if (!m) return empty;
  return {
    group: m.group,
    scene: lookup.sceneName,
    customOps: Array.isArray(m.customOps) ? m.customOps : [],
    category: current,
    matched: true,
    source: 'mapping',
  };
}

// ── channel.update hook ──────────────────────────────────────────────
//
// Wired from twitch-eventsub.js. Payload shape (channel.update v2):
//   payload.event = {
//     broadcaster_user_id, broadcaster_user_login, broadcaster_user_name,
//     title, language, category_id, category_name, content_classification_labels
//   }
//
// What we do here:
//   1. Persist current-cat for that broadcaster so /active is instant.
//   2. If the broadcaster has a scene-themer config bound, look up the
//      resolved group + scene, and if a webhook URL is configured, POST
//      it so the streamer's Streamer.bot can flip groups in <1 s without
//      waiting for the next 10 s poll.

export async function handleChannelUpdate(env, payload) {
  const ev = payload?.event;
  if (!ev) return { ok: false, error: 'no-event' };
  const broadcasterId = String(ev.broadcaster_user_id || ev.broadcaster_id || '').trim();
  if (!broadcasterId) return { ok: false, error: 'no-broadcaster' };
  const current = {
    categoryId: String(ev.category_id || ''),
    categoryName: String(ev.category_name || ''),
    ts: Date.now(),
    source: 'eventsub',
  };
  if (env.STATE) {
    // Categories rarely change inside a single stream; 12 h ttl is plenty
    // to bridge worker cold-starts but won't pin a stale game past the
    // streamer's next session.
    await env.STATE.put(`scene-themer:current-cat:${broadcasterId}`, JSON.stringify(current), {
      expirationTtl: 12 * 3600,
    });
  }
  const lookup = await readLookupByBroadcaster(env, broadcasterId);
  if (!lookup) return { ok: true, persisted: true, pushed: false };
  if (!lookup.webhookUrl) return { ok: true, persisted: true, pushed: false };
  const active = resolveActive(lookup, current);
  // Webhook is best-effort. Streamer.bot's HTTP-trigger endpoint typically
  // expects a JSON body; we POST the active shape with a stable schema
  // version so the SB-side C# can parse with .NET's serializer.
  try {
    const res = await fetch(lookup.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'aquilo-scene-themer/1',
      },
      body: JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        broadcasterId,
        scene: active.scene,
        group: active.group,
        matched: active.matched,
        category: active.category,
        customOps: active.customOps,
        ts: Date.now(),
      }),
    });
    return { ok: true, persisted: true, pushed: true, webhookStatus: res.status };
  } catch (e) {
    return { ok: true, persisted: true, pushed: false, webhookError: String(e?.message || e).slice(0, 80) };
  }
}

// ── Twitch categories autocomplete ───────────────────────────────────
//
// Helix /search/categories returns up to 20 partial-prefix matches with
// { id, name, box_art_url }. Cached per (q lowercased) for 24 h in
// LOADOUT_BOLTS to mirror the resolveTwitchLogin cache shape.

export async function searchTwitchCategories(env, q) {
  const query = String(q || '').trim().slice(0, 60);
  if (!query) return [];
  const ckey = 'scene-themer:helix:cat:' + query.toLowerCase();
  if (env.LOADOUT_BOLTS) {
    const cached = await env.LOADOUT_BOLTS.get(ckey);
    if (cached) {
      try { return JSON.parse(cached); } catch { /* */ }
    }
  }
  try {
    const res = await helixGet(env, 'search/categories?query=' + encodeURIComponent(query));
    if (!res || !res.ok) return [];
    const d = await res.json();
    const list = Array.isArray(d?.data) ? d.data.map((c) => ({
      id: String(c.id || ''),
      name: String(c.name || ''),
      boxArtUrl: String(c.box_art_url || ''),
    })).filter((c) => c.id && c.name) : [];
    if (env.LOADOUT_BOLTS && list.length) {
      await env.LOADOUT_BOLTS.put(ckey, JSON.stringify(list), { expirationTtl: 60 * 60 * 24 });
    }
    return list;
  } catch {
    return [];
  }
}

// ── Router ───────────────────────────────────────────────────────────

export async function handleSceneThemer(request, env, ctx, url) {
  const method = request.method;
  const path = url.pathname;

  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, PUT, POST, OPTIONS',
        'access-control-allow-headers':
          'content-type, x-aquilo-web-ts, x-aquilo-web-sig, x-aquilo-owner-id, x-aquilo-owner-email, x-aquilo-patreon-token',
        'access-control-max-age': '86400',
      },
    });
  }

  try {
    // GET /api/scene-themer/config/:id  (public read)
    // PUT /api/scene-themer/config/:id  (owner)
    const cfgMatch = path.match(/^\/api\/scene-themer\/config\/([^/]+)$/);
    if (cfgMatch) {
      const id = cfgMatch[1];
      if (!validSlug(id)) return json({ ok: false, error: 'bad-id' }, 400);

      if (method === 'GET') {
        const okRl = await rateLimit(env, request, 'read', 120, 60);
        if (!okRl) return json({ ok: false, error: 'rate-limited' }, 429);
        await ensureSchema(env);
        const row = env.DB
          ? await env.DB.prepare(
              `SELECT id, owner_id, owner_type, broadcaster_id, label, mappings_json, default_group, scene_name,`
              + ` visibility, required_tier, mapping_count, created_at, updated_at`
              + ` FROM scene_themer_configs WHERE id = ?`,
            ).bind(id).first()
          : null;
        if (!row) return json({ ok: false, error: 'not-found' }, 404);
        let mappings = [];
        try { mappings = JSON.parse(row.mappings_json || '[]') || []; } catch { mappings = []; }
        return json({
          ok: true,
          id,
          config: {
            label: row.label || '',
            sceneName: row.scene_name || 'Game',
            defaultGroup: row.default_group || 'theme_default',
            broadcasterId: row.broadcaster_id || '',
            visibility: row.visibility || 'private',
            requiredTier: row.required_tier || '',
            mappings,
          },
          meta: {
            ownerId: row.owner_id,
            mappingCount: row.mapping_count,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          },
        });
      }

      if (method === 'PUT') {
        const rawBody = await request.text();
        if (rawBody.length > MAX_BODY) return json({ ok: false, error: 'body-too-large' }, 413);
        const who = await requireOwner(env, request, rawBody);
        const tierInfo = await resolveTier(env, who);
        await ensureSchema(env);

        let body;
        try { body = JSON.parse(rawBody || '{}'); }
        catch { return json({ ok: false, error: 'bad-json' }, 400); }
        const payload = body && body.config ? body.config : body;
        const validated = validateConfig(payload, tierInfo);

        const now = Date.now();
        const existing = env.DB
          ? await env.DB.prepare(`SELECT created_at, owner_id FROM scene_themer_configs WHERE id = ?`).bind(id).first()
          : null;
        if (existing && !tierInfo.owner && String(existing.owner_id) !== String(who.ownerId)) {
          throw new HttpError(403, 'not-your-config');
        }
        const createdAt = existing?.created_at || now;

        if (env.DB) {
          await env.DB.prepare(
            `INSERT INTO scene_themer_configs`
            + ` (id, owner_id, owner_type, owner_email, broadcaster_id, label, mappings_json,`
            + `  default_group, scene_name, webhook_url, visibility, required_tier, mapping_count,`
            + `  created_at, updated_at)`
            + ` VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
            + ` ON CONFLICT(id) DO UPDATE SET`
            + `  owner_email=excluded.owner_email,`
            + `  broadcaster_id=excluded.broadcaster_id,`
            + `  label=excluded.label,`
            + `  mappings_json=excluded.mappings_json,`
            + `  default_group=excluded.default_group,`
            + `  scene_name=excluded.scene_name,`
            + `  webhook_url=excluded.webhook_url,`
            + `  visibility=excluded.visibility,`
            + `  required_tier=excluded.required_tier,`
            + `  mapping_count=excluded.mapping_count,`
            + `  updated_at=excluded.updated_at`,
          ).bind(
            id,
            String(who.ownerId),
            'twitch',
            who.ownerEmail || null,
            validated.broadcasterId || null,
            validated.label,
            JSON.stringify(validated.mappings),
            validated.defaultGroup,
            validated.sceneName,
            validated.webhookUrl || null,
            validated.visibility,
            validated.requiredTier,
            validated.mappings.length,
            createdAt,
            now,
          ).run();
        }
        await writeLookup(env, id, validated);

        return json({
          ok: true,
          id,
          config: validated,
          tier: { tier: tierInfo.tier, owner: tierInfo.owner, limits: serializeLimits(tierInfo.limits) },
        });
      }

      return json({ ok: false, error: 'method-not-allowed' }, 405);
    }

    // GET /api/scene-themer/configs?owner=<id>
    if (path === '/api/scene-themer/configs' && method === 'GET') {
      const who = await requireOwner(env, request, '');
      await ensureSchema(env);
      const owner = url.searchParams.get('owner') || who.ownerId;
      const rs = env.DB
        ? await env.DB.prepare(
            `SELECT id, label, scene_name, default_group, broadcaster_id, mapping_count,`
            + ` visibility, required_tier, created_at, updated_at`
            + ` FROM scene_themer_configs WHERE owner_id = ? ORDER BY updated_at DESC LIMIT 50`,
          ).bind(owner).all()
        : { results: [] };
      return json({ ok: true, owner, configs: rs.results || [] });
    }

    // GET /api/scene-themer/active/:broadcaster
    // The Streamer.bot poll target. Public so the streamer's local SB can
    // hit it without any auth, returns the current group + scene.
    const activeMatch = path.match(/^\/api\/scene-themer\/active\/([^/]+)$/);
    if (activeMatch && method === 'GET') {
      const broadcasterId = activeMatch[1];
      if (!TWITCH_ID_RE.test(broadcasterId)) return json({ ok: false, error: 'bad-broadcaster' }, 400);
      const okRl = await rateLimit(env, request, 'active', 240, 60);
      if (!okRl) return json({ ok: false, error: 'rate-limited' }, 429);
      const lookup = await readLookupByBroadcaster(env, broadcasterId);
      if (!lookup) return json({ ok: false, error: 'no-config-bound' }, 404);
      const current = await getCurrentCategory(env, broadcasterId);
      const active = resolveActive(lookup, current);
      return json({
        ok: true,
        broadcasterId,
        scene: active.scene,
        group: active.group,
        matched: active.matched,
        source: active.source,
        category: active.category,
        customOps: active.customOps,
        ts: Date.now(),
      });
    }

    // GET /api/scene-themer/categories?q=...   (owner)
    if (path === '/api/scene-themer/categories' && method === 'GET') {
      await requireOwner(env, request, '');
      const q = url.searchParams.get('q') || '';
      const list = await searchTwitchCategories(env, q);
      return json({ ok: true, query: q, categories: list });
    }

    // POST /api/scene-themer/test/:id   (owner) -- simulate without writing
    const testMatch = path.match(/^\/api\/scene-themer\/test\/([^/]+)$/);
    if (testMatch && method === 'POST') {
      const id = testMatch[1];
      if (!validSlug(id)) return json({ ok: false, error: 'bad-id' }, 400);
      const rawBody = await request.text();
      await requireOwner(env, request, rawBody);
      let body;
      try { body = JSON.parse(rawBody || '{}'); }
      catch { return json({ ok: false, error: 'bad-json' }, 400); }
      const lookup = await readLookupByConfig(env, id);
      if (!lookup) return json({ ok: false, error: 'no-lookup-saved' }, 404);
      const fakeCategory = {
        categoryId: String(body.categoryId || ''),
        categoryName: safeString(body.categoryName || '', CATEGORY_NAME_MAX),
        ts: Date.now(),
        source: 'test',
      };
      const active = resolveActive(lookup, fakeCategory);
      return json({
        ok: true,
        id,
        test: true,
        scene: active.scene,
        group: active.group,
        matched: active.matched,
        source: active.source,
        category: fakeCategory,
        customOps: active.customOps,
      });
    }

    // GET /api/scene-themer/limits   (returns the tier-limits table for the UI)
    if (path === '/api/scene-themer/limits' && method === 'GET') {
      return json({
        ok: true,
        tiers: {
          free: serializeLimits(TIER_LIMITS.free),
          t1:   serializeLimits(TIER_LIMITS.t1),
          t2:   serializeLimits(TIER_LIMITS.t2),
          t3:   serializeLimits(TIER_LIMITS.t3),
        },
      });
    }

    return json({ ok: false, error: 'not-found' }, 404);
  } catch (e) {
    if (e instanceof HttpError) {
      const body = { ok: false, error: e.code };
      if (e.extra) Object.assign(body, e.extra);
      return json(body, e.status);
    }
    console.error('[scene-themer] error', e?.stack || e);
    return json({ ok: false, error: 'internal' }, 500);
  }
}

// JSON-safe limits (Infinity is not representable in JSON).
function serializeLimits(l) {
  return {
    mappings: l.mappings === Infinity ? null : l.mappings,
    customOps: l.customOps,
    featurable: l.featurable,
    webhookPush: l.webhookPush,
  };
}

export { TIER_LIMITS, validateConfig, buildLookup, resolveActive };
