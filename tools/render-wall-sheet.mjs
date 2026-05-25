// 4×4 grid of the 16 wall connectivity variants for visual QA.

import { readFileSync, readdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { bake, bakeFile } from './bake-glossy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DIR  = join(ROOT, 'aquilo-gg/sprites/clash-v2/glossy/buildings');
const OUT  = join(__dirname, '_qa-sheets/walls.png');

const files = readdirSync(DIR).filter(f => /^wall-L1-\d\d\.svg$/.test(f)).sort();
const TILE = 200;
const COLS = 4;
const W = COLS * (TILE + 8) + 8, H = COLS * (TILE + 22) + 8;

const tiles = [];
for (let i = 0; i < files.length; i++) {
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  const x = col * (TILE + 8) + 8;
  const y = row * (TILE + 22) + 8;
  const svgText = readFileSync(join(DIR, files[i]), 'utf8');
  const pngBuf = await bake(svgText, { width: TILE, height: TILE });
  const data = `data:image/png;base64,${pngBuf.toString('base64')}`;
  const mask = files[i].match(/(\d\d)/)[1];
  const bits = parseInt(mask, 10).toString(2).padStart(4, '0');
  tiles.push(`<image href="${data}" x="${x}" y="${y}" width="${TILE}" height="${TILE}"/>`);
  tiles.push(`<text x="${x + TILE/2}" y="${y + TILE + 14}" font-family="monospace" font-size="11" fill="#cfd8e4" text-anchor="middle">mask ${mask} = ${bits} (NESW)</text>`);
}
const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect x="0" y="0" width="${W}" height="${H}" fill="#1c2030"/>
  ${tiles.join('\n  ')}
</svg>`;
await bakeFile(svg, OUT, { width: W, height: H });
console.log(`✓ wrote ${OUT}`);
