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
OUT  = Path('/tmp/boltbound-pixel-cards-v2')
OUT.mkdir(exist_ok=True, parents=True)
(OUT / '_art').mkdir(exist_ok=True)
STATE_PATH = OUT / '_state.json'
FRAMES_DIR = Path('/tmp/boltbound-pixel-frames-v2')
FONTS_DIR  = Path(__file__).resolve().parent / 'fonts'

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

CARD_W  = 720                # final card width (5:7 TCG ratio)
CARD_H  = 1008               # final card height
ART_PX  = 1024               # AI art generation size (we'll crop)
PACING_S = 14                # between Replicate calls — within rate limit
CARD_PX = CARD_W             # kept for any legacy reference (square assumption)

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

def thematic_background(card: dict[str, Any]) -> str:
    """Pick a contextual background from card.id family + name keywords.
    Boltbound has rough thematic families embedded in the id prefix
    (fire.*, storm.*, undead.*, frost.*, etc) plus seasonal Spire cards
    (spire.s01-s12). Falls back to a generic dark gradient when nothing
    matches, so EVERY card gets SOME background."""
    cid  = (card.get('id')   or '').lower()
    name = (card.get('name') or '').lower()
    text = (card.get('text') or '').lower()
    hay  = cid + ' ' + name + ' ' + text

    if any(w in hay for w in ('fire', 'ember', 'flame', 'pyre', 'cinder', 'lava', 'magma', 'volcanic')):
        return 'pixel-art volcanic cavern with glowing lava streams and ember particles'
    if any(w in hay for w in ('frost', 'ice', 'glacier', 'snow', 'rime', 'permafrost', 'winter', 'sleet')):
        return 'pixel-art frozen glacier cave with hanging icicles and snow drifts'
    if any(w in hay for w in ('storm', 'lightning', 'thunder', 'bolt', 'tempest', 'volt')):
        return 'pixel-art stormy mountain peak at night with crackling lightning'
    if any(w in hay for w in ('undead', 'bone', 'crypt', 'tomb', 'reaper', 'lich', 'skull', 'reliquary')):
        return 'pixel-art shadowy crypt with cracked tombstones and faint green torchlight'
    if any(w in hay for w in ('verdant', 'root', 'grove', 'briar', 'thorn', 'forest', 'leaf')):
        return 'pixel-art mossy forest grove with rays of light through canopy'
    if any(w in hay for w in ('sand', 'dune', 'desert', 'bazaar', 'sphinx', 'oasis')):
        return 'pixel-art desert dune sunset with sandstone ruins silhouette'
    if any(w in hay for w in ('star', 'cosmos', 'astral', 'nebula', 'celestial', 'aurora')):
        return 'pixel-art cosmic starfield with violet and aurora-pink nebula swirls'
    if any(w in hay for w in ('mirror', 'echo', 'twin', 'shimmer', 'glass')):
        return 'pixel-art hall of mirrors with crystalline reflections'
    if any(w in hay for w in ('vampire', 'crimson', 'velvet', 'blood', 'fang', 'catacomb')):
        return 'pixel-art gothic catacomb with crimson banners and candle light'
    if any(w in hay for w in ('gear', 'cog', 'forge', 'automaton', 'piston', 'clockwork', 'mech')):
        return 'pixel-art clockwork foundry interior with gears and steam'
    if any(w in hay for w in ('dragon', 'wyrm', 'drake')):
        return 'pixel-art dragon lair cavern with treasure piles and dim torch glow'
    if any(w in hay for w in ('tide', 'depth', 'kraken', 'coral', 'siren', 'drown', 'ocean')):
        return 'pixel-art sunken underwater temple with bioluminescent algae'
    # Default — moody arena suitable for any minion/champion.
    return 'pixel-art dark arena floor with subtle violet glow and aurora particle dust'

def art_prompt(card: dict[str, Any]) -> str:
    name = card['name']
    eff  = short_effect(card)
    t    = card.get('type') or 'minion'
    bg   = thematic_background(card)
    if t == 'spell':
        return (
            f"16-bit retro pixel art magical spell effect representing {name}, "
            f"a spell that {eff}. The effect is centered against a {bg} background. "
            "Classic SNES JRPG spell-effect style. Vibrant 16-color palette with "
            "violet and aurora-pink. Glowing particles, runic shapes, energy bolts "
            "as appropriate. Crisp pixel edges. No characters, just the effect over "
            "the background. No text in image, no UI elements, no card frame, fill "
            "the whole canvas."
        )
    if t == 'champion':
        return (
            f"16-bit retro pixel art ornate character sprite of {name}, a "
            f"legendary champion who {eff}, standing in front of a {bg} background. "
            "Classic SNES Final Fantasy VI hero-sprite style. Vibrant 16-color "
            "palette with violet, aurora-pink, and gold trim on the character. "
            "Crisp pixel edges, dynamic action pose, glowing accent details. "
            "Centered character, no card frame, no text, fill the whole canvas."
        )
    return (
        f"16-bit retro pixel art character sprite of {name}, a {eff} minion, "
        f"standing in front of a {bg} background. Classic SNES Final Fantasy VI "
        "/ Chrono Trigger battle-sprite style. Vibrant 16-color palette with "
        "violet and aurora-pink accents on the character. Crisp pixel edges, "
        "dithering shadows, idle action stance. Centered character, no card "
        "frame, no text, fill the whole canvas."
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
def _font(size: int, style: str = 'header') -> ImageFont.ImageFont:
    """style='header' → Press Start 2P (chunky pixel headlines).
       style='body'   → VT323 (slim pixel body text)."""
    name = 'PressStart2P-Regular.ttf' if style == 'header' else 'VT323-Regular.ttf'
    path = FONTS_DIR / name
    if path.exists():
        try: return ImageFont.truetype(str(path), size)
        except OSError: pass
    # Fallback to system fonts only if the bundled pixel fonts are missing.
    return ImageFont.load_default()

def _wrap_text(draw: ImageDraw.ImageDraw, text: str, font, max_w: int) -> list[str]:
    """Greedy word-wrap for pixel-art lore boxes."""
    if not text: return []
    words = text.split()
    lines, cur = [], ''
    for w in words:
        trial = (cur + ' ' + w).strip()
        if draw.textlength(trial, font=font) <= max_w:
            cur = trial
        else:
            if cur: lines.append(cur)
            cur = w
    if cur: lines.append(cur)
    return lines

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
    """Load the AI-generated pixel frame for the matching rarity, resized
    to CARD_W x CARD_H (portrait)."""
    name = RARITY_TO_FRAME.get(rarity, 'common')
    path = FRAMES_DIR / f'frame-{name}-clean.png'
    if not path.exists():
        return Image.new('RGBA', (CARD_W, CARD_H), (0, 0, 0, 0))
    return Image.open(path).convert('RGBA').resize((CARD_W, CARD_H), Image.NEAREST)

def _build_card_frame(art_img: Image.Image, card: dict[str, Any]) -> Image.Image:
    """Build a single finished card for the portrait (5:7) frame v2.
    Layout slots match pixel-frame-generator-v2.py's baked positions:
      - mana gem socket: top-left circle (text inside)
      - type slot: top-right small banner
      - character art: center cutout
      - name banner: lower-middle pixel ribbon
      - lore panel: bottom 1/5
    """
    canvas = Image.new('RGBA', (CARD_W, CARD_H), COLOR_FRAME_DARK)

    # Center cutout matches the v2 frame generator's hard cut:
    #   horizontal: 62% width centered → margin (1-0.62)/2 = 19%
    #   vertical:   42% height starting at y = 15%
    art_w = int(CARD_W * 0.62)
    art_h = int(CARD_H * 0.42)
    art_x = (CARD_W - art_w) // 2
    art_y = int(CARD_H * 0.15)

    # Crop+resize the AI art to fill the slot. Schnell renders at 1:1 or
    # 2:3; either way center-crop to the slot's aspect, then NEAREST-
    # resize to preserve the pixel feel.
    src = art_img.convert('RGBA')
    sw, sh = src.size
    target_ratio = art_w / art_h
    src_ratio    = sw / sh
    if src_ratio > target_ratio:
        # source is wider — crop sides
        new_w = int(sh * target_ratio)
        x0 = (sw - new_w) // 2
        src = src.crop((x0, 0, x0 + new_w, sh))
    else:
        new_h = int(sw / target_ratio)
        y0 = (sh - new_h) // 2
        src = src.crop((0, y0, sw, y0 + new_h))
    art = src.resize((art_w, art_h), Image.NEAREST)
    canvas.paste(art, (art_x, art_y), art)

    # AI frame on top — its baked-in transparent center reveals the art.
    frame = _load_frame(card.get('rarity') or 'common')
    canvas.paste(frame, (0, 0), frame)

    draw = ImageDraw.Draw(canvas)

    # Mana cost — written inside the baked gem socket (top-left corner).
    # The AI frame puts an empty circular socket there; we just stamp text.
    mana = str(card.get('mana') or '0')
    mana_font = _font(28, 'header')
    mx, my = int(CARD_W * 0.10), int(CARD_H * 0.067)
    tw, th = draw.textbbox((0, 0), mana, font=mana_font)[2:]
    draw.text((mx - tw / 2, my - th / 2),
              mana, font=mana_font, fill=COLOR_TEXT_LIGHT,
              stroke_width=2, stroke_fill=(0, 0, 0, 255))

    # Type label — written inside the baked banner slot (top-right).
    tlabel = (card.get('type') or '').upper()[:4]   # short: CHAMP / MIN / SPELL → SPEL
    tlabel = {'CHAM': 'CHMP', 'MINI': 'MIN', 'SPEL': 'SPL'}.get(tlabel, tlabel)
    tf = _font(13, 'header')
    tw2, th2 = draw.textbbox((0, 0), tlabel, font=tf)[2:]
    txr, tyr = int(CARD_W * 0.84), int(CARD_H * 0.07)
    draw.text((txr - tw2 / 2, tyr - th2 / 2),
              tlabel, font=tf, fill=COLOR_TEXT_LIGHT,
              stroke_width=2, stroke_fill=(0, 0, 0, 255))

    # Name — written DIRECTLY on the baked name banner ribbon (no backplate).
    # Banner sits around 62% down the card.
    name = card.get('name') or card['id']
    # Try multiple sizes to fit the name into the banner width.
    banner_w_max = int(CARD_W * 0.74)
    for size in (22, 19, 16, 14, 12):
        nf = _font(size, 'header')
        nw = draw.textlength(name, font=nf)
        if nw <= banner_w_max:
            break
    nh = draw.textbbox((0, 0), name, font=nf)[3]
    ny = int(CARD_H * 0.62)
    draw.text((CARD_W / 2 - nw / 2, ny - nh / 2),
              name, font=nf, fill=COLOR_TEXT_LIGHT,
              stroke_width=2, stroke_fill=(0, 0, 0, 255))

    # Stats — small atk/hp pixel digits in bottom corners.
    if (card.get('type') in ('minion', 'champion') and (card.get('atk') or 0) > 0):
        sf = _font(20, 'header')
        atk = str(card.get('atk') or 0)
        hp  = str(card.get('hp')  or 0)
        sy  = int(CARD_H * 0.84)
        # ATK left, red-tinted.
        aw = draw.textbbox((0, 0), atk, font=sf)[2]
        draw.text((int(CARD_W * 0.08) - aw / 2, sy), atk,
                  font=sf, fill=(255, 200, 200, 255),
                  stroke_width=2, stroke_fill=(120, 20, 20, 255))
        # HP right, green-tinted.
        hw = draw.textbbox((0, 0), hp, font=sf)[2]
        draw.text((int(CARD_W * 0.92) - hw / 2, sy), hp,
                  font=sf, fill=(200, 255, 200, 255),
                  stroke_width=2, stroke_fill=(20, 100, 30, 255))

    # Lore / effect text — pixel body font inside the bottom lore panel.
    lore = (card.get('text') or '').strip()
    if not lore:
        # Pad with a generic lore line for stat-only minions.
        lore = card.get('keywords') and (', '.join(k.upper() for k in card['keywords'])) or ''
    if lore:
        lf = _font(22, 'body')
        lore_w = int(CARD_W * 0.78)
        lines = _wrap_text(draw, lore, lf, lore_w)[:3]   # max 3 lines fits
        line_h = draw.textbbox((0, 0), 'Mg', font=lf)[3] + 2
        ly = int(CARD_H * 0.83)
        for i, ln in enumerate(lines):
            lw = draw.textlength(ln, font=lf)
            draw.text((CARD_W / 2 - lw / 2, ly + i * line_h),
                      ln, font=lf, fill=(40, 24, 16, 255))

    return canvas

def composite_animated(art_bytes: bytes, card: dict[str, Any]) -> list[Image.Image]:
    """Produce a 4-frame idle animation (Pillow only — no extra API cost).

    Animation: gentle 1-2px vertical bob simulating breathing, plus a
    subtle brightness pulse on the mana gem and stat circles. Frames
    loop at ~6fps (160ms per frame in the saved WebP).
    """
    raw = Image.open(__import__('io').BytesIO(art_bytes)).convert('RGBA')
    BOB = [0, -2, -4, -2]   # bigger range for portrait — more visible
    frames = []
    for bob_y in BOB:
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
