"""Arena-polish FX batch — Boltbound/RPG match + meta polish assets.

Generates the remaining arena-polish set via Replicate, picking the
model per importance (Clay's guideline):
  * Flux 1.1 Pro Ultra ($0.06) for hero-facing assets shown a lot
    (coin flip, photo-mode frames, Twitch-drops chest).
  * Flux Schnell ($0.003) for incidental fx that flash + disappear
    (auras, weather particles, idle breathing, loot beams).

Asset set (frames bundled into one sprite sheet per concept where the
spec allows, to keep call-count + cost down):
  coin-flip         6-frame spin sheet                 Pro Ultra
  aura:{holy,dark,fire}   4-frame sheet each (×3)      Schnell
  weather:{rain,snow,leaf} 4-frame sheet each (×3)     Schnell
  hero-idle:{warrior,mage,rogue,ranger,healer} 3-frame breathing (×5)  Schnell
  photo-frame:{epic-gold,mythic-violet,casual-blue,retro-pixel} (×4)   Pro Ultra
  drops-chest       6-frame open + light-burst sheet   Pro Ultra
  loot-beam:{common,uncommon,rare,epic,legendary} (×5) Schnell

Estimated cost: 6 Pro Ultra ($0.36) + 16 Schnell ($0.048) ≈ $0.41.
Well under the $3-5 budget guideline.

Backgrounds that need transparency are prompted on a flat magenta
(#FF00FF) field and isolated with an edge-seeded flood-fill (Δ=60) —
see flood_key(). Photo-mode frames additionally seed the center so the
hollow middle is cut. Opaque concepts (coin, chest) keep their bg.

Output: /tmp/boltbound-arena-fx/<slug>.{webp,png}
Upload:  tools/upload-arena-polish-fx.py

Usage:
  REPLICATE_API_TOKEN=... python tools/arena-polish-fx-generator.py [--only <slug-substr>] [--dry-run]
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
OUT = Path('/tmp/boltbound-arena-fx')
OUT.mkdir(parents=True, exist_ok=True)

SCHNELL_URL = 'https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions'
ULTRA_URL   = 'https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro-ultra/predictions'

PIXEL = (
    "16-bit pixel art, chunky low-resolution pixel sprites, visible "
    "pixel blocks, blocky pixelated edges, retro SNES Final Fantasy VI "
    "/ Chrono Trigger sprite style, NO smooth shading, NO painterly "
    "brush strokes, NO photorealism — strictly pixelated 16-bit aesthetic"
)
# Appended to anything that must be cut out to transparency.
ON_MAGENTA = ("isolated on a completely flat solid magenta #FF00FF "
              "background, no gradient, no shadow on the background, "
              "the magenta fills every empty area")
SHEET = ("arranged as a single horizontal sprite-sheet strip of "
         "evenly-spaced frames, equal spacing, frames in a straight row")


def spec(slug, model, prompt, *, kv, key, isolate=False, seed_center=False,
         aspect='1:1'):
    return dict(slug=slug, model=model, prompt=prompt, kv=kv, key=key,
                isolate=isolate, seed_center=seed_center, aspect=aspect)


# KV namespaces:  pixel-art-boltbound:fx:*  for match fx,
#                 pixel-art-rpg:hero-idle:*  for hero idle anims.
FXNS = 'pixel-art-boltbound:fx:'
RPGNS = 'pixel-art-rpg:hero-idle:'

SPECS = []

# ── Coin flip — Pro Ultra sheet (hero-facing, shown on every flip) ──
SPECS.append(spec(
    'coin-flip', 'ultra',
    f"{PIXEL}. A 6-frame spinning gold coin animation, {SHEET}: frame 1 "
    "heads facing forward, frame 2 rotated three-quarters, frame 3 thin "
    "edge-on sliver, frame 4 three-quarters again, frame 5 tails facing "
    "forward, frame 6 thin edge-on sliver. Ornate Boltbound lightning-bolt "
    "sigil embossed on heads, a crown on tails. Bright gold with aurora-pink "
    "rim light. Plain dark slate background. No text.",
    kv=FXNS, key='coin-flip-sheet.png', aspect='16:9'))

# ── Auras — Schnell, 4-frame pulse sheets, transparent ─────────────
for slug, desc, palette in [
    ('holy', 'radiant holy aura, soft golden-white halo glow with rising sparkles',
     'warm gold and white'),
    ('dark', 'sinister dark aura, swirling violet-black smoke with purple embers',
     'deep violet and black'),
    ('fire', 'blazing fire aura, orange-red flames licking upward with embers',
     'orange, red, yellow'),
]:
    SPECS.append(spec(
        f'aura-{slug}', 'schnell',
        f"{PIXEL}. A 4-frame pulsing {desc}, {SHEET}, each frame the aura at a "
        f"slightly different pulse/intensity, {palette} palette, glowing oval "
        f"aura shape only (no character inside), {ON_MAGENTA}. No text.",
        kv=FXNS, key=f'aura-{slug}-sheet.png', isolate=True, aspect='16:9'))

# ── Weather particles — Schnell, 4-frame sheets, transparent ───────
for slug, desc in [
    ('rain', 'a falling blue rain droplet, slightly different fall position + '
             'splash shape per frame'),
    ('snow', 'a drifting white snowflake, gently rotated + repositioned per frame'),
    ('leaf', 'an autumn leaf falling, tumbling to a different angle per frame, '
             'warm orange-brown'),
]:
    SPECS.append(spec(
        f'weather-{slug}', 'schnell',
        f"{PIXEL}. A 4-frame particle animation of {desc}, {SHEET}, small "
        f"individual particle centered in each frame, {ON_MAGENTA}. No text.",
        kv=FXNS, key=f'weather-{slug}-sheet.png', isolate=True, aspect='16:9'))

# ── Idle hero breathing — Schnell, 3-frame sheets, transparent ─────
for cls, desc in [
    ('warrior', 'an armored warrior with sword + shield, sturdy stance'),
    ('mage',    'a robed mage holding a glowing staff'),
    ('rogue',   'a hooded rogue with twin daggers, crouched'),
    ('ranger',  'a cloaked ranger drawing a longbow'),
    ('healer',  'a serene healer in white-gold robes with a holy symbol'),
]:
    SPECS.append(spec(
        f'hero-idle-{cls}', 'schnell',
        f"{PIXEL}. A 3-frame idle breathing animation of {desc}, {SHEET}: "
        f"frame 1 chest neutral, frame 2 chest rising (inhale), frame 3 chest "
        f"settling — subtle motion only, same pose + position, full-body "
        f"front-facing sprite, {ON_MAGENTA}. No text.",
        kv=RPGNS, key=f'{cls}-breathing-sheet.png', isolate=True, aspect='16:9'))

# ── Photo-mode frame overlays — Pro Ultra, hollow-center borders ───
for slug, desc in [
    ('epic-gold',     'ornate epic golden border frame with filigree corners + gem inlays'),
    ('mythic-violet', 'mythic violet-and-aurora-pink border frame, glowing runes, '
                      'elaborate scrollwork'),
    ('casual-blue',   'clean casual blue border frame, simple rounded corners, subtle shine'),
    ('retro-pixel',   'chunky retro-pixel border frame, blocky 8-bit style corners, '
                      'high-contrast'),
]:
    SPECS.append(spec(
        f'photo-frame-{slug}', 'ultra',
        f"{PIXEL}. A decorative rectangular photo-mode {desc}, the entire "
        f"center is a large empty hollow rectangle (where a photo will sit), "
        f"only the border is decorated, {ON_MAGENTA} including the hollow "
        f"center which is also flat magenta. No text.",
        kv=FXNS, key=f'photo-frame-{slug}.png', isolate=True, seed_center=True,
        aspect='4:3'))

# ── Twitch-drops claim — Pro Ultra, 6-frame open + light burst ─────
SPECS.append(spec(
    'drops-chest', 'ultra',
    f"{PIXEL}. A 6-frame treasure-chest opening animation, {SHEET}: frame 1 "
    "closed wooden+gold chest, frame 2 lid cracking with a thin light seam, "
    "frame 3 lid half open with light spilling out, frame 4 lid fully open "
    "with a bright golden light burst, frame 5 peak burst with radiating "
    "aurora-pink rays + sparkles, frame 6 burst settling with floating loot "
    "sparkles. Plain dark slate background. No text.",
    kv=FXNS, key='drops-chest-sheet.png', aspect='16:9'))

# ── Loot rarity beams — Schnell, vertical beam textures, transparent ─
for slug, color in [
    ('common',    'plain gray'),
    ('uncommon',  'bright green'),
    ('rare',      'vivid blue'),
    ('epic',      'rich violet'),
    ('legendary', 'radiant aurora gold'),
]:
    SPECS.append(spec(
        f'loot-beam-{slug}', 'schnell',
        f"{PIXEL}. A single tall vertical {color} light beam / pillar of light "
        f"shooting upward, glowing particles rising within it, brightest at the "
        f"base, fading at the top, {ON_MAGENTA}. No text.",
        kv=FXNS, key=f'loot-beam-{slug}.png', isolate=True, seed_center=False,
        aspect='9:16'))


# ── Replicate plumbing ─────────────────────────────────────────────
def create(s):
    if s['model'] == 'ultra':
        # Pro Ultra only supports jpg/png output (no webp). Use png so
        # transparency-isolated frames survive the round-trip.
        body = {'input': {
            'prompt': s['prompt'], 'aspect_ratio': s['aspect'],
            'output_format': 'png', 'safety_tolerance': 2, 'raw': False,
        }}
        url = ULTRA_URL
    else:
        body = {'input': {
            'prompt': s['prompt'], 'aspect_ratio': s['aspect'],
            'output_format': 'webp', 'output_quality': 95, 'num_outputs': 1,
            'go_fast': True, 'megapixels': '1',
        }}
        url = SCHNELL_URL
    while True:
        r = requests.post(url, json=body, timeout=120,
                          headers={'Authorization': f'Bearer {TOKEN}', 'Prefer': 'wait=30'})
        if r.status_code == 429:
            try: delay = (r.json().get('retry_after') or 15) + 2
            except Exception: delay = 17
            print(f'  429 sleep {delay}s'); time.sleep(delay); continue
        if not r.ok:
            raise RuntimeError(f'{r.status_code} {r.text[:200]}')
        return r.json()


def poll(p):
    while p.get('status') in ('starting', 'processing'):
        time.sleep(1.3)
        p = requests.get(p['urls']['get'], headers={'Authorization': f'Bearer {TOKEN}'}).json()
    if p.get('status') != 'succeeded':
        raise RuntimeError(f"prediction {p.get('status')}: {str(p.get('error'))[:200]}")
    return p


# ── Edge-seeded flood-fill background removal (Δ=60) ───────────────
def flood_key(img: Image.Image, delta: int = 60, seed_center: bool = False) -> Image.Image:
    """Remove the background by flood-filling from edge pixels (and
    optionally the center) wherever the color is within `delta` of the
    seed pixel's color. Robust to the slight gradient/noise Flux adds to
    a 'flat' magenta field — far better than a fixed-color key."""
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

    # Seed every border pixel.
    for x in range(w):
        seed(x, 0); seed(x, h - 1)
    for y in range(h):
        seed(0, y); seed(w - 1, y)
    if seed_center:
        seed(w // 2, h // 2)

    while q:
        x, y, ref = q.popleft()
        idx = y * w + x
        if visited[idx]:
            continue
        cur = px[x, y]
        if not close((cur[0], cur[1], cur[2]), ref):
            continue
        visited[idx] = 1
        px[x, y] = (0, 0, 0, 0)
        # Propagate using the ORIGINAL seed reference so a slow gradient
        # across the field still clears (each step compares to the seed,
        # not the neighbour — tolerant within delta of the seed color).
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
        print('ERROR: REPLICATE_API_TOKEN not set — cannot call Replicate.', file=sys.stderr)
        print('Set it (PowerShell:  $env:REPLICATE_API_TOKEN="r8_...")  then re-run.', file=sys.stderr)
        return 2

    # Always (re)write the full manifest so the uploader maps every
    # slug -> KV key regardless of any --only filter on this run.
    import json
    manifest = {s['slug']: {'kv': s['kv'], 'key': s['key'], 'isolate': s['isolate']}
                for s in SPECS}
    (OUT / 'manifest.json').write_text(json.dumps(manifest, indent=2))

    todo = [s for s in SPECS if (not only or only in s['slug'])]
    n_ultra = sum(1 for s in todo if s['model'] == 'ultra')
    n_schnell = len(todo) - n_ultra
    est = n_ultra * 0.06 + n_schnell * 0.003
    print(f'{len(todo)} specs ({n_ultra} Pro Ultra, {n_schnell} Schnell) — est ${est:.2f}')
    if dry:
        for s in todo:
            print(f'  {s["model"]:7} {s["slug"]:24} -> {s["kv"]}{s["key"]}'
                  f'{"  [isolate]" if s["isolate"] else ""}')
        return 0

    done = 0
    for i, s in enumerate(todo):
        print(f'\n[{i+1}/{len(todo)}] {s["slug"]} ({s["model"]})')
        out_clean = OUT / f'{s["slug"]}.png'
        if out_clean.exists():
            print('  cached'); done += 1; continue
        # Pace to dodge Replicate rate limits (Schnell is fast; Ultra slow).
        if i > 0:
            time.sleep(8 if s['model'] == 'schnell' else 12)
        p = poll(create(s))
        url = p['output'][0] if isinstance(p['output'], list) else p['output']
        raw = requests.get(url, timeout=120).content
        (OUT / f'{s["slug"]}.webp').write_bytes(raw)
        img = Image.open(io.BytesIO(raw))
        if s['isolate']:
            img = flood_key(img, delta=60, seed_center=s['seed_center'])
        img.save(out_clean, optimize=True)
        sz = out_clean.stat().st_size
        if sz < 300:
            raise SystemExit(f'ERROR: {out_clean} only {sz} bytes — generation failed')
        print(f'  saved {out_clean}  ({img.size[0]}x{img.size[1]}, {sz} bytes)')
        done += 1

    print(f'\nDone — {done}/{len(todo)} assets ready in {OUT}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
