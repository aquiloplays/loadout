"""Pixel art card pipeline — end-to-end Boltbound asset overhaul.

For each card:
  1. Generate art-only pixel-style portrait via Replicate flux-schnell.
  2. Composite a pixel-style aurora frame around the art.
  3. Overlay clean readable text — name banner, mana gem, atk/hp stats,
     keyword pill — programmatically (sidesteps Schnell's text rendering).
  4. Save the finished PNG.

Run once for validation (5 cards):
  REPLICATE_API_TOKEN=... python tools/pixel-card-pipeline.py --validate

Run full Boltbound library (~5 hours):
  REPLICATE_API_TOKEN=... python tools/pixel-card-pipeline.py --full

Resume an interrupted full run:
  REPLICATE_API_TOKEN=... python tools/pixel-card-pipeline.py --full --resume

Output:
  /tmp/boltbound-pixel-cards/<cardId>.png      finished composites
  /tmp/boltbound-pixel-cards/_state.json       checkpoint
  /tmp/boltbound-pixel-cards/_art/<cardId>.webp  raw art (kept for re-composite)
"""
from __future__ import annotations
import argparse, json, os, re, sys, time
from pathlib import Path
from typing import Any

import requests
from PIL import Image, ImageDraw, ImageFont

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
ROOT = Path(__file__).resolve().parent.parent
OUT  = Path('/tmp/boltbound-pixel-cards')
OUT.mkdir(exist_ok=True, parents=True)
(OUT / '_art').mkdir(exist_ok=True)
STATE_PATH = OUT / '_state.json'
FRAMES_DIR = Path('/tmp/boltbound-pixel-frames')   # output of pixel-frame-generator.py

# Map every rarity in the catalogue to one of the 5 frames we generated.
# champion + token use the legendary frame (visually distinctive). epic
# isn't in the catalogue today but the slot exists for future cards.
RARITY_TO_FRAME = {
    'common':    'common',
    'uncommon':  'uncommon',
    'rare':      'rare',
    'epic':      'epic',
    'legendary': 'legendary',
    'champion':  'legendary',
    'token':     'common',
}

REPLICATE_TOKEN = os.environ.get('REPLICATE_API_TOKEN')
MODEL_URL = 'https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions'

CARD_PX = 768                # final composite size (square)
ART_PX  = 1024               # AI art generation size
PACING_S = 14                # between Replicate calls — within rate limit

# Aurora palette.
COLOR_FRAME_OUTER  = (155, 108, 255, 255)   # violet
COLOR_FRAME_INNER  = (244, 114, 182, 255)   # aurora pink
COLOR_FRAME_DARK   = (24, 16, 48, 255)      # deep cosmic
COLOR_GEM_VIOLET   = (155, 108, 255, 255)
COLOR_GEM_GOLD     = (250, 204, 21, 255)
COLOR_TEXT_LIGHT   = (255, 255, 255, 255)
COLOR_TEXT_DARK    = (24, 16, 48, 255)
COLOR_KEYWORD_BG   = (244, 114, 182, 255)

# ---------------------------------------------------------------------------
# Card catalogue loader — reads cards-content.js via Node so we don't
# have to rewrite the catalogue in Python.
# ---------------------------------------------------------------------------
def load_cards() -> dict[str, dict[str, Any]]:
    """Spawn Node once to dump the catalogue as JSON."""
    import subprocess
    node_script = (
        "import('./cards-content.js').then(m => {"
        "  const out = {};"
        "  for (const id of Object.keys(m.CARDS)) {"
        "    const c = m.CARDS[id];"
        "    out[id] = { id, name: c.name, type: c.type, rarity: c.rarity, "
        "                mana: c.mana, atk: c.atk, hp: c.hp, "
        "                keywords: c.keywords||[], text: c.text||'' };"
        "  }"
        "  process.stdout.write(JSON.stringify(out));"
        "});"
    )
    r = subprocess.run(
        ['node', '-e', node_script],
        cwd=str(ROOT), capture_output=True, text=True, timeout=60,
    )
    if r.returncode != 0:
        raise RuntimeError(f'node catalogue dump failed: {r.stderr}')
    return json.loads(r.stdout)

# ---------------------------------------------------------------------------
# Prompt builder
# ---------------------------------------------------------------------------
def short_effect(card: dict[str, Any]) -> str:
    t = (card.get('text') or '').strip()
    if t: return t[:120]
    if card.get('type') == 'minion':
        kws = ', '.join(card.get('keywords') or []) or 'no keywords'
        return f'a {kws} minion'
    return f'a {card.get("type") or "card"}'

def art_prompt(card: dict[str, Any]) -> str:
    name = card['name']
    eff  = short_effect(card)
    t    = card.get('type') or 'minion'
    if t == 'spell':
        return (
            f"16-bit retro pixel art magical effect representing {name}, "
            f"a spell that {eff}. Classic SNES JRPG spell-effect style. "
            "Vibrant 16-color palette with violet and aurora-pink. Glowing "
            "particles, runic shapes, energy bolts as appropriate. Crisp "
            "pixel edges. Solid black background. No characters, just the "
            "effect visualization. No text in image, no UI elements."
        )
    if t == 'champion':
        return (
            f"16-bit retro pixel art ornate character sprite of {name}, a "
            f"legendary champion who {eff}. Classic SNES Final Fantasy VI "
            "hero-sprite style. Vibrant 16-color palette with violet, "
            "aurora-pink, and gold trim. Crisp pixel edges, dynamic action "
            "pose, glowing accent details. Solid black background. Isolated "
            "subject, centered. No text in image, no UI elements."
        )
    return (
        f"16-bit retro pixel art character sprite of {name}, a {eff} minion. "
        "Classic SNES Final Fantasy VI / Chrono Trigger battle-sprite style. "
        "Vibrant 16-color palette with violet and aurora-pink accents. Crisp "
        "pixel edges, dithering shadows, idle action stance. Solid black "
        "background. Isolated subject, centered. No text in image, no UI "
        "elements."
    )

# ---------------------------------------------------------------------------
# Replicate caller
# ---------------------------------------------------------------------------
def generate_art(card: dict[str, Any]) -> bytes:
    """Return the raw webp bytes of the AI-generated art."""
    body = {
        'input': {
            'prompt':         art_prompt(card),
            'aspect_ratio':   '1:1',
            'output_format':  'webp',
            'output_quality': 95,
            'num_outputs':    1,
            'seed':           abs(hash(card['id'])) % (2**31),
            'go_fast':        True,
            'megapixels':     '1',
        },
    }
    while True:
        r = requests.post(MODEL_URL, json=body,
                          headers={
                              'Authorization': f'Bearer {REPLICATE_TOKEN}',
                              'Prefer': 'wait=10',
                          }, timeout=60)
        if r.status_code == 429:
            # Honour Replicate's retry_after; default 15s.
            try:    delay = (r.json().get('retry_after') or 15) + 2
            except: delay = 17
            print(f'  429 — sleeping {delay}s')
            time.sleep(delay); continue
        if not r.ok:
            raise RuntimeError(f'create {r.status_code}: {r.text[:300]}')
        break
    p = r.json()
    while p.get('status') in ('starting', 'processing'):
        time.sleep(1.2)
        p = requests.get(p['urls']['get'],
                         headers={'Authorization': f'Bearer {REPLICATE_TOKEN}'},
                         timeout=30).json()
    if p.get('status') != 'succeeded':
        raise RuntimeError(f'status {p.get("status")}: {p.get("error") or ""}')
    url = p['output'][0] if isinstance(p['output'], list) else p['output']
    dl = requests.get(url, timeout=60)
    return dl.content

# ---------------------------------------------------------------------------
# Frame + text overlay
# ---------------------------------------------------------------------------
def _font(size: int, bold: bool = True) -> ImageFont.ImageFont:
    candidates = []
    if sys.platform == 'win32':
        candidates += [
            'C:/Windows/Fonts/arialbd.ttf' if bold else 'C:/Windows/Fonts/arial.ttf',
            'C:/Windows/Fonts/segoeuib.ttf' if bold else 'C:/Windows/Fonts/segoeui.ttf',
        ]
    for c in candidates:
        try: return ImageFont.truetype(c, size)
        except OSError: pass
    return ImageFont.load_default()

def _pixel_border(im: Image.Image, draw: ImageDraw.ImageDraw, w: int):
    """Chunky pixel border, 4 layers — outer violet → pink → dark → pink."""
    layers = [
        (0, COLOR_FRAME_OUTER),
        (4, COLOR_FRAME_INNER),
        (12, COLOR_FRAME_DARK),
        (16, COLOR_FRAME_INNER),
    ]
    for offset, color in layers:
        draw.rectangle(
            [offset, offset, w - 1 - offset, w - 1 - offset],
            outline=color, width=4,
        )

def _load_frame(rarity: str) -> Image.Image:
    """Load the AI-generated pixel frame for the matching rarity."""
    name = RARITY_TO_FRAME.get(rarity, 'common')
    path = FRAMES_DIR / f'frame-{name}-clean.png'
    if not path.exists():
        # First run before frames exist — fall through to a magenta tinted
        # transparent overlay so the composite still produces something.
        f = Image.new('RGBA', (CARD_PX, CARD_PX), (0, 0, 0, 0))
        return f
    return Image.open(path).convert('RGBA').resize((CARD_PX, CARD_PX), Image.NEAREST)

def _build_card_frame(art_img: Image.Image, card: dict[str, Any]) -> Image.Image:
    """Build a single static finished card with AI frame + character art + text."""
    canvas = Image.new('RGBA', (CARD_PX, CARD_PX), COLOR_FRAME_DARK)
    # Inner art slot — match the frame's central transparent area
    # (pixel-frame-generator.py keys out the center 70%, so inset 15% here).
    inset = int(CARD_PX * 0.15)
    inner = CARD_PX - 2 * inset
    art = art_img.resize((inner, inner), Image.NEAREST)
    canvas.paste(art, (inset, inset), art)

    # Paste the AI-generated frame on top — its transparent center reveals
    # the art we just placed.
    frame = _load_frame(card.get('rarity') or 'common')
    canvas.paste(frame, (0, 0), frame)

    draw = ImageDraw.Draw(canvas)

    # Mana gem — top-left.
    gx, gy, gr = 60, 60, 36
    draw.ellipse([gx - gr, gy - gr, gx + gr, gy + gr],
                 fill=COLOR_GEM_VIOLET, outline=COLOR_GEM_GOLD, width=3)
    mana_font = _font(40)
    mana = str(card.get('mana') or '0')
    bbox = draw.textbbox((0, 0), mana, font=mana_font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text((gx - tw / 2, gy - th / 2 - 4), mana,
              font=mana_font, fill=COLOR_TEXT_LIGHT)

    # Name banner — full-width strip near top under the gem.
    banner_y = CARD_PX - 180
    draw.rectangle([24, banner_y, CARD_PX - 24, banner_y + 60],
                   fill=(24, 16, 48, 230), outline=COLOR_FRAME_INNER, width=3)
    name_font = _font(28)
    name = card.get('name') or card['id']
    nw, nh = draw.textbbox((0, 0), name, font=name_font)[2:]
    draw.text((CARD_PX / 2 - nw / 2, banner_y + 30 - nh / 2),
              name, font=name_font, fill=COLOR_TEXT_LIGHT)

    # Stats — atk/hp circles at bottom corners (minions/champions only).
    if (card.get('type') in ('minion', 'champion')
            and (card.get('atk') or 0) > 0):
        atk = str(card.get('atk') or 0)
        hp  = str(card.get('hp')  or 0)
        sf = _font(34)
        for x, val, color in (
            (60, atk, (220, 38, 38, 255)),
            (CARD_PX - 60, hp, (34, 197, 94, 255)),
        ):
            y = CARD_PX - 60
            draw.ellipse([x - 32, y - 32, x + 32, y + 32],
                         fill=color, outline=COLOR_TEXT_LIGHT, width=3)
            vw, vh = draw.textbbox((0, 0), val, font=sf)[2:]
            draw.text((x - vw / 2, y - vh / 2 - 2), val,
                      font=sf, fill=COLOR_TEXT_LIGHT)

    # Keyword pill — only if the card has any keywords.
    kws = card.get('keywords') or []
    if kws:
        kw = (kws[0] or '').upper()
        kf = _font(20)
        kw_w = draw.textbbox((0, 0), kw, font=kf)[2] + 32
        pill_y = CARD_PX - 110
        draw.rectangle([CARD_PX / 2 - kw_w / 2, pill_y,
                        CARD_PX / 2 + kw_w / 2, pill_y + 30],
                       fill=COLOR_KEYWORD_BG, outline=COLOR_TEXT_LIGHT, width=2)
        ww, wh = draw.textbbox((0, 0), kw, font=kf)[2:]
        draw.text((CARD_PX / 2 - ww / 2, pill_y + 15 - wh / 2),
                  kw, font=kf, fill=COLOR_TEXT_DARK)

    # Type label — top-right.
    tf = _font(18)
    tlabel = (card.get('type') or '').upper()
    tw2, th2 = draw.textbbox((0, 0), tlabel, font=tf)[2:]
    draw.text((CARD_PX - 30 - tw2, 50), tlabel,
              font=tf, fill=COLOR_FRAME_INNER)

    return canvas

def composite_animated(art_bytes: bytes, card: dict[str, Any]) -> list[Image.Image]:
    """Produce a 4-frame idle animation (Pillow only — no extra API cost).

    Animation: gentle 1-2px vertical bob simulating breathing, plus a
    subtle brightness pulse on the mana gem and stat circles. Frames
    loop at ~6fps (160ms per frame in the saved WebP).
    """
    raw = Image.open(__import__('io').BytesIO(art_bytes)).convert('RGBA')
    # Bob offsets — small, pixel-accurate (NEAREST scaling preserves edges).
    BOB = [0, -1, -2, -1]
    frames = []
    for bob_y in BOB:
        # Slide the art up by bob_y while keeping the same canvas size.
        shifted = Image.new('RGBA', raw.size, (0, 0, 0, 0))
        shifted.paste(raw, (0, bob_y))
        frames.append(_build_card_frame(shifted, card))
    return frames

def composite(art_bytes: bytes, card: dict[str, Any]) -> Image.Image:
    """Backwards-compat single-frame composite (still used by --validate
    callers expecting a single image)."""
    raw = Image.open(__import__('io').BytesIO(art_bytes)).convert('RGBA')
    return _build_card_frame(raw, card)

# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------
def load_state() -> dict:
    if not STATE_PATH.exists(): return {'done': [], 'failed': {}}
    try: return json.loads(STATE_PATH.read_text())
    except Exception: return {'done': [], 'failed': {}}

def save_state(s: dict): STATE_PATH.write_text(json.dumps(s, indent=2))

def process_card(card: dict[str, Any], force: bool = False) -> bool:
    out_png  = OUT / f'{card["id"]}.png'
    out_webp = OUT / f'{card["id"]}.webp'
    art_path = OUT / '_art' / f'{card["id"]}.webp'
    if out_webp.exists() and not force:
        return True
    print(f'  [{card["id"]}] {card["name"]} ({card.get("type")})')

    # Reuse art if already on disk.
    if art_path.exists() and not force:
        art_bytes = art_path.read_bytes()
        print('    using cached art')
    else:
        art_bytes = generate_art(card)
        art_path.write_bytes(art_bytes)
        print(f'    art generated ({len(art_bytes)//1024} KB)')
        time.sleep(PACING_S)   # rate-limit pacing

    # Static first frame as PNG for any consumer that wants stills.
    frames = composite_animated(art_bytes, card)
    frames[0].save(out_png, optimize=True)
    # Animated WebP — loop forever, 160ms per frame (~6fps idle).
    frames[0].save(
        out_webp,
        save_all=True,
        append_images=frames[1:],
        duration=160,
        loop=0,
        format='WEBP',
        quality=85,
        method=6,
    )
    print(f'    composited -> {out_webp} (4 frames animated) + {out_png}')
    return True

VALIDATION_SAMPLE = [
    'champ.warrior',         # Champion
    'u.firebolt',            # Spell with great prior result
    'leg.nyx',               # Legendary
    'undead.c034',           # Minion w/ stats (Cinder Reaper)
    'spire.s01.embercrown',  # Seasonal exclusive
]

VALIDATION_SAMPLE_PLUS = [
    'tok.boneknight',        # Token (no stats? has 3/3)
    'leg.korrik',             # Legendary tanky w/ taunt + spell-immune
    'c.bolt1',                # Lowest-cost common spell
    'champ.healer',           # Healer-class champion
    'fire.c001',              # Fire family small minion
    'storm.c020',             # Storm family — Tempest Hound
    'u.shieldguard',          # Uncommon defender
    'r.boltstorm',            # Rare AoE spell
    'spire.s06.permafrost',   # Frost-themed Spire seasonal
    'u.daggerthief',          # Rogue-themed uncommon
]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--validate', action='store_true')
    ap.add_argument('--validate-plus', action='store_true')
    ap.add_argument('--full', action='store_true')
    ap.add_argument('--resume', action='store_true')
    ap.add_argument('--limit', type=int, default=None)
    args = ap.parse_args()
    if not REPLICATE_TOKEN:
        print('REPLICATE_API_TOKEN required', file=sys.stderr); sys.exit(1)

    print('Loading catalogue…')
    cards = load_cards()
    print(f'  {len(cards)} cards')

    if args.validate:
        ids = VALIDATION_SAMPLE
    elif getattr(args, 'validate_plus', False):
        ids = VALIDATION_SAMPLE_PLUS
    else:
        ids = list(cards.keys())
        if args.limit: ids = ids[:args.limit]

    state = load_state() if args.resume else {'done': [], 'failed': {}}
    done_set = set(state['done'])

    started = time.time()
    for i, cid in enumerate(ids, 1):
        card = cards.get(cid)
        if not card:
            print(f'  [{cid}] not in catalogue — skip')
            continue
        if cid in done_set:
            continue
        try:
            process_card(card)
            state['done'].append(cid); done_set.add(cid)
            if cid in state['failed']: del state['failed'][cid]
        except Exception as e:
            print(f'    FAIL {e}')
            state['failed'][cid] = str(e)
        if i % 10 == 0:
            save_state(state)
        if i % 250 == 0:
            elapsed = (time.time() - started) / 60
            print(f'\n=== MILESTONE: {i}/{len(ids)} processed · {elapsed:.1f} min elapsed ===\n')
    save_state(state)
    elapsed_min = (time.time() - started) / 60
    print(f'\nDone. {len(state["done"])} succeeded, {len(state["failed"])} failed, {elapsed_min:.1f} min.')

if __name__ == '__main__':
    main()
