// Unit tests for boltbound-emotes — input validation, 5s gap,
// per-match 10-emote cap, feed ring buffer, route handler.
//
// Run from discord-bot/:
//   node test/test-boltbound-emotes.mjs

import {
  ALLOWED_EMOTES, sendEmote, readFeed, handleEmoteRoute, __internals,
} from '../boltbound-emotes.js';

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } }
function eq(a, b, m)  { if (a === b) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m, '(want:', b, 'got:', a, ')'); } }

// ── In-memory KV mock (same shape as test-daily-quests) ───────────

function makeMockKv() {
  const store = new Map();
  return {
    async get(key, opts) {
      const v = store.get(key);
      if (v === undefined) return null;
      if (opts?.type === 'json') return JSON.parse(v);
      return v;
    },
    async put(key, val /*, opts */) { store.set(key, val); },
    async delete(key) { store.delete(key); },
    _store: store,
  };
}

function makeEnv() {
  return {
    LOADOUT_BOLTS: makeMockKv(),
    AQUILO_SITE_WEB_SECRET: 'test-secret',
  };
}

// ── ALLOWED_EMOTES is frozen + exact set ──────────────────────────

console.log('— ALLOWED_EMOTES shape');
{
  eq(ALLOWED_EMOTES.length, 6, 'six curated emotes');
  for (const e of ['wave','party','think','embarrassed','fire','pray']) {
    assert(ALLOWED_EMOTES.includes(e), `includes ${e}`);
  }
  assert(Object.isFrozen(ALLOWED_EMOTES), 'array is frozen');
}

// ── Input validation ──────────────────────────────────────────────

console.log('— sendEmote rejects bad inputs');
{
  const env = makeEnv();
  const a = await sendEmote(env, '', 'A', 'wave', 1000);
  eq(a.ok, false, 'empty matchId → ok:false');
  eq(a.reason, 'invalid-match', 'reason invalid-match');

  const b = await sendEmote(env, 'm1', 'C', 'wave', 1000);
  eq(b.ok, false, 'side C → ok:false');
  eq(b.reason, 'invalid-side', 'reason invalid-side');

  const c = await sendEmote(env, 'm1', 'A', 'rude-emoji', 1000);
  eq(c.ok, false, 'bogus emote → ok:false');
  eq(c.reason, 'invalid-emote', 'reason invalid-emote');

  // Accepts lowercase side and trims.
  const d = await sendEmote(env, '  m1  ', 'a', 'wave', 1000);
  eq(d.ok, true, 'lowercase side accepted after upper-casing');
  eq(d.broadcast.playerSide, 'A', 'side normalised to A');
  eq(d.broadcast.matchId, 'm1', 'matchId trimmed');
}

// ── Rate limit: 1 emote / 5s per (matchId, side) ──────────────────

console.log('— rate-limit 5s gap per side');
{
  const env = makeEnv();
  const t0 = 1_000_000;
  const r1 = await sendEmote(env, 'mr', 'A', 'wave', t0);
  eq(r1.ok, true, '1st emote ok');

  const r2 = await sendEmote(env, 'mr', 'A', 'fire', t0 + 1000);
  eq(r2.ok, false, '1s later → ok:false');
  eq(r2.reason, 'rate-limited', 'reason rate-limited');
  assert(r2.retryAfterMs > 3000 && r2.retryAfterMs <= 4000, 'retryAfterMs ≈4000');

  const r3 = await sendEmote(env, 'mr', 'A', 'fire', t0 + 4999);
  eq(r3.ok, false, '4.999s later still rate-limited');

  const r4 = await sendEmote(env, 'mr', 'A', 'fire', t0 + 5000);
  eq(r4.ok, true, 'exactly 5s later ok');

  // Other side is independent.
  const rB = await sendEmote(env, 'mr', 'B', 'pray', t0 + 1000);
  eq(rB.ok, true, 'side B independent of side A rate limit');
}

// ── Per-match cap: 10 emotes per side per match ──────────────────

console.log('— per-match 10-emote cap per side');
{
  const env = makeEnv();
  const t0 = 2_000_000;
  for (let i = 0; i < 10; i++) {
    const r = await sendEmote(env, 'mc', 'A', 'wave', t0 + i * 5_000);
    eq(r.ok, true, `emote ${i + 1}/10 ok`);
  }
  const r11 = await sendEmote(env, 'mc', 'A', 'wave', t0 + 11 * 5_000);
  eq(r11.ok, false, '11th emote → ok:false');
  eq(r11.reason, 'match-cap', 'reason match-cap');
  eq(r11.count, 10, 'count reported = 10');

  // Other side still has its own 10-emote budget.
  const rB = await sendEmote(env, 'mc', 'B', 'wave', t0 + 11 * 5_000);
  eq(rB.ok, true, 'side B independent of side A cap');
}

// ── Feed ring buffer ──────────────────────────────────────────────

console.log('— readFeed returns recent emotes (and respects sinceTs)');
{
  const env = makeEnv();
  const t0 = 3_000_000;
  await sendEmote(env, 'mf', 'A', 'wave',  t0);
  await sendEmote(env, 'mf', 'B', 'fire',  t0 + 1_000);   // independent side, ok
  await sendEmote(env, 'mf', 'A', 'party', t0 + 5_000);

  const all = await readFeed(env, 'mf', 0);
  eq(all.length, 3, 'feed has 3 entries');
  eq(all[0].emoteId, 'wave', 'oldest first');
  eq(all[2].emoteId, 'party', 'newest last');

  const recent = await readFeed(env, 'mf', t0 + 500);
  eq(recent.length, 2, 'sinceTs filters out the first');
  eq(recent[0].emoteId, 'fire', 'first remaining is fire');

  const empty = await readFeed(env, 'mf', t0 + 999_999);
  eq(empty.length, 0, 'sinceTs after newest → empty');

  const none = await readFeed(env, 'no-such-match', 0);
  eq(none.length, 0, 'unknown match → empty feed');
}

// ── KV write feed cap ─────────────────────────────────────────────

console.log('— feed caps at FEED_CAP entries');
{
  const env = makeEnv();
  const t0 = 4_000_000;
  // FEED_CAP is 20; fire 25 valid emotes (alternate sides + step 5s so
  // none get rate-limited; cap kicks in after 10 per side, so use both
  // sides and small batches).
  for (let i = 0; i < 12; i++) {
    await sendEmote(env, 'mfeed', i % 2 === 0 ? 'A' : 'B', 'wave', t0 + i * 5_000);
  }
  const feed = await readFeed(env, 'mfeed', 0);
  assert(feed.length <= __internals.FEED_CAP, `feed length ${feed.length} ≤ FEED_CAP ${__internals.FEED_CAP}`);
}

// ── kv-unavailable guard ──────────────────────────────────────────

console.log('— missing LOADOUT_BOLTS → kv-unavailable');
{
  const env = { AQUILO_SITE_WEB_SECRET: 'x' };
  const r = await sendEmote(env, 'm', 'A', 'wave', 1);
  eq(r.ok, false, 'no KV binding → ok:false');
  eq(r.reason, 'kv-unavailable', 'reason kv-unavailable');
}

// ── HTTP handler: GET feed (no auth) + POST gated ────────────────

async function hmacSign(secret, ts, body) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(ts + '\n' + body),
  );
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

console.log('— GET /web/boltbound/emote/feed/:matchId returns events');
{
  const env = makeEnv();
  await sendEmote(env, 'mhttp', 'A', 'fire', 5_000_000);
  const req = new Request('https://example.com/web/boltbound/emote/feed/mhttp', { method: 'GET' });
  const res = await handleEmoteRoute(req, env, '/web/boltbound/emote/feed/mhttp');
  eq(res.status, 200, 'status 200');
  const data = await res.json();
  eq(data.matchId, 'mhttp', 'matchId echoed');
  eq(data.events.length, 1, '1 event in feed');
  eq(data.events[0].emoteId, 'fire', 'emote payload correct');
}

console.log('— POST /web/boltbound/emote requires valid HMAC');
{
  const env = makeEnv();
  const body = JSON.stringify({ matchId: 'mp', playerSide: 'A', emoteId: 'wave' });

  // Unsigned → 401.
  const reqBad = new Request('https://example.com/web/boltbound/emote', {
    method: 'POST', body,
    headers: { 'content-type': 'application/json' },
  });
  const resBad = await handleEmoteRoute(reqBad, env, '/web/boltbound/emote');
  eq(resBad.status, 401, 'unsigned → 401');

  // Signed → 200 + broadcast payload.
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = await hmacSign(env.AQUILO_SITE_WEB_SECRET, ts, body);
  const reqOk = new Request('https://example.com/web/boltbound/emote', {
    method: 'POST', body,
    headers: {
      'content-type': 'application/json',
      'x-aquilo-web-ts': ts,
      'x-aquilo-web-sig': sig,
    },
  });
  const resOk = await handleEmoteRoute(reqOk, env, '/web/boltbound/emote');
  eq(resOk.status, 200, 'signed → 200');
  const data = await resOk.json();
  eq(data.ok, true, 'ok:true');
  eq(data.broadcast.emoteId, 'wave', 'broadcast emoteId');
  eq(data.broadcast.playerSide, 'A', 'broadcast side');
  eq(data.broadcast.matchId, 'mp', 'broadcast matchId');
}

console.log('— POST with bad emoteId → 400');
{
  const env = makeEnv();
  const body = JSON.stringify({ matchId: 'mp', playerSide: 'A', emoteId: 'rage' });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = await hmacSign(env.AQUILO_SITE_WEB_SECRET, ts, body);
  const req = new Request('https://example.com/web/boltbound/emote', {
    method: 'POST', body,
    headers: {
      'content-type': 'application/json',
      'x-aquilo-web-ts': ts,
      'x-aquilo-web-sig': sig,
    },
  });
  const res = await handleEmoteRoute(req, env, '/web/boltbound/emote');
  eq(res.status, 400, '400 for invalid-emote');
  const data = await res.json();
  eq(data.reason, 'invalid-emote', 'reason invalid-emote');
}

console.log('— unknown path → 404');
{
  const env = makeEnv();
  const req = new Request('https://example.com/web/boltbound/emote/wat', { method: 'GET' });
  const res = await handleEmoteRoute(req, env, '/web/boltbound/emote/wat');
  eq(res.status, 404, '404 for unknown path');
}

console.log('');
console.log(`PASSED — ${pass} ok / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
