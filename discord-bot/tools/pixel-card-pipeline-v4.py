"""Pixel card pipeline v4 — all-AI single-image approach.

Per Clay's 2026-05-28 direction: AI generates the ENTIRE card including
frame, gems, banner, stats — Pillow does NOT add any text overlays.
The gameplay UI on aquilo.gg overlays readable text at runtime over
the asset image.

Square 1:1 aspect. Static PNG output (no animation in the asset —
the gameplay UI handles any motion since only the character should
move and isolating the character from a single AI image is
impractical without a second generation pass).

Usage:
  REPLICATE_API_TOKEN=... python tools/pixel-card-pipeline-v4.py --validate
  REPLICATE_API_TOKEN=... python tools/pixel-card-pipeline-v4.py --full
"""
from __future__ import annotations
import argparse, json, os, subprocess, sys, time
from pathlib import Path
from typing import Any
import requests

ROOT = Path(__file__).resolve().parent.parent
OUT  = Path('/tmp/boltbound-pixel-cards-v4'); OUT.mkdir(exist_ok=True, parents=True)
STATE_PATH = OUT / '_state.json'

REPLICATE_TOKEN = os.environ.get('REPLICATE_API_TOKEN')
MODEL_URL = 'https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions'
PACING_S = 14

RARITY_FRAME_STYLE = {
    'common':    'simple silver and gray stone-tile pixel border, basic SNES menu-frame style',
    'uncommon':  'polished green-tinted silver pixel border with small emerald gem inlays',
    'rare':      'ornate blue-tinted polished silver pixel border with sapphire gem inlays',
    'epic':      'ornate violet-and-pink gradient pixel border with amethyst gems and aurora-pink filigree',
    'legendary': 'highly ornate aurora-pink-and-gold radiant pixel border with elaborate filigree and gold gem inlays',
    'champion':  'highly ornate aurora-pink-and-gold radiant pixel border with elaborate filigree and gold gem inlays',
    'token':     'simple silver pixel border',
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
    r = subprocess.run(['node', '-e', node], cwd=str(ROOT),
                       capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError(f'node dump failed: {r.stderr}')
    return json.loads(r.stdout)

def thematic_background(card: dict[str, Any]) -> str:
    hay = ((card.get('id') or '') + ' ' + (card.get('name') or '') + ' '
           + (card.get('text') or '')).lower()
    if any(w in hay for w in ('fire','ember','flame','pyre','cinder','lava','magma','volcanic')):
        return 'volcanic cavern with glowing lava streams'
    if any(w in hay for w in ('frost','ice','glacier','snow','rime','permafrost','winter','sleet')):
        return 'frozen glacier cave with hanging icicles'
    if any(w in hay for w in ('storm','lightning','thunder','bolt','tempest','volt')):
        return 'stormy mountain peak with crackling lightning'
    if any(w in hay for w in ('undead','bone','crypt','tomb','reaper','lich','skull','reliquary')):
        return 'shadowy crypt with cracked tombstones and faint green torchlight'
    if any(w in hay for w in ('verdant','root','grove','briar','thorn','forest','leaf')):
        return 'mossy forest grove with rays of light through canopy'
    if any(w in hay for w in ('sand','dune','desert','bazaar','sphinx','oasis')):
        return 'desert dune sunset with sandstone ruins silhouette'
    if any(w in hay for w in ('star','cosmos','astral','nebula','celestial','aurora')):
        return 'cosmic starfield with violet and aurora-pink nebula swirls'
    if any(w in hay for w in ('mirror','echo','twin','shimmer','glass')):
        return 'hall of mirrors with crystalline reflections'
    if any(w in hay for w in ('vampire','crimson','velvet','blood','fang','catacomb')):
        return 'gothic catacomb with crimson banners and candle light'
    if any(w in hay for w in ('gear','cog','forge','automaton','piston','clockwork','mech')):
        return 'clockwork foundry interior with gears and steam'
    if any(w in hay for w in ('dragon','wyrm','drake')):
        return 'dragon lair cavern with treasure piles and dim torch glow'
    if any(w in hay for w in ('tide','depth','kraken','coral','siren','drown','ocean')):
        return 'sunken underwater temple with bioluminescent algae'
    return 'dark arena with subtle violet glow and aurora particle dust'

def all_in_prompt(card: dict[str, Any]) -> str:
    """Single prompt that asks Schnell for a COMPLETE pixel card."""
    name   = card.get('name') or card['id']
    eff    = (card.get('text') or '').strip() or ' '
    t      = card.get('type') or 'minion'
    mana   = card.get('mana') or 0
    atk    = card.get('atk') or 0
    hp     = card.get('hp') or 0
    rarity = (card.get('rarity') or 'common').lower()
    frame  = RARITY_FRAME_STYLE.get(rarity, RARITY_FRAME_STYLE['common'])
    bg     = thematic_background(card)

    if t == 'spell':
        subject = (
            f"a glowing pixel-art spell effect representing '{name}', "
            f"which {eff}, centered against a {bg} background. No characters, "
            "just the effect."
        )
    elif t == 'champion':
        subject = (
            f"a noble pixel-art champion character representing '{name}', "
            f"standing heroically in front of a {bg} background. SNES JRPG "
            "hero-sprite style with violet and gold trim."
        )
    else:
        subject = (
            f"a pixel-art battle sprite of '{name}' standing in front of a "
            f"{bg} background. SNES JRPG / Chrono Trigger battle-sprite style "
            "with violet and aurora-pink accents on the character."
        )

    return (
        "16-bit retro pixel art complete trading card design, square 1:1 "
        f"aspect. The card has {frame}. Card art portion (centered, takes "
        f"about 55% of the card) shows {subject} "
        "The card layout includes: a glowing pixel mana gem in the top-left "
        f"corner showing the number {mana}, a small type-label banner in the "
        f"top-right reading '{t.upper()}', a horizontal pixel name banner in "
        f"the lower-middle area with the words '{name}' written in pixel font"
        + (f", two pixel stat circles at the bottom corners (red showing "
           f"the number {atk} and green showing the number {hp})"
           if t in ('minion','champion') and atk > 0 else '')
        + ". Vibrant 16-color palette, crisp pixel edges, no anti-aliasing, "
          "classic Final Fantasy VI / Chrono Trigger trading card aesthetic. "
          "Solid framing, the whole card fills the canvas."
    )

def generate(card):
    body = {'input': {
        'prompt':         all_in_prompt(card),
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
                          headers={'Authorization': f'Bearer {REPLICATE_TOKEN}',
                                   'Prefer': 'wait=10'})
        if r.status_code == 429:
            try: delay = (r.json().get('retry_after') or 15) + 2
            except: delay = 17
            print(f'  429 sleeping {delay}s'); time.sleep(delay); continue
        if not r.ok: raise RuntimeError(f'create {r.status_code}: {r.text[:200]}')
        break
    p = r.json()
    while p.get('status') in ('starting', 'processing'):
        time.sleep(1.2)
        p = requests.get(p['urls']['get'],
                         headers={'Authorization': f'Bearer {REPLICATE_TOKEN}'}).json()
    if p.get('status') != 'succeeded':
        raise RuntimeError(f'status {p.get("status")}')
    url = p['output'][0] if isinstance(p['output'], list) else p['output']
    return requests.get(url, timeout=60).content

VALIDATION = ['champ.warrior','u.firebolt','leg.nyx','undead.c034','spire.s01.embercrown']
VALIDATION_PLUS = ['tok.boneknight','leg.korrik','c.bolt1','champ.healer','fire.c001',
                   'storm.c020','u.shieldguard','r.boltstorm','spire.s06.permafrost','u.daggerthief']

def load_state(): return json.loads(STATE_PATH.read_text()) if STATE_PATH.exists() else {'done':[],'failed':{}}
def save_state(s): STATE_PATH.write_text(json.dumps(s, indent=2))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--validate', action='store_true')
    ap.add_argument('--validate-plus', action='store_true')
    ap.add_argument('--full', action='store_true')
    ap.add_argument('--resume', action='store_true')
    args = ap.parse_args()
    if not REPLICATE_TOKEN: print('REPLICATE_API_TOKEN required'); sys.exit(1)

    cards = load_cards()
    if args.validate: ids = VALIDATION
    elif getattr(args, 'validate_plus', False): ids = VALIDATION_PLUS
    else: ids = list(cards.keys())

    state = load_state() if args.resume else {'done':[],'failed':{}}
    done = set(state['done'])
    started = time.time()
    for i, cid in enumerate(ids, 1):
        card = cards.get(cid)
        if not card or cid in done: continue
        out = OUT / f'{cid}.png'
        if out.exists(): state['done'].append(cid); continue
        try:
            print(f'[{i}/{len(ids)}] {cid} ({card["name"]})')
            data = generate(card)
            out.write_bytes(data)
            print(f'    saved {out} ({len(data)//1024} KB)')
            state['done'].append(cid)
            time.sleep(PACING_S)
        except Exception as e:
            print(f'    FAIL {e}')
            state['failed'][cid] = str(e)
        if i % 10 == 0: save_state(state)
        if i % 250 == 0:
            mins = (time.time()-started)/60
            print(f'\n=== MILESTONE: {i}/{len(ids)} · {mins:.1f} min ===\n')
    save_state(state)
    print(f'\nDone. {len(state["done"])} ok, {len(state["failed"])} fail.')

if __name__ == '__main__': main()
