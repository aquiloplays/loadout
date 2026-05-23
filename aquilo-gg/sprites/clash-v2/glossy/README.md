# Glossy Clash assets

Post-pixel art for Loadout. Source format is SVG (gradients, bevels,
glossy highlights, rarity glows are native). Browsers serve SVG
directly; any consumer that needs raster bakes via Sharp / Resvg /
ImageMagick / Inkscape.

## Pipeline

```
tools/glossy-art-kit.mjs        ← shared defs (palette, gradients, filters)
tools/build-clash-glossy.mjs    ← Clash building generator
tools/build-clash-troops-glossy.mjs   (Wave 2 — pending)
tools/build-clash-decorations-glossy.mjs   (Wave 2 — pending)
```

Run: `node tools/build-clash-glossy.mjs`.

## Output layout

```
aquilo-gg/sprites/clash-v2/glossy/
├── buildings/
│   ├── townhall-L1.svg          ← Wave 1 (shipped)
│   ├── wall-L1.svg
│   ├── cannon-L1.svg
│   ├── archerTower-L1.svg
│   ├── storage-L1.svg
│   ├── barracks-L1.svg
│   ├── buildersHut-L1.svg
│   └── warTent-L1.svg
├── troops/                       ← Wave 2 (pending)
├── decorations/                  ← Wave 2 (pending)
└── backdrop/                     ← Wave 2 (pending)
```

## Vendoring to aquilo.gg

Same model as the existing PNGs: the `aquilo-site` Pages repo
vendors `aquilo-gg/sprites/clash-v2/glossy/` into
`public/sprites/clash-v2/glossy/`. Manual push required — Clay owns
that Pages project.

## Switching the worker to glossy paths

The worker currently emits `clash-v2/buildings/<kind>-L<level>.png`
via `spriteIdForBuildingV2` in `discord-bot/clash-content.js`.
When the aquilo-site mirror has the glossy assets live, flip that
function to return `clash-v2/glossy/buildings/<kind>-L1.svg`
(per-level glossy levels are deferred to a later wave; L1 art reused
across levels is fine until then).
