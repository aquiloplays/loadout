// warden-db.js — Warden schema + shared primitives (BE-1)
//
// Owns the D1 schema for the Warden moderator suite (aquilo_bot_db,
// binding DB) and a handful of cross-module primitives every other
// warden-*.js file imports:
//
//   ensureSchema(env)   idempotent CREATE TABLE IF NOT EXISTS for all
//                       warden_* tables + indices. Called (cheaply)
//                       before any D1 use in every module.
//   subjectKey(p, l)    '<platform>:<login-lowercased>' identity key.
//   now()               epoch millis.
//   newId()             random hex id (for audit rows etc).
//   mintRoomTicket(...) / verifyRoomTicket(...)  short-lived HMAC ticket
//                       (60s) authorising a WardenRoom WS open. HMAC over
//                       AQUILO_SITE_WEB_SECRET, mirrors the /web/* signing
//                       secret so the DO can verify with the same key.
//
// Graceful-degrade: ensureSchema no-ops when env.DB is absent (local /
// misconfigured) and swallows DDL errors rather than throwing to the top.

// D1 exec() runs a SINGLE statement per call, so the schema is a flat
// list of one-statement DDL strings run in sequence. Every statement is
// CREATE ... IF NOT EXISTS, so re-running is a no-op (this doubles as the
// lazy migrate() the contract asks for — there is nothing to alter yet).
const DDL = [
  `CREATE TABLE IF NOT EXISTS warden_mods (`
  + ` streamer_id TEXT NOT NULL,`
  + ` mod_id TEXT NOT NULL,`
  + ` mod_login TEXT,`
  + ` added_by TEXT,`
  + ` added_at INTEGER,`
  + ` status TEXT DEFAULT 'active',`
  + ` PRIMARY KEY (streamer_id, mod_id)`
  + `)`,
  `CREATE INDEX IF NOT EXISTS idx_warden_mods_mod ON warden_mods (mod_id)`,

  `CREATE TABLE IF NOT EXISTS warden_audit (`
  + ` id TEXT PRIMARY KEY,`
  + ` streamer_id TEXT NOT NULL,`
  + ` actor_id TEXT,`
  + ` actor_login TEXT,`
  + ` action TEXT,`
  + ` platform TEXT,`
  + ` target_login TEXT,`
  + ` target_id TEXT,`
  + ` detail TEXT,`
  + ` ts INTEGER`
  + `)`,
  `CREATE INDEX IF NOT EXISTS idx_warden_audit_stream_ts ON warden_audit (streamer_id, ts)`,

  `CREATE TABLE IF NOT EXISTS warden_notes (`
  + ` streamer_id TEXT NOT NULL,`
  + ` subject_key TEXT NOT NULL,`
  + ` note TEXT,`
  + ` author_id TEXT,`
  + ` author_login TEXT,`
  + ` updated_at INTEGER,`
  + ` PRIMARY KEY (streamer_id, subject_key)`
  + `)`,

  `CREATE TABLE IF NOT EXISTS warden_watchlist (`
  + ` streamer_id TEXT NOT NULL,`
  + ` subject_key TEXT NOT NULL,`
  + ` reason TEXT,`
  + ` flagged_by TEXT,`
  + ` ts INTEGER,`
  + ` PRIMARY KEY (streamer_id, subject_key)`
  + `)`,

  `CREATE TABLE IF NOT EXISTS warden_terms (`
  + ` streamer_id TEXT NOT NULL,`
  + ` term TEXT NOT NULL,`
  + ` mode TEXT,`
  + ` action TEXT,`
  + ` added_by TEXT,`
  + ` ts INTEGER,`
  + ` PRIMARY KEY (streamer_id, term)`
  + `)`,

  `CREATE TABLE IF NOT EXISTS warden_identity (`
  + ` streamer_id TEXT NOT NULL,`
  + ` subject_key TEXT NOT NULL,`
  + ` twitch_login TEXT,`
  + ` youtube_id TEXT,`
  + ` kick_login TEXT,`
  + ` tiktok_login TEXT,`
  + ` updated_at INTEGER,`
  + ` PRIMARY KEY (streamer_id, subject_key)`
  + `)`,
];

// Cheap in-isolate guard so we don't re-issue the DDL on every call
// within a warm isolate. Best-effort only — a cold isolate re-runs it,
// and every statement is IF NOT EXISTS, so correctness never depends on
// this flag.
let _schemaReady = false;

export async function ensureSchema(env) {
  if (_schemaReady) return;
  if (!env || !env.DB) return;   // graceful-degrade: no D1 bound
  try {
    for (const stmt of DDL) {
      await env.DB.exec(stmt.replace(/\s+/g, ' ').trim());
    }
    _schemaReady = true;
  } catch (e) {
    // Don't throw to the top — a schema hiccup should surface as a
    // route-level {ok:false} downstream, not a 500.
    console.warn('[warden] ensureSchema', e?.message || e);
  }
}

// '<platform>:<login>' with the login lowercased + trimmed. Used as the
// stable cross-platform subject key for notes / watchlist / identity.
export function subjectKey(platform, login) {
  const p = String(platform || 'twitch').trim().toLowerCase() || 'twitch';
  const l = String(login || '').trim().toLowerCase();
  return `${p}:${l}`;
}

export function now() {
  return Date.now();
}

// Random 32-hex-char id (128 bits) for audit rows and any other row that
// needs a collision-free primary key.
export function newId() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Room WS ticket ────────────────────────────────────────────────────
// A ticket authorises a single WS open against the streamer's WardenRoom
// DO. Payload is base64url(JSON) and the tag is HMAC-SHA256 over that
// base64url string, keyed by AQUILO_SITE_WEB_SECRET (the same secret the
// site→worker HMAC uses, so the DO — running in this worker — verifies
// with a key it already has). 60-second expiry keeps a leaked ticket
// near-useless.
const TICKET_TTL_MS = 60_000;

function b64urlEncode(str) {
  // str is ASCII/JSON; btoa is fine for the UTF-8-safe subset we emit.
  let bin = '';
  const bytes = new TextEncoder().encode(str);
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(s) {
  let b = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  try {
    const bin = atob(b);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(out);
  } catch {
    return null;
  }
}

function bytesToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return bytesToHex(sig);
}

// Constant-time-ish string compare (both hex of equal length). Avoids
// leaking match progress via early-return timing.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// mintRoomTicket -> '<b64url payload>.<hex hmac>' | null (no secret).
export async function mintRoomTicket(env, streamerId, actorId, actorLogin, role) {
  if (!env || !env.AQUILO_SITE_WEB_SECRET) return null;
  const payload = b64urlEncode(JSON.stringify({
    streamerId: String(streamerId || ''),
    actorId: String(actorId || ''),
    actorLogin: String(actorLogin || ''),
    role: role === 'broadcaster' ? 'broadcaster' : role === 'agent' ? 'agent' : role === 'viewer' ? 'viewer' : 'mod',
    exp: now() + TICKET_TTL_MS,
  }));
  const tag = await hmacHex(env.AQUILO_SITE_WEB_SECRET, payload);
  return `${payload}.${tag}`;
}

// verifyRoomTicket -> { streamerId, actorId, actorLogin, role, exp } | null.
// Rejects on: no secret, malformed, bad HMAC, or expired.
export async function verifyRoomTicket(env, ticket) {
  if (!env || !env.AQUILO_SITE_WEB_SECRET) return null;
  const t = String(ticket || '');
  const dot = t.indexOf('.');
  if (dot <= 0) return null;
  const payload = t.slice(0, dot);
  const tag = t.slice(dot + 1);
  if (!payload || !tag) return null;
  let expected;
  try {
    expected = await hmacHex(env.AQUILO_SITE_WEB_SECRET, payload);
  } catch {
    return null;
  }
  if (!safeEqual(tag, expected)) return null;
  const jsonStr = b64urlDecode(payload);
  if (!jsonStr) return null;
  let obj;
  try { obj = JSON.parse(jsonStr); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  if (typeof obj.exp !== 'number' || now() > obj.exp) return null;
  if (!obj.streamerId) return null;
  return {
    streamerId: String(obj.streamerId),
    actorId: String(obj.actorId || ''),
    actorLogin: String(obj.actorLogin || ''),
    // 'viewer' = read-only chat display (the Twitch panel's shared-chat
    // tab). Anything unknown collapses to 'mod' as before.
    role: obj.role === 'broadcaster' ? 'broadcaster' : obj.role === 'viewer' ? 'viewer' : 'mod',
    exp: obj.exp,
  };
}
