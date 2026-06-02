"""Compose the follow-celebration design-options sheet from authored freeze-frames.

The 6 celebration designs (A-F) are authored by the follow-celebration-options
workflow. Each is a transparent SVG of the peak moment; this places each over a
dark gameplay-style backdrop in a lettered 2x3 grid with a one-line description,
so Clay can pick one. Render to PNG with headless Chrome afterwards. $0.

  python build-celebration-sheet.py --from-workflow "<path to wNNNN.output>"
  python build-celebration-sheet.py            # rebuild from celebration-options.json
"""
import json, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OPTS_JSON = HERE / 'celebration-options.json'
HTML_OUT = HERE / 'celebration-sheet.html'
ORDER = ['A', 'B', 'C', 'D', 'E', 'F']


def import_from_workflow(path):
    data = json.loads(Path(path).read_text(encoding='utf-8'))
    res = data.get('result', data)
    if isinstance(res, str):
        res = json.loads(res)
    opts = {o['option']: o for o in res['options']}
    OPTS_JSON.write_text(json.dumps(opts, indent=1, ensure_ascii=False), encoding='utf-8')
    for k, o in opts.items():
        (HERE / f'celebration-{k}.svg').write_text(o['svg'], encoding='utf-8')
    print(f'imported {len(opts)} options -> celebration-options.json + per-option svg')
    return opts


HEAD = '''<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:968px; background:#101117;
         font-family:"Segoe UI", Arial, Helvetica, sans-serif; color:#e7ecf3; }
  header { padding:13px 22px 10px; border-bottom:2px solid #2bd4d4; }
  header h1 { font-size:24px; font-weight:800; color:#aef3ea; }
  header p  { font-size:13px; color:#9aa6b6; margin-top:4px; }
  .grid { display:grid; grid-template-columns:repeat(2,1fr); }
  .cell { padding:14px 14px 6px; position:relative; }
  .stage { position:relative; height:248px; border-radius:10px; overflow:hidden;
           border:1px solid #2a2f38;
           background:
             radial-gradient(circle at 30% 25%, rgba(60,72,90,0.5), rgba(0,0,0,0) 60%),
             radial-gradient(circle at 75% 80%, rgba(40,30,60,0.5), rgba(0,0,0,0) 60%),
             linear-gradient(160deg, #1b2129 0%, #0e1116 100%); }
  .stage svg { position:absolute; inset:0; width:100% !important; height:100% !important; display:block; }
  .badge { position:absolute; top:6px; left:6px; z-index:5;
           background:#2bd4d4; color:#06222a; font-weight:800; font-size:14px;
           width:26px; height:26px; line-height:26px; text-align:center;
           border-radius:7px; box-shadow:0 1px 4px rgba(0,0,0,0.6); }
  .label { margin-top:8px; }
  .label .t { font-size:15px; font-weight:800; color:#f2f4f8; }
  .label .d { font-size:11.5px; color:#9aa6b6; margin-top:2px; line-height:1.3; }
</style></head><body>
  <header>
    <h1>Follow Overlay &mdash; Celebration Design Options</h1>
    <p>Pick one (A&ndash;F) &middot; freeze-frame of each design at its peak moment &middot; avatar/name/badges are placeholders (real values come from TikTok/Twitch at runtime) &middot; pure SVG, $0</p>
  </header>
  <div class="grid">
'''

# fallback one-liners if an agent omits desc
FALLBACK = {
    'A': 'Lower-third banner slides in: avatar in glowing ring + "Welcome, @name!" + tier badges.',
    'B': 'Full-screen aurora wash + confetti rain; avatar bursts center with a shockwave ring.',
    'C': 'Game-style victory banner (adapts per game) + avatar in a thematic ornate frame + color burst.',
    'D': 'Viewer appears as a premium card that flips in; cards stack for rapid follows.',
    'E': 'Arcade level-up: big gold "+1", follower-count ticker, star/spark burst, name banner.',
    'F': 'Minimal frosted-glass notification top-right: avatar + name + "Followed". Subtle.',
}


def build_html(opts):
    cells = []
    for k in ORDER:
        o = opts.get(k)
        svg = o['svg'] if o else '<svg viewBox="0 0 480 270"></svg>'
        title = (o.get('title') if o else None) or k
        desc = (o.get('desc') if o else '') or FALLBACK.get(k, '')
        cells.append(
            f'<div class="cell"><span class="badge">{k}</span>'
            f'<div class="stage">{svg}</div>'
            f'<div class="label"><div class="t">{k} &mdash; {title}</div><div class="d">{desc}</div></div></div>')
    HTML_OUT.write_text(HEAD + '\n'.join(cells) + '\n</div></body></html>', encoding='utf-8')
    print(f'wrote {HTML_OUT.name}')


def main():
    if '--from-workflow' in sys.argv:
        opts = import_from_workflow(sys.argv[sys.argv.index('--from-workflow') + 1])
    else:
        opts = json.loads(OPTS_JSON.read_text(encoding='utf-8'))
    build_html(opts)


if __name__ == '__main__':
    main()
