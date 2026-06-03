// Unit tests for bolt-rain.js, the interactive Patreon-T2+ bolt rain.
// Covers the T2+ gate, trigger/no-stack, first-click claim, per-user
// dedup, pool depletion, expiry, and wallet credit.
//
// Run with:   node test/test-bolt-rain.mjs

import {
  isPatreonT2Plus,
  triggerBoltRain,
  claimBoltRain,
  getBoltRainState,
} from '../bolt-rain.js';

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } }
function eq(a, b, m)  { if (a === b) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m, '(want:', b, 'got:', a, ')'); } }

function makeKV(initial = {}) {
  const store = new Map(Object.entries(initial).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return {
    _store: store,
    async get(k, opts) { if (!store.has(k)) return null; const v = store.get(k); return opts && opts.type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { store.set(k, String(v)); },
    async delete(k) { store.delete(k); },
  };
}
const G = 'g1';
function envWith(patreon) {
  const init = {};
  if (patreon) init[`patreon:tier:${patreon.userId}`] = patreon.rec;
  return { LOADOUT_BOLTS: makeKV(init) };
}

// ── T2+ gate ──────────────────────────────────────────────────────
console.log('- isPatreonT2Plus gate');
{
  eq(await isPatreonT2Plus(envWith(), 'nobody'), false, 'no record → false');
  eq(await isPatreonT2Plus(envWith({ userId: 'u', rec: { tier: 'free' } }), 'u'), false, 'free → false');
  eq(await isPatreonT2Plus(envWith({ userId: 'u', rec: { tier: 'Tier 1', amount_cents: 300 } }), 'u'), false, '$3 → false');
  eq(await isPatreonT2Plus(envWith({ userId: 'u', rec: { tier: 'Tier 2', amount_cents: 500 } }), 'u'), true, '$5 → true');
  eq(await isPatreonT2Plus(envWith({ userId: 'u', rec: { tier: 'Tier 3 Patron' } }), 'u'), true, 'tier-3 label → true');
  eq(await isPatreonT2Plus(envWith({ userId: 'u', rec: { tier: 'Gold' } }), 'u'), true, 'gold label → true');
}

// ── trigger gate + no-stack ───────────────────────────────────────
console.log('- triggerBoltRain: gated + no stacking');
{
  const env = envWith();
  const denied = await triggerBoltRain(env, G, 'free-user');
  assert(!denied.ok, 'non-T2 refused');
  eq(denied.error, 'not-tier-2', 'not-tier-2');

  const env2 = envWith({ userId: 'patron', rec: { tier: 'Tier 2', amount_cents: 800 } });
  const r = await triggerBoltRain(env2, G, 'patron', { perClaim: 25, maxClaims: 3 });
  assert(r.ok, 'T2 patron triggers');
  eq(r.pool, 75, 'pool = perClaim*maxClaims');
  eq(r.claimsRemaining, 3, '3 claims');

  const again = await triggerBoltRain(env2, G, 'patron');
  assert(!again.ok, 'second trigger refused');
  eq(again.error, 'already-active', 'already-active');
}

// ── claim flow ────────────────────────────────────────────────────
console.log('- claimBoltRain: first-click, dedup, depletion, wallet credit');
{
  const env = envWith({ userId: 'patron', rec: { tier: 'Tier 2', amount_cents: 800 } });
  await triggerBoltRain(env, G, 'patron', { perClaim: 10, maxClaims: 2 });

  const c1 = await claimBoltRain(env, G, 'viewer-A');
  assert(c1.ok, 'viewer-A claims');
  eq(c1.amount, 10, 'got 10 bolts');
  eq(c1.claimsRemaining, 1, '1 remaining');
  // wallet credited
  const w = await env.LOADOUT_BOLTS.get(`wallet:${G}:viewer-A`, { type: 'json' });
  eq(w.balance, 10, 'wallet balance 10');

  const dup = await claimBoltRain(env, G, 'viewer-A');
  assert(!dup.ok, 'no double claim');
  eq(dup.error, 'already-claimed', 'already-claimed');

  const c2 = await claimBoltRain(env, G, 'viewer-B');
  assert(c2.ok, 'viewer-B claims last slot');
  eq(c2.claimsRemaining, 0, '0 remaining');

  const c3 = await claimBoltRain(env, G, 'viewer-C');
  assert(!c3.ok, 'pool depleted');
  eq(c3.error, 'depleted', 'depleted');
}

// ── expiry ────────────────────────────────────────────────────────
console.log('- expired event → not-active');
{
  const env = envWith({ userId: 'patron', rec: { tier: 'Tier 2', amount_cents: 800 } });
  await triggerBoltRain(env, G, 'patron');
  // Force-expire by rewriting the stored event's expiresUtc into the past.
  const ev = await env.LOADOUT_BOLTS.get(`boltrain:event:${G}`, { type: 'json' });
  ev.expiresUtc = Date.now() - 1000;
  await env.LOADOUT_BOLTS.put(`boltrain:event:${G}`, JSON.stringify(ev));

  const st = await getBoltRainState(env, G, 'viewer-X');
  eq(st.active, false, 'state inactive after expiry');
  const c = await claimBoltRain(env, G, 'viewer-X');
  assert(!c.ok, 'claim refused');
  eq(c.error, 'not-active', 'not-active');
}

// ── state shape ───────────────────────────────────────────────────
console.log('- getBoltRainState reports youClaimed');
{
  const env = envWith({ userId: 'patron', rec: { tier: 'Tier 2', amount_cents: 800 } });
  await triggerBoltRain(env, G, 'patron', { perClaim: 5, maxClaims: 10 });
  await claimBoltRain(env, G, 'viewer-Z');
  const st = await getBoltRainState(env, G, 'viewer-Z');
  assert(st.active, 'active');
  eq(st.youClaimed, true, 'viewer-Z claimed flag');
  const st2 = await getBoltRainState(env, G, 'viewer-new');
  eq(st2.youClaimed, false, 'fresh viewer not claimed');
  assert(st2.msRemaining > 0, 'msRemaining positive');
}

console.log('');
console.log(`PASSED, ${pass} ok / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
