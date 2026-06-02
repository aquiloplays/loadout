"""Phase 2 GATE: premium follow-overlay item-sprite contact sheet.

Generates ONE representative item sprite per game for 6 games spanning the
style range of the full bulk run (fantasy / sci-fi / cozy-sim / horror /
casino-card / minimalist), via Replicate flux-1.1-pro-ultra ($0.06 ea),
cuts the background with rembg ($0.01 ea), and assembles a labelled 3x2
contact sheet at the Loadout repo root so Clay can approve the quality
direction BEFORE the ~$20 bulk regen.

  python -u tools/follow-overlay-contact-sheet.py [--force]

Resumable: raw + cut PNGs cached in TEMP; re-run skips finished samples.
ASCII-only output.
"""
from __future__ import annotations
import base64, io, json, os, sys, time, tempfile, urllib.request, urllib.error
from pathlib import Path
import requests
from PIL import Image, ImageDraw, ImageFont

TOKEN = os.environ.get('REPLICATE_API_TOKEN')
ULTRA = 'https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro-ultra/predictions'
PRED  = 'https://api.replicate.com/v1/predictions'
REMBG_VERSION = 'fb8af171cfa1616ddcf1242c093f9c46bcada5ad4cf6f2fbe8b81b330ec5c003'  # cjwbw/rembg
HERE  = Path(__file__).resolve().parent
LOADOUT_ROOT = HERE.parent.parent                      # ...\Loadout
OUT   = LOADOUT_ROOT / 'follow-overlay-sample-contact-sheet.png'
CACHE = Path(tempfile.gettempdir()) / 'follow-contact-sheet'; CACHE.mkdir(parents=True, exist_ok=True)
FORCE = '--force' in sys.argv
MIN_PNG = 4000

# (slug, game display, item, style hint, casino?) -- 6 across the style range
SAMPLES = [
    ("eldenring", "Elden Ring",
     "a single ornate golden flask filled with glowing crimson liquid, a Flask of Crimson Tears, engraved metal filigree and cork stopper",
     "high-quality painterly cel-shaded dark-fantasy game asset, dramatic rim light", False),
    ("cyberpunk2077", "Cyberpunk 2077",
     "a single glowing neon cyberware implant chip, holographic circuitry etched on it, cyan and magenta neon edge glow",
     "sleek high-tech sci-fi game asset, crisp clean illustration", False),
    ("supermarket_simulator", "Supermarket Simulator",
     "a single clean chrome shopping cart, friendly and tidy, three-quarter view",
     "clean cheerful 2D cartoon game asset, soft even shading, bright", False),
    ("phasmophobia", "Phasmophobia",
     "a single EMF reader handheld ghost-hunting device, worn dark plastic, a row of glowing green LED bars lit on its face",
     "atmospheric muted horror game asset, moody low-key lighting", False),
    ("balatro", "Balatro",
     "a single stylized Joker playing card standing upright, bold poker face art, vivid red and deep blue",
     "vibrant casino card-game asset, bold flat illustration, slight pixel-poker flavour", True),
    ("ball_x_pit", "Ball x Pit",
     "a single glowing neon orb sphere with a soft luminous motion trail",
     "minimalist abstract arcade game asset, clean luminous glow on a plain field", False),
]

PROMPT_TPL = ("{item}, game-asset style matching {game}, {style}. "
              "Single isolated object, centered, full object in frame, generous empty margin. "
              "Isolated on a solid flat magenta background #FF00FF. "
              "Clean professional 2D illustration, premium quality, sharp focus, "
              "no text, no watermark, no logo, no border.")


def _download(url, tries=6):
    last = None
    for i in range(tries):
        try:
            r = requests.get(url, timeout=120)
            if r.ok and r.content:
                return r.content
            last = str(r.status_code)
        except Exception as e:
            last = str(e)[:80]
        time.sleep(2 + i * 2)
    raise RuntimeError(f'download failed: {last}')


def gen(prompt, out_path, casino):
    if out_path.exists() and not FORCE:
        return out_path, False
    body = {'input': {'prompt': prompt, 'aspect_ratio': '1:1',
                      'output_format': 'png',
                      'safety_tolerance': 6 if casino else 5, 'raw': False}}
    while True:
        r = requests.post(ULTRA, json=body, timeout=120,
                          headers={'Authorization': f'Bearer {TOKEN}', 'Prefer': 'wait=50'})
        if r.status_code == 429:
            print('  429 backoff 15s'); time.sleep(15); continue
        if not r.ok:
            raise RuntimeError(f'{r.status_code} {r.text[:160]}')
        p = r.json(); break
    while p.get('status') in ('starting', 'processing'):
        time.sleep(1.3)
        p = requests.get(p['urls']['get'], headers={'Authorization': f'Bearer {TOKEN}'}).json()
    if p.get('status') != 'succeeded':
        raise RuntimeError(f"gen {p.get('status')}: {str(p.get('error'))[:140]}")
    url = p['output'][0] if isinstance(p['output'], list) else p['output']
    out_path.write_bytes(_download(url))
    return out_path, True


def rembg(img: Image.Image) -> Image.Image:
    """RGBA/RGB PIL -> RGBA PIL, background removed by cjwbw/rembg."""
    buf = io.BytesIO(); img.convert('RGBA').save(buf, 'PNG')
    uri = 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()
    body = json.dumps({'version': REMBG_VERSION, 'input': {'image': uri}}).encode()
    last = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(PRED, data=body, headers={
                'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json',
                'Prefer': 'wait=60'})
            p = json.load(urllib.request.urlopen(req, timeout=120))
            while p.get('status') in ('starting', 'processing'):
                time.sleep(2)
                p = json.load(urllib.request.urlopen(urllib.request.Request(
                    p['urls']['get'], headers={'Authorization': f'Bearer {TOKEN}'}), timeout=60))
            if p.get('status') != 'succeeded':
                raise RuntimeError(f"{p.get('status')}: {str(p.get('error'))[:120]}")
            out = p['output']; out = out[0] if isinstance(out, list) else out
            raw = urllib.request.urlopen(out, timeout=120).read()
            if len(raw) < MIN_PNG:
                raise RuntimeError(f'tiny output {len(raw)}B')
            return Image.open(io.BytesIO(raw)).convert('RGBA')
        except (urllib.error.HTTPError, urllib.error.URLError, RuntimeError) as e:
            last = e; print(f'  rembg retry {attempt}: {str(e)[:100]}'); time.sleep(4 + attempt * 4)
    raise RuntimeError(f'rembg failed after retries: {last}')


def trim_to_content(im: Image.Image) -> Image.Image:
    bbox = im.split()[3].getbbox()
    return im.crop(bbox) if bbox else im


def fit(im: Image.Image, box: int) -> Image.Image:
    im = trim_to_content(im)
    w, h = im.size
    s = box / max(w, h)
    return im.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS)


def load_font(size, bold=False):
    for name in (('arialbd.ttf', 'segoeuib.ttf') if bold else ('arial.ttf', 'segoeui.ttf')):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def checker(w, h, c1=(28, 31, 40), c2=(20, 22, 30), sq=16):
    base = Image.new('RGB', (w, h), c1)
    d = ImageDraw.Draw(base)
    for y in range(0, h, sq):
        for x in range(0, w, sq):
            if (x // sq + y // sq) % 2:
                d.rectangle([x, y, x + sq - 1, y + sq - 1], fill=c2)
    return base


def compose(cuts):
    COLS, ROWS = 3, 2
    SPR = 280            # sprite box
    PAD = 22
    LBL = 56             # label band
    CELL_W = SPR + PAD * 2
    CELL_H = SPR + PAD + LBL
    HEAD = 76
    W = COLS * CELL_W
    H = HEAD + ROWS * CELL_H
    sheet = Image.new('RGB', (W, H), (15, 16, 22))
    d = ImageDraw.Draw(sheet)
    # header
    f_title = load_font(30, bold=True)
    f_sub = load_font(15)
    d.text((PAD, 16), "Follow Overlay - Premium Item Sprite Samples", font=f_title, fill=(174, 243, 234))
    d.text((PAD, 52), "flux-1.1-pro-ultra + rembg  |  6 of ~38 games  |  approval gate before bulk regen",
           font=f_sub, fill=(150, 160, 176))
    d.line([(0, HEAD - 1), (W, HEAD - 1)], fill=(43, 212, 212), width=2)
    f_game = load_font(20, bold=True)
    f_item = load_font(13)
    for i, (slug, game, cut) in enumerate(cuts):
        cx = (i % COLS) * CELL_W
        cy = HEAD + (i // COLS) * CELL_H
        # sprite area with transparency checker
        sx, sy = cx + PAD, cy + PAD
        ch = checker(SPR, SPR)
        sheet.paste(ch, (sx, sy))
        spr = fit(cut, SPR - 8)
        ox = sx + (SPR - spr.width) // 2
        oy = sy + (SPR - spr.height) // 2
        sheet.paste(spr, (ox, oy), spr)
        # cell border
        d.rectangle([sx - 1, sy - 1, sx + SPR, sy + SPR], outline=(58, 65, 80), width=1)
        # label
        ly = sy + SPR + 8
        d.text((sx, ly), game, font=f_game, fill=(240, 244, 248))
        d.text((sx, ly + 26), slug, font=f_item, fill=(125, 228, 212))
    sheet.save(OUT)
    return W, H


def main():
    if not TOKEN:
        print('REPLICATE_API_TOKEN missing'); return 2
    spend = 0.0
    cuts = []
    for slug, game, item, style, casino in SAMPLES:
        raw_p = CACHE / f'{slug}_raw.png'
        cut_p = CACHE / f'{slug}_cut.png'
        if cut_p.exists() and not FORCE:
            print(f'{slug}: cut (cache)')
            cuts.append((slug, game, Image.open(cut_p).convert('RGBA')))
            continue
        prompt = PROMPT_TPL.format(item=item, game=game, style=style)
        print(f'{slug}: generating...')
        _, billed = gen(prompt, raw_p, casino)
        if billed:
            spend += 0.06
        print(f'{slug}: rembg...')
        cut = rembg(Image.open(raw_p))
        a = cut.split()[3]; H = a.histogram(); tot = cut.width * cut.height
        subj = tot - H[0]
        spend += 0.01
        print(f'  subj={100*subj/tot:.1f}%  (~${spend:.2f} spent)')
        cut.save(cut_p)
        cuts.append((slug, game, cut))
    print('composing contact sheet...')
    w, h = compose(cuts)
    print(f'\nOK -> {OUT}  ({w}x{h})  total ~${spend:.2f}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
