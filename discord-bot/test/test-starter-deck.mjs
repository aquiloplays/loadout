// Tests for the pool-based starter deck (POST /web/boltbound/starter-deck).
// Verifies buildPoolStarterDeck produces a valid 20-card weak starter:
// 20 total (champion + 19), exactly 1 champion matching the class, NO
// legendaries/epics, ~70/25/5 common/uncommon/rare distribution, and
// per-card copy caps respected.
//
// Run: node test/test-starter-deck.mjs

import { buildPoolStarterDeck } from '../cards-decks.js';
import { CARDS, championForClass, DECK_SIZE } from '../cards-content.js';

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } }
function eq(a, b, m) { if (a === b) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m, '(want', b, 'got', a + ')'); } }

// Seeded LCG so the distribution assertions are deterministic.
function lcg(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

const CLASSES = ['warrior', 'mage', 'rogue', 'ranger', 'healer'];

for (const cls of CLASSES) {
  console.log(`- buildPoolStarterDeck("${cls}")`);
  const { deck, grantIds } = buildPoolStarterDeck(cls, lcg(cls.length * 7 + 1));

  eq(deck.cards.length, DECK_SIZE, `deck has ${DECK_SIZE} cards (incl champion)`);
  eq(grantIds.length, DECK_SIZE - 1, '19 non-champion grant cards');

  const champs = deck.cards.filter(id => CARDS[id]?.rarity === 'champion');
  eq(champs.length, 1, 'exactly 1 champion');
  eq(champs[0], championForClass(cls), 'champion matches the requested class');

  // No legendaries / epics anywhere.
  const banned = deck.cards.filter(id => ['legendary', 'epic'].includes(CARDS[id]?.rarity));
  eq(banned.length, 0, 'no legendaries or epics');

  // Every grant card is a playable common/uncommon/rare minion/spell.
  const badGrant = grantIds.filter(id => {
    const c = CARDS[id];
    return !c || c.token || !['common', 'uncommon', 'rare'].includes(c.rarity) ||
           !['minion', 'spell'].includes(c.type);
  });
  eq(badGrant.length, 0, 'all grant cards are common/uncommon/rare playable cards');

  // Distribution ~70/25/5 (we plan 13/5/1).
  const byR = { common: 0, uncommon: 0, rare: 0 };
  for (const id of grantIds) byR[CARDS[id].rarity]++;
  eq(byR.common, 13, '13 commons (~68%)');
  eq(byR.uncommon, 5, '5 uncommons (~26%)');
  eq(byR.rare, 1, '1 rare (~5%)');

  // Copy cap: no card more than 2 copies (starter variety cap).
  const counts = {};
  for (const id of grantIds) counts[id] = (counts[id] || 0) + 1;
  const overCap = Object.entries(counts).filter(([, n]) => n > 2);
  eq(overCap.length, 0, 'no card exceeds 2 copies');
}

// Random (unseeded) runs still hold the invariants.
console.log('- invariants hold across 25 random builds');
{
  let ok = true;
  for (let i = 0; i < 25; i++) {
    const { deck, grantIds } = buildPoolStarterDeck(CLASSES[i % 5]);
    if (deck.cards.length !== DECK_SIZE) ok = false;
    if (grantIds.length !== 19) ok = false;
    if (deck.cards.some(id => ['legendary', 'epic'].includes(CARDS[id]?.rarity))) ok = false;
    if (deck.cards.filter(id => CARDS[id]?.rarity === 'champion').length !== 1) ok = false;
  }
  assert(ok, '25 random builds: 20 cards, 1 champion, no legendaries/epics');
}

console.log('');
console.log(`PASSED, ${pass} ok / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
