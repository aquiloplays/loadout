// Voidborn expansion — set architecture + scheduling + set-aware packs.
//
// Run with:  node test/test-voidborn-set.mjs

import { CARDS, rarityPoolsForSet } from '../cards-content.js';
import { pullPack } from '../cards-packs.js';
import {
  SETS, SET_IDS, isReleased, isNewlyReleased, releasedSetIds,
  latestReleasedSetId, timeUntilRelease,
} from '../boltbound-sets.js';

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } }
function eq(a, b, m) { if (a === b) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m, '(want', b, 'got', a, ')'); } }

// Deterministic xorshift RNG matching cards-packs.js seeding posture.
function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; };
}

// ── Catalogue integrity ──────────────────────────────────────────────
console.log('catalogue:');
{
  const voidborn = Object.values(CARDS).filter(c => c.set === 'voidborn');
  const pullable = voidborn.filter(c => !c.token);
  eq(pullable.length, 50, 'Voidborn has exactly 50 pullable cards');
  const core = Object.values(CARDS).filter(c => (c.set || 'core') === 'core');
  ok(core.length >= 1267, 'core catalogue is intact (>=1267 cards)');
  ok(voidborn.every(c => c.set === 'voidborn'), 'every Voidborn card is tagged set:voidborn');
  ok(pullable.filter(c => c.rarity === 'legendary').length === 5, 'Voidborn has 5 legendaries');
  ok(pullable.filter(c => c.type === 'spell').length === 15, 'Voidborn has 15 spells');
}

// ── Set-aware rarity pools ───────────────────────────────────────────
console.log('pools:');
{
  const vb = rarityPoolsForSet('voidborn');
  ok(vb.common.every(c => c.set === 'voidborn'), 'voidborn common pool is voidborn-only');
  ok(vb.legendary.length === 5, 'voidborn legendary pool has 5');
  const core = rarityPoolsForSet('core');
  ok(core.common.every(c => c.set === 'core' || !c.set), 'core common pool excludes expansions');
  ok(!core.common.some(c => c.id.startsWith('voidborn.')), 'no voidborn cards leak into the core pool');
}

// ── Pack rolls respect the set ───────────────────────────────────────
console.log('packs:');
{
  // A Voidborn pack must only ever yield Voidborn cards.
  let allVoidborn = true, anyVoidbornInCore = false;
  for (let seed = 1; seed <= 200; seed++) {
    const vbPull = pullPack('bolt', rng(seed), { set: 'voidborn' });
    if (!vbPull.every(id => CARDS[id]?.set === 'voidborn')) allVoidborn = false;
    const corePull = pullPack('bolt', rng(seed * 7 + 3));   // no set => core
    if (corePull.some(id => CARDS[id]?.set === 'voidborn')) anyVoidbornInCore = true;
  }
  ok(allVoidborn, 'a Voidborn pack only contains Voidborn cards (200 seeds)');
  ok(!anyVoidbornInCore, 'a default pack never contains Voidborn cards (200 seeds)');
  const three = pullPack('bolt', rng(42), { set: 'voidborn' });
  eq(three.length, 3, 'a pack opens exactly 3 cards');
}

// ── Release scheduling ───────────────────────────────────────────────
console.log('scheduling:');
{
  const now = SETS.voidborn.releaseUtc + 1000;   // just after Voidborn launch
  ok(isReleased('voidborn', now), 'Voidborn is released at launch time');
  ok(isReleased('core', now), 'core is always released');
  ok(!isReleased('tides-of-aether', now), 'future set is NOT released at Voidborn launch');
  ok(isNewlyReleased('voidborn', now), 'Voidborn is "newly released" right after launch');
  ok(!isNewlyReleased('voidborn', now + 8 * 24 * 3600 * 1000), 'the new-set window closes after 7 days');
  ok(timeUntilRelease('tides-of-aether', now) > 0, 'future set has time-until-release');
  eq(timeUntilRelease('voidborn', now), 0, 'released set has 0 time-until-release');
  const live = releasedSetIds(now);
  ok(live.includes('voidborn') && live.includes('core'), 'releasedSetIds includes live sets');
  ok(!live.includes('tides-of-aether'), 'releasedSetIds excludes unreleased sets');
  eq(latestReleasedSetId(now), 'voidborn', 'latest released set is Voidborn at launch');
  ok(SET_IDS.length === 5, 'five sets are registered (core + 4 quarterly)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
