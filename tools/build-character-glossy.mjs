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

// ── Canvas + anatomy anchors ────────────────────────────────────
//
// 128 wide × 160 tall. Premium game-icon proportions (Hearthstone /
// Clash idiom): big expressive head occupies the upper third,
// torso + visible-hand arms in the middle, legs with proper feet
// at the bottom. Quality-rework pass (2026-05): the previous
// proportions had a tiny head + stub legs that read as a block
// stack, not a character.
//
//   y =   0–24   hair crown  ← above head circle, where hair piles
//   y =  16–72   head        ← skin face area (r=28 → 56-wide head)
//   y =  46–54   eye band    ← bigger eyes, ~3px tall each
//   y =  68–80   neck        ← short transition, jaw shadow above
//   y =  78–122  torso       ← shoulders → waist (44px tall)
//   y = 122–152  legs        ← knee → ankle (30px)
//   y = 150–158  feet        ← visible boots/shoes (the body itself
//                              has a foot wedge so a bare hero
//                              doesn't render legless)
//
// Arms hang at sides from shoulder (y=82) down to wrist (y=120)
// with visible HANDS sticking out, so heroes don't look like flippers.

const W = 128, H = 160;
const HEAD_CX = 64, HEAD_CY = 44, HEAD_R = 28;       // bigger expressive head
const BODY_LEFT = 38, BODY_RIGHT = 90;                // torso bounds (tighter than head)
const SHOULDER_Y = 80;
const WAIST_Y    = 118;                               // hips/waist
const KNEE_Y     = 138;
const FOOT_Y     = 154;                               // soles touch here
// Arms: hands sit clearly BELOW the waist tunic line, so they always
// show on top of clothing/gear. ±30 from cx keeps them outside the
// torso silhouette no matter the body type.
const HAND_Y     = 128;
const HAND_R     = 8;
const HAND_OFFSET_X = 30;

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
// Premium game-icon hero. Big head, defined shoulders + waist,
// visible hands at the sides, visible feet at the bottom. Slim
// vs stocky changes the torso/hip width + slightly the shoulder
// breadth; head proportions stay constant so the figure reads as
// the same character regardless of body type.

function bodyShape(type, skin) {
  const cx = 64;
  // Shoulder line is wider than the waist — classic upper-body
  // taper. Stocky pushes both wider.
  const shoulderHalf = type === 'stocky' ? 25 : 21;
  const waistHalf    = type === 'stocky' ? 21 : 17;
  const leftShoulderX  = cx - shoulderHalf;
  const rightShoulderX = cx + shoulderHalf;
  const leftWaistX     = cx - waistHalf;
  const rightWaistX    = cx + waistHalf;
  // Feet wedge — visible at the bottom even without boots so a
  // bare hero doesn't look legless under the tunic.
  const footW = type === 'stocky' ? 18 : 16;
  // Arm geometry: shoulders, elbows, hands. Capsule shape with an
  // explicit elbow + a big rounded hand circle. The hand circle sits
  // *outside* every tunic/cloak silhouette so the figure always reads
  // as having visible hands.
  const armUpperW = type === 'stocky' ? 13 : 11;
  const armForeW  = type === 'stocky' ? 11 : 9;
  const shoulderJointR = type === 'stocky' ? 8 : 7;
  // Hands hang well outside the torso. ±HAND_OFFSET_X from cx, well
  // below the tunic-waist line so the tunic never covers them.
  const leftHandX  = cx - HAND_OFFSET_X;
  const rightHandX = cx + HAND_OFFSET_X;
  // Upper-arm slopes from shoulder ball outward to elbow; forearm
  // slopes back inward to the hand — gives the figure a relaxed pose
  // rather than stick-straight arms.
  const ELBOW_Y    = SHOULDER_Y + 24;
  const leftElbowX  = leftShoulderX  - 6;
  const rightElbowX = rightShoulderX + 6;
  return `
${contactShadow({ cx: 64, cy: 158, rx: 38, ry: 6 })}

<!-- ── ARMS ── shoulder ball → upper arm → elbow → forearm → hand
     circle. Drawn BEFORE the torso so the torso paints over the
     shoulder joint cleanly. Hands sit clear of any tunic line. -->
<!-- left upper arm (shoulder → elbow) -->
<path d="M ${leftShoulderX - armUpperW/2} ${SHOULDER_Y}
         L ${leftShoulderX + armUpperW/2} ${SHOULDER_Y}
         L ${leftElbowX + armForeW/2 + 1} ${ELBOW_Y}
         L ${leftElbowX - armForeW/2 - 1} ${ELBOW_Y} Z"
      fill="url(#skin-grad)" stroke="${skin.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<!-- left forearm (elbow → hand) -->
<path d="M ${leftElbowX - armForeW/2 - 1} ${ELBOW_Y}
         L ${leftElbowX + armForeW/2 + 1} ${ELBOW_Y}
         L ${leftHandX + armForeW/2} ${HAND_Y - HAND_R + 2}
         L ${leftHandX - armForeW/2} ${HAND_Y - HAND_R + 2} Z"
      fill="url(#skin-grad)" stroke="${skin.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<!-- left shoulder ball + hand ball (drawn as explicit circles so
     they always read at 128-px) -->
<circle cx="${leftShoulderX}" cy="${SHOULDER_Y + 2}" r="${shoulderJointR}"
        fill="url(#skin-rgrad)" stroke="${skin.stroke}" stroke-width="2.5"/>
<circle cx="${leftHandX}" cy="${HAND_Y}" r="${HAND_R}"
        fill="url(#skin-rgrad)" stroke="${skin.stroke}" stroke-width="2.5"/>
<!-- knuckle hint on the hand -->
<path d="M ${leftHandX - 4} ${HAND_Y + 3} Q ${leftHandX} ${HAND_Y + 5} ${leftHandX + 4} ${HAND_Y + 3}"
      fill="none" stroke="${skin.stroke}" stroke-width="1" opacity="0.55"/>

<!-- right upper arm -->
<path d="M ${rightShoulderX - armUpperW/2} ${SHOULDER_Y}
         L ${rightShoulderX + armUpperW/2} ${SHOULDER_Y}
         L ${rightElbowX + armForeW/2 + 1} ${ELBOW_Y}
         L ${rightElbowX - armForeW/2 - 1} ${ELBOW_Y} Z"
      fill="url(#skin-grad)" stroke="${skin.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<!-- right forearm -->
<path d="M ${rightElbowX - armForeW/2 - 1} ${ELBOW_Y}
         L ${rightElbowX + armForeW/2 + 1} ${ELBOW_Y}
         L ${rightHandX + armForeW/2} ${HAND_Y - HAND_R + 2}
         L ${rightHandX - armForeW/2} ${HAND_Y - HAND_R + 2} Z"
      fill="url(#skin-grad)" stroke="${skin.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<circle cx="${rightShoulderX}" cy="${SHOULDER_Y + 2}" r="${shoulderJointR}"
        fill="url(#skin-rgrad)" stroke="${skin.stroke}" stroke-width="2.5"/>
<circle cx="${rightHandX}" cy="${HAND_Y}" r="${HAND_R}"
        fill="url(#skin-rgrad)" stroke="${skin.stroke}" stroke-width="2.5"/>
<path d="M ${rightHandX - 4} ${HAND_Y + 3} Q ${rightHandX} ${HAND_Y + 5} ${rightHandX + 4} ${HAND_Y + 3}"
      fill="none" stroke="${skin.stroke}" stroke-width="1" opacity="0.55"/>

<!-- ── TORSO ── tapered: wider shoulders → narrower waist. Drawn
     AFTER arms so the shoulder ball seam at the inner edge looks
     clean. -->
<path d="M ${leftShoulderX} ${SHOULDER_Y}
         Q ${leftShoulderX + 2} ${SHOULDER_Y - 4} ${leftShoulderX + 6} ${SHOULDER_Y - 5}
         L ${rightShoulderX - 6} ${SHOULDER_Y - 5}
         Q ${rightShoulderX - 2} ${SHOULDER_Y - 4} ${rightShoulderX} ${SHOULDER_Y}
         L ${rightWaistX} ${WAIST_Y}
         Q ${rightWaistX - 2} ${WAIST_Y + 4} ${rightWaistX - 5} ${WAIST_Y + 4}
         L ${leftWaistX + 5} ${WAIST_Y + 4}
         Q ${leftWaistX + 2} ${WAIST_Y + 4} ${leftWaistX} ${WAIST_Y} Z"
      fill="url(#skin-grad)" stroke="${skin.stroke}" stroke-width="3" stroke-linejoin="round"/>

<!-- ── LEGS ── tapered from hip down to ankle, slight stance gap -->
<!-- left leg -->
<path d="M ${leftWaistX + 3} ${WAIST_Y + 2}
         Q ${leftWaistX + 1} ${KNEE_Y} ${cx - 6} ${FOOT_Y - 2}
         L ${cx - 1} ${FOOT_Y - 2}
         L ${cx - 1} ${WAIST_Y + 2} Z"
      fill="url(#skin-grad)" stroke="${skin.stroke}" stroke-width="3" stroke-linejoin="round"/>
<!-- right leg -->
<path d="M ${rightWaistX - 3} ${WAIST_Y + 2}
         Q ${rightWaistX - 1} ${KNEE_Y} ${cx + 6} ${FOOT_Y - 2}
         L ${cx + 1} ${FOOT_Y - 2}
         L ${cx + 1} ${WAIST_Y + 2} Z"
      fill="url(#skin-grad)" stroke="${skin.stroke}" stroke-width="3" stroke-linejoin="round"/>

<!-- ── FEET ── flat wedges so a bare/sandalled hero shows feet -->
<ellipse cx="${cx - 8}" cy="${FOOT_Y}" rx="${footW/2}" ry="4"
         fill="url(#skin-rgrad)" stroke="${skin.stroke}" stroke-width="2.5"/>
<ellipse cx="${cx + 8}" cy="${FOOT_Y}" rx="${footW/2}" ry="4"
         fill="url(#skin-rgrad)" stroke="${skin.stroke}" stroke-width="2.5"/>

<!-- ── NECK ── short tapered transition under the head -->
<path d="M ${cx - 9} ${HEAD_CY + HEAD_R - 4}
         L ${cx - 11} ${SHOULDER_Y - 4}
         L ${cx + 11} ${SHOULDER_Y - 4}
         L ${cx + 9} ${HEAD_CY + HEAD_R - 4} Z"
      fill="url(#skin-grad)" stroke="${skin.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<!-- collarbone hint -->
<path d="M ${leftShoulderX + 4} ${SHOULDER_Y - 1} Q ${cx} ${SHOULDER_Y + 3} ${rightShoulderX - 4} ${SHOULDER_Y - 1}"
      fill="none" stroke="${skin.lo}" stroke-width="1.2" opacity="0.6"/>

<!-- ── HEAD ── big expressive circle -->
<circle cx="${HEAD_CX}" cy="${HEAD_CY}" r="${HEAD_R}"
        fill="url(#skin-rgrad)" stroke="${skin.stroke}" stroke-width="3.5"/>
<!-- jaw shadow under chin (gives the head dimensionality) -->
<ellipse cx="${HEAD_CX}" cy="${HEAD_CY + HEAD_R - 3}" rx="18" ry="5" fill="${skin.lo}" opacity="0.55"/>
<!-- cheek blush dots — friendly + characterful -->
<ellipse cx="${HEAD_CX - 14}" cy="${HEAD_CY + 8}" rx="5" ry="3" fill="${skin.hi}" opacity="0.55"/>
<ellipse cx="${HEAD_CX + 14}" cy="${HEAD_CY + 8}" rx="5" ry="3" fill="${skin.hi}" opacity="0.55"/>
<!-- head gloss highlight (upper-left, glossy idiom) -->
<ellipse cx="${HEAD_CX - 10}" cy="${HEAD_CY - 12}" rx="10" ry="6" fill="#FFFFFF" opacity="0.5"/>

<!-- ── FACE ── readable at 128-px scale: nose tab + smile + brows.
     Eyes are NOT drawn here; the eyes-<colour>.png layer paints
     them so the colour customisation slot has clear ownership. -->
<!-- small nose nub centred -->
<ellipse cx="${HEAD_CX}" cy="${HEAD_CY + 4}" rx="2" ry="2.5" fill="${skin.lo}" opacity="0.6"/>
<!-- mouth — gentle smile curve -->
<path d="M ${HEAD_CX - 6} ${HEAD_CY + 12}
         Q ${HEAD_CX} ${HEAD_CY + 16} ${HEAD_CX + 6} ${HEAD_CY + 12}"
      fill="none" stroke="${PALETTE.ink}" stroke-width="1.6" stroke-linecap="round" opacity="0.85"/>
<!-- brows (placed just above where eyes will land) -->
<path d="M ${HEAD_CX - 14} ${HEAD_CY - 4} Q ${HEAD_CX - 9} ${HEAD_CY - 6} ${HEAD_CX - 4} ${HEAD_CY - 4}"
      fill="none" stroke="${PALETTE.ink}" stroke-width="1.5" stroke-linecap="round" opacity="0.75"/>
<path d="M ${HEAD_CX + 14} ${HEAD_CY - 4} Q ${HEAD_CX + 9} ${HEAD_CY - 6} ${HEAD_CX + 4} ${HEAD_CY - 4}"
      fill="none" stroke="${PALETTE.ink}" stroke-width="1.5" stroke-linecap="round" opacity="0.75"/>
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
    desc: 'Glossy eye layer — larger pupils + iris highlight so the face reads at 128-px.',
    body: `
<!-- left eye -->
<ellipse cx="${HEAD_CX - 10}" cy="${HEAD_CY}" rx="4" ry="5" fill="${PALETTE.white}" stroke="${PALETTE.ink}" stroke-width="1.5"/>
<ellipse cx="${HEAD_CX - 10}" cy="${HEAD_CY + 1}" rx="3" ry="4" fill="${c}"/>
<circle  cx="${HEAD_CX - 11}" cy="${HEAD_CY - 1}" r="1.4" fill="${PALETTE.ink}"/>
<circle  cx="${HEAD_CX - 10.5}" cy="${HEAD_CY - 1.5}" r="0.7" fill="${PALETTE.white}"/>
<!-- right eye -->
<ellipse cx="${HEAD_CX + 10}" cy="${HEAD_CY}" rx="4" ry="5" fill="${PALETTE.white}" stroke="${PALETTE.ink}" stroke-width="1.5"/>
<ellipse cx="${HEAD_CX + 10}" cy="${HEAD_CY + 1}" rx="3" ry="4" fill="${c}"/>
<circle  cx="${HEAD_CX + 9}"  cy="${HEAD_CY - 1}" r="1.4" fill="${PALETTE.ink}"/>
<circle  cx="${HEAD_CX + 9.5}" cy="${HEAD_CY - 1.5}" r="0.7" fill="${PALETTE.white}"/>`,
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
  // Tracks the new body anatomy: shoulders SHOULDER_Y, waist
  // WAIST_Y, feet FOOT_Y. Tunic ends at the waist so default
  // trousers show below; legs in trousers stop above the feet
  // wedges so the bare feet still show.
  const cx = 64;
  const shoulderHalf = 22;     // tunic sits over both slim + stocky shoulders
  const waistHalf    = 18;
  return svgWrapper({
    width: W, height: H,
    title: 'default-clothing',
    desc: 'Neutral peasant tunic + trousers baseline.',
    body: `
<!-- tunic — tapered from shoulders to waist, scoop neckline -->
<path d="M ${cx - shoulderHalf} ${SHOULDER_Y - 1}
         Q ${cx - 12} ${SHOULDER_Y + 6} ${cx - 6} ${SHOULDER_Y + 8}
         Q ${cx} ${SHOULDER_Y + 10} ${cx + 6} ${SHOULDER_Y + 8}
         Q ${cx + 12} ${SHOULDER_Y + 6} ${cx + shoulderHalf} ${SHOULDER_Y - 1}
         L ${cx + waistHalf + 2} ${WAIST_Y + 4}
         L ${cx - waistHalf - 2} ${WAIST_Y + 4} Z"
      fill="url(#gk-grad-cream)" stroke="${PALETTE.cream.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<!-- tunic gloss highlight (upper-left) -->
<path d="M ${cx - shoulderHalf + 2} ${SHOULDER_Y - 1}
         L ${cx - waistHalf} ${WAIST_Y}
         L ${cx - waistHalf + 8} ${WAIST_Y}
         Q ${cx - 8} ${SHOULDER_Y + 8} ${cx - shoulderHalf + 10} ${SHOULDER_Y - 1} Z"
      fill="#FFFFFF" opacity="0.4"/>

<!-- belt — wood, gold buckle -->
<rect x="${cx - waistHalf - 2}" y="${WAIST_Y - 2}" width="${(waistHalf + 2) * 2}" height="8" rx="2"
      fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="2"/>
<rect x="${cx - 5}" y="${WAIST_Y - 1}" width="10" height="6" rx="1.5"
      fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1.5"/>

<!-- trousers — two legs with knee taper, ending above the feet -->
<path d="M ${cx - waistHalf + 2} ${WAIST_Y + 6}
         Q ${cx - waistHalf + 2} ${KNEE_Y - 2} ${cx - 8} ${FOOT_Y - 6}
         L ${cx - 1} ${FOOT_Y - 6}
         L ${cx - 1} ${WAIST_Y + 6} Z"
      fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<path d="M ${cx + waistHalf - 2} ${WAIST_Y + 6}
         Q ${cx + waistHalf - 2} ${KNEE_Y - 2} ${cx + 8} ${FOOT_Y - 6}
         L ${cx + 1} ${FOOT_Y - 6}
         L ${cx + 1} ${WAIST_Y + 6} Z"
      fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="2.5" stroke-linejoin="round"/>`,
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
