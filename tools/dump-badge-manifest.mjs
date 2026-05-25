#!/usr/bin/env node
// Dump the JS-side badges-catalog.js into a JSON manifest the
// PowerShell sprite generator can consume. Re-run after editing the
// catalogue:
//   node tools/dump-badge-manifest.mjs
import { BADGE_CATALOG } from '../discord-bot/progression/badges-catalog.js';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const out = BADGE_CATALOG.map(b => ({
  id: b.id, name: b.name, rarity: b.rarity, category: b.category,
  shape: b.shape, accent: b.accent, source: b.source || null,
}));
writeFileSync(
  join(here, 'badge-manifest.json'),
  JSON.stringify(out, null, 2) + '\n',
);
console.log(`wrote ${out.length} badge manifest entries`);
