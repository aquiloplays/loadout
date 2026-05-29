"""Generate 5 pixel-art card frame templates (one per rarity) via Replicate.

Each frame is a 1024x1024 pixel-art card border with a deliberately empty
center area that the per-card character art will paste into. Frame style
scales with rarity: common = simple stone+silver, legendary = aurora-gold
ornate.

Output:
  /tmp/boltbound-pixel-frames/frame-<rarity>.webp        raw AI output
  /tmp/boltbound-pixel-frames/frame-<rarity>-clean.png   color-keyed
                                                          transparent-center

Usage:
  REPLICATE_API_TOKEN=... python tools/pixel-frame-generator.py
"""
from __future__ import annotations
import io, os, sys, time
from pathlib import Path
import requests
from PIL import Image

TOKEN = os.environ.get('REPLICATE_API_TOKEN')
if not TOKEN:
    print('REPLICATE_API_TOKEN required', file=sys.stderr); sys.exit(1)

OUT = Path('/tmp/boltbound-pixel-frames'); OUT.mkdir(exist_ok=True, parents=True)
MODEL_URL = 'https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions'

FRAMES = [
    {
        'rarity': 'common',
        'seed':   3001,
        'prompt': (
            "16-bit retro pixel art trading card border frame, rectangular shape "
            "with rounded corners. Simple silver and gray stone-tile border, "
            "thick pixel edges, classic SNES JRPG menu-frame style. The CENTER "
            "of the image is a perfectly solid uniform bright magenta color "
            "(hex FF00FF, no texture, no pattern) filling 70% of the canvas - "
            "this is the placeholder for character art. Border has subtle violet "
            "accent rivets in corners. Crisp pixel edges, no anti-aliasing. "
            "Vibrant 16-color palette. No text in image."
        ),
    },
    {
        'rarity': 'uncommon',
        'seed':   3002,
        'prompt': (
            "16-bit retro pixel art trading card border frame, rectangular shape "
            "with rounded corners. Polished green-tinted silver border with "
            "small emerald gem inlays in the corners, classic SNES JRPG menu-"
            "frame style. The CENTER of the image is a perfectly solid uniform "
            "bright magenta color (hex FF00FF, no texture) filling 70% of the "
            "canvas - placeholder for character art. Crisp pixel edges, no anti-"
            "aliasing. Vibrant 16-color palette. No text in image."
        ),
    },
    {
        'rarity': 'rare',
        'seed':   3003,
        'prompt': (
            "16-bit retro pixel art trading card border frame, rectangular shape "
            "with rounded corners. Ornate blue-tinted polished silver border "
            "with sapphire gem inlays at corners and top center, decorative "
            "scroll-work motifs, classic SNES JRPG menu-frame style. The CENTER "
            "of the image is a perfectly solid uniform bright magenta color "
            "(hex FF00FF, no texture) filling 70% of the canvas - placeholder "
            "for character art. Crisp pixel edges, no anti-aliasing. Vibrant "
            "16-color palette. No text in image."
        ),
    },
    {
        'rarity': 'epic',
        'seed':   3004,
        'prompt': (
            "16-bit retro pixel art trading card border frame, rectangular shape "
            "with rounded corners. Ornate violet-and-pink gradient border with "
            "amethyst gem inlays, glowing aurora-pink accent details on filigree "
            "scroll-work, classic SNES JRPG ornate magical frame style. The "
            "CENTER of the image is a perfectly solid uniform bright magenta "
            "color (hex FF00FF, no texture) filling 70% of the canvas - "
            "placeholder for character art. Crisp pixel edges, no anti-aliasing. "
            "Vibrant 16-color palette with violet and aurora pink. No text in "
            "image."
        ),
    },
    {
        'rarity': 'legendary',
        'seed':   3005,
        'prompt': (
            "16-bit retro pixel art trading card border frame, rectangular shape "
            "with rounded corners. Highly ornate aurora-pink-and-gold radiant "
            "border with elaborate filigree, golden glowing gem inlays at every "
            "corner and the center-top, pulsing star sparkles, classic SNES "
            "Final Fantasy VI legendary equipment frame style with rainbow-prism "
            "shimmer. The CENTER of the image is a perfectly solid uniform "
            "bright magenta color (hex FF00FF, no texture) filling 70% of the "
            "canvas - placeholder for character art. Crisp pixel edges, no anti-"
            "aliasing. Vibrant 16-color palette with rich aurora pink, deep "
            "violet, and bright gold. No text in image."
        ),
    },
]

def create(sample):
    body = {'input': {
        'prompt':         sample['prompt'],
        'aspect_ratio':   '1:1',
        'output_format':  'webp',
        'output_quality': 95,
        'num_outputs':    1,
        'seed':           sample['seed'],
        'go_fast':        True,
        'megapixels':     '1',
    }}
    while True:
        r = requests.post(MODEL_URL, json=body, timeout=60,
                          headers={'Authorization': f'Bearer {TOKEN}', 'Prefer': 'wait=10'})
        if r.status_code == 429:
            try: delay = (r.json().get('retry_after') or 15) + 2
            except: delay = 17
            print(f'  429 sleeping {delay}s'); time.sleep(delay); continue
        if not r.ok:
            raise RuntimeError(f'create {r.status_code}: {r.text[:200]}')
        return r.json()

def poll(p):
    while p.get('status') in ('starting', 'processing'):
        time.sleep(1.2)
        p = requests.get(p['urls']['get'], headers={'Authorization': f'Bearer {TOKEN}'}).json()
    if p.get('status') != 'succeeded':
        raise RuntimeError(f'status {p.get("status")}')
    return p

def color_key_center(img: Image.Image) -> Image.Image:
    """Replace the magenta placeholder center with transparency.

    Two passes:
    1. Color-key any obvious magenta pixels (catches well-keyed frames).
    2. Carve a fixed center rectangle (70% inset) regardless of color —
       catches frames like the legendary one where the AI ignored the
       magenta-placeholder direction and filled the interior with the
       frame's own pink palette.
    """
    img = img.convert('RGBA')
    px = img.load()
    w, h = img.size
    # Pass 1: color-key magenta.
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if r > 180 and g < 80 and b > 180:
                px[x, y] = (0, 0, 0, 0)
    # Pass 2: hard cutout at center 70%. Anything inside this rect
    # becomes fully transparent so the per-card character art shows
    # through cleanly.
    pad = int(min(w, h) * 0.15)
    for y in range(pad, h - pad):
        for x in range(pad, w - pad):
            px[x, y] = (0, 0, 0, 0)
    return img

for i, s in enumerate(FRAMES):
    print(f'\n[{i+1}/{len(FRAMES)}] frame-{s["rarity"]}')
    if i > 0:
        print('  pacing 14s'); time.sleep(14)
    out_raw   = OUT / f'frame-{s["rarity"]}.webp'
    out_clean = OUT / f'frame-{s["rarity"]}-clean.png'
    if out_clean.exists():
        print('  cached'); continue
    p = poll(create(s))
    url = p['output'][0] if isinstance(p['output'], list) else p['output']
    dl = requests.get(url, timeout=60).content
    out_raw.write_bytes(dl)
    img = Image.open(io.BytesIO(dl))
    cleaned = color_key_center(img)
    cleaned.save(out_clean, optimize=True)
    print(f'  saved {out_clean}')

print('\nDone.')
