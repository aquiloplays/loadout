"""Procedural damage-number sprite sheet for Boltbound match polish.

Floating combat numbers that pop up when a card takes/deals damage.
Pure-procedural (Pillow only, no Replicate) — a hand-coded 5x7 chunky
pixel font scaled into 16x16 cells, with a 1px dark outline so the
digits stay legible over any board art.

Glyphs:  0 1 2 3 4 5 6 7 8 9 K   (11 glyphs)
          'K' is the thousands suffix for big hits like "12K".
Colors:  red    — damage taken
         green  — heal
         white  — default / neutral

Layout:  one row per color, one column per glyph.
         cell = 16x16, sheet = 11*16 wide x 3*16 tall = 176 x 48.
         Frames are read left-to-right, top-to-bottom in glyph order;
         the client slices 16x16 cells. Index map is written alongside
         as damage-numbers-sheet.json for the renderer.

Output:  /tmp/boltbound-fx/damage-numbers-sheet.png (+ .json)
         (uploaded to KV as pixel-art-boltbound:fx:damage-numbers-sheet.png
          by tools/upload-damage-numbers.py)
"""
from __future__ import annotations
import json
from pathlib import Path
from PIL import Image

CELL = 16          # px per frame
SCALE = 2          # 5x7 font -> 10x14 drawn block (chunky)
GLYPH_W, GLYPH_H = 5, 7

OUT_DIR = Path('/tmp/boltbound-fx')
OUT_DIR.mkdir(parents=True, exist_ok=True)
OUT_PNG = OUT_DIR / 'damage-numbers-sheet.png'
OUT_JSON = OUT_DIR / 'damage-numbers-sheet.json'

# ── 5x7 chunky pixel font ──────────────────────────────────────────
# Each glyph is 7 rows of a 5-char string; '#' = lit pixel, ' ' = off.
FONT = {
    '0': ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
    '1': ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    '2': ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
    '3': ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
    '4': ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
    '5': ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
    '6': ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
    '7': ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
    '8': ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
    '9': ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
    'K': ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
}
GLYPH_ORDER = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'K']

# ── color variants ─────────────────────────────────────────────────
# (fill, outline). Outline is a darker shade of the fill for a bold,
# readable pop. RGBA — transparent background everywhere else.
COLORS = {
    'red':   ((255, 74, 87, 255),   (96, 12, 18, 255)),    # damage taken
    'green': ((86, 230, 122, 255),  (16, 84, 38, 255)),    # heal
    'white': ((245, 245, 250, 255), (40, 40, 60, 255)),    # default
}
COLOR_ORDER = ['red', 'green', 'white']


def draw_glyph(img, cell_x, cell_y, bitmap, fill, outline):
    """Draw a scaled 5x7 bitmap centered in a CELL, with a 1px outline."""
    block_w, block_h = GLYPH_W * SCALE, GLYPH_H * SCALE
    # Center the drawn block within the cell.
    ox = cell_x + (CELL - block_w) // 2
    oy = cell_y + (CELL - block_h) // 2
    px = img.load()

    lit = set()
    for ry, row in enumerate(bitmap):
        for rx, ch in enumerate(row):
            if ch != ' ' and ch != '0':
                # honor both '#'/'1' lit conventions
                if ch in ('#', '1'):
                    for sy in range(SCALE):
                        for sx in range(SCALE):
                            lit.add((ox + rx * SCALE + sx, oy + ry * SCALE + sy))

    # Outline: any 8-neighbour of a lit pixel that isn't itself lit.
    outline_px = set()
    for (x, y) in lit:
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                n = (x + dx, y + dy)
                if n not in lit:
                    outline_px.add(n)

    W, H = img.size
    for (x, y) in outline_px:
        if 0 <= x < W and 0 <= y < H:
            px[x, y] = outline
    for (x, y) in lit:
        if 0 <= x < W and 0 <= y < H:
            px[x, y] = fill


def main():
    cols = len(GLYPH_ORDER)
    rows = len(COLOR_ORDER)
    sheet_w, sheet_h = cols * CELL, rows * CELL
    img = Image.new('RGBA', (sheet_w, sheet_h), (0, 0, 0, 0))

    frames = {}
    for r, color_name in enumerate(COLOR_ORDER):
        fill, outline = COLORS[color_name]
        for c, glyph in enumerate(GLYPH_ORDER):
            cell_x, cell_y = c * CELL, r * CELL
            draw_glyph(img, cell_x, cell_y, FONT[glyph], fill, outline)
            frames[f'{color_name}:{glyph}'] = {
                'x': cell_x, 'y': cell_y, 'w': CELL, 'h': CELL,
            }

    img.save(OUT_PNG)
    meta = {
        'cell': CELL,
        'cols': cols,
        'rows': rows,
        'glyphOrder': GLYPH_ORDER,
        'colorOrder': COLOR_ORDER,
        'frames': frames,
        'kvKey': 'pixel-art-boltbound:fx:damage-numbers-sheet.png',
        'note': 'Slice 16x16 cells. row=color (red/green/white), col=glyph (0-9,K).',
    }
    OUT_JSON.write_text(json.dumps(meta, indent=2))
    size = OUT_PNG.stat().st_size
    print(f'wrote {OUT_PNG}  ({sheet_w}x{sheet_h}, {size} bytes)')
    print(f'wrote {OUT_JSON}  ({len(frames)} frames)')
    if size < 200:
        raise SystemExit('ERROR: PNG suspiciously small — generation failed')


if __name__ == '__main__':
    main()
