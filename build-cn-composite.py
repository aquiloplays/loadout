"""
Build the #community-night-games composite roster image.

22 game art tiles laid out 5×5 (last row half-full). Uses Steam
header.jpg for Steam-backed games and the Epic Games Store key
art for Fortnite. Outputs the PNG to discord-bot/assets/ and
also base64-encodes it for the admin upload endpoint.

Run: python build-cn-composite.py
"""

import base64
import io
import os
import sys
import urllib.request
from PIL import Image, ImageDraw, ImageFont

ROSTER = [
    ("MIMESIS",                   "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2827200/8a2a6edc97fbf23ea6941974bdf4ed9a6ab34eb4/header.jpg"),
    ("RV There Yet?",             "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3949040/cae24b4ed7f4531be51f0d63f785b7d253f92dc3/header.jpg"),
    ("Lethal Company",            "https://cdn.cloudflare.steamstatic.com/steam/apps/1966720/header.jpg"),
    ("R.E.P.O.",                  "https://cdn.cloudflare.steamstatic.com/steam/apps/3241660/header.jpg"),
    ("Pratfall",                  "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/4244510/aa5134d11626034935daa974478c834d03d73f54/header.jpg"),
    ("PEAK",                      "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3527290/31bac6b2eccf09b368f5e95ce510bae2baf3cfcd/header.jpg"),
    ("Super Battle Golf",         "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/4069520/2d9b9b6bc0ac18c6eb76f5e38b649425d9202759/header_alt_assets_0.jpg"),
    ("Content Warning",           "https://cdn.cloudflare.steamstatic.com/steam/apps/2881650/header.jpg"),
    ("The Headliners",            "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3059070/62f137f87bbbe03ff34fe64f79aec4059532e849/header.jpg"),
    ("Gamble With Your Friends",  "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3892270/395e6d7972474333a698b26f8aa5597bf38109a1/header.jpg"),
    ("LOCKDOWN Protocol",         "https://cdn.cloudflare.steamstatic.com/steam/apps/2780980/header.jpg"),
    ("Dead by Daylight",          "https://cdn.cloudflare.steamstatic.com/steam/apps/381210/header.jpg"),
    ("Fortnite",                  "https://cdn1.epicgames.com/offer/fn/FNBR_40-40_C7S2_Venison_EGS_Launcher_Blade_2560x1440_2560x1440-3afd36811467479f909b5b753522e63d"),
    ("Among Us",                  "https://cdn.cloudflare.steamstatic.com/steam/apps/945360/header.jpg"),
    ("Phasmophobia",              "https://cdn.cloudflare.steamstatic.com/steam/apps/739630/header.jpg"),
    ("Vampire Crawlers",          "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3265700/5590e42cab09dacabee973dd2c3e27ef12ed4950/header.jpg"),
    ("Baby Steps",                "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1281040/8d57ee5f68ecf97305c2f7847b25f1fbe1c680c2/header.jpg"),
    ("Marbles on Stream",         "https://cdn.cloudflare.steamstatic.com/steam/apps/1170970/header.jpg"),
    ("Pummel Party",              "https://cdn.cloudflare.steamstatic.com/steam/apps/880940/header.jpg"),
    ("PUBG: BATTLEGROUNDS",       "https://cdn.cloudflare.steamstatic.com/steam/apps/578080/header.jpg"),
    ("The Outlast Trials",        "https://cdn.cloudflare.steamstatic.com/steam/apps/1304930/header.jpg"),
    ("Species: Unknown",          "https://cdn.cloudflare.steamstatic.com/steam/apps/2747330/header.jpg"),
]

COLS = 5
ROWS = 5            # 22 entries, last row has 2 blanks
CELL_W = 230        # Steam capsule-ish aspect
CELL_H = 108
GAP = 6
BG = (12, 12, 18)   # near-black to read as gaps
VIOLET = (124, 92, 255)

CANVAS_W = COLS * CELL_W + (COLS + 1) * GAP
CANVAS_H = ROWS * CELL_H + (ROWS + 1) * GAP

UA = "Mozilla/5.0 (loadout-cn-composite) curl/8"

def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read()

def load_or_fallback(name, url):
    try:
        raw = fetch(url)
        return Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception as e:
        print(f"  WARN: {name}: {e!s} — drawing fallback", file=sys.stderr)
        img = Image.new("RGB", (CELL_W, CELL_H), BG)
        d = ImageDraw.Draw(img)
        d.rectangle([(2, 2), (CELL_W - 2, CELL_H - 2)], outline=VIOLET, width=2)
        try:
            font = ImageFont.truetype("arial.ttf", 18)
        except Exception:
            font = ImageFont.load_default()
        d.text((CELL_W // 2, CELL_H // 2), name,
               fill=(220, 220, 230), anchor="mm", font=font)
        return img

def fit_cell(img, w, h):
    # Cover-fit so the whole cell is filled (crops overflow rather than
    # letterboxing — keeps the grid tight, no gray bars).
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

def main():
    canvas = Image.new("RGB", (CANVAS_W, CANVAS_H), BG)
    for idx, (name, url) in enumerate(ROSTER):
        print(f"[{idx+1:>2}/{len(ROSTER)}] {name}")
        img = load_or_fallback(name, url)
        cell = fit_cell(img, CELL_W, CELL_H)
        col = idx % COLS
        row = idx // COLS
        x = GAP + col * (CELL_W + GAP)
        y = GAP + row * (CELL_H + GAP)
        canvas.paste(cell, (x, y))

    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "discord-bot", "assets")
    os.makedirs(out_dir, exist_ok=True)
    out_png = os.path.join(out_dir, "cn-roster-composite.png")
    canvas.save(out_png, format="PNG", optimize=True)
    size = os.path.getsize(out_png)
    print(f"\nWrote {out_png} ({size} bytes, {CANVAS_W}x{CANVAS_H})")

    # Emit base64 alongside for easy upload via the admin endpoint.
    out_b64 = os.path.join(out_dir, "cn-roster-composite.b64.txt")
    with open(out_png, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    with open(out_b64, "w") as f:
        f.write(b64)
    print(f"Wrote {out_b64} ({len(b64)} chars)")

if __name__ == "__main__":
    main()
