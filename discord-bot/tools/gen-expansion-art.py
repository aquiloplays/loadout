"""Parallel art generation for the staged expansion sets (Clay 2026-06-03).

800 expansion cards across 4 sets. Reuses the premium pipeline's gen_art
(Flux 1.1 Pro Ultra, cached in /tmp/boltbound-premium-art) + render_card
(glossy compositor) but runs them through a thread pool so 8 cards bill
concurrently instead of one at a time. Composited faces upload to KV in
bulk batches; a HEAD verifies a sample serves.

Resumable + retry-safe: raw art is cached per id, so a re-run only re-bills
ids whose art is missing. The shared bulk-regen-state.json tracks done ids +
spend so a crash/relaunch resumes cleanly.

Usage:
  REPLICATE_API_TOKEN=... python tools/gen-expansion-art.py \
      [--slugs voidborn,tides-of-aether,...] [--workers 8] [--chunk 100] [--max N]
"""
from __future__ import annotations
import base64, json, os, subprocess, sys, tempfile, time
from pathlib import Path
import importlib.util
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock

import requests
from PIL import Image

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
spec = importlib.util.spec_from_file_location('ppipe', HERE / 'premium-card-pipeline.py')
ppipe = importlib.util.module_from_spec(spec); spec.loader.exec_module(ppipe)

WORKER_HOST = 'loadout-discord.aquiloplays.workers.dev'
KV_NS = 'LOADOUT_BOLTS'
PIXEL_ART_KEY = lambda cid: f'pixel-art-card:{cid}'
GLOBAL_ART_KEY = lambda cid: f'global-card-art:{cid}'
ASSET_URL = lambda cid: f'https://{WORKER_HOST}/asset/card-art/{cid}.png'

STATE_TMP = Path('/tmp/bulk-regen-state.json')
STATE_REPO = ROOT / 'bulk-regen-state.json'
COST_PER_CARD = 0.06
MIN_PNG = 20_000
ALL_SLUGS = ['voidborn', 'tides-of-aether', 'embercrown-rising', 'verdant-awakening']

state_lock = Lock()

def load_state():
    for p in (STATE_TMP, STATE_REPO):
        if p.exists():
            try: return json.loads(p.read_text())
            except Exception: pass
    return {'done': [], 'failed': [], 'uploaded': [], 'spend': 0.0}

def save_state(st):
    STATE_TMP.write_text(json.dumps(st))
    STATE_REPO.write_text(json.dumps(st, indent=0))

def expansion_ids(slugs):
    node = (
        "import('./cards-content.js').then(m=>{const o=[];"
        "for(const id of Object.keys(m.CARDS)){const c=m.CARDS[id];"
        f"if(({json.dumps(slugs)}).includes(c.set))o.push(id);}}"
        "process.stdout.write(JSON.stringify(o));});"
    )
    r = subprocess.run(['node', '-e', node], cwd=str(ROOT), capture_output=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError('id load failed: ' + r.stderr.decode('utf-8', 'replace')[:300])
    return json.loads(r.stdout.decode('utf-8'))

def render_one(cards, cid):
    """gen art (cached → no re-bill) + composite + QA. Returns (cid, ok, billed, note)."""
    card = cards[cid]
    art_cached = (ppipe.ART_DIR / f'{cid}.png').exists()
    last = None
    for attempt in range(3):
        try:
            art = ppipe.gen_art(card)
            full = ppipe.render_card(Image.open(art), card)
            out = ppipe.CARD_DIR / f'{cid}.png'
            full.save(out, optimize=True)
            im = Image.open(out)
            if im.size != (ppipe.W, ppipe.H):
                last = f'bad dims {im.size}'
            elif out.stat().st_size < MIN_PNG:
                last = f'small ({out.stat().st_size}B)'
            else:
                return (cid, True, (not art_cached), 'ok')
        except Exception as e:
            last = str(e)[:140]
        time.sleep(3 + attempt * 3)
    return (cid, False, (not art_cached), last or 'failed')

def wrangler_bulk_put(entries):
    with tempfile.NamedTemporaryFile(mode='w', suffix='-cards.json', delete=False, encoding='utf-8') as fh:
        json.dump(entries, fh); tmp = Path(fh.name)
    try:
        cmd = f'npx wrangler kv bulk put "{tmp}" --binding {KV_NS} --remote'
        res = subprocess.run(cmd, shell=True, capture_output=True, text=True, encoding='utf-8', errors='replace', cwd=str(ROOT))
        if res.returncode != 0:
            raise RuntimeError('bulk put failed: ' + (res.stderr or res.stdout or '')[-400:])
    finally:
        try: tmp.unlink()
        except OSError: pass

def upload_batch(cids, now_iso):
    png_entries, rec_entries = [], []
    for cid in cids:
        raw = (ppipe.CARD_DIR / f'{cid}.png').read_bytes()
        png_entries.append({'key': PIXEL_ART_KEY(cid), 'value': base64.b64encode(raw).decode('ascii'), 'base64': True})
        rec = {'memeGifUrl': ASSET_URL(cid), 'searchTerm': None, 'source': 'expansion-bulk-v1',
               'contentLength': len(raw), 'validatedAt': now_iso, 'updatedAt': now_iso}
        rec_entries.append({'key': GLOBAL_ART_KEY(cid), 'value': json.dumps(rec, separators=(',', ':'))})
    wrangler_bulk_put(png_entries)
    wrangler_bulk_put(rec_entries)

def verify(cid):
    try:
        r = requests.head(ASSET_URL(cid), timeout=30)
        return r.status_code == 200 and int(r.headers.get('content-length', '0')) >= MIN_PNG
    except Exception:
        return False

def main(argv):
    if not ppipe.TOKEN:
        print('REPLICATE_API_TOKEN not set', file=sys.stderr); return 2
    slugs = argv[argv.index('--slugs') + 1].split(',') if '--slugs' in argv else ALL_SLUGS
    workers = int(argv[argv.index('--workers') + 1]) if '--workers' in argv else 8
    chunk = int(argv[argv.index('--chunk') + 1]) if '--chunk' in argv else 100
    max_cards = int(argv[argv.index('--max') + 1]) if '--max' in argv else 10**9

    cards = ppipe.load_cards()
    ids = [c for c in expansion_ids(slugs) if c in cards]
    st = load_state()
    done = set(st['done'])
    todo = [c for c in ids if c not in done][:max_cards]
    now_iso = subprocess.run(['node', '-e', 'process.stdout.write(new Date().toISOString())'],
                             capture_output=True, text=True).stdout.strip() or '2026-06-03T00:00:00.000Z'
    print(f'{len(ids)} expansion cards | {len(ids)-len(todo)} already done | {len(todo)} to render | spend ${st["spend"]:.2f}', flush=True)

    pending = []
    processed = 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(render_one, cards, cid): cid for cid in todo}
        for fut in as_completed(futs):
            cid, ok, billed, note = fut.result()
            processed += 1
            with state_lock:
                if billed:
                    st['spend'] = round(st['spend'] + COST_PER_CARD, 4)
                if ok:
                    pending.append(cid)
                else:
                    st['failed'] = [f for f in st['failed'] if f != cid] + [cid]
                    print(f'  SKIP {cid}: {note}', file=sys.stderr, flush=True)
            if processed % 25 == 0:
                print(f'  ...{processed}/{len(todo)} rendered (spend ${st["spend"]:.2f})', flush=True)
            # Flush an upload chunk on the main thread.
            if len(pending) >= chunk:
                batch = pending[:]; pending.clear()
                upload_batch(batch, now_iso)
                with state_lock:
                    st['done'] += batch; st['uploaded'] += batch; done.update(batch)
                    save_state(st)
                print(f'  uploaded chunk of {len(batch)} | sample {batch[0]} 200={verify(batch[0])} | done {len(st["done"])}', flush=True)
    if pending:
        upload_batch(pending, now_iso)
        with state_lock:
            st['done'] += pending; st['uploaded'] += pending
            save_state(st)
        print(f'  uploaded final {len(pending)} | sample 200={verify(pending[0])} | done {len(st["done"])}', flush=True)

    print(f'\nDONE. rendered {processed}, failed {len(st["failed"])}, spend ${st["spend"]:.2f}', flush=True)
    return 0

if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
