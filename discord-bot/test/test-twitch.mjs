// Standalone harness for the Twitch wiring (twitch-eventsub.js +
// twitch-clips.js + weekly-recap.js).
//
// Coverage:
//   • EventSub HMAC signature verification — matching, mismatching,
//     malformed, missing prefix, wrong-length-but-same-prefix.
//   • EventSub replay protection — second delivery with same
//     message-id swallowed (returns 200 without re-processing).
//   • EventSub challenge handshake responds 200 with the challenge
//     verbatim, plain text.
//   • EventSub revocation acks 200.
//   • EventSub bad-signature returns 403 (no work done).
//   • twitch-helix isTwitchConfigured guard.
//   • twitch-clips ISO-week helper round-trips.
//   • weekly-recap ISO-week idempotency + isoWeek correctness across
//     ISO year-boundary.
//
// Run from repo root:
//   node discord-bot/test/test-twitch.mjs

import {
  verifyEventSubSignature,
  handleEventSubWebhook,
} from '../twitch-eventsub.js';
import { isTwitchConfigured } from '../twitch-helix.js';
import { _isoWeekForTest as clipIsoWeek } from '../twitch-clips.js';
import { _isoWeekForTest as recapIsoWeek, postWeeklyRecap } from '../weekly-recap.js';

let failures = 0;
function assert(cond, label) {
  if (cond) console.log('  ✅ ' + label);
  else { failures++; console.log('  ❌ ' + label); }
}
function eq(a, b, label) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) console.log('    expected', JSON.stringify(b), '\n    got     ', JSON.stringify(a));
  assert(ok, label);
}

function makeKv() {
  const store = new Map();
  return {
    async put(key, value, opts) { store.set(key, value); },
    async get(key, opts) {
      const v = store.get(key);
      if (v === undefined) return null;
      if (opts && opts.type === 'json') {
        try { return JSON.parse(v); } catch { return null; }
      }
      return v;
    },
    async delete(key) { store.delete(key); },
    async list({ prefix = '' } = {}) {
      const keys = [];
      for (const k of store.keys()) if (k.startsWith(prefix)) keys.push({ name: k });
      return { keys, list_complete: true };
    },
    _store: store,
  };
}

// Compute the Twitch signature for a synthetic message — used both
// to feed valid inputs to the verifier and to construct a realistic
// webhook request.
async function sign(secret, messageId, timestamp, body) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key,
    new TextEncoder().encode(messageId + timestamp + body));
  return 'sha256=' + Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

const SECRET = 'super-secret-test-value-not-the-real-one';

// ─────────────────────────────────────────────────────────────────
console.log('— verifyEventSubSignature: happy + sad paths');
{
  const id   = 'msg-12345';
  const ts   = '2026-05-26T00:00:00Z';
  const body = JSON.stringify({ subscription: { type: 'stream.online' } });
  const sig  = await sign(SECRET, id, ts, body);
  assert(await verifyEventSubSignature(SECRET, id, ts, body, sig),         'matching signature accepted');
  assert(!await verifyEventSubSignature('wrong-secret', id, ts, body, sig), 'wrong secret rejected');
  assert(!await verifyEventSubSignature(SECRET, 'wrong-id', ts, body, sig), 'tampered message-id rejected');
  assert(!await verifyEventSubSignature(SECRET, id, 'wrong-ts', body, sig), 'tampered timestamp rejected');
  assert(!await verifyEventSubSignature(SECRET, id, ts, body + 'x', sig),   'tampered body rejected');
  assert(!await verifyEventSubSignature(SECRET, id, ts, body, ''),          'empty header rejected');
  assert(!await verifyEventSubSignature(SECRET, id, ts, body, 'md5=' + sig.slice(7)),
         'wrong algorithm prefix rejected');
  // Same-prefix-different-bytes — must still reject.
  const tampered = 'sha256=' + 'a'.repeat(sig.length - 'sha256='.length);
  assert(!await verifyEventSubSignature(SECRET, id, ts, body, tampered),    'mismatched signature bytes rejected');
  // Null / missing inputs.
  assert(!await verifyEventSubSignature('', id, ts, body, sig),             'empty secret rejected');
  assert(!await verifyEventSubSignature(SECRET, '', ts, body, sig),         'empty messageId rejected');
}

console.log('— EventSub webhook: challenge handshake');
{
  const env = { LOADOUT_BOLTS: makeKv(), TWITCH_EVENTSUB_SECRET: SECRET };
  const body = JSON.stringify({ challenge: 'ping-1234', subscription: { id: 's1' } });
  const id   = 'challenge-1';
  const ts   = '2026-05-26T01:00:00Z';
  const sig  = await sign(SECRET, id, ts, body);
  const req  = new Request('https://w/twitch/eventsub', {
    method: 'POST',
    headers: {
      'twitch-eventsub-message-id': id,
      'twitch-eventsub-message-type': 'webhook_callback_verification',
      'twitch-eventsub-message-timestamp': ts,
      'twitch-eventsub-message-signature': sig,
      'content-type': 'application/json',
    },
    body,
  });
  const ctx = { waitUntil: () => {} };
  const resp = await handleEventSubWebhook(req, env, ctx);
  eq(resp.status, 200, 'challenge → 200');
  eq(await resp.text(), 'ping-1234', 'challenge echoed verbatim');
  eq(resp.headers.get('content-type'), 'text/plain', 'plain-text content-type');
}

console.log('— EventSub webhook: bad signature → 403, no handler run');
{
  const env = { LOADOUT_BOLTS: makeKv(), TWITCH_EVENTSUB_SECRET: SECRET };
  const calls = [];
  const ctx = { waitUntil: (p) => calls.push(p) };
  const body = JSON.stringify({
    subscription: { type: 'stream.online' },
    event: { broadcaster_user_id: '1497793223' },
  });
  const req = new Request('https://w/twitch/eventsub', {
    method: 'POST',
    headers: {
      'twitch-eventsub-message-id': 'bad-1',
      'twitch-eventsub-message-type': 'notification',
      'twitch-eventsub-message-timestamp': '2026-05-26T01:00:00Z',
      'twitch-eventsub-message-signature': 'sha256=' + 'f'.repeat(64),
      'content-type': 'application/json',
    },
    body,
  });
  const resp = await handleEventSubWebhook(req, env, ctx);
  eq(resp.status, 403, 'bad sig → 403');
  eq(calls.length, 0, 'no waitUntil scheduled (handler never ran)');
}

console.log('— EventSub webhook: notification + replay swallow');
{
  const env = { LOADOUT_BOLTS: makeKv(), TWITCH_EVENTSUB_SECRET: SECRET };
  const calls = [];
  const ctx = { waitUntil: (p) => calls.push(p) };
  const id = 'notify-1';
  const ts = '2026-05-26T02:00:00Z';
  const body = JSON.stringify({
    subscription: { type: 'stream.online' },
    event: { broadcaster_user_id: '1497793223' },
  });
  const sig = await sign(SECRET, id, ts, body);
  const make = () => new Request('https://w/twitch/eventsub', {
    method: 'POST',
    headers: {
      'twitch-eventsub-message-id': id,
      'twitch-eventsub-message-type': 'notification',
      'twitch-eventsub-message-timestamp': ts,
      'twitch-eventsub-message-signature': sig,
      'content-type': 'application/json',
    },
    body,
  });
  const r1 = await handleEventSubWebhook(make(), env, ctx);
  eq(r1.status, 204, 'first delivery → 204');
  eq(calls.length, 1, 'one waitUntil queued');
  // Replay — same message-id. Should be swallowed without scheduling.
  const r2 = await handleEventSubWebhook(make(), env, ctx);
  eq(r2.status, 200, 'replay → 200');
  eq(calls.length, 1, 'no extra waitUntil on replay');
}

console.log('— EventSub webhook: revocation acks 200');
{
  const env = { LOADOUT_BOLTS: makeKv(), TWITCH_EVENTSUB_SECRET: SECRET };
  const ctx = { waitUntil: () => {} };
  const body = JSON.stringify({ subscription: { id: 'sub-x', type: 'stream.online', status: 'authorization_revoked' } });
  const id = 'revoke-1';
  const ts = '2026-05-26T03:00:00Z';
  const sig = await sign(SECRET, id, ts, body);
  const req = new Request('https://w/twitch/eventsub', {
    method: 'POST',
    headers: {
      'twitch-eventsub-message-id': id,
      'twitch-eventsub-message-type': 'revocation',
      'twitch-eventsub-message-timestamp': ts,
      'twitch-eventsub-message-signature': sig,
      'content-type': 'application/json',
    },
    body,
  });
  const resp = await handleEventSubWebhook(req, env, ctx);
  eq(resp.status, 200, 'revocation → 200');
}

console.log('— EventSub webhook: no secret configured → 503');
{
  const env = { LOADOUT_BOLTS: makeKv() /* no TWITCH_EVENTSUB_SECRET */ };
  const req = new Request('https://w/twitch/eventsub', { method: 'POST', body: '{}' });
  const resp = await handleEventSubWebhook(req, env, { waitUntil: () => {} });
  eq(resp.status, 503, 'unconfigured → 503');
}

console.log('— twitch-helix: isTwitchConfigured guard');
{
  assert(!isTwitchConfigured(null),                                  'null env → false');
  assert(!isTwitchConfigured({}),                                    'empty env → false');
  assert(!isTwitchConfigured({ TWITCH_CLIENT_ID: 'x' }),             'only id → false');
  assert(!isTwitchConfigured({ TWITCH_CLIENT_SECRET: 'y' }),         'only secret → false');
  assert(isTwitchConfigured({ TWITCH_CLIENT_ID: 'x', TWITCH_CLIENT_SECRET: 'y' }), 'both → true');
}

console.log('— ISO week helper');
{
  // 2026-05-26 is a Tuesday → ISO week 22 of 2026.
  eq(clipIsoWeek(new Date('2026-05-26T12:00:00Z')),  '2026-W22', 'Tue mid-week 2026');
  eq(recapIsoWeek(new Date('2026-05-26T12:00:00Z')), '2026-W22', 'recap helper matches clip helper');
  // ISO week year-boundary: Jan 1 2027 is a Friday → ISO 2026-W53.
  eq(clipIsoWeek(new Date('2027-01-01T12:00:00Z')),  '2026-W53', 'Jan 1 2027 → 2026-W53');
  // Jan 4 is always in week 1 of its ISO year.
  eq(clipIsoWeek(new Date('2026-01-04T12:00:00Z')),  '2026-W01', 'Jan 4 2026 → 2026-W01');
  // Sunday at end of week — should belong to the same ISO week as
  // the preceding Mon-Sat (not yet rolled over).
  eq(clipIsoWeek(new Date('2026-05-31T23:00:00Z')),  '2026-W22', 'Sun end of W22 still W22');
}

console.log('— weekly-recap: ISO-week idempotency');
{
  const env = {
    LOADOUT_BOLTS: makeKv(),
    DISCORD_BOT_TOKEN: 'fake',
    RECAP_CHANNEL_ID: '999000000000000001',
    AQUILO_VAULT_GUILD_ID: '1504103035951906883',
  };
  // Stub Discord POST so postWeeklyRecap doesn\'t actually fetch.
  const realFetch = globalThis.fetch;
  let postCount = 0;
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST' && /\/channels\/.+\/messages$/.test(String(url))) {
      postCount += 1;
      return new Response(JSON.stringify({ id: '950000' + postCount }), { status: 200 });
    }
    return new Response('?', { status: 500 });
  };
  const r1 = await postWeeklyRecap(env);
  globalThis.fetch = realFetch;
  assert(r1.ok, 'first call posts');
  assert(r1.week, 'returns week');
  // KV marker now stamped — re-running same week is a skip.
  globalThis.fetch = async () => new Response('SHOULD NOT FETCH', { status: 500 });
  const r2 = await postWeeklyRecap(env);
  globalThis.fetch = realFetch;
  eq(r2.skipped, 'already-posted-this-week', 'second call skipped');
  eq(r2.week, r1.week, 'same week value');
  eq(postCount, 1, 'exactly one POST');
}

console.log('— weekly-recap: skips cleanly when no channel');
{
  const env = { LOADOUT_BOLTS: makeKv() };
  const r = await postWeeklyRecap(env);
  eq(r.skipped, 'no-recap-channel', 'no channel → skipped');
}

console.log('');
if (failures > 0) {
  console.log('FAILED — ' + failures + ' assertion(s) failed');
  process.exit(1);
}
console.log('PASSED — all assertions ok');
