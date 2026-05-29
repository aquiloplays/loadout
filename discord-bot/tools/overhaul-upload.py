"""Phase-aware bulk uploader for the asset overhaul.

Mirrors upload-pixel-art-v9.py but takes a phase name + maps filenames
to the right KV keys. Filenames carry their KV path as
`__`-separated components (since `:` isn't portable in Windows
filenames). E.g.:

  gear__weapon__bronze-shortsword__common.png
    -> KV key  pixel-art-gear:weapon:bronze-shortsword:common
    -> URL     /asset/gear-art/weapon/bronze-shortsword/common.png

Same wrangler-bulk-put strategy as v9: chunk to ~50 MB JSON payloads,
one wrangler invocation per chunk. Idempotent — re-running overwrites
the same keys.

Usage:
  python tools/overhaul-upload.py <phase> [--dry-run]
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

SRC_ROOT    = Path(r'C:\tmp\pixel-art-overhaul')
WORKER_HOST = 'loadout-discord.aquiloplays.workers.dev'
KV_NS_BIND  = 'LOADOUT_BOLTS'
CHUNK_BUDGET_BYTES = 50 * 1024 * 1024

# Phase -> URL segment under /asset/
PHASE_TO_URL_SEG = {
    'heroes': 'hero-art',
    'gear':   'gear-art',
    'clash':  'clash-art',
    'pets':   'pet-art',
}

# Filename prefix → KV/URL category. The pipeline emits filenames
# whose first __-segment is the category id (hero, gear, clash, pet).
PREFIX_TO_CATEGORY = {
    'hero':  'hero',
    'gear':  'gear',
    'clash': 'clash',
    'pet':   'pet',
}

FNAME_RE = re.compile(r'^([a-z]+(?:__[a-z0-9.\-]+)+)\.png$')


def filename_to_kv_path(fname: str) -> tuple[str, list[str]] | None:
    """Return (category, [segments-after-prefix])."""
    m = FNAME_RE.match(fname)
    if not m:
        return None
    parts = m.group(1).split('__')
    if not parts or parts[0] not in PREFIX_TO_CATEGORY:
        return None
    return PREFIX_TO_CATEGORY[parts[0]], parts[1:]


def kv_key(category: str, segments: list[str]) -> str:
    return f'pixel-art-{category}:' + ':'.join(segments)


def asset_url(category: str, segments: list[str]) -> str:
    url_seg = {'hero': 'hero-art', 'gear': 'gear-art',
               'clash': 'clash-art', 'pet': 'pet-art'}[category]
    return f'https://{WORKER_HOST}/asset/{url_seg}/' + '/'.join(segments) + '.png'


def wrangler_bulk_put(json_path: Path) -> None:
    cmd = (f'npx wrangler kv bulk put "{json_path}" '
           f'--binding {KV_NS_BIND} --remote')
    res = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if res.returncode != 0:
        print('STDOUT:', res.stdout[-500:])
        print('STDERR:', res.stderr[-500:])
        raise RuntimeError(f'wrangler bulk put failed: {res.returncode}')
    tail = (res.stdout or res.stderr).strip().splitlines()[-2:]
    for line in tail:
        print('   ', line)


def _flush_chunk(chunk: list[dict], chunk_idx: int) -> None:
    with tempfile.NamedTemporaryFile(
        mode='w', suffix=f'-chunk{chunk_idx}.json',
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


def upload_pngs(items: list[tuple[str, list[str], Path]], dry: bool) -> int:
    chunk: list[dict] = []
    chunk_bytes = 0
    chunk_idx = 0
    total = 0
    for category, segments, path in items:
        raw = path.read_bytes()
        b64 = base64.b64encode(raw).decode('ascii')
        key = kv_key(category, segments)
        entry = {'key': key, 'value': b64, 'base64': True}
        size = len(b64) + len(key) + 32
        if chunk and chunk_bytes + size > CHUNK_BUDGET_BYTES:
            chunk_idx += 1
            print(f'  PNG chunk #{chunk_idx}: {len(chunk)} entries, '
                  f'~{chunk_bytes / 1024 / 1024:.1f} MB')
            if not dry: _flush_chunk(chunk, chunk_idx)
            total += len(chunk)
            chunk = []
            chunk_bytes = 0
        chunk.append(entry)
        chunk_bytes += size
    if chunk:
        chunk_idx += 1
        print(f'  PNG chunk #{chunk_idx}: {len(chunk)} entries, '
              f'~{chunk_bytes / 1024 / 1024:.1f} MB')
        if not dry: _flush_chunk(chunk, chunk_idx)
        total += len(chunk)
    return total


def main(argv):
    if not argv or argv[0] not in PHASE_TO_URL_SEG:
        print(f'usage: overhaul-upload.py <{"|".join(PHASE_TO_URL_SEG)}> [--dry-run]',
              file=sys.stderr)
        return 2
    phase = argv[0]
    dry = '--dry-run' in argv

    src_dir = SRC_ROOT / phase
    if not src_dir.exists():
        print(f'  source dir not found: {src_dir}', file=sys.stderr)
        return 1

    print('=' * 60)
    print(f'Asset overhaul {phase} -> KV bulk upload {"(DRY RUN)" if dry else ""}')
    print('=' * 60)

    pngs = sorted(p for p in src_dir.iterdir()
                  if p.is_file() and p.suffix.lower() == '.png')
    print(f'PNGs found: {len(pngs)}')

    items: list[tuple[str, list[str], Path]] = []
    bad = 0
    for p in pngs:
        kv_p = filename_to_kv_path(p.name)
        if not kv_p:
            print(f'  skip (bad filename): {p.name}')
            bad += 1
            continue
        items.append((kv_p[0], kv_p[1], p))
    print(f'  good: {len(items)}, bad: {bad}')

    if not items:
        print('Nothing to upload.')
        return 0

    print()
    print(f'Uploading PNGs -> pixel-art-{PHASE_TO_URL_SEG[phase].split("-")[0]}:*')
    n = upload_pngs(items, dry=dry)
    print(f'  done — {n} PNG keys')

    print()
    print('Sample URLs (first 3):')
    for category, segments, _ in items[:3]:
        print(f'  {asset_url(category, segments)}')

    print('Done.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
