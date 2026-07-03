// Unit tests for hero-powers, gate logic, resolve effects,
// turn-boundary reset.
//
// Run from discord-bot/:
//   node test/test-hero-powers.mjs

import {
  HERO_POWER_DEFS,
  initHeroPowerForMatch,
  canUseHeroPower,
  resolveHeroPower,
  onTurnEnd,
} from '../hero-powers.js';

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } }
function eq(a, b, m)  { if (a === b) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m, '(want:', b, 'got:', a, ')'); } }

// Build a minimal match-state shaped like cards-battle's createMatch
// output. We only populate the slots hero-powers touches: players, hp,
// mana, board, turn, plus the heroPower record initialised below.
function makeMatch(opts = {}) {
  const m = {
    matchId: 'test',
    players: { A: 'user-a', B: 'user-b' },
    hp:      { A: 30, B: 30 },
    mana:    { A: { cur: 5, max: 5 }, B: { cur: 5, max: 5 } },
    board:   { A: [], B: [] },
    turn:    1,
    active:  'A',
    status:  'active',
    log:     [],
    boardUidCounter: 1,
  };
  // Populate hero powers per the spec.
  m.heroPower = {
    A: initHeroPowerForMatch(opts.aClass || 'warrior'),
    B: initHeroPowerForMatch(opts.bClass || 'mage'),
  };
  // Optional board minions.
  if (opts.minionsA) m.board.A = opts.minionsA;
  if (opts.minionsB) m.board.B = opts.minionsB;
  return m;
}

function makeMinion(uid, atk, hp, maxHp) {
  return {
    uid, cardId: 'test.minion', atk, hp,
    maxHp: typeof maxHp === 'number' ? maxHp : hp,
    canAttack: true, status: [], keywords: [],
  };
}

// ── 1. catalogue ─────────────────────────────────────────────────

console.log('- HERO_POWER_DEFS catalogue');
{
  const classes = ['warrior', 'mage', 'rogue', 'ranger', 'healer'];
  for (const cls of classes) {
    assert(HERO_POWER_DEFS[cls], `${cls} present in HERO_POWER_DEFS`);
    eq(HERO_POWER_DEFS[cls].manaCost, 2, `${cls} costs 2 mana`);
    assert(typeof HERO_POWER_DEFS[cls].name === 'string', `${cls} has a name`);
  }
  // Frozen, adding a key should fail silently or throw in strict.
  let mutated = false;
  try { HERO_POWER_DEFS.invented = { id: 'x' }; if (HERO_POWER_DEFS.invented) mutated = true; }
  catch { /* expected */ }
  eq(mutated, false, 'HERO_POWER_DEFS is frozen');
}

// ── 2. initHeroPowerForMatch ─────────────────────────────────────

console.log('- initHeroPowerForMatch defaults');
{
  // Site-canonical wire ids (heroPowers.ts): warrior class → 'armor-up'.
  const w = initHeroPowerForMatch('warrior');
  eq(w.id, 'armor-up', 'warrior id set (armor-up)');
  eq(w.manaCost, 2, 'warrior manaCost = 2');
  eq(w.usedThisTurn, false, 'warrior usedThisTurn = false');

  // Unknown class falls back to warrior / Armor Up.
  const bad = initHeroPowerForMatch('paladin');
  eq(bad.id, 'armor-up', 'unknown class → armor-up (warrior) fallback');
}

// ── 3. canUseHeroPower gates ────────────────────────────────────

console.log('- canUseHeroPower mana + once-per-turn');
{
  const m = makeMatch();
  // Mana gate
  m.mana.A.cur = 1;
  const lowMana = canUseHeroPower(m, 'A');
  eq(lowMana.ok, false, 'rejects when mana < cost');
  eq(lowMana.reason, 'insufficient-mana', 'reason = insufficient-mana');

  // OK path
  m.mana.A.cur = 5;
  const ok = canUseHeroPower(m, 'A');
  eq(ok.ok, true, 'allows when mana >= cost and not used');

  // Once-per-turn gate
  m.heroPower.A.usedThisTurn = true;
  const blocked = canUseHeroPower(m, 'A');
  eq(blocked.ok, false, 'rejects when already used this turn');
  eq(blocked.reason, 'already-used-this-turn', 'reason = already-used-this-turn');

  // Bad side
  const badSide = canUseHeroPower(m, 'Z');
  eq(badSide.ok, false, 'bad side rejected');
}

// ── 4. resolveHeroPower per class ───────────────────────────────

console.log('- resolveHeroPower: warrior Armor Up');
{
  const m = makeMatch({ aClass: 'warrior' });
  const r = resolveHeroPower(m, 'A');
  eq(r.log[0].kind, 'hero-power', 'log entry kind = hero-power');
  eq(r.log[0].effect, 'armor', 'effect = armor');
  eq(m.heroArmor.A, 2, 'armor delta = +2 (initial)');
  eq(m.mana.A.cur, 3, 'mana spent: 5 → 3');
  eq(m.heroPower.A.usedThisTurn, true, 'usedThisTurn = true after fire');

  // Re-firing should be blocked.
  const second = resolveHeroPower(m, 'A');
  eq(second.log[0].kind, 'hero-power-rejected', 'second fire same turn = rejected');
  eq(second.log[0].reason, 'already-used-this-turn', 'reason = already-used-this-turn');
  eq(m.heroArmor.A, 2, 'armor unchanged by rejected re-fire');
}

console.log('- resolveHeroPower: mage Fire Bolt');
{
  // Fire Bolt at enemy hero.
  const m1 = makeMatch({ aClass: 'mage' });
  const r1 = resolveHeroPower(m1, 'A', { targetId: 'oppHero' });
  eq(r1.log[0].effect, 'damage', 'effect = damage');
  eq(m1.hp.B, 29, 'enemy hero hp 30 → 29');
  eq(m1.mana.A.cur, 3, 'mana spent: 5 → 3');

  // Fire Bolt at enemy minion.
  const enemyMinion = makeMinion('u-1', 3, 4);
  const m2 = makeMatch({ aClass: 'mage', minionsB: [enemyMinion] });
  const r2 = resolveHeroPower(m2, 'A', { targetId: 'u-1' });
  eq(r2.log[0].effect, 'damage', 'effect = damage on minion');
  eq(enemyMinion.hp, 3, 'enemy minion 4 → 3');

  // No target → rejected, no mana spent, no flag flip.
  const m3 = makeMatch({ aClass: 'mage' });
  const r3 = resolveHeroPower(m3, 'A', {});
  eq(r3.log[0].kind, 'hero-power-rejected', 'no target → rejected');
  eq(r3.log[0].reason, 'invalid-target', 'reason = invalid-target');
  eq(m3.mana.A.cur, 5, 'no mana spent on rejected');
  eq(m3.heroPower.A.usedThisTurn, false, 'no flag flip on rejected');
}

console.log('- resolveHeroPower: rogue Coin Strike');
{
  // Site-canonical: Coin Strike deals 1 damage to the enemy hero, auto-
  // targeted (no manual pick), NOT a coin-pool buff (semantics changed to
  // match heroPowers.ts).
  const m = makeMatch({ aClass: 'rogue' });
  m.active = 'A';
  const r = resolveHeroPower(m, 'A');
  eq(r.log[0].effect, 'damage', 'effect = damage');
  eq(m.hp.B, 29, 'enemy hero hp 30 → 29');
  eq(m.mana.A.cur, 3, 'mana spent: 5 → 3');
  eq(m.heroPower.A.usedThisTurn, true, 'usedThisTurn set');
}

console.log('- resolveHeroPower: ranger Mark Target');
{
  const enemyMinion = makeMinion('u-2', 5, 5);
  const m = makeMatch({ aClass: 'ranger', minionsB: [enemyMinion] });
  const r = resolveHeroPower(m, 'A', { targetId: 'u-2' });
  eq(r.log[0].effect, 'mark', 'effect = mark');
  assert(m.markedTargets && m.markedTargets['u-2'], 'markedTargets entry exists');
  eq(m.markedTargets['u-2'].bonusDamage, 1, 'bonusDamage = 1');
  eq(m.markedTargets['u-2'].markedBy, 'A', 'markedBy = A');

  // Marking own minion → rejected (must target enemy).
  const friendlyMinion = makeMinion('u-3', 1, 1);
  const m2 = makeMatch({ aClass: 'ranger', minionsA: [friendlyMinion] });
  const r2 = resolveHeroPower(m2, 'A', { targetId: 'u-3' });
  eq(r2.log[0].kind, 'hero-power-rejected', 'mark own minion → rejected');
}

console.log('- resolveHeroPower: healer Lesser Heal');
{
  // Heal own hero.
  const m1 = makeMatch({ aClass: 'healer' });
  m1.hp.A = 20;
  const r1 = resolveHeroPower(m1, 'A', { targetId: 'selfHero' });
  eq(r1.log[0].effect, 'heal', 'effect = heal');
  eq(m1.hp.A, 22, 'own hero hp 20 → 22');

  // Cap at 30.
  const m2 = makeMatch({ aClass: 'healer' });
  m2.hp.A = 29;
  resolveHeroPower(m2, 'A', { targetId: 'selfHero' });
  eq(m2.hp.A, 30, 'heal caps at 30');

  // Heal friendly minion.
  const wounded = makeMinion('u-4', 2, 1, 5);   // dmg'd from 5 → 1
  const m3 = makeMatch({ aClass: 'healer', minionsA: [wounded] });
  resolveHeroPower(m3, 'A', { targetId: 'u-4' });
  eq(wounded.hp, 3, 'friendly minion 1 → 3');

  // Heal enemy minion → rejected (healer only targets friendlies).
  const enemy = makeMinion('u-5', 2, 1, 5);
  const m4 = makeMatch({ aClass: 'healer', minionsB: [enemy] });
  const r4 = resolveHeroPower(m4, 'A', { targetId: 'u-5' });
  eq(r4.log[0].kind, 'hero-power-rejected', 'heal enemy minion → rejected');
}

// ── 5. onTurnEnd resets the flag ─────────────────────────────────

console.log('- onTurnEnd resets usedThisTurn for the outgoing player');
{
  const m = makeMatch({ aClass: 'warrior' });
  resolveHeroPower(m, 'A');
  eq(m.heroPower.A.usedThisTurn, true, 'fired, flag set');

  onTurnEnd(m, 'A');
  eq(m.heroPower.A.usedThisTurn, false, 'onTurnEnd cleared the flag');

  // Re-fire works after onTurnEnd (assuming mana).
  m.mana.A.cur = 5;
  const r2 = resolveHeroPower(m, 'A');
  eq(r2.log[0].kind, 'hero-power', 'can re-fire after onTurnEnd');
}

console.log('- onTurnEnd clears same-turn marks placed by outgoing player');
{
  const enemy = makeMinion('u-6', 3, 3);
  const m = makeMatch({ aClass: 'ranger', minionsB: [enemy] });
  resolveHeroPower(m, 'A', { targetId: 'u-6' });
  assert(m.markedTargets['u-6'], 'mark placed');

  onTurnEnd(m, 'A');
  assert(!m.markedTargets['u-6'], 'same-turn mark cleared on outgoing turn-end');
}

// ── 6. Independence between sides ────────────────────────────────

console.log('- B firing does not affect A flag (and vice-versa)');
{
  const m = makeMatch({ aClass: 'warrior', bClass: 'mage' });
  m.active = 'B';
  const r = resolveHeroPower(m, 'B', { targetId: 'oppHero' });
  eq(r.log[0].kind, 'hero-power', 'B fired ok');
  eq(m.heroPower.B.usedThisTurn, true, 'B flag set');
  eq(m.heroPower.A.usedThisTurn, false, 'A flag unaffected');
  eq(m.mana.A.cur, 5, 'A mana unaffected');
}

console.log('');
console.log(`PASSED, ${pass} ok / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
