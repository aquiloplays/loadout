// Lock + reset semantics for the character system.
//
//   node discord-bot/test/test-character-lock.mjs
//
// Exercises the worker-side contract the parallel aquilo-site session
// is building against: first save locks, subsequent saves + class
// changes reject with `character-locked`, and /web/character/reset
// charges 5,000 Bolts atomically to unlock.

import {
  saveCharacterLookWeb,
  applyClassWeb,
  resetCharacterWeb,
  getCharacterLookWeb,
  CHARACTER_RESET_COST,
} from '../character.js';
import { earn, getWallet } from '../wallet.js';

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + label + (detail ? ' (' + detail + ')' : '')); }
  else      { failed++; console.log('  FAIL  ' + label + (detail ? ' -- ' + detail : '')); }
}

// In-memory KV stub matching the parts of LOADOUT_BOLTS the code uses
// (get with optional {type:'json'}, put, list — list isn't exercised
// in these tests but stubbed for safety).
function makeKv() {
  const store = new Map();
  return {
    _store: store,
    async get(key, opts) {
      const raw = store.get(key);
      if (raw == null) return null;
      if (opts && opts.type === 'json') {
        try { return JSON.parse(raw); } catch { return null; }
      }
      return raw;
    },
    async put(key, value) {
      store.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    },
    async list({ prefix = '', cursor, limit = 1000 } = {}) {
      const keys = [];
      for (const k of store.keys()) if (k.startsWith(prefix)) keys.push({ name: k });
      return { keys, list_complete: true, cursor: null };
    },
  };
}

const GUILD = '111111111111111111';
const USER  = '222222222222222222';

async function freshEnv() {
  return { LOADOUT_BOLTS: makeKv() };
}

console.log('--- character lock + reset ---');

// ── Fresh character is unlocked on read ─────────────────────────────
{
  const env = await freshEnv();
  const before = await getCharacterLookWeb(env, GUILD, USER);
  ok('fresh hero: locked = false', before.locked === false, 'locked=' + before.locked);
  ok('fresh hero: resetCost exposed', before.resetCost === CHARACTER_RESET_COST,
     'resetCost=' + before.resetCost);
}

// ── First save commits + locks ──────────────────────────────────────
{
  const env = await freshEnv();
  const saved = await saveCharacterLookWeb(env, GUILD, USER, {
    bodyType: 'stocky', hairColor: 'violet',
  });
  ok('first save ok', saved.ok === true);
  ok('first save → locked=true', saved.locked === true);
  ok('first save persists patch', saved.look.bodyType === 'stocky' && saved.look.hairColor === 'violet');

  const after = await getCharacterLookWeb(env, GUILD, USER);
  ok('read after save → locked=true', after.locked === true);

  const second = await saveCharacterLookWeb(env, GUILD, USER, { bodyType: 'slim' });
  ok('second save rejected', second.ok === false && second.error === 'character-locked',
     'error=' + second.error);
  ok('second save mentions reset cost',
     second.resetCost === CHARACTER_RESET_COST,
     'resetCost=' + second.resetCost);

  const reread = await getCharacterLookWeb(env, GUILD, USER);
  ok('rejected save did not mutate look',
     reread.look.bodyType === 'stocky',
     'bodyType=' + reread.look.bodyType);
}

// ── Class pick is gated by the same lock ────────────────────────────
{
  const env = await freshEnv();
  // Class first (unlocked) — succeeds.
  const c1 = await applyClassWeb(env, GUILD, USER, 'warrior');
  ok('class pick before lock: ok', c1.ok === true);

  // Save (locks).
  await saveCharacterLookWeb(env, GUILD, USER, { bodyType: 'slim' });

  // Class change after lock: rejected.
  const c2 = await applyClassWeb(env, GUILD, USER, 'mage');
  ok('class change after lock: rejected',
     c2.ok === false && c2.error === 'character-locked',
     'error=' + c2.error);

  const after = await getCharacterLookWeb(env, GUILD, USER);
  ok('class unchanged by rejected pick',
     after.className === 'warrior',
     'className=' + after.className);
}

// ── Reset on an unlocked character is a no-op (no charge) ──────────
{
  const env = await freshEnv();
  await earn(env, GUILD, USER, 10000, 'seed');
  const r = await resetCharacterWeb(env, GUILD, USER);
  ok('reset unlocked: not-locked error',
     r.ok === false && r.error === 'not-locked',
     'error=' + r.error);
  const w = await getWallet(env, GUILD, USER);
  ok('reset unlocked: wallet untouched',
     w.balance === 10000,
     'balance=' + w.balance);
}

// ── Reset with insufficient bolts is rejected, no state change ─────
{
  const env = await freshEnv();
  // Lock first.
  await saveCharacterLookWeb(env, GUILD, USER, { bodyType: 'stocky' });
  // Seed with 1000 Bolts (< 5000).
  await earn(env, GUILD, USER, 1000, 'seed');

  const r = await resetCharacterWeb(env, GUILD, USER);
  ok('insufficient bolts: typed error',
     r.ok === false && r.error === 'insufficient-bolts',
     'error=' + r.error);
  ok('insufficient bolts: required = 5000',
     r.required === CHARACTER_RESET_COST,
     'required=' + r.required);
  ok('insufficient bolts: balance reported',
     r.balance === 1000,
     'balance=' + r.balance);

  const w = await getWallet(env, GUILD, USER);
  ok('insufficient bolts: wallet unchanged',
     w.balance === 1000,
     'balance=' + w.balance);

  const after = await getCharacterLookWeb(env, GUILD, USER);
  ok('insufficient bolts: still locked',
     after.locked === true,
     'locked=' + after.locked);
}

// ── Reset with enough bolts: charges + unlocks atomically ──────────
{
  const env = await freshEnv();
  await saveCharacterLookWeb(env, GUILD, USER, { bodyType: 'stocky', hairColor: 'red' });
  await earn(env, GUILD, USER, 7500, 'seed');

  const r = await resetCharacterWeb(env, GUILD, USER);
  ok('reset ok', r.ok === true);
  ok('reset: charged = 5000', r.charged === CHARACTER_RESET_COST, 'charged=' + r.charged);
  ok('reset: locked = false', r.locked === false);
  ok('reset: wallet shows 2500 left',
     r.wallet.balance === 2500,
     'balance=' + r.wallet.balance);
  ok('reset: lifetimeSpent advanced by 5000',
     r.wallet.lifetimeSpent === CHARACTER_RESET_COST,
     'lifetimeSpent=' + r.wallet.lifetimeSpent);
  ok('reset: look preserved',
     r.look.bodyType === 'stocky' && r.look.hairColor === 'red');

  const after = await getCharacterLookWeb(env, GUILD, USER);
  ok('post-reset read: locked = false', after.locked === false);

  // Re-pick + re-save: locks again.
  const c = await applyClassWeb(env, GUILD, USER, 'mage');
  ok('post-reset: class pick succeeds', c.ok === true);

  const s2 = await saveCharacterLookWeb(env, GUILD, USER, { hairColor: 'blonde' });
  ok('post-reset: save succeeds + re-locks',
     s2.ok === true && s2.locked === true,
     'ok=' + s2.ok + ' locked=' + s2.locked);
}

console.log('--- ' + passed + ' pass, ' + failed + ' fail ---');
if (failed > 0) process.exit(1);
