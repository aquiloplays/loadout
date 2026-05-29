"""Pixel card pipeline v5 — hybrid AI + Pillow text-stamping.

Best-results workflow per PIXEL-CARD-WORKFLOW.md:
  1. Schnell renders the FULL square card with frame, character,
     thematic background, and EMPTY mana/banner/stat sockets.
  2. Pillow stamps clean text into those empty sockets using
     Press Start 2P + VT323 with stroked outlines.
  3. Result: AI's visual cohesion + 100% legible numbers/name.

Static PNG output. Gameplay UI handles animation.

Usage:
  REPLICATE_API_TOKEN=... python tools/pixel-card-pipeline-v5.py --validate
  REPLICATE_API_TOKEN=... python tools/pixel-card-pipeline-v5.py --full
"""
from __future__ import annotations
import argparse, io, json, os, subprocess, sys, time
from pathlib import Path
from typing import Any
import requests
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONTS = Path(__file__).resolve().parent / 'fonts'
OUT   = Path('/tmp/boltbound-pixel-cards-v5'); OUT.mkdir(exist_ok=True, parents=True)
(OUT / '_art').mkdir(exist_ok=True)
STATE = OUT / '_state.json'

TOKEN = os.environ.get('REPLICATE_API_TOKEN')
MODEL_URL = 'https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions'
PACING_S = 14
CARD_PX  = 1024   # AI native; final asset preserves this size

RARITY_FRAME = {
    'common':    'simple silver and gray stone-tile pixel border',
    'uncommon':  'polished green-tinted silver pixel border with small emerald gem inlays',
    'rare':      'ornate blue-tinted polished silver pixel border with sapphire gem inlays',
    'epic':      'ornate violet-and-pink gradient pixel border with amethyst gems and aurora-pink filigree',
    'legendary': 'highly ornate aurora-pink-and-gold radiant pixel border with elaborate filigree and gold gem inlays',
    'champion':  'highly ornate aurora-pink-and-gold radiant pixel border with elaborate filigree and gold gem inlays',
    'token':     'simple silver pixel border',
}

# Per-rarity overlay positions (calibrated by running one card per
# rarity and eyeballing where the AI puts each socket). These are in
# the 1024x1024 native canvas; the cards are saved at native resolution.
OVERLAY_POS = {
    # Each entry: (x, y) center for the text glyph
    'common':    {'mana': (110, 110), 'type': (880, 110), 'name': (512, 800), 'atk': (110, 920), 'hp': (914, 920)},
    'uncommon':  {'mana': (110, 110), 'type': (880, 110), 'name': (512, 800), 'atk': (110, 920), 'hp': (914, 920)},
    'rare':      {'mana': (110, 110), 'type': (880, 110), 'name': (512, 800), 'atk': (110, 920), 'hp': (914, 920)},
    'epic':      {'mana': (110, 110), 'type': (880, 110), 'name': (512, 810), 'atk': (110, 920), 'hp': (914, 920)},
    'legendary': {'mana': (115, 115), 'type': (885, 115), 'name': (512, 820), 'atk': (115, 925), 'hp': (910, 925)},
    'champion':  {'mana': (115, 115), 'type': (885, 115), 'name': (512, 820), 'atk': (115, 925), 'hp': (910, 925)},
    'token':     {'mana': (110, 110), 'type': (880, 110), 'name': (512, 800), 'atk': (110, 920), 'hp': (914, 920)},
}

def load_cards() -> dict[str, dict[str, Any]]:
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
        (('undead','bone','crypt','tomb','reaper','lich','skull','reliquary'),  'shadowy crypt with cracked tombstones and faint green torchlight'),
        (('verdant','root','grove','briar','thorn','forest','leaf'),    'mossy forest grove with rays of light through canopy'),
        (('sand','dune','desert','bazaar','sphinx','oasis'),            'desert dune sunset with sandstone ruins'),
        (('star','cosmos','astral','nebula','celestial','aurora'),      'cosmic starfield with violet and aurora-pink nebula'),
        (('mirror','echo','twin','shimmer','glass'),                    'hall of mirrors with crystalline reflections'),
        (('vampire','crimson','velvet','blood','fang','catacomb'),      'gothic catacomb with crimson banners and candle light'),
        (('gear','cog','forge','automaton','piston','clockwork','mech'),'clockwork foundry interior with gears and steam'),
        (('dragon','wyrm','drake'),                                     'dragon lair cavern with treasure piles'),
        (('tide','depth','kraken','coral','siren','drown','ocean'),     'sunken underwater temple with bioluminescent algae'),
    ]
    for words, bg in pairs:
        if any(w in hay for w in words): return bg
    return 'dark arena with subtle violet glow and aurora particle dust'

def empty_slot_prompt(card):
    """Prompt asks AI to render EMPTY slots so Pillow can stamp text cleanly."""
    name  = card.get('name') or card['id']
    eff   = (card.get('text') or '').strip() or ' '
    t     = card.get('type') or 'minion'
    rarity = (card.get('rarity') or 'common').lower()
    frame = RARITY_FRAME.get(rarity, RARITY_FRAME['common'])
    bg    = thematic_bg(card)

    if t == 'spell':
        subject = (
            f"a glowing pixel-art spell effect representing '{name}' "
            f"(a spell that {eff}), centered against a {bg} background. "
            "No characters, just the effect visualization."
        )
    elif t == 'champion':
        subject = (
            f"a noble pixel-art champion sprite representing '{name}', "
            f"standing heroically in front of a {bg} background. SNES "
            "JRPG hero-sprite style with violet and gold trim."
        )
    else:
        subject = (
            f"a pixel-art battle sprite representing '{name}', "
            f"standing in front of a {bg} background. SNES JRPG / "
            "Chrono Trigger battle-sprite style with violet and "
            "aurora-pink accents on the character."
        )

    return (
        "16-bit retro pixel art complete trading card design, square 1:1 "
        f"aspect. The card has {frame}. "
        f"The card art portion (centered, takes about 55% of the card) shows {subject} "
        "The card layout includes these UI shapes (all EMPTY - no text, no letters, no numbers): "
        "(a) a glowing pixel mana gem socket in the top-left corner (empty circular gem), "
        "(b) a small pixel type-label banner in the top-right corner (empty banner shape), "
        "(c) a horizontal pixel name banner ribbon in the lower-middle area (empty ribbon), "
        + ("(d) two pixel stat circles at the bottom corners, one red and one green, both empty. "
           if t in ('minion','champion') and (card.get('atk') or 0) > 0 else "")
        + "Vibrant 16-color palette, crisp pixel edges, no anti-aliasing, "
          "classic Final Fantasy VI / Chrono Trigger trading card aesthetic. "
          "NO TEXT, NO LETTERS, NO NUMBERS anywhere - every banner and gem is empty."
    )

def generate(card):
    body = {'input': {
        'prompt':         empty_slot_prompt(card),
        'aspect_ratio':   '1:1',
        'output_format':  'webp',
        'output_quality': 95,
        'num_outputs':    1,
        'seed':           abs(hash(card['id'])) % (2**31),
        'go_fast':        True,
        'megapixels':     '1',
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
    pos = OVERLAY_POS.get((card.get('rarity') or 'common').lower(), OVERLAY_POS['common'])

    def centered(text, xy, fnt, fill, stroke=(0,0,0,255), stroke_w=3):
        bbox = draw.textbbox((0,0), text, font=fnt)
        tw, th = bbox[2]-bbox[0], bbox[3]-bbox[1]
        draw.text((xy[0]-tw/2, xy[1]-th/2), text,
                  font=fnt, fill=fill, stroke_width=stroke_w, stroke_fill=stroke)

    # Mana — chunky pixel header.
    centered(str(card.get('mana') or 0), pos['mana'], font(38, 'header'), (255,255,255,255))

    # Type label — short pixel header, all caps abbreviated.
    tlabel = (card.get('type') or '').upper()
    tlabel = {'CHAMPION':'CHMP','MINION':'MIN','SPELL':'SPL','TOKEN':'TOK'}.get(tlabel, tlabel[:4])
    centered(tlabel, pos['type'], font(20, 'header'), (255,255,255,255))

    # Name — auto-shrink to fit the banner width.
    name = card.get('name') or card['id']
    name_max_w = int(CARD_PX * 0.72)
    for sz in (40, 34, 30, 26, 22, 18):
        nf = font(sz, 'header')
        if draw.textlength(name, font=nf) <= name_max_w: break
    centered(name, pos['name'], nf, (255,255,255,255), stroke_w=4)

    # Stats — minions + champions only.
    if (card.get('type') in ('minion','champion') and (card.get('atk') or 0) > 0):
        centered(str(card.get('atk') or 0), pos['atk'], font(40, 'header'),
                 (255,230,230,255), stroke=(120,20,20,255), stroke_w=4)
        centered(str(card.get('hp') or 0),  pos['hp'],  font(40, 'header'),
                 (230,255,230,255), stroke=(20,100,30,255), stroke_w=4)
    return img

VALIDATION = ['champ.warrior','u.firebolt','leg.nyx','undead.c034','spire.s01.embercrown']
VALIDATION_PLUS = ['tok.boneknight','leg.korrik','c.bolt1','champ.healer','fire.c001',
                   'storm.c020','u.shieldguard','r.boltstorm','spire.s06.permafrost','u.daggerthief']

def load_state(): return json.loads(STATE.read_text()) if STATE.exists() else {'done':[],'failed':{}}
def save_state(s): STATE.write_text(json.dumps(s, indent=2))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--validate', action='store_true')
    ap.add_argument('--validate-plus', action='store_true')
    ap.add_argument('--full', action='store_true')
    ap.add_argument('--resume', action='store_true')
    args = ap.parse_args()
    if not TOKEN: print('REPLICATE_API_TOKEN required'); sys.exit(1)

    cards = load_cards()
    if args.validate: ids = VALIDATION
    elif getattr(args,'validate_plus', False): ids = VALIDATION_PLUS
    else: ids = list(cards.keys())

    state = load_state() if args.resume else {'done':[],'failed':{}}
    done = set(state['done'])
    started = time.time()
    for i, cid in enumerate(ids, 1):
        card = cards.get(cid)
        if not card or cid in done: continue
        art_path = OUT / '_art' / f'{cid}.webp'
        out_path = OUT / f'{cid}.png'
        if out_path.exists(): state['done'].append(cid); continue
        try:
            print(f'[{i}/{len(ids)}] {cid} ({card["name"]})')
            if art_path.exists():
                data = art_path.read_bytes(); print('    cached art')
            else:
                data = generate(card)
                art_path.write_bytes(data)
                print(f'    generated ({len(data)//1024} KB)')
                time.sleep(PACING_S)
            stamped = stamp_text(Image.open(io.BytesIO(data)), card)
            stamped.save(out_path, optimize=True)
            print(f'    saved {out_path}')
            state['done'].append(cid)
        except Exception as e:
            print(f'    FAIL {e}'); state['failed'][cid] = str(e)
        if i % 10 == 0: save_state(state)
        if i % 250 == 0:
            mins = (time.time()-started)/60
            print(f'\n=== {i}/{len(ids)} · {mins:.1f} min ===\n')
    save_state(state)
    print(f'\nDone. {len(state["done"])} ok, {len(state["failed"])} fail.')

if __name__ == '__main__': main()
