// Unit tests for aether.js — the D1-backed Aether economy ledger.
// Covers lazy seed from legacy wallet.aether, grant/spend with ledger
// rows, insufficient-balance refusal, history ordering, and the
// milestone-grant hook.
//
// Run with:   node test/test-aether.mjs

import {
  getAetherBalance,
  grantAether,
  spendAether,
  getAetherHistory,
  grantAetherForMilestone,
  MILESTONE_AETHER,
} from '../aether.js';

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } }
function eq(a, b, m)  { if (a === b) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m, '(want:', b, 'got:', a, ')'); } }

// ── In-memory D1 mock ─────────────────────────────────────────────
function makeMockDB() {
  const rows = [];   // user_aether
  const tx = [];     // aether_transaction
  function H(sql, args) {
    const S = sql.replace(/\s+/g, ' ').trim();
    return {
      async first() {
        if (/^SELECT .* FROM user_aether WHERE guild_id = \? AND user_id = \?/i.test(S)) {
          return rows.find(r => r.guild_id === args[0] && r.user_id === args[1]) || null;
        }
        return null;
      },
      async all() {
        if (/FROM aether_transaction WHERE guild_id = \? AND user_id = \? ORDER BY created_at DESC, rowid DESC/i.test(S)) {
          const [g, u, lim] = args;
          // rowid tiebreak modeled by insertion index (_seq).
          return { results: tx.filter(t => t.guild_id === g && t.user_id === u)
            .sort((a, b) => (b.created_at - a.created_at) || (b._seq - a._seq)).slice(0, lim) };
        }
        return { results: [] };
      },
      async run() {
        if (/^INSERT OR IGNORE INTO user_aether/i.test(S)) {
          const [g, u, bal, earned, ts] = args;
          if (!rows.find(r => r.guild_id === g && r.user_id === u)) {
            rows.push({ guild_id: g, user_id: u, balance: bal, lifetime_earned: earned,
                        lifetime_spent: 0, seeded: 1, updated_at: ts });
          }
          return { meta: { changes: 1 } };
        }
        if (/^INSERT INTO aether_transaction/i.test(S)) {
          const [id, g, u, delta, reason, after, ts] = args;
          tx.push({ id, guild_id: g, user_id: u, delta, reason, balance_after: after,
                    created_at: ts, _seq: tx.length });
          return { meta: { changes: 1 } };
        }
        if (/^UPDATE user_aether SET balance = \?/i.test(S)) {
          const [bal, earnedInc, spentInc, ts, g, u] = args;
          const r = rows.find(x => x.guild_id === g && x.user_id === u);
          if (r) { r.balance = bal; r.lifetime_earned += earnedInc; r.lifetime_spent += spentInc; r.updated_at = ts; }
          return { meta: { changes: r ? 1 : 0 } };
        }
        return { meta: { changes: 0 } };
      },
    };
  }
  return { _rows: rows, _tx: tx, prepare(sql) { return { bind: (...a) => H(sql, a), ...H(sql, []) }; } };
}

function makeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    async get(k, opts) {
      if (!store.has(k)) return null;
      const v = store.get(k);
      return opts && opts.type === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v) { store.set(k, String(v)); },
  };
}

function makeEnv(walletAether) {
  const kv = walletAether != null
    ? makeKV({ [`wallet:g1:u1`]: JSON.stringify({ aether: walletAether }) })
    : makeKV();
  return { DB: makeMockDB(), LOADOUT_BOLTS: kv };
}

const G = 'g1', U = 'u1';

console.log('— getAetherBalance: fresh user with no legacy aether seeds 0');
{
  const env = makeEnv();
  const r = await getAetherBalance(env, G, U);
  assert(r.ok, 'ok');
  eq(r.balance, 0, 'balance 0');
  eq(r.lifetimeEarned, 0, 'lifetimeEarned 0');
}

console.log('— lazy seed folds in legacy wallet.aether on first touch');
{
  const env = makeEnv(120);   // legacy wallet has 120 aether
  const r = await getAetherBalance(env, G, U);
  eq(r.balance, 120, 'seeded balance 120');
  eq(r.lifetimeEarned, 120, 'lifetimeEarned 120');
  // A seed transaction was logged.
  const hist = await getAetherHistory(env, G, U, 10);
  assert(hist.transactions.some(t => t.reason.startsWith('seed:')), 'seed tx logged');
}

console.log('— grantAether adds + logs');
{
  const env = makeEnv();
  const g1 = await grantAether(env, G, U, 50, 'test-grant');
  assert(g1.ok, 'granted');
  eq(g1.balance, 50, 'balance 50');
  const g2 = await grantAether(env, G, U, 25, 'test-grant-2');
  eq(g2.balance, 75, 'balance 75');
  const bal = await getAetherBalance(env, G, U);
  eq(bal.lifetimeEarned, 75, 'lifetimeEarned 75');
  const hist = await getAetherHistory(env, G, U, 10);
  eq(hist.transactions[0].delta, 25, 'newest tx is +25');
  eq(hist.transactions[0].balanceAfter, 75, 'balanceAfter 75');
}

console.log('— grantAether rejects non-positive');
{
  const env = makeEnv();
  const r = await grantAether(env, G, U, 0, 'x');
  assert(!r.ok, 'refused');
  eq(r.error, 'bad-amount', 'bad-amount');
}

console.log('— spendAether debits + refuses overdraw');
{
  const env = makeEnv();
  await grantAether(env, G, U, 100, 'seed');
  const s1 = await spendAether(env, G, U, 30, 'buy');
  assert(s1.ok, 'spent 30');
  eq(s1.balance, 70, 'balance 70');
  const bal = await getAetherBalance(env, G, U);
  eq(bal.lifetimeSpent, 30, 'lifetimeSpent 30');

  const s2 = await spendAether(env, G, U, 999, 'too-much');
  assert(!s2.ok, 'overdraw refused');
  eq(s2.error, 'insufficient-aether', 'insufficient-aether');
  eq(s2.balance, 70, 'balance unchanged at 70');
}

console.log('— grantAetherForMilestone: known + multiplier + unknown');
{
  const env = makeEnv();
  const r = await grantAetherForMilestone(env, G, U, 'anniversary', { multiplier: 3 });
  assert(r.ok, 'anniversary milestone granted');
  eq(r.balance, MILESTONE_AETHER['anniversary'] * 3, 'base × 3');

  const r2 = await grantAetherForMilestone(env, G, U, 'pass-tier');
  assert(r2.ok, 'pass-tier granted');

  const bad = await grantAetherForMilestone(env, G, U, 'no-such-milestone');
  assert(!bad.ok, 'unknown milestone refused');
  eq(bad.error, 'unknown-milestone', 'unknown-milestone');
}

console.log('— getAetherHistory respects limit');
{
  const env = makeEnv();
  for (let i = 0; i < 5; i++) await grantAether(env, G, U, 1, `g${i}`);
  const h = await getAetherHistory(env, G, U, 3);
  eq(h.transactions.length, 3, 'limited to 3');
}

console.log('');
console.log(`PASSED — ${pass} ok / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
