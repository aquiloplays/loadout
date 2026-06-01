"""Clash visual overhaul — premium art pipeline (Clay 2026-05-31).

Glossy Game Premium vector style (NOT pixel), matching the card overhaul.
Resumable, chunked, QA'd, budget-gated, self-committing — same proven
pattern as tools/bulk-regen-cards.py. Single Replicate consumer.

Batches (run in order B -> A -> D -> C via --batch):
  B  building upgrade variants  (140 real levels, ~$8.40)
  A  unit animation sprite sheets (12 troops, key-pose driven)
  D  field tiles + props
  C  construction overlay (one sheet)

Each batch builds a job list [{key, kvKey, assetUrl, prompt, aspect,
isolate}]; the runner generates (Pro Ultra, png, cached in
/tmp/boltbound-clash-art), optionally flood-keys to transparency, QAs,
base64 bulk-puts to KV, sample-200-verifies, and commits+pushes state
every chunk. State: discord-bot/clash-art-state.json (done keys, spend,
failed) so a crash/context-reset resumes cleanly.

Usage:
  REPLICATE_API_TOKEN=... python -u tools/clash-art-pipeline.py --batch B [--pace 1] [--chunk 25] [--commit]
"""
from __future__ import annotations
import base64, json, os, subprocess, sys, tempfile, time
from collections import deque
from pathlib import Path
import requests
from PIL import Image

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
TOKEN = os.environ.get('REPLICATE_API_TOKEN')
ART = Path('/tmp/boltbound-clash-art'); ART.mkdir(parents=True, exist_ok=True)
ULTRA = 'https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro-ultra/predictions'
WORKER = 'loadout-discord.aquiloplays.workers.dev'
KV_NS = 'LOADOUT_BOLTS'
STATE = ROOT / 'clash-art-state.json'
COST = 0.06
SPEND_GATE = 120.0
MIN_PNG = 8_000

PIXEL = ("Glossy game premium vector art, clean polished AAA mobile-strategy "
         "game asset, crisp vector shapes, soft cel shading, vibrant saturated "
         "color, subtle rim light, NO pixel art, NO photorealism")
ON_MAGENTA = ("centered, isolated on a completely flat solid magenta #FF00FF "
              "background filling every empty area, no shadow on the background")

# ── Pro Ultra plumbing ─────────────────────────────────────────────
def _download(url, tries=5):
    last = None
    for i in range(tries):
        try:
            r = requests.get(url, timeout=120)
            if r.ok and r.content: return r.content
            last = str(r.status_code)
        except Exception as e:
            last = str(e)[:80]
        time.sleep(2 + i * 2)
    raise RuntimeError(f'download failed: {last}')

def gen(prompt, aspect, out_path):
    if out_path.exists():
        return out_path, False
    if not TOKEN:
        raise SystemExit('REPLICATE_API_TOKEN not set')
    body = {'input': {'prompt': prompt, 'aspect_ratio': aspect,
                      'output_format': 'png', 'safety_tolerance': 2, 'raw': False}}
    while True:
        r = requests.post(ULTRA, json=body, timeout=120,
                          headers={'Authorization': f'Bearer {TOKEN}', 'Prefer': 'wait=40'})
        if r.status_code == 429:
            print('  429 backoff 15s'); time.sleep(15); continue
        if not r.ok: raise RuntimeError(f'{r.status_code} {r.text[:160]}')
        p = r.json(); break
    while p.get('status') in ('starting', 'processing'):
        time.sleep(1.3)
        p = requests.get(p['urls']['get'], headers={'Authorization': f'Bearer {TOKEN}'}).json()
    if p.get('status') != 'succeeded':
        raise RuntimeError(f"gen {p.get('status')}: {str(p.get('error'))[:120]}")
    url = p['output'][0] if isinstance(p['output'], list) else p['output']
    out_path.write_bytes(_download(url))
    return out_path, True

def flood_key(img, delta=60, seed_center=False):
    img = img.convert('RGBA'); w, h = img.size; px = img.load()
    def close(c1, c2): return all(abs(c1[i] - c2[i]) <= delta for i in range(3))
    visited = bytearray(w * h); q = deque()
    def seed(x, y):
        if 0 <= x < w and 0 <= y < h and not visited[y * w + x]:
            q.append((x, y, px[x, y][:3]))
    for x in range(w): seed(x, 0); seed(x, h - 1)
    for y in range(h): seed(0, y); seed(w - 1, y)
    if seed_center: seed(w // 2, h // 2)
    while q:
        x, y, ref = q.popleft(); idx = y * w + x
        if visited[idx]: continue
        if not close(px[x, y][:3], ref): continue
        visited[idx] = 1; px[x, y] = (0, 0, 0, 0)
        for nx, ny in ((x+1, y), (x-1, y), (x, y+1), (x, y-1)):
            if 0 <= nx < w and 0 <= ny < h and not visited[ny * w + nx]:
                q.append((nx, ny, ref))
    return img

# ── Batch B: building upgrade variants ─────────────────────────────
BUILDING_THEME = {
    'townhall': 'a majestic fantasy castle keep with banners',
    'wall': 'a fortified stone rampart wall segment',
    'cannon': 'a defensive artillery cannon emplacement',
    'archerTower': 'a tall archer watchtower',
    'trap': 'a concealed ground spike trap',
    'storage': 'a fortified treasure storage vault',
    'barracks': 'a military training barracks',
    'warTent': 'an ornate champion war tent',
    'sawmill': 'a timber sawmill with logs',
    'quarry': 'a stone quarry with cut blocks',
    'forge': 'an iron forge with anvil and embers',
    'mint': 'a gold mint with coin stamps',
    'workshop': 'an engineering workshop with gears',
    'buildersHut': "a builder's hut with scaffolding tools",
    'lumberVault': 'a reinforced lumber storehouse',
    'stoneVault': 'a reinforced stone storehouse',
    'ironVault': 'a reinforced iron storehouse',
    'goldVault': 'a reinforced gold storehouse',
    'mortar': 'a heavy siege mortar',
    'mageTower': 'an arcane mage tower crackling with energy',
    'skywardBow': 'a giant anti-air ballista bow',
    'bombTower': 'a volatile bomb tower',
    'voltaicCoil': 'a crackling tesla voltaic coil tower',
    'heavyCannon': 'a massive double-barreled heavy cannon',
    'infernoTower': 'a searing inferno flame tower',
    'eagleEye': 'a colossal eagle-eye artillery platform',
    'springTrap': 'a hidden spring launch trap',
    'skyMine': 'a floating air mine trap',
    'staticTrap': 'a static-shock floor trap',
    'caltrops': 'scattered caltrop spikes',
    'infernoTrap': 'a hidden flame-burst trap',
    'decoyBanner': 'a decoy banner standard',
}

def jobs_B():
    data = json.loads(Path('C:/tmp/clash-buildings.json').read_text(encoding='utf-8'))
    jobs = []
    for b in data:
        slug, name = b['slug'], b['name']
        theme = BUILDING_THEME.get(slug, f'a fantasy base building ({name})')
        maxL = max(b['levels'])
        for L in b['levels']:
            ratio = L / maxL
            tier = ('a basic early-level' if ratio <= 0.34 else
                    'a reinforced mid-level' if ratio <= 0.67 else
                    'a fully-upgraded ornate high-level')
            prompt = (f"{PIXEL}. {theme}, {tier} version (upgrade level {L} of {maxL} — "
                      f"higher levels are larger, more fortified, with gold trim and glowing "
                      f"accents). Three-quarter top-down isometric game-board view. {ON_MAGENTA}. No text.")
            jobs.append({
                'key': f'buildings:{slug}:{L}',
                'kvKey': f'pixel-art-clash:buildings:{slug}:{L}',
                'assetUrl': f'https://{WORKER}/asset/clash-art/buildings/{slug}/{L}.png',
                'prompt': prompt, 'aspect': '1:1', 'isolate': True, 'seed_center': False,
            })
    return jobs

# ── Batch A: unit animation sprite sheets ──────────────────────────
# Flux can't make temporally-coherent frames across separate calls, but
# WITHIN one image it keeps a character consistent. So we generate one
# wide multi-frame STRIP per (unit, animation), slice it into equal
# frames, normalize each into a square cell, and pack all frames into a
# per-unit 8-column master sheet + a JSON frame manifest.
TROOP_THEME = {
    'scrapper': 'a scrappy junk-armored brawler with a wrench',
    'boltKnight': 'a heavy armored knight crackling with electricity',
    'archerLite': 'a nimble archer with a longbow',
    'voltaicMage': 'a robed mage wreathed in voltaic lightning',
    'sapperRogue': 'a hooded rogue carrying demolition charges',
    'healerCleric': 'a radiant healer cleric with a glowing staff',
    'sneak': 'a sneaky green goblin with a dagger',
    'batteringRam': 'a massive wheeled battering ram crew',
    'skyrider': 'a winged rider mounted on a flying beast',
    'plagueDoctor': 'a sinister plague doctor in a beaked mask',
    'lightningSapper': 'a charged saboteur trailing electric arcs',
    'stormCaller': 'a storm shaman channeling thunderclouds',
}
ANIMS = [('idle', 4), ('walk-n', 4), ('walk-e', 4), ('walk-s', 4),
         ('walk-w', 4), ('attack', 5), ('death', 5)]
ANIM_DESC = {
    'idle': 'standing idle breathing loop, facing the viewer',
    'walk-n': 'walking away (back view), north-facing walk cycle',
    'walk-e': 'walking to the right, east-facing walk cycle',
    'walk-s': 'walking toward the viewer, south-facing walk cycle',
    'walk-w': 'walking to the left, west-facing walk cycle',
    'attack': 'attacking, a wind-up-to-strike action sequence',
    'death': 'being defeated, a collapse-and-fade death sequence',
}
CELL = 128

def strip_jobs_A():
    troops = json.loads(Path('C:/tmp/clash-troops.json').read_text(encoding='utf-8'))
    jobs = []
    for t in troops:
        theme = TROOP_THEME.get(t['id'], f"a fantasy unit ({t['name']})")
        for anim, frames in ANIMS:
            prompt = (f"{PIXEL}. A horizontal sprite-sheet strip of exactly {frames} evenly-spaced "
                      f"animation frames, left to right, of {theme} ({t['name']}). The same character "
                      f"in every frame, {ANIM_DESC[anim]}. Full-body game unit sprite, consistent scale "
                      f"and pose progression across the {frames} frames. {ON_MAGENTA}. No text, no grid lines.")
            jobs.append({'unit': t['id'], 'anim': anim, 'frames': frames,
                         'key': f'unit:{t["id"]}:{anim}', 'prompt': prompt, 'aspect': '21:9'})
    return jobs, [t['id'] for t in troops]

def slice_strip(path, frames):
    """Slice a wide strip into `frames` equal columns; fit each into a
    CELLxCELL transparent square (preserve aspect, centered)."""
    img = Image.open(path).convert('RGBA')
    w, h = img.size
    fw = w // frames
    cells = []
    for i in range(frames):
        crop = img.crop((i * fw, 0, (i + 1) * fw, h))
        cw, ch = crop.size
        scale = min(CELL / cw, CELL / ch)
        nw, nh = max(1, int(cw * scale)), max(1, int(ch * scale))
        crop = crop.resize((nw, nh), Image.LANCZOS)
        cell = Image.new('RGBA', (CELL, CELL), (0, 0, 0, 0))
        cell.paste(crop, ((CELL - nw) // 2, (CELL - nh) // 2), crop)
        cells.append(cell)
    return cells

def compose_unit_sheet(unit):
    """Build the 8-col master sheet + manifest from this unit's strips."""
    all_cells, manifest_anims, idx = [], {}, 0
    for anim, frames in ANIMS:
        strip = ART / f'unit_{unit}_{anim}.png'
        cells = slice_strip(strip, frames)
        manifest_anims[anim] = {'start': idx, 'count': frames}
        all_cells.extend(cells); idx += frames
    cols = 8
    rows = (len(all_cells) + cols - 1) // cols
    sheet = Image.new('RGBA', (cols * CELL, rows * CELL), (0, 0, 0, 0))
    for i, cell in enumerate(all_cells):
        r, c = divmod(i, cols)
        sheet.paste(cell, (c * CELL, r * CELL), cell)
    out = ART / f'sheet_{unit}.png'
    sheet.save(out, optimize=True)
    manifest = {'unit': unit, 'frameW': CELL, 'frameH': CELL, 'cols': cols,
                'rows': rows, 'total': len(all_cells), 'animations': manifest_anims}
    return out, manifest

# ── Batch D: field tiles + props + wildlife ────────────────────────
def jobs_D():
    jobs = []
    def add(aid, prompt, aspect='1:1', isolate=True):
        jobs.append({'key': f'field:{aid}', 'kvKey': f'pixel-art-clash:field:{aid}',
                     'assetUrl': f'https://{WORKER}/asset/clash-art/field/{aid}.png',
                     'prompt': prompt, 'aspect': aspect, 'isolate': isolate, 'seed_center': False})
    base = f"{PIXEL}. Three-quarter top-down isometric game-board"
    # Ground tiles — opaque seamless squares.
    for aid, desc in [('grass-1', 'lush green grass'), ('grass-2', 'darker patchy grass'),
                      ('dirt', 'packed brown dirt'), ('sand', 'pale desert sand')]:
        add(aid, f"{base} ground tile of {desc}, seamless tileable texture, flat square top-down tile. No text.",
            isolate=False)
    # Edge / path tiles — opaque squares.
    for aid, desc in [('edge-grass-water', 'grass meeting a water shoreline'),
                      ('edge-grass-dirt', 'grass meeting a dirt patch'),
                      ('edge-grass-sand', 'grass meeting sand'),
                      ('water-1', 'clear blue water'),
                      ('path-straight', 'a stone path running straight'),
                      ('path-corner', 'a stone path bending at a corner'),
                      ('path-cross', 'a stone path crossroads'),
                      ('path-t', 'a stone path T-junction'),
                      ('shore-corner', 'a curved grass-to-water shore corner'),
                      ('rocks-ground', 'rocky pebbled ground')]:
        add(aid, f"{base} terrain tile: {desc}, seamless edges, flat square top-down tile. No text.",
            isolate=False)
    # Decorative props — transparent.
    props = [('tree-1', 'a round broadleaf tree'), ('tree-2', 'a tall pine tree'),
             ('tree-3', 'a gnarled old oak tree'), ('rock-1', 'a mossy boulder'),
             ('rock-2', 'a cluster of small rocks'), ('rock-3', 'a tall standing stone'),
             ('bush-1', 'a leafy green bush'), ('bush-2', 'a flowering bush'),
             ('bush-3', 'a berry shrub'), ('flower-1', 'a patch of red flowers'),
             ('flower-2', 'a patch of yellow flowers'), ('flower-3', 'a patch of blue flowers'),
             ('npc-tent', 'a colorful merchant tent'), ('well', 'a stone wishing well'),
             ('signpost', 'a wooden signpost'), ('hay-bale', 'a round hay bale'),
             ('watchtower', 'a small wooden watchtower'), ('barrel', 'a wooden barrel'),
             ('crate', 'a wooden supply crate'), ('lamppost', 'an ornate iron lamppost'),
             ('fence', 'a short wooden fence segment'), ('statue', 'a heroic stone statue')]
    for aid, desc in props:
        add(aid, f"{PIXEL}. {desc}, a single decorative game-board prop, three-quarter isometric view. {ON_MAGENTA}. No text.")
    # Animated wildlife — wide 4-frame strips (sliced by the site via the field manifest).
    for aid, desc in [('deer-idle', 'a deer standing idle, subtle breathing'),
                      ('deer-walk', 'a deer walking, a 4-step walk cycle'),
                      ('bird-flock', 'a small flock of birds flying, a wing-flap loop')]:
        add(aid, f"{PIXEL}. A horizontal sprite-sheet strip of exactly 4 evenly-spaced frames, left to right, "
                 f"of {desc}, the same subject in every frame. {ON_MAGENTA}. No text, no grid lines.",
            aspect='21:9')
    return jobs

BATCHES = {'B': jobs_B, 'D': jobs_D}

# ── Batch C: construction overlay (one sheet) + field manifest ─────
def run_C(pace, do_commit):
    st = load_state(); done = set(st['done'])
    # Construction overlay — one wide 8-frame scaffolding/dust/workers strip.
    if 'fx:construction-overlay' not in done:
        out = ART / 'construction_overlay.png'
        prompt = (f"{PIXEL}. A horizontal sprite-sheet strip of exactly 8 evenly-spaced frames, left to right, "
                  f"of a building-under-construction overlay: wooden scaffolding, swirling dust clouds, and "
                  f"tiny workers, progressing from bare scaffolding to nearly-complete across the 8 frames. "
                  f"Designed to overlay on top of any building at partial opacity. {ON_MAGENTA}. No text, no grid lines.")
        for attempt in range(3):
            try:
                _, billed = gen(prompt, '21:9', out)
                img = flood_key(Image.open(out), 60); img.save(out, optimize=True)
                if billed: st['spend'] = round(st['spend'] + COST, 4)
                # slice into 8 frames + repack to an 8-col sheet (1 row) at CELL.
                cells = slice_strip(out, 8)
                sheet = Image.new('RGBA', (8 * CELL, CELL), (0, 0, 0, 0))
                for i, c in enumerate(cells): sheet.paste(c, (i * CELL, 0), c)
                sheet_path = ART / 'construction_overlay_sheet.png'; sheet.save(sheet_path, optimize=True)
                manifest = {'frameW': CELL, 'frameH': CELL, 'cols': 8, 'frames': 8,
                            'usage': 'overlay on building sprite at partial opacity during build/upgrade'}
                kv_bulk_put([
                    {'key': 'pixel-art-clash:fx:construction-overlay',
                     'value': base64.b64encode(sheet_path.read_bytes()).decode('ascii'), 'base64': True},
                    {'key': 'pixel-art-clash:fx:construction-overlay-manifest.json',
                     'value': json.dumps(manifest, separators=(',', ':'))},
                ])
                okv = verify(f'https://{WORKER}/asset/clash-art/fx/construction-overlay.png')
                st['done'].append('fx:construction-overlay'); done.add('fx:construction-overlay')
                save_state(st);  git_push(len(st['done']), 'C') if do_commit else None
                print(f'  uploaded: construction-overlay (8 frames) 200={okv}')
                break
            except Exception as e:
                print('  construction retry:', str(e)[:100]); time.sleep(6)
    # Field wildlife manifest (frame counts for the D strips).
    if 'fx:field-manifest' not in done:
        fm = {'frames': 4, 'animated': ['deer-idle', 'deer-walk', 'bird-flock'],
              'note': 'each animated field asset is a horizontal 4-frame strip; slice into 4 equal columns'}
        kv_bulk_put([{'key': 'pixel-art-clash:field:_manifest.json',
                      'value': json.dumps(fm, separators=(',', ':'))}])
        st['done'].append('fx:field-manifest'); save_state(st)
        if do_commit: git_push(len(st['done']), 'C')
        print('  uploaded: field _manifest.json')
    print(f'\nbatch C run end. done {len(st["done"])} | spend ${st["spend"]:.2f}')
    return 0

# ── State + git ────────────────────────────────────────────────────
def load_state():
    if STATE.exists():
        try: return json.loads(STATE.read_text())
        except Exception: pass
    return {'done': [], 'failed': [], 'spend': 0.0}

def save_state(st): STATE.write_text(json.dumps(st))

def git_push(n, batch):
    try:
        subprocess.run(['git', '-C', str(ROOT.parent), 'add', 'discord-bot/clash-art-state.json'],
                       capture_output=True, text=True)
        c = subprocess.run(['git', '-C', str(ROOT.parent), 'commit', '-m',
                            f'clash overhaul {batch}: art progress {n} assets'], capture_output=True, text=True)
        if c.returncode == 0:
            subprocess.run(['git', '-C', str(ROOT.parent), 'push'], capture_output=True, text=True)
    except Exception as e:
        print('  (git skip:', str(e)[:60], ')')

def kv_bulk_put(entries):
    with tempfile.NamedTemporaryFile(mode='w', suffix='-clash.json', delete=False, encoding='utf-8') as fh:
        json.dump(entries, fh); tmp = Path(fh.name)
    try:
        res = subprocess.run(f'npx wrangler kv bulk put "{tmp}" --binding {KV_NS} --remote',
                             shell=True, capture_output=True, text=True, encoding='utf-8', errors='replace')
        if res.returncode != 0:
            raise RuntimeError('bulk put failed: ' + (res.stderr or res.stdout or '')[-300:])
    finally:
        try: tmp.unlink()
        except OSError: pass

def verify(url):
    try:
        r = requests.head(url, timeout=30)
        return r.status_code == 200 and int(r.headers.get('content-length', '0')) >= MIN_PNG
    except Exception:
        return False

def process_one(job):
    out = ART / (job['key'].replace(':', '_') + '.png')
    last = None
    for attempt in range(3):
        try:
            _, billed = gen(job['prompt'], job['aspect'], out)
            img = Image.open(out)
            if job.get('isolate'):
                img = flood_key(img, 60, job.get('seed_center', False))
                img.save(out, optimize=True)
            if out.stat().st_size < MIN_PNG:
                last = f'small {out.stat().st_size}B'
            else:
                return True, billed, out
        except Exception as e:
            last = str(e)[:120]
        time.sleep(4 + attempt * 4)
    return False, False, last

def run_A(pace, do_commit, max_jobs):
    """Batch A: gen per-(unit,animation) strips (resumable), then compose
    each unit's 8-col master sheet + manifest and upload both."""
    strips, units = strip_jobs_A()
    st = load_state(); done = set(st['done'])
    todo = [s for s in strips if s['key'] not in done][:max_jobs]
    print(f'batch A: {len(strips)} strips | {len(strips)-len([s for s in strips if s["key"] not in done])} done | {len(todo)} remaining | spend ${st["spend"]:.2f}')

    # 1. Generate strips.
    n_since = 0
    for s in todo:
        if st['spend'] + COST > SPEND_GATE:
            print(f'\n*** BUDGET GATE at ${st["spend"]:.2f}. Pausing. ***'); break
        out = ART / (s['key'].replace(':', '_') + '.png')
        last = None
        for attempt in range(3):
            try:
                _, billed = gen(s['prompt'], s['aspect'], out)
                img = flood_key(Image.open(out), 60); img.save(out, optimize=True)
                if out.stat().st_size >= MIN_PNG:
                    if billed: st['spend'] = round(st['spend'] + COST, 4)
                    st['done'].append(s['key']); done.add(s['key']); last = None; break
                last = f'small {out.stat().st_size}B'
            except Exception as e:
                last = str(e)[:120]
            time.sleep(4 + attempt * 4)
        if last:
            st['failed'] = [f for f in st['failed'] if f != s['key']] + [s['key']]
            print(f'  SKIP {s["key"]}: {last}', file=sys.stderr)
        else:
            print(f'  ok   {s["key"]}  (${st["spend"]:.2f})')
        n_since += 1
        if n_since >= 25:
            save_state(st);  git_push(len(st['done']), 'A') if do_commit else None; n_since = 0
        if pace: time.sleep(pace)
    save_state(st)
    if do_commit: git_push(len(st['done']), 'A')

    # 2. Compose + upload per-unit sheets whose strips are all present.
    for unit in units:
        sheet_key = f'sheet:{unit}'
        if sheet_key in done: continue
        if not all(f'unit:{unit}:{a}' in done for a, _ in ANIMS):
            print(f'  (skip compose {unit}: strips incomplete)'); continue
        try:
            sheet_path, manifest = compose_unit_sheet(unit)
            # Sheet key has NO .png — the pixel-art route strips .png from
            # the URL, so /asset/clash-art/units/<unit>/sheet.png resolves
            # to key pixel-art-clash:units:<unit>:sheet (same convention B
            # used + verified). Manifest is read from KV directly by the
            # site render layer.
            entries = [
                {'key': f'pixel-art-clash:units:{unit}:sheet',
                 'value': base64.b64encode(sheet_path.read_bytes()).decode('ascii'), 'base64': True},
                {'key': f'pixel-art-clash:units:{unit}:manifest.json',
                 'value': json.dumps(manifest, separators=(',', ':'))},
            ]
            kv_bulk_put(entries)
            url = f'https://{WORKER}/asset/clash-art/units/{unit}/sheet.png'
            okv = verify(url)
            st['done'].append(sheet_key); done.add(sheet_key); save_state(st)
            if do_commit: git_push(len(st['done']), 'A')
            print(f'  uploaded: sheet {unit} ({manifest["total"]} frames) 200={okv}')
        except Exception as e:
            print(f'  SHEET FAIL {unit}: {str(e)[:120]}', file=sys.stderr)
    print(f'\nbatch A run end. done {len(st["done"])} | failed {len(st["failed"])} | spend ${st["spend"]:.2f}')
    return 0

def main(argv):
    if not TOKEN: print('REPLICATE_API_TOKEN not set', file=sys.stderr); return 2
    batch = argv[argv.index('--batch') + 1] if '--batch' in argv else 'B'
    chunk = int(argv[argv.index('--chunk') + 1]) if '--chunk' in argv else 25
    pace = float(argv[argv.index('--pace') + 1]) if '--pace' in argv else 1.0
    do_commit = '--commit' in argv
    max_jobs = int(argv[argv.index('--max') + 1]) if '--max' in argv else 10**9
    if batch == 'A':
        return run_A(pace, do_commit, max_jobs)
    if batch == 'C':
        return run_C(pace, do_commit)
    if batch not in BATCHES:
        print('unknown batch (have: B,A,D,C)', file=sys.stderr); return 2

    jobs = BATCHES[batch]()
    st = load_state(); done = set(st['done'])
    todo = [j for j in jobs if j['key'] not in done][:max_jobs]
    print(f'batch {batch}: {len(jobs)} jobs | {len(jobs)-len(todo)} done | {len(todo)} remaining | spend ${st["spend"]:.2f}')

    pending = []   # (job, out_path)
    for j in todo:
        if st['spend'] + COST > SPEND_GATE:
            print(f'\n*** BUDGET GATE at ${st["spend"]:.2f}. Pausing. ***'); break
        ok, billed, res = process_one(j)
        if billed: st['spend'] = round(st['spend'] + COST, 4)
        if ok:
            pending.append(j); print(f'  ok   {j["key"]}  (${st["spend"]:.2f})')
        else:
            st['failed'] = [f for f in st['failed'] if f != j['key']] + [j['key']]
            print(f'  SKIP {j["key"]}: {res}', file=sys.stderr)
        if pace: time.sleep(pace)

        if len(pending) >= chunk:
            flush(pending, st, done, batch, do_commit)
            pending = []
    if pending:
        flush(pending, st, done, batch, do_commit)

    print(f'\nbatch {batch} run end. done {len(st["done"])}/{len(jobs)} | failed {len(st["failed"])} | spend ${st["spend"]:.2f}')
    return 0

def flush(pending, st, done, batch, do_commit):
    entries = []
    for j in pending:
        out = ART / (j['key'].replace(':', '_') + '.png')
        entries.append({'key': j['kvKey'], 'value': base64.b64encode(out.read_bytes()).decode('ascii'), 'base64': True})
    kv_bulk_put(entries)
    okv = verify(pending[0]['assetUrl'])
    for j in pending:
        st['done'].append(j['key']); done.add(j['key'])
    save_state(st)
    if do_commit: git_push(len(st['done']), batch)
    print(f'  uploaded: chunk {len(pending)} | sample {pending[0]["key"]} 200={okv} | total done {len(st["done"])}')

if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
