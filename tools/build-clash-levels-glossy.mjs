// K3, Per-level building progression overlays.
//
// Rather than hand-author 32 building kinds × 10 levels = 320
// shapes from scratch, we read each existing L1 glossy SVG and
// composite a level-specific accent overlay on top. Each level
// adds visible "this building has been upgraded" cues, banners,
// gold trim, crowns, gems, sparkle particles, so a viewer can
// tell at a glance what level a building is.
//
// Progression scheme (cumulative, L10 has everything L2..L9
// stacked):
//   L1   baseline (no overlay)
//   L2   small pennant on top
//   L3   gold trim band across mid-height
//   L4   taller "growth" plate behind (slight height boost behind core)
//   L5   gold rivet studs around perimeter corners
//   L6   second pennant on opposite side + brand emblem badge
//   L7   soft rarity glow halo behind the building (epic tint)
//   L8   gem mount up top with a ruby
//   L9   side accent banners hanging off both sides
//   L10  full gold rim outline + sparkle particle burst (legendary look)
//
// Output: aquilo-gg/sprites/clash-v2/glossy/buildings/<kind>-L<n>.svg
//         for n in 2..10. L1 stays as-is.
//
// Wall variants (wall-L1-NN.svg) are intentionally SKIPPED, those
// are connectivity tiles, not single-building art. Per-level wall
// variants is a separate (deferred) wave that would multiply by 16.
//
// Run: node tools/build-clash-levels-glossy.mjs

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { PALETTE } from './glossy-art-kit.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DIR  = join(ROOT, 'aquilo-gg/sprites/clash-v2/glossy/buildings');
mkdirSync(DIR, { recursive: true });

const W = 256, H = 256;

// ── Anchor reference (matches build-clash-glossy.mjs) ────────
//
// All buildings are anchored bottom-centre to GROUND_Y=224.
// Their visible silhouette typically spans y=60..224 and x=40..216.
// Overlay accents go BELOW (front-of) the building? No, they
// composite ON TOP so they appear in front of the building when
// they overlap. We tune positions to sit just outside the core
// silhouette so they don't clip building art.

const GROUND_Y = 224;
const TOP_Y    = 56;     // peak of decoration zone (above building tops)
const SIDE_X_L = 24;     // left-side accent x
const SIDE_X_R = 232;    // right-side accent x

// ── Per-level overlay builders ───────────────────────────────

function pennantLeft() {
  return `
<!-- L2: left pennant -->
<g>
  <rect x="${W/2 - 38}" y="${TOP_Y - 26}" width="4" height="36" rx="1.5"
        fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="1.5"/>
  <path d="M ${W/2 - 34} ${TOP_Y - 22}
           L ${W/2 - 14} ${TOP_Y - 18}
           L ${W/2 - 34} ${TOP_Y - 14} Z"
        fill="url(#gk-grad-ruby)" stroke="${PALETTE.ruby.stroke}" stroke-width="2" stroke-linejoin="round"/>
</g>`;
}

function goldTrimBand() {
  // Mid-band gold trim accent across width
  return `
<!-- L3: gold trim band -->
<rect x="44" y="138" width="168" height="6" rx="2"
      fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1.5" opacity="0.95"/>
<rect x="44" y="138" width="168" height="2" fill="${PALETTE.white}" opacity="0.55"/>`;
}

function growthPlate() {
  // Subtle "the building is bigger now" silhouette behind the L1 art
  return `
<!-- L4: growth plate behind core -->
<rect x="32" y="92" width="192" height="124" rx="14"
      fill="${PALETTE.stone.lo}" opacity="0.35"/>`;
}

function cornerRivets() {
  // 4 gold rivets at building footprint corners
  return `
<!-- L5: corner rivets -->
<g fill="url(#gk-rgrad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1.5">
  <circle cx="48"  cy="200" r="4"/>
  <circle cx="208" cy="200" r="4"/>
  <circle cx="48"  cy="100" r="3.5"/>
  <circle cx="208" cy="100" r="3.5"/>
</g>`;
}

function pennantRightAndEmblem() {
  // Mirror pennant on right + small brand emblem
  return `
<!-- L6: right pennant + emblem -->
<g>
  <rect x="${W/2 + 34}" y="${TOP_Y - 26}" width="4" height="36" rx="1.5"
        fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="1.5"/>
  <path d="M ${W/2 + 38} ${TOP_Y - 22}
           L ${W/2 + 58} ${TOP_Y - 18}
           L ${W/2 + 38} ${TOP_Y - 14} Z"
        fill="url(#gk-grad-sapphire)" stroke="${PALETTE.sapphire.stroke}" stroke-width="2" stroke-linejoin="round"/>
</g>
<!-- L6: brand emblem badge (chest-medallion style) -->
<circle cx="${W/2}" cy="${TOP_Y + 10}" r="9"
        fill="url(#gk-rgrad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="2"/>
<!-- mini bolt motif inside emblem -->
<path d="M ${W/2 + 2} ${TOP_Y + 4}
         L ${W/2 - 4} ${TOP_Y + 10}
         L ${W/2 - 1} ${TOP_Y + 10}
         L ${W/2 - 2} ${TOP_Y + 16}
         L ${W/2 + 4} ${TOP_Y + 10}
         L ${W/2 + 1} ${TOP_Y + 10} Z"
      fill="${PALETTE.gold.stroke}" opacity="0.85"/>`;
}

function rarityGlow() {
  // Soft epic-tint halo behind the building
  return `
<!-- L7: rarity glow halo -->
<defs>
  <radialGradient id="lvl-glow" cx="0.5" cy="0.55" r="0.55">
    <stop offset="0"   stop-color="${PALETTE.amethyst.hi}" stop-opacity="0.65"/>
    <stop offset="0.6" stop-color="${PALETTE.amethyst.hi}" stop-opacity="0.25"/>
    <stop offset="1"   stop-color="${PALETTE.amethyst.hi}" stop-opacity="0"/>
  </radialGradient>
</defs>
<ellipse cx="${W/2}" cy="${H/2 + 8}" rx="118" ry="100" fill="url(#lvl-glow)"/>`;
}

function gemMount() {
  // Ornate gem set on the very top of the building
  return `
<!-- L8: gem mount -->
<g>
  <path d="M ${W/2 - 12} ${TOP_Y - 38}
           L ${W/2} ${TOP_Y - 54}
           L ${W/2 + 12} ${TOP_Y - 38}
           L ${W/2 + 6} ${TOP_Y - 30}
           L ${W/2 - 6} ${TOP_Y - 30} Z"
        fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
  <circle cx="${W/2}" cy="${TOP_Y - 38}" r="8"
          fill="url(#gk-rgrad-ruby)" stroke="${PALETTE.ruby.stroke}" stroke-width="2"/>
  <ellipse cx="${W/2 - 3}" cy="${TOP_Y - 40}" rx="3" ry="1.6" fill="${PALETTE.white}" opacity="0.85"/>
</g>`;
}

function sideBanners() {
  // Banner cloths draping from both sides
  return `
<!-- L9: side banners -->
<g>
  <!-- left -->
  <path d="M ${SIDE_X_L + 4} ${TOP_Y + 20}
           L ${SIDE_X_L + 22} ${TOP_Y + 20}
           L ${SIDE_X_L + 22} ${TOP_Y + 88}
           L ${SIDE_X_L + 14} ${TOP_Y + 96}
           L ${SIDE_X_L + 4}  ${TOP_Y + 88} Z"
        fill="url(#gk-grad-ruby)" stroke="${PALETTE.ruby.stroke}" stroke-width="2" stroke-linejoin="round"/>
  <rect x="${SIDE_X_L + 4}" y="${TOP_Y + 20}" width="18" height="4"
        fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1"/>
  <!-- right -->
  <path d="M ${SIDE_X_R - 22} ${TOP_Y + 20}
           L ${SIDE_X_R - 4}  ${TOP_Y + 20}
           L ${SIDE_X_R - 4}  ${TOP_Y + 88}
           L ${SIDE_X_R - 12} ${TOP_Y + 96}
           L ${SIDE_X_R - 22} ${TOP_Y + 88} Z"
        fill="url(#gk-grad-sapphire)" stroke="${PALETTE.sapphire.stroke}" stroke-width="2" stroke-linejoin="round"/>
  <rect x="${SIDE_X_R - 22}" y="${TOP_Y + 20}" width="18" height="4"
        fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1"/>
</g>`;
}

function legendaryTrimAndSparkles() {
  // Gold sparkle particles + outer glow ring, legendary upgrade
  function spark(cx, cy, size) {
    return `<path d="M ${cx} ${cy - size}
                     L ${cx + size * 0.3} ${cy - size * 0.3}
                     L ${cx + size} ${cy}
                     L ${cx + size * 0.3} ${cy + size * 0.3}
                     L ${cx} ${cy + size}
                     L ${cx - size * 0.3} ${cy + size * 0.3}
                     L ${cx - size} ${cy}
                     L ${cx - size * 0.3} ${cy - size * 0.3} Z"
                  fill="${PALETTE.gold.hi}" opacity="0.95"/>`;
  }
  return `
<!-- L10: legendary trim + sparkles -->
<defs>
  <radialGradient id="lvl-legendary" cx="0.5" cy="0.55" r="0.6">
    <stop offset="0"   stop-color="${PALETTE.gold.hi}" stop-opacity="0.55"/>
    <stop offset="0.55" stop-color="${PALETTE.gold.hi}" stop-opacity="0.25"/>
    <stop offset="1"   stop-color="${PALETTE.gold.hi}" stop-opacity="0"/>
  </radialGradient>
</defs>
<ellipse cx="${W/2}" cy="${H/2 + 8}" rx="124" ry="110" fill="url(#lvl-legendary)"/>
${spark(40, 80, 8)}
${spark(216, 80, 8)}
${spark(W/2, 30, 9)}
${spark(48, 200, 7)}
${spark(208, 200, 7)}
${spark(110, 50, 5)}
${spark(146, 50, 5)}`;
}

// Cumulative overlay stack, each level INCLUDES everything below it.
// (Higher level = visibly more decorated, telegraphs progression.)
const LEVEL_OVERLAYS = {
  2:  [pennantLeft],
  3:  [pennantLeft, goldTrimBand],
  4:  [growthPlate, pennantLeft, goldTrimBand],
  5:  [growthPlate, pennantLeft, goldTrimBand, cornerRivets],
  6:  [growthPlate, pennantLeft, goldTrimBand, cornerRivets, pennantRightAndEmblem],
  7:  [rarityGlow, growthPlate, pennantLeft, goldTrimBand, cornerRivets, pennantRightAndEmblem],
  8:  [rarityGlow, growthPlate, pennantLeft, goldTrimBand, cornerRivets, pennantRightAndEmblem, gemMount],
  9:  [rarityGlow, growthPlate, sideBanners, pennantLeft, goldTrimBand, cornerRivets, pennantRightAndEmblem, gemMount],
  10: [legendaryTrimAndSparkles, growthPlate, sideBanners, pennantLeft, goldTrimBand, cornerRivets, pennantRightAndEmblem, gemMount],
};

// rarityGlow defines its own <defs> per render, so when the same
// overlay function fires twice (impossible here, cumulative
// includes each once) the second would clash. The cumulative
// arrays only include each helper once so this is fine.

// ── Source SVG manipulation ──────────────────────────────────
//
// Read the existing L1 SVG, split into:
//   header  (xml decl + opening <svg ...>)
//   inner   (all child content between opening + closing svg)
//   footer  (</svg> + trailing newline)
// Then build the new svg as: header + inner + overlay + footer.
//
// The growth-plate overlay needs to render BEHIND the building,
// not on top, so we split inner: keep <defs>, then prepend
// growth-plate + rarity-glow, then re-append the rest. Front
// overlays append normally.

const FRONT_OVERLAYS = new Set([
  pennantLeft, pennantRightAndEmblem, goldTrimBand, cornerRivets,
  gemMount, sideBanners, legendaryTrimAndSparkles,
]);
const BACK_OVERLAYS = new Set([growthPlate, rarityGlow]);

function reassemble(srcText, overlayFns) {
  const openIdx = srcText.indexOf('<svg');
  const openTagEnd = srcText.indexOf('>', openIdx);
  const closeIdx = srcText.lastIndexOf('</svg>');
  const header = srcText.slice(0, openTagEnd + 1);
  const inner  = srcText.slice(openTagEnd + 1, closeIdx);
  const footer = '</svg>\n';

  // Split inner at the end of <defs>...</defs> so we can inject
  // background overlays BEFORE the building art (z-order: behind).
  const defsEnd = inner.indexOf('</defs>');
  let preBuilding, building;
  if (defsEnd >= 0) {
    const defsClose = defsEnd + '</defs>'.length;
    preBuilding = inner.slice(0, defsClose);
    building    = inner.slice(defsClose);
  } else {
    preBuilding = '';
    building    = inner;
  }

  const backOverlays  = overlayFns.filter(fn => BACK_OVERLAYS.has(fn)).map(fn => fn()).join('\n');
  const frontOverlays = overlayFns.filter(fn => FRONT_OVERLAYS.has(fn)).map(fn => fn()).join('\n');

  return `${header}\n${preBuilding}\n<!-- L_n back overlays -->\n${backOverlays}\n<!-- L1 building art -->\n${building}\n<!-- L_n front overlays -->\n${frontOverlays}\n${footer}`;
}

// ── Bake driver ──────────────────────────────────────────────

const files = readdirSync(DIR).filter(f => /-L1\.svg$/.test(f) && !/^wall-L1-\d\d\.svg$/.test(f));
console.log(`Found ${files.length} L1 source SVGs (excluding wall connectivity variants)`);

let written = 0;
for (const file of files) {
  const kind = file.replace(/-L1\.svg$/, '');
  const src = readFileSync(join(DIR, file), 'utf8');
  for (let lvl = 2; lvl <= 10; lvl++) {
    const overlay = LEVEL_OVERLAYS[lvl];
    const newSvg = reassemble(src, overlay);
    writeFileSync(join(DIR, `${kind}-L${lvl}.svg`), newSvg);
    written++;
  }
}
console.log(`\n✓ wrote ${written} per-level SVGs (${files.length} kinds × 9 levels)`);
