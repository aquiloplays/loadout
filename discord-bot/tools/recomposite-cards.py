"""Re-composite + re-upload a specific set of Boltbound card faces.

Used to repair cards whose served image was baked with bad text (the
mojibake encoding fix, and the duplicate-effect diversification). Art is
read from the existing /tmp cache -> ZERO Replicate spend. Only the
glossy text overlay is re-baked from the (now corrected) card data, then
the PNG + global-art record are bulk-put to KV and a sample verified.

Usage:
  python tools/recomposite-cards.py <ids-json-file>     # explicit id list
  python tools/recomposite-cards.py --ids a,b,c
"""
from __future__ import annotations
import importlib.util, json, sys, time
from pathlib import Path
from PIL import Image

HERE = Path(__file__).resolve().parent

def _load(modname, fname):
    spec = importlib.util.spec_from_file_location(modname, HERE / fname)
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m

ppipe = _load('ppipe', 'premium-card-pipeline.py')
bulk  = _load('bulkregen', 'bulk-regen-cards.py')  # reuse upload_batch / verify

def recomposite(ids):
    cards = ppipe.load_cards()
    ids = [i for i in ids if i in cards]
    missing_art = [i for i in ids if not (ppipe.ART_DIR / f'{i}.png').exists()]
    if missing_art:
        print('ABORT: cached art missing for', len(missing_art), 'ids e.g.', missing_art[:5])
        return 1
    print(f'Re-compositing {len(ids)} cards from cached art (no Replicate spend).')
    done = 0
    for cid in ids:
        art = ppipe.ART_DIR / f'{cid}.png'
        full = ppipe.render_card(Image.open(art), cards[cid])
        full.save(ppipe.CARD_DIR / f'{cid}.png', optimize=True)
        done += 1
        if done % 25 == 0:
            print(f'  rendered {done}/{len(ids)}')
    print(f'  rendered {done}/{len(ids)} -> uploading to KV')

    # Upload in chunks of 50 (matches bulk-regen sizing).
    CHUNK = 50
    for i in range(0, len(ids), CHUNK):
        batch = ids[i:i+CHUNK]
        bulk.upload_batch(batch)
        ok = bulk.verify(batch[0])
        print(f'  uploaded {i+len(batch)}/{len(ids)} | sample {batch[0]} 200={ok}')
        time.sleep(1)

    # Verify a spread of URLs (first, middle, last + a few random-ish).
    sample = [ids[0], ids[len(ids)//2], ids[-1]]
    if len(ids) > 6:
        sample += [ids[len(ids)//4], ids[3*len(ids)//4]]
    print('\nURL verification:')
    all_ok = True
    for cid in sample:
        ok = bulk.verify(cid)
        all_ok = all_ok and ok
        print(f'  {bulk.ASSET_URL(cid)}  ->  200={ok}')
    print('\nALL VERIFIED' if all_ok else '\nSOME FAILED')
    return 0 if all_ok else 1

def main(argv):
    if not argv:
        print('usage: recomposite-cards.py <ids.json> | --ids a,b,c'); return 1
    if argv[0] == '--ids':
        ids = argv[1].split(',')
    else:
        ids = json.load(open(argv[0], encoding='utf-8'))
    return recomposite(ids)

if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
