// Glossy Clash troops + backdrop — Wave 3.
//
// Troops are small character figurines (192×192). The art idiom is
// the same as the buildings — gradient body lit upper-left, dark
// inked outline, gloss highlights, gold/coloured accents — but the
// silhouette is character-scaled.
//
// Each troop builds from a shared `troopFigure` archetype: contact
// shadow → cape/wing/back-layer if any → body shape → head shape →
// weapon → accent details. Per-kind functions only specify their
// distinctive shapes; the archetype handles the consistent
// lighting + outline pass.
//
// Output:
//   aquilo-gg/sprites/clash-v2/glossy/troops/<id>.svg
//   aquilo-gg/sprites/clash-v2/glossy/backdrop/<layer>.svg
//
// Run:  node tools/build-clash-troops-glossy.mjs

import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  PALETTE,
  contactShadow,
  glossyRoundedRect,
  glossyEllipse,
  svgWrapper,
} from './glossy-art-kit.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const TROOP_DIR = join(ROOT, 'aquilo-gg/sprites/clash-v2/glossy/troops');
const BACK_DIR  = join(ROOT, 'aquilo-gg/sprites/clash-v2/glossy/backdrop');
mkdirSync(TROOP_DIR, { recursive: true });
mkdirSync(BACK_DIR,  { recursive: true });

const W = 192, H = 192;
const GROUND_Y = 170;
const SHADOW = contactShadow({ cx: W/2, cy: GROUND_Y + 6, rx: 54, ry: 9 });

// ── Troop archetype helpers ─────────────────────────────────────

// Body bean — torso/legs in one rounded shape. Bottom-anchored at GROUND_Y.
function bodyBean({ cx = W/2, top = 96, bottom = GROUND_Y, w = 60, color = 'wood' }) {
  const halfW = w / 2;
  return `
<path d="M ${cx - halfW} ${bottom}
         L ${cx - halfW} ${top + halfW}
         Q ${cx - halfW} ${top} ${cx} ${top}
         Q ${cx + halfW} ${top} ${cx + halfW} ${top + halfW}
         L ${cx + halfW} ${bottom} Z"
      fill="url(#gk-grad-${color})" stroke="${PALETTE[color].stroke}" stroke-width="3.5" stroke-linejoin="round"/>
<path d="M ${cx - halfW + 4} ${bottom - 4}
         L ${cx - halfW + 4} ${top + halfW}
         Q ${cx - halfW + 4} ${top + 4} ${cx} ${top + 4}
         Q ${cx} ${bottom * 0.55} ${cx - halfW + 6} ${bottom * 0.7}
         L ${cx - halfW + 6} ${bottom - 6} Z"
      fill="url(#gk-gloss)" opacity="0.55" pointer-events="none"/>`;
}

// Head circle. Tone is a face/skin or monster colour.
function head({ cx = W/2, cy = 78, r = 26, color = 'cream' }) {
  const pal = PALETTE[color];
  return `
<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#gk-rgrad-${color})" stroke="${pal.stroke}" stroke-width="3.5"/>
<ellipse cx="${cx - r * 0.35}" cy="${cy - r * 0.4}" rx="${r * 0.45}" ry="${r * 0.25}" fill="${PALETTE.white}" opacity="0.5"/>`;
}

// Eyes — simple dark dots, can be glowing for monsters.
function eyes({ cx = W/2, cy = 76, gap = 10, color = PALETTE.ink, glow = false }) {
  if (glow) {
    return `
<circle cx="${cx - gap}" cy="${cy}" r="4" fill="${color}"/>
<circle cx="${cx + gap}" cy="${cy}" r="4" fill="${color}"/>
<circle cx="${cx - gap}" cy="${cy}" r="2" fill="${PALETTE.white}" opacity="0.9"/>
<circle cx="${cx + gap}" cy="${cy}" r="2" fill="${PALETTE.white}" opacity="0.9"/>`;
  }
  return `
<circle cx="${cx - gap}" cy="${cy}" r="3" fill="${color}"/>
<circle cx="${cx + gap}" cy="${cy}" r="3" fill="${color}"/>`;
}

// Helmet — half-dome on top of the head.
function helmet({ cx = W/2, cy = 78, r = 26, color = 'iron', plume = null }) {
  const pal = PALETTE[color];
  const out = [
    `<path d="M ${cx - r - 2} ${cy} A ${r + 2} ${r + 2} 0 0 1 ${cx + r + 2} ${cy} Z"
            fill="url(#gk-grad-${color})" stroke="${pal.stroke}" stroke-width="3.5" stroke-linejoin="round"/>`,
    `<rect x="${cx - r - 4}" y="${cy - 4}" width="${2 * r + 8}" height="6" rx="2"
            fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="2"/>`,
  ];
  if (plume) {
    out.push(`<path d="M ${cx} ${cy - r - 18}
                       Q ${cx + 10} ${cy - r - 26} ${cx + 4} ${cy - r}
                       Q ${cx} ${cy - r - 10} ${cx - 4} ${cy - r}
                       Q ${cx - 10} ${cy - r - 26} ${cx} ${cy - r - 18} Z"
                     fill="url(#gk-grad-${plume})" stroke="${PALETTE[plume].stroke}" stroke-width="2" stroke-linejoin="round"/>`);
  }
  return out.join('\n');
}

// Sword. `lean` rotates it (degrees from vertical).
function sword({ x, yBase, length = 60, lean = -20, bladeColor = 'steel', hiltColor = 'gold' }) {
  return `
<g transform="rotate(${lean} ${x} ${yBase})">
  <rect x="${x - 3}" y="${yBase - length}" width="6" height="${length - 14}" rx="2"
        fill="url(#gk-grad-${bladeColor})" stroke="${PALETTE[bladeColor].stroke}" stroke-width="2"/>
  <rect x="${x - 12}" y="${yBase - 16}" width="24" height="6" rx="2"
        fill="url(#gk-grad-${hiltColor})" stroke="${PALETTE[hiltColor].stroke}" stroke-width="1.5"/>
  <rect x="${x - 3}" y="${yBase - 12}" width="6" height="12" rx="2"
        fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="1.5"/>
</g>`;
}

// Bow. Held vertically by the figure.
function bow({ cx, yBase, height = 70, color = 'wood' }) {
  return `
<g>
  <path d="M ${cx - 14} ${yBase - height + 12}
           Q ${cx - 30} ${yBase - height/2} ${cx - 14} ${yBase - 12}"
        fill="none" stroke="url(#gk-grad-${color})" stroke-width="6" stroke-linecap="round"/>
  <line x1="${cx - 16}" y1="${yBase - height + 16}" x2="${cx - 16}" y2="${yBase - 16}"
        stroke="${PALETTE.ink}" stroke-width="1.5"/>
</g>`;
}

// Staff. Tall vertical pole with a glowing orb at the top.
function staff({ cx, yBase, height = 110, orbColor = 'amethyst' }) {
  return `
<rect x="${cx - 3}" y="${yBase - height}" width="6" height="${height}" rx="2"
      fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="2"/>
<circle cx="${cx}" cy="${yBase - height + 6}" r="11"
        fill="url(#gk-rgrad-${orbColor})" stroke="${PALETTE[orbColor].stroke}" stroke-width="2.5"/>
<circle cx="${cx - 3}" cy="${yBase - height + 3}" r="3" fill="${PALETTE.white}" opacity="0.7"/>`;
}

// Hammer (heavy mallet).
function hammer({ x, yBase, lean = -15, headColor = 'iron' }) {
  return `
<g transform="rotate(${lean} ${x} ${yBase})">
  <rect x="${x - 3}" y="${yBase - 50}" width="6" height="42" rx="2"
        fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="2"/>
  <rect x="${x - 16}" y="${yBase - 62}" width="32" height="18" rx="3"
        fill="url(#gk-grad-${headColor})" stroke="${PALETTE[headColor].stroke}" stroke-width="2.5"/>
  <rect x="${x - 12}" y="${yBase - 58}" width="24" height="3" fill="${PALETTE.white}" opacity="0.5"/>
</g>`;
}

// Wings — angel/skyrider style.
function wings({ cx, cy, span = 70, color = 'cream' }) {
  return `
<path d="M ${cx - 6} ${cy}
         Q ${cx - 40} ${cy - 14} ${cx - span} ${cy - 8}
         Q ${cx - span + 16} ${cy + 6} ${cx - 6} ${cy + 14} Z"
      fill="url(#gk-grad-${color})" stroke="${PALETTE[color].stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<path d="M ${cx + 6} ${cy}
         Q ${cx + 40} ${cy - 14} ${cx + span} ${cy - 8}
         Q ${cx + span - 16} ${cy + 6} ${cx + 6} ${cy + 14} Z"
      fill="url(#gk-grad-${color})" stroke="${PALETTE[color].stroke}" stroke-width="2.5" stroke-linejoin="round"/>`;
}

// ── Per-troop bodies ────────────────────────────────────────────

// Player troops
function scrapper() {
  return `${SHADOW}
${bodyBean({ color: 'iron' })}
${head({ color: 'cream' })}
${eyes({})}
${helmet({ color: 'iron' })}
<!-- shoulder pad -->
<ellipse cx="${W/2 - 26}" cy="106" rx="10" ry="7" fill="url(#gk-rgrad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="2"/>
<!-- hammer -->
${hammer({ x: W/2 + 22, yBase: 160 })}
`;
}

function boltKnight() {
  return `${SHADOW}
${bodyBean({ color: 'steel', w: 64 })}
<!-- chest emblem -->
<path d="M ${W/2} 116 L ${W/2 - 10} 132 L ${W/2 + 4} 130 L ${W/2 - 2} 150 L ${W/2 + 10} 130 L ${W/2 - 4} 132 Z"
      fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="2"/>
${head({ color: 'cream' })}
${eyes({})}
${helmet({ color: 'steel', plume: 'sapphire' })}
${sword({ x: W/2 + 28, yBase: 156, length: 68, hiltColor: 'gold' })}
<!-- shield on left -->
<rect x="${W/2 - 36}" y="106" width="20" height="40" rx="6"
      fill="url(#gk-grad-sapphire)" stroke="${PALETTE.sapphire.stroke}" stroke-width="2.5"/>
<circle cx="${W/2 - 26}" cy="124" r="5" fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1.5"/>
`;
}

function voltaicMage() {
  return `${SHADOW}
${bodyBean({ color: 'amethyst', w: 56 })}
<!-- robe trim -->
<rect x="${W/2 - 28}" y="156" width="56" height="10" rx="3"
      fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1.5"/>
${head({ color: 'cream' })}
${eyes({})}
<!-- pointed hood -->
<path d="M ${W/2 - 28} 76 Q ${W/2} 36 ${W/2 + 28} 76 Q ${W/2 + 12} 92 ${W/2} 90 Q ${W/2 - 12} 92 ${W/2 - 28} 76 Z"
      fill="url(#gk-grad-amethyst)" stroke="${PALETTE.amethyst.stroke}" stroke-width="3" stroke-linejoin="round"/>
${staff({ cx: W/2 + 36, yBase: 160 })}
<!-- spark fx -->
<circle cx="${W/2 + 36}" cy="56" r="4" fill="${PALETTE.amethyst.hi}" opacity="0.9"/>
`;
}

function archerLite() {
  return `${SHADOW}
${bodyBean({ color: 'leaf', w: 52 })}
${head({ color: 'cream' })}
${eyes({})}
<!-- hood -->
<path d="M ${W/2 - 26} 76 Q ${W/2} 46 ${W/2 + 26} 76 Q ${W/2 + 20} 78 ${W/2 + 14} 70 L ${W/2 + 8} 72 Q ${W/2} 70 ${W/2 - 8} 72 L ${W/2 - 14} 70 Q ${W/2 - 20} 78 ${W/2 - 26} 76 Z"
      fill="url(#gk-grad-leaf)" stroke="${PALETTE.leaf.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
${bow({ cx: W/2 + 26, yBase: 160 })}
<!-- quiver -->
<rect x="${W/2 - 38}" y="108" width="12" height="36" rx="3"
      fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="2"/>
<g stroke="${PALETTE.wood.stroke}" stroke-width="1.5">
  <line x1="${W/2 - 36}" y1="108" x2="${W/2 - 36}" y2="98"/>
  <line x1="${W/2 - 32}" y1="108" x2="${W/2 - 32}" y2="96"/>
  <line x1="${W/2 - 28}" y1="108" x2="${W/2 - 28}" y2="98"/>
</g>
`;
}

function healerCleric() {
  return `${SHADOW}
${bodyBean({ color: 'cream', w: 56 })}
<!-- gold sash + cross -->
<rect x="${W/2 - 24}" y="124" width="48" height="8" rx="2" fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1.5"/>
<rect x="${W/2 - 4}" y="120" width="8" height="20" rx="2" fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1.5"/>
${head({ color: 'cream' })}
${eyes({})}
<!-- halo -->
<ellipse cx="${W/2}" cy="56" rx="22" ry="6" fill="none" stroke="${PALETTE.gold.hi}" stroke-width="3"/>
${staff({ cx: W/2 + 32, yBase: 160, orbColor: 'gold' })}
`;
}

function skyrider() {
  return `${SHADOW}
${wings({ cx: W/2, cy: 110, span: 76, color: 'sky' })}
${bodyBean({ color: 'steel', w: 50, top: 100 })}
${head({ color: 'cream', cy: 80 })}
${eyes({ cy: 78 })}
${helmet({ color: 'steel', cy: 80, plume: 'sky' })}
${sword({ x: W/2 + 26, yBase: 158, length: 56 })}
`;
}

function sneak() {
  return `${SHADOW}
${bodyBean({ color: 'dark', w: 50 })}
${head({ color: 'cream' })}
<!-- mask -->
<rect x="${W/2 - 22}" y="74" width="44" height="10" rx="2" fill="${PALETTE.dark.base}" stroke="${PALETTE.ink}" stroke-width="1.5"/>
${eyes({ color: PALETTE.amethyst.hi, glow: true })}
<!-- twin daggers -->
${sword({ x: W/2 - 28, yBase: 150, length: 44, lean: 30 })}
${sword({ x: W/2 + 28, yBase: 150, length: 44, lean: -30 })}
`;
}

function stormCaller() {
  return `${SHADOW}
${bodyBean({ color: 'sapphire', w: 58 })}
<!-- chest gem -->
<circle cx="${W/2}" cy="124" r="8" fill="url(#gk-rgrad-sapphire)" stroke="${PALETTE.sapphire.stroke}" stroke-width="2"/>
${head({ color: 'cream' })}
${eyes({ color: PALETTE.sapphire.hi, glow: true })}
<!-- electric crown -->
<path d="M ${W/2 - 18} 54 L ${W/2 - 12} 42 L ${W/2 - 6} 54 L ${W/2} 38 L ${W/2 + 6} 54 L ${W/2 + 12} 42 L ${W/2 + 18} 54 Z"
      fill="url(#gk-grad-sapphire)" stroke="${PALETTE.sapphire.stroke}" stroke-width="2" stroke-linejoin="round"/>
${staff({ cx: W/2 + 34, yBase: 160, orbColor: 'sapphire' })}
`;
}

function sapperRogue() {
  return `${SHADOW}
${bodyBean({ color: 'brick', w: 52 })}
<!-- bomb satchel -->
<circle cx="${W/2 - 28}" cy="128" r="10" fill="url(#gk-rgrad-dark)" stroke="${PALETTE.dark.stroke}" stroke-width="2"/>
<circle cx="${W/2 - 28}" cy="124" r="2" fill="${PALETTE.gold.hi}"/>
${head({ color: 'cream' })}
${eyes({})}
<!-- bandana -->
<rect x="${W/2 - 26}" y="62" width="52" height="8" rx="2" fill="url(#gk-grad-brick)" stroke="${PALETTE.brick.stroke}" stroke-width="2"/>
<!-- bomb in hand -->
<circle cx="${W/2 + 30}" cy="140" r="12" fill="url(#gk-rgrad-dark)" stroke="${PALETTE.dark.stroke}" stroke-width="2.5"/>
<rect x="${W/2 + 28}" y="124" width="4" height="6" fill="${PALETTE.iron.base}"/>
<circle cx="${W/2 + 34}" cy="122" r="3" fill="${PALETTE.gold.hi}"/>
`;
}

function plagueDoctor() {
  return `${SHADOW}
${bodyBean({ color: 'dark', w: 60 })}
${head({ color: 'cream' })}
<!-- beak mask -->
<path d="M ${W/2 - 18} 78 L ${W/2} 96 L ${W/2 + 18} 78 L ${W/2 + 10} 74 L ${W/2 - 10} 74 Z"
      fill="url(#gk-grad-cream)" stroke="${PALETTE.ink}" stroke-width="2.5" stroke-linejoin="round"/>
<!-- hat brim -->
<ellipse cx="${W/2}" cy="58" rx="34" ry="6" fill="${PALETTE.dark.base}" stroke="${PALETTE.ink}" stroke-width="2.5"/>
<rect x="${W/2 - 14}" y="40" width="28" height="22" rx="2" fill="${PALETTE.dark.base}" stroke="${PALETTE.ink}" stroke-width="2.5"/>
<!-- glowing eye lenses -->
<circle cx="${W/2 - 8}" cy="78" r="4" fill="${PALETTE.emerald.hi}" stroke="${PALETTE.ink}" stroke-width="1"/>
<circle cx="${W/2 + 8}" cy="78" r="4" fill="${PALETTE.emerald.hi}" stroke="${PALETTE.ink}" stroke-width="1"/>
${staff({ cx: W/2 + 34, yBase: 160, orbColor: 'emerald' })}
`;
}

function lightningSapper() {
  return `${SHADOW}
${bodyBean({ color: 'copper', w: 54 })}
<!-- coil pack -->
<rect x="${W/2 - 30}" y="116" width="14" height="28" rx="3" fill="url(#gk-grad-copper)" stroke="${PALETTE.copper.stroke}" stroke-width="2"/>
<g stroke="${PALETTE.copper.stroke}" stroke-width="1" opacity="0.6">
  <line x1="${W/2 - 28}" y1="124" x2="${W/2 - 18}" y2="124"/>
  <line x1="${W/2 - 28}" y1="132" x2="${W/2 - 18}" y2="132"/>
</g>
${head({ color: 'cream' })}
${eyes({ color: PALETTE.sapphire.hi, glow: true })}
${helmet({ color: 'copper' })}
<!-- electric prod -->
<rect x="${W/2 + 24}" y="100" width="4" height="64" fill="url(#gk-grad-copper)" stroke="${PALETTE.copper.stroke}" stroke-width="1.5"/>
<circle cx="${W/2 + 26}" cy="96" r="6" fill="url(#gk-rgrad-sapphire)" stroke="${PALETTE.sapphire.stroke}" stroke-width="2"/>
<path d="M ${W/2 + 26} 86 L ${W/2 + 22} 78 L ${W/2 + 30} 76 L ${W/2 + 24} 68"
      fill="none" stroke="${PALETTE.sapphire.hi}" stroke-width="2" stroke-linecap="round"/>
`;
}

function batteringRam() {
  return `${SHADOW}
<!-- log body -->
${glossyEllipse({ cx: W/2, cy: 130, rx: 78, ry: 24, gradient: 'gk-grad-wood', outline: PALETTE.wood.stroke, outlineWidth: 4 })}
<!-- iron cap (ram head) -->
${glossyEllipse({ cx: W/2 + 60, cy: 128, rx: 28, ry: 22, gradient: 'gk-grad-iron', outline: PALETTE.iron.stroke, outlineWidth: 4 })}
<!-- iron bands -->
<rect x="${W/2 - 20}" y="108" width="10" height="44" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="2.5"/>
<rect x="${W/2 - 50}" y="108" width="10" height="44" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="2.5"/>
<!-- horn motif on ram head -->
<path d="M ${W/2 + 78} 116 Q ${W/2 + 90} 108 ${W/2 + 78} 100"
      fill="none" stroke="${PALETTE.gold.hi}" stroke-width="3" stroke-linecap="round"/>
<path d="M ${W/2 + 78} 140 Q ${W/2 + 90} 148 ${W/2 + 78} 156"
      fill="none" stroke="${PALETTE.gold.hi}" stroke-width="3" stroke-linecap="round"/>
<!-- wheels -->
<circle cx="${W/2 - 36}" cy="158" r="14" fill="url(#gk-rgrad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="3"/>
<circle cx="${W/2 - 36}" cy="158" r="5" fill="${PALETTE.iron.base}"/>
<circle cx="${W/2 + 24}" cy="158" r="14" fill="url(#gk-rgrad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="3"/>
<circle cx="${W/2 + 24}" cy="158" r="5" fill="${PALETTE.iron.base}"/>
`;
}

// Goblin variants — green-tinged, smaller heads, jagged teeth
function goblinBase({ color = 'leaf', weapon = null, helmetColor = null, accent = null } = {}) {
  const parts = [SHADOW, bodyBean({ color, w: 50 }), head({ color: 'emerald' }), eyes({ color: PALETTE.gold.hi, glow: true })];
  if (helmetColor) parts.push(helmet({ color: helmetColor }));
  // Pointy ears
  parts.push(`<path d="M ${W/2 - 28} 76 L ${W/2 - 36} 64 L ${W/2 - 24} 70 Z"
                    fill="url(#gk-grad-emerald)" stroke="${PALETTE.emerald.stroke}" stroke-width="2" stroke-linejoin="round"/>
              <path d="M ${W/2 + 28} 76 L ${W/2 + 36} 64 L ${W/2 + 24} 70 Z"
                    fill="url(#gk-grad-emerald)" stroke="${PALETTE.emerald.stroke}" stroke-width="2" stroke-linejoin="round"/>`);
  // Teeth
  parts.push(`<path d="M ${W/2 - 5} 88 L ${W/2 - 7} 96 L ${W/2 - 3} 94 Z"
                    fill="${PALETTE.cream.hi}" stroke="${PALETTE.ink}" stroke-width="1"/>
              <path d="M ${W/2 + 5} 88 L ${W/2 + 7} 96 L ${W/2 + 3} 94 Z"
                    fill="${PALETTE.cream.hi}" stroke="${PALETTE.ink}" stroke-width="1"/>`);
  if (weapon) parts.push(weapon);
  if (accent) parts.push(accent);
  return parts.join('\n');
}

function goblinScrapper() {
  return goblinBase({ weapon: hammer({ x: W/2 + 22, yBase: 158, headColor: 'iron' }) });
}

function goblinArcher() {
  return goblinBase({ color: 'wood', weapon: bow({ cx: W/2 + 24, yBase: 158, height: 60 }) });
}

function goblinMage() {
  return goblinBase({ color: 'amethyst', weapon: staff({ cx: W/2 + 32, yBase: 160, orbColor: 'emerald' }) });
}

function goblinChief() {
  return goblinBase({
    color: 'brick',
    helmetColor: 'iron',
    weapon: sword({ x: W/2 + 26, yBase: 158, length: 60, hiltColor: 'gold' }),
    accent: `<!-- gold trophy cape pin -->
             <circle cx="${W/2 - 22}" cy="108" r="6" fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="2"/>`,
  });
}

function goblinKing() {
  // Bigger silhouette, full crown, bigger weapon
  return `${SHADOW}
${bodyBean({ color: 'ruby', w: 70 })}
<!-- cape -->
<path d="M ${W/2 - 36} 100
         Q ${W/2 - 50} 144 ${W/2 - 30} 168
         L ${W/2 + 30} 168
         Q ${W/2 + 50} 144 ${W/2 + 36} 100 Z"
      fill="url(#gk-grad-ruby)" stroke="${PALETTE.ruby.stroke}" stroke-width="3" stroke-linejoin="round"/>
${head({ color: 'emerald', r: 30, cy: 76 })}
${eyes({ color: PALETTE.gold.hi, glow: true, cy: 76 })}
<!-- crown -->
<path d="M ${W/2 - 28} 56
         L ${W/2 - 20} 38
         L ${W/2 - 10} 48
         L ${W/2} 30
         L ${W/2 + 10} 48
         L ${W/2 + 20} 38
         L ${W/2 + 28} 56 Z"
      fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<circle cx="${W/2}" cy="40" r="3" fill="${PALETTE.ruby.hi}"/>
<!-- teeth -->
<path d="M ${W/2 - 6} 88 L ${W/2 - 8} 98 L ${W/2 - 3} 96 Z"
      fill="${PALETTE.cream.hi}" stroke="${PALETTE.ink}" stroke-width="1"/>
<path d="M ${W/2 + 6} 88 L ${W/2 + 8} 98 L ${W/2 + 3} 96 Z"
      fill="${PALETTE.cream.hi}" stroke="${PALETTE.ink}" stroke-width="1"/>
${sword({ x: W/2 + 38, yBase: 160, length: 90, hiltColor: 'gold' })}
`;
}

function goblinSapper() {
  return goblinBase({
    color: 'brick',
    accent: `<circle cx="${W/2 + 26}" cy="138" r="14" fill="url(#gk-rgrad-dark)" stroke="${PALETTE.dark.stroke}" stroke-width="2.5"/>
             <rect x="${W/2 + 24}" y="122" width="4" height="6" fill="${PALETTE.iron.base}"/>
             <circle cx="${W/2 + 30}" cy="120" r="3" fill="${PALETTE.gold.hi}"/>
             <circle cx="${W/2 + 30}" cy="120" r="1.5" fill="${PALETTE.white}"/>`,
  });
}

function goblinSkyrider() {
  return `${SHADOW}
${wings({ cx: W/2, cy: 108, span: 70, color: 'leaf' })}
${bodyBean({ color: 'leaf', w: 48, top: 100 })}
${head({ color: 'emerald', cy: 80 })}
${eyes({ color: PALETTE.gold.hi, glow: true, cy: 78 })}
<!-- mohawk -->
<path d="M ${W/2 - 6} 54 L ${W/2} 38 L ${W/2 + 6} 54 Z"
      fill="url(#gk-grad-ruby)" stroke="${PALETTE.ruby.stroke}" stroke-width="2" stroke-linejoin="round"/>
${sword({ x: W/2 + 24, yBase: 158, length: 50 })}
`;
}

function wyrm() {
  // Large serpent dragon — bigger silhouette
  return `${SHADOW}
<!-- coiled body -->
<path d="M 40 158
         Q 20 130 60 116
         Q 100 102 124 124
         Q 148 146 130 110
         Q 112 78 142 60
         Q 172 42 160 20"
      fill="none" stroke="url(#gk-grad-emerald)" stroke-width="36" stroke-linecap="round"/>
<path d="M 40 158
         Q 20 130 60 116
         Q 100 102 124 124
         Q 148 146 130 110
         Q 112 78 142 60
         Q 172 42 160 20"
      fill="none" stroke="${PALETTE.emerald.stroke}" stroke-width="40" stroke-linecap="round" stroke-opacity="0"/>
<path d="M 40 158
         Q 20 130 60 116
         Q 100 102 124 124
         Q 148 146 130 110
         Q 112 78 142 60
         Q 172 42 160 20"
      fill="none" stroke="${PALETTE.emerald.stroke}" stroke-width="3"/>
<!-- head -->
<g transform="translate(160, 20)">
  <ellipse cx="0" cy="0" rx="20" ry="14" fill="url(#gk-rgrad-emerald)" stroke="${PALETTE.emerald.stroke}" stroke-width="3"/>
  <circle cx="-4" cy="-4" r="3" fill="${PALETTE.ruby.hi}"/>
  <circle cx="-4" cy="-4" r="1.5" fill="${PALETTE.ink}"/>
  <!-- horns -->
  <path d="M -12 -10 L -14 -22 L -6 -14 Z" fill="url(#gk-grad-iron)" stroke="${PALETTE.ink}" stroke-width="1.5" stroke-linejoin="round"/>
  <path d="M 6 -12 L 12 -22 L 14 -10 Z" fill="url(#gk-grad-iron)" stroke="${PALETTE.ink}" stroke-width="1.5" stroke-linejoin="round"/>
  <!-- fang -->
  <path d="M -8 6 L -10 14 L -4 10 Z" fill="${PALETTE.cream.hi}" stroke="${PALETTE.ink}" stroke-width="1"/>
</g>
<!-- belly scales gloss -->
<path d="M 40 158 Q 60 142 100 132 Q 138 128 158 116"
      fill="none" stroke="${PALETTE.emerald.hi}" stroke-width="6" opacity="0.5"/>
`;
}

// ── Per-troop catalogue ─────────────────────────────────────────

const TROOPS = [
  { id: 'scrapper',        body: scrapper },
  { id: 'boltKnight',      body: boltKnight },
  { id: 'voltaicMage',     body: voltaicMage },
  { id: 'archerLite',      body: archerLite },
  { id: 'healerCleric',    body: healerCleric },
  { id: 'skyrider',        body: skyrider },
  { id: 'sneak',           body: sneak },
  { id: 'stormCaller',     body: stormCaller },
  { id: 'sapperRogue',     body: sapperRogue },
  { id: 'plagueDoctor',    body: plagueDoctor },
  { id: 'lightningSapper', body: lightningSapper },
  { id: 'batteringRam',    body: batteringRam },
  { id: 'goblinScrapper',  body: goblinScrapper },
  { id: 'goblinArcher',    body: goblinArcher },
  { id: 'goblinMage',      body: goblinMage },
  { id: 'goblinChief',     body: goblinChief },
  { id: 'goblinKing',      body: goblinKing },
  { id: 'goblinSapper',    body: goblinSapper },
  { id: 'goblinSkyrider',  body: goblinSkyrider },
  { id: 'wyrm',            body: wyrm },
];

let written = 0;
for (const t of TROOPS) {
  const svg = svgWrapper({
    width: W, height: H,
    body: t.body(),
    title: `${t.id} — glossy troop`,
    desc: 'Loadout Clash troop, glossy art style. Source: tools/build-clash-troops-glossy.mjs.',
  });
  const out = join(TROOP_DIR, `${t.id}.svg`);
  writeFileSync(out, svg);
  written++;
  console.log(`wrote troop ${t.id}`);
}

// ── Backdrop layers ─────────────────────────────────────────────
//
// Parallax stack: sky → mountains → hills → forest → grass.
// Each is a wide (1024×320) layer the site composites/scrolls. SVG
// is ideal — vector clouds, layered hills, etc. all scale.

const BACK_W = 1024, BACK_H = 320;
function sky() {
  return `
<defs>
  <linearGradient id="sky-grad" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${PALETTE.sky.hi}"/>
    <stop offset="0.55" stop-color="${PALETTE.sky.base}"/>
    <stop offset="1" stop-color="${PALETTE.sky.lo}"/>
  </linearGradient>
</defs>
<rect x="0" y="0" width="${BACK_W}" height="${BACK_H}" fill="url(#sky-grad)"/>
<!-- sun -->
<circle cx="${BACK_W * 0.78}" cy="${BACK_H * 0.3}" r="46" fill="url(#gk-rgrad-gold)" opacity="0.9"/>
<circle cx="${BACK_W * 0.78}" cy="${BACK_H * 0.3}" r="60" fill="url(#gk-rgrad-gold)" opacity="0.3"/>
<!-- clouds (soft ellipses) -->
<g fill="${PALETTE.cream.hi}" opacity="0.85">
  <ellipse cx="180" cy="80"  rx="60" ry="14"/>
  <ellipse cx="220" cy="70"  rx="42" ry="12"/>
  <ellipse cx="500" cy="120" rx="80" ry="16"/>
  <ellipse cx="540" cy="106" rx="50" ry="12"/>
  <ellipse cx="820" cy="60"  rx="46" ry="10"/>
</g>
`;
}

function mountains() {
  return `
<g fill="url(#gk-grad-dark)" stroke="${PALETTE.dark.stroke}" stroke-width="3" stroke-linejoin="round">
  <path d="M 0 ${BACK_H} L 0 220 L 130 80 L 240 200 L 360 60 L 510 220 L 640 100 L 780 240 L 900 120 L 1024 220 L 1024 ${BACK_H} Z"/>
</g>
<!-- snowcaps -->
<g fill="${PALETTE.cream.hi}" opacity="0.95">
  <path d="M 110 100 L 130 80 L 150 100 L 138 110 Z"/>
  <path d="M 340 80 L 360 60 L 380 80 L 368 90 Z"/>
  <path d="M 620 120 L 640 100 L 660 120 L 648 130 Z"/>
  <path d="M 880 140 L 900 120 L 920 140 L 908 150 Z"/>
</g>
<!-- gloss on left slopes -->
<g fill="${PALETTE.white}" opacity="0.12">
  <path d="M 60 ${BACK_H} L 60 240 L 130 80 L 130 110 L 90 ${BACK_H} Z"/>
  <path d="M 290 ${BACK_H} L 290 230 L 360 60 L 360 100 L 320 ${BACK_H} Z"/>
</g>
`;
}

function hills() {
  return `
<g fill="url(#gk-grad-leaf)" stroke="${PALETTE.leaf.stroke}" stroke-width="3" stroke-linejoin="round">
  <path d="M 0 ${BACK_H} L 0 240 Q 180 180 360 230 Q 540 280 720 220 Q 880 180 1024 240 L 1024 ${BACK_H} Z"/>
</g>
<g fill="${PALETTE.leaf.hi}" opacity="0.4">
  <path d="M 0 240 Q 180 200 360 245 L 0 245 Z"/>
  <path d="M 540 270 Q 720 220 1024 250 L 1024 254 Q 720 234 540 274 Z"/>
</g>
`;
}

function forest() {
  // Simple stylised tree shapes scattered along
  function tree(x, scale = 1) {
    const w = 60 * scale, h = 90 * scale;
    return `
<g transform="translate(${x}, ${BACK_H - 60})">
  <rect x="${-w * 0.08}" y="0" width="${w * 0.16}" height="${h * 0.3}" fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="2"/>
  <ellipse cx="0" cy="${-h * 0.4}" rx="${w * 0.55}" ry="${h * 0.4}" fill="url(#gk-rgrad-leaf)" stroke="${PALETTE.leaf.stroke}" stroke-width="3"/>
  <ellipse cx="${-w * 0.15}" cy="${-h * 0.55}" rx="${w * 0.25}" ry="${h * 0.15}" fill="${PALETTE.leaf.hi}" opacity="0.5"/>
</g>`;
  }
  let out = '';
  const xs = [80, 200, 320, 460, 620, 760, 880];
  for (const x of xs) {
    out += tree(x, 0.8 + (x % 7) / 14);
  }
  return out;
}

function grass() {
  return `
<rect x="0" y="${BACK_H - 60}" width="${BACK_W}" height="60" fill="url(#gk-grad-leaf)"/>
<rect x="0" y="${BACK_H - 60}" width="${BACK_W}" height="6" fill="${PALETTE.leaf.hi}" opacity="0.7"/>
<!-- grass tufts -->
<g stroke="${PALETTE.leaf.stroke}" stroke-width="1.5" fill="none">
  ${Array.from({ length: 32 }, (_, i) => {
    const x = 16 + i * 32;
    return `<path d="M ${x} ${BACK_H - 4} L ${x + 4} ${BACK_H - 18} M ${x + 2} ${BACK_H - 4} L ${x - 4} ${BACK_H - 16} M ${x + 4} ${BACK_H - 4} L ${x + 8} ${BACK_H - 14}"/>`;
  }).join('\n  ')}
</g>
`;
}

const BACKDROPS = [
  { id: 'sky',       body: sky },
  { id: 'mountains', body: mountains },
  { id: 'hills',     body: hills },
  { id: 'forest',    body: forest },
  { id: 'grass',     body: grass },
];

for (const b of BACKDROPS) {
  const svg = svgWrapper({
    width: BACK_W, height: BACK_H,
    body: b.body(),
    title: `${b.id} — glossy backdrop layer`,
    desc: 'Parallax layer for the Clash town view. Source: tools/build-clash-troops-glossy.mjs.',
  });
  const out = join(BACK_DIR, `${b.id}.svg`);
  writeFileSync(out, svg);
  written++;
  console.log(`wrote backdrop ${b.id}`);
}

console.log(`\n✓ rendered ${written} glossy assets (${TROOPS.length} troops + ${BACKDROPS.length} backdrops)`);
