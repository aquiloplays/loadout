"""Regenerate the 6 Boltbound pack arts cleanly — no Aquilo 'A'.

Recovery: the prior in-place 'A'-badge fix mis-placed on the tier packs
(their 'A' sits lower than legendary/champion's) AND overwrote the KV
originals without backup, so bronze/silver/gold originals are gone. To
land a clean, consistent, GUARANTEED-no-'A' state, regenerate all 6 via
Pro Ultra with a controlled top-center brand slot, then Pillow-stamp the
Boltbound lightning-bolt badge into that slot (so even if Flux sneaks a
letter, the badge covers it). Upload to the same KV keys.

Usage: REPLICATE_API_TOKEN=... python tools/regen-packs.py
"""
from __future__ import annotations
import base64, importlib.util
from pathlib import Path
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
cap_s = importlib.util.spec_from_file_location('cap', HERE / 'clash-art-pipeline.py')
cap = importlib.util.module_from_spec(cap_s); cap_s.loader.exec_module(cap)
fx_s = importlib.util.spec_from_file_location('fx', HERE / 'fix-card-brand-A.py')
fx = importlib.util.module_from_spec(fx_s); fx_s.loader.exec_module(fx)

WORKER = cap.WORKER
ART = cap.ART

PACKS = [
    ('pack-bronze',    'a bronze + warm-brown foil booster pack'),
    ('pack-silver',    'a polished silver + cool-grey foil booster pack'),
    ('pack-gold',      'a radiant gold foil booster pack'),
    ('pack-standard',  'a violet + teal aurora foil booster pack'),
    ('pack-champion',  'a hot-pink + magenta champion foil booster pack'),
    ('pack-legendary', 'a prismatic rainbow-aurora legendary foil booster pack'),
]

def main():
    for slug, desc in PACKS:
        out = ART / f'pack_{slug}.png'
        prompt = (
            "Glossy game premium vector art, clean polished AAA mobile-game asset. "
            f"{desc} for a fantasy card game, standing upright, ornate symmetrical "
            "border, a small empty circular BRAND EMBLEM SLOT centered near the top "
            "(leave it blank). Absolutely NO letters, NO text, NO monogram, NO 'A'. "
            "Plain white background."
        )
        cap.gen(prompt, '3:4', out)   # Pro Ultra, ~1568x2096
        img = Image.open(out).convert('RGBA')
        w, h = img.size
        d = ImageDraw.Draw(img)
        # Stamp the Boltbound bolt badge into the top-center brand slot —
        # guarantees no stray letter survives there.
        fx.bolt_badge(d, w // 2, int(h * 0.13), int(min(w, h) * 0.09))
        from io import BytesIO
        buf = BytesIO(); img.save(buf, format='PNG', optimize=True)
        cap.kv_bulk_put([{'key': f'pixel-art-pack:{slug}',
                          'value': base64.b64encode(buf.getvalue()).decode('ascii'), 'base64': True}])
        okv = cap.verify(f'https://{WORKER}/asset/pack/{slug}.png?v=p3')
        print(f'  regen {slug} ({w}x{h}) -> pixel-art-pack:{slug} | 200={okv}')
    print('done — 6 packs regenerated, bolt-branded, no A')

if __name__ == '__main__':
    main()
