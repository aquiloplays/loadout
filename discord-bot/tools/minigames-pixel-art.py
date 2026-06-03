"""Mini-games pixel-art icon set, generated via Replicate Flux Schnell.

One 16-bit aurora-palette sprite per mini-game (coinflip, dice, blackjack,
roulette, wheel, hilo, mines, plinko), isolated to a transparent PNG with
the same edge-seeded flood-fill the arena-fx generator uses. These drive
the launcher tiles + per-game hero banner on /play.

Style: 16-bit pixel art, aquilo aurora palette (deep violet, teal, gold
accents on a dark cosmic base), single centered object, transparent bg.

Estimated cost: ~12 Schnell calls x $0.003 = ~$0.04. Well under budget.

Output goes straight into the site so no separate KV upload step:
  aquilo-site/public/sprites/casino/<slug>.png

Usage:
  REPLICATE_API_TOKEN=... python tools/minigames-pixel-art.py [--only <substr>] [--dry-run]
"""
from __future__ import annotations
import io
import os
import sys
import time
from collections import deque
from pathlib import Path

import requests
from PIL import Image

TOKEN = os.environ.get('REPLICATE_API_TOKEN')
# Site junction lives at Desktop/aquilo-site; write cleaned PNGs there.
OUT = Path(os.environ.get(
    'MINIGAMES_ART_OUT',
    'C:/Users/bishe/Desktop/aquilo-site/public/sprites/casino'))
OUT.mkdir(parents=True, exist_ok=True)

SCHNELL_URL = 'https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions'

PIXEL = (
    "16-bit pixel art, chunky low-resolution pixel sprites, visible "
    "pixel blocks, blocky pixelated edges, retro SNES Final Fantasy VI "
    "/ Chrono Trigger sprite style, NO smooth shading, NO painterly "
    "brush strokes, NO photorealism, strictly pixelated 16-bit aesthetic"
)
PALETTE = (
    "aurora palette: deep violet and indigo, glowing teal and cyan "
    "highlights, warm gold accents, on a dark cosmic base"
)
ON_MAGENTA = ("isolated on a completely flat solid magenta #FF00FF "
              "background, no gradient, no shadow on the background, "
              "the magenta fills every empty area")


def spec(slug, subject):
    return dict(slug=slug, subject=subject)


SPECS = [
    spec('coinflip',
         "a single large ornate gold coin standing upright, a lightning-bolt "
         "sigil embossed on its face, glinting"),
    spec('dice',
         "a pair of chunky dice showing five and three pips, gold pips, "
         "violet and teal dice bodies"),
    spec('blackjack',
         "two playing cards fanned out, an ace and a king, with a small stack "
         "of gold and teal casino chips in front"),
    spec('roulette',
         "a roulette wheel seen at a three-quarter angle with a small white "
         "ball resting in a pocket, gold rim, red and black pockets"),
    spec('wheel',
         "a segmented wheel-of-fortune prize wheel with a gold pointer at the "
         "top, alternating violet, teal and gold segments"),
    spec('hilo',
         "two playing cards, one higher and one lower, with an upward gold "
         "arrow and a downward arrow between them"),
    spec('mines',
         "a grid tile with a glowing teal gem revealed on it and a dark "
         "spherical bomb with a lit fuse beside it"),
    spec('plinko',
         "a plinko board with a glowing gold ball bouncing between a triangle "
         "of teal pegs, multiplier slots at the bottom"),
]


def create(s):
    body = {'input': {
        'prompt': f"{PIXEL}. A {s['subject']}. {PALETTE}. Single centered "
                  f"object, {ON_MAGENTA}. No text, no words, no numbers, no "
                  f"watermark.",
        'aspect_ratio': '1:1',
        'output_format': 'webp', 'output_quality': 95, 'num_outputs': 1,
        'go_fast': True, 'megapixels': '1',
    }}
    while True:
        r = requests.post(SCHNELL_URL, json=body, timeout=120,
                          headers={'Authorization': f'Bearer {TOKEN}',
                                   'Prefer': 'wait=30'})
        if r.status_code == 429:
            try:
                delay = (r.json().get('retry_after') or 15) + 2
            except Exception:
                delay = 17
            print(f'  429 sleep {delay}s')
            time.sleep(delay)
            continue
        if not r.ok:
            raise RuntimeError(f'{r.status_code} {r.text[:200]}')
        return r.json()


def poll(p):
    while p.get('status') in ('starting', 'processing'):
        time.sleep(1.3)
        p = requests.get(p['urls']['get'],
                         headers={'Authorization': f'Bearer {TOKEN}'}).json()
    if p.get('status') != 'succeeded':
        raise RuntimeError(f"prediction {p.get('status')}: {str(p.get('error'))[:200]}")
    return p


def flood_key(img: Image.Image, delta: int = 60) -> Image.Image:
    """Edge-seeded flood-fill bg removal, tolerant to Flux's near-flat
    magenta field (compares each step to the seed color, within delta)."""
    img = img.convert('RGBA')
    w, h = img.size
    px = img.load()

    def close(c1, c2):
        return (abs(c1[0] - c2[0]) <= delta and
                abs(c1[1] - c2[1]) <= delta and
                abs(c1[2] - c2[2]) <= delta)

    visited = bytearray(w * h)
    q = deque()

    def seed(x, y):
        if 0 <= x < w and 0 <= y < h and not visited[y * w + x]:
            q.append((x, y, (px[x, y][0], px[x, y][1], px[x, y][2])))

    for x in range(w):
        seed(x, 0); seed(x, h - 1)
    for y in range(h):
        seed(0, y); seed(w - 1, y)

    while q:
        x, y, ref = q.popleft()
        i = y * w + x
        if visited[i]:
            continue
        cur = px[x, y]
        if not close((cur[0], cur[1], cur[2]), ref):
            continue
        visited[i] = 1
        px[x, y] = (0, 0, 0, 0)
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h and not visited[ny * w + nx]:
                q.append((nx, ny, ref))
    return img


def main(argv):
    only = None
    dry = '--dry-run' in argv
    if '--only' in argv:
        only = argv[argv.index('--only') + 1]
    if not dry and not TOKEN:
        print('ERROR: REPLICATE_API_TOKEN not set.', file=sys.stderr)
        return 2

    todo = [s for s in SPECS if (not only or only in s['slug'])]
    print(f'{len(todo)} specs (Schnell) est ${len(todo) * 0.003:.2f} -> {OUT}')
    if dry:
        for s in todo:
            print(f'  {s["slug"]:10} -> {OUT / (s["slug"] + ".png")}')
        return 0

    done = 0
    for i, s in enumerate(todo):
        print(f'\n[{i + 1}/{len(todo)}] {s["slug"]}')
        out_clean = OUT / f'{s["slug"]}.png'
        if out_clean.exists():
            print('  cached'); done += 1; continue
        if i > 0:
            time.sleep(6)
        p = poll(create(s))
        url = p['output'][0] if isinstance(p['output'], list) else p['output']
        raw = requests.get(url, timeout=120).content
        img = flood_key(Image.open(io.BytesIO(raw)), delta=60)
        # Downscale to a crisp 256 icon with nearest-neighbour so it keeps
        # the chunky-pixel look rather than going soft.
        img = img.resize((256, 256), Image.NEAREST)
        img.save(out_clean, optimize=True)
        sz = out_clean.stat().st_size
        if sz < 300:
            raise SystemExit(f'ERROR: {out_clean} only {sz} bytes, gen failed')
        print(f'  saved {out_clean} ({sz} bytes)')
        done += 1

    print(f'\nDone, {done}/{len(todo)} icons in {OUT}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
