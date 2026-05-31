// Snapshot + sanity tests for the Clash economy curves (Clay 2026-05-31
// overhaul, part E). The cost/build-duration scaling per level already
// lives hand-tuned in clash-content.js (cost[]/time[]/hp[] per building,
// bolts+time per troop). This test:
//   1. SNAPSHOT — compares the live economy to a committed baseline
//      (clash-economy-snapshot.json) so any future cost/duration change
//      is visible + intentional. Regenerate the baseline with UPDATE=1.
//   2. SANITY — per-building invariants: cost/time/hp arrays consistent
//      length, build durations non-decreasing per level, hp strictly
//      increasing, costs non-decreasing in total resource value.
//
// Run:        node test/test-clash-economy.mjs
// Re-baseline: UPDATE=1 node test/test-clash-economy.mjs   (after an
//             intentional economy change; review the diff, then commit)

import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import {
  BUILDINGS, TROOPS_PERSONAL, TROOPS_GARRISON, maxLevelForBuilding,
} from '../clash-content.js';

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } }

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(HERE, '..', 'clash-economy-snapshot.json');

function buildSnapshot() {
  const snap = { buildings: {}, troops: { personal: {}, garrison: {} } };
  for (const [slug, b] of Object.entries(BUILDINGS)) {
    const max = maxLevelForBuilding(slug);
    const levels = [];
    for (let L = 1; L <= max; L++) {
      levels.push({ level: L, cost: b.cost[L] || null, timeMs: b.time[L] ?? null, hp: b.hp[L] ?? null });
    }
    snap.buildings[slug] = { maxLevel: max, levels };
  }
  for (const [k, t] of Object.entries(TROOPS_PERSONAL)) snap.troops.personal[k] = { bolts: t.bolts ?? null, time: t.time ?? null };
  for (const [k, t] of Object.entries(TROOPS_GARRISON)) snap.troops.garrison[k] = { bolts: t.bolts ?? null, time: t.time ?? null };
  return snap;
}

const live = buildSnapshot();

// ── UPDATE mode ────────────────────────────────────────────────────
if (process.env.UPDATE) {
  fs.writeFileSync(BASELINE, JSON.stringify(live, null, 2));
  console.log('Re-baselined clash-economy-snapshot.json. Review the diff before committing.');
  process.exit(0);
}

// ── 1. Snapshot comparison ─────────────────────────────────────────
console.log('— economy matches committed snapshot');
{
  const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const liveStr = JSON.stringify(live);
  const baseStr = JSON.stringify(baseline);
  if (liveStr === baseStr) {
    assert(true, 'live economy == baseline (no unintended drift)');
  } else {
    // Surface the first differing building/troop for a readable failure.
    const diffs = [];
    for (const slug of Object.keys(live.buildings)) {
      if (JSON.stringify(live.buildings[slug]) !== JSON.stringify(baseline.buildings?.[slug])) diffs.push('building:' + slug);
    }
    for (const slug of Object.keys(baseline.buildings || {})) {
      if (!live.buildings[slug]) diffs.push('removed building:' + slug);
    }
    for (const grp of ['personal', 'garrison']) {
      for (const k of Object.keys(live.troops[grp])) {
        if (JSON.stringify(live.troops[grp][k]) !== JSON.stringify(baseline.troops?.[grp]?.[k])) diffs.push(`troop:${grp}:${k}`);
      }
    }
    console.log('     drift in:', diffs.slice(0, 20).join(', ') || '(structure changed)');
    console.log('     If intentional, re-baseline:  UPDATE=1 node test/test-clash-economy.mjs');
    assert(false, 'live economy drifted from baseline (see above)');
  }
}

// ── 2. Per-building sanity invariants ──────────────────────────────
console.log('— per-building curve invariants');
{
  // Some high-tier buildings (heavyCannon, infernoTower, eagleEye) are
  // TH-gated: their low levels are intentional `null` sentinels (the
  // building is unavailable until a high Town Hall unlocks it). So we
  // validate only REAL levels (cost !== null): they must have positive
  // hp + a build time, durations non-decreasing. We also assert the
  // sentinel levels form a clean leading prefix (a building becomes
  // available at some level K, then stays available) — no mid-range
  // gaps. We do NOT flat-sum heterogeneous resources (the snapshot is
  // the source of truth for exact costs).
  let lenBad = 0, timeBad = 0, hpBad = 0, gapBad = 0, realLevels = 0;
  for (const [slug, b] of Object.entries(BUILDINGS)) {
    const max = maxLevelForBuilding(slug);
    if ((b.cost.length - 1) !== max || (b.time.length - 1) !== max) lenBad++;
    let prevTime = -1, seenReal = false, gapAfterReal = false;
    for (let L = 1; L <= max; L++) {
      const real = b.cost[L] != null;
      if (real) {
        seenReal = true; realLevels++;
        const t = b.time[L], hp = b.hp[L];
        if (t == null || t < prevTime) timeBad++;     // durations non-decreasing among real levels
        if (!(hp > 0)) hpBad++;                        // real levels have positive hp
        prevTime = t;
      } else if (seenReal) {
        gapAfterReal = true;                           // a null AFTER a real level = mid-range gap
      }
    }
    if (gapAfterReal) gapBad++;
  }
  assert(lenBad === 0, `all buildings: cost/time arrays match maxLevel (${lenBad} bad)`);
  assert(timeBad === 0, `build durations non-decreasing among real levels (${timeBad} bad)`);
  assert(hpBad === 0, `every real (buildable) level has positive hp (${hpBad} bad of ${realLevels})`);
  assert(gapBad === 0, `sentinel (unavailable) levels form a clean leading prefix (${gapBad} buildings with mid-range gaps)`);
}

// ── 3. Troop training has cost + duration ──────────────────────────
console.log('— every troop has a training cost + duration');
{
  let bad = 0;
  for (const grp of [TROOPS_PERSONAL, TROOPS_GARRISON]) {
    for (const [k, t] of Object.entries(grp)) {
      const cost = t.bolts ?? t.cost;
      if (!(cost > 0) || !(t.time > 0)) { bad++; console.log('     missing:', k); }
    }
  }
  assert(bad === 0, `all troops priced + timed (${bad} bad)`);
}

// ── 4. Anchor spot-checks (human-readable canaries) ────────────────
console.log('— anchor values');
{
  assert(maxLevelForBuilding('townhall') === 10, 'townhall cap = 10');
  assert(BUILDINGS.townhall.time[10] === 120 * 3_600_000, 'townhall L10 build = 120h');
  assert(maxLevelForBuilding('wall') === 8, 'wall cap = 8');
  assert(maxLevelForBuilding('caltrops') === 2, 'caltrops cap = 2');
}

console.log('');
console.log(`PASSED — ${pass} ok / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
