// Economy v2 (2026-05), pin every paced value so a future drift
// (someone hardcodes a payout, or someone retunes ECONOMY_PACE without
// updating the doc) trips a test failure.
//
// Run from repo root:
//   node discord-bot/test/test-economy-pace.mjs

import {
  ECONOMY_PACE,
  paceBolts, paceMilestone, paceCooldown, paceFunnel,
  QUICK_GAME_NET_WIN_CAP,
  QUICK_GAME_COOLDOWN_MS,
  PET_CARE_COOLDOWN_MS,
  CLASH_DONATE_BOLTS_PER_XP,
} from '../economy-pace.js';

import { DAILY_BASE_BOLTS, STREAK_MILESTONES } from '../community-checkin.js';
import { xpToReach } from '../progression/xp.js';

let failures = 0;
function assert(cond, label) {
  if (cond) console.log('  ✅ ' + label);
  else { failures++; console.log('  ❌ ' + label); }
}
function eq(a, b, label) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) console.log('    expected', JSON.stringify(b), '\n    got     ', JSON.stringify(a));
  assert(ok, label);
}

// ── ECONOMY_PACE constants ─────────────────────────────────────────
console.log('- economy-pace.js constants');
{
  eq(ECONOMY_PACE,             0.4,    'ECONOMY_PACE = 0.4');
  eq(QUICK_GAME_NET_WIN_CAP,   1000,   'QUICK_GAME_NET_WIN_CAP = 1000');
  eq(QUICK_GAME_COOLDOWN_MS,   5000,   'QUICK_GAME_COOLDOWN_MS = 5000 (paced from 2000)');
  eq(PET_CARE_COOLDOWN_MS,     4500000,'PET_CARE_COOLDOWN_MS = 75 min (paced from 30 min)');
  eq(CLASH_DONATE_BOLTS_PER_XP, 250,   'CLASH_DONATE_BOLTS_PER_XP = 250 (paced from 100)');
}

// ── Helpers ────────────────────────────────────────────────────────
console.log('- paceBolts (min-1 clamp)');
{
  eq(paceBolts(100),    40, 'paceBolts(100) = 40');
  eq(paceBolts(50),     20, 'paceBolts(50) = 20');
  eq(paceBolts(10),     4,  'paceBolts(10) = 4');
  eq(paceBolts(5),      2,  'paceBolts(5) = 2');
  eq(paceBolts(2),      1,  'paceBolts(2) = 1 (min clamp)');
  eq(paceBolts(1),      1,  'paceBolts(1) = 1 (min clamp)');
  eq(paceBolts(0),      0,  'paceBolts(0) = 0 (zero passthrough)');
  eq(paceBolts(-5),     0,  'paceBolts(negative) = 0');
}

console.log('- paceMilestone (50% scale)');
{
  eq(paceMilestone(5),  3,  'paceMilestone(5) = 3 (rounded 2.5)');
  eq(paceMilestone(15), 8,  'paceMilestone(15) = 8 (rounded 7.5)');
  eq(paceMilestone(50), 25, 'paceMilestone(50) = 25');
  eq(paceMilestone(1),  1,  'paceMilestone(1) = 1 (min clamp)');
}

console.log('- paceCooldown (slower = longer)');
{
  eq(paceCooldown(2000),  5000,   'paceCooldown(2s) = 5s');
  eq(paceCooldown(30 * 60 * 1000), 4500000, 'paceCooldown(30min) = 75min');
}

console.log('- paceFunnel (passthrough for one-time grants)');
{
  eq(paceFunnel(100),   100,  'paceFunnel(100) = 100 (unchanged)');
  eq(paceFunnel(50),    50,   'paceFunnel(50) = 50 (unchanged)');
}

// ── Check-in payouts ───────────────────────────────────────────────
console.log('- community-checkin payouts');
{
  eq(DAILY_BASE_BOLTS, 2, 'DAILY_BASE_BOLTS = 2 (was 5)');
  eq(STREAK_MILESTONES.length, 3, '3 milestones');
  eq(STREAK_MILESTONES[0].day,    7,  'milestone 0 day = 7');
  eq(STREAK_MILESTONES[0].amount, 3,  'milestone 0 amount = 3 (was 5)');
  eq(STREAK_MILESTONES[1].day,    30, 'milestone 1 day = 30');
  eq(STREAK_MILESTONES[1].amount, 8,  'milestone 1 amount = 8 (was 15)');
  eq(STREAK_MILESTONES[2].day,    100,'milestone 2 day = 100');
  eq(STREAK_MILESTONES[2].amount, 25, 'milestone 2 amount = 25 (was 50)');

  const grandTotal30 = 30 * DAILY_BASE_BOLTS + STREAK_MILESTONES[0].amount + STREAK_MILESTONES[1].amount;
  eq(grandTotal30, 71, '30-day perfect run total = 71 bolts');
}

// ── Counting drip semantic ─────────────────────────────────────────
console.log('- counting drip math');
{
  // Mirror of the formula in aquilo/counting.js, pins the expected
  // reward at each milestone count.
  function dripReward(num) {
    let r = 0;
    if (num % 5 === 0)   r += 1;
    if (num % 25 === 0)  r += 1;
    if (num % 100 === 0) r += 5;
    return r;
  }
  eq(dripReward(1),   0, 'count 1 → 0 bolts');
  eq(dripReward(4),   0, 'count 4 → 0 bolts');
  eq(dripReward(5),   1, 'count 5 → 1 bolt');
  eq(dripReward(10),  1, 'count 10 → 1 bolt');
  eq(dripReward(25),  2, 'count 25 → 2 bolts (multiple of 5 AND 25)');
  eq(dripReward(50),  2, 'count 50 → 2 bolts');
  eq(dripReward(100), 7, 'count 100 → 7 bolts (5+25+100 all hit)');

  // 100-count perfect run total, 20 (×5 hits) + 4 (×25 hits) + 5 (the
  // one ×100 hit) = 29. The 100 itself also satisfies ×5 and ×25 so it
  // earns 7 on that single count.
  let total100 = 0;
  for (let i = 1; i <= 100; i++) total100 += dripReward(i);
  eq(total100, 29, '100-count perfect run = 29 bolts (was ~150 in v1)');
}

// ── XP curve ───────────────────────────────────────────────────────
console.log('- XP curve (steepened)');
{
  eq(xpToReach(1),  0, 'L1 = 0 (start)');
  // v2 formula: round(200·L + 60·L^1.6), exactly 2× the v1 formula
  // at every level (mod ±1 from independent round).
  function v2(L) { return Math.round(200 * L + 60 * Math.pow(L, 1.6)); }
  function v1(L) { return Math.round(100 * L + 30 * Math.pow(L, 1.6)); }
  for (const L of [2, 3, 10, 25, 50, 100]) {
    eq(xpToReach(L), v2(L), `L${L} = ${v2(L)} XP (v2 formula)`);
  }
  // v2 should be ≈ 2× v1 at every level. Allow ±1 to absorb the
  // independent rounding on each formula.
  for (const L of [2, 10, 25, 50, 100]) {
    const diff = xpToReach(L) - v1(L) * 2;
    assert(Math.abs(diff) <= 1, `v2(L${L}) ≈ 2 × v1(L${L})  diff=${diff}`);
  }
  // L2 spot-check the exact value so future drift trips the test.
  eq(xpToReach(2), 582, 'L2 = 582 XP (paced from 291)');
}

console.log('');
if (failures > 0) {
  console.log('FAILED, ' + failures + ' assertion(s) failed');
  process.exit(1);
}
console.log('PASSED, all assertions ok');
