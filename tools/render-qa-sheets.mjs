// K1, Visual QA contact sheets for the whole glossy library.
//
// One sheet per asset group. SVGs get baked to PNG inline so the
// sheet shows the actual rendered output. Labels under each tile
// for spotting "all these look like the same shape" cases.
//
// Output: tools/_qa-sheets/<group>.png
//
// Run: node tools/render-qa-sheets.mjs

import { mkdirSync, readFileSync, readdirSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { bake, bakeFile } from './bake-glossy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SHEETS_DIR = join(__dirname, '_qa-sheets');
mkdirSync(SHEETS_DIR, { recursive: true });

// Read either an SVG (bake it) or PNG (use directly) and return a
// base64 data URI suitable for <image href="...">.
async function loadAsDataUri(absPath, bakeWidth = 192, bakeHeight = 192) {
  const buf = readFileSync(absPath);
  if (absPath.endsWith('.svg')) {
    const png = await bake(buf.toString('utf8'), { width: bakeWidth, height: bakeHeight });
    return `data:image/png;base64,${png.toString('base64')}`;
  }
  return `data:image/png;base64,${buf.toString('base64')}`;
}

async function makeSheet({ dir, label, tileW = 192, tileH = 192, cols = 6, filter = null, bg = '#1c2030' }) {
  let files;
  try { files = readdirSync(dir).filter(f => /\.(svg|png)$/.test(f)); }
  catch { console.warn('  (no dir)', dir); return; }
  if (filter) files = files.filter(filter);
  files.sort();
  if (!files.length) { console.warn('  (no files)', dir); return; }

  const tileTotal = tileH + 22;  // tile + label band
  const rows = Math.ceil(files.length / cols);
  const W = cols * (tileW + 8) + 8;
  const H = rows * tileTotal + 8;

  const tiles = [];
  for (let i = 0; i < files.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = col * (tileW + 8) + 8;
    const y = row * tileTotal + 8;
    const data = await loadAsDataUri(join(dir, files[i]), tileW, tileH);
    const lbl = files[i].replace(/\.(svg|png)$/, '');
    tiles.push(`<image href="${data}" x="${x}" y="${y}" width="${tileW}" height="${tileH}"/>`);
    tiles.push(`<text x="${x + tileW/2}" y="${y + tileH + 14}" font-family="monospace" font-size="9" fill="#cfd8e4" text-anchor="middle">${lbl}</text>`);
  }
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect x="0" y="0" width="${W}" height="${H}" fill="${bg}"/>
  ${tiles.join('\n  ')}
</svg>`;
  const outPath = join(SHEETS_DIR, `${label}.png`);
  await bakeFile(svg, outPath, { width: W, height: H });
  console.log(`  ${label}: ${files.length} assets → ${outPath}`);
}

console.log('Rendering QA contact sheets...');

// Buildings (32, one tile each)
await makeSheet({
  dir: join(ROOT, 'aquilo-gg/sprites/clash-v2/glossy/buildings'),
  label: 'buildings',
  tileW: 160, tileH: 160, cols: 8,
});

// Troops (20)
await makeSheet({
  dir: join(ROOT, 'aquilo-gg/sprites/clash-v2/glossy/troops'),
  label: 'troops',
  tileW: 144, tileH: 144, cols: 7,
});

// Gear by slot (6 sheets)
for (const slot of ['weapon', 'head', 'chest', 'legs', 'boots', 'trinket']) {
  await makeSheet({
    dir: join(ROOT, 'aquilo-gg/sprites/gear/glossy', slot),
    label: `gear-${slot}`,
    tileW: 128, tileH: 128, cols: 8,
  });
}

// Character figure pieces (split for readability)
await makeSheet({
  dir: join(ROOT, 'aquilo-gg/sprites/figure/glossy'),
  label: 'figure-bodies',
  tileW: 128, tileH: 160, cols: 5,
  filter: (f) => f.startsWith('body-'),
});
await makeSheet({
  dir: join(ROOT, 'aquilo-gg/sprites/figure/glossy'),
  label: 'figure-hair-brown',
  tileW: 128, tileH: 160, cols: 6,
  filter: (f) => f.startsWith('hair-') && f.endsWith('-brown.png'),
});
await makeSheet({
  dir: join(ROOT, 'aquilo-gg/sprites/figure/glossy'),
  label: 'figure-eyes',
  tileW: 128, tileH: 160, cols: 4,
  filter: (f) => f.startsWith('eyes-'),
});
await makeSheet({
  dir: join(ROOT, 'aquilo-gg/sprites/figure/glossy'),
  label: 'figure-accents',
  tileW: 128, tileH: 160, cols: 5,
  filter: (f) => f.startsWith('accent-'),
});

// Pets (35)
await makeSheet({
  dir: join(ROOT, 'aquilo-gg/sprites/pet/glossy'),
  label: 'pets',
  tileW: 128, tileH: 160, cols: 7,
});

// Gear figure layers (the paper-doll bake)
for (const slot of ['weapon', 'head', 'chest', 'legs', 'boots', 'trinket']) {
  const d = join(ROOT, 'aquilo-gg/sprites/gear/figure', slot);
  if (!existsSync(d)) continue;
  await makeSheet({
    dir: d,
    label: `gear-figure-${slot}`,
    tileW: 128, tileH: 160, cols: 8,
  });
}

console.log('\n✓ QA sheets written to', SHEETS_DIR);
