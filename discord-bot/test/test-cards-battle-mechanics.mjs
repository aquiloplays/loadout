// Unit tests for the cards-battle.js resolver mechanic extensions
// (Clay 2026-05-31): rush, spell-immune, freeze, allEnemy target, and the
// spire one-off effects cloneSelf / reSummon / revealAndDraw. These cover
// the cards the audit found were referencing mechanics the resolver did
// not previously implement.
//
// Run with:  node test/test-cards-battle-mechanics.mjs

import { createMatch, applyAction, isLegalAction } from '../cards-battle.js';

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } }
function eq(a, b, m) { if (a === b) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m, '(want', b, 'got', a, ')'); } }

let seq = 0;
function freshMatch() {
  const deck = Array(30).fill('tok.boneknight');
  const m = createMatch({ matchId: 'mech-test-' + (seq++), playerA: { userId: 'a', deck }, playerB: { userId: 'b', deck }, goingFirst: 'A' });
  m.status = 'active';
  m.mana.A = { cur: 99, max: 99 }; m.mana.B = { cur: 99, max: 99 };
  m.hands.A = []; m.hands.B = [];
  return m;
}
function play(m, side, cardId, targetUid) {
  m.active = side;
  m.mana[side] = { cur: 99, max: 99 };
  m.hands[side] = [cardId, ...m.hands[side]];
  const r = applyAction(m, { kind: 'playCard', side, handIdx: 0, targetUid });
  return r;
}
const lastBoard = (m, side) => m.board[side][m.board[side].length - 1];
const has = (mn, s) => (mn.status || []).includes(s);
const countCard = (m, side, cardId) => m.board[side].filter(x => x.cardId === cardId).length;
// isLegalAction enforces side === match.active, so set the active side for
// the query first (these tests drive both sides by hand).
function legal(m, side, action) { m.active = side; return isLegalAction(m, { ...action, side }); }

// ── RUSH ─────────────────────────────────────────────────────────────
console.log('rush:');
{
  const m = freshMatch();
  play(m, 'A', 'beast.u004');           // Vale Boar — rush
  const r = lastBoard(m, 'A');
  ok(r.canAttack === true, 'rush minion can attack the turn it is played');
  ok(has(r, 'rush-fresh'), 'rush minion carries rush-fresh the turn it lands');
  const faceLegal = legal(m, 'A', { kind: 'attack', attackerUid: r.uid, defenderUid: 'hero' });
  eq(faceLegal.reason, 'rush-no-hero', 'rush cannot attack the enemy hero the turn it lands');
  play(m, 'B', 'tok.boneknight');       // an enemy minion to trade with
  const enemy = lastBoard(m, 'B');
  const minionLegal = legal(m, 'A', { kind: 'attack', attackerUid: r.uid, defenderUid: enemy.uid });
  ok(minionLegal.ok === true, 'rush CAN attack an enemy minion the turn it lands');
  // Cycle back to A's turn: rush-fresh should clear so it can go face.
  applyAction(m, { kind: 'endTurn', side: 'A' });
  applyAction(m, { kind: 'endTurn', side: 'B' });
  const r2 = m.board.A.find(x => x.cardId === 'beast.u004');
  ok(r2 && !has(r2, 'rush-fresh'), 'rush-fresh clears on the owner\'s next turn');
  // (A taunt minion may still block face; what we assert is that the rush
  // window itself has lifted — no longer 'rush-no-hero'.)
  const faceLegal2 = legal(m, 'A', { kind: 'attack', attackerUid: r2.uid, defenderUid: 'hero' });
  ok(faceLegal2.reason !== 'rush-no-hero', 'rush face-restriction lifts on later turns');
}

// ── FREEZE ───────────────────────────────────────────────────────────
console.log('freeze:');
{
  const m = freshMatch();
  play(m, 'B', 'tok.boneknight');       // a B minion to be frozen
  const victim = lastBoard(m, 'B');
  play(m, 'A', 'spire.s06.permafrost'); // Permafrost Lich — onPlay freeze allEnemyMinions
  ok(has(victim, 'frozen'), 'Permafrost Lich freezes enemy minions on play');
  victim.canAttack = true;              // even if it could, frozen blocks it
  const fl = legal(m, 'B', { kind: 'attack', attackerUid: victim.uid, defenderUid: 'hero' });
  eq(fl.reason, 'frozen', 'a frozen minion cannot attack');
  m.active = 'A';                                    // (legal() above left it on B)
  applyAction(m, { kind: 'endTurn', side: 'A' });   // -> startTurn B thaws it
  ok(!has(victim, 'frozen'), 'frozen clears at the owner\'s start of turn');
  ok(victim.canAttack === false, 'thawed minion still skips that turn (cannot attack)');
}

// ── SPELL-IMMUNE ─────────────────────────────────────────────────────
console.log('spell-immune:');
{
  const m = freshMatch();
  play(m, 'B', 'arcane.c002');          // Apprentice — spell-immune
  const immune = lastBoard(m, 'B');
  const immHpBefore = immune.hp;
  play(m, 'B', 'tok.boneknight');       // a normal minion for comparison
  const normal = lastBoard(m, 'B');
  // A casts a single-target damage spell at the immune minion -> no effect.
  play(m, 'A', 'r.gobpowder', immune.uid);
  eq(immune.hp, immHpBefore, 'enemy spell cannot damage a spell-immune minion');
  // Same spell at the normal minion -> it is hit (damaged or dead).
  const normUid = normal.uid;
  play(m, 'A', 'r.gobpowder', normUid);
  const stillThere = m.board.B.find(x => x.uid === normUid);
  ok(!stillThere || stillThere.hp < normal.maxHp, 'enemy spell still hits a normal minion');
}
{
  // Combat ignores spell-immunity. Isolated board (no taunt minion to
  // force-redirect the swing).
  const m = freshMatch();
  play(m, 'B', 'arcane.c002');          // lone spell-immune minion
  const immune = lastBoard(m, 'B');
  const before = immune.hp;
  play(m, 'A', 'beast.u004');           // a body to swing in
  const body = lastBoard(m, 'A');
  body.canAttack = true; body.status = (body.status || []).filter(s => s !== 'rush-fresh');
  applyAction(m, { kind: 'attack', side: 'A', attackerUid: body.uid, defenderUid: immune.uid });
  ok(immune.hp < before, 'spell-immune does NOT block combat damage');
}

// ── allEnemy TARGET (Apexorb Tyrant) ─────────────────────────────────
console.log('allEnemy target:');
{
  const m = freshMatch();
  play(m, 'B', 'tok.boneknight');
  const victim = lastBoard(m, 'B');
  const hpBefore = m.hp.B;
  play(m, 'A', 'spire.s10.apexorb');    // onPlay damage allEnemies value 3
  eq(m.hp.B, hpBefore - 3, 'allEnemy hits the enemy hero');
  const v = m.board.B.find(x => x.uid === victim.uid);
  ok(!v || v.hp <= victim.maxHp - 3, 'allEnemy hits enemy minions too');
}

// ── cloneSelf (Silvermask Twin) ──────────────────────────────────────
console.log('cloneSelf:');
{
  const m = freshMatch();
  play(m, 'A', 'spire.s08.silvermask'); // onPlay cloneSelf
  eq(countCard(m, 'A', 'spire.s08.silvermask'), 2, 'cloneSelf leaves two copies on board');
}

// ── reSummon (Relicspine Reaver) ─────────────────────────────────────
console.log('reSummon:');
{
  const m = freshMatch();
  play(m, 'A', 'spire.s09.relicspine');
  const first = m.board.A.find(x => x.cardId === 'spire.s09.relicspine');
  first.hp = 0;
  play(m, 'A', 'tok.boneknight');       // any play triggers resolveDeaths
  const revived = m.board.A.find(x => x.cardId === 'spire.s09.relicspine');
  ok(revived && revived.uid !== first.uid, 'reSummon resurrects the dying minion once');
  ok(revived && revived.noReSummon === true, 'the resurrected copy is flagged noReSummon');
  revived.hp = 0;
  play(m, 'A', 'tok.boneknight');
  eq(countCard(m, 'A', 'spire.s09.relicspine'), 0, 'the resurrected copy does NOT resurrect again (no loop)');
}

// ── revealAndDraw (Starcharter Magus) ────────────────────────────────
console.log('revealAndDraw:');
{
  const m = freshMatch();
  m.hands.A = [];
  const deckBefore = m.decks.A.length;
  play(m, 'A', 'spire.s11.starcharter'); // onPlay revealAndDraw value 3
  eq(m.hands.A.length, 3, 'revealAndDraw draws 3 cards');
  eq(m.decks.A.length, deckBefore - 3, 'revealAndDraw pulls them from the deck');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
