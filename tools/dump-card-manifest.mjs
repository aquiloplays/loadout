// Dump the Boltbound card manifest to JSON so the PowerShell sprite
// generator can iterate over every card the JS catalogue knows about.
//
// Writes: tools/.card-manifest.json
// Run: node tools/dump-card-manifest.mjs
//
// The PowerShell sprite script reads this file at startup to:
//   1) iterate the full card id list (1,500+ entries)
//   2) dispatch each id to the right family template + rarity
//   3) emit cards/<id>.png matching the JS spriteId

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const contentUrl   = pathToFileURL(join(repoRoot, 'discord-bot', 'cards-content.js')).href;
const generatorUrl = pathToFileURL(join(repoRoot, 'discord-bot', 'cards-catalog-gen.js')).href;
const content    = await import(contentUrl);
const generator  = await import(generatorUrl);

const procManifest = generator.generateSpriteManifest();
const familiesByKey = Object.fromEntries(generator.FAMILIES.map(f => [f.key, f]));

// Infer a family from a hand-curated card id that follows the
// `<tier>.<familyKey>.<name>` convention (e.g. leg.dra.crimsonwyrm).
// Lets the sprite generator pick a sensible template for the new
// hand-curated legendaries / signature rares without bespoke
// Draw-Card-* functions for every one.
function inferFamily(id) {
  const parts = String(id).split('.');
  if (parts.length < 3) return null;
  const key = parts[1];
  return familiesByKey[key] || null;
}

// Walk CARDS and tag each entry as either 'curated' (hand-drawn —
// already has a Draw-Card-* function in build-card-sprites.ps1) or
// 'procedural' (handled by the family template dispatcher).
const proceduralIds = new Set(procManifest.map(m => m.id));

const entries = [];
for (const id of Object.keys(content.CARDS)) {
  const c = content.CARDS[id];
  const proc = procManifest.find(m => m.id === id) || null;
  // Hand-curated cards: try to infer a family from the id prefix so
  // the sprite generator can pick a template/palette without a
  // bespoke Draw-Card-* function.
  const inferred = proc ? null : inferFamily(id);
  entries.push({
    id,
    name: c.name,
    rarity: c.rarity,
    type: c.type,
    mana: c.mana,
    atk: c.atk,
    hp: c.hp,
    keywords: c.keywords,
    token: !!c.token,
    // Routing flag: procedural is rendered by a family template;
    // curated falls through to whatever Draw-Card-* function the PS
    // script registers for that id.
    procedural: proceduralIds.has(id),
    family: proc?.family || inferred?.key || null,
    archetype: proc?.archetype || inferred?.archetype || null,
    palette: proc?.palette || inferred?.palette || null,
    skin: proc?.skin || inferred?.skin || null,
    template: proc?.template || inferred?.template || null,
    weapon: proc?.weapon || inferred?.weapon || null,
    school: proc?.school || null,
    glyph: proc?.glyph || null,
    variant: proc?.variant ?? null,
  });
}

const out = join(__dirname, '.card-manifest.json');
writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), total: entries.length, cards: entries }, null, 2));
console.log(`wrote ${entries.length} entries -> ${out}`);
