#!/usr/bin/env python3
"""Render the Triple-C + Variety-Night poll composite PNGs.

Each composite is a grid of Steam header-art tiles with the game name
captioned underneath. Variety-Night tiles flagged with `cc=True` get a
Crowd Control icon overlay in the top-right corner.

Inputs are hardcoded below to match the poll catalogue Clay specified
in the 2026-05-28 queue. Run from repo root:

    python build-poll-composite.py

Outputs:
    discord-bot/assets/polls/triple-c.png   — 23-tile 5x5 grid (2 cells blank)
    discord-bot/assets/polls/variety.png    —  12-tile 4x3 grid (full)
"""

import io
import os
import urllib.request

from PIL import Image, ImageDraw, ImageFont, ImageFilter

# ── Palette (aquilo v2) ──────────────────────────────────────────
VIOLET    = (124,  92, 255, 255)   # #7c5cff
PINK      = (255, 106, 181, 255)
GREEN     = ( 91, 255, 149, 255)
DARK_BG   = ( 21,  22,  32, 255)   # near-black canvas
TILE_BG   = ( 30,  34,  48, 255)   # slot fill when art fails
CAPTION_BG= ( 12,  14,  22, 230)   # caption strip
CAPTION_FG= (235, 238, 248, 255)
CC_RED    = (255,  78,  80, 255)   # crowd control brand
WHITE     = (255, 255, 255, 255)

# ── Layout ───────────────────────────────────────────────────────
TILE_W      = 280
TILE_H      = 130     # roughly the Steam header aspect (460:215 scaled)
CAPTION_H   = 28
GUTTER      = 12
PAD         = 28
CORNER_RAD  = 12
CC_BADGE_PX = 36      # diameter of the CC icon overlay
SHADOW_DROP = (1, 2)
TITLE_PT    = 34
CAPTION_PT  = 14

# ── Catalogues ───────────────────────────────────────────────────
# Each tuple: (name, appid_or_None, cc_supported).  appid=None falls
# back to a generated placeholder tile (used for Minecraft).

TRIPLE_C = [
    ('Fallout 4',                    '377160',  False),
    ('Elden Ring',                   '1245620', False),
    ('Skyrim (Special Edition)',     '489830',  False),
    ('Borderlands 2',                '49520',   False),
    ('Borderlands 3',                '397540',  False),
    ('The Witcher 3',                '292030',  False),
    ('Cyberpunk 2077',               '1091500', False),
    ('Resident Evil 2 - 7',          '883710',  False),   # uses RE2 Remake art
    ('Metal Gear Solid DELTA',       '2417610', False),
    ('Minecraft (ender dragon)',     None,      False),   # placeholder
    ('Baby Steps',                   '1281040', False),
    ('HADES',                        '1145360', False),
    ('Hollow Knight',                '367520',  False),
    ('Hollow Knight: Silksong',      '1030300', False),
    ('Kingdom Come: Deliverance 2',  '1771300', False),
    ('Blue Prince',                  '2890190', False),
    ("Baldur's Gate 3",              '1086940', False),
    ('DREDGE',                       '1562430', False),
    ('Stardew Valley',               '413150',  False),
    ('Celeste',                      '504230',  False),
    ('Cult of the Lamb',             '1313140', False),
    ('Red Dead Redemption 2',        '1174180', False),
    ('The Binding of Isaac',         '250900',  False),
]

VARIETY = [
    ('Waterpark Simulator',          '3293260', True),
    ('Retro Rewind',                 '3552140', True),
    ('Slay the Spire 2',             '2868840', True),
    ('Roadside Research',            '3643170', False),
    ('Supermarket Simulator',        '2670400', True),
    ('Vampire Crawlers',             '3265700', True),
    ('Megabonk',                     '3405340', True),
    ('Subnautica 2',                 '1962700', False),
    ('Paralives',                    '1118520', False),
    ('PowerWash Simulator 2',        '2968420', False),
    ('House Flipper 2',              '1190590', False),
    ('Ranch Simulator',              '1119730', False),
]

# Steam CDN URL candidates — try header.jpg first, then library_600x900,
# then capsule_616x353 + the alternate Akamai mirror. Newer titles (post-
# 2024-ish) sometimes lack the legacy header.jpg slot.
STEAM_URL_CANDIDATES = [
    'https://cdn.cloudflare.steamstatic.com/steam/apps/{}/header.jpg',
    'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/{}/header.jpg',
    'https://cdn.akamai.steamstatic.com/steam/apps/{}/header.jpg',
    'https://cdn.cloudflare.steamstatic.com/steam/apps/{}/library_600x900.jpg',
    'https://cdn.cloudflare.steamstatic.com/steam/apps/{}/capsule_616x353.jpg',
    'https://cdn.cloudflare.steamstatic.com/steam/apps/{}/capsule_231x87.jpg',
]

# ── Font finder ──────────────────────────────────────────────────
def find_font(size, bold=False):
    candidates = [
        r'C:\Windows\Fonts\segoeuib.ttf' if bold else r'C:\Windows\Fonts\segoeui.ttf',
        r'C:\Windows\Fonts\arialbd.ttf'  if bold else r'C:\Windows\Fonts\arial.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf' if bold
            else '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    ]
    for c in candidates:
        try:
            return ImageFont.truetype(c, size)
        except OSError:
            continue
    return ImageFont.load_default()


# ── Tile builders ────────────────────────────────────────────────
def fetch_steam_art(appid):
    """Returns a PIL.Image (any aspect; caller resizes) or None.
    Tries the legacy CDN paths first, then falls back to the appdetails
    API to dig out the current header_image URL — newer titles use a
    hashed store_item_assets path that we can't predict ahead of time."""
    import json
    last_err = None
    for template in STEAM_URL_CANDIDATES:
        url = template.format(appid)
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'aquilo-poll-composite'})
            with urllib.request.urlopen(req, timeout=15) as r:
                data = r.read()
            return Image.open(io.BytesIO(data)).convert('RGBA')
        except Exception as e:
            last_err = e
            continue
    # Fall back to the appdetails API to resolve the current header URL.
    try:
        api = f'https://store.steampowered.com/api/appdetails?appids={appid}&filters=basic'
        req = urllib.request.Request(api, headers={'User-Agent': 'aquilo-poll-composite'})
        with urllib.request.urlopen(req, timeout=15) as r:
            j = json.loads(r.read().decode('utf-8'))
        rec = j.get(str(appid))
        if rec and rec.get('success'):
            hdr = rec['data'].get('header_image')
            if hdr:
                req = urllib.request.Request(hdr, headers={'User-Agent': 'aquilo-poll-composite'})
                with urllib.request.urlopen(req, timeout=15) as r:
                    data = r.read()
                return Image.open(io.BytesIO(data)).convert('RGBA')
    except Exception as e:
        last_err = e
    print(f'  !  steam {appid} no asset found ({last_err})')
    return None


def rounded_mask(width, height, radius):
    scale = 4
    m = Image.new('L', (width * scale, height * scale), 0)
    ImageDraw.Draw(m).rounded_rectangle(
        (0, 0, width * scale, height * scale),
        radius=radius * scale, fill=255)
    return m.resize((width, height), Image.LANCZOS)


def render_minecraft_placeholder(width, height):
    """Block-style green canvas with 'MINECRAFT' lettering."""
    img = Image.new('RGBA', (width, height), (76, 144, 44, 255))   # mc grass green
    draw = ImageDraw.Draw(img)
    # Dirt strip along the bottom for vibes.
    draw.rectangle((0, int(height * 0.55), width, height), fill=(120, 80, 50, 255))
    # Title.
    f = find_font(28, bold=True)
    bbox = draw.textbbox((0, 0), 'MINECRAFT', font=f)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    tx = (width - tw) // 2 - bbox[0]
    ty = int(height * 0.18) - bbox[1]
    # Shadow.
    draw.text((tx + 2, ty + 2), 'MINECRAFT', font=f, fill=(0, 0, 0, 180))
    draw.text((tx, ty), 'MINECRAFT', font=f, fill=WHITE)
    # Sub-line.
    f2 = find_font(11)
    sub = 'beat the ender dragon'
    bbox2 = draw.textbbox((0, 0), sub, font=f2)
    sw = bbox2[2] - bbox2[0]
    draw.text(((width - sw) // 2, int(height * 0.7)), sub, font=f2, fill=(255, 255, 220, 230))
    return img


def build_tile(name, appid, cc, cc_icon):
    canvas = Image.new('RGBA', (TILE_W, TILE_H + CAPTION_H), (0, 0, 0, 0))
    # Art area.
    if appid is None:
        art = render_minecraft_placeholder(TILE_W, TILE_H)
    else:
        raw = fetch_steam_art(appid)
        if raw is None:
            art = Image.new('RGBA', (TILE_W, TILE_H), TILE_BG)
            d = ImageDraw.Draw(art)
            d.text((12, TILE_H // 2 - 8), 'art unavailable', font=find_font(11),
                   fill=CAPTION_FG)
        else:
            art = raw.resize((TILE_W, TILE_H), Image.LANCZOS)
    canvas.paste(art, (0, 0))
    # CC overlay top-right.
    if cc and cc_icon is not None:
        icon = cc_icon.copy()
        ico_w, ico_h = icon.size
        # Subtle shadow first.
        shadow = Image.new('RGBA', (ico_w + 6, ico_h + 6), (0, 0, 0, 0))
        ImageDraw.Draw(shadow).ellipse((3, 3, ico_w + 3, ico_h + 3), fill=(0, 0, 0, 110))
        shadow = shadow.filter(ImageFilter.GaussianBlur(radius=2))
        cx = TILE_W - ico_w - 8
        cy = 8
        canvas.alpha_composite(shadow, (cx - 3, cy - 3))
        canvas.alpha_composite(icon, (cx, cy))
    # Caption strip.
    cap = Image.new('RGBA', (TILE_W, CAPTION_H), CAPTION_BG)
    draw = ImageDraw.Draw(cap)
    f = find_font(CAPTION_PT, bold=True)
    text = name
    bbox = draw.textbbox((0, 0), text, font=f)
    while bbox[2] - bbox[0] > TILE_W - 14 and len(text) > 4:
        text = text[:-2] + '…'
        bbox = draw.textbbox((0, 0), text, font=f)
    draw.text((8, (CAPTION_H - (bbox[3] - bbox[1])) // 2 - bbox[1]),
              text, font=f, fill=CAPTION_FG)
    canvas.paste(cap, (0, TILE_H))
    # Rounded corners.
    mask = rounded_mask(TILE_W, TILE_H + CAPTION_H, CORNER_RAD)
    out = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
    out.paste(canvas, (0, 0), mask)
    return out


# ── CC badge ────────────────────────────────────────────────────
def build_cc_badge():
    """Round red badge with white 'CC' lettering — branded but not the
    official SVG (avoids redistribution issues + works offline)."""
    badge = Image.new('RGBA', (CC_BADGE_PX, CC_BADGE_PX), (0, 0, 0, 0))
    d = ImageDraw.Draw(badge)
    d.ellipse((0, 0, CC_BADGE_PX, CC_BADGE_PX), fill=CC_RED, outline=WHITE, width=2)
    f = find_font(int(CC_BADGE_PX * 0.46), bold=True)
    bbox = d.textbbox((0, 0), 'CC', font=f)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    d.text(((CC_BADGE_PX - tw) // 2 - bbox[0],
            (CC_BADGE_PX - th) // 2 - bbox[1] - 1),
           'CC', font=f, fill=WHITE)
    return badge


# ── Grid renderer ────────────────────────────────────────────────
def render_grid(catalog, cols, title, subtitle, out_path, cc_icon):
    rows = (len(catalog) + cols - 1) // cols
    tile_total_h = TILE_H + CAPTION_H
    title_block_h = 90 if title else 0
    canvas_w = PAD * 2 + cols * TILE_W + (cols - 1) * GUTTER
    canvas_h = PAD + title_block_h + rows * tile_total_h + (rows - 1) * GUTTER + PAD
    canvas = Image.new('RGBA', (canvas_w, canvas_h), DARK_BG)
    draw   = ImageDraw.Draw(canvas)
    # Title block.
    if title:
        f_title = find_font(TITLE_PT, bold=True)
        f_sub   = find_font(15)
        draw.text((PAD, PAD), title, font=f_title, fill=WHITE)
        draw.text((PAD, PAD + TITLE_PT + 8), subtitle, font=f_sub,
                  fill=(180, 188, 210, 255))
    # Tiles.
    for idx, (name, appid, cc) in enumerate(catalog):
        col = idx % cols
        row = idx // cols
        x = PAD + col * (TILE_W + GUTTER)
        y = PAD + title_block_h + row * (tile_total_h + GUTTER)
        print(f'  - {name}')
        tile = build_tile(name, appid, cc, cc_icon)
        canvas.alpha_composite(tile, (x, y))
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    canvas.save(out_path, 'PNG', optimize=True)
    size_kb = os.path.getsize(out_path) / 1024
    print(f'  -> {out_path}  ({canvas_w}x{canvas_h}, {size_kb:.1f} KB)')


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.join(here, 'discord-bot', 'assets', 'polls')
    cc_icon = build_cc_badge()
    print('Triple-C Series composite:')
    render_grid(
        TRIPLE_C, cols=5,
        title='Triple-C Series',
        subtitle='Sun · Mon · Tue · Thu — vote for the next game',
        out_path=os.path.join(out_dir, 'triple-c.png'),
        cc_icon=cc_icon,
    )
    print()
    print('Variety Night composite:')
    render_grid(
        VARIETY, cols=4,
        title='Variety Night',
        subtitle='Wed · Fri — CC icon = Crowd Control supported (crowdcontrol.live)',
        out_path=os.path.join(out_dir, 'variety.png'),
        cc_icon=cc_icon,
    )

if __name__ == '__main__':
    main()
