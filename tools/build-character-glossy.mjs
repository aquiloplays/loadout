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
// 128 wide × 160 tall. L2-rework proportions: ~4 heads tall, not the
// stacked-low chibi blob the prior pass shipped. Head diameter ≈ 36,
// torso ≈ 44, legs ≈ 50 — that gives a balanced stance instead of
// everything piled under a giant head.
//
//   y =  10–12   hair crown extra space
//   y =  12–48   head             (HEAD_R=18 → 36-px sphere, cy=30)
//   y =  46–58   neck             (12-px tapered column)
//   y =  58–102  torso            (44-px tall: shoulders → waist)
//   y = 100–110  hip flare        (slight)
//   y = 110–132  thigh            (22 tall)
//   y = 132–152  shin             (20 tall)
//   y = 152–158  feet
//
// Arms hang OUTSIDE the torso silhouette with a visible gap. Hand
// circle sits well below the waist line so any tunic / armor never
// hides it. Hand radius scaled to match the smaller head — 7 px
// reads as a fist at 128-px canvas without looking comical.

const W = 128, H = 160;
const HEAD_CX = 64, HEAD_CY = 30, HEAD_R = 18;
const SHOULDER_Y = 58;
const ARMPIT_Y   = 70;       // where arm separates from torso visibly
const WAIST_Y    = 102;
const HIP_Y      = 110;
const KNEE_Y     = 132;
const ANKLE_Y    = 152;
const FOOT_Y     = 156;
// Arms — slim near-vertical limb. Hand sits roughly at hip level
// (HIP_Y=110) so the arm length matches the torso. HAND_OFFSET_X is
// tight against the body — only a small natural gap from the torso
// silhouette. HAND_R sized in proportion to the wrist (~50 % wider).
const HAND_Y        = 108;
const HAND_R        = 5;
const HAND_OFFSET_X = 22;
// Tiny separation gap so the arm reads as a separate limb but isn't
// "splayed out" away from the body.
const ARM_GAP       = 1;

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
//
// Cel-shaded approach (L3 rework): a SHALLOW linear gradient as the
// base fill, then explicit shadow/highlight shapes drawn on top.
// The prior radial-rgrad was the source of the "every body part is
// an inflated balloon" look — soft gradient + circular shape = sphere.
// A flat-ish base + crisp drawn shading reads as form, not a balloon.

function skinDefs(skin) {
  return `
<!-- shallow top-down linear: subtle warmth at top, settles to base.
     Most of the form is the flat base colour; shadow/highlight come
     from explicit drawn shapes on top of this fill. -->
<linearGradient id="skin-grad" x1="0.5" y1="0" x2="0.5" y2="1">
  <stop offset="0"    stop-color="${skin.hi}"/>
  <stop offset="0.3"  stop-color="${skin.base}"/>
  <stop offset="1"    stop-color="${skin.base}"/>
</linearGradient>
<!-- shadow-side fill (for the right-hand / underside of forms) -->
<linearGradient id="skin-shadow-grad" x1="0.3" y1="0" x2="0.85" y2="1">
  <stop offset="0"    stop-color="${skin.base}"/>
  <stop offset="0.6"  stop-color="${skin.lo}"/>
  <stop offset="1"    stop-color="${skin.lo}"/>
</linearGradient>`;
}

// ── Body shape ──────────────────────────────────────────────────
//
// Premium mobile-RPG hero. Built like a real figure, not segmented
// pieces:
//
//   • One CONTINUOUS arm path per side — shoulder cap → upper-arm
//     bulge → elbow taper → forearm → wrist → hand. No visible bolt
//     joints (the prior pass had shoulder + elbow as separate
//     circles which read as a wooden mannequin).
//   • Torso with a real construction: trapezoid shoulder yoke,
//     pectoral hint, narrow waist, slight hip flare.
//   • Neck integrates head with torso via a wider base + trapezius
//     shading on both sides, so the head doesn't look pasted on.
//   • Legs: thigh → knee → calf → foot, with a stance gap.
//   • Stocky = +30 % shoulder/torso/limb mass with same head + neck
//     so both body types read as the same character.

function bodyShape(type, skin) {
  return bodyShapeL3(type, skin);
}

// ── L3 BODY: deliberate proportions, tapering arms with a visible
// gap from the torso, cel-shaded flat fills (no balloon radial
// gradients), longer torso + longer legs.
function bodyShapeL3(type, skin) {
  const cx = 64;
  const stocky = type === 'stocky';
  // Torso — narrower than the L2 version, longer top-to-bottom
  const shoulderHalf = stocky ? 22 : 18;
  const waistHalf    = stocky ? 16 : 13;
  const hipHalf      = stocky ? 19 : 16;
  const leftShoulderX  = cx - shoulderHalf;
  const rightShoulderX = cx + shoulderHalf;
  const leftWaistX     = cx - waistHalf;
  const rightWaistX    = cx + waistHalf;
  const leftHipX       = cx - hipHalf;
  const rightHipX      = cx + hipHalf;
  // Arms — TAPERING limb, drawn as a separate shape with a visible
  // GAP between the inner arm edge and the torso outer edge. Wider
  // at the shoulder, narrowing steadily to the wrist; the hand is
  // a clean circle slightly bigger than the wrist.
  //   armShoulderW : thickness at the shoulder (top of the arm)
  //   armWristW    : thickness at the wrist (narrower than shoulder)
  // Slim limb proportions. Subtle shoulder→wrist taper (wrist is
  // ~75 % the width of the shoulder, not a dramatic carrot). Width
  // small in absolute terms so the arm is a slender limb, not a
  // flipper. Stocky body type bumps both ends slightly.
  const armShoulderW = stocky ? 8 : 7;
  const armWristW    = stocky ? 6 : 5;
  // The arm's INNER edge sits ARM_GAP outside the torso outer edge
  // — that gap is what makes the arm read as a separate limb rather
  // than a body bulge.
  const leftArmInnerTop  = leftShoulderX  - ARM_GAP;
  const rightArmInnerTop = rightShoulderX + ARM_GAP;
  const leftArmOuterTop  = leftArmInnerTop  - armShoulderW;
  const rightArmOuterTop = rightArmInnerTop + armShoulderW;
  // Hands
  const leftHandX  = cx - HAND_OFFSET_X;
  const rightHandX = cx + HAND_OFFSET_X;
  const leftWristInnerX  = leftHandX  + armWristW / 2;
  const leftWristOuterX  = leftHandX  - armWristW / 2;
  const rightWristInnerX = rightHandX - armWristW / 2;
  const rightWristOuterX = rightHandX + armWristW / 2;
  // Legs — thigh → calf → ankle, longer than L2.
  const thighOuterX = stocky ? 9 : 8;
  const kneeOuterX  = stocky ? 7 : 6;
  const ankleOuterX = stocky ? 5 : 4;
  const footW = stocky ? 16 : 14;
  // Neck — short tapered column under the head
  const neckHalfBase = stocky ? 8 : 7;
  const neckHalfTop  = stocky ? 6 : 5;
  const NECK_TOP_Y   = HEAD_CY + HEAD_R - 3;
  const NECK_BASE_Y  = SHOULDER_Y;
  // Light direction: upper-LEFT. Highlight on left, shadow on right.
  // All "shadow" overlays use skin.lo at 0.4-0.6 opacity; highlights
  // use skin.hi. NO radial gradients — flat shading reads as form,
  // soft gradients read as a balloon.

  return `
${contactShadow({ cx: 64, cy: FOOT_Y + 4, rx: 32, ry: 5 })}

<!-- ── TORSO ── narrow trapezoid: shoulder yoke wider than waist,
     slight hip flare at the bottom. Drawn FIRST so the arms paint
     OVER any shoulder overlap (arms have visible gap, but the
     yoke needs to read as a single torso plane). -->
<path d="M ${leftShoulderX} ${SHOULDER_Y}
         Q ${leftShoulderX + 1} ${SHOULDER_Y - 4} ${leftShoulderX + 4} ${SHOULDER_Y - 4}
         L ${rightShoulderX - 4} ${SHOULDER_Y - 4}
         Q ${rightShoulderX - 1} ${SHOULDER_Y - 4} ${rightShoulderX} ${SHOULDER_Y}
         L ${rightShoulderX - 1} ${ARMPIT_Y - 2}
         Q ${rightWaistX + 1} ${WAIST_Y - 12} ${rightWaistX} ${WAIST_Y}
         L ${rightHipX} ${HIP_Y}
         Q ${rightHipX - 3} ${HIP_Y + 3} ${rightHipX - 5} ${HIP_Y + 3}
         L ${leftHipX + 5} ${HIP_Y + 3}
         Q ${leftHipX + 3} ${HIP_Y + 3} ${leftHipX} ${HIP_Y}
         L ${leftWaistX} ${WAIST_Y}
         Q ${leftWaistX - 1} ${WAIST_Y - 12} ${leftShoulderX + 1} ${ARMPIT_Y - 2} Z"
      fill="url(#skin-grad)" stroke="${skin.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<!-- TORSO SHADOW SIDE (right half) — crisp flat shape, not a soft
     gradient. Reads as cel-shading: light side / shadow side. -->
<path d="M ${cx} ${SHOULDER_Y - 3}
         L ${rightShoulderX - 4} ${SHOULDER_Y - 4}
         Q ${rightShoulderX - 1} ${SHOULDER_Y - 4} ${rightShoulderX} ${SHOULDER_Y}
         L ${rightShoulderX - 1} ${ARMPIT_Y - 2}
         Q ${rightWaistX + 1} ${WAIST_Y - 12} ${rightWaistX} ${WAIST_Y}
         L ${rightHipX} ${HIP_Y}
         Q ${rightHipX - 3} ${HIP_Y + 3} ${rightHipX - 5} ${HIP_Y + 3}
         L ${cx} ${HIP_Y + 3} Z"
      fill="${skin.lo}" opacity="0.18"/>
<!-- centre form line (sternum) — a single crisp shadow line, not a
     radial blob. Gives the torso a centre plane. -->
<path d="M ${cx} ${SHOULDER_Y - 1} L ${cx} ${WAIST_Y + 4}"
      stroke="${skin.lo}" stroke-width="1.1" opacity="0.55"/>
<!-- collarbone form line -->
<path d="M ${leftShoulderX + 4} ${SHOULDER_Y - 1}
         Q ${cx} ${SHOULDER_Y + 3} ${rightShoulderX - 4} ${SHOULDER_Y - 1}"
      fill="none" stroke="${skin.lo}" stroke-width="1" opacity="0.55"/>
<!-- left-side form highlight (light side, runs vertically along the
     left edge of the torso) -->
<path d="M ${leftShoulderX + 2} ${SHOULDER_Y + 2}
         Q ${leftShoulderX + 1} ${ARMPIT_Y + 4} ${leftWaistX + 1} ${WAIST_Y - 6}"
      fill="none" stroke="${skin.hi}" stroke-width="1.4" opacity="0.55" stroke-linecap="round"/>

<!-- ── ARMS ── slim clean-taper limbs with mitt-shape hands. Each
     arm path is two straight tapers (outer + inner edge) with no
     elbow bow. Hand is a palm + thumb combined path. Light side
     on the OUTER edge (away from torso), shadow on the inner. -->

<!-- LEFT arm — clean straight taper, shoulder to wrist -->
<path d="M ${leftArmOuterTop} ${SHOULDER_Y - 1}
         L ${leftWristOuterX} ${HAND_Y - HAND_R}
         L ${leftWristInnerX} ${HAND_Y - HAND_R}
         L ${leftArmInnerTop} ${SHOULDER_Y - 1} Z"
      fill="url(#skin-grad)" stroke="${skin.stroke}" stroke-width="1.8" stroke-linejoin="round"/>
<!-- LEFT arm INNER-edge shadow strip (cel-shaded form) -->
<path d="M ${leftArmInnerTop - 1} ${SHOULDER_Y}
         L ${leftWristInnerX - 1} ${HAND_Y - HAND_R}
         L ${(leftWristInnerX + leftWristOuterX) / 2} ${HAND_Y - HAND_R}
         L ${leftArmInnerTop - 2} ${SHOULDER_Y + 2} Z"
      fill="${skin.lo}" opacity="0.22"/>
<!-- LEFT armpit AO (small dark crescent where arm meets torso) -->
<path d="M ${leftShoulderX - 2} ${SHOULDER_Y + 2}
         Q ${leftShoulderX} ${ARMPIT_Y - 2} ${leftShoulderX + 3} ${ARMPIT_Y}"
      fill="none" stroke="${skin.stroke}" stroke-width="1.6" opacity="0.5" stroke-linecap="round"/>
<!-- LEFT arm OUTER highlight — soft stroke down the light side -->
<path d="M ${leftArmOuterTop + 1} ${SHOULDER_Y + 2}
         L ${leftWristOuterX + 1} ${HAND_Y - HAND_R - 1}"
      fill="none" stroke="${skin.hi}" stroke-width="1" opacity="0.55" stroke-linecap="round"/>
<!-- LEFT hand — mitt: palm ellipse + thumb bump on the INNER (right)
     side. Single closed path so the outline is continuous. -->
<path d="M ${leftHandX} ${HAND_Y - HAND_R - 0.5}
         C ${leftHandX - HAND_R + 1} ${HAND_Y - HAND_R - 0.5},
           ${leftHandX - HAND_R - 0.5} ${HAND_Y - HAND_R + 2},
           ${leftHandX - HAND_R - 0.5} ${HAND_Y}
         C ${leftHandX - HAND_R - 0.5} ${HAND_Y + HAND_R - 1},
           ${leftHandX - HAND_R + 1} ${HAND_Y + HAND_R + 0.5},
           ${leftHandX} ${HAND_Y + HAND_R + 0.5}
         C ${leftHandX + HAND_R - 1} ${HAND_Y + HAND_R + 0.5},
           ${leftHandX + HAND_R + 0.5} ${HAND_Y + HAND_R - 2},
           ${leftHandX + HAND_R + 0.5} ${HAND_Y}
         C ${leftHandX + HAND_R + 1.5} ${HAND_Y - 2},
           ${leftHandX + HAND_R + 2} ${HAND_Y - HAND_R + 1},
           ${leftHandX + HAND_R - 1} ${HAND_Y - HAND_R - 0.5}
         L ${leftHandX} ${HAND_Y - HAND_R - 0.5} Z"
      fill="url(#skin-grad)" stroke="${skin.stroke}" stroke-width="1.6" stroke-linejoin="round"/>
<!-- LEFT hand SHADOW (palm shadow on the lower-right side, cel-shaded) -->
<path d="M ${leftHandX} ${HAND_Y - 1}
         C ${leftHandX + HAND_R/2} ${HAND_Y - 1},
           ${leftHandX + HAND_R + 0.5} ${HAND_Y + 1},
           ${leftHandX + HAND_R + 0.5} ${HAND_Y}
         C ${leftHandX + HAND_R + 0.5} ${HAND_Y + HAND_R - 1},
           ${leftHandX + HAND_R - 1} ${HAND_Y + HAND_R + 0.5},
           ${leftHandX} ${HAND_Y + HAND_R + 0.5} Z"
      fill="${skin.lo}" opacity="0.3"/>
<!-- LEFT hand knuckle line -->
<path d="M ${leftHandX - HAND_R + 1.5} ${HAND_Y + HAND_R - 2}
         Q ${leftHandX} ${HAND_Y + HAND_R} ${leftHandX + HAND_R - 1.5} ${HAND_Y + HAND_R - 2}"
      fill="none" stroke="${skin.stroke}" stroke-width="0.7" opacity="0.5"/>

<!-- RIGHT arm — clean straight taper (mirror of left) -->
<path d="M ${rightArmOuterTop} ${SHOULDER_Y - 1}
         L ${rightWristOuterX} ${HAND_Y - HAND_R}
         L ${rightWristInnerX} ${HAND_Y - HAND_R}
         L ${rightArmInnerTop} ${SHOULDER_Y - 1} Z"
      fill="url(#skin-grad)" stroke="${skin.stroke}" stroke-width="1.8" stroke-linejoin="round"/>
<!-- RIGHT arm SHADOW — outer edge AND inner (this is the away-side
     limb relative to the upper-left light source) -->
<path d="M ${(rightArmInnerTop + rightArmOuterTop) / 2 + 1} ${SHOULDER_Y - 1}
         L ${(rightWristInnerX + rightWristOuterX) / 2 + 1} ${HAND_Y - HAND_R}
         L ${rightWristOuterX} ${HAND_Y - HAND_R}
         L ${rightArmOuterTop - 1} ${SHOULDER_Y} Z"
      fill="${skin.lo}" opacity="0.28"/>
<!-- RIGHT armpit AO -->
<path d="M ${rightShoulderX + 2} ${SHOULDER_Y + 2}
         Q ${rightShoulderX} ${ARMPIT_Y - 2} ${rightShoulderX - 3} ${ARMPIT_Y}"
      fill="none" stroke="${skin.stroke}" stroke-width="1.6" opacity="0.5" stroke-linecap="round"/>
<!-- RIGHT arm OUTER edge — this side is the SHADOW side (light from
     upper-left), so paint a soft form shadow instead of a highlight -->
<path d="M ${rightArmOuterTop - 1} ${SHOULDER_Y + 2}
         L ${rightWristOuterX - 1} ${HAND_Y - HAND_R - 1}"
      fill="none" stroke="${skin.lo}" stroke-width="1" opacity="0.45" stroke-linecap="round"/>
<!-- RIGHT hand — mitt with thumb on the INNER (left) side -->
<path d="M ${rightHandX} ${HAND_Y - HAND_R - 0.5}
         C ${rightHandX + HAND_R - 1} ${HAND_Y - HAND_R - 0.5},
           ${rightHandX + HAND_R + 0.5} ${HAND_Y - HAND_R + 2},
           ${rightHandX + HAND_R + 0.5} ${HAND_Y}
         C ${rightHandX + HAND_R + 0.5} ${HAND_Y + HAND_R - 1},
           ${rightHandX + HAND_R - 1} ${HAND_Y + HAND_R + 0.5},
           ${rightHandX} ${HAND_Y + HAND_R + 0.5}
         C ${rightHandX - HAND_R + 1} ${HAND_Y + HAND_R + 0.5},
           ${rightHandX - HAND_R - 0.5} ${HAND_Y + HAND_R - 2},
           ${rightHandX - HAND_R - 0.5} ${HAND_Y}
         C ${rightHandX - HAND_R - 1.5} ${HAND_Y - 2},
           ${rightHandX - HAND_R - 2} ${HAND_Y - HAND_R + 1},
           ${rightHandX - HAND_R + 1} ${HAND_Y - HAND_R - 0.5}
         L ${rightHandX} ${HAND_Y - HAND_R - 0.5} Z"
      fill="url(#skin-grad)" stroke="${skin.stroke}" stroke-width="1.6" stroke-linejoin="round"/>
<!-- RIGHT hand SHADOW (palm shadow on the right side — away from light) -->
<path d="M ${rightHandX} ${HAND_Y - HAND_R - 0.5}
         C ${rightHandX + HAND_R - 1} ${HAND_Y - HAND_R - 0.5},
           ${rightHandX + HAND_R + 0.5} ${HAND_Y - HAND_R + 2},
           ${rightHandX + HAND_R + 0.5} ${HAND_Y}
         C ${rightHandX + HAND_R + 0.5} ${HAND_Y + HAND_R - 1},
           ${rightHandX + HAND_R - 1} ${HAND_Y + HAND_R + 0.5},
           ${rightHandX} ${HAND_Y + HAND_R + 0.5} Z"
      fill="${skin.lo}" opacity="0.4"/>
<!-- RIGHT hand knuckle line -->
<path d="M ${rightHandX - HAND_R + 1.5} ${HAND_Y + HAND_R - 2}
         Q ${rightHandX} ${HAND_Y + HAND_R} ${rightHandX + HAND_R - 1.5} ${HAND_Y + HAND_R - 2}"
      fill="none" stroke="${skin.stroke}" stroke-width="0.7" opacity="0.5"/>

<!-- ── LEGS ── longer than L2 (50-px) with thigh → knee → calf
     taper. Inner edges nearly touch at the centre (small stance
     gap); outer edge tapers from thigh down to ankle. -->
<!-- LEFT leg -->
<path d="M ${cx - 1} ${HIP_Y + 2}
         L ${cx - thighOuterX} ${HIP_Y + 3}
         C ${cx - thighOuterX - 1} ${KNEE_Y - 10},
           ${cx - kneeOuterX - 1} ${KNEE_Y - 4},
           ${cx - kneeOuterX} ${KNEE_Y + 2}
         C ${cx - kneeOuterX - 1} ${KNEE_Y + 10},
           ${cx - ankleOuterX - 1} ${ANKLE_Y - 6},
           ${cx - ankleOuterX} ${ANKLE_Y}
         L ${cx - 1} ${ANKLE_Y} Z"
      fill="url(#skin-grad)" stroke="${skin.stroke}" stroke-width="2.2" stroke-linejoin="round"/>
<!-- LEFT leg shadow (inner side near the gap) -->
<path d="M ${cx - 1} ${HIP_Y + 2}
         L ${cx - 4} ${HIP_Y + 3}
         L ${cx - 3} ${KNEE_Y + 2}
         L ${cx - 2} ${ANKLE_Y}
         L ${cx - 1} ${ANKLE_Y} Z"
      fill="${skin.lo}" opacity="0.3"/>
<!-- LEFT knee crease line -->
<path d="M ${cx - kneeOuterX} ${KNEE_Y + 1} L ${cx - 2} ${KNEE_Y + 2}"
      stroke="${skin.lo}" stroke-width="0.9" opacity="0.5"/>

<!-- RIGHT leg (mirror) -->
<path d="M ${cx + 1} ${HIP_Y + 2}
         L ${cx + thighOuterX} ${HIP_Y + 3}
         C ${cx + thighOuterX + 1} ${KNEE_Y - 10},
           ${cx + kneeOuterX + 1} ${KNEE_Y - 4},
           ${cx + kneeOuterX} ${KNEE_Y + 2}
         C ${cx + kneeOuterX + 1} ${KNEE_Y + 10},
           ${cx + ankleOuterX + 1} ${ANKLE_Y - 6},
           ${cx + ankleOuterX} ${ANKLE_Y}
         L ${cx + 1} ${ANKLE_Y} Z"
      fill="url(#skin-grad)" stroke="${skin.stroke}" stroke-width="2.2" stroke-linejoin="round"/>
<!-- RIGHT leg has the FULL shadow side (away from light) -->
<path d="M ${cx + 1} ${HIP_Y + 2}
         L ${cx + thighOuterX - 1} ${HIP_Y + 3}
         C ${cx + thighOuterX} ${KNEE_Y - 10},
           ${cx + kneeOuterX} ${KNEE_Y - 4},
           ${cx + kneeOuterX - 1} ${KNEE_Y + 2}
         C ${cx + kneeOuterX} ${KNEE_Y + 10},
           ${cx + ankleOuterX} ${ANKLE_Y - 6},
           ${cx + ankleOuterX - 1} ${ANKLE_Y}
         L ${cx + 1} ${ANKLE_Y} Z"
      fill="${skin.lo}" opacity="0.18"/>
<path d="M ${cx + kneeOuterX} ${KNEE_Y + 1} L ${cx + 2} ${KNEE_Y + 2}"
      stroke="${skin.lo}" stroke-width="0.9" opacity="0.5"/>

<!-- ── FEET ── flat shoe wedges -->
<path d="M ${cx - footW + 2} ${ANKLE_Y}
         L ${cx - 2} ${ANKLE_Y}
         L ${cx - 2} ${FOOT_Y + 2}
         Q ${cx - footW + 2} ${FOOT_Y + 3} ${cx - footW - 1} ${FOOT_Y - 1} Z"
      fill="url(#skin-grad)" stroke="${skin.stroke}" stroke-width="2" stroke-linejoin="round"/>
<path d="M ${cx + footW - 2} ${ANKLE_Y}
         L ${cx + 2} ${ANKLE_Y}
         L ${cx + 2} ${FOOT_Y + 2}
         Q ${cx + footW - 2} ${FOOT_Y + 3} ${cx + footW + 1} ${FOOT_Y - 1} Z"
      fill="url(#skin-grad)" stroke="${skin.stroke}" stroke-width="2" stroke-linejoin="round"/>
<!-- foot shadow (under-arch) -->
<path d="M ${cx - footW - 1} ${FOOT_Y} L ${cx - 2} ${FOOT_Y + 1}" stroke="${skin.lo}" stroke-width="0.9" opacity="0.55"/>
<path d="M ${cx + 2} ${FOOT_Y + 1} L ${cx + footW + 1} ${FOOT_Y} " stroke="${skin.lo}" stroke-width="0.9" opacity="0.55"/>

<!-- ── NECK ── short tapered column under the head. Drawn AFTER
     the torso so the neck base appears to sit on top of the chest. -->
<path d="M ${cx - neckHalfTop}  ${NECK_TOP_Y}
         L ${cx - neckHalfBase} ${NECK_BASE_Y - 1}
         L ${cx + neckHalfBase} ${NECK_BASE_Y - 1}
         L ${cx + neckHalfTop}  ${NECK_TOP_Y} Z"
      fill="url(#skin-grad)" stroke="${skin.stroke}" stroke-width="2" stroke-linejoin="round"/>
<!-- neck shadow (right side) -->
<path d="M ${cx} ${NECK_TOP_Y}
         L ${cx + neckHalfBase} ${NECK_BASE_Y - 1}
         L ${cx + neckHalfTop}  ${NECK_TOP_Y} Z"
      fill="${skin.lo}" opacity="0.35"/>

<!-- ── HEAD ── circle with flat cel-shading. Drawn last so it
     sits ON TOP of the neck/torso. NO radial gradient — flat base
     fill plus a single crescent shadow shape on the right + a
     small highlight on the upper-left. -->
<circle cx="${HEAD_CX}" cy="${HEAD_CY}" r="${HEAD_R}"
        fill="url(#skin-grad)" stroke="${skin.stroke}" stroke-width="2.5"/>
<!-- head SHADOW crescent (right half + jaw underside) -->
<path d="M ${HEAD_CX} ${HEAD_CY - HEAD_R}
         A ${HEAD_R} ${HEAD_R} 0 0 1 ${HEAD_CX} ${HEAD_CY + HEAD_R}
         A ${HEAD_R - 3} ${HEAD_R - 3} 0 0 0 ${HEAD_CX + 2} ${HEAD_CY - HEAD_R + 1} Z"
      fill="${skin.lo}" opacity="0.18"/>
<!-- jaw shadow band -->
<path d="M ${HEAD_CX - HEAD_R + 4} ${HEAD_CY + HEAD_R - 4}
         A ${HEAD_R - 2} ${HEAD_R - 2} 0 0 0 ${HEAD_CX + HEAD_R - 4} ${HEAD_CY + HEAD_R - 4}"
      fill="none" stroke="${skin.lo}" stroke-width="2" opacity="0.4"/>
<!-- small upper-left highlight (NOT a balloon gradient, just a
     defined crescent) -->
<path d="M ${HEAD_CX - HEAD_R + 4} ${HEAD_CY - 4}
         A ${HEAD_R - 2} ${HEAD_R - 2} 0 0 1 ${HEAD_CX - 2} ${HEAD_CY - HEAD_R + 3}"
      fill="none" stroke="${skin.hi}" stroke-width="2" opacity="0.6" stroke-linecap="round"/>
<!-- cheek blush (small + low opacity, not a big blob) -->
<ellipse cx="${HEAD_CX - HEAD_R + 4}" cy="${HEAD_CY + 4}" rx="2.5" ry="1.5" fill="${skin.hi}" opacity="0.55"/>
<ellipse cx="${HEAD_CX + HEAD_R - 4}" cy="${HEAD_CY + 4}" rx="2.5" ry="1.5" fill="${skin.hi}" opacity="0.55"/>

<!-- ── FACE ── nose, mouth, brows (eyes are owned by the eyes-* layer).
     All offsets are scaled to the new HEAD_R=18 head. -->
<!-- NOSE — small triangle nub (more visible than a dot) -->
<path d="M ${HEAD_CX - 1.5} ${HEAD_CY + 4}
         Q ${HEAD_CX} ${HEAD_CY + 6} ${HEAD_CX + 1.5} ${HEAD_CY + 4}"
      fill="${skin.lo}" stroke="${skin.lo}" stroke-width="0.5" opacity="0.7"/>
<!-- MOUTH — friendly smile with corner upturns + subtle lower-lip
     hint. Reads as intentional friendliness, not a default dot. -->
<path d="M ${HEAD_CX - 5} ${HEAD_CY + 8.5}
         Q ${HEAD_CX} ${HEAD_CY + 11} ${HEAD_CX + 5} ${HEAD_CY + 8.5}"
      fill="none" stroke="${PALETTE.ink}" stroke-width="1.3" stroke-linecap="round"/>
<!-- mouth corner upturns (tiny ticks for a smile) -->
<path d="M ${HEAD_CX - 5} ${HEAD_CY + 8.5} L ${HEAD_CX - 5.5} ${HEAD_CY + 7.5}"
      stroke="${PALETTE.ink}" stroke-width="1.1" stroke-linecap="round"/>
<path d="M ${HEAD_CX + 5} ${HEAD_CY + 8.5} L ${HEAD_CX + 5.5} ${HEAD_CY + 7.5}"
      stroke="${PALETTE.ink}" stroke-width="1.1" stroke-linecap="round"/>
<!-- subtle lower-lip line -->
<path d="M ${HEAD_CX - 3} ${HEAD_CY + 11.5} Q ${HEAD_CX} ${HEAD_CY + 12.5} ${HEAD_CX + 3} ${HEAD_CY + 11.5}"
      fill="none" stroke="${skin.lo}" stroke-width="0.7" opacity="0.5"/>
<!-- BROWS — light arched, intentional + friendly. Lower opacity +
     thinner stroke so they read as brows, not slashes. -->
<path d="M ${HEAD_CX - 9.5} ${HEAD_CY - 4}
         Q ${HEAD_CX - 7} ${HEAD_CY - 5.2} ${HEAD_CX - 3.5} ${HEAD_CY - 3.6}"
      fill="none" stroke="${PALETTE.ink}" stroke-width="1" stroke-linecap="round" opacity="0.65"/>
<path d="M ${HEAD_CX + 9.5} ${HEAD_CY - 4}
         Q ${HEAD_CX + 7} ${HEAD_CY - 5.2} ${HEAD_CX + 3.5} ${HEAD_CY - 3.6}"
      fill="none" stroke="${PALETTE.ink}" stroke-width="1" stroke-linecap="round" opacity="0.65"/>
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
  // Tidier afro — base silhouette + intentionally placed curl bumps
  // (not random-feeling stack), all sitting cleanly around the head.
  return `
<!-- base silhouette — a tighter dome so the afro sits ON the head
     instead of floating high above it -->
<path d="M ${HEAD_CX - 26} ${HEAD_CY - 4}
         Q ${HEAD_CX - 30} ${HEAD_CY - 28} ${HEAD_CX} ${HEAD_CY - 36}
         Q ${HEAD_CX + 30} ${HEAD_CY - 28} ${HEAD_CX + 26} ${HEAD_CY - 4}
         Q ${HEAD_CX + 22} ${HEAD_CY - 6} ${HEAD_CX} ${HEAD_CY - 8}
         Q ${HEAD_CX - 22} ${HEAD_CY - 6} ${HEAD_CX - 26} ${HEAD_CY - 4} Z"
      fill="url(#hair-grad)" stroke="${c.deep}" stroke-width="2.5" stroke-linejoin="round"/>
<!-- intentional curl bumps along the silhouette -->
<g fill="url(#hair-grad)" stroke="${c.deep}" stroke-width="1.5">
  <circle cx="${HEAD_CX - 20}" cy="${HEAD_CY - 10}" r="7"/>
  <circle cx="${HEAD_CX + 20}" cy="${HEAD_CY - 10}" r="7"/>
  <circle cx="${HEAD_CX - 12}" cy="${HEAD_CY - 28}" r="8"/>
  <circle cx="${HEAD_CX + 12}" cy="${HEAD_CY - 28}" r="8"/>
  <circle cx="${HEAD_CX}" cy="${HEAD_CY - 34}" r="9"/>
  <circle cx="${HEAD_CX - 22}" cy="${HEAD_CY - 2}" r="5"/>
  <circle cx="${HEAD_CX + 22}" cy="${HEAD_CY - 2}" r="5"/>
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
  // Slimmer wizard-long hair — TWO long side strands that hang from
  // behind the ears down the sides, NOT a full draping curtain that
  // covers the chest. The strands taper to a point.
  return `
<!-- crown — covers the top of the head -->
<path d="M ${HEAD_CX - 24} ${HEAD_CY - 6}
         Q ${HEAD_CX - 26} ${HEAD_CY - 22} ${HEAD_CX - 8} ${HEAD_CY - 30}
         Q ${HEAD_CX + 8} ${HEAD_CY - 32} ${HEAD_CX + 24} ${HEAD_CY - 20}
         Q ${HEAD_CX + 26} ${HEAD_CY - 4} ${HEAD_CX + 24} ${HEAD_CY + 4}
         Q ${HEAD_CX + 12} ${HEAD_CY - 8} ${HEAD_CX} ${HEAD_CY - 10}
         Q ${HEAD_CX - 12} ${HEAD_CY - 8} ${HEAD_CX - 24} ${HEAD_CY + 4} Z"
      fill="url(#hair-grad)" stroke="${c.deep}" stroke-width="2.5" stroke-linejoin="round"/>
<!-- forehead bangs (small fringe) -->
<path d="M ${HEAD_CX - 14} ${HEAD_CY - 16}
         Q ${HEAD_CX - 8} ${HEAD_CY - 4} ${HEAD_CX} ${HEAD_CY - 6}
         Q ${HEAD_CX + 8} ${HEAD_CY - 4} ${HEAD_CX + 14} ${HEAD_CY - 16}
         Q ${HEAD_CX} ${HEAD_CY - 24} ${HEAD_CX - 14} ${HEAD_CY - 16} Z"
      fill="url(#hair-grad)" stroke="${c.deep}" stroke-width="2"/>
<!-- LEFT side strand — narrow ribbon, tapers to a point at y≈+60 -->
<path d="M ${HEAD_CX - 22} ${HEAD_CY}
         Q ${HEAD_CX - 28} ${HEAD_CY + 20} ${HEAD_CX - 26} ${HEAD_CY + 40}
         Q ${HEAD_CX - 24} ${HEAD_CY + 60} ${HEAD_CX - 20} ${HEAD_CY + 70}
         L ${HEAD_CX - 14} ${HEAD_CY + 68}
         Q ${HEAD_CX - 18} ${HEAD_CY + 50} ${HEAD_CX - 18} ${HEAD_CY + 30}
         Q ${HEAD_CX - 16} ${HEAD_CY + 12} ${HEAD_CX - 14} ${HEAD_CY + 2} Z"
      fill="url(#hair-grad)" stroke="${c.deep}" stroke-width="2" stroke-linejoin="round"/>
<!-- RIGHT side strand -->
<path d="M ${HEAD_CX + 22} ${HEAD_CY}
         Q ${HEAD_CX + 28} ${HEAD_CY + 20} ${HEAD_CX + 26} ${HEAD_CY + 40}
         Q ${HEAD_CX + 24} ${HEAD_CY + 60} ${HEAD_CX + 20} ${HEAD_CY + 70}
         L ${HEAD_CX + 14} ${HEAD_CY + 68}
         Q ${HEAD_CX + 18} ${HEAD_CY + 50} ${HEAD_CX + 18} ${HEAD_CY + 30}
         Q ${HEAD_CX + 16} ${HEAD_CY + 12} ${HEAD_CX + 14} ${HEAD_CY + 2} Z"
      fill="url(#hair-grad)" stroke="${c.deep}" stroke-width="2" stroke-linejoin="round"/>
<!-- gloss highlight on left strand -->
<path d="M ${HEAD_CX - 22} ${HEAD_CY + 4}
         Q ${HEAD_CX - 26} ${HEAD_CY + 32} ${HEAD_CX - 22} ${HEAD_CY + 60}"
      fill="none" stroke="${c.top}" stroke-width="1.5" opacity="0.55"/>`;
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
  // Hair shape functions were authored against a 28-px-radius head
  // anchored at (HEAD_CX, HEAD_CY_LEGACY=44). The L3 head is r=18
  // anchored at (HEAD_CX, HEAD_CY=30). We scale the shape uniformly
  // around the LEGACY head centre so all hair offsets stay valid,
  // then translate the result so the scaled origin lands at the new
  // head centre. SCALE = 18/28 ≈ 0.6428.
  const HEAD_CY_LEGACY = 44;
  const HEAD_R_LEGACY  = 28;
  const SCALE          = HEAD_R / HEAD_R_LEGACY;
  // After scaling around the LEGACY anchor (HEAD_CX, HEAD_CY_LEGACY),
  // the legacy anchor stays put. We then translate so the legacy
  // anchor moves to the L3 anchor (HEAD_CX, HEAD_CY).
  const tx = 0;
  const ty = HEAD_CY - HEAD_CY_LEGACY;
  return svgWrapper({
    width: W, height: H,
    title: `hair-${style}-${colourName}`,
    desc: 'Glossy hair layer. Source: tools/build-character-glossy.mjs',
    body: `<defs>${hairDefs(c)}</defs>
<g transform="translate(${tx} ${ty}) translate(${HEAD_CX} ${HEAD_CY_LEGACY}) scale(${SCALE}) translate(${-HEAD_CX} ${-HEAD_CY_LEGACY})">${shape}</g>`,
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
<!-- Layered eyes — sclera (white) with a hairline ink outline, full
     iris in the colour, dark pupil, and a small upper-left gloss
     catch. Sized for the HEAD_R=18 head. Reads as defined +
     expressive without being cartoon-creepy. -->
<!-- LEFT EYE -->
<ellipse cx="${HEAD_CX - 6}" cy="${HEAD_CY}" rx="3.2" ry="3.8" fill="${PALETTE.white}" stroke="${PALETTE.ink}" stroke-width="1.1"/>
<!-- iris (full color circle, not a thin sliver) -->
<circle  cx="${HEAD_CX - 6}" cy="${HEAD_CY + 0.3}" r="2.4" fill="${c}"/>
<!-- iris inner ring (slightly darker for depth) -->
<circle  cx="${HEAD_CX - 6}" cy="${HEAD_CY + 0.3}" r="2.4" fill="none" stroke="${PALETTE.ink}" stroke-width="0.5" opacity="0.4"/>
<!-- pupil (well-defined dark dot) -->
<circle  cx="${HEAD_CX - 6}" cy="${HEAD_CY + 0.3}" r="1.4" fill="${PALETTE.ink}"/>
<!-- gloss catchlight (upper-left, light direction) -->
<circle  cx="${HEAD_CX - 6.8}" cy="${HEAD_CY - 0.8}" r="0.8" fill="${PALETTE.white}"/>
<!-- tiny secondary gloss for sparkle -->
<circle  cx="${HEAD_CX - 5}" cy="${HEAD_CY + 1.2}" r="0.4" fill="${PALETTE.white}" opacity="0.7"/>
<!-- lower lid line (gives eye a defined bottom rim) -->
<path d="M ${HEAD_CX - 9} ${HEAD_CY + 2.5} Q ${HEAD_CX - 6} ${HEAD_CY + 3.4} ${HEAD_CX - 3} ${HEAD_CY + 2.5}"
      fill="none" stroke="${PALETTE.ink}" stroke-width="0.8" opacity="0.6" stroke-linecap="round"/>

<!-- RIGHT EYE (mirror) -->
<ellipse cx="${HEAD_CX + 6}" cy="${HEAD_CY}" rx="3.2" ry="3.8" fill="${PALETTE.white}" stroke="${PALETTE.ink}" stroke-width="1.1"/>
<circle  cx="${HEAD_CX + 6}" cy="${HEAD_CY + 0.3}" r="2.4" fill="${c}"/>
<circle  cx="${HEAD_CX + 6}" cy="${HEAD_CY + 0.3}" r="2.4" fill="none" stroke="${PALETTE.ink}" stroke-width="0.5" opacity="0.4"/>
<circle  cx="${HEAD_CX + 6}" cy="${HEAD_CY + 0.3}" r="1.4" fill="${PALETTE.ink}"/>
<circle  cx="${HEAD_CX + 5.2}" cy="${HEAD_CY - 0.8}" r="0.8" fill="${PALETTE.white}"/>
<circle  cx="${HEAD_CX + 7}" cy="${HEAD_CY + 1.2}" r="0.4" fill="${PALETTE.white}" opacity="0.7"/>
<path d="M ${HEAD_CX + 3} ${HEAD_CY + 2.5} Q ${HEAD_CX + 6} ${HEAD_CY + 3.4} ${HEAD_CX + 9} ${HEAD_CY + 2.5}"
      fill="none" stroke="${PALETTE.ink}" stroke-width="0.8" opacity="0.6" stroke-linecap="round"/>`,
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
  // Same head-rescale wrap as hair — accents were authored against
  // the legacy 28-px head.
  const HEAD_CY_LEGACY = 44;
  const HEAD_R_LEGACY  = 28;
  const SCALE          = HEAD_R / HEAD_R_LEGACY;
  const ty = HEAD_CY - HEAD_CY_LEGACY;
  return svgWrapper({
    width: W, height: H,
    title: `accent-${name}`,
    desc: 'Glossy face accent overlay.',
    body: `<g transform="translate(0 ${ty}) translate(${HEAD_CX} ${HEAD_CY_LEGACY}) scale(${SCALE}) translate(${-HEAD_CX} ${-HEAD_CY_LEGACY})">${ACCENTS[name]}</g>`,
  });
}

// ── Default clothing ────────────────────────────────────────────
//
// Peasant tunic + trousers in neutral wood/cream so a fresh
// character has clothes on. Always rendered before equipped gear.

function defaultClothingSvg() { return defaultClothingSvgL3(); }
function defaultClothingSvgL3() {
  // Neutral peasant tunic + trousers. Real garment construction —
  // not a rectangle:
  //   • Round neckline that visibly wraps around the neck
  //   • Sleeve caps over the shoulder joints
  //   • Cinched waist (narrower than shoulders + hips)
  //   • A-line hem flaring slightly below the belt
  //   • Side seam shadows + chest fold + skirt drape folds
  //   • Belt wraps with shading that follows the waist curve
  //   • Trousers with a centre seam + knee bend + cuff fold
  //
  // Anchored to the body anatomy constants (SHOULDER_Y / WAIST_Y /
  // KNEE_Y / FOOT_Y) — these match build-character-glossy.mjs.
  const cx = 64;
  const shoulderHalf = 20;   // sleeve cap reaches past the body's shoulder line
  const waistHalf    = 14;   // tunic cinches IN at waist
  const hemHalf      = 20;   // A-line hem flare
  const TUNIC_TOP_Y = SHOULDER_Y - 3;
  const TUNIC_HEM_Y = WAIST_Y + 14;
  const BELT_Y      = WAIST_Y - 1;
  const trouserOuterX = 10;
  const trouserKneeX  = 7;
  const trouserAnkleX = 6;
  const TROUSER_TOP_Y = TUNIC_HEM_Y - 1;
  return svgWrapper({
    width: W, height: H,
    title: 'default-clothing',
    desc: 'Neutral peasant tunic + trousers with proper garment construction.',
    body: `
<!-- ── SHORT SLEEVES ── visible cuffs that wrap over the upper arm
     so the tunic reads as a tunic rather than a tank top. Drawn
     FIRST so the bodice paints over the inner edge of each sleeve. -->
<path d="M ${cx - shoulderHalf - 2} ${SHOULDER_Y - 2}
         Q ${cx - shoulderHalf - 6} ${SHOULDER_Y + 2} ${cx - shoulderHalf - 5} ${SHOULDER_Y + 14}
         L ${cx - shoulderHalf + 4} ${SHOULDER_Y + 16}
         Q ${cx - shoulderHalf + 5} ${SHOULDER_Y + 4} ${cx - shoulderHalf + 6} ${SHOULDER_Y - 2} Z"
      fill="url(#gk-grad-cream)" stroke="${PALETTE.cream.stroke}" stroke-width="2.2" stroke-linejoin="round"/>
<path d="M ${cx + shoulderHalf + 2} ${SHOULDER_Y - 2}
         Q ${cx + shoulderHalf + 6} ${SHOULDER_Y + 2} ${cx + shoulderHalf + 5} ${SHOULDER_Y + 14}
         L ${cx + shoulderHalf - 4} ${SHOULDER_Y + 16}
         Q ${cx + shoulderHalf - 5} ${SHOULDER_Y + 4} ${cx + shoulderHalf - 6} ${SHOULDER_Y - 2} Z"
      fill="url(#gk-grad-cream)" stroke="${PALETTE.cream.stroke}" stroke-width="2.2" stroke-linejoin="round"/>
<!-- sleeve cuff lines -->
<path d="M ${cx - shoulderHalf - 5} ${SHOULDER_Y + 13} L ${cx - shoulderHalf + 4} ${SHOULDER_Y + 15}"
      stroke="${PALETTE.cream.stroke}" stroke-width="1" opacity="0.7"/>
<path d="M ${cx + shoulderHalf + 5} ${SHOULDER_Y + 13} L ${cx + shoulderHalf - 4} ${SHOULDER_Y + 15}"
      stroke="${PALETTE.cream.stroke}" stroke-width="1" opacity="0.7"/>

<!-- ── TUNIC ── neckline + bodice + cinched waist + A-line hem. -->
<path d="M ${cx - shoulderHalf + 2} ${TUNIC_TOP_Y + 2}
         Q ${cx - shoulderHalf - 1} ${TUNIC_TOP_Y + 4} ${cx - shoulderHalf + 1} ${SHOULDER_Y + 10}
         L ${cx - shoulderHalf + 5} ${SHOULDER_Y + 14}
         Q ${cx - waistHalf - 1} ${WAIST_Y - 8} ${cx - waistHalf} ${WAIST_Y + 2}
         Q ${cx - waistHalf - 1} ${WAIST_Y + 6} ${cx - hemHalf} ${TUNIC_HEM_Y}
         Q ${cx - hemHalf + 2} ${TUNIC_HEM_Y + 3} ${cx - hemHalf + 6} ${TUNIC_HEM_Y + 2}
         L ${cx + hemHalf - 6} ${TUNIC_HEM_Y + 2}
         Q ${cx + hemHalf - 2} ${TUNIC_HEM_Y + 3} ${cx + hemHalf} ${TUNIC_HEM_Y}
         Q ${cx + waistHalf + 1} ${WAIST_Y + 6} ${cx + waistHalf} ${WAIST_Y + 2}
         Q ${cx + waistHalf + 1} ${WAIST_Y - 8} ${cx + shoulderHalf - 5} ${SHOULDER_Y + 14}
         L ${cx + shoulderHalf - 1} ${SHOULDER_Y + 10}
         Q ${cx + shoulderHalf + 1} ${TUNIC_TOP_Y + 4} ${cx + shoulderHalf - 2} ${TUNIC_TOP_Y + 2}
         Q ${cx + 10} ${TUNIC_TOP_Y - 2} ${cx + 5} ${SHOULDER_Y + 2}
         Q ${cx + 2} ${SHOULDER_Y + 6} ${cx} ${SHOULDER_Y + 6}
         Q ${cx - 2} ${SHOULDER_Y + 6} ${cx - 5} ${SHOULDER_Y + 2}
         Q ${cx - 10} ${TUNIC_TOP_Y - 2} ${cx - shoulderHalf + 2} ${TUNIC_TOP_Y + 2} Z"
      fill="url(#gk-grad-cream)" stroke="${PALETTE.cream.stroke}" stroke-width="2.5" stroke-linejoin="round"/>

<!-- neckline rim shadow — gives the collar visual depth -->
<path d="M ${cx - 7} ${SHOULDER_Y + 4}
         Q ${cx} ${SHOULDER_Y + 11} ${cx + 7} ${SHOULDER_Y + 4}"
      fill="none" stroke="${PALETTE.cream.stroke}" stroke-width="1.5" opacity="0.65"/>
<!-- sleeve seam (where sleeve cap meets bodice) -->
<path d="M ${cx - shoulderHalf + 4} ${SHOULDER_Y + 10} Q ${cx - shoulderHalf + 8} ${SHOULDER_Y + 14} ${cx - waistHalf + 2} ${WAIST_Y - 10}"
      fill="none" stroke="${PALETTE.cream.stroke}" stroke-width="0.9" opacity="0.55"/>
<path d="M ${cx + shoulderHalf - 4} ${SHOULDER_Y + 10} Q ${cx + shoulderHalf - 8} ${SHOULDER_Y + 14} ${cx + waistHalf - 2} ${WAIST_Y - 10}"
      fill="none" stroke="${PALETTE.cream.stroke}" stroke-width="0.9" opacity="0.55"/>

<!-- chest fold (centre, vertical down to belt) -->
<path d="M ${cx} ${SHOULDER_Y + 12} L ${cx} ${WAIST_Y - 4}"
      fill="none" stroke="${PALETTE.cream.stroke}" stroke-width="0.8" opacity="0.5"/>
<!-- side fold (left + right of chest) -->
<path d="M ${cx - 10} ${SHOULDER_Y + 14} Q ${cx - 12} ${WAIST_Y - 6} ${cx - 8} ${WAIST_Y - 2}"
      fill="none" stroke="${PALETTE.cream.stroke}" stroke-width="0.7" opacity="0.4"/>
<path d="M ${cx + 10} ${SHOULDER_Y + 14} Q ${cx + 12} ${WAIST_Y - 6} ${cx + 8} ${WAIST_Y - 2}"
      fill="none" stroke="${PALETTE.cream.stroke}" stroke-width="0.7" opacity="0.4"/>

<!-- TUNIC GLOSS — upper-left highlight (consistent light direction) -->
<path d="M ${cx - shoulderHalf + 4} ${TUNIC_TOP_Y + 4}
         Q ${cx - shoulderHalf + 1} ${SHOULDER_Y + 12} ${cx - waistHalf + 3} ${WAIST_Y - 4}
         L ${cx - waistHalf + 7} ${WAIST_Y - 4}
         Q ${cx - 6} ${SHOULDER_Y + 14} ${cx - shoulderHalf + 10} ${TUNIC_TOP_Y + 4} Z"
      fill="#FFFFFF" opacity="0.35"/>

<!-- HEM — visible bottom edge of the tunic with shadow under -->
<path d="M ${cx - hemHalf + 2} ${TUNIC_HEM_Y + 1}
         Q ${cx} ${TUNIC_HEM_Y + 4} ${cx + hemHalf - 2} ${TUNIC_HEM_Y + 1}"
      fill="none" stroke="${PALETTE.cream.stroke}" stroke-width="1.4" opacity="0.85"/>
<!-- skirt drape folds (3 vertical lines, fanning out toward hem) -->
<path d="M ${cx - 12} ${WAIST_Y + 8} L ${cx - 14} ${TUNIC_HEM_Y - 1}"
      fill="none" stroke="${PALETTE.cream.stroke}" stroke-width="0.8" opacity="0.45"/>
<path d="M ${cx} ${WAIST_Y + 8} L ${cx} ${TUNIC_HEM_Y - 1}"
      fill="none" stroke="${PALETTE.cream.stroke}" stroke-width="0.8" opacity="0.45"/>
<path d="M ${cx + 12} ${WAIST_Y + 8} L ${cx + 14} ${TUNIC_HEM_Y - 1}"
      fill="none" stroke="${PALETTE.cream.stroke}" stroke-width="0.8" opacity="0.45"/>

<!-- ── BELT ── wraps around the waist; slight downward arc so it
     reads as cinched, not just pasted on. -->
<path d="M ${cx - waistHalf - 1} ${BELT_Y}
         Q ${cx} ${BELT_Y + 3} ${cx + waistHalf + 1} ${BELT_Y}
         L ${cx + waistHalf + 1} ${BELT_Y + 6}
         Q ${cx} ${BELT_Y + 9} ${cx - waistHalf - 1} ${BELT_Y + 6} Z"
      fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="2" stroke-linejoin="round"/>
<!-- belt highlight strip -->
<path d="M ${cx - waistHalf - 1} ${BELT_Y + 1} Q ${cx} ${BELT_Y + 4} ${cx + waistHalf + 1} ${BELT_Y + 1}"
      fill="none" stroke="${PALETTE.wood.hi}" stroke-width="0.9" opacity="0.7"/>
<!-- buckle -->
<rect x="${cx - 5}" y="${BELT_Y + 1}" width="10" height="6" rx="1.5"
      fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1.5"/>
<rect x="${cx - 3}" y="${BELT_Y + 3}" width="6" height="2" fill="${PALETTE.gold.lo}" opacity="0.7"/>

<!-- ── TROUSERS ── proper legs with centre seam + cuff -->
<!-- left trouser -->
<path d="M ${cx - 1} ${TROUSER_TOP_Y}
         L ${cx - trouserOuterX} ${TROUSER_TOP_Y}
         Q ${cx - trouserOuterX - 1} ${KNEE_Y - 4} ${cx - trouserKneeX} ${KNEE_Y + 2}
         Q ${cx - trouserKneeX - 1} ${KNEE_Y + 6} ${cx - trouserAnkleX} ${FOOT_Y - 4}
         L ${cx - 1} ${FOOT_Y - 4} Z"
      fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="2.2" stroke-linejoin="round"/>
<!-- right trouser -->
<path d="M ${cx + 1} ${TROUSER_TOP_Y}
         L ${cx + trouserOuterX} ${TROUSER_TOP_Y}
         Q ${cx + trouserOuterX + 1} ${KNEE_Y - 4} ${cx + trouserKneeX} ${KNEE_Y + 2}
         Q ${cx + trouserKneeX + 1} ${KNEE_Y + 6} ${cx + trouserAnkleX} ${FOOT_Y - 4}
         L ${cx + 1} ${FOOT_Y - 4} Z"
      fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="2.2" stroke-linejoin="round"/>
<!-- trouser centre seam (the gap line between the legs) -->
<path d="M ${cx} ${TROUSER_TOP_Y + 1} L ${cx} ${FOOT_Y - 5}"
      fill="none" stroke="${PALETTE.wood.stroke}" stroke-width="0.8" opacity="0.55"/>
<!-- knee fold (per leg) -->
<path d="M ${cx - trouserKneeX} ${KNEE_Y} L ${cx - 3} ${KNEE_Y + 1}"
      fill="none" stroke="${PALETTE.wood.stroke}" stroke-width="0.7" opacity="0.5"/>
<path d="M ${cx + trouserKneeX} ${KNEE_Y} L ${cx + 3} ${KNEE_Y + 1}"
      fill="none" stroke="${PALETTE.wood.stroke}" stroke-width="0.7" opacity="0.5"/>
<!-- cuff line (above the feet) -->
<path d="M ${cx - trouserAnkleX} ${FOOT_Y - 5} L ${cx - 1} ${FOOT_Y - 5}"
      fill="none" stroke="${PALETTE.wood.stroke}" stroke-width="1" opacity="0.7"/>
<path d="M ${cx + 1} ${FOOT_Y - 5} L ${cx + trouserAnkleX} ${FOOT_Y - 5}"
      fill="none" stroke="${PALETTE.wood.stroke}" stroke-width="1" opacity="0.7"/>`,
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
