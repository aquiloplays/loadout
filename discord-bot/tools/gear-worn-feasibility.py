"""Hero Phase 2 - worn-gear feasibility contact sheet (Clay GO gate).

Reuses the PROVEN Phase 1 recipe (see hero-paperdoll-pipeline.py):
  flux-fill-pro INPAINT a gear piece (neutral steel) into the matching
  body wear-zone on a bald base body -> diff-extract the transparent
  registered overlay -> composite. Masters MUST be inpaints; txt2img
  isolated overlays do NOT register to the body.

Goal: prove gear sits in the right wear position (helm on head, chest on
torso, weapon in hand) BEFORE the ~57-slug bulk run. 3 inpaints ~= $0.15.

Output: gear-worn-feasibility-sheet.png in the repo root + the 3
extracted transparent overlays in C:/tmp/hero-pd-gear/.

Usage:  python -u tools/gear-worn-feasibility.py
ASCII-only output. flux-fill-pro ~$0.05/call.
"""
from __future__ import annotations
import base64, io, os, sys, time
from pathlib import Path
import requests
from PIL import Image, ImageDraw, ImageFilter, ImageChops

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
REPO = ROOT.parent
TOKEN = os.environ.get('REPLICATE_API_TOKEN')
FILL = 'https://api.replicate.com/v1/models/black-forest-labs/flux-fill-pro/predictions'
WORKER = 'loadout-discord.aquiloplays.workers.dev'
ART = Path('C:/tmp/hero-pd-gear'); ART.mkdir(parents=True, exist_ok=True)
BALD = Path('C:/tmp/hero-pd')   # Phase 1 bald masters
MIN_PNG = 4000
PIX = ("16-bit pixel art JRPG game sprite, crisp clean pixels, matching the "
       "existing character art style, consistent lighting from upper-left")

# ── wear-zone masks (relative fractions; body is canonically framed) ──
def _ellipse_mask(W, H, cx, cy, rx, ry, ext_to=None, blur=6):
    m = Image.new('L', (W, H), 0); d = ImageDraw.Draw(m)
    d.ellipse([int((cx-rx)*W), int((cy-ry)*H), int((cx+rx)*W), int((cy+ry)*H)], fill=255)
    if ext_to:
        d.rectangle([int((cx-rx)*W), int(cy*H), int((cx+rx)*W), int(ext_to*H)], fill=255)
    return m.filter(ImageFilter.GaussianBlur(blur))

def head_mask(W, H):   return _ellipse_mask(W, H, 0.500, 0.125, 0.140, 0.120, ext_to=0.20, blur=5)
def chest_mask(W, H):  return _ellipse_mask(W, H, 0.500, 0.285, 0.180, 0.090, ext_to=0.41, blur=6)
def weapon_mask(W, H): return _ellipse_mask(W, H, 0.300, 0.430, 0.120, 0.270, blur=6)

# 3 representative pieces - one per high-risk wear zone. Coherent warrior
# ironclad set on a warrior body. Prompts target NEUTRAL STEEL so the
# rarity tint can be applied as a client-side CSS filter on a rarity-
# agnostic base (per the Phase 2 contract).
PIECES = [
    {'slot': 'head',   'slug': 'iron-helm',      'mask': head_mask,
     'prompt': "a medieval iron helmet worn snugly on the head, polished "
               "neutral steel-gray metal with a nose guard, covering the "
               "scalp and forehead, " + PIX},
    {'slot': 'chest',  'slug': 'chainmail',      'mask': chest_mask,
     'prompt': "a chainmail hauberk worn over the torso and shoulders, "
               "interlocking neutral steel-gray metal rings, fitted to the "
               "chest, " + PIX},
    {'slot': 'weapon', 'slug': 'steel-longsword', 'mask': weapon_mask,
     'prompt': "a steel longsword gripped in the fist, long straight "
               "double-edged neutral steel-gray blade pointing upward, "
               "leather-wrapped hilt with a crossguard, " + PIX},
]

def _poll(p):
    while p.get('status') in ('starting', 'processing'):
        time.sleep(1.5)
        p = requests.get(p['urls']['get'], headers={'Authorization': f'Bearer {TOKEN}'}).json()
    return p

def data_uri(path): return 'data:image/png;base64,' + base64.b64encode(Path(path).read_bytes()).decode('ascii')

def fill(image_uri, mask_img, prompt, out, force=False, steps=50, guidance=30):
    if out.exists() and out.stat().st_size > MIN_PNG and not force:
        return out, False
    buf = io.BytesIO(); mask_img.convert('RGB').save(buf, format='PNG')
    mask_uri = 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode('ascii')
    inp = {'image': image_uri, 'mask': mask_uri, 'prompt': prompt,
           'output_format': 'png', 'safety_tolerance': 2, 'steps': steps, 'guidance': guidance}
    for attempt in range(3):
        try:
            r = requests.post(FILL, json={'input': inp}, timeout=120,
                              headers={'Authorization': f'Bearer {TOKEN}', 'Prefer': 'wait=55'})
            if r.status_code == 429:
                print('  429 backoff'); time.sleep(15); continue
            if not r.ok: raise RuntimeError(f'{r.status_code} {r.text[:120]}')
            p = _poll(r.json())
            if p.get('status') != 'succeeded':
                raise RuntimeError(f"{p.get('status')}: {str(p.get('error'))[:100]}")
            url = p['output'][0] if isinstance(p['output'], list) else p['output']
            out.write_bytes(requests.get(url, timeout=120).content)
            if out.stat().st_size < MIN_PNG: raise RuntimeError(f'small {out.stat().st_size}B')
            return out, True
        except Exception as e:
            print('  retry', str(e)[:100]); time.sleep(4 + attempt*4)
    raise RuntimeError('fill failed after retries')

def extract_overlay(base_img, master_img, mask_img):
    W, H = base_img.size
    master_img = master_img.resize((W, H)); mask_img = mask_img.resize((W, H))
    diff = ImageChops.difference(base_img.convert('RGB'), master_img.convert('RGB')).convert('L')
    alpha = diff.point(lambda v: 255 if v > 28 else (v*9 if v > 8 else 0))
    alpha = ImageChops.multiply(alpha, mask_img.point(lambda v: 255 if v > 30 else 0))
    alpha = alpha.filter(ImageFilter.MedianFilter(5))
    ov = master_img.convert('RGBA'); ov.putalpha(alpha); return ov

def checker(size, c1=(70, 70, 86), c2=(50, 50, 64), n=16):
    img = Image.new('RGB', size, c1); d = ImageDraw.Draw(img)
    s = max(8, size[0]//n)
    for y in range(0, size[1], s):
        for x in range(0, size[0], s):
            if ((x//s) + (y//s)) % 2: d.rectangle([x, y, x+s, y+s], fill=c2)
    return img

def main():
    if not TOKEN: print('no REPLICATE_API_TOKEN'); return 2
    bald_path = BALD / 'bald_male-warrior.png'
    if not bald_path.exists():
        print('fetching bald body from worker')
        b = requests.get(f'https://{WORKER}/asset/hero-body/male-warrior-light.png', timeout=120).content
        bald_path.write_bytes(b)
    base = Image.open(bald_path).convert('RGBA'); W, H = base.size
    print(f'bald base {W}x{H}')

    overlays = []      # (slot, slug, RGBA overlay)
    single_comps = []  # (label, composited-on-base image) for the sheet
    spend = 0.0
    for pc in PIECES:
        mask = pc['mask'](W, H)
        master = ART / f"master_{pc['slot']}_{pc['slug']}.png"
        _, billed = fill(data_uri(bald_path), mask, pc['prompt'], master)
        if billed: spend += 0.05
        print(f"  inpaint {pc['slot']}/{pc['slug']} {'(gen)' if billed else '(cache)'}  ~${spend:.2f}")
        ov = extract_overlay(base, Image.open(master), mask)
        ov.save(ART / f"worn_{pc['slot']}_{pc['slug']}.png")
        overlays.append((pc['slot'], pc['slug'], ov))
        comp = base.copy(); comp.alpha_composite(ov)
        single_comps.append((f"{pc['slot']}: {pc['slug']}", comp))

    # full equip: stack all overlays on one body
    full = base.copy()
    for _, _, ov in overlays: full.alpha_composite(ov)

    # ── build the contact sheet ──
    TW = 256
    def tile(img): return img.resize((TW, int(img.height * TW / img.width)))
    th = tile(base).height
    cols = [('bald base', tile(base))]
    cols += [(lbl, tile(c)) for lbl, c in single_comps]
    cols += [('full equip', tile(full))]
    # overlays-on-checker row
    chk = []
    for slot, slug, ov in overlays:
        t = tile(ov); bg = checker(t.size); bg.paste(t.convert('RGB'), (0, 0), t); chk.append((f"{slot} overlay", bg))

    n = len(cols); HDR = 24
    sheet = Image.new('RGB', (TW * n, (th + HDR) * 2 + 8), (28, 28, 38))
    dd = ImageDraw.Draw(sheet)
    for i, (lbl, t) in enumerate(cols):
        bg = Image.new('RGB', (TW, th), (28, 28, 38)); bg.paste(t.convert('RGB'), (0, 0),
                                                                t.convert('RGBA'))
        sheet.paste(bg, (i*TW, HDR)); dd.text((i*TW+4, 6), lbl, fill=(235, 235, 250))
    y2 = th + HDR + 8
    for i, (lbl, t) in enumerate(chk):
        sheet.paste(t, (i*TW, y2 + HDR)); dd.text((i*TW+4, y2+6), lbl, fill=(235, 235, 250))
    dd.text((4, sheet.height-16), f"Phase 2 worn-gear feasibility - 3 inpaints ~${spend:.2f} - warrior body",
            fill=(170, 170, 190))
    out = REPO / 'gear-worn-feasibility-sheet.png'
    sheet.save(out)
    print(f'\nSHEET -> {out}  spend ~${spend:.2f}')
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
