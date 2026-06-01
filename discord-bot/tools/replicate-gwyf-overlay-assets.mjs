// Premium pop-up sprite generator for the GWYF (Gamble With Your Friends)
// TikTok follow overlay. Uses Replicate flux-1.1-pro-ultra ($0.06/image).
//
// Each subject is rendered isolated on a flat pure-magenta (#FF00FF) chroma
// background so a follow-up flood-key pass (keyout.py) can knock the
// background out to true transparency for the OBS overlay. ~8 assets ≈ $0.48.
//
// Usage:
//   REPLICATE_API_TOKEN=... node tools/replicate-gwyf-overlay-assets.mjs
//
// Raw renders land in <overlay>/assets/_raw/<slug>.png; keyout.py then
// writes the transparent finals to <overlay>/assets/<slug>.png.

import fs from 'node:fs';
import path from 'node:path';

const TOKEN = process.env.REPLICATE_API_TOKEN;
if (!TOKEN) { console.error('REPLICATE_API_TOKEN required'); process.exit(1); }

const OUT_DIR = path.resolve(process.cwd(), '../aquilo-gg/overlays/follow-gwyf/assets/_raw');
fs.mkdirSync(OUT_DIR, { recursive: true });

const MODEL_URL = 'https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro-ultra/predictions';

// Shared style suffix — keeps every sprite in the Boltbound "Glossy Game
// Premium" family and forces the flat chroma background for keying.
const STYLE = "Glossy Game Premium vector illustration, premium casino game aesthetic, "
  + "aurora-tinted violet and pink rim highlights, warm gold and casino-red accents, "
  + "glossy reflective surfaces, sharp clean vector lineart, dramatic studio rim lighting, "
  + "single centered subject, generous empty margin around the subject, "
  + "isolated on a perfectly flat solid pure magenta #FF00FF chroma key background, "
  + "no shadow on the background, no text watermark.";

const ASSETS = [
  { slug: 'slot-machine', prompt: "A premium three-reel casino slot machine cabinet, chrome trim, glowing reels showing lucky 7s and cherries, a red pull lever on the side." },
  { slug: 'chips-stack',  prompt: "A tall stack of glossy casino poker chips in violet, gold and red, a few chips mid-air tumbling off the top." },
  { slug: 'dice-pair',    prompt: "A pair of glossy red casino dice tumbling, rounded corners, bright white pips, motion sparkle." },
  { slug: 'cards-fan',    prompt: "A fanned-out hand of five glossy playing cards spreading open, ace and face cards, gold foil edges." },
  { slug: 'gold-coin',    prompt: "A single large glossy gold casino coin with a embossed dollar sign, brilliant reflective rim, sparkles around it." },
  { slug: 'jackpot-text', prompt: "The word JACKPOT in bold chunky 3D glossy gold balloon letters bursting outward, sparkles and confetti, casino marquee style." },
  { slug: 'royal-flush',  prompt: "A neat row of five glossy playing cards forming a royal flush, ten jack queen king ace of hearts, gold foil borders, fanned slightly." },
  { slug: 'die-six',      prompt: "A single large glossy red casino die landed showing the six face, bright white pips, rounded corners, sparkle highlight." },
  { slug: 'coins-rain',   prompt: "A cascade of glossy gold coins raining down, many coins of varying sizes falling, motion blur trails, sparkles." },
  { slug: 'crown-chip',   prompt: "A glossy royal gold crown resting on a single large violet casino chip, jewel accents, premium VIP look." },
];

async function createPrediction(asset) {
  const resp = await fetch(MODEL_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', Prefer: 'wait=20' },
    body: JSON.stringify({
      input: {
        prompt:           asset.prompt + ' ' + STYLE,
        aspect_ratio:     '1:1',
        output_format:    'png',
        safety_tolerance: 6,
        raw:              false,
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
    await new Promise(r => setTimeout(r, 1500));
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

for (let i = 0; i < ASSETS.length; i++) {
  const a = ASSETS[i];
  console.log(`\n[${i + 1}/${ASSETS.length}] ${a.slug}`);
  try {
    let created;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { created = await createPrediction(a); break; }
      catch (e) {
        if (attempt < 2 && /402|429|5\d\d/.test(e.message)) {
          console.warn(`  ${e.message.slice(0, 40)} — retry in 8s`);
          await new Promise(r => setTimeout(r, 8000));
          continue;
        }
        throw e;
      }
    }
    const done = await pollUntilDone(created);
    const outUrl = Array.isArray(done.output) ? done.output[0] : done.output;
    if (!outUrl) throw new Error('no output url');
    const localFile = path.join(OUT_DIR, a.slug + '.png');
    const bytes = await downloadTo(localFile, outUrl);
    totalCost += 0.06;
    results.push({ slug: a.slug, url: outUrl, localFile, bytes, status: 'ok' });
    console.log(`  OK → ${localFile} (${(bytes / 1024).toFixed(1)} KB)`);
  } catch (e) {
    results.push({ slug: a.slug, status: 'failed', error: String(e?.message || e) });
    console.error(`  FAIL ${e.message}`);
  }
}

console.log('\n=== Summary ===');
for (const r of results) {
  console.log(r.status === 'ok' ? `  OK   ${r.slug}` : `  FAIL ${r.slug}  ${r.error}`);
}
console.log(`\nTotal estimated cost: ~$${totalCost.toFixed(2)} (flux-1.1-pro-ultra @ $0.06/image)`);
fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify({ results, totalCost }, null, 2));
