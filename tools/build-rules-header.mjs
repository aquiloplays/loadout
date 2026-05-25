// Rules-embed header banner.
//
// 800x180 glossy banner that lands above the rules text in #🫡│rules.
// Same baking pipeline + house style as build-welcome-card.mjs:
// PALETTE / svgWrapper / contactShadow + the brand gradient.
//
// Pure decoration (resvg has fonts disabled so we can't render the
// word "RULES" as text — instead a stylised shield + bolt motif with
// the brand gradient does the visual heavy lifting; the rules text
// renders in the Discord embed below the image where Discord uses
// its native font stack).
//
// Run:  node tools/build-rules-header.mjs

import { mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { PALETTE, svgWrapper, contactShadow } from './glossy-art-kit.mjs';
import { bakeFile } from './bake-glossy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT = join(ROOT, 'aquilo-gg/sprites/welcome');
mkdirSync(OUT, { recursive: true });

const W = 800, H = 180;

const svg = svgWrapper({
  width: W, height: H,
  title: 'aquilo-rules-header',
  desc: 'Glossy header banner for the #rules embed.',
  body: `
<defs>
  <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#1c2050"/>
    <stop offset="0.5" stop-color="#2a1d5c"/>
    <stop offset="1" stop-color="#3a1d5c"/>
  </linearGradient>
  <linearGradient id="brand" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#7c5cff"/>
    <stop offset="0.5" stop-color="#f47fff"/>
    <stop offset="1" stop-color="#5fa0f8"/>
  </linearGradient>
  <radialGradient id="halo" cx="0.5" cy="0.5" r="0.55">
    <stop offset="0" stop-color="#f47fff" stop-opacity="0.55"/>
    <stop offset="1" stop-color="#f47fff" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="shieldFill" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#5fa0f8"/>
    <stop offset="0.5" stop-color="#7c5cff"/>
    <stop offset="1" stop-color="#3a1d5c"/>
  </linearGradient>
  <linearGradient id="boltFill" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#fffacc"/>
    <stop offset="0.6" stop-color="#ffe35c"/>
    <stop offset="1" stop-color="#c69200"/>
  </linearGradient>
</defs>

<rect x="0" y="0" width="${W}" height="${H}" fill="url(#sky)"/>

<!-- subtle deterministic star field -->
<g fill="#FFFFFF">
  ${[[60,30,1.2],[140,60,0.8],[230,40,1.4],[310,90,0.9],[380,28,1.0],
    [470,110,1.2],[560,40,0.7],[640,80,1.1],[720,50,0.9],[770,120,1.0],
    [40,130,0.7],[180,150,0.9],[300,150,1.0],[420,150,0.8],[540,150,1.1],
    [680,150,0.9],[780,30,1.0],[110,80,0.6],[260,15,0.8]]
    .map(([x,y,r])=>`<circle cx="${x}" cy="${y}" r="${r}" opacity="${0.4 + r*0.3}"/>`).join('')}
</g>

<!-- glossy halo behind the central motif -->
<ellipse cx="${W/2}" cy="${H/2}" rx="320" ry="80" fill="url(#halo)"/>

<!-- left-side decorative gem cluster -->
<g transform="translate(120, ${H/2})">
  <circle cx="0" cy="0" r="10" fill="${PALETTE.gold.base}" stroke="${PALETTE.ink}" stroke-width="2"/>
  <circle cx="0" cy="0" r="4" fill="${PALETTE.gold.hi}"/>
  <circle cx="0" cy="-26" r="6" fill="${PALETTE.ruby.base}" stroke="${PALETTE.ink}" stroke-width="1.5" opacity="0.9"/>
  <circle cx="-24" cy="-12" r="6" fill="${PALETTE.sapphire.base}" stroke="${PALETTE.ink}" stroke-width="1.5" opacity="0.9"/>
  <circle cx="22" cy="14" r="5" fill="${PALETTE.emerald.base}" stroke="${PALETTE.ink}" stroke-width="1.5" opacity="0.9"/>
</g>

<!-- centre: a shield with a bolt struck through it. Symbolises "rules
     protect the community" + "Aquilo bolts as the brand." -->
<g transform="translate(${W/2}, ${H/2 + 6})">
  <!-- shield body -->
  <path d="M 0 -56 L 56 -34 L 56 8 Q 56 36 30 52 L 0 64 L -30 52 Q -56 36 -56 8 L -56 -34 Z"
        fill="url(#shieldFill)" stroke="${PALETTE.ink}" stroke-width="4" stroke-linejoin="round"/>
  <!-- inner shield rim -->
  <path d="M 0 -44 L 44 -26 L 44 6 Q 44 30 22 44 L 0 52 L -22 44 Q -44 30 -44 6 L -44 -26 Z"
        fill="none" stroke="${PALETTE.gold.base}" stroke-width="2" opacity="0.65"/>
  <!-- the bolt -->
  <path d="M -10 -36 L 14 -8 L 2 -8 L 18 28 L -8 4 L 4 4 L -14 -36 Z"
        fill="url(#boltFill)" stroke="${PALETTE.ink}" stroke-width="3" stroke-linejoin="round"/>
  <!-- bolt highlight -->
  <path d="M -2 -28 L 4 -16 L -2 -16 L 2 -8 L -4 -16 L 1 -16 L -8 -28 Z"
        fill="#FFFFFF" opacity="0.45"/>
</g>

<!-- right-side decorative gem cluster (mirror) -->
<g transform="translate(${W - 120}, ${H/2})">
  <circle cx="0" cy="0" r="10" fill="${PALETTE.gold.base}" stroke="${PALETTE.ink}" stroke-width="2"/>
  <circle cx="0" cy="0" r="4" fill="${PALETTE.gold.hi}"/>
  <circle cx="0" cy="-26" r="6" fill="${PALETTE.ruby.base}" stroke="${PALETTE.ink}" stroke-width="1.5" opacity="0.9"/>
  <circle cx="24" cy="-12" r="6" fill="${PALETTE.sapphire.base}" stroke="${PALETTE.ink}" stroke-width="1.5" opacity="0.9"/>
  <circle cx="-22" cy="14" r="5" fill="${PALETTE.emerald.base}" stroke="${PALETTE.ink}" stroke-width="1.5" opacity="0.9"/>
</g>

<!-- top-corner glossy accents -->
<path d="M 0 0 L 70 0 L 0 50 Z" fill="${PALETTE.gold.hi}" opacity="0.55"/>
<path d="M ${W} 0 L ${W-70} 0 L ${W} 50 Z" fill="${PALETTE.gold.hi}" opacity="0.55"/>

<!-- bottom accent bar -->
<rect x="0" y="${H - 6}" width="${W}" height="6" fill="url(#brand)"/>

${contactShadow({ cx: W/2, cy: H - 12, rx: 300, ry: 6 })}
`,
});

await bakeFile(svg, join(OUT, 'aquilo-rules-header.png'), { width: W, height: H });
console.log('✓ baked rules header →', join(OUT, 'aquilo-rules-header.png'));
