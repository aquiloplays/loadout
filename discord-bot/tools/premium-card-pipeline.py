"""Premium Boltbound card-face pipeline — Glossy Game Premium vector style.

The card-visual overhaul (Clay 2026-05-31). Produces the FINAL composited
card faces Clay sees in-game:
  Flux 1.1 Pro Ultra premium illustration  ->  glossy vector frame +
  accurate text from card data (name / mana / type / atk / hp / effect)
  + rarity badge + mana gem.

Style shift vs the legacy pixel cards: premium painterly art (not pixel
sprites) + clean serif/sans typography (Georgia + Segoe UI) + glossy
gradient frames, so the cards read well at thumbnail AND full size.

Modes:
  --contact         generate the ~12-card sample contact sheet (gate)
  --ids a,b,c       composite specific card ids (art cached in /tmp)
Bulk mode is intentionally NOT here yet — it waits on Clay's GO after the
contact-sheet review (see aquilo_priority_overhauls memory).

Art is cached at /tmp/boltbound-premium-art/<id>.png so re-runs of the
compositor don't re-bill Replicate.

Usage:
  REPLICATE_API_TOKEN=... python tools/premium-card-pipeline.py --contact
"""
from __future__ import annotations
import io, json, os, subprocess, sys, time
from pathlib import Path
import requests
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
TOKEN = os.environ.get('REPLICATE_API_TOKEN')
ART_DIR = Path('/tmp/boltbound-premium-art'); ART_DIR.mkdir(parents=True, exist_ok=True)
CARD_DIR = Path('/tmp/boltbound-premium-cards'); CARD_DIR.mkdir(parents=True, exist_ok=True)
OUT_SHEET = Path('/tmp/boltbound-premium-contact-sheet.png')

ULTRA_URL = 'https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro-ultra/predictions'

W, H = 720, 1008

# Windows system fonts — premium serif (name) + clean sans (body/stats).
WINFONTS = Path('C:/Windows/Fonts')
def _f(name, size):
    for p in (WINFONTS / name, ROOT / 'tools' / 'fonts' / name):
        try: return ImageFont.truetype(str(p), size)
        except OSError: continue
    return ImageFont.load_default()
def font_name(size):  return _f('georgiab.ttf', size)   # elegant serif, bold
def font_body(size):  return _f('segoeui.ttf', size)
def font_num(size):   return _f('arialbd.ttf', size)

# Rarity → palette. fg = frame primary, hi = glossy highlight, dark =
# deep accent, label.
RARITY = {
    'common':    {'fg': (150, 165, 185), 'hi': (205, 215, 230), 'dark': (44, 56, 74),  'label': 'COMMON'},
    'uncommon':  {'fg': (52, 199, 120),  'hi': (150, 240, 185), 'dark': (18, 96, 58),  'label': 'UNCOMMON'},
    'rare':      {'fg': (70, 140, 250),  'hi': (165, 205, 255), 'dark': (26, 60, 150), 'label': 'RARE'},
    'epic':      {'fg': (175, 95, 250),  'hi': (215, 175, 255), 'dark': (84, 28, 140), 'label': 'EPIC'},
    'legendary': {'fg': (250, 195, 60),  'hi': (255, 235, 165), 'dark': (140, 92, 14), 'label': 'LEGENDARY'},
    'champion':  {'fg': (245, 120, 185), 'hi': (255, 195, 225), 'dark': (150, 30, 86), 'label': 'CHAMPION'},
    'token':     {'fg': (150, 165, 185), 'hi': (205, 215, 230), 'dark': (44, 56, 74),  'label': 'TOKEN'},
}

# id-prefix → art theme hint (element / palette / scene flavor).
THEMES = {
    'champ':  'a heroic champion, dramatic cinematic key art',
    'leg':    'an epic legendary being, radiant grandeur',
    'wild':   'lush primal nature and beasts, verdant greens',
    'arcane': 'glowing arcane runes and crackling violet-blue magic',
    'shadow': 'creeping dark shadow magic, deep purples and black mist',
    'light':  'radiant holy light, warm gold and white glow',
    'undead': 'eerie undead bone and necrotic green',
    'fire':   'roaring orange-red flames and embers',
    'frost':  'icy blue frost and shards',
    'spire':  'a towering mystical spire, otherworldly',
    'tok':    'a simple summoned creature',
    'u':      'vivid elemental magic',
    's':      'a dramatic magical spell effect',
}
def theme_for(cid):
    pre = cid.split('.')[0]
    return THEMES.get(pre, 'epic fantasy trading-card key art')

def load_cards():
    node = (
        "import('./cards-content.js').then(m=>{const o={};"
        "for(const id of Object.keys(m.CARDS)){const c=m.CARDS[id];"
        "o[id]={id,name:c.name,type:c.type,rarity:c.rarity,mana:c.mana,"
        "atk:c.atk,hp:c.hp,keywords:c.keywords||[],text:c.text||''};}"
        "process.stdout.write(JSON.stringify(o));});"
    )
    r = subprocess.run(['node', '-e', node], cwd=str(ROOT), capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError('load_cards failed: ' + r.stderr[:300])
    return json.loads(r.stdout)

# ── Premium art prompt ─────────────────────────────────────────────
def build_prompt(card):
    theme = theme_for(card['id'])
    subject_kind = ('a powerful champion' if card['type'] == 'champion'
                    else 'a fantasy creature' if card['type'] == 'minion'
                    else 'a dramatic magical spell effect')
    return (
        f"Premium digital illustration for a fantasy trading card: {subject_kind} "
        f"named '{card['name']}'. {theme}. Glossy painterly rendering, dramatic "
        f"rim lighting, rich saturated color, high detail, centered hero "
        f"composition with a clean atmospheric background, polished AAA card-game "
        f"key art. No text, no card frame, no border, no UI — just the artwork."
    )

def gen_art(card, force=False):
    out = ART_DIR / f"{card['id']}.png"
    if out.exists() and not force:
        return out
    if not TOKEN:
        raise SystemExit('REPLICATE_API_TOKEN not set — cannot generate art.')
    body = {'input': {'prompt': build_prompt(card), 'aspect_ratio': '4:3',
                      'output_format': 'png', 'safety_tolerance': 2, 'raw': False}}
    while True:
        r = requests.post(ULTRA_URL, json=body, timeout=120,
                          headers={'Authorization': f'Bearer {TOKEN}', 'Prefer': 'wait=40'})
        if r.status_code == 429:
            time.sleep(15); continue
        if not r.ok: raise RuntimeError(f'{r.status_code} {r.text[:200]}')
        p = r.json(); break
    while p.get('status') in ('starting', 'processing'):
        time.sleep(1.3)
        p = requests.get(p['urls']['get'], headers={'Authorization': f'Bearer {TOKEN}'}).json()
    if p.get('status') != 'succeeded':
        raise RuntimeError(f"art {card['id']}: {p.get('status')}")
    url = p['output'][0] if isinstance(p['output'], list) else p['output']
    out.write_bytes(_download(url))
    return out

def _download(url, tries=5):
    last = None
    for i in range(tries):
        try:
            r = requests.get(url, timeout=120)
            if r.ok and r.content:
                return r.content
            last = f'{r.status_code}'
        except Exception as e:
            last = str(e)[:80]
        time.sleep(2 + i * 2)
    raise RuntimeError(f'download failed after {tries}: {last}')

# ── Glossy helpers ─────────────────────────────────────────────────
def vgrad(w, h, top, bottom):
    """Vertical gradient RGBA image."""
    base = Image.new('RGBA', (w, h))
    px = base.load()
    for y in range(h):
        t = y / max(1, h - 1)
        r = int(top[0] + (bottom[0] - top[0]) * t)
        g = int(top[1] + (bottom[1] - top[1]) * t)
        b = int(top[2] + (bottom[2] - top[2]) * t)
        for x in range(w):
            px[x, y] = (r, g, b, 255)
    return base

def rounded_mask(w, h, radius):
    m = Image.new('L', (w, h), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, w - 1, h - 1], radius=radius, fill=255)
    return m

def gloss_circle(draw, cx, cy, r, fill, outline):
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill, outline=outline, width=4)
    # upper highlight — glossy sheen.
    draw.ellipse([cx - r * 0.6, cy - r * 0.78, cx + r * 0.6, cy - r * 0.12],
                 fill=(255, 255, 255, 70))

def fit_crop(src, w, h):
    src = src.convert('RGBA'); sw, sh = src.size
    target = w / h; sr = sw / sh
    if sr > target:
        nw = int(sh * target); x0 = (sw - nw) // 2; src = src.crop((x0, 0, x0 + nw, sh))
    else:
        nh = int(sw / target); y0 = (sh - nh) // 2; src = src.crop((0, y0, sw, y0 + nh))
    return src.resize((w, h), Image.LANCZOS)

def wrap(draw, text, fnt, maxw):
    words = text.split(); lines = []; cur = ''
    for w in words:
        t = (cur + ' ' + w).strip()
        if draw.textlength(t, font=fnt) <= maxw: cur = t
        else:
            if cur: lines.append(cur)
            cur = w
    if cur: lines.append(cur)
    return lines

# ── Compositor ─────────────────────────────────────────────────────
def render_card(art_img, card):
    rar = (card.get('rarity') or 'common').lower()
    pal = RARITY.get(rar, RARITY['common'])
    fg, hi, dark = pal['fg'], pal['hi'], pal['dark']

    canvas = Image.new('RGBA', (W, H), (0, 0, 0, 0))

    # Glossy gradient frame (rounded) — fg(top) -> dark(bottom) with a
    # bright top sheen.
    frame = vgrad(W, H, (hi[0], hi[1], hi[2]), (dark[0], dark[1], dark[2]))
    frame.putalpha(rounded_mask(W, H, 40))
    canvas.alpha_composite(frame)
    draw = ImageDraw.Draw(canvas)

    # Inner card body (deep, slightly inset) over the frame band.
    M = 22
    body = Image.new('RGBA', (W - 2 * M, H - 2 * M), (0, 0, 0, 0))
    bgrad = vgrad(W - 2 * M, H - 2 * M, (26, 20, 40), (14, 10, 24))
    bgrad.putalpha(rounded_mask(W - 2 * M, H - 2 * M, 26))
    body.alpha_composite(bgrad)
    canvas.alpha_composite(body, (M, M))
    # Top inner sheen line.
    draw.line([(M + 14, M + 4), (W - M - 14, M + 4)], fill=(255, 255, 255, 60), width=2)

    # ── Header: gem | name | type.
    hy, hh = M + 12, 92
    gem_cx, gem_cy, gem_r = M + 50, hy + hh // 2, 38
    gloss_circle(draw, gem_cx, gem_cy, gem_r, (120, 95, 235, 255), (255, 255, 255, 230))
    mana = str(card.get('mana') if card.get('mana') is not None else 0)
    mf = font_num(40)
    mw, mh = draw.textbbox((0, 0), mana, font=mf)[2:]
    draw.text((gem_cx - mw / 2, gem_cy - mh / 2 - 4), mana, font=mf,
              fill=(255, 255, 255, 255), stroke_width=3, stroke_fill=(20, 12, 40, 255))

    # Type pill (right).
    pill_w = 124
    pill = (W - M - 14 - pill_w, hy + 24, W - M - 14, hy + hh - 24)
    draw.rounded_rectangle(pill, radius=20, fill=(dark[0], dark[1], dark[2], 255),
                           outline=(hi[0], hi[1], hi[2], 255), width=2)
    tl = (card.get('type') or '').upper()
    tf = font_body(17)
    tw, th = draw.textbbox((0, 0), tl, font=tf)[2:]
    draw.text(((pill[0] + pill[2]) / 2 - tw / 2, (pill[1] + pill[3]) / 2 - th / 2 - 1),
              tl, font=tf, fill=(255, 255, 255, 255))

    # Name (serif, centered between gem and pill, auto-fit).
    nx0, nx1 = gem_cx + gem_r + 14, pill[0] - 14
    name = card.get('name') or card['id']
    for sz in (34, 30, 27, 24, 21, 19, 17):
        nf = font_name(sz)
        if draw.textlength(name, font=nf) <= (nx1 - nx0): break
    nw = draw.textlength(name, font=nf); nbb = draw.textbbox((0, 0), name, font=nf)
    draw.text(((nx0 + nx1) / 2 - nw / 2, hy + hh / 2 - (nbb[3] - nbb[1]) / 2 - nbb[1]),
              name, font=nf, fill=(255, 252, 240, 255), stroke_width=3,
              stroke_fill=(10, 6, 20, 255))

    # ── Art area (glossy inset frame).
    ax, ay = M + 6, hy + hh + 8
    aw, ah = W - 2 * (M + 6), 580
    art = fit_crop(art_img, aw, ah)
    art_mask = rounded_mask(aw, ah, 18)
    canvas.paste(art, (ax, ay), art_mask)
    draw.rounded_rectangle([ax, ay, ax + aw, ay + ah], radius=18, outline=(hi[0], hi[1], hi[2], 255), width=3)
    draw.rounded_rectangle([ax + 3, ay + 3, ax + aw - 3, ay + ah - 3], radius=15, outline=(10, 6, 20, 120), width=2)

    # ── Rarity ribbon.
    ry, rh2 = ay + ah + 10, 30
    ribbon = (M + 4, ry, W - M - 4, ry + rh2)
    rg = vgrad(ribbon[2] - ribbon[0], rh2, (dark[0], dark[1], dark[2]), (max(0, dark[0]//2), max(0, dark[1]//2), max(0, dark[2]//2)))
    rg.putalpha(rounded_mask(ribbon[2] - ribbon[0], rh2, 8))
    canvas.alpha_composite(rg, (ribbon[0], ribbon[1]))
    draw.rounded_rectangle(ribbon, radius=8, outline=(hi[0], hi[1], hi[2], 255), width=2)
    rf = font_body(15)
    rl = pal['label']; rw = draw.textlength(rl, font=rf); rbb = draw.textbbox((0, 0), rl, font=rf)
    draw.text((W / 2 - rw / 2, ry + rh2 / 2 - (rbb[3] - rbb[1]) / 2 - rbb[1]),
              rl, font=rf, fill=(hi[0], hi[1], hi[2], 255))

    # ── Footer: atk | effect | hp.
    fy = ry + rh2 + 10
    fh = H - fy - M - 8
    has_stats = card.get('type') in ('minion', 'champion') and (card.get('atk') or 0) >= 0 and card.get('type') != 'spell'
    has_stats = card.get('type') in ('minion', 'champion')

    if has_stats:
        col = 104; r2 = 44; ay2 = fy + fh // 2
        axx = M + 8 + col // 2
        gloss_circle(draw, axx, ay2, r2, (216, 40, 40, 255), (255, 255, 255, 235))
        atk = str(card.get('atk') or 0); nf2 = font_num(38)
        aw2, ah2 = draw.textbbox((0, 0), atk, font=nf2)[2:]
        draw.text((axx - aw2 / 2, ay2 - ah2 / 2 - 3), atk, font=nf2, fill=(255, 255, 255, 255),
                  stroke_width=2, stroke_fill=(80, 8, 8, 255))
        hxx = W - M - 8 - col // 2
        gloss_circle(draw, hxx, ay2, r2, (46, 190, 96, 255), (255, 255, 255, 235))
        hp = str(card.get('hp') or 0)
        hw2, hh2 = draw.textbbox((0, 0), hp, font=nf2)[2:]
        draw.text((hxx - hw2 / 2, ay2 - hh2 / 2 - 3), hp, font=nf2, fill=(255, 255, 255, 255),
                  stroke_width=2, stroke_fill=(8, 64, 24, 255))
        ex0, ex1 = M + 8 + col + 16, W - M - 8 - col - 16
    else:
        ex0, ex1 = M + 16, W - M - 16

    py0, py1 = fy + 2, fy + fh - 2
    panel = Image.new('RGBA', (ex1 - ex0, py1 - py0), (0, 0, 0, 0))
    pg = vgrad(ex1 - ex0, py1 - py0, (30, 22, 46), (18, 13, 30))
    pg.putalpha(rounded_mask(ex1 - ex0, py1 - py0, 14))
    panel.alpha_composite(pg)
    canvas.alpha_composite(panel, (ex0, py0))
    draw.rounded_rectangle([ex0, py0, ex1, py1], radius=14, outline=(hi[0], hi[1], hi[2], 200), width=2)

    eff = (card.get('text') or '').strip()
    if not eff:
        eff = ', '.join(k.upper() for k in (card.get('keywords') or [])) or '—'
    emaxw = (ex1 - ex0) - 28; usable = (py1 - py0) - 20
    chosen = None
    for sz in (32, 29, 26, 24, 22, 20, 18, 17, 16):
        ef = font_body(sz)
        lines = wrap(draw, eff, ef, emaxw)
        lh = draw.textbbox((0, 0), 'Mg', font=ef)[3] + 5
        if len(lines) * lh <= usable:
            chosen = (ef, lines, lh); break
    if not chosen:
        ef = font_body(16); lh = draw.textbbox((0, 0), 'Mg', font=ef)[3] + 5
        maxln = max(1, usable // lh); lines = wrap(draw, eff, ef, emaxw)[:maxln]
        if lines and len(lines) == maxln: lines[-1] = lines[-1].rstrip(' .,;') + '…'
        chosen = (ef, lines, lh)
    ef, lines, lh = chosen
    ty = py0 + (usable - len(lines) * lh) // 2 + 8
    for i, ln in enumerate(lines):
        lw = draw.textlength(ln, font=ef)
        draw.text((ex0 + ((ex1 - ex0) - lw) / 2, ty + i * lh), ln, font=ef,
                  fill=(232, 224, 250, 255))

    return canvas

# ── Contact sheet ──────────────────────────────────────────────────
CONTACT_IDS = [
    'champ.warrior', 'champ.rogue', 'leg.solara', 'wild.l001',
    'shadow.rs02', 'arcane.r001', 'light.us04', 'arcane.u002',
    'arcane.c009', 'light.cs06', 'tok.boneknight', 'u.firebolt',
]

def build_contact_sheet(cards):
    cols, pad, label_h = 4, 24, 34
    thumb_w = 300; thumb_h = int(thumb_w * H / W)
    ids = [c for c in CONTACT_IDS if c in cards][:12]
    rows = (len(ids) + cols - 1) // cols
    sheet_w = cols * thumb_w + (cols + 1) * pad
    sheet_h = rows * (thumb_h + label_h) + (rows + 1) * pad + 40
    sheet = Image.new('RGBA', (sheet_w, sheet_h), (16, 12, 26, 255))
    sd = ImageDraw.Draw(sheet)
    title = 'BOLTBOUND — Premium Card Faces (sample) · Glossy Game Premium style'
    sd.text((pad, 12), title, font=font_body(22), fill=(240, 235, 250, 255))
    for i, cid in enumerate(ids):
        card = cards[cid]
        art = gen_art(card)
        full = render_card(Image.open(art), card)
        full.save(CARD_DIR / f'{cid}.png')
        thumb = full.resize((thumb_w, thumb_h), Image.LANCZOS)
        r, c = divmod(i, cols)
        x = pad + c * (thumb_w + pad)
        y = 40 + pad + r * (thumb_h + label_h + pad)
        sheet.alpha_composite(thumb, (x, y))
        lbl = f"{cid}  ·  {card['rarity']}/{card['type']}"
        sd.text((x + 4, y + thumb_h + 6), lbl, font=font_body(15), fill=(200, 192, 220, 255))
        print(f'  [{i+1}/{len(ids)}] {cid}')
    sheet.convert('RGB').save(OUT_SHEET, quality=95)
    print(f'\nContact sheet -> {OUT_SHEET}  ({sheet_w}x{sheet_h})')

def main(argv):
    cards = load_cards()
    if '--contact' in argv:
        build_contact_sheet(cards)
        return 0
    if '--ids' in argv:
        ids = argv[argv.index('--ids') + 1].split(',')
        for cid in ids:
            if cid not in cards: print('skip', cid); continue
            full = render_card(Image.open(gen_art(cards[cid])), cards[cid])
            full.save(CARD_DIR / f'{cid}.png'); print('saved', cid)
        return 0
    print('usage: --contact | --ids a,b,c'); return 1

if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
