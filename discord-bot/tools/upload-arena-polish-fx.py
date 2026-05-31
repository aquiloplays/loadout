"""Upload the arena-polish FX batch to the worker KV.

Reads the manifest written by tools/arena-polish-fx-generator.py
(/tmp/boltbound-arena-fx/manifest.json), then for each slug whose
<slug>.png exists, base64-bulk-puts the PNG bytes to LOADOUT_BOLTS
under the manifest's KV key (pixel-art-boltbound:fx:* or
pixel-art-rpg:hero-idle:*).

Size-verifies every PNG before upload (per the predecessor's lesson —
a corrupt/empty generation must never be "uploaded" as success). One
bulk-put for the whole batch.

Usage:
  python tools/upload-arena-polish-fx.py [--dry-run]
"""
from __future__ import annotations
import base64
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

SRC = Path('/tmp/boltbound-arena-fx')
MANIFEST = SRC / 'manifest.json'
KV_NS = 'LOADOUT_BOLTS'
MIN_BYTES = 300


def wrangler_bulk_put(json_path: Path) -> None:
    cmd = f'npx wrangler kv bulk put "{json_path}" --binding {KV_NS} --remote'
    res = subprocess.run(cmd, shell=True, capture_output=True, text=True,
                         encoding='utf-8', errors='replace')
    def safe(s):
        return (s or '').encode('ascii', 'replace').decode('ascii')
    if res.returncode != 0:
        print('STDOUT:', safe(res.stdout)[-1200:])
        print('STDERR:', safe(res.stderr)[-1200:])
        raise RuntimeError(f'wrangler bulk put failed: {res.returncode}')
    for line in safe((res.stdout or res.stderr)).strip().splitlines()[-2:]:
        print('   ', line)


def main(argv):
    dry = '--dry-run' in argv
    if not MANIFEST.exists():
        print(f'ERR  missing {MANIFEST} — run arena-polish-fx-generator.py first', file=sys.stderr)
        return 1
    manifest = json.loads(MANIFEST.read_text())

    entries, missing, skipped = [], [], []
    for slug, meta in manifest.items():
        png = SRC / f'{slug}.png'
        if not png.exists():
            missing.append(slug); continue
        raw = png.read_bytes()
        if len(raw) < MIN_BYTES:
            print(f'  SKIP {slug}: only {len(raw)} bytes', file=sys.stderr)
            skipped.append(slug); continue
        kv_key = f"{meta['kv']}{meta['key']}"
        entries.append({'key': kv_key, 'value': base64.b64encode(raw).decode('ascii'),
                        'base64': True})
        print(f'  {slug:24} ({len(raw):>6} B) -> {kv_key}')

    if missing:
        print(f'  not-yet-generated ({len(missing)}): {", ".join(missing)}')
    if not entries:
        print('Nothing to upload.'); return 1 if (missing or skipped) else 0
    if dry:
        print(f'(dry run — {len(entries)} keys would upload)'); return 0

    with tempfile.NamedTemporaryFile(mode='w', suffix='-arenafx.json',
                                     delete=False, encoding='utf-8') as fh:
        json.dump(entries, fh)
        tmp = Path(fh.name)
    try:
        t0 = time.time()
        wrangler_bulk_put(tmp)
        print(f'uploaded {len(entries)} keys in {time.time() - t0:.1f}s')
    finally:
        try: tmp.unlink()
        except OSError: pass
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
