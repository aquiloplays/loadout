"""Build one big contact sheet for ~/aquilo-site/branding/.

SVG handling: cairo isn't installed so we pre-render each SVG via
wkhtmltoimage (shipped with the nuttys-fun-tools toolkit) into a
temp PNG, then drop those into the sheet alongside the native
PNGs/GIFs.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageSequence

# ── theme ───────────────────────────────────────────────────────────
BG          = (10, 13, 24)
FG          = (220, 221, 230)
DIM         = (140, 144, 160)
BORDER      = (26, 32, 48)
TITLE_BG    = (16, 20, 36)
SECTION_BG  = (12, 16, 30)

WIDTH       = 1400
PAD         = 18
TITLE_H     = 64
SECTION_H   = 44
LABEL_H     = 26

BRAND  = Path(r"C:\Users\bishe\aquilo-site\branding")
# Output filename overridable via --out so v1 and v2 sheets coexist.
import sys
OUT = Path(sys.argv[sys.argv.index("--out") + 1]) if "--out" in sys.argv \
      else Path(r"C:\Users\bishe\Desktop\Aquilo\Loadout\branding-sheet.png")
WKH    = Path(r"C:\Users\bishe\Desktop\Streamerbot\nuttys-fun-tools\game-boy-camera\print-tools\wkhtmltoimage.exe")
SVG_CACHE = Path(tempfile.mkdtemp(prefix="svg_cache_"))

# ── fonts ───────────────────────────────────────────────────────────
def load_font(size):
    for c in (r"C:\Windows\Fonts\segoeui.ttf", r"C:\Windows\Fonts\arial.ttf"):
        if os.path.exists(c):
            try: return ImageFont.truetype(c, size)
            except Exception: continue
    return ImageFont.load_default()

FONT_TITLE   = load_font(24)
FONT_SECTION = load_font(15)
FONT_LABEL   = load_font(12)

# ── helpers ─────────────────────────────────────────────────────────
def text_size(draw, text, font):
    try:
        l, t, r, b = draw.textbbox((0, 0), text, font=font)
        return r - l, b - t
    except Exception:
        return draw.textsize(text, font=font)

def fit(im, max_w, max_h):
    w, h = im.size
    if w == 0 or h == 0: return im
    s = min(max_w / w, max_h / h)
    nw, nh = max(1, int(w * s)), max(1, int(h * s))
    if (nw, nh) == (w, h): return im
    return im.resize((nw, nh), Image.LANCZOS)

def render_svg(svg_path: Path, w: int, h: int, bg=None) -> Image.Image:
    """SVG → Pillow via wkhtmltoimage. `bg` defaults to the section
    color; pass a tuple to override (e.g. white for dark-on-light logos)."""
    if bg is None:
        bg = SECTION_BG
    out_png = SVG_CACHE / (svg_path.stem + f"_{w}x{h}_{bg[0]}{bg[1]}{bg[2]}.png")
    if out_png.exists():
        return Image.open(out_png).convert("RGBA")
    html_path = SVG_CACHE / (svg_path.stem + f"_{bg[0]}{bg[1]}{bg[2]}.html")
    src_url = "file:///" + str(svg_path).replace("\\", "/")
    html_path.write_text(f"""<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{{margin:0;padding:0;background:rgb({bg[0]},{bg[1]},{bg[2]});width:{w}px;height:{h}px;}}
body{{display:flex;align-items:center;justify-content:center;}}
img{{max-width:90%;max-height:90%;display:block;}}
</style></head>
<body><img src="{src_url}"></body></html>""", encoding="utf-8")
    cmd = [
        str(WKH),
        "--enable-local-file-access",
        "--width", str(w), "--height", str(h),
        "--quality", "100",
        str(html_path), str(out_png),
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0 or not out_png.exists():
        # Fallback: render a placeholder cell with the filename
        ph = Image.new("RGBA", (w, h), SECTION_BG + (255,))
        d = ImageDraw.Draw(ph)
        d.text((10, h // 2 - 8), f"[SVG: {svg_path.name}]", fill=DIM, font=FONT_LABEL)
        return ph
    return Image.open(out_png).convert("RGBA")

def first_frame(gif_path: Path) -> Image.Image:
    """GIF → PIL frame 0 (preserves transparency)."""
    im = Image.open(gif_path)
    for f in ImageSequence.Iterator(im):
        return f.convert("RGBA")
    return im.convert("RGBA")

# ── canvas growth: build sections as separate sub-canvases first ────
def make_section(label: str, sub: Image.Image) -> Image.Image:
    """Stack a section-label strip on top of a sub-canvas."""
    out = Image.new("RGB", (sub.width, SECTION_H + sub.height), BG)
    d = ImageDraw.Draw(out)
    d.rectangle([0, 0, out.width, SECTION_H], fill=SECTION_BG)
    d.line([(0, SECTION_H - 1), (out.width, SECTION_H - 1)], fill=BORDER)
    d.text((PAD, SECTION_H // 2 - 9), label, fill=FG, font=FONT_SECTION)
    out.paste(sub, (0, SECTION_H))
    return out

def draw_cell(canvas, x, y, w, h, image: Image.Image | None, label: str):
    d = ImageDraw.Draw(canvas)
    d.rectangle([x, y, x + w - 1, y + h - 1], outline=BORDER, width=1)
    if image is not None:
        fitted = fit(image, w - 8, h - 8)
        canvas.paste(fitted, (x + (w - fitted.width) // 2,
                              y + (h - fitted.height) // 2),
                     fitted if fitted.mode == "RGBA" else None)
    # label centered below the cell
    lw, lh = text_size(d, label, FONT_LABEL)
    if lw > w - 8:
        # truncate
        while lw > w - 8 and len(label) > 4:
            label = label[:-2] + "…"
            lw, lh = text_size(d, label, FONT_LABEL)
    d.text((x + (w - lw) // 2, y + h + (LABEL_H - lh) // 2 - 1),
           label, fill=FG, font=FONT_LABEL)

# ── section builders ────────────────────────────────────────────────
def section_mee6():
    p = BRAND / "mee6-welcome-banner.png"
    im = Image.open(p).convert("RGBA")
    cell_w = WIDTH - 2 * PAD
    cell_h = int(cell_w * im.height / im.width)
    sub = Image.new("RGB", (WIDTH, PAD + cell_h + LABEL_H + PAD), BG)
    draw_cell(sub, PAD, PAD, cell_w, cell_h, im,
              "mee6-welcome-banner.png — what MEE6 stamps onto every new-joiner card")
    return make_section("MEE6 welcome banner — mee6-welcome-banner.png", sub)

def section_channels():
    files = ["banner-twitch.png", "banner-kick.png", "banner-x.png",
             "banner-youtube.png", "banner-patreon.png"]
    cols, rows = 2, 3
    cell_w = (WIDTH - PAD * (cols + 1)) // cols
    cell_h = int(cell_w / 4.0)   # banners ~4:1
    sub_h = PAD + rows * (cell_h + LABEL_H + PAD)
    sub = Image.new("RGB", (WIDTH, sub_h), BG)
    for i, fn in enumerate(files):
        c, r = i % cols, i // cols
        x = PAD + c * (cell_w + PAD)
        y = PAD + r * (cell_h + LABEL_H + PAD)
        try:    im = Image.open(BRAND / fn).convert("RGBA")
        except: im = None
        draw_cell(sub, x, y, cell_w, cell_h, im, fn)
    return make_section("Channel banners (5) — banner-*.png", sub)

def section_discord():
    # Row 1: discord-banner.png + discord-profile-banner.png (large)
    # Row 2: 4 section dividers
    top = ["discord-banner.png", "discord-profile-banner.png"]
    bot = ["discord-section-invite.png", "discord-section-moderation.png",
           "discord-section-rules.png", "discord-section-welcome.png"]
    cw_top = (WIDTH - PAD * 3) // 2
    ch_top = int(cw_top * 240 / 960)   # Discord banner is roughly 960×240
    cw_bot = (WIDTH - PAD * 5) // 4
    ch_bot = int(cw_bot * 120 / 540)   # section dividers are ~540×120
    sub_h = PAD + ch_top + LABEL_H + PAD + ch_bot + LABEL_H + PAD
    sub = Image.new("RGB", (WIDTH, sub_h), BG)
    for i, fn in enumerate(top):
        x = PAD + i * (cw_top + PAD)
        y = PAD
        try:    im = Image.open(BRAND / fn).convert("RGBA")
        except: im = None
        draw_cell(sub, x, y, cw_top, ch_top, im, fn)
    y2 = PAD + ch_top + LABEL_H + PAD
    for i, fn in enumerate(bot):
        x = PAD + i * (cw_bot + PAD)
        try:    im = Image.open(BRAND / fn).convert("RGBA")
        except: im = None
        draw_cell(sub, x, y2, cw_bot, ch_bot, im, fn.replace("discord-section-", ""))
    return make_section("Discord — banner + profile banner + 4 section dividers", sub)

def section_panels():
    panels_dir = BRAND / "panels"
    files = sorted(p.name for p in panels_dir.glob("*.png"))
    cols = 4
    rows = (len(files) + cols - 1) // cols
    cell_w = (WIDTH - PAD * (cols + 1)) // cols
    cell_h = int(cell_w * 9 / 16)   # ~16:9 Twitch panel
    sub_h = PAD + rows * (cell_h + LABEL_H + PAD)
    sub = Image.new("RGB", (WIDTH, sub_h), BG)
    for i, fn in enumerate(files):
        c, r = i % cols, i // cols
        x = PAD + c * (cell_w + PAD)
        y = PAD + r * (cell_h + LABEL_H + PAD)
        try:    im = Image.open(panels_dir / fn).convert("RGBA")
        except: im = None
        draw_cell(sub, x, y, cell_w, cell_h, im, fn.replace("panel-", ""))
    return make_section(f"Twitch panels ({len(files)}) — panels/*.png", sub)

def section_emotes():
    # Row 1: 6 static emotes at 112px
    # Row 2: 3 animated emotes (frame 0 from the 112 gif)
    static_emotes = ["aquiCOFFEE", "aquiF", "aquiHEART",
                     "aquiLUL", "aquiPOG", "aquiSUS"]
    animated     = ["aquiBOLT", "aquiGG", "aquiHYPE"]
    cell = 140   # cell square
    s_dir = BRAND / "emotes" / "static"
    a_dir = BRAND / "emotes" / "animated"
    # Static row: 6 cells centered
    cols1 = 6
    row1_w = cols1 * cell + (cols1 + 1) * PAD
    # Animated row: 3 cells centered
    cols2 = 3
    row2_w = cols2 * cell + (cols2 + 1) * PAD
    sub_h = PAD + cell + LABEL_H + PAD + cell + LABEL_H + PAD
    sub = Image.new("RGB", (WIDTH, sub_h), BG)
    ox1 = (WIDTH - row1_w) // 2
    for i, name in enumerate(static_emotes):
        x = ox1 + PAD + i * (cell + PAD)
        y = PAD
        try:    im = Image.open(s_dir / f"{name}-112.png").convert("RGBA")
        except: im = None
        draw_cell(sub, x, y, cell, cell, im, name)
    ox2 = (WIDTH - row2_w) // 2
    y2 = PAD + cell + LABEL_H + PAD
    for i, name in enumerate(animated):
        x = ox2 + PAD + i * (cell + PAD)
        try:    im = first_frame(a_dir / f"{name}-112.gif")
        except Exception as e:
            print("  ! animated emote skipped:", name, e)
            im = None
        draw_cell(sub, x, y2, cell, cell, im, f"{name} (frame 0)")
    return make_section("Emotes — 6 static + 3 animated (sized 112px)", sub)

def section_logos():
    # 6 SVGs at consistent ~110px height — wordmarks are wider, monograms square.
    # Use the streamfusion png-export (no svg rasterizer needed for it).
    # wordmark-dark is meant to sit on a LIGHT background; render it on
    # white so the dark glyphs are visible in the sheet. Everything else
    # gets the section-color backdrop.
    WHITE = (245, 245, 247)
    items = [
        ("logo-icon.svg",          "monogram",                    None),
        ("logo-icon-apple.svg",    "apple-touch",                 None),
        ("logo-wordmark-dark.svg", "wordmark / dark (on white)",  WHITE),
        ("logo-wordmark-light.svg","wordmark / light",            None),
        ("streamfusion-logo.svg",  "streamfusion (via png-export)", None),
        ("profile-frame.svg",      "profile frame",               None),
    ]
    cols = 3
    rows = 2
    cell_w = (WIDTH - PAD * (cols + 1)) // cols
    cell_h = 160
    sub_h = PAD + rows * (cell_h + LABEL_H + PAD)
    sub = Image.new("RGB", (WIDTH, sub_h), BG)
    for i, (fn, label, bg) in enumerate(items):
        c, r = i % cols, i // cols
        x = PAD + c * (cell_w + PAD)
        y = PAD + r * (cell_h + LABEL_H + PAD)
        if fn == "streamfusion-logo.svg":
            im = Image.open(BRAND / "png-exports" / "streamfusion-logo-512.png").convert("RGBA")
        else:
            im = render_svg(BRAND / fn, cell_w - 8, cell_h - 8, bg=bg)
        draw_cell(sub, x, y, cell_w, cell_h, im, f"{fn}  ({label})")
    return make_section("Logos — 6 SVGs (rasterised via wkhtmltoimage; streamfusion uses pre-baked png-export)", sub)

# ── glue ────────────────────────────────────────────────────────────
def build():
    print("Pre-rendering SVGs ...")
    sections = []
    print("  building MEE6 banner section")
    sections.append(section_mee6())
    print("  building channel banners")
    sections.append(section_channels())
    print("  building Discord")
    sections.append(section_discord())
    print("  building Twitch panels")
    sections.append(section_panels())
    print("  building emotes")
    sections.append(section_emotes())
    print("  building logos (SVG render via wkh)")
    sections.append(section_logos())

    total_h = TITLE_H + sum(s.height for s in sections)
    canvas = Image.new("RGB", (WIDTH, total_h), BG)
    d = ImageDraw.Draw(canvas)
    d.rectangle([0, 0, WIDTH, TITLE_H], fill=TITLE_BG)
    d.line([(0, TITLE_H - 1), (WIDTH, TITLE_H - 1)], fill=BORDER)
    title = "aquilo.gg branding — ~/aquilo-site/branding/  (palette v2, " + \
            ("2026-05-26" if "v2" in str(OUT) else "v1") + ")"
    tw, th = text_size(d, title, FONT_TITLE)
    d.text(((WIDTH - tw) // 2, (TITLE_H - th) // 2 - 1), title, fill=FG, font=FONT_TITLE)
    y = TITLE_H
    for s in sections:
        canvas.paste(s, (0, y))
        y += s.height
    canvas.save(OUT, optimize=True)
    return OUT

if __name__ == "__main__":
    p = build()
    sz = p.stat().st_size
    print(f"\n  -> {p}  ({sz:,} bytes)")
    im = Image.open(p)
    print(f"     dimensions: {im.size[0]}x{im.size[1]}")
