"""Upload the procedural damage-number sprite sheet to the worker KV.

Reads /tmp/boltbound-fx/damage-numbers-sheet.png (produced by
tools/damage-numbers-generator.py) and writes the raw PNG bytes to
LOADOUT_BOLTS under:
    pixel-art-boltbound:fx:damage-numbers-sheet.png

Plus the slice metadata JSON under:
    pixel-art-boltbound:fx:damage-numbers-sheet.json

Uses `wrangler kv bulk put` with base64-encoded values (most reliable
for binary payloads — see the v9 uploader). Verifies the on-disk PNG
size before uploading so a failed generation can't be silently
"uploaded" as an empty key.

Usage:
  python tools/upload-damage-numbers.py [--dry-run]
"""
from __future__ import annotations
import base64
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

SRC_DIR  = Path('/tmp/boltbound-fx')
PNG      = SRC_DIR / 'damage-numbers-sheet.png'
META     = SRC_DIR / 'damage-numbers-sheet.json'
KV_NS    = 'LOADOUT_BOLTS'
PNG_KEY  = 'pixel-art-boltbound:fx:damage-numbers-sheet.png'
META_KEY = 'pixel-art-boltbound:fx:damage-numbers-sheet.json'
MIN_PNG_BYTES = 300   # the sheet is ~1.3 KB; anything tiny means failure


def wrangler_bulk_put(json_path: Path) -> None:
    cmd = f'npx wrangler kv bulk put "{json_path}" --binding {KV_NS} --remote'
    res = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if res.returncode != 0:
        print('STDOUT:', res.stdout[-800:])
        print('STDERR:', res.stderr[-800:])
        raise RuntimeError(f'wrangler bulk put failed: {res.returncode}')
    tail = (res.stdout or res.stderr).strip().splitlines()[-2:]
    for line in tail:
        print('   ', line)


def main(argv: list[str]) -> int:
    dry = '--dry-run' in argv
    if not PNG.exists():
        print(f'ERR  missing {PNG} — run damage-numbers-generator.py first', file=sys.stderr)
        return 1
    png_bytes = PNG.read_bytes()
    if len(png_bytes) < MIN_PNG_BYTES:
        print(f'ERR  {PNG} is only {len(png_bytes)} bytes — generation likely failed', file=sys.stderr)
        return 1

    entries = [
        {'key': PNG_KEY, 'value': base64.b64encode(png_bytes).decode('ascii'), 'base64': True},
    ]
    if META.exists():
        entries.append({'key': META_KEY, 'value': META.read_text(encoding='utf-8')})

    print(f'PNG  {PNG}  ({len(png_bytes)} bytes)  -> {PNG_KEY}')
    if META.exists():
        print(f'META {META}  -> {META_KEY}')
    if dry:
        print('(dry run — not uploading)')
        return 0

    with tempfile.NamedTemporaryFile(mode='w', suffix='-dmgnum.json',
                                     delete=False, encoding='utf-8') as fh:
        json.dump(entries, fh)
        tmp = Path(fh.name)
    try:
        t0 = time.time()
        wrangler_bulk_put(tmp)
        print(f'uploaded in {time.time() - t0:.1f}s')
    finally:
        try: tmp.unlink()
        except OSError: pass
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
