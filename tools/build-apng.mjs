// Stitch legendary fx halo frame PNGs into APNGs.
//
//   pwsh tools/build-sprites.ps1 -OutRoot aquilo-gg/sprites
//   node tools/build-apng.mjs
//
// PowerShell + GDI+ can't emit APNG natively, so the .ps1 leaves
// per-frame PNGs in aquilo-gg/sprites/_legendary-frames/, and this
// Node script reads them back, encodes the APNG via the same
// png-codec.js the Worker uses, writes to gear/fx/<slug>.png, and
// cleans up the frame intermediates.
//
// Add a new legendary by updating $LEGENDARIES in build-sprites.ps1
// (the catalogue here is derived from the on-disk frame layout, so
// this script doesn't need to be edited when adding new pieces).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodeApng } from '../discord-bot/png-codec.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const framesDir = path.join(repoRoot, 'aquilo-gg/sprites/_legendary-frames');
const fxDir     = path.join(repoRoot, 'aquilo-gg/sprites/gear/fx');

await fs.mkdir(fxDir, { recursive: true });

let entries;
try {
  entries = await fs.readdir(framesDir);
} catch (e) {
  if (e.code === 'ENOENT') {
    console.log('No _legendary-frames directory found — nothing to do.');
    process.exit(0);
  }
  throw e;
}

// Group frame files by slug: "<slug>-fx-<N>.png"
const groups = new Map();
for (const f of entries) {
  const m = /^(.+)-fx-(\d+)\.png$/.exec(f);
  if (!m) continue;
  const slug = m[1];
  const idx  = parseInt(m[2], 10);
  if (!groups.has(slug)) groups.set(slug, []);
  groups.get(slug).push({ idx, file: f });
}

if (groups.size === 0) {
  console.log('No legendary frame PNGs found in', framesDir);
  process.exit(0);
}

let total = 0;
for (const [slug, list] of groups) {
  list.sort((a, b) => a.idx - b.idx);
  const decoded = [];
  for (const { file } of list) {
    const buf = await fs.readFile(path.join(framesDir, file));
    const img = await decodePng(new Uint8Array(buf));
    decoded.push(img);
  }
  const { width, height } = decoded[0];
  for (const img of decoded) {
    if (img.width !== width || img.height !== height) {
      throw new Error(`apng: frame dims mismatch for ${slug}`);
    }
  }
  const apng = await encodeApng({
    width, height,
    fps: 8,
    frames: decoded.map(d => d.pixels),
  });
  const out = path.join(fxDir, `${slug}.png`);
  await fs.writeFile(out, apng);
  console.log(`  ${slug}: ${decoded.length} frames → ${path.relative(repoRoot, out)} (${apng.length}B)`);
  total++;
}

// Clean up intermediates
await fs.rm(framesDir, { recursive: true, force: true });

console.log(`Done — ${total} legendary APNG(s) written.`);
