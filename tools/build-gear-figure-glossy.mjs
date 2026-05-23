// A5b — Gear paper-doll figure layers.
//
// Takes each of the 185 glossy gear icon SVGs (192×192, item
// centred at 96,96) and re-projects it onto the 128×160 figure
// canvas at the correct per-slot anchor so character.js compose
// can layer them on the hero. Output is baked to PNG so the
// existing png-codec compose flow ingests it unchanged.
//
// Per-slot anchor (figure canvas 128×160):
//   head:    over the head circle    (HEAD_CX=64, HEAD_CY=36, ~50×40)
//   chest:   over the torso          (cx=64, cy=82, ~58×52)
//   legs:    over the legs zone      (cx=64, cy=128, ~50×42)
//   boots:   at the feet baseline    (cx=64, cy=148, ~54×18)
//   weapon:  held at the right hand  (cx=96, cy=92, ~52×72, slight tilt)
//   trinket: chest accessory         (cx=64, cy=78, ~24×28)
//
// Icon-context elements are stripped before re-projecting:
//   • rarity glow ellipse (fill="url(#gk-rarity-…)")
//   • contact-shadow ellipse (fill="url(#gk-contact-shadow)")
//   • the icon's rarity ring (cx=96 cy=96 r=86 stroke ring)
// The gear shape itself + its inline defs survive the pass — the
// gloss highlights, gradient fills, and accent rings on the shape
// are all part of the glossy idiom and look correct at figure
// scale.
//
// Output: aquilo-gg/sprites/gear/figure/<slot>/<safeId>.png
//
// Run:  node tools/build-gear-figure-glossy.mjs

import { mkdirSync, readFileSync, readdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { bakeFile } from './bake-glossy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const GEAR_GLOSSY = join(ROOT, 'aquilo-gg/sprites/gear/glossy');
const OUT_BASE   = join(ROOT, 'aquilo-gg/sprites/gear/figure');

const SLOTS = ['weapon', 'head', 'chest', 'legs', 'boots', 'trinket'];
for (const s of SLOTS) mkdirSync(join(OUT_BASE, s), { recursive: true });

// ── Figure canvas + per-slot anchor table ───────────────────────
//
// Each slot describes how to place the gear's 192×192 icon-space
// content onto the 128×160 figure canvas. `scale` is uniform.
// `tx`/`ty` translate the icon's origin so its centre (96,96)
// lands at the figure anchor (figureCx, figureCy).
//
//   placed_x = scale * iconX + tx
//   placed_y = scale * iconY + ty
// To centre: tx = figureCx - scale * 96; ty = figureCy - scale * 96.

const FIGURE_W = 128, FIGURE_H = 160;

function anchorFor(slot) {
  // Each entry: { cx, cy, scale, rotateDeg? }
  //
  // Anchors retuned 2026-05 after visual review — earlier scales
  // were too aggressive (chest+legs covered body entirely; weapon
  // crossed through legs). Goal: gear is *clothing on* the hero,
  // not a body-shaped paint-over. Arms, shoulders, hands, feet
  // remain visible to either side.
  //
  // Body anatomy reference (matches build-character-glossy.mjs):
  //   head circle:   cx=64 cy=36 r=22         (top of head y=14, chin y=58)
  //   shoulders:     y=56                     (arms attach here)
  //   torso bounds:  x=32..96  y=56..110      (≈ 64 wide × 54 tall)
  //   legs zone:     x=42..86  y=110..152
  //   feet baseline: y=152
  switch (slot) {
    case 'head':
      // Anchored on the head circle. Scale 0.36 → 192*0.36 ≈ 69 px
      // bounding box, with the actual helmet/hood silhouette
      // inside narrower than that. Centred on the head.
      return { cx: 64, cy: 36, scale: 0.36, rotateDeg: 0 };
    case 'chest':
      // Sits over the torso. cy=84 (mid-torso). Scale 0.34 →
      // ~65 px bounding box at most. Keeps shoulders + arm
      // outlines visible to either side of the chest piece.
      return { cx: 64, cy: 84, scale: 0.34, rotateDeg: 0 };
    case 'legs':
      // Over the legs zone. Scale 0.32 → 61 px. Keeps the
      // belt-line clean against chest and feet visible below.
      return { cx: 64, cy: 130, scale: 0.32, rotateDeg: 0 };
    case 'boots':
      // Footwear sits at the feet baseline. Boots icon template
      // already has soles near y≈156 inside its own canvas; at
      // scale 0.30 the soles land below cy by 0.30 × (156-96) =
      // 18 px, so cy=138 puts soles at the FOOT_Y=152 mark.
      return { cx: 64, cy: 138, scale: 0.30, rotateDeg: 0 };
    case 'weapon':
      // Held in the right hand, leaning OUT and back so it's
      // clearly to the side of the hero (not crossing the body).
      // Anchor at the right hand zone (~x=102, y=88). The icon
      // template extends well above + below its centre (sword
      // tips, staff orbs, bow ends), so the visible weapon
      // arcs above the shoulder + below the hip cleanly.
      return { cx: 102, cy: 90, scale: 0.46, rotateDeg: 22 };
    case 'trinket':
      // Small chest accessory / charm on a cord. Centre at
      // upper torso just below the neck.
      return { cx: 64, cy: 80, scale: 0.22, rotateDeg: 0 };
    default:
      return { cx: 64, cy: 80, scale: 0.4, rotateDeg: 0 };
  }
}

// ── Source SVG → re-projected SVG ───────────────────────────────
//
// Source files come from build-gear-glossy.mjs and are shaped:
//   <?xml ...>
//   <svg xmlns="..." viewBox="0 0 192 192" width="192" height="192" ...>
//     <title>...</title>  <desc>...</desc>
//     <defs>...</defs>
//     <!-- glow ellipse -->
//     <!-- contact shadow ellipse -->
//     <!-- rarity ring circle (rare+ only) -->
//     <!-- per-shape elements -->
//   </svg>
//
// We extract everything inside <svg>...</svg>, strip the three
// icon-context elements, then wrap the rest in a <g transform>
// inside a new 128×160 svg.

function extractInnerSvg(svgText) {
  // Remove the XML decl + outer <svg ...> open tag + closing </svg>.
  const open = svgText.indexOf('<svg');
  const openClose = svgText.indexOf('>', open);
  const close = svgText.lastIndexOf('</svg>');
  if (open < 0 || openClose < 0 || close < 0) {
    throw new Error('malformed source SVG');
  }
  return svgText.slice(openClose + 1, close);
}

function stripIconContextElements(inner) {
  let out = inner;
  // Rarity glow: <ellipse ... fill="url(#gk-rarity-…)"/>
  out = out.replace(
    /<ellipse[^/>]*fill="url\(#gk-rarity-[^)]+\)"[^/>]*\/>/g, ''
  );
  // Contact shadow: <ellipse ... fill="url(#gk-contact-shadow)"/>
  out = out.replace(
    /<ellipse[^/>]*fill="url\(#gk-contact-shadow\)"[^/>]*\/>/g, ''
  );
  // Icon-scale rarity ring: <circle cx="96" cy="96" r="86" fill="none" ...
  // (these are the big rings on rare+ items, they'd show as
  // sweeping circles around the gear on the hero — strip them.)
  out = out.replace(
    /<circle\s+cx="96"\s+cy="96"\s+r="86"[^/>]*\/>/g, ''
  );
  return out;
}

function rebuildAsFigureLayer(srcSvg, slot) {
  const inner = stripIconContextElements(extractInnerSvg(srcSvg));
  const a = anchorFor(slot);
  const tx = a.cx - a.scale * 96;
  const ty = a.cy - a.scale * 96;
  const transform = a.rotateDeg
    ? `translate(${tx} ${ty}) scale(${a.scale}) rotate(${a.rotateDeg} 96 96)`
    : `translate(${tx} ${ty}) scale(${a.scale})`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${FIGURE_W} ${FIGURE_H}"
     width="${FIGURE_W}" height="${FIGURE_H}" shape-rendering="geometricPrecision">
  <g transform="${transform}">
    ${inner}
  </g>
</svg>
`;
}

// ── Bake driver ─────────────────────────────────────────────────

let total = 0;
const perSlot = {};

for (const slot of SLOTS) {
  perSlot[slot] = 0;
  const srcDir = join(GEAR_GLOSSY, slot);
  let files;
  try { files = readdirSync(srcDir).filter(f => f.endsWith('.svg')); }
  catch { console.warn(`(no src dir for slot ${slot})`); continue; }
  for (const file of files) {
    const src = readFileSync(join(srcDir, file), 'utf8');
    const figureSvg = rebuildAsFigureLayer(src, slot);
    const outPath = join(OUT_BASE, slot, file.replace(/\.svg$/, '.png'));
    await bakeFile(figureSvg, outPath, { width: FIGURE_W, height: FIGURE_H });
    perSlot[slot]++;
    total++;
  }
  console.log(`  ${slot}: ${perSlot[slot]} layers`);
}

console.log(`\n✓ baked ${total} gear paper-doll figure layers at ${FIGURE_W}×${FIGURE_H} → ${OUT_BASE}`);
