"""Pixel card pipeline v7 — three Clay-driven fixes:
  1. Stronger pixel-art emphasis (chunky low-res, NOT painterly)
  2. Character takes up 70-80% of the art area, not centered with
     huge margin around it
  3. Per-rarity Pillow positions tuned so text/numbers fall inside
     the AI-rendered blank shapes
"""
from __future__ import annotations
import argparse, io, json, os, subprocess, sys, time
from pathlib import Path
from typing import Any
import requests
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONTS = Path(__file__).resolve().parent / 'fonts'
OUT   = Path('/tmp/boltbound-pixel-cards-v7'); OUT.mkdir(exist_ok=True, parents=True)
(OUT / '_art').mkdir(exist_ok=True)
STATE = OUT / '_state.json'

TOKEN = os.environ.get('REPLICATE_API_TOKEN')
MODEL_URL = 'https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions'
PACING_S = 14
CARD_PX  = 1024

RARITY_FRAME = {
    'common':    'simple silver and gray stone-tile pixel border',
    'uncommon':  'polished green-tinted silver pixel border with small emerald gem inlays',
    'rare':      'ornate blue-tinted polished silver pixel border with sapphire gem inlays',
    'epic':      'ornate violet-and-pink gradient pixel border with amethyst gems and aurora-pink filigree',
    'legendary': 'highly ornate aurora-pink-and-gold radiant pixel border with elaborate filigree and gold gem inlays',
    'champion':  'highly ornate aurora-pink-and-gold radiant pixel border with elaborate filigree and gold gem inlays',
    'token':     'simple silver pixel border',
}

# CALIBRATED v7: nudged per-rarity to land cleanly inside the AI's
# blank shapes. The legendary frames have slightly different gem
# positions than common ones.
OVERLAY_POS = {
    'common':    {'mana':(135,150),'type':(880,130),'name':(512,860),'atk':(140,920),'hp':(880,920),'name_max_w':620},
    'uncommon':  {'mana':(135,150),'type':(880,130),'name':(512,860),'atk':(140,920),'hp':(880,920),'name_max_w':620},
    'rare':      {'mana':(140,150),'type':(880,135),'name':(512,860),'atk':(140,920),'hp':(880,920),'name_max_w':620},
    'epic':      {'mana':(140,150),'type':(880,135),'name':(512,870),'atk':(140,920),'hp':(880,920),'name_max_w':620},
    'legendary': {'mana':(140,160),'type':(880,140),'name':(512,870),'atk':(140,925),'hp':(880,925),'name_max_w':600},
    'champion':  {'mana':(140,160),'type':(880,140),'name':(512,870),'atk':(140,925),'hp':(880,925),'name_max_w':600},
    'token':     {'mana':(135,150),'type':(880,130),'name':(512,860),'atk':(140,920),'hp':(880,920),'name_max_w':620},
}

def load_cards():
    node = (
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
    r = subprocess.run(['node','-e',node], cwd=str(ROOT),
                       capture_output=True, text=True, timeout=60)
    if r.returncode != 0: raise RuntimeError(r.stderr)
    return json.loads(r.stdout)

def thematic_bg(card):
    hay = ((card.get('id') or '') + ' ' + (card.get('name') or '') + ' '
           + (card.get('text') or '')).lower()
    pairs = [
        (('fire','ember','flame','pyre','cinder','lava','magma'),       'volcanic cavern with glowing lava streams'),
        (('frost','ice','glacier','snow','rime','permafrost','winter','sleet'), 'frozen glacier cave with hanging icicles'),
        (('storm','lightning','thunder','bolt','tempest','volt'),       'stormy mountain peak with crackling lightning'),
        (('undead','bone','crypt','tomb','reaper','lich','skull','reliquary'),  'shadowy crypt with green torchlight'),
        (('verdant','root','grove','briar','thorn','forest','leaf'),    'mossy forest grove with rays of light'),
        (('sand','dune','desert','bazaar','sphinx','oasis'),            'desert dune sunset with sandstone ruins'),
        (('star','cosmos','astral','nebula','celestial','aurora'),      'cosmic starfield with violet nebula'),
        (('mirror','echo','twin','shimmer','glass'),                    'hall of mirrors with crystalline reflections'),
        (('vampire','crimson','velvet','blood','fang','catacomb'),      'gothic catacomb with crimson banners'),
        (('gear','cog','forge','automaton','piston','clockwork','mech'),'clockwork foundry interior with gears'),
        (('dragon','wyrm','drake'),                                     'dragon lair cavern with treasure piles'),
        (('tide','depth','kraken','coral','siren','drown','ocean'),     'sunken underwater temple'),
    ]
    for words, bg in pairs:
        if any(w in hay for w in words): return bg
    return 'dark arena with subtle violet glow and aurora particle dust'

def v7_prompt(card):
    """Stronger pixel-art language + LARGE character + blank slot shapes."""
    name  = card.get('name') or card['id']
    t     = card.get('type') or 'minion'
    rarity = (card.get('rarity') or 'common').lower()
    frame = RARITY_FRAME.get(rarity, RARITY_FRAME['common'])
    bg    = thematic_bg(card)
    has_stats = t in ('minion','champion') and (card.get('atk') or 0) > 0

    # KEY: hammer "pixel art" multiple ways + specify LARGE subject size.
    pixel_emphasis = (
        "16-bit pixel art style, chunky low-resolution pixel sprites, "
        "visible pixel blocks, blocky pixelated edges, retro SNES "
        "Final Fantasy VI / Chrono Trigger sprite style, NO smooth "
        "shading, NO painterly brush strokes, NO digital painting, "
        "NO photorealism — strictly pixelated 16-bit aesthetic"
    )

    if t == 'spell':
        subject = (
            f"a LARGE prominent glowing pixel-art spell effect that "
            f"fills most of the art area, displayed against a {bg} "
            "background. The spell effect is the dominant element, "
            "taking up roughly 70 percent of the visible art area"
        )
    elif t == 'champion':
        subject = (
            f"a LARGE prominent pixel-art champion sprite character "
            "standing heroically, the character takes up roughly "
            "70 percent of the visible art area (most of the art "
            f"portion), against a {bg} background. SNES JRPG hero-"
            "sprite style with violet and gold trim. Character is "
            "BIG and centered, dominant subject"
        )
    else:
        subject = (
            f"a LARGE prominent pixel-art battle sprite character, "
            "the character takes up roughly 70 percent of the visible "
            f"art area (most of the art portion), against a {bg} "
            "background. SNES JRPG / Chrono Trigger battle-sprite "
            "style with violet and aurora-pink accents. Character is "
            "BIG and centered, dominant subject"
        )

    return (
        f"{pixel_emphasis}. Trading card template, square 1:1 aspect, "
        f"{frame}. "
        f"Card art portion (centered, takes about 55% of the card height) "
        f"shows {subject}. "
        # Solid blank shapes — same v6 trick that worked
        "Card layout includes these BLANK UNMARKED PIXEL SHAPES (smooth "
        "uniform solid color, completely flat surface, no writing, no "
        "etching, no symbols): "
        "(1) a small smooth solid polished violet circular gem in the "
        "upper-left corner (perfectly round, no markings, no patterns), "
        "(2) a small smooth solid colored pixel rectangle block in the "
        "upper-right corner (uniform flat color), "
        "(3) a horizontal smooth solid colored pixel rectangle bar in "
        "the lower 1/4 of the card (polished metal nameplate, completely "
        "unmarked, smooth flat color)"
        + (", (4) two smooth solid colored pixel disks in the bottom "
           "corners — one red disk on the left and one green disk on "
           "the right (both perfectly smooth and unmarked)"
           if has_stats else "")
        + ". TEMPLATE CARD — every gem, banner, and stat shape is an "
          "unmarked smooth flat-colored surface. No text. No letters. "
          "No numbers. No symbols. Blank template ready for overlay text."
    )

def generate(card):
    body = {'input': {
        'prompt': v7_prompt(card),
        'aspect_ratio': '1:1', 'output_format': 'webp', 'output_quality': 95,
        'num_outputs': 1, 'seed': abs(hash(card['id'])) % (2**31),
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
        break
    p = r.json()
    while p.get('status') in ('starting','processing'):
        time.sleep(1.2)
        p = requests.get(p['urls']['get'], headers={'Authorization':f'Bearer {TOKEN}'}).json()
    if p.get('status') != 'succeeded': raise RuntimeError(p.get('status'))
    url = p['output'][0] if isinstance(p['output'], list) else p['output']
    return requests.get(url, timeout=60).content

def font(size, style='header'):
    fn = 'PressStart2P-Regular.ttf' if style=='header' else 'VT323-Regular.ttf'
    try: return ImageFont.truetype(str(FONTS / fn), size)
    except OSError: return ImageFont.load_default()

def stamp_text(img, card):
    img = img.convert('RGBA')
    if img.size != (CARD_PX, CARD_PX):
        img = img.resize((CARD_PX, CARD_PX), Image.NEAREST)
    draw = ImageDraw.Draw(img)
    rarity = (card.get('rarity') or 'common').lower()
    pos = OVERLAY_POS.get(rarity, OVERLAY_POS['common'])

    def centered(text, xy, fnt, fill, stroke=(0,0,0,255), stroke_w=3):
        bbox = draw.textbbox((0,0), text, font=fnt)
        tw, th = bbox[2]-bbox[0], bbox[3]-bbox[1]
        draw.text((xy[0]-tw/2, xy[1]-th/2), text,
                  font=fnt, fill=fill, stroke_width=stroke_w, stroke_fill=stroke)

    centered(str(card.get('mana') or 0), pos['mana'], font(38, 'header'), (255,255,255,255))
    tlabel = {'CHAMPION':'CHMP','MINION':'MIN','SPELL':'SPL','TOKEN':'TOK'}.get(
        (card.get('type') or '').upper(), (card.get('type') or '').upper()[:4])
    centered(tlabel, pos['type'], font(18, 'header'), (255,255,255,255))

    name = card.get('name') or card['id']
    name_max_w = pos.get('name_max_w', int(CARD_PX * 0.72))
    for sz in (38, 32, 28, 24, 20, 18, 16):
        nf = font(sz, 'header')
        if draw.textlength(name, font=nf) <= name_max_w: break
    centered(name, pos['name'], nf, (255,255,255,255), stroke_w=4)

    if (card.get('type') in ('minion','champion') and (card.get('atk') or 0) > 0):
        centered(str(card.get('atk') or 0), pos['atk'], font(40, 'header'),
                 (255,230,230,255), stroke=(120,20,20,255), stroke_w=4)
        centered(str(card.get('hp') or 0),  pos['hp'],  font(40, 'header'),
                 (230,255,230,255), stroke=(20,100,30,255), stroke_w=4)
    return img

VALIDATION = ['champ.warrior','u.firebolt','leg.nyx','undead.c034','spire.s01.embercrown']

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--validate', action='store_true')
    ap.add_argument('--full', action='store_true')
    args = ap.parse_args()
    if not TOKEN: print('REPLICATE_API_TOKEN required'); sys.exit(1)

    cards = load_cards()
    ids = VALIDATION if args.validate else list(cards.keys())
    for i, cid in enumerate(ids, 1):
        card = cards.get(cid)
        if not card: continue
        art_path = OUT / '_art' / f'{cid}.webp'
        out_path = OUT / f'{cid}.png'
        if out_path.exists(): continue
        try:
            print(f'[{i}/{len(ids)}] {cid} ({card["name"]})')
            if art_path.exists():
                data = art_path.read_bytes(); print('    cached')
            else:
                data = generate(card)
                art_path.write_bytes(data)
                print(f'    generated ({len(data)//1024} KB)')
                time.sleep(PACING_S)
            stamped = stamp_text(Image.open(io.BytesIO(data)), card)
            stamped.save(out_path, optimize=True)
            print(f'    saved {out_path}')
        except Exception as e:
            print(f'    FAIL {e}')
    print('\nDone.')

if __name__ == '__main__': main()
