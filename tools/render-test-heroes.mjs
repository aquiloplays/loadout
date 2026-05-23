// Render-test: composite a handful of full glossy heroes so we
// can visually inspect anchor/scale/z-order and confirm no
// clipping or overlap bugs in the paper-doll pipeline.
//
// Composition path: build an SVG that embeds each layer PNG as
// a data-uri <image>, bake the composite via @resvg/resvg-js.
// This is exactly the order character.js compose uses (modulo
// pet which we skip for this test):
//
//   z=10  back-trinket   (if name matches cape/cloak/wings/...)
//   z=20  body
//   z=25  default-clothing
//   z=30  legs
//   z=35  boots
//   z=40  chest
//   z=45  front-trinket
//   z=60  hair
//   z=65  eyes
//   z=66  accent
//   z=70  head
//   z=80  weapon
//
// Run:  node tools/render-test-heroes.mjs

import { mkdirSync, readFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { bakeFile } from './bake-glossy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const FIG_DIR  = join(ROOT, 'aquilo-gg/sprites/figure/glossy');
const GEAR_DIR = join(ROOT, 'aquilo-gg/sprites/gear/figure');
const OUT_DIR  = join(ROOT, 'tools/_render-test-heroes');
mkdirSync(OUT_DIR, { recursive: true });

const W = 128, H = 160;

// Embed a PNG as a data URI in an <image> tag.
function pngLayer(absPath) {
  if (!existsSync(absPath)) {
    console.warn('  missing', absPath);
    return '';
  }
  const buf = readFileSync(absPath);
  const b64 = buf.toString('base64');
  return `<image href="data:image/png;base64,${b64}" x="0" y="0" width="${W}" height="${H}"/>`;
}

const BACK_TRINKET_RE = /(^|-)(cape|cloak|wings?|mantle|drape|veil|feather)(-|$)/i;

function composeHero(hero) {
  const layers = [];

  // z=10 — back trinket (if any)
  if (hero.trinket && BACK_TRINKET_RE.test(hero.trinket)) {
    layers.push(pngLayer(join(GEAR_DIR, 'trinket', `${hero.trinket}.png`)));
  }
  // z=20 — body
  layers.push(pngLayer(join(FIG_DIR, `body-${hero.bodyType}-${hero.skinTone}.png`)));
  // z=25 — default clothing
  layers.push(pngLayer(join(FIG_DIR, 'default-clothing.png')));
  // z=30 / 35 / 40 — legs / boots / chest gear
  if (hero.legs)   layers.push(pngLayer(join(GEAR_DIR, 'legs',   `${hero.legs}.png`)));
  if (hero.boots)  layers.push(pngLayer(join(GEAR_DIR, 'boots',  `${hero.boots}.png`)));
  if (hero.chest)  layers.push(pngLayer(join(GEAR_DIR, 'chest',  `${hero.chest}.png`)));
  // z=45 — front trinket
  if (hero.trinket && !BACK_TRINKET_RE.test(hero.trinket)) {
    layers.push(pngLayer(join(GEAR_DIR, 'trinket', `${hero.trinket}.png`)));
  }
  // z=60 — hair
  if (hero.hairStyle && hero.hairStyle !== 'bald') {
    layers.push(pngLayer(join(FIG_DIR, `hair-${hero.hairStyle}-${hero.hairColor}.png`)));
  }
  // z=65 — eyes
  if (hero.eyeColor) layers.push(pngLayer(join(FIG_DIR, `eyes-${hero.eyeColor}.png`)));
  // z=66 — accent
  if (hero.accent && hero.accent !== 'none') {
    layers.push(pngLayer(join(FIG_DIR, `accent-${hero.accent}.png`)));
  }
  // z=70 — head gear (over hair)
  if (hero.head)   layers.push(pngLayer(join(GEAR_DIR, 'head', `${hero.head}.png`)));
  // z=80 — weapon
  if (hero.weapon) layers.push(pngLayer(join(GEAR_DIR, 'weapon', `${hero.weapon}.png`)));

  // Pale background so we can see the silhouette + any
  // alpha-bleed.
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect x="0" y="0" width="${W}" height="${H}" fill="#1c2030"/>
  ${layers.join('\n  ')}
</svg>
`;
}

const TEST_HEROES = [
  {
    name: 'A-warrior-knight',
    bodyType: 'stocky', skinTone: 'tan',
    hairStyle: 'short-tousled', hairColor: 'brown',
    eyeColor: 'brown', accent: 'face-scar',
    weapon: 'weapon-uncommon-knights-sword',
    chest:  'chest-rare-knights-cuirass',
    legs:   'legs-rare-knights-tassets',
    boots:  'boots-rare-knights-sabatons',
    head:   'head-rare-knights-helm',
    trinket: 'trinket-uncommon-iron-ward',
  },
  {
    name: 'B-mage-arcane',
    bodyType: 'slim', skinTone: 'porcelain',
    hairStyle: 'wizard-long', hairColor: 'violet',
    eyeColor: 'violet', accent: 'glasses-round',
    weapon: 'weapon-epic-stormcaller-staff',
    chest:  'chest-epic-voidweave-robe',
    legs:   'legs-uncommon-arcane-skirt',
    boots:  'boots-uncommon-arcane-slippers',
    head:   'head-epic-voidweave-hood',
    trinket: 'trinket-rare-wardstone-amulet',
  },
  {
    name: 'C-ranger-forest',
    bodyType: 'slim', skinTone: 'olive',
    hairStyle: 'ponytail', hairColor: 'forest',
    eyeColor: 'green', accent: 'freckles',
    weapon: 'weapon-uncommon-yew-longbow',
    chest:  'chest-rare-druidic-robes',
    legs:   'legs-rare-druidic-pants',
    boots:  'boots-rare-mossfoot-boots',
    head:   'head-rare-antlered-hood',
    trinket: 'trinket-common-crow-feather',
  },
  {
    name: 'D-rogue-shadow',
    bodyType: 'slim', skinTone: 'ash',
    hairStyle: 'shaved-sides', hairColor: 'silver',
    eyeColor: 'amber', accent: 'eye-shadow',
    weapon: 'weapon-rare-shadow-daggers',
    chest:  'chest-rare-highwayman-coat',
    legs:   'legs-rare-highwayman-pants',
    boots:  'boots-epic-shadowstep-boots',
    head:   'head-rare-highwayman-mask',
    trinket: 'trinket-epic-shadow-mask',
  },
  {
    name: 'E-healer-cleric',
    bodyType: 'stocky', skinTone: 'rose',
    hairStyle: 'bun', hairColor: 'blonde',
    eyeColor: 'blue', accent: 'none',
    weapon: 'weapon-rare-healing-staff',
    chest:  'chest-uncommon-vestal-robes',
    legs:   'legs-uncommon-arcane-skirt',
    boots:  'boots-common-sandals',
    head:   'head-common-cloth-hood',
    trinket: 'trinket-rare-vestal-pendant',
  },
  {
    name: 'F-bare-hero',
    bodyType: 'stocky', skinTone: 'ebony',
    hairStyle: 'curly-afro', hairColor: 'black',
    eyeColor: 'hazel', accent: 'none',
    // no gear — confirms body + default-clothing render alone cleanly
  },
];

console.log('Rendering test heroes...');
for (const h of TEST_HEROES) {
  const svg = composeHero(h);
  const out = join(OUT_DIR, `${h.name}.png`);
  await bakeFile(svg, out, { width: W, height: H });
  console.log(`  ${h.name}.png`);
}

// Also bake a 2x grid PNG so we can eyeball them all together.
const TILE_W = W, TILE_H = H;
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
  labels.push(`<text x="${x + 6}" y="${y + TILE_H - 4}" font-family="monospace" font-size="9" fill="#fff" opacity="0.85">${h.name}</text>`);
  return `<image href="data:image/png;base64,${png}" x="${x}" y="${y}" width="${TILE_W}" height="${TILE_H}"/>`;
});
const gridSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID_W} ${GRID_H}" width="${GRID_W}" height="${GRID_H}">
  <rect x="0" y="0" width="${GRID_W}" height="${GRID_H}" fill="#0a0d14"/>
  ${tiles.join('\n  ')}
  ${labels.join('\n  ')}
</svg>`;
await bakeFile(gridSvg, join(OUT_DIR, '_grid.png'), { width: GRID_W, height: GRID_H });
console.log(`\n✓ rendered ${TEST_HEROES.length} test heroes + _grid.png → ${OUT_DIR}`);
