#!/usr/bin/env python3
"""DEADLINE sprite pipeline.

Generates 16-bit pixel-art sprite sheets (animation frames baked into
each texture) via Replicate flux-1.1-pro, keys the solid prompt
background out to a true alpha channel, slices the frames, pixel-snaps
them to native size on a shared palette, and packs uniform horizontal
strips plus an atlas.json the overlay engine plays back directly.

Style is locked to game-quality pixel art, never photoreal. Cutouts
use border-flood chroma keying (pixel edges survive; photo
segmentation models chew them). Full-bleed tiles (street, skyline)
skip keying entirely.

Usage:
  python tools/deadline-art-gen.py probe                # 4 test sheets + contact sheet
  python tools/deadline-art-gen.py generate [a,b,...]   # queue + download raw sheets
  python tools/deadline-art-gen.py process  [a,b,...]   # key/slice/snap/pack + atlas
  python tools/deadline-art-gen.py sheet                # rebuild contact sheet
  python tools/deadline-art-gen.py install              # copy approved strips into the overlay
  python tools/deadline-art-gen.py list                 # asset registry + cost estimate

Money: ~$0.04 per generation (flux-1.1-pro). Full set ~47 sheets, about $2.
"""
import json, math, os, sys, time
from collections import deque

import requests
from PIL import Image, ImageDraw

TOKEN = os.environ.get("REPLICATE_API_TOKEN", "")
ROOT = os.path.join(os.path.dirname(__file__), "..")
WORK = os.path.join(ROOT, "_deadline_art")
RAW = os.path.join(WORK, "raw")
SPRITES = os.path.join(WORK, "sprites")
DEST = os.path.join(ROOT, "aquilo-gg", "overlays", "deadline", "art")
MODEL_URL = "https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro/predictions"

SPRITE_BASE = (
    "16-bit pixel art sprite sheet for a 2D side scrolling video game, {subject}, "
    "exactly {frames} animation frames of the same character drawn in a single horizontal row "
    "with clear empty space between each frame, every frame the identical character in a "
    "different pose of {motion}, each frame contains exactly one character, all frames drawn "
    "at the identical size and scale, the character faces {facing}, full body visible with "
    "feet on the same baseline in every frame, chunky pixels, dark single-pixel outline, "
    "limited color palette, crisp clean retro game style, flat solid bright magenta background "
    "filling the entire image, no floor, no platform, no pedestal, no shadows on the ground, "
    "no text, no labels, no numbers, no grid lines, no border, no watermark"
)
EFFECT_BASE = (
    "16-bit pixel art sprite sheet of a visual effect for a 2D video game, {subject}, "
    "exactly {frames} frames in a single horizontal row with clear empty space between "
    "frames, the effect evolving step by step: {motion}, each frame floating isolated with "
    "nothing else around it, chunky pixels, limited color palette, crisp retro game style, "
    "flat solid bright magenta background filling the entire image, no characters, no "
    "weapons, no objects, no ground, no text, no labels, no grid lines, no watermark"
)
STILL_BASE = (
    "16-bit pixel art sprite for a 2D side scrolling video game, {subject}, a single object "
    "centered with generous margin, chunky pixels, dark single-pixel outline, limited color "
    "palette, crisp clean retro game style, flat solid bright magenta background filling the "
    "entire image, no floor, no shadows, no text, no labels, no watermark"
)
TILE_BASE = (
    "16-bit pixel art {subject}, seamless horizontally tileable 2D side scroller game "
    "background asset, full bleed edge to edge, limited color palette, chunky pixels, crisp "
    "retro game style, no characters, no text, no labels, no watermark"
)


def A(subject, frames=1, h=40, motion="a walking cycle", facing="right",
      fps=8, loop=True, anchor="bottom", kind="sprite", sweep=True):
    return dict(subject=subject, frames=frames, h=h, motion=motion, facing=facing,
                fps=fps, loop=loop, anchor=anchor, kind=kind, sweep=sweep)


def Z(subject, h=40):
    """walk/attack/death trio for one zombie."""
    return {
        "walk": A(subject, 4, h, "a shambling walk cycle", "right", 8, True),
        "attack": A(subject, 3, h, "a lunging bite attack", "right", 6, True),
        "death": A(subject, 5, h, "falling to its knees then collapsing flat on the "
                   "ground", "right", 10, False),
    }

REROLL_OVERRIDES = {
    # brute-attack keeps coming back as a dark cinematic scene; reuse the
    # exact subject that produced the clean brute-walk and a calmer verb
    "brute-attack": dict(motion="raising both fists overhead then smashing them down"),
    "nuke-ring": dict(subject="three plain white circle outlines of increasing size, "
                              "smallest on the left, largest on the right",
                      motion="a ring growing larger left to right"),
}

ZOMBIES = {
    "walker": Z("a rotting green zombie in tattered clothes", 40),
    "runner": Z("a lean feral fast zombie sprinting low", 38),
    "crawler": Z("a legless zombie dragging itself by its arms along the ground", 24),
    "spitter": Z("a bloated purple zombie with an inflated toxic throat sac", 44),
    "armored": Z("a zombie in dented riot armor and a cracked helmet", 44),
    "exploder": Z("a swollen orange boil-covered zombie about to burst", 42),
    "brute": Z("a huge hulking muscular zombie brute with massive arms", 64),
    "abomination": Z("a towering grotesque mutant zombie abomination boss with exposed bone", 96),
}

ASSETS = {}
for zname, anims in ZOMBIES.items():
    for aname, spec in anims.items():
        ASSETS[f"{zname}-{aname}"] = spec

ASSETS.update({
    "soldier-idle": A("a survivor in a beanie and tactical vest holding a pistol",
                      2, 44, "an alert idle stance, slight breathing", "left", 4, True),
    "soldier-fire": A("a survivor in a beanie and tactical vest firing a pistol",
                      2, 44, "shooting with recoil", "left", 12, True),
    "engineer-work": A("a video game engineer character in a yellow hard hat and tool "
                       "belt holding a big wrench", 3, 44,
                       "swinging the wrench overhead", "left", 8, True),
    "gunner-fire": A("a mercenary in a cap and body armor firing a submachine gun",
                     2, 44, "shooting with recoil and muzzle flash", "left", 12, True),
    "guns-row": A("seven different firearms side by side: pistol, submachine gun, combat "
                  "shotgun, scoped sniper rifle, flamethrower with fuel tank, six barrel "
                  "minigun, rocket launcher",
                  7, 16, "seven separate weapons", "left", 0, False, "center"),
    "explosion-small": A("a fiery orange explosion blast", 6, 64,
                         "an explosion expanding from a small burst to a smoke puff",
                         "right", 14, False, "center", "fx"),
    "explosion-large": A("a huge billowing fiery orange explosion", 6, 96,
                         "an explosion growing from ignition to a large fireball to a "
                         "smoke cloud", "right", 14, False, "center", "fx"),
    "fire-patch": A("a low wide patch of burning flames", 4, 28,
                    "flames flickering in a loop", "right", 10, True, "bottom", "fx"),
    "muzzle-flash": A("a tiny bright yellow and orange muzzle flash burst shape, just the "
                      "flash with no gun", 3, 16,
                      "a star shaped flash appearing then fading", "right", 18, False,
                      "center", "fx"),
    "blood-puff": A("a small dark red splatter burst", 3, 24,
                    "a splatter bursting and dissipating", "right", 14, False, "center",
                    "fx"),
    "trap-snap": A("a steel bear trap", 2, 20,
                   "first frame open and armed, second frame snapped shut", "right",
                   12, False),
    "goo-glob": A("a glob of green acid slime", 2, 16,
                  "a glob flying then splattering", "right", 10, False, "center", "fx"),
    "nuke-ring": A("a white hot circular shockwave ring", 3, 96,
                   "one centered concentric ring growing larger and fading, the ring "
                   "perfectly centered in every frame", "right", 12, False,
                   "center", "fx"),
    "barricade-states": A("a wooden plank barricade wall", 3, 80,
                          "three damage states: pristine, cracked with holes, nearly "
                          "destroyed and splintered", "right", 0, False),
    "sentry-fire": A("one single large automated sentry gun turret on a tripod, exactly "
                     "one object per frame", 2, 48, "idle then firing", "left", 10, True),
    "wire": A("a coil of rusty barbed wire", 1, 24, "", "right", 0, False),
    "mine": A("a small round landmine half buried", 1, 14, "", "right", 0, False),
    "sandbags": A("a stacked sandbag wall", 1, 32, "", "right", 0, False),
    "base-wall": A("a fortified scrap metal and plank wall with a watch platform",
                   1, 120, "", "left", 0, False),
    "flag-wave": A("a tattered flag on a pole", 4, 48, "the flag waving in the wind",
                   "right", 6, True),
    "street-tile": A("ruined city street asphalt with cracks and debris, side view ground "
                     "strip", 1, 36, "", "right", 0, False, "bottom", "tile"),
    "skyline-tile": A("a dark ruined city skyline silhouette at dusk", 1, 200, "", "right",
                      0, False, "bottom", "tile"),
    "ruins-mid": A("burned out cars and rubble piles street furniture silhouettes", 1, 80,
                   "", "right", 0, False, "bottom", "tile"),
})

for _a in ("walk", "attack", "death"):
    # the spitter IS purple; the shadow hue sweep would eat its body
    ASSETS[f"spitter-{_a}"]["sweep"] = False

for _n, _o in REROLL_OVERRIDES.items():
    ASSETS[_n].update(_o)

PROBE = ["walker-walk", "soldier-fire", "explosion-small", "street-tile"]


STANDING = ("walker", "runner", "spitter", "armored", "exploder", "brute",
            "abomination", "soldier", "engineer", "gunner")


def strip_ground_line(frames, band=0.12, cover=0.5):
    """Thin drawn baselines under standing characters: clear bottom-band
    rows whose opaque pixels span half the frame width or more (a
    walker's feet rows stay well under that)."""
    out = []
    for f in frames:
        f = f.copy()
        px = f.load()
        w, h = f.size
        for y in range(int(h * (1 - band)), h):
            n = sum(1 for x in range(w) if px[x, y][3])
            if n >= cover * w:
                for x in range(w):
                    px[x, y] = (0, 0, 0, 0)
        out.append(f.crop(f.getbbox()) if f.getbbox() else f)
    return out


def sweep_feet(frames, band=0.30):
    """Generations tint ground shadows with the magenta background
    (dark violet smears at the feet). Clear saturated magenta/violet
    pixels in the bottom band of each content-cropped frame."""
    out = []
    for f in frames:
        f = f.copy()
        px = f.load()
        w, h = f.size
        for y in range(int(h * (1 - band)), h):
            for x in range(w):
                r, g, b, a = px[x, y]
                if a and r > 25 and b > 55 and g < 0.6 * min(r, b):
                    px[x, y] = (0, 0, 0, 0)
        out.append(f.crop(f.getbbox()) if f.getbbox() else f)
    return out


def aspect_for(spec):
    """flux-1.1-pro rejects 21:9; very wide sheets go through custom
    width/height instead (256-1440, multiples of 32)."""
    if spec["kind"] == "tile":
        if spec["h"] <= 60:
            return {"aspect_ratio": "custom", "width": 1440, "height": 448}
        return {"aspect_ratio": "16:9"}
    f = spec["frames"]
    if f <= 1:
        return {"aspect_ratio": "1:1"}
    if f <= 4:
        return {"aspect_ratio": "16:9"}
    return {"aspect_ratio": "custom", "width": 1440, "height": 576}


def prompt_for(spec):
    if spec["kind"] == "tile":
        return TILE_BASE.format(subject=spec["subject"])
    if spec["kind"] == "fx":
        return EFFECT_BASE.format(subject=spec["subject"], frames=spec["frames"],
                                  motion=spec["motion"])
    if spec["frames"] <= 1:
        return STILL_BASE.format(subject=spec["subject"])
    return SPRITE_BASE.format(subject=spec["subject"], frames=spec["frames"],
                              motion=spec["motion"], facing=spec["facing"])


def generate(names):
    os.makedirs(RAW, exist_ok=True)
    headers = {"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"}
    preds = []
    for name in names:
        spec = ASSETS[name]
        inp = {
            "prompt": prompt_for(spec),
            "output_format": "png",
            "output_quality": 100,
            "safety_tolerance": 6,
            "prompt_upsampling": False,
        }
        inp.update(aspect_for(spec))
        r = requests.post(MODEL_URL, headers=headers, data=json.dumps({"input": inp}),
                          timeout=60)
        if r.status_code >= 400:
            print("API error", r.status_code, name, r.text[:500], flush=True)
        r.raise_for_status()
        p = r.json()
        preds.append((name, p["id"], p["urls"]["get"]))
        print("queued", name, p["id"], flush=True)

    done = {}
    deadline = time.time() + 900
    while len(done) < len(preds) and time.time() < deadline:
        time.sleep(5)
        for name, pid, url in preds:
            if pid in done:
                continue
            g = requests.get(url, headers=headers, timeout=30).json()
            st = g.get("status")
            if st == "succeeded":
                out = g.get("output")
                if isinstance(out, list):
                    out = out[0]
                img = requests.get(out, timeout=120).content
                path = os.path.join(RAW, name + ".png")
                with open(path, "wb") as f:
                    f.write(img)
                done[pid] = path
                print("saved", path, len(img), "bytes", flush=True)
            elif st in ("failed", "canceled"):
                done[pid] = None
                print("FAILED", name, g.get("error"), flush=True)
    ok = sum(1 for v in done.values() if v)
    print(f"generate complete: {ok} of {len(preds)}", flush=True)


def key_chroma(im, tol=72):
    """Flood the background away from the border. Interior pixels that
    happen to be near the bg color survive (they are not connected to
    the border), which is why this beats a global chroma distance."""
    im = im.convert("RGB")
    w, h = im.size
    px = im.load()
    corners = [px[2, 2], px[w - 3, 2], px[2, h - 3], px[w - 3, h - 3]]
    bg = tuple(sorted(c)[len(c) // 2] for c in zip(*corners))
    t2 = tol * tol

    def is_bg(p):
        dr, dg, db = p[0] - bg[0], p[1] - bg[1], p[2] - bg[2]
        return dr * dr + dg * dg + db * db <= t2

    mask = bytearray(w * h)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if not mask[y * w + x] and is_bg(px[x, y]):
                mask[y * w + x] = 1
                q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if not mask[y * w + x] and is_bg(px[x, y]):
                mask[y * w + x] = 1
                q.append((x, y))
    while q:
        x, y = q.popleft()
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nx < w and 0 <= ny < h and not mask[ny * w + nx] and is_bg(px[nx, ny]):
                mask[ny * w + nx] = 1
                q.append((nx, ny))

    out = im.convert("RGBA")
    po = out.load()
    t2_sweep = int((tol * 0.85) ** 2)
    for y in range(h):
        row = y * w
        for x in range(w):
            if mask[row + x]:
                po[x, y] = (0, 0, 0, 0)
                continue
            p = po[x, y]
            dr, dg, db = p[0] - bg[0], p[1] - bg[1], p[2] - bg[2]
            if dr * dr + dg * dg + db * db <= t2_sweep:
                # enclosed bg pockets + chroma dust the flood can't reach
                po[x, y] = (0, 0, 0, 0)
                continue

    opaque = sum(1 for y in range(h) for x in range(0, w, 2) if po[x, y][3])
    if opaque > 0.5 * h * (w // 2):
        # Border flood failed (the bg came out as an enclosed panel the
        # border never touches). Clear the dominant remaining color
        # globally; sprite bodies are never half the canvas.
        from collections import Counter
        buckets = Counter()
        for y in range(0, h, 2):
            for x in range(0, w, 2):
                p = po[x, y]
                if p[3]:
                    buckets[(p[0] // 24, p[1] // 24, p[2] // 24)] += 1
        (mr, mg, mb), _n = buckets.most_common(1)[0]
        mode = (mr * 24 + 12, mg * 24 + 12, mb * 24 + 12)
        if max(mode) < 140 or max(mode) - min(mode) < 60:
            # dominant color is dark/desaturated, i.e. sprite shading or
            # a scene, not a chroma panel; clearing it would gut the art
            print("  panel rescue SKIPPED (mode", mode, "not chroma), needs reroll")
            mode = None
        t2_mode = int((tol * 1.2) ** 2) if mode else 0
        if mode:
            for y in range(h):
                for x in range(w):
                    p = po[x, y]
                    if not p[3]:
                        continue
                    dr, dg, db = p[0] - mode[0], p[1] - mode[1], p[2] - mode[2]
                    if dr * dr + dg * dg + db * db <= t2_mode:
                        po[x, y] = (0, 0, 0, 0)
            print("  panel rescue: cleared dominant color", mode)

    # Drawn floors: a row whose opaque pixels run continuously across
    # most of the sheet is a ground strip, not character pixels. Scan
    # up from the bottom fifth and clear those rows.
    floor_rows, misses = 0, 0
    for y in range(h - 1, int(h * 0.8), -1):
        run = best = 0
        for x in range(w):
            run = run + 1 if po[x, y][3] else 0
            if run > best:
                best = run
        if best >= 0.85 * w:
            for x in range(w):
                po[x, y] = (0, 0, 0, 0)
            floor_rows += 1
            misses = 0
        else:
            misses += 1
            if misses > 2 and floor_rows:
                break
    if floor_rows:
        print(f"  ground band removed ({floor_rows} rows)")

    for _ in range(2):
        # despeckle: drop opaque pixels with at most one opaque neighbor
        kill = []
        for y in range(h):
            for x in range(w):
                if po[x, y][3] == 0:
                    continue
                n = 0
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        if dx == dy == 0:
                            continue
                        nx, ny = x + dx, y + dy
                        if 0 <= nx < w and 0 <= ny < h and po[nx, ny][3] > 0:
                            n += 1
                if n <= 1:
                    kill.append((x, y))
        if not kill:
            break
        for x, y in kill:
            po[x, y] = (0, 0, 0, 0)
    return out


def slice_frames(rgba, want):
    """Split a horizontal sheet on fully transparent column gaps; fall
    back to an even grid when detection disagrees with the request."""
    w, h = rgba.size
    alpha = rgba.split()[3]
    cols = [False] * w
    ap = alpha.load()
    for x in range(w):
        for y in range(h):
            if ap[x, y] > 8:
                cols[x] = True
                break
    segs, start = [], None
    for x in range(w):
        if cols[x] and start is None:
            start = x
        elif not cols[x] and start is not None:
            segs.append((start, x))
            start = None
    if start is not None:
        segs.append((start, w))
    segs = [s for s in segs if s[1] - s[0] >= 6]
    merged = []
    for s in segs:
        if merged and s[0] - merged[-1][1] < 5:
            merged[-1] = (merged[-1][0], s[1])
        else:
            merged.append(s)
    segs = merged

    def area(seg):
        box = rgba.crop((seg[0], 0, seg[1], h)).getbbox()
        if not box:
            return 0
        return (box[2] - box[0]) * (box[3] - box[1])

    if segs:
        amax = max(area(s) for s in segs)
        segs = [s for s in segs if area(s) >= amax * 0.10]

    # Trust what the model actually drew: flux frequently produces more
    # (or fewer) frames than requested, and forcing the requested count
    # through an even grid slices characters in half. Only fall back to
    # the grid when no gaps were found at all.
    if len(segs) >= 2:
        if len(segs) != want:
            print(f"  using {len(segs)} detected frames (asked for {want})")
        segs = segs[:10]
    else:
        cw = w // want
        segs = [(i * cw, (i + 1) * cw) for i in range(want)]
        print(f"  even-grid fallback (no clean gaps, wanted {want})")
    frames = []
    for x0, x1 in segs:
        f = rgba.crop((x0, 0, x1, h))
        bbox = f.getbbox()
        frames.append(f.crop(bbox) if bbox else f)
    return frames


def snap_pack(frames, spec):
    """Anchor frames in a uniform cell, NN-downscale to native height,
    quantize all frames on one shared palette, return the strip."""
    if spec["anchor"] == "bottom" and spec["loop"] and len(frames) > 1:
        # Looping ground anims (walk, attack, idle) should hold a steady
        # silhouette height; generations sometimes mix scales across the
        # row, so rescale every frame to the median content height.
        med = sorted(f.height for f in frames)[len(frames) // 2]
        frames = [f if f.height == med else
                  f.resize((max(1, round(f.width * med / f.height)), med),
                           Image.NEAREST)
                  for f in frames]
    cw = max(f.width for f in frames)
    ch = max(f.height for f in frames)
    cells = []
    for f in frames:
        cell = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
        x = (cw - f.width) // 2
        y = (ch - f.height) if spec["anchor"] == "bottom" else (ch - f.height) // 2
        cell.paste(f, (x, y))
        cells.append(cell)
    scale = spec["h"] / ch
    nw, nh = max(1, round(cw * scale)), spec["h"]
    cells = [c.resize((nw, nh), Image.NEAREST) for c in cells]

    strip = Image.new("RGBA", (nw * len(cells), nh), (0, 0, 0, 0))
    for i, c in enumerate(cells):
        strip.paste(c, (i * nw, 0))
    alpha = strip.split()[3].point(lambda a: 255 if a >= 128 else 0)
    rgb = Image.new("RGB", strip.size, (255, 0, 255))
    rgb.paste(strip, mask=alpha)
    rgb = rgb.quantize(colors=32, method=Image.MEDIANCUT).convert("RGB")
    out = rgb.convert("RGBA")
    out.putalpha(alpha)
    return out, nw, nh


def process(names):
    os.makedirs(SPRITES, exist_ok=True)
    atlas_path = os.path.join(SPRITES, "atlas.json")
    atlas = {}
    if os.path.exists(atlas_path):
        atlas = json.load(open(atlas_path, encoding="utf-8"))
    for name in names:
        raw_path = os.path.join(RAW, name + ".png")
        if not os.path.exists(raw_path):
            print("skip (no raw)", name)
            continue
        spec = ASSETS[name]
        im = Image.open(raw_path)
        print("processing", name, im.size, flush=True)
        if spec["kind"] == "tile":
            scale = spec["h"] / im.height
            out = im.convert("RGBA").resize(
                (max(1, round(im.width * scale)), spec["h"]), Image.NEAREST)
            fw, fh, frames = out.width, out.height, 1
        else:
            rgba = key_chroma(im)
            cut = slice_frames(rgba, spec["frames"])
            if spec.get("sweep", True):
                cut = sweep_feet(cut)
            if name.startswith(STANDING) and "death" not in name:
                cut = strip_ground_line(cut)
            out, fw, fh = snap_pack(cut, spec)
            frames = len(cut)
        dst = os.path.join(SPRITES, name + ".png")
        out.save(dst, optimize=True)
        atlas[name] = {"file": name + ".png", "frames": frames, "fw": fw, "fh": fh,
                       "fps": spec["fps"], "loop": spec["loop"], "anchor": spec["anchor"],
                       "kind": spec["kind"]}
        print("  packed", dst, f"{frames}x{fw}x{fh}", flush=True)
    json.dump(atlas, open(atlas_path, "w", encoding="utf-8"), indent=2)
    print("atlas written:", atlas_path, flush=True)


def contact_sheet():
    atlas_path = os.path.join(SPRITES, "atlas.json")
    if not os.path.exists(atlas_path):
        sys.exit("no atlas.json yet, run process first")
    atlas = json.load(open(atlas_path, encoding="utf-8"))
    pad, label_h, zoom = 10, 14, 2
    rows = []
    for name in sorted(atlas):
        meta = atlas[name]
        im = Image.open(os.path.join(SPRITES, meta["file"]))
        rows.append((name, im, meta))
    width = max(r[1].width * zoom for r in rows) + pad * 2
    height = sum(r[1].height * zoom + label_h + pad for r in rows) + pad
    sheet = Image.new("RGB", (width, height), (34, 34, 38))
    d = ImageDraw.Draw(sheet)
    for cy in range(0, height, 16):
        for cx in range(0, width, 16):
            if (cx // 16 + cy // 16) % 2 == 0:
                d.rectangle((cx, cy, cx + 15, cy + 15), fill=(44, 44, 50))
    y = pad
    for name, im, meta in rows:
        d.text((pad, y), f"{name}  {meta['frames']}f {meta['fw']}x{meta['fh']} "
                         f"{meta['fps']}fps", fill=(230, 230, 235))
        y += label_h
        big = im.resize((im.width * zoom, im.height * zoom), Image.NEAREST)
        sheet.paste(big, (pad, y), big)
        y += big.height + pad
    out = os.path.join(WORK, "contact-sheet.png")
    sheet.save(out)
    print("contact sheet:", out, sheet.size, flush=True)


def install():
    os.makedirs(DEST, exist_ok=True)
    atlas_path = os.path.join(SPRITES, "atlas.json")
    atlas = json.load(open(atlas_path, encoding="utf-8"))
    import shutil
    for meta in atlas.values():
        shutil.copy2(os.path.join(SPRITES, meta["file"]), os.path.join(DEST, meta["file"]))
    shutil.copy2(atlas_path, os.path.join(DEST, "atlas.json"))
    print("installed", len(atlas), "strips ->", DEST, flush=True)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "list"
    pick = sys.argv[2].split(",") if len(sys.argv) > 2 else None
    if cmd == "list":
        for n, s in ASSETS.items():
            print(f"{n:24s} {s['frames']}f h{s['h']} {s['kind']}")
        print(f"\n{len(ASSETS)} generations, ~${len(ASSETS) * 0.04:.2f} at flux-1.1-pro")
        sys.exit(0)
    if not TOKEN:
        sys.exit("REPLICATE_API_TOKEN missing")
    if cmd == "probe":
        generate(PROBE)
        process(PROBE)
        contact_sheet()
    elif cmd == "generate":
        generate(pick or list(ASSETS))
    elif cmd == "process":
        process(pick or list(ASSETS))
    elif cmd == "sheet":
        contact_sheet()
    elif cmd == "install":
        install()
    else:
        sys.exit("unknown command " + cmd)
