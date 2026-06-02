"""Sample-audit live asset alpha quality across categories (2026-06-02).

Fetches a handful of live PNGs per category from the worker and reports
flood-fill damage symptoms so we know which categories to re-clean with
rembg (tools/rembg-pipeline.py). Read-only — touches nothing.

Symptoms scored per image:
  mode        - is it RGBA at all
  bg_clear    - are the 4 corners transparent (alpha < 16)
  black_bleed - opaque near-black pixels (flood-fill missed bg, or ate
                outline leaving black fringe)
  pink_bleed  - opaque magenta/maroon flux-leak pixels still present
  holes       - transparent pixels strictly interior to the alpha bbox
                (flood-fill ate INTO the subject) as % of bbox area
  hard_edge   - fraction of perimeter alpha that is pure 0/255 (no AA);
                high => hard-cut, low => clean antialiased matte

Usage: python -u tools/asset-alpha-audit.py
ASCII-only.
"""
import io, urllib.request
from PIL import Image

WORKER = 'loadout-discord.aquiloplays.workers.dev'

SAMPLES = {
    'hero-body': [f'/asset/hero-body/{s}.png' for s in
        ('male-warrior-light', 'female-mage-dark', 'male-healer-fair',
         'female-rogue-tan', 'male-ranger-deepest', 'female-warrior-brown')],
    'hero-hair': [f'/asset/hero-hair/{s}.png' for s in
        ('male-short-brown', 'female-long-blonde', 'male-mohawk-red',
         'female-bun-black', 'male-curly-aquilo-violet')],
    'hero-facial': [f'/asset/hero-facial/{s}.png' for s in
        ('full-brown', 'goatee-black', 'mustache-gray')],
    'hero-eyes': [f'/asset/hero-eyes/{s}.png' for s in
        ('round-blue', 'narrow-amber', 'soft-violet')],
    'gear-worn': [f'/asset/gear-art/{s}.png' for s in
        ('boots/cloth/male-worn', 'chest/plate/male-worn', 'head/robe/male-worn',
         'chest/leather/female-worn', 'boots/mail/female-worn')],
    'clash-buildings': [f'/asset/clash-art/buildings/{s}.png' for s in
        ('townhall/5', 'wall/2', 'townhall/10')],
    'clash-sheets': [f'/asset/clash-art/sheet/{s}.png' for s in
        ('scrapper', 'boltKnight', 'voltaicMage')],
    'vault': [f'/asset/vault/{s}.png' for s in
        ('room-diner', 'terrain', 'door', 'room-reactor-lab', 'room-medical-bay')],
}


def is_black(r, g, b):
    return max(r, g, b) < 40

def is_pink(r, g, b):
    return r > 60 and b > 30 and g + 45 < r and g + 25 < b


def audit(im):
    im = im.convert('RGBA'); w, h = im.size; px = im.load()
    has_alpha = im.getextrema()[3][0] < 250         # any non-opaque pixel
    corners = [px[0, 0], px[w-1, 0], px[0, h-1], px[w-1, h-1]]
    bg_clear = all(c[3] < 16 for c in corners)
    black = pink = opaque = 0
    # alpha bbox (subject extent)
    xs0, ys0, xs1, ys1 = w, h, 0, 0
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            r, g, b, a = px[x, y]
            if a > 24:
                opaque += 1
                if x < xs0: xs0 = x
                if x > xs1: xs1 = x
                if y < ys0: ys0 = y
                if y > ys1: ys1 = y
                if a > 200 and is_black(r, g, b): black += 1
                if a > 120 and is_pink(r, g, b): pink += 1
    # interior holes: transparent pixels well inside the alpha bbox
    holes = bbox_area = 0
    if xs1 > xs0 and ys1 > ys0:
        mx = (xs1 - xs0) // 8 or 1; my = (ys1 - ys0) // 8 or 1
        for y in range(ys0 + my, ys1 - my, 2):
            for x in range(xs0 + mx, xs1 - mx, 2):
                bbox_area += 1
                if px[x, y][3] < 24:
                    holes += 1
    hole_pct = (100.0 * holes / bbox_area) if bbox_area else 0.0
    # edge AA: sample alpha just outside->inside the bbox perimeter
    edge_vals = []
    if xs1 > xs0 and ys1 > ys0:
        for x in range(xs0, xs1, 2):
            for y in (ys0, ys1):
                edge_vals.append(px[x, y][3])
        for y in range(ys0, ys1, 2):
            for x in (xs0, xs1):
                edge_vals.append(px[x, y][3])
    hard = sum(1 for a in edge_vals if a == 0 or a == 255)
    hard_edge = (100.0 * hard / len(edge_vals)) if edge_vals else 100.0
    return dict(size=(w, h), rgba=im.mode == 'RGBA', has_alpha=has_alpha,
                bg_clear=bg_clear, black=black, pink=pink, opaque=opaque,
                hole_pct=hole_pct, hard_edge=hard_edge)


def fetch(path):
    url = f'https://{WORKER}{path}?audit=1'
    req = urllib.request.Request(url, headers={'User-Agent': 'aquilo-audit'})
    return urllib.request.urlopen(req, timeout=60).read()


def verdict(rows):
    """A category is BROKEN if a meaningful share of samples show
    no-alpha, residual bg bleed, or interior holes."""
    n = len(rows)
    if not n:
        return 'NO-DATA'
    no_alpha = sum(1 for r in rows if not r['has_alpha'] or not r['bg_clear'])
    bleed = sum(1 for r in rows if r['black'] > 20 or r['pink'] > 5)
    holey = sum(1 for r in rows if r['hole_pct'] > 4.0)
    if no_alpha >= max(1, n // 3) or bleed >= max(1, n // 3) or holey >= max(1, n // 3):
        return 'BROKEN'
    if no_alpha or bleed or holey:
        return 'SUSPECT'
    return 'CLEAN'


def main():
    print(f'{"category":<16}{"sample":<42}{"alpha":>6}{"bgclr":>6}{"blk":>6}{"pink":>6}{"hole%":>7}{"hard%":>7}')
    print('-' * 95)
    summary = {}
    for cat, paths in SAMPLES.items():
        rows = []
        for p in paths:
            try:
                im = Image.open(io.BytesIO(fetch(p)))
                r = audit(im); rows.append(r)
                name = p.split('/asset/')[1]
                print(f'{cat:<16}{name:<42}{("Y" if r["has_alpha"] else "n"):>6}'
                      f'{("Y" if r["bg_clear"] else "n"):>6}{r["black"]:>6}{r["pink"]:>6}'
                      f'{r["hole_pct"]:>7.1f}{r["hard_edge"]:>7.0f}')
            except Exception as e:
                print(f'{cat:<16}{p:<42}  ERR {str(e)[:40]}')
        summary[cat] = verdict(rows)
    print('\n=== VERDICT ===')
    for cat, v in summary.items():
        print(f'  {cat:<18} {v}')
    broken = [c for c, v in summary.items() if v in ('BROKEN', 'SUSPECT')]
    print('\nNEEDS REMBG:', broken or 'none')


if __name__ == '__main__':
    main()
