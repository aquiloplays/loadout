"""Hero Phase 2 - archetype-grouped worn-gear overlay bulk runner.

Proven recipe (Phase 1, hero-paperdoll-pipeline.py + the GO-gated
feasibility sheet): flux-fill-pro INPAINT a neutral-material gear piece
into the matching body wear-zone on a median-build bald rep body ->
diff-extract the registered transparent overlay (with magenta-reject) ->
upload to KV pixel-art-gear:<slot>:<slug>:<sex>-worn.

Archetypes come from gear-art-slugs.js enumerateArchetypes(SHOP_POOL) so
the work-list can never drift from the render contract. Every archetype
is rendered per-sex (male + female reps).

Stages (resumable; state in gear-worn-state.json):
  gen      inpaint + extract every (archetype x sex) overlay  [--force]
  sheet    build a QA contact sheet of all overlays on the rep bodies
  upload   wrangler kv bulk put every worn overlay

Usage:  python -u tools/gear-worn-overlay-pipeline.py --stage gen
ASCII-only output. flux-fill-pro ~$0.05/call. ~66 calls ~= $3.30.
"""
from __future__ import annotations
import base64, io, json, os, subprocess, sys, tempfile, time
from pathlib import Path
import requests
from PIL import Image, ImageDraw, ImageFilter, ImageChops

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent                       # discord-bot/
REPO = ROOT.parent                       # Loadout/
TOKEN = os.environ.get('REPLICATE_API_TOKEN')
FILL = 'https://api.replicate.com/v1/models/black-forest-labs/flux-fill-pro/predictions'
WORKER = 'loadout-discord.aquiloplays.workers.dev'
KV_NS = 'LOADOUT_BOLTS'
ART = Path('C:/tmp/hero-pd-gear'); ART.mkdir(parents=True, exist_ok=True)
BALD = Path('C:/tmp/hero-pd')
STATE = ROOT / 'gear-worn-state.json'
COST = 0.05
MIN_PNG = 4000
SEXES = ['male', 'female']
REP = {'male': 'male-ranger', 'female': 'female-ranger'}   # median build per sex
PIX = ("16-bit pixel art JRPG game sprite, crisp clean pixels, matching the "
       "existing character art style, consistent lighting from upper-left, "
       "neutral natural material colors")

# ── wear-zone masks (relative fractions) ──
# Tuned on the male-ranger rep. The female rep is narrower and framed a
# touch higher, so per-sex (sx, dy) scales x toward center 0.5 and nudges
# y. flux-fill still inpaints contextually onto the visible body, so the
# mask only needs to roughly bound the target part.
def _ellipse(W, H, cx, cy, rx, ry, ext_to=None, blur=6, dy=0.0, sx=1.0):
    cy += dy
    cx = 0.5 + (cx - 0.5) * sx; rx *= sx
    m = Image.new('L', (W, H), 0); d = ImageDraw.Draw(m)
    d.ellipse([int((cx-rx)*W), int((cy-ry)*H), int((cx+rx)*W), int((cy+ry)*H)], fill=255)
    if ext_to is not None:
        d.rectangle([int((cx-rx)*W), int(cy*H), int((cx+rx)*W), int((ext_to+dy)*H)], fill=255)
    return m.filter(ImageFilter.GaussianBlur(blur))

def mask_for(slot, W, H, dy=0.0, sx=1.0):
    if slot == 'head':    return _ellipse(W, H, 0.500, 0.125, 0.140, 0.120, ext_to=0.20, blur=5, dy=dy, sx=sx)
    if slot == 'chest':   return _ellipse(W, H, 0.500, 0.285, 0.185, 0.095, ext_to=0.40, blur=6, dy=dy, sx=sx)
    if slot == 'legs':    return _ellipse(W, H, 0.500, 0.555, 0.165, 0.130, ext_to=0.71, blur=6, dy=dy, sx=sx)
    if slot == 'boots':   return _ellipse(W, H, 0.500, 0.820, 0.175, 0.080, ext_to=0.90, blur=5, dy=dy, sx=sx)
    if slot == 'weapon':  return _ellipse(W, H, 0.300, 0.430, 0.125, 0.290, blur=6, dy=dy, sx=sx)
    if slot == 'trinket': return _ellipse(W, H, 0.500, 0.240, 0.075, 0.055, blur=4, dy=dy, sx=sx)
    raise ValueError(slot)

# per-sex mask tuning
SEX_MASK = {'male': dict(dy=0.0, sx=1.0), 'female': dict(dy=0.005, sx=0.85)}

# ── per-archetype prompts ──
WEAPON_DESC = {
    'sword':    "a steel longsword gripped in the fist, long straight double-edged blade pointing upward, leather-wrapped hilt with crossguard",
    'axe':      "a battle axe gripped in the fist, broad curved steel axe-head on a wooden haft",
    'hammer':   "a heavy war hammer gripped in the fist, blunt rectangular steel head on a wooden haft",
    'dagger':   "a short dagger gripped in the fist, pointed double-edged steel blade",
    'bow':      "a tall wooden longbow held upright at the side, curved limbs and taut bowstring",
    'crossbow': "a crossbow held forward in both hands, horizontal wood-and-steel frame with a short bow",
    'sling':    "a simple leather sling held at the side",
    'wand':     "a slender wooden magic wand gripped in the fist, small crystal at the tip",
    'staff':    "a tall wooden staff held upright in the fist, reaching above the head",
    'tome':     "a thick leather-bound spellbook tome held open in one hand",
    'orb':      "a round crystal orb cradled in the open palm",
    'holy':     "a holy cross-topped staff held upright in the fist",
    'polearm':  "a tall halberd polearm held upright, steel axe-blade and spike at the top, long wooden shaft",
}
HEAD_DESC = {
    'cloth':   "a simple cloth hood worn over the head",
    'leather': "a brown leather cap worn snugly on the head",
    'mail':    "a steel chainmail coif framing the face",
    'plate':   "a polished steel plate helmet worn on the head with a nose guard",
    'robe':    "a cloth mage circlet/hood worn on the head",
}
CHEST_DESC = {
    'cloth':   "a simple cloth tunic worn over the torso and shoulders",
    'leather': "a brown leather chest jerkin worn over the torso and shoulders",
    'mail':    "a steel chainmail hauberk of interlocking rings over the torso and shoulders",
    'plate':   "a polished steel breastplate with pauldrons over the torso and shoulders",
    'robe':    "flowing cloth mage robes draped over the torso and shoulders",
}
LEGS_DESC = {
    'cloth':   "simple cloth trousers worn on the legs and hips",
    'leather': "brown leather leg guards worn on the legs and hips",
    'mail':    "steel chainmail leggings worn on the legs and hips",
    'plate':   "polished steel plate greaves and tassets on the legs and hips",
    'robe':    "a long cloth mage skirt draped over the legs and hips",
}
BOOTS_DESC = {
    'cloth':   "simple cloth shoes worn on the feet",
    'leather': "brown leather boots worn on the feet and lower legs",
    'mail':    "steel chainmail sabatons worn on the feet and lower legs",
    'plate':   "polished steel plate sabatons worn on the feet and lower legs",
}
def prompt_for(slot, slug):
    if slot == 'weapon':  body = WEAPON_DESC[slug]
    elif slot == 'head':  body = HEAD_DESC[slug]
    elif slot == 'chest': body = CHEST_DESC[slug]
    elif slot == 'legs':  body = LEGS_DESC[slug]
    elif slot == 'boots': body = BOOTS_DESC[slug]
    elif slot == 'trinket': body = "a small pendant amulet on a cord around the neck, resting on the upper chest"
    else: raise ValueError(slot)
    return f"{body}, {PIX}"

# ── state ──
def load_state():
    if STATE.exists():
        try: return json.loads(STATE.read_text())
        except Exception: pass
    return {'gen': [], 'spend': 0.0, 'uploaded': []}
def save_state(s): STATE.write_text(json.dumps(s, indent=1))

# ── archetype work-list from the live contract ──
def archetypes():
    script = """
      import { SHOP_POOL } from './dungeon.js';
      import { enumerateArchetypes } from './gear-art-slugs.js';
      const rows = SHOP_POOL.map(r => ({slot:r[0],rarity:r[1],name:r[2],setName:r[7],weaponType:r[8]}));
      console.log(JSON.stringify(enumerateArchetypes(rows)));
    """
    r = subprocess.run(['node', '--input-type=module', '-e', script], cwd=str(ROOT),
                       capture_output=True, text=True, encoding='utf-8', errors='replace', check=True)
    return json.loads(r.stdout.strip())

# ── flux-fill ──
def _poll(p):
    while p.get('status') in ('starting', 'processing'):
        time.sleep(1.5)
        p = requests.get(p['urls']['get'], headers={'Authorization': f'Bearer {TOKEN}'}).json()
    return p
def data_uri(path): return 'data:image/png;base64,' + base64.b64encode(Path(path).read_bytes()).decode('ascii')
def fill(image_uri, mask_img, prompt, out, st, force=False, steps=50, guidance=30):
    if out.exists() and out.stat().st_size > MIN_PNG and not force: return out, False
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

# ── extraction (diff vs base) with magenta-reject ──
def extract_overlay(base_img, master_img, mask_img):
    import numpy as np
    W, H = base_img.size
    master_img = master_img.resize((W, H)); mask_img = mask_img.resize((W, H))
    diff = ImageChops.difference(base_img.convert('RGB'), master_img.convert('RGB')).convert('L')
    alpha = diff.point(lambda v: 255 if v > 28 else (v*9 if v > 8 else 0))
    alpha = ImageChops.multiply(alpha, mask_img.point(lambda v: 255 if v > 30 else 0))
    alpha = alpha.filter(ImageFilter.MedianFilter(5))
    ov = master_img.convert('RGBA'); ov.putalpha(alpha)
    # Magenta-reject: the Phase 1 bald bodies have un-keyed magenta floor
    # pixels that can bleed into the masked diff (notably under tall weapon
    # masks). Zero alpha wherever the master pixel is floor-magenta so the
    # overlay never carries pink fringes. (Body re-key is W1's job; this
    # just keeps OUR overlays clean regardless.)
    arr = np.array(ov)
    R, G, B = arr[..., 0].astype(np.int16), arr[..., 1].astype(np.int16), arr[..., 2].astype(np.int16)
    is_mag = (R > 150) & (B > 90) & ((R - G) > 70) & ((B - G) > 30)
    arr[..., 3] = np.where(is_mag, 0, arr[..., 3]).astype('uint8')
    return Image.fromarray(arr, 'RGBA')

def bald(sex): return BALD / f'bald_{REP[sex]}.png'

# ── stages ──
def stage_gen(st, force):
    arch = archetypes()
    print(f'{len(arch)} archetypes x {len(SEXES)} sexes = {len(arch)*len(SEXES)} overlays')
    for sex in SEXES:
        bp = bald(sex)
        if not bp.exists():
            print('  fetching rep body', REP[sex])
            bp.write_bytes(requests.get(f'https://{WORKER}/asset/hero-body/{REP[sex]}-light.png', timeout=120).content)
        base = Image.open(bp).convert('RGBA'); W, H = base.size
        mp = SEX_MASK[sex]
        for a in arch:
            slot, slug = a['slot'], a['slug']
            master = ART / f'master_{sex}_{slot}_{slug}.png'
            worn = ART / f'worn_{sex}_{slot}_{slug}.png'
            if worn.exists() and worn.stat().st_size > MIN_PNG and not force:
                continue
            mask = mask_for(slot, W, H, **mp)
            _, billed = fill(data_uri(bp), mask, prompt_for(slot, slug), master, st, force=force)
            ov = extract_overlay(base, Image.open(master), mask)
            ov.save(worn)
            tag = f'{sex}:{slot}/{slug}'
            if tag not in st['gen']: st['gen'].append(tag)
            print(f"  {tag} {'(gen)' if billed else '(cache)'}  ${st['spend']:.2f}")
            save_state(st)
    print(f'gen done  spend ${st["spend"]:.2f}')

def stage_sheet(st):
    arch = archetypes()
    cols = max(7, (len(arch) + 1))
    TW = 150
    for sex in SEXES:
        base = Image.open(bald(sex)).convert('RGBA')
        tiles = [('base', base.copy())]
        for a in arch:
            worn = ART / f"worn_{sex}_{a['slot']}_{a['slug']}.png"
            if not worn.exists(): continue
            comp = base.copy(); comp.alpha_composite(Image.open(worn).convert('RGBA').resize(base.size))
            tiles.append((f"{a['slot']}/{a['slug']}", comp))
        n = len(tiles); ncol = 8; nrow = (n + ncol - 1)//ncol
        th = int(base.height * TW / base.width)
        sheet = Image.new('RGB', (TW*ncol, (th+18)*nrow), (28, 28, 38)); dd = ImageDraw.Draw(sheet)
        for i, (lbl, t) in enumerate(tiles):
            r, c = divmod(i, ncol)
            tt = t.resize((TW, th)); bg = Image.new('RGB', (TW, th), (28, 28, 38))
            bg.paste(tt.convert('RGB'), (0, 0), tt.convert('RGBA'))
            sheet.paste(bg, (c*TW, r*(th+18)+18)); dd.text((c*TW+3, r*(th+18)+4), lbl, fill=(235, 235, 250))
        out = REPO / f'gear-worn-sheet-{sex}.png'; sheet.save(out); print('  sheet ->', out)
    print('sheet done')

def kv_bulk_put(entries, chunk=10):
    for i in range(0, len(entries), chunk):
        batch = entries[i:i+chunk]
        with tempfile.NamedTemporaryFile(mode='w', suffix='-gw.json', delete=False, encoding='utf-8') as fh:
            json.dump(batch, fh); tmp = fh.name
        try:
            res = subprocess.run(f'npx wrangler kv bulk put "{tmp}" --binding {KV_NS} --remote',
                                 shell=True, capture_output=True, text=True, encoding='utf-8',
                                 errors='replace', cwd=str(ROOT))
            if res.returncode != 0:
                msg = (res.stderr or res.stdout or '')[-400:].encode('ascii', 'replace').decode('ascii')
                print('  chunk FAIL at', i, '::', msg); return res.returncode
            print(f'  chunk {i}-{i+len(batch)} ok')
        finally:
            try: Path(tmp).unlink()
            except OSError: pass
    return 0

def stage_upload(st):
    arch = archetypes()
    entries = []
    for sex in SEXES:
        for a in arch:
            worn = ART / f"worn_{sex}_{a['slot']}_{a['slug']}.png"
            if not worn.exists() or worn.stat().st_size < MIN_PNG:
                print('  MISSING', sex, a['slot'], a['slug']); continue
            key = f"pixel-art-gear:{a['slot']}:{a['slug']}:{sex}-worn"
            entries.append({'key': key, 'value': base64.b64encode(worn.read_bytes()).decode('ascii'), 'base64': True})
    print(f'  uploading {len(entries)} worn overlays')
    rc = kv_bulk_put(entries)
    print('  bulk put rc', rc, 'OK' if rc == 0 else 'FAIL')
    if rc == 0:
        st['uploaded'].append(f'worn:{len(entries)}'); save_state(st)
    return rc

def main(argv):
    if not TOKEN: print('no REPLICATE_API_TOKEN'); return 2
    stage = argv[argv.index('--stage')+1] if '--stage' in argv else None
    force = '--force' in argv
    st = load_state()
    if stage == 'gen': stage_gen(st, force)
    elif stage == 'sheet': stage_sheet(st)
    elif stage == 'upload': return stage_upload(st)
    else: print('stages: gen | sheet | upload'); return 2
    save_state(st)
    return 0

if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
