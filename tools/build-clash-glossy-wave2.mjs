// Glossy Clash Wave 2, collectors / vaults / defenses / traps / decoy.
//
// Same kit as Wave 1. Uses archetype helpers so a category of
// kindred kinds (e.g. all four collectors) shares a base silhouette
// with per-kind accent recoloring. Output: SVG sources at
// aquilo-gg/sprites/clash-v2/glossy/buildings/<kind>-L1.svg.
//
// Run:  node tools/build-clash-glossy-wave2.mjs

import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  PALETTE,
  contactShadow,
  glossyRoundedRect,
  glossyEllipse,
  flagpole,
  glossyBanner,
  archedWindow,
  door,
  svgWrapper,
} from './glossy-art-kit.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_DIR = join(ROOT, 'aquilo-gg/sprites/clash-v2/glossy/buildings');
mkdirSync(OUT_DIR, { recursive: true });

const W = 256, H = 256;
const GROUND_Y = 224;
const SHADOW = contactShadow({ cx: W/2, cy: GROUND_Y + 8, rx: 92, ry: 14 });

// ── Archetype: a defense tower ───────────────────────────────────
//
// Tall stone or steel column with a weapon mount on top. Used by
// mortar, mageTower, infernoTower, bombTower, heavyCannon,
// voltaicCoil, skyMine, skywardBow, eagleEye, archerTower (Wave 1
// used a custom shape for archerTower, but this archetype is for
// the rest).
//
// `weapon` is a function that draws the upper mount given (cx, cy).
function defenseTower({ baseGradient = 'gk-grad-stone', baseStroke = PALETTE.stone.stroke, accent = PALETTE.gold, weapon }) {
  const x = 88, w = 80;
  const towerY = 96;
  const cx = W/2;
  return `
${SHADOW}
<!-- column base flare -->
${glossyEllipse({ cx, cy: GROUND_Y - 8, rx: 56, ry: 14, gradient: baseGradient, outline: baseStroke, outlineWidth: 4 })}
<!-- tower column -->
${glossyRoundedRect({ x, y: towerY, w, h: GROUND_Y - 8 - towerY, r: 10, gradient: baseGradient, outline: baseStroke, outlineWidth: 4 })}
<!-- accent band at top -->
<rect x="${x - 6}" y="${towerY - 4}" width="${w + 12}" height="12" rx="3"
      fill="url(#gk-grad-${gradKeyOf(accent)})" stroke="${accent.stroke}" stroke-width="2.5"/>
<!-- accent band at bottom -->
<rect x="${x - 4}" y="${GROUND_Y - 28}" width="${w + 8}" height="10" rx="2"
      fill="url(#gk-grad-${gradKeyOf(accent)})" stroke="${accent.stroke}" stroke-width="2"/>
${weapon ? weapon({ cx, cy: towerY - 8 }) : ''}
`;
}

// Reverse-lookup palette family name from a palette entry (so we
// can build the `gk-grad-<family>` id from the accent object).
function gradKeyOf(palEntry) {
  for (const [k, v] of Object.entries(PALETTE)) {
    if (v === palEntry) return k;
  }
  return 'gold';
}

// ── Archetype: a collector building ──────────────────────────────
//
// Squat workshop with a chimney/spout that puffs resource. Used by
// sawmill / quarry / forge / mint / workshop. `produces` controls
// the spout colour + the resource icon over the door.
function collectorBuilding({ wallGradient = 'gk-grad-wood', wallStroke = PALETTE.wood.stroke, roofGradient = 'gk-grad-brick', roofStroke = PALETTE.brick.stroke, spoutColor = PALETTE.cream.hi, iconShape = null }) {
  const x = 40, w = 176;
  const wallTop = 144;
  const roofPeak = 80;
  return `
${SHADOW}
${glossyRoundedRect({ x, y: wallTop, w, h: GROUND_Y - wallTop, r: 6, gradient: wallGradient, outline: wallStroke, outlineWidth: 4 })}
<!-- roof -->
<path d="M ${x - 12} ${wallTop + 6}
         L ${W/2} ${roofPeak}
         L ${x + w + 12} ${wallTop + 6}
         L ${x + w} ${wallTop + 14}
         L ${x} ${wallTop + 14} Z"
      fill="url(#${roofGradient})" stroke="${roofStroke}" stroke-width="4" stroke-linejoin="round"/>
<!-- roof gloss -->
<path d="M ${x - 6} ${wallTop + 4} L ${W/2 - 6} ${roofPeak + 4} L ${W/2 - 2} ${wallTop + 12} L ${x + 4} ${wallTop + 12} Z"
      fill="url(#gk-gloss)" opacity="0.5"/>
<!-- chimney -->
<rect x="${W/2 + 38}" y="${wallTop - 36}" width="22" height="40" rx="3"
      fill="url(#gk-grad-stone)" stroke="${PALETTE.stone.stroke}" stroke-width="3"/>
<!-- chimney puff -->
<ellipse cx="${W/2 + 49}" cy="${wallTop - 50}" rx="16" ry="9" fill="${spoutColor}" opacity="0.85" stroke="${PALETTE.stone.stroke}" stroke-width="1.5"/>
<ellipse cx="${W/2 + 60}" cy="${wallTop - 64}" rx="10" ry="6" fill="${spoutColor}" opacity="0.7"/>
<!-- door -->
${door({ cx: W/2 - 20, yBottom: GROUND_Y - 4, w: 36, h: 48 })}
<!-- accent icon plaque to right of door -->
<rect x="${W/2 + 12}" y="${wallTop + 36}" width="48" height="48" rx="5"
      fill="url(#gk-grad-cream)" stroke="${PALETTE.ink}" stroke-width="2.5"/>
${iconShape ? iconShape({ cx: W/2 + 36, cy: wallTop + 60 }) : ''}
`;
}

// ── Archetype: a vault chest ─────────────────────────────────────
//
// Heavy chest with a resource-stamped lock plate. Used by
// lumberVault / stoneVault / ironVault / goldVault.
function vaultChest({ wallGradient = 'gk-grad-wood', wallStroke = PALETTE.wood.stroke, plateColor = PALETTE.gold, iconShape = null }) {
  const x = 36, y = 110, w = 184, h = GROUND_Y - y;
  const lidH = 52;
  return `
${SHADOW}
${glossyRoundedRect({ x, y: y + lidH, w, h: h - lidH, r: 12, gradient: wallGradient, outline: wallStroke, outlineWidth: 4 })}
<!-- lid -->
<path d="M ${x + 6} ${y + lidH}
         L ${x + 6} ${y + lidH - 10}
         Q ${x + 6} ${y - 6} ${x + 40} ${y - 6}
         L ${x + w - 40} ${y - 6}
         Q ${x + w - 6} ${y - 6} ${x + w - 6} ${y + lidH - 10}
         L ${x + w - 6} ${y + lidH} Z"
      fill="url(#${wallGradient})" stroke="${wallStroke}" stroke-width="4" stroke-linejoin="round"/>
<path d="M ${x + 14} ${y + lidH - 6}
         Q ${x + 14} ${y} ${x + 40} ${y}
         L ${x + 90} ${y}
         Q ${x + 50} ${y + 18} ${x + 18} ${y + lidH - 6} Z"
      fill="url(#gk-gloss)" opacity="0.6"/>
<!-- big steel bands -->
<g fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="3" stroke-linejoin="round">
  <rect x="${x + 12}" y="${y - 8}" width="22" height="${h + 6}" rx="2"/>
  <rect x="${x + w - 34}" y="${y - 8}" width="22" height="${h + 6}" rx="2"/>
</g>
<!-- horizontal seam -->
<rect x="${x - 2}" y="${y + lidH - 4}" width="${w + 4}" height="8" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="2"/>
<!-- lock plate with resource icon -->
<rect x="${W/2 - 30}" y="${y + lidH - 18}" width="60" height="50" rx="5"
      fill="url(#gk-grad-${gradKeyOf(plateColor)})" stroke="${plateColor.stroke}" stroke-width="3"/>
${iconShape ? iconShape({ cx: W/2, cy: y + lidH + 8 }) : ''}
`;
}

// ── Archetype: a floor trap ──────────────────────────────────────
//
// Low-profile circular plate with a hazard motif. Used by trap,
// infernoTrap, springTrap, staticTrap, caltrops, skyMine.
function floorTrap({ plateGradient = 'gk-grad-iron', plateStroke = PALETTE.iron.stroke, hazardShape }) {
  const cx = W/2;
  const cy = GROUND_Y - 20;
  return `
${SHADOW}
<!-- outer plate -->
${glossyEllipse({ cx, cy, rx: 92, ry: 30, gradient: plateGradient, outline: plateStroke, outlineWidth: 4 })}
<!-- inner ring -->
<ellipse cx="${cx}" cy="${cy}" rx="68" ry="22"
         fill="none" stroke="${plateStroke}" stroke-width="3" opacity="0.75"/>
<!-- rivets -->
<g fill="url(#gk-grad-gold)" stroke="${PALETTE.ink}" stroke-width="1">
  <circle cx="${cx - 78}" cy="${cy}" r="4"/>
  <circle cx="${cx + 78}" cy="${cy}" r="4"/>
  <circle cx="${cx - 38}" cy="${cy - 20}" r="3"/>
  <circle cx="${cx + 38}" cy="${cy - 20}" r="3"/>
  <circle cx="${cx - 38}" cy="${cy + 20}" r="3"/>
  <circle cx="${cx + 38}" cy="${cy + 20}" r="3"/>
</g>
${hazardShape ? hazardShape({ cx, cy }) : ''}
`;
}

// ── Per-kind icon shapes (used by archetype callbacks) ───────────

function logIcon({ cx, cy }) {
  return `
<rect x="${cx - 16}" y="${cy - 6}" width="32" height="14" rx="3" fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="2"/>
<circle cx="${cx - 16}" cy="${cy + 1}" r="6" fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="2"/>
<circle cx="${cx - 16}" cy="${cy + 1}" r="2.5" fill="${PALETTE.wood.lo}"/>`;
}

function stoneIcon({ cx, cy }) {
  return `
<path d="M ${cx - 14} ${cy + 8} L ${cx - 16} ${cy - 2} L ${cx - 6} ${cy - 12} L ${cx + 10} ${cy - 10} L ${cx + 16} ${cy} L ${cx + 12} ${cy + 8} Z"
      fill="url(#gk-grad-stone)" stroke="${PALETTE.stone.stroke}" stroke-width="2" stroke-linejoin="round"/>`;
}

function ironIcon({ cx, cy }) {
  return `
<rect x="${cx - 14}" y="${cy - 8}" width="28" height="16" rx="3"
      fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="2"/>
<rect x="${cx - 10}" y="${cy - 4}" width="20" height="3" fill="${PALETTE.iron.hi}" opacity="0.7"/>`;
}

function coinIcon({ cx, cy }) {
  return `
<circle cx="${cx}" cy="${cy}" r="14" fill="url(#gk-rgrad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="2.5"/>
<text x="${cx}" y="${cy + 5}" font-size="14" font-family="serif" font-weight="bold"
      fill="${PALETTE.gold.stroke}" text-anchor="middle">$</text>`;
}

function gearIcon({ cx, cy }) {
  const teeth = 8;
  let path = '';
  for (let i = 0; i < teeth; i++) {
    const ang = (i * 360 / teeth) * Math.PI / 180;
    const x1 = cx + Math.cos(ang) * 14;
    const y1 = cy + Math.sin(ang) * 14;
    path += `<rect x="${x1 - 2.5}" y="${y1 - 2.5}" width="5" height="5" rx="1" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="1" transform="rotate(${i * 360 / teeth} ${x1} ${y1})"/>`;
  }
  return `
${path}
<circle cx="${cx}" cy="${cy}" r="10" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="2"/>
<circle cx="${cx}" cy="${cy}" r="4" fill="${PALETTE.ink}"/>`;
}

// ── Weapon mounts for defenseTower ───────────────────────────────

function mortarMount({ cx, cy }) {
  return `
<!-- bowl on stand -->
<ellipse cx="${cx}" cy="${cy + 8}" rx="38" ry="14" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="4"/>
<path d="M ${cx - 34} ${cy + 6} L ${cx - 22} ${cy - 24} L ${cx + 22} ${cy - 24} L ${cx + 34} ${cy + 6} Z"
      fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="4" stroke-linejoin="round"/>
<!-- gold rim -->
<ellipse cx="${cx}" cy="${cy - 24}" rx="22" ry="6" fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="2"/>
<!-- shell ready -->
<circle cx="${cx}" cy="${cy - 24}" r="10" fill="url(#gk-rgrad-iron)" stroke="${PALETTE.ink}" stroke-width="2"/>
<rect x="${cx - 2}" y="${cy - 40}" width="4" height="10" fill="${PALETTE.gold.hi}" stroke="${PALETTE.ink}" stroke-width="1"/>`;
}

function mageOrbMount({ cx, cy }) {
  return `
<!-- pillar cap -->
<rect x="${cx - 32}" y="${cy + 8}" width="64" height="10" rx="3" fill="url(#gk-grad-stone)" stroke="${PALETTE.stone.stroke}" stroke-width="3"/>
<!-- crystal orb -->
<circle cx="${cx}" cy="${cy - 14}" r="22" fill="url(#gk-rgrad-amethyst)" stroke="${PALETTE.amethyst.stroke}" stroke-width="4"/>
<ellipse cx="${cx - 7}" cy="${cy - 22}" rx="8" ry="4" fill="${PALETTE.white}" opacity="0.7"/>
<!-- arcane glow ring -->
<circle cx="${cx}" cy="${cy - 14}" r="26" fill="none" stroke="${PALETTE.amethyst.hi}" stroke-width="2" opacity="0.55"/>`;
}

function infernoMount({ cx, cy }) {
  return `
<!-- brass crown -->
<rect x="${cx - 28}" y="${cy + 8}" width="56" height="10" rx="3" fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="3"/>
<!-- flame chamber -->
<path d="M ${cx - 20} ${cy + 8}
         L ${cx - 14} ${cy - 14}
         Q ${cx - 6} ${cy - 30} ${cx} ${cy - 34}
         Q ${cx + 6} ${cy - 30} ${cx + 14} ${cy - 14}
         L ${cx + 20} ${cy + 8} Z"
      fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="3" stroke-linejoin="round"/>
<!-- flame -->
<path d="M ${cx} ${cy - 50}
         Q ${cx - 8} ${cy - 36} ${cx - 5} ${cy - 18}
         Q ${cx - 1} ${cy - 28} ${cx} ${cy - 38}
         Q ${cx + 1} ${cy - 28} ${cx + 5} ${cy - 18}
         Q ${cx + 8} ${cy - 36} ${cx} ${cy - 50} Z"
      fill="url(#gk-grad-ruby)" stroke="${PALETTE.ruby.stroke}" stroke-width="2" stroke-linejoin="round"/>
<path d="M ${cx} ${cy - 42}
         Q ${cx - 4} ${cy - 32} ${cx - 2} ${cy - 22}
         Q ${cx} ${cy - 28} ${cx + 2} ${cy - 22}
         Q ${cx + 4} ${cy - 32} ${cx} ${cy - 42} Z"
      fill="url(#gk-grad-gold)" opacity="0.85"/>`;
}

function bombMount({ cx, cy }) {
  return `
<!-- saucer -->
<ellipse cx="${cx}" cy="${cy + 8}" rx="36" ry="10" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="3"/>
<!-- bomb -->
<circle cx="${cx}" cy="${cy - 12}" r="20" fill="url(#gk-rgrad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="3.5"/>
<rect x="${cx - 4}" y="${cy - 38}" width="8" height="8" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="2"/>
<!-- fuse + spark -->
<path d="M ${cx + 4} ${cy - 36} Q ${cx + 14} ${cy - 46} ${cx + 22} ${cy - 50}"
      fill="none" stroke="${PALETTE.wood.lo}" stroke-width="2.5" stroke-linecap="round"/>
<circle cx="${cx + 24}" cy="${cy - 52}" r="4" fill="${PALETTE.gold.hi}"/>
<circle cx="${cx + 24}" cy="${cy - 52}" r="2" fill="${PALETTE.white}"/>`;
}

function heavyCannonMount({ cx, cy }) {
  return `
<!-- thick steel saucer -->
<ellipse cx="${cx}" cy="${cy + 8}" rx="42" ry="14" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="4"/>
<!-- short heavy barrel -->
<rect x="${cx - 22}" y="${cy - 22}" width="44" height="32" rx="6"
      fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="4"/>
<!-- muzzle -->
<rect x="${cx + 20}" y="${cy - 24}" width="10" height="36" rx="3"
      fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="3"/>
<!-- gold bands -->
<rect x="${cx - 22}" y="${cy - 14}" width="44" height="6" fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1.5"/>
<rect x="${cx - 22}" y="${cy + 2}"  width="44" height="6" fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1.5"/>
<!-- gloss -->
<rect x="${cx - 18}" y="${cy - 18}" width="36" height="4" rx="2" fill="${PALETTE.white}" opacity="0.55"/>`;
}

function voltaicCoilMount({ cx, cy }) {
  return `
<!-- copper base -->
<rect x="${cx - 32}" y="${cy + 8}" width="64" height="10" rx="3" fill="url(#gk-grad-copper)" stroke="${PALETTE.copper.stroke}" stroke-width="3"/>
<!-- coil tower (banded cylinder) -->
<g>
  <rect x="${cx - 18}" y="${cy - 28}" width="36" height="36" rx="6"
        fill="url(#gk-grad-copper)" stroke="${PALETTE.copper.stroke}" stroke-width="3"/>
  <g stroke="${PALETTE.copper.stroke}" stroke-width="1.5" opacity="0.65" fill="none">
    <line x1="${cx - 14}" y1="${cy - 22}" x2="${cx + 14}" y2="${cy - 22}"/>
    <line x1="${cx - 14}" y1="${cy - 16}" x2="${cx + 14}" y2="${cy - 16}"/>
    <line x1="${cx - 14}" y1="${cy - 10}" x2="${cx + 14}" y2="${cy - 10}"/>
    <line x1="${cx - 14}" y1="${cy - 4}"  x2="${cx + 14}" y2="${cy - 4}"/>
    <line x1="${cx - 14}" y1="${cy + 2}"  x2="${cx + 14}" y2="${cy + 2}"/>
  </g>
</g>
<!-- top dome (tesla ball) -->
<circle cx="${cx}" cy="${cy - 36}" r="14" fill="url(#gk-rgrad-sapphire)" stroke="${PALETTE.sapphire.stroke}" stroke-width="3"/>
<ellipse cx="${cx - 5}" cy="${cy - 42}" rx="6" ry="3" fill="${PALETTE.white}" opacity="0.75"/>
<!-- arc bolt -->
<path d="M ${cx - 14} ${cy - 36} L ${cx - 4} ${cy - 30} L ${cx - 8} ${cy - 26} L ${cx + 4} ${cy - 18}"
      fill="none" stroke="${PALETTE.sapphire.hi}" stroke-width="2.5" stroke-linecap="round" opacity="0.9"/>`;
}

function skyMineMount({ cx, cy }) {
  return `
<!-- mooring rod -->
<rect x="${cx - 2}" y="${cy - 4}" width="4" height="22" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="1.5"/>
<!-- spiked mine ball -->
<circle cx="${cx}" cy="${cy - 16}" r="18" fill="url(#gk-rgrad-dark)" stroke="${PALETTE.dark.stroke}" stroke-width="3"/>
<g stroke="${PALETTE.iron.stroke}" stroke-width="2" fill="url(#gk-grad-iron)">
  <rect x="${cx - 2}" y="${cy - 40}" width="4" height="8"/>
  <rect x="${cx + 14}" y="${cy - 18}" width="8" height="4"/>
  <rect x="${cx - 22}" y="${cy - 18}" width="8" height="4"/>
  <rect x="${cx + 10}" y="${cy - 30}" width="6" height="6" transform="rotate(45 ${cx + 13} ${cy - 27})"/>
  <rect x="${cx - 16}" y="${cy - 30}" width="6" height="6" transform="rotate(-45 ${cx - 13} ${cy - 27})"/>
  <rect x="${cx - 2}" y="${cy - 2}"  width="4" height="6"/>
</g>
<ellipse cx="${cx - 6}" cy="${cy - 24}" rx="5" ry="3" fill="${PALETTE.white}" opacity="0.55"/>`;
}

function skywardBowMount({ cx, cy }) {
  return `
<!-- platform -->
<rect x="${cx - 30}" y="${cy + 8}" width="60" height="10" rx="3" fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="3"/>
<!-- ballista arms -->
<path d="M ${cx - 36} ${cy - 16}
         Q ${cx} ${cy - 48} ${cx + 36} ${cy - 16}"
      fill="none" stroke="url(#gk-grad-wood)" stroke-width="8" stroke-linecap="round"/>
<path d="M ${cx - 36} ${cy - 16}
         Q ${cx} ${cy - 48} ${cx + 36} ${cy - 16}"
      fill="none" stroke="${PALETTE.wood.stroke}" stroke-width="2" stroke-linecap="round" opacity="0.5"/>
<!-- bowstring -->
<line x1="${cx - 32}" y1="${cy - 18}" x2="${cx + 32}" y2="${cy - 18}"
      stroke="${PALETTE.ink}" stroke-width="1.5"/>
<!-- arrow nocked -->
<rect x="${cx - 1}" y="${cy - 42}" width="2.5" height="32" fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="1"/>
<path d="M ${cx} ${cy - 50} L ${cx - 6} ${cy - 36} L ${cx + 6} ${cy - 36} Z"
      fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="1.5"/>`;
}

function eagleEyeMount({ cx, cy }) {
  return `
<!-- pivot mount -->
<rect x="${cx - 28}" y="${cy + 4}" width="56" height="14" rx="3" fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="3"/>
<!-- spyglass body -->
<g transform="rotate(-30 ${cx} ${cy - 12})">
  <rect x="${cx - 4}" y="${cy - 44}" width="8" height="40" rx="3"
        fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="3"/>
  <ellipse cx="${cx}" cy="${cy - 44}" rx="10" ry="4" fill="url(#gk-grad-sapphire)" stroke="${PALETTE.sapphire.stroke}" stroke-width="2"/>
</g>
<!-- eagle eye -->
<circle cx="${cx - 16}" cy="${cy - 26}" r="6" fill="${PALETTE.gold.hi}" stroke="${PALETTE.ink}" stroke-width="1.5"/>
<circle cx="${cx - 16}" cy="${cy - 26}" r="3" fill="${PALETTE.ink}"/>`;
}

// ── Hazard motifs for floorTrap ──────────────────────────────────

function bombHazard({ cx, cy }) {
  return `
<circle cx="${cx}" cy="${cy - 4}" r="14" fill="url(#gk-rgrad-dark)" stroke="${PALETTE.dark.stroke}" stroke-width="3"/>
<rect x="${cx - 3}" y="${cy - 22}" width="6" height="4" fill="${PALETTE.iron.base}" stroke="${PALETTE.ink}" stroke-width="1"/>
<path d="M ${cx} ${cy - 18} Q ${cx + 6} ${cy - 22} ${cx + 10} ${cy - 26}"
      fill="none" stroke="${PALETTE.wood.lo}" stroke-width="2"/>`;
}

function infernoHazard({ cx, cy }) {
  return `
<path d="M ${cx} ${cy - 26}
         Q ${cx - 12} ${cy - 12} ${cx - 8} ${cy + 4}
         Q ${cx - 2} ${cy - 6} ${cx} ${cy - 16}
         Q ${cx + 2} ${cy - 6} ${cx + 8} ${cy + 4}
         Q ${cx + 12} ${cy - 12} ${cx} ${cy - 26} Z"
      fill="url(#gk-grad-ruby)" stroke="${PALETTE.ruby.stroke}" stroke-width="2" stroke-linejoin="round"/>
<path d="M ${cx} ${cy - 18}
         Q ${cx - 4} ${cy - 8} ${cx - 2} ${cy + 2}
         Q ${cx} ${cy - 4} ${cx + 2} ${cy + 2}
         Q ${cx + 4} ${cy - 8} ${cx} ${cy - 18} Z"
      fill="url(#gk-grad-gold)" opacity="0.9"/>`;
}

function springHazard({ cx, cy }) {
  return `
<!-- coiled spring -->
<g fill="none" stroke="url(#gk-grad-iron)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M ${cx - 14} ${cy + 4}
           Q ${cx - 14} ${cy - 2} ${cx + 14} ${cy - 2}
           Q ${cx + 14} ${cy - 8} ${cx - 14} ${cy - 8}
           Q ${cx - 14} ${cy - 14} ${cx + 14} ${cy - 14}
           Q ${cx + 14} ${cy - 20} ${cx - 14} ${cy - 20}"/>
</g>
<g fill="none" stroke="${PALETTE.iron.stroke}" stroke-width="2" opacity="0.7">
  <path d="M ${cx - 14} ${cy + 4}
           Q ${cx - 14} ${cy - 2} ${cx + 14} ${cy - 2}
           Q ${cx + 14} ${cy - 8} ${cx - 14} ${cy - 8}
           Q ${cx - 14} ${cy - 14} ${cx + 14} ${cy - 14}
           Q ${cx + 14} ${cy - 20} ${cx - 14} ${cy - 20}"/>
</g>
<rect x="${cx - 20}" y="${cy - 28}" width="40" height="8" rx="2" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="2"/>`;
}

function staticHazard({ cx, cy }) {
  // Lightning bolt
  return `
<path d="M ${cx - 8} ${cy - 24}
         L ${cx + 4} ${cy - 10}
         L ${cx - 4} ${cy - 8}
         L ${cx + 8} ${cy + 12}
         L ${cx} ${cy - 4}
         L ${cx + 8} ${cy - 4} Z"
      fill="url(#gk-grad-sapphire)" stroke="${PALETTE.sapphire.stroke}" stroke-width="2" stroke-linejoin="round"/>
<path d="M ${cx - 6} ${cy - 22}
         L ${cx + 2} ${cy - 12}
         L ${cx - 2} ${cy - 10} Z"
      fill="${PALETTE.sapphire.hi}" opacity="0.85"/>`;
}

function caltropsHazard({ cx, cy }) {
  // Several caltrop spikes scattered
  function caltrop(x, y) {
    return `
<g transform="translate(${x}, ${y})">
  <path d="M 0 -10 L 4 6 L -4 6 Z" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="1.5" stroke-linejoin="round"/>
  <path d="M -8 4 L 2 -4 L 0 8 Z" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="1.5" stroke-linejoin="round"/>
  <path d="M 8 4 L -2 -4 L 0 8 Z" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="1.5" stroke-linejoin="round"/>
</g>`;
  }
  return `${caltrop(cx - 26, cy - 8)}${caltrop(cx, cy)}${caltrop(cx + 26, cy - 4)}`;
}

// ── decoyBanner ──────────────────────────────────────────────────
// Standalone shape (not really a tower), a flagpole on a base with
// a big rallying banner.
function decoyBanner() {
  const cx = W/2;
  return `
${SHADOW}
<!-- base -->
${glossyEllipse({ cx, cy: GROUND_Y - 12, rx: 56, ry: 14, gradient: 'gk-grad-stone', outline: PALETTE.stone.stroke, outlineWidth: 4 })}
<rect x="${cx - 30}" y="${GROUND_Y - 22}" width="60" height="14" rx="3"
      fill="url(#gk-grad-stone)" stroke="${PALETTE.stone.stroke}" stroke-width="3"/>
<!-- gold base ring -->
<rect x="${cx - 32}" y="${GROUND_Y - 28}" width="64" height="8" rx="2"
      fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="2"/>
<!-- pole -->
${flagpole({ x: cx, yTop: 56, yBottom: GROUND_Y - 24, width: 6 })}
<!-- big banner -->
${glossyBanner({ x: cx + 4, y: 64, w: 76, h: 64, gradient: 'gk-grad-ruby' })}
<!-- skull/sigil on banner -->
<g transform="translate(${cx + 36}, 96)">
  <circle cx="0" cy="0" r="14" fill="${PALETTE.cream.hi}" stroke="${PALETTE.ink}" stroke-width="2"/>
  <circle cx="-5" cy="-3" r="3" fill="${PALETTE.ink}"/>
  <circle cx="5" cy="-3" r="3" fill="${PALETTE.ink}"/>
  <rect x="-6" y="4" width="3" height="6" fill="${PALETTE.ink}"/>
  <rect x="-1" y="4" width="3" height="6" fill="${PALETTE.ink}"/>
  <rect x="4" y="4" width="3" height="6" fill="${PALETTE.ink}"/>
</g>
`;
}

// ── Per-kind catalogue ───────────────────────────────────────────

const KINDS = [
  // Collectors
  { id: 'sawmill',   body: () => collectorBuilding({ roofGradient: 'gk-grad-leaf',    roofStroke: PALETTE.leaf.stroke,    spoutColor: PALETTE.leaf.hi,    iconShape: logIcon }) },
  { id: 'quarry',    body: () => collectorBuilding({ wallGradient: 'gk-grad-stone',   wallStroke: PALETTE.stone.stroke,   roofGradient: 'gk-grad-stone', roofStroke: PALETTE.stone.stroke, iconShape: stoneIcon }) },
  { id: 'forge',     body: () => collectorBuilding({ wallGradient: 'gk-grad-brick',   wallStroke: PALETTE.brick.stroke,   roofGradient: 'gk-grad-iron',  roofStroke: PALETTE.iron.stroke,  spoutColor: PALETTE.ruby.hi, iconShape: ironIcon }) },
  { id: 'mint',      body: () => collectorBuilding({ wallGradient: 'gk-grad-cream',   wallStroke: PALETTE.cream.stroke,   roofGradient: 'gk-grad-gold',  roofStroke: PALETTE.gold.stroke,  iconShape: coinIcon }) },
  { id: 'workshop',  body: () => collectorBuilding({ wallGradient: 'gk-grad-wood',    wallStroke: PALETTE.wood.stroke,    roofGradient: 'gk-grad-thatch', roofStroke: PALETTE.thatch.stroke, iconShape: gearIcon }) },

  // Vaults
  { id: 'lumberVault', body: () => vaultChest({ wallGradient: 'gk-grad-wood',  wallStroke: PALETTE.wood.stroke,  plateColor: PALETTE.leaf,  iconShape: logIcon }) },
  { id: 'stoneVault',  body: () => vaultChest({ wallGradient: 'gk-grad-stone', wallStroke: PALETTE.stone.stroke, plateColor: PALETTE.stone, iconShape: stoneIcon }) },
  { id: 'ironVault',   body: () => vaultChest({ wallGradient: 'gk-grad-iron',  wallStroke: PALETTE.iron.stroke,  plateColor: PALETTE.iron,  iconShape: ironIcon }) },
  { id: 'goldVault',   body: () => vaultChest({ wallGradient: 'gk-grad-wood',  wallStroke: PALETTE.wood.stroke,  plateColor: PALETTE.gold,  iconShape: coinIcon }) },

  // Defense towers
  { id: 'mortar',       body: () => defenseTower({ accent: PALETTE.gold,     weapon: mortarMount }) },
  { id: 'mageTower',    body: () => defenseTower({ baseGradient: 'gk-grad-amethyst', baseStroke: PALETTE.amethyst.stroke, accent: PALETTE.amethyst, weapon: mageOrbMount }) },
  { id: 'infernoTower', body: () => defenseTower({ baseGradient: 'gk-grad-iron',     baseStroke: PALETTE.iron.stroke,     accent: PALETTE.ruby,     weapon: infernoMount }) },
  { id: 'bombTower',    body: () => defenseTower({ baseGradient: 'gk-grad-brick',    baseStroke: PALETTE.brick.stroke,    accent: PALETTE.gold,     weapon: bombMount }) },
  { id: 'heavyCannon',  body: () => defenseTower({ baseGradient: 'gk-grad-iron',     baseStroke: PALETTE.iron.stroke,     accent: PALETTE.gold,     weapon: heavyCannonMount }) },
  { id: 'voltaicCoil',  body: () => defenseTower({ baseGradient: 'gk-grad-copper',   baseStroke: PALETTE.copper.stroke,   accent: PALETTE.sapphire, weapon: voltaicCoilMount }) },
  { id: 'skyMine',      body: () => defenseTower({ baseGradient: 'gk-grad-stone',    baseStroke: PALETTE.stone.stroke,    accent: PALETTE.iron,     weapon: skyMineMount }) },
  { id: 'skywardBow',   body: () => defenseTower({ baseGradient: 'gk-grad-wood',     baseStroke: PALETTE.wood.stroke,     accent: PALETTE.gold,     weapon: skywardBowMount }) },
  { id: 'eagleEye',     body: () => defenseTower({ baseGradient: 'gk-grad-stone',    baseStroke: PALETTE.stone.stroke,    accent: PALETTE.gold,     weapon: eagleEyeMount }) },

  // Floor traps
  { id: 'trap',        body: () => floorTrap({ hazardShape: bombHazard }) },
  { id: 'infernoTrap', body: () => floorTrap({ plateGradient: 'gk-grad-brick', plateStroke: PALETTE.brick.stroke, hazardShape: infernoHazard }) },
  { id: 'springTrap',  body: () => floorTrap({ plateGradient: 'gk-grad-wood',  plateStroke: PALETTE.wood.stroke,  hazardShape: springHazard }) },
  { id: 'staticTrap',  body: () => floorTrap({ plateGradient: 'gk-grad-copper', plateStroke: PALETTE.copper.stroke, hazardShape: staticHazard }) },
  { id: 'caltrops',    body: () => floorTrap({ plateGradient: 'gk-grad-stone', plateStroke: PALETTE.stone.stroke, hazardShape: caltropsHazard }) },

  // Decoy / banner
  { id: 'decoyBanner', body: decoyBanner },
];

let written = 0;
for (const k of KINDS) {
  const svg = svgWrapper({
    width: W, height: H,
    body: k.body(),
    title: `${k.id} (L1), glossy`,
    desc: 'Loadout Clash building, glossy art style. Source: tools/build-clash-glossy-wave2.mjs.',
  });
  const out = join(OUT_DIR, `${k.id}-L1.svg`);
  writeFileSync(out, svg);
  written++;
  console.log(`wrote ${out}`);
}
console.log(`\n✓ rendered ${written} glossy Clash buildings (Wave 2)`);
