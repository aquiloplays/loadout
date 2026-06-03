// Boltbound card-art sample generator via Replicate flux-schnell.
//
// Fires N predictions (5 distinct prompts), polls each to completion,
// downloads the result image, and reports cost. Used once to give
// Clay a representative-style slice before he funds the integration.
//
// Usage:
//   REPLICATE_API_TOKEN=... node tools/replicate-card-samples.mjs

import fs from 'node:fs';
import path from 'node:path';

const TOKEN = process.env.REPLICATE_API_TOKEN;
if (!TOKEN) {
  console.error('REPLICATE_API_TOKEN env var required');
  process.exit(1);
}

const OUT_DIR = process.env.OUT_DIR || '/tmp/boltbound-replicate-samples';
fs.mkdirSync(OUT_DIR, { recursive: true });

const MODEL_URL = 'https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions';

const SAMPLES = [
  {
    slug:  'style-1-stylized-fantasy',
    label: 'Stylized fantasy illustration',
    seed:  101,
    prompt: 'A glowing arcane firebolt mid-flight, magical violet and aurora-pink energy, runic sparks trailing behind, dramatic dark cosmic background, glossy game card art, stylized vector painting, no text, centered composition',
  },
  {
    slug:  'style-2-painterly-classic',
    label: 'Painterly classic fantasy',
    seed:  202,
    prompt: 'A classical fantasy painting of a wizard casting a fire bolt spell, glowing violet flame in his palm, oil-painting brush strokes, rich atmospheric lighting, traditional trading card art',
  },
  {
    slug:  'style-3-anime-cel-shaded',
    label: 'Anime / cel-shaded',
    seed:  303,
    prompt: 'Anime style fire bolt spell, cel-shaded vibrant colors, a young mage girl with violet hair launching a glowing pink-violet fire orb, dynamic action pose, bold lineart, trading card illustration',
  },
  {
    slug:  'style-4-cyberpunk-synthwave',
    label: 'Cyberpunk / synthwave',
    seed:  404,
    prompt: 'Cyberpunk fire bolt, a digital plasma sphere of violet and pink energy crackling with neon code, glitch artifacts, retro grid background, vaporwave palette, game card art',
  },
  {
    slug:  'style-5-glossy-game-premium',
    label: 'Glossy game premium (Aquilo house style)',
    seed:  505,
    prompt: 'A glossy vector game illustration of a magical firebolt, concentrated aurora-pink energy bolt mid-flight, sharp vector edges with soft gradient shading, subtle violet contrail, dark cosmic background with aurora particles, premium trading card art for a game called Boltbound, no text in image',
  },
];

async function createPrediction(sample) {
  const resp = await fetch(MODEL_URL, {
    method:  'POST',
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      'Content-Type': 'application/json',
      'Prefer': 'wait=10',   // wait up to 10s inline before falling back to poll
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
    throw new Error(`create-prediction ${resp.status}: ${text.slice(0, 400)}`);
  }
  return await resp.json();
}

async function pollUntilDone(prediction) {
  const pollUrl = prediction?.urls?.get;
  if (!pollUrl) throw new Error('no poll url on prediction');
  let p = prediction;
  while (p.status === 'starting' || p.status === 'processing') {
    await new Promise(r => setTimeout(r, 1200));
    const r = await fetch(pollUrl, { headers: { Authorization: 'Bearer ' + TOKEN } });
    if (!r.ok) throw new Error(`poll ${r.status}`);
    p = await r.json();
  }
  if (p.status !== 'succeeded') {
    throw new Error(`prediction ${p.status}: ${p.error || '(no error msg)'}`);
  }
  return p;
}

async function downloadTo(localPath, url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${r.status} for ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(localPath, buf);
  return buf.length;
}

const results = [];
let totalCostUsd = 0;

for (let i = 0; i < SAMPLES.length; i++) {
  const s = SAMPLES[i];
  console.log(`\n[${i+1}/${SAMPLES.length}] ${s.label}`);
  try {
    const created = await createPrediction(s);
    const done    = await pollUntilDone(created);
    const outUrls = Array.isArray(done.output) ? done.output : [done.output].filter(Boolean);
    const outUrl  = outUrls[0];
    if (!outUrl) throw new Error('no output url');

    const localFile = path.join(OUT_DIR, `${s.slug}.webp`);
    const bytes = await downloadTo(localFile, outUrl);

    // Flux-schnell typically reports per-prediction USD cost via the
    // metrics.predict_time + the model's price-per-second. Replicate's
    // public API returns `metrics.predict_time` (seconds), Schnell
    // bills ~$0.003/image at 4 steps. Honest estimate when no
    // explicit cost field is present.
    const seconds = done.metrics?.predict_time || null;
    // Replicate flux-schnell is currently $0.003 per output image
    // (fixed-price model, not per-second). Hardcode for the report.
    const cost = 0.003;
    totalCostUsd += cost;

    results.push({
      slug:    s.slug,
      label:   s.label,
      url:     outUrl,
      localFile,
      bytes,
      seconds,
      cost,
      status:  'ok',
    });
    console.log(`  ✅ ${outUrl}`);
    console.log(`     → ${localFile} (${(bytes/1024).toFixed(1)} KB) · ${seconds?.toFixed(1) || '?'}s · ~$${cost.toFixed(3)}`);
  } catch (e) {
    results.push({ slug: s.slug, label: s.label, status: 'failed', error: String(e?.message || e) });
    console.error(`  ❌ ${e.message}`);
  }
}

console.log('\n=== Summary ===');
for (const r of results) {
  if (r.status === 'ok') console.log(`  OK   ${r.slug.padEnd(28)} → ${r.localFile}`);
  else                  console.log(`  FAIL ${r.slug.padEnd(28)} ${r.error}`);
}
console.log(`\nTotal estimated cost: ~$${totalCostUsd.toFixed(3)} (5 × Flux Schnell @ $0.003/image)`);
console.log(`Free-trial allowance: not exposed via API; check at https://replicate.com/account/billing`);

// Write a JSON manifest for the reporter to consume.
fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify({ results, totalCostUsd }, null, 2));
console.log(`\nManifest: ${path.join(OUT_DIR, 'manifest.json')}`);
