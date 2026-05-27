"""
One-shot test composite for the check-in v2 embed (variant C).

Fetches a background and a sample GIF, composites the GIF centered
over the background at ~35% canvas width with a soft radial vignette
behind it for legibility, per-frame, and re-exports as an animated
GIF. Saves to discord-bot/assets/ + base64 for upload to the worker's
/admin/checkin-v2/test-post endpoint.

Defaults are tuned for the variant C mockup spec (1200×675 bg,
~35% gif width, soft vignette). Override via CLI args:
  python build-checkin-v2-test.py [bg_url] [gif_url]
"""

import base64
import io
import os
import sys
import urllib.request
from PIL import Image, ImageDraw, ImageFilter, ImageSequence

DEFAULT_BG_URL  = "https://aquilo.gg/sprites/checkin/default-card.png"
DEFAULT_GIF_URL = "https://media.giphy.com/media/3o7TKsQ8gqVrxZTAqI/giphy.gif"  # generic "yes!" celebration

# Variant C target: 1200×675. Discord caps bot file uploads at 10 MB
# (server-boost tiers raise to 25/50, but the loadout-discord bot
# doesn't benefit from those). Composite at half-res (600×337) for
# the test send so the file fits — final production rendering can run
# at full res via the sidecar service since that path uploads bytes
# to a CDN, not Discord's attachment limit.
CANVAS_W = 600
CANVAS_H = 337
GIF_WIDTH_RATIO = 0.35   # variant C spec
# Cap frames to keep file under Discord's 10 MB limit.
MAX_FRAMES = 40
UA = "Mozilla/5.0 (loadout-checkin-v2-test) curl/8"


def fetch_bytes(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read()


def load_background():
    bg_url = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_BG_URL
    try:
        print(f"BG: fetching {bg_url}")
        raw = fetch_bytes(bg_url)
        img = Image.open(io.BytesIO(raw)).convert("RGB")
        print(f"BG: loaded {img.size}")
    except Exception as e:
        print(f"BG: fetch failed ({e!s}) — falling back to a generated Aurora gradient.", file=sys.stderr)
        img = Image.new("RGB", (CANVAS_W, CANVAS_H), (12, 12, 18))
        d = ImageDraw.Draw(img)
        # Vertical Aurora gradient: violet → pink
        for y in range(CANVAS_H):
            t = y / CANVAS_H
            r = int(0x7c * (1 - t) + 0xff * t)
            g = int(0x5c * (1 - t) + 0x6a * t)
            b = int(0xff * (1 - t) + 0xb5 * t)
            d.line([(0, y), (CANVAS_W, y)], fill=(r, g, b))
    # Cover-fit to canvas size.
    img = cover_fit(img, CANVAS_W, CANVAS_H)
    return img


def cover_fit(img, w, h):
    iw, ih = img.size
    target_ratio = w / h
    src_ratio = iw / ih
    if src_ratio > target_ratio:
        new_w = int(ih * target_ratio)
        left = (iw - new_w) // 2
        img = img.crop((left, 0, left + new_w, ih))
    else:
        new_h = int(iw / target_ratio)
        top = (ih - new_h) // 2
        img = img.crop((0, top, iw, top + new_h))
    return img.resize((w, h), Image.LANCZOS)


def build_radial_vignette(canvas_size, gif_size, strength=140):
    """Return an RGBA image the size of the canvas with a soft darkened
    radial vignette centered behind the gif. The vignette is a black
    fill with an alpha mask that's strongest at the gif center and
    fades to fully transparent ~1.4× the gif diagonal away.
    """
    cw, ch = canvas_size
    gw, gh = gif_size
    cx, cy = cw // 2, ch // 2
    # Build a tiny alpha mask centered on (cx, cy), scaled by a
    # gaussian-blurred white ellipse — fast + soft. Final mask is
    # multiplied by strength to clamp peak darkness.
    mask = Image.new("L", canvas_size, 0)
    d = ImageDraw.Draw(mask)
    rx = int(gw * 0.85)
    ry = int(gh * 0.95)
    d.ellipse([(cx - rx, cy - ry), (cx + rx, cy + ry)], fill=strength)
    mask = mask.filter(ImageFilter.GaussianBlur(radius=int(min(gw, gh) * 0.45)))
    overlay = Image.new("RGBA", canvas_size, (0, 0, 0, 0))
    overlay.putalpha(mask)
    # The above replaces overlay alpha but keeps RGB at (0,0,0) — i.e.
    # solid black painted with soft alpha. Exactly the vignette we want.
    return overlay


def composite_frames(bg, gif):
    """Composite each frame of `gif` over `bg` per variant C, return
    a list of RGB frames + a list of per-frame durations in ms."""
    target_gif_w = int(CANVAS_W * GIF_WIDTH_RATIO)
    # First frame: figure out gif aspect for height calc.
    first = gif.copy().convert("RGBA")
    fw, fh = first.size
    aspect = fh / fw
    target_gif_h = int(target_gif_w * aspect)

    vignette = build_radial_vignette((CANVAS_W, CANVAS_H), (target_gif_w, target_gif_h))
    paste_x = (CANVAS_W - target_gif_w) // 2
    paste_y = (CANVAS_H - target_gif_h) // 2

    out_frames = []
    durations = []
    all_frames = list(ImageSequence.Iterator(gif))
    # Subsample frames if over MAX_FRAMES — keeps file size bounded
    # while preserving motion characteristics.
    if len(all_frames) > MAX_FRAMES:
        step = len(all_frames) / MAX_FRAMES
        keep_indices = set(int(i * step) for i in range(MAX_FRAMES))
        all_frames = [f for i, f in enumerate(all_frames) if i in keep_indices]
    for frame in all_frames:
        rgba = frame.convert("RGBA").resize((target_gif_w, target_gif_h), Image.LANCZOS)
        canvas = bg.copy().convert("RGBA")
        canvas.alpha_composite(vignette)
        canvas.alpha_composite(rgba, dest=(paste_x, paste_y))
        out_frames.append(canvas.convert("RGB"))
        # Lengthen durations slightly when we drop frames so playback
        # speed stays roughly the same.
        durations.append(int(frame.info.get("duration", 100) * 1.5))
    return out_frames, durations


def save_animated_gif(frames, durations, out_path):
    if not frames:
        raise RuntimeError("no frames composited")
    # Quantize each frame to a 128-color palette to shrink the file.
    # Pillow's MEDIANCUT palette gives the best perceptual quality for
    # photographic content; ADAPTIVE works better for our bg+gif mix.
    paletted = [f.convert("P", palette=Image.ADAPTIVE, colors=128) for f in frames]
    paletted[0].save(
        out_path,
        save_all=True,
        append_images=paletted[1:],
        loop=0,
        duration=durations,
        disposal=2,
        optimize=True,
    )


def main():
    gif_url = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_GIF_URL
    bg  = load_background()
    print(f"GIF: fetching {gif_url}")
    gif_raw = fetch_bytes(gif_url)
    gif = Image.open(io.BytesIO(gif_raw))
    print(f"GIF: loaded, frames={getattr(gif, 'n_frames', 1)}, size={gif.size}")
    frames, durations = composite_frames(bg, gif)
    print(f"composited {len(frames)} frames, durations sum={sum(durations)}ms")

    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "discord-bot", "assets")
    os.makedirs(out_dir, exist_ok=True)
    out_gif = os.path.join(out_dir, "checkin-v2-test.gif")
    save_animated_gif(frames, durations, out_gif)
    size = os.path.getsize(out_gif)
    print(f"\nWrote {out_gif} ({size} bytes)")

    out_b64 = os.path.join(out_dir, "checkin-v2-test.b64.txt")
    with open(out_gif, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    with open(out_b64, "w") as f:
        f.write(b64)
    print(f"Wrote {out_b64} ({len(b64)} chars)")


if __name__ == "__main__":
    main()
