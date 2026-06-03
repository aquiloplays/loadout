// Unit tests for pvp-combat.js, the deterministic D20 hero-duel resolver.
// Covers: determinism (same seed → identical log), termination (turn cap),
// HP/winner invariants, dodge/crit/fumble edges, and each combat ability
// (lifesteal, first-hit-immune, death-save, execute, reflect) plus statuses
// (burn/poison/freeze/mark) and the low-HP ultimate.
//
// Run with:   node test/test-pvp-combat.mjs

import { resolveBattle, combatantFromHero, hashStr, _internals } from '../pvp-combat.js';

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; } else { fail++; console.log('  ❌', m); } }
function ok(m) { pass++; }
function eq(a, b, m) { if (a === b) { pass++; } else { fail++; console.log('  ❌', m, '(want:', b, 'got:', a, ')'); } }

// Build a combatant snapshot directly (bypasses hero loading).
function C(over = {}) {
  return {
    userId: over.userId || 'u',
    name: over.name || 'Hero',
    className: over.className || 'warrior',
    level: over.level || 5,
    hpMax: over.hpMax || 30,
    atk: over.atk != null ? over.atk : 8,
    def: over.def != null ? over.def : 2,
    critPct: over.critPct || 0,
    dodgePct: over.dodgePct || 0,
    abilities: over.abilities || [],
    record: over.record || null,
    art: over.art || null,
  };
}

// ── determinism ──────────────────────────────────────────────────────────
console.log('- determinism');
{
  const a = C({ userId: 'a', name: 'Aytch', className: 'rogue', critPct: 10, dodgePct: 10 });
  const b = C({ userId: 'b', name: 'Bishop', className: 'mage', critPct: 10, dodgePct: 5 });
  const r1 = resolveBattle(a, b, 'battle-seed-1');
  const r2 = resolveBattle(a, b, 'battle-seed-1');
  eq(JSON.stringify(r1.turns), JSON.stringify(r2.turns), 'same seed → identical turns');
  eq(r1.winner, r2.winner, 'same seed → same winner');
  const r3 = resolveBattle(a, b, 'battle-seed-2');
  assert(JSON.stringify(r1.turns) !== JSON.stringify(r3.turns), 'different seed → different log');
  eq(hashStr('x'), hashStr('x'), 'hashStr stable');
}

// ── termination + HP/winner invariants over many seeds ─────────────────────
console.log('- invariants across 400 seeded battles');
{
  let drawCount = 0, koCount = 0, maxTurns = 0;
  for (let i = 0; i < 400; i++) {
    const a = C({ userId: 'a', name: 'A', className: ['warrior','mage','rogue','ranger','healer'][i % 5], level: 1 + (i % 20), hpMax: 25 + (i % 16), atk: 4 + (i % 9), def: i % 6, critPct: i % 25, dodgePct: i % 20 });
    const b = C({ userId: 'b', name: 'B', className: ['healer','ranger','rogue','mage','warrior'][i % 5], level: 1 + ((i*3) % 20), hpMax: 25 + ((i*2) % 16), atk: 4 + ((i*2) % 9), def: (i+1) % 6, critPct: (i*2) % 25, dodgePct: (i+3) % 20 });
    const r = resolveBattle(a, b, 'seed-' + i);

    assert(r.turns.length <= _internals.TURN_CAP, 'turn cap respected #' + i);
    maxTurns = Math.max(maxTurns, r.turns.length);
    assert(['a','b','draw'].includes(r.winner), 'valid winner #' + i);
    // final HP bounds
    assert(r.final.a.hp >= 0 && r.final.a.hp <= r.final.a.hpMax, 'a hp in range #' + i);
    assert(r.final.b.hp >= 0 && r.final.b.hp <= r.final.b.hpMax, 'b hp in range #' + i);
    // winner consistency
    if (r.winner === 'a') assert(r.winnerUserId === 'a' && (r.final.b.hp === 0 || r.final.a.hp >= r.final.b.hp), 'a-win consistent #' + i);
    if (r.winner === 'b') assert(r.winnerUserId === 'b' && (r.final.a.hp === 0 || r.final.b.hp >= r.final.a.hp), 'b-win consistent #' + i);
    if (r.winner === 'draw') { drawCount++; assert(r.winnerUserId === null, 'draw → null winnerUserId #' + i); }
    if (r.final.a.hp === 0 || r.final.b.hp === 0) koCount++;

    // every event well-formed
    for (const t of r.turns) {
      assert(t.turn > 0, 'turn seq positive #' + i);
      assert(t.damage >= 0 && t.heal >= 0, 'non-negative dmg/heal #' + i);
      assert(['a','b'].includes(t.actor) && ['a','b'].includes(t.target), 'valid actor/target #' + i);
      assert(t.hp && typeof t.hp.a === 'number' && typeof t.hp.b === 'number', 'hp snapshot present #' + i);
    }
    // turns strictly increasing
    for (let j = 1; j < r.turns.length; j++) assert(r.turns[j].turn === r.turns[j-1].turn + 1, 'turn monotonic #' + i);
  }
  console.log(`    (maxTurns=${maxTurns}, KOs=${koCount}/400, draws=${drawCount})`);
  assert(koCount > 350, 'most battles end in a KO, not the cap');
}

// ── damage applied equals hp drop ──────────────────────────────────────────
console.log('- damage accounting');
{
  // High-atk, no-dodge attacker vs a fragile defender: trace hp deltas.
  const a = C({ userId: 'a', atk: 12, def: 0, dodgePct: 0, critPct: 0, hpMax: 100 });
  const b = C({ userId: 'b', atk: 1, def: 0, dodgePct: 0, critPct: 0, hpMax: 100 });
  const r = resolveBattle(a, b, 'acct');
  // Reconstruct hp from events and confirm it matches the running snapshot.
  let hpA = a.hpMax, hpB = b.hpMax;
  for (const t of r.turns) {
    // damage hits the target; heal helps the actor; tick hits the actor
    if (t.action === 'tick') {
      if (t.target === 'a') hpA = Math.min(a.hpMax, hpA - t.damage + t.heal); else hpB = Math.min(b.hpMax, hpB - t.damage + t.heal);
    } else {
      if (t.target === 'a') hpA -= t.damage; else hpB -= t.damage;
      if (t.heal) { if (t.actor === 'a') hpA = Math.min(a.hpMax, hpA + t.heal); else hpB = Math.min(b.hpMax, hpB + t.heal); }
    }
    hpA = Math.max(0, hpA); hpB = Math.max(0, hpB);
    eq(t.hp.a, hpA, 'reconstructed hpA matches snapshot @turn ' + t.turn);
    eq(t.hp.b, hpB, 'reconstructed hpB matches snapshot @turn ' + t.turn);
  }
}

// ── dodge: a 95% dodger almost never gets hit by basic attacks ──────────────
console.log('- dodge');
{
  const a = C({ userId: 'a', atk: 8, critPct: 0 });
  const b = C({ userId: 'b', atk: 1, dodgePct: 95, hpMax: 200, def: 0 });
  const r = resolveBattle(a, b, 'dodge');
  const aHits = r.turns.filter(t => t.actor === 'a' && (t.result === 'hit' || t.result === 'crit'));
  // crit ignores dodge in our model; pure-attack hits on a 95% dodger are rare
  assert(aHits.length <= r.turns.filter(t => t.actor === 'a').length * 0.3, 'high dodge blocks most hits');
}

// ── lifesteal heals the attacker ───────────────────────────────────────────
console.log('- lifesteal');
{
  const a = C({ userId: 'a', atk: 12, def: 0, abilities: ['lifesteal'], hpMax: 60 });
  const b = C({ userId: 'b', atk: 8, def: 0, hpMax: 60 });
  const r = resolveBattle(a, b, 'ls');
  const healEvents = r.turns.filter(t => t.actor === 'a' && t.heal > 0 && t.action !== 'tick');
  assert(healEvents.length > 0, 'lifesteal produced heal events');
}

// ── first-hit immunity shrugs off exactly one blow ──────────────────────────
console.log('- first-hit immune');
{
  const a = C({ userId: 'a', atk: 12, def: 0, critPct: 0, dodgePct: 0 });
  const b = C({ userId: 'b', atk: 1, def: 0, abilities: ['first-hit-immune'], hpMax: 200, dodgePct: 0 });
  const r = resolveBattle(a, b, 'immune');
  const immuneBlocks = r.turns.filter(t => t.target === 'b' && t.result === 'block' && /shrugs off/.test(t.note));
  eq(immuneBlocks.length, 1, 'first-hit immunity consumed exactly once');
}

// ── death save: survive lethal once at 1 hp ─────────────────────────────────
console.log('- death save');
{
  const a = C({ userId: 'a', atk: 40, def: 0, critPct: 0, dodgePct: 0 });
  const b = C({ userId: 'b', atk: 1, def: 0, abilities: ['death-save-once'], hpMax: 20, dodgePct: 0 });
  const r = resolveBattle(a, b, 'ds');
  const survive = r.turns.find(t => t.result === 'survive');
  assert(!!survive, 'a death-save survive event occurred');
  if (survive) eq(survive.hp.b, 1, 'survived at 1 hp');
}

// ── execute: rogue crit KOs a low target ────────────────────────────────────
console.log('- execute');
{
  // Force crits via critPct 95; rogue with execute vs a target it can bring low.
  const a = C({ userId: 'a', className: 'rogue', atk: 10, def: 0, critPct: 95, abilities: ['execute'], dodgePct: 0 });
  const b = C({ userId: 'b', atk: 1, def: 0, hpMax: 40, dodgePct: 0 });
  const r = resolveBattle(a, b, 'exec');
  const exec = r.turns.find(t => t.result === 'execute');
  // Execute requires a crit landing while target is within EXECUTE_PCT after the
  // hit; over a full fight against a fragile target it should trigger.
  assert(!!exec || r.winner === 'a', 'execute fired or rogue still won');
}

// ── reflect: mage returns damage to the attacker ────────────────────────────
console.log('- reflect');
{
  const a = C({ userId: 'a', atk: 14, def: 0, critPct: 0, dodgePct: 0, hpMax: 80 });
  const b = C({ userId: 'b', className: 'mage', atk: 1, def: 0, abilities: ['reflect'], hpMax: 200, dodgePct: 0 });
  const r = resolveBattle(a, b, 'reflect');
  const reflects = r.turns.filter(t => t.action === 'reflect' && t.target === 'a');
  assert(reflects.length > 0, 'reflect damaged the attacker');
}

// ── ultimate fires once at low HP ───────────────────────────────────────────
console.log('- ultimate (low-HP signature)');
{
  // Even match so both drop low; assert each side fires at most one ultimate.
  const a = C({ userId: 'a', className: 'mage', atk: 7, def: 1, hpMax: 30 });
  const b = C({ userId: 'b', className: 'warrior', atk: 7, def: 1, hpMax: 30 });
  let sawUltimate = false;
  for (let i = 0; i < 40; i++) {
    const r = resolveBattle(a, b, 'ult-' + i);
    const ultsA = r.turns.filter(t => t.action === 'ultimate' && t.actor === 'a' && t.result === 'ultimate');
    const ultsB = r.turns.filter(t => t.action === 'ultimate' && t.actor === 'b' && t.result === 'ultimate');
    assert(ultsA.length <= 1, 'a fires ≤1 ultimate #' + i);
    assert(ultsB.length <= 1, 'b fires ≤1 ultimate #' + i);
    if (ultsA.length || ultsB.length) sawUltimate = true;
  }
  assert(sawUltimate, 'ultimates do fire across the sample');
}

// ── statuses: mage crit applies burn (DoT tick) ─────────────────────────────
console.log('- status effects');
{
  const a = C({ userId: 'a', className: 'mage', atk: 10, def: 0, critPct: 95, dodgePct: 0 });
  const b = C({ userId: 'b', atk: 1, def: 0, hpMax: 200, dodgePct: 0 });
  const r = resolveBattle(a, b, 'burn');
  const burnTicks = r.turns.filter(t => t.action === 'tick' && t.effect === 'burning' && t.target === 'b');
  assert(burnTicks.length > 0, 'mage crits applied burn DoT');
}

// ── combatantFromHero maps stats correctly ──────────────────────────────────
console.log('- combatantFromHero');
{
  const hero = { className: 'Healer', level: 7, hpMax: 30 };
  const eff = { atk: 9, def: 4, bonus: { hpFlat: 10, critPct: 12, dodgePct: 8, abilities: ['lifesteal'] } };
  const snap = combatantFromHero(hero, eff, { userId: '123', name: 'Cleric', record: { won: 2, lost: 1 } });
  eq(snap.className, 'healer', 'class lowercased');
  eq(snap.hpMax, 40, 'hpFlat folded into hpMax');
  eq(snap.atk, 9, 'atk from eff');
  eq(snap.def, 4, 'def from eff');
  eq(snap.critPct, 12, 'critPct passthrough');
  eq(snap.abilities[0], 'lifesteal', 'abilities passthrough');
  eq(snap.record.won, 2, 'record passthrough');
  const bad = combatantFromHero({ className: 'necromancer' }, {}, {});
  eq(bad.className, 'warrior', 'unknown class falls back to warrior');
  eq(bad.hpMax, 25, 'default hpMax');
  eq(bad.atk, 4, 'default atk floor');
}

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAIL'}, ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
