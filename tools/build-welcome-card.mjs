// Welcome-card backdrop generator.
//
// One static, brand-themed PNG that becomes the welcome embed's `image:`
// field. The per-user info (username, avatar, member #) lives in the
// embed's text + thumbnail and is rendered by Discord, that part is
// dynamic. This backdrop is fixed and ships at
// aquilo-gg/sprites/welcome/aquilo-welcome-card.png.
//
// 800×280, Discord renders embed images at 400-ish wide so 2× scale
// keeps it crisp on hi-DPI.
//
// Run:  node tools/build-welcome-card.mjs

import { mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { PALETTE, svgWrapper, contactShadow } from './glossy-art-kit.mjs';
import { bakeFile } from './bake-glossy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT = join(ROOT, 'aquilo-gg/sprites/welcome');
mkdirSync(OUT, { recursive: true });

const W = 800, H = 280;

const svg = svgWrapper({
  width: W, height: H,
  title: 'aquilo-welcome-card',
  desc: 'Brand-themed welcome embed backdrop.',
  body: `
<!-- night-sky background gradient -->
<defs>
  <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#1c2050"/>
    <stop offset="0.6" stop-color="#2a1d5c"/>
    <stop offset="1" stop-color="#3a1d5c"/>
  </linearGradient>
  <linearGradient id="brand" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#7c5cff"/>
    <stop offset="0.5" stop-color="#f47fff"/>
    <stop offset="1" stop-color="#5fa0f8"/>
  </linearGradient>
  <radialGradient id="halo" cx="0.5" cy="0.5" r="0.6">
    <stop offset="0" stop-color="#f47fff" stop-opacity="0.5"/>
    <stop offset="1" stop-color="#f47fff" stop-opacity="0"/>
  </radialGradient>
</defs>

<rect x="0" y="0" width="${W}" height="${H}" fill="url(#sky)"/>

<!-- stars (deterministic placement so the card looks the same every render) -->
<g fill="#FFFFFF">
  ${[[60,40,1.2],[120,180,0.8],[180,90,1.5],[240,200,0.9],[280,50,1.1],
    [340,150,1.3],[400,30,0.7],[470,210,1.4],[530,80,0.9],[600,160,1.2],
    [660,40,1],[720,190,1.3],[760,110,0.8],[90,230,0.7],[160,260,1.1],
    [300,250,0.9],[420,260,1],[560,250,0.8],[680,250,1.2],[100,140,0.6]]
    .map(([x,y,r])=>`<circle cx="${x}" cy="${y}" r="${r}" opacity="${0.4 + r*0.3}"/>`).join('')}
</g>

<!-- glossy halo behind the headline -->
<ellipse cx="${W/2}" cy="${H/2}" rx="280" ry="100" fill="url(#halo)"/>

<!-- Decorative glossy logo shape (no rendered text, resvg has fonts
     disabled to keep the bake hermetic; the welcome embed's TITLE
     and DESCRIPTION carry the actual wording, so this stays pure
     decoration that won't clash with Discord's text). Stylised "A"
     monogram with brand gradient + ink stroke. -->
<g transform="translate(${W/2 - 70}, ${H/2 - 80})">
  <!-- triangle bowl of the A -->
  <path d="M 70 0 L 140 140 L 0 140 Z"
        fill="url(#brand)" stroke="${PALETTE.ink}" stroke-width="4" stroke-linejoin="round"/>
  <!-- crossbar -->
  <rect x="32" y="92" width="76" height="14" rx="3"
        fill="${PALETTE.gold.base}" stroke="${PALETTE.ink}" stroke-width="3"/>
  <!-- inner highlight on the left flank -->
  <path d="M 70 24 L 110 110 L 96 110 L 70 50 Z"
        fill="#FFFFFF" opacity="0.4"/>
  <!-- crown gem on the apex -->
  <circle cx="70" cy="0" r="10" fill="${PALETTE.gold.hi}" stroke="${PALETTE.ink}" stroke-width="2"/>
  <circle cx="70" cy="0" r="4" fill="#FFFFFF" opacity="0.7"/>
</g>
<!-- decorative gem cluster either side of the monogram -->
<g>
  ${[150, W - 150].map((cx, i) => `
    <g transform="translate(${cx}, ${H/2 + 20})">
      <circle cx="0" cy="0" r="10" fill="${PALETTE.gold.base}" stroke="${PALETTE.ink}" stroke-width="2"/>
      <circle cx="0" cy="0" r="4" fill="${PALETTE.gold.hi}"/>
      <circle cx="0" cy="-22" r="6" fill="${PALETTE.ruby.base}" stroke="${PALETTE.ink}" stroke-width="1.5" opacity="0.85"/>
      <circle cx="${i === 0 ? -22 : 22}" cy="-10" r="6" fill="${PALETTE.sapphire.base}" stroke="${PALETTE.ink}" stroke-width="1.5" opacity="0.85"/>
      <circle cx="${i === 0 ? 18 : -18}" cy="14" r="5" fill="${PALETTE.emerald.base}" stroke="${PALETTE.ink}" stroke-width="1.5" opacity="0.85"/>
    </g>
  `).join('')}
</g>

<!-- bottom accent bar -->
<rect x="0" y="${H - 8}" width="${W}" height="8" fill="url(#brand)"/>

<!-- top corner glossy accents -->
<path d="M 0 0 L 80 0 L 0 60 Z" fill="${PALETTE.gold.hi}" opacity="0.6"/>
<path d="M ${W} 0 L ${W-80} 0 L ${W} 60 Z" fill="${PALETTE.gold.hi}" opacity="0.6"/>

${contactShadow({ cx: W/2, cy: H - 16, rx: 320, ry: 8 })}
`,
});

await bakeFile(svg, join(OUT, 'aquilo-welcome-card.png'), { width: W, height: H });
console.log('✓ baked welcome card →', join(OUT, 'aquilo-welcome-card.png'));
