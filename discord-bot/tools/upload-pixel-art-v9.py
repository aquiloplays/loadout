"""Bulk-upload v9 pixel-art PNGs to the loadout-discord worker KV.

Pipeline:
  1. Read every PNG from /c/tmp/boltbound-pixel-cards-v9/<cardId>.png
  2. Skip any cardIds not present in the catalogue (so an off-by-one
     filename can't poison the global record map).
  3. Write the raw PNG bytes to LOADOUT_BOLTS under
     pixel-art-card:<cardId>.
  4. Register the per-card global-art record at
     global-card-art:<cardId> pointing at the worker asset URL.

Uses `wrangler kv bulk put` with base64-encoded JSON. The bulk API
caps each call at ~100 MB on the wire, so we chunk by encoded byte
budget (CHUNK_BUDGET_BYTES). One wrangler invocation per chunk —
massively faster than 1266 individual `wrangler kv key put` calls
(each Node startup is ~2-3s on Windows).

Idempotent — re-running just overwrites the same keys. Counts the
chunks emitted so a partial failure can be retried after editing the
script to skip already-uploaded ones if needed.

Usage:
  python tools/upload-pixel-art-v9.py [--dry-run] [--catalogue-only]
"""
from __future__ import annotations
import base64
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

# ── Config ──────────────────────────────────────────────────────────
SOURCE_DIR  = Path(r'C:\tmp\boltbound-pixel-cards-v9')
WORKER_HOST = 'loadout-discord.aquiloplays.workers.dev'
KV_NS_BIND  = 'LOADOUT_BOLTS'
# 50 MB per bulk chunk — well under the API ceiling, leaves headroom
# for JSON overhead + base64's 4/3 inflation.
CHUNK_BUDGET_BYTES = 50 * 1024 * 1024

# Card-art namespace keys
PIXEL_ART_KEY    = lambda cid: f'pixel-art-card:{cid}'
GLOBAL_ART_KEY   = lambda cid: f'global-card-art:{cid}'
ASSET_URL        = lambda cid: f'https://{WORKER_HOST}/asset/card-art/{cid}.png'

# Catalogue id regex — same chars the worker route accepts.
CID_RE = re.compile(r'^[a-z0-9][a-z0-9.\-]*$')

# Two bulk uploads happen in this script:
#   1. The PNG bytes (large — needs base64).
#   2. The global-card-art JSON records (small — plain JSON values).
# Wrangler bulk JSON format:
#   [{"key": "...", "value": "...", "base64": true}, ...]


def load_catalogue() -> set[str]:
    """Pull the card-id set from cards-content.js by spawning node."""
    here = Path(__file__).resolve().parent.parent   # discord-bot/
    script = (
        "import { CARDS } from './cards-content.js';"
        " console.log(JSON.stringify(Object.keys(CARDS)));"
    )
    res = subprocess.run(
        ['node', '--input-type=module', '-e', script],
        cwd=here, capture_output=True, text=True, check=True,
    )
    return set(json.loads(res.stdout.strip()))


def discover_pngs() -> list[tuple[str, Path]]:
    """Return [(cardId, path), ...] for every <cardId>.png in SOURCE_DIR."""
    out = []
    for p in sorted(SOURCE_DIR.iterdir()):
        if not p.is_file() or p.suffix.lower() != '.png':
            continue
        cid = p.stem
        if not CID_RE.match(cid):
            print(f'  skip (bad cardId): {p.name}', file=sys.stderr)
            continue
        out.append((cid, p))
    return out


def wrangler_bulk_put(json_path: Path) -> None:
    """Invoke `wrangler kv bulk put <file> --binding=... --remote`.

    Uses shell=True on Windows because npx resolves to npx.cmd which
    needs the shell's PATHEXT to be findable from CreateProcess."""
    cmd = (
        f'npx wrangler kv bulk put "{json_path}" '
        f'--binding {KV_NS_BIND} --remote'
    )
    res = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if res.returncode != 0:
        print('STDOUT:', res.stdout[-500:])
        print('STDERR:', res.stderr[-500:])
        raise RuntimeError(f'wrangler bulk put failed: {res.returncode}')
    # On success wrangler prints a "Success!" line — surface a tail.
    tail = (res.stdout or res.stderr).strip().splitlines()[-2:]
    for line in tail:
        print('   ', line)


def chunked_bulk_upload_pngs(items: list[tuple[str, Path]], dry: bool) -> int:
    """Build bulk JSON files, upload each. Returns total items written."""
    chunk: list[dict] = []
    chunk_bytes = 0
    chunk_idx = 0
    total = 0
    for cid, path in items:
        raw = path.read_bytes()
        b64 = base64.b64encode(raw).decode('ascii')
        entry = {'key': PIXEL_ART_KEY(cid), 'value': b64, 'base64': True}
        # rough size: base64 length + JSON overhead
        size = len(b64) + len(entry['key']) + 32
        if chunk and chunk_bytes + size > CHUNK_BUDGET_BYTES:
            chunk_idx += 1
            print(f'  chunk #{chunk_idx}: {len(chunk)} entries, '
                  f'~{chunk_bytes / 1024 / 1024:.1f} MB')
            if not dry:
                _flush_chunk(chunk, chunk_idx)
            total += len(chunk)
            chunk = []
            chunk_bytes = 0
        chunk.append(entry)
        chunk_bytes += size
    if chunk:
        chunk_idx += 1
        print(f'  chunk #{chunk_idx}: {len(chunk)} entries, '
              f'~{chunk_bytes / 1024 / 1024:.1f} MB')
        if not dry:
            _flush_chunk(chunk, chunk_idx)
        total += len(chunk)
    return total


def _flush_chunk(chunk: list[dict], chunk_idx: int) -> None:
    """Write chunk to a temp JSON file + invoke wrangler bulk put."""
    with tempfile.NamedTemporaryFile(
        mode='w', suffix=f'-png-chunk{chunk_idx}.json',
        delete=False, encoding='utf-8',
    ) as fh:
        json.dump(chunk, fh)
        tmp_path = Path(fh.name)
    try:
        t0 = time.time()
        wrangler_bulk_put(tmp_path)
        print(f'    uploaded in {time.time() - t0:.1f}s')
    finally:
        try: tmp_path.unlink()
        except OSError: pass


def upload_global_art_records(card_ids: list[str], dry: bool) -> int:
    """Write the per-card global-card-art:<id> records pointing at the asset URL."""
    now_iso = '2026-05-29T00:00:00.000Z'   # stamped at run time of v9
    records = []
    for cid in card_ids:
        rec = {
            'memeGifUrl':    ASSET_URL(cid),
            'searchTerm':    None,
            'source':        'pixel-art-v9',
            'contentLength': None,
            'validatedAt':   now_iso,
            'updatedAt':     now_iso,
        }
        records.append({
            'key': GLOBAL_ART_KEY(cid),
            'value': json.dumps(rec, separators=(',', ':')),
        })
    # global-card-art records are tiny JSON blobs (~200 B each) so one
    # bulk call covers all 1266 even at the API ceiling.
    with tempfile.NamedTemporaryFile(
        mode='w', suffix='-global-art.json', delete=False, encoding='utf-8',
    ) as fh:
        json.dump(records, fh)
        tmp_path = Path(fh.name)
    print(f'  global-art bulk: {len(records)} records, '
          f'~{tmp_path.stat().st_size / 1024:.1f} KB')
    if not dry:
        try:
            t0 = time.time()
            wrangler_bulk_put(tmp_path)
            print(f'    registered in {time.time() - t0:.1f}s')
        finally:
            try: tmp_path.unlink()
            except OSError: pass
    return len(records)


def main(argv: list[str]) -> int:
    dry = '--dry-run' in argv
    catalogue_only = '--catalogue-only' in argv
    print('=' * 60)
    print(f'Pixel-art v9 -> KV bulk upload  {"(DRY RUN)" if dry else ""}')
    print('=' * 60)

    if not SOURCE_DIR.exists():
        print(f'  ERR  source dir not found: {SOURCE_DIR}', file=sys.stderr)
        return 1

    print('Loading catalogue …')
    catalogue = load_catalogue()
    print(f'  catalogue size: {len(catalogue)}')

    print('Scanning v9 output …')
    pngs = discover_pngs()
    print(f'  PNGs found: {len(pngs)}')

    in_cat   = [(cid, p) for (cid, p) in pngs if cid in catalogue]
    off_cat  = [cid for (cid, p) in pngs if cid not in catalogue]
    miss_cat = sorted(catalogue - {cid for (cid, _) in pngs})
    print(f'  in-catalogue: {len(in_cat)}')
    print(f'  off-catalogue (skipped): {len(off_cat)}')
    if off_cat[:5]: print(f'    first off: {off_cat[:5]}')
    print(f'  catalogue cards with NO PNG: {len(miss_cat)}')
    if miss_cat[:5]: print(f'    first missing: {miss_cat[:5]}')

    upload_set = in_cat if catalogue_only else pngs

    print()
    print(f'Uploading {len(upload_set)} PNGs (raw bytes -> pixel-art-card:*) …')
    t0 = time.time()
    n_pngs = chunked_bulk_upload_pngs(upload_set, dry=dry)
    print(f'  done — {n_pngs} PNG keys, {time.time() - t0:.1f}s')

    print()
    print(f'Registering {len(upload_set)} global-card-art records …')
    t0 = time.time()
    n_records = upload_global_art_records(
        [cid for (cid, _) in upload_set], dry=dry,
    )
    print(f'  done — {n_records} records, {time.time() - t0:.1f}s')

    print()
    print('Samples (first 5):')
    for cid, _ in upload_set[:5]:
        print(f'  {cid}  ->  {ASSET_URL(cid)}')

    print('Done.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
