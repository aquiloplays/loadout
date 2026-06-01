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

BATCHES = {'B': jobs_B}

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

def main(argv):
    if not TOKEN: print('REPLICATE_API_TOKEN not set', file=sys.stderr); return 2
    batch = argv[argv.index('--batch') + 1] if '--batch' in argv else 'B'
    chunk = int(argv[argv.index('--chunk') + 1]) if '--chunk' in argv else 25
    pace = float(argv[argv.index('--pace') + 1]) if '--pace' in argv else 1.0
    do_commit = '--commit' in argv
    max_jobs = int(argv[argv.index('--max') + 1]) if '--max' in argv else 10**9
    if batch not in BATCHES:
        print('unknown batch (have:', ','.join(BATCHES) + ')', file=sys.stderr); return 2

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
