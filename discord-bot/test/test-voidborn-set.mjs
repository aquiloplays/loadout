// Expansion sets, 4x200 catalogue, set-aware packs, and the KV-driven
// release gate (staged hidden until an admin flip).
//
// Run with:  node test/test-voidborn-set.mjs

import { CARDS, rarityPoolsForSet } from '../cards-content.js';
import { pullPack } from '../cards-packs.js';
import { SETS, SET_IDS } from '../boltbound-sets.js';
import {
  isExpansionReleased, releasedSetIds, setExpansionRelease, listEffectiveReleases,
} from '../boltbound-release.js';

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } }
function eq(a, b, m) { if (a === b) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m, '(want', b, 'got', a, ')'); } }

function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; };
}

// In-memory KV mock for the release-override layer.
function makeEnv() {
  const store = {};
  return {
    LOADOUT_BOLTS: {
      get: async (k, o) => { const v = store[k]; if (v == null) return null; return o && o.type === 'json' ? JSON.parse(v) : v; },
      put: async (k, v) => { store[k] = v; },
      delete: async (k) => { delete store[k]; },
    },
  };
}

const EXPANSIONS = ['voidborn', 'tides-of-aether', 'embercrown-rising', 'verdant-awakening'];

// ── Catalogue integrity ──────────────────────────────────────────────
console.log('catalogue:');
{
  eq(SET_IDS.length, 5, 'five sets registered (core + 4 quarterly)');
  for (const slug of EXPANSIONS) {
    const all = Object.values(CARDS).filter(c => c.set === slug);
    const pull = all.filter(c => !c.token);
    eq(pull.length, 200, `${slug} has exactly 200 pullable cards`);
    eq(pull.filter(c => c.rarity === 'legendary').length, 20, `${slug} has 20 legendaries`);
    ok(pull.every(c => c.set === slug), `${slug} cards all tagged set:${slug}`);
  }
  const core = Object.values(CARDS).filter(c => (c.set || 'core') === 'core');
  ok(core.length >= 1267, 'core catalogue intact (>=1267)');
}

// ── Set-aware rarity pools ───────────────────────────────────────────
console.log('pools:');
{
  for (const slug of EXPANSIONS) {
    const p = rarityPoolsForSet(slug);
    ok(p.common.every(c => c.set === slug), `${slug} common pool is ${slug}-only`);
    eq(p.legendary.length, 20, `${slug} legendary pool has 20`);
  }
  const core = rarityPoolsForSet('core');
  ok(!core.common.some(c => EXPANSIONS.includes(c.set)), 'no expansion cards leak into the core pool');
}

// ── Pack rolls respect the set (pool selection is release-independent) ─
console.log('packs:');
{
  let vbOk = true, coreLeak = false, tidesOk = true;
  for (let seed = 1; seed <= 150; seed++) {
    if (!pullPack('bolt', rng(seed), { set: 'voidborn' }).every(id => CARDS[id]?.set === 'voidborn')) vbOk = false;
    if (!pullPack('bolt', rng(seed * 3 + 1), { set: 'tides-of-aether' }).every(id => CARDS[id]?.set === 'tides-of-aether')) tidesOk = false;
    if (pullPack('bolt', rng(seed * 7 + 5)).some(id => EXPANSIONS.includes(CARDS[id]?.set))) coreLeak = true;
  }
  ok(vbOk, 'a Voidborn pack only contains Voidborn cards (150 seeds)');
  ok(tidesOk, 'a Tides pack only contains Tides cards (150 seeds)');
  ok(!coreLeak, 'a default pack never contains expansion cards (150 seeds)');
}

// ── Registry: everything staged hidden ───────────────────────────────
console.log('registry (staged hidden):');
{
  const now = Date.now();
  for (const slug of EXPANSIONS) {
    ok(SETS[slug].releaseUtc > now + 365 * 24 * 3600 * 1000, `${slug} registry date is a far-future placeholder`);
    eq(SETS[slug].plannedCount, 200, `${slug} plannedCount is 200`);
  }
}

// ── KV release gate: hidden → flip → released → revert → hidden ───────
console.log('release gate (KV-driven):');
await (async () => {
  const env = makeEnv();
  ok(await isExpansionReleased(env, 'core'), 'core is always released');
  ok(!(await isExpansionReleased(env, 'voidborn')), 'voidborn hidden by default');
  ok(!(await isExpansionReleased(env, 'tides-of-aether')), 'tides hidden by default');
  eq((await releasedSetIds(env)).join(','), 'core', 'only core released by default');

  await setExpansionRelease(env, 'voidborn', Date.now());
  ok(await isExpansionReleased(env, 'voidborn'), 'voidborn released after admin flip');
  ok(!(await isExpansionReleased(env, 'tides-of-aether')), 'tides still hidden after voidborn flip');
  ok((await releasedSetIds(env)).includes('voidborn'), 'releasedSetIds includes voidborn after flip');
  const eff = await listEffectiveReleases(env);
  ok(eff.voidborn <= Date.now(), 'effective release time is now-ish after flip');

  await setExpansionRelease(env, 'voidborn', null);
  ok(!(await isExpansionReleased(env, 'voidborn')), 'voidborn hidden again after revert');

  let threw = false;
  try { await setExpansionRelease(env, 'core', Date.now()); } catch { threw = true; }
  ok(threw, 'cannot override core release');
})();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
