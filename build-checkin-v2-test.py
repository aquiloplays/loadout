"""
One-shot test composite for the check-in v2 embed (variant C).

Composite pipeline:
  1. Load the background — either:
       (a) fetched animated GIF (the aquilo-site session is
           pre-rendering the firefly-effect bg as a 1200×675 looping
           GIF; URL passes in as CLI arg or via the bg list endpoint
           once that lands), OR
       (b) the local violet+fireflies PLACEHOLDER (single-frame for
           backwards compat; multi-frame if FIREFLY_PLACEHOLDER_FRAMES
           > 1 so the placeholder also animates).
  2. Load the user's chosen GIF.
  3. Composite frame-by-frame: each output frame pairs the next bg
     frame (looped to match) with the next user-gif frame (also
     looped), centered with a soft radial vignette behind the user's
     gif for legibility. Output frame count = MAX_FRAMES, output
     duration = LCM-ish of source loops, capped at MAX_DURATION_MS.

Save targets:
  discord-bot/assets/checkin-v2-test.gif      (the composite)
  discord-bot/assets/checkin-v2-test.b64.txt  (base64 for upload)

CLI:
  python build-checkin-v2-test.py [bg_url_or_path] [gif_url]
  Sentinels for bg_url:
    __firefly_placeholder__   → generated violet+fireflies stand-in
"""

import base64
import io
import math
import os
import random
import sys
import urllib.request
from PIL import Image, ImageDraw, ImageFilter, ImageSequence

DEFAULT_GIF_URL = "https://media.giphy.com/media/3o7TKsQ8gqVrxZTAqI/giphy.gif"

# Variant C target: 1200×675. Discord caps bot file uploads at 10 MB
# for non-boosted servers; composite at half-res for the test send.
# The production sidecar renderer will run at full 1200×675 because
# its output uploads to a CDN, not Discord's attachment limit.
CANVAS_W = 600
CANVAS_H = 337
# Bumped 0.35 → 0.55 on Clay's iteration — make the GIF the focal
# point. Still centered, still has a vignette behind it.
GIF_WIDTH_RATIO = 0.55
# Discord's 10 MB cap forces a tight frame budget.
MAX_FRAMES = 40
# Multi-frame firefly placeholder so even without the real asset
# the composite shows motion. 12 frames × ~80ms ≈ 1s loop.
FIREFLY_PLACEHOLDER_FRAMES = 12
FIREFLY_PLACEHOLDER_FRAME_MS = 80

FIREFLY_PLACEHOLDER = "__firefly_placeholder__"
UA = "Mozilla/5.0 (loadout-checkin-v2-test) curl/8"
# Site-side check-in background API (live as of 2026-05-28 — site
# session shipped 8 presets + a per-user picker, all backgrounds are
# static PNGs at 1200×675).
SITE_USER_BG_URL = "https://aquilo.gg/api/web/checkin/user-background?userId={uid}"
SITE_BG_LIST_URL = "https://aquilo.gg/api/web/checkin/backgrounds"

# Default discord ID to look up if arg1 is "__user__" without a value.
# Clay's ID — bg preview defaults to whatever HE'S picked on the site.
DEFAULT_LOOKUP_USER = "1107161695262085210"

# Holds the accent / theme metadata when we resolved the bg via the
# site API. Surfaced in main() so the test-post endpoint can pass
# the accent through as the embed color (matches what the user sees
# on the home Daily Check-in card).
RESOLVED_BG_META = {}


# ── Fetching ─────────────────────────────────────────────────────────

def fetch_bytes(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read()


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


# ── Background loaders ───────────────────────────────────────────────
#
# Both paths return (frames: list[RGB Image], durations_ms: list[int])
# of the same length. Single-frame backgrounds return lists of length 1.

def load_background():
    """CLI arg 1:
      - omitted → look up DEFAULT_LOOKUP_USER's pick on the site API
      - bare Discord ID (digits-only)  → look up THAT user's pick
      - "__firefly_placeholder__"      → local generated stand-in
      - anything else (URL/path)       → fetched directly
    Falls back to the firefly placeholder on any fetch error so a
    network blip doesn't abort the test pipeline.
    """
    arg1 = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_LOOKUP_USER

    bg_url = None
    if arg1 == FIREFLY_PLACEHOLDER:
        print("BG: generating violet+fireflies placeholder "
              f"({FIREFLY_PLACEHOLDER_FRAMES} frames)")
        return build_firefly_placeholder()
    if arg1.isdigit():
        # Site API lookup. Returns {ok, userId, backgroundId, background:
        # { id, name, theme, effect, gradient, accent, url }}.
        lookup_url = SITE_USER_BG_URL.format(uid=arg1)
        try:
            print(f"BG: looking up site pick for user {arg1}")
            import json as _json
            raw = fetch_bytes(lookup_url)
            data = _json.loads(raw.decode("utf-8"))
            bg = data.get("background") or {}
            bg_url = bg.get("url")
            RESOLVED_BG_META.update({
                "backgroundId": data.get("backgroundId"),
                "name":         bg.get("name"),
                "theme":        bg.get("theme"),
                "effect":       bg.get("effect"),
                "accent":       bg.get("accent"),
            })
            print(f"BG: site says user picked '{data.get('backgroundId')}' "
                  f"→ {bg_url}  (effect={bg.get('effect')}, accent={bg.get('accent')})")
        except Exception as e:
            print(f"BG: API lookup failed ({e!s}) — falling back to placeholder.",
                  file=sys.stderr)
            return build_firefly_placeholder()
    else:
        bg_url = arg1

    if not bg_url:
        print("BG: no URL resolved — falling back to placeholder.", file=sys.stderr)
        return build_firefly_placeholder()

    try:
        print(f"BG: fetching {bg_url}")
        raw = fetch_bytes(bg_url)
        img = Image.open(io.BytesIO(raw))
        frames = []
        durations = []
        for frame in ImageSequence.Iterator(img):
            frames.append(cover_fit(frame.convert("RGB"), CANVAS_W, CANVAS_H))
            durations.append(frame.info.get("duration", 100))
        print(f"BG: loaded {len(frames)} frame(s), size={img.size}")
        return frames, durations
    except Exception as e:
        print(f"BG: fetch failed ({e!s}) — falling back to placeholder.",
              file=sys.stderr)
        return build_firefly_placeholder()


def build_firefly_placeholder():
    """Violet/purple gradient matching the home Daily Check-in card
    + warm golden firefly dots. Animated: each firefly's brightness
    pulses + position drifts slightly across FIREFLY_PLACEHOLDER_FRAMES.
    Stand-in until the aquilo-site session pushes the real
    pre-rendered firefly-effect bg gif.
    """
    rng = random.Random(7)   # fixed seed → reruns are deterministic

    # Pre-roll firefly positions + per-firefly phase offset so each
    # blinks on its own cycle.
    n_small  = 90
    n_glowy  = 16
    small_dots = [
        (rng.randint(0, CANVAS_W - 1),
         rng.randint(0, CANVAS_H - 1),
         rng.randint(0, 1),
         rng.randint(80, 160),
         rng.random())            # phase offset 0..1
        for _ in range(n_small)
    ]
    glowy = [
        (rng.randint(40, CANVAS_W - 40),
         rng.randint(40, CANVAS_H - 40),
         rng.random(),             # phase offset
         rng.uniform(0.7, 1.3))    # per-firefly brightness scale
        for _ in range(n_glowy)
    ]

    # Pre-render the gradient once (it's the same every frame).
    base = Image.new("RGB", (CANVAS_W, CANVAS_H), 0)
    d_base = ImageDraw.Draw(base)
    # Reference screenshot palette:
    #   top:    deep dark violet  ~#2a1845
    #   middle: violet            ~#553388
    #   bottom: blue-purple       ~#3a2a6a
    for y in range(CANVAS_H):
        t = y / CANVAS_H
        # Two-stop gradient: top→middle→bottom
        if t < 0.5:
            u = t / 0.5
            r = int(0x2a * (1 - u) + 0x55 * u)
            g = int(0x18 * (1 - u) + 0x33 * u)
            b = int(0x45 * (1 - u) + 0x88 * u)
        else:
            u = (t - 0.5) / 0.5
            r = int(0x55 * (1 - u) + 0x3a * u)
            g = int(0x33 * (1 - u) + 0x2a * u)
            b = int(0x88 * (1 - u) + 0x6a * u)
        d_base.line([(0, y), (CANVAS_W, y)], fill=(r, g, b))

    frames = []
    durations = []
    for fi in range(FIREFLY_PLACEHOLDER_FRAMES):
        t = fi / FIREFLY_PLACEHOLDER_FRAMES   # 0..1 around the loop
        img = base.copy()
        d = ImageDraw.Draw(img)
        # Distant small dots — sinusoidal twinkle.
        for (x, y, radius, base_b, phase) in small_dots:
            cycle = (t + phase) % 1.0
            # 0.5..1.0 brightness envelope
            mult = 0.6 + 0.4 * (0.5 + 0.5 * math.sin(2 * math.pi * cycle))
            br = max(20, min(255, int(base_b * mult)))
            d.ellipse([(x - radius, y - radius), (x + radius, y + radius)],
                      fill=(br, br, max(40, br - 50)))
        # Bigger glowy fireflies on an RGBA layer with halo + drift.
        halo_layer = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
        hd = ImageDraw.Draw(halo_layer)
        for (x0, y0, phase, scale) in glowy:
            cycle = (t + phase) % 1.0
            # Subtle drift: small lissajous loop ±10px.
            dx = int(10 * math.sin(2 * math.pi * cycle))
            dy = int(6  * math.cos(2 * math.pi * cycle * 1.3))
            x, y = x0 + dx, y0 + dy
            # Brightness envelope: 0.55..1.0 of the per-firefly scale
            mult = (0.55 + 0.45 * (0.5 + 0.5 * math.sin(2 * math.pi * cycle))) * scale
            mult = min(1.4, mult)
            glow_alpha = int(110 * mult)
            core_alpha = int(255 * min(1.0, mult))
            glow_color = (255, 230, 130, glow_alpha)
            core_color = (255, 250, 200, core_alpha)
            hd.ellipse([(x - 16, y - 16), (x + 16, y + 16)], fill=glow_color)
            hd.ellipse([(x - 2,  y - 2),  (x + 2,  y + 2)],  fill=core_color)
        halo_layer = halo_layer.filter(ImageFilter.GaussianBlur(radius=5))
        img = Image.alpha_composite(img.convert("RGBA"), halo_layer).convert("RGB")
        frames.append(img)
        durations.append(FIREFLY_PLACEHOLDER_FRAME_MS)
    return frames, durations


# ── Vignette + compositing ───────────────────────────────────────────

def build_radial_vignette(canvas_size, gif_size, strength=130):
    cw, ch = canvas_size
    gw, gh = gif_size
    cx, cy = cw // 2, ch // 2
    mask = Image.new("L", canvas_size, 0)
    d = ImageDraw.Draw(mask)
    rx = int(gw * 0.85)
    ry = int(gh * 0.95)
    d.ellipse([(cx - rx, cy - ry), (cx + rx, cy + ry)], fill=strength)
    mask = mask.filter(ImageFilter.GaussianBlur(radius=int(min(gw, gh) * 0.45)))
    overlay = Image.new("RGBA", canvas_size, (0, 0, 0, 0))
    overlay.putalpha(mask)
    return overlay


def composite_frames(bg_frames, bg_durations, gif):
    """Frame-iterate both sources, looping the shorter to match.
    Output runs MAX_FRAMES frames, durations averaged from the user
    gif's source timing so motion playback feels right."""
    target_gif_w = int(CANVAS_W * GIF_WIDTH_RATIO)
    first = gif.copy().convert("RGBA")
    fw, fh = first.size
    aspect = fh / fw
    target_gif_h = int(target_gif_w * aspect)

    vignette = build_radial_vignette((CANVAS_W, CANVAS_H),
                                     (target_gif_w, target_gif_h))
    paste_x = (CANVAS_W - target_gif_w) // 2
    paste_y = (CANVAS_H - target_gif_h) // 2

    gif_frames = list(ImageSequence.Iterator(gif))
    # Subsample the user gif if over MAX_FRAMES so we stay under file
    # cap; bg gets looped, so its frame count doesn't blow file size.
    if len(gif_frames) > MAX_FRAMES:
        step = len(gif_frames) / MAX_FRAMES
        keep = set(int(i * step) for i in range(MAX_FRAMES))
        gif_frames = [f for i, f in enumerate(gif_frames) if i in keep]
    # Each output frame keeps the user gif's pace; the bg cycles
    # at its own clock derived from bg_durations so the firefly
    # motion looks natural even when output frame count != bg count.
    bg_cumulative = []
    total_bg_ms = 0
    for d_ms in bg_durations:
        bg_cumulative.append(total_bg_ms)
        total_bg_ms += max(1, d_ms)
    if total_bg_ms == 0:
        total_bg_ms = max(1, len(bg_frames) * 100)

    out_frames = []
    out_durations = []
    cursor_ms = 0
    for gi, gif_frame in enumerate(gif_frames):
        # Snap the bg cursor — pick the bg frame whose start-time is
        # nearest cursor_ms modulo the bg loop length.
        snap = cursor_ms % total_bg_ms
        bg_idx = 0
        for i, start in enumerate(bg_cumulative):
            if start <= snap:
                bg_idx = i
            else:
                break
        bg_frame = bg_frames[bg_idx % len(bg_frames)]

        user_rgba = gif_frame.convert("RGBA").resize(
            (target_gif_w, target_gif_h), Image.LANCZOS)
        canvas = bg_frame.copy().convert("RGBA")
        canvas.alpha_composite(vignette)
        canvas.alpha_composite(user_rgba, dest=(paste_x, paste_y))
        out_frames.append(canvas.convert("RGB"))

        # Speed up the user gif's per-frame duration a bit so the
        # composite stays inside MAX_DURATION_MS and the bg has room
        # to cycle visibly.
        per_frame_ms = int(gif_frame.info.get("duration", 100) * 1.5)
        out_durations.append(per_frame_ms)
        cursor_ms += per_frame_ms

    return out_frames, out_durations


def save_animated_gif(frames, durations, out_path):
    if not frames:
        raise RuntimeError("no frames composited")
    paletted = [f.convert("P", palette=Image.ADAPTIVE, colors=128)
                for f in frames]
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
    bg_frames, bg_durations = load_background()
    print(f"GIF: fetching {gif_url}")
    gif_raw = fetch_bytes(gif_url)
    gif = Image.open(io.BytesIO(gif_raw))
    print(f"GIF: loaded, frames={getattr(gif, 'n_frames', 1)}, size={gif.size}")

    frames, durations = composite_frames(bg_frames, bg_durations, gif)
    print(f"composited {len(frames)} frames, total ~{sum(durations)}ms")

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

    # Surface the resolved bg metadata so the caller (or whoever's
    # tailing the test runner) can paste it into the worker admin
    # /admin/checkin-v2/test-post body for `accentColor`.
    if RESOLVED_BG_META:
        out_meta = os.path.join(out_dir, "checkin-v2-test.meta.json")
        import json as _json
        with open(out_meta, "w") as f:
            _json.dump(RESOLVED_BG_META, f, indent=2)
        print(f"Wrote {out_meta}")
        if RESOLVED_BG_META.get("accent"):
            print("  site accent: " + str(RESOLVED_BG_META['accent']) +
                  " (pass this as accentColor in the test-post body)")


if __name__ == "__main__":
    main()
