#!/usr/bin/env python3
"""Cut the GWYF sprite renders out to transparent PNGs.

The Replicate renders (assets/_raw/*.png) put each subject on a busy magenta
backdrop with a gradient + drop shadow, and the subjects themselves are warm
red/pink — so a flat colour-key would eat into them. We instead use rembg's
salient-object matting to lift the subject, then trim to its bounding box so
every sprite fills its pop-up consistently. Finals land in assets/<slug>.png.

If rembg isn't installed we fall back to a magenta chroma-key (lower quality,
but keeps the pipeline runnable).

Usage:  python keyout.py
"""
import sys
from pathlib import Path
import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
RAW = HERE / "assets" / "_raw"
OUT = HERE / "assets"
PAD = 16       # transparent padding kept around the trimmed subject
MAXDIM = 480   # cap the long edge — these are pop-up sprites, not posters


def cut_rembg(im: Image.Image, session) -> Image.Image:
    from rembg import remove
    return remove(
        im, session=session, alpha_matting=True,
        alpha_matting_foreground_threshold=240,
        alpha_matting_background_threshold=12,
        alpha_matting_erode_size=8,
    ).convert("RGBA")


def cut_chroma(im: Image.Image) -> Image.Image:
    """Fallback: magenta chroma key with edge de-fringe."""
    KEY = np.array([255, 0, 255], dtype=np.int16)
    HARD, SOFT = 120, 200
    arr = np.asarray(im.convert("RGBA")).astype(np.int16)
    rgb, alpha = arr[:, :, :3], arr[:, :, 3].astype(np.float32)
    dist = np.sqrt(((rgb - KEY) ** 2).sum(axis=2)).astype(np.float32)
    magenta = (rgb[:, :, 0] > 120) & (rgb[:, :, 2] > 120) & (rgb[:, :, 1] < 130)
    a = alpha.copy()
    a[(dist <= HARD) & magenta] = 0
    ring = (dist > HARD) & (dist <= SOFT) & magenta
    a[ring] = np.clip((dist[ring] - HARD) / (SOFT - HARD), 0, 1) * 255
    out = np.dstack([rgb, a]).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def trim(im: Image.Image, pad: int = PAD) -> Image.Image:
    a = np.asarray(im)[:, :, 3]
    ys, xs = np.where(a > 12)
    if len(xs) == 0:
        return im
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    x0 = max(0, x0 - pad); y0 = max(0, y0 - pad)
    x1 = min(im.width - 1, x1 + pad); y1 = min(im.height - 1, y1 + pad)
    return im.crop((x0, y0, x1 + 1, y1 + 1))


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    raws = sorted(RAW.glob("*.png"))
    if not raws:
        print(f"no raw renders in {RAW}", file=sys.stderr)
        return 1

    session = None
    mode = "chroma"
    try:
        from rembg import new_session
        session = new_session("isnet-general-use")
        mode = "rembg(isnet)"
    except Exception as e:
        print(f"  rembg unavailable ({e}); using chroma fallback", file=sys.stderr)

    print(f"keying {len(raws)} sprites via {mode}")
    for p in raws:
        im = Image.open(p).convert("RGBA")
        cut = cut_rembg(im, session) if session else cut_chroma(im)
        cut = trim(cut)
        if max(cut.size) > MAXDIM:
            s = MAXDIM / max(cut.size)
            cut = cut.resize((round(cut.width * s), round(cut.height * s)), Image.LANCZOS)
        dest = OUT / p.name
        cut.save(dest)
        op = (np.asarray(cut)[:, :, 3] > 0).mean() * 100
        print(f"  {p.name:18s} -> {dest.name}  ({cut.width}x{cut.height}, {op:.0f}% opaque)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
