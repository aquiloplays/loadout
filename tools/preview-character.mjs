// Quick preview: composite a sample character look from on-disk sprites
// and write PNG(s) to tools/preview/. No worker dependency.
//
// Usage:
//   node tools/preview-character.mjs              # default look
//   node tools/preview-character.mjs --body=slim --skin=bronze --hair=long-straight --eyes=blue --accent=freckles
//
// Also accepts --gear=weapon:excalibur,head:emberfall-helm,...
// All layer paths resolve under aquilo-gg/sprites/.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng, compose, paletteSwap } from '../discord-bot/png-codec.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const spritesDir = path.join(repoRoot, 'aquilo-gg/sprites');
const outDir = path.join(__dirname, 'preview');
await fs.mkdir(outDir, { recursive: true });

// CLI args: --key=value
const argv = process.argv.slice(2);
const args = {};
for (const a of argv) {
  const m = /^--([^=]+)=(.*)$/.exec(a);
  if (m) args[m[1]] = m[2];
}

// Default look — exercises every layer type
const look = {
  body: args.body || 'stocky',
  skin: args.skin || 'fair',
  hair: args.hair || 'short-tousled',
  hairColor: args.hairColor || 'brown',
  eyes: args.eyes || 'blue',
  accent: args.accent || 'freckles',
  gear: parseGear(args.gear),
};

function parseGear(s) {
  if (!s) return {};
  const out = {};
  for (const part of s.split(',')) {
    const [slot, id] = part.split(':');
    if (slot && id) out[slot] = id;
  }
  return out;
}

// Hair palette swap data — must mirror character.js HAIR_REF +
// HAIR_COLOURS_RGB. We extend to 5 tones for the HD bar.
const HAIR_REF = {
  deep: [0x22, 0x12, 0x0b], shadow: [0x3b, 0x25, 0x1a], base: [0x5a, 0x3a, 0x26], high: [0x7a, 0x52, 0x36], top: [0xa0, 0x72, 0x48],
};
const HAIR_COLOURS = {
  brown: HAIR_REF,
  black:   { deep:[0x08,0x08,0x0a], shadow:[0x16,0x16,0x18], base:[0x2a,0x2a,0x30], high:[0x42,0x42,0x4a], top:[0x5a,0x5b,0x66] },
  blonde:  { deep:[0x6c,0x4e,0x10], shadow:[0xa3,0x7a,0x30], base:[0xd4,0xa6,0x4a], high:[0xf4,0xd2,0x7a], top:[0xff,0xf0,0xb8] },
  red:     { deep:[0x4a,0x10,0x0a], shadow:[0x7a,0x20,0x18], base:[0xb5,0x34,0x20], high:[0xd8,0x55,0x3a], top:[0xf0,0x80,0x60] },
  grey:    { deep:[0x3e,0x42,0x4a], shadow:[0x5f,0x63,0x6c], base:[0x87,0x8b,0x95], high:[0xb3,0xb8,0xc2], top:[0xd2,0xd6,0xde] },
  white:   { deep:[0xa4,0xa8,0xb2], shadow:[0xc8,0xcc,0xd6], base:[0xe6,0xe9,0xef], high:[0xff,0xff,0xff], top:[0xff,0xff,0xff] },
  violet:  { deep:[0x3a,0x28,0x80], shadow:[0x5a,0x40,0xb0], base:[0x7c,0x5c,0xff], high:[0xa8,0x90,0xff], top:[0xcd,0xb8,0xff] },
  teal:    { deep:[0x1a,0x5a,0x4a], shadow:[0x2f,0x8a,0x78], base:[0x5f,0xc4,0xa8], high:[0x92,0xe6,0xcd], top:[0xbd,0xf5,0xe0] },
  pink:    { deep:[0x85,0x20,0x48], shadow:[0xc1,0x46,0x88], base:[0xe8,0x7a,0xb0], high:[0xff,0xab,0xcf], top:[0xff,0xd0,0xe2] },
  mint:    { deep:[0x22,0x78,0x4a], shadow:[0x3d,0xa7,0x6c], base:[0x5b,0xe0,0x98], high:[0x90,0xff,0xc4], top:[0xc4,0xff,0xe0] },
  silver:  { deep:[0x52,0x58,0x68], shadow:[0x7a,0x80,0x90], base:[0xa8,0xaf,0xbc], high:[0xd4,0xd8,0xe0], top:[0xee,0xf0,0xf5] },
  copper:  { deep:[0x68,0x26,0x0a], shadow:[0x9c,0x4a,0x1f], base:[0xcf,0x72,0x40], high:[0xf0,0x98,0x66], top:[0xff,0xb8,0x8a] },
  navy:    { deep:[0x0a,0x12,0x30], shadow:[0x17,0x20,0x46], base:[0x29,0x3a,0x78], high:[0x3e,0x53,0x9c], top:[0x5a,0x72,0xc0] },
  forest:  { deep:[0x0a,0x24,0x10], shadow:[0x1a,0x3a,0x20], base:[0x2e,0x5c,0x34], high:[0x4b,0x85,0x50], top:[0x74,0xa8,0x78] },
};
function hairPaletteMap(colourKey) {
  const tgt = HAIR_COLOURS[colourKey] || HAIR_REF;
  return [
    { from: HAIR_REF.deep,   to: tgt.deep   },
    { from: HAIR_REF.shadow, to: tgt.shadow },
    { from: HAIR_REF.base,   to: tgt.base   },
    { from: HAIR_REF.high,   to: tgt.high   },
    { from: HAIR_REF.top,    to: tgt.top    },
  ];
}

async function loadLayer(rel) {
  const file = path.join(spritesDir, rel);
  try {
    const buf = await fs.readFile(file);
    return await decodePng(new Uint8Array(buf));
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.warn('  missing:', rel);
      return null;
    }
    throw e;
  }
}

async function composeLook(look, outName) {
  const layers = [];
  // Back trinket (cape) — if applicable
  if (look.gear.trinket && /(^|-)(cape|cloak|wing|mantle|drape|veil|feather)(-|$)/.test(look.gear.trinket)) {
    const l = await loadLayer(`gear/trinket/${look.gear.trinket}.png`);
    if (l) layers.push(l);
  }
  // Body
  const body = await loadLayer(`figure/body-${look.body}-${look.skin}.png`);
  if (body) layers.push(body);
  // Default clothing — always rendered; chest/legs gear paints over it.
  const clothes = await loadLayer('figure/default-clothing.png');
  if (clothes) layers.push(clothes);
  // Legs / boots / chest gear
  for (const slot of ['legs', 'boots', 'chest']) {
    if (look.gear[slot]) {
      const l = await loadLayer(`gear/${slot}/${look.gear[slot]}.png`);
      if (l) layers.push(l);
    }
  }
  // Front trinket
  if (look.gear.trinket && !/(^|-)(cape|cloak|wing|mantle|drape|veil|feather)(-|$)/.test(look.gear.trinket)) {
    const l = await loadLayer(`gear/trinket/${look.gear.trinket}.png`);
    if (l) layers.push(l);
  }
  // Hair (palette swap)
  if (look.hair && look.hair !== 'bald') {
    const hair = await loadLayer(`figure/hair-${look.hair}.png`);
    if (hair) layers.push(paletteSwap(hair, hairPaletteMap(look.hairColor)));
  }
  // Eyes
  if (look.eyes) {
    const l = await loadLayer(`figure/eyes-${look.eyes}.png`);
    if (l) layers.push(l);
  }
  // Accent
  if (look.accent && look.accent !== 'none') {
    const l = await loadLayer(`figure/accent-${look.accent}.png`);
    if (l) layers.push(l);
  }
  // Head
  if (look.gear.head) {
    const l = await loadLayer(`gear/head/${look.gear.head}.png`);
    if (l) layers.push(l);
  }
  // Weapon
  if (look.gear.weapon) {
    const l = await loadLayer(`gear/weapon/${look.gear.weapon}.png`);
    if (l) layers.push(l);
  }
  if (!layers.length) {
    console.error('No layers loaded.');
    return null;
  }
  const composed = compose(layers);
  const png = await encodePng(composed);
  const out = path.join(outDir, outName);
  await fs.writeFile(out, png);
  console.log(`  wrote ${path.relative(repoRoot, out)}  (${composed.width}×${composed.height})`);
  return out;
}

await composeLook(look, 'preview.png');
