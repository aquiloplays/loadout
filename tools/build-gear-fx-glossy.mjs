// J4 — Glossy legendary gear FX halos (per-slot, 128×160).
//
// Replaces the retired 64×80 gear/fx/<itemSlug>.png halos with a
// per-slot halo overlay anchored at the slot's body position. Six
// halos total (one per equipable slot) — the halo signals "this
// gear piece is legendary rarity" by floating a soft gold/violet
// glow around the gear's footprint on the hero.
//
// Output: aquilo-gg/sprites/gear/figure/fx/<slot>.png    (6 PNGs)
//   weapon  — glow around the right hand (where weapons render)
//   head    — halo over the helmet
//   chest   — soft aura over the torso
//   legs    — glow band over the legs
//   boots   — pulse around the feet
//   trinket — sparkle accent at the chest amulet position
//
// Each PNG is mostly transparent — only the glow + sparkles paint.
// Composes ABOVE the equipped gear so the halo reads as overlay
// magic on top of the equipped piece.
//
// Run:  node tools/build-gear-fx-glossy.mjs

import { mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { PALETTE, svgWrapper } from './glossy-art-kit.mjs';
import { bakeFile } from './bake-glossy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT  = join(ROOT, 'aquilo-gg/sprites/gear/figure/fx');
mkdirSync(OUT, { recursive: true });

const W = 128, H = 160;

// ── Helpers ─────────────────────────────────────────────────────

// Soft radial glow at (cx, cy) of given radius. Gold (legendary)
// by default; can override colour.
function radialGlow({ cx, cy, r, color = PALETTE.gold.hi, id }) {
  return `
<defs>
  <radialGradient id="${id}" cx="0.5" cy="0.5" r="0.5">
    <stop offset="0"    stop-color="${color}" stop-opacity="0.85"/>
    <stop offset="0.45" stop-color="${color}" stop-opacity="0.45"/>
    <stop offset="1"    stop-color="${color}" stop-opacity="0"/>
  </radialGradient>
</defs>
<ellipse cx="${cx}" cy="${cy}" rx="${r}" ry="${r}" fill="url(#${id})"/>`;
}

// Small 4-point sparkle.
function sparkle(cx, cy, size = 6, color = PALETTE.gold.hi) {
  return `<path d="M ${cx} ${cy - size}
                   L ${cx + size * 0.3} ${cy - size * 0.3}
                   L ${cx + size} ${cy}
                   L ${cx + size * 0.3} ${cy + size * 0.3}
                   L ${cx} ${cy + size}
                   L ${cx - size * 0.3} ${cy + size * 0.3}
                   L ${cx - size} ${cy}
                   L ${cx - size * 0.3} ${cy - size * 0.3} Z"
                fill="${color}" opacity="0.9"/>`;
}

// ── Per-slot FX bodies ──────────────────────────────────────────

const FX = {
  // Right-hand weapon glow — sits at the weapon anchor (102, 90)
  weapon: () => `
${radialGlow({ cx: 102, cy: 90, r: 38, id: 'fx-w' })}
${sparkle(120, 56, 5)}
${sparkle(86, 62, 4, PALETTE.cream.hi)}
${sparkle(112, 122, 4)}
${sparkle(96, 96, 3, PALETTE.cream.hi)}`,

  // Head halo — over the helmet area
  head: () => `
${radialGlow({ cx: 64, cy: 36, r: 36, id: 'fx-h' })}
<!-- ring halo arc above head -->
<path d="M 30 30 A 34 14 0 0 1 98 30"
      fill="none" stroke="${PALETTE.gold.hi}" stroke-width="3" opacity="0.7"/>
<path d="M 32 30 A 32 12 0 0 1 96 30"
      fill="none" stroke="${PALETTE.white}" stroke-width="1.5" opacity="0.85"/>
${sparkle(40, 12, 5)}
${sparkle(92, 12, 5)}
${sparkle(64, 4, 4, PALETTE.cream.hi)}`,

  // Torso aura — soft body glow
  chest: () => `
${radialGlow({ cx: 64, cy: 84, r: 50, id: 'fx-c' })}
${sparkle(28, 70, 5)}
${sparkle(100, 70, 5)}
${sparkle(28, 100, 4, PALETTE.cream.hi)}
${sparkle(100, 100, 4, PALETTE.cream.hi)}
${sparkle(64, 56, 4)}`,

  // Legs glow band
  legs: () => `
${radialGlow({ cx: 64, cy: 130, r: 40, id: 'fx-l' })}
${sparkle(36, 122, 4)}
${sparkle(92, 122, 4)}
${sparkle(50, 146, 3, PALETTE.cream.hi)}
${sparkle(78, 146, 3, PALETTE.cream.hi)}`,

  // Boots pulse at feet
  boots: () => `
${radialGlow({ cx: 64, cy: 148, r: 36, id: 'fx-b' })}
<!-- ground sparkle ring -->
<ellipse cx="64" cy="154" rx="34" ry="6" fill="none" stroke="${PALETTE.gold.hi}" stroke-width="2" opacity="0.7"/>
${sparkle(30, 152, 4)}
${sparkle(98, 152, 4)}`,

  // Chest amulet sparkle (trinket position)
  trinket: () => `
${radialGlow({ cx: 64, cy: 80, r: 24, id: 'fx-t' })}
${sparkle(64, 64, 6)}
${sparkle(48, 80, 4, PALETTE.cream.hi)}
${sparkle(80, 80, 4, PALETTE.cream.hi)}
${sparkle(64, 96, 4)}`,
};

// ── Bake driver ─────────────────────────────────────────────────

let count = 0;
for (const [slot, fn] of Object.entries(FX)) {
  const svg = svgWrapper({
    width: W, height: H,
    title: `fx-${slot} (legendary halo)`,
    desc: 'Glossy legendary-rarity halo overlay for the slot. Source: tools/build-gear-fx-glossy.mjs',
    body: fn(),
  });
  const out = join(OUT, `${slot}.png`);
  await bakeFile(svg, out, { width: W, height: H });
  count++;
  console.log(`  fx-${slot}.png`);
}
console.log(`\n✓ baked ${count} glossy legendary FX halos → ${OUT}`);
