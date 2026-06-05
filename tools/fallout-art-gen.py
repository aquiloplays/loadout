"""Batch Flux 1.1 Pro Ultra generator for the Fallout stream assets.

  python tools/fallout-art-gen.py <manifest.json> <out_dir>

manifest.json: [{ "name": "t-51", "prompt": "...", "aspect_ratio": "3:4" }, ...]
Each item -> <out_dir>/<name>.png. Skips files that already exist (so a rerun
only fills gaps, and the spend never doubles). ~0.06 USD per new image.
"""
import json
import os
import sys
import time
from pathlib import Path

import requests

TOKEN = os.environ.get("REPLICATE_API_TOKEN")
URL = "https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro-ultra/predictions"


def gen(prompt, aspect_ratio):
    body = {"input": {"prompt": prompt, "aspect_ratio": aspect_ratio,
                      "output_format": "png", "safety_tolerance": 6, "raw": False}}
    while True:
        r = requests.post(URL, json=body, timeout=120,
                          headers={"Authorization": f"Bearer {TOKEN}", "Prefer": "wait=50"})
        if r.status_code == 429:
            time.sleep(15); continue
        if not r.ok:
            raise RuntimeError(f"{r.status_code} {r.text[:300]}")
        p = r.json(); break
    while p.get("status") in ("starting", "processing"):
        time.sleep(1.3)
        p = requests.get(p["urls"]["get"], headers={"Authorization": f"Bearer {TOKEN}"}).json()
    if p.get("status") != "succeeded":
        raise RuntimeError(f"gen failed: {p.get('status')} {p.get('error')}")
    out = p["output"]
    u = out[0] if isinstance(out, list) else out
    return requests.get(u, timeout=120).content


def main():
    if not TOKEN:
        print("REPLICATE_API_TOKEN not set", file=sys.stderr); return 2
    manifest = json.load(open(sys.argv[1], encoding="utf-8"))
    out_dir = Path(sys.argv[2]); out_dir.mkdir(parents=True, exist_ok=True)
    made = 0
    for item in manifest:
        dest = out_dir / (item["name"] + ".png")
        if dest.exists():
            print("skip (exists)", dest.name); continue
        ar = item.get("aspect_ratio", "1:1")
        try:
            dest.write_bytes(gen(item["prompt"], ar))
            made += 1
            print("wrote", dest.name)
        except Exception as e:  # keep going; a rerun retries the gaps
            print("FAIL", dest.name, str(e)[:160], file=sys.stderr)
    print(f"done. {made} new image(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
