// K4b, Family-clone redesign for the 23 buildings that previously
// shared archetype shapes. Each kind now has a genuinely distinct
// silhouette + structural motif, not just a recoloured base.
//
// Replaces these L1 SVGs in aquilo-gg/sprites/clash-v2/glossy/
// buildings/ (the K3 per-level overlay then regenerates L2..L10
// from the new L1 sources):
//
//   Collectors (5):
//     sawmill, riverside watermill with waterwheel + log stack
//     quarry, open-cut pit with stacked rocks + pickaxe
//     forge, open-air smithy: anvil + bellows + flame chimney
//     mint, coin press building with stacked coins
//     workshop, gear-rack workshop with tool wall + workbench
//
//   Vaults (4):
//     lumberVault, log silo (cylindrical stack of stacked logs)
//     stoneVault, slate bunker (low blocky stone vault with iron door)
//     ironVault, riveted iron safe (cube with massive lock dial)
//     goldVault, gilded treasury (vault door with star + columns)
//
//   Defense towers (9):
//     mortar, squat siege bunker (wide low body, big bowl on top)
//     mageTower, slim wizard spire (twisted purple column, glowing crystal)
//     infernoTower, spiked obsidian column with flame jets at sides
//     bombTower, round powder keg tower with iron bands + lit fuse
//     heavyCannon, wheeled siege cannon battlement (low platform)
//     voltaicCoil, open lattice scaffold + tesla ball at the top
//     skyMine, narrow pylon with a spiked mine hanging from a boom
//     skywardBow, wooden ballista platform with crossed beams
//     eagleEye, slender observation post with rotating spyglass
//
//   Floor traps (5):
//     trap, wooden pit trap (cross-hatched plank lid)
//     infernoTrap, flame-vent grate (brass slits + flame tongues)
//     springTrap, coiled-spring pad (visible spring under a plate)
//     staticTrap, copper-coil mat (concentric rings)
//     caltrops, scatter of caltrops on grass (no plate)
//
// Run: node tools/build-clash-unique-buildings.mjs

import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  PALETTE, contactShadow, svgWrapper,
} from './glossy-art-kit.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT  = join(ROOT, 'aquilo-gg/sprites/clash-v2/glossy/buildings');
mkdirSync(OUT, { recursive: true });

const W = 256, H = 256;
const GROUND_Y = 224;
const SHADOW = contactShadow({ cx: W/2, cy: GROUND_Y + 8, rx: 92, ry: 14 });

// ── Helpers ──────────────────────────────────────────────────

function inkedRect({ x, y, w, h, r = 4, gradient, stroke, sw = 3 }) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" ry="${r}"
    fill="url(#${gradient})" stroke="${stroke}" stroke-width="${sw}"/>`;
}

function glossPath(d, opacity = 0.55) {
  return `<path d="${d}" fill="url(#gk-gloss)" opacity="${opacity}" pointer-events="none"/>`;
}

// ── Collectors ────────────────────────────────────────────────

function sawmill() {
  // Side-on watermill: small hut on the right + big waterwheel
  // on the left, log pile in front.
  return `
${SHADOW}
<!-- log pile (front) -->
<g fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="2.5">
  <ellipse cx="60" cy="${GROUND_Y - 10}" rx="20" ry="8"/>
  <ellipse cx="76" cy="${GROUND_Y - 22}" rx="20" ry="8"/>
  <ellipse cx="58" cy="${GROUND_Y - 34}" rx="20" ry="8"/>
</g>
<g stroke="${PALETTE.wood.stroke}" stroke-width="1.2" fill="${PALETTE.wood.lo}">
  <circle cx="60" cy="${GROUND_Y - 10}" r="4"/>
  <circle cx="76" cy="${GROUND_Y - 22}" r="4"/>
  <circle cx="58" cy="${GROUND_Y - 34}" r="4"/>
</g>
<!-- mill hut body (right side) -->
${inkedRect({ x: 130, y: 130, w: 90, h: 90, r: 6, gradient: 'gk-grad-wood', stroke: PALETTE.wood.stroke, sw: 4 })}
<!-- pitched red roof -->
<path d="M 122 134 L 175 88 L 228 134 L 220 142 L 130 142 Z"
      fill="url(#gk-grad-brick)" stroke="${PALETTE.brick.stroke}" stroke-width="4" stroke-linejoin="round"/>
${glossPath(`M 128 134 L 172 92 L 174 100 L 134 142 Z`, 0.5)}
<!-- mill door -->
<rect x="160" y="170" width="30" height="50" rx="3" fill="${PALETTE.wood.lo}" stroke="${PALETTE.wood.stroke}" stroke-width="2.5"/>
<circle cx="184" cy="195" r="2" fill="${PALETTE.gold.hi}"/>
<!-- waterwheel (big!) -->
<g transform="translate(76, 160)">
  <circle cx="0" cy="0" r="48" fill="url(#gk-rgrad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="4"/>
  <circle cx="0" cy="0" r="34" fill="none" stroke="${PALETTE.wood.stroke}" stroke-width="3" opacity="0.7"/>
  <!-- spokes -->
  ${[0,1,2,3,4,5,6,7].map(i => {
    const a = (i * Math.PI / 4).toFixed(3);
    const x1 = (Math.cos(a) * 12).toFixed(1);
    const y1 = (Math.sin(a) * 12).toFixed(1);
    const x2 = (Math.cos(a) * 46).toFixed(1);
    const y2 = (Math.sin(a) * 46).toFixed(1);
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${PALETTE.wood.stroke}" stroke-width="3"/>`;
  }).join('')}
  <!-- paddles -->
  ${[0,1,2,3,4,5,6,7].map(i => {
    const a = (i * Math.PI / 4 + Math.PI/8).toFixed(3);
    const cx = (Math.cos(a) * 44).toFixed(1);
    const cy = (Math.sin(a) * 44).toFixed(1);
    const rot = (i * 45 + 22).toFixed(0);
    return `<rect x="${(cx - 5).toFixed(1)}" y="${(cy - 3).toFixed(1)}" width="10" height="6"
                  transform="rotate(${rot} ${cx} ${cy})"
                  fill="${PALETTE.wood.base}" stroke="${PALETTE.wood.stroke}" stroke-width="1.5"/>`;
  }).join('')}
  <circle cx="0" cy="0" r="6" fill="${PALETTE.iron.base}" stroke="${PALETTE.ink}" stroke-width="2"/>
</g>
<!-- water splash at base of wheel -->
<ellipse cx="76" cy="${GROUND_Y - 4}" rx="36" ry="6" fill="url(#gk-grad-sky)" opacity="0.7"/>
`;
}

function quarry() {
  // Open pit: dirt mound at back, stacked stone blocks, pickaxe leaning.
  return `
${SHADOW}
<!-- back dirt mound -->
<path d="M 32 ${GROUND_Y - 8} Q 128 110 224 ${GROUND_Y - 8} L 224 ${GROUND_Y} L 32 ${GROUND_Y} Z"
      fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="3" stroke-linejoin="round"/>
<!-- pit floor (darker) -->
<ellipse cx="128" cy="${GROUND_Y - 20}" rx="80" ry="20" fill="${PALETTE.wood.lo}" opacity="0.55"/>
<!-- stacked stone blocks (foreground left + middle) -->
<g>
  ${[
    {x: 60, y: 178, w: 38, h: 30},
    {x: 100, y: 178, w: 36, h: 30},
    {x: 70, y: 148, w: 38, h: 30},
    {x: 138, y: 168, w: 40, h: 40},
    {x: 110, y: 124, w: 40, h: 26},
  ].map(b => `
    ${inkedRect({ x: b.x, y: b.y, w: b.w, h: b.h, r: 3, gradient: 'gk-rgrad-stone', stroke: PALETTE.stone.stroke, sw: 3 })}
    ${glossPath(`M ${b.x + 2} ${b.y + 2} L ${b.x + 8} ${b.y + 2} L ${b.x + 8} ${b.y + 10} L ${b.x + 2} ${b.y + b.h - 4} Z`, 0.45)}
  `).join('')}
</g>
<!-- pickaxe leaning on right side -->
<g transform="translate(190, 130) rotate(20)">
  <rect x="-3" y="0" width="6" height="90" rx="2" fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="2"/>
  <path d="M -18 0 L 18 0 L 22 -6 L 12 -10 L 6 -2 L -6 -2 L -12 -10 L -22 -6 Z"
        fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
</g>
<!-- gold accent rivets on the corner block -->
<circle cx="148" cy="174" r="3" fill="url(#gk-rgrad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1.5"/>
<circle cx="170" cy="174" r="3" fill="url(#gk-rgrad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1.5"/>
`;
}

function forge() {
  // Open-air smithy: stone anvil + iron bellows + flame chimney + tools.
  return `
${SHADOW}
<!-- back chimney/furnace stack -->
${inkedRect({ x: 160, y: 100, w: 60, h: 120, r: 6, gradient: 'gk-grad-stone', stroke: PALETTE.stone.stroke, sw: 4 })}
<rect x="158" y="92" width="64" height="14" rx="3" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="3"/>
<!-- furnace mouth glow -->
<rect x="170" y="138" width="40" height="32" rx="3" fill="url(#gk-grad-ruby)" stroke="${PALETTE.ink}" stroke-width="2.5"/>
<path d="M 190 168 Q 180 158 184 144 Q 190 156 196 148 Q 200 162 190 168 Z"
      fill="${PALETTE.gold.hi}" opacity="0.95"/>
<!-- smoke wisps from chimney -->
<g fill="${PALETTE.cream.hi}" opacity="0.65">
  <ellipse cx="195" cy="80" rx="14" ry="7"/>
  <ellipse cx="205" cy="64" rx="10" ry="5"/>
  <ellipse cx="190" cy="50" rx="8" ry="4"/>
</g>
<!-- big anvil (front-left) -->
<g transform="translate(76, 188)">
  <!-- wood block base -->
  <rect x="-26" y="20" width="52" height="14" rx="3" fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="3"/>
  <!-- anvil top -->
  <path d="M -30 0 L 30 0 L 28 8 L 22 8 L 22 16 L -22 16 L -22 8 L -28 8 Z"
        fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="3" stroke-linejoin="round"/>
  <!-- pointed horn on the left -->
  <path d="M -30 0 L -44 -4 L -30 4 Z" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
  <!-- gloss highlight -->
  ${glossPath(`M -26 -1 L 26 -1 L 24 4 L -22 4 Z`, 0.55)}
</g>
<!-- hammer on the anvil -->
<g transform="translate(60, 172) rotate(-15)">
  <rect x="-2" y="0" width="4" height="20" fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="1.5"/>
  <rect x="-10" y="-8" width="20" height="10" rx="2" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="2"/>
</g>
<!-- glowing red-hot sword being forged on the anvil -->
<g transform="translate(98, 184)">
  <path d="M 0 0 L 16 -2 L 18 0 L 16 2 L 0 4 Z" fill="url(#gk-grad-ruby)" stroke="${PALETTE.ruby.stroke}" stroke-width="1.5"/>
  <rect x="-8" y="-1" width="10" height="6" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="1.2"/>
</g>
`;
}

function mint() {
  // Coin press building: small temple-like structure with coin stacks
  // out front and a press wheel on top.
  return `
${SHADOW}
<!-- main building body (creamy stone) -->
${inkedRect({ x: 60, y: 132, w: 136, h: 88, r: 6, gradient: 'gk-grad-cream', stroke: PALETTE.cream.stroke, sw: 4 })}
<!-- gold-trimmed roof entablature -->
<rect x="52" y="124" width="152" height="14" rx="3"
      fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="3"/>
<!-- 4 cream columns -->
<g fill="url(#gk-grad-cream)" stroke="${PALETTE.cream.stroke}" stroke-width="2.5">
  <rect x="68" y="140" width="14" height="80" rx="2"/>
  <rect x="100" y="140" width="14" height="80" rx="2"/>
  <rect x="142" y="140" width="14" height="80" rx="2"/>
  <rect x="174" y="140" width="14" height="80" rx="2"/>
</g>
<!-- column-capital gold -->
<g fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1.5">
  <rect x="65" y="136" width="20" height="6" rx="1"/>
  <rect x="97" y="136" width="20" height="6" rx="1"/>
  <rect x="139" y="136" width="20" height="6" rx="1"/>
  <rect x="171" y="136" width="20" height="6" rx="1"/>
</g>
<!-- press wheel on the roof -->
<circle cx="128" cy="106" r="20" fill="url(#gk-rgrad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="3.5"/>
<g stroke="${PALETTE.iron.stroke}" stroke-width="2">
  ${[0,1,2,3,4,5,6,7].map(i => {
    const a = (i * Math.PI / 4).toFixed(3);
    const x = (Math.cos(a) * 18).toFixed(1);
    const y = (Math.sin(a) * 18).toFixed(1);
    return `<line x1="${(x*0.4).toFixed(1)}" y1="${(y*0.4 + 106).toFixed(1) - 106 + 106}" x2="${x}" y2="${(106 + parseFloat(y)).toFixed(1)}" transform="translate(128, 0)"/>`;
  }).join('')}
</g>
<circle cx="128" cy="106" r="6" fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="2"/>
<rect x="124" y="84" width="8" height="22" fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="2"/>
<!-- coin stacks out front -->
<g transform="translate(96, ${GROUND_Y - 12})">
  ${[0,1,2,3,4,5].map(i => `
    <ellipse cx="0" cy="${-i * 4}" rx="14" ry="3.5" fill="url(#gk-rgrad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1.5"/>
  `).join('')}
</g>
<g transform="translate(160, ${GROUND_Y - 8})">
  ${[0,1,2,3].map(i => `
    <ellipse cx="0" cy="${-i * 4}" rx="12" ry="3" fill="url(#gk-rgrad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1.5"/>
  `).join('')}
</g>
`;
}

function workshop() {
  // Workbench with tool wall behind, gear racks. Wide squat.
  return `
${SHADOW}
<!-- back wall (tool wall) -->
${inkedRect({ x: 44, y: 96, w: 168, h: 100, r: 6, gradient: 'gk-grad-thatch', stroke: PALETTE.thatch.stroke, sw: 4 })}
<!-- vertical wall planks -->
<g stroke="${PALETTE.thatch.stroke}" stroke-width="1.5" opacity="0.6">
  <line x1="74" y1="100" x2="74" y2="192"/>
  <line x1="104" y1="100" x2="104" y2="192"/>
  <line x1="134" y1="100" x2="134" y2="192"/>
  <line x1="164" y1="100" x2="164" y2="192"/>
  <line x1="184" y1="100" x2="184" y2="192"/>
</g>
<!-- tools hanging on wall: hammer, wrench, saw -->
<g transform="translate(80, 130)">
  <rect x="-2" y="0" width="4" height="36" fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="1.2"/>
  <rect x="-10" y="-8" width="20" height="10" rx="2" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="2"/>
</g>
<g transform="translate(118, 132) rotate(8)">
  <rect x="-3" y="-22" width="6" height="42" rx="2" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="1.8"/>
  <path d="M -8 -22 L 8 -22 L 6 -28 L -6 -28 Z" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="2"/>
  <path d="M -7 20 L 7 20 L 5 26 L -5 26 Z" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="2"/>
</g>
<g transform="translate(160, 138)">
  <rect x="-22" y="-3" width="44" height="6" fill="url(#gk-grad-steel)" stroke="${PALETTE.steel.stroke}" stroke-width="1.5"/>
  <g stroke="${PALETTE.ink}" stroke-width="0.7">
    <line x1="-20" y1="3" x2="-20" y2="6"/>
    <line x1="-14" y1="3" x2="-14" y2="6"/>
    <line x1="-8" y1="3" x2="-8" y2="6"/>
    <line x1="-2" y1="3" x2="-2" y2="6"/>
    <line x1="4" y1="3" x2="4" y2="6"/>
    <line x1="10" y1="3" x2="10" y2="6"/>
    <line x1="16" y1="3" x2="16" y2="6"/>
  </g>
  <rect x="-26" y="-1" width="6" height="6" fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="1.2"/>
</g>
<!-- workbench (in front) -->
${inkedRect({ x: 36, y: 184, w: 184, h: 22, r: 3, gradient: 'gk-grad-wood', stroke: PALETTE.wood.stroke, sw: 3.5 })}
<rect x="44" y="206" width="6" height="16" fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="2"/>
<rect x="206" y="206" width="6" height="16" fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="2"/>
<!-- gear on bench -->
<g transform="translate(108, 184)">
  <circle cx="0" cy="0" r="11" fill="url(#gk-rgrad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="2.5"/>
  ${[0,1,2,3,4,5,6,7].map(i => {
    const a = (i * Math.PI / 4).toFixed(3);
    const cx = (Math.cos(a) * 13).toFixed(1);
    const cy = (Math.sin(a) * 13).toFixed(1);
    return `<rect x="${(cx - 2).toFixed(1)}" y="${(cy - 2).toFixed(1)}" width="4" height="4" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="1.2"/>`;
  }).join('')}
  <circle cx="0" cy="0" r="3" fill="${PALETTE.ink}"/>
</g>
`;
}

// ── Vaults ────────────────────────────────────────────────────

function lumberVault() {
  // Stacked log silo, circular stack of cut logs.
  return `
${SHADOW}
<!-- back support posts -->
<rect x="48" y="90" width="10" height="130" fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="2.5"/>
<rect x="198" y="90" width="10" height="130" fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="2.5"/>
<!-- horizontal log cradle bottom + top -->
<rect x="36" y="${GROUND_Y - 8}" width="184" height="16" rx="3" fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="3"/>
<rect x="44" y="84" width="168" height="12" rx="3" fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="3"/>
<!-- log stack (rows of cut-end circles) -->
<g stroke="${PALETTE.wood.stroke}" stroke-width="2">
  ${(() => {
    const rows = [
      { y: 196, count: 7 },
      { y: 168, count: 7, offset: 16 },
      { y: 140, count: 7 },
      { y: 112, count: 7, offset: 16 },
    ];
    return rows.map(r => {
      const startX = 70 + (r.offset || 0);
      return Array.from({length: r.count}, (_, i) => {
        const x = startX + i * 16;
        return `<circle cx="${x}" cy="${r.y}" r="11" fill="url(#gk-rgrad-wood)"/>
                <circle cx="${x}" cy="${r.y}" r="4" fill="${PALETTE.wood.lo}"/>
                <circle cx="${x - 1}" cy="${r.y - 1}" r="2" fill="${PALETTE.wood.hi}" opacity="0.55"/>`;
      }).join('');
    }).join('');
  })()}
</g>
<!-- iron banding strap (foreground) -->
<rect x="40" y="158" width="176" height="8" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="2.5"/>
<!-- gold padlock on the band -->
<rect x="118" y="148" width="20" height="28" rx="3" fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="2.5"/>
<circle cx="128" cy="158" r="3" fill="${PALETTE.ink}"/>
<path d="M 122 148 Q 122 138 128 138 Q 134 138 134 148"
      fill="none" stroke="${PALETTE.iron.stroke}" stroke-width="3"/>
`;
}

function stoneVault() {
  // Low slate bunker, wide squat blocky vault with massive iron door.
  return `
${SHADOW}
<!-- bunker body (very wide + low) -->
<path d="M 32 ${GROUND_Y - 4}
         L 32 120
         Q 32 100 64 96
         L 192 96
         Q 224 100 224 120
         L 224 ${GROUND_Y - 4} Z"
      fill="url(#gk-rgrad-stone)" stroke="${PALETTE.stone.stroke}" stroke-width="4" stroke-linejoin="round"/>
<!-- stone block courses (visible mortar) -->
<g stroke="${PALETTE.stone.stroke}" stroke-width="1.5" opacity="0.55">
  <line x1="38" y1="140" x2="218" y2="140"/>
  <line x1="38" y1="170" x2="218" y2="170"/>
  <line x1="38" y1="200" x2="218" y2="200"/>
  <line x1="84" y1="140" x2="84" y2="170"/>
  <line x1="128" y1="140" x2="128" y2="170"/>
  <line x1="172" y1="140" x2="172" y2="170"/>
  <line x1="60" y1="170" x2="60" y2="200"/>
  <line x1="104" y1="170" x2="104" y2="200"/>
  <line x1="148" y1="170" x2="148" y2="200"/>
  <line x1="192" y1="170" x2="192" y2="200"/>
</g>
<!-- iron vault door (arched, centred) -->
<path d="M 96 ${GROUND_Y - 4} L 96 150 Q 96 124 128 124 Q 160 124 160 150 L 160 ${GROUND_Y - 4} Z"
      fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="4" stroke-linejoin="round"/>
<!-- iron rivets around door -->
<g fill="url(#gk-rgrad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1.5">
  <circle cx="100" cy="160" r="3"/>
  <circle cx="156" cy="160" r="3"/>
  <circle cx="100" cy="190" r="3"/>
  <circle cx="156" cy="190" r="3"/>
  <circle cx="100" cy="216" r="3"/>
  <circle cx="156" cy="216" r="3"/>
</g>
<!-- door wheel + handle -->
<circle cx="128" cy="180" r="14" fill="url(#gk-rgrad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="3"/>
<g stroke="${PALETTE.iron.stroke}" stroke-width="3">
  <line x1="128" y1="166" x2="128" y2="194"/>
  <line x1="114" y1="180" x2="142" y2="180"/>
  <line x1="118" y1="170" x2="138" y2="190"/>
  <line x1="118" y1="190" x2="138" y2="170"/>
</g>
<circle cx="128" cy="180" r="4" fill="${PALETTE.gold.hi}" stroke="${PALETTE.ink}" stroke-width="1.5"/>
`;
}

function ironVault() {
  // Riveted iron safe, a perfect cube with a big lock dial.
  return `
${SHADOW}
<!-- cube body -->
${inkedRect({ x: 56, y: 92, w: 144, h: 132, r: 8, gradient: 'gk-rgrad-iron', stroke: PALETTE.iron.stroke, sw: 5 })}
<!-- corner rivet panel -->
<g fill="url(#gk-rgrad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1.5">
  ${[
    [68, 104], [200 - 12, 104], [68, 220 - 8], [200 - 12, 220 - 8],
    [86, 104], [200 - 30, 104], [86, 220 - 8], [200 - 30, 220 - 8],
    [104, 104], [200 - 48, 104], [104, 220 - 8], [200 - 48, 220 - 8],
    [68, 122], [200 - 12, 122], [68, 184], [200 - 12, 184],
    [68, 140], [200 - 12, 140], [68, 166], [200 - 12, 166],
  ].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3"/>`).join('')}
</g>
<!-- inner safe panel -->
${inkedRect({ x: 86, y: 116, w: 84, h: 92, r: 4, gradient: 'gk-grad-iron', stroke: PALETTE.iron.stroke, sw: 3 })}
<!-- big circular lock dial -->
<circle cx="128" cy="162" r="32" fill="url(#gk-rgrad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="4"/>
<circle cx="128" cy="162" r="26" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="2"/>
<!-- dial tick marks -->
<g stroke="${PALETTE.gold.hi}" stroke-width="1.5">
  ${[0,1,2,3,4,5,6,7,8,9,10,11].map(i => {
    const a = (i * Math.PI / 6 - Math.PI / 2).toFixed(3);
    const x1 = (128 + Math.cos(a) * 22).toFixed(1);
    const y1 = (162 + Math.sin(a) * 22).toFixed(1);
    const x2 = (128 + Math.cos(a) * 26).toFixed(1);
    const y2 = (162 + Math.sin(a) * 26).toFixed(1);
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
  }).join('')}
</g>
<!-- dial pointer + central nub -->
<rect x="126" y="138" width="4" height="22" rx="1" fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1.2"/>
<circle cx="128" cy="162" r="6" fill="url(#gk-rgrad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="2"/>
<circle cx="128" cy="162" r="2" fill="${PALETTE.ink}"/>
<!-- gloss on cube -->
${glossPath(`M 60 96 L 68 96 L 68 200 L 64 220 L 60 220 Z`, 0.4)}
`;
}

function goldVault() {
  // Gilded treasury, gold vault door with star + columns, gold piles in front.
  return `
${SHADOW}
<!-- back wall (creamy stone) -->
${inkedRect({ x: 44, y: 96, w: 168, h: 124, r: 6, gradient: 'gk-grad-cream', stroke: PALETTE.cream.stroke, sw: 4 })}
<!-- side columns (gold) -->
<g fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="2.5">
  <rect x="48" y="100" width="16" height="118" rx="2"/>
  <rect x="192" y="100" width="16" height="118" rx="2"/>
</g>
<!-- column caps -->
<rect x="44" y="96" width="24" height="10" rx="2" fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="2"/>
<rect x="188" y="96" width="24" height="10" rx="2" fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="2"/>
<!-- ornate gold pediment at top -->
<path d="M 44 96 L 128 70 L 212 96 Z"
      fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="3.5" stroke-linejoin="round"/>
${glossPath(`M 48 94 L 124 76 L 126 80 L 52 96 Z`, 0.5)}
<!-- vault door (gilded round arch) -->
<path d="M 80 ${GROUND_Y - 4} L 80 150 Q 80 120 128 120 Q 176 120 176 150 L 176 ${GROUND_Y - 4} Z"
      fill="url(#gk-rgrad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="4" stroke-linejoin="round"/>
<!-- door star emblem (centre) -->
<g transform="translate(128, 168)">
  <path d="M 0 -20 L 6 -6 L 20 -3 L 9 6 L 12 20 L 0 12 L -12 20 L -9 6 L -20 -3 L -6 -6 Z"
        fill="url(#gk-grad-cream)" stroke="${PALETTE.gold.stroke}" stroke-width="2" stroke-linejoin="round"/>
  <circle cx="0" cy="0" r="5" fill="url(#gk-rgrad-ruby)" stroke="${PALETTE.ruby.stroke}" stroke-width="1.5"/>
</g>
<!-- gold coin piles in front -->
<g transform="translate(60, ${GROUND_Y - 12})">
  ${[0,1,2,3,4].map(i => `
    <ellipse cx="0" cy="${-i * 3}" rx="10" ry="3" fill="url(#gk-rgrad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1.5"/>
  `).join('')}
</g>
<g transform="translate(196, ${GROUND_Y - 10})">
  ${[0,1,2,3].map(i => `
    <ellipse cx="0" cy="${-i * 3}" rx="9" ry="3" fill="url(#gk-rgrad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1.5"/>
  `).join('')}
</g>
`;
}

// ── Defense towers ───────────────────────────────────────────

function mortar() {
  // Squat wide siege bunker, broad low body with a huge bowl on top.
  return `
${SHADOW}
<!-- wide platform -->
${inkedRect({ x: 36, y: 168, w: 184, h: 56, r: 8, gradient: 'gk-grad-stone', stroke: PALETTE.stone.stroke, sw: 4 })}
<!-- iron bands around the platform -->
<rect x="30" y="172" width="196" height="8" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="2.5"/>
<rect x="30" y="208" width="196" height="8" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="2.5"/>
<!-- ammo pile (shells, beside) -->
<g fill="url(#gk-rgrad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="2">
  <circle cx="60" cy="200" r="9"/>
  <circle cx="78" cy="200" r="9"/>
  <circle cx="68" cy="184" r="9"/>
</g>
<!-- huge mortar bowl on top -->
<ellipse cx="148" cy="160" rx="58" ry="20" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="4"/>
<path d="M 90 158 L 96 110 L 200 110 L 206 158 Z"
      fill="url(#gk-rgrad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="4" stroke-linejoin="round"/>
<!-- gold rim -->
<ellipse cx="148" cy="110" rx="52" ry="8" fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="3"/>
<!-- shell loaded inside -->
<circle cx="148" cy="106" r="16" fill="url(#gk-rgrad-iron)" stroke="${PALETTE.ink}" stroke-width="2.5"/>
<rect x="144" y="76" width="8" height="14" fill="url(#gk-grad-gold)" stroke="${PALETTE.ink}" stroke-width="1.2"/>
<path d="M 148 80 Q 154 70 160 64" fill="none" stroke="${PALETTE.ruby.hi}" stroke-width="2" stroke-linecap="round"/>
<circle cx="162" cy="62" r="3" fill="${PALETTE.gold.hi}"/>
`;
}

function mageTower() {
  // Slim twisted wizard spire with a glowing crystal at the top.
  return `
${SHADOW}
<!-- base ring -->
<ellipse cx="128" cy="${GROUND_Y - 6}" rx="56" ry="14" fill="url(#gk-rgrad-amethyst)" stroke="${PALETTE.amethyst.stroke}" stroke-width="4"/>
<!-- slim twisted spire (use a curved path that swerves slightly) -->
<path d="M 110 218
         Q 100 180 116 150
         Q 132 120 110 88
         Q 100 60 128 36
         Q 156 60 146 88
         Q 124 120 140 150
         Q 156 180 146 218 Z"
      fill="url(#gk-grad-amethyst)" stroke="${PALETTE.amethyst.stroke}" stroke-width="4" stroke-linejoin="round"/>
<!-- spiral ridge highlight -->
<path d="M 116 220 Q 108 180 122 150 Q 138 120 118 90 Q 110 64 130 42"
      fill="none" stroke="${PALETTE.amethyst.hi}" stroke-width="3" opacity="0.6" stroke-linecap="round"/>
<!-- gold trim bands -->
<rect x="110" y="190" width="36" height="6" rx="2" fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1.5"/>
<rect x="114" y="120" width="28" height="5" rx="2" fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1.5"/>
<!-- crown of crystal spikes at the top -->
<g fill="url(#gk-rgrad-amethyst)" stroke="${PALETTE.amethyst.stroke}" stroke-width="2.5" stroke-linejoin="round">
  <path d="M 122 38 L 116 24 L 124 28 Z"/>
  <path d="M 134 38 L 140 24 L 132 28 Z"/>
</g>
<!-- main crystal orb floating just above tower -->
<circle cx="128" cy="22" r="14" fill="url(#gk-rgrad-amethyst)" stroke="${PALETTE.amethyst.stroke}" stroke-width="3"/>
<ellipse cx="124" cy="16" rx="5" ry="3" fill="${PALETTE.white}" opacity="0.85"/>
<!-- soft glow halo around orb -->
<circle cx="128" cy="22" r="22" fill="none" stroke="${PALETTE.amethyst.hi}" stroke-width="2" opacity="0.55"/>
`;
}

function infernoTower() {
  // Spiked obsidian column with flame jets at the sides.
  return `
${SHADOW}
<!-- base -->
<ellipse cx="128" cy="${GROUND_Y - 6}" rx="52" ry="12" fill="url(#gk-grad-dark)" stroke="${PALETTE.dark.stroke}" stroke-width="4"/>
<!-- obsidian column with jagged edges (zigzag silhouette) -->
<path d="M 110 218
         L 102 200 L 110 188 L 102 170 L 110 158 L 100 140 L 110 124 L 102 108
         L 114 96 L 110 80 L 122 64 L 128 50
         L 134 64 L 146 80 L 142 96 L 154 108
         L 146 124 L 156 140 L 146 158 L 154 170 L 146 188 L 154 200 L 146 218 Z"
      fill="url(#gk-rgrad-dark)" stroke="${PALETTE.dark.stroke}" stroke-width="4" stroke-linejoin="round"/>
<!-- vertical highlight ridge -->
<path d="M 116 60 L 110 100 L 116 140 L 110 180 L 116 218"
      fill="none" stroke="${PALETTE.steel.hi}" stroke-width="2.5" opacity="0.55"/>
<!-- flame vent slits down the column (glowing) -->
<g fill="url(#gk-grad-ruby)" stroke="${PALETTE.ruby.stroke}" stroke-width="1.5">
  <ellipse cx="128" cy="180" rx="6" ry="3"/>
  <ellipse cx="128" cy="150" rx="6" ry="3"/>
  <ellipse cx="128" cy="120" rx="6" ry="3"/>
</g>
<!-- side flame jets (left + right) -->
<path d="M 96 168 Q 82 162 76 154 Q 80 158 90 160 Q 76 162 70 156"
      fill="url(#gk-grad-ruby)" stroke="${PALETTE.ruby.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<path d="M 160 168 Q 174 162 180 154 Q 176 158 166 160 Q 180 162 186 156"
      fill="url(#gk-grad-ruby)" stroke="${PALETTE.ruby.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<!-- top crown flame -->
<path d="M 128 44
         Q 116 30 122 12
         Q 124 22 128 16
         Q 132 22 134 12
         Q 140 30 128 44 Z"
      fill="url(#gk-grad-ruby)" stroke="${PALETTE.ruby.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
<path d="M 128 36 Q 122 26 126 16 Q 128 22 130 18 Q 134 26 128 36 Z"
      fill="${PALETTE.gold.hi}" opacity="0.9"/>
`;
}

function bombTower() {
  // Round powder keg tower with thick iron bands + lit fuse.
  return `
${SHADOW}
<!-- ground ring -->
<ellipse cx="128" cy="${GROUND_Y - 6}" rx="52" ry="12" fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="4"/>
<!-- main barrel body (huge cylinder) -->
<path d="M 76 ${GROUND_Y - 18}
         Q 72 130 76 80
         Q 128 64 180 80
         Q 184 130 180 ${GROUND_Y - 18}
         Q 128 ${GROUND_Y - 4} 76 ${GROUND_Y - 18} Z"
      fill="url(#gk-grad-brick)" stroke="${PALETTE.brick.stroke}" stroke-width="4" stroke-linejoin="round"/>
<!-- top oval lip -->
<ellipse cx="128" cy="80" rx="52" ry="14" fill="url(#gk-grad-brick)" stroke="${PALETTE.brick.stroke}" stroke-width="3.5"/>
<ellipse cx="128" cy="78" rx="40" ry="8" fill="${PALETTE.brick.lo}"/>
<!-- thick iron bands -->
<g fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="2.5">
  <rect x="74" y="104" width="108" height="8" rx="2"/>
  <rect x="74" y="160" width="108" height="8" rx="2"/>
  <rect x="74" y="194" width="108" height="8" rx="2"/>
</g>
<!-- gold rivets on bands -->
<g fill="${PALETTE.gold.hi}" stroke="${PALETTE.ink}" stroke-width="1">
  <circle cx="86" cy="108" r="2.5"/><circle cx="170" cy="108" r="2.5"/>
  <circle cx="86" cy="164" r="2.5"/><circle cx="170" cy="164" r="2.5"/>
</g>
<!-- skull warning sigil -->
<g transform="translate(128, 140)">
  <circle cx="0" cy="0" r="12" fill="${PALETTE.cream.hi}" stroke="${PALETTE.ink}" stroke-width="2"/>
  <circle cx="-3" cy="-2" r="2" fill="${PALETTE.ink}"/>
  <circle cx="3" cy="-2" r="2" fill="${PALETTE.ink}"/>
  <rect x="-4" y="4" width="2" height="4" fill="${PALETTE.ink}"/>
  <rect x="-1" y="4" width="2" height="4" fill="${PALETTE.ink}"/>
  <rect x="2" y="4" width="2" height="4" fill="${PALETTE.ink}"/>
</g>
<!-- fuse + spark -->
<rect x="124" y="60" width="8" height="12" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="1.5"/>
<path d="M 132 64 Q 148 50 158 36" fill="none" stroke="${PALETTE.wood.lo}" stroke-width="3" stroke-linecap="round"/>
<circle cx="158" cy="36" r="5" fill="${PALETTE.gold.hi}"/>
<circle cx="158" cy="36" r="2.5" fill="${PALETTE.white}"/>
${glossPath(`M 86 90 L 90 200 L 100 200 L 96 84 Z`, 0.45)}
`;
}

function heavyCannon() {
  // Wheeled siege cannon on a low platform (no tall column).
  return `
${SHADOW}
<!-- platform -->
${inkedRect({ x: 36, y: 188, w: 184, h: 32, r: 6, gradient: 'gk-grad-wood', stroke: PALETTE.wood.stroke, sw: 4 })}
<!-- gold trim band -->
<rect x="32" y="184" width="192" height="6" rx="2" fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="2"/>
<!-- big wheels (left + right) -->
<circle cx="68" cy="208" r="20" fill="url(#gk-rgrad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="3.5"/>
<circle cx="68" cy="208" r="14" fill="none" stroke="${PALETTE.wood.stroke}" stroke-width="2"/>
${[0,1,2,3,4,5].map(i => {
  const a = (i * Math.PI / 3).toFixed(3);
  const x = (68 + Math.cos(a) * 14).toFixed(1);
  const y = (208 + Math.sin(a) * 14).toFixed(1);
  return `<line x1="68" y1="208" x2="${x}" y2="${y}" stroke="${PALETTE.wood.stroke}" stroke-width="2"/>`;
}).join('')}
<circle cx="68" cy="208" r="4" fill="${PALETTE.iron.base}" stroke="${PALETTE.ink}" stroke-width="1.5"/>
<circle cx="188" cy="208" r="20" fill="url(#gk-rgrad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="3.5"/>
<circle cx="188" cy="208" r="14" fill="none" stroke="${PALETTE.wood.stroke}" stroke-width="2"/>
${[0,1,2,3,4,5].map(i => {
  const a = (i * Math.PI / 3).toFixed(3);
  const x = (188 + Math.cos(a) * 14).toFixed(1);
  const y = (208 + Math.sin(a) * 14).toFixed(1);
  return `<line x1="188" y1="208" x2="${x}" y2="${y}" stroke="${PALETTE.wood.stroke}" stroke-width="2"/>`;
}).join('')}
<circle cx="188" cy="208" r="4" fill="${PALETTE.iron.base}" stroke="${PALETTE.ink}" stroke-width="1.5"/>
<!-- heavy cannon barrel (huge, horizontal, slightly tilted up) -->
<g transform="translate(128, 160) rotate(-12 0 0)">
  <rect x="-72" y="-22" width="144" height="44" rx="14" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="4"/>
  <!-- breech (back) -->
  <rect x="-80" y="-26" width="16" height="52" rx="4" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="3"/>
  <!-- muzzle (front) -->
  <rect x="68" y="-26" width="18" height="52" rx="4" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="3"/>
  <!-- gold bands -->
  <rect x="-50" y="-22" width="6" height="44" fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1.5"/>
  <rect x="20" y="-22" width="6" height="44" fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1.5"/>
  <!-- gloss highlight -->
  <rect x="-66" y="-18" width="132" height="6" rx="3" fill="${PALETTE.white}" opacity="0.55"/>
</g>
<!-- pivot mount on the platform -->
<rect x="120" y="178" width="16" height="14" rx="3" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="2.5"/>
`;
}

function voltaicCoil() {
  // Open lattice scaffold tower + a Tesla ball at the top.
  return `
${SHADOW}
<!-- base footings -->
<rect x="78" y="208" width="20" height="16" rx="3" fill="url(#gk-grad-stone)" stroke="${PALETTE.stone.stroke}" stroke-width="3"/>
<rect x="158" y="208" width="20" height="16" rx="3" fill="url(#gk-grad-stone)" stroke="${PALETTE.stone.stroke}" stroke-width="3"/>
<!-- 4 lattice beams (X shape) -->
<g stroke="url(#gk-grad-copper)" stroke-width="9" stroke-linecap="round" fill="none">
  <line x1="88"  y1="208" x2="120" y2="80"/>
  <line x1="168" y1="208" x2="136" y2="80"/>
  <line x1="100" y1="208" x2="156" y2="80"/>
  <line x1="156" y1="208" x2="100" y2="80"/>
</g>
<g stroke="${PALETTE.copper.stroke}" stroke-width="3" stroke-linecap="round" fill="none">
  <line x1="88"  y1="208" x2="120" y2="80"/>
  <line x1="168" y1="208" x2="136" y2="80"/>
  <line x1="100" y1="208" x2="156" y2="80"/>
  <line x1="156" y1="208" x2="100" y2="80"/>
</g>
<!-- horizontal cross-bracing -->
<g stroke="url(#gk-grad-copper)" stroke-width="5" fill="none">
  <line x1="98"  y1="180" x2="158" y2="180"/>
  <line x1="108" y1="140" x2="148" y2="140"/>
  <line x1="114" y1="108" x2="142" y2="108"/>
</g>
<!-- copper top platform -->
<ellipse cx="128" cy="80" rx="32" ry="8" fill="url(#gk-grad-copper)" stroke="${PALETTE.copper.stroke}" stroke-width="3"/>
<!-- Tesla ball -->
<circle cx="128" cy="64" r="20" fill="url(#gk-rgrad-sapphire)" stroke="${PALETTE.sapphire.stroke}" stroke-width="4"/>
<ellipse cx="120" cy="56" rx="6" ry="3" fill="${PALETTE.white}" opacity="0.85"/>
<!-- electric arc bolts -->
<g fill="none" stroke="${PALETTE.sapphire.hi}" stroke-width="3" stroke-linecap="round" opacity="0.95">
  <path d="M 110 60 L 100 52 L 108 48 L 96 40"/>
  <path d="M 146 60 L 156 52 L 148 48 L 160 40"/>
  <path d="M 128 44 L 124 32 L 132 28 L 128 16"/>
</g>
`;
}

function skyMine() {
  // Narrow pylon with a spiked mine hanging from a horizontal boom.
  return `
${SHADOW}
<!-- pylon base + body -->
<rect x="56" y="208" width="36" height="16" rx="3" fill="url(#gk-grad-stone)" stroke="${PALETTE.stone.stroke}" stroke-width="3"/>
<path d="M 60 208
         L 62 96
         L 86 96
         L 88 208 Z"
      fill="url(#gk-grad-stone)" stroke="${PALETTE.stone.stroke}" stroke-width="3.5" stroke-linejoin="round"/>
<g stroke="${PALETTE.stone.stroke}" stroke-width="1.2" opacity="0.55">
  <line x1="62" y1="140" x2="86" y2="140"/>
  <line x1="62" y1="170" x2="86" y2="170"/>
</g>
<!-- horizontal boom extending right -->
<rect x="74" y="92" width="120" height="10" rx="3" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="3"/>
<rect x="186" y="86" width="14" height="22" rx="2" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="2.5"/>
<!-- hanging chain -->
<line x1="180" y1="102" x2="180" y2="138" stroke="${PALETTE.ink}" stroke-width="2"/>
<g stroke="${PALETTE.iron.stroke}" stroke-width="1.5" fill="${PALETTE.iron.base}">
  <ellipse cx="180" cy="108" rx="2.5" ry="2"/>
  <ellipse cx="180" cy="116" rx="2.5" ry="2"/>
  <ellipse cx="180" cy="124" rx="2.5" ry="2"/>
  <ellipse cx="180" cy="132" rx="2.5" ry="2"/>
</g>
<!-- spiked mine ball (BIG) -->
<circle cx="180" cy="160" r="30" fill="url(#gk-rgrad-dark)" stroke="${PALETTE.dark.stroke}" stroke-width="4"/>
<g stroke="${PALETTE.iron.stroke}" stroke-width="2.5" fill="url(#gk-grad-iron)">
  <rect x="178" y="124" width="4" height="14"/>
  <rect x="178" y="182" width="4" height="14"/>
  <rect x="146" y="158" width="14" height="4"/>
  <rect x="200" y="158" width="14" height="4"/>
  <rect x="156" y="140" width="6" height="14" transform="rotate(-45 159 147)"/>
  <rect x="156" y="166" width="6" height="14" transform="rotate(45 159 173)"/>
  <rect x="194" y="140" width="6" height="14" transform="rotate(45 197 147)"/>
  <rect x="194" y="166" width="6" height="14" transform="rotate(-45 197 173)"/>
</g>
<ellipse cx="172" cy="148" rx="6" ry="3" fill="${PALETTE.white}" opacity="0.55"/>
<!-- detonator light -->
<circle cx="180" cy="160" r="4" fill="${PALETTE.ruby.hi}"/>
`;
}

function skywardBow() {
  // Wooden ballista platform with crossed beams + huge arrow ready.
  return `
${SHADOW}
<!-- platform -->
${inkedRect({ x: 56, y: 188, w: 144, h: 30, r: 5, gradient: 'gk-grad-wood', stroke: PALETTE.wood.stroke, sw: 4 })}
<!-- crossed support beams -->
<g stroke="${PALETTE.wood.stroke}" stroke-width="4" fill="none">
  <line x1="76" y1="186" x2="128" y2="130"/>
  <line x1="180" y1="186" x2="128" y2="130"/>
</g>
<line x1="76" y1="186" x2="128" y2="130" stroke="url(#gk-grad-wood)" stroke-width="10" stroke-linecap="round"/>
<line x1="180" y1="186" x2="128" y2="130" stroke="url(#gk-grad-wood)" stroke-width="10" stroke-linecap="round"/>
<line x1="76" y1="186" x2="128" y2="130" stroke="${PALETTE.wood.stroke}" stroke-width="2"/>
<line x1="180" y1="186" x2="128" y2="130" stroke="${PALETTE.wood.stroke}" stroke-width="2"/>
<!-- bow stock (horizontal beam at top) -->
<rect x="56" y="124" width="144" height="12" rx="3" fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="3"/>
<!-- bow arms (curved) -->
<path d="M 56 130 Q 32 90 56 60" fill="none" stroke="url(#gk-grad-wood)" stroke-width="12" stroke-linecap="round"/>
<path d="M 56 130 Q 32 90 56 60" fill="none" stroke="${PALETTE.wood.stroke}" stroke-width="3"/>
<path d="M 200 130 Q 224 90 200 60" fill="none" stroke="url(#gk-grad-wood)" stroke-width="12" stroke-linecap="round"/>
<path d="M 200 130 Q 224 90 200 60" fill="none" stroke="${PALETTE.wood.stroke}" stroke-width="3"/>
<!-- bowstring (drawn back) -->
<path d="M 56 60 Q 128 100 200 60" fill="none" stroke="${PALETTE.ink}" stroke-width="2"/>
<!-- massive arrow loaded down the stock -->
<rect x="124" y="60" width="8" height="80" rx="2" fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="2"/>
<path d="M 128 28 L 116 60 L 140 60 Z"
      fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="3" stroke-linejoin="round"/>
<!-- fletching at back -->
<path d="M 122 138 L 110 158 L 122 152 Z" fill="${PALETTE.ruby.base}" stroke="${PALETTE.ruby.stroke}" stroke-width="1.5"/>
<path d="M 134 138 L 146 158 L 134 152 Z" fill="${PALETTE.ruby.base}" stroke="${PALETTE.ruby.stroke}" stroke-width="1.5"/>
<!-- gold trim on tip -->
<rect x="116" y="60" width="24" height="3" fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1"/>
`;
}

function eagleEye() {
  // Slender observation post, tall thin tower with rotating spyglass on swivel.
  return `
${SHADOW}
<!-- thin base -->
<rect x="104" y="208" width="48" height="16" rx="3" fill="url(#gk-grad-stone)" stroke="${PALETTE.stone.stroke}" stroke-width="3"/>
<!-- slender tapered tower -->
<path d="M 110 208 L 116 88 L 140 88 L 146 208 Z"
      fill="url(#gk-rgrad-stone)" stroke="${PALETTE.stone.stroke}" stroke-width="4" stroke-linejoin="round"/>
<g stroke="${PALETTE.stone.stroke}" stroke-width="1.2" opacity="0.55">
  <line x1="112" y1="140" x2="144" y2="140"/>
  <line x1="113" y1="170" x2="143" y2="170"/>
</g>
<!-- platform on top -->
<rect x="98" y="80" width="60" height="12" rx="3" fill="url(#gk-grad-stone)" stroke="${PALETTE.stone.stroke}" stroke-width="3"/>
<!-- merlons -->
<g fill="url(#gk-grad-stone)" stroke="${PALETTE.stone.stroke}" stroke-width="2">
  <rect x="96" y="68" width="12" height="14"/>
  <rect x="118" y="68" width="12" height="14"/>
  <rect x="140" y="68" width="12" height="14"/>
</g>
<!-- swivel mount -->
<rect x="116" y="60" width="24" height="10" rx="2" fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="2"/>
<!-- spyglass (big! brass, angled up to the right) -->
<g transform="translate(128, 56) rotate(-30)">
  <rect x="-6" y="-44" width="12" height="46" rx="3" fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="3"/>
  <rect x="-8" y="-50" width="16" height="10" rx="3" fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="2.5"/>
  <ellipse cx="0" cy="-50" rx="10" ry="3" fill="url(#gk-grad-sapphire)" stroke="${PALETTE.sapphire.stroke}" stroke-width="2"/>
  <rect x="-7" y="-32" width="14" height="4" fill="${PALETTE.gold.stroke}" opacity="0.55"/>
  <rect x="-7" y="-18" width="14" height="4" fill="${PALETTE.gold.stroke}" opacity="0.55"/>
</g>
<!-- eagle eye motif on the front of the platform -->
<g transform="translate(128, 100)">
  <ellipse cx="0" cy="0" rx="10" ry="6" fill="${PALETTE.cream.hi}" stroke="${PALETTE.ink}" stroke-width="1.5"/>
  <circle cx="0" cy="0" r="4" fill="${PALETTE.gold.hi}"/>
  <circle cx="0" cy="0" r="2" fill="${PALETTE.ink}"/>
</g>
`;
}

// ── Floor traps ──────────────────────────────────────────────

function trap() {
  // Wooden pit trap, square plank lid with cross-hatched cover.
  return `
${SHADOW}
<!-- ground hole -->
<ellipse cx="128" cy="200" rx="84" ry="22" fill="${PALETTE.dark.base}" opacity="0.85"/>
<!-- plank lid (square, slightly tilted in perspective) -->
<path d="M 56 184 L 200 184 L 220 220 L 36 220 Z"
      fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="4" stroke-linejoin="round"/>
<!-- wood planks (parallel lines) -->
<g stroke="${PALETTE.wood.stroke}" stroke-width="1.5" opacity="0.6">
  <line x1="84"  y1="184" x2="76"  y2="220"/>
  <line x1="112" y1="184" x2="108" y2="220"/>
  <line x1="140" y1="184" x2="142" y2="220"/>
  <line x1="168" y1="184" x2="180" y2="220"/>
</g>
<!-- iron-banded frame -->
<rect x="50" y="180" width="156" height="6" rx="2" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="2"/>
<!-- corner nails -->
<g fill="${PALETTE.gold.hi}" stroke="${PALETTE.ink}" stroke-width="1">
  <circle cx="60" cy="186" r="2.5"/>
  <circle cx="196" cy="186" r="2.5"/>
  <circle cx="48" cy="214" r="2.5"/>
  <circle cx="208" cy="214" r="2.5"/>
</g>
<!-- warning sign nailed on -->
<g transform="translate(128, 196)">
  <path d="M 0 -12 L 14 14 L -14 14 Z"
        fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="2.5" stroke-linejoin="round"/>
  <rect x="-1" y="-6" width="2" height="10" fill="${PALETTE.ink}"/>
  <circle cx="0" cy="9" r="1.5" fill="${PALETTE.ink}"/>
</g>
`;
}

function infernoTrap() {
  // Flame-vent grate, brass plate with slit vents + tongues of flame.
  return `
${SHADOW}
<!-- brass grate plate -->
<ellipse cx="128" cy="200" rx="86" ry="20" fill="url(#gk-grad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="4"/>
<ellipse cx="128" cy="198" rx="72" ry="14" fill="${PALETTE.brick.base}" opacity="0.5"/>
<!-- slit vents -->
<g fill="${PALETTE.ink}" stroke="${PALETTE.gold.stroke}" stroke-width="1.2">
  <rect x="74" y="192" width="18" height="4" rx="1"/>
  <rect x="98" y="190" width="20" height="4" rx="1"/>
  <rect x="124" y="188" width="22" height="4" rx="1"/>
  <rect x="152" y="190" width="20" height="4" rx="1"/>
  <rect x="178" y="192" width="18" height="4" rx="1"/>
</g>
<!-- corner brass studs -->
<g fill="url(#gk-rgrad-gold)" stroke="${PALETTE.gold.stroke}" stroke-width="1.5">
  <circle cx="60" cy="200" r="4"/>
  <circle cx="196" cy="200" r="4"/>
  <circle cx="92" cy="184" r="3"/>
  <circle cx="164" cy="184" r="3"/>
</g>
<!-- flame tongues bursting up from the slits -->
<g stroke="${PALETTE.ruby.stroke}" stroke-width="2" stroke-linejoin="round">
  <path d="M 84 192 Q 78 178 84 168 Q 86 174 84 188 Z" fill="url(#gk-grad-ruby)"/>
  <path d="M 108 190 Q 100 168 110 150 Q 116 168 108 188 Z" fill="url(#gk-grad-ruby)"/>
  <path d="M 134 188 Q 124 160 136 134 Q 144 160 134 184 Z" fill="url(#gk-grad-ruby)"/>
  <path d="M 162 190 Q 158 168 168 150 Q 174 168 164 188 Z" fill="url(#gk-grad-ruby)"/>
  <path d="M 188 192 Q 186 180 192 170 Q 196 180 192 190 Z" fill="url(#gk-grad-ruby)"/>
</g>
<!-- gold inner flame highlights -->
<g fill="${PALETTE.gold.hi}" opacity="0.95">
  <path d="M 134 180 Q 132 168 138 156 Q 142 168 138 180 Z"/>
  <path d="M 110 184 Q 108 174 113 164 Q 117 174 113 184 Z"/>
  <path d="M 162 184 Q 164 174 169 164 Q 173 174 169 184 Z"/>
</g>
`;
}

function springTrap() {
  // Coiled-spring pad, visible heavy spring + a plate hovering above.
  return `
${SHADOW}
<!-- ground anchor -->
<ellipse cx="128" cy="${GROUND_Y - 4}" rx="60" ry="10" fill="${PALETTE.wood.lo}" opacity="0.85"/>
<rect x="68" y="${GROUND_Y - 12}" width="120" height="12" rx="3" fill="url(#gk-grad-wood)" stroke="${PALETTE.wood.stroke}" stroke-width="3"/>
<!-- big visible coiled spring -->
<g fill="none" stroke="url(#gk-grad-iron)" stroke-width="14" stroke-linecap="round">
  <path d="M 82 192
           Q 82 178 174 178
           Q 174 168 82 168
           Q 82 158 174 158
           Q 174 148 82 148
           Q 82 138 174 138
           Q 174 128 82 128"/>
</g>
<g fill="none" stroke="${PALETTE.iron.stroke}" stroke-width="3" stroke-linecap="round" opacity="0.7">
  <path d="M 82 192
           Q 82 178 174 178
           Q 174 168 82 168
           Q 82 158 174 158
           Q 174 148 82 148
           Q 82 138 174 138
           Q 174 128 82 128"/>
</g>
<!-- top plate (hovering, ready to spring) -->
<ellipse cx="128" cy="118" rx="76" ry="10" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="3.5"/>
<rect x="56" y="108" width="144" height="14" rx="3" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="3"/>
${glossPath(`M 60 110 L 196 110 L 196 116 L 60 116 Z`, 0.5)}
<!-- gold trigger button on top -->
<circle cx="128" cy="112" r="6" fill="url(#gk-rgrad-ruby)" stroke="${PALETTE.ruby.stroke}" stroke-width="2"/>
<!-- spike tip in centre of plate (it's a spike trap with bounce) -->
<path d="M 128 108 L 122 78 L 134 78 Z"
      fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="2" stroke-linejoin="round"/>
`;
}

function staticTrap() {
  // Copper-coil mat, concentric copper rings on a circular plate, arcs pulsing.
  return `
${SHADOW}
<!-- outer copper plate -->
<ellipse cx="128" cy="200" rx="86" ry="20" fill="url(#gk-grad-copper)" stroke="${PALETTE.copper.stroke}" stroke-width="4"/>
<!-- concentric coils -->
<g fill="none" stroke="${PALETTE.copper.stroke}" stroke-width="2.5">
  <ellipse cx="128" cy="200" rx="68" ry="14"/>
  <ellipse cx="128" cy="200" rx="52" ry="10"/>
  <ellipse cx="128" cy="200" rx="36" ry="7"/>
  <ellipse cx="128" cy="200" rx="20" ry="4"/>
</g>
<!-- copper bumps on outer ring -->
<g fill="url(#gk-rgrad-copper)" stroke="${PALETTE.copper.stroke}" stroke-width="1.5">
  <circle cx="48" cy="200" r="4"/>
  <circle cx="208" cy="200" r="4"/>
  <circle cx="88" cy="186" r="3"/>
  <circle cx="168" cy="186" r="3"/>
  <circle cx="88" cy="214" r="3"/>
  <circle cx="168" cy="214" r="3"/>
</g>
<!-- centre orb (sapphire, electric) -->
<circle cx="128" cy="200" r="12" fill="url(#gk-rgrad-sapphire)" stroke="${PALETTE.sapphire.stroke}" stroke-width="3"/>
<ellipse cx="124" cy="196" rx="4" ry="2" fill="${PALETTE.white}" opacity="0.85"/>
<!-- electric arcs jumping out -->
<g fill="none" stroke="${PALETTE.sapphire.hi}" stroke-width="2.5" stroke-linecap="round" opacity="0.95">
  <path d="M 128 188 L 124 172 L 132 168 L 128 152"/>
  <path d="M 116 200 L 100 196 L 96 188 L 80 184"/>
  <path d="M 140 200 L 156 196 L 160 188 L 176 184"/>
  <path d="M 128 212 L 124 224 L 132 224 L 128 234"/>
</g>
`;
}

function caltrops() {
  // Scatter of caltrops on grass, no plate; just spikes on ground.
  return `
${SHADOW}
<!-- grass tuft base -->
<ellipse cx="128" cy="${GROUND_Y - 6}" rx="92" ry="14" fill="url(#gk-grad-leaf)" opacity="0.7"/>
<g stroke="${PALETTE.leaf.stroke}" stroke-width="1.5" fill="none" opacity="0.75">
  <path d="M 50 220 L 54 208 M 60 220 L 56 206"/>
  <path d="M 180 220 L 184 208 M 196 220 L 192 206"/>
  <path d="M 84 218 L 80 208"/>
  <path d="M 220 218 L 216 208"/>
</g>
<!-- caltrops scattered (5 different positions/sizes/rotations) -->
${(() => {
  const positions = [
    { x: 80, y: 198, scale: 1.0, rot: 0 },
    { x: 134, y: 188, scale: 1.3, rot: 18 },
    { x: 188, y: 200, scale: 0.9, rot: -25 },
    { x: 104, y: 210, scale: 0.85, rot: 40 },
    { x: 168, y: 214, scale: 1.0, rot: -10 },
  ];
  return positions.map((p, i) => `
<g transform="translate(${p.x}, ${p.y}) rotate(${p.rot}) scale(${p.scale})">
  <!-- triangle pile of 4 spikes -->
  <path d="M 0 -14 L 5 8 L -5 8 Z" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="2" stroke-linejoin="round"/>
  <path d="M -12 4 L 4 -4 L 0 12 Z" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="2" stroke-linejoin="round"/>
  <path d="M 12 4 L -4 -4 L 0 12 Z" fill="url(#gk-grad-iron)" stroke="${PALETTE.iron.stroke}" stroke-width="2" stroke-linejoin="round"/>
  <!-- gold tip on the up-pointing spike -->
  <circle cx="0" cy="-12" r="1.6" fill="${PALETTE.gold.hi}"/>
</g>
`).join('');
})()}
`;
}

// ── Catalogue + write ────────────────────────────────────────

const KINDS = [
  { id: 'sawmill',     body: sawmill },
  { id: 'quarry',      body: quarry },
  { id: 'forge',       body: forge },
  { id: 'mint',        body: mint },
  { id: 'workshop',    body: workshop },
  { id: 'lumberVault', body: lumberVault },
  { id: 'stoneVault',  body: stoneVault },
  { id: 'ironVault',   body: ironVault },
  { id: 'goldVault',   body: goldVault },
  { id: 'mortar',       body: mortar },
  { id: 'mageTower',    body: mageTower },
  { id: 'infernoTower', body: infernoTower },
  { id: 'bombTower',    body: bombTower },
  { id: 'heavyCannon',  body: heavyCannon },
  { id: 'voltaicCoil',  body: voltaicCoil },
  { id: 'skyMine',      body: skyMine },
  { id: 'skywardBow',   body: skywardBow },
  { id: 'eagleEye',     body: eagleEye },
  { id: 'trap',         body: trap },
  { id: 'infernoTrap',  body: infernoTrap },
  { id: 'springTrap',   body: springTrap },
  { id: 'staticTrap',   body: staticTrap },
  { id: 'caltrops',     body: caltrops },
];

let written = 0;
for (const k of KINDS) {
  const svg = svgWrapper({
    width: W, height: H,
    body: k.body(),
    title: `${k.id} (L1, K4b redesign), glossy`,
    desc: 'Distinct-silhouette glossy Clash building. Source: tools/build-clash-unique-buildings.mjs.',
  });
  const out = join(OUT, `${k.id}-L1.svg`);
  writeFileSync(out, svg);
  written++;
  console.log(`  ${k.id}-L1.svg`);
}
console.log(`\n✓ rewrote ${written} L1 building SVGs with distinct silhouettes (K4b)`);
