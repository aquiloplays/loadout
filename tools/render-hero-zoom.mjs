// Big-resolution hero render so I can ACTUALLY see what's wrong with
// the figure. Composes the same 9 heroes as render-test-heroes.mjs
// but bakes at 4× scale (512×640 per hero) and writes both individual
// large PNGs and a 3-col grid.
//
// Run:  node tools/render-hero-zoom.mjs

import { mkdirSync, readFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { bakeFile } from './bake-glossy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const FIG_DIR  = join(ROOT, 'aquilo-gg/sprites/figure/glossy');
const GEAR_DIR = join(ROOT, 'aquilo-gg/sprites/gear/figure');
const PET_DIR  = join(ROOT, 'aquilo-gg/sprites/pet/glossy');
const FX_DIR   = join(ROOT, 'aquilo-gg/sprites/gear/figure/fx');
const OUT_DIR  = join(ROOT, 'tools/_render-hero-zoom');
mkdirSync(OUT_DIR, { recursive: true });

const W = 128, H = 160;
const SCALE = 4;
const BIG_W = W * SCALE, BIG_H = H * SCALE;

function pngLayer(absPath) {
  if (!existsSync(absPath)) return '';
  const buf = readFileSync(absPath);
  const b64 = buf.toString('base64');
  return `<image href="data:image/png;base64,${b64}" x="0" y="0" width="${W}" height="${H}"/>`;
}

const BACK_TRINKET_RE = /(^|-)(cape|cloak|wings?|mantle|drape|veil|feather)(-|$)/i;

function composeHero(hero) {
  const layers = [];
  if (hero.trinket && BACK_TRINKET_RE.test(hero.trinket)) {
    layers.push(pngLayer(join(GEAR_DIR, 'trinket', `${hero.trinket}.png`)));
  }
  if (hero.pet) {
    layers.push(pngLayer(join(PET_DIR, `${hero.pet.species}-${hero.pet.colour}.png`)));
    if (hero.pet.mood) layers.push(pngLayer(join(PET_DIR, `mood-${hero.pet.mood}.png`)));
  }
  // z=20 body
  layers.push(pngLayer(join(FIG_DIR, `body-${hero.bodyType}-${hero.skinTone}.png`)));
  // z=22 default trousers
  layers.push(pngLayer(join(FIG_DIR, 'default-trousers.png')));
  // z=30 legs gear
  if (hero.legs)   layers.push(pngLayer(join(GEAR_DIR, 'legs',   `${hero.legs}.png`)));
  // z=33 default tunic, covers leg gear TOP with the skirt
  layers.push(pngLayer(join(FIG_DIR, 'default-tunic.png')));
  // z=35 boots
  if (hero.boots)  layers.push(pngLayer(join(GEAR_DIR, 'boots',  `${hero.boots}.png`)));
  // z=40 chest gear
  if (hero.chest)  layers.push(pngLayer(join(GEAR_DIR, 'chest',  `${hero.chest}.png`)));
  // z=45 front trinket
  if (hero.trinket && !BACK_TRINKET_RE.test(hero.trinket)) {
    layers.push(pngLayer(join(GEAR_DIR, 'trinket', `${hero.trinket}.png`)));
  }
  // z=60 hair
  if (hero.hairStyle && hero.hairStyle !== 'bald') {
    layers.push(pngLayer(join(FIG_DIR, `hair-${hero.hairStyle}-${hero.hairColor}.png`)));
  }
  // z=65 face overlay (eyes + accent)
  if (hero.eyeColor) layers.push(pngLayer(join(FIG_DIR, `eyes-${hero.eyeColor}.png`)));
  if (hero.accent && hero.accent !== 'none') {
    layers.push(pngLayer(join(FIG_DIR, `accent-${hero.accent}.png`)));
  }
  // z=70 head gear
  if (hero.head)   layers.push(pngLayer(join(GEAR_DIR, 'head', `${hero.head}.png`)));
  // z=78 weapon
  if (hero.weapon) layers.push(pngLayer(join(GEAR_DIR, 'weapon', `${hero.weapon}.png`)));
  // z=79 hand overlay, grips the weapon
  if (hero.weapon) layers.push(pngLayer(join(FIG_DIR, `hand-overlay-${hero.skinTone}.png`)));
  if (hero.legendarySlots) {
    for (const slot of hero.legendarySlots) {
      layers.push(pngLayer(join(FX_DIR, `${slot}.png`)));
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect x="0" y="0" width="${W}" height="${H}" fill="#1c2030"/>
  ${layers.join('\n  ')}
</svg>`;
}

const TEST_HEROES = [
  { name: 'A-warrior-knight', bodyType: 'stocky', skinTone: 'tan',
    hairStyle: 'short-tousled', hairColor: 'brown', eyeColor: 'brown', accent: 'face-scar',
    weapon: 'weapon-uncommon-knights-sword', chest: 'chest-rare-knights-cuirass',
    legs: 'legs-rare-knights-tassets', boots: 'boots-rare-knights-sabatons',
    head: 'head-rare-knights-helm', trinket: 'trinket-uncommon-iron-ward' },
  { name: 'B-mage-arcane', bodyType: 'slim', skinTone: 'porcelain',
    hairStyle: 'wizard-long', hairColor: 'violet', eyeColor: 'violet', accent: 'glasses-round',
    weapon: 'weapon-epic-stormcaller-staff', chest: 'chest-epic-voidweave-robe',
    legs: 'legs-uncommon-arcane-skirt', boots: 'boots-uncommon-arcane-slippers',
    head: 'head-epic-voidweave-hood', trinket: 'trinket-rare-wardstone-amulet' },
  { name: 'C-ranger-forest', bodyType: 'slim', skinTone: 'olive',
    hairStyle: 'ponytail', hairColor: 'forest', eyeColor: 'green', accent: 'freckles',
    weapon: 'weapon-uncommon-yew-longbow', chest: 'chest-rare-druidic-robes',
    legs: 'legs-rare-druidic-pants', boots: 'boots-rare-mossfoot-boots',
    head: 'head-rare-antlered-hood', trinket: 'trinket-common-crow-feather' },
  { name: 'D-rogue-shadow', bodyType: 'slim', skinTone: 'ash',
    hairStyle: 'shaved-sides', hairColor: 'silver', eyeColor: 'amber', accent: 'eye-shadow',
    weapon: 'weapon-rare-shadow-daggers', chest: 'chest-rare-highwayman-coat',
    legs: 'legs-rare-highwayman-pants', boots: 'boots-epic-shadowstep-boots',
    head: 'head-rare-highwayman-mask', trinket: 'trinket-epic-shadow-mask' },
  { name: 'E-healer-cleric', bodyType: 'stocky', skinTone: 'rose',
    hairStyle: 'bun', hairColor: 'blonde', eyeColor: 'blue', accent: 'none',
    weapon: 'weapon-rare-healing-staff', chest: 'chest-uncommon-vestal-robes',
    legs: 'legs-uncommon-arcane-skirt', boots: 'boots-common-sandals',
    head: 'head-common-cloth-hood', trinket: 'trinket-rare-vestal-pendant' },
  { name: 'F-bare-hero', bodyType: 'stocky', skinTone: 'ebony',
    hairStyle: 'curly-afro', hairColor: 'black', eyeColor: 'hazel', accent: 'none' },
  { name: 'G-warrior-with-pet-and-legendary', bodyType: 'stocky', skinTone: 'tan',
    hairStyle: 'short-tousled', hairColor: 'brown', eyeColor: 'brown', accent: 'face-scar',
    weapon: 'weapon-uncommon-knights-sword', chest: 'chest-rare-knights-cuirass',
    legs: 'legs-rare-knights-tassets', boots: 'boots-rare-knights-sabatons',
    head: 'head-rare-knights-helm', pet: { species: 'dog', colour: 'amber' },
    legendarySlots: ['weapon', 'head'] },
  { name: 'H-mage-with-cat-mood', bodyType: 'slim', skinTone: 'porcelain',
    hairStyle: 'wizard-long', hairColor: 'violet', eyeColor: 'violet', accent: 'glasses-round',
    weapon: 'weapon-epic-stormcaller-staff', chest: 'chest-epic-voidweave-robe',
    legs: 'legs-uncommon-arcane-skirt', boots: 'boots-uncommon-arcane-slippers',
    head: 'head-epic-voidweave-hood', pet: { species: 'cat', colour: 'black', mood: 'hungry' },
    legendarySlots: ['chest'] },
  { name: 'I-ranger-with-fox', bodyType: 'slim', skinTone: 'olive',
    hairStyle: 'ponytail', hairColor: 'forest', eyeColor: 'green', accent: 'freckles',
    weapon: 'weapon-uncommon-yew-longbow', chest: 'chest-rare-druidic-robes',
    legs: 'legs-rare-druidic-pants', boots: 'boots-rare-mossfoot-boots',
    head: 'head-rare-antlered-hood', pet: { species: 'fox', colour: 'rust' } },
];

console.log('Rendering BIG (' + BIG_W + '×' + BIG_H + ') heroes for inspection...');
for (const h of TEST_HEROES) {
  const svg = composeHero(h);
  const out = join(OUT_DIR, `${h.name}.png`);
  await bakeFile(svg, out, { width: BIG_W, height: BIG_H });
  console.log(`  ${h.name}.png`);
}

// 3-col grid at 2× per tile.
const TILE_S = 2;
const TILE_W = W * TILE_S, TILE_H = H * TILE_S;
const COLS = 3;
const ROWS = Math.ceil(TEST_HEROES.length / COLS);
const GRID_W = COLS * TILE_W;
const GRID_H = ROWS * TILE_H + 24;
const labels = [];
const tiles = TEST_HEROES.map((h, i) => {
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  const x = col * TILE_W;
  const y = row * TILE_H;
  const png = readFileSync(join(OUT_DIR, `${h.name}.png`)).toString('base64');
  labels.push(`<text x="${x + 6}" y="${y + TILE_H - 4}" font-family="monospace" font-size="14" fill="#fff" opacity="0.85">${h.name}</text>`);
  return `<image href="data:image/png;base64,${png}" x="${x}" y="${y}" width="${TILE_W}" height="${TILE_H}"/>`;
});
const gridSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID_W} ${GRID_H}" width="${GRID_W}" height="${GRID_H}">
  <rect x="0" y="0" width="${GRID_W}" height="${GRID_H}" fill="#0a0d14"/>
  ${tiles.join('\n  ')}
  ${labels.join('\n  ')}
</svg>`;
await bakeFile(gridSvg, join(OUT_DIR, '_grid.png'), { width: GRID_W, height: GRID_H });
console.log(`\n✓ ${TEST_HEROES.length} big heroes + 2× _grid.png → ${OUT_DIR}`);
