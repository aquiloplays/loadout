"""Hero paper-doll Phase 1 — atomic per-sex overlay bulk (Clay GO 2026-06-01).

Proven recipe (see hero-paper-doll-feasibility-sheet.png + _hero_hair_validate):
  flux-fill-pro inpaint a NEUTRAL-GRAY feature onto a bald/base body ->
  diff-extract the transparent registered overlay -> PIL recolor per color.
Masters MUST be inpaints (txt2img isolated overlays do NOT register).

Stages (resumable; state in discord-bot/hero-paperdoll-state.json):
  bald        gen 10 bald base bodies (mask hair, prompt bald scalp)
  hairmasters gen 15 hair-style masters on a bald representative per sex
  hairbuild   extract + recolor (12) every hair style + per-style 5-class QA sheet
  eyesfacial  gen 4 eye + 3 facial masters, extract + recolor, QA sheet
  upload      atomic per-sex/per-layer KV bulk put  (--sex male|female  --layer hair|body|eyes|facial)

Usage:  python -u tools/hero-paperdoll-pipeline.py --stage bald [--force]
ASCII-only output. flux-fill-pro ~$0.05/call.
"""
from __future__ import annotations
import base64, json, os, subprocess, sys, tempfile, time, io
from pathlib import Path
import requests
from PIL import Image, ImageDraw, ImageFilter, ImageChops

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent                      # discord-bot/
REPO = ROOT.parent                      # Loadout/
TOKEN = os.environ.get('REPLICATE_API_TOKEN')
FILL = 'https://api.replicate.com/v1/models/black-forest-labs/flux-fill-pro/predictions'
WORKER = 'loadout-discord.aquiloplays.workers.dev'
KV_NS = 'LOADOUT_BOLTS'
ART = Path('C:/tmp/hero-pd'); ART.mkdir(parents=True, exist_ok=True)
STATE = ROOT / 'hero-paperdoll-state.json'
COST = 0.05
MIN_PNG = 4000

SEXES = ['male', 'female']
CLASSES = ['warrior', 'mage', 'rogue', 'ranger', 'healer']
TONES = ['fair', 'light', 'tan', 'brown', 'dark', 'deepest']
REP = {'male': 'male-healer', 'female': 'female-warrior'}   # 2048 native canonical master canvases

HAIR_STYLES = {
    'male':   ['short', 'buzz', 'long', 'ponytail', 'mohawk', 'curly', 'wavy'],   # 'bald' = no sprite
    'female': ['long', 'short', 'ponytail', 'braided', 'twin', 'bun', 'curly', 'wavy'],
}
HAIR_DESC = {
    'short': 'short neat hair', 'buzz': 'a very short buzz-cut', 'long': 'long flowing hair to the shoulders',
    'ponytail': 'hair tied back in a ponytail', 'mohawk': 'a tall spiked mohawk',
    'curly': 'curly voluminous hair', 'wavy': 'wavy medium-length hair',
    'braided': 'a long single braid', 'twin': 'two braided pigtails', 'bun': 'hair tied up in a bun',
}
HAIR_COLORS = {'blonde': (240, 213, 124), 'brown': (107, 70, 38), 'black': (26, 24, 32),
               'red': (168, 51, 42), 'gray': (154, 163, 179), 'white': (236, 237, 242),
               'aquilo-violet': (124, 92, 255), 'aurora-pink': (255, 92, 184),
               'aurora-green': (91, 255, 149), 'cyan': (92, 240, 255),
               'amber': (255, 177, 74), 'magenta': (214, 92, 255)}
EYE_STYLES = {'round': 'large round eyes', 'narrow': 'narrow almond eyes',
              'sharp': 'sharp angular eyes', 'soft': 'soft gentle eyes'}
EYE_COLORS = {'brown': (107, 70, 38), 'blue': (74, 138, 255), 'green': (95, 179, 90),
              'amber': (209, 138, 58), 'violet': (169, 143, 255), 'gray': (154, 163, 179)}
FACIAL_STYLES = {'mustache': 'a neat mustache', 'goatee': 'a goatee beard', 'full': 'a full thick beard'}

# ── relative mask zones (fraction of WxH; bodies are canonically framed) ──
def _ellipse_mask(W, H, cx, cy, rx, ry, ext_to=None, blur=6):
    m = Image.new('L', (W, H), 0); d = ImageDraw.Draw(m)
    d.ellipse([int((cx-rx)*W), int((cy-ry)*H), int((cx+rx)*W), int((cy+ry)*H)], fill=255)
    if ext_to:
        d.rectangle([int((cx-rx)*W), int(cy*H), int((cx+rx)*W), int(ext_to*H)], fill=255)
    return m.filter(ImageFilter.GaussianBlur(blur))
def hair_mask(W, H, long=False):  return _ellipse_mask(W, H, 0.505, 0.150, 0.165, 0.135, ext_to=0.34 if long else None)
def bald_mask(W, H):              return _ellipse_mask(W, H, 0.505, 0.140, 0.170, 0.130, ext_to=0.22)
def eye_mask(W, H):               return _ellipse_mask(W, H, 0.505, 0.140, 0.080, 0.035, blur=3)
def facial_mask(W, H):            return _ellipse_mask(W, H, 0.505, 0.185, 0.090, 0.055, blur=4)

PIX = "16-bit pixel art JRPG character game sprite, crisp clean pixels, matching the existing art style"

# ── state ──
def load_state():
    if STATE.exists():
        try: return json.loads(STATE.read_text())
        except Exception: pass
    return {'done': [], 'spend': 0.0, 'qa_pass': {}, 'dropped': []}
def save_state(s): STATE.write_text(json.dumps(s, indent=1))

# ── flux-fill ──
def _poll(p):
    while p.get('status') in ('starting', 'processing'):
        time.sleep(1.5); p = requests.get(p['urls']['get'], headers={'Authorization': f'Bearer {TOKEN}'}).json()
    return p
def fill(image_uri, mask_img, prompt, out, st, steps=50, guidance=30, force=False):
    if out.exists() and not force: return out, False
    buf = io.BytesIO(); mask_img.convert('RGB').save(buf, format='PNG')
    mask_uri = 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode('ascii')
    inp = {'image': image_uri, 'mask': mask_uri, 'prompt': prompt,
           'output_format': 'png', 'safety_tolerance': 2, 'steps': steps, 'guidance': guidance}
    for attempt in range(3):
        try:
            r = requests.post(FILL, json={'input': inp}, timeout=120,
                              headers={'Authorization': f'Bearer {TOKEN}', 'Prefer': 'wait=55'})
            if r.status_code == 429: print('  429 backoff'); time.sleep(15); continue
            if not r.ok: raise RuntimeError(f'{r.status_code} {r.text[:120]}')
            p = _poll(r.json())
            if p.get('status') != 'succeeded': raise RuntimeError(f"{p.get('status')}: {str(p.get('error'))[:100]}")
            url = p['output'][0] if isinstance(p['output'], list) else p['output']
            out.write_bytes(requests.get(url, timeout=120).content)
            if out.stat().st_size < MIN_PNG: raise RuntimeError(f'small {out.stat().st_size}B')
            st['spend'] = round(st['spend'] + COST, 4)
            return out, True
        except Exception as e:
            print('  retry', str(e)[:100]); time.sleep(4 + attempt*4)
    raise RuntimeError('fill failed after retries')

def body_url(slug_tone): return f'https://{WORKER}/asset/hero-body/{slug_tone}.png'
def data_uri(path): return 'data:image/png;base64,' + base64.b64encode(Path(path).read_bytes()).decode('ascii')

# ── extraction + recolor ──
def extract_overlay(base_img, master_img, mask_img):
    W, H = base_img.size
    master_img = master_img.resize((W, H)); mask_img = mask_img.resize((W, H))
    diff = ImageChops.difference(base_img.convert('RGB'), master_img.convert('RGB')).convert('L')
    alpha = diff.point(lambda v: 255 if v > 28 else (v*9 if v > 8 else 0))
    alpha = ImageChops.multiply(alpha, mask_img.point(lambda v: 255 if v > 30 else 0))
    alpha = alpha.filter(ImageFilter.MedianFilter(5))
    ov = master_img.convert('RGBA'); ov.putalpha(alpha); return ov
def recolor(overlay, rgb):
    r, g, b, a = overlay.split()
    lum = Image.merge('RGB', (r, g, b)).convert('L').point(lambda v: 55 + int(v*0.78))
    col = Image.merge('RGB', [lum.point(lambda v, c=c: int(v*c/255)) for c in rgb])
    out = col.convert('RGBA'); out.putalpha(a); return out

# ── stages ──
def stage_bald(st, force):
    for s in SEXES:
        for c in CLASSES:
            slug = f'{s}-{c}'; out = ART / f'bald_{slug}.png'
            _, billed = fill(body_url(f'{slug}-light'), bald_mask(*Image.open(io.BytesIO(requests.get(body_url(f'{slug}-light'), timeout=120).content)).size),
                             f"completely bald bare smooth scalp, no hair at all, clean forehead, {PIX}, "
                             f"keep the same skin tone and head shape", out, st, force=force)
            print(f'  bald {slug} {"(gen)" if billed else "(cache)"}  ${st["spend"]:.2f}')
            save_state(st)
    print('bald done')

def stage_hairmasters(st, force):
    for s in SEXES:
        bald = ART / f'bald_{REP[s]}.png'
        if not bald.exists(): print('  MISSING bald rep', REP[s]); continue
        W, H = Image.open(bald).size
        for style in HAIR_STYLES[s]:
            out = ART / f'hairmaster_{s}_{style}.png'
            longish = style in ('long', 'ponytail', 'braided', 'twin', 'curly', 'wavy', 'bun')
            _, billed = fill(data_uri(bald), hair_mask(W, H, long=longish),
                             f"{HAIR_DESC[style]}, neutral light ash-gray color, natural hairline framing the face, {PIX}",
                             out, st, force=force)
            print(f'  hairmaster {s}-{style} {"(gen)" if billed else "(cache)"}  ${st["spend"]:.2f}')
            save_state(st)
    print('hairmasters done')

def stage_hairbuild(st):
    """Extract + recolor each style + build a 5-class QA sheet (brown variant)."""
    qa_dir = ART / 'qa'; qa_dir.mkdir(exist_ok=True)
    for s in SEXES:
        bald_rep = Image.open(ART / f'bald_{REP[s]}.png').convert('RGBA')
        for style in HAIR_STYLES[s]:
            mp = ART / f'hairmaster_{s}_{style}.png'
            if not mp.exists(): print('  missing master', s, style); continue
            longish = style in ('long', 'ponytail', 'braided', 'twin', 'curly', 'wavy', 'bun')
            ov = extract_overlay(bald_rep, Image.open(mp), hair_mask(*bald_rep.size, long=longish))
            for cname, rgb in HAIR_COLORS.items():
                recolor(ov, rgb).save(ART / f'hair_{s}_{style}_{cname}.png')
            # QA: composite brown over all 5 class bald bodies
            tiles = []
            brown = recolor(ov, HAIR_COLORS['brown'])
            for c in CLASSES:
                bb = Image.open(ART / f'bald_{s}-{c}.png').convert('RGBA')
                comp = bb.copy(); comp.alpha_composite(brown.resize(bb.size))
                tiles.append((c, comp))
            TW = 240; th = [t.resize((TW, int(t.height*TW/t.width))) for _, t in tiles]
            sheet = Image.new('RGB', (TW*5, max(x.height for x in th)+22), (40, 40, 52))
            dd = ImageDraw.Draw(sheet)
            for i, ((c, _), t) in enumerate(zip(tiles, th)):
                bg = Image.new('RGBA', t.size, (40, 40, 52, 255)); bg.alpha_composite(t.convert('RGBA'))
                sheet.paste(bg.convert('RGB'), (i*TW, 22)); dd.text((i*TW+4, 6), f'{s}-{style}:{c}', fill=(240, 240, 255))
            sheet.save(qa_dir / f'qa_hair_{s}_{style}.png')
            print('  built+QA', s, style)
    print('hairbuild done -> review qa/ sheets')

def stage_eyesfacial(st, force):
    """Eye masters (sex-agnostic, on female rep face) + facial masters (male
    rep chin). Inpaint neutral -> extract -> recolor. Build QA sheets."""
    qa = ART / 'qa'; qa.mkdir(exist_ok=True)
    # Eyes
    eye_base = Image.open(ART / f'bald_{REP["female"]}.png').convert('RGBA'); W, H = eye_base.size
    for style, desc in EYE_STYLES.items():
        mp = ART / f'eyemaster_{style}.png'
        fill(data_uri(ART / f'bald_{REP["female"]}.png'), eye_mask(W, H),
             f"{desc}, bright neutral gray iris, clear and expressive, {PIX}", mp, st, steps=40, force=force)
        ov = extract_overlay(eye_base, Image.open(mp), eye_mask(W, H))
        for cn, rgb in EYE_COLORS.items(): recolor(ov, rgb).save(ART / f'eyes_{style}_{cn}.png')
        comp = eye_base.copy(); comp.alpha_composite(recolor(ov, EYE_COLORS['blue']))
        comp.save(qa / f'qa_eyes_{style}.png'); save_state(st)
        print('  eyes', style, f'${st["spend"]:.2f}')
    # Facial (male only)
    fb = Image.open(ART / f'bald_{REP["male"]}.png').convert('RGBA'); W2, H2 = fb.size
    for style, desc in FACIAL_STYLES.items():
        mp = ART / f'facialmaster_{style}.png'
        fill(data_uri(ART / f'bald_{REP["male"]}.png'), facial_mask(W2, H2),
             f"{desc}, neutral light ash-gray color, {PIX}", mp, st, force=force)
        ov = extract_overlay(fb, Image.open(mp), facial_mask(W2, H2))
        for cn, rgb in HAIR_COLORS.items(): recolor(ov, rgb).save(ART / f'facial_{style}_{cn}.png')
        comp = fb.copy(); comp.alpha_composite(recolor(ov, HAIR_COLORS['brown']))
        comp.save(qa / f'qa_facial_{style}.png'); save_state(st)
        print('  facial', style, f'${st["spend"]:.2f}')
    print('eyesfacial done -> review qa/ sheets')

def stage_upload(st, sex, layer):
    """Atomic KV bulk put. layer=heroset uploads bald bodies + all hair for a
    sex together (atomic). layer=eyes / facial upload those overlays."""
    drop = set(st.get('dropped', []))
    entries = []
    def add(key, path): entries.append({'key': key, 'value': base64.b64encode(Path(path).read_bytes()).decode('ascii'), 'base64': True})
    if layer == 'heroset':
        for c in CLASSES:
            for t in TONES: add(f'pixel-art-hero-body:{sex}-{c}-{t}', ART / f'bald_{sex}-{c}.png')
        for style in HAIR_STYLES[sex]:
            if f'hair:{sex}:{style}' in drop: print('  (dropped', sex, style, ')'); continue
            for cn in HAIR_COLORS: add(f'pixel-art-hero-hair:{sex}-{style}-{cn}', ART / f'hair_{sex}_{style}_{cn}.png')
    elif layer == 'eyes':
        for style in EYE_STYLES:
            if f'eyes:{style}' in drop: continue
            for cn in EYE_COLORS: add(f'pixel-art-hero-eyes:{style}-{cn}', ART / f'eyes_{style}_{cn}.png')
    elif layer == 'facial':
        for style in FACIAL_STYLES:
            if f'facial:{style}' in drop: continue
            for cn in HAIR_COLORS: add(f'pixel-art-hero-facial:{style}-{cn}', ART / f'facial_{style}_{cn}.png')
    print(f'  uploading {len(entries)} keys (layer={layer} sex={sex})')
    rc = kv_bulk_put(entries)
    print('  bulk put rc', rc, 'OK' if rc == 0 else 'FAIL')
    if rc == 0:
        st.setdefault('uploaded', []).append(f'{layer}:{sex}:{len(entries)}'); save_state(st)
    return rc

def kv_bulk_put(entries, chunk=12):
    """Chunk to stay under wrangler bulk-put payload limits (these are large
    2048px PNGs). Returns 0 only if every chunk succeeds."""
    for i in range(0, len(entries), chunk):
        batch = entries[i:i+chunk]
        with tempfile.NamedTemporaryFile(mode='w', suffix='-hpd.json', delete=False, encoding='utf-8') as fh:
            json.dump(batch, fh); tmp = fh.name
        try:
            res = subprocess.run(f'npx wrangler kv bulk put "{tmp}" --binding {KV_NS} --remote',
                                 shell=True, capture_output=True, text=True, encoding='utf-8', errors='replace',
                                 cwd=str(ROOT))
            if res.returncode != 0:
                msg = (res.stderr or res.stdout or '')[-400:].encode('ascii', 'replace').decode('ascii')
                print('  chunk FAIL at', i, '::', msg); return res.returncode
            print(f'  chunk {i}-{i+len(batch)} ok')
        finally:
            try: Path(tmp).unlink()
            except OSError: pass
    return 0

def main(argv):
    if not TOKEN: print('no token'); return 2
    stage = argv[argv.index('--stage')+1] if '--stage' in argv else None
    force = '--force' in argv
    st = load_state()
    sex = argv[argv.index('--sex')+1] if '--sex' in argv else None
    layer = argv[argv.index('--layer')+1] if '--layer' in argv else None
    if stage == 'bald': stage_bald(st, force)
    elif stage == 'hairmasters': stage_hairmasters(st, force)
    elif stage == 'hairbuild': stage_hairbuild(st)
    elif stage == 'eyesfacial': stage_eyesfacial(st, force)
    elif stage == 'upload': return stage_upload(st, sex, layer)
    else: print('stages: bald | hairmasters | hairbuild | eyesfacial | upload'); return 2
    save_state(st)
    print(f'\nspend ${st["spend"]:.2f}')
    return 0

if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
