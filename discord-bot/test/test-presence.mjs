// Unit tests for the Discord rich-presence web fallback routes in web.js
// (routePresenceUpdate / routePresenceClear / routePresenceFeed).
//
// These three bypass handleWeb's strict discordId/guildId gate because
// presence is per-user + guild-agnostic — the site proxy forwards
// { userId, key, state, detail } (no guildId). We test the handlers
// directly against an in-memory KV mock that models the put/get/list/
// delete contract + expirationTtl.
//
// Run with:   node test/test-presence.mjs

import {
  routePresenceUpdate,
  routePresenceClear,
  routePresenceFeed,
} from '../web.js';

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } }
function eq(a, b, m)  { if (a === b) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m, '(want:', b, 'got:', a, ')'); } }

// ── In-memory KV mock (models the Workers KV surface we use) ──────────
function makeKV() {
  const store = new Map();   // name -> { value, ttl }
  return {
    store,
    async put(name, value, opts) { store.set(name, { value, ttl: opts && opts.expirationTtl }); },
    async get(name) { const e = store.get(name); return e ? e.value : null; },
    async delete(name) { store.delete(name); },
    async list({ prefix, limit } = {}) {
      let keys = [...store.keys()].filter(k => !prefix || k.startsWith(prefix));
      if (limit) keys = keys.slice(0, limit);
      return { keys: keys.map(name => ({ name })) };
    },
  };
}

async function bodyOf(resp) { return JSON.parse(await resp.text()); }

async function run() {
  const USER = '123456789012345678';

  // 1. update — stores under presence:user:<id> with a TTL.
  {
    const STATE = makeKV();
    const resp = await routePresenceUpdate({ STATE }, {
      userId: USER, key: 'boltbound', state: 'Playing Boltbound', detail: 'In the card battler',
    });
    eq(resp.status, 200, 'update returns 200');
    const b = await bodyOf(resp);
    assert(b.ok === true, 'update ok:true');
    const entry = STATE.store.get('presence:user:' + USER);
    assert(!!entry, 'wrote presence:user:<id>');
    eq(entry.ttl, 200, 'TTL set to 200s (heartbeat-expiry)');
    const rec = JSON.parse(entry.value);
    eq(rec.key, 'boltbound', 'persisted key');
    eq(rec.state, 'Playing Boltbound', 'persisted state');
    assert(typeof rec.ts === 'number', 'stamped ts');
  }

  // 2. update — rejects a bad user id and never writes.
  {
    const STATE = makeKV();
    const resp = await routePresenceUpdate({ STATE }, { userId: 'not-a-snowflake' });
    eq(resp.status, 400, 'bad user id -> 400');
    eq(STATE.store.size, 0, 'nothing written on reject');
  }

  // 3. update — clamps oversized + control-char fields to single-line.
  {
    const STATE = makeKV();
    const longState = 'x'.repeat(500);
    await routePresenceUpdate({ STATE }, {
      userId: USER, key: 'live', state: 'line1\nline2bell', detail: longState,
    });
    const rec = JSON.parse(STATE.store.get('presence:user:' + USER).value);
    assert(rec.state.indexOf('\n') === -1, 'newline stripped from state');
    assert(rec.detail.length <= 128, 'detail clamped to <=128 chars');
  }

  // 4. clear — removes the entry.
  {
    const STATE = makeKV();
    await routePresenceUpdate({ STATE }, { userId: USER, key: 'idle' });
    assert(STATE.store.has('presence:user:' + USER), 'present before clear');
    const resp = await routePresenceClear({ STATE }, { userId: USER });
    eq(resp.status, 200, 'clear returns 200');
    assert(!STATE.store.has('presence:user:' + USER), 'entry gone after clear');
  }

  // 5. feed — lists every live presence.
  {
    const STATE = makeKV();
    await routePresenceUpdate({ STATE }, { userId: '111111111111111111', key: 'clash' });
    await routePresenceUpdate({ STATE }, { userId: '222222222222222222', key: 'pet' });
    const resp = await routePresenceFeed({ STATE });
    eq(resp.status, 200, 'feed returns 200');
    const b = await bodyOf(resp);
    eq(b.presences.length, 2, 'feed returns both active presences');
    assert(b.presences.every(p => p.userId && p.key), 'feed entries carry userId + key');
  }

  // 6. defensive — no STATE binding -> 503, not a throw.
  {
    const resp = await routePresenceUpdate({}, { userId: USER, key: 'idle' });
    eq(resp.status, 503, 'missing KV binding -> 503');
  }

  console.log(`\npresence: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

run().catch(e => { console.error('THREW', e); process.exit(1); });
