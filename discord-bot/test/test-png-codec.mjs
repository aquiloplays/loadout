// Sanity test for the pure-JS PNG codec, decode + encode round trip
// of a real generated sprite, then composite two layers.
//
// Run from repo root:
//   node discord-bot/test/test-png-codec.mjs

import { readFile, writeFile } from 'node:fs/promises';
import { decodePng, encodePng, compose, encodeApng } from '../png-codec.js';

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + label + (detail ? ' (' + detail + ')' : '')); }
  else      { failed++; console.log('  FAIL  ' + label + (detail ? ' -- ' + detail : '')); }
}

console.log('--- png-codec ---');

const buf = await readFile(new URL('../../aquilo-gg/sprites/figure/body-slim-tan.png', import.meta.url));
const decoded = await decodePng(buf);
ok('decode body-slim-tan dims',  decoded.width === 64 && decoded.height === 80, `${decoded.width}x${decoded.height}`);
ok('decode produced RGBA pixels', decoded.pixels.length === 64 * 80 * 4);

// Spot-check transparency at corner (the canvas is mostly transparent
// outside the figure footprint).
const cornerAlpha = decoded.pixels[3];
ok('top-left corner is transparent', cornerAlpha === 0);

// Spot-check the head area should have non-zero alpha. Head sits
// around (32, 28) on the 64×80 HD canvas.
const headIdx = (28 * 64 + 32) * 4;
ok('head area has pixels', decoded.pixels[headIdx + 3] > 0);

// Round trip: decode → encode → decode and compare pixels.
const reEncoded = await encodePng(decoded);
const reDecoded = await decodePng(reEncoded);
ok('round-trip dims preserved',
   reDecoded.width === decoded.width && reDecoded.height === decoded.height);
let mismatches = 0;
for (let i = 0; i < decoded.pixels.length; i++) {
  if (decoded.pixels[i] !== reDecoded.pixels[i]) mismatches++;
}
ok('round-trip pixels match',  mismatches === 0, `mismatches=${mismatches}`);

// Compose: layer the body on top of an empty (fully transparent)
// canvas, composite output should equal the body input.
const empty = {
  width: decoded.width,
  height: decoded.height,
  pixels: new Uint8Array(decoded.width * decoded.height * 4),  // all zero
};
const composed = compose([empty, decoded]);
let composeMismatches = 0;
for (let i = 0; i < decoded.pixels.length; i++) {
  if (decoded.pixels[i] !== composed.pixels[i]) composeMismatches++;
}
ok('compose [empty, body] equals body', composeMismatches === 0, `mismatches=${composeMismatches}`);

// Save the composed PNG to /tmp for eyeballing if desired.
const composedPng = await encodePng(composed);
await writeFile('/tmp/test-compose-out.png', composedPng).catch(() => {});

// ── APNG encoder ─────────────────────────────────────────────────
// Build a 3-frame APNG out of three flat-colour 4×4 canvases and
// confirm the chunk layout (acTL + per-frame fcTL + IDAT/fdAT).
const frame = (r, g, b) => {
  const px = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
  }
  return px;
};
const apng = await encodeApng({
  width: 4, height: 4, fps: 4,
  frames: [frame(255, 0, 0), frame(0, 255, 0), frame(0, 0, 255)],
});
// Scan chunk types
const chunkTypes = [];
let p = 8;
while (p < apng.length) {
  const len = (apng[p] << 24 >>> 0) + (apng[p + 1] << 16) + (apng[p + 2] << 8) + apng[p + 3];
  const type = String.fromCharCode(apng[p + 4], apng[p + 5], apng[p + 6], apng[p + 7]);
  chunkTypes.push(type);
  p += 8 + len + 4;
  if (type === 'IEND') break;
}
ok('apng has acTL chunk',          chunkTypes.includes('acTL'));
ok('apng has fcTL chunk',          chunkTypes.includes('fcTL'));
ok('apng has fdAT chunk',          chunkTypes.includes('fdAT'));
ok('apng has 3 fcTL (one per frame)',
   chunkTypes.filter(c => c === 'fcTL').length === 3);
ok('apng has 1 IDAT + 2 fdAT',
   chunkTypes.filter(c => c === 'IDAT').length === 1 &&
   chunkTypes.filter(c => c === 'fdAT').length === 2);
// First-frame fallback should decode as a 4×4 red square
const fallback = await decodePng(apng);
ok('apng frame-0 fallback decodes',
   fallback.width === 4 && fallback.height === 4 &&
   fallback.pixels[0] === 255 && fallback.pixels[1] === 0 && fallback.pixels[2] === 0);

console.log('--- ' + passed + ' pass, ' + failed + ' fail ---');
if (failed > 0) process.exit(1);
