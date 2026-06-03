// Hero Powers, class-specific once-per-turn 2-mana abilities.
//
// Boltbound previously had no analogue to Hearthstone's hero power.
// This module introduces five pre-written powers (one per hero class)
// that slot into the existing match-state shape so the combat-action
// endpoint can dispatch on `action.type === 'hero_power'` without
// rewriting cards-battle.js.
//
// Match-state extension (additive, old saves still load):
//   match.heroPower[side] = { id, manaCost, usedThisTurn }
//
// `id` is the class key ('warrior' | 'mage' | 'rogue' | 'ranger' |
// 'healer'). The `usedThisTurn` flag flips to true when resolveHeroPower
// runs and is cleared by onTurnEnd() for the OUTGOING player, same
// shape as Hearthstone, so a player can fire their power, then end
// turn, then re-fire on their next turn.
//
// All five powers cost 2 mana. They are wired through cards-match's
// existing `takeAction` machinery (the worker's combat-action endpoint
// already dispatches by action.kind/type, see integration note at the
// bottom of this file for the touchpoint).
//
// Effect surface (kept intentionally narrow to match the existing
// battle engine without new ability primitives):
//   warrior, Armor Up:    +2 to match.heroArmor[side] (new field, init 0)
//   mage, Fire Bolt:   1 dmg to opts.targetId ('hero' | minion uid)
//   rogue, Coin Strike: pushes a temporary +0/+1 coin into match.coinPool[side]
//   ranger, Mark Target: enemy minion marked; next attack against it gets +1 dmg this turn
//   healer, Lesser Heal: +2 HP to opts.targetId (own hero or own minion)
//
// "Mark Target" + "Coin Strike" are intentionally tracked in
// match-state side-tables (markedTargets, coinPool) rather than the
// minion record, the existing engine doesn't have a hook for the
// hero-power consumer, so each affordance reads its own scratch slot
// when the orchestrator wires it in. Tests cover that the slots are
// populated correctly.

// ── Power catalogue ─────────────────────────────────────────────────

export const HERO_POWER_DEFS = Object.freeze({
  warrior: Object.freeze({
    id:       'warrior',
    name:     'Armor Up',
    manaCost: 2,
    effect:   'armor',     // +2 armor to your hero
    value:    2,
    text:     'Hero Power: gain 2 armor.',
  }),
  mage: Object.freeze({
    id:       'mage',
    name:     'Fire Bolt',
    manaCost: 2,
    effect:   'damage',    // 1 dmg to any target
    value:    1,
    needsTarget: true,
    text:     'Hero Power: deal 1 damage to any target.',
  }),
  rogue: Object.freeze({
    id:       'rogue',
    name:     'Coin Strike',
    manaCost: 2,
    effect:   'coin',      // pushes a +0/+1 coin into matchState's coin pool
    value:    1,
    text:     'Hero Power: add a +0/+1 coin to your pool.',
  }),
  ranger: Object.freeze({
    id:       'ranger',
    name:     'Mark Target',
    manaCost: 2,
    effect:   'mark',      // enemy minion takes +1 dmg from next attack this turn
    value:    1,
    needsTarget: true,
    text:     'Hero Power: mark an enemy minion, it takes +1 damage from the next attack this turn.',
  }),
  healer: Object.freeze({
    id:       'healer',
    name:     'Lesser Heal',
    manaCost: 2,
    effect:   'heal',      // restore 2 HP to your hero or a minion
    value:    2,
    needsTarget: true,
    text:     'Hero Power: restore 2 HP to your hero or a friendly minion.',
  }),
});

// ── Construction ────────────────────────────────────────────────────

// Returns the initial heroPower record stamped onto the match state at
// match-creation. Caller wires this in alongside the per-side champion
// in cards-match.startNpcMatch / queueOrMatchPvp etc.:
//
//   match.heroPower = {
//     A: initHeroPowerForMatch(playerA.championClass),
//     B: initHeroPowerForMatch(playerB?.championClass || npc.championClass),
//   };
export function initHeroPowerForMatch(playerHeroClass) {
  const cls = HERO_POWER_DEFS[playerHeroClass] ? playerHeroClass : 'warrior';
  const def = HERO_POWER_DEFS[cls];
  return {
    id:           def.id,
    manaCost:     def.manaCost,
    usedThisTurn: false,
  };
}

// ── Gate ────────────────────────────────────────────────────────────

// True if `playerSide` can fire their hero power right now. Mirrors
// the shape of cards-battle's isLegalAction return, { ok, reason }.
// Callers (combat-action handler) should preflight with this before
// calling resolveHeroPower so the UI can render a disabled button +
// tooltip without paying the resolver cost.
export function canUseHeroPower(matchState, playerSide) {
  if (!matchState || !matchState.heroPower) {
    return { ok: false, reason: 'no-hero-power-state' };
  }
  if (playerSide !== 'A' && playerSide !== 'B') {
    return { ok: false, reason: 'bad-side' };
  }
  const hp = matchState.heroPower[playerSide];
  if (!hp) return { ok: false, reason: 'no-hero-power-state' };
  if (hp.usedThisTurn) return { ok: false, reason: 'already-used-this-turn' };
  const mana = matchState.mana?.[playerSide];
  if (!mana) return { ok: false, reason: 'no-mana-state' };
  if ((mana.cur || 0) < (hp.manaCost || 0)) {
    return { ok: false, reason: 'insufficient-mana', need: hp.manaCost, have: mana.cur };
  }
  return { ok: true };
}

// ── Resolve ─────────────────────────────────────────────────────────

// Mutates matchState in place to apply the player's hero power, spend
// the mana, and flip usedThisTurn. Returns { stateAfter, log }.
//
// `opts.targetId` is required for mage/ranger/healer:
//   - 'hero'         → your own hero (heal) or enemy hero (fire bolt)
//   - 'oppHero'      → enemy hero (alias for fire bolt clarity)
//   - 'selfHero'     → your own hero (alias for heal clarity)
//   - <minion uid>   → board minion (any side; resolver picks the right
//                       board based on the power)
//
// On invalid args the function returns { stateAfter: matchState, log:
// [{ kind:'hero-power-rejected', reason }] } and does NOT mutate state.
export function resolveHeroPower(matchState, playerSide, opts = {}) {
  const gate = canUseHeroPower(matchState, playerSide);
  if (!gate.ok) {
    return {
      stateAfter: matchState,
      log: [{ kind: 'hero-power-rejected', side: playerSide, reason: gate.reason }],
    };
  }
  const hp = matchState.heroPower[playerSide];
  const def = HERO_POWER_DEFS[hp.id];
  if (!def) {
    return {
      stateAfter: matchState,
      log: [{ kind: 'hero-power-rejected', side: playerSide, reason: 'unknown-power' }],
    };
  }
  const opp = playerSide === 'A' ? 'B' : 'A';
  const log = [];

  switch (def.effect) {
    case 'armor': {
      _ensureArmor(matchState);
      matchState.heroArmor[playerSide] = (matchState.heroArmor[playerSide] || 0) + def.value;
      log.push({
        kind:   'hero-power',
        side:   playerSide,
        power:  def.id,
        effect: 'armor',
        value:  def.value,
        armor:  matchState.heroArmor[playerSide],
      });
      break;
    }
    case 'damage': {
      const target = _resolveDamageTarget(matchState, playerSide, opts.targetId);
      if (!target) {
        return {
          stateAfter: matchState,
          log: [{ kind: 'hero-power-rejected', side: playerSide, reason: 'invalid-target' }],
        };
      }
      if (target.kind === 'hero') {
        matchState.hp[target.side] = (matchState.hp[target.side] || 0) - def.value;
        log.push({
          kind:   'hero-power',
          side:   playerSide,
          power:  def.id,
          effect: 'damage',
          target: { kind: 'hero', side: target.side },
          value:  def.value,
          hp:     matchState.hp[target.side],
        });
      } else {
        target.minion.hp -= def.value;
        log.push({
          kind:   'hero-power',
          side:   playerSide,
          power:  def.id,
          effect: 'damage',
          target: { kind: 'minion', uid: target.minion.uid, side: target.side },
          value:  def.value,
          minionHp: target.minion.hp,
        });
      }
      break;
    }
    case 'coin': {
      _ensureCoinPool(matchState);
      matchState.coinPool[playerSide].push({ atk: 0, hp: def.value, sourcedFrom: 'hero-power' });
      log.push({
        kind:   'hero-power',
        side:   playerSide,
        power:  def.id,
        effect: 'coin',
        coin:   { atk: 0, hp: def.value },
        poolSize: matchState.coinPool[playerSide].length,
      });
      break;
    }
    case 'mark': {
      // Mark an enemy minion. Stored as a side-table keyed by uid so
      // the orchestrator's damage-dealer can look it up + consume it
      // on the next attack this turn.
      const minion = _findMinionAnyBoard(matchState, opts.targetId);
      if (!minion || minion.side !== opp) {
        return {
          stateAfter: matchState,
          log: [{ kind: 'hero-power-rejected', side: playerSide, reason: 'invalid-target' }],
        };
      }
      _ensureMarkedTargets(matchState);
      matchState.markedTargets[minion.minion.uid] = {
        bonusDamage: def.value,
        markedBy:    playerSide,
        turn:        matchState.turn,
      };
      log.push({
        kind:   'hero-power',
        side:   playerSide,
        power:  def.id,
        effect: 'mark',
        target: { uid: minion.minion.uid, side: minion.side },
        bonus:  def.value,
      });
      break;
    }
    case 'heal': {
      const target = _resolveHealTarget(matchState, playerSide, opts.targetId);
      if (!target) {
        return {
          stateAfter: matchState,
          log: [{ kind: 'hero-power-rejected', side: playerSide, reason: 'invalid-target' }],
        };
      }
      if (target.kind === 'hero') {
        matchState.hp[target.side] = Math.min(30, (matchState.hp[target.side] || 0) + def.value);
        log.push({
          kind:   'hero-power',
          side:   playerSide,
          power:  def.id,
          effect: 'heal',
          target: { kind: 'hero', side: target.side },
          value:  def.value,
          hp:     matchState.hp[target.side],
        });
      } else {
        const max = _maxHpOf(target.minion);
        target.minion.hp = Math.min(max, target.minion.hp + def.value);
        log.push({
          kind:   'hero-power',
          side:   playerSide,
          power:  def.id,
          effect: 'heal',
          target: { kind: 'minion', uid: target.minion.uid, side: target.side },
          value:  def.value,
          minionHp: target.minion.hp,
        });
      }
      break;
    }
    default:
      return {
        stateAfter: matchState,
        log: [{ kind: 'hero-power-rejected', side: playerSide, reason: 'unknown-effect' }],
      };
  }

  // Spend mana + flip the once-per-turn flag.
  matchState.mana[playerSide].cur -= def.manaCost;
  hp.usedThisTurn = true;

  return { stateAfter: matchState, log };
}

// ── Turn boundary ───────────────────────────────────────────────────

// Called by the orchestrator at end-of-turn for the OUTGOING player
// (i.e. the player whose turn is ending). Resets the once-per-turn
// flag so the same player can re-fire on their next turn. Also clears
// any "this turn" marks they placed via Mark Target.
export function onTurnEnd(matchState, playerSide) {
  if (!matchState || !matchState.heroPower) return matchState;
  const hp = matchState.heroPower[playerSide];
  if (hp) hp.usedThisTurn = false;
  // Drop any marks placed BY this player this turn. (Marks placed by
  // the opponent persist into our turn so they still affect our
  // attacks, though in practice the orchestrator should also call
  // onTurnEnd for the opponent when their turn flips; this is a
  // belt-and-braces sweep.)
  if (matchState.markedTargets) {
    for (const uid of Object.keys(matchState.markedTargets)) {
      const m = matchState.markedTargets[uid];
      if (m && m.markedBy === playerSide && m.turn === matchState.turn) {
        delete matchState.markedTargets[uid];
      }
    }
  }
  return matchState;
}

// ── Internal helpers ────────────────────────────────────────────────

function _ensureArmor(matchState) {
  if (!matchState.heroArmor) matchState.heroArmor = { A: 0, B: 0 };
}

function _ensureCoinPool(matchState) {
  if (!matchState.coinPool) matchState.coinPool = { A: [], B: [] };
  if (!Array.isArray(matchState.coinPool.A)) matchState.coinPool.A = [];
  if (!Array.isArray(matchState.coinPool.B)) matchState.coinPool.B = [];
}

function _ensureMarkedTargets(matchState) {
  if (!matchState.markedTargets) matchState.markedTargets = {};
}

// Resolve a damage target ('hero' or 'oppHero' → enemy hero; minion
// uid → any board). Mage/Fire Bolt can hit any target so we don't
// restrict by side. Returns null for unknown uids.
function _resolveDamageTarget(matchState, playerSide, targetId) {
  if (!targetId) return null;
  const opp = playerSide === 'A' ? 'B' : 'A';
  if (targetId === 'oppHero' || targetId === 'hero') {
    return { kind: 'hero', side: opp };
  }
  if (targetId === 'selfHero') {
    return { kind: 'hero', side: playerSide };
  }
  const found = _findMinionAnyBoard(matchState, targetId);
  return found ? { kind: 'minion', side: found.side, minion: found.minion } : null;
}

// Resolve a heal target. Healer can only target self-hero or friendly
// minions. Returns null otherwise (rejected by resolveHeroPower).
function _resolveHealTarget(matchState, playerSide, targetId) {
  if (!targetId) return null;
  if (targetId === 'selfHero' || targetId === 'hero') {
    return { kind: 'hero', side: playerSide };
  }
  const found = _findMinionAnyBoard(matchState, targetId);
  if (!found) return null;
  if (found.side !== playerSide) return null;       // can't heal enemy minions
  return { kind: 'minion', side: found.side, minion: found.minion };
}

function _findMinionAnyBoard(matchState, uid) {
  if (!uid || !matchState.board) return null;
  for (const side of ['A', 'B']) {
    const arr = matchState.board[side] || [];
    for (const m of arr) {
      if (m.uid === uid) return { side, minion: m };
    }
  }
  return null;
}

// Best-effort max-HP read. Boltbound minions carry `maxHp` after first
// damage; if absent we treat the current hp as the cap (so healing
// undamaged minions is a no-op, which matches "you can't overheal").
function _maxHpOf(minion) {
  if (typeof minion.maxHp === 'number') return minion.maxHp;
  return minion.hp;
}

// ── Test-only exports ───────────────────────────────────────────────
export const __internals = {
  _resolveDamageTarget,
  _resolveHealTarget,
  _findMinionAnyBoard,
};
