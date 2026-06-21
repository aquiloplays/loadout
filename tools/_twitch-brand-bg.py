"""One-shot: generate the aurora nebula banner background via Flux 1.1 Pro Ultra.
Outputs repo-root/_twitch-banner-bg.png. ~$0.06. NOT committed."""
import os, sys, time, requests
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / '_twitch-banner-bg.png'
TOKEN = os.environ.get('REPLICATE_API_TOKEN')
URL = 'https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro-ultra/predictions'

PROMPT = (
    "Painterly cosmic aurora nebula, ultra wide panoramic deep space backdrop. "
    "Flowing aurora ribbons in violet and teal and indigo, soft nebula clouds, "
    "scattered tiny gold star sparks, subtle warm gold light glow toward the lower right. "
    "Deep navy to deep purple gradient base, smooth atmospheric depth, gentle glossy sheen. "
    "Premium AAA key-art quality, clean and uncluttered, dark and moody but luminous. "
    "No text, no characters, no creatures, no UI, no border."
)

def main():
    if OUT.exists():
        print('bg already exists', OUT); return 0
    if not TOKEN:
        print('REPLICATE_API_TOKEN not set', file=sys.stderr); return 2
    body = {'input': {'prompt': PROMPT, 'aspect_ratio': '21:9',
                      'output_format': 'png', 'safety_tolerance': 6, 'raw': False}}
    while True:
        r = requests.post(URL, json=body, timeout=120,
                          headers={'Authorization': f'Bearer {TOKEN}', 'Prefer': 'wait=40'})
        if r.status_code == 429:
            time.sleep(15); continue
        if not r.ok:
            raise RuntimeError(f'{r.status_code} {r.text[:300]}')
        p = r.json(); break
    while p.get('status') in ('starting', 'processing'):
        time.sleep(1.3)
        p = requests.get(p['urls']['get'], headers={'Authorization': f'Bearer {TOKEN}'}).json()
    if p.get('status') != 'succeeded':
        raise RuntimeError(f"bg gen: {p.get('status')} {p.get('error')}")
    url = p['output'][0] if isinstance(p['output'], list) else p['output']
    img = requests.get(url, timeout=120).content
    OUT.write_bytes(img)
    print('wrote', OUT, len(img), 'bytes')
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
