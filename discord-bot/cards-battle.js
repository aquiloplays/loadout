// Boltbound — deterministic battle engine.
//
// Pure functions. No KV I/O, no Date.now(), no Math.random — all RNG
// goes through a seeded generator. The same (match, action) input
// always produces the same (match', log) output, so /boltbound log
// can show a faithful replay and the future web client can re-run a
// match locally to render the animation.
//
// Same posture as clash-raid.js — see CARD-GAME-DESIGN.md §2 for the
// match shape and §3 for the ability key dictionary.
//
// Public API:
//   createMatch(opts)                    — build initial match state
//   applyMulligan(match, side, idxs)     — replace 0..N starting cards
//   applyAction(match, action)           — { match, events, ended? }
//   isLegalAction(match, action)         — preflight a UI action
//   summariseMatch(match)                — receipt-shape projection for /log

import { CARDS, CHAMPIONS, championForClass, KEYWORDS, ADAPT_POOL } from './cards-content.js';

// ── RNG ──────────────────────────────────────────────────────────────

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < (s || '').length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; };
}

// Match-scoped rng — keyed off the match seed + a step counter so
// every action has its own stable sub-seed. We bump match.rngStep
// before each rng call so order matters but the same starting seed
// always replays identically.
function rng(match) {
  match.rngStep = (match.rngStep || 0) + 1;
  return makeRng((match.seed >>> 0) ^ match.rngStep);
}

function rngFloat(match) { return rng(match)(); }

// ── Match creation ───────────────────────────────────────────────────
//
// opts: {
//   matchId,             // unique id, drives the seed
//   guildId,             // home channel (used for queue scoping outside this module)
//   playerA: { userId, deck: [cardId,...], championClass },
//   playerB: { userId, deck: [cardId,...], championClass } | null,  // null => NPC
//   npc:     { archetype: 'aggro'|'control'|'midrange', deck: [cardId,...], championClass } | null,
//   goingFirst: 'A' | 'B' | null,   // null => coin flip
// }

const STARTING_HP = 30;
const HAND_CAP = 5;
const STARTING_HAND_A = 3;
const STARTING_HAND_B = 4;

export function createMatch(opts) {
  if (!opts.matchId) throw new Error('matchId required');
  if (!opts.playerA?.deck?.length) throw new Error('playerA deck required');
  if (!opts.playerB && !opts.npc) throw new Error('playerB or npc required');

  const seed = hashStr(opts.matchId);
  const tmp = { seed, rngStep: 0 };

  const goingFirst = opts.goingFirst || (rngFloat(tmp) < 0.5 ? 'A' : 'B');
  const m = {
    matchId: opts.matchId,
    guildId: opts.guildId || null,
    createdUtc: opts.createdUtc || 0,         // orchestrator stamps real time
    lastTurnUtc: 0,
    players: {
      A: opts.playerA.userId,
      B: opts.playerB?.userId || ('npc:' + (opts.npc?.archetype || 'aggro')),
    },
    npc: opts.npc ? { ...opts.npc, side: opts.playerB ? null : 'B' } : null,
    decks:  { A: shuffleDeck(opts.playerA.deck, tmp), B: shuffleDeck((opts.playerB || opts.npc).deck, tmp) },
    hands:  { A: [], B: [] },
    hp:     { A: STARTING_HP, B: STARTING_HP },
    mana:   { A: { cur: 0, max: 0 }, B: { cur: 0, max: 0 } },
    bonusMana: { A: 0, B: 0 },                // manaThisTurn carryover for current turn
    overloadNext: { A: 0, B: 0 },             // mana locked NEXT turn by Overload (X)
    cardsPlayed: { A: 0, B: 0 },              // cards played THIS turn (Combo gate)
    board:  { A: [], B: [] },
    graveyard: { A: [], B: [] },
    spellsCast: { A: 0, B: 0 },               // for The Hollow King's gate
    counterNextSpell: { A: false, B: false }, // Relic Seal
    fatigueDmg: { A: 0, B: 0 },               // empty-deck draw escalation
    turn: 1,
    active: goingFirst,
    goingFirst,
    log: [],
    status: 'mulligan',
    seed,
    rngStep: tmp.rngStep,
    boardUidCounter: 1,
  };

  // Draw starting hands. Going first = 3 cards. Going second = 4 + bonus mana token (one-shot +1 mana on turn 1).
  drawCardsRaw(m, 'A', goingFirst === 'A' ? STARTING_HAND_A : STARTING_HAND_B);
  drawCardsRaw(m, 'B', goingFirst === 'B' ? STARTING_HAND_A : STARTING_HAND_B);
  if (goingFirst === 'A') m.bonusMana.B = 1;
  else m.bonusMana.A = 1;

  push(m, { t: 0, kind: 'match-start', goingFirst });
  return m;
}

function shuffleDeck(cardIds, ctx) {
  // Fisher–Yates with the match RNG. Mutates a copy.
  const arr = cardIds.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rngFloat(ctx) * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Internal — no fatigue, just take the top of deck. Used by createMatch
// to draw starting hands before fatigue rules apply.
function drawCardsRaw(match, side, n) {
  for (let i = 0; i < n; i++) {
    if (!match.decks[side].length) break;
    const id = match.decks[side].shift();
    if (match.hands[side].length < HAND_CAP) {
      match.hands[side].push(id);
    } else {
      // Burn — over hand cap, discarded.
      match.graveyard[side].push(id);
      push(match, { t: match.turn, kind: 'burn', side, cardId: id });
    }
  }
}

// Turn-time draw — applies fatigue when the deck is empty.
function drawTurnStart(match, side) {
  if (match.decks[side].length === 0) {
    match.fatigueDmg[side] = (match.fatigueDmg[side] || 0) + 1;
    const dmg = match.fatigueDmg[side];
    match.hp[side] -= dmg;
    push(match, { t: match.turn, kind: 'fatigue', side, dmg, hp: match.hp[side] });
    return;
  }
  const id = match.decks[side].shift();
  if (match.hands[side].length < HAND_CAP) {
    match.hands[side].push(id);
    push(match, { t: match.turn, kind: 'draw', side, cardId: id });
  } else {
    match.graveyard[side].push(id);
    push(match, { t: match.turn, kind: 'burn', side, cardId: id });
  }
}

// ── Mulligan ─────────────────────────────────────────────────────────
//
// One-shot. Replace the chosen subset of starting hand with the same
// number of fresh cards. The discarded ones go BACK to the bottom of
// the deck (so the replacement pool is non-overlapping with the
// discards — Hearthstone rule).

export function applyMulligan(match, side, handIndices) {
  if (match.status !== 'mulligan') return match;
  const toReplace = (handIndices || []).map(i => +i).filter(i => Number.isInteger(i) && i >= 0 && i < match.hands[side].length);
  if (toReplace.length === 0) {
    // Mark side as mulligan-complete (sentinel-empty hands tracked in mulliganDone)
  }
  // Shuffle the discards back in, then draw N replacements.
  const dedupedSorted = Array.from(new Set(toReplace)).sort((a, b) => b - a);  // remove from end so indices stay valid
  const discardedCards = [];
  for (const i of dedupedSorted) {
    discardedCards.push(match.hands[side][i]);
    match.hands[side].splice(i, 1);
  }
  // Put discards on the bottom of the deck.
  for (const id of discardedCards) match.decks[side].push(id);
  // Draw fresh ones.
  drawCardsRaw(match, side, dedupedSorted.length);
  if (!match.mulliganDone) match.mulliganDone = {};
  match.mulliganDone[side] = true;
  push(match, { t: 0, kind: 'mulligan', side, replaced: dedupedSorted.length });
  // If both sides mulliganned, start turn 1 properly.
  if (match.mulliganDone.A && match.mulliganDone.B) {
    match.status = 'active';
    startTurn(match, match.goingFirst);
  }
  return match;
}

// ── Turn machinery ───────────────────────────────────────────────────

function startTurn(match, side) {
  match.active = side;
  // Max mana up to 10 — but at the very start (turn 1 going-first), the
  // active player gets 1 base mana NOT incremented from prior turn.
  if (match.mana[side].max < 10) match.mana[side].max += 1;
  match.mana[side].cur = match.mana[side].max + (match.bonusMana[side] || 0);
  match.bonusMana[side] = 0;
  // Overload: mana crystals locked by a card played LAST turn are unusable
  // this turn. Consume the accumulator after applying so it only bites once.
  if (match.overloadNext?.[side]) {
    const locked = Math.min(match.mana[side].cur, match.overloadNext[side]);
    match.mana[side].cur -= locked;
    push(match, { t: match.turn, kind: 'overload', side, locked });
    match.overloadNext[side] = 0;
  }
  // New turn — the Combo gate resets (the next card played is "first").
  match.cardsPlayed[side] = 0;
  // Untap at the start of the OWNER's turn (charge/rush handle the
  // play-turn case). Frozen minions thaw instead of untapping — they miss
  // exactly this one turn, then act normally next turn.
  for (const m of match.board[side]) {
    m.exhausted = false;
    if ((m.status || []).includes('frozen')) {
      m.status = m.status.filter(s => s !== 'frozen');
      m.canAttack = false;
      push(match, { t: match.turn, kind: 'thaw', side, uid: m.uid });
    } else {
      m.canAttack = true;
    }
    // Rush's no-hero restriction only applies the turn it was played;
    // by the owner's next turn it attacks freely.
    if ((m.status || []).includes('rush-fresh')) {
      m.status = m.status.filter(s => s !== 'rush-fresh');
    }
  }
  // Stealth wears off at start of the owner's turn AFTER they were played
  // (so stealth applies for the opponent's one turn, then drops).
  for (const m of match.board[side]) {
    if (m.status?.includes('stealth-fresh')) {
      m.status = m.status.filter(s => s !== 'stealth-fresh');
      m.status.push('stealth');
    } else if (m.status?.includes('stealth')) {
      m.status = m.status.filter(s => s !== 'stealth');
    }
  }
  // Start of turn triggers.
  for (const m of match.board[side]) fireAbilities(match, m, side, 'startOfTurn');
  // Draw a card.
  drawTurnStart(match, side);
  // Counter-next-spell flag is for the OPPONENT's next spell — reset
  // the *opposite* side's flag here (no — actually we set it when
  // Relic Seal is cast; it'll be consumed by the opponent's next spell).
  // Don't touch it here; that gets handled in cast resolution.
  push(match, { t: match.turn, kind: 'turn-start', side, mana: { ...match.mana[side] } });
}

function endTurn(match, side) {
  // Fire endOfTurn triggers for owner-side minions.
  for (const m of match.board[side].slice()) {
    if (m.hp > 0) fireAbilities(match, m, side, 'endOfTurn');
  }
  // Wear off this-turn buffs.
  for (const arr of [match.board.A, match.board.B]) {
    for (const m of arr) {
      if (m.tempAtk) { m.atk = Math.max(0, m.atk - m.tempAtk); m.tempAtk = 0; }
      if (m.tempHp)  { m.hp = Math.max(0, m.hp - m.tempHp);  m.tempHp = 0; }   // this-turn HP is a temporary cap; we don't restore lost HP, just clear the bookkeeping
    }
  }
  // Hero this-turn shield (Iron Skin): just bookkeeping reset.
  for (const s of ['A', 'B']) {
    if (match.heroTempHp?.[s]) match.heroTempHp[s] = 0;
  }
  push(match, { t: match.turn, kind: 'turn-end', side });
  // Fatigue check — if past turn 20, start global fatigue.
  if (match.turn >= 20) {
    match.hp.A -= 2;
    match.hp.B -= 2;
    push(match, { t: match.turn, kind: 'global-fatigue', a: match.hp.A, b: match.hp.B });
  }
  // Swap sides + advance turn counter when wrapping back to goingFirst.
  const next = side === 'A' ? 'B' : 'A';
  if (next === match.goingFirst) match.turn += 1;
  // Resolve victory conditions before starting the next turn.
  if (resolveVictoryIfAny(match)) return match;
  startTurn(match, next);
  return match;
}

function resolveVictoryIfAny(match) {
  if (match.status !== 'active') return true;
  const aDead = match.hp.A <= 0;
  const bDead = match.hp.B <= 0;
  if (aDead && bDead) { match.status = 'draw'; push(match, { t: match.turn, kind: 'match-end', result: 'draw' }); return true; }
  if (aDead) { match.status = 'B-won'; push(match, { t: match.turn, kind: 'match-end', result: 'B-won' }); return true; }
  if (bDead) { match.status = 'A-won'; push(match, { t: match.turn, kind: 'match-end', result: 'A-won' }); return true; }
  if (match.turn > 20) {
    if (match.hp.A > match.hp.B) match.status = 'A-won';
    else if (match.hp.B > match.hp.A) match.status = 'B-won';
    else match.status = 'draw';
    push(match, { t: match.turn, kind: 'match-end', result: match.status, reason: 'turn-cap' });
    return true;
  }
  return false;
}

// ── Actions ──────────────────────────────────────────────────────────

export function applyAction(match, action) {
  if (match.status !== 'active' && action.kind !== 'concede') {
    return { match, ended: match.status !== 'active', error: 'match-not-active' };
  }
  if (action.kind === 'concede') {
    match.status = action.side === 'A' ? 'B-won' : 'A-won';
    push(match, { t: match.turn, kind: 'concede', side: action.side });
    push(match, { t: match.turn, kind: 'match-end', result: match.status });
    return { match, ended: true };
  }
  if (action.side !== match.active) {
    return { match, error: 'not-your-turn' };
  }
  if (action.kind === 'endTurn') {
    endTurn(match, action.side);
    return { match, ended: match.status !== 'active' };
  }
  if (action.kind === 'playCard') {
    return playCardAction(match, action);
  }
  if (action.kind === 'attack') {
    return attackAction(match, action);
  }
  return { match, error: 'unknown-action' };
}

function playCardAction(match, action) {
  const side = action.side;
  const idx = +action.handIdx;
  if (!Number.isInteger(idx) || idx < 0 || idx >= match.hands[side].length) {
    return { match, error: 'no-such-card' };
  }
  const cardId = match.hands[side][idx];
  const card = CARDS[cardId];
  if (!card) return { match, error: 'unknown-card' };
  const cost = card.mana || 0;
  if (match.mana[side].cur < cost) return { match, error: 'insufficient-mana' };

  // Spend mana, remove from hand.
  match.mana[side].cur -= cost;
  match.hands[side].splice(idx, 1);

  // Combo gate: this card triggers its `combo` abilities only if it is
  // NOT the first card played this turn. Snapshot before we count it.
  const isCombo = (match.cardsPlayed[side] || 0) > 0;
  match.cardsPlayed[side] = (match.cardsPlayed[side] || 0) + 1;
  // Choose One: which of the two onPlay option groups the player picked.
  const chooseOption = Number.isInteger(+action.chooseOption) ? +action.chooseOption : 0;
  // Overload (X): lock X of your mana crystals next turn (consumed in startTurn).
  if (card.overload) match.overloadNext[side] = (match.overloadNext[side] || 0) + card.overload;

  const fireCtx = { pickedTargetUid: action.targetUid, chooseOption, action };

  if (card.type === 'spell') {
    const r = castSpell(match, side, card, { ...action, _isCombo: isCombo, _chooseOption: chooseOption });
    maybeEcho(match, side, card, cardId);
    return r;
  }
  // Minion: place on board, then onPlay triggers.
  const minion = makeBoardMinion(match, card, side);
  match.board[side].push(minion);
  push(match, { t: match.turn, kind: 'play-minion', side, cardId, uid: minion.uid, atk: minion.atk, hp: minion.hp });

  // Process onPlay abilities — they may need the picked target from
  // the action. Combo abilities fire on top only when this isn't the
  // first card of the turn.
  fireAbilities(match, minion, side, 'onPlay', fireCtx);
  if (isCombo) fireAbilities(match, minion, side, 'combo', fireCtx);

  maybeEcho(match, side, card, cardId);

  // Resolve deaths from any onPlay AoE damage.
  resolveDeaths(match);
  if (resolveVictoryIfAny(match)) return { match, ended: true };
  return { match };
}

// Echo: a played card with the `echo` keyword returns a copy to hand so
// it can be replayed this turn until you run out of mana (the replay
// still costs full mana, so it terminates naturally).
function maybeEcho(match, side, card, cardId) {
  if (!(card.keywords || []).includes('echo')) return;
  if (match.hands[side].length < HAND_CAP) {
    match.hands[side].push(cardId);
    push(match, { t: match.turn, kind: 'echo', side, cardId });
  }
}

function castSpell(match, side, card, action) {
  // If the opponent has Relic Seal'd us, counter this spell.
  if (match.counterNextSpell[side]) {
    match.counterNextSpell[side] = false;
    match.graveyard[side].push(card.id);
    push(match, { t: match.turn, kind: 'counter-spell', side, cardId: card.id });
    return { match };
  }
  match.spellsCast[side] = (match.spellsCast[side] || 0) + 1;
  push(match, { t: match.turn, kind: 'cast-spell', side, cardId: card.id });
  // Spell damage bonus from Voltaic Mage etc.
  const spellDamageBonus = match.board[side].filter(m => (m.spellDamageBonus || 0) > 0).reduce((s, m) => s + m.spellDamageBonus, 0);
  const chooseOption = action._chooseOption || 0;
  const baseCtx = { spellDamageBonus, pickedTargetUid: action.targetUid, chooseOption, source: { kind: 'spell', cardId: card.id } };
  for (const ab of card.abilities || []) {
    // Choose One: skip the option group the player didn't pick.
    if (ab.option !== undefined && ab.option !== chooseOption) continue;
    // onCast always; `combo` abilities only when this isn't the turn's first card.
    if (ab.trigger === 'onCast' || (ab.trigger === 'combo' && action._isCombo)) {
      runEffect(match, side, ab, baseCtx);
    }
  }
  match.graveyard[side].push(card.id);
  resolveDeaths(match);
  if (resolveVictoryIfAny(match)) return { match, ended: true };
  return { match };
}

function attackAction(match, action) {
  const side = action.side;
  const attacker = findMinion(match, side, action.attackerUid);
  if (!attacker || attacker.hp <= 0) return { match, error: 'no-attacker' };
  if (!attacker.canAttack) return { match, error: 'attacker-exhausted' };
  if ((attacker.status || []).includes('frozen')) return { match, error: 'frozen' };
  if (attacker.hollowKing && (match.spellsCast[side] || 0) < 3) return { match, error: 'hollow-king-gated' };
  const opp = side === 'A' ? 'B' : 'A';
  let target = null;
  const targetUid = action.defenderUid;

  // Identify the target — either a minion or the hero.
  if (targetUid === 'hero') {
    // Reach bypasses taunts.
    const hasReach = (attacker.keywords || []).includes('reach');
    // Rush can't go face the turn it lands.
    if ((attacker.status || []).includes('rush-fresh')) {
      return { match, error: 'rush-no-hero' };
    }
    if (!hasReach && hasTaunt(match, opp)) {
      return { match, error: 'taunt-blocks' };
    }
    target = { kind: 'hero', side: opp };
  } else {
    const m = findMinion(match, opp, targetUid);
    if (!m || m.hp <= 0) return { match, error: 'no-defender' };
    if ((m.status || []).includes('stealth') || (m.status || []).includes('stealth-fresh')) {
      return { match, error: 'stealth-blocks' };
    }
    if (hasTaunt(match, opp) && !(m.keywords || []).includes('taunt')) {
      return { match, error: 'must-target-taunt' };
    }
    target = { kind: 'minion', side: opp, minion: m };
  }

  // Fire onAttack abilities.
  fireAbilities(match, attacker, side, 'onAttack', { pickedTargetUid: targetUid });

  // Apply damage both ways.
  if (target.kind === 'hero') {
    dealDamage(match, attacker, { kind: 'hero', side: opp }, attacker.atk);
    // Lifesteal heals own hero.
    if ((attacker.keywords || []).includes('lifesteal')) {
      match.hp[side] = Math.min(STARTING_HP, match.hp[side] + attacker.atk);
      push(match, { t: match.turn, kind: 'lifesteal-heal', side, amount: attacker.atk, hp: match.hp[side] });
    }
  } else {
    const defender = target.minion;
    dealDamage(match, attacker, { kind: 'minion', minion: defender, side: opp }, attacker.atk);
    dealDamage(match, defender, { kind: 'minion', minion: attacker, side }, defender.atk);
    // Poison: any damage dealt kills the minion outright.
    if ((attacker.keywords || []).includes('poison') && defender.hp > 0) {
      defender.hp = 0;
      push(match, { t: match.turn, kind: 'poison-kill', uid: defender.uid });
    }
    if ((defender.keywords || []).includes('poison') && attacker.hp > 0) {
      attacker.hp = 0;
      push(match, { t: match.turn, kind: 'poison-kill', uid: attacker.uid });
    }
    // Lifesteal on attacker — only if they hit a minion too.
    if ((attacker.keywords || []).includes('lifesteal')) {
      match.hp[side] = Math.min(STARTING_HP, match.hp[side] + attacker.atk);
      push(match, { t: match.turn, kind: 'lifesteal-heal', side, amount: attacker.atk, hp: match.hp[side] });
    }
  }

  attacker.canAttack = false;
  push(match, { t: match.turn, kind: 'attack', side, uid: attacker.uid, target: target.kind === 'hero' ? 'hero' : target.minion.uid });

  resolveDeaths(match);
  if (resolveVictoryIfAny(match)) return { match, ended: true };
  return { match };
}

// ── Damage + death ───────────────────────────────────────────────────

function dealDamage(match, source, target, amount) {
  if (amount <= 0) return;
  if (target.kind === 'hero') {
    match.hp[target.side] -= amount;
    push(match, { t: match.turn, kind: 'hero-damage', side: target.side, amount, hp: match.hp[target.side] });
    return;
  }
  const m = target.minion;
  if ((m.status || []).includes('shield')) {
    m.status = m.status.filter(s => s !== 'shield');
    push(match, { t: match.turn, kind: 'shield-block', uid: m.uid });
    return;
  }
  m.hp -= amount;
  push(match, { t: match.turn, kind: 'minion-damage', uid: m.uid, amount, hp: m.hp });
  // onDamage triggers fire for a minion that took (and survived) damage.
  // A dying minion runs its onDeath path instead (resolveDeaths), so we
  // skip onDamage at <=0 to avoid double-firing on the same blow.
  if (m.hp > 0 && target.side) fireAbilities(match, m, target.side, 'onDamage', {});
}

function resolveDeaths(match) {
  // Multiple passes — a deathrattle can damage others which can die.
  for (let pass = 0; pass < 8; pass++) {
    let died = false;
    for (const side of ['A', 'B']) {
      const live = [];
      for (const m of match.board[side]) {
        if (m.hp <= 0) {
          died = true;
          push(match, { t: match.turn, kind: 'death', side, uid: m.uid, cardId: m.cardId });
          match.lastDeadFriendly = match.lastDeadFriendly || {};
          match.lastDeadFriendly[side] = m.cardId;
          match.graveyard[side].push(m.cardId);
          // Fire onDeath triggers.
          fireAbilities(match, m, side, 'onDeath', { dying: true });
          // Reborn (Phoenix): the FIRST time this minion dies it returns
          // to the board with 1 HP, minus its Reborn keyword so it cannot
          // loop. Silenced minions lose Reborn like every other keyword.
          if ((m.keywords || []).includes('reborn') && !m.reborned
              && !(m.status || []).includes('silenced')) {
            const card = CARDS[m.cardId];
            if (card) {
              const nm = makeBoardMinion(match, card, side);
              nm.hp = 1; nm.maxHp = 1;
              nm.keywords = (nm.keywords || []).filter(k => k !== 'reborn');
              nm.reborned = true;
              live.push(nm);   // joins the rebuilt board; alive at 1 HP
              push(match, { t: match.turn, kind: 'reborn', side, cardId: m.cardId, uid: nm.uid });
            }
          }
        } else {
          live.push(m);
        }
      }
      match.board[side] = live;
    }
    if (!died) break;
  }
}

// ── Ability dispatch ─────────────────────────────────────────────────

function fireAbilities(match, minion, side, trigger, ctx = {}) {
  const card = CARDS[minion.cardId];
  if (!card) return;
  // Honour silence.
  if ((minion.status || []).includes('silenced')) return;
  for (const ab of card.abilities || []) {
    if (ab.trigger !== trigger) continue;
    // Choose One: skip the option group the player didn't pick.
    if (ab.option !== undefined && ab.option !== (ctx.chooseOption ?? 0)) continue;
    // A re-summoned copy does not re-trigger its own reSummon (no loop).
    if (ab.effect === 'reSummon' && minion.noReSummon) continue;
    runEffect(match, side, ab, { ...ctx, source: { kind: 'minion', uid: minion.uid, cardId: minion.cardId } });
  }
}

function runEffect(match, side, ab, ctx) {
  const opp = side === 'A' ? 'B' : 'A';
  const eff = ab.effect;
  switch (eff) {
    case 'damage': {
      const amount = (ab.value || 0) + (ctx.spellDamageBonus || 0);
      for (const t of resolveTargets(match, side, ab, ctx)) {
        dealDamage(match, ctx.source, t, amount);
      }
      return;
    }
    case 'heal': {
      const amount = ab.value || 0;
      for (const t of resolveTargets(match, side, ab, ctx)) {
        if (t.kind === 'hero') {
          match.hp[t.side] = Math.min(STARTING_HP, match.hp[t.side] + amount);
          push(match, { t: match.turn, kind: 'hero-heal', side: t.side, amount, hp: match.hp[t.side] });
        } else if (t.kind === 'minion') {
          t.minion.hp = Math.min(t.minion.maxHp || t.minion.hp + amount, t.minion.hp + amount);
          push(match, { t: match.turn, kind: 'minion-heal', uid: t.minion.uid, amount, hp: t.minion.hp });
        }
      }
      return;
    }
    case 'draw': {
      const n = ab.value || 0;
      for (let i = 0; i < n; i++) drawTurnStart(match, side);
      return;
    }
    case 'discard': {
      const n = ab.value || 0;
      const tgtSide = ab.target === 'oppHand' ? opp : side;
      const r = rng(match);
      for (let i = 0; i < n; i++) {
        if (!match.hands[tgtSide].length) break;
        const idx = Math.floor(r() * match.hands[tgtSide].length);
        const dropped = match.hands[tgtSide].splice(idx, 1)[0];
        match.graveyard[tgtSide].push(dropped);
        push(match, { t: match.turn, kind: 'discard', side: tgtSide, cardId: dropped });
      }
      return;
    }
    case 'summon': {
      const summonCardId = ab.cardId;
      const summonSide = ab.target === 'opp' ? opp : side;
      const card = CARDS[summonCardId];
      if (!card) return;
      const m = makeBoardMinion(match, card, summonSide);
      // Summoned tokens get the keyword 'charge' if present in their card def.
      match.board[summonSide].push(m);
      push(match, { t: match.turn, kind: 'summon', side: summonSide, cardId: summonCardId, uid: m.uid });
      return;
    }
    case 'buff': {
      for (const t of resolveTargets(match, side, ab, ctx)) {
        if (t.kind !== 'minion') continue;
        t.minion.atk += (ab.valueAtk || 0);
        t.minion.hp  += (ab.valueHp  || 0);
        t.minion.maxHp = (t.minion.maxHp || t.minion.hp) + (ab.valueHp || 0);
        push(match, { t: match.turn, kind: 'buff', uid: t.minion.uid, valueAtk: ab.valueAtk || 0, valueHp: ab.valueHp || 0 });
      }
      return;
    }
    case 'buffThisTurn': {
      for (const t of resolveTargets(match, side, ab, ctx)) {
        if (t.kind === 'minion') {
          t.minion.tempAtk = (t.minion.tempAtk || 0) + (ab.valueAtk || 0);
          t.minion.atk += (ab.valueAtk || 0);
          if (ab.valueHp) {
            t.minion.tempHp = (t.minion.tempHp || 0) + (ab.valueHp || 0);
            t.minion.hp += (ab.valueHp || 0);
          }
          push(match, { t: match.turn, kind: 'buff-temp', uid: t.minion.uid, valueAtk: ab.valueAtk || 0, valueHp: ab.valueHp || 0 });
        } else if (t.kind === 'hero' && ab.valueHp) {
          // Iron Skin — adds temporary HP that doesn't survive end of turn.
          match.heroTempHp = match.heroTempHp || { A: 0, B: 0 };
          match.heroTempHp[t.side] += ab.valueHp;
          match.hp[t.side] += ab.valueHp;
          push(match, { t: match.turn, kind: 'hero-temp-hp', side: t.side, amount: ab.valueHp, hp: match.hp[t.side] });
        }
      }
      return;
    }
    case 'destroy': {
      for (const t of resolveTargets(match, side, ab, ctx)) {
        if (t.kind === 'minion') {
          t.minion.hp = 0;
          push(match, { t: match.turn, kind: 'destroy', uid: t.minion.uid });
        }
      }
      return;
    }
    case 'returnToHand': {
      // 'self' (deathrattle) or 'lastDeadFriendly' (Resurrect).
      if (ab.target === 'self' && ctx.source?.kind === 'minion') {
        const cardId = ctx.source.cardId;
        const buffAtk = ab.buffAtk || 0;
        const buffHp = ab.buffHp || 0;
        const enrichedId = (buffAtk || buffHp) ? `${cardId}+${buffAtk}/${buffHp}` : cardId;
        if (match.hands[side].length < HAND_CAP) {
          match.hands[side].push(enrichedId);
          push(match, { t: match.turn, kind: 'return-to-hand', side, cardId: enrichedId });
        } else {
          push(match, { t: match.turn, kind: 'return-burn', side, cardId: enrichedId });
        }
        return;
      }
      if (ab.target === 'lastDeadFriendly') {
        const dead = match.lastDeadFriendly?.[side];
        if (!dead) return;
        if (match.hands[side].length < HAND_CAP) {
          match.hands[side].push(dead);
          push(match, { t: match.turn, kind: 'return-to-hand', side, cardId: dead });
        }
        return;
      }
      return;
    }
    case 'copyOpponentCard': {
      if (!match.hands[opp].length) return;
      const r = rng(match);
      const idx = Math.floor(r() * match.hands[opp].length);
      const cardId = match.hands[opp][idx];
      if (match.hands[side].length < HAND_CAP) {
        match.hands[side].push(cardId);
        push(match, { t: match.turn, kind: 'copy-card', side, cardId });
      }
      return;
    }
    case 'silence': {
      for (const t of resolveTargets(match, side, ab, ctx)) {
        if (t.kind === 'minion') {
          t.minion.status = (t.minion.status || []).filter(s => true);
          t.minion.status.push('silenced');
          push(match, { t: match.turn, kind: 'silence', uid: t.minion.uid });
        }
      }
      return;
    }
    case 'counter': {
      match.counterNextSpell[opp] = true;
      push(match, { t: match.turn, kind: 'counter-armed', side });
      return;
    }
    case 'manaThisTurn': {
      // Negative value to subtract opponent's mana next turn.
      if (ab.target === 'oppHero') {
        match.bonusMana[opp] = (match.bonusMana[opp] || 0) + (ab.value || 0);
        push(match, { t: match.turn, kind: 'mana-debt', side: opp, value: ab.value || 0 });
      } else {
        match.mana[side].cur = Math.max(0, match.mana[side].cur + (ab.value || 0));
        push(match, { t: match.turn, kind: 'mana-this-turn', side, value: ab.value || 0 });
      }
      return;
    }
    case 'peekDeck': {
      // No-op for the resolver — the peek is a UI affordance, not a state change.
      push(match, { t: match.turn, kind: 'peek', side, value: ab.value || 1 });
      return;
    }
    case 'freeze': {
      // Frozen minions skip their next turn (see startTurn thaw).
      for (const t of resolveTargets(match, side, ab, ctx)) {
        if (t.kind === 'minion') {
          if (!(t.minion.status || []).includes('frozen')) t.minion.status.push('frozen');
          push(match, { t: match.turn, kind: 'freeze', uid: t.minion.uid });
        }
      }
      return;
    }
    case 'cloneSelf': {
      // Summon a fresh copy of the source minion on the caster's side.
      if (ctx.source?.kind === 'minion') {
        const c = CARDS[ctx.source.cardId];
        if (c) {
          const nm = makeBoardMinion(match, c, side);
          match.board[side].push(nm);
          push(match, { t: match.turn, kind: 'summon', side, cardId: c.id, uid: nm.uid, clone: true });
        }
      }
      return;
    }
    case 'reSummon': {
      // Resurrect the dying minion once. The copy is flagged so its own
      // onDeath reSummon does not fire (no infinite loop).
      if (ctx.source?.kind === 'minion') {
        const c = CARDS[ctx.source.cardId];
        if (c) {
          const nm = makeBoardMinion(match, c, side);
          nm.noReSummon = true;
          match.board[side].push(nm);
          push(match, { t: match.turn, kind: 'resummon', side, cardId: c.id, uid: nm.uid });
        }
      }
      return;
    }
    case 'revealAndDraw': {
      const n = ab.value || 1;
      push(match, { t: match.turn, kind: 'reveal', side, value: n });
      for (let i = 0; i < n; i++) drawTurnStart(match, side);
      return;
    }
    case 'doubleBattlecry': {
      // Re-fire the onPlay (battlecry) of the most recent OTHER friendly
      // minion still on the board.
      const board = match.board[side];
      const srcUid = ctx.source?.uid;
      let prev = null;
      for (let i = board.length - 1; i >= 0; i--) {
        if (board[i].uid !== srcUid && board[i].hp > 0) { prev = board[i]; break; }
      }
      if (prev) {
        push(match, { t: match.turn, kind: 'double-battlecry', side, uid: prev.uid });
        fireAbilities(match, prev, side, 'onPlay', {});
      }
      return;
    }
    case 'recruit': {
      // Pull a friendly MINION of cost <= value from your deck and summon
      // it to the board. Removes it from the deck (so it can't be drawn
      // twice). Seeded pick among eligible cards for replay determinism.
      const maxMana = ab.value || 0;
      const deck = match.decks[side];
      const eligible = [];
      for (let i = 0; i < deck.length; i++) {
        const c = CARDS[deck[i]];
        if (!c || c.type !== 'minion') continue;
        if ((c.mana || 0) > maxMana) continue;
        if (ab.tribe && c.tribe !== ab.tribe) continue;   // tribal recruit filter
        eligible.push(i);
      }
      if (!eligible.length) { push(match, { t: match.turn, kind: 'recruit-miss', side }); return; }
      const pickIdx = eligible[Math.floor(rng(match)() * eligible.length)];
      const cardId = deck[pickIdx];
      deck.splice(pickIdx, 1);
      const c = CARDS[cardId];
      const nm = makeBoardMinion(match, c, side);
      match.board[side].push(nm);
      push(match, { t: match.turn, kind: 'recruit', side, cardId, uid: nm.uid });
      return;
    }
    case 'adapt': {
      // Grant the source minion one buff from ADAPT_POOL. The player's
      // pick (ctx.action.adaptChoice) wins; otherwise a seeded choice so
      // NPCs + replays stay deterministic.
      if (ctx.source?.kind !== 'minion') return;
      const self = findMinion(match, side, ctx.source.uid);
      if (!self) return;
      let choice = Number(ctx.action?.adaptChoice);
      if (!Number.isInteger(choice) || choice < 0 || choice >= ADAPT_POOL.length) {
        choice = Math.floor(rng(match)() * ADAPT_POOL.length);
      }
      const pick = ADAPT_POOL[choice];
      if (pick.buff) {
        self.atk += pick.buff.valueAtk || 0;
        self.hp  += pick.buff.valueHp  || 0;
        self.maxHp = (self.maxHp || self.hp) + (pick.buff.valueHp || 0);
      }
      if (pick.keyword && !(self.keywords || []).includes(pick.keyword)) {
        self.keywords.push(pick.keyword);
        if (pick.keyword === 'shield' && !self.status.includes('shield')) self.status.push('shield');
      }
      push(match, { t: match.turn, kind: 'adapt', side, uid: self.uid, label: pick.label });
      return;
    }
    case 'discover': {
      // Reveal 3 candidate cards from a pool and add the picked one to
      // hand. Pool = ab.pool (array of cardIds) or, by default, the
      // caster's own deck. action.discoverChoice picks (0..2); else seeded.
      const poolIds = Array.isArray(ab.pool) && ab.pool.length
        ? ab.pool.filter(id => CARDS[id])
        : match.decks[side].slice();
      if (!poolIds.length) { push(match, { t: match.turn, kind: 'discover-miss', side }); return; }
      const r = rng(match);
      const candidates = [];
      const work = poolIds.slice();
      for (let i = 0; i < 3 && work.length; i++) {
        candidates.push(work.splice(Math.floor(r() * work.length), 1)[0]);
      }
      let choice = Number(ctx.action?.discoverChoice);
      if (!Number.isInteger(choice) || choice < 0 || choice >= candidates.length) choice = 0;
      const cardId = candidates[choice];
      if (match.hands[side].length < HAND_CAP) {
        match.hands[side].push(cardId);
        push(match, { t: match.turn, kind: 'discover', side, cardId, candidates });
      } else {
        push(match, { t: match.turn, kind: 'discover-burn', side, cardId });
      }
      return;
    }
    default:
      // Unknown effect — log and continue. Don't crash the resolver on
      // a new ability key being added without a handler.
      push(match, { t: match.turn, kind: 'unknown-effect', eff });
  }
}

// ── Target resolution ────────────────────────────────────────────────

function resolveTargets(match, side, ab, ctx) {
  const opp = side === 'A' ? 'B' : 'A';
  const out = [];
  switch (ab.target) {
    case 'oppHero':              out.push({ kind: 'hero', side: opp }); break;
    case 'selfHero':             out.push({ kind: 'hero', side });      break;
    case 'allEnemyMinions':      for (const m of match.board[opp]) if (m.hp > 0) out.push({ kind: 'minion', minion: m, side: opp }); break;
    case 'allEnemy': case 'allEnemies': // all enemy minions PLUS the enemy hero.
                                 for (const m of match.board[opp]) if (m.hp > 0) out.push({ kind: 'minion', minion: m, side: opp });
                                 out.push({ kind: 'hero', side: opp });
                                 break;
    case 'allFriendlyMinions':   for (const m of match.board[side]) if (m.hp > 0) out.push({ kind: 'minion', minion: m, side });    break;
    case 'allFriendlyTribe':     // tribal synergy — friendly minions of ab.tribe
                                 for (const m of match.board[side]) {
                                   if (m.hp <= 0) continue;
                                   const c = CARDS[m.cardId];
                                   if (c && c.tribe === ab.tribe) out.push({ kind: 'minion', minion: m, side });
                                 }
                                 break;
    case 'allMinions':           for (const m of match.board.A) if (m.hp > 0) out.push({ kind: 'minion', minion: m, side: 'A' });
                                 for (const m of match.board.B) if (m.hp > 0) out.push({ kind: 'minion', minion: m, side: 'B' });
                                 break;
    case 'allOtherMinions': {
      const src = ctx.source?.kind === 'minion' ? ctx.source.uid : null;
      for (const s of ['A', 'B']) for (const m of match.board[s]) if (m.hp > 0 && m.uid !== src) out.push({ kind: 'minion', minion: m, side: s });
      break;
    }
    case 'randomEnemyMinion': {
      const live = match.board[opp].filter(m => m.hp > 0);
      if (live.length) {
        const idx = Math.floor(rng(match)() * live.length);
        out.push({ kind: 'minion', minion: live[idx], side: opp });
      }
      break;
    }
    case 'randomFriendlyMinion': {
      const live = match.board[side].filter(m => m.hp > 0 && m.uid !== ctx.source?.uid);
      if (live.length) {
        const idx = Math.floor(rng(match)() * live.length);
        out.push({ kind: 'minion', minion: live[idx], side });
      }
      break;
    }
    case 'pickedTarget': {
      // The action carries `targetUid` — a minion uid, or 'oppHero' / 'selfHero'.
      const tu = ctx.pickedTargetUid;
      if (tu === 'oppHero')  out.push({ kind: 'hero', side: opp });
      else if (tu === 'selfHero') out.push({ kind: 'hero', side });
      else if (tu) {
        // Search both sides for the minion uid.
        for (const s of ['A', 'B']) {
          const m = findMinion(match, s, tu);
          if (m) { out.push({ kind: 'minion', minion: m, side: s }); break; }
        }
      }
      break;
    }
    case 'lastDeadFriendly':     /* handled inline in returnToHand */ break;
    case 'self':                 /* handled inline in returnToHand */ break;
    case 'oppHand':              out.push({ kind: 'oppHand', side: opp }); break;
    case 'selfHand':             out.push({ kind: 'selfHand', side });     break;
    default: /* no target */ break;
  }
  // Spell-Immune: a minion with this keyword cannot be targeted by an
  // effect cast by its OPPONENT (enemy spells/abilities). Friendly buffs
  // still land, and combat is unaffected (combat does not route here).
  return out.filter(t => !(t.kind === 'minion' && t.side !== side
                           && (t.minion.keywords || []).includes('spell-immune')));
}

// ── Helpers ──────────────────────────────────────────────────────────

function makeBoardMinion(match, card, side) {
  const uid = 'm' + (match.boardUidCounter++);
  const m = {
    uid,
    cardId: card.id,
    atk: card.atk || 0,
    hp:  card.hp  || 0,
    maxHp: card.hp || 0,
    keywords: (card.keywords || []).slice(),
    status: [],
    canAttack: false,
    exhausted: !((card.keywords || []).includes('charge')),
  };
  if ((card.keywords || []).includes('charge')) m.canAttack = true;
  // Rush: can attack the turn it's played, but minions only — not the
  // enemy hero. The 'rush-fresh' status enforces the no-hero window and
  // is cleared at the owner's next start-of-turn.
  if ((card.keywords || []).includes('rush')) { m.canAttack = true; m.exhausted = false; m.status.push('rush-fresh'); }
  if ((card.keywords || []).includes('shield')) m.status.push('shield');
  if ((card.keywords || []).includes('stealth')) m.status.push('stealth-fresh');
  // Voltaic Mage 'spellDamageBonus' is keyed off ability with effect:'buff' trigger:'spellDamageBonus'
  // — stored on the minion record so the spell-cast path can fold it in.
  const sda = (card.abilities || []).find(a => a.trigger === 'spellDamageBonus');
  if (sda) m.spellDamageBonus = sda.value || 1;
  // Hollow King gate
  if ((card.keywords || []).includes('cannot-attack-unless-3-spells')) {
    m.hollowKing = true;
  }
  return m;
}

function findMinion(match, side, uid) {
  return match.board[side].find(m => m.uid === uid) || null;
}

function hasTaunt(match, side) {
  return match.board[side].some(m => (m.keywords || []).includes('taunt') && m.hp > 0);
}

function push(match, evt) {
  if (!Array.isArray(match.log)) match.log = [];
  match.log.push(evt);
  // Cap log so KV stays small; 400 entries is plenty for a 20-turn match.
  if (match.log.length > 400) match.log.shift();
}

// ── Public: legality check (UI helper) ───────────────────────────────

export function isLegalAction(match, action) {
  if (match.status !== 'active' && action.kind !== 'concede') return { ok: false, reason: 'match-not-active' };
  if (action.kind === 'concede') return { ok: true };
  if (action.side !== match.active) return { ok: false, reason: 'not-your-turn' };
  if (action.kind === 'endTurn') return { ok: true };
  if (action.kind === 'playCard') {
    const idx = +action.handIdx;
    if (!Number.isInteger(idx) || idx < 0 || idx >= match.hands[action.side].length) return { ok: false, reason: 'no-such-card' };
    const cardId = match.hands[action.side][idx];
    const card = CARDS[cardId];
    if (!card) return { ok: false, reason: 'unknown-card' };
    if (match.mana[action.side].cur < (card.mana || 0)) return { ok: false, reason: 'insufficient-mana' };
    return { ok: true };
  }
  if (action.kind === 'attack') {
    const attacker = findMinion(match, action.side, action.attackerUid);
    if (!attacker || attacker.hp <= 0) return { ok: false, reason: 'no-attacker' };
    if (!attacker.canAttack) return { ok: false, reason: 'attacker-exhausted' };
    if ((attacker.status || []).includes('frozen')) return { ok: false, reason: 'frozen' };
    // Hollow King: spells-cast >= 3 required.
    if (attacker.hollowKing && (match.spellsCast[action.side] || 0) < 3) {
      return { ok: false, reason: 'hollow-king-gated' };
    }
    const opp = action.side === 'A' ? 'B' : 'A';
    if (action.defenderUid === 'hero') {
      if ((attacker.status || []).includes('rush-fresh')) return { ok: false, reason: 'rush-no-hero' };
      if (!(attacker.keywords || []).includes('reach') && hasTaunt(match, opp)) {
        return { ok: false, reason: 'taunt-blocks' };
      }
      return { ok: true };
    }
    const defender = findMinion(match, opp, action.defenderUid);
    if (!defender || defender.hp <= 0) return { ok: false, reason: 'no-defender' };
    if ((defender.status || []).some(s => s === 'stealth' || s === 'stealth-fresh')) return { ok: false, reason: 'stealth-blocks' };
    if (hasTaunt(match, opp) && !(defender.keywords || []).includes('taunt')) return { ok: false, reason: 'must-target-taunt' };
    return { ok: true };
  }
  return { ok: false, reason: 'unknown-action' };
}

// ── Public: receipt-shape projection for the match log ───────────────

export function summariseMatch(match) {
  return {
    matchId: match.matchId,
    status: match.status,
    players: { ...match.players },
    npc: match.npc ? { archetype: match.npc.archetype } : null,
    hp: { ...match.hp },
    turn: match.turn,
    endedAt: Date.now(),
    log: match.log.slice(-60),    // keep the last 60 events for /log replay
  };
}

// ── Convenience: re-export STARTING_HP for the orchestrator ──────────

export { STARTING_HP, HAND_CAP };
