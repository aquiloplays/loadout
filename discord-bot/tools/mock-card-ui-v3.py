"""Mock Boltbound card UI v2 — polished layout, no overlaps, no dead space.

Layout (top to bottom):
  [ MANA-GEM ][ NAME BANNER (centered) ][ TYPE PILL ]   <- 110 px header
  [ ART AREA (centered, big) ]                          <- 660 px (fills vertical)
  [ RARITY STRIP (full-width, thin) ]                   <- 24 px
  [ ATK | EFFECT-TEXT-PANEL | HP ]                      <- 200 px footer

Card: 720x1008 portrait. The footer's three-column layout guarantees
effect text never crosses into atk/hp circles.
"""
from __future__ import annotations
import json, subprocess
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT  = Path(__file__).resolve().parent.parent
FONTS = Path(__file__).resolve().parent / 'fonts'
V8_DIR = Path('/tmp/boltbound-pixel-cards-v8')
OUT    = Path('/tmp/boltbound-mock-cards-v3'); OUT.mkdir(exist_ok=True, parents=True)

W, H = 720, 1008

# Rarity → (primary, dark-accent) colors. Dark-accent used for the
# rarity strip + stroke fills to keep the design coherent.
RARITY = {
    'common':    {'fg': (148, 163, 184, 255), 'dark': ( 51,  65,  85, 255), 'name': 'COMMON'},
    'uncommon':  {'fg': ( 34, 197,  94, 255), 'dark': ( 21, 128,  61, 255), 'name': 'UNCOMMON'},
    'rare':      {'fg': ( 59, 130, 246, 255), 'dark': ( 30,  64, 175, 255), 'name': 'RARE'},
    'epic':      {'fg': (168,  85, 247, 255), 'dark': ( 88,  28, 135, 255), 'name': 'EPIC'},
    'legendary': {'fg': (250, 204,  21, 255), 'dark': (133,  77,  14, 255), 'name': 'LEGENDARY'},
    'champion':  {'fg': (244, 114, 182, 255), 'dark': (157,  23,  77, 255), 'name': 'CHAMPION'},
    'token':     {'fg': (148, 163, 184, 255), 'dark': ( 51,  65,  85, 255), 'name': 'TOKEN'},
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
    canvas = Image.new('RGBA', (W, H), (12, 8, 22, 255))
    draw = ImageDraw.Draw(canvas)
    rarity = (card.get('rarity') or 'common').lower()
    pal = RARITY.get(rarity, RARITY['common'])
    fg, dark = pal['fg'], pal['dark']

    # ── Outer rarity-toned border (thick top + bottom bands).
    band_h = 14
    draw.rectangle([0, 0, W, band_h], fill=fg)
    draw.rectangle([0, H - band_h, W, H], fill=fg)
    draw.rectangle([0, band_h, band_h, H - band_h], fill=fg)
    draw.rectangle([W - band_h, band_h, W, H - band_h], fill=fg)

    # ── Header band: mana + name + type (no overlap, fixed columns).
    hdr_y = band_h + 8
    hdr_h = 96
    # Header backdrop strip.
    draw.rectangle([band_h, hdr_y, W - band_h, hdr_y + hdr_h], fill=(22, 16, 38, 255))
    draw.rectangle([band_h, hdr_y + hdr_h - 3, W - band_h, hdr_y + hdr_h], fill=dark)

    # Mana gem — left column (locked area 100px wide).
    mana_col = (band_h + 12, hdr_y + 12, band_h + 100, hdr_y + hdr_h - 12)
    cx = (mana_col[0] + mana_col[2]) // 2
    cy = (mana_col[1] + mana_col[3]) // 2
    cr = 36
    # Outer glow gem.
    for o in (3, 0):
        draw.ellipse([cx-cr-o, cy-cr-o, cx+cr+o, cy+cr+o],
                     outline=fg if o else None,
                     fill=None if o else (155, 108, 255, 255),
                     width=3 if o else 0)
    draw.ellipse([cx-cr+6, cy-cr+6, cx+cr-6, cy+cr-6],
                 outline=(255, 255, 255, 90), width=2)
    mana = str(card.get('mana') or 0)
    mf = font(34, 'header')
    mw, mh = draw.textbbox((0, 0), mana, font=mf)[2:]
    draw.text((cx - mw/2, cy - mh/2 - 2), mana, font=mf,
              fill=(255, 255, 255, 255), stroke_width=3, stroke_fill=(0, 0, 0, 255))

    # Type pill — right column (locked area 130px wide).
    type_col_w = 130
    type_col = (W - band_h - type_col_w - 10, hdr_y + 24, W - band_h - 10, hdr_y + hdr_h - 24)
    draw.rounded_rectangle(type_col, radius=18, fill=dark, outline=fg, width=2)
    tlabel = (card.get('type') or '').upper()
    tf = font(15, 'header')
    tw, th = draw.textbbox((0, 0), tlabel, font=tf)[2:]
    type_cx = (type_col[0] + type_col[2]) // 2
    type_cy = (type_col[1] + type_col[3]) // 2
    draw.text((type_cx - tw/2, type_cy - th/2), tlabel, font=tf,
              fill=(255, 255, 255, 255))

    # Name banner — center column (between the two locked side columns).
    name_x0 = mana_col[2] + 16
    name_x1 = type_col[0] - 16
    name_w_max = name_x1 - name_x0 - 16
    name = card.get('name') or card['id']
    for sz in (28, 24, 22, 20, 18, 16, 14):
        nf = font(sz, 'header')
        if draw.textlength(name, font=nf) <= name_w_max: break
    nw = draw.textlength(name, font=nf)
    nh = draw.textbbox((0, 0), name, font=nf)[3]
    name_cx = (name_x0 + name_x1) // 2
    name_cy = (hdr_y + hdr_h // 2)
    draw.text((name_cx - nw/2, name_cy - nh/2 - 2), name, font=nf,
              fill=(255, 255, 255, 255), stroke_width=3, stroke_fill=(0, 0, 0, 255))

    # ── Art area — bigger, takes most of the vertical space.
    art_x = band_h + 4
    art_y = hdr_y + hdr_h + 6
    art_w = W - 2 * (band_h + 4)
    art_h = 596
    # Resize character art to fit the box with a slight crop.
    src = art_img.convert('RGBA')
    sw, sh = src.size
    target = art_w / art_h
    src_r = sw / sh
    if src_r > target:
        new_w = int(sh * target); x0 = (sw - new_w) // 2
        src = src.crop((x0, 0, x0 + new_w, sh))
    else:
        new_h = int(sw / target); y0 = (sh - new_h) // 2
        src = src.crop((0, y0, sw, y0 + new_h))
    src = src.resize((art_w, art_h), Image.NEAREST)
    canvas.paste(src, (art_x, art_y), src)
    # Rarity-colored hairline around the art.
    draw.rectangle([art_x-2, art_y-2, art_x+art_w+1, art_y+art_h+1],
                   outline=fg, width=3)

    # ── Rarity strip — thin full-width band between art and footer.
    strip_y = art_y + art_h + 10
    strip_h = 26
    draw.rectangle([band_h, strip_y, W - band_h, strip_y + strip_h],
                   fill=dark, outline=fg, width=2)
    rf = font(12, 'header')
    rname = pal['name']
    rw, rh = draw.textbbox((0, 0), rname, font=rf)[2:]
    draw.text((W/2 - rw/2, strip_y + strip_h/2 - rh/2 - 1), rname,
              font=rf, fill=fg)

    # ── Footer: 3 columns — atk | effect | hp.
    foot_y = strip_y + strip_h + 8
    foot_h = H - foot_y - band_h - 8

    has_stats = card.get('type') in ('minion', 'champion') and (card.get('atk') or 0) > 0

    if has_stats:
        # Stat circles: fixed 110-wide columns. Effect text gets the
        # middle 500-wide column. Zero overlap by construction.
        col_w = 110
        # ATK left circle.
        ax = band_h + 8 + col_w // 2
        ay = foot_y + foot_h // 2
        ar = 42
        draw.ellipse([ax-ar, ay-ar, ax+ar, ay+ar],
                     fill=(220, 38, 38, 255), outline=(255, 255, 255, 255), width=4)
        atk = str(card.get('atk') or 0)
        asf = font(34, 'header')
        aw, ah = draw.textbbox((0, 0), atk, font=asf)[2:]
        draw.text((ax-aw/2, ay-ah/2-2), atk, font=asf,
                  fill=(255, 255, 255, 255), stroke_width=2, stroke_fill=(80, 10, 10, 255))
        # HP right circle.
        hx = W - band_h - 8 - col_w // 2
        draw.ellipse([hx-ar, ay-ar, hx+ar, ay+ar],
                     fill=(34, 197, 94, 255), outline=(255, 255, 255, 255), width=4)
        hp = str(card.get('hp') or 0)
        hw, hh = draw.textbbox((0, 0), hp, font=asf)[2:]
        draw.text((hx-hw/2, ay-hh/2-2), hp, font=asf,
                  fill=(255, 255, 255, 255), stroke_width=2, stroke_fill=(10, 60, 20, 255))
        # Effect text panel — center column.
        eff_x0 = band_h + 8 + col_w + 20
        eff_x1 = W - band_h - 8 - col_w - 20
    else:
        # No stats — effect text uses the whole footer width.
        eff_x0 = band_h + 16
        eff_x1 = W - band_h - 16

    # Effect text panel — boxed with dark fill so text never visually
    # mixes with anything around it.
    panel_y0 = foot_y + 4
    panel_y1 = foot_y + foot_h - 4
    draw.rounded_rectangle([eff_x0, panel_y0, eff_x1, panel_y1],
                           radius=12, fill=(22, 16, 38, 240),
                           outline=fg, width=2)
    eff_max_w = (eff_x1 - eff_x0) - 24
    panel_h_usable = (panel_y1 - panel_y0) - 16
    eff = (card.get('text') or '').strip()
    if not eff:
        eff = (', '.join(k.upper() for k in (card.get('keywords') or []))
               or 'Vanilla minion.')

    # Auto-GROW font: start big, shrink only if wrapped text overflows
    # the panel. Short text gets big legible glyphs (no tiny placeholder
    # in a huge box). Long text shrinks just enough to fit.
    chosen = None
    for sz in (44, 40, 36, 32, 28, 26, 24, 22, 20, 18, 16):
        ef = font(sz, 'body')
        lines = wrap(draw, eff, ef, eff_max_w)
        line_h = draw.textbbox((0, 0), 'Mg', font=ef)[3] + 4
        total_h = len(lines) * line_h
        if total_h <= panel_h_usable:
            chosen = (ef, lines, line_h, total_h); break
    if chosen is None:
        ef = font(16, 'body')
        line_h = draw.textbbox((0, 0), 'Mg', font=ef)[3] + 4
        max_lines = max(1, panel_h_usable // line_h)
        lines = wrap(draw, eff, ef, eff_max_w)[:max_lines]
        if lines and len(lines) == max_lines:
            lines[-1] = lines[-1].rstrip(' .,;') + '…'
        chosen = (ef, lines, line_h, len(lines) * line_h)
    ef, lines, line_h, total_h = chosen
    ey = panel_y0 + 8 + ((panel_h_usable - total_h) // 2)
    for i, ln in enumerate(lines):
        lw = draw.textlength(ln, font=ef)
        draw.text((eff_x0 + ((eff_x1 - eff_x0) - lw) // 2,
                   ey + i * line_h), ln, font=ef,
                  fill=(230, 220, 255, 255))

    return canvas

cards = load_cards()
SAMPLES = ['champ.warrior', 'u.firebolt', 'leg.nyx', 'undead.c034', 'spire.s01.embercrown']
for cid in SAMPLES:
    art_path = V8_DIR / f'{cid}.webp'
    if not art_path.exists():
        print(f'SKIP {cid}: no v8 art'); continue
    art = Image.open(art_path)
    out_path = OUT / f'{cid}.png'
    render_card(art, cards[cid]).save(out_path, optimize=True)
    print(f'  saved {out_path}')
print('Done.')
