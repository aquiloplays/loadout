// Spire boss mechanic engine.
//
// Each season's boss has a unique mechanic the player must counter.
// The mechanic is declared in spire-seasons.js as
//   { id, phase, params }
// where `phase` is one of:
//   'start-of-turn', fires at the boss's start-of-turn step
//   'end-of-turn', fires at the boss's end-of-turn step
//   'on-play', fires when the boss plays a minion
//   'on-draw', fires when ANY player draws a card
//   'on-deathrattle', fires when a friendly minion dies
//   'persistent', a passive effect always in force during boss
//                        fights (e.g. boss lifesteal)
//
// `id` selects the actual effect function from MECHANIC_HOOKS below.
// `params` are id-specific (e.g. {damageToAllFriendly: 1, message}).
//
// The match engine (cards-match.js) calls applyBossMechanic(match,
// phase, ctx) at each phase. If the match is a spire boss fight
// (`match.kind === 'spire-boss'`) and the matching phase fires, the
// hook runs against the match state in-place + appends a log line.
//
// Hooks are PURE-ISH, they mutate the match argument and return
// a string to append to the log, or null when no-op. They never
// throw, a bad params payload should degrade gracefully.

// Registry of available mechanics. Each entry is keyed by the
// mechanic's `id`. The match engine never references this map by
// hardcoded id, it dispatches by the boss's declared mechanic.
const MECHANIC_HOOKS = {
  // Ember Court, at end of boss turn, deal N damage to all friendly
  // (player) minions.
  'ember.end-of-turn-burn': (match, params, ctx) => {
    const damage = Number(params?.damageToAllFriendly) || 1;
    const playerSide = ctx.playerSide;
    const board = match.board?.[playerSide];
    if (!Array.isArray(board) || !board.length) return null;
    for (const m of board) { m.hp = Math.max(0, (m.hp || 0) - damage); }
    return params?.message
      || `Ember Court burns, ${damage} dmg to all friendly minions.`;
  },

  // Aurora Spire, at start of player turn, reduce mana by N (floor M).
  'aurora.start-of-turn-mana-drain': (match, params, ctx) => {
    const reduction = Number(params?.manaReduction) || 1;
    const floor     = Number(params?.floor) || 2;
    const ps = ctx.playerSide;
    const mana = match.mana?.[ps];
    if (!mana) return null;
    mana.current = Math.max(floor, (mana.current || 0) - reduction);
    return params?.message || `Aurora drains ${reduction} mana.`;
  },

  // Sunken Vault, every Nth player draw, discard the drawn card.
  'sunken.discard-on-draw': (match, params, ctx) => {
    if (ctx.drawingSide !== ctx.playerSide) return null;
    const nth = Math.max(1, Number(params?.discardEveryNth) || 4);
    const counter = (match.spireCounters ||= {});
    counter.playerDraws = (counter.playerDraws || 0) + 1;
    if (counter.playerDraws % nth !== 0) return null;
    const hand = match.hands?.[ctx.playerSide];
    if (Array.isArray(hand) && hand.length) {
      const drawn = ctx.drawnCardId || hand[hand.length - 1];
      const idx = hand.lastIndexOf(drawn);
      if (idx >= 0) hand.splice(idx, 1);
    }
    return params?.message || `The Vault hungers, your draw is discarded.`;
  },

  // Verdant Hollow, at end of boss turn, spawn a Thorn Vine on boss board.
  'verdant.summon-thorn': (match, params, ctx) => {
    const bs = ctx.bossSide;
    const board = (match.board ||= {})[bs] ||= [];
    if (board.length >= 7) return params?.message
      || 'Verdant tries to sprout, boss board is full.';
    const tok = params?.spawnMinion || { cardId: 'spire.token.thorn', atk: 1, hp: 2 };
    board.push({
      uid:    `thorn-${match.turn}-${board.length}`,
      cardId: tok.cardId,
      atk:    tok.atk, hp: tok.hp,
      status: ['summoning-sickness'],
      keywords: ['taunt'],
      canAttack: false,
    });
    return params?.message || 'A thorn vine sprouts on the boss board.';
  },

  // Sandstorm Bazaar, every Nth start-of-turn, swap ATK/HP on all minions.
  'sandstorm.swap-attack': (match, params, ctx) => {
    const nth = Math.max(1, Number(params?.swapAtkHpEveryNth) || 3);
    const counter = (match.spireCounters ||= {});
    counter.startTurns = (counter.startTurns || 0) + 1;
    if (counter.startTurns % nth !== 0) return null;
    for (const side of ['A', 'B']) {
      const board = match.board?.[side] || [];
      for (const m of board) {
        const a = m.atk || 0;
        m.atk = m.hp || 0;
        m.hp  = a;
      }
    }
    return params?.message || 'Sandstorm, atk/hp swapped on all minions.';
  },

  // Frost Citadel, start of player turn, freeze a random friendly minion.
  'frost.freeze-random': (match, params, ctx) => {
    const ps = ctx.playerSide;
    const board = match.board?.[ps] || [];
    const unfrozen = board.filter(m => !(m.status || []).includes('frozen'));
    if (!unfrozen.length) return null;
    const pick = unfrozen[Math.floor((match.turn || 1) % unfrozen.length)];
    (pick.status ||= []).push('frozen');
    pick.canAttack = false;
    return params?.message || 'Frost grips one of your minions.';
  },

  // Clockwork Foundry, on-play, every Nth boss minion fires battlecry twice.
  'foundry.double-effects': (match, params, ctx) => {
    if (ctx.playedSide !== ctx.bossSide) return null;
    const nth = Math.max(1, Number(params?.doubleBattlecryEveryNth) || 3);
    const counter = (match.spireCounters ||= {});
    counter.bossPlays = (counter.bossPlays || 0) + 1;
    if (counter.bossPlays % nth !== 0) return null;
    ctx.requestDoubleBattlecry = true;     // engine reads + replays
    return params?.message || 'Clockwork gears grind, boss battlecry fires twice.';
  },

  // Mirror Garden, end of player turn, copy a random friendly minion to boss.
  'mirror.copy-minion': (match, params, ctx) => {
    const ps = ctx.playerSide;
    const bs = ctx.bossSide;
    const src = match.board?.[ps] || [];
    if (!src.length) return null;
    const bossBoard = (match.board ||= {})[bs] ||= [];
    if (bossBoard.length >= 7) return null;
    const idx = Math.floor((match.turn || 1) % src.length);
    const proto = src[idx];
    bossBoard.push({
      uid:    `mirror-${match.turn}-${bossBoard.length}`,
      cardId: proto.cardId,
      atk:    proto.atk, hp: proto.hp,
      status: ['summoning-sickness'],
      keywords: (proto.keywords || []).slice(),
      canAttack: false,
    });
    return params?.message || 'Mirror Garden, your minion is copied to the boss board.';
  },

  // Bone Reliquary, boss deathrattles trigger twice.
  'bone.deathrattle-chain': (match, params, ctx) => {
    if (ctx.deathSide !== ctx.bossSide) return null;
    ctx.requestExtraDeathrattle = true;
    return params?.message || 'A bone-saint re-triggers a deathrattle.';
  },

  // Cinder Apex, fatigue damage on player draws is doubled.
  'apex.fatigue-double': (match, params, ctx) => {
    if (ctx.drawingSide !== ctx.playerSide) return null;
    if (!ctx.fatigueDamage) return null;
    ctx.fatigueDamage = ctx.fatigueDamage * 2;
    return params?.message || 'The Apex burns your library, fatigue doubled.';
  },

  // Stargazer Court, on player draw, reveal opponent's topcard. If
  // it matches your draw's rarity, opponent re-draws.
  'stargazer.predict-redraw': (match, params, ctx) => {
    if (ctx.drawingSide !== ctx.playerSide) return null;
    ctx.peekOpponentTopcard = true;
    return params?.message || 'The Stargazer sees your draw.';
  },

  // Velvet Catacomb, persistent: all boss damage heals the boss.
  'velvet.lifesteal-boss': (match, params, ctx) => {
    if (ctx.attackingSide !== ctx.bossSide) return null;
    const amount = Number(ctx.damageDealt) || 0;
    if (amount <= 0) return null;
    const bs = ctx.bossSide;
    match.hp[bs] = Math.min(30, (match.hp[bs] || 0) + amount);
    return params?.message
      || `Velvet Catacomb, boss heals ${amount} from its strike.`;
  },
};

/**
 * Dispatch entry point, called by the match engine at each phase.
 * Returns a string (log line to append) or null when no-op.
 *
 * @param {object} match, the in-flight match state, mutated in-place
 * @param {string} phase, 'start-of-turn' | 'end-of-turn' | 'on-play' | 'on-draw' | 'on-deathrattle' | 'persistent'
 * @param {object} ctx, { playerSide, bossSide, ...phase-specific fields }
 */
export function applyBossMechanic(match, phase, ctx) {
  if (!match || match.kind !== 'spire-boss') return null;
  const mech = match.bossMechanic;
  if (!mech || mech.phase !== phase) return null;
  const hook = MECHANIC_HOOKS[mech.id];
  if (!hook) return null;
  try { return hook(match, mech.params || {}, ctx || {}); }
  catch { return null; }
}

// Exported for tests + the run-start path that wants to know which
// mechanic a given seasonId will impose.
export function listMechanicIds() {
  return Object.keys(MECHANIC_HOOKS);
}
