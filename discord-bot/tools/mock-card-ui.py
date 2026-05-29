"""Mock Boltbound card UI for previewing v8 character art in context.

This builds a representative card frame (mana gem + name banner + stats
+ effect text panel) and slots the v8 character art into the picture
area. Approximates what the aquilo-site card UI renders at runtime.

Usage:
  python tools/mock-card-ui.py
"""
from __future__ import annotations
import json, subprocess
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT  = Path(__file__).resolve().parent.parent
FONTS = Path(__file__).resolve().parent / 'fonts'
V8_DIR = Path('/tmp/boltbound-pixel-cards-v8')
OUT    = Path('/tmp/boltbound-mock-cards'); OUT.mkdir(exist_ok=True, parents=True)

# Portrait card: 720x1008 (5:7 standard TCG ratio)
W, H = 720, 1008

RARITY_COLOR = {
    'common':    (148, 163, 184, 255),   # slate
    'uncommon':  ( 34, 197,  94, 255),   # green
    'rare':      ( 59, 130, 246, 255),   # blue
    'epic':      (168,  85, 247, 255),   # violet
    'legendary': (250, 204,  21, 255),   # gold
    'champion':  (244, 114, 182, 255),   # aurora pink
    'token':     (148, 163, 184, 255),
}

def load_cards():
    node = (
        "import('./cards-content.js').then(m => {"
        "  const out = {};"
        "  for (const id of Object.keys(m.CARDS)) {"
        "    const c = m.CARDS[id];"
        "    out[id] = { id, name: c.name, type: c.type, rarity: c.rarity, "
        "                mana: c.mana, atk: c.atk, hp: c.hp, "
        "                keywords: c.keywords||[], text: c.text||'' };"
        "  }"
        "  process.stdout.write(JSON.stringify(out));"
        "});"
    )
    r = subprocess.run(['node','-e',node], cwd=str(ROOT),
                       capture_output=True, text=True, timeout=60)
    return json.loads(r.stdout)

def font(size, style='header'):
    fn = 'PressStart2P-Regular.ttf' if style=='header' else 'VT323-Regular.ttf'
    try: return ImageFont.truetype(str(FONTS / fn), size)
    except OSError: return ImageFont.load_default()

def wrap(draw, text, fnt, max_w):
    if not text: return []
    words = text.split(); lines = []; cur = ''
    for w in words:
        trial = (cur + ' ' + w).strip()
        if draw.textlength(trial, font=fnt) <= max_w: cur = trial
        else:
            if cur: lines.append(cur)
            cur = w
    if cur: lines.append(cur)
    return lines

def render_card(art_img, card):
    canvas = Image.new('RGBA', (W, H), (15, 11, 26, 255))
    draw = ImageDraw.Draw(canvas)

    rarity = (card.get('rarity') or 'common').lower()
    rcolor = RARITY_COLOR.get(rarity, RARITY_COLOR['common'])

    # Outer pixel border — chunky.
    border_w = 8
    draw.rectangle([0, 0, W-1, H-1], outline=rcolor, width=border_w)
    draw.rectangle([border_w, border_w, W-border_w-1, H-border_w-1],
                   outline=(20, 16, 40, 255), width=4)

    # Header bar — mana + name + type.
    hdr_y = 24
    hdr_h = 80
    # Mana gem (circle, top-left).
    cx, cy, cr = 70, hdr_y + hdr_h//2, 32
    draw.ellipse([cx-cr, cy-cr, cx+cr, cy+cr],
                 fill=(155,108,255,255), outline=(250,204,21,255), width=3)
    mana = str(card.get('mana') or 0)
    mf = font(28, 'header')
    mw, mh = draw.textbbox((0,0), mana, font=mf)[2:]
    draw.text((cx-mw/2, cy-mh/2-2), mana, font=mf, fill=(255,255,255,255),
              stroke_width=2, stroke_fill=(0,0,0,255))

    # Name (center of header).
    name = card.get('name') or card['id']
    for sz in (28, 24, 22, 20, 18):
        nf = font(sz, 'header')
        if draw.textlength(name, font=nf) <= W - 240: break
    nw, nh = draw.textbbox((0,0), name, font=nf)[2:]
    draw.text((W/2-nw/2, hdr_y + hdr_h/2 - nh/2), name, font=nf,
              fill=(255,255,255,255), stroke_width=2, stroke_fill=(0,0,0,255))

    # Type (top-right).
    tlabel = (card.get('type') or '').upper()
    tf = font(16, 'header')
    tw, th = draw.textbbox((0,0), tlabel, font=tf)[2:]
    draw.text((W - 30 - tw, hdr_y + hdr_h/2 - th/2), tlabel, font=tf,
              fill=rcolor, stroke_width=2, stroke_fill=(0,0,0,255))

    # Art area — center.
    art_y = hdr_y + hdr_h + 16
    art_h = 600
    art_x = 24
    art_w = W - 48
    # Resize character art to fit.
    src = art_img.convert('RGBA')
    sw, sh = src.size
    target = art_w / art_h
    src_r  = sw / sh
    if src_r > target:
        new_w = int(sh * target); x0 = (sw - new_w)//2
        src = src.crop((x0, 0, x0+new_w, sh))
    else:
        new_h = int(sw / target); y0 = (sh - new_h)//2
        src = src.crop((0, y0, sw, y0+new_h))
    src = src.resize((art_w, art_h), Image.NEAREST)
    canvas.paste(src, (art_x, art_y), src)
    draw.rectangle([art_x-2, art_y-2, art_x+art_w+1, art_y+art_h+1],
                   outline=rcolor, width=3)

    # Footer — stats + effect text.
    foot_y = art_y + art_h + 12
    foot_h = H - foot_y - 24

    # Stats (atk left, hp right).
    if card.get('type') in ('minion','champion') and (card.get('atk') or 0) > 0:
        sf = font(34, 'header')
        # ATK red circle.
        ax, ay = 60, foot_y + 50
        ar = 36
        draw.ellipse([ax-ar, ay-ar, ax+ar, ay+ar],
                     fill=(220,38,38,255), outline=(255,255,255,255), width=3)
        atk = str(card.get('atk') or 0)
        aw, ah = draw.textbbox((0,0), atk, font=sf)[2:]
        draw.text((ax-aw/2, ay-ah/2-2), atk, font=sf, fill=(255,255,255,255),
                  stroke_width=2, stroke_fill=(80,10,10,255))
        # HP green circle.
        hx = W - 60
        draw.ellipse([hx-ar, ay-ar, hx+ar, ay+ar],
                     fill=(34,197,94,255), outline=(255,255,255,255), width=3)
        hp = str(card.get('hp') or 0)
        hw, hh = draw.textbbox((0,0), hp, font=sf)[2:]
        draw.text((hx-hw/2, ay-hh/2-2), hp, font=sf, fill=(255,255,255,255),
                  stroke_width=2, stroke_fill=(10,60,20,255))

    # Effect text panel.
    eff = (card.get('text') or '').strip()
    if eff:
        ef = font(22, 'body')
        eff_max_w = W - 240   # leave room for stat circles
        lines = wrap(draw, eff, ef, eff_max_w)[:4]
        line_h = draw.textbbox((0,0), 'Mg', font=ef)[3] + 4
        ey = foot_y + 10
        for i, ln in enumerate(lines):
            lw = draw.textlength(ln, font=ef)
            draw.text((W/2 - lw/2, ey + i * line_h), ln, font=ef,
                      fill=(220,210,255,255))

    return canvas

cards = load_cards()
SAMPLES = ['champ.warrior','u.firebolt','leg.nyx','undead.c034','spire.s01.embercrown']
for cid in SAMPLES:
    art_path = V8_DIR / f'{cid}.webp'
    if not art_path.exists():
        print(f'SKIP {cid}: no v8 art'); continue
    art = Image.open(art_path)
    card = cards[cid]
    out = render_card(art, card)
    out_path = OUT / f'{cid}.png'
    out.save(out_path, optimize=True)
    print(f'  saved {out_path}')

print('Done.')
