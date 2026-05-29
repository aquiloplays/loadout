// Boltbound complete-card-design sample generator via Replicate
// flux-schnell. Renders the Champion of Steel card in 5 distinct
// frame/illustration treatments. Used once to give Clay a visual
// language picker before committing to a production style.
//
// Usage:
//   REPLICATE_API_TOKEN=... node tools/replicate-card-styled.mjs

import fs from 'node:fs';
import path from 'node:path';

const TOKEN = process.env.REPLICATE_API_TOKEN;
if (!TOKEN) { console.error('REPLICATE_API_TOKEN required'); process.exit(1); }

const OUT_DIR = '/tmp/boltbound-card-styled';
fs.mkdirSync(OUT_DIR, { recursive: true });

const MODEL_URL = 'https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions';

const SAMPLES = [
  {
    slug:  'card-styled-1-glossy-game-premium',
    label: 'Glossy game premium (Aquilo house)',
    seed:  1001,
    prompt: "A complete glossy vector trading card game card, rectangular shape with rounded corners, aurora violet-to-pink gradient frame border. Top-left of the card has a glowing violet mana cost gem with the bold number 4. Top-right has a small CHAMPION type label. The card art portion shows a noble warrior in gleaming steel plate armor charging forward with sword raised, aurora-pink energy particles trailing. Below the art there is a horizontal name banner with 'Champion of Steel' written in clean bright white text. Bottom of card shows 4/6 stats in two golden circles and the keyword 'CHARGE' as a glowing pink pill. Dark cosmic background outside the card. Premium Hearthstone-style game card design, aurora aesthetic, sharp vector lineart.",
  },
  {
    slug:  'card-styled-2-pixel-art',
    label: 'Pixel art retro SNES',
    seed:  1002,
    prompt: "A retro 16-bit pixel art trading card game card, rectangular shape with chunky pixelated golden border. Top-left has a blocky blue mana cost gem with a pixel-font number 4. The card art portion shows a 16-bit pixel art warrior in shiny steel armor charging forward, sword raised, classic Final Fantasy IV / Chrono Trigger SNES sprite style with crisp pixel edges. Below the art is a pixel banner with 'CHAMPION OF STEEL' in pixel font. Bottom shows 4/6 stats and 'CHARGE' keyword. Vibrant 16-color palette, dithering shadows, no anti-aliasing, authentic retro game card.",
  },
  {
    slug:  'card-styled-3-anime-cel-shaded',
    label: 'Anime cel-shaded',
    seed:  1003,
    prompt: "A complete trading card game card in vibrant anime cel-shaded illustration style, rectangular shape with sharp violet and pink gradient borders. Top-left has a glowing pink mana crystal showing 4. The card art portion shows an anime-style young knight with dramatic windswept hair, gleaming steel armor with aurora-pink trim, charging dramatically with a glowing sword raised, motion speed lines and energy aura swirling. Below the art is a bold name banner with 'Champion of Steel' in anime title text. Bottom shows 4/6 stats and 'CHARGE' keyword. Manga-style speed lines, vivid saturated colors, sharp cel-shading, no photoreal elements.",
  },
  {
    slug:  'card-styled-4-handdrawn-ink',
    label: 'Hand-drawn pencil & ink TCG',
    seed:  1004,
    prompt: "A classic hand-drawn trading card game card on parchment paper with hand-drawn borders. Top-left has an inked circular mana symbol with the number 4. The art portion shows a graphite pencil and India ink illustration of a noble warrior in plate armor charging mid-stride, sword raised, classical fantasy realism with visible pencil strokes and crosshatching shading. Below the art is a hand-lettered name banner reading 'Champion of Steel' in classic fantasy calligraphy. Bottom shows 4/6 stats and 'CHARGE' keyword in inked text. Sepia and parchment tones with subtle violet ink accents, looks like a Magic: the Gathering concept art card.",
  },
  {
    slug:  'card-styled-5-3d-vinyl-figurine',
    label: '3D toy / vinyl figurine',
    seed:  1005,
    prompt: "A glossy 3D rendered trading card game card in chibi vinyl figure style, rectangular shape with smooth plastic borders. Top-left has a 3D-rendered violet crystal showing the number 4 in glossy material. The art portion shows a stubby chibi 3D vinyl toy figurine of a warrior in shiny steel armor charging forward, oversized head, cute big eyes, glossy material shading like a Funko Pop or Pop Mart blind box figure. Below the art is a banner with 'Champion of Steel' in friendly rounded sans-serif font. Bottom shows 4/6 stats and 'CHARGE' keyword. Soft studio rim lighting, premium 3D Pixar-quality render, aurora-violet accent lights.",
  },
];

async function createPrediction(sample) {
  const resp = await fetch(MODEL_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      'Content-Type': 'application/json',
      Prefer: 'wait=10',
    },
    body: JSON.stringify({
      input: {
        prompt:         sample.prompt,
        aspect_ratio:   '1:1',
        output_format:  'webp',
        output_quality: 95,
        num_outputs:    1,
        seed:           sample.seed,
        go_fast:        true,
        megapixels:     '1',
      },
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`create ${resp.status}: ${text.slice(0, 300)}`);
  }
  return await resp.json();
}

async function pollUntilDone(prediction) {
  let p = prediction;
  while (p.status === 'starting' || p.status === 'processing') {
    await new Promise(r => setTimeout(r, 1200));
    const r = await fetch(p.urls.get, { headers: { Authorization: 'Bearer ' + TOKEN } });
    if (!r.ok) throw new Error(`poll ${r.status}`);
    p = await r.json();
  }
  if (p.status !== 'succeeded') throw new Error(`status ${p.status}: ${p.error || ''}`);
  return p;
}

async function downloadTo(localPath, url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(localPath, buf);
  return buf.length;
}

const results = [];
let totalCost = 0;

for (let i = 0; i < SAMPLES.length; i++) {
  const s = SAMPLES[i];
  console.log(`\n[${i+1}/${SAMPLES.length}] ${s.label}`);
  try {
    let created;
    // Retry once on 402 — billing propagation can lag the first call.
    for (let attempt = 0; attempt < 2; attempt++) {
      try { created = await createPrediction(s); break; }
      catch (e) {
        if (attempt === 0 && /402/.test(e.message)) {
          console.warn('  402 on first try; pausing 8s for billing propagation');
          await new Promise(r => setTimeout(r, 8000));
          continue;
        }
        throw e;
      }
    }
    const done = await pollUntilDone(created);
    const outUrl = Array.isArray(done.output) ? done.output[0] : done.output;
    if (!outUrl) throw new Error('no output url');
    const localFile = path.join(OUT_DIR, s.slug + '.webp');
    const bytes = await downloadTo(localFile, outUrl);
    const seconds = done.metrics?.predict_time || null;
    const cost = 0.003;
    totalCost += cost;
    results.push({ slug: s.slug, label: s.label, url: outUrl, localFile, bytes, seconds, cost, status: 'ok' });
    console.log(`  ✅ ${outUrl}`);
    console.log(`     → ${localFile} (${(bytes/1024).toFixed(1)} KB) · ${seconds?.toFixed(1) || '?'}s · ~$${cost.toFixed(3)}`);
  } catch (e) {
    results.push({ slug: s.slug, label: s.label, status: 'failed', error: String(e?.message || e) });
    console.error(`  ❌ ${e.message}`);
  }
}

console.log('\n=== Summary ===');
for (const r of results) {
  if (r.status === 'ok') console.log(`  OK   ${r.slug.padEnd(36)} → ${r.localFile}`);
  else                  console.log(`  FAIL ${r.slug.padEnd(36)} ${r.error}`);
}
console.log(`\nTotal estimated cost: ~$${totalCost.toFixed(3)} (5 × Flux Schnell @ $0.003/image)`);
fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify({ results, totalCost }, null, 2));
