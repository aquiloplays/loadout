// Glossy Art Kit — the shared visual foundation for the post-pixel
// art style. Everything else (Clash buildings, gear, character,
// overlays, DLL UI) references this module so the whole library
// stays visually coherent.
//
// House style: Clash-of-Clans / App-Store premium game-icon idiom.
// Rich saturated palettes, real depth, gloss highlights, soft
// drop shadows, rarity glows. No pixel art, no emoji as assets.
//
// Format: SVG source-of-truth. Browsers serve SVG natively; any
// consumer that needs raster bakes via tools/bake-glossy.mjs (or
// the consumer's own pipeline — sharp, resvg, ImageMagick, etc).
//
// Authoring pattern: each asset module imports this kit, calls
// `svgWrapper({width, height, body, ...})`, and writes the result.
// `body` is a string of SVG markup that uses the gradient/filter
// IDs from `sharedDefs()` via `url(#id)` references.

// ── Palette ──────────────────────────────────────────────────────
//
// Saturated, glossy-friendly. Each family carries a base (mid),
// hi (upper-left lighting), lo (shadow), and a stroke (outline).
// Use `.hi`/`.lo` for gradient stops, `.stroke` for the crisp
// outline ring, `.base` as the dominant tone.

export const PALETTE = {
  // Earth tones — buildings, woodwork, terrain
  wood:    { hi: '#C99560', base: '#A06A36', lo: '#6E4621', stroke: '#3B240F' },
  stone:   { hi: '#C9CCD4', base: '#9298A4', lo: '#5E6471', stroke: '#262B36' },
  brick:   { hi: '#CE684D', base: '#9C4231', lo: '#6A2618', stroke: '#321009' },
  thatch:  { hi: '#E3B563', base: '#B0832F', lo: '#79581B', stroke: '#3C2A0A' },
  // Cool tones — defenses, metals
  steel:   { hi: '#A0B0BE', base: '#6F8190', lo: '#3F4D5A', stroke: '#171E27' },
  iron:    { hi: '#6B7080', base: '#43485A', lo: '#21253A', stroke: '#0B0E1C' },
  copper:  { hi: '#E2A172', base: '#B36839', lo: '#7A3F1B', stroke: '#3A1A07' },
  // Vibrant accents
  gold:    { hi: '#FFD970', base: '#E5AC1F', lo: '#9F7505', stroke: '#3F2D01' },
  ruby:    { hi: '#FF7A8C', base: '#D62E48', lo: '#8C1428', stroke: '#3B0510' },
  emerald: { hi: '#5BDD96', base: '#1FA561', lo: '#0E6C3D', stroke: '#04361E' },
  sapphire:{ hi: '#5A9EF7', base: '#235FCB', lo: '#103480', stroke: '#04143B' },
  amethyst:{ hi: '#B581FF', base: '#7E47D6', lo: '#4C2289', stroke: '#1A0840' },
  // Vegetation / nature
  leaf:    { hi: '#7BD15A', base: '#3D9226', lo: '#1F5712', stroke: '#0A2A06' },
  sky:     { hi: '#A8D9FF', base: '#5FA8E8', lo: '#2C6BB0', stroke: '#0C2D4F' },
  // UI shades
  dark:    { hi: '#3A4250', base: '#222937', lo: '#10141C', stroke: '#04060A' },
  cream:   { hi: '#FFF6D8', base: '#F1DDA4', lo: '#B19D6E', stroke: '#5A4A20' },
  ink:     '#0A0D14',          // neutral dark outline when colour-neutral needed
  white:   '#FFFFFF',
};

// Rarity tints — used by rarityGlow + accent rings on collectables.
export const RARITY = {
  common:    { glow: '#9298A4', ring: '#C9CCD4', label: '#475467' },
  uncommon:  { glow: '#3D9226', ring: '#5BDD96', label: '#1F5712' },
  rare:      { glow: '#235FCB', ring: '#5A9EF7', label: '#103480' },
  epic:      { glow: '#7E47D6', ring: '#B581FF', label: '#4C2289' },
  legendary: { glow: '#E5AC1F', ring: '#FFD970', label: '#7A4F00' },
  mythic:    { glow: '#D62E48', ring: '#FF7A8C', label: '#8C1428' },
};

// ── Shared defs ──────────────────────────────────────────────────
//
// Returns a `<defs>...</defs>` block to inline at the top of every
// SVG. IDs are namespaced with `gk-` (glossy-kit) so per-asset
// gradient defs can use plain ids without colliding.
//
// Provided defs:
//   gk-shadow-soft       feGaussianBlur drop-shadow filter
//   gk-bevel             feSpecularLighting + composite (subtle bevel/emboss)
//   gk-gloss             white-arc upper-left highlight gradient
//   gk-contact-shadow    radial gradient for the under-asset ellipse
//   gk-rarity-<r>        radial glow per rarity
//   gradient defs for every PALETTE family: gk-grad-<family>

export function sharedDefs() {
  const palGrads = Object.entries(PALETTE)
    .filter(([_, v]) => typeof v === 'object' && v.hi)
    .map(([name, p]) => `
    <linearGradient id="gk-grad-${name}" x1="0.2" y1="0.1" x2="0.85" y2="0.95">
      <stop offset="0"   stop-color="${p.hi}"/>
      <stop offset="0.55" stop-color="${p.base}"/>
      <stop offset="1"   stop-color="${p.lo}"/>
    </linearGradient>
    <radialGradient id="gk-rgrad-${name}" cx="0.35" cy="0.25" r="0.85">
      <stop offset="0"    stop-color="${p.hi}"/>
      <stop offset="0.55" stop-color="${p.base}"/>
      <stop offset="1"    stop-color="${p.lo}"/>
    </radialGradient>`).join('\n');
  const rarityGlows = Object.entries(RARITY).map(([name, r]) => `
    <radialGradient id="gk-rarity-${name}" cx="0.5" cy="0.55" r="0.55">
      <stop offset="0"   stop-color="${r.glow}" stop-opacity="0.85"/>
      <stop offset="0.6" stop-color="${r.glow}" stop-opacity="0.35"/>
      <stop offset="1"   stop-color="${r.glow}" stop-opacity="0"/>
    </radialGradient>`).join('\n');

  return `<defs>
    <!-- soft drop shadow -->
    <filter id="gk-shadow-soft" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="3"/>
      <feOffset dx="0" dy="3" result="b"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.55"/></feComponentTransfer>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <!-- subtle bevel/emboss via specular lighting -->
    <filter id="gk-bevel" x="-10%" y="-10%" width="120%" height="120%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="2" result="blur"/>
      <feSpecularLighting in="blur" surfaceScale="3" specularConstant="0.6"
                          specularExponent="20" lighting-color="#ffffff" result="spec">
        <feDistantLight azimuth="135" elevation="55"/>
      </feSpecularLighting>
      <feComposite in="spec" in2="SourceAlpha" operator="in" result="specMasked"/>
      <feComposite in="SourceGraphic" in2="specMasked" operator="arithmetic"
                   k1="0" k2="1" k3="1" k4="0"/>
    </filter>
    <!-- gloss highlight — white→transparent, upper-left -->
    <linearGradient id="gk-gloss" x1="0" y1="0" x2="0.7" y2="0.9">
      <stop offset="0"    stop-color="#FFFFFF" stop-opacity="0.85"/>
      <stop offset="0.55" stop-color="#FFFFFF" stop-opacity="0.18"/>
      <stop offset="1"    stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient>
    <!-- contact-shadow ellipse fill (dark→transparent radial) -->
    <radialGradient id="gk-contact-shadow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0"   stop-color="#000000" stop-opacity="0.55"/>
      <stop offset="0.7" stop-color="#000000" stop-opacity="0.15"/>
      <stop offset="1"   stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    ${palGrads}
    ${rarityGlows}
  </defs>`;
}

// ── Building blocks ──────────────────────────────────────────────

// Soft contact-shadow ellipse, sits beneath the asset.
export function contactShadow({ cx, cy, rx, ry }) {
  return `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#gk-contact-shadow)"/>`;
}

// Rarity glow backing — sits BEHIND the asset, ahead of background.
// Pass the bounding box of the asset; the glow is a 1.15× ellipse.
export function rarityGlow({ rarity, cx, cy, rx, ry }) {
  if (!RARITY[rarity]) return '';
  return `<ellipse cx="${cx}" cy="${cy}" rx="${rx * 1.18}" ry="${ry * 1.18}" fill="url(#gk-rarity-${rarity})"/>`;
}

// Upper-left gloss arc — overlay near the top of any rounded body.
// `path` should be a rounded-rect or ellipse top arc; `opacity` 0.5–0.9.
export function glossArc({ d, opacity = 0.75 }) {
  return `<path d="${d}" fill="url(#gk-gloss)" opacity="${opacity}" pointer-events="none"/>`;
}

// Crisp dark outline ring. Pass an SVG path; we double-stroke it
// (slightly wider dark behind, slightly narrower base on top) for
// the "inked" look. Width relative to a 256-px canvas.
export function inkedStroke({ d, width = 4, color = PALETTE.ink, fill = 'none' }) {
  return `<path d="${d}" fill="${fill}" stroke="${color}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"/>`;
}

// Inner accent ring/detail — used for door frames, window trims,
// gem settings. `color` defaults to the gold-glow.
export function accentRing({ d, color = PALETTE.gold.hi, width = 2, opacity = 0.95 }) {
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round" opacity="${opacity}"/>`;
}

// ── Full-file wrapper ────────────────────────────────────────────
//
// Returns a complete `<svg>...</svg>` string ready to write to disk.
// `body` is the per-asset markup; we inline the shared defs at the
// top so the file is self-contained (no cross-file <use href>).
//
// Conventions:
//   • viewBox is always "0 0 W H" — caller picks W/H
//   • Default 256×256 for buildings, 192×192 for troops/icons
//   • shape-rendering="geometricPrecision" for clean curves

export function svgWrapper({ width = 256, height = 256, body, title = '', desc = '' }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"
     shape-rendering="geometricPrecision">
${title ? `  <title>${title}</title>\n` : ''}${desc ? `  <desc>${desc}</desc>\n` : ''}  ${sharedDefs()}
  ${body}
</svg>
`;
}

// ── Convenience: a rounded-rect with full glossy treatment ───────
//
// A common pattern — a chunky body with the standard glossy
// treatment baked in. Returns the SVG markup for the shape +
// outline + gloss. Caller is responsible for placing it.

export function glossyRoundedRect({
  x, y, w, h, r = 10,
  gradient = 'gk-grad-wood',
  outline = PALETTE.ink,
  outlineWidth = 4,
  glossOpacity = 0.7,
}) {
  const inset = outlineWidth * 0.5;
  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" ry="${r}"
          fill="url(#${gradient})"
          stroke="${outline}" stroke-width="${outlineWidth}"/>
    <path d="M ${x + inset} ${y + r}
             Q ${x + inset} ${y + inset} ${x + r} ${y + inset}
             L ${x + w - r} ${y + inset}
             Q ${x + w - inset} ${y + inset} ${x + w - inset} ${y + r}
             L ${x + w - inset} ${y + h * 0.42}
             Q ${x + w * 0.5} ${y + h * 0.55} ${x + inset} ${y + h * 0.42}
             Z"
          fill="url(#gk-gloss)" opacity="${glossOpacity}" pointer-events="none"/>`;
}

// Glossy ellipse / dome — for cannon barrels, gem domes, etc.
export function glossyEllipse({ cx, cy, rx, ry, gradient = 'gk-grad-steel', outline = PALETTE.ink, outlineWidth = 4, glossOpacity = 0.7 }) {
  return `
    <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}"
             fill="url(#${gradient})" stroke="${outline}" stroke-width="${outlineWidth}"/>
    <path d="M ${cx - rx * 0.85} ${cy - ry * 0.1}
             A ${rx * 0.85} ${ry * 0.7} 0 0 1 ${cx + rx * 0.65} ${cy - ry * 0.7}
             A ${rx * 0.7} ${ry * 0.4} 0 0 1 ${cx - rx * 0.85} ${cy - ry * 0.1} Z"
          fill="url(#gk-gloss)" opacity="${glossOpacity}" pointer-events="none"/>`;
}

// ── Banner / pennant flag ────────────────────────────────────────
//
// Hangs off a flagpole. Used for townhall, warTent, victory icons.
export function glossyBanner({ x, y, w = 36, h = 24, gradient = 'gk-grad-ruby' }) {
  const tipX = x + w;
  const tipY = y + h * 0.5;
  return `
    <path d="M ${x} ${y} L ${tipX - 8} ${y} L ${tipX} ${tipY} L ${tipX - 8} ${y + h} L ${x} ${y + h} Z"
          fill="url(#${gradient})" stroke="${PALETTE.ink}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M ${x + 2} ${y + 2} L ${tipX - 9} ${y + 2} L ${x + w * 0.6} ${y + h * 0.5} L ${x + 2} ${y + h * 0.5} Z"
          fill="url(#gk-gloss)" opacity="0.55" pointer-events="none"/>`;
}

// ── Flagpole ─────────────────────────────────────────────────────
export function flagpole({ x, yTop, yBottom, width = 4 }) {
  return `<rect x="${x - width/2}" y="${yTop}" width="${width}" height="${yBottom - yTop}" rx="${width/2}" fill="url(#gk-grad-wood)" stroke="${PALETTE.ink}" stroke-width="2"/>`;
}

// ── Window / door ───────────────────────────────────────────────
//
// Small accent shapes the building modules can drop in.
export function archedWindow({ cx, cy, w, h, glowColor = PALETTE.gold.hi }) {
  const halfW = w * 0.5;
  return `
    <path d="M ${cx - halfW} ${cy + h/2}
             L ${cx - halfW} ${cy - h/2 + halfW}
             A ${halfW} ${halfW} 0 0 1 ${cx + halfW} ${cy - h/2 + halfW}
             L ${cx + halfW} ${cy + h/2} Z"
          fill="${glowColor}" stroke="${PALETTE.ink}" stroke-width="2.5"/>
    <path d="M ${cx - halfW + 1} ${cy + h/2 - 1}
             L ${cx - halfW + 1} ${cy - h/2 + halfW}
             A ${halfW - 1} ${halfW - 1} 0 0 1 ${cx + halfW - 1} ${cy - h/2 + halfW}
             L ${cx + halfW - 1} ${cy - h/4} Z"
          fill="url(#gk-gloss)" opacity="0.45"/>`;
}

export function door({ cx, yBottom, w, h, frameColor = PALETTE.wood.lo }) {
  const x = cx - w/2;
  const y = yBottom - h;
  return `
    <path d="M ${x} ${yBottom}
             L ${x} ${y + w * 0.5}
             A ${w * 0.5} ${w * 0.5} 0 0 1 ${x + w} ${y + w * 0.5}
             L ${x + w} ${yBottom} Z"
          fill="url(#gk-grad-wood)" stroke="${PALETTE.ink}" stroke-width="3"/>
    <circle cx="${cx + w * 0.25}" cy="${y + h * 0.65}" r="2.5" fill="${PALETTE.gold.hi}" stroke="${PALETTE.ink}" stroke-width="1"/>`;
}

// ── Helper: dim a body for "damaged" / "destroyed" overlays ──────
// Returns markup to OVERLAY on top of the building body.
export function damageOverlay({ x, y, w, h, level = 'damaged' }) {
  if (level === 'destroyed') {
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#000000" opacity="0.55"/>
            <path d="M ${x} ${y + h * 0.7} L ${x + w * 0.5} ${y + h * 0.3} L ${x + w} ${y + h * 0.85}"
                  fill="none" stroke="#FF3B3B" stroke-width="3" opacity="0.85"/>`;
  }
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#000000" opacity="0.22"/>`;
}
