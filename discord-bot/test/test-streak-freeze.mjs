// Standalone harness for streak-freeze.js. Stubs env.LOADOUT_BOLTS with
// an in-memory KV shim, exercises add/get/consume + cap behavior, and
// simulates the /ext/checkin miss path with and without a freeze held.
//
// Run from repo root:
//   node discord-bot/test/test-streak-freeze.mjs

import {
  getFreezes, addFreeze, consumeFreeze,
  FREEZE_PRICE, MAX_FREEZES_PER_TYPE,
} from '../streak-freeze.js';

function makeKvShim() {
  const store = new Map();
  return {
    async get(key, opts) {
      const v = store.get(key);
      if (v === undefined) return null;
      if (opts && opts.type === 'json') {
        try { return JSON.parse(v); } catch { return null; }
      }
      return v;
    },
    async put(key, value) { store.set(key, String(value)); },
    async delete(key) { store.delete(key); },
    _dump() { return Object.fromEntries(store); },
  };
}

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + label + (detail ? ' (' + detail + ')' : '')); }
  else      { failed++; console.log('  FAIL  ' + label + (detail ? ' -- ' + detail : '')); }
}

const env = { LOADOUT_BOLTS: makeKvShim() };
const GUILD = 'g1';
const USER = 'u1';

console.log('--- streak-freeze unit harness ---');

// 1. Initial state: 0 freezes for both types.
{
  const f = await getFreezes(env, GUILD, USER);
  ok('initial.stream=0', f.stream === 0);
  ok('initial.discord=0', f.discord === 0);
}

// 2. Add one of each.
{
  const a = await addFreeze(env, GUILD, USER, 'stream');
  ok('add stream ok', a.ok && a.count === 1);
  const b = await addFreeze(env, GUILD, USER, 'discord');
  ok('add discord ok', b.ok && b.count === 1);
  const f = await getFreezes(env, GUILD, USER);
  ok('counts after add', f.stream === 1 && f.discord === 1);
}

// 3. Add up to cap.
{
  await addFreeze(env, GUILD, USER, 'stream'); // 2
  await addFreeze(env, GUILD, USER, 'stream'); // 3 (cap)
  const f = await getFreezes(env, GUILD, USER);
  ok('at cap', f.stream === MAX_FREEZES_PER_TYPE);
  const over = await addFreeze(env, GUILD, USER, 'stream');
  ok('reject over cap', !over.ok && over.reason === 'cap', 'count=' + over.count);
}

// 4. Bad type rejected.
{
  const r = await addFreeze(env, GUILD, USER, 'bogus');
  ok('reject bad type', !r.ok && r.reason === 'bad-type');
}

// 5. Consume on miss.
{
  const r = await consumeFreeze(env, GUILD, USER, 'stream');
  ok('consume returns consumed:true', r.consumed === true);
  ok('remaining decremented', r.remaining === 2);
  const f = await getFreezes(env, GUILD, USER);
  ok('persisted decrement', f.stream === 2);
}

// 6. Consume when empty: { consumed: false, remaining: 0 }
{
  const fresh = { LOADOUT_BOLTS: makeKvShim() };
  const r = await consumeFreeze(fresh, GUILD, USER, 'discord');
  ok('consume empty -> false', !r.consumed && r.remaining === 0);
}

// 7. Discord freeze doesn't bleed into stream count.
{
  const f = await getFreezes(env, GUILD, USER);
  ok('discord untouched after stream consume', f.discord === 1);
}

// 8. Independence after consume to zero.
{
  await consumeFreeze(env, GUILD, USER, 'discord');
  const f = await getFreezes(env, GUILD, USER);
  ok('discord goes to 0 alone', f.discord === 0 && f.stream === 2);
}

// 9. Simulate the /ext/checkin miss-path logic in isolation.
{
  // Mirrors the ext.js block: rec.streak before, time-since says miss,
  // user holds a stream freeze -> streak preserved + freeze decremented.
  const before = await getFreezes(env, GUILD, USER);
  const beforeStreak = 5;
  const cr = await consumeFreeze(env, GUILD, USER, 'stream');
  const newStreak = cr.consumed ? beforeStreak + 1 : 1;
  ok('miss with freeze -> streak preserved+1', newStreak === 6);
  const after = await getFreezes(env, GUILD, USER);
  ok('freeze decremented by exactly 1', after.stream === before.stream - 1);
}

// 10. Simulate the same scenario with no freeze held (after 9 we have
// stream=1; consume twice to drain, then attempt third -> reset).
{
  await consumeFreeze(env, GUILD, USER, 'stream'); // 0
  const cr = await consumeFreeze(env, GUILD, USER, 'stream');
  ok('miss without freeze -> consumed:false', !cr.consumed);
  const beforeStreak = 5;
  const newStreak = cr.consumed ? beforeStreak + 1 : 1;
  ok('miss without freeze -> streak resets to 1', newStreak === 1);
}

console.log('---');
console.log(`pass=${passed} fail=${failed}`);
if (failed > 0) process.exit(1);
