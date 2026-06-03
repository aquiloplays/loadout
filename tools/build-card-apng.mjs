// Stitch Boltbound legendary card frames into APNGs.
//
//   pwsh tools/build-card-sprites.ps1
//   node tools/build-card-apng.mjs
//
// PowerShell + GDI+ can't emit APNG natively, so build-card-sprites.ps1
// drops per-frame PNGs in aquilo-gg/sprites/_card-legendary-frames/.
// This script reads them back, encodes the APNG via the same
// png-codec.js the Worker uses, writes to aquilo-gg/sprites/cards/<id>.png
// (overwriting the static-frame placeholder), and cleans up the
// intermediates.
//
// Symmetric with tools/build-apng.mjs (for gear fx), kept separate so
// the two pipelines can evolve independently.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodeApng } from '../discord-bot/png-codec.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const framesDir = path.join(repoRoot, 'aquilo-gg/sprites/_card-legendary-frames');
const cardDir   = path.join(repoRoot, 'aquilo-gg/sprites/cards');

await fs.mkdir(cardDir, { recursive: true });

let entries;
try {
  entries = await fs.readdir(framesDir);
} catch (e) {
  if (e.code === 'ENOENT') {
    console.log('No _card-legendary-frames directory, nothing to do.');
    process.exit(0);
  }
  throw e;
}

// Group frame files by cardId: "<cardId>-fx-<N>.png". cardId itself
// contains a dot (leg.solara), so we anchor on the literal "-fx-".
const groups = new Map();
for (const f of entries) {
  const m = /^(.+)-fx-(\d+)\.png$/.exec(f);
  if (!m) continue;
  const cardId = m[1];
  const idx    = parseInt(m[2], 10);
  if (!groups.has(cardId)) groups.set(cardId, []);
  groups.get(cardId).push({ idx, file: f });
}

if (groups.size === 0) {
  console.log('No card legendary frame PNGs found in', framesDir);
  process.exit(0);
}

let total = 0;
for (const [cardId, list] of groups) {
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
      throw new Error(`apng: frame dims mismatch for ${cardId}`);
    }
  }
  const apng = await encodeApng({
    width, height,
    fps: 6,
    frames: decoded.map(d => d.pixels),
  });
  const out = path.join(cardDir, `${cardId}.png`);
  await fs.writeFile(out, apng);
  console.log(`  ${cardId}: ${decoded.length} frames → ${path.relative(repoRoot, out)} (${apng.length}B)`);
  total++;
}

await fs.rm(framesDir, { recursive: true, force: true });

console.log(`Done, ${total} card APNG(s) written.`);
