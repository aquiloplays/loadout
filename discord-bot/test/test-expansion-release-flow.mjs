// End-to-end gate test for the staged-expansion release flow, against the
// REAL creditPack / openPack / release-override code with an in-memory KV.
// Mirrors Clay's acceptance criteria: a hidden set's pack downgrades to
// core; an admin flip makes its packs pull the set; reverting hides it.
//
// Run with:  node test/test-expansion-release-flow.mjs

import { creditPack, openPack, buyPack } from '../cards-packs.js';
import { setExpansionRelease, isExpansionReleased } from '../boltbound-release.js';
import { CARDS } from '../cards-content.js';

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } }
function eq(a, b, m) { if (a === b) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m, '(want', b, 'got', a, ')'); } }

// Generic in-memory KV with prefix list support (covers collection,
// pending packs, wallet, pity, release overrides, all plain KV ops).
function makeEnv() {
  const m = new Map();
  return {
    LOADOUT_BOLTS: {
      get: async (k, o) => { const v = m.get(k); if (v == null) return null; return o && o.type === 'json' ? JSON.parse(v) : v; },
      put: async (k, v) => { m.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
      delete: async (k) => { m.delete(k); },
      list: async ({ prefix, cursor, limit } = {}) => {
        const keys = [...m.keys()].filter(k => !prefix || k.startsWith(prefix)).map(name => ({ name }));
        return { keys: keys.slice(0, limit || 1000), list_complete: true, cursor: null };
      },
    },
  };
}

const G = 'g1', U = 'u1';

await (async () => {
  // ── Hidden by default: a voidborn pack downgrades to core ──────────
  console.log('hidden by default:');
  {
    const env = makeEnv();
    ok(!(await isExpansionReleased(env, 'voidborn')), 'voidborn hidden by default');
    const r = await creditPack(env, G, U, 'bolt', 'test', 'voidborn');
    ok(r.ok, 'creditPack succeeds');
    eq(r.pack.set, 'core', 'a voidborn pack credited while hidden downgrades to core');
    const buy = await buyPack(env, G, U, 'bolt', 'voidborn');   // no wallet funds, but gate runs first
    eq(buy.error, 'set-not-released', 'buyPack refuses a hidden set with set-not-released');
  }

  // ── Admin flip → voidborn packs pull voidborn ──────────────────────
  console.log('after admin release:');
  {
    const env = makeEnv();
    await setExpansionRelease(env, 'voidborn', Date.now());
    ok(await isExpansionReleased(env, 'voidborn'), 'voidborn released after flip');
    const r = await creditPack(env, G, U, 'bolt', 'test', 'voidborn');
    eq(r.pack.set, 'voidborn', 'a voidborn pack now stays tagged voidborn');
    const opened = await openPack(env, G, U, r.pack.id);
    ok(opened.ok, 'openPack succeeds');
    eq(opened.rolled.length, 3, 'pack opens 3 cards');
    ok(opened.rolled.every(id => CARDS[id]?.set === 'voidborn'), 'all 3 pulled cards are voidborn');
  }

  // ── Revert → hidden again ──────────────────────────────────────────
  console.log('after revert:');
  {
    const env = makeEnv();
    await setExpansionRelease(env, 'voidborn', Date.now());
    await setExpansionRelease(env, 'voidborn', null);
    ok(!(await isExpansionReleased(env, 'voidborn')), 'voidborn hidden again after revert');
    const r = await creditPack(env, G, U, 'bolt', 'test', 'voidborn');
    eq(r.pack.set, 'core', 'a voidborn pack downgrades to core again after revert');
  }

  // ── Other sets independent ─────────────────────────────────────────
  console.log('per-set independence:');
  {
    const env = makeEnv();
    await setExpansionRelease(env, 'tides-of-aether', Date.now());
    ok(await isExpansionReleased(env, 'tides-of-aether'), 'tides released');
    ok(!(await isExpansionReleased(env, 'voidborn')), 'voidborn still hidden (independent)');
    const r = await creditPack(env, G, U, 'bolt', 'test', 'tides-of-aether');
    eq(r.pack.set, 'tides-of-aether', 'tides pack tagged tides after its own flip');
  }
})();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
