// Visual QA for per-level progression, pick a few representative
// kinds and show L1 → L10 side by side so it's obvious each level
// looks distinct.

import { readFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { bake, bakeFile } from './bake-glossy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DIR  = join(ROOT, 'aquilo-gg/sprites/clash-v2/glossy/buildings');
const OUT  = join(__dirname, '_qa-sheets/levels.png');

const KINDS = ['townhall', 'cannon', 'storage', 'sawmill', 'mageTower', 'warTent', 'goldVault', 'archerTower'];
const TILE = 144;
const ROW_H = TILE + 32;
const COL_W = TILE + 6;
const W = 10 * COL_W + 88, H = KINDS.length * ROW_H + 12;

const tiles = [];
for (let r = 0; r < KINDS.length; r++) {
  const kind = KINDS[r];
  tiles.push(`<text x="6" y="${r * ROW_H + TILE/2 + 6}" font-family="monospace" font-size="11" fill="#cfd8e4">${kind}</text>`);
  for (let lvl = 1; lvl <= 10; lvl++) {
    const file = join(DIR, `${kind}-L${lvl}.svg`);
    const svgText = readFileSync(file, 'utf8');
    const pngBuf = await bake(svgText, { width: TILE, height: TILE });
    const data = `data:image/png;base64,${pngBuf.toString('base64')}`;
    const x = 88 + (lvl - 1) * COL_W;
    const y = r * ROW_H + 6;
    tiles.push(`<image href="${data}" x="${x}" y="${y}" width="${TILE}" height="${TILE}"/>`);
    if (r === 0) tiles.push(`<text x="${x + TILE/2}" y="${y + TILE + 14}" font-family="monospace" font-size="10" fill="#cfd8e4" text-anchor="middle">L${lvl}</text>`);
  }
}
const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect x="0" y="0" width="${W}" height="${H}" fill="#1c2030"/>
  ${tiles.join('\n  ')}
</svg>`;
await bakeFile(svg, OUT, { width: W, height: H });
console.log(`✓ wrote ${OUT}`);
