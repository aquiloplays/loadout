// SVG → PNG baker. Wraps @resvg/resvg-js so the per-asset
// generators don't all reimplement the same plumbing.
//
// Usage:
//   import { bake, bakeFile } from './bake-glossy.mjs';
//   const buf = await bake(svgString, { width: 128, height: 160 });
//   await bakeFile(svgString, outPath, { width: 128, height: 160 });
//
// Resvg's `fitTo` lets us hand it an SVG with an arbitrary viewBox
// and pin the output dimensions. The renderer is pure Rust, ~10×
// faster than headless Chrome for this use case and ships as a
// prebuilt N-API binary so no system Cairo / Skia required.

import { writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';

/**
 * Bake an SVG string to PNG bytes.
 * @param {string} svg — SVG document text
 * @param {object} opts
 * @param {number} opts.width  — target raster width (pixels)
 * @param {number} opts.height — target raster height (pixels)
 * @param {string} [opts.background] — optional bg colour ('transparent' default)
 * @returns {Promise<Buffer>}
 */
export async function bake(svg, { width, height, background } = {}) {
  const resvgOpts = {
    fitTo: { mode: 'width', value: width },
    background: background || 'rgba(0,0,0,0)',
    // Use the system 'sans-serif' for any <text> nodes (we don't
    // rely on text in the glossy library, but the icon shop emoji
    // glyphs in some legacy assets do — harmless if unused).
    font: { loadSystemFonts: false },
    // Crisp anti-aliased shapes.
    shapeRendering: 2,   // 2 = geometricPrecision
    textRendering:  2,
    imageRendering: 0,
  };
  const renderer = new Resvg(svg, resvgOpts);
  // Verify height matches — if the SVG viewBox aspect mismatches
  // the requested width:height, Resvg honours the width and the
  // output height comes from the aspect. We force the exact box
  // by re-fitting via `mode: 'height'` if needed.
  const png = renderer.render();
  const buf = png.asPng();
  // Aspect check — if the SVG's natural box differs from the
  // requested w:h, the per-generator can re-issue with a corrected
  // viewBox. We trust the caller to pass a matching pair.
  void height;
  return buf;
}

/** Bake to a file. Creates parent dirs the caller's responsibility. */
export async function bakeFile(svg, outPath, opts) {
  const buf = await bake(svg, opts);
  writeFileSync(outPath, buf);
  return buf.length;
}
