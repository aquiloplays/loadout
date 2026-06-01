// Clash Expansion E5 — drag-and-drop layout editor backend.
//
// CLASH-EXPANSION-DESIGN.md §6: the web editor lets streamers + mods
// drag buildings onto a 24×24 grid, snap walls together, and submit
// the whole layout atomically. Backend's job:
//   - validate the proposed layout against the live town
//   - check footprint collisions (multi-cell buildings can't overlap)
//   - reject kind mismatches (you can't reskin a Mage Tower)
//   - reject new placements unless affordable + within build queue cap
//   - apply: atomically write the new buildings[], bump layoutVersion,
//     invalidate def-snapshot, append an event
//
// Wall snapping is a render-time concern (4-neighbor bitmask resolved
// client-side per §6.3), but we expose a helper that emits the bitmask
// for any wall in a layout so the editor can preview snapping pre-save.

import { BUILDINGS, footprintFor } from './clash-content.js';
import {
  getTown, putTown, refreshDefenseSnapshot,
} from './clash-state.js';
import { chargeResources } from './clash-resources.js';

// Legacy fallback grid dims, used only when a town record has no
// `grid` field. Bumped 24 -> 48 (2026-06 grid expansion) to match the
// authoritative TOWN_GRID; real towns carry town.grid and override this.
export const GRID_W = 48;
export const GRID_H = 48;

// ── Footprint occupancy ──────────────────────────────────────────────
//
// Returns a Map<"x,y", buildingId> of every tile claimed by a
// building's footprint. Walls + traps are 1×1; defenses can be up to
// 3×3 (TownHall, Eagle Eye). Caller passes the buildings[] array;
// `excludeId` lets the validator ignore a specific id while checking
// overlap (e.g., when moving a building to a different cell).
export function occupancyMap(buildings, excludeId = null) {
  const occ = new Map();
  for (const b of buildings || []) {
    if (excludeId !== null && b.id === excludeId) continue;
    const fp = footprintFor(b.kind);
    for (let dy = 0; dy < fp.h; dy++) {
      for (let dx = 0; dx < fp.w; dx++) {
        const x = (b.x || 0) + dx;
        const y = (b.y || 0) + dy;
        occ.set(`${x},${y}`, b.id || -1);
      }
    }
  }
  return occ;
}

// True if the proposed placement fits the grid + doesn't collide with
// any of the already-occupied tiles in `occ`. Walls + traps may sit
// adjacent to a building edge — those are 1×1 themselves so the
// collision check is identical.
export function placementFits(kind, x, y, occ, gridW = GRID_W, gridH = GRID_H) {
  const fp = footprintFor(kind);
  if (x < 0 || y < 0) return false;
  if (x + fp.w > gridW) return false;
  if (y + fp.h > gridH) return false;
  for (let dy = 0; dy < fp.h; dy++) {
    for (let dx = 0; dx < fp.w; dx++) {
      if (occ.has(`${x + dx},${y + dy}`)) return false;
    }
  }
  return true;
}

// ── Validate a full layout payload ────────────────────────────────────
//
// The web editor sends the full intended layout, not a delta. Validate
// against the live town:
//   - every entry with an `id` field must reference an existing live
//     building of the same kind (no kind reskin)
//   - new placements (entries without an `id`) need a valid kind, level
//     defaulting to 1, and must be affordable + within queue cap
//   - no two footprints overlap on the 24×24 grid
//
// Returns { ok: true, layout: <normalized> } or { ok: false, errors }.

export function validateLayoutUpdate(town, layout) {
  if (!town || !Array.isArray(town.buildings)) {
    return { ok: false, errors: ['no-town'] };
  }
  if (!Array.isArray(layout)) {
    return { ok: false, errors: ['layout-not-array'] };
  }
  // Bounds come from the town's authoritative grid (now 48×48), falling
  // back to the legacy editor constants for grid-less towns.
  const gridW = town.grid?.w || GRID_W;
  const gridH = town.grid?.h || GRID_H;
  const live = new Map(town.buildings.map(b => [b.id, b]));
  const seen = new Set();
  const errors = [];
  const newPlacements = [];
  const moves = [];

  // First pass: identify each entry as a move or a new placement.
  for (const entry of layout) {
    if (!entry || typeof entry !== 'object') {
      errors.push('layout-entry-not-object');
      continue;
    }
    const kind = entry.kind;
    if (!kind || !BUILDINGS[kind]) {
      errors.push(`unknown-kind:${kind}`);
      continue;
    }
    if (entry.id != null) {
      const liveB = live.get(entry.id);
      if (!liveB) {
        errors.push(`unknown-id:${entry.id}`);
        continue;
      }
      if (liveB.kind !== kind) {
        errors.push(`kind-mismatch:${entry.id}:${liveB.kind}->${kind}`);
        continue;
      }
      if (seen.has(entry.id)) {
        errors.push(`duplicate-id:${entry.id}`);
        continue;
      }
      seen.add(entry.id);
      moves.push({ b: liveB, x: entry.x | 0, y: entry.y | 0 });
    } else {
      newPlacements.push({ kind, x: entry.x | 0, y: entry.y | 0, level: Math.max(1, entry.level | 0 || 1) });
    }
  }

  // Build proposed buildings[] applying the moves then the new placements.
  const proposed = town.buildings.map(b => {
    const mv = moves.find(m => m.b.id === b.id);
    if (mv) return { ...b, x: mv.x, y: mv.y };
    return b;
  });

  // Optionally allow deletes — if the payload omits an existing id,
  // treat it as "untouched" rather than implicit delete. The design
  // doc reserves explicit /demolish for removal, so we don't honor
  // implicit drops here.

  // Footprint collision pass against the proposed buildings.
  const occ = new Map();
  for (const b of proposed) {
    const fp = footprintFor(b.kind);
    for (let dy = 0; dy < fp.h; dy++) {
      for (let dx = 0; dx < fp.w; dx++) {
        const key = `${(b.x | 0) + dx},${(b.y | 0) + dy}`;
        if (occ.has(key)) {
          errors.push(`collision:${b.id || '?'}->${occ.get(key)}@${key}`);
        } else {
          occ.set(key, b.id || -1);
        }
      }
    }
  }
  // Grid bounds for moved buildings.
  for (const b of proposed) {
    const fp = footprintFor(b.kind);
    if ((b.x | 0) < 0 || (b.y | 0) < 0 || (b.x | 0) + fp.w > gridW || (b.y | 0) + fp.h > gridH) {
      errors.push(`out-of-bounds:${b.id || '?'}@${b.x},${b.y}`);
    }
  }
  // New placements: fit against the proposed-buildings occupancy.
  for (const np of newPlacements) {
    if (!placementFits(np.kind, np.x, np.y, occ, gridW, gridH)) {
      errors.push(`new-collision:${np.kind}@${np.x},${np.y}`);
      continue;
    }
    const fp = footprintFor(np.kind);
    for (let dy = 0; dy < fp.h; dy++) {
      for (let dx = 0; dx < fp.w; dx++) {
        occ.set(`${np.x + dx},${np.y + dy}`, -1);
      }
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    layout: { moves, newPlacements, proposed },
  };
}

// ── Wall bitmask (server-side helper for editor previews) ────────────
//
// For each wall segment in the layout, compute its 4-neighbor bitmask
// (N=8, E=4, S=2, W=1). Editor previews can render the correct sprite
// pre-save; the same logic resolves client-side per §6.3. Strict
// orthogonal — diagonal walls do NOT connect.

export function wallBitmasksFor(buildings) {
  if (!Array.isArray(buildings)) return {};
  const wallsByCell = new Map();
  for (const b of buildings) {
    if (b.kind !== 'wall') continue;
    wallsByCell.set(`${b.x},${b.y}`, b.id);
  }
  const out = {};
  for (const [key, id] of wallsByCell.entries()) {
    const [x, y] = key.split(',').map(n => parseInt(n, 10));
    let m = 0;
    if (wallsByCell.has(`${x},${y - 1}`)) m |= 0b1000;   // N
    if (wallsByCell.has(`${x + 1},${y}`)) m |= 0b0100;   // E
    if (wallsByCell.has(`${x},${y + 1}`)) m |= 0b0010;   // S
    if (wallsByCell.has(`${x - 1},${y}`)) m |= 0b0001;   // W
    out[id] = m;
  }
  return out;
}

// ── Apply a validated layout ─────────────────────────────────────────
//
// Takes the validation output + handles the actual write: charges
// resources for new placements, mutates buildings[], bumps
// layoutVersion, refreshes the def-snapshot. New placements land at
// level 1 and start in status:'building' (they go through the
// existing clash:queue with kind:'newBuilding') so cooldowns + push
// notifications behave identically to /clash town build.
//
// Returns { ok, layoutVersion, errors? }.

export async function applyLayoutUpdate(env, guildId, town, validated) {
  if (!validated || !validated.ok) {
    return { ok: false, errors: validated?.errors || ['invalid'] };
  }
  // Apply moves (atomic). New placements still go through enqueue —
  // the editor is "queue them up" not "place instantly".
  const { moves, newPlacements } = validated.layout;
  for (const mv of moves) {
    mv.b.x = mv.x;
    mv.b.y = mv.y;
  }
  // Charge + enqueue every new placement. Each is a separate queue
  // entry so the existing walkQueueComplete + pushBuildComplete flow
  // applies one-by-one. Charge total cost up front so a partial
  // failure doesn't leave half-paid placements lingering.
  const { enqueue } = await import('./clash-state.js');
  const { townBuildCost } = await import('./clash-content.js');
  const costsTotal = {};
  const queueItems = [];
  for (const np of newPlacements) {
    const c = townBuildCost(np.kind, 1);
    if (!c) {
      return { ok: false, errors: [`no-level1-cost:${np.kind}`] };
    }
    for (const k of Object.keys(c.cost)) {
      costsTotal[k] = (costsTotal[k] || 0) + (c.cost[k] || 0);
    }
    queueItems.push({ np, c });
  }
  if (Object.keys(costsTotal).length) {
    const charge = await chargeResources(env, guildId, costsTotal);
    if (!charge.ok) {
      return { ok: false, errors: ['insufficient-resources'], missing: charge.missing };
    }
  }
  // Persist the moves first.
  town.layoutVersion = (town.layoutVersion || 0) + 1;
  await putTown(env, guildId, town);
  // Enqueue new placements with a synthetic id placeholder; the queue
  // completer (in clash.js syncCooldowns) will assign the real id at
  // newBuilding completion.
  for (const { np, c } of queueItems) {
    await enqueue(env, 'clash:queue:' + guildId, {
      id: 'q_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      kind: 'newBuilding',
      target: { kind: np.kind, x: np.x, y: np.y },
      endsAt: Date.now() + Math.max(60_000, c.timeMs),
    });
  }
  // Def-snapshot must reflect the new layout for subsequent raids.
  await refreshDefenseSnapshot(env, guildId).catch(() => {});
  return { ok: true, layoutVersion: town.layoutVersion };
}
