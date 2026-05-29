"""Pixel card pipeline v8 — character-only output.

Clay's clarification: the EXISTING Boltbound card UI in the site
already renders the frame, mana gem, name banner, stats, etc. We
just need to replace the Giphy GIF (the global-card-art image slot)
with a pixel art character.

This pipeline outputs ONLY the character/asset on a thematic
background. No frame, no text overlays. The image drops in where
the Giphy URL was; the site's card UI handles all the chrome.

Usage:
  REPLICATE_API_TOKEN=... python tools/pixel-card-pipeline-v8.py --validate
  REPLICATE_API_TOKEN=... python tools/pixel-card-pipeline-v8.py --full
"""
from __future__ import annotations
import argparse, io, json, os, subprocess, sys, time
from pathlib import Path
from typing import Any
import requests

ROOT = Path(__file__).resolve().parent.parent
OUT   = Path('/tmp/boltbound-pixel-cards-v8'); OUT.mkdir(exist_ok=True, parents=True)
STATE = OUT / '_state.json'

TOKEN = os.environ.get('REPLICATE_API_TOKEN')
MODEL_URL = 'https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions'
PACING_S = 14

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

def v8_prompt(card):
    """Character/asset only. No frame, no text, no card design."""
    name = card.get('name') or card['id']
    eff  = (card.get('text') or '').strip()
    t    = card.get('type') or 'minion'
    bg   = thematic_bg(card)

    pixel_emphasis = (
        "16-bit pixel art, chunky low-resolution pixel sprites, "
        "visible pixel blocks, blocky pixelated edges, retro SNES "
        "Final Fantasy VI / Chrono Trigger sprite style, NO smooth "
        "shading, NO painterly brush strokes, NO digital painting, "
        "NO photorealism — strictly pixelated 16-bit aesthetic"
    )

    if t == 'spell':
        subject = (
            f"a LARGE prominent glowing pixel-art spell effect representing "
            f"'{name}'"
            + (f" (a spell that {eff})" if eff else "")
            + f", filling most of the frame, displayed against a {bg} "
              "background. The spell effect is the dominant element, "
              "taking up roughly 70 percent of the visible area. No "
              "characters, just the magical effect visualization"
        )
    elif t == 'champion':
        subject = (
            f"a LARGE prominent pixel-art champion sprite character "
            f"representing '{name}', standing heroically and taking up "
            f"roughly 70 percent of the visible area, against a {bg} "
            "background. SNES JRPG hero-sprite style with violet and "
            "gold trim accents. Character is BIG and centered, dominant subject"
        )
    else:
        subject = (
            f"a LARGE prominent pixel-art battle sprite character "
            f"representing '{name}', taking up roughly 70 percent of "
            f"the visible area, against a {bg} background. SNES JRPG / "
            "Chrono Trigger battle-sprite style with violet and aurora-"
            "pink accents. Character is BIG and centered, dominant subject"
        )

    return (
        f"{pixel_emphasis}. {subject}. Vibrant 16-color palette, crisp "
        "pixel edges, no anti-aliasing. NO card frame, NO border, NO UI "
        "elements, NO text, NO letters, NO numbers, NO banners, NO gems, "
        "NO stat circles — JUST the character or spell effect against "
        "the background, filling the canvas edge-to-edge. Pure pixel-art "
        "illustration only."
    )

def generate(card):
    body = {'input': {
        'prompt': v8_prompt(card),
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

VALIDATION = ['champ.warrior','u.firebolt','leg.nyx','undead.c034','spire.s01.embercrown']

def load_state(): return json.loads(STATE.read_text()) if STATE.exists() else {'done':[],'failed':{}}
def save_state(s): STATE.write_text(json.dumps(s, indent=2))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--validate', action='store_true')
    ap.add_argument('--full', action='store_true')
    ap.add_argument('--resume', action='store_true')
    args = ap.parse_args()
    if not TOKEN: print('REPLICATE_API_TOKEN required'); sys.exit(1)

    cards = load_cards()
    ids = VALIDATION if args.validate else list(cards.keys())
    state = load_state() if args.resume else {'done':[],'failed':{}}
    done = set(state['done'])
    started = time.time()
    for i, cid in enumerate(ids, 1):
        card = cards.get(cid)
        if not card or cid in done: continue
        out_path = OUT / f'{cid}.webp'
        if out_path.exists(): state['done'].append(cid); continue
        try:
            print(f'[{i}/{len(ids)}] {cid} ({card["name"]})')
            data = generate(card)
            out_path.write_bytes(data)
            print(f'    saved {out_path} ({len(data)//1024} KB)')
            state['done'].append(cid)
            time.sleep(PACING_S)
        except Exception as e:
            print(f'    FAIL {e}'); state['failed'][cid] = str(e)
        if i % 10 == 0: save_state(state)
        if i % 250 == 0:
            mins = (time.time()-started)/60
            print(f'\n=== {i}/{len(ids)} · {mins:.1f} min ===\n')
    save_state(state)
    print(f'\nDone. {len(state["done"])} ok, {len(state["failed"])} fail.')

if __name__ == '__main__': main()
