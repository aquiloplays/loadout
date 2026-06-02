# Hero base-body transparency cleanup (W1, 2026-06-02).
#
# The 60 pixel-art-hero-body:<sex>-<class>-<tone> PNGs shipped by hero
# Phase 1 had a SOLID BLACK background (mode RGB, no alpha) plus a
# magenta/pink flux-fill leak around the silhouette + a dark-maroon
# floor-shadow blob (~(80,0,48)) under the feet.
#
# Fix: add alpha, then edge-seeded flood-fill that treats near-black
# AND magenta/maroon leak as background (the leak ring bridges the
# black bg to the character edge, so one connected fill clears both),
# then a 2-pass erosion of any residual leak pixels touching
# transparency. Interior character outlines are never reached (not
# edge-connected), so they survive.
#
# Usage: python tools/hero-body-transparency-fix.py   (clean + bulk-upload all 60)
# Re-runnable: pulls the current bytes from the worker each time.

import io, os, json, base64, hashlib, subprocess, urllib.request
from collections import deque
from PIL import Image

WORKER = 'loadout-discord.aquiloplays.workers.dev'
KV_NS = 'LOADOUT_BOLTS'
SEXES = ['male', 'female']
CLASSES = ['warrior', 'mage', 'rogue', 'ranger', 'healer']
TONES = ['fair', 'light', 'tan', 'brown', 'dark', 'deepest']


def classify_bg(r, g, b):
    if max(r, g, b) < 50:
        return True                                        # near-black background
    if r > 60 and b > 30 and g + 45 < r and g + 25 < b:
        return True                                        # magenta/pink + floor-shadow leak
    return False


def clean(im):
    im = im.convert('RGBA'); w, h = im.size; px = im.load()
    visited = bytearray(w * h); q = deque()

    def seed(x, y):
        i = y * w + x
        if not visited[i] and classify_bg(*px[x, y][:3]):
            visited[i] = 1; q.append((x, y))

    for x in range(w): seed(x, 0); seed(x, h - 1)
    for y in range(h): seed(0, y); seed(w - 1, y)
    while q:
        x, y = q.popleft(); px[x, y] = (0, 0, 0, 0)
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h:
                i = ny * w + nx
                if not visited[i] and classify_bg(*px[nx, ny][:3]):
                    visited[i] = 1; q.append((nx, ny))
    # Erode residual leak pixels touching transparency (anti-alias halo).
    for _ in range(2):
        kill = []
        for y in range(h):
            for x in range(w):
                if px[x, y][3] == 0:
                    continue
                if classify_bg(*px[x, y][:3]):
                    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        nx, ny = x + dx, y + dy
                        if 0 <= nx < w and 0 <= ny < h and px[nx, ny][3] == 0:
                            kill.append((x, y)); break
        for x, y in kill:
            px[x, y] = (0, 0, 0, 0)
    return im


def fetch(slug):
    url = f'https://{WORKER}/asset/hero-body/{slug}.png?reproc=1'
    req = urllib.request.Request(url, headers={'User-Agent': 'aquilo-heroclean'})
    return urllib.request.urlopen(req, timeout=60).read()


def kv_bulk_put(items, chunk=8):
    for i in range(0, len(items), chunk):
        tmp = f'_herochunk_{i}.json'
        open(tmp, 'w').write(json.dumps(items[i:i + chunk]))
        r = subprocess.run(f'npx wrangler kv bulk put "{tmp}" --binding {KV_NS} --remote',
                           shell=True, capture_output=True, text=True, encoding='utf-8', errors='replace')
        os.remove(tmp)
        ok = 'Success' in (r.stdout or '') or r.returncode == 0
        print(f'  chunk {i // chunk}: rc={r.returncode} {"OK" if ok else "FAIL " + (r.stderr or "")[:200]}')
        if not ok:
            return 1
    return 0


def main():
    keys = [f'{s}-{c}-{t}' for s in SEXES for c in CLASSES for t in TONES]
    raw, hashes = {}, {}
    for k in keys:
        raw[k] = fetch(k); hashes[k] = hashlib.md5(raw[k]).hexdigest()
    uniq = {}
    for k, h in hashes.items():
        uniq.setdefault(h, k)
    print(f'{len(keys)} keys, {len(uniq)} unique source images')

    cleaned = {}
    for h, rep in uniq.items():
        out = clean(Image.open(io.BytesIO(raw[rep])))
        buf = io.BytesIO(); out.save(buf, 'PNG'); cleaned[h] = buf.getvalue()
        print(f'  cleaned {rep} ({h[:8]}) -> {len(cleaned[h])} bytes')

    entries = [{'key': f'pixel-art-hero-body:{k}',
                'value': base64.b64encode(cleaned[hashes[k]]).decode(),
                'base64': True} for k in keys]
    rc = kv_bulk_put(entries)
    print('BULK PUT', 'OK' if rc == 0 else 'FAIL', '-- wrote', len(entries), 'keys')


if __name__ == '__main__':
    main()
