// Backend for the StreamFusion chat dock (aquilo.gg/dock/streamfusion-chat)
// and the standalone overlay profiles (aquilo.gg/sf/overlay/* + /sf/customize).
//
//   POST /api/sfdock/gate         { token }                 -> { ok, tier, owner, premium }
//   POST /api/sfdock/translate    { text, token }           -> { ok, translation }   (patron)
//   POST /api/sfdock/mod          { action, ... , token }   -> stub
//   POST /api/sfdock/clip         { token }                 -> stub
//   GET  /api/sfdock/profile?id=  -> { ok, overlays, updatedAt }   (public read)
//   POST /api/sfdock/profile      { id?, editKey?, overlays } -> { ok, id, editKey, updatedAt }
//   GET  /api/sfdock/cosmetics?ch= -> { ok, flairs, firstWords }  (public read; overlay cosmeticsUrl)
//
// Premium (auto-translate) gates on a Patreon pledge to the Aquilo campaign
// using the same campaign-scoped entitlement path as the Rotation presets
// (widget-presets.getWidgetPresetAccess). The Patreon token is hashed for the
// KV cache key and never logged; the ANTHROPIC key stays server-side.
//
// Overlay profiles let a streamer customize the hosted overlays at
// aquilo.gg/sf/customize and use them in OBS WITHOUT running the StreamFusion
// desktop app. The customizer "publishes" a profile (random id + edit key)
// to KV; the overlay URL carries ?p=<id> and fetches its look on boot. No
// login required: the unguessable id is the read capability, the edit key
// (kept only in the customizer's localStorage) is the write capability.
import { getWidgetPresetAccess } from './widget-presets.js';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS } });
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function genHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// T2+ ($5+) or owner. getWidgetPresetAccess returns { tier, owner, cents }.
async function premiumOk(env, token) {
  if (!token) return { ok: false, premium: false, tier: 'none', owner: false };
  try {
    const a = await getWidgetPresetAccess(env, token);
    const premium = !!a.owner || Number(a.cents || 0) >= 500;
    return { ok: !!a.ok, premium, tier: a.tier || 'none', owner: !!a.owner };
  } catch {
    return { ok: false, premium: false, tier: 'none', owner: false };
  }
}

async function callHaiku(env, prompt, maxTokens) {
  const key = String(env.ANTHROPIC_API_KEY || '').trim();
  if (!key) throw new Error('translate-not-configured');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: HAIKU_MODEL, max_tokens: maxTokens || 200, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!r.ok) throw new Error('anthropic ' + r.status);
  const j = await r.json();
  return (j.content || []).map((c) => c.text || '').join('').trim();
}

// ── Overlay profile storage (KV: LOADOUT_BOLTS) ──────────────────────────
const PROFILE_PREFIX = 'sf:ovl:';
// chatUndercam = the optional second chat instance (a streamer's separate
// under-cam chat) — same shape as `chat`, loaded by the overlay via ?slot=.
const OVERLAY_KEYS = ['chat', 'chatUndercam', 'alerts', 'shoutout', 'vertical', 'ticker'];
const MAX_PROFILE_BYTES = 64 * 1024;     // a fully-loaded 5-overlay cfg is < 8KB
const CREATE_CAP_PER_HOUR = 60;          // soft anti-spam on anonymous creates

function sanitizeOverlays(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const k of OVERLAY_KEYS) {
    if (raw[k] && typeof raw[k] === 'object' && !Array.isArray(raw[k])) out[k] = raw[k];
  }
  return Object.keys(out).length ? out : null;
}

async function handleProfileGet(env, url) {
  const id = String(url.searchParams.get('id') || '').toLowerCase();
  if (!/^[a-f0-9]{8,40}$/.test(id)) return json({ ok: false, error: 'bad-id' }, 400);
  let rec = null;
  try { rec = await env.LOADOUT_BOLTS.get(PROFILE_PREFIX + id, { type: 'json' }); } catch { /* ignore */ }
  if (!rec) return json({ ok: false, error: 'not-found' }, 404);
  // Never echo the edit key.
  return json({ ok: true, overlays: rec.overlays || {}, updatedAt: rec.updatedAt || 0 });
}

async function handleProfileSave(env, body, ip) {
  const overlays = sanitizeOverlays(body.overlays);
  if (!overlays) return json({ ok: false, error: 'no-overlays' }, 400);
  const payloadSize = JSON.stringify(overlays).length;
  if (payloadSize > MAX_PROFILE_BYTES) return json({ ok: false, error: 'too-large' }, 413);

  const wantId = String(body.id || '').toLowerCase();
  // Update path: id + matching edit key.
  if (wantId) {
    if (!/^[a-f0-9]{8,40}$/.test(wantId)) return json({ ok: false, error: 'bad-id' }, 400);
    let rec = null;
    try { rec = await env.LOADOUT_BOLTS.get(PROFILE_PREFIX + wantId, { type: 'json' }); } catch { /* ignore */ }
    if (!rec) return json({ ok: false, error: 'not-found' }, 404);
    if (!body.editKey || body.editKey !== rec.ek) return json({ ok: false, error: 'forbidden' }, 403);
    const updatedAt = Date.now();
    const next = { v: 1, overlays, ek: rec.ek, updatedAt };
    try { await env.LOADOUT_BOLTS.put(PROFILE_PREFIX + wantId, JSON.stringify(next)); }
    catch { return json({ ok: false, error: 'write-failed' }, 502); }
    return json({ ok: true, id: wantId, updatedAt });
  }

  // Create path: soft per-IP rate limit, then mint id + edit key.
  if (ip) {
    const rlKey = 'sf:ovl:rl:' + ip;
    let n = 0;
    try { n = Number(await env.LOADOUT_BOLTS.get(rlKey)) || 0; } catch { /* ignore */ }
    if (n >= CREATE_CAP_PER_HOUR) return json({ ok: false, error: 'rate-limited' }, 429);
    try { await env.LOADOUT_BOLTS.put(rlKey, String(n + 1), { expirationTtl: 3600 }); } catch { /* ignore */ }
  }
  const id = genHex(8);          // 16 hex chars
  const ek = genHex(16);         // 32 hex chars
  const updatedAt = Date.now();
  const rec = { v: 1, overlays, ek, updatedAt };
  try { await env.LOADOUT_BOLTS.put(PROFILE_PREFIX + id, JSON.stringify(rec)); }
  catch { return json({ ok: false, error: 'write-failed' }, 502); }
  return json({ ok: true, id, editKey: ek, updatedAt });
}

// ── Viewer cosmetics read (KV: LOADOUT_BOLTS key `sfcos:<ch>`) ────────────
// Per-channel { flairs, firstWords } served to the chat overlay's
// `cosmeticsUrl`. READ-ONLY + public here: the unguessable channel login is a
// public identifier, the served data is cosmetic, and the Twitch extension
// owns the authenticated write/purchase path (spend goes through the
// extension's channel Bolts economy — see SF-VIEWER-COSMETICS-BACKEND.md).
// Shape mirrors what the overlay merges (chat/index.html fetchCloudCosmetics):
//   flairs[login]     = { badge, color }   badge = emoji or https image URL
//   firstWords[login] = <effect in FX_EFFECTS>
const COSMETICS_PREFIX = 'sfcos:';
// Must stay in sync with the overlay's _FX_EFFECTS palette (chat/index.html).
const FX_EFFECTS = new Set([
  'confetti', 'shake', 'flash', 'emote-rain', 'hype-text', 'firework',
  'hearts', 'snow', 'rainbow', 'sparkles', 'bubbles', 'bounce', 'zoom',
]);
const MAX_COSMETIC_LOGINS = 5000;   // cap the served map so a bloated blob can't bloat the overlay

// Mirror of the overlay's safeColor() — only serve CSS-safe color tokens so a
// stored value can never smuggle style/markup through to the overlay.
function safeCosmeticColor(c) {
  c = String(c == null ? '' : c).trim();
  if (!c) return '';
  if (c === 'var(--accent)') return c;
  if (/^#[0-9a-fA-F]{3,8}$/.test(c)) return c;
  if (/^rgba?\([0-9.,%\s/]+\)$/.test(c)) return c;
  if (/^hsla?\([0-9.,%\s/deg]+\)$/.test(c)) return c;
  if (/^[a-zA-Z]{3,20}$/.test(c)) return c;
  return '';
}

// A badge is an emoji/short text OR an https image URL. Reject http:// and any
// non-URL that looks like markup; the overlay renders https badges as <img>.
function safeCosmeticBadge(b) {
  const s = String(b == null ? '' : b).trim().slice(0, 300);
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return /^https:\/\/[^\s"'<>]+$/i.test(s) ? s : '';
  if (/[<>]/.test(s)) return '';
  return s;
}

function sanitizeCosmetics(rec) {
  const flairs = {};
  const firstWords = {};
  if (!rec || typeof rec !== 'object') return { flairs, firstWords };
  const rf = (rec.flairs && typeof rec.flairs === 'object') ? rec.flairs : {};
  let n = 0;
  for (const login of Object.keys(rf)) {
    if (n >= MAX_COSMETIC_LOGINS) break;
    const lk = String(login).toLowerCase();
    if (!/^[a-z0-9_]{1,25}$/.test(lk)) continue;
    const v = rf[login] || {};
    const badge = safeCosmeticBadge(v.badge);
    const color = safeCosmeticColor(v.color);
    if (!badge && !color) continue;   // nothing renderable — skip
    flairs[lk] = { badge, color };
    n++;
  }
  const rw = (rec.firstWords && typeof rec.firstWords === 'object') ? rec.firstWords : {};
  let m = 0;
  for (const login of Object.keys(rw)) {
    if (m >= MAX_COSMETIC_LOGINS) break;
    const lk = String(login).toLowerCase();
    if (!/^[a-z0-9_]{1,25}$/.test(lk)) continue;
    const fx = String(rw[login] || '');
    if (!FX_EFFECTS.has(fx)) continue;
    firstWords[lk] = fx;
    m++;
  }
  return { flairs, firstWords };
}

async function handleCosmeticsGet(env, url) {
  const headers = { 'content-type': 'application/json', 'cache-control': 'public, max-age=30', ...CORS };
  const ch = String(url.searchParams.get('ch') || '').trim().toLowerCase().replace(/^@/, '');
  if (!/^[a-z0-9_]{2,25}$/.test(ch)) {
    return new Response(JSON.stringify({ ok: false, error: 'bad-channel', flairs: {}, firstWords: {} }), { status: 400, headers });
  }
  let rec = null;
  try { rec = await env.LOADOUT_BOLTS.get(COSMETICS_PREFIX + ch, { type: 'json' }); } catch { /* miss -> empty */ }
  const { flairs, firstWords } = sanitizeCosmetics(rec);
  return new Response(JSON.stringify({ ok: true, ch, flairs, firstWords }), { status: 200, headers });
}

// ── Translate cache + per-token daily quota ──────────────────────────────
const TRANSLATE_CACHE_TTL = 7 * 24 * 3600;   // identical messages are cheap to dedupe
const TRANSLATE_DAILY_CAP = 2000;            // per Patreon token; owners exempt

export async function handleSfDock(req, env, path) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);

  // Public profile read (GET), overlays fetch their look by id on boot.
  if (path === '/api/sfdock/profile' && req.method === 'GET') {
    return handleProfileGet(env, url);
  }

  // Public viewer-cosmetics read (GET); the chat overlay's cosmeticsUrl points
  // here and merges the equipped flairs + first-words effects per viewer.
  if (path === '/api/sfdock/cosmetics' && req.method === 'GET') {
    return handleCosmeticsGet(env, url);
  }

  if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405);
  let body = {};
  try { body = await req.json(); } catch { /* empty */ }

  if (path === '/api/sfdock/profile') {
    const ip = req.headers.get('cf-connecting-ip') || '';
    return handleProfileSave(env, body, ip);
  }

  if (path === '/api/sfdock/gate') {
    const p = await premiumOk(env, body.token);
    return json({ ok: true, tier: p.tier, owner: p.owner, premium: p.premium });
  }

  if (path === '/api/sfdock/translate') {
    const p = await premiumOk(env, body.token);
    if (!p.premium) return json({ ok: false, error: 'patreon-required', minTier: 't2' }, 402);
    const text = String(body.text || '').slice(0, 400).trim();
    if (!text) return json({ ok: false, error: 'empty' }, 400);

    // 1) identical-message cache: most translate traffic is repeated spam /
    //    copypasta, so this collapses the bulk of the Anthropic spend.
    const cacheKey = 'sf:tr:' + (await sha256Hex(text.toLowerCase())).slice(0, 40);
    try {
      const hit = await env.LOADOUT_BOLTS.get(cacheKey);
      if (hit != null) return json({ ok: true, translation: hit, cached: true });
    } catch { /* ignore */ }

    // 2) per-token daily quota so a flood of unique foreign-language messages
    //    can't run up an unbounded Anthropic bill. Owners are exempt.
    if (!p.owner) {
      const day = new Date().toISOString().slice(0, 10);
      const qKey = 'sf:trq:' + (await sha256Hex(body.token)).slice(0, 24) + ':' + day;
      let used = 0;
      try { used = Number(await env.LOADOUT_BOLTS.get(qKey)) || 0; } catch { /* ignore */ }
      if (used >= TRANSLATE_DAILY_CAP) return json({ ok: false, error: 'quota', retryAfter: 'tomorrow' }, 429);
      try { await env.LOADOUT_BOLTS.put(qKey, String(used + 1), { expirationTtl: 2 * 24 * 3600 }); } catch { /* ignore */ }
    }

    try {
      const out = await callHaiku(env,
        'Translate this live-stream chat message to English. Reply with ONLY the translation, ' +
        'no quotes and no notes. If it is already English, reply with exactly an empty line.\n\nMessage: ' + text, 160);
      const t = out.replace(/^["']|["']$/g, '').trim();
      const translation = (t && t.toLowerCase() !== text.toLowerCase()) ? t.slice(0, 300) : '';
      try { await env.LOADOUT_BOLTS.put(cacheKey, translation, { expirationTtl: TRANSLATE_CACHE_TTL }); } catch { /* ignore */ }
      return json({ ok: true, translation });
    } catch (e) {
      return json({ ok: false, error: String(e.message || e).slice(0, 60) }, 502);
    }
  }

  // Mod actions + clip require the broadcaster's Twitch OAuth (Helix moderation
  // + clips:edit) or routing through a Streamer.bot action. Not wired yet; the
  // dock surfaces this message. See the dock README for the two wiring options.
  if (path === '/api/sfdock/mod' || path === '/api/sfdock/clip') {
    return json({ ok: false, error: 'not-configured',
      message: 'Connect Twitch mod/clip auth to enable this (see the dock README).' }, 501);
  }

  return json({ ok: false, error: 'not-found' }, 404);
}
