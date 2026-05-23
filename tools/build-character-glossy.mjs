// Glossy character figure pipeline.
//
// Replaces tools/build-sprites.ps1 for everything under
// figure/* — body, hair, eyes, accent, default clothing. SVG
// authored per kind, baked to PNG at 128×160 (HD glossy, 2× the
// retired 64×80 pixel canvas).
//
// Outputs (committed to git):
//   aquilo-gg/sprites/figure/glossy/body-<type>-<skinTone>.png    (20)
//   aquilo-gg/sprites/figure/glossy/hair-<style>-<colour>.png    (168)
//   aquilo-gg/sprites/figure/glossy/eyes-<colour>.png              (8)
//   aquilo-gg/sprites/figure/glossy/accent-<name>.png              (5)
//   aquilo-gg/sprites/figure/glossy/default-clothing.png           (1)
//
// All variants are layer-compatible — same dims, same anchor
// points — so character.js can compose them after the worker
// flip (deferred per Clay).
//
// Hair colour is now baked per-file rather than runtime
// paletteSwap. The glossy gradient idiom doesn't survive
// paletteSwap cleanly (anti-aliased intermediates fall outside
// the 5-tone reference palette), so we ship 12 × 14 = 168 hair
// PNGs and the future character.js flip just picks
// hair-<style>-<colour>.png directly.
//
// Run:  node tools/build-character-glossy.mjs

import { mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { PALETTE, contactShadow, svgWrapper } from './glossy-art-kit.mjs';
import { bakeFile } from './bake-glossy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT = join(ROOT, 'aquilo-gg/sprites/figure/glossy');
mkdirSync(OUT, { recursive: true });

// ── Canvas + anchor reference ───────────────────────────────────
//
// 128 wide × 160 tall. Anatomy anchors (so hair sits on the head,
// eyes sit in the face, gear sits on the torso):
//
//   y =  6–18    crown        ← hair top
//   y = 18–55    head         ← skin
//   y = 35–45    eye band
//   y = 55–60    neck
//   y = 55–115   torso        ← chest gear / default-clothing
//   y = 115–145  legs         ← legs gear
//   y = 145–158  feet         ← boots
//   y = 156–160  contact shadow ground line
//
// Body bean is centred on x=64. Head circle is ~r=22 at (64, 36).

const W = 128, H = 160;
const HEAD_CX = 64, HEAD_CY = 36, HEAD_R = 22;
const BODY_LEFT = 32, BODY_RIGHT = 96;        // torso bounds
const SHOULDER_Y = 58;                         // shoulders
const HIP_Y = 110;                             // waist
const FOOT_Y = 152;                            // feet baseline

// ── Skin tone palette ───────────────────────────────────────────
//
// 10 tones matching CHARACTER_LOOK_OPTIONS.skinTone in dungeon.js.
// Each is a {hi, base, lo, stroke} family so the body shape can
// reuse the kit's per-palette gradient defs via an inline grad.

const SKIN_TONES = {
  fair:          { hi: '#FFE4D2', base: '#F2C7A8', lo: '#C49980', stroke: '#704A38' },
  porcelain:     { hi: '#FDF1E5', base: '#F4DCC4', lo: '#D8B59A', stroke: '#7A5641' },
  rose:          { hi: '#FFD7C9', base: '#F1B69F', lo: '#C58375', stroke: '#6D3B33' },
  tan:           { hi: '#E8B98C', base: '#C68F60', lo: '#94613D', stroke: '#522F19' },
  olive:         { hi: '#DDB682', base: '#B68A56', lo: '#7F5B33', stroke: '#3B2511' },
  bronze:        { hi: '#D89B6B', base: '#A66A3F', lo: '#724423', stroke: '#341A09' },
  umber:         { hi: '#B07449', base: '#7E4A26', lo: '#502A12', stroke: '#250F04' },
  ebony:         { hi: '#7D4F30', base: '#4F2F18', lo: '#2A180A', stroke: '#0B0501' },
  pale_violet:   { hi: '#E4D2F0', base: '#C5B0DB', lo: '#9685B2', stroke: '#4E4172' },
  ash:           { hi: '#D7D2CB', base: '#A8A39C', lo: '#7A766F', stroke: '#383631' },
};

// ── Hair colour palette (5-tone, matches char.js HAIR_COLOURS_RGB) ─

const HAIR_COLOURS = {
  brown:  { deep: '#22120b', shadow: '#3b251a', base: '#5a3a26', high: '#7a5236', top: '#a07248' },
  black:  { deep: '#08080a', shadow: '#161618', base: '#2a2a30', high: '#42424a', top: '#5a5b66' },
  blonde: { deep: '#6c4e10', shadow: '#a37a30', base: '#d4a64a', high: '#f4d27a', top: '#fff0b8' },
  red:    { deep: '#4a100a', shadow: '#7a2018', base: '#b53420', high: '#d8553a', top: '#f08060' },
  grey:   { deep: '#3e424a', shadow: '#5f636c', base: '#878b95', high: '#b3b8c2', top: '#d2d6de' },
  white:  { deep: '#a4a8b2', shadow: '#c8ccd6', base: '#e6e9ef', high: '#ffffff', top: '#ffffff' },
  violet: { deep: '#3a2880', shadow: '#5a40b0', base: '#7c5cff', high: '#a890ff', top: '#cdb8ff' },
  teal:   { deep: '#1a5a4a', shadow: '#2f8a78', base: '#5fc4a8', high: '#92e6cd', top: '#bdf5e0' },
  pink:   { deep: '#852048', shadow: '#c14688', base: '#e87ab0', high: '#ffabcf', top: '#ffd0e2' },
  mint:   { deep: '#22784a', shadow: '#3da76c', base: '#5be098', high: '#90ffc4', top: '#c4ffe0' },
  silver: { deep: '#525868', shadow: '#7a8090', base: '#a8afbc', high: '#d4d8e0', top: '#eef0f5' },
  copper: { deep: '#68260a', shadow: '#9c4a1f', base: '#cf7240', high: '#f09866', top: '#ffb88a' },
  navy:   { deep: '#0a1230', shadow: '#172046', base: '#293a78', high: '#3e539c', top: '#5a72c0' },
  forest: { deep: '#0a2410', shadow: '#1a3a20', base: '#2e5c34', high: '#4b8550', top: '#74a878' },
};

const EYE_COLOURS = {
  brown:  '#5a3a1e',
  blue:   '#3a7bd5',
  green:  '#3aa758',
  hazel:  '#a08040',
  amber:  '#d6932a',
  violet: '#a06ad8',
  silver: '#9ba5b5',
  pink:   '#e57aa0',
};

// ── Helper: inline gradient defs for a skin tone ────────────────
// Avoids relying on kit defs (skin tones aren't part of PALETTE).
function skinDefs(skin) {
  return `
<linearGradient id="skin-grad" x1="0.2" y1="0.1" x2="0.85" y2="0.95">
  <stop offset="0"    stop-color="${skin.hi}"/>
  <stop offset="0.55" stop-color="${skin.base}"/>
  <stop offset="1"    stop-color="${skin.lo}"/>
</linearGradient>
<radialGradient id="skin-rgrad" cx="0.35" cy="0.25" r="0.85">
  <stop offset="0"    stop-color="${skin.hi}"/>
  <stop offset="0.55" stop-color="${skin.base}"/>
  <stop offset="1"    stop-color="${skin.lo}"/>
</radialGradient>`;
}

// ── Body shape ──────────────────────────────────────────────────
//
// Glossy bean with subtle anatomy. Slim = narrower torso, stocky =
// wider. Head is on top, neck merges smoothly.

function bodyShape(type, skin) {
  const torsoHalf = type === 'stocky' ? 32 : 26;
  const hipHalf   = type === 'stocky' ? 28 : 22;
  const shoulderY = SHOULDER_Y - 2;
  const armEdge = type === 'stocky' ? 4 : 2;
  return `
${contactShadow({ cx: 64, cy: 156, rx: 36, ry: 6 })}
<!-- arms (back layer so gear can sit forward) -->
<path d="M ${64 - torsoHalf - armEdge} ${shoulderY}
         Q ${64 - torsoHalf - 8} ${shoulderY + 18} ${64 - torsoHalf - 6} ${shoulderY + 38}
         Q ${64 - torsoHalf - 4} ${shoulderY + 48} ${64 - torsoHalf + 4} ${shoulderY + 50}
         L ${64 - torsoHalf + 4} ${shoulderY + 12} Z"
      fill="url(#skin-grad)" stroke="${skin.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<path d="M ${64 + torsoHalf + armEdge} ${shoulderY}
         Q ${64 + torsoHalf + 8} ${shoulderY + 18} ${64 + torsoHalf + 6} ${shoulderY + 38}
         Q ${64 + torsoHalf + 4} ${shoulderY + 48} ${64 + torsoHalf - 4} ${shoulderY + 50}
         L ${64 + torsoHalf - 4} ${shoulderY + 12} Z"
      fill="url(#skin-grad)" stroke="${skin.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<!-- torso + hips -->
<path d="M ${64 - torsoHalf} ${shoulderY}
         L ${64 - hipHalf}   ${HIP_Y}
         L ${64 + hipHalf}   ${HIP_Y}
         L ${64 + torsoHalf} ${shoulderY}
         Q ${64 + torsoHalf} ${shoulderY - 4} ${64 + torsoHalf - 6} ${shoulderY - 6}
         L ${64 - torsoHalf + 6} ${shoulderY - 6}
         Q ${64 - torsoHalf} ${shoulderY - 4} ${64 - torsoHalf} ${shoulderY} Z"
      fill="url(#skin-grad)" stroke="${skin.stroke}" stroke-width="3" stroke-linejoin="round"/>
<!-- legs (no separation — default-clothing covers) -->
<path d="M ${64 - hipHalf + 2} ${HIP_Y}
         L ${64 - hipHalf + 6} ${FOOT_Y}
         L ${64 + hipHalf - 6} ${FOOT_Y}
         L ${64 + hipHalf - 2} ${HIP_Y} Z"
      fill="url(#skin-grad)" stroke="${skin.stroke}" stroke-width="3" stroke-linejoin="round"/>
<!-- neck -->
<rect x="${64 - 8}" y="${HEAD_CY + HEAD_R - 4}" width="16" height="10"
      fill="url(#skin-grad)" stroke="${skin.stroke}" stroke-width="2.5"/>
<!-- head -->
<circle cx="${HEAD_CX}" cy="${HEAD_CY}" r="${HEAD_R}"
        fill="url(#skin-rgrad)" stroke="${skin.stroke}" stroke-width="3"/>
<!-- jaw shadow under chin -->
<ellipse cx="${HEAD_CX}" cy="${HEAD_CY + HEAD_R - 2}" rx="14" ry="4" fill="${skin.lo}" opacity="0.5"/>
<!-- head gloss -->
<ellipse cx="${HEAD_CX - 8}" cy="${HEAD_CY - 8}" rx="9" ry="5" fill="#FFFFFF" opacity="0.5"/>
<!-- subtle face features (nose hint, mouth) -->
<path d="M ${HEAD_CX - 2} ${HEAD_CY + 6} Q ${HEAD_CX} ${HEAD_CY + 10} ${HEAD_CX + 2} ${HEAD_CY + 6}"
      fill="none" stroke="${skin.stroke}" stroke-width="1" opacity="0.5"/>
<line x1="${HEAD_CX - 4}" y1="${HEAD_CY + 14}" x2="${HEAD_CX + 4}" y2="${HEAD_CY + 14}"
      stroke="${skin.stroke}" stroke-width="1.2" opacity="0.7" stroke-linecap="round"/>
`;
}

function bodySvg(type, toneName) {
  const skin = SKIN_TONES[toneName];
  return svgWrapper({
    width: W, height: H,
    title: `body-${type}-${toneName}`,
    desc: 'Glossy character body. Source: tools/build-character-glossy.mjs',
    body: `<defs>${skinDefs(skin)}</defs>${bodyShape(type, skin)}`,
  });
}

// ── Hair styles ─────────────────────────────────────────────────
//
// Each style is a function returning SVG body, parametrized by a
// 5-tone palette object. Hair sits over the head crown — anchored
// against (HEAD_CX, HEAD_CY).

function hairDefs(c) {
  return `
<linearGradient id="hair-grad" x1="0.3" y1="0.1" x2="0.85" y2="0.95">
  <stop offset="0"    stop-color="${c.top}"/>
  <stop offset="0.4"  stop-color="${c.high}"/>
  <stop offset="0.75" stop-color="${c.base}"/>
  <stop offset="1"    stop-color="${c.shadow}"/>
</linearGradient>`;
}

function hairShortTousled(c) {
  return `
<path d="M ${HEAD_CX - 24} ${HEAD_CY + 4}
         Q ${HEAD_CX - 26} ${HEAD_CY - 18} ${HEAD_CX - 14} ${HEAD_CY - 24}
         Q ${HEAD_CX - 6} ${HEAD_CY - 30} ${HEAD_CX + 4} ${HEAD_CY - 28}
         Q ${HEAD_CX + 18} ${HEAD_CY - 26} ${HEAD_CX + 22} ${HEAD_CY - 12}
         Q ${HEAD_CX + 26} ${HEAD_CY + 2} ${HEAD_CX + 22} ${HEAD_CY + 4}
         Q ${HEAD_CX + 16} ${HEAD_CY - 8} ${HEAD_CX + 4} ${HEAD_CY - 12}
         Q ${HEAD_CX - 10} ${HEAD_CY - 4} ${HEAD_CX - 24} ${HEAD_CY + 4} Z"
      fill="url(#hair-grad)" stroke="${c.deep}" stroke-width="2.5" stroke-linejoin="round"/>
<!-- gloss tuft -->
<path d="M ${HEAD_CX - 14} ${HEAD_CY - 18}
         Q ${HEAD_CX - 4} ${HEAD_CY - 24} ${HEAD_CX + 6} ${HEAD_CY - 22}"
      fill="none" stroke="${c.top}" stroke-width="2" opacity="0.6"/>`;
}

function hairLongStraight(c) {
  return `
<!-- back drape (down past shoulders) -->
<path d="M ${HEAD_CX - 22} ${HEAD_CY - 8}
         Q ${HEAD_CX - 28} ${HEAD_CY + 16} ${HEAD_CX - 22} ${HEAD_CY + 56}
         Q ${HEAD_CX - 16} ${HEAD_CY + 70} ${HEAD_CX - 6} ${HEAD_CY + 68}
         L ${HEAD_CX + 6} ${HEAD_CY + 68}
         Q ${HEAD_CX + 16} ${HEAD_CY + 70} ${HEAD_CX + 22} ${HEAD_CY + 56}
         Q ${HEAD_CX + 28} ${HEAD_CY + 16} ${HEAD_CX + 22} ${HEAD_CY - 8}
         Q ${HEAD_CX + 6} ${HEAD_CY - 30} ${HEAD_CX - 6} ${HEAD_CY - 28}
         Q ${HEAD_CX - 22} ${HEAD_CY - 22} ${HEAD_CX - 22} ${HEAD_CY - 8} Z"
      fill="url(#hair-grad)" stroke="${c.deep}" stroke-width="2.5" stroke-linejoin="round"/>
<!-- forehead bangs -->
<path d="M ${HEAD_CX - 18} ${HEAD_CY - 14}
         Q ${HEAD_CX - 8} ${HEAD_CY - 4} ${HEAD_CX + 2} ${HEAD_CY - 8}
         Q ${HEAD_CX + 14} ${HEAD_CY - 4} ${HEAD_CX + 20} ${HEAD_CY - 14}
         Q ${HEAD_CX + 18} ${HEAD_CY - 22} ${HEAD_CX} ${HEAD_CY - 24}
         Q ${HEAD_CX - 18} ${HEAD_CY - 22} ${HEAD_CX - 18} ${HEAD_CY - 14} Z"
      fill="url(#hair-grad)" stroke="${c.deep}" stroke-width="2"/>
<!-- gloss strip -->
<path d="M ${HEAD_CX - 14} ${HEAD_CY - 6}
         Q ${HEAD_CX - 18} ${HEAD_CY + 30} ${HEAD_CX - 12} ${HEAD_CY + 56}"
      fill="none" stroke="${c.top}" stroke-width="3" opacity="0.5"/>`;
}

function hairBun(c) {
  return `
<!-- side hair -->
<path d="M ${HEAD_CX - 24} ${HEAD_CY + 6}
         Q ${HEAD_CX - 26} ${HEAD_CY - 16} ${HEAD_CX - 4} ${HEAD_CY - 26}
         Q ${HEAD_CX + 14} ${HEAD_CY - 26} ${HEAD_CX + 22} ${HEAD_CY - 8}
         Q ${HEAD_CX + 26} ${HEAD_CY + 6} ${HEAD_CX + 22} ${HEAD_CY + 12}
         Q ${HEAD_CX + 14} ${HEAD_CY + 6} ${HEAD_CX} ${HEAD_CY + 4}
         Q ${HEAD_CX - 14} ${HEAD_CY + 6} ${HEAD_CX - 24} ${HEAD_CY + 6} Z"
      fill="url(#hair-grad)" stroke="${c.deep}" stroke-width="2.5" stroke-linejoin="round"/>
<!-- bun on crown -->
<circle cx="${HEAD_CX}" cy="${HEAD_CY - 26}" r="11"
        fill="url(#hair-grad)" stroke="${c.deep}" stroke-width="2.5"/>
<circle cx="${HEAD_CX - 3}" cy="${HEAD_CY - 30}" r="3" fill="${c.top}" opacity="0.6"/>`;
}

function hairMohawk(c) {
  return `
<!-- shaved sides (thin band) -->
<path d="M ${HEAD_CX - 22} ${HEAD_CY + 4}
         Q ${HEAD_CX - 22} ${HEAD_CY - 8} ${HEAD_CX - 12} ${HEAD_CY - 8}
         L ${HEAD_CX + 12} ${HEAD_CY - 8}
         Q ${HEAD_CX + 22} ${HEAD_CY - 8} ${HEAD_CX + 22} ${HEAD_CY + 4}
         Q ${HEAD_CX + 16} ${HEAD_CY + 2} ${HEAD_CX} ${HEAD_CY + 2}
         Q ${HEAD_CX - 16} ${HEAD_CY + 2} ${HEAD_CX - 22} ${HEAD_CY + 4} Z"
      fill="${c.shadow}" stroke="${c.deep}" stroke-width="1.5" opacity="0.55"/>
<!-- mohawk strip -->
<path d="M ${HEAD_CX - 8} ${HEAD_CY - 6}
         L ${HEAD_CX - 6} ${HEAD_CY - 30}
         Q ${HEAD_CX} ${HEAD_CY - 36} ${HEAD_CX + 6} ${HEAD_CY - 30}
         L ${HEAD_CX + 8} ${HEAD_CY - 6} Z"
      fill="url(#hair-grad)" stroke="${c.deep}" stroke-width="2.5" stroke-linejoin="round"/>
<rect x="${HEAD_CX - 3}" y="${HEAD_CY - 30}" width="2" height="22" fill="${c.top}" opacity="0.55"/>`;
}

function hairBraids(c) {
  return `
<!-- crown -->
<path d="M ${HEAD_CX - 22} ${HEAD_CY + 4}
         Q ${HEAD_CX - 24} ${HEAD_CY - 18} ${HEAD_CX} ${HEAD_CY - 28}
         Q ${HEAD_CX + 24} ${HEAD_CY - 18} ${HEAD_CX + 22} ${HEAD_CY + 4}
         Q ${HEAD_CX + 14} ${HEAD_CY - 6} ${HEAD_CX} ${HEAD_CY - 8}
         Q ${HEAD_CX - 14} ${HEAD_CY - 6} ${HEAD_CX - 22} ${HEAD_CY + 4} Z"
      fill="url(#hair-grad)" stroke="${c.deep}" stroke-width="2.5" stroke-linejoin="round"/>
<!-- left braid down past shoulder -->
<g>
  <path d="M ${HEAD_CX - 22} ${HEAD_CY + 4}
           Q ${HEAD_CX - 24} ${HEAD_CY + 24} ${HEAD_CX - 26} ${HEAD_CY + 50}"
        fill="none" stroke="url(#hair-grad)" stroke-width="9" stroke-linecap="round"/>
  <g stroke="${c.deep}" stroke-width="1.5" opacity="0.6" fill="none">
    <path d="M ${HEAD_CX - 22} ${HEAD_CY + 14} L ${HEAD_CX - 27} ${HEAD_CY + 20}"/>
    <path d="M ${HEAD_CX - 23} ${HEAD_CY + 28} L ${HEAD_CX - 28} ${HEAD_CY + 34}"/>
    <path d="M ${HEAD_CX - 24} ${HEAD_CY + 42} L ${HEAD_CX - 28} ${HEAD_CY + 48}"/>
  </g>
</g>
<!-- right braid -->
<g>
  <path d="M ${HEAD_CX + 22} ${HEAD_CY + 4}
           Q ${HEAD_CX + 24} ${HEAD_CY + 24} ${HEAD_CX + 26} ${HEAD_CY + 50}"
        fill="none" stroke="url(#hair-grad)" stroke-width="9" stroke-linecap="round"/>
  <g stroke="${c.deep}" stroke-width="1.5" opacity="0.6" fill="none">
    <path d="M ${HEAD_CX + 22} ${HEAD_CY + 14} L ${HEAD_CX + 27} ${HEAD_CY + 20}"/>
    <path d="M ${HEAD_CX + 23} ${HEAD_CY + 28} L ${HEAD_CX + 28} ${HEAD_CY + 34}"/>
    <path d="M ${HEAD_CX + 24} ${HEAD_CY + 42} L ${HEAD_CX + 28} ${HEAD_CY + 48}"/>
  </g>
</g>`;
}

function hairCurlyAfro(c) {
  return `
<!-- big rounded silhouette -->
<circle cx="${HEAD_CX}" cy="${HEAD_CY - 10}" r="28"
        fill="url(#hair-grad)" stroke="${c.deep}" stroke-width="2.5"/>
<!-- curl bumps -->
<g fill="url(#hair-grad)" stroke="${c.deep}" stroke-width="1.5">
  <circle cx="${HEAD_CX - 22}" cy="${HEAD_CY - 12}" r="8"/>
  <circle cx="${HEAD_CX + 22}" cy="${HEAD_CY - 12}" r="8"/>
  <circle cx="${HEAD_CX - 14}" cy="${HEAD_CY - 30}" r="9"/>
  <circle cx="${HEAD_CX + 14}" cy="${HEAD_CY - 30}" r="9"/>
  <circle cx="${HEAD_CX}" cy="${HEAD_CY - 36}" r="10"/>
  <circle cx="${HEAD_CX - 22}" cy="${HEAD_CY + 2}" r="6"/>
  <circle cx="${HEAD_CX + 22}" cy="${HEAD_CY + 2}" r="6"/>
</g>
<!-- gloss highlights on curls -->
<g fill="${c.top}" opacity="0.5">
  <circle cx="${HEAD_CX - 16}" cy="${HEAD_CY - 32}" r="2.5"/>
  <circle cx="${HEAD_CX + 8}" cy="${HEAD_CY - 38}" r="2.5"/>
  <circle cx="${HEAD_CX - 4}" cy="${HEAD_CY - 22}" r="2"/>
</g>`;
}

function hairPixie(c) {
  return `
<path d="M ${HEAD_CX - 22} ${HEAD_CY + 2}
         Q ${HEAD_CX - 24} ${HEAD_CY - 14} ${HEAD_CX - 12} ${HEAD_CY - 22}
         Q ${HEAD_CX} ${HEAD_CY - 26} ${HEAD_CX + 14} ${HEAD_CY - 22}
         Q ${HEAD_CX + 22} ${HEAD_CY - 16} ${HEAD_CX + 20} ${HEAD_CY + 2}
         Q ${HEAD_CX + 8} ${HEAD_CY - 10} ${HEAD_CX} ${HEAD_CY - 8}
         Q ${HEAD_CX - 8} ${HEAD_CY - 4} ${HEAD_CX - 22} ${HEAD_CY + 2} Z"
      fill="url(#hair-grad)" stroke="${c.deep}" stroke-width="2.5" stroke-linejoin="round"/>
<!-- swept bang -->
<path d="M ${HEAD_CX - 14} ${HEAD_CY - 14}
         Q ${HEAD_CX} ${HEAD_CY - 18} ${HEAD_CX + 14} ${HEAD_CY - 8}"
      fill="none" stroke="${c.top}" stroke-width="2.5" opacity="0.55"/>`;
}

function hairPonytail(c) {
  return `
<!-- back ponytail (sticks out -->
<path d="M ${HEAD_CX + 12} ${HEAD_CY - 6}
         Q ${HEAD_CX + 32} ${HEAD_CY + 6} ${HEAD_CX + 36} ${HEAD_CY + 30}
         Q ${HEAD_CX + 32} ${HEAD_CY + 36} ${HEAD_CX + 26} ${HEAD_CY + 32}
         Q ${HEAD_CX + 22} ${HEAD_CY + 10} ${HEAD_CX + 6} ${HEAD_CY + 4} Z"
      fill="url(#hair-grad)" stroke="${c.deep}" stroke-width="2.5" stroke-linejoin="round"/>
<!-- crown -->
<path d="M ${HEAD_CX - 22} ${HEAD_CY + 4}
         Q ${HEAD_CX - 24} ${HEAD_CY - 16} ${HEAD_CX - 8} ${HEAD_CY - 26}
         Q ${HEAD_CX + 8} ${HEAD_CY - 28} ${HEAD_CX + 18} ${HEAD_CY - 14}
         Q ${HEAD_CX + 20} ${HEAD_CY - 4} ${HEAD_CX + 12} ${HEAD_CY - 6}
         Q ${HEAD_CX - 2} ${HEAD_CY - 8} ${HEAD_CX - 22} ${HEAD_CY + 4} Z"
      fill="url(#hair-grad)" stroke="${c.deep}" stroke-width="2.5" stroke-linejoin="round"/>
<!-- band -->
<rect x="${HEAD_CX + 8}" y="${HEAD_CY - 10}" width="10" height="4" rx="1.5"
      fill="${c.deep}"/>`;
}

function hairBald(_c) {
  // Effectively a no-op layer (the body's head circle shows). We
  // still emit a near-empty PNG so the worker can fetch the URL
  // and skip naturally; the file ships as a 1×1 transparent stub.
  return `<rect x="0" y="0" width="1" height="1" fill="transparent"/>`;
}

function hairShavedSides(c) {
  return `
<!-- shaved band -->
<rect x="${HEAD_CX - 22}" y="${HEAD_CY - 6}" width="44" height="8" rx="3"
      fill="${c.shadow}" opacity="0.45"/>
<!-- top crop -->
<path d="M ${HEAD_CX - 18} ${HEAD_CY - 6}
         Q ${HEAD_CX - 20} ${HEAD_CY - 22} ${HEAD_CX - 4} ${HEAD_CY - 28}
         Q ${HEAD_CX + 14} ${HEAD_CY - 26} ${HEAD_CX + 18} ${HEAD_CY - 12}
         Q ${HEAD_CX + 20} ${HEAD_CY - 4} ${HEAD_CX + 14} ${HEAD_CY - 6}
         L ${HEAD_CX - 14} ${HEAD_CY - 6} Z"
      fill="url(#hair-grad)" stroke="${c.deep}" stroke-width="2.5" stroke-linejoin="round"/>
<rect x="${HEAD_CX - 8}" y="${HEAD_CY - 24}" width="3" height="14" fill="${c.top}" opacity="0.5"/>`;
}

function hairMullet(c) {
  return `
<!-- back trailing -->
<path d="M ${HEAD_CX - 22} ${HEAD_CY + 6}
         Q ${HEAD_CX - 18} ${HEAD_CY + 40} ${HEAD_CX} ${HEAD_CY + 46}
         Q ${HEAD_CX + 18} ${HEAD_CY + 40} ${HEAD_CX + 22} ${HEAD_CY + 6}
         L ${HEAD_CX + 18} ${HEAD_CY + 2}
         Q ${HEAD_CX} ${HEAD_CY - 4} ${HEAD_CX - 18} ${HEAD_CY + 2} Z"
      fill="url(#hair-grad)" stroke="${c.deep}" stroke-width="2.5" stroke-linejoin="round"/>
<!-- crown -->
<path d="M ${HEAD_CX - 22} ${HEAD_CY + 4}
         Q ${HEAD_CX - 24} ${HEAD_CY - 18} ${HEAD_CX} ${HEAD_CY - 28}
         Q ${HEAD_CX + 24} ${HEAD_CY - 18} ${HEAD_CX + 22} ${HEAD_CY + 4}
         Q ${HEAD_CX + 12} ${HEAD_CY - 6} ${HEAD_CX} ${HEAD_CY - 4}
         Q ${HEAD_CX - 12} ${HEAD_CY - 6} ${HEAD_CX - 22} ${HEAD_CY + 4} Z"
      fill="url(#hair-grad)" stroke="${c.deep}" stroke-width="2.5" stroke-linejoin="round"/>`;
}

function hairWizardLong(c) {
  return `
<!-- long flowing hair down past chest -->
<path d="M ${HEAD_CX - 24} ${HEAD_CY - 4}
         Q ${HEAD_CX - 36} ${HEAD_CY + 40} ${HEAD_CX - 28} ${HEAD_CY + 80}
         L ${HEAD_CX + 28} ${HEAD_CY + 80}
         Q ${HEAD_CX + 36} ${HEAD_CY + 40} ${HEAD_CX + 24} ${HEAD_CY - 4}
         Q ${HEAD_CX + 12} ${HEAD_CY - 30} ${HEAD_CX} ${HEAD_CY - 32}
         Q ${HEAD_CX - 12} ${HEAD_CY - 30} ${HEAD_CX - 24} ${HEAD_CY - 4} Z"
      fill="url(#hair-grad)" stroke="${c.deep}" stroke-width="2.5" stroke-linejoin="round"/>
<!-- forehead bangs -->
<path d="M ${HEAD_CX - 18} ${HEAD_CY - 14}
         Q ${HEAD_CX - 10} ${HEAD_CY - 6} ${HEAD_CX} ${HEAD_CY - 8}
         Q ${HEAD_CX + 10} ${HEAD_CY - 6} ${HEAD_CX + 18} ${HEAD_CY - 14}"
      fill="none" stroke="${c.deep}" stroke-width="2"/>
<!-- gloss stripe -->
<path d="M ${HEAD_CX - 18} ${HEAD_CY - 4}
         Q ${HEAD_CX - 28} ${HEAD_CY + 40} ${HEAD_CX - 24} ${HEAD_CY + 70}"
      fill="none" stroke="${c.top}" stroke-width="3" opacity="0.55"/>`;
}

const HAIR_STYLES = {
  'short-tousled': hairShortTousled,
  'long-straight': hairLongStraight,
  bun:             hairBun,
  mohawk:          hairMohawk,
  braids:          hairBraids,
  'curly-afro':    hairCurlyAfro,
  pixie:           hairPixie,
  ponytail:        hairPonytail,
  bald:            hairBald,
  'shaved-sides':  hairShavedSides,
  mullet:          hairMullet,
  'wizard-long':   hairWizardLong,
};

function hairSvg(style, colourName) {
  const c = HAIR_COLOURS[colourName];
  const shape = HAIR_STYLES[style](c);
  return svgWrapper({
    width: W, height: H,
    title: `hair-${style}-${colourName}`,
    desc: 'Glossy hair layer. Source: tools/build-character-glossy.mjs',
    body: `<defs>${hairDefs(c)}</defs>${shape}`,
  });
}

// ── Eyes ────────────────────────────────────────────────────────
function eyesSvg(colourName) {
  const c = EYE_COLOURS[colourName];
  return svgWrapper({
    width: W, height: H,
    title: `eyes-${colourName}`,
    desc: 'Glossy eye layer.',
    body: `
<!-- left eye -->
<ellipse cx="${HEAD_CX - 8}" cy="${HEAD_CY - 2}" rx="3" ry="4" fill="${c}" stroke="${PALETTE.ink}" stroke-width="1.2"/>
<circle cx="${HEAD_CX - 7}" cy="${HEAD_CY - 3}" r="1" fill="#FFFFFF" opacity="0.9"/>
<!-- right eye -->
<ellipse cx="${HEAD_CX + 8}" cy="${HEAD_CY - 2}" rx="3" ry="4" fill="${c}" stroke="${PALETTE.ink}" stroke-width="1.2"/>
<circle cx="${HEAD_CX + 9}" cy="${HEAD_CY - 3}" r="1" fill="#FFFFFF" opacity="0.9"/>
<!-- brows -->
<path d="M ${HEAD_CX - 13} ${HEAD_CY - 9} L ${HEAD_CX - 3} ${HEAD_CY - 10}"
      stroke="${PALETTE.ink}" stroke-width="1.5" stroke-linecap="round" opacity="0.7"/>
<path d="M ${HEAD_CX + 3} ${HEAD_CY - 10} L ${HEAD_CX + 13} ${HEAD_CY - 9}"
      stroke="${PALETTE.ink}" stroke-width="1.5" stroke-linecap="round" opacity="0.7"/>`,
  });
}

// ── Accents ─────────────────────────────────────────────────────
const ACCENTS = {
  freckles: `
<g fill="#8a4a26" opacity="0.7">
  <circle cx="${HEAD_CX - 9}" cy="${HEAD_CY + 4}" r="0.8"/>
  <circle cx="${HEAD_CX - 6}" cy="${HEAD_CY + 7}" r="0.7"/>
  <circle cx="${HEAD_CX - 3}" cy="${HEAD_CY + 5}" r="0.6"/>
  <circle cx="${HEAD_CX + 2}" cy="${HEAD_CY + 6}" r="0.7"/>
  <circle cx="${HEAD_CX + 6}" cy="${HEAD_CY + 5}" r="0.7"/>
  <circle cx="${HEAD_CX + 9}" cy="${HEAD_CY + 4}" r="0.6"/>
  <circle cx="${HEAD_CX}"     cy="${HEAD_CY + 3}" r="0.6"/>
  <circle cx="${HEAD_CX - 12}" cy="${HEAD_CY + 8}" r="0.6"/>
  <circle cx="${HEAD_CX + 12}" cy="${HEAD_CY + 8}" r="0.6"/>
</g>`,
  'eye-shadow': `
<ellipse cx="${HEAD_CX - 8}" cy="${HEAD_CY - 6}" rx="6" ry="2.5" fill="#7c3aff" opacity="0.55"/>
<ellipse cx="${HEAD_CX + 8}" cy="${HEAD_CY - 6}" rx="6" ry="2.5" fill="#7c3aff" opacity="0.55"/>`,
  'face-scar': `
<path d="M ${HEAD_CX + 6} ${HEAD_CY - 8}
         L ${HEAD_CX + 10} ${HEAD_CY + 6}"
      stroke="#a04030" stroke-width="1.8" stroke-linecap="round" opacity="0.85"/>
<path d="M ${HEAD_CX + 8} ${HEAD_CY - 6}
         L ${HEAD_CX + 8.5} ${HEAD_CY + 4}"
      stroke="#e07868" stroke-width="0.8" stroke-linecap="round" opacity="0.7"/>`,
  'beauty-mark': `
<circle cx="${HEAD_CX + 6}" cy="${HEAD_CY + 8}" r="1.5" fill="#3a1a0a"/>`,
  'glasses-round': `
<g fill="none" stroke="${PALETTE.ink}" stroke-width="1.6">
  <circle cx="${HEAD_CX - 8}" cy="${HEAD_CY - 2}" r="6"/>
  <circle cx="${HEAD_CX + 8}" cy="${HEAD_CY - 2}" r="6"/>
  <line x1="${HEAD_CX - 2}" y1="${HEAD_CY - 2}" x2="${HEAD_CX + 2}" y2="${HEAD_CY - 2}"/>
  <line x1="${HEAD_CX - 14}" y1="${HEAD_CY - 2}" x2="${HEAD_CX - 22}" y2="${HEAD_CY - 4}"/>
  <line x1="${HEAD_CX + 14}" y1="${HEAD_CY - 2}" x2="${HEAD_CX + 22}" y2="${HEAD_CY - 4}"/>
</g>
<ellipse cx="${HEAD_CX - 10}" cy="${HEAD_CY - 4}" rx="2" ry="1" fill="#FFFFFF" opacity="0.55"/>
<ellipse cx="${HEAD_CX + 6}"  cy="${HEAD_CY - 4}" rx="2" ry="1" fill="#FFFFFF" opacity="0.55"/>`,
};

function accentSvg(name) {
  return svgWrapper({
    width: W, height: H,
    title: `accent-${name}`,
    desc: 'Glossy face accent overlay.',
    body: ACCENTS[name],
  });
}

// ── Default clothing ────────────────────────────────────────────
//
// Peasant tunic + trousers in neutral wood/cream so a fresh
// character has clothes on. Always rendered before equipped gear.

function defaultClothingSvg() {
  return svgWrapper({
    width: W, height: H,
    title: 'default-clothing',
    desc: 'Neutral peasant tunic + trousers baseline.',
    body: `
<!-- tunic (matches torso outline) -->
<path d="M ${BODY_LEFT - 2} ${SHOULDER_Y}
         L ${BODY_LEFT - 4 + 6} ${HIP_Y + 4}
         L ${BODY_RIGHT - 2} ${HIP_Y + 4}
         L ${BODY_RIGHT + 2} ${SHOULDER_Y}
         Q ${BODY_RIGHT + 2} ${SHOULDER_Y - 4} ${BODY_RIGHT - 4} ${SHOULDER_Y - 6}
         L ${BODY_LEFT + 4} ${SHOULDER_Y - 6}
         Q ${BODY_LEFT - 2} ${SHOULDER_Y - 4} ${BODY_LEFT - 2} ${SHOULDER_Y} Z"
      fill="url(#gk-grad-cream)" stroke="${PALETTE.cream.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<!-- trousers -->
<path d="M ${BODY_LEFT + 8} ${HIP_Y}
         L ${BODY_LEFT + 10} ${FOOT_Y - 4}
         L ${64 - 2} ${FOOT_Y - 4}
         L ${64 - 2} ${HIP_Y + 2}
         L ${64 + 2} ${HIP_Y + 2}
         L ${64 + 2} ${FOOT_Y - 4}
         L ${BODY_RIGHT - 10} ${FOOT_Y - 4}
         L ${BODY_RIGHT - 8} ${HIP_Y} Z"
      fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<!-- belt -->
<rect x="${BODY_LEFT - 2}" y="${HIP_Y - 4}" width="${BODY_RIGHT - BODY_LEFT + 4}" height="6" rx="2"
      fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="2"/>
<!-- tunic gloss -->
<path d="M ${BODY_LEFT + 6} ${SHOULDER_Y - 4}
         L ${BODY_LEFT + 4} ${HIP_Y - 4}
         L ${BODY_LEFT + 14} ${HIP_Y - 4}
         L ${BODY_LEFT + 14} ${SHOULDER_Y - 4} Z"
      fill="#FFFFFF" opacity="0.4"/>`,
  });
}

// ── Bake driver ─────────────────────────────────────────────────

console.log('Baking character glossy assets…');

let count = 0;

// Bodies — 20.
for (const type of ['slim', 'stocky']) {
  for (const tone of Object.keys(SKIN_TONES)) {
    await bakeFile(bodySvg(type, tone), join(OUT, `body-${type}-${tone}.png`), { width: W, height: H });
    count++;
  }
}
console.log(`  bodies: 20`);

// Hair — 12 styles × 14 colours = 168.
let hairCount = 0;
for (const style of Object.keys(HAIR_STYLES)) {
  for (const colour of Object.keys(HAIR_COLOURS)) {
    await bakeFile(hairSvg(style, colour), join(OUT, `hair-${style}-${colour}.png`), { width: W, height: H });
    hairCount++;
  }
}
count += hairCount;
console.log(`  hair: ${hairCount}`);

// Eyes — 8.
for (const colour of Object.keys(EYE_COLOURS)) {
  await bakeFile(eyesSvg(colour), join(OUT, `eyes-${colour}.png`), { width: W, height: H });
  count++;
}
console.log(`  eyes: ${Object.keys(EYE_COLOURS).length}`);

// Accents — 5.
for (const name of Object.keys(ACCENTS)) {
  await bakeFile(accentSvg(name), join(OUT, `accent-${name}.png`), { width: W, height: H });
  count++;
}
console.log(`  accents: ${Object.keys(ACCENTS).length}`);

// Default clothing — 1.
await bakeFile(defaultClothingSvg(), join(OUT, `default-clothing.png`), { width: W, height: H });
count++;
console.log(`  default clothing: 1`);

console.log(`\n✓ baked ${count} character figure PNGs at ${W}×${H} → ${OUT}`);
