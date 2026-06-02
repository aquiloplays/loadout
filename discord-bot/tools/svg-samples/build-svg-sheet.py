"""Assemble the follow-overlay SVG sample contact sheet from authored sprites.

Reads the 6 game-accurate SVG sprites (authored by the follow-svg-depth-pass
workflow, saved to sprites.json), writes each as a standalone <slug>.svg, and
composes contact-sheet.html (3x2 grid, labels). Render to PNG with headless
Chrome afterwards. Pure code, $0.

  # one-time import from a workflow output file:
  python build-svg-sheet.py --from-workflow "<path to wNNNN.output>"
  # rebuild HTML from the committed sprites.json:
  python build-svg-sheet.py
"""
import json, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPRITES_JSON = HERE / 'sprites.json'
HTML_OUT = HERE / 'contact-sheet.html'

# display order + labels
LABELS = [
    ("eldenring",             "Elden Ring",            "flask of crimson tears"),
    ("cyberpunk2077",         "Cyberpunk 2077",        "cyberware biochip"),
    ("supermarket_simulator", "Supermarket Simulator", "loaded shopping cart"),
    ("phasmophobia",          "Phasmophobia",          "EMF reader"),
    ("balatro",               "Balatro",               "Jimbo joker card"),
    ("ball_x_pit",            "BALL x PIT",            "arcade ball cluster"),
]


def import_from_workflow(path):
    data = json.loads(Path(path).read_text(encoding='utf-8'))
    res = data.get('result', data)
    if isinstance(res, str):
        res = json.loads(res)
    sprites = {s['slug']: s['svg'] for s in res['sprites']}
    SPRITES_JSON.write_text(json.dumps(sprites, indent=1, ensure_ascii=False), encoding='utf-8')
    for slug, svg in sprites.items():
        (HERE / f'{slug}.svg').write_text(svg, encoding='utf-8')
    print(f'imported {len(sprites)} sprites -> sprites.json + per-slug .svg')
    return sprites


HEAD = '''<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:984px; height:812px; background:#101117;
         font-family:"Segoe UI", Arial, Helvetica, sans-serif; color:#e7ecf3; }
  header { padding:14px 22px 10px; border-bottom:2px solid #2bd4d4; }
  header h1 { font-size:26px; font-weight:800; color:#aef3ea; }
  header p  { font-size:13px; color:#9aa6b6; margin-top:5px; }
  .grid { display:grid; grid-template-columns:repeat(3,1fr); }
  .cell { padding:18px 18px 8px; }
  .panel { background-image:radial-gradient(circle at 50% 40%, #4a4a4a, #383838);
           border:1px solid #565656; border-radius:12px; height:236px;
           display:flex; align-items:center; justify-content:center; overflow:hidden; }
  .panel svg { width:210px !important; height:210px !important; display:block; }
  .label { margin-top:9px; }
  .label .g { font-size:18px; font-weight:800; color:#f2f4f8; }
  .label .s { font-size:12px; color:#7de4d4; margin-top:1px; }
</style></head><body>
  <header>
    <h1>Follow Overlay &mdash; Game-Accurate SVG Sprites (rich pass)</h1>
    <p>Pure vector &middot; $0 &middot; 30-78 paths/sprite &middot; SVG filters (glow, specular, drop-shadow, turbulence) &middot; multi-stop gradients &middot; each matches its own game's real asset</p>
  </header>
  <div class="grid">
'''


def build_html(sprites):
    cells = []
    for slug, g, s in LABELS:
        svg = sprites.get(slug, '<svg viewBox="0 0 256 256"></svg>')
        cells.append(f'<div class="cell"><div class="panel">{svg}</div>'
                     f'<div class="label"><div class="g">{g}</div><div class="s">{s}</div></div></div>')
    HTML_OUT.write_text(HEAD + '\n'.join(cells) + '\n</div></body></html>', encoding='utf-8')
    print(f'wrote {HTML_OUT.name}')


def main():
    if '--from-workflow' in sys.argv:
        sprites = import_from_workflow(sys.argv[sys.argv.index('--from-workflow') + 1])
    else:
        sprites = json.loads(SPRITES_JSON.read_text(encoding='utf-8'))
    build_html(sprites)


if __name__ == '__main__':
    main()
