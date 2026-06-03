// Unit tests for random-drops.js, rarity-weighted community chest
// spawns. Covers weighted rarity selection, spawn/no-stack, claim
// (first-click, dedup, depletion, reward fan-out), expiry, and the
// even-hour cron gate.
//
// Run with:   node test/test-random-drops.mjs

import {
  pickRarity,
  spawnRandomDrop,
  claimRandomDrop,
  getRandomDropState,
  randomDropCron,
} from '../random-drops.js';

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } }
function eq(a, b, m)  { if (a === b) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m, '(want:', b, 'got:', a, ')'); } }

function makeKV() {
  const store = new Map();
  return {
    _store: store,
    async get(k, opts) { if (!store.has(k)) return null; const v = store.get(k); return opts && opts.type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { store.set(k, String(v)); },
    async delete(k) { store.delete(k); },
  };
}
function makeEnv() { return { LOADOUT_BOLTS: makeKV(), AQUILO_VAULT_GUILD_ID: 'g1' }; }
const G = 'g1';

console.log('- pickRarity is weighted (rand boundaries)');
{
  eq(pickRarity(0.0).rarity, 'common', 'rand 0 → common');
  eq(pickRarity(0.49).rarity, 'common', 'rand .49 → common');
  eq(pickRarity(0.60).rarity, 'uncommon', 'rand .60 → uncommon');
  eq(pickRarity(0.90).rarity, 'rare', 'rand .90 → rare');
  eq(pickRarity(0.97).rarity, 'epic', 'rand .97 → epic');
  eq(pickRarity(0.995).rarity, 'legendary', 'rand .995 → legendary');
}

console.log('- spawnRandomDrop + no stacking');
{
  const env = makeEnv();
  const r = await spawnRandomDrop(env, G, { rand: 0.0 });   // common
  assert(r.ok, 'spawned');
  eq(r.rarity, 'common', 'common rarity');
  eq(r.maxClaims, 25, 'common 25 slots');

  const again = await spawnRandomDrop(env, G, { rand: 0.99 });
  assert(again.alreadyActive, 'second spawn returns active (no stack)');
  eq(again.rarity, 'common', 'still the common one');
}

console.log('- claimRandomDrop: first-click, dedup, reward, depletion');
{
  const env = makeEnv();
  // legendary for max reward variety, but force tiny slot count via def.
  await spawnRandomDrop(env, G, { rarityDef: {
    rarity: 'rare', maxClaims: 2, reward: { bolts: 150, aether: 15 },
  } });

  const c1 = await claimRandomDrop(env, G, 'viewer-A');
  assert(c1.ok, 'A claims');
  eq(c1.rarity, 'rare', 'rare');
  eq(c1.reward.bolts, 150, '150 bolts granted');
  // aether needs the D1 ledger; absent here, so the grant is skipped +
  // an error is recorded rather than echoed (graceful degradation).
  assert(c1.reward.aether === undefined && c1.reward.error, 'aether skipped without D1 (error recorded)');
  eq(c1.claimsRemaining, 1, '1 left');
  const w = await env.LOADOUT_BOLTS.get(`wallet:${G}:viewer-A`, { type: 'json' });
  eq(w.balance, 150, 'wallet credited 150');

  const dup = await claimRandomDrop(env, G, 'viewer-A');
  assert(!dup.ok && dup.error === 'already-claimed', 'no double claim');

  const c2 = await claimRandomDrop(env, G, 'viewer-B');
  assert(c2.ok, 'B claims last slot');
  eq(c2.claimsRemaining, 0, '0 left');

  const c3 = await claimRandomDrop(env, G, 'viewer-C');
  assert(!c3.ok && c3.error === 'depleted', 'depleted');
}

console.log('- expiry → not-active');
{
  const env = makeEnv();
  await spawnRandomDrop(env, G, { rand: 0 });
  const ev = await env.LOADOUT_BOLTS.get(`randomdrop:event:${G}`, { type: 'json' });
  ev.expiresUtc = Date.now() - 1000;
  await env.LOADOUT_BOLTS.put(`randomdrop:event:${G}`, JSON.stringify(ev));
  const st = await getRandomDropState(env, G, 'x');
  eq(st.active, false, 'inactive after expiry');
  const c = await claimRandomDrop(env, G, 'x');
  assert(!c.ok && c.error === 'not-active', 'claim refused');
}

console.log('- randomDropCron even-hour gate + bucket dedup');
{
  const env = makeEnv();
  // Odd hour → off-cadence.
  const odd = await randomDropCron(env, { nowUtc: Date.UTC(2026, 4, 31, 3, 0, 0) });
  eq(odd.skipped, 'off-cadence', 'odd hour skipped');
  // Even hour, minute 0 → spawns.
  const evenT = Date.UTC(2026, 4, 31, 4, 0, 0);
  const evn = await randomDropCron(env, { nowUtc: evenT });
  assert(evn.spawned?.ok, 'even-hour:00 spawns');
  // Same bucket again → deduped.
  const dup = await randomDropCron(env, { nowUtc: evenT + 30_000 });
  eq(dup.skipped, 'already-spawned-this-bucket', 'bucket dedup');
  // Minute != 0 → off-cadence even on even hour.
  const midHour = await randomDropCron(env, { nowUtc: Date.UTC(2026, 4, 31, 6, 17, 0) });
  eq(midHour.skipped, 'off-cadence', 'mid-hour skipped');
}

console.log('- getRandomDropState youClaimed');
{
  const env = makeEnv();
  await spawnRandomDrop(env, G, { rand: 0 });
  await claimRandomDrop(env, G, 'claimer');
  const st = await getRandomDropState(env, G, 'claimer');
  assert(st.active, 'active');
  eq(st.youClaimed, true, 'claimer flagged');
  const st2 = await getRandomDropState(env, G, 'other');
  eq(st2.youClaimed, false, 'other not flagged');
}

console.log('');
console.log(`PASSED, ${pass} ok / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
