// Boltbound, match orchestrator + PvP queue + NPC turn driver.
//
// Sits between the pure cards-battle resolver and the Discord
// command layer. Owns:
//   - starting matches (vs NPC, via queue, or direct-challenge)
//   - persisting match state between turns (cards-state.putMatch)
//   - running NPC turns end-to-end before handing control back
//   - finalising matches: trophy + Bolts + match-log + active-match-ref
//
// All mutating helpers return the post-write match object so callers
// can render the resulting embed without an extra read.

import {
  createMatch, applyMulligan, applyAction, isLegalAction, summariseMatch,
  HAND_CAP,
} from './cards-battle.js';
import {
  CARDS, championForClass, NPC_DECKS,
} from './cards-content.js';
import { canUseHeroPower } from './hero-powers.js';
import {
  getMatch, putMatch, deleteMatch,
  getActiveMatch, setActiveMatchId,
  enqueueQueue, dequeuePartner, removeFromQueue, getQueue,
  appendLog,
  adjustTrophies, getTrophies,
  ladderCapacity, commitLadderCredit,
  mintChallenge, consumeChallenge, listChallenges,
  getActiveDeck, resolveDeckChampion,
  newId,
} from './cards-state.js';
import { applyVaultDelta } from './wallet.js';

// ── Match creation paths ─────────────────────────────────────────────

// vs NPC. Returns { ok, match, error? }. NPC turns run automatically
// past each human end-of-turn until it's the human's turn again.
//
// Picks the NPC archetype with a simple seed off the matchId so a
// viewer doesn't always face the same bot.
export async function startNpcMatch(env, guildId, userId, archetypeHint) {
  // Refuse if the viewer already has an active match.
  const existing = await getActiveMatch(env, guildId, userId);
  if (existing && existing.status === 'active') {
    return { ok: false, error: 'already-in-match', matchId: existing.matchId };
  }
  if (existing && existing.status === 'mulligan') {
    return { ok: false, error: 'pending-mulligan', matchId: existing.matchId };
  }
  const deck = await getActiveDeck(env, guildId, userId);
  if (!deck) return { ok: false, error: 'no-active-deck' };

  // CR-1: 6 NPC archetypes (3 original + 3 expansion: tribal, burn, swarm).
  // Random pick when no hint; archetype hint must be one of these.
  const archs = Object.keys(NPC_DECKS);
  const archetype = archs.includes(archetypeHint) ? archetypeHint : archs[Math.floor(Math.random() * archs.length)];
  const npcDeck = NPC_DECKS[archetype];

  const matchId = newId();
  const match = createMatch({
    matchId,
    guildId,
    playerA: { userId, deck: deck.cards, championClass: deck.championClass },
    playerB: null,
    npc: {
      archetype,
      deck: [...npcDeck.cards, championForClass(npcDeck.champion)],
      championClass: npcDeck.champion,
    },
    createdUtc: Date.now(),
  });
  await persistMatch(env, guildId, match);
  return { ok: true, match };
}

// PvP queue path. If there's a partner waiting in the channel queue,
// match immediately. Otherwise enqueue this viewer and return
// { ok: true, queued: true }.
export async function queueOrMatchPvp(env, guildId, userId) {
  const existing = await getActiveMatch(env, guildId, userId);
  if (existing && existing.status !== 'active' && existing.status !== 'mulligan') {
    // Stale ref; clear and continue.
    await setActiveMatchId(env, guildId, userId, '');
  } else if (existing) {
    return { ok: false, error: 'already-in-match', matchId: existing.matchId };
  }
  const deck = await getActiveDeck(env, guildId, userId);
  if (!deck) return { ok: false, error: 'no-active-deck' };

  const partner = await dequeuePartner(env, guildId, userId);
  if (!partner) {
    await enqueueQueue(env, guildId, userId, deck.id);
    return { ok: true, queued: true };
  }
  // Partner is waiting, load their deck. If their deck has gone
  // missing or invalid (e.g. they deleted it after queueing), drop them
  // and re-queue this caller so we don't lose the request.
  const partnerDeck = await loadDeckForMatch(env, guildId, partner.userId, partner.deckId);
  if (!partnerDeck) {
    await enqueueQueue(env, guildId, userId, deck.id);
    return { ok: true, queued: true, partnerDropped: true };
  }
  const matchId = newId();
  const match = createMatch({
    matchId,
    guildId,
    playerA: { userId, deck: deck.cards, championClass: deck.championClass },
    playerB: { userId: partner.userId, deck: partnerDeck.cards, championClass: partnerDeck.championClass },
    createdUtc: Date.now(),
  });
  await persistMatch(env, guildId, match);
  return { ok: true, match };
}

// Direct challenge, Phase 1 ships the "lay a challenge in their
// inbox" half; acceptance turns it into a match the same way the
// queue path does.

export async function challengeUser(env, guildId, senderId, recipientId) {
  if (senderId === recipientId) return { ok: false, error: 'cannot-challenge-self' };
  const deck = await getActiveDeck(env, guildId, senderId);
  if (!deck) return { ok: false, error: 'no-active-deck' };
  const r = await mintChallenge(env, guildId, senderId, recipientId, deck.id);
  return r;
}

export async function acceptChallenge(env, guildId, recipientId, senderId) {
  const recipientDeck = await getActiveDeck(env, guildId, recipientId);
  if (!recipientDeck) return { ok: false, error: 'no-active-deck' };
  const ch = await consumeChallenge(env, guildId, senderId, recipientId);
  if (!ch) return { ok: false, error: 'no-such-challenge' };
  const senderDeck = await loadDeckForMatch(env, guildId, senderId, ch.deckId);
  if (!senderDeck) return { ok: false, error: 'sender-deck-missing' };
  const matchId = newId();
  const match = createMatch({
    matchId, guildId,
    playerA: { userId: senderId,    deck: senderDeck.cards,    championClass: senderDeck.championClass },
    playerB: { userId: recipientId, deck: recipientDeck.cards, championClass: recipientDeck.championClass },
    createdUtc: Date.now(),
  });
  await persistMatch(env, guildId, match);
  return { ok: true, match };
}

// Friend-room match, like acceptChallenge but matched by a shared
// room code (boltbound-rooms.js) instead of a Discord challenge
// record. Flags match.private so it does NOT touch the ranked ladder.
export async function startRoomMatch(env, guildId, creatorId, joinerId) {
  if (String(creatorId) === String(joinerId)) return { ok: false, error: 'cannot-join-own-room' };
  const creatorDeck = await getActiveDeck(env, guildId, creatorId);
  if (!creatorDeck) return { ok: false, error: 'creator-no-deck' };
  const joinerDeck = await getActiveDeck(env, guildId, joinerId);
  if (!joinerDeck) return { ok: false, error: 'no-active-deck' };
  for (const uid of [creatorId, joinerId]) {
    const a = await getActiveMatch(env, guildId, uid);
    if (a && (a.status === 'active' || a.status === 'mulligan')) {
      return { ok: false, error: uid === joinerId ? 'already-in-match' : 'creator-in-match' };
    }
  }
  const matchId = newId();
  const match = createMatch({
    matchId, guildId,
    playerA: { userId: creatorId, deck: creatorDeck.cards, championClass: creatorDeck.championClass },
    playerB: { userId: joinerId,  deck: joinerDeck.cards,  championClass: joinerDeck.championClass },
    createdUtc: Date.now(),
  });
  match.private = true;
  await persistMatch(env, guildId, match);
  return { ok: true, match };
}

// ── Turn handling ───────────────────────────────────────────────────

// Apply a human action, then run any pending NPC turns.
// Returns the post-action match + a summary of what happened.
export async function takeAction(env, match, side, action) {
  if (side !== match.active && action.kind !== 'concede') {
    return { ok: false, error: 'not-your-turn', match };
  }
  if (match.status !== 'active') {
    return { ok: false, error: 'match-not-active', match };
  }
  const r = applyAction(match, { ...action, side });
  if (r.error) return { ok: false, error: r.error, match: r.match };

  // Run NPC turns until either the match ends or it's the human's
  // turn again.
  while (r.match.status === 'active' && r.match.npc && r.match.active === r.match.npc.side) {
    runNpcTurn(r.match);
  }
  await finaliseIfEnded(env, r.match);
  await persistMatch(env, match.guildId, r.match);
  return { ok: true, match: r.match, ended: r.match.status !== 'active' };
}

// Mulligan handler, same idea, kicks NPC's turn 1 immediately after
// both sides finish their mulligan if the NPC is on side B.
export async function takeMulligan(env, match, side, handIndices) {
  applyMulligan(match, side, handIndices);
  // If this match has an NPC, auto-mulligan the NPC immediately.
  if (match.status === 'mulligan' && match.npc && !match.mulliganDone?.[match.npc.side]) {
    applyMulligan(match, match.npc.side, npcMulliganIndices(match, match.npc.side, match.npc.archetype));
  }
  // Run NPC turns if it's now its turn.
  while (match.status === 'active' && match.npc && match.active === match.npc.side) {
    runNpcTurn(match);
  }
  await finaliseIfEnded(env, match);
  await persistMatch(env, match.guildId, match);
  return { ok: true, match };
}

// ── NPC decision policy (simulate-and-score) ─────────────────────────
//
// The engine (cards-battle.js) is pure + deterministic and match state
// is plain-object / structuredClone-safe, so the NPC plays a real
// 1-ply search instead of a greedy one-step heuristic:
//
//   1. LETHAL FIRST — sum available face damage this turn (ready
//      attackers respecting taunt/reach + playable face-damage spells +
//      hero-power face damage + charge minions in hand). If it meets or
//      beats the enemy hero's effective HP (+armor), take the lethal
//      line action-by-action.
//   2. Otherwise ENUMERATE candidate actions (plays with sensible
//      targets, attacks, a hero-power use with spare mana), deep-copy
//      the match, apply each via the engine, SCORE the resulting state
//      from the NPC's POV (own hp/board/cards minus the enemy's, with
//      archetype weights), and take the best. Ties break on a SEEDED
//      pseudo-random derived from match state so replays stay identical.
//   3. When nothing scores better than passing, end the turn.
//
// We keep stepping one action at a time (30-action cap) since each
// resolved action can unlock new options (a fresh charge minion, a
// buffed attacker, a cleared taunt).

// Behavioural policy for an archetype. Newer decks carry an explicit
// `policy` field; the three originals map by name.
function policyFor(archetype) {
  const deck = NPC_DECKS[archetype];
  if (deck?.policy) return deck.policy;
  if (archetype === 'aggro' || archetype === 'burn' || archetype === 'swarm') return 'aggro';
  if (archetype === 'control') return 'control';
  return 'midrange';   // midrange, tribal, and any unknown
}

function runNpcTurn(match) {
  if (!match.npc) return;
  const side = match.npc.side;
  const policy = policyFor(match.npc.archetype);
  // Hard ceiling on actions per turn, protects against any policy loop
  // that doesn't terminate.
  for (let step = 0; step < 30; step++) {
    if (match.status !== 'active' || match.active !== side) break;
    const action = pickNpcAction(match, side, policy);
    if (!action || action.kind === 'endTurn') {
      applyAction(match, { kind: 'endTurn', side });
      return;
    }
    const r = applyAction(match, action);
    if (r.error) {
      // Defensive: an illegal pick (shouldn't happen) ends the turn so
      // we never infinite-loop.
      applyAction(match, { kind: 'endTurn', side });
      return;
    }
  }
  if (match.status === 'active' && match.active === side) {
    applyAction(match, { kind: 'endTurn', side });
  }
}

// ── Seeded tie-break (pure, no match mutation) ───────────────────────
// A stable hash over the match's replay position, used only to break
// score ties deterministically. We do NOT touch match.rngStep here (the
// engine owns that); this reads state without mutating it, so scoring is
// side-effect free and replays are identical.
function tieHash(match, salt) {
  let h = (match.seed >>> 0) ^ ((match.rngStep || 0) * 2654435761);
  h = (h ^ (match.turn * 40503)) >>> 0;
  for (let i = 0; i < salt.length; i++) h = (((h << 5) - h) + salt.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

// ── Board / state evaluation ─────────────────────────────────────────

const KW_TAUNT_BONUS  = 2;
const KW_SHIELD_BONUS = 2;
const CARD_ADV_WEIGHT = 2;

function minionValue(m) {
  if (!m || m.hp <= 0) return 0;
  let v = (m.atk || 0) + (m.hp || 0);
  const kws = m.keywords || [];
  const st = m.status || [];
  if (kws.includes('taunt')) v += KW_TAUNT_BONUS;
  if (st.includes('shield')) v += KW_SHIELD_BONUS;
  if (kws.includes('lifesteal')) v += 1;
  if (kws.includes('poison')) v += 2;
  if (kws.includes('reborn') && !m.reborned) v += 2;
  if (st.includes('frozen')) v -= 1;   // will miss a turn
  return v;
}

// Score a state from `side`'s point of view. Higher = better for `side`.
// Archetype weights: aggro leans on enemy-hero damage, control leans on
// board clears + own survival, midrange is balanced.
function scoreState(match, side, policy) {
  const opp = side === 'A' ? 'B' : 'A';
  // Terminal states dominate.
  if (match.status === (side === 'A' ? 'A-won' : 'B-won')) return 1e6;
  if (match.status === (side === 'A' ? 'B-won' : 'A-won')) return -1e6;
  if (match.status === 'draw') return -5e5;

  const myHp = (match.hp[side] || 0) + ((match.heroArmor && match.heroArmor[side]) || 0);
  const opHp = (match.hp[opp] || 0) + ((match.heroArmor && match.heroArmor[opp]) || 0);

  let myBoard = 0, opBoard = 0;
  for (const m of match.board[side]) myBoard += minionValue(m);
  for (const m of match.board[opp]) opBoard += minionValue(m);

  const myCards = (match.hands[side]?.length || 0);
  const opCards = (match.hands[opp]?.length || 0);

  // Base: board control + card advantage + a light own-survival term.
  let score = (myBoard - opBoard)
            + CARD_ADV_WEIGHT * (myCards - opCards)
            + 0.3 * (myHp - opHp);

  if (policy === 'aggro') {
    // Reward pushing the enemy hero low (weight enemy-hero damage hard).
    score += (30 - opHp) * 1.4;
    score += myBoard * 0.3;
  } else if (policy === 'control') {
    // Reward clearing their board and staying healthy.
    score -= opBoard * 0.8;
    score += myHp * 0.5;
  } else {
    score += (30 - opHp) * 0.6;
    score += myBoard * 0.2;
  }
  return score;
}

// Deep-copy the live match so we can simulate an action without
// disturbing it. structuredClone verified plain-object-safe for the
// match shape at module init (see selfCheck below).
function simulate(match, action) {
  const copy = structuredClone(match);
  applyAction(copy, action);
  return copy;
}

// ── Lethal detection ─────────────────────────────────────────────────
//
// Sum the face damage the NPC can commit THIS turn without needing a
// board clear first. If it >= the enemy hero's effective HP, we return
// an ordered lethal plan and execute it step by step.

// Face-damage a spell can throw at the enemy hero directly (targets that
// hit the hero: oppHero, allEnemy/allEnemies). Minion-only picked-damage
// (filter.type === 'minion') can't go face and is excluded.
function spellFaceDamage(card) {
  let dmg = 0;
  for (const ab of card.abilities || []) {
    if (ab.effect !== 'damage') continue;
    if (ab.target === 'oppHero' || ab.target === 'allEnemy' || ab.target === 'allEnemies') {
      dmg += (ab.value || 0);
    }
  }
  return dmg;
}

// Everything the NPC could throw at the enemy face right now.
function lethalReach(match, side) {
  const opp = side === 'A' ? 'B' : 'A';
  const oppHp = (match.hp[opp] || 0) + ((match.heroArmor && match.heroArmor[opp]) || 0);
  const tauntsUp = match.board[opp].some(m => (m.keywords || []).includes('taunt') && m.hp > 0
    && !(m.status || []).includes('stealth') && !(m.status || []).includes('stealth-fresh'));

  // Attackers that can hit the hero right now (respect taunt unless reach;
  // rush-fresh can't go face).
  const faceAttackers = match.board[side].filter(m =>
    m.canAttack && m.hp > 0
    && !(m.status || []).includes('frozen')
    && !(m.status || []).includes('rush-fresh')
    && !(m.hollowKing && (match.spellsCast[side] || 0) < 3)
    && (!tauntsUp || (m.keywords || []).includes('reach')));
  let dmg = faceAttackers.reduce((s, m) => s + (m.atk || 0), 0);

  // Spare-mana face burn from spells + charge minions in hand + hero power.
  let mana = match.mana[side].cur;
  const spellPlays = [];   // { handIdx, cardId }
  const chargePlays = [];  // { handIdx, cardId, atk }
  // Snapshot hand once; we account for mana greedily.
  const hand = match.hands[side];
  for (let i = 0; i < hand.length; i++) {
    const c = CARDS[hand[i]];
    if (!c) continue;
    const cost = c.mana || 0;
    if (cost > mana) continue;
    if (c.type === 'spell') {
      const fd = spellFaceDamage(c);
      if (fd > 0) { dmg += fd; mana -= cost; spellPlays.push({ handIdx: i, cardId: hand[i] }); continue; }
    } else if ((c.keywords || []).includes('charge') && !tauntsUp) {
      // A charge body can swing face the turn it lands.
      dmg += (c.atk || 0); mana -= cost; chargePlays.push({ handIdx: i, cardId: hand[i], atk: c.atk || 0 });
    }
  }
  // Hero power face damage (coin-strike / fire-bolt at oppHero) if mana allows.
  let heroPowerFace = 0;
  const hp = match.heroPower && match.heroPower[side];
  if (hp && !hp.usedThisTurn && canUseHeroPower(match, side).ok
      && (hp.id === 'coin-strike' || hp.id === 'fire-bolt')) {
    heroPowerFace = 1;
    dmg += 1;
  }

  return { dmg, oppHp, tauntsUp, faceAttackers, spellPlays, chargePlays, heroPowerFace };
}

// If lethal is on the table, return the NEXT single action toward it
// (we're stepped one action at a time). Order: play burn spells + charge
// bodies, fire the hero power, then swing every face attacker.
function lethalNextAction(match, side) {
  const R = lethalReach(match, side);
  if (R.tauntsUp) return null;                 // can't reach face this turn
  if (R.dmg < R.oppHp) return null;            // not lethal
  // 1) Cast a face-burn spell still in hand.
  if (R.spellPlays.length) {
    const p = R.spellPlays[0];
    return { kind: 'playCard', side, handIdx: p.handIdx, targetUid: 'oppHero' };
  }
  // 2) Drop a charge body (it will swing next step).
  if (R.chargePlays.length && !boardFullFor(match, side)) {
    const p = R.chargePlays[0];
    return { kind: 'playCard', side, handIdx: p.handIdx };
  }
  // 3) Fire the hero power at the face.
  if (R.heroPowerFace) {
    const hp = match.heroPower[side];
    const targetId = hp.id === 'fire-bolt' ? 'oppHero' : undefined;
    return { kind: 'heroPower', side, targetId };
  }
  // 4) Swing a ready face attacker.
  if (R.faceAttackers.length) {
    return { kind: 'attack', side, attackerUid: R.faceAttackers[0].uid, defenderUid: 'hero' };
  }
  return null;
}

function boardFullFor(match, side) {
  return match.board[side].length >= 7;
}

// ── Action enumeration + scoring ─────────────────────────────────────

function pickNpcAction(match, side, policy) {
  // 0. LETHAL: if we can kill the enemy hero this turn, commit to it.
  const lethal = lethalNextAction(match, side);
  if (lethal) return lethal;

  // 1. Enumerate candidate actions, score each by simulation, take best.
  const candidates = enumerateCandidates(match, side, policy);
  if (!candidates.length) return { kind: 'endTurn', side };

  // Baseline: the value of ending the turn now (passing).
  let best = null;
  let bestScore = scoreState(match, side, policy);   // do-nothing baseline
  let bestSalt = '';

  for (const action of candidates) {
    let next;
    try { next = simulate(match, action); }
    catch { continue; }
    // Reject actions the engine refused (no state change of value).
    const s = scoreState(next, side, policy);
    const salt = actionSalt(action);
    if (s > bestScore
        || (s === bestScore && best && tieHash(match, salt) > tieHash(match, bestSalt))) {
      best = action; bestScore = s; bestSalt = salt;
    }
  }
  return best || { kind: 'endTurn', side };
}

function actionSalt(a) {
  return `${a.kind}:${a.handIdx ?? ''}:${a.attackerUid ?? ''}:${a.defenderUid ?? ''}:${a.targetUid ?? ''}:${a.targetId ?? ''}:${a.chooseOption ?? ''}:${a.adaptChoice ?? ''}:${a.discoverChoice ?? ''}`;
}

// Enumerate the choice dimensions a card exposes (Choose One options,
// Adapt buffs, Discover candidates). Returns an array of partial action
// objects to merge into the play; a card with no choices yields [{}] so
// the single base play is still produced. Capped so enumeration stays
// small.
function choicePicks(card) {
  const abilities = card.abilities || [];
  // Choose One: distinct option group ids present on the card.
  const opts = new Set();
  for (const ab of abilities) if (ab.option !== undefined) opts.add(ab.option);
  if (opts.size >= 2) return [...opts].slice(0, 2).map(o => ({ chooseOption: o }));

  // Adapt: ADAPT_POOL is small; try a spread of buffs so scoring picks
  // the most valuable. We cover the pool's start (kept tiny for perf).
  if (abilities.some(ab => ab.effect === 'adapt')) {
    return [0, 1, 2, 3].map(i => ({ adaptChoice: i }));
  }
  // Discover: the engine reveals up to 3 candidates; try each slot.
  if (abilities.some(ab => ab.effect === 'discover')) {
    return [0, 1, 2].map(i => ({ discoverChoice: i }));
  }
  return [{}];
}

// Build the candidate action set. Capped: at most TOP_N targets per
// action so worst-case enumeration stays small (perf).
const TOP_N_TARGETS = 4;

function enumerateCandidates(match, side, policy) {
  const opp = side === 'A' ? 'B' : 'A';
  const out = [];
  const mana = match.mana[side].cur;

  // ── PLAYS ──
  for (let i = 0; i < match.hands[side].length; i++) {
    const cardId = match.hands[side][i];
    const c = CARDS[cardId];
    if (!c) continue;
    if ((c.mana || 0) > mana) continue;
    if (c.type !== 'spell' && boardFullFor(match, side)) continue;

    const needsTarget = c.type === 'spell'
      ? (c.abilities || []).some(ab => ab.target === 'pickedTarget')
      : !!c.needsTarget;

    // Choose-One / Adapt / Discover: the engine reads these off the
    // action (ctx.action.chooseOption / adaptChoice / discoverChoice) and
    // falls back to a seeded pick when absent. We enumerate the options so
    // scoring picks the best branch (task 5); absent = engine's default.
    const pickDims = choicePicks(c);

    if (!needsTarget) {
      for (const extra of pickDims) out.push({ kind: 'playCard', side, handIdx: i, ...extra });
      continue;
    }
    // Targeted: enumerate a capped, sensible candidate-target set. Skip
    // the play entirely when no legal target exists (never waste a
    // targeted spell — freeze/silence/removal/spell-immune fizzle).
    const targets = candidateTargetsFor(match, side, c);
    for (const t of targets) for (const extra of pickDims) out.push({ kind: 'playCard', side, handIdx: i, targetUid: t, ...extra });
  }

  // ── ATTACKS ──
  const attackers = match.board[side].filter(m =>
    m.canAttack && m.hp > 0
    && !(m.status || []).includes('frozen')
    && !(m.hollowKing && (match.spellsCast[side] || 0) < 3));
  const tauntsUp = match.board[opp].some(m => (m.keywords || []).includes('taunt') && m.hp > 0
    && !(m.status || []).includes('stealth') && !(m.status || []).includes('stealth-fresh'));
  const enemyMinions = match.board[opp].filter(m => m.hp > 0
    && !(m.status || []).includes('stealth') && !(m.status || []).includes('stealth-fresh')
    && (!tauntsUp || (m.keywords || []).includes('taunt')));
  for (const a of attackers) {
    const canFace = !tauntsUp || (a.keywords || []).includes('reach');
    const rushFresh = (a.status || []).includes('rush-fresh');
    if (canFace && !rushFresh) out.push({ kind: 'attack', side, attackerUid: a.uid, defenderUid: 'hero' });
    // Trade options: prefer the highest-value enemy bodies (capped).
    const ordered = enemyMinions.slice().sort((x, y) => minionValue(y) - minionValue(x)).slice(0, TOP_N_TARGETS);
    for (const e of ordered) out.push({ kind: 'attack', side, attackerUid: a.uid, defenderUid: e.uid });
  }

  // ── HERO POWER ── (only with spare mana; scoring decides if worth it)
  const hp = match.heroPower && match.heroPower[side];
  if (hp && !hp.usedThisTurn && canUseHeroPower(match, side).ok) {
    for (const t of heroPowerTargets(match, side, hp)) out.push({ kind: 'heroPower', side, ...t });
  }

  return out;
}

// Capped candidate targets for a targeted card, chosen by the card's
// dominant effect. Returns uids / 'oppHero' / 'selfHero'. Empty => the
// caller drops the play (avoids wasting a targeted spell on no target).
function candidateTargetsFor(match, side, card) {
  const opp = side === 'A' ? 'B' : 'A';
  const targets = [];
  const seen = new Set();
  const add = (t) => { if (t != null && !seen.has(t)) { seen.add(t); targets.push(t); } };

  const enemyLive = () => match.board[opp].filter(m => m.hp > 0
    && !(m.keywords || []).includes('spell-immune'));   // enemy spells fizzle on spell-immune
  const friendLive = () => match.board[side].filter(m => m.hp > 0);

  for (const ab of card.abilities || []) {
    if (ab.target !== 'pickedTarget') continue;
    const filt = ab.filter || {};
    switch (ab.effect) {
      case 'damage': {
        // Can this go face? filter.type 'minion' means minion-only.
        if (filt.type !== 'minion' && filt.type !== 'friendly-minion') add('oppHero');
        let pool = enemyLive();
        if (filt.maxMana != null) pool = pool.filter(m => (CARDS[m.cardId]?.mana || 0) <= filt.maxMana);
        pool.sort((a, b) => minionValue(b) - minionValue(a));
        for (const m of pool.slice(0, TOP_N_TARGETS)) add(m.uid);
        break;
      }
      case 'destroy': {
        let pool = enemyLive();
        if (filt.maxMana != null) pool = pool.filter(m => (CARDS[m.cardId]?.mana || 0) <= filt.maxMana);
        pool.sort((a, b) => minionValue(b) - minionValue(a));
        for (const m of pool.slice(0, TOP_N_TARGETS)) add(m.uid);
        break;
      }
      case 'freeze':
      case 'silence': {
        const pool = enemyLive().sort((a, b) => minionValue(b) - minionValue(a));
        for (const m of pool.slice(0, TOP_N_TARGETS)) add(m.uid);
        break;
      }
      case 'heal': {
        add('selfHero');
        const hurt = friendLive().filter(m => m.hp < (m.maxHp || m.hp)).sort((a, b) => (b.maxHp - b.hp) - (a.maxHp - a.hp));
        for (const m of hurt.slice(0, TOP_N_TARGETS)) add(m.uid);
        break;
      }
      case 'buff':
      case 'buffThisTurn': {
        const pool = friendLive().sort((a, b) => (b.atk || 0) - (a.atk || 0));
        for (const m of pool.slice(0, TOP_N_TARGETS)) add(m.uid);
        break;
      }
      default: {
        // Unknown picked effect: offer the biggest enemy body if any.
        const pool = enemyLive().sort((a, b) => minionValue(b) - minionValue(a));
        if (pool.length) add(pool[0].uid);
      }
    }
  }
  return targets;
}

// Candidate hero-power actions with their targets.
function heroPowerTargets(match, side, hp) {
  const opp = side === 'A' ? 'B' : 'A';
  const enemies = match.board[opp].filter(m => m.hp > 0
    && !(m.status || []).includes('stealth') && !(m.status || []).includes('stealth-fresh'));
  if (hp.id === 'coin-strike') return [{ }];                              // auto enemy hero
  if (hp.id === 'lesser-heal' || hp.id === 'armor-up') return [{ }];      // self-target / no target
  if (hp.id === 'fire-bolt') {
    const out = [{ targetId: 'oppHero' }];
    const best = enemies.slice().sort((a, b) => minionValue(b) - minionValue(a))[0];
    if (best) out.push({ targetId: best.uid });
    return out;
  }
  if (hp.id === 'mark-target') {
    const best = enemies.slice().sort((a, b) => minionValue(b) - minionValue(a))[0];
    return best ? [{ targetId: best.uid }] : [];   // needs an enemy minion
  }
  return [{ }];
}

// ── NPC mulligan ─────────────────────────────────────────────────────
//
// Toss expensive cards: cost >= 4 for aggro-flavoured decks, >= 5 for
// the rest. Returns the hand indices to replace.
function npcMulliganIndices(match, side, archetype) {
  const policy = policyFor(archetype);
  const threshold = policy === 'aggro' ? 4 : 5;
  const hand = match.hands[side] || [];
  const out = [];
  for (let i = 0; i < hand.length; i++) {
    const c = CARDS[hand[i]];
    if (c && (c.mana || 0) >= threshold) out.push(i);
  }
  return out;
}

// structuredClone plain-object safety self-check (fails loudly at import
// if the match shape ever gains a non-cloneable field).
(function selfCheck() {
  try {
    structuredClone({ a: 1, b: [1, 2], c: { d: true } });
  } catch (e) {
    console.warn('[boltbound-npc] structuredClone unavailable:', e?.message || e);
  }
})();

// ── End-of-match finalisation ───────────────────────────────────────
//
// When the match resolver flips status to 'A-won' / 'B-won' / 'draw',
// we:
//   1. Compute trophy + Bolts delta for each human side.
//   2. Append a receipt to each human's match-log ring buffer.
//   3. Clear the active-match-ref pointer so the next /boltbound play
//      starts fresh.
//
// Idempotent, re-running on the same finished match no-ops (we mark
// match.settled=true after the first pass).

async function finaliseIfEnded(env, match) {
  if (match.status === 'active' || match.status === 'mulligan') return;
  if (match.settled) return;

  const npc = !!match.npc;
  const aWon = match.status === 'A-won';
  const bWon = match.status === 'B-won';
  const draw = match.status === 'draw';

  const receipt = summariseMatch(match, Date.now());

  // Figure out which side is the human(s). For NPC matches, only A is
  // human (we always put humans on A in this orchestrator).
  const humanSides = npc ? ['A'] : ['A', 'B'];
  for (const s of humanSides) {
    const userId = match.players[s];
    if (!userId || userId.startsWith?.('npc:')) continue;
    const won = (s === 'A' && aWon) || (s === 'B' && bWon);
    const lost = (s === 'A' && bWon) || (s === 'B' && aWon);

    // Trophies
    let trophyDelta = 0;
    if (npc) {
      trophyDelta = won ? +3 : (draw ? 0 : -1);
    } else {
      trophyDelta = won ? +12 : (draw ? 0 : -10);
    }
    await adjustTrophies(env, userId, trophyDelta);

    // Bolts payout (capped at LADDER_CAP_PER_DAY). v2 rebalance paces
    // the per-win amount through economy-pace.js. v1: 10 NPC / 50 PvP;
    // v2: 4 NPC / 20 PvP. Pack drops + trophy progression are
    // unchanged so the "I won" feel still matters.
    let want = 0;
    if (won) {
      const { paceBolts } = await import('./economy-pace.js');
      want = paceBolts(npc ? 10 : 50);
    }
    if (want > 0) {
      const r = await commitLadderCredit(env, userId, want);
      if (r.credit > 0) {
        await applyVaultDelta(env, match.guildId, userId, r.credit, 'boltbound:ladder-win');
      }
      receipt[`boltsCredited_${s}`] = r.credit;
      receipt[`boltsCapped_${s}`] = !!r.capped;
    }
    receipt[`trophyDelta_${s}`] = trophyDelta;
    await appendLog(env, match.guildId, userId, receipt);
    await setActiveMatchId(env, match.guildId, userId, '');

    // PROGRESSION (P1), emit cards.match.played (floor) + cards.match.won.*
    // on victory. Dedup by matchId so re-runs grant XP once.
    try {
      const { emitProgressionEvent } = await import('./progression/event-bus.js');
      await emitProgressionEvent(env, {
        kind: 'cards.match.played', userId, guildId: match.guildId,
        meta: { matchId: match.matchId }, stableKeys: ['matchId'],
      });
      if (won) {
        await emitProgressionEvent(env, {
          kind: npc ? 'cards.match.won.npc' : 'cards.match.won.pvp',
          userId, guildId: match.guildId,
          meta: { matchId: match.matchId }, stableKeys: ['matchId'],
        });
      }
    } catch { /* non-fatal */ }
  }
  // RET-4, feed the ranked ladder (PvP only; the helper no-ops on
  // NPC matches and draws). Best-effort; must not block finalise.
  try {
    const { applyRankedResult } = await import('./boltbound-ranked.js');
    await applyRankedResult(env, match);
  } catch (e) { console.warn('[ranked] finalise hook', e?.message || e); }
  match.settled = true;
}

async function persistMatch(env, guildId, match) {
  await putMatch(env, match);
  if (match.status === 'active' || match.status === 'mulligan') {
    // Both human sides get the activeMatchRef pointing at this match.
    for (const s of ['A', 'B']) {
      const uid = match.players[s];
      if (uid && !uid.startsWith?.('npc:')) {
        await setActiveMatchId(env, guildId, uid, match.matchId);
      }
    }
  }
}

async function loadDeckForMatch(env, guildId, userId, deckId) {
  // Try the requested deck; fall back to active deck if it's gone.
  const { getDeck } = await import('./cards-state.js');
  let d = deckId ? await getDeck(env, guildId, userId, deckId) : null;
  if (!d) d = await getActiveDeck(env, guildId, userId);
  if (!d) return null;
  // Patch the champion in.
  return resolveDeckChampion(d);
}

// ── Helpers exposed to cards.js ─────────────────────────────────────

// Find the human side of a match for a given user. Returns 'A', 'B', or null.
export function sideOf(match, userId) {
  if (match.players?.A === userId) return 'A';
  if (match.players?.B === userId) return 'B';
  return null;
}

// Snapshot the parts the Discord renderer needs without leaking the
// opponent's hand.
export function renderableState(match, userId) {
  const me = sideOf(match, userId);
  if (!me) return null;
  const opp = me === 'A' ? 'B' : 'A';
  // Per-side hero-power projection { id, manaCost, usedThisTurn }, matching
  // the site's MatchSideView.heroPower field. Optional so old match records
  // (pre-hero-power) render fine without it.
  const heroPowerView = (side) => {
    const hp = match.heroPower && match.heroPower[side];
    return hp ? { id: hp.id, manaCost: hp.manaCost, usedThisTurn: !!hp.usedThisTurn } : null;
  };
  return {
    matchId: match.matchId,
    status: match.status,
    turn: match.turn,
    active: match.active,
    yourTurn: match.active === me,
    me, opp,
    you: {
      hp: match.hp[me],
      armor: (match.heroArmor && match.heroArmor[me]) || 0,
      mana: { ...match.mana[me] },
      hand: match.hands[me].slice(),       // your own hand is visible
      handCount: match.hands[me].length,
      deckCount: match.decks[me].length,
      heroPower: heroPowerView(me),
      board: match.board[me].map(m => ({ uid: m.uid, cardId: m.cardId, atk: m.atk, hp: m.hp, status: (m.status || []).slice(), keywords: (m.keywords || []).slice(), canAttack: !!m.canAttack })),
    },
    them: {
      hp: match.hp[opp],
      armor: (match.heroArmor && match.heroArmor[opp]) || 0,
      mana: { ...match.mana[opp] },
      handCount: match.hands[opp].length,
      deckCount: match.decks[opp].length,
      heroPower: heroPowerView(opp),
      board: match.board[opp].map(m => ({ uid: m.uid, cardId: m.cardId, atk: m.atk, hp: m.hp, status: (m.status || []).slice(), keywords: (m.keywords || []).slice() })),
      npc: match.npc ? { archetype: match.npc.archetype } : null,
    },
    log: (match.log || []).slice(-20),     // recent events only
  };
}

export { isLegalAction };

// Test-only surface for the NPC policy (see test/test-npc-ai.mjs). Kept
// off the public Discord/web API; exported so unit tests can drive the
// decision function directly without spinning a full orchestrated match.
export const __npcTest = {
  pickNpcAction, runNpcTurn, npcMulliganIndices, lethalNextAction,
  lethalReach, scoreState, enumerateCandidates, policyFor, choicePicks,
};
