// Contact-sheet for visual review of the glossy UI icon set.
// Composites all 32 baked icons into a single grid PNG.

import { readFileSync, readdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { bakeFile } from './bake-glossy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DIR  = join(ROOT, 'aquilo-gg/sprites/ui/icons/glossy');
const OUT  = join(__dirname, '_render-ui-icons-sheet.png');

const files = readdirSync(DIR).filter(f => f.endsWith('.png')).sort();
const TILE = 80;        // 64-px icon + 16-px padding/label
const COLS = 8;
const ROWS = Math.ceil(files.length / COLS);
const W = COLS * TILE, H = ROWS * TILE + 4;

const tiles = files.map((f, i) => {
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  const x = col * TILE + 8;
  const y = row * TILE + 6;
  const png = readFileSync(join(DIR, f)).toString('base64');
  const label = f.replace(/\.png$/, '');
  return `<image href="data:image/png;base64,${png}" x="${x}" y="${y}" width="64" height="64"/>
  <text x="${x + 32}" y="${y + 76}" font-family="monospace" font-size="8" fill="#a8b0c0" text-anchor="middle">${label}</text>`;
}).join('\n  ');

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect x="0" y="0" width="${W}" height="${H}" fill="#0a0d14"/>
  ${tiles}
</svg>
`;
await bakeFile(svg, OUT, { width: W, height: H });
console.log(`✓ wrote ${OUT}`);
