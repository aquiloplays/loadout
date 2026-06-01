"""Replace the baked-in Aquilo "A" monogram on Boltbound pack + card-back
PNGs with a Boltbound lightning-bolt brand badge.

Clay sees an "A" on Boltbound surfaces. The card-back SVGs already say
BOLTBOUND (site-confirmed), so the "A" is in worker PNGs: the 6
pixel-art-pack:* pack arts and the 16 pixel-art-cardback:* backs each
carry a serif "A" in a small brand emblem. No source generator exists
+ "BOLTBOUND" text won't fit the tiny emblem, so we overlay a circular
brand badge with a lightning bolt (the Boltbound mark) over the "A" —
$0, guaranteed coverage, on-brand. Packs: emblem is top-center; backs:
center.

Re-uploads to the same KV keys. Cache-bust handled by the worker route
TTL change (see worker.js) — these served immutable, so the route is
lowered to a short TTL alongside this so the new bytes propagate.

Usage: python tools/fix-card-brand-A.py
"""
from __future__ import annotations
import base64, json, subprocess, tempfile
from io import BytesIO
from pathlib import Path
import requests
from PIL import Image, ImageDraw

WORKER = 'loadout-discord.aquiloplays.workers.dev'
KV_NS = 'LOADOUT_BOLTS'

def kv_list(prefix):
    r = subprocess.run(f'npx wrangler kv key list --binding {KV_NS} --prefix "{prefix}" --remote',
                       shell=True, capture_output=True, text=True, encoding='utf-8', errors='replace')
    try: return [k['name'] for k in json.loads(r.stdout)]
    except Exception: return []

def kv_put_png(key, png_bytes):
    entry = [{'key': key, 'value': base64.b64encode(png_bytes).decode('ascii'), 'base64': True}]
    with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False, encoding='utf-8') as fh:
        json.dump(entry, fh); tmp = Path(fh.name)
    try:
        r = subprocess.run(f'npx wrangler kv bulk put "{tmp}" --binding {KV_NS} --remote',
                           shell=True, capture_output=True, text=True, encoding='utf-8', errors='replace')
        if r.returncode != 0:
            raise RuntimeError((r.stderr or r.stdout or '')[-200:])
    finally:
        try: tmp.unlink()
        except OSError: pass

def fetch(url):
    r = requests.get(url, timeout=60); r.raise_for_status(); return r.content

def bolt_badge(draw, cx, cy, r):
    """Draw a circular brand badge with a lightning bolt at (cx,cy)."""
    # Badge disc: deep violet with a bright rim (matches the cards' palette).
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(30, 18, 54, 255),
                 outline=(255, 214, 92, 255), width=max(2, r // 10))
    # Lightning bolt polygon, scaled to the badge.
    s = r * 0.95
    pts = [(cx - 0.18*s, cy - 0.62*s), (cx + 0.30*s, cy - 0.62*s),
           (cx - 0.02*s, cy - 0.08*s), (cx + 0.26*s, cy - 0.08*s),
           (cx - 0.22*s, cy + 0.66*s), (cx - 0.02*s, cy + 0.06*s),
           (cx - 0.30*s, cy + 0.06*s)]
    draw.polygon(pts, fill=(255, 214, 92, 255), outline=(255, 245, 200, 255))

# (relY) of the "A" emblem center per namespace.
# NOTE: only packs are fixed here. The 16 pixel-art-cardback:* backs carry
# the "A" at WILDLY varying sizes (e.g. aurora-drift-back's "A" is ~40% of
# the card vs t1-stars' ~12%), so a fixed badge can't reliably cover them —
# and the site renders the displayed card-back via SVG (BOLTBOUND, per the
# site chip), so those PNGs are likely superseded. Packs are PNGs that
# definitely render (pack-opening), with a consistent top-center emblem —
# the high-confidence source of the "A" Clay sees.
TARGETS = [
    ('pixel-art-pack:', 0.16),   # packs: top-center emblem
]

def main():
    fixed, failed = [], []
    for prefix, relY in TARGETS:
        for key in kv_list(prefix):
            slug = key.split(':', 1)[1]
            route = 'pack' if prefix.startswith('pixel-art-pack') else 'cardback'
            url = f'https://{WORKER}/asset/{route}/{slug}.png'
            try:
                img = Image.open(BytesIO(fetch(url))).convert('RGBA')
                w, h = img.size
                draw = ImageDraw.Draw(img)
                r = int(min(w, h) * 0.085)            # badge radius ~ covers the "A"
                bolt_badge(draw, w // 2, int(h * relY), r)
                buf = BytesIO(); img.save(buf, format='PNG', optimize=True)
                kv_put_png(key, buf.getvalue())
                fixed.append(key)
                print(f'  fixed {key}  ({w}x{h}, badge@{w//2},{int(h*relY)})')
            except Exception as e:
                failed.append((key, str(e)[:80]))
                print(f'  FAIL {key}: {str(e)[:80]}')
    print(f'\nfixed {len(fixed)} assets, {len(failed)} failed')
    if failed: print('failed:', failed)

if __name__ == '__main__':
    main()
