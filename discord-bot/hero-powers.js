// Boltbound, hero powers (signature per-champion class abilities).
//
// Each champion class has ONE hero power the player can fire once per
// turn for a flat 2 mana; it refreshes at the start of every turn.
//
// This module is the authoritative worker-side mirror of the site's
// pre-written source of truth (src/lib/boltbound/heroPowers.ts). The
// SITE definitions are player-visible, so THEY are canonical: the wire
// `id`s (armor-up / fire-bolt / coin-strike / mark-target / lesser-heal)
// and the semantics below match heroPowers.ts exactly:
//
//   armor-up   (warrior) → gain 2 armor (heroArmor, absorbed before hp)
//   fire-bolt  (mage)    → deal 1 damage to ANY target (hero or minion,
//                          either side)
//   coin-strike(rogue)   → deal 1 damage to the enemy hero (auto-target)
//   mark-target(ranger)  → an enemy minion takes +1 damage from all
//                          sources this turn (markedTargets, cleared at
//                          the marker's turn-end)
//   lesser-heal(healer)  → restore 2 HP to your own hero (auto-target,
//                          caps at 30)
//
// Purity: this module NEVER calls Date.now() / Math.random(). It mutates
// the passed match object in place and also returns a small { log } so
// the caller (routeMatchAction) can surface what happened. Determinism
// is preserved, no power is randomised.
//
// The champion class → power binding tolerates the loose catalogue
// class strings via CLASS_TO_POWER (createMatch passes the deck's
// championClass, e.g. 'warrior').

// Locked catalogue. Keyed by champion class (the shape createMatch and
// the test harness pass). Each entry carries the site wire `id`, the
// mana cost (all 2 in the launch set), and the display name.
export const HERO_POWER_DEFS = Object.freeze({
  warrior: Object.freeze({ id: 'armor-up',    manaCost: 2, name: 'Armor Up',    effect: 'armor'  }),
  mage:    Object.freeze({ id: 'fire-bolt',   manaCost: 2, name: 'Fire Bolt',   effect: 'damage' }),
  rogue:   Object.freeze({ id: 'coin-strike', manaCost: 2, name: 'Coin Strike', effect: 'damage' }),
  ranger:  Object.freeze({ id: 'mark-target', manaCost: 2, name: 'Mark Target', effect: 'mark'   }),
  healer:  Object.freeze({ id: 'lesser-heal', manaCost: 2, name: 'Lesser Heal', effect: 'heal'   }),
});

// Loose champion-class string → canonical power key. Mirrors the site's
// heroPowerForClass() substring matching so 'Arcane Mage', 'Warden',
// etc. all resolve. Unknown → warrior (Armor Up), the safe default.
export function classToPowerKey(className) {
  const c = String(className || '').toLowerCase();
  if (c.includes('warrior') || c.includes('steel') || c.includes('knight'))  return 'warrior';
  if (c.includes('mage')    || c.includes('nyx')   || c.includes('arcane') || c.includes('wizard')) return 'mage';
  if (c.includes('rogue')   || c.includes('assassin') || c.includes('thief')) return 'rogue';
  if (c.includes('ranger')  || c.includes('hunter') || c.includes('warden') || c.includes('archer')) return 'ranger';
  if (c.includes('healer')  || c.includes('priest') || c.includes('cleric') || c.includes('keeper')) return 'healer';
  return 'warrior';
}

const ARMOR_UP    = 2;   // armor gained per Armor Up
const FIRE_BOLT   = 1;   // damage dealt by Fire Bolt
const COIN_STRIKE = 1;   // damage dealt by Coin Strike to the enemy hero
const MARK_BONUS  = 1;   // +1 damage from all sources while marked
const LESSER_HEAL = 2;   // HP restored by Lesser Heal
const HP_CAP      = 30;  // hero hp ceiling (STARTING_HP)

// Build the per-side hero-power record createMatch stores on
// match.heroPower[side]. Unknown class falls back to warrior/Armor Up.
export function initHeroPowerForMatch(className) {
  const key = classToPowerKey(className);
  const def = HERO_POWER_DEFS[key];
  return { id: def.id, manaCost: def.manaCost, usedThisTurn: false };
}

// Resolve the def a side's power points at, from its stored record `id`.
function defForSide(match, side) {
  const rec = match.heroPower && match.heroPower[side];
  if (!rec) return null;
  for (const key of Object.keys(HERO_POWER_DEFS)) {
    if (HERO_POWER_DEFS[key].id === rec.id) return { key, def: HERO_POWER_DEFS[key], rec };
  }
  return null;
}

// Gate: enough mana + not yet fired this turn + a valid side.
// Returns { ok:true } or { ok:false, reason }.
export function canUseHeroPower(match, side) {
  const info = defForSide(match, side);
  if (!info) return { ok: false, reason: 'no-hero-power' };
  const rec = info.rec;
  if (rec.usedThisTurn) return { ok: false, reason: 'already-used-this-turn' };
  const cur = (match.mana && match.mana[side] && Number(match.mana[side].cur)) || 0;
  if (cur < rec.manaCost) return { ok: false, reason: 'insufficient-mana' };
  return { ok: true };
}

// Find an enemy or friendly minion by uid across the board.
function findMinionOn(match, side, uid) {
  const arr = (match.board && match.board[side]) || [];
  return arr.find(m => m.uid === uid && m.hp > 0) || null;
}

// Fire a side's hero power. `opts.targetId` is the picked target:
//   - 'oppHero' / 'hero'  → enemy hero
//   - 'selfHero'          → own hero
//   - <minion uid>        → a board minion
// Returns { log: [entry] }. On rejection the entry is
// { kind:'hero-power-rejected', reason } and NOTHING is mutated (no
// mana spent, no usedThisTurn flip).
export function resolveHeroPower(match, side, opts = {}) {
  const gate = canUseHeroPower(match, side);
  if (!gate.ok) {
    return { log: [{ kind: 'hero-power-rejected', side, reason: gate.reason }] };
  }
  const { def, rec } = defForSide(match, side);
  const opp = side === 'A' ? 'B' : 'A';
  const targetId = opts.targetId;

  // Resolve per effect. Each branch either commits (spend mana, set flag,
  // push a log entry) or rejects WITHOUT committing.
  const spend = () => {
    match.mana[side].cur -= rec.manaCost;
    rec.usedThisTurn = true;
  };
  const logEntry = (effect, extra) =>
    ({ kind: 'hero-power', side, id: def.id, effect, ...extra });

  if (def.effect === 'armor') {
    // Armor Up: +2 armor absorbed before hero hp (consumed in dealDamage).
    if (!match.heroArmor) match.heroArmor = { A: 0, B: 0 };
    match.heroArmor[side] = (match.heroArmor[side] || 0) + ARMOR_UP;
    spend();
    return { log: [logEntry('armor', { amount: ARMOR_UP, armor: match.heroArmor[side] })] };
  }

  if (def.effect === 'damage') {
    if (def.id === 'coin-strike') {
      // Coin Strike: always the enemy hero, no manual pick.
      match.hp[opp] -= COIN_STRIKE;
      spend();
      return { log: [logEntry('damage', { target: 'oppHero', amount: COIN_STRIKE, hp: match.hp[opp] })] };
    }
    // Fire Bolt: 1 damage to ANY target the player picked.
    if (!targetId) {
      return { log: [{ kind: 'hero-power-rejected', side, reason: 'invalid-target' }] };
    }
    if (targetId === 'oppHero' || targetId === 'hero') {
      match.hp[opp] -= FIRE_BOLT;
      spend();
      return { log: [logEntry('damage', { target: 'oppHero', amount: FIRE_BOLT, hp: match.hp[opp] })] };
    }
    if (targetId === 'selfHero') {
      match.hp[side] -= FIRE_BOLT;
      spend();
      return { log: [logEntry('damage', { target: 'selfHero', amount: FIRE_BOLT, hp: match.hp[side] })] };
    }
    // A minion on either side.
    const em = findMinionOn(match, opp, targetId);
    const fm = em ? null : findMinionOn(match, side, targetId);
    const m = em || fm;
    if (!m) return { log: [{ kind: 'hero-power-rejected', side, reason: 'invalid-target' }] };
    if ((m.status || []).includes('shield')) {
      m.status = m.status.filter(s => s !== 'shield');
      spend();
      return { log: [logEntry('damage', { target: m.uid, amount: 0, shielded: true })] };
    }
    m.hp -= FIRE_BOLT;
    spend();
    return { log: [logEntry('damage', { target: m.uid, amount: FIRE_BOLT, hp: m.hp })] };
  }

  if (def.effect === 'coin') {
    // Retained for wire-compat: a coin pool grants a +0/+1 token buff.
    // Not part of the launch-set site semantics (rogue is Coin Strike),
    // but kept so an older match record with a coin power still resolves.
    if (!match.coinPool) match.coinPool = { A: [], B: [] };
    if (!Array.isArray(match.coinPool[side])) match.coinPool[side] = [];
    match.coinPool[side].push({ atk: 0, hp: 1 });
    spend();
    return { log: [logEntry('coin', { pool: match.coinPool[side].length })] };
  }

  if (def.effect === 'mark') {
    // Mark Target: an ENEMY minion takes +1 damage from all sources this
    // turn. Must target an enemy minion.
    if (!targetId) {
      return { log: [{ kind: 'hero-power-rejected', side, reason: 'invalid-target' }] };
    }
    const m = findMinionOn(match, opp, targetId);
    if (!m) {
      return { log: [{ kind: 'hero-power-rejected', side, reason: 'invalid-target' }] };
    }
    if (!match.markedTargets) match.markedTargets = {};
    match.markedTargets[targetId] = { bonusDamage: MARK_BONUS, markedBy: side };
    spend();
    return { log: [logEntry('mark', { target: targetId, bonusDamage: MARK_BONUS })] };
  }

  if (def.effect === 'heal') {
    // Lesser Heal: restore 2 HP to your OWN hero (site auto-targets self
    // hero). A 'selfHero' / absent target both resolve on the hero; a
    // friendly minion uid heals that minion (capped at maxHp); an enemy
    // target is rejected.
    if (!targetId || targetId === 'selfHero') {
      match.hp[side] = Math.min(HP_CAP, match.hp[side] + LESSER_HEAL);
      spend();
      return { log: [logEntry('heal', { target: 'selfHero', amount: LESSER_HEAL, hp: match.hp[side] })] };
    }
    const fm = findMinionOn(match, side, targetId);
    if (fm) {
      const cap = typeof fm.maxHp === 'number' ? fm.maxHp : fm.hp + LESSER_HEAL;
      fm.hp = Math.min(cap, fm.hp + LESSER_HEAL);
      spend();
      return { log: [logEntry('heal', { target: fm.uid, amount: LESSER_HEAL, hp: fm.hp })] };
    }
    // Enemy minion or unknown uid → rejected.
    return { log: [{ kind: 'hero-power-rejected', side, reason: 'invalid-target' }] };
  }

  return { log: [{ kind: 'hero-power-rejected', side, reason: 'unknown-effect' }] };
}

// Turn-boundary reset for the OUTGOING side: clear usedThisTurn and drop
// any marks that side placed this turn (Mark Target is a this-turn buff).
export function onTurnEnd(match, side) {
  const rec = match.heroPower && match.heroPower[side];
  if (rec) rec.usedThisTurn = false;
  if (match.markedTargets) {
    for (const uid of Object.keys(match.markedTargets)) {
      if (match.markedTargets[uid] && match.markedTargets[uid].markedBy === side) {
        delete match.markedTargets[uid];
      }
    }
  }
}
