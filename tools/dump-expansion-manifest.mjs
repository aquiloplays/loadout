// Dumps a flat JSON manifest of every CR-1 expansion card so the
// PowerShell sprite generator can consume it without parsing JS.
//
// Output:
//   tools/expansion-cards.json
//     [
//       { id, family, rarity, type, mana, atk, hp, visualArchetype,
//         paletteHint, keywords, tribe },
//       ...
//     ]
//
// Run:
//   node tools/dump-expansion-manifest.mjs
//
// Idempotent, re-runnable. The PS1 generator only reads from this
// file; regenerating sprites after a content edit goes: `node ...mjs`
// then `pwsh -File tools/build-card-sprites.ps1 -Expansion`.

import { EXPANSION_CARDS, EXPANSION_FAMILIES } from '../discord-bot/cards-expansion.js';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Build a lookup of family → paletteHint so each card row carries its
// palette inline (PS1 doesn't need a separate dictionary).
const palettes = Object.fromEntries(EXPANSION_FAMILIES.map(f => [f.id, f.paletteHint]));

const out = EXPANSION_CARDS.map(c => ({
  id: c.id,
  family: c.family,
  rarity: c.rarity,
  type: c.type,
  mana: c.mana,
  atk: c.atk || 0,
  hp:  c.hp  || 0,
  visualArchetype: c.visualArchetype,
  paletteHint: palettes[c.family] || 'fur-brown',
  keywords: c.keywords || [],
  tribe: c.tribe || '',
  token: !!c.token,
}));

const path = resolve(__dirname, 'expansion-cards.json');
writeFileSync(path, JSON.stringify(out, null, 0));
console.log('Wrote', out.length, 'cards to', path);
