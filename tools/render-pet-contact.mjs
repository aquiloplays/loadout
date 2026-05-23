// Render-test: contact sheet of all 32 pets + 3 moods so we can
// eyeball the pet catalogue at a glance.
//
// Output: tools/_render-pet-contact/_grid.png

import { mkdirSync, readFileSync, readdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { bakeFile } from './bake-glossy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PET_DIR = join(ROOT, 'aquilo-gg/sprites/pet/glossy');
const OUT_DIR = join(ROOT, 'tools/_render-pet-contact');
mkdirSync(OUT_DIR, { recursive: true });

const W = 128, H = 160;
const COLS = 4;

const files = readdirSync(PET_DIR).filter(f => f.endsWith('.png')).sort();
const ROWS = Math.ceil(files.length / COLS);
const GRID_W = COLS * W;
const GRID_H = ROWS * (H + 14);

const tiles = files.map((f, i) => {
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  const x = col * W;
  const y = row * (H + 14);
  const png = readFileSync(join(PET_DIR, f)).toString('base64');
  return `
    <image href="data:image/png;base64,${png}" x="${x}" y="${y}" width="${W}" height="${H}"/>
    <text x="${x + 4}" y="${y + H + 11}" font-family="monospace" font-size="10" fill="#ddd">${f.replace('.png','')}</text>`;
}).join('\n');

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID_W} ${GRID_H}" width="${GRID_W}" height="${GRID_H}">
  <rect x="0" y="0" width="${GRID_W}" height="${GRID_H}" fill="#0a0d14"/>
  ${tiles}
</svg>`;

await bakeFile(svg, join(OUT_DIR, '_grid.png'), { width: GRID_W, height: GRID_H });
console.log(`✓ ${files.length} pets → ${OUT_DIR}/_grid.png`);
