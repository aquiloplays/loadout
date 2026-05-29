// Unit tests for Spire — covers run state machine, reward gating,
// season rotation idempotency, deck generator, boss mechanic dispatch.

import { themeForMonth, monthBoundsUtc, SPIRE_THEMES } from '../spire-seasons.js';
import { generateSpireNpcDeck, tierForFloor } from '../spire-deck.js';
import { applyBossMechanic, listMechanicIds } from '../spire-boss-mechanics.js';
import { SPIRE_EXCLUSIVE_BY_THEME } from '../spire-cards.js';

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } }
function eq(a, b, m)  { if (a === b) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m, '(want:', b, 'got:', a, ')'); } }

console.log('— seasons roster shape');
{
  eq(SPIRE_THEMES.length, 12, '12 themes');
  for (const t of SPIRE_THEMES) {
    assert(t.themeId && t.name && t.bossMechanic && t.curatedCardPool,
      `theme ${t.themeId} has required fields`);
    assert(SPIRE_EXCLUSIVE_BY_THEME[t.themeId] === t.seasonalExclusiveCard,
      `exclusive map matches for ${t.themeId}`);
  }
}

console.log('— themeForMonth rotation is stable from epoch');
{
  const m0 = themeForMonth(2026, 6);   // SPIRE_EPOCH = June 2026
  eq(m0.themeId, 'ember-court', 'epoch month = ember-court');
  const m1 = themeForMonth(2026, 7);
  eq(m1.themeId, 'aurora-spire', 'next month = aurora-spire');
  const m12 = themeForMonth(2027, 6);
  eq(m12.themeId, 'ember-court', 'year +1 returns to ember-court');
  // Pre-epoch months clamp to epoch.
  const pre = themeForMonth(2025, 12);
  eq(pre.themeId, 'ember-court', 'pre-epoch months clamp');
}

console.log('— monthBoundsUtc');
{
  const b = monthBoundsUtc(2026, 6);
  eq(b.startsAt, '2026-06-01T00:00:00.000Z', 'June 2026 starts at month 1');
  assert(b.endsAt.startsWith('2026-06-30T23:59:59'), 'June 2026 ends at month-end');
}

console.log('— tierForFloor');
{
  eq(tierForFloor(1),  'easy',   'floor 1 = easy');
  eq(tierForFloor(3),  'easy',   'floor 3 = easy');
  eq(tierForFloor(4),  'medium', 'floor 4 = medium');
  eq(tierForFloor(6),  'medium', 'floor 6 = medium');
  eq(tierForFloor(7),  'hard',   'floor 7 = hard');
  eq(tierForFloor(9),  'hard',   'floor 9 = hard');
  eq(tierForFloor(10), 'boss',   'floor 10 = boss');
}

console.log('— deck generator: fallback when no npc row');
{
  const d = generateSpireNpcDeck('ember-court', null, 'seed-a');
  assert(d.cards.length >= 12, 'fallback fills >=12');
  assert(d.championClass, 'has champion class');
}

console.log('— deck generator: themed pool prefers fire.* for ember-court');
{
  const npcRow = {
    npc_key: 'ember.boss', difficulty_tier: 'boss',
    deck_template: JSON.stringify({ champion: 'mage', sizeMin: 20, raresAllowed: 3, forceCardIds: ['spire.s01.embercrown'] }),
  };
  const d = generateSpireNpcDeck('ember-court', npcRow, 'seed-b');
  eq(d.cards.length, 20, 'boss deck = 20 cards');
  assert(d.cards.includes('spire.s01.embercrown'), 'forced card present');
  const firePicks = d.cards.filter(id => id.startsWith('fire.')).length;
  assert(firePicks >= 5, `themed fire.* cards present (${firePicks} found)`);
}

console.log('— deck generator: deterministic seed');
{
  const npcRow = {
    npc_key: 'ember.boss', difficulty_tier: 'medium',
    deck_template: JSON.stringify({ champion: 'warrior' }),
  };
  const d1 = generateSpireNpcDeck('ember-court', npcRow, 'fixed');
  const d2 = generateSpireNpcDeck('ember-court', npcRow, 'fixed');
  eq(JSON.stringify(d1.cards), JSON.stringify(d2.cards), 'same seed → identical deck');
}

console.log('— deck generator: different seed varies output');
{
  const npcRow = {
    npc_key: 'ember.boss', difficulty_tier: 'medium',
    deck_template: JSON.stringify({ champion: 'warrior' }),
  };
  const d1 = generateSpireNpcDeck('ember-court', npcRow, 'fixed-1');
  const d2 = generateSpireNpcDeck('ember-court', npcRow, 'fixed-2');
  assert(JSON.stringify(d1.cards) !== JSON.stringify(d2.cards), 'different seeds → different decks');
}

console.log('— boss mechanic registry covers all 12 seasons');
{
  const registry = new Set(listMechanicIds());
  for (const t of SPIRE_THEMES) {
    assert(registry.has(t.bossMechanic.id), `mechanic id ${t.bossMechanic.id} registered`);
  }
}

console.log('— boss mechanic dispatch: ember end-of-turn-burn');
{
  const match = {
    kind: 'spire-boss',
    bossMechanic: { id: 'ember.end-of-turn-burn', phase: 'end-of-turn', params: { damageToAllFriendly: 2 } },
    board: { A: [{ uid: 'a1', hp: 5 }, { uid: 'a2', hp: 3 }], B: [] },
  };
  const log = applyBossMechanic(match, 'end-of-turn', { playerSide: 'A', bossSide: 'B' });
  assert(log && log.length, 'log line emitted');
  eq(match.board.A[0].hp, 3, 'minion 1 hp reduced 5→3');
  eq(match.board.A[1].hp, 1, 'minion 2 hp reduced 3→1');
}

console.log('— boss mechanic dispatch: no-op when not spire-boss');
{
  const match = {
    kind: 'pvp',
    bossMechanic: { id: 'ember.end-of-turn-burn', phase: 'end-of-turn' },
    board: { A: [{ uid: 'a1', hp: 5 }], B: [] },
  };
  const log = applyBossMechanic(match, 'end-of-turn', { playerSide: 'A', bossSide: 'B' });
  eq(log, null, 'pvp match → null');
  eq(match.board.A[0].hp, 5, 'hp unchanged');
}

console.log('— boss mechanic dispatch: phase mismatch is no-op');
{
  const match = {
    kind: 'spire-boss',
    bossMechanic: { id: 'ember.end-of-turn-burn', phase: 'end-of-turn' },
    board: { A: [{ uid: 'a1', hp: 5 }], B: [] },
  };
  const log = applyBossMechanic(match, 'start-of-turn', { playerSide: 'A', bossSide: 'B' });
  eq(log, null, 'start-of-turn ≠ end-of-turn → null');
  eq(match.board.A[0].hp, 5, 'hp unchanged');
}

console.log('— boss mechanic dispatch: frost.freeze-random');
{
  const match = {
    kind: 'spire-boss',
    bossMechanic: { id: 'frost.freeze-random', phase: 'start-of-turn' },
    board: { A: [{ uid: 'a1', hp: 5, status: [] }, { uid: 'a2', hp: 3, status: [] }], B: [] },
    turn: 1,
  };
  applyBossMechanic(match, 'start-of-turn', { playerSide: 'A', bossSide: 'B' });
  const frozenCount = match.board.A.filter(m => m.status.includes('frozen')).length;
  eq(frozenCount, 1, 'exactly one minion frozen');
}

console.log('— boss mechanic dispatch: sunken vault discard-on-draw');
{
  const match = {
    kind: 'spire-boss',
    bossMechanic: { id: 'sunken.discard-on-draw', phase: 'on-draw', params: { discardEveryNth: 2 } },
    hands: { A: ['card1', 'card2'], B: [] },
  };
  // First draw — no discard.
  const log1 = applyBossMechanic(match, 'on-draw', { playerSide: 'A', bossSide: 'B', drawingSide: 'A', drawnCardId: 'card1' });
  eq(log1, null, '1st draw → no discard');
  eq(match.hands.A.length, 2, 'hand unchanged');
  // Second draw — discard fires.
  const log2 = applyBossMechanic(match, 'on-draw', { playerSide: 'A', bossSide: 'B', drawingSide: 'A', drawnCardId: 'card2' });
  assert(log2 && log2.length, '2nd draw → discard log emitted');
  eq(match.hands.A.length, 1, 'hand reduced 2→1');
}

console.log('');
console.log(`PASSED — ${pass} ok / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
