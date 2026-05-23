// Contact sheet of all 35 glossy pet sprites for visual review.

import { readFileSync, readdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { bakeFile } from './bake-glossy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DIR  = join(ROOT, 'aquilo-gg/sprites/pet/glossy');
const OUT  = join(__dirname, '_render-pet-sheet.png');

const files = readdirSync(DIR).filter(f => f.endsWith('.png')).sort();
const TILE = 144;
const COLS = 7;
const ROWS = Math.ceil(files.length / COLS);
const W = COLS * TILE, H = ROWS * TILE + 4;

const tiles = files.map((f, i) => {
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  const x = col * TILE + 8;
  const y = row * TILE + 6;
  const png = readFileSync(join(DIR, f)).toString('base64');
  const label = f.replace(/\.png$/, '');
  return `<image href="data:image/png;base64,${png}" x="${x}" y="${y}" width="128" height="128"/>
  <text x="${x + 64}" y="${y + 140}" font-family="monospace" font-size="9" fill="#a8b0c0" text-anchor="middle">${label}</text>`;
}).join('\n  ');

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect x="0" y="0" width="${W}" height="${H}" fill="#1c2030"/>
  ${tiles}
</svg>
`;
await bakeFile(svg, OUT, { width: W, height: H });
console.log(`✓ wrote ${OUT}`);
