// Retry the 3 styled-card samples that hit Replicate's 6/min rate limit.

import fs from 'node:fs';
import path from 'node:path';

const TOKEN = process.env.REPLICATE_API_TOKEN;
if (!TOKEN) { console.error('REPLICATE_API_TOKEN required'); process.exit(1); }

const OUT_DIR = '/tmp/boltbound-card-styled';
fs.mkdirSync(OUT_DIR, { recursive: true });
const MODEL_URL = 'https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions';

const SAMPLES = [
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
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', Prefer: 'wait=10' },
    body: JSON.stringify({
      input: { prompt: sample.prompt, aspect_ratio: '1:1', output_format: 'webp', output_quality: 95, num_outputs: 1, seed: sample.seed, go_fast: true, megapixels: '1' },
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    if (resp.status === 429) {
      // Parse retry_after and wait.
      let after = 12;
      try { after = JSON.parse(t).retry_after || 12; } catch {}
      console.warn(`  429, sleeping ${after + 2}s and retrying`);
      await new Promise(r => setTimeout(r, (after + 2) * 1000));
      return createPrediction(sample);
    }
    throw new Error(`create ${resp.status}: ${t.slice(0, 300)}`);
  }
  return await resp.json();
}

async function pollUntilDone(prediction) {
  let p = prediction;
  while (p.status === 'starting' || p.status === 'processing') {
    await new Promise(r => setTimeout(r, 1200));
    const r = await fetch(p.urls.get, { headers: { Authorization: 'Bearer ' + TOKEN } });
    p = await r.json();
  }
  if (p.status !== 'succeeded') throw new Error(`status ${p.status}`);
  return p;
}

async function downloadTo(localPath, url) {
  const r = await fetch(url);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(localPath, buf);
  return buf.length;
}

for (let i = 0; i < SAMPLES.length; i++) {
  const s = SAMPLES[i];
  console.log(`\n[${i+1}/${SAMPLES.length}] ${s.label}`);
  if (i > 0) {
    console.log('  pacing 14s for rate limit');
    await new Promise(r => setTimeout(r, 14000));
  }
  try {
    const created = await createPrediction(s);
    const done = await pollUntilDone(created);
    const outUrl = Array.isArray(done.output) ? done.output[0] : done.output;
    const localFile = path.join(OUT_DIR, s.slug + '.webp');
    const bytes = await downloadTo(localFile, outUrl);
    console.log(`  ✅ ${outUrl}`);
    console.log(`     → ${localFile} (${(bytes/1024).toFixed(1)} KB)`);
  } catch (e) {
    console.error(`  ❌ ${e.message}`);
  }
}
