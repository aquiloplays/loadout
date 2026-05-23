// Glossy gear catalogue — all 185 items from dungeon.js SHOP_POOL.
//
// Each gear icon is a 192×192 SVG composed from:
//   • rarity glow backdrop (per-rarity radial behind item)
//   • soft contact shadow
//   • slot+subtype shape template (sword/bow/wand/helm/tunic/...)
//   • palette family resolved from item name / setName
//   • per-rarity accent ring + stroke weight
//
// Pure name→template heuristics for the subtype pick (looking for
// keywords like "Bow", "Hood", "Plate", "Boots", etc). Falls back
// to a default per-slot silhouette.
//
// Output: aquilo-gg/sprites/gear/glossy/<slot>/<safeId>.svg
//
// SafeId is `<slot>-<rarity>-<snake-name>` so the worker can
// continue resolving via the existing gear.id field by hashing or
// just by name. The catalogue index `_catalog.json` is written next
// to the icons mapping id → svg filename for cross-referencing.
//
// Run:  node tools/build-gear-glossy.mjs

import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  PALETTE,
  RARITY,
  contactShadow,
  rarityGlow,
  svgWrapper,
} from './glossy-art-kit.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_BASE = join(ROOT, 'aquilo-gg/sprites/gear/glossy');
for (const s of ['weapon', 'head', 'chest', 'legs', 'boots', 'trinket']) {
  mkdirSync(join(OUT_BASE, s), { recursive: true });
}

// ── Parse SHOP_POOL from dungeon.js ─────────────────────────────
const dungeonSrc = readFileSync(join(ROOT, 'discord-bot/dungeon.js'), 'utf8');
// Match: ['slot', 'rarity', 'name', '...glyph', atk, def, gold, 'setName', 'weaponType', 'preferredClass', 'ability'],
const reEntry = /\['(weapon|head|chest|legs|boots|trinket)',\s*'(\w+)',\s*'([^']+(?:\\'[^']*)*)',\s*'([^']*)',\s*(\d+),\s*(\d+),\s*(\d+),\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)'/g;
const items = [];
let m;
while ((m = reEntry.exec(dungeonSrc)) !== null) {
  items.push({
    slot:           m[1],
    rarity:         m[2],
    name:           m[3].replace(/\\'/g, "'"),
    glyph:          m[4],
    atk:            +m[5],
    def:            +m[6],
    gold:           +m[7],
    setName:        m[8],
    weaponType:     m[9],
    preferredClass: m[10],
    ability:        m[11],
  });
}
console.log(`parsed ${items.length} gear entries from SHOP_POOL`);
if (items.length !== 185) {
  console.warn(`expected 185, got ${items.length} — regex may be drifting`);
}

const W = 192, H = 192;
const CX = W / 2, CY = H / 2;

// ── Palette + rarity helpers ────────────────────────────────────
//
// Pick a palette family from the item name + setName. Falls back
// per-slot. Cross-references against the kit's PALETTE keys.

const NAME_PALETTE = [
  // Materials in the name → palette
  [/bronze|copper|wayfarer/i,   'copper'],
  [/iron|steel|knight|warrior/i, 'steel'],
  [/wood|hempen|leather|patch|hunter|sapper|trail/i, 'wood'],
  [/cloth|cotton|robe|hood|sage|monk/i, 'cream'],
  [/gold|royal|prince|king|queen|saint/i, 'gold'],
  [/ruby|crimson|blood|fire|flame|inferno|ember/i, 'ruby'],
  [/emerald|forest|leaf|nature|druid|moss/i, 'emerald'],
  [/sapphire|ocean|frost|ice|storm|tide/i, 'sapphire'],
  [/amethyst|arcane|mage|wizard|witch|warlock|sorcerer|astral|void/i, 'amethyst'],
  [/silver|moon|mithril|elven/i, 'steel'],
  [/dark|shadow|night|raven|grim|necro/i, 'dark'],
  [/stone|granite|earth|stalker/i, 'stone'],
  [/brick|terra|clay/i, 'brick'],
];
const SLOT_FALLBACK_PALETTE = {
  weapon:  'steel',
  head:    'wood',
  chest:   'wood',
  legs:    'wood',
  boots:   'wood',
  trinket: 'gold',
};
function pickPalette(item) {
  const txt = `${item.name} ${item.setName}`;
  for (const [re, fam] of NAME_PALETTE) if (re.test(txt)) return fam;
  return SLOT_FALLBACK_PALETTE[item.slot] || 'steel';
}

// ── Weapon subtype shapes ───────────────────────────────────────
//
// All weapons centred at (CX, CY), height ~140, anchored so the
// rarity glow sits behind nicely. weaponType comes from the SHOP_POOL
// column. Falls back to sword.

function shapeSword(pal, accent) {
  return `
<!-- blade -->
<path d="M ${CX - 8} ${CY + 50}
         L ${CX - 8} ${CY - 50}
         L ${CX}     ${CY - 64}
         L ${CX + 8} ${CY - 50}
         L ${CX + 8} ${CY + 50} Z"
      fill="url(#gk-grad-${pal})" stroke="${PALETTE[pal].stroke}" stroke-width="3.5" stroke-linejoin="round"/>
<!-- fuller -->
<rect x="${CX - 2}" y="${CY - 48}" width="4" height="86" rx="1" fill="${PALETTE[pal].stroke}" opacity="0.45"/>
<!-- blade gloss -->
<path d="M ${CX - 5} ${CY + 48} L ${CX - 5} ${CY - 46} L ${CX - 2} ${CY - 52} L ${CX - 2} ${CY + 48} Z"
      fill="${PALETTE.white}" opacity="0.5"/>
<!-- crossguard -->
<rect x="${CX - 28}" y="${CY + 50}" width="56" height="10" rx="3"
      fill="url(#gk-grad-${accent})" stroke="${PALETTE[accent].stroke}" stroke-width="2"/>
<!-- grip -->
<rect x="${CX - 6}" y="${CY + 60}" width="12" height="28" rx="3" fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="2"/>
<!-- pommel -->
<circle cx="${CX}" cy="${CY + 92}" r="9" fill="url(#gk-rgrad-${accent})" stroke="${PALETTE[accent].stroke}" stroke-width="2"/>
<circle cx="${CX - 3}" cy="${CY + 89}" r="3" fill="${PALETTE.white}" opacity="0.65"/>`;
}

function shapeDagger(pal, accent) {
  return `
<path d="M ${CX - 6} ${CY + 40}
         L ${CX - 6} ${CY - 38}
         L ${CX}     ${CY - 50}
         L ${CX + 6} ${CY - 38}
         L ${CX + 6} ${CY + 40} Z"
      fill="url(#gk-grad-${pal})" stroke="${PALETTE[pal].stroke}" stroke-width="3.5" stroke-linejoin="round"/>
<rect x="${CX - 1.5}" y="${CY - 36}" width="3" height="74" rx="1" fill="${PALETTE[pal].stroke}" opacity="0.45"/>
<path d="M ${CX - 4} ${CY + 38} L ${CX - 4} ${CY - 36} L ${CX - 1} ${CY - 42} L ${CX - 1} ${CY + 38} Z"
      fill="${PALETTE.white}" opacity="0.5"/>
<rect x="${CX - 18}" y="${CY + 40}" width="36" height="8" rx="2"
      fill="url(#gk-grad-${accent})" stroke="${PALETTE[accent].stroke}" stroke-width="2"/>
<rect x="${CX - 4}" y="${CY + 48}" width="8" height="22" rx="2" fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="2"/>
<circle cx="${CX}" cy="${CY + 74}" r="6" fill="url(#gk-rgrad-${accent})" stroke="${PALETTE[accent].stroke}" stroke-width="1.5"/>`;
}

function shapeAxe(pal, accent) {
  return `
<!-- haft -->
<rect x="${CX - 4}" y="${CY - 60}" width="8" height="148" rx="3" fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="2.5"/>
<!-- axe head -->
<path d="M ${CX - 4} ${CY - 50}
         L ${CX - 46} ${CY - 30}
         L ${CX - 48} ${CY + 6}
         L ${CX - 12} ${CY - 6}
         L ${CX - 4} ${CY + 4} Z"
      fill="url(#gk-grad-${pal})" stroke="${PALETTE[pal].stroke}" stroke-width="3" stroke-linejoin="round"/>
<path d="M ${CX + 4} ${CY - 50}
         L ${CX + 46} ${CY - 30}
         L ${CX + 48} ${CY + 6}
         L ${CX + 12} ${CY - 6}
         L ${CX + 4} ${CY + 4} Z"
      fill="url(#gk-grad-${pal})" stroke="${PALETTE[pal].stroke}" stroke-width="3" stroke-linejoin="round"/>
<!-- gloss on edges -->
<path d="M ${CX - 38} ${CY - 28} L ${CX - 14} ${CY - 8} L ${CX - 12} ${CY - 4} L ${CX - 42} ${CY - 16} Z"
      fill="${PALETTE.white}" opacity="0.45"/>
<!-- gold band on haft -->
<rect x="${CX - 5}" y="${CY + 10}" width="10" height="6" rx="2" fill="url(#gk-grad-${accent})" stroke="${PALETTE[accent].stroke}" stroke-width="1.5"/>
<rect x="${CX - 5}" y="${CY + 70}" width="10" height="6" rx="2" fill="url(#gk-grad-${accent})" stroke="${PALETTE[accent].stroke}" stroke-width="1.5"/>`;
}

function shapeHammer(pal, accent) {
  return `
<rect x="${CX - 4}" y="${CY - 32}" width="8" height="118" rx="3" fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="2.5"/>
<rect x="${CX - 36}" y="${CY - 44}" width="72" height="38" rx="6"
      fill="url(#gk-grad-${pal})" stroke="${PALETTE[pal].stroke}" stroke-width="3.5"/>
<rect x="${CX - 30}" y="${CY - 38}" width="60" height="6" rx="2" fill="${PALETTE.white}" opacity="0.55"/>
<!-- gold rivets -->
<circle cx="${CX - 26}" cy="${CY - 24}" r="3" fill="url(#gk-rgrad-${accent})" stroke="${PALETTE[accent].stroke}" stroke-width="1"/>
<circle cx="${CX + 26}" cy="${CY - 24}" r="3" fill="url(#gk-rgrad-${accent})" stroke="${PALETTE[accent].stroke}" stroke-width="1"/>
<!-- grip wrap -->
<rect x="${CX - 5}" y="${CY + 60}" width="10" height="28" rx="3" fill="url(#gk-grad-${accent})" stroke="${PALETTE[accent].stroke}" stroke-width="2"/>`;
}

function shapeBow(pal, accent) {
  return `
<path d="M ${CX - 32} ${CY - 64}
         Q ${CX - 78} ${CY} ${CX - 32} ${CY + 64}"
      fill="none" stroke="url(#gk-grad-${pal})" stroke-width="12" stroke-linecap="round"/>
<path d="M ${CX - 32} ${CY - 64}
         Q ${CX - 78} ${CY} ${CX - 32} ${CY + 64}"
      fill="none" stroke="${PALETTE[pal].stroke}" stroke-width="3" stroke-linecap="round"/>
<!-- bowstring -->
<line x1="${CX - 32}" y1="${CY - 64}" x2="${CX - 32}" y2="${CY + 64}" stroke="${PALETTE.ink}" stroke-width="2"/>
<!-- grip wrap -->
<rect x="${CX - 40}" y="${CY - 14}" width="14" height="28" rx="3" fill="url(#gk-grad-${accent})" stroke="${PALETTE[accent].stroke}" stroke-width="2"/>
<!-- arrow nocked -->
<rect x="${CX - 28}" y="${CY - 2}" width="76" height="4" rx="2" fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="1.5"/>
<path d="M ${CX + 50} ${CY} L ${CX + 64} ${CY - 8} L ${CX + 64} ${CY + 8} Z"
      fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="2" stroke-linejoin="round"/>`;
}

function shapeCrossbow(pal, accent) {
  return `
<!-- stock -->
<rect x="${CX - 16}" y="${CY - 14}" width="74" height="20" rx="4" fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="3"/>
<!-- bow -->
<path d="M ${CX - 16} ${CY - 36}
         Q ${CX - 32} ${CY - 4} ${CX - 16} ${CY + 24}"
      fill="none" stroke="url(#gk-grad-${pal})" stroke-width="10" stroke-linecap="round"/>
<path d="M ${CX - 16} ${CY - 36}
         Q ${CX - 32} ${CY - 4} ${CX - 16} ${CY + 24}"
      fill="none" stroke="${PALETTE[pal].stroke}" stroke-width="2.5"/>
<!-- string -->
<line x1="${CX - 16}" y1="${CY - 36}" x2="${CX - 16}" y2="${CY + 24}" stroke="${PALETTE.ink}" stroke-width="2"/>
<!-- bolt -->
<rect x="${CX - 4}" y="${CY - 4}" width="52" height="4" rx="2" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="1.5"/>
<!-- trigger guard -->
<rect x="${CX + 18}" y="${CY + 6}" width="12" height="14" rx="2" fill="url(#gk-grad-${accent})" stroke="${PALETTE[accent].stroke}" stroke-width="2"/>`;
}

function shapeWand(pal, accent) {
  return `
<rect x="${CX - 4}" y="${CY - 40}" width="8" height="110" rx="3" fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="2.5"/>
<circle cx="${CX}" cy="${CY - 52}" r="18" fill="url(#gk-rgrad-${pal})" stroke="${PALETTE[pal].stroke}" stroke-width="3"/>
<circle cx="${CX - 5}" cy="${CY - 58}" r="5" fill="${PALETTE.white}" opacity="0.7"/>
<!-- holder claws around orb -->
<g stroke="${PALETTE[accent].stroke}" stroke-width="2.5" fill="url(#gk-grad-${accent})">
  <path d="M ${CX - 16} ${CY - 38} L ${CX - 22} ${CY - 32} L ${CX - 14} ${CY - 30} Z"/>
  <path d="M ${CX + 16} ${CY - 38} L ${CX + 22} ${CY - 32} L ${CX + 14} ${CY - 30} Z"/>
  <path d="M ${CX} ${CY - 70} L ${CX - 6} ${CY - 64} L ${CX + 6} ${CY - 64} Z"/>
</g>
<!-- grip wrap -->
<rect x="${CX - 5}" y="${CY + 30}" width="10" height="20" rx="2" fill="url(#gk-grad-${accent})" stroke="${PALETTE[accent].stroke}" stroke-width="2"/>`;
}

function shapeStaff(pal, accent) {
  return `
<rect x="${CX - 4}" y="${CY - 70}" width="8" height="150" rx="3" fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="2.5"/>
<!-- topper crystal -->
<path d="M ${CX - 14} ${CY - 60}
         L ${CX} ${CY - 86}
         L ${CX + 14} ${CY - 60}
         L ${CX + 6} ${CY - 52}
         L ${CX - 6} ${CY - 52} Z"
      fill="url(#gk-grad-${pal})" stroke="${PALETTE[pal].stroke}" stroke-width="3" stroke-linejoin="round"/>
<path d="M ${CX - 10} ${CY - 58} L ${CX} ${CY - 80} L ${CX - 2} ${CY - 56} Z"
      fill="${PALETTE.white}" opacity="0.6"/>
<!-- gold band -->
<rect x="${CX - 8}" y="${CY - 54}" width="16" height="5" rx="2"
      fill="url(#gk-grad-${accent})" stroke="${PALETTE[accent].stroke}" stroke-width="1.5"/>
<!-- grip wrap -->
<rect x="${CX - 5}" y="${CY - 6}" width="10" height="24" rx="2" fill="url(#gk-grad-${accent})" stroke="${PALETTE[accent].stroke}" stroke-width="2"/>`;
}

function shapePolearm(pal, accent) {
  // Spear / halberd
  return `
<rect x="${CX - 4}" y="${CY - 36}" width="8" height="130" rx="3" fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="2.5"/>
<!-- broad blade -->
<path d="M ${CX - 6} ${CY - 30}
         L ${CX - 16} ${CY - 60}
         L ${CX} ${CY - 84}
         L ${CX + 16} ${CY - 60}
         L ${CX + 6} ${CY - 30} Z"
      fill="url(#gk-grad-${pal})" stroke="${PALETTE[pal].stroke}" stroke-width="3" stroke-linejoin="round"/>
<rect x="${CX - 1.5}" y="${CY - 78}" width="3" height="46" rx="1" fill="${PALETTE[pal].stroke}" opacity="0.45"/>
<path d="M ${CX - 12} ${CY - 56} L ${CX - 2} ${CY - 78} L ${CX - 2} ${CY - 32} Z"
      fill="${PALETTE.white}" opacity="0.45"/>
<!-- side axe blade (halberd hint) -->
<path d="M ${CX + 6} ${CY - 36} L ${CX + 26} ${CY - 50} L ${CX + 26} ${CY - 30} Z"
      fill="url(#gk-grad-${pal})" stroke="${PALETTE[pal].stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<!-- gold band -->
<rect x="${CX - 6}" y="${CY - 30}" width="12" height="6" rx="2" fill="url(#gk-grad-${accent})" stroke="${PALETTE[accent].stroke}" stroke-width="1.5"/>`;
}

function shapeSling(pal, accent) {
  // Y-shaped slingshot
  return `
<rect x="${CX - 5}" y="${CY}" width="10" height="80" rx="3" fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="2.5"/>
<path d="M ${CX} ${CY}
         L ${CX - 40} ${CY - 50}
         M ${CX} ${CY}
         L ${CX + 40} ${CY - 50}"
      stroke="url(#gk-grad-wood)" stroke-width="12" stroke-linecap="round"/>
<path d="M ${CX} ${CY}
         L ${CX - 40} ${CY - 50}
         M ${CX} ${CY}
         L ${CX + 40} ${CY - 50}"
      stroke="${PALETTE.wood.stroke}" stroke-width="2" stroke-linecap="round"/>
<!-- rubber band + stone -->
<path d="M ${CX - 36} ${CY - 46} Q ${CX} ${CY - 22} ${CX + 36} ${CY - 46}"
      fill="none" stroke="${PALETTE.dark.base}" stroke-width="2.5"/>
<circle cx="${CX}" cy="${CY - 24}" r="9" fill="url(#gk-rgrad-${pal})" stroke="${PALETTE[pal].stroke}" stroke-width="2"/>`;
}

const WEAPON_SHAPES = {
  sword:    shapeSword,
  dagger:   shapeDagger,
  axe:      shapeAxe,
  hammer:   shapeHammer,
  bow:      shapeBow,
  crossbow: shapeCrossbow,
  wand:     shapeWand,
  staff:    shapeStaff,
  polearm:  shapePolearm,
  sling:    shapeSling,
};

// ── Armour shapes ───────────────────────────────────────────────

function shapeHelm(pal, accent) {
  return `
<!-- dome -->
<path d="M ${CX - 60} ${CY + 10}
         Q ${CX - 60} ${CY - 60} ${CX} ${CY - 60}
         Q ${CX + 60} ${CY - 60} ${CX + 60} ${CY + 10}
         L ${CX + 60} ${CY + 30}
         L ${CX - 60} ${CY + 30} Z"
      fill="url(#gk-grad-${pal})" stroke="${PALETTE[pal].stroke}" stroke-width="4" stroke-linejoin="round"/>
<!-- gloss top-left -->
<path d="M ${CX - 50} ${CY + 8} Q ${CX - 50} ${CY - 50} ${CX - 6} ${CY - 54} L ${CX - 6} ${CY - 30} Q ${CX - 32} ${CY - 16} ${CX - 30} ${CY + 8} Z"
      fill="${PALETTE.white}" opacity="0.55"/>
<!-- gold band -->
<rect x="${CX - 64}" y="${CY + 16}" width="128" height="14" rx="3"
      fill="url(#gk-grad-${accent})" stroke="${PALETTE[accent].stroke}" stroke-width="2.5"/>
<!-- visor slit -->
<rect x="${CX - 28}" y="${CY - 18}" width="56" height="8" rx="2" fill="${PALETTE.ink}" stroke="${PALETTE[pal].stroke}" stroke-width="1.5"/>
<!-- rivets -->
<circle cx="${CX - 48}" cy="${CY + 23}" r="3" fill="${PALETTE[accent].hi}" stroke="${PALETTE.ink}" stroke-width="1"/>
<circle cx="${CX + 48}" cy="${CY + 23}" r="3" fill="${PALETTE[accent].hi}" stroke="${PALETTE.ink}" stroke-width="1"/>`;
}

function shapeHood(pal, accent) {
  return `
<path d="M ${CX - 64} ${CY + 30}
         Q ${CX - 70} ${CY - 20} ${CX - 30} ${CY - 60}
         Q ${CX} ${CY - 72} ${CX + 30} ${CY - 60}
         Q ${CX + 70} ${CY - 20} ${CX + 64} ${CY + 30}
         L ${CX + 50} ${CY + 30}
         Q ${CX} ${CY + 6} ${CX - 50} ${CY + 30} Z"
      fill="url(#gk-grad-${pal})" stroke="${PALETTE[pal].stroke}" stroke-width="4" stroke-linejoin="round"/>
<path d="M ${CX - 56} ${CY + 26} Q ${CX - 60} ${CY - 14} ${CX - 26} ${CY - 50} L ${CX - 14} ${CY - 46} Q ${CX - 38} ${CY - 8} ${CX - 32} ${CY + 26} Z"
      fill="${PALETTE.white}" opacity="0.5"/>
<!-- pointed tip -->
<path d="M ${CX - 4} ${CY - 70} L ${CX + 14} ${CY - 86} L ${CX + 18} ${CY - 68} Z"
      fill="url(#gk-grad-${pal})" stroke="${PALETTE[pal].stroke}" stroke-width="3" stroke-linejoin="round"/>
<!-- accent trim -->
<path d="M ${CX - 50} ${CY + 30} Q ${CX} ${CY + 6} ${CX + 50} ${CY + 30}"
      fill="none" stroke="${PALETTE[accent].hi}" stroke-width="3"/>`;
}

function shapeCap(pal, accent) {
  return `
<!-- crown -->
<ellipse cx="${CX}" cy="${CY - 4}" rx="48" ry="34"
         fill="url(#gk-grad-${pal})" stroke="${PALETTE[pal].stroke}" stroke-width="3.5"/>
<!-- brim -->
<ellipse cx="${CX}" cy="${CY + 22}" rx="68" ry="14"
         fill="url(#gk-grad-${pal})" stroke="${PALETTE[pal].stroke}" stroke-width="3.5"/>
<ellipse cx="${CX - 16}" cy="${CY - 20}" rx="18" ry="10" fill="${PALETTE.white}" opacity="0.5"/>
<!-- accent band -->
<rect x="${CX - 48}" y="${CY + 8}" width="96" height="10" rx="2"
      fill="url(#gk-grad-${accent})" stroke="${PALETTE[accent].stroke}" stroke-width="2"/>`;
}

function shapeTunic(pal, accent) {
  return `
<path d="M ${CX - 60} ${CY + 70}
         L ${CX - 60} ${CY - 30}
         L ${CX - 36} ${CY - 60}
         L ${CX - 14} ${CY - 50}
         L ${CX + 14} ${CY - 50}
         L ${CX + 36} ${CY - 60}
         L ${CX + 60} ${CY - 30}
         L ${CX + 60} ${CY + 70} Z"
      fill="url(#gk-grad-${pal})" stroke="${PALETTE[pal].stroke}" stroke-width="4" stroke-linejoin="round"/>
<!-- gloss -->
<path d="M ${CX - 52} ${CY + 64} L ${CX - 52} ${CY - 26} L ${CX - 30} ${CY - 52} L ${CX - 12} ${CY - 46} L ${CX - 16} ${CY - 26} Q ${CX - 32} ${CY - 14} ${CX - 30} ${CY + 64} Z"
      fill="${PALETTE.white}" opacity="0.5"/>
<!-- collar v -->
<path d="M ${CX - 14} ${CY - 50} L ${CX} ${CY - 24} L ${CX + 14} ${CY - 50} Z"
      fill="${PALETTE[pal].lo}" stroke="${PALETTE[pal].stroke}" stroke-width="2" stroke-linejoin="round"/>
<!-- gold belt -->
<rect x="${CX - 60}" y="${CY + 50}" width="120" height="10" rx="2"
      fill="url(#gk-grad-${accent})" stroke="${PALETTE[accent].stroke}" stroke-width="2"/>
<circle cx="${CX}" cy="${CY + 55}" r="6" fill="url(#gk-rgrad-${accent})" stroke="${PALETTE[accent].stroke}" stroke-width="1.5"/>`;
}

function shapePlate(pal, accent) {
  return `
${shapeTunic(pal, accent)}
<!-- shoulder pauldrons -->
<ellipse cx="${CX - 56}" cy="${CY - 36}" rx="16" ry="12"
         fill="url(#gk-rgrad-${pal})" stroke="${PALETTE[pal].stroke}" stroke-width="3"/>
<ellipse cx="${CX + 56}" cy="${CY - 36}" rx="16" ry="12"
         fill="url(#gk-rgrad-${pal})" stroke="${PALETTE[pal].stroke}" stroke-width="3"/>
<!-- chest emblem -->
<circle cx="${CX}" cy="${CY + 8}" r="14" fill="url(#gk-grad-${accent})" stroke="${PALETTE[accent].stroke}" stroke-width="2.5"/>
<path d="M ${CX} ${CY - 4} L ${CX - 8} ${CY + 6} L ${CX} ${CY + 18} L ${CX + 8} ${CY + 6} Z"
      fill="${PALETTE[pal].lo}" stroke="${PALETTE[pal].stroke}" stroke-width="1.5"/>`;
}

function shapeRobe(pal, accent) {
  return `
<path d="M ${CX - 70} ${CY + 76}
         L ${CX - 50} ${CY - 30}
         L ${CX - 30} ${CY - 60}
         L ${CX + 30} ${CY - 60}
         L ${CX + 50} ${CY - 30}
         L ${CX + 70} ${CY + 76} Z"
      fill="url(#gk-grad-${pal})" stroke="${PALETTE[pal].stroke}" stroke-width="4" stroke-linejoin="round"/>
<!-- robe folds -->
<g stroke="${PALETTE[pal].stroke}" stroke-width="2" opacity="0.6" fill="none">
  <path d="M ${CX - 36} ${CY - 40} L ${CX - 28} ${CY + 70}"/>
  <path d="M ${CX + 36} ${CY - 40} L ${CX + 28} ${CY + 70}"/>
  <path d="M ${CX} ${CY - 50} L ${CX} ${CY + 74}"/>
</g>
<!-- collar trim -->
<path d="M ${CX - 30} ${CY - 60} L ${CX} ${CY - 30} L ${CX + 30} ${CY - 60}"
      fill="none" stroke="${PALETTE[accent].hi}" stroke-width="3"/>
<!-- gloss -->
<path d="M ${CX - 60} ${CY + 70} L ${CX - 44} ${CY - 26} L ${CX - 30} ${CY - 50} L ${CX - 20} ${CY - 30} L ${CX - 30} ${CY + 70} Z"
      fill="${PALETTE.white}" opacity="0.4"/>`;
}

function shapeTrousers(pal, accent) {
  return `
<path d="M ${CX - 48} ${CY - 50}
         L ${CX + 48} ${CY - 50}
         L ${CX + 50} ${CY - 30}
         L ${CX + 32} ${CY + 70}
         L ${CX + 8} ${CY + 70}
         L ${CX + 4} ${CY - 20}
         L ${CX - 4} ${CY - 20}
         L ${CX - 8} ${CY + 70}
         L ${CX - 32} ${CY + 70}
         L ${CX - 50} ${CY - 30} Z"
      fill="url(#gk-grad-${pal})" stroke="${PALETTE[pal].stroke}" stroke-width="4" stroke-linejoin="round"/>
<!-- belt -->
<rect x="${CX - 50}" y="${CY - 50}" width="100" height="12" rx="3"
      fill="url(#gk-grad-${accent})" stroke="${PALETTE[accent].stroke}" stroke-width="2.5"/>
<!-- gloss left leg -->
<path d="M ${CX - 40} ${CY - 26} L ${CX - 28} ${CY + 64} L ${CX - 18} ${CY + 64} L ${CX - 28} ${CY - 26} Z"
      fill="${PALETTE.white}" opacity="0.4"/>`;
}

function shapeBoots(pal, accent) {
  return `
<!-- left boot -->
<path d="M ${CX - 60} ${CY + 60}
         L ${CX - 60} ${CY - 20}
         L ${CX - 32} ${CY - 20}
         L ${CX - 32} ${CY + 40}
         L ${CX - 18} ${CY + 40}
         L ${CX - 16} ${CY + 60} Z"
      fill="url(#gk-grad-${pal})" stroke="${PALETTE[pal].stroke}" stroke-width="4" stroke-linejoin="round"/>
<!-- right boot -->
<path d="M ${CX + 60} ${CY + 60}
         L ${CX + 60} ${CY - 20}
         L ${CX + 32} ${CY - 20}
         L ${CX + 32} ${CY + 40}
         L ${CX + 18} ${CY + 40}
         L ${CX + 16} ${CY + 60} Z"
      fill="url(#gk-grad-${pal})" stroke="${PALETTE[pal].stroke}" stroke-width="4" stroke-linejoin="round"/>
<!-- cuff trim -->
<rect x="${CX - 64}" y="${CY - 24}" width="36" height="10" rx="2" fill="url(#gk-grad-${accent})" stroke="${PALETTE[accent].stroke}" stroke-width="2"/>
<rect x="${CX + 28}" y="${CY - 24}" width="36" height="10" rx="2" fill="url(#gk-grad-${accent})" stroke="${PALETTE[accent].stroke}" stroke-width="2"/>
<!-- sole -->
<rect x="${CX - 62}" y="${CY + 58}" width="48" height="6" rx="2" fill="${PALETTE[pal].stroke}"/>
<rect x="${CX + 14}" y="${CY + 58}" width="48" height="6" rx="2" fill="${PALETTE[pal].stroke}"/>
<!-- gloss on shaft -->
<path d="M ${CX - 54} ${CY + 54} L ${CX - 54} ${CY - 14} L ${CX - 46} ${CY - 14} L ${CX - 44} ${CY + 54} Z"
      fill="${PALETTE.white}" opacity="0.45"/>`;
}

function shapeSandals(pal, accent) {
  return `
<!-- platform soles -->
<rect x="${CX - 64}" y="${CY + 32}" width="46" height="14" rx="6" fill="url(#gk-grad-${pal})" stroke="${PALETTE[pal].stroke}" stroke-width="3"/>
<rect x="${CX + 18}" y="${CY + 32}" width="46" height="14" rx="6" fill="url(#gk-grad-${pal})" stroke="${PALETTE[pal].stroke}" stroke-width="3"/>
<!-- straps -->
<g stroke="url(#gk-grad-${accent})" stroke-width="6" stroke-linecap="round" fill="none">
  <path d="M ${CX - 56} ${CY + 30} L ${CX - 30} ${CY + 8}"/>
  <path d="M ${CX - 48} ${CY + 30} L ${CX - 22} ${CY + 8}"/>
  <path d="M ${CX + 30} ${CY + 8} L ${CX + 56} ${CY + 30}"/>
  <path d="M ${CX + 22} ${CY + 8} L ${CX + 48} ${CY + 30}"/>
</g>`;
}

const ARMOUR_SHAPES = {
  head: {
    cap: shapeCap, hat: shapeCap, crown: shapeCap, hood: shapeHood,
    coif: shapeHelm, helm: shapeHelm, helmet: shapeHelm, mask: shapeCap,
    default: shapeHelm,
  },
  chest: {
    tunic: shapeTunic, vest: shapeTunic, doublet: shapeTunic, robe: shapeRobe,
    robes: shapeRobe, gown: shapeRobe, plate: shapePlate, bulwark: shapePlate,
    cuirass: shapePlate, coat: shapeRobe, cloak: shapeRobe, mail: shapePlate,
    default: shapeTunic,
  },
  legs: {
    trousers: shapeTrousers, pants: shapeTrousers, greaves: shapeTrousers,
    leggings: shapeTrousers, default: shapeTrousers,
  },
  boots: {
    boots: shapeBoots, sabatons: shapeBoots, shoes: shapeBoots,
    sandals: shapeSandals, slippers: shapeSandals, default: shapeBoots,
  },
};

function pickArmourShape(slot, item) {
  const tbl = ARMOUR_SHAPES[slot] || {};
  const lower = item.name.toLowerCase();
  for (const key of Object.keys(tbl)) {
    if (key === 'default') continue;
    if (lower.includes(key)) return tbl[key];
  }
  return tbl.default;
}

// ── Trinket shapes ──────────────────────────────────────────────

function shapeRing(pal, accent) {
  return `
<circle cx="${CX}" cy="${CY + 8}" r="48" fill="none" stroke="url(#gk-grad-${pal})" stroke-width="20"/>
<circle cx="${CX}" cy="${CY + 8}" r="48" fill="none" stroke="${PALETTE[pal].stroke}" stroke-width="3"/>
<circle cx="${CX - 14}" cy="${CY - 12}" r="6" fill="${PALETTE.white}" opacity="0.6"/>
<!-- gem mount -->
<path d="M ${CX - 22} ${CY - 38}
         L ${CX} ${CY - 56}
         L ${CX + 22} ${CY - 38}
         L ${CX + 12} ${CY - 22}
         L ${CX - 12} ${CY - 22} Z"
      fill="url(#gk-grad-${accent})" stroke="${PALETTE[accent].stroke}" stroke-width="3" stroke-linejoin="round"/>
<path d="M ${CX - 14} ${CY - 36} L ${CX} ${CY - 50} L ${CX + 4} ${CY - 30} Z"
      fill="${PALETTE.white}" opacity="0.6"/>`;
}

function shapeAmulet(pal, accent) {
  return `
<!-- chain -->
<path d="M ${CX - 60} ${CY - 50} Q ${CX - 30} ${CY - 70} ${CX} ${CY - 60} Q ${CX + 30} ${CY - 70} ${CX + 60} ${CY - 50}"
      fill="none" stroke="url(#gk-grad-${accent})" stroke-width="4"/>
<!-- gem body -->
<path d="M ${CX} ${CY + 60}
         L ${CX - 36} ${CY + 18}
         L ${CX - 30} ${CY - 30}
         L ${CX} ${CY - 50}
         L ${CX + 30} ${CY - 30}
         L ${CX + 36} ${CY + 18} Z"
      fill="url(#gk-grad-${pal})" stroke="${PALETTE[pal].stroke}" stroke-width="4" stroke-linejoin="round"/>
<path d="M ${CX - 28} ${CY + 16} L ${CX - 22} ${CY - 24} L ${CX - 4} ${CY - 40} L ${CX - 14} ${CY + 24} Z"
      fill="${PALETTE.white}" opacity="0.5"/>
<!-- accent frame -->
<circle cx="${CX}" cy="${CY - 10}" r="14" fill="url(#gk-grad-${accent})" stroke="${PALETTE[accent].stroke}" stroke-width="2.5"/>
<circle cx="${CX}" cy="${CY - 10}" r="8" fill="${PALETTE[pal].lo}"/>`;
}

function shapeOrb(pal, accent) {
  return `
<circle cx="${CX}" cy="${CY}" r="56" fill="url(#gk-rgrad-${pal})" stroke="${PALETTE[pal].stroke}" stroke-width="4"/>
<ellipse cx="${CX - 18}" cy="${CY - 22}" rx="18" ry="10" fill="${PALETTE.white}" opacity="0.7"/>
<!-- gold stand -->
<rect x="${CX - 40}" y="${CY + 56}" width="80" height="12" rx="3"
      fill="url(#gk-grad-${accent})" stroke="${PALETTE[accent].stroke}" stroke-width="2.5"/>
<rect x="${CX - 28}" y="${CY + 48}" width="56" height="10" rx="2"
      fill="url(#gk-grad-${accent})" stroke="${PALETTE[accent].stroke}" stroke-width="2"/>`;
}

function shapeCharm(pal, accent) {
  // Generic feather / fang / coin charm — a small motif hanging on a cord
  return `
<!-- cord -->
<path d="M ${CX - 50} ${CY - 50} Q ${CX} ${CY - 70} ${CX + 50} ${CY - 50}"
      fill="none" stroke="${PALETTE.dark.base}" stroke-width="3"/>
<!-- feather -->
<path d="M ${CX} ${CY + 60}
         Q ${CX - 36} ${CY + 20} ${CX - 18} ${CY - 40}
         Q ${CX} ${CY - 50} ${CX + 18} ${CY - 40}
         Q ${CX + 36} ${CY + 20} ${CX} ${CY + 60} Z"
      fill="url(#gk-grad-${pal})" stroke="${PALETTE[pal].stroke}" stroke-width="3" stroke-linejoin="round"/>
<line x1="${CX}" y1="${CY + 60}" x2="${CX}" y2="${CY - 50}" stroke="${PALETTE[pal].stroke}" stroke-width="2" opacity="0.7"/>
<g stroke="${PALETTE[pal].stroke}" stroke-width="1.5" opacity="0.5">
  <path d="M ${CX} ${CY + 20} L ${CX - 18} ${CY + 4}"/>
  <path d="M ${CX} ${CY + 20} L ${CX + 18} ${CY + 4}"/>
  <path d="M ${CX} ${CY - 4} L ${CX - 16} ${CY - 16}"/>
  <path d="M ${CX} ${CY - 4} L ${CX + 16} ${CY - 16}"/>
  <path d="M ${CX} ${CY - 24} L ${CX - 12} ${CY - 32}"/>
  <path d="M ${CX} ${CY - 24} L ${CX + 12} ${CY - 32}"/>
</g>
<!-- bead at top -->
<circle cx="${CX}" cy="${CY - 56}" r="8" fill="url(#gk-rgrad-${accent})" stroke="${PALETTE[accent].stroke}" stroke-width="2"/>`;
}

const TRINKET_SHAPES = {
  ring: shapeRing, band: shapeRing,
  amulet: shapeAmulet, pendant: shapeAmulet, talisman: shapeAmulet,
  orb: shapeOrb, sphere: shapeOrb, crystal: shapeOrb,
  feather: shapeCharm, charm: shapeCharm, fang: shapeCharm, coin: shapeCharm,
  default: shapeCharm,
};

function pickTrinketShape(item) {
  const lower = item.name.toLowerCase();
  for (const key of Object.keys(TRINKET_SHAPES)) {
    if (key === 'default') continue;
    if (lower.includes(key)) return TRINKET_SHAPES[key];
  }
  return TRINKET_SHAPES.default;
}

// ── Per-item render ─────────────────────────────────────────────

function safeId(item) {
  const slug = item.name.toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${item.slot}-${item.rarity}-${slug}`;
}

function pickAccent(item, basePal) {
  // Accent should contrast the body palette. Heuristics:
  //   rare/epic/legendary/mythic → gold or rarity colour
  //   common/uncommon → wood/cream for warmth
  if (item.rarity === 'legendary' || item.rarity === 'mythic') return 'gold';
  if (item.rarity === 'epic') return 'amethyst';
  if (item.rarity === 'rare') return 'sapphire';
  if (basePal === 'gold') return 'ruby';
  if (basePal === 'wood') return 'gold';
  return 'gold';
}

// ── Per-item motif (K4 uniqueness pass) ─────────────────────────
//
// Templates above give one shape per (slot, weaponType, subtype).
// Without further differentiation, "Knight's Sword" + "Bronze
// Shortsword" + "Steel Longsword" read as recolours of the same
// silhouette. Each item now also gets a unique inscribed motif —
// a small badge / emblem / gem clipped onto a slot-specific
// anchor — so the eye picks up "this is a DIFFERENT item" even
// across siblings.
//
// Motif kind selection:
//   1. Keyword match against item.name + item.setName (fire→flame,
//      frost→snowflake, shadow→eye, etc.) — most semantic.
//   2. Deterministic hash fallback so unmatched items pick a
//      consistent motif from the library.
//
// Per-slot anchor (where the motif sits on the icon's template):
//   weapon  — pommel (just below the grip)
//   head    — forehead (center-front of helmet)
//   chest   — chest-medallion (center of torso)
//   legs    — belt-buckle (top-center of trousers)
//   boots   — ankle clasp (top-center between boot cuffs)
//   trinket — gem center (overlay on existing gem)
//
// Motif colour resolved from item.setName / item.rarity / item.
// preferredClass so set-pieces share an emblem hue.

const MOTIF_LIB = {
  flame: (cx, cy, c) => `
<path d="M ${cx} ${cy - 8}
         Q ${cx - 5} ${cy - 2} ${cx - 3} ${cy + 4}
         Q ${cx - 1} ${cy + 1} ${cx} ${cy - 2}
         Q ${cx + 1} ${cy + 1} ${cx + 3} ${cy + 4}
         Q ${cx + 5} ${cy - 2} ${cx} ${cy - 8} Z"
      fill="${c}" stroke="${PALETTE.ink}" stroke-width="0.8" stroke-linejoin="round"/>`,
  snowflake: (cx, cy, c) => `
<g stroke="${c}" stroke-width="1.6" stroke-linecap="round" fill="none">
  <line x1="${cx}"    y1="${cy - 8}" x2="${cx}"    y2="${cy + 8}"/>
  <line x1="${cx - 7}" y1="${cy - 4}" x2="${cx + 7}" y2="${cy + 4}"/>
  <line x1="${cx - 7}" y1="${cy + 4}" x2="${cx + 7}" y2="${cy - 4}"/>
  <line x1="${cx - 2}" y1="${cy - 6}" x2="${cx + 2}" y2="${cy - 6}"/>
  <line x1="${cx - 2}" y1="${cy + 6}" x2="${cx + 2}" y2="${cy + 6}"/>
</g>`,
  star: (cx, cy, c) => `
<path d="M ${cx} ${cy - 8}
         L ${cx + 2.5} ${cy - 2}
         L ${cx + 8} ${cy - 1}
         L ${cx + 3.5} ${cy + 3}
         L ${cx + 5} ${cy + 8}
         L ${cx} ${cy + 5}
         L ${cx - 5} ${cy + 8}
         L ${cx - 3.5} ${cy + 3}
         L ${cx - 8} ${cy - 1}
         L ${cx - 2.5} ${cy - 2} Z"
      fill="${c}" stroke="${PALETTE.ink}" stroke-width="0.8" stroke-linejoin="round"/>`,
  skull: (cx, cy, c) => `
<g fill="${c}" stroke="${PALETTE.ink}" stroke-width="0.8" stroke-linejoin="round">
  <path d="M ${cx} ${cy - 8} Q ${cx - 7} ${cy - 7} ${cx - 7} ${cy - 1} L ${cx - 7} ${cy + 3} L ${cx - 4} ${cy + 6} L ${cx + 4} ${cy + 6} L ${cx + 7} ${cy + 3} L ${cx + 7} ${cy - 1} Q ${cx + 7} ${cy - 7} ${cx} ${cy - 8} Z"/>
</g>
<circle cx="${cx - 3}" cy="${cy - 1}" r="1.4" fill="${PALETTE.ink}"/>
<circle cx="${cx + 3}" cy="${cy - 1}" r="1.4" fill="${PALETTE.ink}"/>`,
  eye: (cx, cy, c) => `
<path d="M ${cx - 8} ${cy} Q ${cx} ${cy - 6} ${cx + 8} ${cy} Q ${cx} ${cy + 6} ${cx - 8} ${cy} Z"
      fill="${PALETTE.cream.hi}" stroke="${PALETTE.ink}" stroke-width="0.9"/>
<circle cx="${cx}" cy="${cy}" r="3" fill="${c}"/>
<circle cx="${cx}" cy="${cy}" r="1.2" fill="${PALETTE.ink}"/>`,
  leaf: (cx, cy, c) => `
<path d="M ${cx - 8} ${cy + 6} Q ${cx - 4} ${cy - 8} ${cx + 8} ${cy - 8} Q ${cx + 4} ${cy + 6} ${cx - 8} ${cy + 6} Z"
      fill="${c}" stroke="${PALETTE.ink}" stroke-width="0.8" stroke-linejoin="round"/>
<path d="M ${cx - 6} ${cy + 4} Q ${cx} ${cy - 2} ${cx + 6} ${cy - 6}" fill="none" stroke="${PALETTE.ink}" stroke-width="0.6" opacity="0.7"/>`,
  rose: (cx, cy, c) => `
<g fill="${c}" stroke="${PALETTE.ink}" stroke-width="0.6">
  <circle cx="${cx}" cy="${cy}" r="6"/>
  <circle cx="${cx - 3}" cy="${cy - 2}" r="3" opacity="0.85"/>
  <circle cx="${cx + 3}" cy="${cy + 1}" r="2.5" opacity="0.85"/>
  <circle cx="${cx}" cy="${cy + 2}" r="1.5" fill="${PALETTE.ink}"/>
</g>`,
  bolt: (cx, cy, c) => `
<path d="M ${cx + 2} ${cy - 8}
         L ${cx - 4} ${cy + 1}
         L ${cx - 1} ${cy + 1}
         L ${cx - 2} ${cy + 8}
         L ${cx + 4} ${cy - 1}
         L ${cx + 1} ${cy - 1} Z"
      fill="${c}" stroke="${PALETTE.ink}" stroke-width="0.8" stroke-linejoin="round"/>`,
  crescent: (cx, cy, c) => `
<path d="M ${cx + 5} ${cy - 8}
         A 8 8 0 1 0 ${cx + 5} ${cy + 8}
         A 6 6 0 1 1 ${cx + 5} ${cy - 8} Z"
      fill="${c}" stroke="${PALETTE.ink}" stroke-width="0.8" stroke-linejoin="round"/>`,
  sun: (cx, cy, c) => `
<g fill="${c}" stroke="${PALETTE.ink}" stroke-width="0.6">
  <circle cx="${cx}" cy="${cy}" r="4"/>
  ${[0,1,2,3,4,5,6,7].map(i => {
    const a = i * Math.PI / 4;
    const x1 = cx + Math.cos(a) * 6, y1 = cy + Math.sin(a) * 6;
    const x2 = cx + Math.cos(a) * 9, y2 = cy + Math.sin(a) * 9;
    return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${c}" stroke-width="1.6"/>`;
  }).join('')}
</g>`,
  drop: (cx, cy, c) => `
<path d="M ${cx} ${cy - 8} Q ${cx - 6} ${cy - 2} ${cx - 6} ${cy + 2} Q ${cx - 6} ${cy + 7} ${cx} ${cy + 7} Q ${cx + 6} ${cy + 7} ${cx + 6} ${cy + 2} Q ${cx + 6} ${cy - 2} ${cx} ${cy - 8} Z"
      fill="${c}" stroke="${PALETTE.ink}" stroke-width="0.8" stroke-linejoin="round"/>`,
  fang: (cx, cy, c) => `
<path d="M ${cx} ${cy + 8} L ${cx - 4} ${cy - 6} L ${cx} ${cy - 8} L ${cx + 4} ${cy - 6} Z"
      fill="${c}" stroke="${PALETTE.ink}" stroke-width="0.8" stroke-linejoin="round"/>`,
  hand: (cx, cy, c) => `
<g fill="${c}" stroke="${PALETTE.ink}" stroke-width="0.6">
  <rect x="${cx - 5}" y="${cy - 4}" width="10" height="9" rx="2"/>
  <rect x="${cx - 4}" y="${cy - 9}" width="2" height="5" rx="0.5"/>
  <rect x="${cx - 1.5}" y="${cy - 10}" width="2" height="6" rx="0.5"/>
  <rect x="${cx + 1}" y="${cy - 9}" width="2" height="5" rx="0.5"/>
  <rect x="${cx + 3.5}" y="${cy - 8}" width="2" height="4" rx="0.5"/>
</g>`,
  anchor: (cx, cy, c) => `
<g fill="none" stroke="${c}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
  <line x1="${cx}" y1="${cy - 7}" x2="${cx}" y2="${cy + 7}"/>
  <line x1="${cx - 3}" y1="${cy - 5}" x2="${cx + 3}" y2="${cy - 5}"/>
  <path d="M ${cx - 6} ${cy + 3} Q ${cx - 6} ${cy + 7} ${cx} ${cy + 7} Q ${cx + 6} ${cy + 7} ${cx + 6} ${cy + 3}"/>
</g>
<circle cx="${cx}" cy="${cy - 7}" r="1.4" fill="${c}"/>`,
  key: (cx, cy, c) => `
<g fill="${c}" stroke="${PALETTE.ink}" stroke-width="0.7">
  <circle cx="${cx - 4}" cy="${cy}" r="4"/>
  <circle cx="${cx - 4}" cy="${cy}" r="1.5" fill="${PALETTE.ink}"/>
  <rect x="${cx - 1}" y="${cy - 1}" width="9" height="2.5" rx="0.5"/>
  <rect x="${cx + 5}" y="${cy + 1.5}" width="2" height="2.5"/>
  <rect x="${cx + 2}" y="${cy + 1.5}" width="2" height="2.5"/>
</g>`,
  crown: (cx, cy, c) => `
<g fill="${c}" stroke="${PALETTE.ink}" stroke-width="0.7" stroke-linejoin="round">
  <path d="M ${cx - 7} ${cy + 5} L ${cx - 7} ${cy - 1} L ${cx - 4} ${cy + 1} L ${cx - 2} ${cy - 4} L ${cx} ${cy + 1} L ${cx + 2} ${cy - 4} L ${cx + 4} ${cy + 1} L ${cx + 7} ${cy - 1} L ${cx + 7} ${cy + 5} Z"/>
  <circle cx="${cx}" cy="${cy - 2}" r="1.2" fill="${PALETTE.ruby.hi}"/>
</g>`,
  hammer: (cx, cy, c) => `
<g fill="${c}" stroke="${PALETTE.ink}" stroke-width="0.7" stroke-linejoin="round">
  <rect x="${cx - 6}" y="${cy - 5}" width="12" height="5" rx="1"/>
  <rect x="${cx - 1}" y="${cy}" width="2" height="8" rx="0.5" fill="url(#gk-grad-wood)"/>
</g>`,
  gear: (cx, cy, c) => `
<g fill="${c}" stroke="${PALETTE.ink}" stroke-width="0.6">
  ${[0,1,2,3,4,5].map(i => {
    const a = i * Math.PI / 3;
    const x = cx + Math.cos(a) * 6.5;
    const y = cy + Math.sin(a) * 6.5;
    return `<rect x="${(x - 1.5).toFixed(1)}" y="${(y - 1.5).toFixed(1)}" width="3" height="3" transform="rotate(${(i * 60).toFixed(0)} ${x.toFixed(1)} ${y.toFixed(1)})"/>`;
  }).join('')}
  <circle cx="${cx}" cy="${cy}" r="4"/>
  <circle cx="${cx}" cy="${cy}" r="1.5" fill="${PALETTE.ink}"/>
</g>`,
  scroll: (cx, cy, c) => `
<g fill="${PALETTE.cream.hi}" stroke="${PALETTE.ink}" stroke-width="0.7">
  <rect x="${cx - 7}" y="${cy - 4}" width="14" height="8" rx="1.5"/>
  <line x1="${cx - 4}" y1="${cy - 1}" x2="${cx + 4}" y2="${cy - 1}" stroke="${c}" stroke-width="1"/>
  <line x1="${cx - 4}" y1="${cy + 2}" x2="${cx + 4}" y2="${cy + 2}" stroke="${c}" stroke-width="1"/>
</g>`,
  feather: (cx, cy, c) => `
<g fill="${c}" stroke="${PALETTE.ink}" stroke-width="0.7" stroke-linejoin="round">
  <path d="M ${cx + 6} ${cy - 7} Q ${cx - 4} ${cy - 4} ${cx - 6} ${cy + 7} Q ${cx} ${cy + 5} ${cx + 6} ${cy - 7} Z"/>
  <line x1="${cx + 6}" y1="${cy - 7}" x2="${cx - 6}" y2="${cy + 7}" stroke="${PALETTE.ink}" stroke-width="0.6" opacity="0.5"/>
</g>`,
  cross: (cx, cy, c) => `
<g fill="${c}" stroke="${PALETTE.ink}" stroke-width="0.7">
  <rect x="${cx - 1.5}" y="${cy - 8}" width="3" height="16" rx="0.5"/>
  <rect x="${cx - 7}" y="${cy - 1.5}" width="14" height="3" rx="0.5"/>
</g>`,
  ankh: (cx, cy, c) => `
<g fill="none" stroke="${c}" stroke-width="1.7" stroke-linecap="round">
  <circle cx="${cx}" cy="${cy - 4}" r="3.5"/>
  <line x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy + 8}"/>
  <line x1="${cx - 5}" y1="${cy + 2}" x2="${cx + 5}" y2="${cy + 2}"/>
</g>`,
  rune: (cx, cy, c) => `
<g fill="none" stroke="${c}" stroke-width="1.7" stroke-linecap="round">
  <line x1="${cx}" y1="${cy - 7}" x2="${cx}" y2="${cy + 7}"/>
  <line x1="${cx - 5}" y1="${cy - 7}" x2="${cx + 5}" y2="${cy - 3}"/>
  <line x1="${cx - 5}" y1="${cy + 3}" x2="${cx + 5}" y2="${cy + 7}"/>
</g>`,
  diamond: (cx, cy, c) => `
<path d="M ${cx} ${cy - 8} L ${cx + 6} ${cy} L ${cx} ${cy + 8} L ${cx - 6} ${cy} Z"
      fill="${c}" stroke="${PALETTE.ink}" stroke-width="0.8" stroke-linejoin="round"/>
<path d="M ${cx - 3} ${cy} L ${cx} ${cy - 5} L ${cx + 3} ${cy} L ${cx} ${cy + 5} Z"
      fill="${PALETTE.white}" opacity="0.45"/>`,
  bone: (cx, cy, c) => `
<g fill="${c}" stroke="${PALETTE.ink}" stroke-width="0.6">
  <ellipse cx="${cx - 5}" cy="${cy - 5}" rx="2.5" ry="2"/>
  <ellipse cx="${cx + 5}" cy="${cy - 5}" rx="2.5" ry="2"/>
  <ellipse cx="${cx - 5}" cy="${cy + 5}" rx="2.5" ry="2"/>
  <ellipse cx="${cx + 5}" cy="${cy + 5}" rx="2.5" ry="2"/>
  <rect x="${cx - 4}" y="${cy - 6}" width="8" height="12" rx="1.5"/>
</g>`,
  shield: (cx, cy, c) => `
<path d="M ${cx} ${cy - 8} L ${cx - 6} ${cy - 5} L ${cx - 6} ${cy + 2} Q ${cx - 6} ${cy + 7} ${cx} ${cy + 8} Q ${cx + 6} ${cy + 7} ${cx + 6} ${cy + 2} L ${cx + 6} ${cy - 5} Z"
      fill="${c}" stroke="${PALETTE.ink}" stroke-width="0.7" stroke-linejoin="round"/>
<line x1="${cx}" y1="${cy - 5}" x2="${cx}" y2="${cy + 6}" stroke="${PALETTE.ink}" stroke-width="0.6" opacity="0.5"/>`,
};

// Name/setName keyword → motif library key.
const MOTIF_KEYWORDS = [
  [/fire|flame|ember|inferno|burn|phoenix|drake|dragon/i, 'flame'],
  [/frost|ice|snow|frozen|winter|tundra|chill/i,         'snowflake'],
  [/shadow|dark|void|night|umbra/i,                       'eye'],
  [/leaf|forest|nature|druid|wild|verdant|grove/i,        'leaf'],
  [/sun|solar|radiant|golden|saint|holy|divine/i,         'sun'],
  [/moon|lunar|night/i,                                    'crescent'],
  [/star|astral|stellar|cosmic/i,                          'star'],
  [/storm|thunder|lightning|voltaic|bolt|tempest|stormcaller/i, 'bolt'],
  [/rose|bloom|petal|garden/i,                             'rose'],
  [/water|tide|ocean|sea|wave|coral|reef|drop|aqua/i,      'drop'],
  [/fang|tooth|wolf|beast|claw|tusk/i,                     'fang'],
  [/grip|hand|gauntlet|finger/i,                           'hand'],
  [/anchor|sailor|sea|harbour/i,                           'anchor'],
  [/key|lock|warden|guard|jailer/i,                        'key'],
  [/king|queen|royal|crown|highborn|noble|monarch|prince|princess/i, 'crown'],
  [/forge|hammer|smith|anvil|sapper/i,                     'hammer'],
  [/gear|cog|mech|clockwork|engineer/i,                    'gear'],
  [/scroll|arcane|spell|tome|grimoire|witch|wizard|mage/i, 'scroll'],
  [/feather|crow|raven|wing|bird|hunter|ranger|sky/i,      'feather'],
  [/cross|paladin|crusader/i,                              'cross'],
  [/ankh|life|vitality|vestal|healer/i,                    'ankh'],
  [/rune|elder|ancient|seer/i,                             'rune'],
  [/gem|crystal|diamond|ruby|sapphire|emerald|amethyst/i,  'diamond'],
  [/bone|skull|necro|undead|reaper/i,                      'bone'],
  [/ward|shield|aegis|bulwark|defender/i,                  'shield'],
  [/skull|death|reaper|grim/i,                             'skull'],
];

const MOTIF_KEYS = Object.keys(MOTIF_LIB);

function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return h >>> 0;
}

function pickMotifKey(item) {
  const txt = `${item.name} ${item.setName}`;
  for (const [re, key] of MOTIF_KEYWORDS) if (re.test(txt)) return key;
  return MOTIF_KEYS[djb2(item.name) % MOTIF_KEYS.length];
}

function pickMotifColor(item, basePal) {
  // Set-piece items share a hue (setName-hashed); otherwise rarity-tinted.
  if (item.setName) {
    const setHues = ['#FFD970', '#FF7A8C', '#5BDD96', '#5A9EF7', '#B581FF', '#7BD15A', '#FFE082', '#A8D9FF'];
    return setHues[djb2(item.setName) % setHues.length];
  }
  // Default = rarity ring colour for crisp tint
  if (RARITY[item.rarity]) return RARITY[item.rarity].ring;
  // Final fallback — gold against most palettes
  void basePal;
  return PALETTE.gold.hi;
}

// Anchor for the motif on the icon canvas, per slot. Positions
// picked to land on visible empty space outside the dominant
// template silhouette (not behind/under the existing shape).
function motifAnchor(slot) {
  switch (slot) {
    // weapon: upper-right of canvas, off to the side of the blade,
    // so swords/axes/staffs all get a clear inscribed crest area.
    case 'weapon':  return { cx: CX + 56, cy: CY - 60, r: 12 };
    // head: forehead/visor band — sits on most helm/hood/cap templates
    case 'head':    return { cx: CX,      cy: CY + 6,  r: 12 };
    // chest: middle of torso — most templates leave a clear centre
    case 'chest':   return { cx: CX,      cy: CY + 30, r: 12 };
    // legs: belt buckle position
    case 'legs':    return { cx: CX,      cy: CY - 50, r: 11 };
    // boots: between the two boots at the cuff line
    case 'boots':   return { cx: CX,      cy: CY - 28, r: 11 };
    // trinket: gem centre — sits on top of the existing gem mount
    case 'trinket': return { cx: CX,      cy: CY + 60, r: 11 };
    default:        return { cx: CX,      cy: CY,      r: 11 };
  }
}

function renderMotif(item) {
  const key = pickMotifKey(item);
  const color = pickMotifColor(item, null);
  const anchor = motifAnchor(item.slot);
  const fn = MOTIF_LIB[key];
  if (!fn) return '';
  // Small inscribed coin behind the motif so it reads against
  // any underlying gradient. Inked outline + rarity-tint ring.
  const coinBg = `<circle cx="${anchor.cx}" cy="${anchor.cy}" r="${anchor.r}" fill="${PALETTE.ink}" opacity="0.62"/>
                  <circle cx="${anchor.cx}" cy="${anchor.cy}" r="${anchor.r}" fill="none" stroke="${color}" stroke-width="1.3" opacity="0.95"/>`;
  return coinBg + '\n' + fn(anchor.cx, anchor.cy, color);
}

function renderItem(item) {
  const pal = pickPalette(item);
  const accent = pickAccent(item, pal);
  let shape;
  if (item.slot === 'weapon') {
    const wt = (item.weaponType || '').toLowerCase();
    shape = WEAPON_SHAPES[wt] || shapeSword;
  } else if (item.slot === 'trinket') {
    shape = pickTrinketShape(item);
  } else {
    shape = pickArmourShape(item.slot, item);
  }
  // Rarity glow + contact shadow.
  const glow = rarityGlow({ rarity: item.rarity, cx: CX, cy: CY, rx: 72, ry: 72 });
  const shadow = contactShadow({ cx: CX, cy: H - 16, rx: 60, ry: 9 });
  // Inner rarity ring (subtle border for higher rarities).
  const ring = (['rare', 'epic', 'legendary', 'mythic'].includes(item.rarity))
    ? `<circle cx="${CX}" cy="${CY}" r="86" fill="none" stroke="${RARITY[item.rarity].ring}" stroke-width="2" opacity="0.55"/>`
    : '';
  const motif = renderMotif(item);
  return `
${glow}
${shadow}
${ring}
${shape(pal, accent)}
${motif}
`;
}

// ── Render all items ────────────────────────────────────────────

const indexEntries = [];
let written = 0;
for (const item of items) {
  const body = renderItem(item);
  const svg = svgWrapper({
    width: W, height: H,
    body,
    title: `${item.name} — ${item.rarity}`,
    desc: `Loadout gear icon. slot=${item.slot} rarity=${item.rarity} weaponType=${item.weaponType}.`,
  });
  const id = safeId(item);
  const out = join(OUT_BASE, item.slot, `${id}.svg`);
  writeFileSync(out, svg);
  indexEntries.push({
    id, name: item.name, slot: item.slot, rarity: item.rarity,
    setName: item.setName, weaponType: item.weaponType,
    preferredClass: item.preferredClass, ability: item.ability,
    file: `${item.slot}/${id}.svg`,
  });
  written++;
}

// Write catalogue index.
writeFileSync(join(OUT_BASE, '_catalog.json'), JSON.stringify(indexEntries, null, 2));

console.log(`\n✓ rendered ${written} gear icons + _catalog.json index`);
console.log(`  weapons: ${indexEntries.filter(e => e.slot === 'weapon').length}`);
console.log(`  head:    ${indexEntries.filter(e => e.slot === 'head').length}`);
console.log(`  chest:   ${indexEntries.filter(e => e.slot === 'chest').length}`);
console.log(`  legs:    ${indexEntries.filter(e => e.slot === 'legs').length}`);
console.log(`  boots:   ${indexEntries.filter(e => e.slot === 'boots').length}`);
console.log(`  trinket: ${indexEntries.filter(e => e.slot === 'trinket').length}`);
