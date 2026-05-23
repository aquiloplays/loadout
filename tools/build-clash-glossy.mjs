// Glossy Clash buildings — Wave 1 source-art generator.
//
// Renders the core 8 buildings (townhall, wall, cannon, archerTower,
// storage, barracks, buildersHut, warTent) at L1 in the glossy
// post-pixel house style. Output: SVG sources at
// aquilo-gg/sprites/clash-v2/glossy/buildings/<kind>-L1.svg.
//
// Per-kind body modules build their SVG with the shared kit's
// primitives so the lighting, outline, gloss, and shadow stay
// consistent across the catalogue. Successive levels are deferred
// to Wave 2 (a level-progression layer mostly recolors banners +
// adds detail layers — cheap once the L1 baseline lands).
//
// Run:
//   node tools/build-clash-glossy.mjs

import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  PALETTE,
  contactShadow,
  glossyRoundedRect,
  glossyEllipse,
  glossyBanner,
  flagpole,
  archedWindow,
  door,
  inkedStroke,
  accentRing,
  svgWrapper,
} from './glossy-art-kit.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_DIR = join(ROOT, 'aquilo-gg/sprites/clash-v2/glossy/buildings');
mkdirSync(OUT_DIR, { recursive: true });

const W = 256, H = 256;
// Reference baseline — everything anchors to the ground line so
// buildings sit on the contact-shadow ellipse consistently.
const GROUND_Y = 224;
const SHADOW = contactShadow({ cx: W/2, cy: GROUND_Y + 8, rx: 92, ry: 14 });

// ── townhall ─────────────────────────────────────────────────────
// Stone castle keep, gold accents, banner, large door.
function townhall() {
  const x = 40, y = 80, w = 176, h = GROUND_Y - y;
  return `
${SHADOW}
${glossyRoundedRect({ x, y: y + 8, w, h: h - 8, r: 12, gradient: 'gk-rgrad-stone', outline: PALETTE.stone.stroke, outlineWidth: 4 })}
<!-- crenellations -->
<g fill="url(#gk-rgrad-stone)" stroke="${PALETTE.stone.stroke}" stroke-width="3" stroke-linejoin="round">
  <rect x="${x}"        y="${y - 8}" width="22" height="22" rx="2"/>
  <rect x="${x + 32}"   y="${y - 8}" width="22" height="22" rx="2"/>
  <rect x="${x + 64}"   y="${y - 8}" width="22" height="22" rx="2"/>
  <rect x="${x + 96}"   y="${y - 8}" width="22" height="22" rx="2"/>
  <rect x="${x + 128}"  y="${y - 8}" width="22" height="22" rx="2"/>
  <rect x="${x + 154}"  y="${y - 8}" width="22" height="22" rx="2"/>
</g>
<!-- mortar courses (depth detail) -->
<g stroke="${PALETTE.stone.stroke}" stroke-width="1.5" opacity="0.55">
  <line x1="${x + 4}" y1="${y + 50}" x2="${x + w - 4}" y2="${y + 50}"/>
  <line x1="${x + 4}" y1="${y + 90}" x2="${x + w - 4}" y2="${y + 90}"/>
  <line x1="${x + 28}" y1="${y + 18}" x2="${x + 28}" y2="${y + 50}"/>
  <line x1="${x + 84}" y1="${y + 18}" x2="${x + 84}" y2="${y + 50}"/>
  <line x1="${x + 132}" y1="${y + 18}" x2="${x + 132}" y2="${y + 50}"/>
</g>
<!-- door -->
${door({ cx: W/2, yBottom: GROUND_Y - 4, w: 44, h: 56 })}
<!-- gold band above door (rich accent) -->
<rect x="${W/2 - 30}" y="${GROUND_Y - 68}" width="60" height="10" rx="3"
      fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="2"/>
<!-- side arched windows -->
${archedWindow({ cx: x + 36,  cy: y + 70, w: 18, h: 28 })}
${archedWindow({ cx: x + 140, cy: y + 70, w: 18, h: 28 })}
<!-- flagpole + banner -->
${flagpole({ x: W/2, yTop: y - 64, yBottom: y - 4, width: 4 })}
${glossyBanner({ x: W/2 + 2, y: y - 60, w: 40, h: 22, gradient: 'gk-grad-ruby' })}
`;
}

// ── wall ─────────────────────────────────────────────────────────
// Stone wall block — crenellated top, mortar courses, gold rivets.
function wall() {
  const x = 56, y = 110, w = 144, h = GROUND_Y - y;
  return `
${SHADOW}
${glossyRoundedRect({ x, y, w, h, r: 8, gradient: 'gk-grad-stone', outline: PALETTE.stone.stroke, outlineWidth: 4 })}
<!-- merlons -->
<g fill="url(#gk-rgrad-stone)" stroke="${PALETTE.stone.stroke}" stroke-width="3" stroke-linejoin="round">
  <rect x="${x}"        y="${y - 14}" width="26" height="18" rx="2"/>
  <rect x="${x + 38}"   y="${y - 14}" width="28" height="18" rx="2"/>
  <rect x="${x + 80}"   y="${y - 14}" width="28" height="18" rx="2"/>
  <rect x="${x + 120}"  y="${y - 14}" width="24" height="18" rx="2"/>
</g>
<!-- gold rivets at corners -->
<circle cx="${x + 10}" cy="${y + h - 12}" r="4" fill="url(#gk-rgrad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1.5"/>
<circle cx="${x + w - 10}" cy="${y + h - 12}" r="4" fill="url(#gk-rgrad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1.5"/>
<!-- mortar -->
<g stroke="${PALETTE.stone.stroke}" stroke-width="1.5" opacity="0.6">
  <line x1="${x + 6}" y1="${y + 38}" x2="${x + w - 6}" y2="${y + 38}"/>
  <line x1="${x + 6}" y1="${y + 70}" x2="${x + w - 6}" y2="${y + 70}"/>
  <line x1="${x + 50}" y1="${y + 6}" x2="${x + 50}" y2="${y + 38}"/>
  <line x1="${x + 100}" y1="${y + 38}" x2="${x + 100}" y2="${y + 70}"/>
</g>
`;
}

// ── cannon ───────────────────────────────────────────────────────
// Dark steel barrel on a wooden rotating base, gold rim.
function cannon() {
  return `
${SHADOW}
<!-- wooden base (cylinder) -->
${glossyEllipse({ cx: W/2, cy: GROUND_Y - 24, rx: 70, ry: 22, gradient: 'gk-rgrad-wood', outline: PALETTE.wood.stroke, outlineWidth: 4 })}
<rect x="${W/2 - 70}" y="${GROUND_Y - 24}" width="140" height="22" fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="4"/>
${glossyEllipse({ cx: W/2, cy: GROUND_Y - 2, rx: 70, ry: 16, gradient: 'gk-rgrad-wood', outline: PALETTE.wood.stroke, outlineWidth: 4 })}
<!-- gold rim band -->
<rect x="${W/2 - 70}" y="${GROUND_Y - 28}" width="140" height="8" rx="2"
      fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="2"/>
<!-- barrel (long capsule, tilted slightly skyward) -->
<g transform="rotate(-22 ${W/2} ${GROUND_Y - 40})">
  <rect x="${W/2 - 16}" y="${GROUND_Y - 154}" width="32" height="116" rx="14"
        fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="4"/>
  <!-- muzzle ring -->
  <rect x="${W/2 - 22}" y="${GROUND_Y - 158}" width="44" height="14" rx="4"
        fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="3"/>
  <!-- gloss highlight on barrel -->
  <rect x="${W/2 - 12}" y="${GROUND_Y - 150}" width="8" height="100" rx="4"
        fill="url(#gk-gloss)" opacity="0.65"/>
  <!-- mid gold band -->
  <rect x="${W/2 - 18}" y="${GROUND_Y - 96}" width="36" height="8" rx="2"
        fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1.5"/>
</g>
<!-- side pivot bolts -->
<circle cx="${W/2 - 28}" cy="${GROUND_Y - 38}" r="6" fill="url(#gk-rgrad-iron)" stroke="${PALETTE.ink}" stroke-width="2"/>
<circle cx="${W/2 + 28}" cy="${GROUND_Y - 38}" r="6" fill="url(#gk-rgrad-iron)" stroke="${PALETTE.ink}" stroke-width="2"/>
`;
}

// ── archerTower ──────────────────────────────────────────────────
// Tall stone tower, conical wood roof, arrow slits, gold tip.
function archerTower() {
  const x = 84, w = 88, y = 64;
  const towerBottom = GROUND_Y - 6;
  return `
${SHADOW}
<!-- stone tower -->
${glossyRoundedRect({ x, y: y + 38, w, h: towerBottom - (y + 38), r: 10, gradient: 'gk-rgrad-stone', outline: PALETTE.stone.stroke, outlineWidth: 4 })}
<!-- ring of corbels (top platform overhang) -->
<rect x="${x - 8}" y="${y + 30}" width="${w + 16}" height="14" rx="3"
      fill="url(#gk-grad-stone)" stroke="${PALETTE.stone.stroke}" stroke-width="3"/>
<!-- merlons on the platform -->
<g fill="url(#gk-grad-stone)" stroke="${PALETTE.stone.stroke}" stroke-width="3" stroke-linejoin="round">
  <rect x="${x - 8}"      y="${y + 18}" width="16" height="14" rx="1"/>
  <rect x="${x + 14}"     y="${y + 18}" width="16" height="14" rx="1"/>
  <rect x="${x + 36}"     y="${y + 18}" width="16" height="14" rx="1"/>
  <rect x="${x + 58}"     y="${y + 18}" width="16" height="14" rx="1"/>
  <rect x="${x + 80}"     y="${y + 18}" width="16" height="14" rx="1"/>
</g>
<!-- conical wooden roof -->
<path d="M ${x - 14} ${y + 22}
         L ${W/2} ${y - 48}
         L ${x + w + 14} ${y + 22} Z"
      fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="4" stroke-linejoin="round"/>
<!-- roof gloss -->
<path d="M ${x - 10} ${y + 20} L ${W/2 - 6} ${y - 42} L ${W/2 - 2} ${y + 22} Z"
      fill="url(#gk-gloss)" opacity="0.55"/>
<!-- gold finial -->
<circle cx="${W/2}" cy="${y - 52}" r="6" fill="url(#gk-rgrad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="2"/>
<path d="M ${W/2} ${y - 60} L ${W/2 - 3} ${y - 70} L ${W/2} ${y - 78} L ${W/2 + 3} ${y - 70} Z"
      fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="2" stroke-linejoin="round"/>
<!-- arrow slits -->
${arrowSlit(W/2 - 18, y + 58)}
${arrowSlit(W/2 + 6,  y + 58)}
${arrowSlit(W/2 - 6,  y + 110)}
<!-- door at base -->
${door({ cx: W/2, yBottom: towerBottom - 6, w: 30, h: 42 })}
`;
}

function arrowSlit(x, y) {
  return `<rect x="${x}" y="${y}" width="6" height="22" rx="2" fill="${PALETTE.ink}" stroke="${PALETTE.stone.stroke}" stroke-width="1.5"/>`;
}

// ── storage ──────────────────────────────────────────────────────
// Iron-banded wooden chest, gold lock + gem.
function storage() {
  const x = 36, y = 100, w = 184, h = GROUND_Y - y;
  const lidH = 56;
  return `
${SHADOW}
<!-- chest body -->
${glossyRoundedRect({ x, y: y + lidH, w, h: h - lidH, r: 12, gradient: 'gk-grad-wood', outline: PALETTE.wood.stroke, outlineWidth: 4 })}
<!-- lid -->
<path d="M ${x + 6} ${y + lidH}
         L ${x + 6} ${y + lidH - 10}
         Q ${x + 6} ${y - 6} ${x + 40} ${y - 6}
         L ${x + w - 40} ${y - 6}
         Q ${x + w - 6} ${y - 6} ${x + w - 6} ${y + lidH - 10}
         L ${x + w - 6} ${y + lidH} Z"
      fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="4" stroke-linejoin="round"/>
<!-- lid gloss -->
<path d="M ${x + 14} ${y + lidH - 6}
         Q ${x + 14} ${y} ${x + 40} ${y}
         L ${x + 90} ${y}
         Q ${x + 50} ${y + 18} ${x + 18} ${y + lidH - 6} Z"
      fill="url(#gk-gloss)" opacity="0.6"/>
<!-- iron bands (vertical) -->
<g fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="3" stroke-linejoin="round">
  <rect x="${x + 18}"  y="${y - 8}" width="20" height="${h + 6}" rx="2"/>
  <rect x="${x + w - 38}" y="${y - 8}" width="20" height="${h + 6}" rx="2"/>
</g>
<!-- iron horizontal seam (lid/body line) -->
<rect x="${x - 2}" y="${y + lidH - 4}" width="${w + 4}" height="8" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="2"/>
<!-- gold lock + gem -->
<rect x="${W/2 - 18}" y="${y + lidH - 16}" width="36" height="30" rx="4"
      fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="3"/>
<circle cx="${W/2}" cy="${y + lidH + 2}" r="7" fill="url(#gk-rgrad-ruby)" stroke="${PALETTE.ruby.stroke}" stroke-width="2"/>
<circle cx="${W/2 - 2}" cy="${y + lidH}" r="2.5" fill="#FFFFFF" opacity="0.85"/>
<!-- iron rivets on bands -->
<g fill="${PALETTE.gold.hi}" stroke="${PALETTE.ink}" stroke-width="1">
  <circle cx="${x + 28}" cy="${y - 2}"  r="3"/>
  <circle cx="${x + 28}" cy="${y + h - 8}" r="3"/>
  <circle cx="${x + w - 28}" cy="${y - 2}"  r="3"/>
  <circle cx="${x + w - 28}" cy="${y + h - 8}" r="3"/>
</g>
`;
}

// ── barracks ─────────────────────────────────────────────────────
// Pitched-roof tent/longhouse, red roof, banner.
function barracks() {
  const x = 36, w = 184;
  const wallTop = 130;
  const roofPeak = 64;
  return `
${SHADOW}
<!-- walls -->
${glossyRoundedRect({ x, y: wallTop, w, h: GROUND_Y - wallTop, r: 6, gradient: 'gk-grad-wood', outline: PALETTE.wood.stroke, outlineWidth: 4 })}
<!-- pitched roof -->
<path d="M ${x - 10} ${wallTop + 6}
         L ${W/2} ${roofPeak}
         L ${x + w + 10} ${wallTop + 6}
         L ${x + w} ${wallTop + 14}
         L ${x} ${wallTop + 14} Z"
      fill="url(#gk-grad-brick)" stroke="${PALETTE.brick.stroke}" stroke-width="4" stroke-linejoin="round"/>
<!-- roof gloss highlight -->
<path d="M ${x - 4} ${wallTop + 4}
         L ${W/2 - 8} ${roofPeak + 6}
         L ${W/2 - 4} ${wallTop + 12}
         L ${x + 4} ${wallTop + 12} Z"
      fill="url(#gk-gloss)" opacity="0.5"/>
<!-- shingle lines on roof -->
<g stroke="${PALETTE.brick.stroke}" stroke-width="1.5" opacity="0.55" fill="none">
  <path d="M ${x + 12} ${wallTop} L ${W/2 - 24} ${roofPeak + 26}"/>
  <path d="M ${x + 44} ${wallTop} L ${W/2 - 16} ${roofPeak + 14}"/>
  <path d="M ${x + w - 12} ${wallTop} L ${W/2 + 24} ${roofPeak + 26}"/>
  <path d="M ${x + w - 44} ${wallTop} L ${W/2 + 16} ${roofPeak + 14}"/>
</g>
<!-- door -->
${door({ cx: W/2, yBottom: GROUND_Y - 4, w: 38, h: 50 })}
<!-- side windows -->
${archedWindow({ cx: x + 36, cy: wallTop + 42, w: 16, h: 22 })}
${archedWindow({ cx: x + w - 36, cy: wallTop + 42, w: 16, h: 22 })}
<!-- flagpole + banner on peak -->
${flagpole({ x: W/2, yTop: roofPeak - 50, yBottom: roofPeak + 4, width: 4 })}
${glossyBanner({ x: W/2 + 2, y: roofPeak - 46, w: 32, h: 18, gradient: 'gk-grad-ruby' })}
`;
}

// ── buildersHut ──────────────────────────────────────────────────
// Small workshop with hammer-anvil icon plaque.
function buildersHut() {
  const x = 60, w = 136;
  const wallTop = 140;
  const roofPeak = 88;
  return `
${SHADOW}
${glossyRoundedRect({ x, y: wallTop, w, h: GROUND_Y - wallTop, r: 6, gradient: 'gk-grad-wood', outline: PALETTE.wood.stroke, outlineWidth: 4 })}
<!-- pitched roof -->
<path d="M ${x - 10} ${wallTop + 4}
         L ${W/2} ${roofPeak}
         L ${x + w + 10} ${wallTop + 4}
         L ${x + w} ${wallTop + 12}
         L ${x} ${wallTop + 12} Z"
      fill="url(#gk-grad-thatch)" stroke="${PALETTE.thatch.stroke}" stroke-width="4" stroke-linejoin="round"/>
<path d="M ${x - 4} ${wallTop + 4} L ${W/2 - 6} ${roofPeak + 4} L ${W/2 - 2} ${wallTop + 10} L ${x + 4} ${wallTop + 10} Z"
      fill="url(#gk-gloss)" opacity="0.5"/>
<!-- shingle/thatch lines -->
<g stroke="${PALETTE.thatch.stroke}" stroke-width="1.5" opacity="0.55" fill="none">
  <path d="M ${x + 18} ${wallTop - 2} L ${W/2 - 18} ${roofPeak + 22}"/>
  <path d="M ${x + w - 18} ${wallTop - 2} L ${W/2 + 18} ${roofPeak + 22}"/>
</g>
<!-- door (centred) -->
${door({ cx: W/2 - 24, yBottom: GROUND_Y - 4, w: 34, h: 44 })}
<!-- plaque with hammer + anvil -->
<rect x="${x + w - 56}" y="${wallTop + 26}" width="48" height="40" rx="4"
      fill="url(#gk-grad-cream)" stroke="${PALETTE.ink}" stroke-width="2.5"/>
<!-- anvil -->
<path d="M ${x + w - 50} ${wallTop + 56}
         L ${x + w - 50} ${wallTop + 48}
         L ${x + w - 40} ${wallTop + 48}
         L ${x + w - 40} ${wallTop + 42}
         L ${x + w - 18} ${wallTop + 42}
         L ${x + w - 18} ${wallTop + 48}
         L ${x + w - 8}  ${wallTop + 48}
         L ${x + w - 8}  ${wallTop + 56}
         Z"
      fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="2" stroke-linejoin="round"/>
<!-- hammer -->
<g transform="rotate(-25 ${x + w - 30} ${wallTop + 38})">
  <rect x="${x + w - 30}" y="${wallTop + 28}" width="6" height="22" rx="2"
        fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="1.5"/>
  <rect x="${x + w - 38}" y="${wallTop + 22}" width="22" height="10" rx="2"
        fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="2"/>
</g>
`;
}

// ── warTent ──────────────────────────────────────────────────────
// Command tent — striped canvas, banner, sword crossed at door.
function warTent() {
  const x = 36, w = 184;
  const tentBase = GROUND_Y - 6;
  const tentPeak = 78;
  return `
${SHADOW}
<!-- tent body — wide trapezoid -->
<path d="M ${x + 24} ${tentBase}
         L ${x} ${tentBase}
         L ${x + 36} ${tentPeak + 24}
         L ${x + w - 36} ${tentPeak + 24}
         L ${x + w} ${tentBase}
         L ${x + w - 24} ${tentBase} Z"
      fill="url(#gk-grad-leaf)" stroke="${PALETTE.leaf.stroke}" stroke-width="4" stroke-linejoin="round"/>
<!-- tent peak (smaller dome) -->
<path d="M ${x + 36} ${tentPeak + 24}
         L ${W/2 - 22} ${tentPeak - 6}
         L ${W/2 + 22} ${tentPeak - 6}
         L ${x + w - 36} ${tentPeak + 24} Z"
      fill="url(#gk-grad-leaf)" stroke="${PALETTE.leaf.stroke}" stroke-width="4" stroke-linejoin="round"/>
<!-- canvas stripes -->
<g stroke="${PALETTE.leaf.lo}" stroke-width="3" opacity="0.55" fill="none">
  <line x1="${x + 60}" y1="${tentBase}" x2="${x + 72}" y2="${tentPeak + 30}"/>
  <line x1="${x + 100}" y1="${tentBase}" x2="${x + 102}" y2="${tentPeak + 30}"/>
  <line x1="${x + 140}" y1="${tentBase}" x2="${x + 138}" y2="${tentPeak + 30}"/>
  <line x1="${x + 180}" y1="${tentBase}" x2="${x + 170}" y2="${tentPeak + 30}"/>
</g>
<!-- gloss on tent left flank -->
<path d="M ${x + 6} ${tentBase}
         L ${x + 40} ${tentPeak + 26}
         L ${x + 60} ${tentPeak + 26}
         L ${x + 28} ${tentBase} Z"
      fill="url(#gk-gloss)" opacity="0.55"/>
<!-- door flap — dark v-cut centre -->
<path d="M ${W/2 - 26} ${tentBase}
         L ${W/2} ${tentPeak + 60}
         L ${W/2 + 26} ${tentBase} Z"
      fill="${PALETTE.dark.lo}" stroke="${PALETTE.ink}" stroke-width="3" stroke-linejoin="round"/>
<!-- crossed swords above door -->
<g transform="translate(${W/2}, ${tentPeak + 38})">
  <g transform="rotate(-40)">
    <rect x="-2" y="-32" width="4" height="42" fill="url(#gk-grad-steel)" stroke="${PALETTE.steel.stroke}" stroke-width="1.5"/>
    <rect x="-7" y="6" width="14" height="4" fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1"/>
  </g>
  <g transform="rotate(40)">
    <rect x="-2" y="-32" width="4" height="42" fill="url(#gk-grad-steel)" stroke="${PALETTE.steel.stroke}" stroke-width="1.5"/>
    <rect x="-7" y="6" width="14" height="4" fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1"/>
  </g>
</g>
<!-- flagpole + banner on top -->
${flagpole({ x: W/2, yTop: tentPeak - 56, yBottom: tentPeak - 4, width: 4 })}
${glossyBanner({ x: W/2 + 2, y: tentPeak - 52, w: 36, h: 20, gradient: 'gk-grad-gold' })}
`;
}

// ── Catalogue + writer ───────────────────────────────────────────

const KINDS = [
  { id: 'townhall',    body: townhall },
  { id: 'wall',        body: wall },
  { id: 'cannon',      body: cannon },
  { id: 'archerTower', body: archerTower },
  { id: 'storage',     body: storage },
  { id: 'barracks',    body: barracks },
  { id: 'buildersHut', body: buildersHut },
  { id: 'warTent',     body: warTent },
];

let written = 0;
for (const k of KINDS) {
  const svg = svgWrapper({
    width: W, height: H,
    body: k.body(),
    title: `${k.id} (L1) — glossy`,
    desc: 'Loadout Clash building, glossy art style. Source: tools/build-clash-glossy.mjs.',
  });
  const out = join(OUT_DIR, `${k.id}-L1.svg`);
  writeFileSync(out, svg);
  written++;
  console.log(`wrote ${out} (${svg.length} bytes)`);
}
console.log(`\n✓ rendered ${written} glossy Clash buildings (Wave 1, L1) to ${OUT_DIR}`);
