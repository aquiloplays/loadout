// printflair-doodle-selftest.mjs — pure-logic tests for paid doodles.
//
// Covers doodleCfg normalization + the canonical-wallet debit/refund math
// against a mocked KV. No network / no live worker.
//
//   node test/printflair-doodle-selftest.mjs

import assert from 'node:assert';
import { doodleCfg, pfWalletDebit, pfWalletCredit } from '../printflair.js';

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok  -', name); }
  catch (e) { fail++; console.log('FAIL  -', name, '::', e && e.message || e); }
}

function mockKV(map) {
  return {
    async get(key, opts) {
      const v = map.get(key);
      if (v == null) return null;
      if (opts === 'json' || (opts && opts.type === 'json')) return typeof v === 'string' ? JSON.parse(v) : v;
      return typeof v === 'string' ? v : JSON.stringify(v);
    },
    async put(key, val) { map.set(key, val); },
    async delete(key) { map.delete(key); },
  };
}
const GUILD = '1504103035951906883';
function envWith(map) { return { AQUILO_VAULT_GUILD_ID: GUILD, LOADOUT_BOLTS: mockKV(map) }; }

async function run() {
  console.log('printflair doodle self-test\n');

  await t('doodleCfg: defaults when unset (disabled, 500/250/doodle)', async () => {
    const c = await doodleCfg(envWith(new Map()));
    assert.deepEqual(c, { enabled: false, bolts: 500, bits: 250, bitsSku: 'doodle' });
  });

  await t('doodleCfg: honors stored overrides + clamps bad values', async () => {
    const m = new Map();
    m.set('printflair:doodlecfg', { enabled: true, bolts: 1000, bits: 500, bitsSku: 'bigdoodle' });
    assert.deepEqual(await doodleCfg(envWith(m)), { enabled: true, bolts: 1000, bits: 500, bitsSku: 'bigdoodle' });
    const m2 = new Map();
    m2.set('printflair:doodlecfg', { enabled: 'yes', bolts: -5, bits: NaN, bitsSku: 42 });
    // enabled only true on strict boolean; bad numbers/sku fall back to defaults.
    assert.deepEqual(await doodleCfg(envWith(m2)), { enabled: false, bolts: 500, bits: 250, bitsSku: 'doodle' });
  });

  await t('debit: succeeds when funded, writes new balance + lifetimeSpent', async () => {
    const m = new Map();
    m.set('wallet:' + GUILD + ':111', { balance: 800, lifetimeSpent: 0 });
    const env = envWith(m);
    const r = await pfWalletDebit(env, '111', 500);
    assert(r.ok && r.balance === 300, JSON.stringify(r));
    const w = JSON.parse(m.get('wallet:' + GUILD + ':111'));
    assert.equal(w.balance, 300);
    assert.equal(w.lifetimeSpent, 500);
  });

  await t('debit: refuses when short, leaves wallet untouched', async () => {
    const m = new Map();
    m.set('wallet:' + GUILD + ':222', { balance: 200 });
    const env = envWith(m);
    const r = await pfWalletDebit(env, '222', 500);
    assert(!r.ok && r.error === 'insufficient' && r.balance === 200, JSON.stringify(r));
    // Never written (debit refuses first) → still the original object.
    const raw = m.get('wallet:' + GUILD + ':222');
    const bal = typeof raw === 'string' ? JSON.parse(raw).balance : raw.balance;
    assert.equal(bal, 200);
  });

  await t('debit: missing wallet reads as 0 → insufficient', async () => {
    const r = await pfWalletDebit(envWith(new Map()), '333', 500);
    assert(!r.ok && r.error === 'insufficient' && r.balance === 0, JSON.stringify(r));
  });

  await t('debit then credit (refund) restores balance; spend nets to 0', async () => {
    const m = new Map();
    m.set('wallet:' + GUILD + ':444', { balance: 500, lifetimeSpent: 0 });
    const env = envWith(m);
    await pfWalletDebit(env, '444', 500);
    await pfWalletCredit(env, '444', 500);
    const w = JSON.parse(m.get('wallet:' + GUILD + ':444'));
    assert.equal(w.balance, 500);
    assert.equal(w.lifetimeSpent, 0);
  });

  await t('debit refuses without a configured guild', async () => {
    const r = await pfWalletDebit({ LOADOUT_BOLTS: mockKV(new Map()) }, '555', 500);
    assert(!r.ok && r.error === 'not-configured', JSON.stringify(r));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
