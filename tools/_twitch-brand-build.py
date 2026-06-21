"""Build Clay's prodigalttv Twitch branding set in the aquilo.gg aurora theme.

- Banner (1200x480): Flux aurora bg + PRODIGALTTV gold wordmark + aquilo.gg mark + sigil.
- 8 panels (320x100): pure CSS cosmic-aurora cards rendered by headless Chrome.
- Comparison sheet: banner + all 8 panels stacked (assembled with PIL).

All output -> repo root, untracked. NO deploy. Chrome headless at native dsf=1 for
exact pixel dimensions (plus a 2x pass for the panels to confirm retina crispness).
"""
import base64, subprocess, sys, tempfile
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
CHROME = r'C:\Program Files\Google\Chrome\Application\chrome.exe'
BG = ROOT / '_twitch-banner-bg.png'

# ---- aurora palette ---------------------------------------------------------
VIOLET = '#7c3aed'
TEAL   = '#06b6d4'
GOLD   = '#fbbf24'
GOLD_HI= '#fde68a'
GOLD_LO= '#f59e0b'

FONT_STACK = "'Inter','Segoe UI',Arial,sans-serif"
# Inter pulled from Google Fonts; Segoe UI is the offline fallback if no network.
FONT_IMPORT = "@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap');"

def b64(p: Path) -> str:
    return base64.b64encode(p.read_bytes()).decode('ascii')

def shoot(html: str, w: int, h: int, out: Path, scale: int = 1):
    """Render an HTML string to a PNG of exactly w*scale x h*scale via headless Chrome."""
    with tempfile.NamedTemporaryFile('w', suffix='.html', delete=False, encoding='utf-8') as fh:
        fh.write(html); tmp = Path(fh.name)
    try:
        cmd = [CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars',
               '--no-sandbox', '--force-device-scale-factor=' + str(scale),
               '--default-background-color=00000000',
               f'--screenshot={out}', f'--window-size={w},{h}',
               '--virtual-time-budget=4000', tmp.as_uri()]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if not out.exists():
            raise RuntimeError('chrome failed: ' + (r.stderr or r.stdout)[-500:])
    finally:
        try: tmp.unlink()
        except OSError: pass

# ---- banner -----------------------------------------------------------------
def banner_html() -> str:
    bg = b64(BG)
    # Hand-drawn aurora sigil: a stylized upward chevron (the north wind) inside a
    # soft ring, stroked with a violet->teal aurora gradient. Sparse, low opacity.
    sigil = f"""
    <svg class="sigil" viewBox="0 0 200 200" aria-hidden="true">
      <defs>
        <linearGradient id="aur" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="{TEAL}"/>
          <stop offset="0.55" stop-color="{VIOLET}"/>
          <stop offset="1" stop-color="{GOLD}"/>
        </linearGradient>
      </defs>
      <circle cx="100" cy="100" r="84" fill="none" stroke="url(#aur)" stroke-width="3" opacity="0.7"/>
      <circle cx="100" cy="100" r="84" fill="none" stroke="url(#aur)" stroke-width="10" opacity="0.18"/>
      <path d="M52 128 L100 58 L148 128" fill="none" stroke="url(#aur)"
            stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M70 138 L100 94 L130 138" fill="none" stroke="url(#aur)"
            stroke-width="7" stroke-linecap="round" stroke-linejoin="round" opacity="0.6"/>
    </svg>"""
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>
{FONT_IMPORT}
*{{margin:0;padding:0;box-sizing:border-box}}
html,body{{width:1200px;height:480px;overflow:hidden}}
.banner{{position:relative;width:1200px;height:480px;font-family:{FONT_STACK};
  background:#0a0a14 url('data:image/png;base64,{bg}') center/cover no-repeat;}}
/* left scrim so the wordmark stays legible over the aurora */
.scrim{{position:absolute;inset:0;background:
  linear-gradient(90deg, rgba(7,5,18,0.92) 0%, rgba(7,5,18,0.72) 26%, rgba(7,5,18,0.22) 46%, rgba(7,5,18,0) 60%);}}
/* faint top/bottom gloss + vignette */
.gloss{{position:absolute;inset:0;background:
  linear-gradient(180deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0) 24%),
  radial-gradient(120% 80% at 12% 30%, rgba(124,58,237,0.18), rgba(0,0,0,0) 60%);}}
.wrap{{position:absolute;left:64px;top:0;height:480px;display:flex;flex-direction:column;
  justify-content:center;gap:18px;z-index:3;}}
.kicker{{font-size:15px;font-weight:700;letter-spacing:7px;color:{TEAL};
  text-transform:uppercase;opacity:0.92;}}
.word{{font-size:78px;font-weight:900;letter-spacing:1px;line-height:0.96;
  text-transform:uppercase;
  background:linear-gradient(165deg,{GOLD_HI} 0%,{GOLD} 42%,{GOLD_LO} 100%);
  -webkit-background-clip:text;background-clip:text;color:transparent;
  filter:drop-shadow(0 3px 14px rgba(251,191,36,0.28));}}
.rule{{width:300px;height:3px;border-radius:3px;
  background:linear-gradient(90deg,{VIOLET},{TEAL} 70%,rgba(6,182,212,0));}}
.tag{{font-size:19px;font-weight:600;letter-spacing:1.5px;color:#e7e3f5;opacity:0.9;}}
.mark{{position:absolute;left:64px;bottom:30px;z-index:3;font-size:18px;font-weight:800;
  letter-spacing:2px;color:{TEAL};text-shadow:0 1px 10px rgba(6,182,212,0.4);}}
.mark span{{color:#9aa6c4;font-weight:600;}}
.sigil{{position:absolute;right:118px;top:50%;transform:translateY(-50%);
  width:230px;height:230px;z-index:2;opacity:0.62;
  filter:drop-shadow(0 0 22px rgba(124,58,237,0.35));}}
</style></head><body>
<div class="banner">
  <div class="scrim"></div>
  <div class="gloss"></div>
  {sigil}
  <div class="wrap">
    <div class="kicker">aquilo.gg presents</div>
    <div class="word">Prodigal<br>TTV</div>
    <div class="rule"></div>
    <div class="tag">Variety, Boltbound, and good company.</div>
  </div>
  <div class="mark">aquilo.gg <span>home base</span></div>
</div></body></html>"""

# ---- panels -----------------------------------------------------------------
# Sparse hand-drawn aurora SVG glyphs (stroke only, no fonts/emoji). One per panel.
ICONS = {
    'about':    '<circle cx="20" cy="20" r="15"/><line x1="20" y1="17" x2="20" y2="29"/><circle cx="20" cy="11.5" r="1.6" fill="currentColor" stroke="none"/>',
    'schedule': '<rect x="6" y="9" width="28" height="25" rx="3"/><line x1="6" y1="16" x2="34" y2="16"/><line x1="13" y1="5" x2="13" y2="12"/><line x1="27" y1="5" x2="27" y2="12"/>',
    'website':  '<circle cx="20" cy="20" r="15"/><ellipse cx="20" cy="20" rx="6.5" ry="15"/><line x1="5" y1="20" x2="35" y2="20"/>',
    'discord':  '<path d="M11 27 C7 21 7 14 10 10 L15 9 M29 27 C33 21 33 14 30 10 L25 9"/><ellipse cx="16" cy="20" rx="2.2" ry="3"/><ellipse cx="24" cy="20" rx="2.2" ry="3"/><path d="M12 27 C16 30 24 30 28 27"/>',
    'patreon':  '<circle cx="26" cy="15" r="9"/><line x1="9" y1="6" x2="9" y2="34"/>',
    'boltbound':'<path d="M22 5 L11 22 L19 22 L17 35 L29 17 L21 17 Z"/>',
    'tiktok':   '<path d="M21 6 L21 26 a6 6 0 1 1 -6 -6"/><path d="M21 6 C22 12 26 15 31 15"/>',
    'rules':    '<path d="M20 6 L31 11 V20 C31 28 26 32 20 35 C14 32 9 28 9 20 V11 Z"/><path d="M15 20 l4 4 l7 -8"/>',
}

PANELS = [
    ('about',     'ABOUT',     'Variety plus Boltbound, live from aquilo.gg'),
    ('schedule',  'SCHEDULE',  'Stream nights at aquilo.gg/community'),
    ('website',   'AQUILO.GG', 'Boltbound, mini-games, daily check-ins'),
    ('discord',   'DISCORD',   'Join the community, invite at aquilo.gg'),
    ('patreon',   'PATREON',   'Support the stream, unlock supporter perks'),
    ('boltbound', 'BOLTBOUND', 'The trading card game, free to play'),
    ('tiktok',    'TIKTOK',    'Daily clips, follow @prodigalttv'),
    ('rules',     'RULES',     'Be kind. No spam. Have fun.'),
]

def panel_html(key, title, sub) -> str:
    icon = ICONS[key]
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>
{FONT_IMPORT}
*{{margin:0;padding:0;box-sizing:border-box}}
html,body{{width:320px;height:100px;overflow:hidden}}
.p{{position:relative;width:320px;height:100px;font-family:{FONT_STACK};
  border-radius:10px;overflow:hidden;
  background:
    radial-gradient(120% 140% at 88% 12%, rgba(6,182,212,0.16), rgba(0,0,0,0) 55%),
    radial-gradient(120% 150% at 18% 96%, rgba(124,58,237,0.26), rgba(0,0,0,0) 60%),
    linear-gradient(135deg,#140a26 0%,#0c0a1c 52%,#0a0a14 100%);}}
/* hairline aurora top sheen + inner border */
.p::after{{content:"";position:absolute;inset:0;border-radius:10px;pointer-events:none;
  border:1px solid rgba(124,58,237,0.30);
  background:linear-gradient(180deg, rgba(255,255,255,0.07), rgba(255,255,255,0) 22%);}}
.strip{{position:absolute;left:0;top:0;bottom:0;width:6px;
  background:linear-gradient(180deg,{TEAL} 0%,{VIOLET} 60%,{GOLD} 120%);
  box-shadow:0 0 14px rgba(124,58,237,0.55);}}
.body{{position:absolute;left:26px;right:62px;top:0;height:100px;
  display:flex;flex-direction:column;justify-content:center;gap:8px;}}
.title{{font-size:23px;font-weight:800;letter-spacing:2.5px;line-height:1;
  background:linear-gradient(120deg,{GOLD_HI},{GOLD} 55%,{GOLD_LO});
  -webkit-background-clip:text;background-clip:text;color:transparent;}}
.sub{{font-size:12.5px;font-weight:500;line-height:1.25;color:#c7cbe0;letter-spacing:0.2px;}}
.ico{{position:absolute;right:18px;top:50%;transform:translateY(-50%);
  width:40px;height:40px;color:{TEAL};opacity:0.85;
  filter:drop-shadow(0 0 8px rgba(6,182,212,0.45));}}
.ico svg{{width:40px;height:40px;fill:none;stroke:currentColor;stroke-width:2;
  stroke-linecap:round;stroke-linejoin:round;}}
</style></head><body>
<div class="p">
  <div class="strip"></div>
  <div class="body"><div class="title">{title}</div><div class="sub">{sub}</div></div>
  <div class="ico"><svg viewBox="0 0 40 40">{icon}</svg></div>
</div></body></html>"""

# ---- comparison sheet -------------------------------------------------------
def build_comparison(banner_png: Path, panel_pngs, out: Path):
    pad, gap, colgap = 40, 18, 28
    banner = Image.open(banner_png).convert('RGBA')
    panels = [Image.open(p).convert('RGBA') for p in panel_pngs]
    pw, ph = panels[0].size  # 320x100
    cols = 2
    rows = (len(panels) + cols - 1) // cols
    grid_w = cols * pw + (cols - 1) * colgap
    bw = banner.width
    content_w = max(bw, grid_w)
    W = content_w + pad * 2
    H = pad + banner.height + 44 + rows * ph + (rows - 1) * gap + pad
    sheet = Image.new('RGBA', (W, H), (10, 9, 22, 255))
    # backdrop wash
    sheet.alpha_composite(banner, ((W - bw) // 2, pad))
    gy0 = pad + banner.height + 44
    gx0 = (W - grid_w) // 2
    for i, im in enumerate(panels):
        r, c = divmod(i, cols)
        x = gx0 + c * (pw + colgap)
        y = gy0 + r * (ph + gap)
        sheet.alpha_composite(im, (x, y))
    sheet.convert('RGB').save(out)

# ---- main -------------------------------------------------------------------
def main():
    if not BG.exists():
        print('missing banner bg; run _twitch-brand-bg.py first', file=sys.stderr); return 2

    banner_out = ROOT / 'twitch-banner-1200x480.png'
    shoot(banner_html(), 1200, 480, banner_out, scale=1)

    panel_outs = []
    for key, title, sub in PANELS:
        out = ROOT / f'twitch-panel-{key}.png'
        shoot(panel_html(key, title, sub), 320, 100, out, scale=1)
        # 2x retina sanity pass (kept separate, not a deliverable)
        shoot(panel_html(key, title, sub), 320, 100, ROOT / f'_2x-{key}.png', scale=2)
        panel_outs.append(out)

    cmp_out = ROOT / 'twitch-branding-comparison.png'
    build_comparison(banner_out, panel_outs, cmp_out)

    # ---- verify ----
    print('\n=== VERIFY ===')
    ok = True
    b = Image.open(banner_out); print('banner', b.size, 'expect (1200, 480)', 'OK' if b.size==(1200,480) else 'BAD'); ok &= b.size==(1200,480)
    for key, *_ in PANELS:
        p = Image.open(ROOT / f'twitch-panel-{key}.png')
        x2 = Image.open(ROOT / f'_2x-{key}.png')
        status = 'OK' if (p.size==(320,100) and x2.size==(640,200)) else 'BAD'
        ok &= p.size==(320,100) and x2.size==(640,200)
        print(f'panel {key:10s} {p.size} 2x {x2.size} {status}')
    c = Image.open(cmp_out); print('comparison', c.size)
    print('\nALL DIMENSIONS', 'OK' if ok else 'BAD')
    return 0 if ok else 1

if __name__ == '__main__':
    raise SystemExit(main())
