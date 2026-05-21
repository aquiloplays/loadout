// Standalone harness for the character + pet plumbing.
//
//   node discord-bot/test/test-character-pet.mjs
//
// Doesn't render PNGs — that path is already covered by
// test-png-codec.mjs. This is the data-model + slash-command-level
// coverage: schema backfill, pet adoption gating, care decay, mood
// thresholds.

import {
  defaultLookForUser, applyLookBackfill, CHARACTER_LOOK_OPTIONS,
} from '../dungeon.js';
import {
  computeMood, isColourUnlocked, unlockedColoursForTier,
  SPECIES, SPECIES_COLOURS,
} from '../pet.js';

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + label + (detail ? ' (' + detail + ')' : '')); }
  else      { failed++; console.log('  FAIL  ' + label + (detail ? ' -- ' + detail : '')); }
}

console.log('--- character/pet plumbing ---');

// ── Look backfill ──────────────────────────────────────────────────
const d1 = defaultLookForUser('u_user_one');
ok('default look has bodyType',  CHARACTER_LOOK_OPTIONS.bodyType.includes(d1.bodyType));
ok('default look has skinTone',  CHARACTER_LOOK_OPTIONS.skinTone.includes(d1.skinTone));
ok('default look has hairStyle', CHARACTER_LOOK_OPTIONS.hairStyle.includes(d1.hairStyle));
ok('default look has hairColor', CHARACTER_LOOK_OPTIONS.hairColor.includes(d1.hairColor));
ok('default look has eyeColor',  CHARACTER_LOOK_OPTIONS.eyeColor.includes(d1.eyeColor));
ok('default look accent=none',   d1.accent === 'none');
ok('defaultLookForUser is deterministic', JSON.stringify(d1) === JSON.stringify(defaultLookForUser('u_user_one')));
ok('different users → different looks (usually)',
   JSON.stringify(d1) !== JSON.stringify(defaultLookForUser('u_user_two')));

const hero0 = { custom: {} };
applyLookBackfill(hero0, 'u_user_one');
ok('backfill fills empty hero', hero0.custom.bodyType && hero0.custom.skinTone);
ok('backfill sets lookVersion', typeof hero0.lookVersion === 'number');

const hero1 = { custom: { bodyType: 'stocky', hairColor: 'violet' } };
applyLookBackfill(hero1, 'u_user_two');
ok('backfill preserves set fields',
   hero1.custom.bodyType === 'stocky' && hero1.custom.hairColor === 'violet');
ok('backfill fills missing fields',
   hero1.custom.skinTone && hero1.custom.hairStyle && hero1.custom.eyeColor);

// ── Pet colour gating ──────────────────────────────────────────────
ok('cat colour 0 unlocked at tier 1', isColourUnlocked('cat', SPECIES_COLOURS.cat[0], 1) === true);
ok('cat colour 3 locked at tier 1',   isColourUnlocked('cat', SPECIES_COLOURS.cat[3], 1) === false);
ok('cat colour 3 unlocked at tier 3', isColourUnlocked('cat', SPECIES_COLOURS.cat[3], 3) === true);
ok('unlockedColoursForTier 1 ⊂ tier 2',
   unlockedColoursForTier('cat', 1).every(c => unlockedColoursForTier('cat', 2).includes(c)));
ok('unlockedColoursForTier 3 = all 4',
   unlockedColoursForTier('cat', 3).length === SPECIES_COLOURS.cat.length);
ok('every species has 4 colours',
   SPECIES.every(s => (SPECIES_COLOURS[s] || []).length === 4));

// ── Tamagotchi mood math ──────────────────────────────────────────
const now = Date.now();

const fresh = {
  hunger:      { value: 100, lastSetUtc: now },
  happiness:   { value: 100, lastSetUtc: now },
  cleanliness: { value: 100, lastSetUtc: now },
};
const moodFresh = computeMood(fresh);
ok('fresh pet is happy', moodFresh.label === 'happy');
ok('fresh stats all 100', moodFresh.stats.hunger === 100);

const hours6 = now - 6 * 3_600_000;
const sixHoursOld = {
  hunger:      { value: 100, lastSetUtc: hours6 },   // -2/h × 6 = 88
  happiness:   { value: 100, lastSetUtc: hours6 },   // -1/h × 6 = 94
  cleanliness: { value: 100, lastSetUtc: hours6 },   // -0.5/h × 6 = 97
};
const mood6 = computeMood(sixHoursOld);
ok('hunger decays at 2/h',
   Math.abs(mood6.stats.hunger - 88) < 0.5,
   `hunger=${mood6.stats.hunger.toFixed(1)}`);
ok('happiness decays at 1/h',
   Math.abs(mood6.stats.happiness - 94) < 0.5,
   `happiness=${mood6.stats.happiness.toFixed(1)}`);

const neglected = {
  hunger:      { value: 100, lastSetUtc: now - 60 * 3_600_000 },   // -120 → 0
  happiness:   { value: 100, lastSetUtc: now - 60 * 3_600_000 },   // -60 → 40
  cleanliness: { value: 100, lastSetUtc: now - 60 * 3_600_000 },   // -30 → 70
};
const moodNeg = computeMood(neglected);
ok('neglected pet shows sad mood', moodNeg.label === 'sad', `label=${moodNeg.label}`);
ok('mood hint identifies lowest stat',
   moodNeg.hint === 'hungry',
   `hint=${moodNeg.hint}`);

const stable = {
  hunger:      { value: 65, lastSetUtc: now },
  happiness:   { value: 65, lastSetUtc: now },
  cleanliness: { value: 65, lastSetUtc: now },
};
const moodStable = computeMood(stable);
ok('mid-range pet is content',
   moodStable.label === 'content',
   `label=${moodStable.label} avg=${moodStable.avg.toFixed(1)}`);

console.log('--- ' + passed + ' pass, ' + failed + ' fail ---');
if (failed > 0) process.exit(1);
