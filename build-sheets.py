"""One-shot — build 3 contact-sheet PNGs for Clay's MEE6-style assets.

Outputs into the repo root so they're easy to attach.
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

# ── theme ─────────────────────────────────────────────────────────────────
BG          = (10, 13, 24)        # #0a0d18 dark navy
FG          = (220, 221, 230)     # #dcdde6 off-white
DIM         = (140, 144, 160)
BORDER      = (26, 32, 48)        # #1a2030
TITLE_BG    = (16, 20, 36)
PAD         = 16
TITLE_H     = 56
LABEL_H     = 28

ROOT      = Path(r"C:\Users\bishe\Desktop\Aquilo\Loadout")
SPRITE    = ROOT / "aquilo-gg" / "sprites"
WELCOME   = SPRITE / "welcome"
BADGES    = SPRITE / "progression" / "badges"
FSBOT     = Path(r"C:\Users\bishe\Desktop\Aquilo\FS Bot\previews")
OUT_WELCOME = ROOT / "welcome-sheet.png"
OUT_BADGES  = ROOT / "badges-sheet.png"
OUT_FSBOT   = ROOT / "fsbot-cards-sheet.png"

# ── fonts ─────────────────────────────────────────────────────────────────
def load_font(size: int) -> ImageFont.ImageFont:
    for candidate in (
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

FONT_TITLE = load_font(22)
FONT_LABEL = load_font(11)
FONT_LABEL_BIG = load_font(13)

# ── helpers ───────────────────────────────────────────────────────────────
def text_size(draw, text, font):
    try:
        l, t, r, b = draw.textbbox((0, 0), text, font=font)
        return r - l, b - t
    except Exception:
        return draw.textsize(text, font=font)

def fit_image(im: Image.Image, max_w: int, max_h: int) -> Image.Image:
    """Resize preserving aspect to fit within max_w × max_h."""
    w, h = im.size
    if w == 0 or h == 0:
        return im
    scale = min(max_w / w, max_h / h, 1.0) if (w > max_w or h > max_h) else min(max_w / w, max_h / h)
    new_w = max(1, int(w * scale))
    new_h = max(1, int(h * scale))
    if (new_w, new_h) == (w, h):
        return im
    return im.resize((new_w, new_h), Image.LANCZOS)

def draw_title_strip(canvas, draw, title: str):
    draw.rectangle([0, 0, canvas.width, TITLE_H], fill=TITLE_BG)
    draw.line([(0, TITLE_H - 1), (canvas.width, TITLE_H - 1)], fill=BORDER)
    tw, th = text_size(draw, title, FONT_TITLE)
    draw.text(((canvas.width - tw) // 2, (TITLE_H - th) // 2 - 1), title, fill=FG, font=FONT_TITLE)

def draw_label_centered(draw, text: str, cx: int, cy: int, font, max_w: int):
    """Truncate-with-ellipsis label if it overflows."""
    s = text
    while True:
        tw, _ = text_size(draw, s, font)
        if tw <= max_w or len(s) <= 4:
            break
        s = s[:-2] + "…" if not s.endswith("…") else s[:-2]
    tw, th = text_size(draw, s, font)
    draw.text((cx - tw // 2, cy - th // 2), s, fill=FG, font=font)

# ── 1. welcome-sheet.png — 2 backdrops side by side ──────────────────────
def build_welcome():
    # The pixel art "aquilo-welcome-card.png" was retired 2026-06-15;
    # the welcome embed now uses the bird mark at
    # aquilo-gg/sprites/brand/aquilo-bird.png. Contact sheet shows the
    # bird mark + the rules header that still ships unchanged.
    items = [
        (SPRITE / "brand" / "aquilo-bird.png", "aquilo-bird.png"),
        (WELCOME / "aquilo-rules-header.png", "aquilo-rules-header.png"),
    ]
    total_w = 1400
    cell_w = (total_w - PAD * 3) // 2     # PAD on left, between, right
    cell_h = 420                           # max height per cell
    # Compute the actual scaled heights to decide canvas height.
    scaled = []
    for path, lbl in items:
        if not path.exists():
            scaled.append((None, lbl, cell_w, cell_h))
            continue
        im = Image.open(path).convert("RGBA")
        fitted = fit_image(im, cell_w - 4, cell_h - 4)
        scaled.append((fitted, lbl, fitted.size[0], fitted.size[1]))
    max_h = max((h for _, _, _, h in scaled), default=cell_h)
    cell_box_h = max_h + 4
    canvas_h = TITLE_H + PAD + cell_box_h + LABEL_H + PAD
    canvas = Image.new("RGB", (total_w, canvas_h), BG)
    draw = ImageDraw.Draw(canvas)
    draw_title_strip(canvas, draw, "Welcome backdrops (2) — aquilo-gg/sprites/welcome/")
    y = TITLE_H + PAD
    x = PAD
    for fitted, lbl, w, h in scaled:
        # cell border box
        box_r = x + cell_w
        box_b = y + cell_box_h
        draw.rectangle([x, y, box_r - 1, box_b - 1], outline=BORDER, width=1)
        if fitted is not None:
            # center image inside the cell box
            ix = x + (cell_w - w) // 2
            iy = y + (cell_box_h - h) // 2
            canvas.paste(fitted, (ix, iy), fitted)
        # label
        label_cx = x + cell_w // 2
        label_cy = box_b + LABEL_H // 2
        draw_label_centered(draw, lbl, label_cx, label_cy, FONT_LABEL_BIG, cell_w - 8)
        x += cell_w + PAD
    canvas.save(OUT_WELCOME, optimize=True)
    return OUT_WELCOME

# ── 2. badges-sheet.png — 47 PNGs in 8×6 grid ────────────────────────────
def build_badges():
    paths = sorted(BADGES.glob("*.png"))
    n = len(paths)
    cols = 8
    rows = (n + cols - 1) // cols
    cell_w = 140        # img max 120 + padding
    cell_h = 140
    canvas_w = PAD + cols * (cell_w + PAD)
    canvas_h = TITLE_H + PAD + rows * (cell_h + LABEL_H + PAD) + PAD
    canvas = Image.new("RGB", (canvas_w, canvas_h), BG)
    draw = ImageDraw.Draw(canvas)
    draw_title_strip(canvas, draw, f"Progression badges ({n}) — sprites/progression/badges/")
    for i, p in enumerate(paths):
        col = i % cols
        row = i // cols
        x = PAD + col * (cell_w + PAD)
        y = TITLE_H + PAD + row * (cell_h + LABEL_H + PAD)
        # cell border
        draw.rectangle([x, y, x + cell_w - 1, y + cell_h - 1], outline=BORDER, width=1)
        try:
            im = Image.open(p).convert("RGBA")
            fitted = fit_image(im, cell_w - 12, cell_h - 12)
            ix = x + (cell_w - fitted.size[0]) // 2
            iy = y + (cell_h - fitted.size[1]) // 2
            canvas.paste(fitted, (ix, iy), fitted)
        except Exception as e:
            print(f"  ! skipped {p.name}: {e}")
        # label below
        label_text = p.stem
        draw_label_centered(draw, label_text, x + cell_w // 2,
                            y + cell_h + LABEL_H // 2, FONT_LABEL, cell_w - 4)
    canvas.save(OUT_BADGES, optimize=True)
    return OUT_BADGES, n

# ── 3. fsbot-cards-sheet.png — FS Bot/previews/ result cards ──────────────
def build_fsbot():
    paths = sorted(FSBOT.glob("*.png"))
    n = len(paths)
    cols = 4
    rows = (n + cols - 1) // cols
    cell_w = 300       # img max 280 + padding
    cell_h = 200       # cards are roughly 16:9-ish; let them breathe vertically
    canvas_w = PAD + cols * (cell_w + PAD)
    canvas_h = TITLE_H + PAD + rows * (cell_h + LABEL_H + PAD) + PAD
    canvas = Image.new("RGB", (canvas_w, canvas_h), BG)
    draw = ImageDraw.Draw(canvas)
    draw_title_strip(canvas, draw, f"FS Bot result cards ({n}) — FS Bot/previews/")
    label_prefix_re = re.compile(r"^\d+_")
    for i, p in enumerate(paths):
        col = i % cols
        row = i // cols
        x = PAD + col * (cell_w + PAD)
        y = TITLE_H + PAD + row * (cell_h + LABEL_H + PAD)
        draw.rectangle([x, y, x + cell_w - 1, y + cell_h - 1], outline=BORDER, width=1)
        try:
            im = Image.open(p).convert("RGBA")
            fitted = fit_image(im, cell_w - 12, cell_h - 12)
            ix = x + (cell_w - fitted.size[0]) // 2
            iy = y + (cell_h - fitted.size[1]) // 2
            canvas.paste(fitted, (ix, iy), fitted)
        except Exception as e:
            print(f"  ! skipped {p.name}: {e}")
        label_text = label_prefix_re.sub("", p.stem)   # "32_level_up" → "level_up"
        draw_label_centered(draw, label_text, x + cell_w // 2,
                            y + cell_h + LABEL_H // 2, FONT_LABEL_BIG, cell_w - 4)
    canvas.save(OUT_FSBOT, optimize=True)
    return OUT_FSBOT, n

if __name__ == "__main__":
    print("Building welcome-sheet ...")
    p1 = build_welcome()
    print(f"  -> {p1}  ({p1.stat().st_size:,} bytes)")

    print("Building badges-sheet ...")
    p2, n2 = build_badges()
    print(f"  -> {p2}  ({p2.stat().st_size:,} bytes, {n2} cells)")

    print("Building fsbot-cards-sheet ...")
    p3, n3 = build_fsbot()
    print(f"  -> {p3}  ({p3.stat().st_size:,} bytes, {n3} cells)")
