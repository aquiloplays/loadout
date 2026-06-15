// tikfinity-keys.js
//
// Per-user personalised TikFinity webhook keys + the polling buffer
// behind the setup wizard's "Waiting for test event..." card.
//
// The TikFinity bridge in tikfinity.js still owns the canonical event
// handler (gift -> recordGifterEvent etc). This module adds:
//   1. a 32-char URL-safe key per streamer
//   2. a tiny KV-backed event ring per key so the wizard can poll
//      "has anything arrived yet?" without hitting D1
//   3. /tikfinity/event?key=... ingest that resolves the key to the
//      owning user and routes through the same recordGifterEvent path
//
// V1 ships owner-gated (only Clay can claim a key). V2 should drop
// the owner check and treat any signed-in streamer as eligible; the
// key lookup is intentionally keyed on user_id, not on a hard-coded
// owner constant, so flipping that gate is a one-line change in
// requireOwnerOrUser().
//
// D1 schema (created lazily, canonical migration in
// tikfinity-keys-migration.sql):
//
//   CREATE TABLE tikfinity_keys (
//     user_id     TEXT PRIMARY KEY,
//     key         TEXT NOT NULL UNIQUE,
//     created_at  INTEGER NOT NULL,
//     last_event_at INTEGER,
//     event_count INTEGER NOT NULL DEFAULT 0,
//     revoked_at  INTEGER
//   );
//   CREATE INDEX idx_tikfinity_keys_key ON tikfinity_keys(key);
//
// KV layout (LOADOUT_BOLTS):
//   tikfinity:recent:<userId>   JSON ring buffer of last 10 events
//                                (kept 15 min, used by the polling
//                                 endpoint only)

import { recordGifterEvent } from './gifter-roles.js';

const RECENT_KEY = (u) => `tikfinity:recent:${u}`;
const RECENT_TTL_SEC = 60 * 15;
const RECENT_CAP = 10;

// Same v1 owner gate dock.js uses. Flip both lists together if the
// owner identity ever changes.
const OWNER_DISCORD_IDS = new Set(['1107161695262085210']);
const OWNER_EMAILS = new Set(['bisherclay@gmail.com']);

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,x-aquilo-web-ts,x-aquilo-web-sig,x-aquilo-owner-id,x-aquilo-owner-email',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...CORS,
    },
  });
}

async function ensureSchema(env) {
  if (!env.DB) return;
  try {
    await env.DB.exec(
      'CREATE TABLE IF NOT EXISTS tikfinity_keys ('
      + ' user_id TEXT PRIMARY KEY,'
      + ' key TEXT NOT NULL UNIQUE,'
      + ' created_at INTEGER NOT NULL,'
      + ' last_event_at INTEGER,'
      + ' event_count INTEGER NOT NULL DEFAULT 0,'
      + ' revoked_at INTEGER'
      + ');'
    );
    await env.DB.exec('CREATE INDEX IF NOT EXISTS idx_tikfinity_keys_key ON tikfinity_keys(key);');
  } catch (e) {
    // Idempotent CREATE; swallow "already exists" style errors.
  }
}

function newKey() {
  // 32 bytes URL-safe base64 = 43 chars, comfortably above the
  // 32-char minimum the spec calls for.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // base64url, no padding, so the key is safe in a query string and
  // copy-pastes cleanly without trailing "=" surprises.
  let b64 = btoa(String.fromCharCode.apply(null, bytes));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// HMAC envelope shared with dock.js / vault.js / etc.
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

// Owner gate for v1. Returns { userId, isOwner } on success; throws
// on failure. v2: relax the owner check, accept any signed-in user
// (just verify the HMAC + ownerId headers) and return the userId.
async function requireOwnerOrUser(env, req, rawBody) {
  const wts = req.headers.get('x-aquilo-web-ts');
  const wsig = req.headers.get('x-aquilo-web-sig');
  if (!wts || !wsig || !env.AQUILO_SITE_WEB_SECRET) {
    return { error: 'auth-required', status: 401 };
  }
  const stale = Math.abs(Date.now() / 1000 - Number(wts)) > 300;
  if (stale) return { error: 'auth-stale', status: 401 };
  const ok = await verifyWebHmac(env.AQUILO_SITE_WEB_SECRET, wts, rawBody || '', wsig);
  if (!ok) return { error: 'bad-sig', status: 401 };
  const ownerId = req.headers.get('x-aquilo-owner-id') || '';
  const ownerEmail = (req.headers.get('x-aquilo-owner-email') || '').toLowerCase().trim();
  const isOwner = OWNER_DISCORD_IDS.has(String(ownerId)) || OWNER_EMAILS.has(ownerEmail);
  // V1: gate strictly to the configured owner. V2: drop this guard and
  // any signed-in user gets their own key bucket.
  if (!isOwner) return { error: 'owner-required', status: 403 };
  return { userId: String(ownerId), isOwner: true };
}

// ── Public: get-or-create key for the calling user ────────────────
export async function getOrCreateKey(env, userId) {
  await ensureSchema(env);
  if (!env.DB) return { ok: false, error: 'db-not-configured' };
  const existing = await env.DB
    .prepare('SELECT key, created_at, last_event_at, event_count, revoked_at FROM tikfinity_keys WHERE user_id = ?')
    .bind(userId).first();
  if (existing && !existing.revoked_at) {
    return { ok: true, key: existing.key, createdAt: existing.created_at,
             lastEventAt: existing.last_event_at, eventCount: existing.event_count };
  }
  const key = newKey();
  const now = Date.now();
  if (existing && existing.revoked_at) {
    await env.DB
      .prepare('UPDATE tikfinity_keys SET key = ?, created_at = ?, revoked_at = NULL, event_count = 0, last_event_at = NULL WHERE user_id = ?')
      .bind(key, now, userId).run();
  } else {
    await env.DB
      .prepare('INSERT INTO tikfinity_keys (user_id, key, created_at, event_count) VALUES (?, ?, ?, 0)')
      .bind(userId, key, now).run();
  }
  return { ok: true, key, createdAt: now, eventCount: 0, lastEventAt: null };
}

export async function rotateKey(env, userId) {
  await ensureSchema(env);
  if (!env.DB) return { ok: false, error: 'db-not-configured' };
  const key = newKey();
  const now = Date.now();
  const existing = await env.DB
    .prepare('SELECT user_id FROM tikfinity_keys WHERE user_id = ?')
    .bind(userId).first();
  if (!existing) {
    await env.DB
      .prepare('INSERT INTO tikfinity_keys (user_id, key, created_at, event_count) VALUES (?, ?, ?, 0)')
      .bind(userId, key, now).run();
  } else {
    await env.DB
      .prepare('UPDATE tikfinity_keys SET key = ?, created_at = ?, revoked_at = NULL, event_count = 0, last_event_at = NULL WHERE user_id = ?')
      .bind(key, now, userId).run();
  }
  // Wipe the recent ring so the wizard starts from a clean state.
  try { await env.LOADOUT_BOLTS.delete(RECENT_KEY(userId)); } catch { /* idle */ }
  return { ok: true, key, createdAt: now };
}

async function lookupUserByKey(env, key) {
  if (!env.DB || !key) return null;
  try {
    const row = await env.DB
      .prepare('SELECT user_id, revoked_at FROM tikfinity_keys WHERE key = ? LIMIT 1')
      .bind(key).first();
    if (!row) return null;
    if (row.revoked_at) return null;
    return String(row.user_id);
  } catch { return null; }
}

// Append an event to the per-user ring buffer. Best-effort; KV
// hiccups never block the canonical /tikfinity/event response.
async function pushRecent(env, userId, evt) {
  try {
    const cur = (await env.LOADOUT_BOLTS.get(RECENT_KEY(userId), { type: 'json' })) || [];
    cur.unshift(evt);
    while (cur.length > RECENT_CAP) cur.pop();
    await env.LOADOUT_BOLTS.put(RECENT_KEY(userId), JSON.stringify(cur), { expirationTtl: RECENT_TTL_SEC });
  } catch (e) {
    console.warn('[tikfinity-keys] pushRecent failed', e && e.message);
  }
}

// ── Public: /tikfinity/event?key=... ─────────────────────────────
// Mounted in worker.js. Mirrors tikfinity.js's bearer-secret variant
// but uses the per-user key from the query string instead of a single
// shared header secret. Both can coexist; this route is opt-in via the
// presence of ?key=.
export async function handleKeyedEvent(req, env) {
  const url = new URL(req.url);
  const key = url.searchParams.get('key') || '';
  if (!key) return json({ ok: false, error: 'missing-key' }, 400);

  const userId = await lookupUserByKey(env, key);
  if (!userId) return json({ ok: false, error: 'unknown-or-revoked-key' }, 401);

  let payload;
  try { payload = await req.json(); }
  catch { return json({ ok: false, error: 'bad-json' }, 400); }
  if (!payload || typeof payload !== 'object') {
    return json({ ok: false, error: 'bad-payload' }, 400);
  }

  const event = String(payload.event || payload.type || 'gift').toLowerCase();
  const uniqueId = String(
    payload.uniqueId || payload.username || payload.user || payload.nickname || 'tester'
  ).trim().toLowerCase();
  const nickname = String(payload.nickname || payload.displayName || uniqueId);
  const tsMs = Number(payload.timestamp || payload.ts || Date.now());

  // Update D1 counters + push to the wizard's polling ring regardless
  // of event kind so the "Got it!" state lights up for likes/follows
  // too, not just gifts. (Diamond / repeat are still gift-only.)
  await pushRecent(env, userId, {
    event, uniqueId, nickname, ts: tsMs,
    diamondCount: Number(payload.diamondCount ?? 0),
    repeatCount:  Number(payload.repeatCount  ?? 1),
    test: !!payload.test,
  });
  try {
    await env.DB
      .prepare('UPDATE tikfinity_keys SET last_event_at = ?, event_count = event_count + 1 WHERE user_id = ?')
      .bind(tsMs, userId).run();
  } catch (e) { /* counters are best-effort */ }

  // Route gift events through the existing aggregator, exactly like
  // tikfinity.js does. Skip the recordGifterEvent call for test
  // events so a wizard verification can't pollute leaderboards.
  if (event === 'gift' && !payload.test) {
    const guildId = String(env.AQUILO_VAULT_GUILD_ID || '').trim();
    if (!guildId) return json({ ok: true, recorded: false, reason: 'no-guild-id' });
    const diamondCount = Number(payload.diamondCount ?? payload.diamonds ?? 0);
    const repeatCount  = Number(payload.repeatCount  ?? payload.giftCount ?? 1);
    const amount = Math.trunc(diamondCount * (repeatCount > 0 ? repeatCount : 1));
    if (Number.isFinite(amount) && amount > 0 && uniqueId) {
      const r = await recordGifterEvent(env, guildId, 'tip', 'tiktok', uniqueId, amount, tsMs);
      return json({ ok: true, source: 'tikfinity-keyed', userId, recorded: !!r.ok, ...r });
    }
  }
  return json({ ok: true, source: 'tikfinity-keyed', userId, recorded: false, event });
}

// ── Public: /api/tikfinity/key (GET/POST/DELETE) ─────────────────
// Owner-gated v1; v2 drops the gate and any signed-in user can mint.
// GET = read current key; POST = ensure-key (create on first hit);
// DELETE = rotate (revoke + issue new).
export async function handleKeyApi(req, env) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  const rawBody = (req.method === 'GET' || req.method === 'DELETE') ? '' : await req.text();
  const who = await requireOwnerOrUser(env, req, rawBody);
  if (who.error) return json({ ok: false, error: who.error }, who.status);

  if (req.method === 'GET') {
    const r = await getOrCreateKey(env, who.userId);
    return json(r, r.ok ? 200 : 500);
  }
  if (req.method === 'POST') {
    const r = await getOrCreateKey(env, who.userId);
    return json(r, r.ok ? 200 : 500);
  }
  if (req.method === 'DELETE') {
    const r = await rotateKey(env, who.userId);
    return json(r, r.ok ? 200 : 500);
  }
  return json({ ok: false, error: 'method-not-allowed' }, 405);
}

// ── Public: /api/tikfinity/recent (GET) ─────────────────────────
// Polled by the setup wizard's "Waiting for test event..." card.
// Returns the last 10 events seen for the calling user, plus a
// monotonic count so the page can detect "something new arrived
// since the last poll" without doing its own diffing.
export async function handleRecentApi(req, env) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  const who = await requireOwnerOrUser(env, req, '');
  if (who.error) return json({ ok: false, error: who.error }, who.status);
  await ensureSchema(env);
  const events = (await env.LOADOUT_BOLTS.get(RECENT_KEY(who.userId), { type: 'json' })) || [];
  let connected = false;
  let lastEventAt = null;
  let eventCount = 0;
  try {
    const row = await env.DB
      .prepare('SELECT last_event_at, event_count, revoked_at FROM tikfinity_keys WHERE user_id = ?')
      .bind(who.userId).first();
    if (row && !row.revoked_at) {
      connected = !!row.last_event_at;
      lastEventAt = row.last_event_at;
      eventCount = row.event_count || 0;
    }
  } catch { /* row may not exist yet */ }
  return json({ ok: true, connected, lastEventAt, eventCount, events });
}

// ── Public: /api/tikfinity/test-fire (POST) ─────────────────────
// Sends a synthetic event through the keyed ingest path so the wizard
// can verify the wiring without a real viewer. The synthetic event is
// flagged { test: true } so recordGifterEvent is skipped.
export async function handleTestFire(req, env) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  const rawBody = await req.text();
  const who = await requireOwnerOrUser(env, req, rawBody);
  if (who.error) return json({ ok: false, error: who.error }, who.status);
  const key = (await getOrCreateKey(env, who.userId)).key;
  if (!key) return json({ ok: false, error: 'no-key' }, 500);
  const url = new URL(req.url);
  const eventUrl = `${url.protocol}//${url.host}/tikfinity/event?key=${encodeURIComponent(key)}`;
  const body = JSON.stringify({
    event: 'gift',
    test: true,
    uniqueId: 'wizard-test',
    nickname: 'Wizard Test',
    diamondCount: 1,
    repeatCount: 1,
    timestamp: Date.now(),
  });
  // Local fetch is fine inside the same worker; it round-trips via the
  // public route so we exercise the full path the real TikFinity hit
  // would follow.
  try {
    const r = await fetch(eventUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    const ok = r.ok;
    let detail = null;
    try { detail = await r.json(); } catch { /* ignore body parse */ }
    return json({ ok, sentTo: eventUrl, detail });
  } catch (e) {
    return json({ ok: false, error: 'self-fetch-failed', detail: e && e.message }, 502);
  }
}
