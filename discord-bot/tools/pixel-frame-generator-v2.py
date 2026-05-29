"""Generate 5 portrait-aspect (5:7) pixel-art card frames with baked-in
mana gem socket, type label slot, name banner area, and lore text panel.
The frame design dictates WHERE the text/gem goes — Pillow then just
writes the text inside those baked slots.

Output: /tmp/boltbound-pixel-frames-v2/frame-<rarity>-clean.png

Usage:
  REPLICATE_API_TOKEN=... python tools/pixel-frame-generator-v2.py
"""
from __future__ import annotations
import io, os, sys, time
from pathlib import Path
import requests
from PIL import Image

TOKEN = os.environ.get('REPLICATE_API_TOKEN')
if not TOKEN: print('REPLICATE_API_TOKEN required', file=sys.stderr); sys.exit(1)

OUT = Path('/tmp/boltbound-pixel-frames-v2'); OUT.mkdir(exist_ok=True, parents=True)
MODEL_URL = 'https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions'

# Common base — every frame needs these design features in the same positions
# so the Pillow compositor can drop text into the correct slots later.
COMMON_LAYOUT = (
    "Portrait-orientation rectangular trading card border frame, taller "
    "than wide, classic TCG card proportions. Baked into the design: "
    "(a) a circular mana gem socket in the top-left corner (the gem itself "
    "is empty/dark for text to be drawn into later), "
    "(b) a small pixel banner ribbon in the top-right corner with empty "
    "space for a type label, "
    "(c) a horizontal pixel name banner ribbon in the lower-middle area, "
    "designed empty for text to be drawn into later, "
    "(d) a small text panel at the bottom 1/5 of the card with parchment "
    "or rune background, also empty for lore text overlay. The CENTER of "
    "the card (60% of canvas, roughly centered between the type banner "
    "and the name ribbon) is perfectly solid uniform bright magenta color "
    "(hex FF00FF, no texture, no detail) for the character art "
    "placeholder. Crisp pixel edges, no anti-aliasing, vibrant 16-color "
    "palette. No text characters anywhere in image — all banners and "
    "gem sockets are empty."
)

FRAMES = [
    {
        'rarity': 'common',
        'seed':   4001,
        'prompt': (
            "16-bit retro pixel art. " + COMMON_LAYOUT +
            " Common rarity tier styling: simple silver and gray stone-tile "
            "border, subtle violet accent rivets, classic SNES JRPG menu-frame style."
        ),
    },
    {
        'rarity': 'uncommon',
        'seed':   4002,
        'prompt': (
            "16-bit retro pixel art. " + COMMON_LAYOUT +
            " Uncommon rarity tier styling: polished green-tinted silver border "
            "with small emerald gem inlays in the corners."
        ),
    },
    {
        'rarity': 'rare',
        'seed':   4003,
        'prompt': (
            "16-bit retro pixel art. " + COMMON_LAYOUT +
            " Rare rarity tier styling: ornate blue-tinted polished silver border "
            "with sapphire gem inlays at corners and top center, decorative scroll-work motifs."
        ),
    },
    {
        'rarity': 'epic',
        'seed':   4004,
        'prompt': (
            "16-bit retro pixel art. " + COMMON_LAYOUT +
            " Epic rarity tier styling: ornate violet-and-pink gradient border "
            "with amethyst gem inlays, glowing aurora-pink accent details on filigree."
        ),
    },
    {
        'rarity': 'legendary',
        'seed':   4005,
        'prompt': (
            "16-bit retro pixel art. " + COMMON_LAYOUT +
            " Legendary rarity tier styling: highly ornate aurora-pink-and-gold "
            "radiant border with elaborate filigree, golden glowing gem inlays "
            "at every corner, pulsing star sparkles, FF6 legendary equipment frame style."
        ),
    },
]

def create(sample):
    body = {'input': {
        'prompt':         sample['prompt'],
        'aspect_ratio':   '2:3',          # portrait — closer to TCG card shape
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
        if not r.ok: raise RuntimeError(f'create {r.status_code}: {r.text[:200]}')
        return r.json()

def poll(p):
    while p.get('status') in ('starting', 'processing'):
        time.sleep(1.2)
        p = requests.get(p['urls']['get'], headers={'Authorization': f'Bearer {TOKEN}'}).json()
    if p.get('status') != 'succeeded': raise RuntimeError(f'status {p.get("status")}')
    return p

def color_key_and_cut(img: Image.Image) -> Image.Image:
    """Color-key magenta + cut center 60% rectangle for art placement."""
    img = img.convert('RGBA')
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if r > 180 and g < 80 and b > 180:
                px[x, y] = (0, 0, 0, 0)
    # Hard cutout — 60% width centered horizontally, vertically positioned
    # in the upper portion (above the bottom lore panel).
    cut_w = int(w * 0.62)
    cut_h = int(h * 0.42)
    cx = (w - cut_w) // 2
    cy = int(h * 0.15)   # below type banners, above name banner
    for y in range(cy, cy + cut_h):
        for x in range(cx, cx + cut_w):
            if 0 <= x < w and 0 <= y < h:
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
    cleaned = color_key_and_cut(Image.open(io.BytesIO(dl)))
    cleaned.save(out_clean, optimize=True)
    print(f'  saved {out_clean}  ({cleaned.size[0]}x{cleaned.size[1]})')

print('\nDone.')
