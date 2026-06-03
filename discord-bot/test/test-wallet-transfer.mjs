// Focused unit test for wallet.transfer(), the refund-on-earn-failure
// compensator added during the audit sweep. The /loadout gift command
// + the Twitch panel both call this; the docstring claims atomicity
// (economy.md L41) so the compensator must actually compensate.
//
// Run with: node test/test-wallet-transfer.mjs

import { transfer, getWallet, earn } from '../wallet.js';

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
    async list({ prefix } = {}) {
      const keys = [];
      for (const k of store.keys()) if (k.startsWith(prefix || '')) keys.push({ name: k });
      return { keys, list_complete: true };
    },
    _wrap(predicate, error) {
      const inner = this;
      const innerPut = inner.put.bind(inner);
      this.put = async (key, value) => {
        if (predicate(key, value)) throw error;
        return innerPut(key, value);
      };
    },
    _dump() { return Object.fromEntries(store); },
  };
}

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + label + (detail ? ' (' + detail + ')' : '')); }
  else      { failed++; console.log('  FAIL  ' + label + (detail ? ' -- ' + detail : '')); }
}

const GUILD = 'g_test';
const SENDER = '111111111111111111';
const TARGET = '222222222222222222';

console.log('--- wallet.transfer atomicity ---');

// Happy path: 1000 gift, sender + recipient both updated.
{
  const env = { LOADOUT_BOLTS: makeKvShim() };
  await earn(env, GUILD, SENDER, 5000, 'seed');
  const r = await transfer(env, GUILD, SENDER, TARGET, 1000);
  const ws = await getWallet(env, GUILD, SENDER);
  const wt = await getWallet(env, GUILD, TARGET);
  ok('happy path returns ok', r.ok === true, `r=${JSON.stringify(r).slice(0, 200)}`);
  ok('sender debited 1000', ws.balance === 4000, `bal=${ws.balance}`);
  ok('recipient credited 1000', wt.balance === 1000, `bal=${wt.balance}`);
}

// Insufficient funds: sender keeps balance, recipient unchanged.
{
  const env = { LOADOUT_BOLTS: makeKvShim() };
  await earn(env, GUILD, SENDER, 100, 'seed');
  const r = await transfer(env, GUILD, SENDER, TARGET, 1000);
  const ws = await getWallet(env, GUILD, SENDER);
  const wt = await getWallet(env, GUILD, TARGET);
  ok('insufficient returns !ok', r.ok === false, `r=${JSON.stringify(r)}`);
  ok('sender balance preserved on insufficient', ws.balance === 100, `bal=${ws.balance}`);
  ok('recipient untouched on insufficient', wt.balance === 0, `bal=${wt.balance}`);
}

// Recipient write fails → sender refunded, transfer returns !ok.
{
  const env = { LOADOUT_BOLTS: makeKvShim() };
  await earn(env, GUILD, SENDER, 5000, 'seed');
  // Inject failure on the recipient's wallet put. Spend on sender
  // succeeds (writes wallet:g_test:111…), then the earn on recipient
  // tries to write wallet:g_test:222… and throws. The refund earn
  // back on sender targets 111…, so we let that through.
  env.LOADOUT_BOLTS._wrap(
    (key) => key === `wallet:${GUILD}:${TARGET}`,
    new Error('synthetic KV failure'),
  );
  const r = await transfer(env, GUILD, SENDER, TARGET, 1000);
  const ws = await getWallet(env, GUILD, SENDER);
  const wt = await getWallet(env, GUILD, TARGET);
  ok('write-fail returns !ok', r.ok === false && r.reason === 'recipient-write-failed',
     `r=${JSON.stringify(r).slice(0, 200)}`);
  ok('sender net balance preserved (debit + refund cancel out)',
     ws.balance === 5000, `bal=${ws.balance}`);
  ok('recipient still has nothing', wt.balance === 0, `bal=${wt.balance}`);
  // Lifetime counters should reflect the cycle: 5000 seeded + 1000
  // refunded = 6000 earned; 1000 spent on the failed gift.
  ok('sender lifetimeEarned bumped by refund',
     ws.lifetimeEarned === 6000, `lifetimeEarned=${ws.lifetimeEarned}`);
  ok('sender lifetimeSpent reflects the attempted gift',
     ws.lifetimeSpent === 1000, `lifetimeSpent=${ws.lifetimeSpent}`);
}

// Self-gift refused (unchanged contract).
{
  const env = { LOADOUT_BOLTS: makeKvShim() };
  await earn(env, GUILD, SENDER, 5000, 'seed');
  const r = await transfer(env, GUILD, SENDER, SENDER, 100);
  ok('self-gift refused', r.ok === false && /yourself/.test(r.reason),
     `r=${JSON.stringify(r)}`);
}

console.log('--- ' + passed + ' pass, ' + failed + ' fail ---');
if (failed > 0) process.exit(1);
