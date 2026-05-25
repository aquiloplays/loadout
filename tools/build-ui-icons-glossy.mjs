// A7 — Glossy UI icon set for OBS overlays + Discord embeds.
//
// Replaces the 32 pixel icons under aquilo-gg/sprites/ui/icons/
// with a glossy SVG-sourced library, baked to PNG so the existing
// overlay HTML (img src="/sprites/ui/icons/...") keeps working
// after vendor.
//
// Each icon is authored as a self-contained 64×64 SVG using the
// glossy art kit's palette/gradient/filter defs. Baked at 64×64
// (overlays display at 16-32 px so 64 gives 2-4× headroom for
// crisp downscale).
//
// Output: aquilo-gg/sprites/ui/icons/glossy/<name>.png    (32 icons)
//
// Run:  node tools/build-ui-icons-glossy.mjs

import { mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { PALETTE, svgWrapper } from './glossy-art-kit.mjs';
import { bakeFile } from './bake-glossy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT  = join(ROOT, 'aquilo-gg/sprites/ui/icons/glossy');
mkdirSync(OUT, { recursive: true });

const W = 64, H = 64;
const CX = 32, CY = 32;

// Each icon = one function returning SVG body using PALETTE
// gradients. All icons centred. Shapes are bold + simple so they
// read crisply at 16 px.

const ICONS = {
  // Brand bolt — violet → green like the wordmark gradient.
  bolt: () => `
<defs>
  <linearGradient id="bolt-grad" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#9a82ff"/>
    <stop offset="0.55" stop-color="#7c5cff"/>
    <stop offset="1" stop-color="#5bff95"/>
  </linearGradient>
</defs>
<path d="M ${CX + 4} 6
         L ${CX - 14} 32
         L ${CX - 2} 32
         L ${CX - 8} 58
         L ${CX + 14} 28
         L ${CX + 2} 28 Z"
      fill="url(#bolt-grad)" stroke="${PALETTE.ink}" stroke-width="2.5" stroke-linejoin="round"/>
<path d="M ${CX + 2} 10
         L ${CX - 10} 32
         L ${CX - 4} 32
         L ${CX - 6} 42
         Z"
      fill="#FFFFFF" opacity="0.6"/>`,

  // Trophy — gold cup with handles.
  trophy: () => `
<!-- base -->
<rect x="${CX - 14}" y="50" width="28" height="8" rx="2"
      fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="2"/>
<rect x="${CX - 6}" y="40" width="12" height="14"
      fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="2"/>
<!-- cup body -->
<path d="M ${CX - 16} 10
         L ${CX + 16} 10
         L ${CX + 14} 32
         Q ${CX} 44 ${CX - 14} 32 Z"
      fill="url(#gk-rgrad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<!-- handles -->
<path d="M ${CX - 16} 14 Q ${CX - 26} 18 ${CX - 20} 28" fill="none" stroke="${PALETTE.gold.stroke}" stroke-width="3" stroke-linecap="round"/>
<path d="M ${CX + 16} 14 Q ${CX + 26} 18 ${CX + 20} 28" fill="none" stroke="${PALETTE.gold.stroke}" stroke-width="3" stroke-linecap="round"/>
<!-- rim -->
<rect x="${CX - 18}" y="6" width="36" height="6" rx="2"
      fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="2"/>
<!-- gloss -->
<ellipse cx="${CX - 6}" cy="16" rx="6" ry="3" fill="#FFFFFF" opacity="0.55"/>`,

  // Crown — gold with gem.
  crown: () => `
<path d="M 10 50
         L 10 28
         L 18 36
         L 24 16
         L ${CX} 32
         L 40 16
         L 46 36
         L 54 28
         L 54 50 Z"
      fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<!-- gems -->
<circle cx="${CX}" cy="24" r="3.5" fill="url(#gk-rgrad-ruby)" stroke="${PALETTE.ruby.stroke}" stroke-width="1.5"/>
<circle cx="22" cy="32" r="2.5" fill="url(#gk-rgrad-sapphire)" stroke="${PALETTE.sapphire.stroke}" stroke-width="1"/>
<circle cx="42" cy="32" r="2.5" fill="url(#gk-rgrad-sapphire)" stroke="${PALETTE.sapphire.stroke}" stroke-width="1"/>
<!-- base band -->
<rect x="9" y="48" width="46" height="6" rx="2" fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="2"/>
<!-- gloss strip -->
<path d="M 12 30 L 16 30 L 22 18 L 24 22 L ${CX} 32 L 36 26 L 40 18 L 46 30 L 50 30 L 50 38 L 12 38 Z"
      fill="#FFFFFF" opacity="0.25"/>`,

  // Coin — gold disc with embossed bolt motif (path-based; Resvg
  // skips system fonts in our bake config so $ text won't render).
  coin: () => `
<circle cx="${CX}" cy="${CY}" r="26" fill="url(#gk-rgrad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="3"/>
<circle cx="${CX}" cy="${CY}" r="20" fill="none" stroke="${PALETTE.gold.stroke}" stroke-width="2" opacity="0.55"/>
<!-- embossed bolt motif (matches the brand bolt icon) -->
<path d="M ${CX + 3} ${CY - 12}
         L ${CX - 8} ${CY + 2}
         L ${CX - 2} ${CY + 2}
         L ${CX - 4} ${CY + 12}
         L ${CX + 8} ${CY - 2}
         L ${CX + 2} ${CY - 2} Z"
      fill="${PALETTE.gold.stroke}" stroke="${PALETTE.gold.stroke}" stroke-width="1" stroke-linejoin="round" opacity="0.85"/>
<ellipse cx="${CX - 10}" cy="${CY - 14}" rx="9" ry="4" fill="#FFFFFF" opacity="0.5"/>`,

  // Gem — faceted diamond.
  gem: () => `
<path d="M ${CX} 8
         L 14 26
         L 22 50
         L ${CX} 58
         L 42 50
         L 50 26 Z"
      fill="url(#gk-grad-sapphire)" stroke="${PALETTE.sapphire.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<!-- facet lines -->
<g stroke="${PALETTE.sapphire.stroke}" stroke-width="1.5" opacity="0.5">
  <line x1="14" y1="26" x2="${CX}" y2="22"/>
  <line x1="50" y1="26" x2="${CX}" y2="22"/>
  <line x1="22" y1="50" x2="${CX}" y2="22"/>
  <line x1="42" y1="50" x2="${CX}" y2="22"/>
  <line x1="${CX}" y1="22" x2="${CX}" y2="58"/>
</g>
<!-- top facet gloss -->
<path d="M ${CX} 8 L 14 26 L ${CX} 22 Z" fill="#FFFFFF" opacity="0.65"/>`,

  // Heart — pink, glossy.
  heart: () => `
<path d="M ${CX} 56
         Q 8 38 12 22
         Q 16 10 ${CX - 4} 12
         Q ${CX} 16 ${CX} 22
         Q ${CX} 16 ${CX + 4} 12
         Q 48 10 52 22
         Q 56 38 ${CX} 56 Z"
      fill="url(#gk-grad-pink-glossy)" stroke="${PALETTE.ruby.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<defs>
  <linearGradient id="gk-grad-pink-glossy" x1="0.3" y1="0.1" x2="0.7" y2="0.9">
    <stop offset="0" stop-color="#FFB0C8"/>
    <stop offset="0.55" stop-color="#F85F90"/>
    <stop offset="1" stop-color="#8C1E48"/>
  </linearGradient>
</defs>
<ellipse cx="22" cy="22" rx="8" ry="4" fill="#FFFFFF" opacity="0.65"/>`,

  // Flame — orange→yellow tongue.
  flame: () => `
<defs>
  <linearGradient id="flame-grad" x1="0" y1="1" x2="0" y2="0">
    <stop offset="0" stop-color="#D62E48"/>
    <stop offset="0.5" stop-color="#F0B429"/>
    <stop offset="1" stop-color="#FFF6D8"/>
  </linearGradient>
</defs>
<path d="M ${CX} 56
         Q 12 50 14 36
         Q 16 28 22 24
         Q 18 14 ${CX} 6
         Q ${CX + 4} 18 ${CX + 10} 22
         Q 50 30 50 40
         Q 52 52 ${CX} 56 Z"
      fill="url(#flame-grad)" stroke="${PALETTE.ruby.stroke}" stroke-width="2" stroke-linejoin="round"/>
<!-- inner tongue -->
<path d="M ${CX} 50
         Q 22 46 24 36
         Q 28 26 ${CX} 18
         Q ${CX + 6} 28 38 36
         Q 42 46 ${CX} 50 Z"
      fill="${PALETTE.gold.hi}" opacity="0.85"/>
<path d="M ${CX} 42 Q 28 36 32 28 Q ${CX + 2} 34 ${CX} 42 Z" fill="#FFFFFF" opacity="0.6"/>`,

  // Gift — box with bow.
  gift: () => `
<!-- box body -->
<rect x="8" y="26" width="48" height="32" rx="3"
      fill="url(#gk-grad-ruby)" stroke="${PALETTE.ruby.stroke}" stroke-width="2.5"/>
<!-- lid -->
<rect x="6" y="20" width="52" height="10" rx="2"
      fill="url(#gk-grad-ruby)" stroke="${PALETTE.ruby.stroke}" stroke-width="2.5"/>
<!-- ribbon vertical -->
<rect x="${CX - 4}" y="20" width="8" height="38" fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1.5"/>
<!-- ribbon horizontal -->
<rect x="6" y="${CY - 2}" width="52" height="6" fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1.5"/>
<!-- bow loops -->
<ellipse cx="${CX - 8}" cy="18" rx="8" ry="6" fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="2"/>
<ellipse cx="${CX + 8}" cy="18" rx="8" ry="6" fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="2"/>
<circle cx="${CX}" cy="18" r="4" fill="url(#gk-rgrad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1.5"/>
<!-- gloss -->
<path d="M 12 24 L 14 56 L 22 56 L 22 24 Z" fill="#FFFFFF" opacity="0.35"/>`,

  // Star — 5-point gold.
  star: () => `
<path d="M ${CX} 6
         L ${CX + 8} 24
         L 58 26
         L 42 38
         L 48 56
         L ${CX} 46
         L 16 56
         L 22 38
         L 6 26
         L ${CX - 8} 24 Z"
      fill="url(#gk-rgrad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<path d="M ${CX} 14 L ${CX + 5} 25 L ${CX + 14} 26 L ${CX + 3} 34 Z"
      fill="#FFFFFF" opacity="0.5"/>`,

  // Sparkle — 4-point burst.
  sparkle: () => `
<path d="M ${CX} 4 L ${CX + 4} ${CY - 4} L ${CY + 28} ${CY} L ${CX + 4} ${CY + 4} L ${CX} ${CY + 28} L ${CX - 4} ${CY + 4} L ${CY - 28} ${CY} L ${CX - 4} ${CY - 4} Z"
      fill="url(#gk-grad-cream)" stroke="${PALETTE.gold.stroke}" stroke-width="2" stroke-linejoin="round"/>
<circle cx="${CX}" cy="${CY}" r="6" fill="${PALETTE.white}" opacity="0.85"/>
<!-- small accent stars -->
<circle cx="14" cy="50" r="2" fill="${PALETTE.gold.hi}"/>
<circle cx="50" cy="14" r="2" fill="${PALETTE.gold.hi}"/>`,

  // Shield — heater shield with brand colors.
  shield: () => `
<path d="M ${CX} 6
         L 10 14
         L 12 38
         Q 16 52 ${CX} 58
         Q 48 52 52 38
         L 54 14 Z"
      fill="url(#gk-grad-sapphire)" stroke="${PALETTE.sapphire.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<!-- gold rim -->
<path d="M ${CX} 10 L 14 16 L 16 38 Q 19 48 ${CX} 54 Q 45 48 48 38 L 50 16 Z"
      fill="none" stroke="${PALETTE.gold.hi}" stroke-width="2"/>
<!-- center emblem (bolt-ish) -->
<path d="M ${CX + 2} 18 L ${CX - 6} ${CY} L ${CX - 2} ${CY} L ${CX - 4} 44 L ${CX + 6} 28 L ${CX + 2} 28 Z"
      fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1.5" stroke-linejoin="round"/>
<!-- gloss -->
<path d="M 14 16 L 16 38 L 22 36 L 22 16 Z" fill="#FFFFFF" opacity="0.35"/>`,

  // Sword — same as gear weapon-sword but small.
  sword: () => `
<rect x="${CX - 3}" y="6" width="6" height="36" rx="2"
      fill="url(#gk-grad-steel)" stroke="${PALETTE.steel.stroke}" stroke-width="2"/>
<path d="M ${CX} 4 L ${CX - 3} 8 L ${CX + 3} 8 Z"
      fill="url(#gk-grad-steel)" stroke="${PALETTE.steel.stroke}" stroke-width="1.5"/>
<rect x="${CX - 12}" y="42" width="24" height="5" rx="2"
      fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1.5"/>
<rect x="${CX - 3}" y="47" width="6" height="10" rx="1.5"
      fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="1.5"/>
<circle cx="${CX}" cy="58" r="3.5" fill="url(#gk-rgrad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1.5"/>
<rect x="${CX - 1.5}" y="8" width="3" height="32" fill="${PALETTE.white}" opacity="0.45"/>`,

  // Skull — cartoon with eye sockets.
  skull: () => `
<path d="M ${CX} 6
         Q 10 8 10 28
         Q 10 38 14 42
         L 14 50
         L 22 50
         L 22 54
         L 28 54
         L 28 50
         L 36 50
         L 36 54
         L 42 54
         L 42 50
         L 50 50
         L 50 42
         Q 54 38 54 28
         Q 54 8 ${CX} 6 Z"
      fill="url(#gk-grad-cream)" stroke="${PALETTE.ink}" stroke-width="2.5" stroke-linejoin="round"/>
<!-- eye sockets -->
<ellipse cx="22" cy="28" rx="5" ry="6" fill="${PALETTE.ink}"/>
<ellipse cx="42" cy="28" rx="5" ry="6" fill="${PALETTE.ink}"/>
<!-- nose -->
<path d="M ${CX - 3} 36 L ${CX} 40 L ${CX + 3} 36 Z" fill="${PALETTE.ink}"/>
<!-- highlight -->
<ellipse cx="20" cy="14" rx="6" ry="4" fill="#FFFFFF" opacity="0.55"/>`,

  // Bomb — black sphere with fuse spark.
  bomb: () => `
<circle cx="${CX}" cy="${CY + 4}" r="22" fill="url(#gk-rgrad-dark)" stroke="${PALETTE.dark.stroke}" stroke-width="3"/>
<rect x="${CX - 4}" y="8" width="8" height="8" fill="url(#gk-grad-iron)" stroke="${PALETTE.ink}" stroke-width="1.5"/>
<path d="M ${CX + 4} 10 Q ${CX + 12} 4 ${CX + 18} 6"
      fill="none" stroke="${PALETTE.wood.lo}" stroke-width="2.5" stroke-linecap="round"/>
<circle cx="${CX + 20}" cy="4" r="4" fill="${PALETTE.gold.hi}"/>
<circle cx="${CX + 20}" cy="4" r="2" fill="${PALETTE.white}"/>
<ellipse cx="${CX - 8}" cy="${CY - 4}" rx="6" ry="4" fill="${PALETTE.white}" opacity="0.45"/>`,

  // Dice — d6 with pips.
  dice: () => `
<rect x="10" y="10" width="44" height="44" rx="6"
      fill="url(#gk-grad-cream)" stroke="${PALETTE.ink}" stroke-width="2.5"/>
<g fill="${PALETTE.ink}">
  <circle cx="22" cy="22" r="3"/>
  <circle cx="42" cy="22" r="3"/>
  <circle cx="22" cy="${CY}" r="3"/>
  <circle cx="42" cy="${CY}" r="3"/>
  <circle cx="22" cy="42" r="3"/>
  <circle cx="42" cy="42" r="3"/>
</g>
<path d="M 12 12 L 12 30 L 18 30 L 18 12 Z" fill="#FFFFFF" opacity="0.4"/>`,

  // Check — green tick.
  check: () => `
<circle cx="${CX}" cy="${CY}" r="26" fill="url(#gk-rgrad-emerald)" stroke="${PALETTE.emerald.stroke}" stroke-width="3"/>
<path d="M 18 32 L 28 42 L 46 22"
      fill="none" stroke="${PALETTE.white}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
<ellipse cx="22" cy="20" rx="8" ry="4" fill="#FFFFFF" opacity="0.4"/>`,

  // Plus — green plus button.
  plus: () => `
<circle cx="${CX}" cy="${CY}" r="26" fill="url(#gk-rgrad-emerald)" stroke="${PALETTE.emerald.stroke}" stroke-width="3"/>
<rect x="${CX - 12}" y="${CY - 3}" width="24" height="6" rx="2" fill="${PALETTE.white}"/>
<rect x="${CX - 3}" y="${CY - 12}" width="6" height="24" rx="2" fill="${PALETTE.white}"/>
<ellipse cx="22" cy="20" rx="8" ry="4" fill="#FFFFFF" opacity="0.4"/>`,

  // Alert — yellow triangle.
  alert: () => `
<path d="M ${CX} 6
         L 56 54
         L 8 54 Z"
      fill="url(#gk-rgrad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="3" stroke-linejoin="round"/>
<rect x="${CX - 3}" y="20" width="6" height="20" rx="2" fill="${PALETTE.ink}"/>
<circle cx="${CX}" cy="46" r="3.5" fill="${PALETTE.ink}"/>
<path d="M 16 50 L ${CX} 14 L ${CX + 4} 14 L 20 50 Z" fill="#FFFFFF" opacity="0.35"/>`,

  // Camera — body + lens.
  camera: () => `
<rect x="8" y="20" width="48" height="32" rx="4"
      fill="url(#gk-grad-dark)" stroke="${PALETTE.ink}" stroke-width="2.5"/>
<rect x="22" y="14" width="20" height="8" rx="2"
      fill="url(#gk-grad-dark)" stroke="${PALETTE.ink}" stroke-width="2"/>
<circle cx="${CX}" cy="36" r="12" fill="url(#gk-rgrad-steel)" stroke="${PALETTE.iron.stroke}" stroke-width="2.5"/>
<circle cx="${CX}" cy="36" r="6" fill="url(#gk-rgrad-sapphire)" stroke="${PALETTE.sapphire.stroke}" stroke-width="1.5"/>
<ellipse cx="${CX - 3}" cy="33" rx="3" ry="2" fill="${PALETTE.white}" opacity="0.85"/>
<!-- red light -->
<circle cx="48" cy="26" r="2" fill="${PALETTE.ruby.hi}"/>`,

  // Castle — simple silhouette.
  castle: () => `
<g fill="url(#gk-grad-stone)" stroke="${PALETTE.stone.stroke}" stroke-width="2" stroke-linejoin="round">
  <rect x="10" y="22" width="44" height="32" rx="2"/>
  <!-- left tower -->
  <rect x="8"  y="14" width="12" height="42"/>
  <!-- right tower -->
  <rect x="44" y="14" width="12" height="42"/>
  <!-- center tower -->
  <rect x="26" y="6" width="12" height="48"/>
</g>
<!-- crenellations -->
<g fill="url(#gk-grad-stone)" stroke="${PALETTE.stone.stroke}" stroke-width="1.5">
  <rect x="8" y="12" width="4" height="6"/><rect x="14" y="12" width="4" height="6"/>
  <rect x="26" y="4" width="4" height="6"/><rect x="34" y="4" width="4" height="6"/>
  <rect x="44" y="12" width="4" height="6"/><rect x="50" y="12" width="4" height="6"/>
</g>
<!-- door -->
<path d="M 28 56 L 28 42 Q 28 36 ${CX} 36 Q 36 36 36 42 L 36 56 Z"
      fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="2" stroke-linejoin="round"/>
<!-- flag -->
<rect x="${CX - 0.5}" y="0" width="2" height="8" fill="${PALETTE.ink}"/>
<path d="M ${CX + 1} 1 L ${CX + 9} 3 L ${CX + 1} 5 Z" fill="url(#gk-grad-ruby)" stroke="${PALETTE.ruby.stroke}" stroke-width="1"/>`,

  // Chat — speech bubble.
  chat: () => `
<path d="M 8 16 Q 8 8 16 8 L 48 8 Q 56 8 56 16 L 56 38 Q 56 46 48 46 L 28 46 L 18 56 L 20 46 L 16 46 Q 8 46 8 38 Z"
      fill="url(#gk-grad-sapphire)" stroke="${PALETTE.sapphire.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<g fill="${PALETTE.white}">
  <circle cx="22" cy="${CY}" r="3"/>
  <circle cx="${CX}" cy="${CY}" r="3"/>
  <circle cx="42" cy="${CY}" r="3"/>
</g>
<ellipse cx="20" cy="14" rx="6" ry="3" fill="#FFFFFF" opacity="0.5"/>`,

  // Construction — traffic cone.
  construction: () => `
<path d="M ${CX} 6 L 16 54 L 48 54 Z"
      fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<g stroke="${PALETTE.ink}" stroke-width="2" fill="none" opacity="0.7">
  <line x1="22" y1="36" x2="42" y2="36"/>
  <line x1="20" y1="46" x2="44" y2="46"/>
</g>
<rect x="12" y="54" width="40" height="6" rx="2" fill="url(#gk-grad-dark)" stroke="${PALETTE.ink}" stroke-width="2"/>
<path d="M ${CX - 4} 8 L 18 44 L 22 44 Z" fill="#FFFFFF" opacity="0.4"/>`,

  // Droplet — water drop.
  droplet: () => `
<path d="M ${CX} 6
         Q 18 22 16 36
         Q 16 52 ${CX} 56
         Q 48 52 48 36
         Q 46 22 ${CX} 6 Z"
      fill="url(#gk-rgrad-sapphire)" stroke="${PALETTE.sapphire.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<ellipse cx="22" cy="26" rx="4" ry="8" fill="${PALETTE.white}" opacity="0.55"/>`,

  // ID — id card.
  id: () => `
<rect x="6" y="14" width="52" height="36" rx="4"
      fill="url(#gk-grad-cream)" stroke="${PALETTE.ink}" stroke-width="2.5"/>
<rect x="6" y="14" width="52" height="10" rx="4" fill="url(#gk-grad-sapphire)" stroke="${PALETTE.sapphire.stroke}" stroke-width="1.5"/>
<circle cx="20" cy="36" r="7" fill="url(#gk-rgrad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="1.5"/>
<g stroke="${PALETTE.ink}" stroke-width="2" stroke-linecap="round" opacity="0.55">
  <line x1="32" y1="32" x2="50" y2="32"/>
  <line x1="32" y1="38" x2="46" y2="38"/>
  <line x1="32" y1="44" x2="48" y2="44"/>
</g>
<path d="M 8 16 L 8 22 L 56 22 L 56 18 Z" fill="#FFFFFF" opacity="0.35"/>`,

  // Music — eighth note.
  music: () => `
<rect x="38" y="8" width="4" height="38" fill="url(#gk-grad-amethyst)" stroke="${PALETTE.amethyst.stroke}" stroke-width="1.5"/>
<rect x="22" y="14" width="4" height="38" fill="url(#gk-grad-amethyst)" stroke="${PALETTE.amethyst.stroke}" stroke-width="1.5"/>
<path d="M 22 16 Q 30 8 42 12 L 42 18 Q 30 14 22 22 Z"
      fill="url(#gk-grad-amethyst)" stroke="${PALETTE.amethyst.stroke}" stroke-width="2" stroke-linejoin="round"/>
<ellipse cx="18" cy="50" rx="8" ry="6" fill="url(#gk-rgrad-amethyst)" stroke="${PALETTE.amethyst.stroke}" stroke-width="2"/>
<ellipse cx="34" cy="44" rx="8" ry="6" fill="url(#gk-rgrad-amethyst)" stroke="${PALETTE.amethyst.stroke}" stroke-width="2"/>`,

  // Paper — document.
  paper: () => `
<path d="M 12 6 L 42 6 L 54 18 L 54 58 L 12 58 Z"
      fill="url(#gk-grad-cream)" stroke="${PALETTE.ink}" stroke-width="2.5" stroke-linejoin="round"/>
<path d="M 42 6 L 42 18 L 54 18 Z" fill="url(#gk-grad-stone)" stroke="${PALETTE.ink}" stroke-width="2" stroke-linejoin="round"/>
<g stroke="${PALETTE.dark.base}" stroke-width="2" stroke-linecap="round" opacity="0.6">
  <line x1="20" y1="28" x2="46" y2="28"/>
  <line x1="20" y1="36" x2="46" y2="36"/>
  <line x1="20" y1="44" x2="42" y2="44"/>
</g>
<path d="M 14 8 L 14 56 L 22 56 L 22 8 Z" fill="#FFFFFF" opacity="0.3"/>`,

  // Rock — for RPS.
  rock: () => `
<path d="M 12 50
         Q 8 36 14 28
         Q 18 14 ${CX} 12
         Q 46 12 50 22
         Q 58 32 54 46
         Q 50 56 ${CX} 56
         Q 18 56 12 50 Z"
      fill="url(#gk-rgrad-stone)" stroke="${PALETTE.stone.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<path d="M 18 26 Q 20 18 28 18 Q 24 24 22 30 Z" fill="${PALETTE.white}" opacity="0.45"/>
<path d="M 36 36 L 42 32 L 44 38 L 38 40 Z" fill="${PALETTE.stone.lo}" opacity="0.55"/>`,

  // Scissors — RPS.
  scissors: () => `
<g stroke="${PALETTE.iron.stroke}" stroke-width="2.5" fill="url(#gk-grad-iron)">
  <path d="M ${CX} ${CY} L 50 8 L 56 14 L ${CX + 4} 34 Z" stroke-linejoin="round"/>
  <path d="M ${CX} ${CY} L 14 8 L 8 14 L ${CX - 4} 34 Z" stroke-linejoin="round"/>
</g>
<circle cx="18" cy="46" r="9" fill="none" stroke="${PALETTE.gold.hi}" stroke-width="4"/>
<circle cx="46" cy="46" r="9" fill="none" stroke="${PALETTE.gold.hi}" stroke-width="4"/>
<circle cx="${CX}" cy="${CY}" r="3" fill="${PALETTE.ink}"/>`,

  // Swirl — spiral.
  swirl: () => `
<path d="M ${CX} ${CY}
         m -2 0
         a 2 2 0 1 1 4 0
         a 8 8 0 1 1 -8 0
         a 14 14 0 1 1 16 0
         a 20 20 0 1 1 -20 0"
      fill="none" stroke="url(#gk-grad-amethyst)" stroke-width="5" stroke-linecap="round"/>
<path d="M ${CX} ${CY}
         m -2 0
         a 2 2 0 1 1 4 0
         a 8 8 0 1 1 -8 0
         a 14 14 0 1 1 16 0
         a 20 20 0 1 1 -20 0"
      fill="none" stroke="${PALETTE.amethyst.stroke}" stroke-width="2" stroke-linecap="round"/>`,

  // Target — bullseye.
  target: () => `
<circle cx="${CX}" cy="${CY}" r="26" fill="url(#gk-grad-cream)" stroke="${PALETTE.ink}" stroke-width="2.5"/>
<circle cx="${CX}" cy="${CY}" r="20" fill="url(#gk-grad-ruby)" stroke="${PALETTE.ruby.stroke}" stroke-width="2"/>
<circle cx="${CX}" cy="${CY}" r="14" fill="url(#gk-grad-cream)" stroke="${PALETTE.ink}" stroke-width="2"/>
<circle cx="${CX}" cy="${CY}" r="8" fill="url(#gk-grad-ruby)" stroke="${PALETTE.ruby.stroke}" stroke-width="2"/>
<circle cx="${CX}" cy="${CY}" r="3" fill="${PALETTE.ink}"/>
<ellipse cx="${CX - 8}" cy="${CY - 12}" rx="5" ry="3" fill="${PALETTE.white}" opacity="0.5"/>`,

  // Train — engine.
  train: () => `
<rect x="8" y="20" width="40" height="28" rx="3"
      fill="url(#gk-grad-ruby)" stroke="${PALETTE.ruby.stroke}" stroke-width="2.5"/>
<rect x="34" y="10" width="18" height="14" rx="2"
      fill="url(#gk-grad-ruby)" stroke="${PALETTE.ruby.stroke}" stroke-width="2.5"/>
<rect x="14" y="26" width="8" height="8" rx="1" fill="url(#gk-grad-sapphire)" stroke="${PALETTE.sapphire.stroke}" stroke-width="1.5"/>
<!-- chimney -->
<rect x="48" y="4" width="8" height="8" fill="url(#gk-grad-dark)" stroke="${PALETTE.ink}" stroke-width="1.5"/>
<!-- wheels -->
<circle cx="18" cy="52" r="6" fill="url(#gk-rgrad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="2"/>
<circle cx="38" cy="52" r="6" fill="url(#gk-rgrad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="2"/>
<!-- gloss -->
<rect x="10" y="22" width="6" height="22" fill="#FFFFFF" opacity="0.35"/>`,

  // Wave — water wave.
  wave: () => `
<path d="M 6 36
         Q 16 22 26 36
         Q 36 50 46 36
         Q 56 22 60 30
         L 60 56 L 6 56 Z"
      fill="url(#gk-grad-sapphire)" stroke="${PALETTE.sapphire.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<path d="M 6 36 Q 16 22 26 36 Q 36 50 46 36 Q 56 22 60 30"
      fill="none" stroke="${PALETTE.sky.hi}" stroke-width="3" opacity="0.85"/>
<path d="M 6 36 Q 14 28 20 32 L 22 38 L 12 42 Z" fill="${PALETTE.white}" opacity="0.45"/>`,
};

// ── Bake driver ─────────────────────────────────────────────────

let count = 0;
for (const [name, fn] of Object.entries(ICONS)) {
  const svg = svgWrapper({
    width: W, height: H,
    title: `${name} (glossy)`,
    desc: 'Loadout overlay UI icon, glossy style. Source: tools/build-ui-icons-glossy.mjs',
    body: fn(),
  });
  const out = join(OUT, `${name}.png`);
  await bakeFile(svg, out, { width: W, height: H });
  count++;
  console.log(`  ${name}.png`);
}
console.log(`\n✓ baked ${count} glossy UI icons → ${OUT}`);
