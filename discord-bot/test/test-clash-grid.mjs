// Tests for the Clash town-grid expansion (16/24 -> 48, 2026-06).
// Covers: TOWN_GRID constant, ensureTown seed + lazy backfill of legacy
// towns, and grid-aware placement validation (the now-larger bounds are
// accepted; out-of-bounds is still rejected).
//
// Run: node test/test-clash-grid.mjs

import { ensureTown, TOWN_GRID } from '../clash-state.js';
import { validateLayoutUpdate, placementFits } from '../clash-layout.js';

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } }
function eq(a, b, m) { if (a === b) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m, '(want', b, 'got', a + ')'); } }

// ── KV mock ────────────────────────────────────────────────────────
function makeEnv(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    LOADOUT_BOLTS: {
      async get(k, opts) { const v = store.get(k); if (v == null) return null; return opts?.type === 'json' ? JSON.parse(v) : v; },
      async put(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
      async delete(k) { store.delete(k); },
      async list() { return { keys: [], list_complete: true }; },
    },
    _store: store,
  };
}
const G = 'g1';

console.log('— TOWN_GRID is 48');
eq(TOWN_GRID, 48, 'TOWN_GRID === 48');

console.log('— ensureTown seeds a fresh town at 48×48');
{
  const env = makeEnv();
  const town = await ensureTown(env, G, 'owner1');
  eq(town.grid.w, 48, 'seed grid.w 48');
  eq(town.grid.h, 48, 'seed grid.h 48');
}

console.log('— ensureTown lazily upgrades a legacy 16×16 town to 48×48');
{
  const legacy = {
    guildId: G, thLevel: 1, grid: { w: 16, h: 16 },
    buildings: [{ id: 1, kind: 'townhall', level: 1, x: 8, y: 8, hp: 800, status: 'idle' }],
    obstacles: [], engineers: { total: 1 }, defenderChampion: null, battlePlans: 0,
  };
  const env = makeEnv({ [`clash:town:${G}`]: JSON.stringify(legacy) });
  const town = await ensureTown(env, G, 'owner1');
  eq(town.grid.w, 48, 'legacy grid.w upgraded to 48');
  eq(town.grid.h, 48, 'legacy grid.h upgraded to 48');
  // persisted
  const persisted = JSON.parse(env._store.get(`clash:town:${G}`));
  eq(persisted.grid.w, 48, 'upgrade persisted to KV');
  // existing building position preserved
  eq(town.buildings[0].x, 8, 'existing building position preserved');
}

console.log('— ensureTown does NOT shrink an already-large town');
{
  const big = {
    guildId: G, thLevel: 1, grid: { w: 64, h: 64 },
    buildings: [{ id: 1, kind: 'townhall', level: 1, x: 8, y: 8, hp: 800, status: 'idle' }],
    obstacles: [], engineers: { total: 1 }, defenderChampion: null, battlePlans: 0,
  };
  const env = makeEnv({ [`clash:town:${G}`]: JSON.stringify(big) });
  const town = await ensureTown(env, G, 'owner1');
  eq(town.grid.w, 64, '64-wide grid left intact (>= 48)');
}

// ── placement validation (grid-aware) ──────────────────────────────
console.log('— placementFits honors explicit grid bounds');
{
  const occ = new Map();
  assert(placementFits('cannon', 40, 40, occ, 48, 48), 'cannon at 40,40 fits in 48 grid (beyond old 24)');
  assert(!placementFits('townhall', 47, 47, occ, 48, 48), '3×3 TH at 47,47 exceeds 48 bound -> rejected');
  assert(!placementFits('cannon', 50, 10, occ, 48, 48), 'x=50 beyond 48 -> rejected');
  assert(!placementFits('cannon', 40, 40, occ, 24, 24), 'same tile rejected when grid is only 24 (grid-aware)');
}

console.log('— validateLayoutUpdate accepts placements in the expanded grid, rejects out-of-bounds');
{
  const town = {
    grid: { w: 48, h: 48 },
    buildings: [{ id: 1, kind: 'townhall', level: 1, x: 8, y: 8 }],
  };
  // A new cannon at x=40 (beyond the old 24 bound) is now valid.
  const okRes = validateLayoutUpdate(town, [
    { id: 1, kind: 'townhall', x: 8, y: 8 },
    { kind: 'cannon', x: 40, y: 40 },
  ]);
  assert(okRes.ok, 'placement at 40,40 accepted on 48 grid');

  // Beyond 48 -> rejected.
  const badRes = validateLayoutUpdate(town, [
    { id: 1, kind: 'townhall', x: 8, y: 8 },
    { kind: 'cannon', x: 50, y: 10 },
  ]);
  assert(!badRes.ok, 'placement at 50,10 rejected (out of bounds)');
  assert(badRes.errors.some(e => e.includes('50')), 'error references the bad coord');
}

console.log('— a 16×16 town still rejects placements beyond its own bounds');
{
  const town = { grid: { w: 16, h: 16 }, buildings: [{ id: 1, kind: 'townhall', level: 1, x: 8, y: 8 }] };
  const res = validateLayoutUpdate(town, [
    { id: 1, kind: 'townhall', x: 8, y: 8 },
    { kind: 'cannon', x: 20, y: 20 },
  ]);
  assert(!res.ok, 'placement at 20,20 rejected on a 16 grid (grid-aware, not hardcoded 48)');
}

console.log('');
console.log(`PASSED — ${pass} ok / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
