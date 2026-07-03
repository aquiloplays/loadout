// Unit tests for the simulate-and-score NPC policy (cards-match.js
// __npcTest surface). Deterministic seeds throughout.
//
// Run with:  node test/test-npc-ai.mjs
//
// Covers (task 9):
//   - LETHAL taken when available (attackers / burn spell / hero power)
//   - no WASTED targeted spells (freeze/removal with no valid target)
//   - NPC MULLIGAN tosses expensive cards (>=4 aggro, >=5 others)
//   - new expansion decks are real + valid

import { createMatch, applyAction } from '../cards-battle.js';
import { CARDS, NPC_DECKS, championForClass } from '../cards-content.js';
import { __npcTest } from '../cards-match.js';

const { pickNpcAction, runNpcTurn, npcMulliganIndices, lethalNextAction, policyFor, enumerateCandidates } = __npcTest;

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } }
function eq(a, b, m) { if (a === b) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m, '(want', b, 'got', a, ')'); } }

// Build an active NPC match with the NPC on side B, empty hands/boards,
// lots of mana. Deterministic seed via matchId.
let seq = 0;
function npcMatch(archetype = 'aggro') {
  const deck = Array(20).fill('c.gobrunt');
  const npcDeck = NPC_DECKS[archetype];
  const m = createMatch({
    matchId: 'npc-test-' + (seq++),
    playerA: { userId: 'a', deck },
    playerB: null,
    npc: { archetype, deck: [...npcDeck.cards, championForClass(npcDeck.champion)], championClass: npcDeck.champion },
    goingFirst: 'B',
  });
  m.status = 'active';
  m.mana.A = { cur: 0, max: 0 };
  m.mana.B = { cur: 10, max: 10 };
  m.hands.A = []; m.hands.B = [];
  m.board.A = []; m.board.B = [];
  m.active = 'B';
  return m;
}
// Place a minion on a side directly (ready to attack).
function put(m, side, card, over = {}) {
  const uid = 'x' + (m.boardUidCounter++);
  const mn = {
    uid, cardId: card.id, atk: card.atk || 0, hp: card.hp || 0, maxHp: card.hp || 0,
    keywords: (card.keywords || []).slice(), status: [], canAttack: true, ...over,
  };
  m.board[side].push(mn);
  return mn;
}

// ── LETHAL: a ready attacker that covers the enemy hero's HP ──────────
console.log('lethal via board attack:');
{
  const m = npcMatch('aggro');
  m.hp.A = 5;
  put(m, 'B', { id: 'c.gobrunt', atk: 6, hp: 6, keywords: [] });
  const a = lethalNextAction(m, 'B');
  ok(a && a.kind === 'attack' && a.defenderUid === 'hero', 'lethal plan swings the 6-atk minion at the face');
  // Drive the whole turn: the enemy hero should die.
  runNpcTurn(m);
  ok(m.hp.A <= 0, 'enemy hero is dead after the NPC turn (lethal taken)');
  ok(m.status === 'B-won', 'match resolves as NPC win');
}

console.log('lethal via burn spell:');
{
  // voidborn.u15: 5 mana, deal 2 to all enemy (hits face). Give the NPC
  // exactly this in hand with the enemy at 2 HP.
  const m = npcMatch('burn');
  m.hp.A = 2;
  m.hands.B = ['voidborn.u15'];
  m.mana.B = { cur: 10, max: 10 };
  const a = lethalNextAction(m, 'B');
  ok(a && a.kind === 'playCard', 'lethal plan casts the face-burn spell');
  runNpcTurn(m);
  ok(m.hp.A <= 0 && m.status === 'B-won', 'burn spell closes the game');
}

console.log('lethal via hero power (coin-strike, rogue):');
{
  // Rogue coin-strike = 1 face dmg. Enemy at 1 HP, NPC has spare mana.
  const m = npcMatch('swarm');   // swarm champion is rogue
  eq(m.heroPower.B.id, 'coin-strike', 'swarm NPC has coin-strike hero power');
  m.hp.A = 1;
  m.mana.B = { cur: 10, max: 10 };
  const a = lethalNextAction(m, 'B');
  ok(a && a.kind === 'heroPower', 'lethal plan fires the hero power for the last point');
  runNpcTurn(m);
  ok(m.hp.A <= 0 && m.status === 'B-won', 'hero power closes the game');
}

console.log('NOT lethal: taunt wall blocks the plan:');
{
  const m = npcMatch('aggro');
  m.hp.A = 5;
  put(m, 'B', { id: 'c.gobrunt', atk: 6, hp: 6, keywords: [] });
  put(m, 'A', { id: 'u.shieldguard', atk: 1, hp: 8, keywords: ['taunt'] });
  const a = lethalNextAction(m, 'B');
  ok(a === null, 'no lethal while a taunt wall is up');
}

// ── NO WASTED TARGETED SPELLS ────────────────────────────────────────
console.log('no wasted targeted spell (freeze with no enemy minion):');
{
  // tides-of-aether.x003: freeze + 1 dmg to a picked minion. With NO
  // enemy minions on board, the NPC must NOT choose to cast it (it would
  // fizzle). Give it ONLY that spell + plenty of mana; the policy should
  // decline the play and end the turn.
  const m = npcMatch('frostbite');
  m.hands.B = ['tides-of-aether.x003'];
  m.mana.B = { cur: 10, max: 10 };
  m.board.A = [];   // no targets
  // No candidate should even OFFER the freeze cast when there is no
  // valid minion target (the play is dropped, not cast at null).
  const noTargetCands = enumerateCandidates(m, 'B', policyFor('frostbite'));
  ok(!noTargetCands.some(c => c.kind === 'playCard' && c.handIdx === 0),
     'no candidate casts the picked-target spell with no valid target');
  // With an enemy minion present, the freeze cast IS enumerated with a
  // real (non-null) target (whether or not it ends up the top pick).
  put(m, 'A', { id: 'test.vanilla', atk: 3, hp: 4, keywords: [] });
  const cands2 = enumerateCandidates(m, 'B', policyFor('frostbite'));
  const freezeCand = cands2.find(c => c.kind === 'playCard' && c.handIdx === 0);
  ok(freezeCand && freezeCand.targetUid, 'with a target present, the freeze cast is offered with a real target');
}

console.log('picked-damage spell never targets a spell-immune enemy alone:');
{
  const m = npcMatch('frostbite');
  m.hands.B = ['tides-of-aether.x003'];   // freeze+dmg, picked minion
  m.mana.B = { cur: 10, max: 10 };
  m.board.A = [];
  put(m, 'A', { id: 'test.vanilla', atk: 3, hp: 4, keywords: ['spell-immune'] });
  const cands = enumerateCandidates(m, 'B', policyFor('frostbite'));
  ok(!cands.some(c => c.kind === 'playCard' && c.handIdx === 0),
     'no candidate casts the freeze spell onto a spell-immune-only board (would fizzle)');
}

// ── MULLIGAN ─────────────────────────────────────────────────────────
console.log('mulligan tosses expensive cards:');
{
  const m = npcMatch('aggro');
  // Hand: cheap 1-drop, a 4-drop, a 6-drop, a 2-drop.
  m.hands.B = ['c.gobrunt' /*1*/, 'c.guardian5' /*5*/, 'leg.solara' /*7*/, 'u.scrapper' /*2*/];
  const idxs = npcMulliganIndices(m, 'B', 'aggro');
  ok(idxs.includes(1) && idxs.includes(2), 'aggro tosses the 5-drop and the 7-drop (>=4)');
  ok(!idxs.includes(0) && !idxs.includes(3), 'aggro keeps the 1-drop and 2-drop');
}
console.log('mulligan threshold is >=5 for non-aggro:');
{
  const m = npcMatch('control');
  m.hands.B = ['c.gobrunt' /*1*/, 'c.cleric4' /*4*/, 'c.guardian5' /*5*/];
  const idxs = npcMulliganIndices(m, 'B', 'control');
  ok(idxs.includes(2), 'control tosses the 5-drop');
  ok(!idxs.includes(1), 'control KEEPS the 4-drop (threshold is 5)');
}

// ── NEW EXPANSION DECKS ──────────────────────────────────────────────
console.log('new expansion decks are real + valid:');
{
  for (const name of ['frostbite', 'ember', 'umbra']) {
    const d = NPC_DECKS[name];
    ok(d && d.cards.length === 20, `${name} deck has 20 cards`);
    const allReal = d.cards.every(id => !!CARDS[id]);
    ok(allReal, `${name} deck references only real card ids`);
  }
}

// ── DETERMINISM: same seed → same first action ───────────────────────
console.log('determinism: identical state yields identical pick:');
{
  const mk = () => {
    const m = npcMatch('midrange');
    m.matchId = 'det-fixed'; m.seed = 12345; m.rngStep = 3; m.turn = 4;
    put(m, 'B', { id: 'c.gobrunt', atk: 3, hp: 3, keywords: [] });
    put(m, 'A', { id: 'test.vanilla', atk: 3, hp: 3, keywords: [] });
    put(m, 'A', { id: 'test.vanilla', atk: 3, hp: 3, keywords: [] });
    return m;
  };
  const a1 = pickNpcAction(mk(), 'B', 'midrange');
  const a2 = pickNpcAction(mk(), 'B', 'midrange');
  eq(JSON.stringify(a1), JSON.stringify(a2), 'same state → same action (seeded tie-break holds)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
