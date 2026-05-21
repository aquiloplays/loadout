// Sanity test for the pure-JS PNG codec — decode + encode round trip
// of a real generated sprite, then composite two layers.
//
// Run from repo root:
//   node discord-bot/test/test-png-codec.mjs

import { readFile, writeFile } from 'node:fs/promises';
import { decodePng, encodePng, compose } from '../png-codec.js';

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + label + (detail ? ' (' + detail + ')' : '')); }
  else      { failed++; console.log('  FAIL  ' + label + (detail ? ' -- ' + detail : '')); }
}

console.log('--- png-codec ---');

const buf = await readFile(new URL('../../aquilo-gg/sprites/figure/body-slim-tan.png', import.meta.url));
const decoded = await decodePng(buf);
ok('decode body-slim-tan dims',  decoded.width === 40 && decoded.height === 56, `${decoded.width}x${decoded.height}`);
ok('decode produced RGBA pixels', decoded.pixels.length === 40 * 56 * 4);

// Spot-check transparency at corner (the canvas is mostly transparent
// outside the figure footprint).
const cornerAlpha = decoded.pixels[3];
ok('top-left corner is transparent', cornerAlpha === 0);

// Spot-check the head area should have non-zero alpha.
const headIdx = (20 * 40 + 20) * 4;   // roughly mid-head
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
// canvas — composite output should equal the body input.
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

console.log('--- ' + passed + ' pass, ' + failed + ' fail ---');
if (failed > 0) process.exit(1);
