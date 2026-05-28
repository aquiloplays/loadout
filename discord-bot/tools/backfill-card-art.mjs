// Boltbound card-art backfill driver.
//
// Loops over slices of the worker endpoint /admin/_card-art-backfill/:token
// until the server reports done=true. The Giphy search + KV write
// happens worker-side (so GIPHY_API_KEY stays in worker secrets).
//
// Usage:
//   BOOTSTRAP_TOKEN=<hex> node tools/backfill-card-art.mjs [--limit=25] [--force]
//
// Optional env:
//   WORKER_BASE       defaults to https://loadout-discord.aquiloplays.workers.dev
//
// The driver writes a flat audit log to tools/backfill-card-art.log
// (one line per processed card) so a partial run can be inspected
// without hitting /admin/card-art/list.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH  = path.join(__dirname, 'backfill-card-art.log');

const token = process.env.BOOTSTRAP_TOKEN;
if (!token) {
  console.error('BOOTSTRAP_TOKEN env var required');
  console.error('  Mint it via: wrangler kv key put bootstrap-card-art-backfill-token "$(openssl rand -hex 24)"');
  process.exit(1);
}
const base = (process.env.WORKER_BASE || 'https://loadout-discord.aquiloplays.workers.dev').replace(/\/$/, '');
const args = new Set(process.argv.slice(2));
const limitArg = [...args].find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.slice(8), 10) : 25;
const force = args.has('--force');

async function callSlice(offset) {
  const url = `${base}/admin/_card-art-backfill/${token}?offset=${offset}&limit=${limit}${force ? '&force=1' : ''}`;
  const resp = await fetch(url, { method: 'POST' });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`slice failed (${resp.status}): ${text.slice(0, 300)}`);
  }
  return resp.json();
}

let offset       = 0;
let totalHits    = 0;
let totalMisses  = 0;
let totalSkipped = 0;
let started      = Date.now();
let total        = null;

console.log(`Driving worker backfill — base=${base} limit=${limit}${force ? ' force=true' : ''}`);

while (true) {
  let r;
  try { r = await callSlice(offset); }
  catch (e) { console.error(e.message); process.exit(2); }

  if (!r.ok) {
    console.error('worker returned not-ok:', r);
    process.exit(3);
  }

  totalHits    += r.hits    || 0;
  totalMisses  += r.misses  || 0;
  totalSkipped += r.skipped || 0;
  total = r.total;

  for (const s of (r.samples || [])) {
    const line = `OK  | ${s.cardId.padEnd(28)} | ${(s.cardName || '').padEnd(28)} | term="${s.term}" | ${s.url}`;
    fs.appendFileSync(LOG_PATH, line + '\n');
  }
  for (const f of (r.failed || [])) {
    const line = `FAIL| ${f.cardId.padEnd(28)} | ${''.padEnd(28)} | reason=${f.error}`;
    fs.appendFileSync(LOG_PATH, line + '\n');
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const pct = total ? ((r.nextOffset / total) * 100).toFixed(1) : '?';
  console.log(`[${r.nextOffset}/${total || '?'}] (${pct}%) elapsed=${elapsed}s slice hits=${r.hits} misses=${r.misses} skipped=${r.skipped}`);
  if (r.samples?.length) {
    for (const s of r.samples.slice(-3)) {
      console.log(`    ${(s.cardName || s.cardId).padEnd(28)} → ${s.url} (term: ${s.term})`);
    }
  }

  if (r.rateLimited) {
    // Worker now rewinds nextOffset to the rate-limited card so the
    // next request retries it. Sleep long enough for Giphy's hourly
    // window to substantially recover — 60s wasn't enough on prior
    // runs. 10 minutes between retries keeps us under any plausible
    // per-key budget.
    console.warn('  worker reported rate-limit; sleeping 10 min');
    await new Promise(r => setTimeout(r, 600_000));
  }

  if (r.done) break;
  offset = r.nextOffset;
}

console.log('');
console.log('— Backfill complete —');
console.log(`Total cards:    ${total}`);
console.log(`  Hits:         ${totalHits}`);
console.log(`  Misses:       ${totalMisses}`);
console.log(`  Skipped:      ${totalSkipped}`);
console.log('Log saved to', LOG_PATH);
console.log('');
console.log('When you\'re happy, delete the bootstrap token:');
console.log(`  wrangler kv key delete --binding=LOADOUT_BOLTS --remote bootstrap-card-art-backfill-token`);
