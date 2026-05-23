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
// right foot. Centred on (PCX, PCY) with ~40 px radius footprint.
const PCX = 96, PCY = 134;

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
${contactShadow({ cx: PCX, cy: PCY + 18, rx: 22, ry: 5 })}
<!-- tail (curled back) -->
<path d="M ${PCX + 16} ${PCY + 10}
         Q ${PCX + 32} ${PCY - 2} ${PCX + 28} ${PCY - 18}
         Q ${PCX + 24} ${PCY - 24} ${PCX + 20} ${PCY - 14}
         Q ${PCX + 22} ${PCY - 4} ${PCX + 14} ${PCY + 10} Z"
      fill="url(#pet-grad)" stroke="${c.stroke}" stroke-width="2" stroke-linejoin="round"/>
<!-- body (oval) -->
<ellipse cx="${PCX}" cy="${PCY + 6}" rx="20" ry="14"
         fill="url(#pet-rgrad)" stroke="${c.stroke}" stroke-width="2.5"/>
<!-- head -->
<circle cx="${PCX - 4}" cy="${PCY - 8}" r="13"
        fill="url(#pet-rgrad)" stroke="${c.stroke}" stroke-width="2.5"/>
<!-- ears -->
<path d="M ${PCX - 14} ${PCY - 18} L ${PCX - 10} ${PCY - 28} L ${PCX - 6} ${PCY - 20} Z"
      fill="${c.base}" stroke="${c.stroke}" stroke-width="2" stroke-linejoin="round"/>
<path d="M ${PCX - 2} ${PCY - 18} L ${PCX + 2} ${PCY - 28} L ${PCX + 6} ${PCY - 19} Z"
      fill="${c.base}" stroke="${c.stroke}" stroke-width="2" stroke-linejoin="round"/>
<!-- inner ears (pink) -->
<path d="M ${PCX - 12} ${PCY - 20} L ${PCX - 10} ${PCY - 26} L ${PCX - 8} ${PCY - 21} Z" fill="#f5a8c8" opacity="0.85"/>
<path d="M ${PCX} ${PCY - 20} L ${PCX + 2} ${PCY - 26} L ${PCX + 4} ${PCY - 21} Z" fill="#f5a8c8" opacity="0.85"/>
<!-- eyes -->
<ellipse cx="${PCX - 8}" cy="${PCY - 8}" rx="2" ry="3" fill="#FFD972"/>
<ellipse cx="${PCX}" cy="${PCY - 8}" rx="2" ry="3" fill="#FFD972"/>
<circle cx="${PCX - 8}" cy="${PCY - 7}" r="0.8" fill="${PALETTE.ink}"/>
<circle cx="${PCX}"     cy="${PCY - 7}" r="0.8" fill="${PALETTE.ink}"/>
<!-- nose + mouth -->
<path d="M ${PCX - 5} ${PCY - 3} L ${PCX - 4} ${PCY - 1} L ${PCX - 3} ${PCY - 3} Z" fill="#f5a8c8"/>
<path d="M ${PCX - 4} ${PCY - 1} Q ${PCX - 6} ${PCY + 1} ${PCX - 8} ${PCY - 1}" fill="none" stroke="${c.stroke}" stroke-width="1.2"/>
<path d="M ${PCX - 4} ${PCY - 1} Q ${PCX - 2} ${PCY + 1} ${PCX}     ${PCY - 1}" fill="none" stroke="${c.stroke}" stroke-width="1.2"/>
<!-- whiskers -->
<g stroke="${c.stroke}" stroke-width="1" opacity="0.7">
  <line x1="${PCX - 14}" y1="${PCY - 4}" x2="${PCX - 22}" y2="${PCY - 6}"/>
  <line x1="${PCX - 14}" y1="${PCY - 2}" x2="${PCX - 22}" y2="${PCY}"/>
  <line x1="${PCX + 4}"  y1="${PCY - 4}" x2="${PCX + 12}" y2="${PCY - 6}"/>
  <line x1="${PCX + 4}"  y1="${PCY - 2}" x2="${PCX + 12}" y2="${PCY}"/>
</g>
<!-- body gloss -->
<ellipse cx="${PCX - 8}" cy="${PCY - 2}" rx="6" ry="3" fill="#FFFFFF" opacity="0.4"/>`;
}

function petDog(c) {
  return `
${contactShadow({ cx: PCX, cy: PCY + 18, rx: 24, ry: 5 })}
<!-- tail (wagging up) -->
<path d="M ${PCX + 14} ${PCY + 4}
         Q ${PCX + 28} ${PCY - 2} ${PCX + 26} ${PCY - 14}
         Q ${PCX + 22} ${PCY - 18} ${PCX + 18} ${PCY - 10}
         Q ${PCX + 18} ${PCY - 2} ${PCX + 12} ${PCY + 6} Z"
      fill="url(#pet-grad)" stroke="${c.stroke}" stroke-width="2" stroke-linejoin="round"/>
<!-- body -->
<ellipse cx="${PCX}" cy="${PCY + 6}" rx="22" ry="14"
         fill="url(#pet-rgrad)" stroke="${c.stroke}" stroke-width="2.5"/>
<!-- legs (front paws sticking out) -->
<rect x="${PCX - 14}" y="${PCY + 14}" width="6" height="8" rx="2" fill="${c.base}" stroke="${c.stroke}" stroke-width="2"/>
<rect x="${PCX + 8}"  y="${PCY + 14}" width="6" height="8" rx="2" fill="${c.base}" stroke="${c.stroke}" stroke-width="2"/>
<!-- head -->
<circle cx="${PCX - 4}" cy="${PCY - 6}" r="13"
        fill="url(#pet-rgrad)" stroke="${c.stroke}" stroke-width="2.5"/>
<!-- snout -->
<ellipse cx="${PCX - 12}" cy="${PCY - 1}" rx="6" ry="4"
         fill="${c.hi}" stroke="${c.stroke}" stroke-width="2"/>
<circle cx="${PCX - 16}" cy="${PCY - 2}" r="1.5" fill="${PALETTE.ink}"/>
<!-- floppy ears -->
<path d="M ${PCX - 14} ${PCY - 14}
         Q ${PCX - 22} ${PCY - 10} ${PCX - 18} ${PCY + 4}
         Q ${PCX - 14} ${PCY - 2} ${PCX - 12} ${PCY - 12} Z"
      fill="${c.base}" stroke="${c.stroke}" stroke-width="2" stroke-linejoin="round"/>
<path d="M ${PCX + 4} ${PCY - 14}
         Q ${PCX + 12} ${PCY - 8} ${PCX + 8} ${PCY + 2}
         Q ${PCX + 4} ${PCY - 4} ${PCX + 2} ${PCY - 12} Z"
      fill="${c.base}" stroke="${c.stroke}" stroke-width="2" stroke-linejoin="round"/>
<!-- eyes -->
<circle cx="${PCX - 6}" cy="${PCY - 8}" r="1.8" fill="${PALETTE.ink}"/>
<circle cx="${PCX + 2}" cy="${PCY - 8}" r="1.8" fill="${PALETTE.ink}"/>
<circle cx="${PCX - 5.5}" cy="${PCY - 8.5}" r="0.6" fill="#FFFFFF"/>
<circle cx="${PCX + 2.5}" cy="${PCY - 8.5}" r="0.6" fill="#FFFFFF"/>
<!-- mouth + tongue -->
<path d="M ${PCX - 8} ${PCY + 2} Q ${PCX - 6} ${PCY + 4} ${PCX - 4} ${PCY + 2}" fill="#f08aa0" stroke="${c.stroke}" stroke-width="1.2"/>
<!-- gloss -->
<ellipse cx="${PCX - 8}" cy="${PCY - 2}" rx="7" ry="3" fill="#FFFFFF" opacity="0.4"/>`;
}

function petOwl(c) {
  return `
${contactShadow({ cx: PCX, cy: PCY + 18, rx: 20, ry: 4 })}
<!-- body (egg-shape) -->
<ellipse cx="${PCX}" cy="${PCY}" rx="18" ry="22"
         fill="url(#pet-rgrad)" stroke="${c.stroke}" stroke-width="2.5"/>
<!-- belly tuft (lighter) -->
<ellipse cx="${PCX}" cy="${PCY + 4}" rx="10" ry="12" fill="${c.hi}" opacity="0.65"/>
<!-- wings (folded) -->
<path d="M ${PCX - 18} ${PCY - 4}
         Q ${PCX - 22} ${PCY + 8} ${PCX - 14} ${PCY + 16}
         Q ${PCX - 10} ${PCY + 8} ${PCX - 12} ${PCY - 2} Z"
      fill="${c.base}" stroke="${c.stroke}" stroke-width="2" stroke-linejoin="round"/>
<path d="M ${PCX + 18} ${PCY - 4}
         Q ${PCX + 22} ${PCY + 8} ${PCX + 14} ${PCY + 16}
         Q ${PCX + 10} ${PCY + 8} ${PCX + 12} ${PCY - 2} Z"
      fill="${c.base}" stroke="${c.stroke}" stroke-width="2" stroke-linejoin="round"/>
<!-- ear tufts -->
<path d="M ${PCX - 12} ${PCY - 18} L ${PCX - 8} ${PCY - 26} L ${PCX - 4} ${PCY - 18} Z" fill="${c.base}" stroke="${c.stroke}" stroke-width="2" stroke-linejoin="round"/>
<path d="M ${PCX + 4} ${PCY - 18} L ${PCX + 8} ${PCY - 26} L ${PCX + 12} ${PCY - 18} Z" fill="${c.base}" stroke="${c.stroke}" stroke-width="2" stroke-linejoin="round"/>
<!-- eyes (big yellow) -->
<circle cx="${PCX - 6}" cy="${PCY - 10}" r="6" fill="#FFE082" stroke="${c.stroke}" stroke-width="1.5"/>
<circle cx="${PCX + 6}" cy="${PCY - 10}" r="6" fill="#FFE082" stroke="${c.stroke}" stroke-width="1.5"/>
<circle cx="${PCX - 6}" cy="${PCY - 10}" r="3" fill="${PALETTE.ink}"/>
<circle cx="${PCX + 6}" cy="${PCY - 10}" r="3" fill="${PALETTE.ink}"/>
<circle cx="${PCX - 5}" cy="${PCY - 11}" r="1" fill="#FFFFFF"/>
<circle cx="${PCX + 7}" cy="${PCY - 11}" r="1" fill="#FFFFFF"/>
<!-- beak -->
<path d="M ${PCX} ${PCY - 4} L ${PCX - 3} ${PCY + 1} L ${PCX + 3} ${PCY + 1} Z"
      fill="${PALETTE.gold.base}" stroke="${c.stroke}" stroke-width="1.5" stroke-linejoin="round"/>
<!-- gloss -->
<ellipse cx="${PCX - 6}" cy="${PCY - 14}" rx="5" ry="3" fill="#FFFFFF" opacity="0.35"/>`;
}

function petFox(c) {
  return `
${contactShadow({ cx: PCX, cy: PCY + 18, rx: 22, ry: 5 })}
<!-- bushy tail -->
<path d="M ${PCX + 14} ${PCY + 8}
         Q ${PCX + 32} ${PCY + 4} ${PCX + 34} ${PCY - 14}
         Q ${PCX + 28} ${PCY - 22} ${PCX + 18} ${PCY - 14}
         Q ${PCX + 22} ${PCY - 2} ${PCX + 10} ${PCY + 8} Z"
      fill="url(#pet-grad)" stroke="${c.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<!-- tail tip (white) -->
<ellipse cx="${PCX + 28}" cy="${PCY - 18}" rx="5" ry="4" fill="${PALETTE.white}" stroke="${c.stroke}" stroke-width="1.5"/>
<!-- body -->
<ellipse cx="${PCX}" cy="${PCY + 6}" rx="20" ry="13"
         fill="url(#pet-rgrad)" stroke="${c.stroke}" stroke-width="2.5"/>
<!-- chest tuft (white) -->
<ellipse cx="${PCX - 4}" cy="${PCY + 10}" rx="8" ry="6" fill="${PALETTE.white}" opacity="0.8"/>
<!-- head (more triangular than cat) -->
<path d="M ${PCX - 14} ${PCY - 4}
         Q ${PCX - 16} ${PCY - 12} ${PCX - 8} ${PCY - 16}
         Q ${PCX + 4} ${PCY - 18} ${PCX + 10} ${PCY - 14}
         Q ${PCX + 14} ${PCY - 8} ${PCX + 12} ${PCY - 2}
         Q ${PCX + 8} ${PCY + 4} ${PCX - 2} ${PCY + 4}
         Q ${PCX - 12} ${PCY + 2} ${PCX - 14} ${PCY - 4} Z"
      fill="url(#pet-rgrad)" stroke="${c.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<!-- snout (pointed) -->
<path d="M ${PCX - 14} ${PCY - 2} L ${PCX - 22} ${PCY + 2} L ${PCX - 12} ${PCY + 4} Z"
      fill="${PALETTE.white}" stroke="${c.stroke}" stroke-width="1.5" stroke-linejoin="round"/>
<circle cx="${PCX - 20}" cy="${PCY + 1}" r="1.4" fill="${PALETTE.ink}"/>
<!-- pointed ears -->
<path d="M ${PCX - 8} ${PCY - 14} L ${PCX - 4} ${PCY - 24} L ${PCX} ${PCY - 16} Z"
      fill="${c.base}" stroke="${c.stroke}" stroke-width="2" stroke-linejoin="round"/>
<path d="M ${PCX + 4} ${PCY - 14} L ${PCX + 8} ${PCY - 24} L ${PCX + 12} ${PCY - 16} Z"
      fill="${c.base}" stroke="${c.stroke}" stroke-width="2" stroke-linejoin="round"/>
<!-- eyes -->
<ellipse cx="${PCX - 6}" cy="${PCY - 8}" rx="2.2" ry="2.8" fill="#FFE082"/>
<ellipse cx="${PCX + 4}" cy="${PCY - 8}" rx="2.2" ry="2.8" fill="#FFE082"/>
<circle cx="${PCX - 6}" cy="${PCY - 7}" r="0.9" fill="${PALETTE.ink}"/>
<circle cx="${PCX + 4}" cy="${PCY - 7}" r="0.9" fill="${PALETTE.ink}"/>`;
}

function petSlime(c) {
  return `
${contactShadow({ cx: PCX, cy: PCY + 18, rx: 24, ry: 5 })}
<!-- blob body -->
<path d="M ${PCX - 24} ${PCY + 14}
         Q ${PCX - 26} ${PCY - 10} ${PCX - 12} ${PCY - 18}
         Q ${PCX + 6} ${PCY - 22} ${PCX + 18} ${PCY - 12}
         Q ${PCX + 26} ${PCY - 4} ${PCX + 22} ${PCY + 14}
         Q ${PCX + 10} ${PCY + 18} ${PCX} ${PCY + 16}
         Q ${PCX - 12} ${PCY + 18} ${PCX - 24} ${PCY + 14} Z"
      fill="url(#pet-rgrad)" stroke="${c.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<!-- highlight crescent -->
<path d="M ${PCX - 18} ${PCY - 4}
         Q ${PCX - 22} ${PCY - 14} ${PCX - 8} ${PCY - 16}
         L ${PCX - 4} ${PCY - 12}
         Q ${PCX - 16} ${PCY - 10} ${PCX - 14} ${PCY - 2} Z"
      fill="${PALETTE.white}" opacity="0.55"/>
<!-- big simple eyes -->
<ellipse cx="${PCX - 7}" cy="${PCY - 4}" rx="3" ry="4" fill="${PALETTE.ink}"/>
<ellipse cx="${PCX + 7}" cy="${PCY - 4}" rx="3" ry="4" fill="${PALETTE.ink}"/>
<circle cx="${PCX - 6}" cy="${PCY - 5}" r="1" fill="${PALETTE.white}"/>
<circle cx="${PCX + 8}" cy="${PCY - 5}" r="1" fill="${PALETTE.white}"/>
<!-- smile -->
<path d="M ${PCX - 6} ${PCY + 4} Q ${PCX} ${PCY + 8} ${PCX + 6} ${PCY + 4}"
      fill="none" stroke="${c.stroke}" stroke-width="1.6" stroke-linecap="round"/>`;
}

function petDragonling(c) {
  return `
${contactShadow({ cx: PCX, cy: PCY + 18, rx: 22, ry: 5 })}
<!-- back wing -->
<path d="M ${PCX + 4} ${PCY - 2}
         Q ${PCX + 18} ${PCY - 22} ${PCX + 26} ${PCY - 10}
         Q ${PCX + 20} ${PCY - 6} ${PCX + 18} ${PCY + 4}
         Q ${PCX + 8} ${PCY - 4} ${PCX + 4} ${PCY - 2} Z"
      fill="${c.base}" stroke="${c.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<!-- body -->
<ellipse cx="${PCX}" cy="${PCY + 6}" rx="18" ry="13"
         fill="url(#pet-rgrad)" stroke="${c.stroke}" stroke-width="2.5"/>
<!-- belly scales -->
<ellipse cx="${PCX - 2}" cy="${PCY + 10}" rx="9" ry="6" fill="${c.hi}" opacity="0.6"/>
<!-- tail (curling) -->
<path d="M ${PCX - 14} ${PCY + 10}
         Q ${PCX - 24} ${PCY + 18} ${PCX - 22} ${PCY + 4}
         Q ${PCX - 18} ${PCY + 8} ${PCX - 12} ${PCY + 8} Z"
      fill="url(#pet-grad)" stroke="${c.stroke}" stroke-width="2" stroke-linejoin="round"/>
<!-- head -->
<ellipse cx="${PCX - 6}" cy="${PCY - 6}" rx="11" ry="9"
         fill="url(#pet-rgrad)" stroke="${c.stroke}" stroke-width="2.5"/>
<!-- horns -->
<path d="M ${PCX - 12} ${PCY - 14} L ${PCX - 16} ${PCY - 22} L ${PCX - 8} ${PCY - 16} Z"
      fill="${PALETTE.iron.base}" stroke="${c.stroke}" stroke-width="1.5" stroke-linejoin="round"/>
<path d="M ${PCX - 2} ${PCY - 14} L ${PCX + 2} ${PCY - 22} L ${PCX + 4} ${PCY - 14} Z"
      fill="${PALETTE.iron.base}" stroke="${c.stroke}" stroke-width="1.5" stroke-linejoin="round"/>
<!-- snout (small) -->
<ellipse cx="${PCX - 14}" cy="${PCY - 4}" rx="4" ry="3" fill="${c.base}" stroke="${c.stroke}" stroke-width="1.5"/>
<circle cx="${PCX - 16}" cy="${PCY - 5}" r="0.6" fill="${PALETTE.ink}"/>
<circle cx="${PCX - 16}" cy="${PCY - 3}" r="0.6" fill="${PALETTE.ink}"/>
<!-- eye -->
<circle cx="${PCX - 4}" cy="${PCY - 8}" r="2.5" fill="${PALETTE.ruby.hi}" stroke="${c.stroke}" stroke-width="1"/>
<circle cx="${PCX - 4}" cy="${PCY - 8}" r="1" fill="${PALETTE.ink}"/>`;
}

function petFrog(c) {
  return `
${contactShadow({ cx: PCX, cy: PCY + 18, rx: 22, ry: 5 })}
<!-- back legs -->
<path d="M ${PCX - 18} ${PCY + 8}
         Q ${PCX - 22} ${PCY + 18} ${PCX - 12} ${PCY + 22}
         L ${PCX - 8} ${PCY + 12} Z"
      fill="url(#pet-grad)" stroke="${c.stroke}" stroke-width="2" stroke-linejoin="round"/>
<path d="M ${PCX + 8} ${PCY + 12}
         L ${PCX + 12} ${PCY + 22}
         Q ${PCX + 22} ${PCY + 18} ${PCX + 18} ${PCY + 8} Z"
      fill="url(#pet-grad)" stroke="${c.stroke}" stroke-width="2" stroke-linejoin="round"/>
<!-- body (squat oval) -->
<ellipse cx="${PCX}" cy="${PCY + 4}" rx="20" ry="14"
         fill="url(#pet-rgrad)" stroke="${c.stroke}" stroke-width="2.5"/>
<!-- belly (lighter) -->
<ellipse cx="${PCX}" cy="${PCY + 10}" rx="14" ry="8" fill="${c.hi}" opacity="0.6"/>
<!-- bulging eye sockets on top -->
<circle cx="${PCX - 8}" cy="${PCY - 10}" r="7"
        fill="url(#pet-rgrad)" stroke="${c.stroke}" stroke-width="2"/>
<circle cx="${PCX + 8}" cy="${PCY - 10}" r="7"
        fill="url(#pet-rgrad)" stroke="${c.stroke}" stroke-width="2"/>
<!-- eyes inside sockets -->
<circle cx="${PCX - 8}" cy="${PCY - 10}" r="3.5" fill="#FFE082"/>
<circle cx="${PCX + 8}" cy="${PCY - 10}" r="3.5" fill="#FFE082"/>
<circle cx="${PCX - 7}" cy="${PCY - 10}" r="1.8" fill="${PALETTE.ink}"/>
<circle cx="${PCX + 9}" cy="${PCY - 10}" r="1.8" fill="${PALETTE.ink}"/>
<!-- wide mouth -->
<path d="M ${PCX - 14} ${PCY + 2} Q ${PCX} ${PCY + 8} ${PCX + 14} ${PCY + 2}"
      fill="none" stroke="${c.stroke}" stroke-width="2" stroke-linecap="round"/>`;
}

function petBunny(c) {
  return `
${contactShadow({ cx: PCX, cy: PCY + 18, rx: 20, ry: 4 })}
<!-- back foot -->
<ellipse cx="${PCX - 10}" cy="${PCY + 18}" rx="9" ry="5" fill="${c.base}" stroke="${c.stroke}" stroke-width="2"/>
<!-- body -->
<ellipse cx="${PCX}" cy="${PCY + 4}" rx="16" ry="14"
         fill="url(#pet-rgrad)" stroke="${c.stroke}" stroke-width="2.5"/>
<!-- chest fluff -->
<ellipse cx="${PCX - 2}" cy="${PCY + 8}" rx="8" ry="6" fill="${c.hi}" opacity="0.65"/>
<!-- tail (cotton ball) -->
<circle cx="${PCX + 14}" cy="${PCY + 6}" r="5" fill="${PALETTE.white}" stroke="${c.stroke}" stroke-width="1.5"/>
<!-- head -->
<circle cx="${PCX - 2}" cy="${PCY - 10}" r="11"
        fill="url(#pet-rgrad)" stroke="${c.stroke}" stroke-width="2.5"/>
<!-- LONG ears (signature bunny) -->
<ellipse cx="${PCX - 8}" cy="${PCY - 26}" rx="3.5" ry="14"
         fill="${c.base}" stroke="${c.stroke}" stroke-width="2"/>
<ellipse cx="${PCX + 4}" cy="${PCY - 26}" rx="3.5" ry="14"
         fill="${c.base}" stroke="${c.stroke}" stroke-width="2"/>
<!-- ear inner (pink) -->
<ellipse cx="${PCX - 8}" cy="${PCY - 24}" rx="1.5" ry="10" fill="#f5a8c8" opacity="0.85"/>
<ellipse cx="${PCX + 4}" cy="${PCY - 24}" rx="1.5" ry="10" fill="#f5a8c8" opacity="0.85"/>
<!-- eyes -->
<circle cx="${PCX - 6}" cy="${PCY - 10}" r="1.8" fill="${PALETTE.ink}"/>
<circle cx="${PCX + 2}" cy="${PCY - 10}" r="1.8" fill="${PALETTE.ink}"/>
<circle cx="${PCX - 5.5}" cy="${PCY - 10.5}" r="0.6" fill="${PALETTE.white}"/>
<circle cx="${PCX + 2.5}" cy="${PCY - 10.5}" r="0.6" fill="${PALETTE.white}"/>
<!-- nose (pink Y) -->
<path d="M ${PCX - 2} ${PCY - 5} L ${PCX - 4} ${PCY - 3} L ${PCX} ${PCY - 3} Z" fill="#f5a8c8" stroke="${c.stroke}" stroke-width="1"/>
<!-- buck teeth -->
<rect x="${PCX - 3}" y="${PCY - 1}" width="2" height="3" fill="${PALETTE.white}" stroke="${c.stroke}" stroke-width="0.8"/>
<rect x="${PCX - 1}" y="${PCY - 1}" width="2" height="3" fill="${PALETTE.white}" stroke="${c.stroke}" stroke-width="0.8"/>`;
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
