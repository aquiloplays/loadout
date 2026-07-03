// Content-quality polish verification for the Boltbound generators.
//
// Scoped to THIS agent's ownership so it runs independent of concurrent
// edits to cards-content.js / spire-cards.js: it imports the bulk
// generator output and the text-override map directly, never the full
// composed CARDS map (whose schemaCheck may transiently throw while a
// sibling agent is mid-edit on spire cards).
//
//   node test/test-content-polish.mjs
//
// Invariants:
//   1. Bulk generator ids + stats match a captured baseline (no id or
//      stat drift from the content edits).
//   2. Zero numeric-suffix display names in the bulk sets.
//   3. Unique display names within each bulk set.
//   4. No bulk card with keywords/abilities and empty rules text.
//   5. Bulk rules-text keyword clauses use the Aquilo badge names
//      (Ward/Veiled/Drain/Venomous/Spell Warded), never the raw engine
//      names.
//   6. The text-override map (card-text-overrides.js) carries no raw
//      engine keyword badge tokens (Shield/Stealth/Lifesteal/Poison/
//      Spell-Immune) as leading clauses -- they must read as Aquilo names
//      to agree with boltbound-keywords.ts.

import { EXPANSION_BULK_CARDS, EXPANSION_BULK_TOKENS } from '../cards-expansion-bulk.js';
import { CARD_TEXT_OVERRIDES } from '../card-text-overrides.js';
import fs from 'node:fs';
import url from 'node:url';

const bulk = EXPANSION_BULK_CARDS;
const allBulk = [...EXPANSION_BULK_CARDS, ...EXPANSION_BULK_TOKENS];
let fail = 0;
const errs = [];
function bad(msg) { fail++; if (errs.length < 40) errs.push(msg); }

// ── 1. id/stat baseline (bulk only) ──────────────────────────────────
const baseDir = url.fileURLToPath(new URL('.', import.meta.url));
const basePath = baseDir + '.content-baseline-bulk.json';
function statSig(c) {
  return { mana: c.mana, atk: c.atk, hp: c.hp, rarity: c.rarity, set: c.set,
    kw: (c.keywords || []).slice().sort().join(','), ab: JSON.stringify(c.abilities || []) };
}
const now = {};
for (const c of allBulk) now[c.id] = statSig(c);
if (fs.existsSync(basePath)) {
  const base = JSON.parse(fs.readFileSync(basePath, 'utf8'));
  const bIds = Object.keys(base).sort().join(',');
  const nIds = Object.keys(now).sort().join(',');
  if (bIds !== nIds) bad('bulk id set changed vs baseline');
  let diffs = 0;
  for (const id of Object.keys(base)) {
    if (now[id] && JSON.stringify(base[id]) !== JSON.stringify(now[id])) {
      if (diffs < 8) bad(`stat drift ${id}: ${JSON.stringify(base[id])} -> ${JSON.stringify(now[id])}`);
      diffs++;
    }
  }
  console.log(`baseline: present, stat diffs ${diffs}`);
} else {
  fs.writeFileSync(basePath, JSON.stringify(now));
  console.log('baseline: WROTE new bulk baseline (rerun to assert stability)');
}

// ── 2. numeric-suffix names ──────────────────────────────────────────
const numSuffix = bulk.filter((c) => /\s\d+$/.test(String(c.name || '')));
if (numSuffix.length) bad(`numeric-suffix names: ${numSuffix.length} (e.g. ${numSuffix.slice(0, 5).map((c) => `${c.id}="${c.name}"`).join(', ')})`);

// ── 3. unique names within each set ──────────────────────────────────
const perSet = {};
for (const c of bulk) { (perSet[c.set] ||= new Map()); const m = perSet[c.set]; m.set(c.name, (m.get(c.name) || 0) + 1); }
for (const [set, m] of Object.entries(perSet)) {
  const dupes = [...m.entries()].filter(([, n]) => n > 1);
  if (dupes.length) bad(`dup names in ${set}: ${dupes.length} (e.g. ${dupes.slice(0, 4).map(([n, k]) => `"${n}"x${k}`).join(', ')})`);
}

// ── 4. empty text w/ mechanics ───────────────────────────────────────
const emptyMech = bulk.filter((c) => ((c.keywords && c.keywords.length) || (c.abilities && c.abilities.length) || c.overload) && !String(c.text || '').trim());
if (emptyMech.length) bad(`empty text w/ mechanics: ${emptyMech.length} (e.g. ${emptyMech.slice(0, 5).map((c) => c.id).join(', ')})`);

// ── 5. bulk keyword text uses Aquilo names ───────────────────────────
const RAW = /\b(Shield|Stealth|Lifesteal|Poison|Spell-Immune|Spell Immune)\b/;
const bulkRaw = bulk.filter((c) => RAW.test(String(c.text || '')));
if (bulkRaw.length) bad(`bulk raw-keyword text: ${bulkRaw.length} (e.g. ${bulkRaw.slice(0, 5).map((c) => `${c.id}="${c.text}"`).join(' | ')})`);

// ── 6. override map uses Aquilo names ────────────────────────────────
const ovRaw = Object.entries(CARD_TEXT_OVERRIDES).filter(([, t]) => RAW.test(String(t)));
if (ovRaw.length) bad(`override raw-keyword text: ${ovRaw.length} (e.g. ${ovRaw.slice(0, 5).map(([id, t]) => `${id}="${t}"`).join(' | ')})`);

// ── report ───────────────────────────────────────────────────────────
console.log(`bulk cards: ${bulk.length} (+${EXPANSION_BULK_TOKENS.length} tokens)`);
console.log(`numeric-suffix names: ${numSuffix.length}`);
console.log(`empty-text-with-mechanics: ${emptyMech.length}`);
console.log(`bulk raw-keyword text: ${bulkRaw.length}`);
console.log(`override raw-keyword text: ${ovRaw.length}`);

if (fail) { console.error('\nFAIL:'); for (const e of errs) console.error('  - ' + e); process.exit(1); }
console.log('\nOK: content-polish invariants hold.');
