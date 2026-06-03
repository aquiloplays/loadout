"""Generate the Clash-of-Clans-style town field backdrop (overhaul wave 1).

ONE large top-down landscape the site frames behind the buildable grid:
lush grass centre (under the town), rippling water at the outer edge, a
cartoon tree border, organic decorative props. Saved straight into the
aquilo-site public tree as a webp (no KV / wrangler — Replicate only).

Usage: REPLICATE_API_TOKEN=... python tools/gen-clash-field-coc.py
"""
from __future__ import annotations
import io, os, sys, time
from pathlib import Path
import requests
from PIL import Image

TOKEN = os.environ.get('REPLICATE_API_TOKEN')
ULTRA = 'https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro-ultra/predictions'
OUT = Path('C:/Users/bishe/Desktop/aquilo-site/public/sprites/clash-v2/glossy/backdrop/field-coc.webp')

PROMPT = (
    "Vibrant Clash-of-Clans cartoon village landscape, straight top-down "
    "three-quarter isometric game-board view, sunlit warm palette. A large "
    "lush green grass plot (#6cc24a) fills the CENTRE of the square, framed "
    "on all four outer edges by sky-blue rippling cartoon WATER like a moat. "
    "Between the grass and the water runs a natural border of cartoon trees "
    "in organic clusters of 3-5 (not a uniform ring), with a few sandy shore "
    "patches. Decorative props scattered ORGANICALLY across the grass (small "
    "bushes, colourful flower patches, a few gray-brown rocks, a winding dirt "
    "path off to one side) — never in a grid. Warm 45-degree sunlight, soft "
    "shadows, glossy polished AAA mobile-strategy art, chunky friendly "
    "cartoon. The centre grass area is open and empty (buildings render on "
    "top later). NO buildings, NO houses, NO characters, NO units, NO people, "
    "NO text, NO UI, NO grid lines, NO vignette frame."
)


def _download(url, tries=5):
    last = None
    for i in range(tries):
        try:
            r = requests.get(url, timeout=120)
            if r.ok and r.content:
                return r.content
            last = str(r.status_code)
        except Exception as e:
            last = str(e)[:80]
        time.sleep(2 + i * 2)
    raise RuntimeError(f'download failed: {last}')


def gen(prompt, aspect='1:1'):
    if not TOKEN:
        raise SystemExit('REPLICATE_API_TOKEN not set')
    body = {'input': {'prompt': prompt, 'aspect_ratio': aspect,
                      'output_format': 'png', 'safety_tolerance': 2, 'raw': False}}
    while True:
        r = requests.post(ULTRA, json=body, timeout=120,
                          headers={'Authorization': f'Bearer {TOKEN}', 'Prefer': 'wait=40'})
        if r.status_code == 429:
            print('  429 backoff 15s'); time.sleep(15); continue
        if not r.ok:
            raise RuntimeError(f'{r.status_code} {r.text[:160]}')
        p = r.json(); break
    while p.get('status') in ('starting', 'processing'):
        time.sleep(1.3)
        p = requests.get(p['urls']['get'], headers={'Authorization': f'Bearer {TOKEN}'}).json()
    if p.get('status') != 'succeeded':
        raise RuntimeError(f"gen {p.get('status')}: {str(p.get('error'))[:120]}")
    url = p['output'][0] if isinstance(p['output'], list) else p['output']
    return _download(url)


def main():
    print('generating CoC field backdrop (Pro Ultra 1:1, ~$0.06)...')
    png = gen(PROMPT)
    img = Image.open(io.BytesIO(png)).convert('RGB')
    # Cap to 2048 square + encode webp (smaller payload, opaque backdrop).
    if max(img.size) > 2048:
        img.thumbnail((2048, 2048), Image.LANCZOS)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT, 'WEBP', quality=86, method=6)
    sz = OUT.stat().st_size
    if sz < 30_000:
        raise SystemExit(f'field too small ({sz}B) — generation likely failed')
    print(f'saved {img.size[0]}x{img.size[1]} {sz}B -> {OUT}')


if __name__ == '__main__':
    sys.exit(main())
