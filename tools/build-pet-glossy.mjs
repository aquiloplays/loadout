// J3 — Glossy pet sprites + mood overlays at the figure canvas dims.
//
// Replaces the retired 64×80 pixel pet PNGs with 128×160 glossy
// SVGs baked to PNG so character.js compose can layer them on the
// new HD figure canvas without the dimension-mismatch crash.
//
// Pet sits at the lower-right of the figure canvas — beside the
// hero's right foot — so it's clearly an in-frame companion
// (z=15, behind the body).
//
// Catalogue matches discord-bot/pet.js SPECIES_COLOURS:
//   cat:        black, tabby, ginger, calico
//   dog:        cream, spotted, amber, midnight
//   owl:        barn, snowy, sage, twilight
//   fox:        rust, arctic, plum, gold
//   slime:      mint, cobalt, rose, aurora
//   dragonling: emerald, ember, storm, voltaic
//   frog:       leaf, lily, inkblot, sunburst
//   bunny:      ash, cocoa, meadow, starlight
//
// = 8 × 4 = 32 species×colour PNGs.
//
// Mood overlays (positioned above pet head):
//   hungry  — bowl + steam
//   dirty   — soap bubbles
//   sad     — rain cloud
//
// Output: aquilo-gg/sprites/pet/glossy/<species>-<colour>.png  (32)
//         aquilo-gg/sprites/pet/glossy/mood-<hint>.png          (3)
//
// Run:  node tools/build-pet-glossy.mjs

import { mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { PALETTE, contactShadow, svgWrapper } from './glossy-art-kit.mjs';
import { bakeFile } from './bake-glossy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT = join(ROOT, 'aquilo-gg/sprites/pet/glossy');
mkdirSync(OUT, { recursive: true });

const W = 128, H = 160;

// Pet anchor — lower-right of the figure canvas, beside the hero's
// right foot. Centred on (PCX, PCY). L1 quality pass (2026-05):
// bumped the centre slightly down + right so the pet sits clear of
// the hero's right hand (cx=94, y=128) and the bigger pet
// silhouette has room. Footprint ~32 wide × 28 tall.
const PCX = 100, PCY = 132;

// ── Per-colour palette resolver ─────────────────────────────────
//
// Each (species, colour) pair picks a primary {hi, base, lo, stroke}.
// We hand-tune these so a "black cat" reads dark + cool, an "amber
// dog" reads warm gold, a "voltaic dragonling" reads brand-violet.

const COLOR = {
  // shared palette tones — referenced by per-species maps below
  inkBlack:  { hi: '#3a3e4a', base: '#1c1f29', lo: '#0a0c14', stroke: '#020308' },
  warmGrey:  { hi: '#c8c1ad', base: '#9c937e', lo: '#665d4d', stroke: '#2a261d' },
  ginger:    { hi: '#f6b97a', base: '#d68034', lo: '#964c10', stroke: '#3a1a04' },
  calico:    { hi: '#fff1c8', base: '#e9b870', lo: '#a07530', stroke: '#3a280a' },

  cream:     { hi: '#fff6d8', base: '#f1dda4', lo: '#b19d6e', stroke: '#5a4a20' },
  spotted:   { hi: '#d8c8a0', base: '#9c8a5e', lo: '#5e5028', stroke: '#26200a' },
  amber:     { hi: '#fad583', base: '#d49a30', lo: '#8a5e10', stroke: '#352204' },
  midnight:  { hi: '#3a4878', base: '#1c2548', lo: '#0a0f24', stroke: '#02050e' },

  barn:      { hi: '#e6b988', base: '#b48452', lo: '#7a5328', stroke: '#2d1c08' },
  snowy:     { hi: '#ffffff', base: '#dde6f2', lo: '#9aabc4', stroke: '#3a4860' },
  sage:      { hi: '#b8d8a8', base: '#7da868', lo: '#3f6a2d', stroke: '#102a0a' },
  twilight:  { hi: '#9690d0', base: '#5e57a3', lo: '#2d2868', stroke: '#0a0820' },

  rust:      { hi: '#f2935a', base: '#c25920', lo: '#7a300a', stroke: '#2d0f02' },
  arctic:    { hi: '#f4faff', base: '#cfd8e4', lo: '#8a93a3', stroke: '#2a3040' },
  plum:      { hi: '#b67ac0', base: '#7e3d8a', lo: '#481a52', stroke: '#180520' },
  gold:      { hi: '#ffe590', base: '#e5b020', lo: '#9f7600', stroke: '#3a2a02' },

  mint:      { hi: '#a8f5cf', base: '#4fc88b', lo: '#1e7a4a', stroke: '#082a18' },
  cobalt:    { hi: '#5fa0f8', base: '#2f5fcb', lo: '#0e2c7a', stroke: '#020d28' },
  rose:      { hi: '#ffb0c8', base: '#e25f8a', lo: '#8c1e48', stroke: '#33051c' },
  aurora:    { hi: '#a8d0ff', base: '#9e7ae0', lo: '#3a4f9a', stroke: '#0a142a' },

  emerald:   { hi: '#5bdd96', base: '#1fa561', lo: '#0e6c3d', stroke: '#04361e' },
  ember:     { hi: '#ff8a5a', base: '#d63a20', lo: '#7a1808', stroke: '#280502' },
  storm:     { hi: '#9aa8c0', base: '#4e5a78', lo: '#222a3e', stroke: '#080c14' },
  voltaic:   { hi: '#a890ff', base: '#7c5cff', lo: '#3a2880', stroke: '#0c0830' },

  leaf:      { hi: '#7bd15a', base: '#3d9226', lo: '#1f5712', stroke: '#0a2a06' },
  lily:      { hi: '#ffe0f0', base: '#f5a8c8', lo: '#a25080', stroke: '#33122a' },
  inkblot:   { hi: '#4a4f5e', base: '#22273a', lo: '#0a0e1c', stroke: '#020308' },
  sunburst:  { hi: '#ffe080', base: '#f0a020', lo: '#a06800', stroke: '#322000' },

  ash:       { hi: '#d4cfc4', base: '#9c958a', lo: '#5e574d', stroke: '#241f18' },
  cocoa:     { hi: '#c8a080', base: '#8a5a3a', lo: '#4a2810', stroke: '#180a02' },
  meadow:    { hi: '#a4d88c', base: '#6ba94e', lo: '#2f6020', stroke: '#0c2208' },
  starlight: { hi: '#e0e8f8', base: '#a8b4d4', lo: '#5a6488', stroke: '#181f30' },
};

// Map species + colour names → palette entry.
const SPECIES_COLOR = {
  cat:         { black: COLOR.inkBlack, tabby: COLOR.warmGrey, ginger: COLOR.ginger, calico: COLOR.calico },
  dog:         { cream: COLOR.cream, spotted: COLOR.spotted, amber: COLOR.amber, midnight: COLOR.midnight },
  owl:         { barn: COLOR.barn, snowy: COLOR.snowy, sage: COLOR.sage, twilight: COLOR.twilight },
  fox:         { rust: COLOR.rust, arctic: COLOR.arctic, plum: COLOR.plum, gold: COLOR.gold },
  slime:       { mint: COLOR.mint, cobalt: COLOR.cobalt, rose: COLOR.rose, aurora: COLOR.aurora },
  dragonling:  { emerald: COLOR.emerald, ember: COLOR.ember, storm: COLOR.storm, voltaic: COLOR.voltaic },
  frog:        { leaf: COLOR.leaf, lily: COLOR.lily, inkblot: COLOR.inkblot, sunburst: COLOR.sunburst },
  bunny:       { ash: COLOR.ash, cocoa: COLOR.cocoa, meadow: COLOR.meadow, starlight: COLOR.starlight },
};

// ── Per-colour gradient defs (inline) ───────────────────────────
//
// Pets use a unique colour per file (not part of PALETTE), so we
// inline the gradients per-bake rather than relying on the kit's
// shared defs.

function petDefs(c) {
  return `
<linearGradient id="pet-grad" x1="0.25" y1="0.1" x2="0.85" y2="0.95">
  <stop offset="0"    stop-color="${c.hi}"/>
  <stop offset="0.55" stop-color="${c.base}"/>
  <stop offset="1"    stop-color="${c.lo}"/>
</linearGradient>
<radialGradient id="pet-rgrad" cx="0.35" cy="0.25" r="0.85">
  <stop offset="0"    stop-color="${c.hi}"/>
  <stop offset="0.55" stop-color="${c.base}"/>
  <stop offset="1"    stop-color="${c.lo}"/>
</radialGradient>`;
}

// ── Per-species silhouette functions ────────────────────────────
//
// Each takes the palette and returns SVG body anchored around
// (PCX, PCY). Contact shadow under pet, body fill, eyes, tail/ears
// per species, gloss highlight on the back.

function petCat(c) {
  return `
${contactShadow({ cx: PCX, cy: PCY + 22, rx: 24, ry: 5 })}
<!-- tail (curled back over body, with darker stripe band) -->
<path d="M ${PCX + 18} ${PCY + 14}
         Q ${PCX + 36} ${PCY + 2} ${PCX + 34} ${PCY - 18}
         Q ${PCX + 28} ${PCY - 28} ${PCX + 22} ${PCY - 16}
         Q ${PCX + 26} ${PCY - 2} ${PCX + 14} ${PCY + 14} Z"
      fill="url(#pet-grad)" stroke="${c.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<path d="M ${PCX + 32} ${PCY - 14} Q ${PCX + 28} ${PCY - 8} ${PCX + 28} ${PCY - 2}"
      fill="none" stroke="${c.lo}" stroke-width="1.5" opacity="0.5"/>
<!-- front paws -->
<ellipse cx="${PCX - 10}" cy="${PCY + 18}" rx="5" ry="3.5" fill="${c.base}" stroke="${c.stroke}" stroke-width="2"/>
<ellipse cx="${PCX + 4}"  cy="${PCY + 18}" rx="5" ry="3.5" fill="${c.base}" stroke="${c.stroke}" stroke-width="2"/>
<!-- body (oval, sitting pose) -->
<ellipse cx="${PCX - 2}" cy="${PCY + 10}" rx="22" ry="14"
         fill="url(#pet-rgrad)" stroke="${c.stroke}" stroke-width="2.5"/>
<!-- belly tuft (lighter) -->
<ellipse cx="${PCX - 4}" cy="${PCY + 14}" rx="10" ry="6" fill="${c.hi}" opacity="0.6"/>
<!-- head (slightly bigger so face reads) -->
<circle cx="${PCX - 4}" cy="${PCY - 10}" r="15"
        fill="url(#pet-rgrad)" stroke="${c.stroke}" stroke-width="2.5"/>
<!-- cheek fluff -->
<ellipse cx="${PCX - 14}" cy="${PCY - 4}" rx="4" ry="3" fill="${c.hi}" opacity="0.55"/>
<ellipse cx="${PCX + 6}"  cy="${PCY - 4}" rx="4" ry="3" fill="${c.hi}" opacity="0.55"/>
<!-- ears (taller, more defined triangles) -->
<path d="M ${PCX - 16} ${PCY - 18} L ${PCX - 10} ${PCY - 30} L ${PCX - 4} ${PCY - 22} Z"
      fill="url(#pet-grad)" stroke="${c.stroke}" stroke-width="2" stroke-linejoin="round"/>
<path d="M ${PCX - 4} ${PCY - 22} L ${PCX + 2} ${PCY - 30} L ${PCX + 8} ${PCY - 19} Z"
      fill="url(#pet-grad)" stroke="${c.stroke}" stroke-width="2" stroke-linejoin="round"/>
<!-- inner ears (pink, bigger) -->
<path d="M ${PCX - 13} ${PCY - 20} L ${PCX - 10} ${PCY - 27} L ${PCX - 7} ${PCY - 21} Z" fill="#f5a8c8" opacity="0.9"/>
<path d="M ${PCX - 1} ${PCY - 20} L ${PCX + 2} ${PCY - 27} L ${PCX + 5} ${PCY - 21} Z" fill="#f5a8c8" opacity="0.9"/>
<!-- BIG expressive eyes -->
<ellipse cx="${PCX - 9}" cy="${PCY - 10}" rx="3.5" ry="4.5" fill="${PALETTE.white}" stroke="${c.stroke}" stroke-width="1.2"/>
<ellipse cx="${PCX + 1}" cy="${PCY - 10}" rx="3.5" ry="4.5" fill="${PALETTE.white}" stroke="${c.stroke}" stroke-width="1.2"/>
<ellipse cx="${PCX - 9}" cy="${PCY - 9}" rx="2.2" ry="3.5" fill="#FFD972"/>
<ellipse cx="${PCX + 1}" cy="${PCY - 9}" rx="2.2" ry="3.5" fill="#FFD972"/>
<!-- vertical-slit cat pupils -->
<ellipse cx="${PCX - 9}" cy="${PCY - 9}" rx="0.7" ry="3" fill="${PALETTE.ink}"/>
<ellipse cx="${PCX + 1}" cy="${PCY - 9}" rx="0.7" ry="3" fill="${PALETTE.ink}"/>
<!-- eye gloss -->
<circle cx="${PCX - 8}" cy="${PCY - 11}" r="0.9" fill="${PALETTE.white}"/>
<circle cx="${PCX + 2}" cy="${PCY - 11}" r="0.9" fill="${PALETTE.white}"/>
<!-- nose + mouth (proper kitty smile) -->
<path d="M ${PCX - 6} ${PCY - 3} L ${PCX - 4} ${PCY - 1} L ${PCX - 2} ${PCY - 3} Z" fill="#f5a8c8" stroke="${c.stroke}" stroke-width="0.8"/>
<path d="M ${PCX - 4} ${PCY - 1} Q ${PCX - 7} ${PCY + 2} ${PCX - 10} ${PCY}" fill="none" stroke="${c.stroke}" stroke-width="1.2" stroke-linecap="round"/>
<path d="M ${PCX - 4} ${PCY - 1} Q ${PCX - 1} ${PCY + 2} ${PCX + 2} ${PCY}" fill="none" stroke="${c.stroke}" stroke-width="1.2" stroke-linecap="round"/>
<!-- whiskers (more visible) -->
<g stroke="${c.stroke}" stroke-width="1" opacity="0.8" stroke-linecap="round">
  <line x1="${PCX - 15}" y1="${PCY - 4}" x2="${PCX - 24}" y2="${PCY - 6}"/>
  <line x1="${PCX - 15}" y1="${PCY - 1}" x2="${PCX - 24}" y2="${PCY}"/>
  <line x1="${PCX + 7}"  y1="${PCY - 4}" x2="${PCX + 16}" y2="${PCY - 6}"/>
  <line x1="${PCX + 7}"  y1="${PCY - 1}" x2="${PCX + 16}" y2="${PCY}"/>
</g>
<!-- head gloss highlight (upper-left) -->
<ellipse cx="${PCX - 10}" cy="${PCY - 18}" rx="5" ry="3" fill="#FFFFFF" opacity="0.4"/>`;
}

function petDog(c) {
  return `
${contactShadow({ cx: PCX, cy: PCY + 22, rx: 26, ry: 5 })}
<!-- tail (wagging up, with curl) -->
<path d="M ${PCX + 16} ${PCY + 4}
         Q ${PCX + 32} ${PCY - 4} ${PCX + 30} ${PCY - 18}
         Q ${PCX + 24} ${PCY - 24} ${PCX + 20} ${PCY - 14}
         Q ${PCX + 22} ${PCY - 2} ${PCX + 14} ${PCY + 6} Z"
      fill="url(#pet-grad)" stroke="${c.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<!-- body (sitting puppy pose) -->
<ellipse cx="${PCX}" cy="${PCY + 8}" rx="24" ry="15"
         fill="url(#pet-rgrad)" stroke="${c.stroke}" stroke-width="2.5"/>
<!-- chest tuft (lighter) -->
<ellipse cx="${PCX - 4}" cy="${PCY + 12}" rx="10" ry="6" fill="${c.hi}" opacity="0.55"/>
<!-- front paws -->
<ellipse cx="${PCX - 10}" cy="${PCY + 20}" rx="5" ry="3.5" fill="${c.base}" stroke="${c.stroke}" stroke-width="2"/>
<ellipse cx="${PCX + 4}"  cy="${PCY + 20}" rx="5" ry="3.5" fill="${c.base}" stroke="${c.stroke}" stroke-width="2"/>
<!-- paw toe pad lines -->
<g stroke="${c.stroke}" stroke-width="0.8" opacity="0.5">
  <line x1="${PCX - 11}" y1="${PCY + 19}" x2="${PCX - 11}" y2="${PCY + 22}"/>
  <line x1="${PCX - 9}"  y1="${PCY + 19}" x2="${PCX - 9}"  y2="${PCY + 22}"/>
  <line x1="${PCX + 3}"  y1="${PCY + 19}" x2="${PCX + 3}"  y2="${PCY + 22}"/>
  <line x1="${PCX + 5}"  y1="${PCY + 19}" x2="${PCX + 5}"  y2="${PCY + 22}"/>
</g>
<!-- head (bigger) -->
<circle cx="${PCX - 4}" cy="${PCY - 8}" r="15"
        fill="url(#pet-rgrad)" stroke="${c.stroke}" stroke-width="2.5"/>
<!-- snout (rounded, with darker top) -->
<ellipse cx="${PCX - 14}" cy="${PCY - 2}" rx="8" ry="5"
         fill="${c.hi}" stroke="${c.stroke}" stroke-width="2"/>
<ellipse cx="${PCX - 18}" cy="${PCY - 4}" rx="3" ry="2" fill="${PALETTE.ink}"/>
<!-- floppy ears (longer, dropping past chin) -->
<path d="M ${PCX - 14} ${PCY - 18}
         Q ${PCX - 26} ${PCY - 14} ${PCX - 22} ${PCY + 6}
         Q ${PCX - 18} ${PCY + 2} ${PCX - 16} ${PCY - 8}
         Q ${PCX - 14} ${PCY - 16} ${PCX - 12} ${PCY - 14} Z"
      fill="url(#pet-grad)" stroke="${c.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<path d="M ${PCX + 4} ${PCY - 18}
         Q ${PCX + 16} ${PCY - 14} ${PCX + 12} ${PCY + 4}
         Q ${PCX + 8} ${PCY + 2} ${PCX + 6} ${PCY - 8}
         Q ${PCX + 4} ${PCY - 16} ${PCX + 2} ${PCY - 14} Z"
      fill="url(#pet-grad)" stroke="${c.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<!-- BIG round puppy eyes -->
<circle cx="${PCX - 7}" cy="${PCY - 9}" r="3" fill="${PALETTE.white}" stroke="${c.stroke}" stroke-width="1.2"/>
<circle cx="${PCX + 3}" cy="${PCY - 9}" r="3" fill="${PALETTE.white}" stroke="${c.stroke}" stroke-width="1.2"/>
<circle cx="${PCX - 7}" cy="${PCY - 8}" r="2" fill="${PALETTE.ink}"/>
<circle cx="${PCX + 3}" cy="${PCY - 8}" r="2" fill="${PALETTE.ink}"/>
<circle cx="${PCX - 6}" cy="${PCY - 10}" r="0.8" fill="${PALETTE.white}"/>
<circle cx="${PCX + 4}" cy="${PCY - 10}" r="0.8" fill="${PALETTE.white}"/>
<!-- eyebrow tufts (cuteness booster) -->
<path d="M ${PCX - 10} ${PCY - 14} Q ${PCX - 7} ${PCY - 15} ${PCX - 4} ${PCY - 14}"
      fill="none" stroke="${c.lo}" stroke-width="1.2" opacity="0.7"/>
<path d="M ${PCX} ${PCY - 14} Q ${PCX + 3} ${PCY - 15} ${PCX + 6} ${PCY - 14}"
      fill="none" stroke="${c.lo}" stroke-width="1.2" opacity="0.7"/>
<!-- mouth + tongue lolling -->
<path d="M ${PCX - 10} ${PCY + 2} Q ${PCX - 7} ${PCY + 5} ${PCX - 4} ${PCY + 2}" fill="none" stroke="${c.stroke}" stroke-width="1.3" stroke-linecap="round"/>
<ellipse cx="${PCX - 7}" cy="${PCY + 4}" rx="2.5" ry="1.5" fill="#f08aa0" stroke="${c.stroke}" stroke-width="1"/>
<!-- head gloss -->
<ellipse cx="${PCX - 8}" cy="${PCY - 16}" rx="5" ry="3" fill="#FFFFFF" opacity="0.45"/>`;
}

function petOwl(c) {
  return `
${contactShadow({ cx: PCX, cy: PCY + 22, rx: 22, ry: 5 })}
<!-- body (egg-shape, BIGGER) -->
<ellipse cx="${PCX}" cy="${PCY + 2}" rx="22" ry="26"
         fill="url(#pet-rgrad)" stroke="${c.stroke}" stroke-width="2.5"/>
<!-- belly tuft (lighter, with chevron pattern hint) -->
<ellipse cx="${PCX}" cy="${PCY + 8}" rx="13" ry="14" fill="${c.hi}" opacity="0.65"/>
<path d="M ${PCX - 8} ${PCY + 6} L ${PCX} ${PCY + 10} L ${PCX + 8} ${PCY + 6}" fill="none" stroke="${c.lo}" stroke-width="0.8" opacity="0.5"/>
<path d="M ${PCX - 8} ${PCY + 12} L ${PCX} ${PCY + 16} L ${PCX + 8} ${PCY + 12}" fill="none" stroke="${c.lo}" stroke-width="0.8" opacity="0.5"/>
<!-- wings (folded, with feather division) -->
<path d="M ${PCX - 20} ${PCY - 4}
         Q ${PCX - 26} ${PCY + 10} ${PCX - 16} ${PCY + 22}
         Q ${PCX - 12} ${PCY + 10} ${PCX - 14} ${PCY - 2} Z"
      fill="url(#pet-grad)" stroke="${c.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<path d="M ${PCX + 20} ${PCY - 4}
         Q ${PCX + 26} ${PCY + 10} ${PCX + 16} ${PCY + 22}
         Q ${PCX + 12} ${PCY + 10} ${PCX + 14} ${PCY - 2} Z"
      fill="url(#pet-grad)" stroke="${c.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<!-- wing feather hints -->
<g stroke="${c.lo}" stroke-width="0.8" fill="none" opacity="0.6">
  <path d="M ${PCX - 20} ${PCY + 4} Q ${PCX - 16} ${PCY + 6} ${PCX - 14} ${PCY + 4}"/>
  <path d="M ${PCX - 20} ${PCY + 12} Q ${PCX - 16} ${PCY + 14} ${PCX - 14} ${PCY + 12}"/>
  <path d="M ${PCX + 20} ${PCY + 4} Q ${PCX + 16} ${PCY + 6} ${PCX + 14} ${PCY + 4}"/>
  <path d="M ${PCX + 20} ${PCY + 12} Q ${PCX + 16} ${PCY + 14} ${PCX + 14} ${PCY + 12}"/>
</g>
<!-- feet (clawed perch grip) -->
<g fill="${PALETTE.gold.base}" stroke="${c.stroke}" stroke-width="1">
  <ellipse cx="${PCX - 6}" cy="${PCY + 24}" rx="2.5" ry="1.5"/>
  <ellipse cx="${PCX + 6}" cy="${PCY + 24}" rx="2.5" ry="1.5"/>
  <path d="M ${PCX - 6} ${PCY + 22} L ${PCX - 8} ${PCY + 26}"/>
  <path d="M ${PCX - 6} ${PCY + 22} L ${PCX - 4} ${PCY + 26}"/>
  <path d="M ${PCX + 6} ${PCY + 22} L ${PCX + 8} ${PCY + 26}"/>
  <path d="M ${PCX + 6} ${PCY + 22} L ${PCX + 4} ${PCY + 26}"/>
</g>
<!-- ear tufts (more pointed + slightly tilted outward) -->
<path d="M ${PCX - 14} ${PCY - 20} L ${PCX - 10} ${PCY - 30} L ${PCX - 6} ${PCY - 20} Z"
      fill="url(#pet-grad)" stroke="${c.stroke}" stroke-width="2" stroke-linejoin="round"/>
<path d="M ${PCX + 6} ${PCY - 20} L ${PCX + 10} ${PCY - 30} L ${PCX + 14} ${PCY - 20} Z"
      fill="url(#pet-grad)" stroke="${c.stroke}" stroke-width="2" stroke-linejoin="round"/>
<!-- face disc (lighter cream surrounding eyes — classic owl idiom) -->
<ellipse cx="${PCX - 6}" cy="${PCY - 10}" rx="8" ry="9" fill="${PALETTE.cream.hi}" opacity="0.85"/>
<ellipse cx="${PCX + 6}" cy="${PCY - 10}" rx="8" ry="9" fill="${PALETTE.cream.hi}" opacity="0.85"/>
<!-- eyes (BIG yellow + bigger pupils) -->
<circle cx="${PCX - 6}" cy="${PCY - 10}" r="6" fill="#FFE082" stroke="${c.stroke}" stroke-width="1.8"/>
<circle cx="${PCX + 6}" cy="${PCY - 10}" r="6" fill="#FFE082" stroke="${c.stroke}" stroke-width="1.8"/>
<circle cx="${PCX - 6}" cy="${PCY - 9}" r="3.5" fill="${PALETTE.ink}"/>
<circle cx="${PCX + 6}" cy="${PCY - 9}" r="3.5" fill="${PALETTE.ink}"/>
<circle cx="${PCX - 5}" cy="${PCY - 11}" r="1.3" fill="#FFFFFF"/>
<circle cx="${PCX + 7}" cy="${PCY - 11}" r="1.3" fill="#FFFFFF"/>
<!-- beak (hooked) -->
<path d="M ${PCX - 3} ${PCY - 4} L ${PCX + 3} ${PCY - 4} L ${PCX + 1} ${PCY + 2} L ${PCX - 1} ${PCY + 2} Z"
      fill="${PALETTE.gold.base}" stroke="${c.stroke}" stroke-width="1.5" stroke-linejoin="round"/>
<!-- head gloss -->
<ellipse cx="${PCX - 8}" cy="${PCY - 22}" rx="5" ry="3" fill="#FFFFFF" opacity="0.4"/>`;
}

function petFox(c) {
  return `
${contactShadow({ cx: PCX, cy: PCY + 22, rx: 24, ry: 5 })}
<!-- bushy tail (bigger, with stripe hint + white tip) -->
<path d="M ${PCX + 16} ${PCY + 10}
         Q ${PCX + 36} ${PCY + 4} ${PCX + 38} ${PCY - 16}
         Q ${PCX + 32} ${PCY - 26} ${PCX + 20} ${PCY - 16}
         Q ${PCX + 24} ${PCY - 2} ${PCX + 12} ${PCY + 10} Z"
      fill="url(#pet-grad)" stroke="${c.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<!-- tail tip (white, bigger) -->
<ellipse cx="${PCX + 32}" cy="${PCY - 20}" rx="6" ry="5" fill="${PALETTE.white}" stroke="${c.stroke}" stroke-width="1.5"/>
<!-- tail stripe (subtle darker band) -->
<path d="M ${PCX + 26} ${PCY - 10} Q ${PCX + 22} ${PCY - 4} ${PCX + 20} ${PCY + 4}"
      fill="none" stroke="${c.lo}" stroke-width="1.5" opacity="0.5"/>
<!-- front paws -->
<ellipse cx="${PCX - 10}" cy="${PCY + 20}" rx="5" ry="3.5" fill="${c.lo}" stroke="${c.stroke}" stroke-width="2"/>
<ellipse cx="${PCX + 4}"  cy="${PCY + 20}" rx="5" ry="3.5" fill="${c.lo}" stroke="${c.stroke}" stroke-width="2"/>
<!-- body (sitting pose, bigger) -->
<ellipse cx="${PCX - 2}" cy="${PCY + 10}" rx="22" ry="14"
         fill="url(#pet-rgrad)" stroke="${c.stroke}" stroke-width="2.5"/>
<!-- chest tuft (white, bigger) -->
<ellipse cx="${PCX - 4}" cy="${PCY + 14}" rx="9" ry="7" fill="${PALETTE.white}" opacity="0.85"/>
<!-- head (triangular, more characterful) -->
<path d="M ${PCX - 16} ${PCY - 4}
         Q ${PCX - 18} ${PCY - 14} ${PCX - 10} ${PCY - 18}
         Q ${PCX + 4} ${PCY - 22} ${PCX + 12} ${PCY - 16}
         Q ${PCX + 16} ${PCY - 8} ${PCX + 14} ${PCY - 2}
         Q ${PCX + 10} ${PCY + 6} ${PCX - 4} ${PCY + 6}
         Q ${PCX - 14} ${PCY + 4} ${PCX - 16} ${PCY - 4} Z"
      fill="url(#pet-rgrad)" stroke="${c.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<!-- white mask on lower face -->
<path d="M ${PCX - 14} ${PCY - 2}
         Q ${PCX - 4} ${PCY + 6} ${PCX + 8} ${PCY - 2}
         Q ${PCX + 6} ${PCY + 4} ${PCX - 6} ${PCY + 6}
         Q ${PCX - 16} ${PCY + 4} ${PCX - 14} ${PCY - 2} Z"
      fill="${PALETTE.white}" opacity="0.7"/>
<!-- snout (pointed, with darker nose) -->
<path d="M ${PCX - 16} ${PCY - 2} L ${PCX - 24} ${PCY + 2} L ${PCX - 14} ${PCY + 6} Z"
      fill="${PALETTE.white}" stroke="${c.stroke}" stroke-width="1.5" stroke-linejoin="round"/>
<ellipse cx="${PCX - 22}" cy="${PCY + 1}" rx="2" ry="1.6" fill="${PALETTE.ink}"/>
<!-- pointed ears (bigger, with darker tips) -->
<path d="M ${PCX - 10} ${PCY - 14} L ${PCX - 6} ${PCY - 26} L ${PCX - 2} ${PCY - 16} Z"
      fill="url(#pet-grad)" stroke="${c.stroke}" stroke-width="2" stroke-linejoin="round"/>
<path d="M ${PCX + 2} ${PCY - 14} L ${PCX + 6} ${PCY - 26} L ${PCX + 12} ${PCY - 16} Z"
      fill="url(#pet-grad)" stroke="${c.stroke}" stroke-width="2" stroke-linejoin="round"/>
<!-- inner ear (pink fluff) -->
<path d="M ${PCX - 9} ${PCY - 15} L ${PCX - 6} ${PCY - 22} L ${PCX - 3} ${PCY - 16} Z" fill="#f5a8c8" opacity="0.85"/>
<path d="M ${PCX + 3} ${PCY - 15} L ${PCX + 6} ${PCY - 22} L ${PCX + 11} ${PCY - 16} Z" fill="#f5a8c8" opacity="0.85"/>
<!-- BIG amber eyes with slit pupils -->
<ellipse cx="${PCX - 7}" cy="${PCY - 8}" rx="3" ry="4" fill="${PALETTE.white}" stroke="${c.stroke}" stroke-width="1.2"/>
<ellipse cx="${PCX + 5}" cy="${PCY - 8}" rx="3" ry="4" fill="${PALETTE.white}" stroke="${c.stroke}" stroke-width="1.2"/>
<ellipse cx="${PCX - 7}" cy="${PCY - 7}" rx="2" ry="3" fill="#FFB040"/>
<ellipse cx="${PCX + 5}" cy="${PCY - 7}" rx="2" ry="3" fill="#FFB040"/>
<ellipse cx="${PCX - 7}" cy="${PCY - 7}" rx="0.7" ry="2.5" fill="${PALETTE.ink}"/>
<ellipse cx="${PCX + 5}" cy="${PCY - 7}" rx="0.7" ry="2.5" fill="${PALETTE.ink}"/>
<circle cx="${PCX - 6}" cy="${PCY - 9}" r="0.8" fill="${PALETTE.white}"/>
<circle cx="${PCX + 6}" cy="${PCY - 9}" r="0.8" fill="${PALETTE.white}"/>
<!-- head gloss -->
<ellipse cx="${PCX - 10}" cy="${PCY - 14}" rx="4" ry="3" fill="#FFFFFF" opacity="0.4"/>`;
}

function petSlime(c) {
  return `
${contactShadow({ cx: PCX, cy: PCY + 22, rx: 28, ry: 6 })}
<!-- blob body (jelly droplet shape — wide base, narrow top) -->
<path d="M ${PCX - 26} ${PCY + 18}
         Q ${PCX - 30} ${PCY - 4} ${PCX - 18} ${PCY - 18}
         Q ${PCX - 6} ${PCY - 26} ${PCX + 4} ${PCY - 24}
         Q ${PCX + 22} ${PCY - 18} ${PCX + 26} ${PCY - 2}
         Q ${PCX + 28} ${PCY + 14} ${PCX + 22} ${PCY + 20}
         Q ${PCX + 10} ${PCY + 22} ${PCX} ${PCY + 20}
         Q ${PCX - 14} ${PCY + 22} ${PCX - 26} ${PCY + 18} Z"
      fill="url(#pet-rgrad)" stroke="${c.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<!-- inner translucent ring (jelly idiom) -->
<path d="M ${PCX - 22} ${PCY + 14}
         Q ${PCX - 24} ${PCY - 4} ${PCX - 14} ${PCY - 14}
         Q ${PCX} ${PCY - 20} ${PCX + 12} ${PCY - 14}
         Q ${PCX + 22} ${PCY - 2} ${PCX + 20} ${PCY + 14}"
      fill="none" stroke="${c.hi}" stroke-width="1.5" opacity="0.5"/>
<!-- BIG gloss crescent (upper-left, defines the slime sheen) -->
<path d="M ${PCX - 20} ${PCY - 4}
         Q ${PCX - 26} ${PCY - 18} ${PCX - 8} ${PCY - 22}
         L ${PCX - 2} ${PCY - 16}
         Q ${PCX - 18} ${PCY - 12} ${PCX - 16} ${PCY - 2} Z"
      fill="${PALETTE.white}" opacity="0.6"/>
<!-- secondary gloss dot -->
<ellipse cx="${PCX + 12}" cy="${PCY - 14}" rx="3" ry="2" fill="${PALETTE.white}" opacity="0.5"/>
<!-- bubble inside (cute jelly idiom) -->
<circle cx="${PCX + 8}" cy="${PCY + 8}" r="3" fill="${PALETTE.white}" opacity="0.35" stroke="${c.hi}" stroke-width="0.8"/>
<circle cx="${PCX - 14}" cy="${PCY + 12}" r="2" fill="${PALETTE.white}" opacity="0.35" stroke="${c.hi}" stroke-width="0.8"/>
<!-- BIG kawaii eyes (closed-arch happy shape) -->
<path d="M ${PCX - 10} ${PCY - 2} Q ${PCX - 6} ${PCY - 8} ${PCX - 2} ${PCY - 2}"
      fill="none" stroke="${PALETTE.ink}" stroke-width="2.5" stroke-linecap="round"/>
<path d="M ${PCX + 2} ${PCY - 2} Q ${PCX + 6} ${PCY - 8} ${PCX + 10} ${PCY - 2}"
      fill="none" stroke="${PALETTE.ink}" stroke-width="2.5" stroke-linecap="round"/>
<!-- blush cheeks -->
<ellipse cx="${PCX - 12}" cy="${PCY + 4}" rx="3" ry="2" fill="#f5a8c8" opacity="0.7"/>
<ellipse cx="${PCX + 12}" cy="${PCY + 4}" rx="3" ry="2" fill="#f5a8c8" opacity="0.7"/>
<!-- happy open mouth -->
<path d="M ${PCX - 5} ${PCY + 6}
         Q ${PCX} ${PCY + 12} ${PCX + 5} ${PCY + 6}
         Q ${PCX} ${PCY + 10} ${PCX - 5} ${PCY + 6} Z"
      fill="#552028" stroke="${c.stroke}" stroke-width="1.3"/>`;
}

function petDragonling(c) {
  return `
${contactShadow({ cx: PCX, cy: PCY + 22, rx: 24, ry: 5 })}
<!-- BACK WING (spread, more dramatic — bat-style) -->
<path d="M ${PCX + 2} ${PCY - 4}
         Q ${PCX + 24} ${PCY - 28} ${PCX + 34} ${PCY - 14}
         L ${PCX + 30} ${PCY - 10}
         Q ${PCX + 32} ${PCY - 6} ${PCX + 26} ${PCY - 4}
         L ${PCX + 22} ${PCY - 6}
         Q ${PCX + 22} ${PCY - 2} ${PCX + 16} ${PCY}
         Q ${PCX + 8} ${PCY - 4} ${PCX + 2} ${PCY - 4} Z"
      fill="${c.base}" stroke="${c.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<!-- wing ribs -->
<g stroke="${c.stroke}" stroke-width="1" fill="none" opacity="0.7">
  <path d="M ${PCX + 4} ${PCY - 4} L ${PCX + 30} ${PCY - 12}"/>
  <path d="M ${PCX + 4} ${PCY - 4} L ${PCX + 26} ${PCY - 6}"/>
  <path d="M ${PCX + 4} ${PCY - 4} L ${PCX + 18} ${PCY - 2}"/>
</g>
<!-- BODY (egg-like, sitting pose) -->
<ellipse cx="${PCX - 2}" cy="${PCY + 8}" rx="20" ry="14"
         fill="url(#pet-rgrad)" stroke="${c.stroke}" stroke-width="2.5"/>
<!-- belly scales (lighter chevron pattern) -->
<ellipse cx="${PCX - 4}" cy="${PCY + 12}" rx="11" ry="7" fill="${c.hi}" opacity="0.6"/>
<path d="M ${PCX - 8} ${PCY + 10} L ${PCX - 4} ${PCY + 12} L ${PCX} ${PCY + 10}"
      fill="none" stroke="${c.lo}" stroke-width="0.8" opacity="0.5"/>
<path d="M ${PCX - 8} ${PCY + 14} L ${PCX - 4} ${PCY + 16} L ${PCX} ${PCY + 14}"
      fill="none" stroke="${c.lo}" stroke-width="0.8" opacity="0.5"/>
<!-- front claws -->
<g fill="${c.lo}" stroke="${c.stroke}" stroke-width="1.5">
  <ellipse cx="${PCX - 12}" cy="${PCY + 20}" rx="5" ry="3"/>
  <ellipse cx="${PCX + 2}"  cy="${PCY + 20}" rx="5" ry="3"/>
</g>
<g fill="${PALETTE.cream.hi}" stroke="${c.stroke}" stroke-width="0.7">
  <path d="M ${PCX - 15} ${PCY + 22} L ${PCX - 14} ${PCY + 24}"/>
  <path d="M ${PCX - 12} ${PCY + 22} L ${PCX - 12} ${PCY + 25}"/>
  <path d="M ${PCX - 9}  ${PCY + 22} L ${PCX - 10} ${PCY + 24}"/>
  <path d="M ${PCX - 1}  ${PCY + 22} L ${PCX - 1} ${PCY + 24}"/>
  <path d="M ${PCX + 2}  ${PCY + 22} L ${PCX + 2} ${PCY + 25}"/>
  <path d="M ${PCX + 5}  ${PCY + 22} L ${PCX + 5} ${PCY + 24}"/>
</g>
<!-- TAIL (curling with arrowhead tip) -->
<path d="M ${PCX - 16} ${PCY + 12}
         Q ${PCX - 30} ${PCY + 16} ${PCX - 28} ${PCY + 2}
         Q ${PCX - 22} ${PCY + 6} ${PCX - 14} ${PCY + 10} Z"
      fill="url(#pet-grad)" stroke="${c.stroke}" stroke-width="2" stroke-linejoin="round"/>
<!-- tail arrowhead -->
<path d="M ${PCX - 28} ${PCY + 2} L ${PCX - 32} ${PCY - 4} L ${PCX - 26} ${PCY - 2} Z"
      fill="${c.lo}" stroke="${c.stroke}" stroke-width="1.5" stroke-linejoin="round"/>
<!-- back spine ridges (saw-tooth crest) -->
<g fill="${c.lo}" stroke="${c.stroke}" stroke-width="1">
  <path d="M ${PCX - 6} ${PCY - 4} L ${PCX - 4} ${PCY - 10} L ${PCX - 2} ${PCY - 4} Z"/>
  <path d="M ${PCX - 2} ${PCY - 6} L ${PCX} ${PCY - 12} L ${PCX + 2} ${PCY - 6} Z"/>
</g>
<!-- HEAD (bigger, more dragony) -->
<ellipse cx="${PCX - 8}" cy="${PCY - 6}" rx="13" ry="11"
         fill="url(#pet-rgrad)" stroke="${c.stroke}" stroke-width="2.5"/>
<!-- jaw underbite hint -->
<path d="M ${PCX - 18} ${PCY - 2}
         Q ${PCX - 22} ${PCY + 2} ${PCX - 14} ${PCY + 4}
         L ${PCX - 8} ${PCY + 2} Z"
      fill="${c.hi}" stroke="${c.stroke}" stroke-width="1.5" stroke-linejoin="round"/>
<!-- tiny fang -->
<path d="M ${PCX - 16} ${PCY + 1} L ${PCX - 15} ${PCY + 4} L ${PCX - 14} ${PCY + 1} Z"
      fill="${PALETTE.white}" stroke="${c.stroke}" stroke-width="0.6"/>
<!-- HORNS (bigger, swept back, with rings) -->
<path d="M ${PCX - 14} ${PCY - 14}
         Q ${PCX - 22} ${PCY - 24} ${PCX - 18} ${PCY - 30}
         L ${PCX - 12} ${PCY - 18} Z"
      fill="${PALETTE.iron.base}" stroke="${c.stroke}" stroke-width="1.5" stroke-linejoin="round"/>
<path d="M ${PCX - 4} ${PCY - 14}
         Q ${PCX + 2} ${PCY - 24} ${PCX} ${PCY - 30}
         L ${PCX - 2} ${PCY - 18} Z"
      fill="${PALETTE.iron.base}" stroke="${c.stroke}" stroke-width="1.5" stroke-linejoin="round"/>
<!-- horn rings -->
<path d="M ${PCX - 18} ${PCY - 22} L ${PCX - 14} ${PCY - 20}" stroke="${PALETTE.ink}" stroke-width="0.8" opacity="0.5"/>
<path d="M ${PCX - 1} ${PCY - 22} L ${PCX - 3} ${PCY - 20}" stroke="${PALETTE.ink}" stroke-width="0.8" opacity="0.5"/>
<!-- nostrils -->
<circle cx="${PCX - 18}" cy="${PCY - 4}" r="0.8" fill="${PALETTE.ink}"/>
<circle cx="${PCX - 18}" cy="${PCY - 1}" r="0.8" fill="${PALETTE.ink}"/>
<!-- BIG dragon eye (one prominent eye) -->
<ellipse cx="${PCX - 6}" cy="${PCY - 9}" rx="3.5" ry="4" fill="${PALETTE.white}" stroke="${c.stroke}" stroke-width="1.3"/>
<ellipse cx="${PCX - 6}" cy="${PCY - 8}" rx="2.5" ry="3" fill="${PALETTE.ruby.hi}"/>
<ellipse cx="${PCX - 6}" cy="${PCY - 8}" rx="0.7" ry="2.5" fill="${PALETTE.ink}"/>
<circle cx="${PCX - 5}" cy="${PCY - 10}" r="0.8" fill="${PALETTE.white}"/>
<!-- eye ridge brow -->
<path d="M ${PCX - 10} ${PCY - 13} Q ${PCX - 6} ${PCY - 15} ${PCX - 2} ${PCY - 13}"
      fill="none" stroke="${c.stroke}" stroke-width="1.2" opacity="0.7"/>
<!-- head gloss -->
<ellipse cx="${PCX - 11}" cy="${PCY - 12}" rx="4" ry="2.5" fill="#FFFFFF" opacity="0.4"/>`;
}

function petFrog(c) {
  return `
${contactShadow({ cx: PCX, cy: PCY + 22, rx: 26, ry: 5 })}
<!-- back legs (folded haunches) -->
<path d="M ${PCX - 22} ${PCY + 6}
         Q ${PCX - 28} ${PCY + 20} ${PCX - 14} ${PCY + 24}
         L ${PCX - 10} ${PCY + 14} Z"
      fill="url(#pet-grad)" stroke="${c.stroke}" stroke-width="2" stroke-linejoin="round"/>
<path d="M ${PCX + 10} ${PCY + 14}
         L ${PCX + 14} ${PCY + 24}
         Q ${PCX + 28} ${PCY + 20} ${PCX + 22} ${PCY + 6} Z"
      fill="url(#pet-grad)" stroke="${c.stroke}" stroke-width="2" stroke-linejoin="round"/>
<!-- back-leg toe pads (webbed) -->
<g fill="${c.hi}" stroke="${c.stroke}" stroke-width="1">
  <ellipse cx="${PCX - 18}" cy="${PCY + 24}" rx="2" ry="1.5"/>
  <ellipse cx="${PCX - 14}" cy="${PCY + 25}" rx="2" ry="1.5"/>
  <ellipse cx="${PCX + 14}" cy="${PCY + 25}" rx="2" ry="1.5"/>
  <ellipse cx="${PCX + 18}" cy="${PCY + 24}" rx="2" ry="1.5"/>
</g>
<!-- body (squat wide oval, bigger) -->
<ellipse cx="${PCX}" cy="${PCY + 4}" rx="22" ry="16"
         fill="url(#pet-rgrad)" stroke="${c.stroke}" stroke-width="2.5"/>
<!-- belly (lighter cream, big oval — frog idiom) -->
<ellipse cx="${PCX}" cy="${PCY + 10}" rx="15" ry="9" fill="${c.hi}" opacity="0.7"/>
<ellipse cx="${PCX}" cy="${PCY + 10}" rx="15" ry="9" fill="none" stroke="${c.lo}" stroke-width="1" opacity="0.4"/>
<!-- back spots (warts on darker top) -->
<g fill="${c.lo}" opacity="0.55">
  <ellipse cx="${PCX - 8}" cy="${PCY - 2}" rx="2.5" ry="1.8"/>
  <ellipse cx="${PCX + 6}" cy="${PCY - 4}" rx="2" ry="1.5"/>
  <ellipse cx="${PCX + 10}" cy="${PCY + 2}" rx="1.5" ry="1.2"/>
  <ellipse cx="${PCX - 12}" cy="${PCY + 4}" rx="1.5" ry="1.2"/>
</g>
<!-- front feet (sticky toe pads in front) -->
<g fill="${c.hi}" stroke="${c.stroke}" stroke-width="1.5">
  <ellipse cx="${PCX - 14}" cy="${PCY + 18}" rx="4" ry="2.5"/>
  <ellipse cx="${PCX + 14}" cy="${PCY + 18}" rx="4" ry="2.5"/>
</g>
<g fill="${PALETTE.cream.hi}" stroke="${c.stroke}" stroke-width="0.8">
  <circle cx="${PCX - 16}" cy="${PCY + 18}" r="1.2"/>
  <circle cx="${PCX - 13}" cy="${PCY + 19}" r="1.2"/>
  <circle cx="${PCX + 13}" cy="${PCY + 19}" r="1.2"/>
  <circle cx="${PCX + 16}" cy="${PCY + 18}" r="1.2"/>
</g>
<!-- BULGING eye sockets on top (bigger, more prominent) -->
<circle cx="${PCX - 10}" cy="${PCY - 12}" r="9"
        fill="url(#pet-rgrad)" stroke="${c.stroke}" stroke-width="2.5"/>
<circle cx="${PCX + 10}" cy="${PCY - 12}" r="9"
        fill="url(#pet-rgrad)" stroke="${c.stroke}" stroke-width="2.5"/>
<!-- eyes inside sockets (BIG, classic frog yellow) -->
<circle cx="${PCX - 10}" cy="${PCY - 12}" r="5" fill="#FFE082" stroke="${c.stroke}" stroke-width="1.2"/>
<circle cx="${PCX + 10}" cy="${PCY - 12}" r="5" fill="#FFE082" stroke="${c.stroke}" stroke-width="1.2"/>
<!-- vertical slit pupils -->
<ellipse cx="${PCX - 10}" cy="${PCY - 12}" rx="1" ry="4" fill="${PALETTE.ink}"/>
<ellipse cx="${PCX + 10}" cy="${PCY - 12}" rx="1" ry="4" fill="${PALETTE.ink}"/>
<!-- eye gloss -->
<circle cx="${PCX - 8}" cy="${PCY - 14}" r="1.2" fill="${PALETTE.white}"/>
<circle cx="${PCX + 12}" cy="${PCY - 14}" r="1.2" fill="${PALETTE.white}"/>
<!-- WIDE mouth (toothy frog grin) -->
<path d="M ${PCX - 16} ${PCY + 2}
         Q ${PCX} ${PCY + 10} ${PCX + 16} ${PCY + 2}
         Q ${PCX} ${PCY + 6} ${PCX - 16} ${PCY + 2} Z"
      fill="#552028" stroke="${c.stroke}" stroke-width="1.8"/>
<!-- tongue tip -->
<ellipse cx="${PCX + 2}" cy="${PCY + 5}" rx="3" ry="1.5" fill="#f08aa0" opacity="0.8"/>
<!-- nostrils -->
<circle cx="${PCX - 3}" cy="${PCY - 2}" r="0.6" fill="${PALETTE.ink}"/>
<circle cx="${PCX + 3}" cy="${PCY - 2}" r="0.6" fill="${PALETTE.ink}"/>
<!-- body gloss -->
<ellipse cx="${PCX - 6}" cy="${PCY + 0}" rx="7" ry="3" fill="#FFFFFF" opacity="0.35"/>`;
}

function petBunny(c) {
  return `
${contactShadow({ cx: PCX, cy: PCY + 22, rx: 22, ry: 5 })}
<!-- back feet (folded under, visible toes) -->
<ellipse cx="${PCX - 10}" cy="${PCY + 22}" rx="10" ry="5" fill="${c.lo}" stroke="${c.stroke}" stroke-width="2"/>
<ellipse cx="${PCX + 8}"  cy="${PCY + 22}" rx="10" ry="5" fill="${c.lo}" stroke="${c.stroke}" stroke-width="2"/>
<!-- foot pads (pink) -->
<ellipse cx="${PCX - 12}" cy="${PCY + 22}" rx="3" ry="2" fill="#f5a8c8" opacity="0.75"/>
<ellipse cx="${PCX + 10}" cy="${PCY + 22}" rx="3" ry="2" fill="#f5a8c8" opacity="0.75"/>
<!-- body (rounded, bigger) -->
<ellipse cx="${PCX}" cy="${PCY + 8}" rx="18" ry="15"
         fill="url(#pet-rgrad)" stroke="${c.stroke}" stroke-width="2.5"/>
<!-- chest fluff (lighter belly) -->
<ellipse cx="${PCX - 2}" cy="${PCY + 12}" rx="10" ry="7" fill="${c.hi}" opacity="0.7"/>
<!-- tail (cotton ball, bigger) -->
<circle cx="${PCX + 16}" cy="${PCY + 10}" r="6" fill="${PALETTE.white}" stroke="${c.stroke}" stroke-width="1.5"/>
<circle cx="${PCX + 14}" cy="${PCY + 8}" r="1.5" fill="${PALETTE.white}" opacity="0.7"/>
<!-- head (bigger, set above body) -->
<circle cx="${PCX - 2}" cy="${PCY - 10}" r="13"
        fill="url(#pet-rgrad)" stroke="${c.stroke}" stroke-width="2.5"/>
<!-- cheek fluff -->
<ellipse cx="${PCX - 12}" cy="${PCY - 4}" rx="4" ry="3" fill="${c.hi}" opacity="0.55"/>
<ellipse cx="${PCX + 8}"  cy="${PCY - 4}" rx="4" ry="3" fill="${c.hi}" opacity="0.55"/>
<!-- LONG ears (signature bunny, with one slightly bent) -->
<path d="M ${PCX - 10} ${PCY - 22}
         Q ${PCX - 14} ${PCY - 38} ${PCX - 10} ${PCY - 42}
         Q ${PCX - 6} ${PCY - 40} ${PCX - 6} ${PCY - 22} Z"
      fill="url(#pet-grad)" stroke="${c.stroke}" stroke-width="2" stroke-linejoin="round"/>
<path d="M ${PCX + 2} ${PCY - 22}
         Q ${PCX + 4} ${PCY - 40} ${PCX + 8} ${PCY - 42}
         Q ${PCX + 12} ${PCY - 38} ${PCX + 6} ${PCY - 22} Z"
      fill="url(#pet-grad)" stroke="${c.stroke}" stroke-width="2" stroke-linejoin="round"/>
<!-- ear inner (pink, bigger) -->
<path d="M ${PCX - 9} ${PCY - 24}
         Q ${PCX - 12} ${PCY - 36} ${PCX - 9} ${PCY - 38}
         Q ${PCX - 7} ${PCY - 36} ${PCX - 7} ${PCY - 24} Z"
      fill="#f5a8c8" opacity="0.85"/>
<path d="M ${PCX + 3} ${PCY - 24}
         Q ${PCX + 4} ${PCY - 36} ${PCX + 7} ${PCY - 38}
         Q ${PCX + 10} ${PCY - 36} ${PCX + 5} ${PCY - 24} Z"
      fill="#f5a8c8" opacity="0.85"/>
<!-- BIG sparkly bunny eyes (with eyelash hint) -->
<ellipse cx="${PCX - 7}" cy="${PCY - 10}" rx="3" ry="3.5" fill="${PALETTE.white}" stroke="${c.stroke}" stroke-width="1.2"/>
<ellipse cx="${PCX + 3}" cy="${PCY - 10}" rx="3" ry="3.5" fill="${PALETTE.white}" stroke="${c.stroke}" stroke-width="1.2"/>
<circle cx="${PCX - 7}" cy="${PCY - 9}" r="2.2" fill="${PALETTE.ink}"/>
<circle cx="${PCX + 3}" cy="${PCY - 9}" r="2.2" fill="${PALETTE.ink}"/>
<circle cx="${PCX - 6}" cy="${PCY - 10.5}" r="0.9" fill="${PALETTE.white}"/>
<circle cx="${PCX + 4}" cy="${PCY - 10.5}" r="0.9" fill="${PALETTE.white}"/>
<!-- nose (pink triangle, bigger) -->
<path d="M ${PCX - 4} ${PCY - 4} L ${PCX - 1} ${PCY - 1} L ${PCX + 2} ${PCY - 4} Z"
      fill="#f5a8c8" stroke="${c.stroke}" stroke-width="1"/>
<!-- mouth Y line -->
<path d="M ${PCX - 1} ${PCY - 1} L ${PCX - 1} ${PCY + 1}" stroke="${c.stroke}" stroke-width="1" stroke-linecap="round"/>
<path d="M ${PCX - 1} ${PCY + 1} Q ${PCX - 4} ${PCY + 3} ${PCX - 5} ${PCY + 1}" fill="none" stroke="${c.stroke}" stroke-width="1" stroke-linecap="round"/>
<path d="M ${PCX - 1} ${PCY + 1} Q ${PCX + 2} ${PCY + 3} ${PCX + 3} ${PCY + 1}" fill="none" stroke="${c.stroke}" stroke-width="1" stroke-linecap="round"/>
<!-- buck teeth -->
<rect x="${PCX - 3}" y="${PCY + 2}" width="2" height="3" fill="${PALETTE.white}" stroke="${c.stroke}" stroke-width="0.8"/>
<rect x="${PCX - 1}" y="${PCY + 2}" width="2" height="3" fill="${PALETTE.white}" stroke="${c.stroke}" stroke-width="0.8"/>
<!-- whiskers -->
<g stroke="${c.stroke}" stroke-width="0.8" opacity="0.6" stroke-linecap="round">
  <line x1="${PCX - 12}" y1="${PCY - 2}" x2="${PCX - 18}" y2="${PCY - 4}"/>
  <line x1="${PCX - 12}" y1="${PCY}"    x2="${PCX - 18}" y2="${PCY}"/>
  <line x1="${PCX + 8}"  y1="${PCY - 2}" x2="${PCX + 14}" y2="${PCY - 4}"/>
  <line x1="${PCX + 8}"  y1="${PCY}"    x2="${PCX + 14}" y2="${PCY}"/>
</g>
<!-- head gloss -->
<ellipse cx="${PCX - 8}" cy="${PCY - 16}" rx="5" ry="3" fill="#FFFFFF" opacity="0.4"/>`;
}

const SPECIES_FN = {
  cat: petCat, dog: petDog, owl: petOwl, fox: petFox,
  slime: petSlime, dragonling: petDragonling, frog: petFrog, bunny: petBunny,
};

// ── Mood overlays ───────────────────────────────────────────────
//
// Small icon above the pet's head (~y = PCY-32, ~16 px wide).

const MOOD_CX = PCX, MOOD_CY = PCY - 34;

const MOODS = {
  hungry: () => `
<!-- bowl with steam -->
<path d="M ${MOOD_CX - 10} ${MOOD_CY + 4}
         Q ${MOOD_CX - 10} ${MOOD_CY + 12} ${MOOD_CX} ${MOOD_CY + 12}
         Q ${MOOD_CX + 10} ${MOOD_CY + 12} ${MOOD_CX + 10} ${MOOD_CY + 4} Z"
      fill="url(#gk-grad-cream)" stroke="${PALETTE.ink}" stroke-width="1.5" stroke-linejoin="round"/>
<rect x="${MOOD_CX - 12}" y="${MOOD_CY + 2}" width="24" height="3" rx="1" fill="url(#gk-grad-gold)" stroke="${PALETTE.ink}" stroke-width="1"/>
<!-- steam wisps -->
<path d="M ${MOOD_CX - 4} ${MOOD_CY} Q ${MOOD_CX - 2} ${MOOD_CY - 6} ${MOOD_CX - 4} ${MOOD_CY - 10}"
      fill="none" stroke="${PALETTE.cream.hi}" stroke-width="2" stroke-linecap="round" opacity="0.85"/>
<path d="M ${MOOD_CX + 4} ${MOOD_CY} Q ${MOOD_CX + 6} ${MOOD_CY - 6} ${MOOD_CX + 4} ${MOOD_CY - 10}"
      fill="none" stroke="${PALETTE.cream.hi}" stroke-width="2" stroke-linecap="round" opacity="0.85"/>`,

  dirty: () => `
<!-- soap bar -->
<rect x="${MOOD_CX - 8}" y="${MOOD_CY + 4}" width="16" height="8" rx="2"
      fill="url(#gk-grad-sky)" stroke="${PALETTE.sapphire.stroke}" stroke-width="1.5"/>
<ellipse cx="${MOOD_CX - 4}" cy="${MOOD_CY + 6}" rx="3" ry="1.5" fill="${PALETTE.white}" opacity="0.7"/>
<!-- bubbles -->
<circle cx="${MOOD_CX + 6}" cy="${MOOD_CY}" r="3" fill="${PALETTE.white}" stroke="${PALETTE.sapphire.stroke}" stroke-width="1" opacity="0.85"/>
<circle cx="${MOOD_CX - 6}" cy="${MOOD_CY - 4}" r="2" fill="${PALETTE.white}" stroke="${PALETTE.sapphire.stroke}" stroke-width="1" opacity="0.85"/>
<circle cx="${MOOD_CX + 2}" cy="${MOOD_CY - 8}" r="1.5" fill="${PALETTE.white}" stroke="${PALETTE.sapphire.stroke}" stroke-width="0.8" opacity="0.85"/>`,

  sad: () => `
<!-- cloud -->
<path d="M ${MOOD_CX - 12} ${MOOD_CY}
         Q ${MOOD_CX - 14} ${MOOD_CY - 8} ${MOOD_CX - 4} ${MOOD_CY - 8}
         Q ${MOOD_CX} ${MOOD_CY - 14} ${MOOD_CX + 6} ${MOOD_CY - 8}
         Q ${MOOD_CX + 14} ${MOOD_CY - 6} ${MOOD_CX + 10} ${MOOD_CY + 2}
         L ${MOOD_CX - 10} ${MOOD_CY + 2} Z"
      fill="url(#gk-grad-steel)" stroke="${PALETTE.steel.stroke}" stroke-width="1.5" stroke-linejoin="round"/>
<ellipse cx="${MOOD_CX - 4}" cy="${MOOD_CY - 6}" rx="3" ry="1.5" fill="${PALETTE.white}" opacity="0.55"/>
<!-- raindrops -->
<path d="M ${MOOD_CX - 6} ${MOOD_CY + 6} L ${MOOD_CX - 6} ${MOOD_CY + 12}" stroke="${PALETTE.sapphire.base}" stroke-width="2" stroke-linecap="round"/>
<path d="M ${MOOD_CX}     ${MOOD_CY + 6} L ${MOOD_CX}     ${MOOD_CY + 12}" stroke="${PALETTE.sapphire.base}" stroke-width="2" stroke-linecap="round"/>
<path d="M ${MOOD_CX + 6} ${MOOD_CY + 6} L ${MOOD_CX + 6} ${MOOD_CY + 12}" stroke="${PALETTE.sapphire.base}" stroke-width="2" stroke-linecap="round"/>`,
};

// ── Bake driver ─────────────────────────────────────────────────

console.log('Baking glossy pet sprites...');

let count = 0;
for (const species of Object.keys(SPECIES_COLOR)) {
  const colours = SPECIES_COLOR[species];
  for (const [name, palette] of Object.entries(colours)) {
    const body = SPECIES_FN[species](palette);
    const svg = svgWrapper({
      width: W, height: H,
      title: `${species}-${name}`,
      desc: 'Glossy pet sprite. Source: tools/build-pet-glossy.mjs',
      body: `<defs>${petDefs(palette)}</defs>${body}`,
    });
    const out = join(OUT, `${species}-${name}.png`);
    await bakeFile(svg, out, { width: W, height: H });
    count++;
  }
}
console.log(`  pets: ${count}`);

let moodCount = 0;
for (const [hint, fn] of Object.entries(MOODS)) {
  const svg = svgWrapper({
    width: W, height: H,
    title: `mood-${hint}`,
    desc: 'Glossy mood overlay (above pet head).',
    body: fn(),
  });
  const out = join(OUT, `mood-${hint}.png`);
  await bakeFile(svg, out, { width: W, height: H });
  moodCount++;
}
console.log(`  moods: ${moodCount}`);

console.log(`\n✓ baked ${count + moodCount} glossy pet assets (${count} species×colour + ${moodCount} moods) → ${OUT}`);
