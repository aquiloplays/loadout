"""Generate pixel-art card BACKS — the image shown when a card is face down.

6 variants:
  - universal:   default Aquilo-branded back
  - common:      slate-themed
  - uncommon:    green-themed
  - rare:        blue-themed
  - epic:        violet-themed
  - legendary:   aurora-gold-themed (champion uses this too)

Total: 6 Replicate calls, ~$0.018.
"""
from __future__ import annotations
import io, os, sys, time
from pathlib import Path
import requests
from PIL import Image

TOKEN = os.environ.get('REPLICATE_API_TOKEN')
if not TOKEN: print('REPLICATE_API_TOKEN required'); sys.exit(1)

OUT = Path('/tmp/boltbound-card-backs'); OUT.mkdir(exist_ok=True, parents=True)
MODEL_URL = 'https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions'

PIXEL_EMPHASIS = (
    "16-bit pixel art, chunky low-resolution pixel sprites, "
    "visible pixel blocks, blocky pixelated edges, retro SNES "
    "Final Fantasy VI / Chrono Trigger sprite style, NO smooth "
    "shading, NO painterly brush strokes, NO digital painting, "
    "NO photorealism — strictly pixelated 16-bit aesthetic"
)

BACKS = [
    {
        'slug': 'universal',
        'seed': 7001,
        'prompt': (
            f"{PIXEL_EMPHASIS}. A trading card back design for a fantasy "
            "card game called BOLTBOUND. The back features a stylized "
            "pixel-art lightning bolt motif in violet and aurora-pink, "
            "centered, against a dark cosmic background with subtle "
            "star particles and aurora swirls. An ornate symmetrical "
            "pixel border frames the design with gold accents. "
            "Square 1:1 aspect, vibrant 16-color palette, crisp pixel "
            "edges, no text, no letters, no logos."
        ),
    },
    {
        'slug': 'common',
        'seed': 7002,
        'prompt': (
            f"{PIXEL_EMPHASIS}. Trading card back, square 1:1 pixel-art "
            "design. Central motif: a pixelated stone tile carved with "
            "a simple bolt sigil in slate-gray and silver tones, "
            "against a darker slate background with subtle stone-wall "
            "texture. A simple symmetrical pixel border frames the "
            "design. Cool slate-and-silver palette. No text."
        ),
    },
    {
        'slug': 'uncommon',
        'seed': 7003,
        'prompt': (
            f"{PIXEL_EMPHASIS}. Trading card back, square 1:1 pixel-art "
            "design. Central motif: an emerald-green crystal bolt sigil "
            "against a forest-canopy background with small leaves and "
            "vines around the edges. A green-tinted silver border with "
            "tiny emerald gem inlays. Lush green palette. No text."
        ),
    },
    {
        'slug': 'rare',
        'seed': 7004,
        'prompt': (
            f"{PIXEL_EMPHASIS}. Trading card back, square 1:1 pixel-art "
            "design. Central motif: a sapphire-blue lightning bolt sigil "
            "against a deep oceanic background with star-like sapphire "
            "particles. An ornate blue-tinted polished silver border "
            "with sapphire gem inlays and decorative scroll-work. "
            "Rich blue and silver palette. No text."
        ),
    },
    {
        'slug': 'epic',
        'seed': 7005,
        'prompt': (
            f"{PIXEL_EMPHASIS}. Trading card back, square 1:1 pixel-art "
            "design. Central motif: an amethyst-and-pink lightning bolt "
            "sigil glowing with aurora particles, against a violet "
            "cosmic background with aurora-pink nebula swirls. Ornate "
            "violet-and-pink gradient border with amethyst gem inlays "
            "and aurora-pink filigree. Vibrant violet and pink palette. No text."
        ),
    },
    {
        'slug': 'legendary',
        'seed': 7006,
        'prompt': (
            f"{PIXEL_EMPHASIS}. Trading card back, square 1:1 pixel-art "
            "design. Central motif: a radiant aurora-pink-and-gold "
            "lightning bolt sigil glowing with intense star sparkles, "
            "against a rich gold-and-violet cosmic background with "
            "aurora particles and constellation patterns. A highly "
            "ornate aurora-pink-and-gold radiant border with elaborate "
            "filigree, gold gem inlays at every corner, pulsing star "
            "sparkles. Lavish gold-violet-pink palette. No text."
        ),
    },
]

def create(s):
    body = {'input': {
        'prompt': s['prompt'], 'aspect_ratio': '1:1',
        'output_format': 'webp', 'output_quality': 95,
        'num_outputs': 1, 'seed': s['seed'],
        'go_fast': True, 'megapixels': '1',
    }}
    while True:
        r = requests.post(MODEL_URL, json=body, timeout=60,
                          headers={'Authorization': f'Bearer {TOKEN}', 'Prefer': 'wait=10'})
        if r.status_code == 429:
            try: delay = (r.json().get('retry_after') or 15) + 2
            except: delay = 17
            print(f'  429 sleep {delay}s'); time.sleep(delay); continue
        if not r.ok: raise RuntimeError(f'{r.status_code} {r.text[:200]}')
        return r.json()

def poll(p):
    while p.get('status') in ('starting','processing'):
        time.sleep(1.2)
        p = requests.get(p['urls']['get'], headers={'Authorization':f'Bearer {TOKEN}'}).json()
    if p.get('status') != 'succeeded': raise RuntimeError(p.get('status'))
    return p

for i, s in enumerate(BACKS):
    print(f'\n[{i+1}/{len(BACKS)}] {s["slug"]}')
    if i > 0: print('  pacing 14s'); time.sleep(14)
    out = OUT / f'back-{s["slug"]}.webp'
    if out.exists(): print('  cached'); continue
    p = poll(create(s))
    url = p['output'][0] if isinstance(p['output'], list) else p['output']
    out.write_bytes(requests.get(url, timeout=60).content)
    print(f'  saved {out}')

print('\nDone.')
