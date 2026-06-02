"""
Aquilo's Vault — premium cross-section art batch (Flux 1.1 Pro Ultra).

Generates the gritty-industrial Fallout-Shelter cross-section art set for
the worker-native vault (terrain, vault door, 16 room cells, per-class
dweller sprites, crisis FX, HUD chrome), magenta-keys the isolated
assets to transparent, and uploads to Cloudflare KV under
`pixel-art-vault:<asset>` (served by the worker at
/asset/vault/<asset>.png — wired in Phase 1).

Resumable: state in discord-bot/vault-art-state.json ({done,failed,spend}).
Re-running skips finished assets. Single serial Replicate consumer with
429 backoff (respects the one-runner guardrail). ASCII-only output.

Usage:
  REPLICATE_API_TOKEN=... python -u tools/vault-art-pipeline.py [--chunk 8] [--pace 1] [--commit] [--only PREFIX] [--force]
"""
from __future__ import annotations
import base64, json, os, subprocess, sys, tempfile, time
from collections import deque
from pathlib import Path

try:
    import requests
    from PIL import Image
except Exception as e:
    print('missing dep:', e, file=sys.stderr); sys.exit(2)

ROOT   = Path(__file__).resolve().parent.parent          # discord-bot/
TOKEN  = os.environ.get('REPLICATE_API_TOKEN')
ART    = Path(tempfile.gettempdir()) / 'aquilo-vault-art'; ART.mkdir(parents=True, exist_ok=True)
ULTRA  = 'https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro-ultra/predictions'
WORKER = 'loadout-discord.aquiloplays.workers.dev'
KV_NS  = 'LOADOUT_BOLTS'
STATE  = ROOT / 'vault-art-state.json'
COST   = 0.06
SPEND_GATE = 60.0
MIN_PNG = 8_000
FORCE = False

VAULT_STYLE = (
    "Fallout Shelter mobile-game cross-section art style, dim industrial "
    "underground fallout-vault aesthetic, vault-green steel and rusted iron and "
    "warm sodium-lamp amber palette, 1950s atomic-age retro-futuristic machinery, "
    "riveted steel bulkhead panels, warm tungsten work-lighting, gritty weathered "
    "grime and wear, clean readable AAA game-asset shapes, side-on cutaway diorama, "
    "NOT cartoon, NOT cosmic, NOT glossy plastic, NOT photorealistic"
)
ON_MAGENTA = ("isolated on a completely flat solid magenta #FF00FF background "
              "filling every empty area, no shadow cast on the background")

# ── Replicate plumbing (mirrors clash-art-pipeline.py) ─────────────────
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
    if out_path.exists() and not FORCE:
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
        if not r.ok:
            raise RuntimeError(f'{r.status_code} {r.text[:160]}')
        p = r.json(); break
    while p.get('status') in ('starting', 'processing'):
        time.sleep(1.3)
        p = requests.get(p['urls']['get'], headers={'Authorization': f'Bearer {TOKEN}'}).json()
    if p.get('status') != 'succeeded':
        raise RuntimeError(f"gen {p.get('status')}: {str(p.get('error'))[:120]}")
    url = p['output'][0] if isinstance(p['output'], list) else p['output']
    out_path.write_bytes(_download(url))
    return out_path, True

def flood_key(img, delta=64, seed_center=False):
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

def kv_bulk_put(entries):
    with tempfile.NamedTemporaryFile(mode='w', suffix='-vault.json', delete=False, encoding='utf-8') as fh:
        json.dump(entries, fh); tmp = Path(fh.name)
    try:
        last = ''
        for attempt in range(4):
            # cwd MUST be discord-bot/ (ROOT) so wrangler resolves the
            # KV binding from wrangler.toml regardless of the launch dir.
            res = subprocess.run(f'npx wrangler kv bulk put "{tmp}" --binding {KV_NS} --remote',
                                 shell=True, capture_output=True, text=True, encoding='utf-8',
                                 errors='replace', cwd=str(ROOT))
            if res.returncode == 0:
                return
            last = (res.stderr or res.stdout or '')[-300:]
            time.sleep(5 + attempt * 5)
        raise RuntimeError('bulk put failed after retries: ' + last)
    finally:
        try: tmp.unlink()
        except OSError: pass

def verify(url):
    try:
        r = requests.head(url, timeout=30)
        return r.status_code == 200 and int(r.headers.get('content-length', '0')) >= MIN_PNG
    except Exception:
        return False

def load_state():
    if STATE.exists():
        try: return json.loads(STATE.read_text())
        except Exception: pass
    return {'done': [], 'failed': [], 'spend': 0.0}

def save_state(st): STATE.write_text(json.dumps(st))

def git_push(n):
    try:
        subprocess.run(['git', '-C', str(ROOT.parent), 'add', 'discord-bot/vault-art-state.json'],
                       capture_output=True, text=True)
        c = subprocess.run(['git', '-C', str(ROOT.parent), 'commit', '-m',
                            f'vault Phase 3: art progress {n} assets'], capture_output=True, text=True)
        if c.returncode == 0:
            subprocess.run(['git', '-C', str(ROOT.parent), 'push'], capture_output=True, text=True)
    except Exception as e:
        print('  (git skip:', str(e)[:60], ')')

# ── Asset manifest ─────────────────────────────────────────────────────
# name -> served at /asset/vault/<name>.png  (KV key pixel-art-vault:<name>)

ROOM_DESC = {
    'living-quarters':  'cozy bunk-bed sleeping quarters with metal bunks, footlockers and a flickering lamp',
    'diner':            'a vault diner / cafeteria with a steel serving counter, stools and ration trays',
    'water-works':      'a water purification room with big riveted water tanks, gauges and a tangle of pipes',
    'power-generator':  'a power generator room with a humming turbine, exposed copper coils and a breaker panel',
    'medical-bay':      'a medical bay with examination beds, IV stands, a vitals monitor and a red-cross cabinet',
    'security-office':  'a security office with a wall gun-rack, CRT monitor bank and a reinforced weapons locker',
    'reactor-lab':      'an arcane reactor lab with a glowing energy crystal in a containment ring and brass arcane machinery',
    'stealth-bay':      'a dark stealth bay, moody cyan rim-light, a cloaking rig, dark lockers and a recon console',
    'watchtower':       'a watchtower / sniper nest with a slit window, a mounted long rifle and ammo crates',
    'training-room':    'a training room with combat dummies, a weight rack and worn target boards',
    'weapons-workshop': 'a weapons workshop with an anvil, a glowing forge, a vice bench and scattered tools',
    'science-lab':      'a science lab with bubbling test tubes, a chemistry rig and a humming computer terminal',
    'garden':           'a hydroponics garden with grow-light racks of green plants and irrigation troughs',
    'radio-room':       'a radio room with a big valve transceiver, a wall map and a headset on the desk',
    'armory':           'an armory stacked with heavy weapons, missile crates, grenades and a fortified rack',
    'storage-vault':    'a storage vault stacked with crates, barrels, footlockers and shelving',
}

def jobs():
    J = []
    def add(name, prompt, aspect, isolate=True, seed_center=False):
        J.append({
            'key': name,
            'kvKey': f'pixel-art-vault:{name}',
            'assetUrl': f'https://{WORKER}/asset/vault/{name}.png',
            'prompt': prompt, 'aspect': aspect,
            'isolate': isolate, 'seed_center': seed_center,
        })

    # 1. Cross-section terrain background (full-bleed, NOT isolated).
    add('terrain',
        f"{VAULT_STYLE}. A tall vertical cross-section of a rocky mountainside cut "
        f"open to show layered dirt, rock strata and bedrock that a fallout vault is "
        f"dug into, empty excavated cavity in the center for vault rooms, dramatic "
        f"earthy browns and greys, subterranean depth, no text, no logo",
        '3:4', isolate=False)

    # 2. Vault door (heavy circular Vault-Tec style, top entrance).
    add('door',
        f"{VAULT_STYLE}. A massive heavy circular cog-shaped fallout-vault blast door "
        f"set in a riveted steel frame, big central gear-wheel, yellow-and-green hazard "
        f"trim, the number 86 stenciled on it, head-on view. {ON_MAGENTA}",
        '1:1', isolate=True, seed_center=False)

    # 3. 16 room cells (isolated horizontal room dioramas).
    for rtype, desc in ROOM_DESC.items():
        add(f'room-{rtype}',
            f"{VAULT_STYLE}. Interior side-cutaway of {desc}, framed by riveted steel "
            f"bulkhead walls as one room cell of a fallout vault, clean readable, evenly "
            f"lit, no characters. {ON_MAGENTA}",
            '3:2', isolate=True, seed_center=False)

    # 4. Per-class dweller sprites (5 classes x 2 sexes), front idle.
    CLASS_LOOK = {
        'warrior': 'a sturdy warrior in a blue-and-yellow vault jumpsuit with steel shoulder armor and a combat knife',
        'mage':    'a mage in a blue vault jumpsuit with arcane-blue glowing trim and a small floating energy orb',
        'rogue':   'a rogue in a dark hooded vault jumpsuit with cyan accents and a holstered pistol',
        'ranger':  'a ranger in a vault jumpsuit with a leather bandolier and a slung long rifle',
        'healer':  'a healer in a vault jumpsuit with a red-cross armband holding a stimpak',
    }
    for cls, look in CLASS_LOOK.items():
        for sex, who in (('m', 'man'), ('f', 'woman')):
            add(f'dweller-{cls}-{sex}',
                f"{VAULT_STYLE}. Full-body front-facing chibi game-sprite of a {who}, "
                f"{look}, standing idle, friendly, small simple readable character, "
                f"thick clean outline. {ON_MAGENTA}",
                '2:3', isolate=True, seed_center=False)

    # 5. Crisis FX overlays (match CRISIS_KINDS fx keys).
    CRISIS = {
        'raiders':       'a menacing group of wasteland raider silhouettes in spiked scrap armor charging with weapons raised',
        'fire':          'a burst of roaring orange flames and black smoke, a fire hazard',
        'radstorm':      'a sickly green radioactive storm cloud with crackling rad-energy and falling glow',
        'infestation':   'a swarm of giant mutant ants pouring in, an infestation',
        'power-failure': 'sparking severed power cables and a flickering red alarm light in darkness',
    }
    for kind, desc in CRISIS.items():
        add(f'crisis-{kind}',
            f"{VAULT_STYLE}. A crisis-event overlay icon: {desc}, dramatic warning red "
            f"glow, dynamic game FX. {ON_MAGENTA}",
            '1:1', isolate=True, seed_center=True)

    # 6. HUD chrome.
    add('hud-terminal',
        f"{VAULT_STYLE}. A small green retro Vault-Tec terminal / monitor icon with a "
        f"glowing CRT screen and chunky bezel, UI button icon. {ON_MAGENTA}",
        '1:1', isolate=True, seed_center=True)
    add('vault-emblem',
        f"{VAULT_STYLE}. A circular Vault-Tec style emblem badge with a stylized cog "
        f"and the number 86, weathered metal, UI logo. {ON_MAGENTA}",
        '1:1', isolate=True, seed_center=True)
    return J

# ── Process one + flush ────────────────────────────────────────────────
def process_one(job):
    out = ART / (job['key'] + '.png')
    last = None
    for attempt in range(3):
        try:
            _, billed = gen(job['prompt'], job['aspect'], out)
            if job.get('isolate'):
                img = flood_key(Image.open(out), 64, job.get('seed_center', False))
                img.save(out, optimize=True)
            if out.stat().st_size < MIN_PNG:
                last = f'small {out.stat().st_size}B'
            else:
                return True, billed, out
        except Exception as e:
            last = str(e)[:140]
        time.sleep(4 + attempt * 4)
    return False, False, last

def flush(pending, st, done, do_commit):
    entries = []
    for j in pending:
        out = ART / (j['key'] + '.png')
        entries.append({'key': j['kvKey'],
                        'value': base64.b64encode(out.read_bytes()).decode('ascii'),
                        'base64': True})
    kv_bulk_put(entries)
    okv = verify(pending[0]['assetUrl'])
    for j in pending:
        if j['key'] not in done:
            st['done'].append(j['key']); done.add(j['key'])
    save_state(st)
    if do_commit: git_push(len(st['done']))
    print(f"  uploaded: chunk {len(pending)} | sample {pending[0]['key']} 200={okv} | total done {len(st['done'])}")

def main(argv):
    if not TOKEN:
        print('REPLICATE_API_TOKEN not set', file=sys.stderr); return 2
    chunk = int(argv[argv.index('--chunk') + 1]) if '--chunk' in argv else 8
    pace  = float(argv[argv.index('--pace') + 1]) if '--pace' in argv else 1.0
    only  = argv[argv.index('--only') + 1] if '--only' in argv else None
    do_commit = '--commit' in argv
    global FORCE
    FORCE = '--force' in argv

    J = jobs()
    if only:
        J = [j for j in J if j['key'].startswith(only)]
    st = load_state(); done = set(st['done'])
    todo = J if FORCE else [j for j in J if j['key'] not in done]
    print(f'vault-art: {len(J)} assets | {len(J)-len(todo)} done | {len(todo)} remaining | spend ${st["spend"]:.2f}')

    pending = []
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
            flush(pending, st, done, do_commit); pending = []
    if pending:
        flush(pending, st, done, do_commit)

    print(f'\nvault-art run end. done {len(st["done"])}/{len(J)} | failed {len(st["failed"])} | spend ${st["spend"]:.2f}')
    return 0

if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
