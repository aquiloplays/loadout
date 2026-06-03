// Cache-bust re-point for Boltbound globalArt (2026-06-01).
//
// PROBLEM: the premium card-face regen overwrote the image BYTES under
// the same key (pixel-art-card:<id>) + same URL
// (/asset/card-art/<id>.png), which the worker serves with
// `Cache-Control: public, max-age=31536000, immutable`. Browsers /
// edge that cached the OLD pixel-art image keep serving it for up to a
// year because the URL never changed. (handleCardArtAsset's own comment:
// "a re-render uploads the same key and requires a versioned URL ... to
// roll out faster than the cache TTL.")
//
// AUDIT (via /admin/_card-art-summary): all 1267 global-card-art records
// already point at the premium /asset/card-art URL (source
// premium-overhaul-v1), 0 Giphy, 0 stale. So this is NOT a stale-URL
// problem; it's an immutable-cache-on-unchanged-URL problem.
//
// FIX: re-point every global-card-art record's memeGifUrl to a VERSIONED
// premium URL (/asset/card-art/<id>.png?v=<VER>). The new URL is a cache
// miss everywhere -> clients fetch the premium bytes immediately. The
// asset route matches on pathname (ignores the query), so the versioned
// URL serves the same premium PNG; immutable caching stays correct
// (each version is its own cache entry). Bump VER on any future regen.
//
// $0 (no Replicate). Pure KV data update via `wrangler kv bulk put`.
//
// Usage:  node tools/repoint-global-art-cachebust.mjs [--ver p2] [--dry-run]

import { CARDS } from '../cards-content.js';
import fs from 'fs';
import { execSync } from 'child_process';

const HOST = 'loadout-discord.aquiloplays.workers.dev';
const argv = process.argv.slice(2);
const VER = argv.includes('--ver') ? argv[argv.indexOf('--ver') + 1] : 'p2';
const DRY = argv.includes('--dry-run');

const ids = Object.keys(CARDS);
const nowIso = new Date().toISOString();
const entries = ids.map(id => ({
  key: `global-card-art:${id}`,
  value: JSON.stringify({
    memeGifUrl: `https://${HOST}/asset/card-art/${id}.png?v=${VER}`,
    searchTerm: null,
    source: `premium-overhaul-v2-cachebust-${VER}`,
    contentLength: null,
    validatedAt: nowIso,
    updatedAt: nowIso,
  }),
}));

console.log(`re-pointing ${entries.length} global-card-art records -> /asset/card-art/<id>.png?v=${VER}`);
console.log('sample:', entries[0].key, '->', JSON.parse(entries[0].value).memeGifUrl);
if (DRY) { console.log('(dry run, not writing)'); process.exit(0); }

// Chunk the bulk put (small JSON values; one chunk easily fits, but
// stay well under the wire ceiling).
const CHUNK = 500;
let written = 0;
for (let i = 0; i < entries.length; i += CHUNK) {
  const chunk = entries.slice(i, i + CHUNK);
  const tmp = `C:/tmp/globalart-repoint-${i}.json`;
  fs.writeFileSync(tmp, JSON.stringify(chunk), 'utf8');
  execSync(`npx wrangler kv bulk put "${tmp}" --binding LOADOUT_BOLTS --remote`, { stdio: 'pipe' });
  fs.unlinkSync(tmp);
  written += chunk.length;
  console.log(`  wrote ${written}/${entries.length}`);
}
console.log(`done, ${written} records re-pointed to ?v=${VER}`);
