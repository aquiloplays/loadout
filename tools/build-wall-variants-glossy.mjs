// K2-16 glossy wall connectivity variants.
//
// A wall tile is rendered by mask4 = bit0(north) | bit1(east) |
// bit2(south) | bit3(west) indicating which of the 4 cardinal
// neighbours are also wall tiles. The 16 combinations cover
// every possible junction:
//
//   0000  free-standing pillar
//   0001  west cap                  0010  south cap
//   0011  SW corner                 0100  east cap
//   0101  EW horizontal             0110  SE corner
//   0111  T-junction-S              1000  north cap
//   1001  NW corner                 1010  NS vertical
//   1011  T-junction-W              1100  NE corner
//   1101  T-junction-N              1110  T-junction-E
//   1111  4-way cross
//
// All 16 share the same crenellated top + mortar + corner rivets;
// what changes is whether each cardinal edge "extends out" past
// the tile (neighbour present) or "closes off" with an end-cap
// merlon (no neighbour).
//
// Output: aquilo-gg/sprites/clash-v2/glossy/buildings/wall-L1-NN.svg
//         (NN = decimal 00..15 to match v1 bitmask filename convention)
//
// Run: node tools/build-wall-variants-glossy.mjs

import { mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { PALETTE, contactShadow, svgWrapper } from './glossy-art-kit.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT  = join(ROOT, 'aquilo-gg/sprites/clash-v2/glossy/buildings');
mkdirSync(OUT, { recursive: true });

const W = 256, H = 256;
const GROUND_Y = 224;
const SHADOW = contactShadow({ cx: W/2, cy: GROUND_Y + 8, rx: 92, ry: 14 });

// ── Geometry ──────────────────────────────────────────────────
//
// We render the tile as a stone "+", a central core, plus up to
// four cardinal arms that extend to the tile edge when a
// neighbour is present in that direction. End-caps (no neighbour)
// get a merlon-style closure so the wall reads as ending.

const CX = W/2, CY = 150;       // wall body center
const CORE = 64;                // central core size (full square)
const HALF = CORE / 2;
const ARM_W = 64;               // arm width
const ARM_HALF = ARM_W / 2;
const ARM_LEN = (W - CORE) / 2; // distance from core edge to tile edge
const TOP    = CY - HALF;
const BOTTOM = CY + HALF;
const LEFT   = CX - HALF;
const RIGHT  = CX + HALF;

// ── Shape builders ────────────────────────────────────────────

// Arm extension (rectangle from core edge to tile edge in given dir).
function arm(dir) {
  switch (dir) {
    case 'N': return `<rect x="${CX - ARM_HALF}" y="${TOP - ARM_LEN}" width="${ARM_W}" height="${ARM_LEN}" rx="3"
                            fill="url(#gk-grad-stone)" stroke="${PALETTE.stone.stroke}" stroke-width="3"/>`;
    case 'S': return `<rect x="${CX - ARM_HALF}" y="${BOTTOM}" width="${ARM_W}" height="${ARM_LEN}" rx="3"
                            fill="url(#gk-grad-stone)" stroke="${PALETTE.stone.stroke}" stroke-width="3"/>`;
    case 'E': return `<rect x="${RIGHT}" y="${CY - ARM_HALF}" width="${ARM_LEN}" height="${ARM_W}" rx="3"
                            fill="url(#gk-grad-stone)" stroke="${PALETTE.stone.stroke}" stroke-width="3"/>`;
    case 'W': return `<rect x="${LEFT - ARM_LEN}" y="${CY - ARM_HALF}" width="${ARM_LEN}" height="${ARM_W}" rx="3"
                            fill="url(#gk-grad-stone)" stroke="${PALETTE.stone.stroke}" stroke-width="3"/>`;
  }
}

// End cap (merlon-topped closure on an edge where there's NO
// neighbour, so the wall visibly ends instead of trailing off).
function endCap(dir) {
  const merlonW = 10, merlonH = 8;
  switch (dir) {
    case 'N': {
      // Top edge merlons sitting above the core's top edge
      return `
<g fill="url(#gk-grad-stone)" stroke="${PALETTE.stone.stroke}" stroke-width="2.5" stroke-linejoin="round">
  <rect x="${LEFT + 6}"      y="${TOP - merlonH}" width="${merlonW}" height="${merlonH}" rx="1.5"/>
  <rect x="${LEFT + 22}"     y="${TOP - merlonH}" width="${merlonW}" height="${merlonH}" rx="1.5"/>
  <rect x="${LEFT + 38}"     y="${TOP - merlonH}" width="${merlonW}" height="${merlonH}" rx="1.5"/>
  <rect x="${LEFT + 48}"     y="${TOP - merlonH}" width="${merlonW}" height="${merlonH}" rx="1.5"/>
</g>`;
    }
    case 'S': {
      // Bottom edge, a base trim accent (gold rivet band so the
      // wall ends with a finished look, not just cut off).
      return `<rect x="${LEFT + 4}" y="${BOTTOM - 6}" width="${CORE - 8}" height="8" rx="2"
                    fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="2"/>`;
    }
    case 'E': {
      return `
<g fill="url(#gk-grad-stone)" stroke="${PALETTE.stone.stroke}" stroke-width="2.5" stroke-linejoin="round">
  <rect x="${RIGHT}" y="${CY - ARM_HALF + 6}"  width="${merlonH}" height="${merlonW}" rx="1.5"/>
  <rect x="${RIGHT}" y="${CY - ARM_HALF + 22}" width="${merlonH}" height="${merlonW}" rx="1.5"/>
  <rect x="${RIGHT}" y="${CY - ARM_HALF + 38}" width="${merlonH}" height="${merlonW}" rx="1.5"/>
  <rect x="${RIGHT}" y="${CY - ARM_HALF + 48}" width="${merlonH}" height="${merlonW}" rx="1.5"/>
</g>`;
    }
    case 'W': {
      return `
<g fill="url(#gk-grad-stone)" stroke="${PALETTE.stone.stroke}" stroke-width="2.5" stroke-linejoin="round">
  <rect x="${LEFT - merlonH}" y="${CY - ARM_HALF + 6}"  width="${merlonH}" height="${merlonW}" rx="1.5"/>
  <rect x="${LEFT - merlonH}" y="${CY - ARM_HALF + 22}" width="${merlonH}" height="${merlonW}" rx="1.5"/>
  <rect x="${LEFT - merlonH}" y="${CY - ARM_HALF + 38}" width="${merlonH}" height="${merlonW}" rx="1.5"/>
  <rect x="${LEFT - merlonH}" y="${CY - ARM_HALF + 48}" width="${merlonH}" height="${merlonW}" rx="1.5"/>
</g>`;
    }
  }
}

// Core block, always present, with mortar courses + gloss highlight.
function core() {
  return `
<rect x="${LEFT}" y="${TOP}" width="${CORE}" height="${CORE}" rx="6"
      fill="url(#gk-grad-stone)" stroke="${PALETTE.stone.stroke}" stroke-width="3.5"/>
<!-- mortar courses (subtle) -->
<g stroke="${PALETTE.stone.stroke}" stroke-width="1.5" opacity="0.55">
  <line x1="${LEFT + 4}" y1="${CY - 16}" x2="${RIGHT - 4}" y2="${CY - 16}"/>
  <line x1="${LEFT + 4}" y1="${CY + 16}" x2="${RIGHT - 4}" y2="${CY + 16}"/>
  <line x1="${CX - 16}"  y1="${TOP + 4}"  x2="${CX - 16}" y2="${CY - 16}"/>
  <line x1="${CX + 16}"  y1="${CY - 16}"  x2="${CX + 16}" y2="${CY + 16}"/>
  <line x1="${CX}"       y1="${CY + 16}"  x2="${CX}"      y2="${BOTTOM - 4}"/>
</g>
<!-- centre gloss -->
<path d="M ${LEFT + 6} ${TOP + 8} Q ${LEFT + 6} ${TOP + 4} ${LEFT + 10} ${TOP + 4}
         L ${RIGHT - 10} ${TOP + 4} Q ${RIGHT - 6} ${TOP + 4} ${RIGHT - 6} ${TOP + 8}
         L ${RIGHT - 6} ${CY - 12} Q ${CX} ${TOP + 24} ${LEFT + 6} ${CY - 12} Z"
      fill="url(#gk-gloss)" opacity="0.55" pointer-events="none"/>
<!-- gold rivets at corners -->
<g fill="url(#gk-rgrad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1.5">
  <circle cx="${LEFT + 10}"  cy="${TOP + 10}"     r="3.5"/>
  <circle cx="${RIGHT - 10}" cy="${TOP + 10}"     r="3.5"/>
  <circle cx="${LEFT + 10}"  cy="${BOTTOM - 10}"  r="3.5"/>
  <circle cx="${RIGHT - 10}" cy="${BOTTOM - 10}"  r="3.5"/>
</g>`;
}

// Build one variant from the 4-bit mask: bit0=N, bit1=E, bit2=S, bit3=W.
function variant(mask) {
  const n = !!(mask & 0b1000);
  const e = !!(mask & 0b0100);
  const s = !!(mask & 0b0010);
  const w = !!(mask & 0b0001);
  // Render order: shadow → arms (back) → core → end-caps (front).
  const arms   = [n && arm('N'), e && arm('E'), s && arm('S'), w && arm('W')].filter(Boolean).join('\n');
  const caps   = [!n && endCap('N'), !e && endCap('E'), !s && endCap('S'), !w && endCap('W')].filter(Boolean).join('\n');
  return `
${SHADOW}
${arms}
${core()}
${caps}
`;
}

// ── Bake driver ───────────────────────────────────────────────

// Note: writes raw SVG (matches the rest of the glossy library
// which is SVG-served). The on-disk filename uses the existing
// 2-digit decimal bitmask convention so spriteIdForBuildingV2's
// mask formatting matches without modification.

import { writeFileSync } from 'fs';

let written = 0;
for (let m = 0; m < 16; m++) {
  const body = variant(m);
  const svg = svgWrapper({
    width: W, height: H,
    body,
    title: `wall-L1-${String(m).padStart(2, '0')} (glossy, mask=${m.toString(2).padStart(4, '0')})`,
    desc: 'Loadout Clash wall connectivity variant. bit0=N bit1=E bit2=S bit3=W. Source: tools/build-wall-variants-glossy.mjs.',
  });
  const out = join(OUT, `wall-L1-${String(m).padStart(2, '0')}.svg`);
  writeFileSync(out, svg);
  written++;
  console.log(`  wall-L1-${String(m).padStart(2, '0')}.svg (${m.toString(2).padStart(4, '0')})`);
}
console.log(`\n✓ rendered ${written} glossy wall variants`);
