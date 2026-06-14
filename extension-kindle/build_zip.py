"""Zip the loadable extension into dist/aquilo-kindle-extension.zip.

  python build_zip.py

Includes only the files Chrome/Edge needs to load unpacked; excludes the gen
+ build scripts, README, and caches.
"""
import os
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(ROOT, "dist")
OUT = os.path.join(OUT_DIR, "aquilo-kindle-extension.zip")

INCLUDE = ["manifest.json", "background.js", "content.js", "popup.html", "popup.js"]
INCLUDE_DIRS = ["icons"]


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    if os.path.exists(OUT):
        os.remove(OUT)
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        for name in INCLUDE:
            p = os.path.join(ROOT, name)
            if os.path.exists(p):
                z.write(p, name)
        for d in INCLUDE_DIRS:
            dp = os.path.join(ROOT, d)
            for fn in sorted(os.listdir(dp)):
                if fn.endswith(".png"):
                    z.write(os.path.join(dp, fn), f"{d}/{fn}")
    print("wrote", OUT, os.path.getsize(OUT), "bytes")


if __name__ == "__main__":
    main()
