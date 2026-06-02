"""Reusable background-removal pipeline via Replicate rembg (2026-06-02).

WHY this exists: the old edge-seeded flood-fill (hero-body-transparency-fix.py
and friends) hard-cuts edges with a Delta threshold. On character cutouts that
yields BINARY alpha (0% antialiasing) and, when the bg color bleeds into the
subject, eats outline pixels -- the "broken texture" Clay reported. rembg uses
a U^2-Net foreground/background segmenter, producing a soft antialiased matte
with no eaten interior.

MODEL: cjwbw/rembg (U^2-Net), 11M+ runs, version pinned below. ~$0.01/image.
  input  : {"image": <data-uri or url>}
  output : single RGBA PNG uri

WHEN TO USE rembg vs flood-fill:
  - rembg            : character/asset CUTOUTS that get composited (hero bodies,
                       any sprite with a non-trivial silhouette + soft neighbours).
  - flood-fill/keyed : ONLY exact-chromakey #FF00FF scenes (that colour never
                       occurs naturally). Do NOT rembg full-bleed background
                       tiles (e.g. vault terrain/rooms) -- it would segment the
                       scene and delete the "background", destroying the art.

Resumable: per-image disk cache in CACHE, state in STATE; KV upload chunked with
size+200 verify; single-runner lock. ASCII-only output.

Drivers:
  python -u tools/rembg-pipeline.py --category hero-body [--force] [--dry-run]
  python -u tools/rembg-pipeline.py --files a.png b.png   (ad-hoc; writes *_rembg.png)
"""
from __future__ import annotations
import base64, hashlib, io, json, os, subprocess, sys, tempfile, time, urllib.request, urllib.error
from collections import deque
from pathlib import Path
from PIL import Image

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent                       # discord-bot/
WORKER = 'loadout-discord.aquiloplays.workers.dev'
KV_NS = 'LOADOUT_BOLTS'
TOKEN = os.environ.get('REPLICATE_API_TOKEN')
REMBG_VERSION = 'fb8af171cfa1616ddcf1242c093f9c46bcada5ad4cf6f2fbe8b81b330ec5c003'  # cjwbw/rembg
PRED_URL = 'https://api.replicate.com/v1/predictions'
CACHE = Path('C:/tmp/rembg-pipeline'); CACHE.mkdir(parents=True, exist_ok=True)
STATE = ROOT / 'rembg-pipeline-state.json'
LOCK = CACHE / '.runner.lock'
COST = 0.01
MIN_PNG = 4000
SOLIDIFY_AT = 232        # alpha >= this -> 255 (keep body solid, preserve <232 edge ramp)


# ── single-runner guard ──────────────────────────────────────────
def acquire_lock():
    if LOCK.exists():
        age = None
        try:
            import time as _t
            age = _t.time() - LOCK.stat().st_mtime
        except OSError:
            pass
        if age is not None and age < 1800:
            print(f'LOCK held ({LOCK}); another runner active (age {age:.0f}s). Abort.')
            sys.exit(3)
        print('stale lock; reclaiming')
    LOCK.write_text(str(os.getpid()))
def release_lock():
    try: LOCK.unlink()
    except OSError: pass


# ── state ────────────────────────────────────────────────────────
def load_state():
    if STATE.exists():
        try: return json.loads(STATE.read_text())
        except Exception: pass
    return {'done': {}, 'uploaded': [], 'spend': 0.0}
def save_state(s): STATE.write_text(json.dumps(s, indent=1))


# ── rembg core ───────────────────────────────────────────────────
def _http_json(req, timeout=120):
    return json.load(urllib.request.urlopen(req, timeout=timeout))

def rembg(img: Image.Image) -> Image.Image:
    """RGBA/RGB PIL -> RGBA PIL, background removed by cjwbw/rembg."""
    buf = io.BytesIO(); img.convert('RGBA').save(buf, 'PNG')
    uri = 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()
    body = json.dumps({'version': REMBG_VERSION, 'input': {'image': uri}}).encode()
    last = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(PRED_URL, data=body, headers={
                'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json',
                'Prefer': 'wait=60'})
            p = _http_json(req)
            while p.get('status') in ('starting', 'processing'):
                time.sleep(2)
                p = _http_json(urllib.request.Request(p['urls']['get'],
                               headers={'Authorization': f'Bearer {TOKEN}'}), timeout=60)
            if p.get('status') != 'succeeded':
                raise RuntimeError(f"{p.get('status')}: {str(p.get('error'))[:120]}")
            out = p['output']; out = out[0] if isinstance(out, list) else out
            raw = urllib.request.urlopen(out, timeout=120).read()
            if len(raw) < MIN_PNG:
                raise RuntimeError(f'tiny output {len(raw)}B')
            return Image.open(io.BytesIO(raw)).convert('RGBA')
        except (urllib.error.HTTPError, urllib.error.URLError, RuntimeError) as e:
            last = e; print(f'  rembg retry {attempt}: {str(e)[:100]}'); time.sleep(4 + attempt * 4)
    raise RuntimeError(f'rembg failed after retries: {last}')


def solidify(im: Image.Image, at=SOLIDIFY_AT) -> Image.Image:
    """Snap near-opaque interior to 255 so the body never ghosts, while
    preserving the sub-`at` edge ramp that gives clean antialiasing."""
    r, g, b, a = im.split()
    a = a.point(lambda v: 255 if v >= at else v)
    out = Image.merge('RGBA', (r, g, b, a))
    return out


# ── verify ───────────────────────────────────────────────────────
def interior_holes(a: Image.Image, th=24) -> int:
    """Transparent pixels NOT reachable from the border = holes eaten into
    the subject. A clean matte has 0."""
    w, h = a.size; px = a.load(); vis = bytearray(w * h); q = deque()
    def seed(x, y):
        i = y * w + x
        if not vis[i] and px[x, y] < th: vis[i] = 1; q.append((x, y))
    for x in range(w): seed(x, 0); seed(x, h - 1)
    for y in range(h): seed(0, y); seed(w - 1, y)
    while q:
        x, y = q.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h:
                i = ny * w + nx
                if not vis[i] and px[nx, ny] < th: vis[i] = 1; q.append((nx, ny))
    return sum(1 for i in range(w * h) if px[i % w, i // w] < th and not vis[i])

def verify(im: Image.Image) -> tuple[bool, str]:
    if im.mode != 'RGBA': return False, 'not RGBA'
    w, h = im.size; a = im.split()[3]; H = a.histogram(); tot = w * h
    subj = tot - H[0]
    if subj < tot * 0.02: return False, f'subject too small ({100*subj/tot:.1f}%)'
    if subj > tot * 0.97: return False, f'background not removed ({100*subj/tot:.1f}% opaque)'
    semi = sum(H[8:248])
    if semi < subj * 0.01: return False, f'no antialiasing (semi {100*semi/max(subj,1):.2f}%)'
    holes = interior_holes(a)
    if holes > subj * 0.01: return False, f'{holes} interior holes ({100*holes/subj:.2f}%)'
    return True, f'subj={100*subj/tot:.1f}% semi/subj={100*semi/subj:.1f}% holes={holes}'


# ── KV upload (chunked, verified) ────────────────────────────────
def kv_bulk_put(entries, chunk=8):
    for i in range(0, len(entries), chunk):
        batch = entries[i:i + chunk]
        with tempfile.NamedTemporaryFile('w', suffix='-rembg.json', delete=False, encoding='utf-8') as fh:
            json.dump(batch, fh); tmp = fh.name
        try:
            res = subprocess.run(f'npx wrangler kv bulk put "{tmp}" --binding {KV_NS} --remote',
                                 shell=True, capture_output=True, text=True, encoding='utf-8',
                                 errors='replace', cwd=str(ROOT))
            if res.returncode != 0:
                msg = (res.stderr or res.stdout or '')[-400:].encode('ascii', 'replace').decode('ascii')
                if '9109' in msg or 'authentication' in msg.lower():
                    print('  KV AUTH EXPIRED (9109) -- run `wrangler login`; aborting upload')
                print('  chunk FAIL at', i, '::', msg); return res.returncode
            print(f'  chunk {i}-{i+len(batch)} ok')
        finally:
            try: Path(tmp).unlink()
            except OSError: pass
    return 0

def verify_live(keys_to_paths, n=4):
    """HEAD/GET a few asset URLs and confirm 200 + nonzero bytes."""
    ok = 0
    for url in list(keys_to_paths)[:n]:
        try:
            req = urllib.request.Request(f'https://{WORKER}{url}?v={int(time.time())}',
                                         headers={'User-Agent': 'rembg-verify'})
            data = urllib.request.urlopen(req, timeout=60).read()
            print(f'  200 {url} ({len(data)}B)'); ok += 1
        except Exception as e:
            print(f'  FAIL {url}: {str(e)[:80]}')
    return ok


def commit_push(msg):
    for cmd in ('git add -A', f'git commit -m "{msg}"', 'git push'):
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True,
                           encoding='utf-8', errors='replace', cwd=str(ROOT.parent))
        out = (r.stdout or '') + (r.stderr or '')
        print(f'  $ {cmd} -> rc={r.returncode} {out.strip()[:120]}')


# ── fetch helpers ────────────────────────────────────────────────
def fetch_asset(path):
    req = urllib.request.Request(f'https://{WORKER}{path}?rembg={int(time.time())}',
                                 headers={'User-Agent': 'rembg-pipeline'})
    return urllib.request.urlopen(req, timeout=60).read()


# ── driver: hero-body ────────────────────────────────────────────
SEXES = ['male', 'female']
CLASSES = ['warrior', 'mage', 'rogue', 'ranger', 'healer']
TONES = ['fair', 'light', 'tan', 'brown', 'dark', 'deepest']

def driver_hero_body(st, force, dry):
    """10 unique bodies (sex x class; tone is client-side, all 6 keys share one
    image). rembg the live bytes (the only canonical source -- the 512px
    pixel-art-overhaul/heroes/ set is a stale, different generation), solidify,
    verify, then bulk-put all 60 keys."""
    units = [(s, c) for s in SEXES for c in CLASSES]
    cleaned = {}                                       # (s,c) -> bytes
    for s, c in units:
        tag = f'{s}-{c}'
        cache = CACHE / f'hero-body_{tag}.png'
        if cache.exists() and not force:
            cleaned[(s, c)] = cache.read_bytes(); print(f'  {tag} (cache)'); continue
        raw = fetch_asset(f'/asset/hero-body/{tag}-light.png')   # canonical tone
        im = rembg(Image.open(io.BytesIO(raw)))
        im = solidify(im)
        good, why = verify(im)
        print(f'  {tag} rembg -> {why} [{"OK" if good else "REJECT"}]  ${st["spend"]+COST:.2f}')
        if not good:
            st.setdefault('rejected', []).append(f'hero-body:{tag}:{why}')
            raise RuntimeError(f'verify failed for {tag}: {why}')
        buf = io.BytesIO(); im.save(buf, 'PNG'); data = buf.getvalue()
        cache.write_bytes(data); cleaned[(s, c)] = data
        st['spend'] = round(st['spend'] + COST, 4); save_state(st)
    if dry:
        print('DRY-RUN: skip upload'); return 0
    entries = [{'key': f'pixel-art-hero-body:{s}-{c}-{t}',
                'value': base64.b64encode(cleaned[(s, c)]).decode(), 'base64': True}
               for s in SEXES for c in CLASSES for t in TONES]
    print(f'uploading {len(entries)} keys ({len(cleaned)} unique images)')
    rc = kv_bulk_put(entries)
    if rc != 0: return rc
    st['uploaded'].append(f'hero-body:{len(entries)}'); save_state(st)
    print('verify live:')
    verify_live([f'/asset/hero-body/{s}-{c}-light.png' for s, c in units])
    return 0


DRIVERS = {'hero-body': driver_hero_body}


def driver_files(paths):
    for p in paths:
        p = Path(p); im = rembg(Image.open(p)); im = solidify(im)
        good, why = verify(im)
        out = p.with_name(p.stem + '_rembg.png'); im.save(out)
        print(f'{p.name} -> {out.name}  {why} [{"OK" if good else "CHECK"}]')


def main(argv):
    if not TOKEN: print('REPLICATE_API_TOKEN missing'); return 2
    if '--files' in argv:
        driver_files(argv[argv.index('--files') + 1:]); return 0
    cat = argv[argv.index('--category') + 1] if '--category' in argv else None
    if cat not in DRIVERS:
        print('categories:', ', '.join(DRIVERS)); return 2
    force = '--force' in argv; dry = '--dry-run' in argv
    acquire_lock()
    try:
        st = load_state()
        rc = DRIVERS[cat](st, force, dry)
        print(f'\n{cat} done rc={rc}  spend ${st["spend"]:.2f}')
        return rc
    finally:
        release_lock()


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
