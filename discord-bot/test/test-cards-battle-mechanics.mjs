// Unit tests for the cards-battle.js resolver mechanic extensions
// (Clay 2026-05-31): rush, spell-immune, freeze, allEnemy target, and the
// spire one-off effects cloneSelf / reSummon / revealAndDraw. These cover
// the cards the audit found were referencing mechanics the resolver did
// not previously implement.
//
// Run with:  node test/test-cards-battle-mechanics.mjs

import { createMatch, applyAction, isLegalAction } from '../cards-battle.js';
import { CARDS } from '../cards-content.js';

// Synthetic test-only cards for mechanics that no shipped card exercises
// yet (Combo + Overload land with Embercrown/Tides). Injected into the
// live CARDS map so the resolver dispatches them like any other card,
// WITHOUT polluting the shipped catalogue or its load-time schema check.
CARDS['test.combo'] = {
  id: 'test.combo', name: 'Combo Tester', type: 'minion', mana: 0, atk: 1, hp: 1,
  keywords: [], abilities: [{ trigger: 'combo', effect: 'damage', target: 'oppHero', value: 5 }],
};
CARDS['test.overload'] = {
  id: 'test.overload', name: 'Overload Tester', type: 'minion', mana: 1, atk: 1, hp: 1,
  keywords: [], abilities: [], overload: 2,
};
// A guaranteed-vanilla body. Many "filler" catalogue minions (incl.
// tok.boneknight) carry a backfilled keyword, so tests that need a truly
// keyword-free minion use this instead.
CARDS['test.vanilla'] = {
  id: 'test.vanilla', name: 'Vanilla Bear', type: 'minion', mana: 5, atk: 7, hp: 6,
  keywords: [], abilities: [],
};

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
  play(m, 'A', 'beast.u004');           // Vale Boar, rush
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
  // window itself has lifted, no longer 'rush-no-hero'.)
  const faceLegal2 = legal(m, 'A', { kind: 'attack', attackerUid: r2.uid, defenderUid: 'hero' });
  ok(faceLegal2.reason !== 'rush-no-hero', 'rush face-restriction lifts on later turns');
}

// ── FREEZE ───────────────────────────────────────────────────────────
console.log('freeze:');
{
  const m = freshMatch();
  play(m, 'B', 'tok.boneknight');       // a B minion to be frozen
  const victim = lastBoard(m, 'B');
  play(m, 'A', 'spire.s06.permafrost'); // Permafrost Lich, onPlay freeze allEnemyMinions
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
  play(m, 'B', 'arcane.c002');          // Apprentice, spell-immune
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

// ── TAUNT (verification: prevents non-Taunt targeting) ───────────────
console.log('taunt:');
{
  const m = freshMatch();
  play(m, 'B', 'r.boltknight');     // Bolt Knight, Taunt 4/5
  play(m, 'B', 'test.vanilla');     // a guaranteed non-taunt body
  const taunt = m.board.B.find(x => x.cardId === 'r.boltknight');
  const nontaunt = m.board.B.find(x => x.cardId === 'test.vanilla');
  play(m, 'A', 'u.scrapper');       // Charge body so it can swing now
  const atk = lastBoard(m, 'A'); atk.canAttack = true;
  const r1 = legal(m, 'A', { kind: 'attack', attackerUid: atk.uid, defenderUid: nontaunt.uid });
  eq(r1.reason, 'must-target-taunt', 'cannot hit a non-taunt while a Taunt stands');
  const r2 = legal(m, 'A', { kind: 'attack', attackerUid: atk.uid, defenderUid: taunt.uid });
  ok(r2.ok === true, 'CAN attack the Taunt minion');
  const r3 = legal(m, 'A', { kind: 'attack', attackerUid: atk.uid, defenderUid: 'hero' });
  eq(r3.reason, 'taunt-blocks', 'cannot go face through a Taunt');
}

// ── DIVINE SHIELD / WARD (verification: negates first hit) ────────────
console.log('divine shield (shield):');
{
  const m = freshMatch();
  play(m, 'B', 'u.tankknight');     // Tank Knight, Shield 4/6
  const sh = lastBoard(m, 'B');
  const hp0 = sh.hp;
  play(m, 'A', 'u.firebolt', sh.uid);   // 3 dmg, absorbed by the shield
  eq(sh.hp, hp0, 'Ward negates the first instance of damage');
  ok(!has(sh, 'shield'), 'the shield is consumed after blocking once');
  play(m, 'A', 'u.firebolt', sh.uid);   // now it lands
  eq(sh.hp, hp0 - 3, 'damage lands once the shield is gone');
}

// ── POISON / VENOMOUS (verification: destroys regardless of HP) ───────
console.log('poison:');
{
  const m = freshMatch();
  play(m, 'A', 'u.honeybadger');    // 2/3 Poison
  const pois = lastBoard(m, 'A');
  pois.canAttack = true; pois.status = (pois.status || []).filter(s => s !== 'rush-fresh');
  play(m, 'B', 'test.vanilla');     // 7/6, far more HP than the badger's 2 atk
  const big = lastBoard(m, 'B');
  m.active = 'A';                   // playing on B flipped the active side
  applyAction(m, { kind: 'attack', side: 'A', attackerUid: pois.uid, defenderUid: big.uid });
  ok(!m.board.B.find(x => x.uid === big.uid), 'Poison destroys a minion regardless of its HP');
}

// ── STEALTH / VEILED (verification: prevents targeting) ──────────────
console.log('stealth:');
{
  const m = freshMatch();
  play(m, 'B', 'u.daggerthief');    // Stealth 3/2
  const st = lastBoard(m, 'B');
  play(m, 'A', 'u.scrapper');
  const a = lastBoard(m, 'A'); a.canAttack = true; a.status = [];
  const r = legal(m, 'A', { kind: 'attack', attackerUid: a.uid, defenderUid: st.uid });
  eq(r.reason, 'stealth-blocks', 'a Veiled minion cannot be attacked');
}

// ── LIFESTEAL / DRAIN (verification: heals correctly) ────────────────
console.log('lifesteal:');
{
  const m = freshMatch();
  m.hp.A = 20;
  play(m, 'A', 'u.bloodhound');     // 3/3 Lifesteal
  const bh = lastBoard(m, 'A'); bh.canAttack = true; bh.status = [];
  applyAction(m, { kind: 'attack', side: 'A', attackerUid: bh.uid, defenderUid: 'hero' });
  eq(m.hp.A, 23, 'Drain heals your hero by the damage dealt (3)');
}

// ── BATTLECRY (verification: fires on play from hand) ────────────────
console.log('battlecry:');
{
  const m = freshMatch();
  m.hands.A = [];
  play(m, 'A', 'u.runesinger');     // Battlecry: draw a card
  eq(m.hands.A.length, 1, 'Battlecry fires when played from hand (drew 1)');
}

// ── DEATHRATTLE / FINAL STRIKE (verification: fires on death) ─────────
console.log('deathrattle:');
{
  const m = freshMatch();
  m.hands.A = [];
  play(m, 'A', 'voidborn.c01');     // Drift Lantern, Deathrattle: draw a card
  const lantern = lastBoard(m, 'A');
  lantern.hp = 0;
  play(m, 'A', 'tok.boneknight');   // any play resolves deaths
  ok(m.hands.A.length >= 1, 'Deathrattle fires on death (drew a card)');
}

// ── REBORN / PHOENIX (Voidborn) ──────────────────────────────────────
console.log('reborn:');
{
  const m = freshMatch();
  play(m, 'A', 'voidborn.c07');     // Threadbare Revenant, Reborn 2/3
  const first = lastBoard(m, 'A');
  first.hp = 0;
  play(m, 'A', 'tok.boneknight');
  const revived = m.board.A.find(x => x.cardId === 'voidborn.c07');
  ok(revived && revived.uid !== first.uid, 'Reborn returns the minion on its first death');
  eq(revived.hp, 1, 'Reborn returns it at 1 HP');
  ok(!(revived.keywords || []).includes('reborn'), 'the Reborn copy drops the keyword');
  revived.hp = 0;
  play(m, 'A', 'tok.boneknight');
  eq(countCard(m, 'A', 'voidborn.c07'), 0, 'Reborn only happens once (no loop)');
}

// ── RECRUIT (Voidborn) ───────────────────────────────────────────────
console.log('recruit:');
{
  const m = freshMatch();        // deck is all 0-cost boneknights (<= 2 mana)
  const deckBefore = m.decks.A.length;
  const boardBefore = m.board.A.length;
  play(m, 'A', 'voidborn.u06');  // Battlecry: Recruit a minion costing <= 2
  eq(m.board.A.length, boardBefore + 2, 'Recruit adds the recruiter + a pulled minion');
  eq(m.decks.A.length, deckBefore - 1, 'Recruit pulls the minion OUT of the deck');
  ok(m.board.A.some(x => x.cardId === 'tok.boneknight'), 'the recruited body is a deck minion');
}

// ── COMBO (Embercrown/Tides preview, synthetic card) ────────────────
console.log('combo:');
{
  const m = freshMatch();
  const hp0 = m.hp.B;
  play(m, 'A', 'test.combo');     // FIRST card this turn, combo must NOT fire
  eq(m.hp.B, hp0, 'Combo does not fire on the first card of the turn');
}
{
  const m = freshMatch();
  const hp0 = m.hp.B;
  play(m, 'A', 'tok.boneknight'); // a first card
  play(m, 'A', 'test.combo');     // second card, combo fires for 5 to face
  eq(m.hp.B, hp0 - 5, 'Combo fires when it is not the turn\'s first card');
}

// ── OVERLOAD (Tides preview, synthetic card) ────────────────────────
console.log('overload:');
{
  const m = freshMatch();
  play(m, 'A', 'test.overload');  // Overload (2)
  eq(m.overloadNext.A, 2, 'Overload accrues locked mana for next turn');
  m.active = 'A';
  applyAction(m, { kind: 'endTurn', side: 'A' });
  applyAction(m, { kind: 'endTurn', side: 'B' });   // back to A's start of turn
  eq(m.mana.A.cur, m.mana.A.max - 2, 'Overload locks 2 mana on the next turn');
  eq(m.overloadNext.A, 0, 'Overload is consumed after one turn');
}

// ── IRON SKIN / hero buffThisTurn wears off (engine-rules fix) ───────
console.log('hero temp HP wears off:');
{
  const m = freshMatch();
  m.hp.A = 20;
  // Synthetic 'Iron Skin' spell: +4 HP to your hero THIS TURN only.
  CARDS['test.ironskin'] = {
    id: 'test.ironskin', name: 'Iron Skin', type: 'spell', mana: 1, atk: 0, hp: 0,
    keywords: [], abilities: [{ trigger: 'onCast', effect: 'buffThisTurn', target: 'selfHero', valueHp: 4 }],
  };
  play(m, 'A', 'test.ironskin');
  eq(m.hp.A, 24, 'hero this-turn HP applies immediately (+4)');
  m.active = 'A';
  applyAction(m, { kind: 'endTurn', side: 'A' });
  eq(m.hp.A, 20, 'hero this-turn HP is subtracted back at end of turn');
  eq((m.heroTempHp || {}).A || 0, 0, 'heroTempHp bookkeeping is cleared');
}

// ── SILENCE strips keywords + statuses (engine-rules fix) ────────────
console.log('silence strips keywords:');
{
  const m = freshMatch();
  play(m, 'B', 'r.boltknight');     // Taunt 4/5
  const taunt = lastBoard(m, 'B');
  ok((taunt.keywords || []).includes('taunt'), 'setup: minion has taunt');
  // Synthetic silence spell targeting a picked minion.
  CARDS['test.silence'] = {
    id: 'test.silence', name: 'Hush', type: 'spell', mana: 1, atk: 0, hp: 0,
    keywords: [], abilities: [{ trigger: 'onCast', effect: 'silence', target: 'pickedTarget' }],
  };
  play(m, 'A', 'test.silence', taunt.uid);
  eq((taunt.keywords || []).length, 0, 'silence strips all keywords');
  ok(has(taunt, 'silenced'), 'the silenced marker remains');
  // A silenced taunt no longer forces targeting.
  play(m, 'B', 'test.vanilla');
  const other = lastBoard(m, 'B');
  play(m, 'A', 'u.scrapper'); const atk = lastBoard(m, 'A'); atk.canAttack = true; atk.status = [];
  const r = legal(m, 'A', { kind: 'attack', attackerUid: atk.uid, defenderUid: other.uid });
  ok(r.ok === true, 'a silenced taunt no longer blocks other targets');
}
{
  // Silence clears shield too.
  const m = freshMatch();
  play(m, 'B', 'u.tankknight');     // Shield 4/6
  const sh = lastBoard(m, 'B');
  ok(has(sh, 'shield'), 'setup: minion has a shield');
  CARDS['test.silence'] = CARDS['test.silence'] || {
    id: 'test.silence', name: 'Hush', type: 'spell', mana: 1, atk: 0, hp: 0,
    keywords: [], abilities: [{ trigger: 'onCast', effect: 'silence', target: 'pickedTarget' }],
  };
  play(m, 'A', 'test.silence', sh.uid);
  ok(!has(sh, 'shield'), 'silence clears the shield status');
}

// ── BOARD CAP (engine-rules fix) ─────────────────────────────────────
console.log('board cap:');
{
  const m = freshMatch();
  for (let i = 0; i < 7; i++) play(m, 'A', 'test.vanilla');
  eq(m.board.A.length, 7, 'board fills to 7');
  const r = play(m, 'A', 'test.vanilla');   // 8th, must be rejected
  eq(r.error, 'board-full', 'playing an 8th minion is rejected (board-full)');
  eq(m.board.A.length, 7, 'board stays at 7');
  const lr = legal(m, 'A', { kind: 'playCard', handIdx: 0 });
  // hand[0] is a vanilla we pushed; the legality helper should also block it.
  m.hands.A = ['test.vanilla'];
  const lr2 = legal(m, 'A', { kind: 'playCard', handIdx: 0 });
  eq(lr2.reason, 'board-full', 'isLegalAction blocks a minion play on a full board');
}
{
  // summon with count respects the cap.
  const m = freshMatch();
  for (let i = 0; i < 6; i++) play(m, 'A', 'test.vanilla');   // 6 on board
  play(m, 'A', 'spire.s04.hollowheart');  // taunt body + summon two thorns
  // Board was 6, Hollowheart makes 7, then summon of 2 can only fit 0.
  eq(m.board.A.length, 7, 'summon stops at the board cap');
}
{
  // Hollowheart summons two thorns on an empty-ish board (fix for the
  // token:{id} -> cardId shape that used to no-op).
  const m = freshMatch();
  play(m, 'A', 'spire.s04.hollowheart');
  eq(countCard(m, 'A', 'spire.token.thorn'), 2, 'Hollowheart summons two Thorn Vines');
}

// ── STEALTH-TAUNT does not soft-lock (engine-rules fix) ──────────────
console.log('stealth taunt:');
{
  const m = freshMatch();
  play(m, 'B', 'u.daggerthief');    // Stealth 3/2
  const st = lastBoard(m, 'B');
  st.keywords = (st.keywords || []).concat('taunt');   // stealthed + taunt
  ok(has(st, 'stealth-fresh') || has(st, 'stealth'), 'setup: minion is stealthed');
  play(m, 'A', 'u.scrapper'); const atk = lastBoard(m, 'A'); atk.canAttack = true; atk.status = [];
  // Face should be reachable: a stealthed taunt does not block.
  const r = legal(m, 'A', { kind: 'attack', attackerUid: atk.uid, defenderUid: 'hero' });
  ok(r.reason !== 'taunt-blocks', 'a stealthed taunt does not block the hero');
}

// ── GHOST MINION reaped at end of turn (engine-rules fix) ────────────
console.log('temp-buff ghost minions:');
{
  const m = freshMatch();
  play(m, 'A', 'test.vanilla');   // 7/6
  const v = lastBoard(m, 'A');
  // Grant +3 temp HP this turn (6 -> 9), THEN take 8 damage down to 1 while
  // the temp cushion is up. Wear-off subtracts 3 -> -2 -> death.
  CARDS['test.tempbuff'] = {
    id: 'test.tempbuff', name: 'Fleeting Vigor', type: 'spell', mana: 0, atk: 0, hp: 0,
    keywords: [], abilities: [{ trigger: 'onCast', effect: 'buffThisTurn', target: 'pickedTarget', valueHp: 3 }],
  };
  play(m, 'A', 'test.tempbuff', v.uid);
  eq(v.hp, 9, 'temp HP applied (6 + 3)');
  v.hp = 1;                        // took 8 damage while cushioned
  m.active = 'A';
  applyAction(m, { kind: 'endTurn', side: 'A' });
  ok(!m.board.A.find(x => x.uid === v.uid), 'a minion that hits 0 HP on wear-off is reaped, not a ghost');
}

// ── onAttack ordering: dead defender does not retaliate (engine fix) ─
console.log('onAttack kills defender pre-strike:');
{
  const m = freshMatch();
  // Attacker whose onAttack deals 5 to a picked target (enough to kill a
  // 1/1) before combat. Give it charge so it can swing this turn.
  CARDS['test.onattack'] = {
    id: 'test.onattack', name: 'Preemptive Wyrm', type: 'minion', mana: 1, atk: 2, hp: 1,
    keywords: ['charge'], abilities: [{ trigger: 'onAttack', effect: 'damage', target: 'pickedTarget', value: 5 }],
  };
  // A 3/5 defender: onAttack's 5 damage kills it; its 3-atk retaliation
  // would kill the 1-hp wyrm if combat wrongly resolved against the corpse.
  CARDS['test.defender'] = {
    id: 'test.defender', name: 'Retaliator', type: 'minion', mana: 3, atk: 3, hp: 5,
    keywords: [], abilities: [],
  };
  play(m, 'B', 'test.defender');
  const big = lastBoard(m, 'B');
  play(m, 'A', 'test.onattack');
  const wyrm = lastBoard(m, 'A'); wyrm.canAttack = true;
  applyAction(m, { kind: 'attack', side: 'A', attackerUid: wyrm.uid, defenderUid: big.uid });
  ok(!m.board.B.find(x => x.uid === big.uid), 'onAttack killed the defender');
  const survived = m.board.A.find(x => x.uid === wyrm.uid);
  ok(survived && survived.hp === 1, 'the dead defender did NOT retaliate (attacker keeps full HP)');
}

// ── SPIRE s03: returnToHand allEnemyMinions (spire fix) ──────────────
console.log('spire s03 tidescepter bounce:');
{
  const m = freshMatch();
  m.hands.B = [];
  play(m, 'B', 'test.vanilla');
  play(m, 'B', 'r.boltknight');
  const boardBefore = m.board.B.length;
  ok(boardBefore >= 2, 'setup: enemy has minions');
  play(m, 'A', 'spire.s03.tidescepter');
  eq(m.board.B.length, 0, 'Tidescepter bounces all enemy minions off the board');
  ok(m.hands.B.length >= 2, 'the bounced minions land in the enemy hand');
}

// ── SPIRE s12: onAttack self-heal actually heals (spire fix) ─────────
console.log('spire s12 crimsongoblet self-heal:');
{
  const m = freshMatch();
  play(m, 'A', 'spire.s12.crimsongoblet');   // 4/6 lifesteal, onAttack heal self 2
  const gob = lastBoard(m, 'A');
  gob.hp = 3; gob.canAttack = true; gob.status = [];
  applyAction(m, { kind: 'attack', side: 'A', attackerUid: gob.uid, defenderUid: 'hero' });
  const g = m.board.A.find(x => x.uid === gob.uid);
  eq(g.hp, 5, 'Crimsongoblet heals itself 2 when it attacks (3 -> 5)');
}

// ── SPIRE s09: reSummon comes back with -1 attack (spire fix) ────────
console.log('spire s09 relicspine -1 attack:');
{
  const m = freshMatch();
  play(m, 'A', 'spire.s09.relicspine');   // 6/4
  const first = m.board.A.find(x => x.cardId === 'spire.s09.relicspine');
  first.hp = 0;
  play(m, 'A', 'tok.boneknight');
  const revived = m.board.A.find(x => x.cardId === 'spire.s09.relicspine');
  ok(revived && revived.uid !== first.uid, 'reSummon resurrects the reaver');
  eq(revived.atk, 5, 'the resurrected reaver comes back at -1 attack (6 -> 5)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
