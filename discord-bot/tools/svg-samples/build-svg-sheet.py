"""Assemble the follow-overlay SVG sample gallery from authored sprites.

Game-accurate rich SVG sprites are authored by the follow-svg-* workflows and
merged into sprites.json (also saved per-slug as <slug>.svg). This composes a
NUMBERED contact sheet (6 cols) so Clay can reference cells by number for
edit/delete feedback. Render to PNG with headless Chrome afterwards. $0.

  python build-svg-sheet.py --from-workflow "<path to wNNNN.output>"   # merge-import then build
  python build-svg-sheet.py                                            # rebuild HTML from sprites.json
"""
import json, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPRITES_JSON = HERE / 'sprites.json'
HTML_OUT = HERE / 'contact-sheet.html'

# numbered display order: (slug, game, item subtitle)
LABELS = [
    ("eldenring",             "Elden Ring",            "flask of crimson tears"),
    ("cyberpunk2077",         "Cyberpunk 2077",        "cyberware biochip"),
    ("supermarket_simulator", "Supermarket Simulator", "shopping cart"),
    ("phasmophobia",          "Phasmophobia",          "EMF reader"),
    ("balatro",               "Balatro",               "Jimbo joker card"),
    ("ball_x_pit",            "BALL x PIT",            "arcade ball cluster"),
    ("skyrim_se",             "Skyrim SE",             "grand soul gem"),
    ("hollow_knight",         "Hollow Knight",         "charm"),
    ("stardew",               "Stardew Valley",        "parsnip"),
    ("hades",                 "Hades",                 "pomegranate"),
    ("witcher3",              "The Witcher 3",         "wolf medallion"),
    ("cult_lamb",             "Cult of the Lamb",      "the red crown"),
    ("among_us",              "Among Us",              "emergency button"),
    ("lethal_company",        "Lethal Company",        "walkie-talkie"),
    ("minecraft",             "Minecraft",             "diamond"),
    ("paralives",             "Paralives",             "cozy house"),
    ("manor_lords",           "Manor Lords",           "heraldic shield"),
    ("powerwash_simulator_2", "PowerWash Simulator 2", "spray gun"),
]


def import_from_workflow(path):
    data = json.loads(Path(path).read_text(encoding='utf-8'))
    res = data.get('result', data)
    if isinstance(res, str):
        res = json.loads(res)
    incoming = {s['slug']: s['svg'] for s in res['sprites']}
    existing = {}
    if SPRITES_JSON.exists():
        existing = json.loads(SPRITES_JSON.read_text(encoding='utf-8'))
    existing.update(incoming)                                   # merge (new overrides same slug)
    SPRITES_JSON.write_text(json.dumps(existing, indent=1, ensure_ascii=False), encoding='utf-8')
    for slug, svg in incoming.items():
        (HERE / f'{slug}.svg').write_text(svg, encoding='utf-8')
    print(f'merged {len(incoming)} sprites; sprites.json now has {len(existing)}')
    return existing


HEAD = '''<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:984px; height:726px; background:#101117;
         font-family:"Segoe UI", Arial, Helvetica, sans-serif; color:#e7ecf3; }
  header { padding:12px 20px 9px; border-bottom:2px solid #2bd4d4; }
  header h1 { font-size:23px; font-weight:800; color:#aef3ea; }
  header p  { font-size:12.5px; color:#9aa6b6; margin-top:4px; }
  .grid { display:grid; grid-template-columns:repeat(6,1fr); }
  .cell { padding:10px 10px 4px; position:relative; }
  .panel { background-image:radial-gradient(circle at 50% 40%, #4a4a4a, #383838);
           border:1px solid #565656; border-radius:10px; height:142px;
           display:flex; align-items:center; justify-content:center; overflow:hidden; }
  .panel svg { width:130px !important; height:130px !important; display:block; }
  .num { position:absolute; top:4px; left:4px; z-index:3;
         background:#2bd4d4; color:#06222a; font-weight:800; font-size:12px;
         min-width:20px; height:20px; line-height:20px; text-align:center;
         border-radius:6px; padding:0 5px; box-shadow:0 1px 3px rgba(0,0,0,0.5); }
  .label { margin-top:6px; }
  .label .g { font-size:13px; font-weight:800; color:#f2f4f8; line-height:1.1; }
  .label .s { font-size:10.5px; color:#7de4d4; margin-top:1px; }
</style></head><body>
  <header>
    <h1>Follow Overlay &mdash; 18 game-accurate SVG samples</h1>
    <p>Number any cell to edit/delete &middot; pure vector &middot; $0 &middot; 30+ paths/sprite, SVG filters + multi-stop gradients &middot; each matches its own game's real asset</p>
  </header>
  <div class="grid">
'''


def build_html(sprites):
    cells = []
    for i, (slug, g, s) in enumerate(LABELS, 1):
        svg = sprites.get(slug, '<svg viewBox="0 0 256 256"><rect x="40" y="40" width="176" height="176" rx="14" fill="#2a2a2a" stroke="#666" stroke-width="3"/><text x="128" y="138" text-anchor="middle" fill="#888" font-size="18">missing</text></svg>')
        cells.append(f'<div class="cell"><span class="num">{i}</span><div class="panel">{svg}</div>'
                     f'<div class="label"><div class="g">{g}</div><div class="s">{s}</div></div></div>')
    HTML_OUT.write_text(HEAD + '\n'.join(cells) + '\n</div></body></html>', encoding='utf-8')
    print(f'wrote {HTML_OUT.name} ({len(LABELS)} cells)')


def main():
    if '--from-workflow' in sys.argv:
        sprites = import_from_workflow(sys.argv[sys.argv.index('--from-workflow') + 1])
    else:
        sprites = json.loads(SPRITES_JSON.read_text(encoding='utf-8'))
    build_html(sprites)


if __name__ == '__main__':
    main()
