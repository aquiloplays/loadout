// overlay-canvas.js
//
// Aquilo Overlay Composer backend (internal codename: overlay-canvas).
//
// One unified OBS browser source loads every widget the streamer wants
// from a single Chromium instance. The static page lives at
//   /overlays/canvas/index.html  (aquilo-site)
// The layout it renders is a JSON blob kept in KV for hot reads, with
// ownership + discoverability metadata in D1.
//
// Wire-up in worker.js (additive):
//   if (path.startsWith('/api/overlay-canvas/')) {
//     const { handleOverlayCanvas } = await import('./overlay-canvas.js');
//     return handleOverlayCanvas(req, env, ctx, url);
//   }
//
// Routes (all paths begin /api/overlay-canvas/):
//
//   GET  /layout/:id
//     Public read of the layout JSON. Rate-limited 60/min/IP. Falls back
//     to a stable empty default when the id is unknown so an OBS browser
//     source pointed at the URL renders something before the streamer
//     saves anything.
//
//   PUT  /layout/:id   (owner-only via site HMAC)
//     Validates schema, scrubs em dashes, applies tier limits, writes
//     KV blob + D1 metadata. Max 50 KB body.
//
//   DELETE /layout/:id  (owner-only)
//   POST   /layout/:id/fork  (caller becomes owner of a copy)
//   GET    /layouts             (owner-only, lists the caller's saved layouts)
//
//   GET    /events/:broadcaster  (SSE, taps ActivityBroadcaster DO)
//     Same fanout pattern as cam-border. NO new EventSub subscriptions.
//
//   POST /probe-iframe   (owner-only)
//     HEAD-probes a candidate Custom URL widget URL. Returns
//     {ok, embeddable, xFrameOptions, contentSecurityPolicy, reason}.
//     Result is advisory only; the builder still saves the URL because
//     many providers fail the server-side check but render fine inside
//     an OBS browser source (which is a desktop Chromium with no
//     framing protection enforced by the host page chain).
//
//   POST   /reference-image   (owner-only, multipart, 4 MB cap)
//     Uploads an OBS scene screenshot to R2. Used by the builder as a
//     toggleable background.
//   GET    /reference-image/:owner  (public read, signed by KV TTL)
//   DELETE /reference-image          (owner-only)
//
//   GET    /tier   (owner-only)
//     Returns the caller's tier + current usage so the builder can
//     show "5/5 layouts" before they try to save.
//
// Tier limits (enforced server-side on every PUT):
//   free  : 5 layouts, 5 widgets/layout
//   t1    : 15 layouts, 15 widgets/layout
//   t2    : unlimited + custom_css + share-as-template
//   t3    : same as t2 + featured eligibility
// Owner (Clay's Discord 1107161695262085210 OR email bisherclay@gmail.com)
// bypasses every limit.

import { getWidgetPresetAccess } from './widget-presets.js';
import { publishActivity } from './activity-do.js';

const SCHEMA_VERSION = 1;
const MAX_BODY = 50 * 1024;
const MAX_REFERENCE_BYTES = 4 * 1024 * 1024;
const ALLOWED_REFERENCE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const HEX_RE = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

// Owner identity. Clay's Discord id is the same constant kitchen.js and
// vault.js use. The email bypass mirrors widget-presets.js OWNER_EMAILS.
const OWNER_DISCORD_IDS = new Set(['1107161695262085210']);
const OWNER_EMAILS = new Set(['bisherclay@gmail.com']);

const TIER_LIMITS = Object.freeze({
  free: { layouts: 5, widgets: 5, customCss: false, featurable: false },
  t1:   { layouts: 15, widgets: 15, customCss: false, featurable: false },
  t2:   { layouts: Infinity, widgets: Infinity, customCss: true, featurable: false },
  t3:   { layouts: Infinity, widgets: Infinity, customCss: true, featurable: true },
});

// Widget types the builder + overlay both know about. Kept in lockstep
// with src/lib/overlay-canvas/widgets.ts on the site side. requiresOwner
// flags widgets that touch personal data (check-in card) or pull from
// Clay-only event streams; even Patreon T3 cannot render them.
const WIDGET_TYPES = Object.freeze({
  'aurora-cam-border':  { requiresOwner: true,  requiresTier: 'free' },
  'liquid-bubble':      { requiresOwner: true,  requiresTier: 'free' },
  'chat':               { requiresOwner: false, requiresTier: 'free' },
  'rotation':           { requiresOwner: false, requiresTier: 't1' },
  'gift-jar':           { requiresOwner: false, requiresTier: 't1' },
  'sub-goal':           { requiresOwner: false, requiresTier: 'free' },
  'fo4-bpm':            { requiresOwner: false, requiresTier: 't1' },
  'punch-card':         { requiresOwner: false, requiresTier: 't1' },
  'check-in-card':      { requiresOwner: true,  requiresTier: 'free' },
  'death-counter':      { requiresOwner: false, requiresTier: 'free' },
  'follow-popup':       { requiresOwner: false, requiresTier: 'free' },
  'hangar-drop':        { requiresOwner: true,  requiresTier: 't2' },
  'tangia-feed':        { requiresOwner: false, requiresTier: 't1' },
  'printerbot-feed':    { requiresOwner: false, requiresTier: 't1' },
  'custom-url':         { requiresOwner: false, requiresTier: 'free' },
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
// hyphen. The character classes are written as Unicode escapes so this
// source file itself stays em-dash-free.
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

// HMAC envelope used by every owner-only path. Identical to cam-border:
// the site signs `${ts}\n${rawBody}` with AQUILO_SITE_WEB_SECRET, sends
// `x-aquilo-web-{ts,sig}` headers plus an `x-aquilo-owner-id` hint.
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
  if (env.OVERLAY_CANVAS_OWNER_OVERRIDE) {
    return {
      ownerId: String(env.OVERLAY_CANVAS_OWNER_OVERRIDE),
      ownerEmail: '',
      patreonToken: '',
    };
  }
  throw new HttpError(401, 'owner-required');
}

// Tier resolution. Anchor users are Clay (full owner bypass); everyone
// else gets their Patreon tier via widget-presets.js (same cache layer).
async function resolveTier(env, who) {
  const isOwner = OWNER_DISCORD_IDS.has(String(who.ownerId)) || OWNER_EMAILS.has(who.ownerEmail);
  if (isOwner) {
    return { tier: 't3', owner: true, limits: TIER_LIMITS.t3 };
  }
  if (!who.patreonToken) {
    return { tier: 'free', owner: false, limits: TIER_LIMITS.free };
  }
  let access = null;
  try { access = await getWidgetPresetAccess(env, who.patreonToken); }
  catch { /* fall through to free */ }
  const tier = (access && access.tier) || 'none';
  const norm = (tier === 'none') ? 'free' : tier;
  return { tier: norm, owner: false, limits: TIER_LIMITS[norm] || TIER_LIMITS.free };
}

async function rateLimit(env, request, limit = 60, windowSec = 60) {
  if (!env.STATE) return true;
  const ip = request.headers.get('cf-connecting-ip')
    || request.headers.get('x-forwarded-for')
    || '0.0.0.0';
  const key = `overlay-canvas:rl:${ip}`;
  const raw = await env.STATE.get(key);
  const count = raw ? Number(raw) || 0 : 0;
  if (count >= limit) return false;
  await env.STATE.put(key, String(count + 1), { expirationTtl: windowSec });
  return true;
}

async function ensureSchema(env) {
  if (!env.DB) return;
  try {
    await env.DB.exec(
      `CREATE TABLE IF NOT EXISTS overlay_canvas_layouts (`
      + ` id TEXT PRIMARY KEY,`
      + ` owner_id TEXT NOT NULL,`
      + ` owner_email TEXT,`
      + ` label TEXT NOT NULL DEFAULT '',`
      + ` visibility TEXT NOT NULL DEFAULT 'private',`
      + ` required_tier TEXT NOT NULL DEFAULT 'free',`
      + ` forked_from TEXT,`
      + ` published_at INTEGER,`
      + ` widget_count INTEGER NOT NULL DEFAULT 0,`
      + ` custom_css INTEGER NOT NULL DEFAULT 0,`
      + ` created_at INTEGER NOT NULL,`
      + ` updated_at INTEGER NOT NULL`
      + `)`,
    );
    await env.DB.exec(
      `CREATE TABLE IF NOT EXISTS overlay_canvas_reference_images (`
      + ` owner_id TEXT PRIMARY KEY,`
      + ` r2_key TEXT NOT NULL,`
      + ` mime TEXT NOT NULL DEFAULT 'image/png',`
      + ` bytes INTEGER NOT NULL DEFAULT 0,`
      + ` width INTEGER NOT NULL DEFAULT 0,`
      + ` height INTEGER NOT NULL DEFAULT 0,`
      + ` created_at INTEGER NOT NULL,`
      + ` updated_at INTEGER NOT NULL`
      + `)`,
    );
  } catch (e) {
    console.warn('[overlay-canvas] ensureSchema', e?.message || e);
  }
}

// ── Layout schema validation ────────────────────────────────────────────

function clampInt(v, lo, hi, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

function validateWidget(input, who, tierInfo) {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'widget-not-object');
  const type = String(input.type || '').slice(0, 64);
  const meta = WIDGET_TYPES[type];
  if (!meta) throw new HttpError(400, 'unknown-widget-type', { type });

  // Owner-only widgets stay owner-only regardless of patron tier.
  if (meta.requiresOwner && !tierInfo.owner) {
    throw new HttpError(403, 'widget-owner-only', { type });
  }

  // Tier gate on the widget's required tier.
  const wantRank = TIER_RANK[meta.requiresTier] ?? 0;
  const haveRank = TIER_RANK[tierInfo.tier] ?? 0;
  if (!tierInfo.owner && haveRank < wantRank) {
    throw new HttpError(402, 'widget-tier-locked', {
      type,
      required_tier: meta.requiresTier,
      current_tier: tierInfo.tier,
      upgrade_url: '/become-a-supporter',
    });
  }

  const id = String(input.id || '').slice(0, 64) || `wgt_${Math.random().toString(36).slice(2, 9)}`;
  const x = clampInt(input.x, -2000, 4000, 0);
  const y = clampInt(input.y, -2000, 4000, 0);
  const w = clampInt(input.w, 16, 4000, 320);
  const h = clampInt(input.h, 16, 4000, 200);
  const z = clampInt(input.z, 0, 999, 1);
  const opacity = Number.isFinite(Number(input.opacity)) ? Math.max(0, Math.min(1, Number(input.opacity))) : 1;
  const enabled = input.enabled === false ? false : true;
  let scenes = ['*'];
  if (Array.isArray(input.scenes)) {
    scenes = input.scenes
      .filter((s) => typeof s === 'string')
      .map((s) => s.slice(0, 48))
      .slice(0, 24);
    if (scenes.length === 0) scenes = ['*'];
  }
  const config = scrubDeep((input.config && typeof input.config === 'object') ? input.config : {});

  // Custom URL widget gets extra validation: URL must be http(s), max 2 KB.
  if (type === 'custom-url') {
    const u = String(config.url || '').slice(0, 2048);
    if (!/^https?:\/\//i.test(u)) throw new HttpError(400, 'custom-url-bad-protocol');
    config.url = u;
    config.allowTransparent = config.allowTransparent !== false;
    config.refreshInterval = clampInt(config.refreshInterval, 0, 86400, 0);
    if (typeof config.customCss === 'string') {
      config.customCss = config.customCss.slice(0, 8000);
      // Custom CSS injection on iframes is a T2 feature.
      if (!tierInfo.owner && !tierInfo.limits.customCss && config.customCss.length > 0) {
        throw new HttpError(402, 'custom-css-tier-locked', {
          required_tier: 't2',
          current_tier: tierInfo.tier,
          upgrade_url: '/become-a-supporter',
        });
      }
    }
  }

  return { id, type, x, y, w, h, z, opacity, enabled, scenes, config };
}

function validateLayout(input, who, tierInfo) {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'layout-not-object');
  const label = scrubEmDash(String(input.label || '').slice(0, 80)) || 'Untitled layout';
  const canvasSize = {
    w: clampInt(input.canvasSize?.w, 320, 7680, 1920),
    h: clampInt(input.canvasSize?.h, 180, 4320, 1080),
  };
  const visibility = ['private', 'unlisted', 'public'].includes(input.visibility) ? input.visibility : 'private';
  const requiredTier = ['free', 't1', 't2', 't3'].includes(input.requiredTier) ? input.requiredTier : 'free';
  const widgetsIn = Array.isArray(input.widgets) ? input.widgets : [];

  if (!tierInfo.owner && widgetsIn.length > tierInfo.limits.widgets) {
    throw new HttpError(402, 'tier_exceeded', {
      scope: 'widgets',
      current: widgetsIn.length,
      limit: tierInfo.limits.widgets,
      tier: tierInfo.tier,
      upgrade_url: '/become-a-supporter',
    });
  }

  const widgets = widgetsIn.slice(0, 200).map((w) => validateWidget(w, who, tierInfo));

  const templates = [];
  if (Array.isArray(input.templates)) {
    for (const t of input.templates.slice(0, 32)) {
      if (!t || typeof t !== 'object') continue;
      const name = scrubEmDash(String(t.name || '').slice(0, 48));
      if (!name) continue;
      const widgetVisibility = {};
      if (t.widgetVisibility && typeof t.widgetVisibility === 'object') {
        for (const [k, v] of Object.entries(t.widgetVisibility)) {
          widgetVisibility[String(k).slice(0, 64)] = !!v;
        }
      }
      templates.push({ name, widgetVisibility });
    }
  }

  let customCss = '';
  if (typeof input.customCss === 'string' && input.customCss.length > 0) {
    if (!tierInfo.owner && !tierInfo.limits.customCss) {
      throw new HttpError(402, 'custom-css-tier-locked', {
        required_tier: 't2',
        current_tier: tierInfo.tier,
        upgrade_url: '/become-a-supporter',
      });
    }
    customCss = input.customCss.slice(0, 16000);
  }

  let backgroundColor = '';
  if (typeof input.backgroundColor === 'string' && HEX_RE.test(input.backgroundColor)) {
    backgroundColor = input.backgroundColor;
  }

  const referenceImage = (input.referenceImage && typeof input.referenceImage === 'object') ? {
    url: typeof input.referenceImage.url === 'string' ? input.referenceImage.url.slice(0, 512) : '',
    opacity: Number.isFinite(Number(input.referenceImage.opacity))
      ? Math.max(0, Math.min(1, Number(input.referenceImage.opacity)))
      : 0.3,
    visible: input.referenceImage.visible !== false,
  } : null;

  return {
    schemaVersion: SCHEMA_VERSION,
    label,
    canvasSize,
    visibility,
    requiredTier,
    widgets,
    templates,
    customCss,
    backgroundColor,
    referenceImage,
  };
}

// ── Layout count enforcement ────────────────────────────────────────────

async function countLayoutsForOwner(env, ownerId) {
  if (!env.DB) return 0;
  try {
    const r = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM overlay_canvas_layouts WHERE owner_id = ?`,
    ).bind(ownerId).first();
    return Number(r?.n || 0);
  } catch { return 0; }
}

async function layoutExists(env, id) {
  if (!env.DB) return false;
  try {
    const r = await env.DB.prepare(
      `SELECT 1 AS x FROM overlay_canvas_layouts WHERE id = ? LIMIT 1`,
    ).bind(id).first();
    return !!r;
  } catch { return false; }
}

// ── Handlers ────────────────────────────────────────────────────────────

export async function handleOverlayCanvas(request, env, ctx, url) {
  const method = request.method;
  const path = url.pathname;

  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, PUT, POST, DELETE, OPTIONS',
        'access-control-allow-headers':
          'content-type, x-aquilo-web-ts, x-aquilo-web-sig, x-aquilo-owner-id, x-aquilo-owner-email, x-aquilo-patreon-token',
        'access-control-max-age': '86400',
      },
    });
  }

  try {
    if (path === '/api/overlay-canvas/default') {
      return json({
        ok: true,
        schemaVersion: SCHEMA_VERSION,
        widgetTypes: Object.fromEntries(
          Object.entries(WIDGET_TYPES).map(([k, v]) => [k, v]),
        ),
        tierLimits: {
          free: { layouts: 5, widgets: 5, customCss: false },
          t1:   { layouts: 15, widgets: 15, customCss: false },
          t2:   { layouts: 'unlimited', widgets: 'unlimited', customCss: true },
          t3:   { layouts: 'unlimited', widgets: 'unlimited', customCss: true, featurable: true },
        },
      });
    }

    if (path === '/api/overlay-canvas/tier' && method === 'GET') {
      const who = await requireOwner(env, request, '');
      const tierInfo = await resolveTier(env, who);
      await ensureSchema(env);
      const used = await countLayoutsForOwner(env, who.ownerId);
      return json({
        ok: true,
        tier: tierInfo.tier,
        owner: tierInfo.owner,
        limits: {
          layouts: tierInfo.limits.layouts === Infinity ? 'unlimited' : tierInfo.limits.layouts,
          widgets: tierInfo.limits.widgets === Infinity ? 'unlimited' : tierInfo.limits.widgets,
          customCss: tierInfo.limits.customCss,
        },
        usage: { layouts: used },
      });
    }

    // GET /api/overlay-canvas/layouts (owner-only)
    if (path === '/api/overlay-canvas/layouts' && method === 'GET') {
      const who = await requireOwner(env, request, '');
      await ensureSchema(env);
      const rs = env.DB
        ? await env.DB.prepare(
            `SELECT id, label, visibility, required_tier, forked_from, published_at,`
            + ` widget_count, custom_css, created_at, updated_at`
            + ` FROM overlay_canvas_layouts WHERE owner_id = ?`
            + ` ORDER BY updated_at DESC LIMIT 200`,
          ).bind(who.ownerId).all()
        : { results: [] };
      return json({ ok: true, owner: who.ownerId, layouts: rs.results || [] });
    }

    // POST /api/overlay-canvas/probe-iframe (owner-only)
    if (path === '/api/overlay-canvas/probe-iframe' && method === 'POST') {
      const rawBody = await request.text();
      await requireOwner(env, request, rawBody);
      let body;
      try { body = JSON.parse(rawBody || '{}'); }
      catch { return json({ ok: false, error: 'bad-json' }, 400); }
      const target = String(body.url || '').slice(0, 2048);
      if (!/^https?:\/\//i.test(target)) {
        return json({ ok: false, error: 'bad-protocol' }, 400);
      }
      return await probeIframe(target);
    }

    // POST /api/overlay-canvas/reference-image (owner-only, multipart)
    if (path === '/api/overlay-canvas/reference-image' && method === 'POST') {
      return await handleReferenceImageUpload(env, request);
    }
    const refGet = path.match(/^\/api\/overlay-canvas\/reference-image\/([^/]+)$/);
    if (refGet && method === 'GET') {
      return await serveReferenceImage(env, refGet[1]);
    }
    if (path === '/api/overlay-canvas/reference-image' && method === 'DELETE') {
      return await handleReferenceImageDelete(env, request);
    }

    // /api/overlay-canvas/layout/:id
    const layoutMatch = path.match(/^\/api\/overlay-canvas\/layout\/([^/]+)$/);
    if (layoutMatch) {
      const id = layoutMatch[1];
      if (!validSlug(id)) return json({ ok: false, error: 'bad-id' }, 400);

      if (method === 'GET') {
        const ok = await rateLimit(env, request, 60, 60);
        if (!ok) return json({ ok: false, error: 'rate-limited' }, 429);
        const raw = env.STATE ? await env.STATE.get(`overlay-canvas:layout:${id}`) : null;
        if (!raw) {
          return json({
            ok: true,
            id,
            layout: emptyLayout(id),
            source: 'default',
          }, 200, { 'cache-control': 'public, max-age=5' });
        }
        let layout;
        try { layout = JSON.parse(raw); }
        catch { layout = emptyLayout(id); }
        return json({ ok: true, id, layout, source: 'stored' }, 200, {
          'cache-control': 'public, max-age=5',
        });
      }

      if (method === 'PUT') {
        const rawBody = await request.text();
        if (rawBody.length > MAX_BODY) return json({ ok: false, error: 'body-too-large', limit: MAX_BODY }, 413);
        const who = await requireOwner(env, request, rawBody);
        const tierInfo = await resolveTier(env, who);
        await ensureSchema(env);

        let body;
        try { body = JSON.parse(rawBody || '{}'); }
        catch { return json({ ok: false, error: 'bad-json' }, 400); }

        // Layout-count cap on NEW saves only.
        const exists = await layoutExists(env, id);
        if (!exists && !tierInfo.owner) {
          const used = await countLayoutsForOwner(env, who.ownerId);
          if (used >= tierInfo.limits.layouts) {
            return json({
              ok: false,
              error: 'tier_exceeded',
              scope: 'layouts',
              current: used,
              limit: tierInfo.limits.layouts,
              tier: tierInfo.tier,
              upgrade_url: '/become-a-supporter',
            }, 402);
          }
        }

        let validated;
        try { validated = validateLayout(body.layout || body, who, tierInfo); }
        catch (e) {
          if (e instanceof HttpError) {
            return json({ ok: false, error: e.code, ...(e.extra || {}) }, e.status);
          }
          throw e;
        }

        validated.id = id;
        validated.ownerId = String(who.ownerId);
        validated.updatedAt = Date.now();

        if (env.STATE) {
          await env.STATE.put(`overlay-canvas:layout:${id}`, JSON.stringify(validated));
        }
        if (env.DB) {
          const now = Date.now();
          await env.DB.prepare(
            `INSERT INTO overlay_canvas_layouts`
            + ` (id, owner_id, owner_email, label, visibility, required_tier, forked_from,`
            + `  published_at, widget_count, custom_css, created_at, updated_at)`
            + ` VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`
            + ` ON CONFLICT(id) DO UPDATE SET`
            + `  label=excluded.label, visibility=excluded.visibility,`
            + `  required_tier=excluded.required_tier, widget_count=excluded.widget_count,`
            + `  custom_css=excluded.custom_css, updated_at=excluded.updated_at`,
          ).bind(
            id,
            String(who.ownerId),
            (who.ownerEmail || '').slice(0, 128) || null,
            validated.label,
            validated.visibility,
            validated.requiredTier,
            validated.widgets.length,
            validated.customCss ? 1 : 0,
            now, now,
          ).run();
        }
        return json({ ok: true, id, layout: validated, tier: tierInfo.tier });
      }

      if (method === 'DELETE') {
        const who = await requireOwner(env, request, '');
        await ensureSchema(env);
        // Only the owner of the layout can delete it (Clay bypasses).
        if (env.DB) {
          const row = await env.DB.prepare(
            `SELECT owner_id FROM overlay_canvas_layouts WHERE id = ?`,
          ).bind(id).first();
          if (row && String(row.owner_id) !== String(who.ownerId)) {
            const tierInfo = await resolveTier(env, who);
            if (!tierInfo.owner) return json({ ok: false, error: 'forbidden' }, 403);
          }
          await env.DB.prepare(`DELETE FROM overlay_canvas_layouts WHERE id = ?`).bind(id).run();
        }
        if (env.STATE) await env.STATE.delete(`overlay-canvas:layout:${id}`);
        return json({ ok: true, id });
      }

      return json({ ok: false, error: 'method-not-allowed' }, 405);
    }

    // POST /api/overlay-canvas/layout/:id/fork
    const forkMatch = path.match(/^\/api\/overlay-canvas\/layout\/([^/]+)\/fork$/);
    if (forkMatch && method === 'POST') {
      const sourceId = forkMatch[1];
      if (!validSlug(sourceId)) return json({ ok: false, error: 'bad-id' }, 400);
      const rawBody = await request.text();
      const who = await requireOwner(env, request, rawBody);
      const tierInfo = await resolveTier(env, who);
      await ensureSchema(env);

      const sourceRaw = env.STATE ? await env.STATE.get(`overlay-canvas:layout:${sourceId}`) : null;
      if (!sourceRaw) return json({ ok: false, error: 'source-not-found' }, 404);
      let sourceLayout;
      try { sourceLayout = JSON.parse(sourceRaw); }
      catch { return json({ ok: false, error: 'source-corrupt' }, 500); }

      // Tier check against fork length.
      if (!tierInfo.owner) {
        const used = await countLayoutsForOwner(env, who.ownerId);
        if (used >= tierInfo.limits.layouts) {
          return json({
            ok: false, error: 'tier_exceeded', scope: 'layouts',
            current: used, limit: tierInfo.limits.layouts,
            tier: tierInfo.tier, upgrade_url: '/become-a-supporter',
          }, 402);
        }
      }

      const newId = `fork-${randomSlug(8)}`;
      const forked = {
        ...sourceLayout,
        id: newId,
        ownerId: String(who.ownerId),
        label: scrubEmDash(`${sourceLayout.label || 'Layout'} (fork)`).slice(0, 80),
        visibility: 'private',
        forkedFrom: sourceId,
      };
      // Re-validate so any tier-locked widgets get rejected for the caller.
      let validated;
      try { validated = validateLayout(forked, who, tierInfo); }
      catch (e) {
        if (e instanceof HttpError) return json({ ok: false, error: e.code, ...(e.extra || {}) }, e.status);
        throw e;
      }
      validated.id = newId;
      validated.ownerId = String(who.ownerId);

      if (env.STATE) {
        await env.STATE.put(`overlay-canvas:layout:${newId}`, JSON.stringify(validated));
      }
      if (env.DB) {
        const now = Date.now();
        await env.DB.prepare(
          `INSERT INTO overlay_canvas_layouts`
          + ` (id, owner_id, owner_email, label, visibility, required_tier, forked_from,`
          + `  published_at, widget_count, custom_css, created_at, updated_at)`
          + ` VALUES (?, ?, ?, ?, 'private', ?, ?, NULL, ?, ?, ?, ?)`,
        ).bind(
          newId,
          String(who.ownerId),
          (who.ownerEmail || '').slice(0, 128) || null,
          validated.label,
          validated.requiredTier,
          sourceId,
          validated.widgets.length,
          validated.customCss ? 1 : 0,
          now, now,
        ).run();
      }
      return json({ ok: true, id: newId, layout: validated });
    }

    // GET /api/overlay-canvas/events/:broadcaster   (SSE)
    const sseMatch = path.match(/^\/api\/overlay-canvas\/events\/([^/]+)$/);
    if (sseMatch && method === 'GET') {
      return openOverlayCanvasSSE(env, request, sseMatch[1]);
    }

    // POST /api/overlay-canvas/test/fire-event   (owner-only)
    //
    // Fires a real synthetic event through the same ActivityBroadcaster
    // DO that powers cam-border + every other overlay. Lets Clay verify
    // the full chain from inside the builder. Payload is stamped with
    // `_test: true` so production logic can filter it out if a path
    // ever needs to.
    //
    // body: { type, payload, broadcastTo: 'do' | 'sb' | 'both' }
    if (path === '/api/overlay-canvas/test/fire-event' && method === 'POST') {
      const rawBody = await request.text();
      await requireOwner(env, request, rawBody);
      let body;
      try { body = JSON.parse(rawBody || '{}'); }
      catch { return json({ ok: false, error: 'bad-json' }, 400); }

      const allowedTypes = new Set([
        'sub', 'gift-sub', 'follow', 'raid', 'bits',
        'channel-point-redeem', 'chat', 'chat-hype',
        'hype-train-begin', 'hype-train-progress', 'hype-train-end',
        'metric-update', 'tangia', 'printerbot', 'hangar-drop',
        // Builder -> live overlay control channel (e.g. outline toggle).
        // Carries a payload like { outline: true }; not a stream event.
        'composer-control',
      ]);
      const type = String(body.type || '').toLowerCase();
      if (!allowedTypes.has(type)) {
        return json({ ok: false, error: 'unknown-event-type', type }, 400);
      }
      const broadcastTo = ['do', 'sb', 'both'].includes(body.broadcastTo) ? body.broadcastTo : 'do';
      const payload = (body.payload && typeof body.payload === 'object') ? scrubDeep(body.payload) : {};

      const event = {
        kind: type,
        payload,
        _test: true,
        broadcaster: String(body.broadcaster || 'clay').slice(0, 32),
        source: 'overlay-canvas-test',
        ts: Date.now(),
      };

      const results = { do: null, sb: null };
      if (broadcastTo === 'do' || broadcastTo === 'both') {
        results.do = await publishActivity(env, event);
      }
      // Streamer.bot delivery is browser-side (the builder owns the WS
      // connection). We just acknowledge the intent so the UI can do the
      // local broadcast itself.
      if (broadcastTo === 'sb' || broadcastTo === 'both') {
        results.sb = { ok: true, note: 'broadcast-via-browser-ws' };
      }
      return json({ ok: true, event, results });
    }

    return json({ ok: false, error: 'not-found', path }, 404);
  } catch (e) {
    if (e instanceof HttpError) {
      return json({ ok: false, error: e.code, ...(e.extra || {}) }, e.status);
    }
    console.error('[overlay-canvas] error', e?.stack || e);
    return json({ ok: false, error: 'internal' }, 500);
  }
}

function emptyLayout(id) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    label: 'Untitled layout',
    canvasSize: { w: 1920, h: 1080 },
    visibility: 'private',
    requiredTier: 'free',
    widgets: [],
    templates: [],
    customCss: '',
    backgroundColor: '',
    referenceImage: null,
  };
}

function randomSlug(n) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// ── Iframe probe ────────────────────────────────────────────────────────

async function probeIframe(target) {
  const result = {
    ok: true,
    url: target,
    embeddable: true,
    xFrameOptions: '',
    contentSecurityPolicy: '',
    reason: '',
  };
  let res;
  try {
    res = await fetch(target, {
      method: 'HEAD',
      redirect: 'follow',
      cf: { cacheTtl: 30 },
    });
  } catch (e) {
    result.embeddable = true;
    result.reason = 'probe-failed-network';
    return json(result);
  }
  const xfo = (res.headers.get('x-frame-options') || '').toLowerCase();
  const csp = res.headers.get('content-security-policy') || '';
  result.xFrameOptions = xfo;
  result.contentSecurityPolicy = csp;
  if (xfo.includes('deny') || xfo.includes('sameorigin')) {
    result.embeddable = false;
    result.reason = 'x-frame-options blocks embedding';
  }
  const fa = csp.match(/frame-ancestors\s+([^;]+)/i);
  if (fa) {
    const directive = fa[1].toLowerCase().trim();
    if (directive === "'none'" || directive === 'none') {
      result.embeddable = false;
      result.reason = "CSP frame-ancestors 'none' blocks embedding";
    } else if (!directive.includes('*') && !directive.includes('aquilo.gg')) {
      result.embeddable = false;
      result.reason = 'CSP frame-ancestors restricts to other origins';
    }
  }
  return json(result);
}

// ── Reference image (R2) ────────────────────────────────────────────────

async function handleReferenceImageUpload(env, request) {
  const ct = request.headers.get('content-type') || '';
  // We need the raw body for HMAC, so the site signs the multipart form
  // exactly as encoded. Read raw bytes, then parse.
  const rawBuf = await request.arrayBuffer();
  if (rawBuf.byteLength > MAX_REFERENCE_BYTES + 4096) {
    return json({ ok: false, error: 'too-large', limit: MAX_REFERENCE_BYTES }, 413);
  }
  // HMAC body covers raw bytes as a hex digest so the site can sign without
  // re-serializing multipart. The verify path reuses `${ts}\n${bodyHex}`.
  const bodyHex = await sha256Hex(new Uint8Array(rawBuf));
  const who = await requireOwner(env, request, bodyHex);
  const tierInfo = await resolveTier(env, who);

  let mime = 'image/png';
  let bytes = new Uint8Array(0);
  if (ct.includes('multipart/form-data')) {
    // Reconstruct a Request so we can call .formData() on it.
    const tmp = new Request('https://x/', {
      method: 'POST',
      headers: { 'content-type': ct },
      body: rawBuf,
    });
    const form = await tmp.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') return json({ ok: false, error: 'no-file' }, 400);
    mime = (file.type || 'image/png').toLowerCase();
    bytes = new Uint8Array(await file.arrayBuffer());
  } else if (ALLOWED_REFERENCE_MIME.has(ct.split(';')[0].trim().toLowerCase())) {
    mime = ct.split(';')[0].trim().toLowerCase();
    bytes = new Uint8Array(rawBuf);
  } else {
    return json({ ok: false, error: 'unsupported-content-type' }, 415);
  }

  if (!ALLOWED_REFERENCE_MIME.has(mime)) {
    return json({ ok: false, error: 'unsupported-mime', mime }, 415);
  }
  if (bytes.byteLength > MAX_REFERENCE_BYTES) {
    return json({ ok: false, error: 'too-large', limit: MAX_REFERENCE_BYTES }, 413);
  }

  if (!env.OVERLAY_REFERENCES) {
    return json({
      ok: false,
      error: 'r2-not-wired',
      message: 'OVERLAY_REFERENCES R2 binding missing - see migration doc.',
    }, 503);
  }

  const ownerSlug = String(who.ownerId).replace(/[^a-z0-9_-]/gi, '_').slice(0, 48) || 'owner';
  const ext = mime === 'image/jpeg' ? 'jpg' : (mime === 'image/webp' ? 'webp' : 'png');
  const r2Key = `references/${ownerSlug}/${Date.now()}.${ext}`;

  await env.OVERLAY_REFERENCES.put(r2Key, bytes, {
    httpMetadata: { contentType: mime, cacheControl: 'private, max-age=300' },
    customMetadata: { ownerId: String(who.ownerId), tier: tierInfo.tier },
  });

  await ensureSchema(env);
  if (env.DB) {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO overlay_canvas_reference_images (owner_id, r2_key, mime, bytes, width, height, created_at, updated_at)`
      + ` VALUES (?, ?, ?, ?, 0, 0, ?, ?)`
      + ` ON CONFLICT(owner_id) DO UPDATE SET`
      + `  r2_key=excluded.r2_key, mime=excluded.mime, bytes=excluded.bytes, updated_at=excluded.updated_at`,
    ).bind(String(who.ownerId), r2Key, mime, bytes.byteLength, now, now).run();
  }

  return json({
    ok: true,
    url: `/api/overlay-canvas/reference-image/${encodeURIComponent(ownerSlug)}`,
    bytes: bytes.byteLength,
    mime,
  });
}

async function serveReferenceImage(env, ownerSlug) {
  if (!env.DB) return json({ ok: false, error: 'no-db' }, 503);
  let row;
  try {
    row = await env.DB.prepare(
      `SELECT r2_key, mime, bytes FROM overlay_canvas_reference_images WHERE owner_id = ?`,
    ).bind(ownerSlug).first();
  } catch {
    return json({ ok: false, error: 'lookup-failed' }, 500);
  }
  if (!row) return json({ ok: false, error: 'not-found' }, 404);
  if (!env.OVERLAY_REFERENCES) return json({ ok: false, error: 'r2-not-wired' }, 503);
  const obj = await env.OVERLAY_REFERENCES.get(row.r2_key);
  if (!obj) return json({ ok: false, error: 'gone' }, 410);
  return new Response(obj.body, {
    status: 200,
    headers: {
      'content-type': row.mime || 'image/png',
      'cache-control': 'public, max-age=60',
      'access-control-allow-origin': '*',
    },
  });
}

async function handleReferenceImageDelete(env, request) {
  const who = await requireOwner(env, request, '');
  if (!env.DB) return json({ ok: false, error: 'no-db' }, 503);
  let row;
  try {
    row = await env.DB.prepare(
      `SELECT r2_key FROM overlay_canvas_reference_images WHERE owner_id = ?`,
    ).bind(String(who.ownerId)).first();
  } catch { row = null; }
  if (row && env.OVERLAY_REFERENCES) {
    try { await env.OVERLAY_REFERENCES.delete(row.r2_key); } catch { /* ignore */ }
  }
  if (row) {
    await env.DB.prepare(
      `DELETE FROM overlay_canvas_reference_images WHERE owner_id = ?`,
    ).bind(String(who.ownerId)).run();
  }
  return json({ ok: true });
}

async function sha256Hex(bytes) {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── SSE event bus (reuses ActivityBroadcaster) ──────────────────────────

async function openOverlayCanvasSSE(env, request, broadcaster) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();

  const send = (event, dataObj) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(dataObj)}\n\n`;
    writer.write(enc.encode(frame)).catch(() => { /* closed */ });
  };

  send('hello', { ok: true, broadcaster, ts: Date.now(), schemaVersion: SCHEMA_VERSION });

  let cancelled = false;
  let heartbeat = null;
  const startHeartbeat = () => {
    heartbeat = setInterval(() => {
      writer.write(enc.encode(`: ping ${Date.now()}\n\n`)).catch(() => { cancelled = true; });
    }, 20_000);
  };
  startHeartbeat();

  request.signal?.addEventListener('abort', () => {
    cancelled = true;
    if (heartbeat) clearInterval(heartbeat);
    try { writer.close(); } catch { /* */ }
  });

  if (env.ACTIVITY_DO) {
    try {
      const id = env.ACTIVITY_DO.idFromName('global');
      const stub = env.ACTIVITY_DO.get(id);
      const upstream = await stub.fetch('https://do/sse', {
        headers: { 'accept': 'text/event-stream' },
      });
      if (upstream.body) {
        const reader = upstream.body.getReader();
        const decode = new TextDecoder();
        let buf = '';
        (async () => {
          while (!cancelled) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decode.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf('\n\n')) !== -1) {
              const frame = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              const lines = frame.split('\n');
              let evt = 'message';
              let dataLine = '';
              for (const ln of lines) {
                if (ln.startsWith('event:')) evt = ln.slice(6).trim();
                else if (ln.startsWith('data:')) dataLine += ln.slice(5).trim();
              }
              if (evt === 'activity' && dataLine) {
                let parsed;
                try { parsed = JSON.parse(dataLine); } catch { continue; }
                if (broadcaster !== 'global' && parsed.broadcaster && parsed.broadcaster !== broadcaster) continue;
                send('activity', parsed);
                // Also forward as a typed event so widget components can
                // addEventListener on the specific kind cheaply.
                if (parsed.kind) send(String(parsed.kind), parsed);
              }
            }
          }
          try { writer.close(); } catch { /* */ }
        })().catch(() => { /* upstream gone */ });
      }
    } catch (e) {
      console.warn('[overlay-canvas] upstream subscribe failed', e?.message || e);
    }
  }

  return new Response(readable, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'access-control-allow-origin': '*',
    },
  });
}

export { SCHEMA_VERSION, TIER_LIMITS, WIDGET_TYPES, validateLayout, scrubEmDash };
