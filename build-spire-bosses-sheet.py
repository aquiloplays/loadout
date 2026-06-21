"""Build a 12-row x 4-col contact sheet for Spire boss Pro Ultra batch.

Layout: 12 rows (one per theme); 4 thumbnails per row at 256x256 (v1, v2, v3, CHOSEN).
CHOSEN tile has gold border + label. Each variant tile labeled with its seed at the bottom.
The chosen tile is labeled with the reasoning truncated to ~50 chars.
"""
from __future__ import annotations

import os
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

# ── theme ─────────────────────────────────────────────────────────────────
BG          = (24, 26, 32)        # dark navy
FG          = (220, 221, 230)
DIM         = (140, 144, 160)
ROW_BG      = (32, 36, 46)
TILE_BG     = (16, 18, 24)
BORDER      = (50, 56, 70)
GOLD        = (212, 175, 55)
GOLD_DIM    = (130, 105, 30)
LABEL_BG    = (12, 14, 20)

THUMB       = 256
LABEL_H     = 28               # seed / reasoning strip at bottom of each tile
TILE_PAD    = 8
ROW_PAD_Y   = 12
TITLE_H     = 64
ROW_LABEL_W = 200

OUT_PATH = Path(r"C:\Users\bishe\Desktop\Aquilo\Loadout\spire-bosses-ultra-sheet.png")
SRC_DIR  = Path(r"C:\tmp\paper-doll\spire-bosses-ultra")

# 12 boss themes, in the order originally generated (idx 0..11)
BOSSES = [
    {
        "theme": "ember-court",
        "variants": [
            {"id": "v1", "filepath": SRC_DIR / "boss__ember-court__v1.png", "keyed_clean": True},
            {"id": "v2", "filepath": SRC_DIR / "boss__ember-court__v2.png", "keyed_clean": False},
            {"id": "v3", "filepath": SRC_DIR / "boss__ember-court__v3.png", "keyed_clean": True},
        ],
        "chosen_id": "v3",
        "chosen": SRC_DIR / "boss__ember-court.png",
        "reasoning": "v2 not keyed; v3 won opaque=2430555 dist=200.7",
    },
    {
        "theme": "aurora-spire",
        "variants": [
            {"id": "v1", "filepath": SRC_DIR / "boss__aurora-spire__v1.png", "keyed_clean": True},
            {"id": "v2", "filepath": SRC_DIR / "boss__aurora-spire__v2.png", "keyed_clean": True},
            {"id": "v3", "filepath": SRC_DIR / "boss__aurora-spire__v3.png", "keyed_clean": True},
        ],
        "chosen_id": "v2",
        "chosen": SRC_DIR / "boss__aurora-spire.png",
        "reasoning": "all keyed; v2 largest opaque 1903713 (biggest aurora)",
    },
    {
        "theme": "sunken-vault",
        "variants": [
            {"id": "v1", "filepath": SRC_DIR / "boss__sunken-vault__v1.png", "keyed_clean": False},
            {"id": "v2", "filepath": SRC_DIR / "boss__sunken-vault__v2.png", "keyed_clean": True},
            {"id": "v3", "filepath": SRC_DIR / "boss__sunken-vault__v3.png", "keyed_clean": True},
        ],
        "chosen_id": "v2",
        "chosen": SRC_DIR / "boss__sunken-vault.png",
        "reasoning": "v1 not keyed; v2 won opaque=1240937 dist=156.0",
    },
    {
        "theme": "verdant-hollow",
        "variants": [
            {"id": "v1", "filepath": SRC_DIR / "boss__verdant-hollow__v1.png", "keyed_clean": True},
            {"id": "v2", "filepath": SRC_DIR / "boss__verdant-hollow__v2.png", "keyed_clean": True},
            {"id": "v3", "filepath": SRC_DIR / "boss__verdant-hollow__v3.png", "keyed_clean": True},
        ],
        "chosen_id": "v3",
        "chosen": SRC_DIR / "boss__verdant-hollow.png",
        "reasoning": "all keyed; v3 largest opaque 1255812",
    },
    {
        "theme": "sandstorm-bazaar",
        "variants": [
            {"id": "v1", "filepath": SRC_DIR / "boss__sandstorm-bazaar__v1.png", "keyed_clean": True},
            {"id": "v2", "filepath": SRC_DIR / "boss__sandstorm-bazaar__v2.png", "keyed_clean": True},
            {"id": "v3", "filepath": SRC_DIR / "boss__sandstorm-bazaar__v3.png", "keyed_clean": True},
        ],
        "chosen_id": "v1",
        "chosen": SRC_DIR / "boss__sandstorm-bazaar.png",
        "reasoning": "all keyed; v1 largest opaque 1186404 (biggest djinn)",
    },
    {
        "theme": "frost-citadel",
        "variants": [
            {"id": "v1", "filepath": SRC_DIR / "boss__frost-citadel__v1.png", "keyed_clean": True},
            {"id": "v2", "filepath": SRC_DIR / "boss__frost-citadel__v2.png", "keyed_clean": True},
            {"id": "v3", "filepath": SRC_DIR / "boss__frost-citadel__v3.png", "keyed_clean": True},
        ],
        "chosen_id": "v2",
        "chosen": SRC_DIR / "boss__frost-citadel.png",
        "reasoning": "all keyed; v2 largest opaque 2213089 dist=136.5",
    },
    {
        "theme": "clockwork-foundry",
        "variants": [
            {"id": "v1", "filepath": SRC_DIR / "boss__clockwork-foundry__v1.png", "keyed_clean": True},
            {"id": "v2", "filepath": SRC_DIR / "boss__clockwork-foundry__v2.png", "keyed_clean": True},
            {"id": "v3", "filepath": SRC_DIR / "boss__clockwork-foundry__v3.png", "keyed_clean": True},
        ],
        "chosen_id": "v3",
        "chosen": SRC_DIR / "boss__clockwork-foundry.png",
        "reasoning": "all keyed; v3 largest opaque 1845180",
    },
    {
        "theme": "mirror-garden",
        "variants": [
            {"id": "v1", "filepath": SRC_DIR / "boss__mirror-garden__v1.png", "keyed_clean": True},
            {"id": "v2", "filepath": SRC_DIR / "boss__mirror-garden__v2.png", "keyed_clean": True},
            {"id": "v3", "filepath": SRC_DIR / "boss__mirror-garden__v3.png", "keyed_clean": True},
        ],
        "chosen_id": "v1",
        "chosen": SRC_DIR / "boss__mirror-garden.png",
        "reasoning": "all keyed; v1 largest opaque 2211669 (fullest cloak)",
    },
    {
        "theme": "bone-reliquary",
        "variants": [
            {"id": "v1", "filepath": SRC_DIR / "boss__bone-reliquary__v1.png", "keyed_clean": True},
            {"id": "v2", "filepath": SRC_DIR / "boss__bone-reliquary__v2.png", "keyed_clean": True},
            {"id": "v3", "filepath": SRC_DIR / "boss__bone-reliquary__v3.png", "keyed_clean": True},
        ],
        "chosen_id": "v2",
        "chosen": SRC_DIR / "boss__bone-reliquary.png",
        "reasoning": "all keyed; v2 largest opaque 1274318 (most imposing lich)",
    },
    {
        "theme": "cinder-apex",
        "variants": [
            {"id": "v1", "filepath": SRC_DIR / "boss__cinder-apex__v1.png", "keyed_clean": True},
            {"id": "v2", "filepath": SRC_DIR / "boss__cinder-apex__v2.png", "keyed_clean": True},
            {"id": "v3", "filepath": SRC_DIR / "boss__cinder-apex__v3.png", "keyed_clean": True},
        ],
        "chosen_id": "v3",
        "chosen": SRC_DIR / "boss__cinder-apex.png",
        "reasoning": "all keyed; v3 largest opaque 2199126 (magma-lord)",
    },
    {
        "theme": "stargazer-court",
        "variants": [
            {"id": "v1", "filepath": SRC_DIR / "boss__stargazer-court__v1.png", "keyed_clean": True},
            {"id": "v2", "filepath": SRC_DIR / "boss__stargazer-court__v2.png", "keyed_clean": True},
            {"id": "v3", "filepath": SRC_DIR / "boss__stargazer-court__v3.png", "keyed_clean": True},
        ],
        "chosen_id": "v2",
        "chosen": SRC_DIR / "boss__stargazer-court.png",
        "reasoning": "all keyed; v2 largest opaque 1440874 dist=126.8",
    },
    {
        "theme": "velvet-catacomb",
        "variants": [
            {"id": "v1", "filepath": SRC_DIR / "boss__velvet-catacomb__v1.png", "keyed_clean": True},
            {"id": "v2", "filepath": SRC_DIR / "boss__velvet-catacomb__v2.png", "keyed_clean": True},
            {"id": "v3", "filepath": SRC_DIR / "boss__velvet-catacomb__v3.png", "keyed_clean": True},
        ],
        "chosen_id": "v3",
        "chosen": SRC_DIR / "boss__velvet-catacomb.png",
        "reasoning": "all keyed; v3 largest opaque 1691164 dist=171.0",
    },
]


def load_font(size: int) -> ImageFont.ImageFont:
    for candidate in (
        r"C:\Windows\Fonts\segoeuib.ttf",
        r"C:\Windows\Fonts\segoeui.ttf",
        r"C:\Windows\Fonts\arial.ttf",
        r"C:\Windows\Fonts\consola.ttf",
    ):
        if os.path.exists(candidate):
            try:
                return ImageFont.truetype(candidate, size)
            except Exception:
                continue
    return ImageFont.load_default()


FONT_TITLE   = load_font(22)
FONT_ROW     = load_font(15)
FONT_SEED    = load_font(12)
FONT_REASON  = load_font(11)
FONT_CHOSEN  = load_font(12)


def text_w(draw: ImageDraw.ImageDraw, s: str, font) -> int:
    bbox = draw.textbbox((0, 0), s, font=font)
    return bbox[2] - bbox[0]


def text_h(draw: ImageDraw.ImageDraw, s: str, font) -> int:
    bbox = draw.textbbox((0, 0), s, font=font)
    return bbox[3] - bbox[1]


def truncate(s: str, max_chars: int) -> str:
    if len(s) <= max_chars:
        return s
    return s[: max_chars - 1] + "…"


def composite_thumb(src_path: Path) -> Image.Image:
    """Open source image, drop on TILE_BG, scale to THUMB x THUMB."""
    base = Image.new("RGB", (THUMB, THUMB), TILE_BG)
    if not src_path.exists():
        # placeholder if missing
        d = ImageDraw.Draw(base)
        d.text((10, THUMB // 2 - 10), "missing", fill=(200, 80, 80), font=FONT_SEED)
        return base
    img = Image.open(src_path).convert("RGBA")
    # Letterbox fit
    img.thumbnail((THUMB, THUMB), Image.LANCZOS)
    # paste centered using alpha
    off_x = (THUMB - img.width) // 2
    off_y = (THUMB - img.height) // 2
    base.paste(img, (off_x, off_y), img)
    return base


def draw_tile(canvas: Image.Image, x: int, y: int, src: Path, label_top: str,
              label_bottom: str, *, chosen: bool):
    """Draw a tile at (x, y). Tile is THUMB+LABEL_H tall, THUMB wide."""
    tile = composite_thumb(src)
    canvas.paste(tile, (x, y))
    d = ImageDraw.Draw(canvas)

    # label strip below image
    label_y = y + THUMB
    d.rectangle([x, label_y, x + THUMB, label_y + LABEL_H], fill=LABEL_BG)
    # bottom text
    label_color = GOLD if chosen else FG
    tw = text_w(d, label_bottom, FONT_SEED if not chosen else FONT_REASON)
    font_for_label = FONT_REASON if chosen else FONT_SEED
    d.text(
        (x + (THUMB - text_w(d, label_bottom, font_for_label)) // 2, label_y + 7),
        label_bottom,
        fill=label_color,
        font=font_for_label,
    )

    # top corner badge for CHOSEN
    if chosen:
        badge = "CHOSEN"
        bw = text_w(d, badge, FONT_CHOSEN)
        bh = text_h(d, badge, FONT_CHOSEN)
        bx = x + 6
        by = y + 6
        d.rectangle([bx - 4, by - 2, bx + bw + 4, by + bh + 4], fill=GOLD)
        d.text((bx, by), badge, fill=(20, 16, 0), font=FONT_CHOSEN)

    # top-right keyed-clean indicator (handled by caller via label_top)
    if label_top:
        tw2 = text_w(d, label_top, FONT_SEED)
        d.rectangle(
            [x + THUMB - tw2 - 10, y + 6, x + THUMB - 4, y + 6 + text_h(d, label_top, FONT_SEED) + 4],
            fill=(40, 60, 40) if "OK" in label_top else (80, 30, 30),
        )
        d.text(
            (x + THUMB - tw2 - 7, y + 8),
            label_top,
            fill=FG,
            font=FONT_SEED,
        )

    # gold or normal border
    border_color = GOLD if chosen else BORDER
    border_w = 4 if chosen else 1
    for i in range(border_w):
        d.rectangle(
            [x - i - 1, y - i - 1, x + THUMB + i, y + THUMB + LABEL_H + i],
            outline=border_color,
        )


def main():
    cols = 4   # v1, v2, v3, chosen
    rows = 12
    tile_full_w = THUMB
    tile_full_h = THUMB + LABEL_H

    # canvas size
    row_h = tile_full_h + ROW_PAD_Y
    grid_w = ROW_LABEL_W + cols * (tile_full_w + TILE_PAD) + TILE_PAD
    grid_h = TITLE_H + rows * row_h + TILE_PAD * 2

    canvas = Image.new("RGB", (grid_w, grid_h), BG)
    d = ImageDraw.Draw(canvas)

    # title bar
    d.rectangle([0, 0, grid_w, TITLE_H], fill=ROW_BG)
    title = "SPIRE BOSSES — Pro Ultra ×3 shots per theme (36 generated, 12 chosen)"
    d.text(
        (24, (TITLE_H - text_h(d, title, FONT_TITLE)) // 2 - 2),
        title,
        fill=FG,
        font=FONT_TITLE,
    )
    subtitle = "Selection priority: keyed_clean → largest opaque pixel count → centroid distance"
    d.text(
        (grid_w - 24 - text_w(d, subtitle, FONT_SEED), TITLE_H - text_h(d, subtitle, FONT_SEED) - 8),
        subtitle,
        fill=DIM,
        font=FONT_SEED,
    )

    # rows
    y0 = TITLE_H + TILE_PAD
    for ridx, boss in enumerate(BOSSES):
        ry = y0 + ridx * row_h
        # row label background
        d.rectangle([0, ry - 4, ROW_LABEL_W - 4, ry + tile_full_h + 4], fill=ROW_BG)
        # theme name + index
        idx_str = f"{ridx + 1:02d}"
        d.text((12, ry + 8), idx_str, fill=GOLD_DIM, font=FONT_ROW)
        d.text((46, ry + 6), boss["theme"], fill=FG, font=FONT_ROW)
        # secondary line: number keyed clean
        n_clean = sum(1 for v in boss["variants"] if v["keyed_clean"])
        d.text(
            (46, ry + 28),
            f"keyed: {n_clean}/3",
            fill=DIM,
            font=FONT_SEED,
        )
        d.text(
            (46, ry + 46),
            f"chosen: {boss['chosen_id']}",
            fill=GOLD,
            font=FONT_SEED,
        )

        # 4 tiles: v1, v2, v3, chosen
        for cidx in range(cols):
            tx = ROW_LABEL_W + TILE_PAD + cidx * (tile_full_w + TILE_PAD)
            ty = ry
            if cidx < 3:
                v = boss["variants"][cidx]
                # seed pattern: 100000 + idx*10 + variant_index
                seed = 100000 + ridx * 10 + cidx
                label_bottom = f"{v['id']}  seed={seed}"
                label_top = "OK" if v["keyed_clean"] else "FAIL"
                is_chosen_variant = v["id"] == boss["chosen_id"]
                draw_tile(
                    canvas, tx, ty, v["filepath"],
                    label_top=label_top,
                    label_bottom=label_bottom,
                    chosen=False,  # only the 4th col gets the gold treatment
                )
                # mark which variant was the chosen one with a small dot
                if is_chosen_variant:
                    dd = ImageDraw.Draw(canvas)
                    dd.ellipse([tx + THUMB - 14, ty + THUMB - 18, tx + THUMB - 2, ty + THUMB - 6], fill=GOLD)
            else:
                reasoning = truncate(boss["reasoning"], 50)
                draw_tile(
                    canvas, tx, ty, boss["chosen"],
                    label_top="",
                    label_bottom=reasoning,
                    chosen=True,
                )

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(OUT_PATH, "PNG", optimize=True)
    print(f"WROTE {OUT_PATH} ({canvas.width}x{canvas.height})")


if __name__ == "__main__":
    main()
