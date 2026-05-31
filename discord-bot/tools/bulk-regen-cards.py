"""Bulk regen of all Boltbound card faces at premium quality (Clay GO).

Resumable, chunked, QA'd, budget-gated. Reuses the premium pipeline
(tools/premium-card-pipeline.py) for art generation + the glossy
compositor, then uploads the finished faces to the global-default card
namespace and verifies they serve.

Per card:
  1. gen_art  — Flux 1.1 Pro Ultra (cached in /tmp/boltbound-premium-art)
  2. render   — glossy compositor (accurate text from card data)
  3. QA       — dims == 720x1008, file size sane, render didn't throw
  4. (batched) base64 bulk-put to KV:
       pixel-art-card:<id>   raw PNG bytes  (served at /asset/card-art/<id>.png)
       global-card-art:<id>  JSON record    (the global default layer)
  5. verify a sample of the batch returns HTTP 200

State (/tmp/bulk-regen-state.json) tracks done ids + spend + upload
cursor so a re-run (or a successor chip) resumes cleanly. A copy is
written to the repo (bulk-regen-state.json) each chunk for git-durable
progress.

Budget gate: stops + reports at SPEND_GATE. Failures: 2 retries then
log-and-skip (never blocks the batch).

Usage:
  REPLICATE_API_TOKEN=... python tools/bulk-regen-cards.py [--max N] [--chunk 50]
"""
from __future__ import annotations
import base64, json, os, subprocess, sys, tempfile, time
from pathlib import Path
import importlib.util

import requests
from PIL import Image

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

# Import the premium pipeline as a module (reuse gen_art / render_card /
# load_cards / _download / CARD_DIR / ART_DIR).
spec = importlib.util.spec_from_file_location('ppipe', HERE / 'premium-card-pipeline.py')
ppipe = importlib.util.module_from_spec(spec); spec.loader.exec_module(ppipe)

WORKER_HOST = 'loadout-discord.aquiloplays.workers.dev'
KV_NS = 'LOADOUT_BOLTS'
PIXEL_ART_KEY = lambda cid: f'pixel-art-card:{cid}'
GLOBAL_ART_KEY = lambda cid: f'global-card-art:{cid}'
ASSET_URL = lambda cid: f'https://{WORKER_HOST}/asset/card-art/{cid}.png'

STATE_TMP = Path('/tmp/bulk-regen-state.json')
STATE_REPO = ROOT / 'bulk-regen-state.json'
COST_PER_CARD = 0.06          # Flux Pro Ultra
SPEND_GATE = 120.0            # pause + surface if spend would exceed this
MIN_PNG = 20_000              # a finished 720x1008 card is ~hundreds of KB

def load_state():
    for p in (STATE_TMP, STATE_REPO):
        if p.exists():
            try: return json.loads(p.read_text())
            except Exception: pass
    return {'done': [], 'failed': [], 'uploaded': [], 'spend': 0.0}

def save_state(st):
    txt = json.dumps(st)
    STATE_TMP.write_text(txt)
    STATE_REPO.write_text(json.dumps(st, indent=0))

def wrangler_bulk_put(entries):
    with tempfile.NamedTemporaryFile(mode='w', suffix='-cards.json', delete=False, encoding='utf-8') as fh:
        json.dump(entries, fh); tmp = Path(fh.name)
    try:
        cmd = f'npx wrangler kv bulk put "{tmp}" --binding {KV_NS} --remote'
        res = subprocess.run(cmd, shell=True, capture_output=True, text=True, encoding='utf-8', errors='replace')
        if res.returncode != 0:
            raise RuntimeError('bulk put failed: ' + (res.stderr or res.stdout or '')[-400:])
    finally:
        try: tmp.unlink()
        except OSError: pass

def upload_batch(cids):
    """Upload PNG bytes + global-art records for a list of card ids."""
    png_entries, rec_entries = [], []
    now_iso = subprocess.run(['node', '-e', 'process.stdout.write(new Date().toISOString())'],
                             capture_output=True, text=True).stdout.strip() or '2026-05-31T00:00:00.000Z'
    for cid in cids:
        png = ppipe.CARD_DIR / f'{cid}.png'
        raw = png.read_bytes()
        png_entries.append({'key': PIXEL_ART_KEY(cid),
                            'value': base64.b64encode(raw).decode('ascii'), 'base64': True})
        rec = {'memeGifUrl': ASSET_URL(cid), 'searchTerm': None,
               'source': 'premium-overhaul-v1', 'contentLength': len(raw),
               'validatedAt': now_iso, 'updatedAt': now_iso}
        rec_entries.append({'key': GLOBAL_ART_KEY(cid), 'value': json.dumps(rec, separators=(',', ':'))})
    wrangler_bulk_put(png_entries)
    wrangler_bulk_put(rec_entries)

def verify(cid):
    try:
        r = requests.head(ASSET_URL(cid), timeout=30)
        return r.status_code == 200 and int(r.headers.get('content-length', '0')) >= MIN_PNG
    except Exception:
        return False

def qa(cid):
    png = ppipe.CARD_DIR / f'{cid}.png'
    if not png.exists() or png.stat().st_size < MIN_PNG:
        return False, f'png missing/small ({png.stat().st_size if png.exists() else 0}B)'
    try:
        im = Image.open(png)
        if im.size != (ppipe.W, ppipe.H):
            return False, f'bad dims {im.size}'
    except Exception as e:
        return False, f'open failed {e}'
    return True, 'ok'

def regen_one(card):
    """gen art -> composite -> QA. Returns (ok, billed_bool, note)."""
    cid = card['id']
    art_cached = (ppipe.ART_DIR / f'{cid}.png').exists()
    last = None
    for attempt in range(3):
        try:
            art = ppipe.gen_art(card)            # cached -> no re-bill
            full = ppipe.render_card(Image.open(art), card)
            full.save(ppipe.CARD_DIR / f'{cid}.png', optimize=True)
            ok, note = qa(cid)
            if ok:
                return True, (not art_cached), note
            last = note
        except Exception as e:
            last = str(e)[:120]
        time.sleep(4 + attempt * 4)
    return False, (not art_cached), last or 'failed'

def main(argv):
    if not ppipe.TOKEN:
        print('REPLICATE_API_TOKEN not set', file=sys.stderr); return 2
    max_cards = int(argv[argv.index('--max') + 1]) if '--max' in argv else 10**9
    chunk = int(argv[argv.index('--chunk') + 1]) if '--chunk' in argv else 50
    only = argv[argv.index('--only') + 1].split(',') if '--only' in argv else None
    pace = float(argv[argv.index('--pace') + 1]) if '--pace' in argv else 2.0

    cards = ppipe.load_cards()
    st = load_state()
    done = set(st['done'])
    ids = only or list(cards.keys())
    todo = [c for c in ids if c not in done]
    print(f'{len(cards)} total | {len(done)} done | {len(todo)} remaining | spend ${st["spend"]:.2f}')

    processed, pending_upload = 0, []
    for cid in todo:
        if processed >= max_cards: break
        card = cards[cid]
        # Budget gate (only counts NEW billed gens).
        if st['spend'] + COST_PER_CARD > SPEND_GATE:
            print(f'\n*** BUDGET GATE at ${st["spend"]:.2f} (next would exceed ${SPEND_GATE}). Pausing. ***')
            break
        ok, billed, note = regen_one(card)
        if billed:
            st['spend'] = round(st['spend'] + COST_PER_CARD, 4)
        if ok:
            pending_upload.append(cid)
            print(f'  ok   {cid}  (${st["spend"]:.2f})')
        else:
            st['failed'] = [f for f in st['failed'] if f != cid] + [cid]
            print(f'  SKIP {cid}: {note}', file=sys.stderr)
        processed += 1
        if pace: time.sleep(pace)

        # Flush an upload chunk.
        if len(pending_upload) >= chunk:
            upload_batch(pending_upload)
            sample = pending_upload[0]
            okv = verify(sample)
            st['done'] += pending_upload
            st['uploaded'] += pending_upload
            done.update(pending_upload)
            save_state(st)
            print(f'  uploaded: uploaded chunk of {len(pending_upload)} | sample {sample} 200={okv} | total done {len(st["done"])}')
            pending_upload = []

    if pending_upload:
        upload_batch(pending_upload)
        okv = verify(pending_upload[0])
        st['done'] += pending_upload; st['uploaded'] += pending_upload
        save_state(st)
        print(f'  uploaded: final chunk of {len(pending_upload)} | sample 200={okv} | total done {len(st["done"])}')

    print(f'\nProcessed {processed} this run. Done {len(st["done"])}/{len(cards)}. '
          f'Failed {len(st["failed"])}. Spend ${st["spend"]:.2f}.')
    return 0

if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
