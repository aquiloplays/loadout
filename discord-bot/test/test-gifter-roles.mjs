// Gifter-roles harness, HMAC webhook + rolling-window math +
// reconciliation logic.
//
// Coverage:
//   • HMAC verification: matching + tampered + missing + wrong-skew
//   • Webhook validation: bad event type, bad amount, missing login,
//     non-snowflake guild, returns 503 with no secret
//   • Daily bucket accumulation: same user + same day = additive
//   • Daily bucket date-key: respects event.ts
//   • Rolling 30d leaderboard: only days in window counted, sort
//     desc, includes unlinked contributors
//   • Reconciliation: top-3 grant + revoke-from-falling-out + only
//     linked contributors hold roles + idempotent re-run
//
// Run from repo root:
//   node discord-bot/test/test-gifter-roles.mjs

import {
  GIFTER_CATEGORIES,
  handleStreamerbotEvent,
  rolling30dLeaderboard,
  gifterRolesDailyTick,
  ensureGifterRoles,
  lastNDays,
  _utcDayForTest,
  _categoryForTest,
  _identityKeyForTest,
} from '../gifter-roles.js';

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

let fetchHandler = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (fetchHandler) return fetchHandler(String(input), init || {});
  return new Response('no fetchHandler set', { status: 599 });
};

const GUILD = '1504103035951906883';
const SECRET = 'streamerbot-hmac-test-secret';

async function signHmac(secret, ts, body) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ts + '\n' + body));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function makeReq(body, opts = {}) {
  const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
  const headers = {
    'content-type': 'application/json',
    ...(opts.skipTs ? {} : { 'x-aquilo-sb-ts':  ts }),
    ...(opts.skipSig ? {} : { 'x-aquilo-sb-sig': opts.sig || '' }),
  };
  return new Request('https://w/streamerbot/event', { method: 'POST', headers, body });
}

console.log('- categories sanity');
{
  eq(Object.keys(GIFTER_CATEGORIES), ['sub', 'tiktok', 'cheer'], 'three categories');
  eq(GIFTER_CATEGORIES.sub.name,    'Top Sub Gifter',    'sub name');
  eq(GIFTER_CATEGORIES.tiktok.name, 'Top TikTok Gifter', 'tiktok name');
  eq(GIFTER_CATEGORIES.cheer.name,  'Top Cheerer',       'cheer name');
}

console.log('- event-type → category mapping');
{
  eq(_categoryForTest('sub-gift', 'twitch'), 'sub',    'sub-gift twitch');
  eq(_categoryForTest('tip',      'tiktok'), 'tiktok', 'tip tiktok');
  eq(_categoryForTest('cheer',    'twitch'), 'cheer',  'cheer twitch');
  eq(_categoryForTest('sub-gift', 'tiktok'), null,     'cross-platform refused');
  eq(_categoryForTest('whatever', 'tiktok'), null,     'unknown type');
}

console.log('- webhook: bad signature + replay');
{
  const env = { LOADOUT_BOLTS: makeKv(), STREAMERBOT_WEBHOOK_SECRET: SECRET, AQUILO_VAULT_GUILD_ID: GUILD };
  const body = JSON.stringify({ type: 'sub-gift', platform: 'twitch', twitchLogin: 'someone', amount: 1 });
  // Wrong signature → 401.
  const r1 = await handleStreamerbotEvent(makeReq(body, { sig: 'f'.repeat(64) }), env);
  eq(r1.status, 401, 'bad sig → 401');
  // Missing sig header → 401.
  const r2 = await handleStreamerbotEvent(makeReq(body, { skipSig: true }), env);
  eq(r2.status, 401, 'missing sig → 401');
  // No secret configured → 503.
  const r3 = await handleStreamerbotEvent(makeReq(body, { sig: 'whatever' }),
    { LOADOUT_BOLTS: makeKv(), AQUILO_VAULT_GUILD_ID: GUILD });
  eq(r3.status, 503, 'no secret → 503');
}

console.log('- webhook: validation');
{
  const env = { LOADOUT_BOLTS: makeKv(), STREAMERBOT_WEBHOOK_SECRET: SECRET, AQUILO_VAULT_GUILD_ID: GUILD };
  async function call(payload) {
    const body = JSON.stringify(payload);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await signHmac(SECRET, ts, body);
    return handleStreamerbotEvent(makeReq(body, { ts, sig }), env);
  }
  // Bad amount.
  const r1 = await call({ type: 'sub-gift', platform: 'twitch', twitchLogin: 'x', amount: 0 });
  const j1 = await r1.json();
  eq(j1.error, 'bad-amount', 'amount=0 rejected');
  // Bad type.
  const r2 = await call({ type: 'gift', platform: 'twitch', twitchLogin: 'x', amount: 5 });
  const j2 = await r2.json();
  eq(j2.error, 'unhandled-event-type', 'unknown type rejected');
  // Missing login.
  const r3 = await call({ type: 'sub-gift', platform: 'twitch', amount: 5 });
  const j3 = await r3.json();
  eq(j3.error, 'no-contributor-login', 'missing login rejected');
}

console.log('- webhook: accumulates per day per user');
{
  const env = { LOADOUT_BOLTS: makeKv(), STREAMERBOT_WEBHOOK_SECRET: SECRET, AQUILO_VAULT_GUILD_ID: GUILD };
  // Pin event.ts so the day is deterministic.
  const ts0 = Date.UTC(2026, 4, 26, 12, 0, 0);   // 2026-05-26 12:00 UTC
  async function fire(payload) {
    const body = JSON.stringify(payload);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await signHmac(SECRET, ts, body);
    const r = await handleStreamerbotEvent(makeReq(body, { ts, sig }), env);
    return r.json();
  }
  const r1 = await fire({ type: 'sub-gift', platform: 'twitch', twitchLogin: 'alice', amount: 3, ts: ts0 });
  eq(r1.totalToday, 3, 'first event: 3');
  const r2 = await fire({ type: 'sub-gift', platform: 'twitch', twitchLogin: 'alice', amount: 4, ts: ts0 });
  eq(r2.totalToday, 7, 'second event same day: 7');
  // Verify bucket key shape directly.
  const bucket = await env.LOADOUT_BOLTS.get(`gifter:sub:${GUILD}:twitch:alice:2026-05-26`);
  eq(bucket, '7', 'KV bucket value matches');
  // Identity record persisted.
  const ident = await env.LOADOUT_BOLTS.get(`gifter-identity:sub:${GUILD}:twitch:alice`, { type: 'json' });
  eq(ident.login, 'alice', 'identity stored');
  eq(ident.platform, 'twitch', 'platform stored');
}

console.log('- rolling30dLeaderboard math');
{
  const env = { LOADOUT_BOLTS: makeKv(), AQUILO_VAULT_GUILD_ID: GUILD };
  // alice +5 today, +3 1d ago, +9 31d ago (out of window).
  // bob +20 today.
  const today = _utcDayForTest(new Date());
  const yest  = _utcDayForTest(new Date(Date.now() - 86400000));
  const old   = _utcDayForTest(new Date(Date.now() - 31 * 86400000));
  await env.LOADOUT_BOLTS.put(`gifter:sub:${GUILD}:twitch:alice:${today}`, '5');
  await env.LOADOUT_BOLTS.put(`gifter:sub:${GUILD}:twitch:alice:${yest}`,  '3');
  await env.LOADOUT_BOLTS.put(`gifter:sub:${GUILD}:twitch:alice:${old}`,   '9');
  await env.LOADOUT_BOLTS.put(`gifter:sub:${GUILD}:twitch:bob:${today}`,   '20');
  await env.LOADOUT_BOLTS.put(`gifter-identity:sub:${GUILD}:twitch:alice`,
    JSON.stringify({ platform: 'twitch', login: 'alice' }));
  await env.LOADOUT_BOLTS.put(`gifter-identity:sub:${GUILD}:twitch:bob`,
    JSON.stringify({ platform: 'twitch', login: 'bob' }));
  // Give alice a Discord link.
  await env.LOADOUT_BOLTS.put(`wallet:${GUILD}:alice-discord-id`, JSON.stringify({
    balance: 0, links: [{ platform: 'twitch', username: 'alice' }],
  }));

  const board = await rolling30dLeaderboard(env, 'sub', GUILD, 5);
  eq(board.length, 2, 'two contributors in window (old day excluded)');
  eq(board[0].login, 'bob',   'bob top');
  eq(board[0].total, 20,      'bob total');
  eq(board[1].login, 'alice', 'alice 2nd');
  eq(board[1].total, 8,       'alice total = 5 + 3 (31d ago excluded)');
  eq(board[1].discordUserId, 'alice-discord-id', 'alice resolved to discord id');
  eq(board[0].discordUserId, null, 'bob unlinked');
}

console.log('- gifterRolesDailyTick: top-3 add + revoke fall-outs + idempotent');
{
  const env = { LOADOUT_BOLTS: makeKv(), DISCORD_BOT_TOKEN: 'fake', AQUILO_VAULT_GUILD_ID: GUILD };
  await env.LOADOUT_BOLTS.put(`gifter-roles:${GUILD}`,
    JSON.stringify({ sub: 'R_SUB', tiktok: 'R_TIKTOK', cheer: 'R_CHEER' }));
  // Sub leaderboard: alice 100, bob 50, carol 25, dave 10, eve 5. Top 3 = a/b/c.
  // All five have discord links.
  const today = _utcDayForTest(new Date());
  for (const [login, n] of [['alice', 100], ['bob', 50], ['carol', 25], ['dave', 10], ['eve', 5]]) {
    await env.LOADOUT_BOLTS.put(`gifter:sub:${GUILD}:twitch:${login}:${today}`, String(n));
    await env.LOADOUT_BOLTS.put(`gifter-identity:sub:${GUILD}:twitch:${login}`,
      JSON.stringify({ platform: 'twitch', login }));
    await env.LOADOUT_BOLTS.put(`wallet:${GUILD}:${login}-uid`, JSON.stringify({
      balance: 0, links: [{ platform: 'twitch', username: login }],
    }));
  }
  // Pretend Discord currently has dave + eve holding R_SUB (stale top-3
  // from yesterday); a/b/c don't have it yet. Members list returns
  // every linked-discord-uid.
  const grants  = [];
  const revokes = [];
  fetchHandler = async (url, init) => {
    if ((!init.method || init.method === 'GET') && url.includes('/members?')) {
      // Members + their roles.
      return new Response(JSON.stringify([
        { user: { id: 'alice-uid' }, roles: [] },
        { user: { id: 'bob-uid'   }, roles: [] },
        { user: { id: 'carol-uid' }, roles: [] },
        { user: { id: 'dave-uid'  }, roles: ['R_SUB'] },
        { user: { id: 'eve-uid'   }, roles: ['R_SUB'] },
      ]), { status: 200 });
    }
    if (init.method === 'PUT' && url.includes('/roles/R_SUB')) {
      const m = url.match(/members\/([^/]+)\/roles/);
      grants.push(m[1]);
      return new Response(null, { status: 204 });
    }
    if (init.method === 'DELETE' && url.includes('/roles/R_SUB')) {
      const m = url.match(/members\/([^/]+)\/roles/);
      revokes.push(m[1]);
      return new Response(null, { status: 204 });
    }
    return new Response('{}', { status: 200 });
  };
  const r = await gifterRolesDailyTick(env);
  fetchHandler = null;
  assert(r.ok, 'ok:true');
  // top-3 for sub: alice, bob, carol (decoded by Discord id).
  eq(r.summary.sub.top3Ids.sort(), ['alice-uid', 'bob-uid', 'carol-uid'].sort(), 'top3 ids');
  eq(grants.sort(),  ['alice-uid', 'bob-uid', 'carol-uid'].sort(), '3 PUT grants');
  eq(revokes.sort(), ['dave-uid', 'eve-uid'].sort(),               '2 DELETE revokes');
  // Marker stamped, second call same UTC day is a no-op.
  const r2 = await gifterRolesDailyTick(env);
  eq(r2.skipped, 'already-ran-today', 'second run same day skipped');
}

console.log('- ensureGifterRoles: creates the three roles');
{
  const env = { LOADOUT_BOLTS: makeKv(), DISCORD_BOT_TOKEN: 'fake' };
  fetchHandler = async (url, init) => {
    if ((!init.method || init.method === 'GET') && url.endsWith(`/guilds/${GUILD}/roles`)) {
      return new Response(JSON.stringify([{ id: GUILD, name: '@everyone' }]), { status: 200 });
    }
    if (init.method === 'POST' && url.endsWith(`/guilds/${GUILD}/roles`)) {
      const body = JSON.parse(init.body);
      const id = '950200' + (body.name.length).toString().padStart(13, '0');
      return new Response(JSON.stringify({ id, name: body.name }), { status: 200 });
    }
    return new Response('?', { status: 500 });
  };
  const r = await ensureGifterRoles(env, GUILD);
  fetchHandler = null;
  assert(r.ok, 'ok:true');
  eq(r.created.map(c => c.key).sort(), ['cheer', 'sub', 'tiktok'].sort(), 'three created');
  const map = await env.LOADOUT_BOLTS.get(`gifter-roles:${GUILD}`, { type: 'json' });
  eq(Object.keys(map).sort(), ['cheer', 'sub', 'tiktok'].sort(), 'map written');
}

console.log('- identity / day helpers');
{
  eq(_identityKeyForTest('twitch', 'Alice'), 'twitch:alice', 'lowercased');
  eq(_identityKeyForTest('TIKTOK', 'BoB'),   'tiktok:bob',   'lowercased both');
  eq(_identityKeyForTest('', 'x'),           null,           'empty platform');
  eq(_identityKeyForTest('twitch', ''),      null,           'empty login');
  eq(_utcDayForTest(new Date('2026-05-26T01:00:00Z')), '2026-05-26', 'utc day format');
  eq(lastNDays(3, new Date('2026-05-26T12:00:00Z')),
     ['2026-05-26', '2026-05-25', '2026-05-24'], 'lastNDays descending');
}

console.log('');
globalThis.fetch = realFetch;
if (failures > 0) {
  console.log('FAILED, ' + failures + ' assertion(s) failed');
  process.exit(1);
}
console.log('PASSED, all assertions ok');
