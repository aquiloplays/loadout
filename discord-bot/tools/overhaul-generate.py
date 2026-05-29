"""Phase-aware pixel-art generator for the asset overhaul.

Usage:
  python tools/overhaul-generate.py <phase>
  phase ∈ {heroes, gear, clash, pets}

Pipeline (per phase):
  1. Load the roster from the live JS catalogue via `node -e`.
  2. For each entry, build the Schnell prompt from the phase template.
  3. Hit Replicate (Flux Schnell), poll, download the PNG.
  4. Save to /c/tmp/pixel-art-overhaul/<phase>/<kvKey-as-filename>.png
     where kvKey-as-filename uses `__` as the path separator (`:` is
     not portable in Windows filenames). The uploader splits on `__`
     to derive the KV key.

Resumable — skips any output PNG that already exists. So a re-run
after a crash picks up from the last failure.

Rate-limit + retry follow the v9 pipeline pattern: 14s pacing
between calls, 429 backoff respecting `retry_after`.

Run from discord-bot/:
  REPLICATE_API_TOKEN=... python tools/overhaul-generate.py heroes
"""
from __future__ import annotations
import json, os, subprocess, sys, time
from pathlib import Path
import requests

TOKEN = os.environ.get('REPLICATE_API_TOKEN')
if not TOKEN:
    print('REPLICATE_API_TOKEN required', file=sys.stderr)
    sys.exit(1)

OUT_ROOT = Path(r'C:\tmp\pixel-art-overhaul')
MODEL_URL = 'https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions'

# Shared prompt fragments — same SNES/CT pixel-art emphasis as v9 so
# the visual language across the asset set stays consistent.
PIXEL_EMPHASIS = (
    "16-bit pixel art, chunky low-resolution pixel sprites, "
    "visible pixel blocks, blocky pixelated edges, retro SNES "
    "Final Fantasy VI / Chrono Trigger sprite style, NO smooth "
    "shading, NO painterly brush strokes, NO digital painting, "
    "NO photorealism — strictly pixelated 16-bit aesthetic"
)

# Rarity colour treatment shared by gear + Clash buildings.
RARITY_TREATMENT = {
    'common':    'silver and grey palette, no glow effects',
    'uncommon':  'soft green palette with subtle green glow particles',
    'rare':      'sapphire blue palette with blue gem inlays',
    'epic':      'violet palette with aurora-pink aura particles',
    'legendary': 'aurora-pink and gold radiant glow with star sparkles',
}

# ── Phase ROSTERS — loaded via node from the live catalogues ────


def load_heroes() -> list[dict]:
    here = Path(__file__).resolve().parent.parent
    script = """
      import { CLASSES } from './dungeon.js';
      console.log(JSON.stringify(Object.entries(CLASSES).map(([id, def]) => ({
        id, name: def.name || id, weaponType: def.weaponType || '',
        emoji: def.emoji || '', desc: def.desc || '',
      }))));
    """
    r = subprocess.run(['node', '--input-type=module', '-e', script],
                       cwd=here, capture_output=True, text=True)
    if r.returncode != 0:
        # Fallback to hard-coded list if CLASSES isn't exported.
        print('  CLASSES export missing — using static roster', file=sys.stderr)
        return [
            {'id': 'warrior', 'name': 'Warrior', 'weaponType': 'sword'},
            {'id': 'mage',    'name': 'Mage',    'weaponType': 'staff'},
            {'id': 'rogue',   'name': 'Rogue',   'weaponType': 'dagger'},
            {'id': 'ranger',  'name': 'Ranger',  'weaponType': 'bow'},
            {'id': 'healer',  'name': 'Healer',  'weaponType': 'staff'},
        ]
    return json.loads(r.stdout.strip())


def load_gear() -> list[dict]:
    """Load every SHOP_POOL row. Each row becomes one generation.

    Drops the `glyph` column on the node side — it's emoji and would
    blow up Python's default cp1252 stdout decoding on Windows. We
    don't use glyphs in the prompts anyway."""
    here = Path(__file__).resolve().parent.parent
    script = """
      import { SHOP_POOL } from './dungeon.js';
      const SLOTS = ['slot','rarity','name','glyph','atk','def','gold','setName','weaponType','preferredClass','ability'];
      const SKIP = new Set(['glyph']);
      const out = SHOP_POOL.map(row => {
        const o = {};
        SLOTS.forEach((k, i) => { if (!SKIP.has(k)) o[k] = row[i]; });
        return o;
      });
      console.log(JSON.stringify(out));
    """
    r = subprocess.run(['node', '--input-type=module', '-e', script],
                       cwd=here, capture_output=True, text=True,
                       encoding='utf-8', errors='replace', check=True)
    return json.loads(r.stdout.strip())


def load_clash() -> dict:
    """Load buildings (kind × level) + personal troops."""
    here = Path(__file__).resolve().parent.parent
    script = """
      import { BUILDINGS, TROOPS_PERSONAL } from './clash-content.js';
      const buildings = [];
      for (const [kind, def] of Object.entries(BUILDINGS)) {
        const lvls = def.hp ? Object.keys(def.hp).map(Number).filter(L => L > 0).sort((a,b)=>a-b) : [1];
        for (const lvl of lvls) {
          buildings.push({
            kind, level: lvl,
            name: def.name || kind,
            category: def.category || '',
          });
        }
      }
      const troops = Object.entries(TROOPS_PERSONAL).map(([id, def]) => ({
        id, name: def.name || id, role: def.role || '',
      }));
      console.log(JSON.stringify({ buildings, troops }));
    """
    r = subprocess.run(['node', '--input-type=module', '-e', script],
                       cwd=here, capture_output=True, text=True, check=True)
    return json.loads(r.stdout.strip())


def load_pets() -> list[dict]:
    here = Path(__file__).resolve().parent.parent
    # pet.js exports SPECIES (string list) — no per-species metadata.
    script = """
      import { SPECIES } from './pet.js';
      console.log(JSON.stringify(SPECIES.map(s => ({ id: s, name: s }))));
    """
    r = subprocess.run(['node', '--input-type=module', '-e', script],
                       cwd=here, capture_output=True, text=True)
    if r.returncode != 0:
        print('  SPECIES export missing — using static roster', file=sys.stderr)
        return [{'id': k, 'name': k} for k in
                ['cat', 'dog', 'owl', 'fox', 'slime',
                 'dragonling', 'frog', 'bunny']]
    return json.loads(r.stdout.strip())

# ── Phase PROMPTS ────────────────────────────────────────────────


def prompt_for_hero(h: dict) -> str:
    weapon = h.get('weaponType') or 'weapon'
    return (
        f"{PIXEL_EMPHASIS}. Full-body sprite of a {h['name']}, "
        f"idle stance, holding a {weapon}. Classic SNES Final Fantasy VI "
        f"hero-sprite style with crisp pixel edges. Vibrant 16-color "
        f"palette with violet and aurora-pink accent details on armor "
        f"and cape. Friendly determined expression. Magenta background "
        f"#ff00ff for color-keying. Isolated subject centered. NO card "
        f"frame, NO banner, NO text, NO border, NO UI elements."
    )


def prompt_for_gear(g: dict) -> str:
    rarity_line = RARITY_TREATMENT.get(g.get('rarity', ''), '')
    return (
        f"{PIXEL_EMPHASIS}. Inventory icon of a {g['name']}, "
        f"{g.get('rarity', 'common')} rarity. Classic JRPG item-icon "
        f"style — 3/4 view, centered. {rarity_line}. Crisp pixel edges. "
        f"Magenta background #ff00ff for color-keying. NO frame, NO "
        f"text, NO border, NO UI elements."
    )


def prompt_for_building(b: dict) -> str:
    lvl = b['level']
    if lvl <= 3:    tier = 'wooden and stone basic construction'
    elif lvl <= 6:  tier = 'reinforced with banners and decorations'
    else:           tier = 'gold and aurora-violet ornaments with glowing details'
    return (
        f"{PIXEL_EMPHASIS}. Isometric pixel art of {b['name']} at level "
        f"{lvl}, a Clash town building. {tier}. Classic JRPG town-builder "
        f"sprite style. Vibrant 16-color palette. Crisp pixel edges. "
        f"Magenta background #ff00ff for color-keying. Subject centered. "
        f"NO text."
    )


def prompt_for_troop(t: dict) -> str:
    return (
        f"{PIXEL_EMPHASIS}. Battle sprite of a {t['name']}, action pose, "
        f"classic SNES JRPG battle-sprite style. Vibrant 16-color "
        f"palette with violet and aurora-pink accent details. 3/4 view. "
        f"Crisp pixel edges. Magenta background #ff00ff for color-keying. NO text."
    )


def prompt_for_pet(p: dict) -> str:
    return (
        f"{PIXEL_EMPHASIS}. Sprite of a cute companion creature {p['name']}, "
        f"battle-ready idle stance. Classic SNES JRPG monster/pet sprite "
        f"style. Vibrant 16-color palette with aurora accents. Crisp pixel "
        f"edges. Friendly expression. Magenta background #ff00ff for "
        f"color-keying. NO text."
    )

# ── Phase REGISTRY — phase name → (loader, prompt fn, filename fn) ─


def phase_heroes():
    items = load_heroes()
    return [{
        'filename': f"hero__{h['id']}.png",
        'prompt':   prompt_for_hero(h),
        'seed':     8000 + i,
    } for i, h in enumerate(items)]


def phase_gear():
    items = load_gear()
    out = []
    for i, g in enumerate(items):
        # Slugify the name for the filename.
        slug = ''.join(c if c.isalnum() else '-' for c in g['name'].lower())
        slug = '-'.join(p for p in slug.split('-') if p)
        out.append({
            'filename': f"gear__{g['slot']}__{slug}__{g['rarity']}.png",
            'prompt':   prompt_for_gear(g),
            'seed':     9000 + i,
        })
    return out


def phase_clash():
    data = load_clash()
    out = []
    for i, b in enumerate(data['buildings']):
        out.append({
            'filename': f"clash__buildings__{b['kind']}__{b['level']}.png",
            'prompt':   prompt_for_building(b),
            'seed':     10000 + i,
        })
    for j, t in enumerate(data['troops']):
        out.append({
            'filename': f"clash__units__{t['id']}.png",
            'prompt':   prompt_for_troop(t),
            'seed':     11000 + j,
        })
    return out


def phase_pets():
    items = load_pets()
    return [{
        'filename': f"pet__{p['id']}.png",
        'prompt':   prompt_for_pet(p),
        'seed':     12000 + i,
    } for i, p in enumerate(items)]


PHASES = {
    'heroes': phase_heroes,
    'gear':   phase_gear,
    'clash':  phase_clash,
    'pets':   phase_pets,
}

# ── Replicate driver ─────────────────────────────────────────────


def create_prediction(prompt: str, seed: int):
    body = {'input': {
        'prompt': prompt, 'aspect_ratio': '1:1',
        'output_format': 'png', 'output_quality': 95,
        'num_outputs': 1, 'seed': seed,
        'go_fast': True, 'megapixels': '0.25',   # 512x512-ish
    }}
    while True:
        r = requests.post(
            MODEL_URL, json=body, timeout=60,
            headers={'Authorization': f'Bearer {TOKEN}', 'Prefer': 'wait=10'},
        )
        if r.status_code == 429:
            try: delay = (r.json().get('retry_after') or 15) + 2
            except Exception: delay = 17
            print(f'    429 sleep {delay}s')
            time.sleep(delay)
            continue
        if not r.ok:
            raise RuntimeError(f'create failed: {r.status_code} {r.text[:200]}')
        return r.json()


def poll(p):
    while p.get('status') in ('starting', 'processing'):
        time.sleep(1.2)
        p = requests.get(p['urls']['get'],
                         headers={'Authorization': f'Bearer {TOKEN}'},
                         timeout=30).json()
    if p.get('status') != 'succeeded':
        raise RuntimeError(p.get('status') or 'unknown')
    return p


def main(argv):
    if not argv or argv[0] not in PHASES:
        print(f'usage: overhaul-generate.py <{"|".join(PHASES)}>', file=sys.stderr)
        return 2
    phase = argv[0]
    pacing = 14 if '--no-pacing' not in argv else 2
    out_dir = OUT_ROOT / phase
    out_dir.mkdir(parents=True, exist_ok=True)
    work = PHASES[phase]()
    print(f'Phase: {phase}  ({len(work)} items)  ->  {out_dir}')

    ok, skipped, failed = 0, 0, 0
    for i, item in enumerate(work):
        out_path = out_dir / item['filename']
        if out_path.exists() and out_path.stat().st_size > 4000:
            skipped += 1
            if i % 50 == 0:
                print(f'  [{i+1}/{len(work)}] cached {item["filename"]}')
            continue
        if (i % 25) == 0:
            print(f'  [{i+1}/{len(work)}] {item["filename"]}')
        try:
            if i > 0 and pacing > 0:
                time.sleep(pacing)
            pred = poll(create_prediction(item['prompt'], item['seed']))
            url = pred['output'][0] if isinstance(pred['output'], list) else pred['output']
            blob = requests.get(url, timeout=60).content
            out_path.write_bytes(blob)
            ok += 1
        except Exception as e:
            failed += 1
            print(f'    FAIL {item["filename"]}: {e}')

    print(f'\nPhase {phase}: ok={ok} skipped={skipped} failed={failed}')
    return 0 if failed == 0 else 1


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
