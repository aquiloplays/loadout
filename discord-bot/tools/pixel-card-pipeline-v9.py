"""Pixel card pipeline v9 — Clay's spec.

ARCHITECTURE:
  1. Schnell generates ONLY the character/sprite/effect at 512x512.
     Prompt asks for: isolated subject, solid magenta background,
     no card frame, no text, no UI.
  2. Post-process: color-key the magenta background to transparent,
     then crop to the non-transparent bounding box. Guarantees no
     stray text or UI leakage gets into the card.
  3. Pillow builds the ENTIRE card at 1024x1024 — golden pixelated
     border, cosmic violet inner background, mana gem with the
     actual number, name banner with the actual name, stats line,
     keyword pills, type pill, effect-text panel.
  4. Sprite pastes into the art slot at center, scaled to fit.

This sidesteps Schnell's text-rendering weakness entirely — the AI
never renders text because the AI never renders a card.

Usage:
  REPLICATE_API_TOKEN=... python tools/pixel-card-pipeline-v9.py --validate
  REPLICATE_API_TOKEN=... python tools/pixel-card-pipeline-v9.py --full
"""
from __future__ import annotations
import argparse, io, json, os, subprocess, sys, time
from pathlib import Path
from typing import Any
import requests
from PIL import Image, ImageDraw, ImageFont

ROOT  = Path(__file__).resolve().parent.parent
FONTS = Path(__file__).resolve().parent / 'fonts'
OUT   = Path('/tmp/boltbound-pixel-cards-v9'); OUT.mkdir(exist_ok=True, parents=True)
(OUT / '_sprite').mkdir(exist_ok=True)
STATE = OUT / '_state.json'

TOKEN = os.environ.get('REPLICATE_API_TOKEN')
MODEL_URL = 'https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions'
PACING_S = 14

# Final card canvas — 1024x1024 square, matches the Discord embed
# aspect that Boltbound already uses.
CARD_W = CARD_H = 1024

# Rarity styling — frame palette + accent.
RARITY = {
    'common':    {'fg':(148,163,184,255), 'dark':(51,65,85,255),   'name':'COMMON'},
    'uncommon':  {'fg':(34,197,94,255),   'dark':(21,128,61,255),  'name':'UNCOMMON'},
    'rare':      {'fg':(59,130,246,255),  'dark':(30,64,175,255),  'name':'RARE'},
    'epic':      {'fg':(168,85,247,255),  'dark':(88,28,135,255),  'name':'EPIC'},
    'legendary': {'fg':(250,204,21,255),  'dark':(133,77,14,255),  'name':'LEGENDARY'},
    'champion':  {'fg':(244,114,182,255), 'dark':(157,23,77,255),  'name':'CHAMPION'},
    'token':     {'fg':(148,163,184,255), 'dark':(51,65,85,255),   'name':'TOKEN'},
}

COSMIC_VIOLET     = (24, 16, 48, 255)
COSMIC_VIOLET_TOP = (40, 20, 70, 255)
GOLD              = (250, 204, 21, 255)
AURORA_PINK       = (244, 114, 182, 255)

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
    if r.returncode != 0: raise RuntimeError(r.stderr)
    return json.loads(r.stdout)

# ── Sprite generation ────────────────────────────────────────────────

def sprite_prompt(card):
    name = card.get('name') or card['id']
    eff  = (card.get('text') or '').strip() or ''
    t    = card.get('type') or 'minion'
    # Per Clay: spell → effect visualisation. Champion/minion → sprite.
    if t == 'spell':
        subject = (
            f"a glowing pixel-art spell effect representing '{name}'"
            + (f" (a spell that {eff})" if eff else "")
            + ". Just the magical effect, no characters"
        )
    elif t == 'champion':
        subject = (
            f"a noble pixel-art champion character representing '{name}', "
            "heroic full-body sprite, SNES JRPG Final Fantasy VI hero-sprite "
            "style with violet and gold trim"
        )
    else:
        subject = (
            f"a pixel-art battle sprite character representing '{name}', "
            "full-body, SNES JRPG / Chrono Trigger battle-sprite style with "
            "violet and aurora-pink accents"
        )
    return (
        f"16-bit pixel art, {subject}. Classic SNES Final Fantasy VI / "
        "Chrono Trigger sprite style, vibrant 16-color palette with violet "
        "and aurora-pink accents, crisp pixel edges, dithering shadows, "
        "idle action pose. The subject is centered and fills most of the "
        "canvas. Solid uniform bright magenta background (hex FF00FF, no "
        "texture, no gradient, completely flat color, no shapes, no "
        "patterns) — the magenta IS the background and will be removed in "
        "post-processing. NO card frame, NO banner, NO text, NO letters, "
        "NO numbers, NO border, NO UI elements, NO buttons. Just the pixel "
        "art subject on the flat magenta backdrop."
    )

def generate_sprite(card):
    body = {'input': {
        'prompt': sprite_prompt(card),
        'aspect_ratio': '1:1', 'output_format': 'webp', 'output_quality': 95,
        'num_outputs': 1, 'seed': abs(hash(card['id'])) % (2**31),
        'go_fast': True, 'megapixels': '0.25',     # 512x512 — Clay's spec
    }}
    while True:
        r = requests.post(MODEL_URL, json=body, timeout=60,
                          headers={'Authorization': f'Bearer {TOKEN}', 'Prefer': 'wait=10'})
        if r.status_code == 429:
            try: delay = (r.json().get('retry_after') or 15) + 2
            except: delay = 17
            print(f'  429 sleep {delay}s'); time.sleep(delay); continue
        if not r.ok: raise RuntimeError(f'{r.status_code} {r.text[:200]}')
        break
    p = r.json()
    while p.get('status') in ('starting','processing'):
        time.sleep(1.2)
        p = requests.get(p['urls']['get'], headers={'Authorization':f'Bearer {TOKEN}'}).json()
    if p.get('status') != 'succeeded': raise RuntimeError(p.get('status'))
    url = p['output'][0] if isinstance(p['output'], list) else p['output']
    return requests.get(url, timeout=60).content

# ── Post-process: color-key magenta + crop to content bounds ────────

def isolate_sprite(img: Image.Image) -> Image.Image:
    """Color-key the magenta/pink background, then crop to non-
    transparent content bounding box.

    Schnell drifts the requested FF00FF magenta to various pink/red
    hues. Detection: R high, G low, and R-G separation big — catches
    everything from pure magenta to bright pink to red-pink without
    eating character outlines (which are dark) or warm character
    tints (which have moderate G)."""
    img = img.convert('RGBA')
    import numpy as np
    arr = np.array(img)
    R = arr[..., 0].astype(np.int16)
    G = arr[..., 1].astype(np.int16)
    B = arr[..., 2].astype(np.int16)
    # Background = "very pink/magenta" — high R, low G, R much greater
    # than G. Loose on B (lets us catch hot pink, magenta, fuchsia).
    is_bg = (R > 200) & (G < 110) & ((R - G) > 110) & (B > 80)
    arr[..., 3] = np.where(is_bg, 0, arr[..., 3])
    img = Image.fromarray(arr, 'RGBA')
    bbox = img.getbbox()
    if bbox: img = img.crop(bbox)
    return img

# ── Pillow card frame ───────────────────────────────────────────────

def font(size, style='header'):
    fn = 'PressStart2P-Regular.ttf' if style=='header' else 'VT323-Regular.ttf'
    try: return ImageFont.truetype(str(FONTS / fn), size)
    except OSError: return ImageFont.load_default()

def wrap(draw, text, fnt, max_w):
    if not text: return []
    words = text.split(); lines, cur = [], ''
    for w in words:
        trial = (cur + ' ' + w).strip()
        if draw.textlength(trial, font=fnt) <= max_w: cur = trial
        else:
            if cur: lines.append(cur)
            cur = w
    if cur: lines.append(cur)
    return lines

def build_card(sprite: Image.Image, card: dict[str, Any]) -> Image.Image:
    rarity = (card.get('rarity') or 'common').lower()
    pal = RARITY.get(rarity, RARITY['common'])
    fg, dark = pal['fg'], pal['dark']

    # Base canvas — cosmic violet vertical gradient.
    canvas = Image.new('RGBA', (CARD_W, CARD_H), COSMIC_VIOLET)
    grad = ImageDraw.Draw(canvas)
    for y in range(CARD_H):
        t = y / CARD_H
        r = int(COSMIC_VIOLET_TOP[0] * (1-t) + COSMIC_VIOLET[0] * t)
        g = int(COSMIC_VIOLET_TOP[1] * (1-t) + COSMIC_VIOLET[1] * t)
        b = int(COSMIC_VIOLET_TOP[2] * (1-t) + COSMIC_VIOLET[2] * t)
        grad.line([(0, y), (CARD_W, y)], fill=(r, g, b, 255))
    draw = ImageDraw.Draw(canvas)

    # ── Pixelated golden border (Style 2 look) ─────────
    border = 16
    # Outer gold band.
    draw.rectangle([0, 0, CARD_W, border], fill=GOLD)
    draw.rectangle([0, CARD_H - border, CARD_W, CARD_H], fill=GOLD)
    draw.rectangle([0, 0, border, CARD_H], fill=GOLD)
    draw.rectangle([CARD_W - border, 0, CARD_W, CARD_H], fill=GOLD)
    # Inner dark trim for the chunky pixel feel.
    draw.rectangle([border, border, CARD_W - border, border + 4], fill=dark)
    draw.rectangle([border, CARD_H - border - 4, CARD_W - border, CARD_H - border], fill=dark)
    draw.rectangle([border, border, border + 4, CARD_H - border], fill=dark)
    draw.rectangle([CARD_W - border - 4, border, CARD_W - border, CARD_H - border], fill=dark)
    # Corner pixel rivets in rarity color.
    for cx, cy in ((50, 50), (CARD_W - 50, 50),
                   (50, CARD_H - 50), (CARD_W - 50, CARD_H - 50)):
        draw.rectangle([cx-12, cy-12, cx+12, cy+12], fill=fg, outline=dark, width=3)

    # ── Header: mana | name | type pill (3-column fixed) ─────────
    hdr_y = border + 24
    hdr_h = 96
    # Mana gem (top-left).
    mx, my, mr = 110, hdr_y + hdr_h//2, 44
    draw.ellipse([mx-mr-3, my-mr-3, mx+mr+3, my+mr+3], outline=GOLD, width=4)
    draw.ellipse([mx-mr, my-mr, mx+mr, my+mr], fill=(155, 108, 255, 255))
    draw.ellipse([mx-mr+8, my-mr+8, mx-12, my-8],
                 outline=None, fill=(220, 200, 255, 100))
    mana = str(card.get('mana') or 0)
    mf = font(40, 'header')
    mw, mh = draw.textbbox((0,0), mana, font=mf)[2:]
    draw.text((mx - mw/2, my - mh/2 - 4), mana, font=mf,
              fill=(255,255,255,255), stroke_width=3, stroke_fill=(0,0,0,255))

    # Type pill (top-right).
    tlabel = (card.get('type') or '').upper()
    tf = font(18, 'header')
    tw, th = draw.textbbox((0,0), tlabel, font=tf)[2:]
    pill_x1 = CARD_W - 50
    pill_x0 = pill_x1 - tw - 36
    pill_y0 = hdr_y + hdr_h//2 - 22
    pill_y1 = hdr_y + hdr_h//2 + 22
    draw.rounded_rectangle([pill_x0, pill_y0, pill_x1, pill_y1],
                           radius=22, fill=dark, outline=fg, width=3)
    draw.text((pill_x0 + (pill_x1-pill_x0-tw)/2,
               pill_y0 + (pill_y1-pill_y0-th)/2 - 1),
              tlabel, font=tf, fill=(255,255,255,255))

    # Name banner (center column).
    name_x0 = mx + mr + 30
    name_x1 = pill_x0 - 30
    name_max_w = name_x1 - name_x0 - 24
    name = card.get('name') or card['id']
    for sz in (36, 32, 28, 24, 22, 20, 18, 16):
        nf = font(sz, 'header')
        if draw.textlength(name, font=nf) <= name_max_w: break
    nw = draw.textlength(name, font=nf)
    nh = draw.textbbox((0,0), name, font=nf)[3]
    name_cx = (name_x0 + name_x1) // 2
    name_cy = hdr_y + hdr_h//2
    draw.text((name_cx - nw/2, name_cy - nh/2 - 2),
              name, font=nf, fill=(255,255,255,255),
              stroke_width=3, stroke_fill=(0,0,0,255))

    # ── Art panel (sprite goes here) ─────────
    art_x = border + 24
    art_y = hdr_y + hdr_h + 16
    art_w = CARD_W - 2*(border + 24)
    art_h = 600
    # Art backdrop — inner cosmic with a subtle radial highlight.
    draw.rectangle([art_x, art_y, art_x+art_w, art_y+art_h],
                   fill=(18, 12, 36, 255), outline=fg, width=4)
    # Soft glow behind where the sprite will sit.
    cx, cy = art_x + art_w//2, art_y + art_h//2
    for rr in range(280, 0, -40):
        alpha = max(0, 36 - (rr // 12))
        draw.ellipse([cx-rr, cy-rr, cx+rr, cy+rr],
                     fill=(155, 108, 255, alpha))
    # Paste the sprite, scaled to fit with margin.
    sw, sh = sprite.size
    max_sw = int(art_w * 0.85)
    max_sh = int(art_h * 0.90)
    scale = min(max_sw / sw, max_sh / sh)
    new_w, new_h = max(1, int(sw * scale)), max(1, int(sh * scale))
    spr = sprite.resize((new_w, new_h), Image.NEAREST)
    canvas.paste(spr, (cx - new_w//2, cy - new_h//2 + 30), spr)
    draw = ImageDraw.Draw(canvas)

    # ── Rarity strip ─────────
    strip_y = art_y + art_h + 12
    strip_h = 32
    draw.rectangle([border + 24, strip_y, CARD_W - border - 24, strip_y + strip_h],
                   fill=dark, outline=fg, width=3)
    rf = font(14, 'header')
    rname = pal['name']
    rw, rh = draw.textbbox((0,0), rname, font=rf)[2:]
    draw.text((CARD_W//2 - rw//2, strip_y + (strip_h - rh)//2 - 2),
              rname, font=rf, fill=fg)

    # ── Footer: 3-col (atk | effect | hp) ─────────
    foot_y = strip_y + strip_h + 14
    foot_h = CARD_H - foot_y - border - 22

    has_stats = card.get('type') in ('minion','champion') and (card.get('atk') or 0) > 0
    if has_stats:
        col_w = 130
        ax = border + 24 + col_w//2
        ay = foot_y + foot_h//2
        ar = 52
        draw.ellipse([ax-ar, ay-ar, ax+ar, ay+ar],
                     fill=(220,38,38,255), outline=(255,255,255,255), width=4)
        atk = str(card.get('atk') or 0)
        asf = font(42, 'header')
        aw, ah = draw.textbbox((0,0), atk, font=asf)[2:]
        draw.text((ax - aw/2, ay - ah/2 - 2), atk, font=asf,
                  fill=(255,255,255,255), stroke_width=3, stroke_fill=(80,10,10,255))
        hx = CARD_W - border - 24 - col_w//2
        draw.ellipse([hx-ar, ay-ar, hx+ar, ay+ar],
                     fill=(34,197,94,255), outline=(255,255,255,255), width=4)
        hp = str(card.get('hp') or 0)
        hw, hh = draw.textbbox((0,0), hp, font=asf)[2:]
        draw.text((hx - hw/2, ay - hh/2 - 2), hp, font=asf,
                  fill=(255,255,255,255), stroke_width=3, stroke_fill=(10,60,20,255))
        eff_x0 = border + 24 + col_w + 24
        eff_x1 = CARD_W - border - 24 - col_w - 24
    else:
        eff_x0 = border + 32
        eff_x1 = CARD_W - border - 32

    # Effect text panel — dark backdrop, rarity hairline, auto-grow font.
    panel_y0 = foot_y + 4
    panel_y1 = foot_y + foot_h - 4
    draw.rounded_rectangle([eff_x0, panel_y0, eff_x1, panel_y1],
                           radius=14, fill=(22, 16, 38, 235),
                           outline=fg, width=3)
    eff_max_w = (eff_x1 - eff_x0) - 32
    panel_h_usable = (panel_y1 - panel_y0) - 20

    eff = (card.get('text') or '').strip()
    if not eff:
        eff = (', '.join(k.upper() for k in (card.get('keywords') or []))
               or 'Vanilla minion.')

    chosen = None
    for sz in (46, 42, 38, 34, 30, 26, 24, 22, 20, 18, 16):
        ef = font(sz, 'body')
        lines = wrap(draw, eff, ef, eff_max_w)
        line_h = draw.textbbox((0,0), 'Mg', font=ef)[3] + 4
        total_h = len(lines) * line_h
        if total_h <= panel_h_usable:
            chosen = (ef, lines, line_h, total_h); break
    if chosen is None:
        ef = font(16, 'body')
        line_h = draw.textbbox((0,0), 'Mg', font=ef)[3] + 4
        max_lines = max(1, panel_h_usable // line_h)
        lines = wrap(draw, eff, ef, eff_max_w)[:max_lines]
        if lines and len(lines) == max_lines:
            lines[-1] = lines[-1].rstrip(' .,;') + '…'
        chosen = (ef, lines, line_h, len(lines) * line_h)
    ef, lines, line_h, total_h = chosen
    ey = panel_y0 + 10 + ((panel_h_usable - total_h) // 2)
    for i, ln in enumerate(lines):
        lw = draw.textlength(ln, font=ef)
        draw.text((eff_x0 + ((eff_x1 - eff_x0) - lw) // 2,
                   ey + i * line_h), ln, font=ef,
                  fill=(230, 220, 255, 255))

    # ── Keyword pills (above the effect panel, inline row) ─────────
    kws = [k.upper() for k in (card.get('keywords') or [])][:3]
    if kws:
        kf = font(14, 'header')
        pill_y = strip_y - 50
        # Pre-measure to center the row.
        pill_widths = []
        for k in kws:
            pw, ph = draw.textbbox((0,0), k, font=kf)[2:]
            pill_widths.append(pw + 28)
        total_w = sum(pill_widths) + 12 * (len(kws) - 1)
        cur_x = (CARD_W - total_w) // 2
        for k, pw in zip(kws, pill_widths):
            draw.rounded_rectangle([cur_x, pill_y, cur_x + pw, pill_y + 28],
                                   radius=14, fill=AURORA_PINK, outline=(0,0,0,255), width=2)
            kw_w = draw.textbbox((0,0), k, font=kf)[2]
            draw.text((cur_x + (pw - kw_w)//2, pill_y + 6), k,
                      font=kf, fill=(24,16,48,255))
            cur_x += pw + 12

    return canvas

# ── Pipeline driver ──────────────────────────────────────────────────

VALIDATION = ['champ.warrior','u.firebolt','leg.nyx','undead.c034','spire.s01.embercrown']

def load_state(): return json.loads(STATE.read_text()) if STATE.exists() else {'done':[],'failed':{}}
def save_state(s): STATE.write_text(json.dumps(s, indent=2))

def process_card(card):
    cid = card['id']
    out_png = OUT / f'{cid}.png'
    sprite_path = OUT / '_sprite' / f'{cid}.webp'
    if out_png.exists(): return True
    print(f'  [{cid}] {card["name"]}')
    if sprite_path.exists():
        raw = sprite_path.read_bytes(); print('    cached sprite')
    else:
        raw = generate_sprite(card)
        sprite_path.write_bytes(raw)
        print(f'    sprite generated ({len(raw)//1024} KB)')
        time.sleep(PACING_S)
    sprite = isolate_sprite(Image.open(io.BytesIO(raw)))
    print(f'    sprite isolated → {sprite.size}')
    canvas = build_card(sprite, card)
    canvas.save(out_png, optimize=True)
    print(f'    saved {out_png}')

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--validate', action='store_true')
    ap.add_argument('--full', action='store_true')
    ap.add_argument('--resume', action='store_true')
    args = ap.parse_args()
    if not TOKEN: print('REPLICATE_API_TOKEN required'); sys.exit(1)
    cards = load_cards()
    ids = VALIDATION if args.validate else list(cards.keys())
    state = load_state() if args.resume else {'done':[],'failed':{}}
    done = set(state['done'])
    started = time.time()
    for i, cid in enumerate(ids, 1):
        card = cards.get(cid)
        if not card or cid in done: continue
        try:
            print(f'[{i}/{len(ids)}]')
            process_card(card)
            state['done'].append(cid)
        except Exception as e:
            print(f'    FAIL {e}'); state['failed'][cid] = str(e)
        if i % 10 == 0: save_state(state)
        if i % 250 == 0:
            mins = (time.time()-started)/60
            print(f'\n=== {i}/{len(ids)} · {mins:.1f} min ===\n')
    save_state(state)
    print(f'\nDone. {len(state["done"])} ok, {len(state["failed"])} fail.')

if __name__ == '__main__': main()
