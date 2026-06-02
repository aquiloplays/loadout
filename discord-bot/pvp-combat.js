// pvp-combat.js — server-side D20 hero-duel resolver for the PvP feature.
//
// PURE + SEED-DETERMINISTIC. No Date.now(), no Math.random() — every roll
// flows through a seeded xorshift PRNG so a battle replays identically from
// just { seed, combatants }. The worker (pvp.js) loads two heroes, snapshots
// them with combatantFromHero(), then calls resolveBattle() once on accept;
// the resulting `turns` array is persisted and streamed to the OBS overlay
// for deterministic replay.
//
// The two fighters are referenced side-agnostically as 'a' (challenger / p1)
// and 'b' (opponent / p2). pvp.js maps sides ↔ userIds when emitting events.
//
// Stat + ability contract comes from dungeon.js (attackOf/defenseOf/CLASSES)
// and hero-skills.js (computeEffectiveStats → critPct/dodgePct/abilities).
// See .claude/scout/combat-contract.md for the full grounding.

// ── Seeded RNG (replicated from cards-battle.js, which doesn't export it) ──

export function hashStr(s) {
  let h = 0;
  s = String(s == null ? '' : s);
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

// xorshift32 → float in [0,1). Stateful generator object so each draw steps.
function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return function next() {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) % 1000000) / 1000000;
  };
}

// ── Tunables ───────────────────────────────────────────────────────────────

const TURN_CAP = 60;            // hard stop; HP-tiebreak decides a capped fight
const LOW_HP_PCT = 0.30;        // ultimate unlocks at ≤30% maxHp (once)
const EXECUTE_PCT = 0.25;       // rogue 'execute' KO threshold on a crit
const LIFESTEAL_FRAC = 0.5;     // heal = floor(dmg * 0.5)
const REFLECT_FRAC = 0.10;      // mage 'reflect' returns 10% of incoming dmg

const CLASS_FALLBACK = 'warrior';

// Status-effect definitions applied on crits / ultimates. `tint` is a hint for
// the overlay's floating-status colour (poisoned green, burning orange, etc.).
const STATUS = {
  burn:   { tint: 'orange', dmgPerTurn: 2, turns: 2 },   // mage
  poison: { tint: 'green',  dmgPerTurn: 2, turns: 3 },   // rogue
  freeze: { tint: 'ice',    turns: 1 },                  // skip next turn
  mark:   { tint: 'gold',   turns: 1, dmgTakenMult: 1.5 }, // ranger: next hit harder
  bless:  { tint: 'gold',   turns: 3, regen: 3 },        // healer: regen / turn
};

// ── Combatant snapshot ───────────────────────────────────────────────────

// Build a combat-ready snapshot from a loaded hero. Call OUTSIDE the resolver
// (it touches no RNG). `eff` is computeEffectiveStats(hero) from hero-skills.js;
// pass it in so this module has no import cycle with the stat code.
//
//   combatantFromHero(hero, { atk, def, bonus }, { userId, name })
export function combatantFromHero(hero, eff, ident = {}) {
  hero = hero || {};
  eff = eff || {};
  const bonus = eff.bonus || {};
  const hpMax = Math.max(1, (hero.hpMax || 25) + (bonus.hpFlat || 0));
  const className = String(hero.className || CLASS_FALLBACK).toLowerCase();
  return {
    userId: String(ident.userId || hero.userId || ''),
    name: String(ident.name || hero.name || 'Challenger'),
    className: CLASSES_KNOWN.has(className) ? className : CLASS_FALLBACK,
    level: Math.max(1, hero.level || 1),
    hpMax,
    atk: Math.max(1, Math.round(eff.atk != null ? eff.atk : 4)),
    def: Math.max(0, Math.round(eff.def != null ? eff.def : 0)),
    critPct: clampPct(bonus.critPct || 0),
    dodgePct: clampPct(bonus.dodgePct || 0),
    abilities: Array.isArray(bonus.abilities) ? bonus.abilities.slice() : [],
    record: ident.record || null,   // {won,lost} display only, passed through
    art: ident.art || null,         // composite manifest/url, passed through to overlay
  };
}

const CLASSES_KNOWN = new Set(['warrior', 'mage', 'rogue', 'ranger', 'healer']);
function clampPct(n) { n = Number(n) || 0; return n < 0 ? 0 : n > 95 ? 95 : n; }

// ── Live combat state per side (derived from the snapshot) ──────────────────

function initFighter(snap) {
  return {
    ...snap,
    hp: snap.hpMax,
    statuses: [],               // [{ key, turns, ... }]
    usedUltimate: false,
    // `used*` flags start FALSE only when the ability is present (so the
    // one-shot guard fires once); they start TRUE when absent so the guard
    // is a permanent no-op.
    usedFirstImmune: !(hasAbility(snap, 'first-hit-immune') || hasAbility(snap, 'spell-immune-first')),
    usedDeathSave: !(hasAbility(snap, 'death-save-once') || hasAbility(snap, 'escape-lethal')),
  };
}

function hasAbility(f, key) { return Array.isArray(f.abilities) && f.abilities.includes(key); }

// ── Resolver ────────────────────────────────────────────────────────────────

// resolveBattle(aSnap, bSnap, seedStr) -> {
//   seed, winner:'a'|'b'|'draw', winnerUserId, rounds, turns:[...], final, combatants
// }
export function resolveBattle(aSnap, bSnap, seedStr) {
  const seed = hashStr(seedStr);
  const rng = makeRng(seed || 1);
  const a = initFighter(aSnap);
  const b = initFighter(bSnap);
  const fighters = { a, b };
  const turns = [];
  let seq = 0;

  // Initiative: higher (atk + level) acts first; deterministic tiebreak → 'a'.
  let active = (b.atk + b.level) > (a.atk + a.level) ? 'b' : 'a';

  const log = (ev) => { turns.push({ turn: ++seq, ...ev, hp: { a: a.hp, b: b.hp } }); };

  let round = 0;
  while (a.hp > 0 && b.hp > 0 && seq < TURN_CAP) {
    round++;
    const side = active;
    const other = side === 'a' ? 'b' : 'a';
    const attacker = fighters[side];
    const defender = fighters[other];

    // 1) Start-of-turn status ticks on the active fighter (burn/poison/bless).
    tickStatuses(attacker, side, log, rng);
    if (attacker.hp <= 0) { /* died to DoT */ break; }

    // 2) Frozen? skip the action (consume one freeze turn already ticked above).
    if (consumeFreeze(attacker)) {
      log({ actor: side, target: side, action: 'frozen', roll: 0, result: 'skip', damage: 0, heal: 0, effect: 'freeze', note: `${attacker.name} is frozen solid` });
      active = other; continue;
    }

    // 3) Low-HP ultimate (once per fighter).
    if (!attacker.usedUltimate && attacker.hp <= attacker.hpMax * LOW_HP_PCT) {
      attacker.usedUltimate = true;
      doUltimate(side, attacker, defender, log, rng);
      if (defender.hp <= 0) break;
      // Ultimate replaces the basic attack this turn.
      active = other; continue;
    }

    // 4) Basic attack.
    doAttack(side, attacker, defender, log, rng);
    active = other;
  }

  // Winner: KO wins; otherwise HP-tiebreak at the cap; equal → draw.
  let winner;
  if (a.hp <= 0 && b.hp <= 0) winner = a.hp === b.hp ? 'draw' : (a.hp > b.hp ? 'a' : 'b');
  else if (a.hp <= 0) winner = 'b';
  else if (b.hp <= 0) winner = 'a';
  else winner = a.hp === b.hp ? 'draw' : (a.hp > b.hp ? 'a' : 'b');

  return {
    seed: seedStr,
    winner,
    winnerUserId: winner === 'draw' ? null : fighters[winner].userId,
    rounds: round,
    turns,
    final: {
      a: { hp: Math.max(0, a.hp), hpMax: a.hpMax },
      b: { hp: Math.max(0, b.hp), hpMax: b.hpMax },
    },
    combatants: { a: aSnap, b: bSnap },
  };
}

// ── Core mechanics ──────────────────────────────────────────────────────────

function d20(rng) { return 1 + Math.floor(rng() * 20); }
function roll100(rng) { return rng() * 100; }

function doAttack(side, atk, def, log, rng) {
  const other = side === 'a' ? 'b' : 'a';
  const roll = d20(rng);
  const fumble = roll === 1;
  const natCrit = roll === 20;
  const critFromSkill = roll100(rng) < atk.critPct;
  const dodged = !fumble && !natCrit && roll100(rng) < def.dodgePct;

  if (fumble) {
    log({ actor: side, target: other, action: 'attack', roll, result: 'miss', damage: 0, heal: 0, effect: null, note: `${atk.name} fumbles` });
    return;
  }
  if (dodged) {
    log({ actor: side, target: other, action: 'attack', roll, result: 'dodge', damage: 0, heal: 0, effect: null, note: `${def.name} slips aside` });
    return;
  }

  const dc = 10 + Math.floor(def.def / 2);
  const hitScore = roll + Math.floor(atk.atk / 2);
  const isHit = natCrit || critFromSkill || hitScore >= dc;
  if (!isHit) {
    log({ actor: side, target: other, action: 'attack', roll, result: 'block', damage: 0, heal: 0, effect: null, note: `${def.name} blocks` });
    return;
  }

  const crit = natCrit || critFromSkill;
  const applied = applyDamage(side, atk, def, baseDamage(atk, def, rng), crit, rng, log);
  // applyDamage already logged the hit; nothing more here.
  return applied;
}

// Raw damage before crit multiplier + mitigation already folded in.
function baseDamage(atk, def, rng) {
  const variance = Math.floor(rng() * Math.max(1, Math.floor(atk.atk / 2)) + 1); // 1..~atk/2
  const raw = atk.atk + variance - Math.floor(def.def / 3);
  return Math.max(1, raw);
}

// Apply `dmg` from `side` attacker to the other fighter, honouring crit,
// mark, first-hit-immune, death-save, execute, lifesteal, reflect. Logs the
// resulting event and returns the net damage dealt.
function applyDamage(side, atk, def, dmg, crit, rng, log, action = 'attack') {
  const other = side === 'a' ? 'b' : 'a';
  let result = crit ? 'crit' : 'hit';
  let effect = null;
  let note = '';

  if (crit) dmg = Math.round(dmg * 1.75);

  // Mark: the marked defender takes extra from the next incoming hit.
  const mark = takeStatus(def, 'mark');
  if (mark) { dmg = Math.round(dmg * STATUS.mark.dmgTakenMult); note = `${def.name} was marked`; }

  // First-hit immunity (warrior Unbreakable / mage spell-immune-first):
  // the defender shrugs off the first blow that would land, once.
  if (def.usedFirstImmune === false) {
    def.usedFirstImmune = true;
    log({ actor: side, target: other, action, roll: 0, result: 'block', damage: 0, heal: 0, effect: null, note: `${def.name} shrugs off the first blow` });
    return 0;
  }

  // Execute (rogue Assassinate): a crit that leaves the target low → instant KO.
  let lethalExecute = false;
  if (crit && hasAbility(atk, 'execute')) {
    const afterHp = def.hp - dmg;
    if (afterHp > 0 && afterHp <= def.hpMax * EXECUTE_PCT) lethalExecute = true;
  }

  let netDmg = dmg;
  if (lethalExecute) { netDmg = def.hp; result = 'execute'; note = `${atk.name} executes ${def.name}`; }

  let newHp = def.hp - netDmg;

  // Death save (healer Divine Shield / rogue Smoke Bomb): survive lethal once.
  if (newHp <= 0 && def.usedDeathSave === false) {
    def.usedDeathSave = true;
    netDmg = def.hp - 1;
    newHp = 1;
    result = 'survive';
    note = `${def.name} clings to life`;
  }

  // Clamp stored HP at 0 so the per-turn snapshot never shows a negative bar.
  // Overkill `damage` in the log is intentional (satisfying big numbers); the
  // bar just bottoms out at 0.
  def.hp = Math.max(0, newHp);

  // Status application on crit by class flavour.
  if ((result === 'crit') && action === 'attack') {
    effect = applyCritStatus(atk, def);
    if (effect && !note) note = `${def.name} is ${effect}`;
  }

  // Lifesteal: attacker heals a fraction of damage dealt.
  let heal = 0;
  if (hasAbility(atk, 'lifesteal') && netDmg > 0) {
    heal = Math.floor(netDmg * LIFESTEAL_FRAC);
    atk.hp = Math.min(atk.hpMax, atk.hp + heal);
  }

  log({ actor: side, target: other, action, roll: 0, result, damage: Math.max(0, netDmg), heal, effect, note: note || calloutFor(result, atk, def) });

  // Reflect (mage): defender returns a fraction to the attacker AFTER the log.
  if (hasAbility(def, 'reflect') && netDmg > 0 && def.hp > 0) {
    const back = Math.max(1, Math.round(netDmg * REFLECT_FRAC));
    atk.hp = Math.max(0, atk.hp - back);
    log({ actor: other, target: side, action: 'reflect', roll: 0, result: 'hit', damage: back, heal: 0, effect: null, note: `${def.name}'s barrier reflects` });
  }

  return netDmg;
}

function calloutFor(result, atk, def) {
  if (result === 'crit') return `CRITICAL — ${atk.name} strikes deep`;
  if (result === 'execute') return `${atk.name} ends it`;
  return `${atk.name} hits ${def.name}`;
}

// Pick the status a crit applies, by attacker class. Returns the effect name or
// null. Pushes onto the defender's status list.
function applyCritStatus(atk, def) {
  let key = null;
  switch (atk.className) {
    case 'mage':   key = 'burn'; break;
    case 'rogue':  key = 'poison'; break;
    case 'ranger': key = 'mark'; break;
    default: key = null;
  }
  if (!key) return null;
  addStatus(def, key);
  return STATUS[key].tint === 'orange' ? 'burning'
    : STATUS[key].tint === 'green' ? 'poisoned'
    : key === 'mark' ? 'marked' : key;
}

function addStatus(f, key) {
  const def = STATUS[key];
  if (!def) return;
  // Refresh duration if already present, else add.
  const existing = f.statuses.find(s => s.key === key);
  if (existing) { existing.turns = def.turns; return; }
  f.statuses.push({ key, turns: def.turns });
}

function takeStatus(f, key) {
  const i = f.statuses.findIndex(s => s.key === key);
  if (i < 0) return null;
  const s = f.statuses[i];
  f.statuses.splice(i, 1);
  return s;
}

// Returns true (and removes the freeze) if the fighter is frozen this turn.
function consumeFreeze(f) {
  const i = f.statuses.findIndex(s => s.key === 'freeze');
  if (i < 0) return false;
  f.statuses.splice(i, 1);
  return true;
}

// Start-of-turn DoT / regen ticks on the active fighter.
function tickStatuses(f, side, log, rng) {
  if (!f.statuses.length) return;
  const keep = [];
  for (const s of f.statuses) {
    const def = STATUS[s.key];
    if (!def) continue;
    // Freeze is consumed by consumeFreeze() AFTER ticks — never decrement it
    // here, or the skip would be eaten before it can take effect.
    if (s.key === 'freeze') { keep.push(s); continue; }
    if (def.dmgPerTurn) {
      f.hp = Math.max(0, f.hp - def.dmgPerTurn);
      log({ actor: side, target: side, action: 'tick', roll: 0, result: 'tick', damage: def.dmgPerTurn, heal: 0, effect: s.key === 'burn' ? 'burning' : s.key === 'poison' ? 'poisoned' : s.key, note: `${f.name} suffers ${s.key}` });
      if (f.hp <= 0) return;
    }
    if (def.regen) {
      const before = f.hp;
      f.hp = Math.min(f.hpMax, f.hp + def.regen);
      const healed = f.hp - before;
      if (healed > 0) log({ actor: side, target: side, action: 'tick', roll: 0, result: 'heal', damage: 0, heal: healed, effect: 'blessed', note: `${f.name} is blessed` });
    }
    s.turns -= 1;
    if (s.turns > 0) keep.push(s);
  }
  f.statuses = keep;
}

// Per-class signature ultimate, fired once at low HP. Replaces the basic attack
// that turn. Kept deliberately punchy so the overlay has a hero moment.
function doUltimate(side, atk, def, log, rng) {
  const other = side === 'a' ? 'b' : 'a';
  switch (atk.className) {
    case 'warrior': {
      // Bladestorm — guaranteed heavy crit.
      const dmg = baseDamage(atk, def, rng) + Math.floor(atk.atk / 2);
      log({ actor: side, target: side, action: 'ultimate', roll: 0, result: 'ultimate', damage: 0, heal: 0, effect: null, note: `${atk.name} unleashes BLADESTORM` });
      applyDamage(side, atk, def, dmg, true, rng, log, 'ultimate');
      return;
    }
    case 'mage': {
      // Frostfire — big hit + freeze the target's next turn.
      const dmg = baseDamage(atk, def, rng);
      log({ actor: side, target: side, action: 'ultimate', roll: 0, result: 'ultimate', damage: 0, heal: 0, effect: 'freeze', note: `${atk.name} casts FROSTFIRE` });
      applyDamage(side, atk, def, dmg, true, rng, log, 'ultimate');
      if (def.hp > 0) addStatus(def, 'freeze');
      return;
    }
    case 'rogue': {
      // Shadowstrike — double hit, second is a crit.
      log({ actor: side, target: side, action: 'ultimate', roll: 0, result: 'ultimate', damage: 0, heal: 0, effect: null, note: `${atk.name} vanishes — SHADOWSTRIKE` });
      applyDamage(side, atk, def, baseDamage(atk, def, rng), false, rng, log, 'ultimate');
      if (def.hp > 0) applyDamage(side, atk, def, baseDamage(atk, def, rng), true, rng, log, 'ultimate');
      return;
    }
    case 'ranger': {
      // Piercing Volley — mark + heavy hit.
      log({ actor: side, target: side, action: 'ultimate', roll: 0, result: 'ultimate', damage: 0, heal: 0, effect: 'mark', note: `${atk.name} looses a PIERCING VOLLEY` });
      addStatus(def, 'mark');
      applyDamage(side, atk, def, baseDamage(atk, def, rng) + 2, false, rng, log, 'ultimate');
      return;
    }
    case 'healer': {
      // Radiant Surge — heal self + smite.
      const heal = Math.floor(atk.hpMax * 0.35);
      atk.hp = Math.min(atk.hpMax, atk.hp + heal);
      addStatus(atk, 'bless');
      log({ actor: side, target: side, action: 'ultimate', roll: 0, result: 'heal', damage: 0, heal, effect: 'blessed', note: `${atk.name} channels a RADIANT SURGE` });
      applyDamage(side, atk, def, baseDamage(atk, def, rng), false, rng, log, 'ultimate');
      return;
    }
    default: {
      applyDamage(side, atk, def, baseDamage(atk, def, rng) + 2, true, rng, log, 'ultimate');
    }
  }
}

export const _internals = { makeRng, d20, baseDamage, STATUS, TURN_CAP, LOW_HP_PCT };
