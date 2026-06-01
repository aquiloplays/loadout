"""Single large Clash field landscape (replaces stitched tiles).

Clay: the stitched-tile field looks broken; switch to ONE big image the
site positions + scales behind the canvas. Pro Ultra ~2048x2048, warm
CoC village landscape, no buildings/units (those render on top).

KV: pixel-art-clash:field:landscape  (served /asset/clash-art/field/landscape.png)

Usage: REPLICATE_API_TOKEN=... python tools/gen-clash-landscape.py
"""
from __future__ import annotations
import base64, importlib.util
from pathlib import Path
from PIL import Image

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('cap', HERE / 'clash-art-pipeline.py')
cap = importlib.util.module_from_spec(spec); spec.loader.exec_module(cap)

PROMPT = (
    "Vibrant Clash-of-Clans cartoon village landscape, sunlit warm palette: a "
    "large lush green grass field (#6cc24a) filling most of the scene, sky-blue "
    "rippling WATER around the outer edges, a forest perimeter of cartoon trees "
    "in natural clusters of 3-5 along the border (not uniform), decorative props "
    "scattered organically across the grass (small bushes, colorful flowers, a "
    "few gray-brown rocks, NOT in a grid), a subtle dirt path winding off to one "
    "side (not central), warm 45-degree sunlight casting soft shadows. "
    "Three-quarter top-down isometric game-board view. Glossy polished AAA mobile-"
    "strategy art, chunky cartoon, NO cosmic tones, NO buildings, NO characters, "
    "NO units, NO people, NO text. Just the empty landscape ground."
)

OUT = cap.ART / 'field_landscape.png'
KV  = 'pixel-art-clash:field:landscape'
URL = f'https://{cap.WORKER}/asset/clash-art/field/landscape.png'

def main():
    # Pro Ultra at 1:1 -> ~2048x2048 (single asset, no tiling concerns). Opaque.
    cap.gen(PROMPT, '1:1', OUT)
    sz = OUT.stat().st_size
    dims = Image.open(OUT).size
    if sz < 50_000:
        raise SystemExit(f'landscape too small ({sz}B) — generation failed')
    cap.kv_bulk_put([{'key': KV, 'value': base64.b64encode(OUT.read_bytes()).decode('ascii'), 'base64': True}])
    okv = cap.verify(URL)
    print(f'landscape {dims[0]}x{dims[1]} {sz}B -> {KV} | 200={okv} | {URL}')

if __name__ == '__main__':
    main()
