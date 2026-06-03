// Boltbound — match orchestrator + PvP queue + NPC turn driver.
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
  // Partner is waiting — load their deck. If their deck has gone
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

// Direct challenge — Phase 1 ships the "lay a challenge in their
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

// Mulligan handler — same idea, kicks NPC's turn 1 immediately after
// both sides finish their mulligan if the NPC is on side B.
export async function takeMulligan(env, match, side, handIndices) {
  applyMulligan(match, side, handIndices);
  // If this match has an NPC, auto-mulligan the NPC immediately.
  if (match.status === 'mulligan' && match.npc && !match.mulliganDone?.[match.npc.side]) {
    // NPC mulligan: keep nothing (worst-case parity).
    applyMulligan(match, match.npc.side, []);
  }
  // Run NPC turns if it's now its turn.
  while (match.status === 'active' && match.npc && match.active === match.npc.side) {
    runNpcTurn(match);
  }
  await finaliseIfEnded(env, match);
  await persistMatch(env, match.guildId, match);
  return { ok: true, match };
}

// ── NPC decision policy ──────────────────────────────────────────────
//
// Three archetypes (see CARD-GAME-DESIGN.md §5.1). Each is a
// deterministic decision function over the current match state. We
// step the bot one action at a time until it decides to end turn,
// since each action may unlock new options (a freshly-summoned charge
// minion, a buffed friend, etc.).

function runNpcTurn(match) {
  if (!match.npc) return;
  const side = match.npc.side;
  // Hard ceiling on actions per turn — protects against any policy
  // loop that doesn't terminate (charge minions playing into
  // themselves etc.).
  for (let step = 0; step < 30; step++) {
    if (match.status !== 'active' || match.active !== side) break;
    const action = pickNpcAction(match, side, match.npc.archetype);
    if (!action || action.kind === 'endTurn') {
      applyAction(match, { kind: 'endTurn', side });
      return;
    }
    const r = applyAction(match, action);
    if (r.error) {
      // Defensive — if the bot picks an illegal action (shouldn't
      // happen), just end turn so we don't infinite-loop.
      applyAction(match, { kind: 'endTurn', side });
      return;
    }
  }
  if (match.status === 'active' && match.active === side) {
    applyAction(match, { kind: 'endTurn', side });
  }
}

function pickNpcAction(match, side, archetype) {
  const opp = side === 'A' ? 'B' : 'A';

  // 1. PLAY CARDS — pick the policy that matches archetype.
  const playable = playableHandIndices(match, side);
  if (playable.length) {
    const pick = pickPlay(match, side, archetype, playable);
    if (pick) return pick;
  }

  // 2. ATTACK — pick the policy that matches archetype.
  const attackers = match.board[side].filter(m => m.canAttack && m.hp > 0 && !(m.hollowKing && (match.spellsCast[side] || 0) < 3));
  if (attackers.length) {
    const atk = pickAttack(match, side, archetype, attackers);
    if (atk) return atk;
  }

  return { kind: 'endTurn', side };
}

function playableHandIndices(match, side) {
  const out = [];
  for (let i = 0; i < match.hands[side].length; i++) {
    const c = CARDS[match.hands[side][i]];
    if (!c) continue;
    if ((c.mana || 0) <= match.mana[side].cur) out.push(i);
  }
  return out;
}

function pickPlay(match, side, archetype, playable) {
  const opp = side === 'A' ? 'B' : 'A';
  // Cards sorted by current preference per archetype.
  const ranked = playable.map(i => ({ i, c: CARDS[match.hands[side][i]] }));
  if (archetype === 'aggro') {
    // Greedy — play the highest-attack minion that fits.
    ranked.sort((x, y) => (y.c.atk || 0) - (x.c.atk || 0));
  } else if (archetype === 'control') {
    // Patient — play the highest-HP / highest-cost minion or removal/heal spell.
    ranked.sort((x, y) => (y.c.hp || 0) + (y.c.mana || 0) - ((x.c.hp || 0) + (x.c.mana || 0)));
  } else {
    // Midrange — play the highest-mana card that fits (board curve).
    ranked.sort((x, y) => (y.c.mana || 0) - (x.c.mana || 0));
  }
  for (const { i, c } of ranked) {
    // Spells: pick a target if needed.
    if (c.type === 'spell') {
      const targetUid = pickSpellTarget(match, side, c, archetype);
      // Even if the targetUid is null, we still try the play — the
      // resolver will fall through to a no-op (covered by the
      // resolveTargets returning []), and the spell is spent.
      return { kind: 'playCard', side, handIdx: i, targetUid };
    }
    // Minion: if its onPlay needs a picked target, choose one.
    if (c.needsTarget) {
      const targetUid = pickMinionPlayTarget(match, side, c, archetype);
      return { kind: 'playCard', side, handIdx: i, targetUid };
    }
    return { kind: 'playCard', side, handIdx: i };
  }
  return null;
}

function pickSpellTarget(match, side, card, archetype) {
  const opp = side === 'A' ? 'B' : 'A';
  for (const ab of card.abilities || []) {
    if (ab.target !== 'pickedTarget') continue;
    if (ab.effect === 'damage') {
      // Aggro: face. Control + midrange: biggest enemy minion.
      if (archetype === 'aggro') return 'oppHero';
      const enemies = match.board[opp].filter(m => m.hp > 0);
      if (enemies.length) {
        enemies.sort((a, b) => (b.atk || 0) - (a.atk || 0));
        return enemies[0].uid;
      }
      return 'oppHero';
    }
    if (ab.effect === 'heal') {
      return 'selfHero';
    }
    if (ab.effect === 'destroy') {
      const enemies = match.board[opp].filter(m => m.hp > 0);
      if (!enemies.length) return null;
      // Respect filter.maxMana if present.
      const filt = ab.filter || {};
      let pool = enemies;
      if (filt.maxMana != null) pool = pool.filter(m => (CARDS[m.cardId]?.mana || 0) <= filt.maxMana);
      pool.sort((a, b) => (b.atk || 0) - (a.atk || 0));
      return pool[0]?.uid || null;
    }
    if (ab.effect === 'buff' || ab.effect === 'buffThisTurn') {
      // Buff biggest friendly attacker.
      const friends = match.board[side].filter(m => m.hp > 0);
      friends.sort((a, b) => (b.atk || 0) - (a.atk || 0));
      return friends[0]?.uid || null;
    }
  }
  return null;
}

function pickMinionPlayTarget(match, side, card, archetype) {
  // Reuse the spell target picker — same intent.
  return pickSpellTarget(match, side, card, archetype);
}

function pickAttack(match, side, archetype, attackers) {
  const opp = side === 'A' ? 'B' : 'A';
  // Pick attacker order: highest attack first.
  attackers.sort((a, b) => (b.atk || 0) - (a.atk || 0));
  for (const attacker of attackers) {
    // Determine targets respecting taunt + reach.
    const tauntsUp = match.board[opp].some(m => (m.keywords || []).includes('taunt') && m.hp > 0);
    const targetableMinions = match.board[opp].filter(m => m.hp > 0 && !(m.status || []).some(s => s === 'stealth' || s === 'stealth-fresh') && (!tauntsUp || (m.keywords || []).includes('taunt')));
    const canFace = !tauntsUp || (attacker.keywords || []).includes('reach');

    if (archetype === 'aggro') {
      if (canFace) return { kind: 'attack', side, attackerUid: attacker.uid, defenderUid: 'hero' };
      // Must go through taunts — pick smallest-HP taunt to remove fast.
      if (targetableMinions.length) {
        targetableMinions.sort((a, b) => (a.hp || 0) - (b.hp || 0));
        return { kind: 'attack', side, attackerUid: attacker.uid, defenderUid: targetableMinions[0].uid };
      }
    } else if (archetype === 'control') {
      // Prefer removing biggest enemy minion when present; only face if board is clear.
      if (targetableMinions.length) {
        targetableMinions.sort((a, b) => (b.atk || 0) - (a.atk || 0));
        return { kind: 'attack', side, attackerUid: attacker.uid, defenderUid: targetableMinions[0].uid };
      }
      if (canFace) return { kind: 'attack', side, attackerUid: attacker.uid, defenderUid: 'hero' };
    } else {
      // Midrange — kill profitable trades, else face.
      const trade = targetableMinions.find(m => attacker.atk >= m.hp && m.atk < attacker.hp);
      if (trade) return { kind: 'attack', side, attackerUid: attacker.uid, defenderUid: trade.uid };
      if (canFace) return { kind: 'attack', side, attackerUid: attacker.uid, defenderUid: 'hero' };
      if (targetableMinions.length) {
        targetableMinions.sort((a, b) => (a.hp || 0) - (b.hp || 0));
        return { kind: 'attack', side, attackerUid: attacker.uid, defenderUid: targetableMinions[0].uid };
      }
    }
  }
  return null;
}

// ── End-of-match finalisation ───────────────────────────────────────
//
// When the match resolver flips status to 'A-won' / 'B-won' / 'draw',
// we:
//   1. Compute trophy + Bolts delta for each human side.
//   2. Append a receipt to each human's match-log ring buffer.
//   3. Clear the active-match-ref pointer so the next /boltbound play
//      starts fresh.
//
// Idempotent — re-running on the same finished match no-ops (we mark
// match.settled=true after the first pass).

async function finaliseIfEnded(env, match) {
  if (match.status === 'active' || match.status === 'mulligan') return;
  if (match.settled) return;

  const npc = !!match.npc;
  const aWon = match.status === 'A-won';
  const bWon = match.status === 'B-won';
  const draw = match.status === 'draw';

  const receipt = summariseMatch(match);

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

    // PROGRESSION (P1) — emit cards.match.played (floor) + cards.match.won.*
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
  // RET-4 — feed the ranked ladder (PvP only; the helper no-ops on
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
  return {
    matchId: match.matchId,
    status: match.status,
    turn: match.turn,
    active: match.active,
    yourTurn: match.active === me,
    me, opp,
    you: {
      hp: match.hp[me],
      mana: { ...match.mana[me] },
      hand: match.hands[me].slice(),       // your own hand is visible
      handCount: match.hands[me].length,
      deckCount: match.decks[me].length,
      board: match.board[me].map(m => ({ uid: m.uid, cardId: m.cardId, atk: m.atk, hp: m.hp, status: (m.status || []).slice(), keywords: (m.keywords || []).slice(), canAttack: !!m.canAttack })),
    },
    them: {
      hp: match.hp[opp],
      mana: { ...match.mana[opp] },
      handCount: match.hands[opp].length,
      deckCount: match.decks[opp].length,
      board: match.board[opp].map(m => ({ uid: m.uid, cardId: m.cardId, atk: m.atk, hp: m.hp, status: (m.status || []).slice(), keywords: (m.keywords || []).slice() })),
      npc: match.npc ? { archetype: match.npc.archetype } : null,
    },
    log: (match.log || []).slice(-20),     // recent events only
  };
}

export { isLegalAction };
