#!/usr/bin/env python3
"""Gift Jar premium art pipeline.

Generates photoreal EMPTY GLASS jars on pure black via flux-1.1-pro,
then converts luminance to alpha (glass-on-black -> true transparency,
which keeps every subtle reflection rembg would shred). Output PNGs are
cropped, padded and resized for the overlay.

Usage:
  python tools/gift-jar-art-gen.py generate   # call Replicate, save raw candidates
  python tools/gift-jar-art-gen.py convert    # luma->alpha + crop on picked files
"""
import io, json, os, sys, time
import requests
from PIL import Image

TOKEN = os.environ.get("REPLICATE_API_TOKEN", "")
WORK = os.path.join(os.path.dirname(__file__), "..", "_jar_art")
MODEL_URL = "https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro/predictions"

BASE = ("studio product photograph of {subject}, perfectly centered, the entire vessel fully visible "
        "with generous margin on every side, photographed straight on at eye level, on a pure black "
        "background, dramatic rim lighting, crisp glass reflections and bright edge highlights, "
        "photorealistic, sharp focus, no labels, no text, no logos, completely empty, nothing inside, "
        "open top with no lid")

STYLES = {
    "mason":  "a classic vintage glass mason jar with embossed glass texture and a wide open mouth",
    "bowl":   ("a completely empty round glass fishbowl with a wide circular opening at the top, "
               "no water, no fish, no plants, no gravel, nothing inside, pristine clear empty glass, "
               "isolated on a solid pure black studio backdrop"),
    "cookie": ("a large wide-mouth round glass storage canister, open top with no lid, the bare glass "
               "rim clearly visible at the very top, rounded shoulders, completely empty, nothing inside, "
               "pristine clear empty glass, isolated on a solid pure black studio backdrop"),
    "hex":    "a tall hexagonal glass apothecary jar with flat glass facets and an open top",
}

CANDIDATES = 2


def generate(only=None):
    styles = {k: v for k, v in STYLES.items() if (not only or k in only)}
    return _generate(styles)


def _generate(styles):
    os.makedirs(WORK, exist_ok=True)
    headers = {"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"}
    preds = []
    for style, subject in styles.items():
        for i in range(CANDIDATES):
            body = {
                "input": {
                    "prompt": BASE.format(subject=subject),
                    "aspect_ratio": "2:3",
                    "output_format": "png",
                    "output_quality": 100,
                    "safety_tolerance": 6,
                    "prompt_upsampling": False,
                }
            }
            r = requests.post(MODEL_URL, headers=headers, data=json.dumps(body), timeout=60)
            r.raise_for_status()
            p = r.json()
            preds.append((style, i, p["id"], p["urls"]["get"]))
            print("queued", style, i, p["id"], flush=True)

    done = {}
    deadline = time.time() + 600
    while len(done) < len(preds) and time.time() < deadline:
        time.sleep(5)
        for style, i, pid, url in preds:
            if pid in done:
                continue
            g = requests.get(url, headers=headers, timeout=30).json()
            st = g.get("status")
            if st == "succeeded":
                out = g.get("output")
                if isinstance(out, list):
                    out = out[0]
                img = requests.get(out, timeout=120).content
                path = os.path.join(WORK, f"{style}-{i}.png")
                with open(path, "wb") as f:
                    f.write(img)
                done[pid] = path
                print("saved", path, len(img), "bytes", flush=True)
            elif st in ("failed", "canceled"):
                done[pid] = None
                print("FAILED", style, i, g.get("error"), flush=True)
    print("generate complete:", sum(1 for v in done.values() if v), "of", len(preds), flush=True)


def luma_alpha(src, dst, gamma=0.82, alpha_boost=1.18, noise_floor=0.06, max_h=1100):
    im = Image.open(src).convert("RGB")
    px = im.load()
    w, h = im.size
    out = Image.new("RGBA", (w, h))
    po = out.load()
    min_x, min_y, max_x, max_y = w, h, 0, 0
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            a = max(r, g, b) / 255.0
            a = min(1.0, (a ** gamma) * alpha_boost)
            if a <= noise_floor:
                # background haze / soft studio glow: fully transparent
                po[x, y] = (0, 0, 0, 0)
                continue
            ia = int(a * 255)
            po[x, y] = (min(255, int(r / a)), min(255, int(g / a)), min(255, int(b / a)), ia)
            # bbox only counts confident pixels so dim spill can't
            # inflate the crop box
            if a > 0.14:
                if x < min_x: min_x = x
                if x > max_x: max_x = x
                if y < min_y: min_y = y
                if y > max_y: max_y = y
    if max_x > min_x:
        pad = 12
        out = out.crop((max(0, min_x - pad), max(0, min_y - pad), min(w, max_x + pad), min(h, max_y + pad)))
    if out.height > max_h:
        out = out.resize((round(out.width * max_h / out.height), max_h), Image.LANCZOS)
    out.save(dst, optimize=True)
    print("converted", dst, out.size, os.path.getsize(dst), "bytes", flush=True)


def convert():
    picks = json.load(open(os.path.join(WORK, "picks.json"), encoding="utf-8"))
    dest_dir = os.path.join(os.path.dirname(__file__), "..", "aquilo-gg", "overlays", "gift-jar", "jars")
    os.makedirs(dest_dir, exist_ok=True)
    for style, fname in picks.items():
        luma_alpha(os.path.join(WORK, fname), os.path.join(dest_dir, style + ".png"))


if __name__ == "__main__":
    if not TOKEN:
        sys.exit("REPLICATE_API_TOKEN missing")
    cmd = sys.argv[1] if len(sys.argv) > 1 else "generate"
    if cmd == "generate":
        generate(sys.argv[2].split(",") if len(sys.argv) > 2 else None)
    elif cmd == "convert":
        convert()
    else:
        sys.exit("unknown command " + cmd)
