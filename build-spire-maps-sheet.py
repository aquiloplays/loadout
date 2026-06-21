"""Build contact sheet for 24 Spire Map sprites (12 bgs + 7 nodes + 5 paths)."""
from PIL import Image, ImageDraw, ImageFont
import os

OUT = r"C:\Users\bishe\Desktop\Aquilo\Loadout\spire-maps-sheet.png"

BG_DIR    = r"C:\tmp\paper-doll\spire-maps\bgs"
NODE_DIR  = r"C:\tmp\paper-doll\spire-maps\nodes"
PATH_DIR  = r"C:\tmp\paper-doll\spire-maps\paths"

BGS = [
    "spire-map-bg__ember-court",
    "spire-map-bg__aurora-spire",
    "spire-map-bg__sunken-vault",
    "spire-map-bg__verdant-hollow",
    "spire-map-bg__sandstorm-bazaar",
    "spire-map-bg__frost-citadel",
    "spire-map-bg__clockwork-foundry",
    "spire-map-bg__mirror-garden",
    "spire-map-bg__bone-reliquary",
    "spire-map-bg__cinder-apex",
    "spire-map-bg__stargazer-court",
    "spire-map-bg__velvet-catacomb",
]
NODES = ["node__combat", "node__elite", "node__rest", "node__shop",
         "node__treasure", "node__event", "node__boss"]
PATHS = ["path__straight", "path__branch-left", "path__branch-right",
         "path__merge-left", "path__merge-right"]

BG_COLOR   = (24, 26, 32)
GOLD       = (212, 175, 90)
GOLD_DIM   = (140, 115, 60)
WHITE      = (235, 235, 235)
MUTED      = (170, 170, 180)
RED        = (220, 60, 60)
MISS_GREY  = (60, 62, 70)

# Chequerboard for path tiles
CHECK_A = (50, 52, 60)
CHECK_B = (80, 82, 92)

MARGIN  = 12
PAD_X   = 32
PAD_Y   = 24

BG_W, BG_H = 256, 455      # 9:16
TILE_W     = 192            # nodes + paths
LABEL_H    = 26

def load_font(size):
    candidates = [
        r"C:\Windows\Fonts\segoeuib.ttf",
        r"C:\Windows\Fonts\arialbd.ttf",
        r"C:\Windows\Fonts\segoeui.ttf",
        r"C:\Windows\Fonts\arial.ttf",
    ]
    for p in candidates:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()

FONT_TITLE   = load_font(28)
FONT_SECTION = load_font(20)
FONT_LABEL   = load_font(12)

def text_size(draw, text, font):
    bbox = draw.textbbox((0, 0), text, font=font)
    return bbox[2] - bbox[0], bbox[3] - bbox[1]

def chequerboard(w, h, sq=12):
    img = Image.new("RGBA", (w, h), CHECK_A + (255,))
    px = img.load()
    for y in range(h):
        for x in range(w):
            if ((x // sq) + (y // sq)) & 1:
                px[x, y] = CHECK_B + (255,)
    return img

def fit(img, box_w, box_h):
    """Fit img inside box preserving aspect, return resized image (no padding)."""
    iw, ih = img.size
    s = min(box_w / iw, box_h / ih)
    nw, nh = max(1, int(iw * s)), max(1, int(ih * s))
    return img.resize((nw, nh), Image.LANCZOS)

def placeholder(w, h, label="MISS"):
    img = Image.new("RGBA", (w, h), MISS_GREY + (255,))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, w - 1, h - 1], outline=GOLD_DIM, width=2)
    tw, th = text_size(d, label, FONT_SECTION)
    d.text(((w - tw) / 2, (h - th) / 2), label, fill=RED, font=FONT_SECTION)
    return img

def load_or_miss(path, w, h):
    if not os.path.exists(path):
        return placeholder(w, h), False
    try:
        return Image.open(path).convert("RGBA"), True
    except Exception:
        return placeholder(w, h), False

# ---- compute layout dims ----
# Section 1: 4 cols x 3 rows of BG tiles
BG_COLS, BG_ROWS = 4, 3
BG_TILE_H = BG_H + LABEL_H
sec1_w = BG_COLS * BG_W + (BG_COLS - 1) * MARGIN
sec1_h = BG_ROWS * BG_TILE_H + (BG_ROWS - 1) * MARGIN

# Section 2: 7 nodes in a row
NODE_COUNT = 7
NODE_TILE_H = TILE_W + LABEL_H
sec2_w = NODE_COUNT * TILE_W + (NODE_COUNT - 1) * MARGIN
sec2_h = NODE_TILE_H

# Section 3: 5 paths in a row
PATH_COUNT = 5
PATH_TILE_H = TILE_W + LABEL_H
sec3_w = PATH_COUNT * TILE_W + (PATH_COUNT - 1) * MARGIN
sec3_h = PATH_TILE_H

content_w = max(sec1_w, sec2_w, sec3_w)
SHEET_W = content_w + PAD_X * 2

TITLE_H    = 70
SECTION_H  = 50
DIVIDER_H  = 18

SHEET_H = (TITLE_H
           + SECTION_H + sec1_h + DIVIDER_H
           + SECTION_H + sec2_h + DIVIDER_H
           + SECTION_H + sec3_h
           + PAD_Y * 2)

sheet = Image.new("RGBA", (SHEET_W, SHEET_H), BG_COLOR + (255,))
draw = ImageDraw.Draw(sheet)

# ---- title ----
title = "SPIRE MAPS  --  24 assets (12 bgs Pro Ultra + 7 nodes Pro + 5 paths Pro)"
tw, th = text_size(draw, title, FONT_TITLE)
draw.text(((SHEET_W - tw) / 2, PAD_Y + 8), title, fill=GOLD, font=FONT_TITLE)
draw.line([(PAD_X, PAD_Y + TITLE_H - 8), (SHEET_W - PAD_X, PAD_Y + TITLE_H - 8)],
          fill=GOLD_DIM, width=2)

y_cursor = PAD_Y + TITLE_H

def draw_section_header(y, text):
    draw.text((PAD_X, y + 10), text, fill=GOLD, font=FONT_SECTION)
    draw.line([(PAD_X, y + SECTION_H - 6), (SHEET_W - PAD_X, y + SECTION_H - 6)],
              fill=GOLD_DIM, width=1)
    return y + SECTION_H

def draw_label(x, y, w, text):
    tw_, th_ = text_size(draw, text, FONT_LABEL)
    if tw_ > w - 4:
        # Truncate with ellipsis
        while text and text_size(draw, text + "...", FONT_LABEL)[0] > w - 4:
            text = text[:-1]
        text = text + "..."
        tw_, th_ = text_size(draw, text, FONT_LABEL)
    draw.text((x + (w - tw_) / 2, y + (LABEL_H - th_) / 2 - 2), text,
              fill=MUTED, font=FONT_LABEL)

# ---- section 1: backgrounds ----
y_cursor = draw_section_header(y_cursor, "1. BACKGROUNDS  -  12 vertical 9:16 spires (Pro Ultra 1536x2752)")
sec1_x0 = (SHEET_W - sec1_w) // 2
for i, bg_id in enumerate(BGS):
    col = i % BG_COLS
    row = i // BG_COLS
    x = sec1_x0 + col * (BG_W + MARGIN)
    y = y_cursor + row * (BG_TILE_H + MARGIN)
    src_path = os.path.join(BG_DIR, bg_id + ".png")
    img, ok = load_or_miss(src_path, BG_W, BG_H)
    if ok:
        img = fit(img, BG_W, BG_H)
        # center within tile
        tx = x + (BG_W - img.size[0]) // 2
        ty = y + (BG_H - img.size[1]) // 2
        # tile background frame
        draw.rectangle([x, y, x + BG_W - 1, y + BG_H - 1], fill=(15, 16, 22, 255))
        sheet.paste(img, (tx, ty), img)
    else:
        sheet.paste(img, (x, y), img)
    draw.rectangle([x, y, x + BG_W - 1, y + BG_H - 1], outline=GOLD_DIM, width=1)
    draw_label(x, y + BG_H, BG_W, bg_id)
y_cursor += sec1_h + DIVIDER_H

# ---- section 2: node icons ----
y_cursor = draw_section_header(y_cursor, "2. NODE ICONS  -  7 keyed-clean Pro icons (1024x1024 -> 192px)")
sec2_x0 = (SHEET_W - sec2_w) // 2
for i, node_id in enumerate(NODES):
    x = sec2_x0 + i * (TILE_W + MARGIN)
    y = y_cursor
    src_path = os.path.join(NODE_DIR, node_id + ".png")
    img, ok = load_or_miss(src_path, TILE_W, TILE_W)
    # node tile background = chequerboard (transparent assets)
    cb = chequerboard(TILE_W, TILE_W)
    sheet.paste(cb, (x, y), cb)
    if ok:
        img = fit(img, TILE_W, TILE_W)
        tx = x + (TILE_W - img.size[0]) // 2
        ty = y + (TILE_W - img.size[1]) // 2
        sheet.paste(img, (tx, ty), img)
    else:
        sheet.paste(img, (x, y), img)
    draw.rectangle([x, y, x + TILE_W - 1, y + TILE_W - 1], outline=GOLD_DIM, width=1)
    draw_label(x, y + TILE_W, TILE_W, node_id)
y_cursor += sec2_h + DIVIDER_H

# ---- section 3: path graphics ----
y_cursor = draw_section_header(y_cursor, "3. PATH GRAPHICS  -  5 Pro path tiles (alpha on chequerboard)")
sec3_x0 = (SHEET_W - sec3_w) // 2
for i, path_id in enumerate(PATHS):
    x = sec3_x0 + i * (TILE_W + MARGIN)
    y = y_cursor
    src_path = os.path.join(PATH_DIR, path_id + ".png")
    img, ok = load_or_miss(src_path, TILE_W, TILE_W)
    cb = chequerboard(TILE_W, TILE_W)
    sheet.paste(cb, (x, y), cb)
    if ok:
        img = fit(img, TILE_W, TILE_W)
        tx = x + (TILE_W - img.size[0]) // 2
        ty = y + (TILE_W - img.size[1]) // 2
        sheet.paste(img, (tx, ty), img)
    else:
        sheet.paste(img, (x, y), img)
    draw.rectangle([x, y, x + TILE_W - 1, y + TILE_W - 1], outline=GOLD_DIM, width=1)
    draw_label(x, y + TILE_W, TILE_W, path_id)

sheet.save(OUT, "PNG", optimize=True)
size = os.path.getsize(OUT)
print(f"WROTE {OUT}")
print(f"DIMS {SHEET_W}x{SHEET_H}")
print(f"BYTES {size}")
assert size > 200000, f"size {size} too small"
print("OK")
