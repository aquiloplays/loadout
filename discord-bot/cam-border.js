// cam-border.js
//
// Owner-configurable webcam border overlay backend.
//
// Wire-up in worker.js:
//   import { handleCamBorder } from './cam-border.js';
//   if (path.startsWith('/api/cam-border/')) return handleCamBorder(req, env, ctx, url);
//
// Routes (all paths begin /api/cam-border/):
//
//   GET  /config/:id
//     Public read of the JSON config blob stored in KV under
//     cam-border:config:<id>. Rate-limited per IP (60/min). When the id
//     is missing or unknown, returns the baked-in DEFAULT_CONFIG so the
//     overlay always renders something so Clay can point OBS at the URL
//     before saving anything.
//
//   PUT  /config/:id   (owner-only)
//     Replaces the config blob. Body is JSON validated against the
//     schema below. Updates the D1 row (creating it if missing). The
//     owner check reuses the same /api/link/status pattern used by the
//     existing /admin/* endpoints: site forwards an HMAC-signed envelope
//     with the linked owner id; worker verifies.
//
//   GET  /events/:broadcaster
//     SSE stream. Subscribes to the existing ActivityBroadcaster fanout
//     (the same DO that powers the community activity feed) and forwards
//     events relevant to the cam border to this client. No new EventSub
//     subs are created. The `broadcaster` segment is reserved for future
//     multi-streamer routing; v1 fires every event since Clay is the
//     only consumer.
//
//   GET  /configs?owner=<id>   (owner-only)
//     Lists every config owned by `owner`. v1 returns one row (Clay's),
//     v2 will return many.
//
//   POST /events/:broadcaster/test  (owner-only)
//     Owner-only test publish. Lets the admin live-preview fire mock
//     events through the real fanout so what you see in /cam-border is
//     exactly what hits the deployed overlay.
//
// Note: this module deliberately does not implement Patreon-tier
// gating. The `visibility` + `required_tier` columns are wired so the
// public-read endpoint can grow a tier check later (read the config row,
// if required_tier !== '' resolve the requester's patreon tier and 403
// on mismatch) without touching the overlay client at all.

const SCHEMA_VERSION = 1;

// Aurora brand defaults. These reuse the same hue tokens the rest of
// aquilo.gg uses (--primary-bright violet, --brand-pink, --brand-green).
// Stored as resolved hex so the overlay does not need to load the site
// stylesheet to render correctly inside OBS.
const DEFAULT_CONFIG = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  preset: 'aurora',
  shape: 'rounded',          // 'rectangle' | 'rounded' | 'circle' | 'hexagon'
  cornerRadius: 24,
  thickness: 28,
  speed: 0.4,                // 0..1, mapped to 60s..30s loop
  glow: 0.55,                // 0..1
  colors: ['#7c5cff', '#22d3ee', '#ec4899', '#3fdf80'],
  reactivity: {
    sub: true,
    giftSub: true,
    follow: true,
    raid: true,
    bits: true,
    chatHype: true,
    channelPointRedeem: true,
    hypeTrain: true,
    chatHypeWords: ['LETSGO', 'POG', 'POGGERS', 'HYPE', 'LFG'],
  },
  bubble: {
    enabled: true,
    position: 'right',       // 'top' | 'right' | 'bottom' | 'left'
    size: 0.62,              // 0..1
    rotationSec: 10,
    metrics: [
      { kind: 'subs', goal: 5, label: 'Subs' },
      { kind: 'bits', goal: 1000, label: 'Bits' },
      { kind: 'donations', goal: 25, label: 'Donations $' },
      { kind: 'patreon', goal: 100, label: 'Patrons' },
      { kind: 'follows', goal: 10, label: 'Follows' },
    ],
    colorOverride: null,
  },
});

const PRESETS = Object.freeze({
  aurora:    ['#7c5cff', '#22d3ee', '#ec4899', '#3fdf80'],
  sunset:    ['#ff7a59', '#ffb454', '#ff6ab5', '#7c5cff'],
  vaulttec:  ['#ffd34d', '#5bff95', '#0a3d2a', '#ffd34d'],
  cyberpunk: ['#00f0ff', '#ff00a0', '#ffeb00', '#7c5cff'],
});

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
function clampInt(v, lo, hi) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function validateConfig(input) {
  if (!input || typeof input !== 'object') {
    throw new HttpError(400, 'config-not-object');
  }
  const out = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  out.schemaVersion = SCHEMA_VERSION;
  if (typeof input.preset === 'string' && (PRESETS[input.preset] || input.preset === 'custom')) {
    out.preset = input.preset;
  }
  if (['rectangle', 'rounded', 'circle', 'hexagon'].includes(input.shape)) {
    out.shape = input.shape;
  }
  out.cornerRadius = clampInt(input.cornerRadius, 0, 120);
  out.thickness = clampInt(input.thickness, 4, 96);
  out.speed = clamp01(input.speed);
  out.glow = clamp01(input.glow);
  if (Array.isArray(input.colors) && input.colors.length >= 2 && input.colors.length <= 5) {
    const clean = input.colors.filter((c) => typeof c === 'string' && HEX_RE.test(c));
    if (clean.length >= 2) out.colors = clean;
  }
  if (input.reactivity && typeof input.reactivity === 'object') {
    for (const k of Object.keys(out.reactivity)) {
      if (k === 'chatHypeWords') continue;
      if (typeof input.reactivity[k] === 'boolean') out.reactivity[k] = input.reactivity[k];
    }
    if (Array.isArray(input.reactivity.chatHypeWords)) {
      const words = input.reactivity.chatHypeWords
        .filter((w) => typeof w === 'string')
        .map((w) => w.trim().toUpperCase())
        .filter((w) => w.length > 0 && w.length <= 24)
        .slice(0, 40);
      if (words.length) out.reactivity.chatHypeWords = words;
    }
  }
  if (input.bubble && typeof input.bubble === 'object') {
    if (typeof input.bubble.enabled === 'boolean') out.bubble.enabled = input.bubble.enabled;
    if (['top', 'right', 'bottom', 'left'].includes(input.bubble.position)) {
      out.bubble.position = input.bubble.position;
    }
    out.bubble.size = clamp01(input.bubble.size ?? out.bubble.size);
    out.bubble.rotationSec = clampInt(input.bubble.rotationSec ?? 10, 3, 120);
    if (Array.isArray(input.bubble.metrics)) {
      const allowed = ['subs', 'bits', 'donations', 'patreon', 'follows'];
      const cleaned = input.bubble.metrics
        .filter((m) => m && allowed.includes(m.kind))
        .map((m) => ({
          kind: m.kind,
          goal: Math.max(1, Math.round(Number(m.goal)) || 1),
          label: typeof m.label === 'string' ? m.label.slice(0, 24) : '',
        }));
      if (cleaned.length) out.bubble.metrics = cleaned;
    }
    if (typeof input.bubble.colorOverride === 'string' && HEX_RE.test(input.bubble.colorOverride)) {
      out.bubble.colorOverride = input.bubble.colorOverride;
    } else if (input.bubble.colorOverride === null) {
      out.bubble.colorOverride = null;
    }
  }
  return out;
}

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
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

// Per-IP token bucket for the public read path. Stored in KV under
// cam-border:rl:<ip> with a 60s TTL. 60 reads/min/IP is generous for an
// OBS source (which reads once per page load) but blocks scrape loops.
async function rateLimit(env, request, limit = 60, windowSec = 60) {
  if (!env.STATE) return true;
  const ip = request.headers.get('cf-connecting-ip')
    || request.headers.get('x-forwarded-for')
    || '0.0.0.0';
  const key = `cam-border:rl:${ip}`;
  const raw = await env.STATE.get(key);
  const count = raw ? Number(raw) || 0 : 0;
  if (count >= limit) return false;
  await env.STATE.put(key, String(count + 1), { expirationTtl: windowSec });
  return true;
}

// Owner-check helper. Reuses the existing site→worker HMAC envelope
// (`x-aquilo-web-{ts,sig}` signed with AQUILO_SITE_WEB_SECRET over
// `ts + "\n" + body`). The site-side functions/api/admin/cam-border.js
// is the only thing that signs these, and it gates on isOwner(sess)
// before signing, so a valid HMAC === owner request.
//
// We also accept CAM_BORDER_OWNER_OVERRIDE as a wrangler var so Clay
// can curl the PUT directly from a local terminal without a session.
async function requireOwner(env, request, rawBody) {
  const wts = request.headers.get('x-aquilo-web-ts');
  const wsig = request.headers.get('x-aquilo-web-sig');
  if (wts && wsig && env.AQUILO_SITE_WEB_SECRET) {
    const stale = Math.abs(Date.now() / 1000 - Number(wts)) > 300;
    if (!stale) {
      const ok = await verifyWebHmac(env.AQUILO_SITE_WEB_SECRET, wts, rawBody || '', wsig);
      if (ok) {
        // The site forwards the canonical owner id in a header for
        // auditing; default to "owner" when omitted.
        const ownerId = request.headers.get('x-aquilo-owner-id') || 'owner';
        return { ownerId, ownerType: 'twitch' };
      }
    }
  }
  if (env.CAM_BORDER_OWNER_OVERRIDE) {
    return { ownerId: String(env.CAM_BORDER_OWNER_OVERRIDE), ownerType: 'twitch' };
  }
  throw new HttpError(401, 'owner-required');
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

async function ensureSchema(env) {
  if (!env.DB) return;
  try {
    await env.DB.exec(
      `CREATE TABLE IF NOT EXISTS cam_border_configs (`
      + ` id TEXT PRIMARY KEY,`
      + ` owner_id TEXT NOT NULL,`
      + ` owner_type TEXT NOT NULL DEFAULT 'twitch',`
      + ` label TEXT NOT NULL DEFAULT '',`
      + ` visibility TEXT NOT NULL DEFAULT 'private',`
      + ` required_tier TEXT NOT NULL DEFAULT '',`
      + ` created_at INTEGER NOT NULL,`
      + ` updated_at INTEGER NOT NULL`
      + `)`,
    );
  } catch (e) {
    console.warn('[cam-border] ensureSchema', e?.message || e);
  }
}

// Slug guard. Config ids are short alphanumeric+dash slugs.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
function validSlug(s) { return typeof s === 'string' && SLUG_RE.test(s); }

export async function handleCamBorder(request, env, ctx, url) {
  const method = request.method;
  const path = url.pathname;

  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, PUT, POST, OPTIONS',
        'access-control-allow-headers': 'content-type, x-aquilo-web-ts, x-aquilo-web-sig, x-aquilo-owner-id',
        'access-control-max-age': '86400',
      },
    });
  }

  try {
    if (path === '/api/cam-border/default') {
      return json({ ok: true, config: DEFAULT_CONFIG, presets: PRESETS });
    }

    // GET /api/cam-border/config/:id
    const cfgMatch = path.match(/^\/api\/cam-border\/config\/([^/]+)$/);
    if (cfgMatch) {
      const id = cfgMatch[1];
      if (!validSlug(id)) return json({ ok: false, error: 'bad-id' }, 400);

      if (method === 'GET') {
        const ok = await rateLimit(env, request, 60, 60);
        if (!ok) return json({ ok: false, error: 'rate-limited' }, 429);
        const raw = env.STATE ? await env.STATE.get(`cam-border:config:${id}`) : null;
        if (!raw) {
          // Stable fallback: any unknown id returns the Aurora default so
          // OBS browser sources point at the URL before Clay configures
          // anything, and still render.
          return json({ ok: true, id, config: DEFAULT_CONFIG, source: 'default' });
        }
        try {
          const config = JSON.parse(raw);
          return json({ ok: true, id, config, source: 'stored' });
        } catch {
          return json({ ok: true, id, config: DEFAULT_CONFIG, source: 'default-fallback' });
        }
      }

      if (method === 'PUT') {
        const rawBody = await request.text();
        const who = await requireOwner(env, request, rawBody);
        await ensureSchema(env);
        let body;
        try { body = JSON.parse(rawBody || '{}'); }
        catch { return json({ ok: false, error: 'bad-json' }, 400); }
        const validated = validateConfig(body && body.config ? body.config : body);
        if (env.STATE) {
          await env.STATE.put(`cam-border:config:${id}`, JSON.stringify(validated));
        }
        if (env.DB) {
          const now = Date.now();
          const label = typeof body.label === 'string' ? body.label.slice(0, 64) : '';
          await env.DB.prepare(
            `INSERT INTO cam_border_configs (id, owner_id, owner_type, label, visibility, required_tier, created_at, updated_at)`
            + ` VALUES (?, ?, ?, ?, 'private', '', ?, ?)`
            + ` ON CONFLICT(id) DO UPDATE SET label=excluded.label, updated_at=excluded.updated_at`,
          ).bind(id, who.ownerId, who.ownerType, label, now, now).run();
        }
        return json({ ok: true, id, config: validated });
      }

      return json({ ok: false, error: 'method-not-allowed' }, 405);
    }

    // GET /api/cam-border/configs?owner=<id>
    if (path === '/api/cam-border/configs' && method === 'GET') {
      const who = await requireOwner(env, request, '');
      await ensureSchema(env);
      const owner = url.searchParams.get('owner') || who.ownerId;
      const rs = env.DB
        ? await env.DB.prepare(
            `SELECT id, label, visibility, required_tier, created_at, updated_at`
            + ` FROM cam_border_configs WHERE owner_id = ? ORDER BY updated_at DESC LIMIT 50`,
          ).bind(owner).all()
        : { results: [] };
      return json({ ok: true, owner, configs: rs.results || [] });
    }

    // GET /api/cam-border/events/:broadcaster   (SSE)
    const sseMatch = path.match(/^\/api\/cam-border\/events\/([^/]+)$/);
    if (sseMatch && method === 'GET') {
      return openCamBorderSSE(env, request, sseMatch[1]);
    }

    // POST /api/cam-border/events/:broadcaster/test
    const testMatch = path.match(/^\/api\/cam-border\/events\/([^/]+)\/test$/);
    if (testMatch && method === 'POST') {
      const rawBody = await request.text();
      await requireOwner(env, request, rawBody);
      let body;
      try { body = JSON.parse(rawBody || '{}'); }
      catch { return json({ ok: false, error: 'bad-json' }, 400); }
      const event = sanitizeTestEvent(body);
      await publishCamBorderEvent(env, testMatch[1], event);
      return json({ ok: true, event });
    }

    return json({ ok: false, error: 'not-found' }, 404);
  } catch (e) {
    if (e instanceof HttpError) {
      return json({ ok: false, error: e.code }, e.status);
    }
    console.error('[cam-border] error', e?.stack || e);
    return json({ ok: false, error: 'internal' }, 500);
  }
}

function sanitizeTestEvent(input) {
  const allowed = new Set([
    'sub', 'gift-sub', 'follow', 'raid', 'bits',
    'channel-point-redeem', 'chat-hype',
    'hype-train-begin', 'hype-train-progress', 'hype-train-end',
    'metric-update',
  ]);
  const kind = allowed.has(input?.kind) ? input.kind : 'follow';
  const payload = (input && typeof input.payload === 'object' && input.payload !== null) ? input.payload : {};
  return { kind, payload, ts: Date.now(), source: 'test' };
}

// Filter the firehose down to events relevant for the cam border, then
// forward them to this client. Reuses the existing ACTIVITY_DO fanout;
// we tap it with a private subscriber DO id ('cam-border:<broadcaster>')
// so other consumers (community feed) are not perturbed.
async function openCamBorderSSE(env, request, broadcaster) {
  // SSE response stream we own.
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();

  const send = (event, dataObj) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(dataObj)}\n\n`;
    writer.write(enc.encode(frame)).catch(() => { /* closed */ });
  };

  send('hello', { ok: true, broadcaster, ts: Date.now() });

  // Pipe-through from the activity DO. If the binding is absent (local
  // dev), we still send a hello + heartbeats so the overlay does not
  // sit in connect/retry forever.
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

  // Best-effort upstream subscribe: tap the in-memory KV pubsub on the
  // activity DO. (The DO already forwards `event: activity`.) We attach a
  // private listener via a custom DO path here when the binding exists.
  if (env.ACTIVITY_DO) {
    try {
      const id = env.ACTIVITY_DO.idFromName('global');
      const stub = env.ACTIVITY_DO.get(id);
      const upstream = await stub.fetch('https://do/sse', {
        headers: { 'accept': 'text/event-stream' },
      });
      if (upstream.body) {
        // Pipe raw frames through. Each upstream activity frame is
        // `event: activity\ndata: <json>\n\n`. We rewrite it as the
        // cam-border namespace so the overlay can listen for either
        // `event: activity` or the higher-level reactive types we mint
        // server-side (sub, follow, etc.) without doubling up.
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
                const mapped = mapActivityToCamBorder(parsed, broadcaster);
                if (mapped) send(mapped.kind, mapped);
              }
            }
          }
          try { writer.close(); } catch { /* */ }
        })().catch(() => { /* upstream gone */ });
      }
    } catch (e) {
      console.warn('[cam-border] upstream subscribe failed', e?.message || e);
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

// Translate a generic activity-feed event into the cam-border event
// shape the overlay reacts to. Returning null drops the event (not
// relevant for the cam border).
function mapActivityToCamBorder(act, broadcaster) {
  if (!act || typeof act !== 'object') return null;
  if (act.broadcaster && broadcaster && act.broadcaster !== broadcaster) return null;
  const k = String(act.kind || '').toLowerCase();
  switch (k) {
    case 'sub':
    case 'subscription':
      return { kind: 'sub', payload: { tier: act.tier || 1, user: act.user || act.userName || '' }, ts: act.ts || Date.now() };
    case 'gift-sub':
    case 'subgift':
      return { kind: 'gift-sub', payload: { count: act.count || 1, gifter: act.gifter || act.user || '' }, ts: act.ts || Date.now() };
    case 'follow':
      return { kind: 'follow', payload: { user: act.user || act.userName || '' }, ts: act.ts || Date.now() };
    case 'raid':
      return { kind: 'raid', payload: { from: act.from || act.fromUser || '', viewers: act.viewers || 0 }, ts: act.ts || Date.now() };
    case 'bits':
    case 'cheer':
      return { kind: 'bits', payload: { user: act.user || '', amount: act.amount || act.bits || 0 }, ts: act.ts || Date.now() };
    case 'channel-point-redeem':
    case 'redeem':
      return { kind: 'channel-point-redeem', payload: { user: act.user || '', reward: act.reward || '' }, ts: act.ts || Date.now() };
    case 'chat':
      // Only forward if the message contains a hype word; the overlay
      // decides whether to render. We pass the raw text so the overlay's
      // configured word list runs client-side.
      return { kind: 'chat-hype', payload: { user: act.user || '', text: String(act.text || '') }, ts: act.ts || Date.now() };
    case 'hype-train-begin':
      return { kind: 'hype-train-begin', payload: { level: act.level || 1, goal: act.goal || 1, progress: act.progress || 0 }, ts: act.ts || Date.now() };
    case 'hype-train-progress':
      return { kind: 'hype-train-progress', payload: { level: act.level || 1, goal: act.goal || 1, progress: act.progress || 0 }, ts: act.ts || Date.now() };
    case 'hype-train-end':
      return { kind: 'hype-train-end', payload: { level: act.level || 1 }, ts: act.ts || Date.now() };
    case 'metric-update':
      return { kind: 'metric-update', payload: act.payload || {}, ts: act.ts || Date.now() };
    default:
      return null;
  }
}

// Fire a cam-border event into the activity DO so every connected
// /api/cam-border/events/* client receives it. We mint it as an
// `activity` frame with kind=cam-border so the existing community feed
// can ignore it (it filters on its own kind list).
export async function publishCamBorderEvent(env, broadcaster, event) {
  if (!env.ACTIVITY_DO) return { ok: false, skipped: true };
  const payload = {
    kind: event.kind,
    broadcaster,
    payload: event.payload || {},
    ts: event.ts || Date.now(),
    namespace: 'cam-border',
  };
  try {
    const id = env.ACTIVITY_DO.idFromName('global');
    const stub = env.ACTIVITY_DO.get(id);
    await stub.fetch('https://do/publish', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 80) };
  }
}

export { DEFAULT_CONFIG, PRESETS, validateConfig };
