#!/usr/bin/env python3
"""Generate the gradient banner PNGs for the Twitch event embeds.

Per Clay's spec — aquilo palette only (violet / pink / green), 1100x100
(120 for high-impact events), 18px rounded corners, white centred event
label. One PNG per event type, written to:

    discord-bot/assets/twitch-banners/<key>.png

Then the discord-bot worker uploads them to LOADOUT_BOLTS KV under
keys like `twitch-banner:follow` and serves via /asset/twitch-banner/<key>.png.

Run from repo root:
    python build-twitch-banners.py

Idempotent — overwrites existing PNGs every run.
"""

import os
import sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter

# ── Palette (aquilo v2) ──────────────────────────────────────────
VIOLET = (124,  92, 255, 255)   # #7c5cff
PINK   = (255, 106, 181, 255)   # #ff6ab5
GREEN  = ( 91, 255, 149, 255)   # #5bff95
GREY_S = (110, 117, 136, 255)   # #6e7588  (subdued moments)
GREY_D = ( 64,  68,  80, 255)   # #404450  (darker subdued)

# ── Banner spec ──────────────────────────────────────────────────
WIDTH         = 1100
HEIGHT_STD    = 100
HEIGHT_HIGH   = 120     # live / raid / hype / gift
CORNER_RADIUS = 18
LABEL_COLOR   = (255, 255, 255, 255)
LABEL_PT      = 38      # tuned to feel "ribbon-ish" not "billboard"

# ── Catalogue ────────────────────────────────────────────────────
# (key, label, [color stops], height_high?)
# Color stops are placed at evenly-spaced positions across the width.
BANNERS = [
    # — Routine events (100h, two-stop)
    ('follow',            'NEW FOLLOWER',              [VIOLET, PINK],                          False),
    ('sub-t1',            'NEW SUB · TIER 1',          [PINK,   VIOLET],                        False),
    ('sub-t2',            'NEW SUB · TIER 2',          [VIOLET, GREEN],                         False),
    ('sub-t3',            'NEW SUB · TIER 3',          [PINK,   GREEN,  VIOLET],                False),
    ('gift',              'COMMUNITY GIFT',            [GREEN,  VIOLET],                        True),
    ('resub',             'RESUB',                     [PINK,   GREEN,  VIOLET],                False),
    ('cheer',             'CHEER',                     [VIOLET, PINK],                          False),
    # — High-impact (120h, 3+ stops)
    ('raid',              'INCOMING RAID',             [PINK,   VIOLET, GREEN],                 True),
    ('live',              'AQUILO IS LIVE',            [VIOLET, PINK,   VIOLET],                True),
    ('ended',             'STREAM WRAP',               [GREY_S, VIOLET],                        False),
    ('hype',              'HYPE TRAIN',                [VIOLET, PINK,   GREEN, PINK, VIOLET],   True),
    # — Lower-noise events
    ('redemption',        'CHANNEL POINT REDEMPTION',  [VIOLET, PINK],                          False),
    ('poll',              'POLL',                      [PINK,   VIOLET],                        False),
    ('prediction',        'PREDICTION',                [PINK,   VIOLET],                        False),
    # — Moderation (subdued)
    ('ban',               'MOD ACTION',                [GREY_D, GREY_S],                        False),
    ('unban',             'UNBANNED',                  [GREY_S, GREEN],                         False),
]


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(4))


def gradient_horizontal(width, height, stops):
    """Linear horizontal gradient — len(stops) >= 2."""
    img = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    px = img.load()
    seg = len(stops) - 1
    for x in range(width):
        # Which segment?
        t_global = x / max(1, width - 1)
        seg_idx = min(int(t_global * seg), seg - 1)
        t_local = (t_global * seg) - seg_idx
        c = lerp(stops[seg_idx], stops[seg_idx + 1], t_local)
        for y in range(height):
            px[x, y] = c
    return img


def rounded_corner_mask(width, height, radius):
    """Anti-aliased rounded-corner alpha mask (L mode)."""
    # Render at 4x then downsample for AA.
    scale = 4
    mask = Image.new('L', (width * scale, height * scale), 0)
    drw = ImageDraw.Draw(mask)
    drw.rounded_rectangle(
        (0, 0, width * scale, height * scale),
        radius=radius * scale,
        fill=255,
    )
    return mask.resize((width, height), Image.LANCZOS)


def find_font(size):
    """Find a bold sans-serif font — fall back gracefully if not present."""
    candidates = [
        # Windows
        r'C:\Windows\Fonts\segoeuib.ttf',     # Segoe UI Bold
        r'C:\Windows\Fonts\arialbd.ttf',      # Arial Bold
        # cross-platform DejaVu (ships with Pillow on many systems)
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
        # macOS
        '/System/Library/Fonts/HelveticaNeue.ttc',
    ]
    for c in candidates:
        try:
            return ImageFont.truetype(c, size)
        except OSError:
            continue
    print('  ⚠️  no TTF found, falling back to default font')
    return ImageFont.load_default()


def build_banner(key, label, stops, high):
    h = HEIGHT_HIGH if high else HEIGHT_STD
    # 1. Build the gradient fill.
    grad = gradient_horizontal(WIDTH, h, stops)
    # 2. Apply rounded-corner alpha mask.
    mask = rounded_corner_mask(WIDTH, h, CORNER_RADIUS)
    out = Image.new('RGBA', (WIDTH, h), (0, 0, 0, 0))
    out.paste(grad, (0, 0), mask)
    # 3. Drop the centred label with a soft shadow so it pops over the
    #    brighter parts of the gradient.
    draw = ImageDraw.Draw(out)
    font = find_font(LABEL_PT)
    # Pillow text-bbox API: (x0, y0, x1, y1)
    bbox = draw.textbbox((0, 0), label, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    tx = (WIDTH - tw) // 2 - bbox[0]
    ty = (h - th) // 2 - bbox[1]
    # Shadow — render onto its own RGBA so the blur doesn't affect bg.
    shadow_layer = Image.new('RGBA', out.size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow_layer)
    sd.text((tx + 2, ty + 3), label, font=font, fill=(0, 0, 0, 110))
    shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(radius=2))
    out = Image.alpha_composite(out, shadow_layer)
    # Label proper.
    draw = ImageDraw.Draw(out)
    draw.text((tx, ty), label, font=font, fill=LABEL_COLOR)
    return out


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.join(here, 'discord-bot', 'assets', 'twitch-banners')
    os.makedirs(out_dir, exist_ok=True)
    print(f'Writing banners to {out_dir}')
    for (key, label, stops, high) in BANNERS:
        img = build_banner(key, label, stops, high)
        out_path = os.path.join(out_dir, f'{key}.png')
        img.save(out_path, 'PNG', optimize=True)
        size_kb = os.path.getsize(out_path) / 1024
        print(f'  {key:15s} {img.size[0]:>4}x{img.size[1]:<3} {size_kb:>5.1f} KB  "{label}"')
    print(f'Done — {len(BANNERS)} banners written.')


if __name__ == '__main__':
    main()
