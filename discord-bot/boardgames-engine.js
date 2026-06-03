// Boardgames engine, server-authoritative PvP board games (chess,
// checkers, connect4, …).
//
// All games share the same lifecycle, matchmaking, opt-in, and wager
// escrow. Per-game rules are isolated in adapter modules registered in
// the ADAPTERS map at the bottom of this file. Adding a new game = a
// new adapter + one line in ADAPTERS, no engine changes.
//
// ---------------------------------------------------------------------
// KV layout (all under env.LOADOUT_BOLTS)
// ---------------------------------------------------------------------
//   bg:match:<matchId>            -> { id, game, players[2], wager, state, status, turn, winner?,
//                                       createdAt, updatedAt, lastMove?, history[],
//                                       guildId, escrowed }
//   bg:user:<guildId>:<userId>    -> { activeMatchIds[] }  (~5 max, capped on add)
//   bg:queue:<game>:<guildId>     -> JSON [{ userId, wager, joinedAt, displayName }]
//                                       random-matchup waiting room. One per
//                                       (game, guild) so a different wager
//                                       doesn't fragment matchmaking, pairing
//                                       picks the closest-wager match.
//   bg:optin:<guildId>:<userId>   -> "1" | (absent = opted out)
//                                       random-matchup eligibility. Direct
//                                       challenges bypass the toggle entirely.
//   bg:challenge:<challengeId>    -> { id, game, fromId, toId, wager, createdAt,
//                                       expiresAt, guildId, fromName, toName }
//                                       direct-challenge request, 10 min TTL.
//   bg:user:challenges:<userId>   -> [challengeIds]  inbox pointer.
//
// MATCH STATUS values:
//   "waiting", created server-side, both players locked, board ready,
//                 wager escrowed. (Created either by direct-challenge
//                 accept or by queue pair-up.)
//   "active", moves in flight. (Engine flips waiting→active on the
//                 first move, but for v1 we just start at active.)
//   "finished", terminal. `winner` field is "p1" | "p2" | "draw".
//   "abandoned", one side resigned. winner = the OTHER side.
//
// All state mutations bump updatedAt. Clients poll match state every
// 2-3s during their opponent's turn.
//
// ---------------------------------------------------------------------
// Wager handling
// ---------------------------------------------------------------------
// - Direct challenge: wager is locked in the request payload. When the
//   target accepts, BOTH sides are charged (spend()) atomically; if
//   either spend fails the challenge is rejected with insufficient-funds.
// - Queue join: wager is locked in the queue payload + escrowed up
//   front when joining the queue. Withdrawing from the queue refunds.
// - Match outcome:
//     winner takes the pot (2 * wager) via earn().
//     draw    refunds wager to each side.
//     resign  treats the opponent as winner.
// - Edge case: if escrowed funds disappear (corrupted KV, etc.) the
//   refund is best-effort, we log + return ok so the game can still
//   terminate cleanly.

import { earn, spend, getWallet } from './wallet.js';
import { pickAiMove, AI_PERSONAS, isValidDifficulty } from './boardgames-ai.js';

const MATCH_PREFIX = 'bg:match:';
const USER_PREFIX = 'bg:user:';
const QUEUE_PREFIX = 'bg:queue:';
const OPTIN_PREFIX = 'bg:optin:';
const CHALLENGE_PREFIX = 'bg:challenge:';
const USER_CHALLENGES_PREFIX = 'bg:user:challenges:';

// Synthetic opponent id for solo vs-AI matches. Non-numeric so the
// your-turn push (which validates a Discord snowflake) skips it; we also
// exclude it from active-match bookkeeping and PvP stats.
const AI_USER_ID = 'ai';
function isAiUser(id) { return id === AI_USER_ID; }

// Soft ceiling so a stalemated lobby doesn't pin a player into infinite
// active games. Anything above this fails newGame() with too-many-active.
const MAX_ACTIVE_PER_USER = 5;

// Direct challenges expire after this if the target hasn't responded.
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const CHALLENGE_TTL_S = Math.floor(CHALLENGE_TTL_MS / 1000);

// Match record TTL, keep terminated matches around for a day so the
// loser can review the final position, then GC away.
const FINISHED_MATCH_TTL_S = 24 * 60 * 60;

// Async / correspondence model: each player has 24 hours to make their
// move once it becomes their turn. Missing the window forfeits the
// match, opponent wins, wager goes to them. Stamped on the match as
// `turnDeadline` (unix ms) on every turn flip (NOT on multi-jumps
// where the same player keeps the turn).
const TURN_DEADLINE_MS = 24 * 60 * 60 * 1000;

// Wager bounds.
const MIN_WAGER = 0;          // wager-free games allowed
const MAX_WAGER = 100_000;    // sane upper bound to stop fat-finger ruin

function randomId(prefix) {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  const hex = [...buf].map(b => b.toString(16).padStart(2, '0')).join('');
  return prefix + '-' + hex;
}

function clampWager(w) {
  const n = Number(w);
  if (!Number.isFinite(n)) return 0;
  return Math.max(MIN_WAGER, Math.min(MAX_WAGER, Math.floor(n)));
}

// ── KV helpers ───────────────────────────────────────────────────────

async function loadMatch(env, matchId) {
  const raw = await env.LOADOUT_BOLTS.get(MATCH_PREFIX + matchId, { type: 'json' });
  return raw || null;
}

async function saveMatch(env, match) {
  match.updatedAt = Date.now();
  const opts = match.status === 'finished' || match.status === 'abandoned'
    ? { expirationTtl: FINISHED_MATCH_TTL_S }
    : undefined;
  await env.LOADOUT_BOLTS.put(MATCH_PREFIX + match.id, JSON.stringify(match), opts);
}

async function loadUserActive(env, guildId, userId) {
  const raw = await env.LOADOUT_BOLTS.get(USER_PREFIX + guildId + ':' + userId, { type: 'json' });
  return raw || { activeMatchIds: [] };
}

async function saveUserActive(env, guildId, userId, rec) {
  await env.LOADOUT_BOLTS.put(USER_PREFIX + guildId + ':' + userId, JSON.stringify(rec));
}

async function addUserActive(env, guildId, userId, matchId) {
  if (isAiUser(userId)) return;
  const rec = await loadUserActive(env, guildId, userId);
  if (!rec.activeMatchIds.includes(matchId)) {
    rec.activeMatchIds.push(matchId);
  }
  await saveUserActive(env, guildId, userId, rec);
}

async function removeUserActive(env, guildId, userId, matchId) {
  if (isAiUser(userId)) return;
  const rec = await loadUserActive(env, guildId, userId);
  rec.activeMatchIds = rec.activeMatchIds.filter(m => m !== matchId);
  await saveUserActive(env, guildId, userId, rec);
}

async function loadQueue(env, game, guildId) {
  const raw = await env.LOADOUT_BOLTS.get(QUEUE_PREFIX + game + ':' + guildId, { type: 'json' });
  return Array.isArray(raw) ? raw : [];
}

async function saveQueue(env, game, guildId, list) {
  await env.LOADOUT_BOLTS.put(QUEUE_PREFIX + game + ':' + guildId, JSON.stringify(list));
}

// ── Adapter contract ─────────────────────────────────────────────────
// Each adapter exports:
//   initialState(): object, fresh board / state
//   legalMoves(state, side): Move[], for the side-to-move (optional, used
//                                          for client hints / pre-validation)
//   applyMove(state, side, move):
//     { ok: true, state, terminal?: { winner: 'p1'|'p2'|'draw', reason } }
//     { ok: false, error, message }
//   sideToMove(state): 'p1' | 'p2'
//   isTerminal(state): boolean
//
// `move` shape is adapter-specific (e.g. { col } for connect4, {from, to}
// for chess). The engine treats it as opaque.

import { adapter as connect4 } from './boardgames-connect4.js';
import { adapter as checkers } from './boardgames-checkers.js';
import { adapter as chess }    from './boardgames-chess.js';
import { adapter as tanks }    from './boardgames-tanks.js';

const ADAPTERS = {
  connect4,
  checkers,
  chess,
  // Turn-based artillery PvP (Pocket Tanks-style). Uses the same
  // applyMove/redactMatch lifecycle; per-shot rich data lives on
  // state.lastShot so the PWA can replay the trajectory + crater +
  // damages from the redacted match snapshot alone.
  tanks,
};

export function getAdapter(game) {
  return ADAPTERS[game] || null;
}

export function listGames() {
  return Object.keys(ADAPTERS);
}

// ── Public engine API ─────────────────────────────────────────────────

/**
 * Snapshot read for the page-load, returns the user's active matches +
 * incoming challenges + opt-in state.
 *
 * Side-effect: any of the user's matches whose turn-deadline has passed
 * are auto-forfeit on read. This is the cheap lazy path; the worker's
 * hourly cron does the same sweep across every match (see
 * cronSweepExpiredMatches) so deadbeat matches no one is watching also
 * resolve.
 */
export async function snapshot(env, guildId, userId) {
  const rec = await loadUserActive(env, guildId, userId);
  const activeMatchIds = rec.activeMatchIds || [];

  const matches = [];
  for (const id of activeMatchIds) {
    let m = await loadMatch(env, id);
    if (!m) continue;
    if (m.status === 'active' || m.status === 'waiting') {
      m = await checkAndExpireMatch(env, m);
    }
    if (m && (m.status === 'waiting' || m.status === 'active')) {
      matches.push(redactMatch(m, userId));
    }
  }

  const inboxRaw = await env.LOADOUT_BOLTS.get(USER_CHALLENGES_PREFIX + userId, { type: 'json' });
  const inboxIds = Array.isArray(inboxRaw) ? inboxRaw : [];
  const challenges = [];
  for (const id of inboxIds) {
    const c = await env.LOADOUT_BOLTS.get(CHALLENGE_PREFIX + id, { type: 'json' });
    if (c && c.expiresAt > Date.now()) challenges.push(c);
  }

  const optIn = await env.LOADOUT_BOLTS.get(OPTIN_PREFIX + guildId + ':' + userId);
  return {
    ok: true,
    optIn: optIn === '1',
    matches,
    challenges,
    games: listGames(),
  };
}

/**
 * Toggle whether this user is included in the random-matchup pool. Off
 * by default, direct challenges still work either way.
 */
export async function setOptIn(env, guildId, userId, on) {
  if (on) {
    await env.LOADOUT_BOLTS.put(OPTIN_PREFIX + guildId + ':' + userId, '1');
  } else {
    await env.LOADOUT_BOLTS.delete(OPTIN_PREFIX + guildId + ':' + userId);
    // Drop them from any queues they're sitting in, refunding the
    // escrowed wager. Best-effort across all games.
    for (const game of listGames()) {
      const q = await loadQueue(env, game, guildId);
      const me = q.find(e => e.userId === userId);
      if (me) {
        if (me.wager > 0) {
          await earn(env, guildId, userId, me.wager, 'boardgames:queue:opt-out-refund');
        }
        await saveQueue(env, game, guildId, q.filter(e => e.userId !== userId));
      }
    }
  }
  return { ok: true, optIn: !!on };
}

/**
 * Get full match state for one of this user's matches. Returns null if
 * the user isn't a participant.
 */
export async function getMatch(env, userId, matchId) {
  let m = await loadMatch(env, matchId);
  if (!m) return { ok: false, error: 'not-found' };
  if (m.players[0].userId !== userId && m.players[1].userId !== userId) {
    return { ok: false, error: 'forbidden' };
  }
  if (m.status === 'active' || m.status === 'waiting') {
    m = await checkAndExpireMatch(env, m);
  }
  return { ok: true, match: redactMatch(m, userId) };
}

/**
 * Apply a move. Side is derived from the userId. The adapter validates;
 * we wrap the result in match-lifecycle bookkeeping (turn flip, win
 * detection, escrow payout).
 */
export async function applyMove(env, guildId, userId, matchId, move) {
  let m = await loadMatch(env, matchId);
  if (!m) return { ok: false, error: 'not-found' };
  if (m.status !== 'active' && m.status !== 'waiting') {
    return { ok: false, error: 'finished' };
  }

  // First, expire if the player let their own clock run out before
  // submitting. The check honours pre-existing turnDeadline (legacy
  // matches without one get an immediate one-time grace stamp).
  m = await checkAndExpireMatch(env, m);
  if (m.status !== 'active' && m.status !== 'waiting') {
    return { ok: false, error: 'finished' };
  }

  const sideIdx = m.players[0].userId === userId ? 0 : m.players[1].userId === userId ? 1 : -1;
  if (sideIdx < 0) return { ok: false, error: 'forbidden' };

  const adapter = getAdapter(m.game);
  if (!adapter) return { ok: false, error: 'bad-game' };

  const toMove = adapter.sideToMove(m.state);
  const expectedIdx = toMove === 'p1' ? 0 : 1;
  if (sideIdx !== expectedIdx) {
    return { ok: false, error: 'not-your-turn' };
  }

  const result = adapter.applyMove(m.state, toMove, move);
  if (!result.ok) return result;

  const prevTurn = toMove;
  m.state = result.state;
  m.status = 'active';
  m.lastMove = { side: toMove, move, ts: Date.now() };
  m.history = m.history || [];
  m.history.push(m.lastMove);

  if (result.terminal) {
    m.status = 'finished';
    m.winner = result.terminal.winner;
    m.winReason = result.terminal.reason || null;
    m.turnDeadline = null;
    await settleEscrow(env, m);
    await emitBoardgameProgression(env, m);
    await removeUserActive(env, guildId, m.players[0].userId, m.id);
    await removeUserActive(env, guildId, m.players[1].userId, m.id);
  } else {
    // Only reset the per-move clock when the TURN ACTUALLY FLIPS.
    // Checkers multi-jumps keep the same player on the move, they
    // shouldn't get a fresh 24h every jump in their own chain.
    const newTurn = adapter.sideToMove(m.state);
    if (newTurn !== prevTurn) {
      m.turnDeadline = Date.now() + TURN_DEADLINE_MS;
      // Fire-and-forget push to the player whose turn it just became.
      // Their discordId IS the userId we stored on creation (same
      // namespace as wallet ids in this deploy). Skipped for vs-AI: the
      // AI side has no Discord id and replies in this same request.
      if (!m.ai) {
        const newIdx = newTurn === 'p1' ? 0 : 1;
        const targetUserId = m.players[newIdx].userId;
        try {
          await notifyYourTurn(env, m, targetUserId);
        } catch { /* notification best-effort */ }
      }
    }
  }

  // Solo vs-AI: play the AI's reply(s) now so this response already
  // reflects the AI's move. If the AI ends the match, settle + clean up
  // exactly like a human-terminated game.
  if (m.status === 'active' && m.ai && adapter.sideToMove(m.state) === m.ai.side) {
    applyAiTurns(adapter, m);
    if (m.status === 'finished') {
      await settleEscrow(env, m);
      await emitBoardgameProgression(env, m);
      await removeUserActive(env, guildId, m.players[0].userId, m.id);
      await removeUserActive(env, guildId, m.players[1].userId, m.id);
    } else {
      m.turnDeadline = Date.now() + TURN_DEADLINE_MS;
    }
  }

  await saveMatch(env, m);
  return { ok: true, match: redactMatch(m, userId) };
}

/**
 * Resign, counts as a loss for the resigning side.
 */
export async function resign(env, guildId, userId, matchId) {
  const m = await loadMatch(env, matchId);
  if (!m) return { ok: false, error: 'not-found' };
  if (m.status !== 'active' && m.status !== 'waiting') {
    return { ok: false, error: 'finished' };
  }
  const sideIdx = m.players[0].userId === userId ? 0 : m.players[1].userId === userId ? 1 : -1;
  if (sideIdx < 0) return { ok: false, error: 'forbidden' };
  m.status = 'abandoned';
  m.winner = sideIdx === 0 ? 'p2' : 'p1';
  m.winReason = 'resign';
  m.turnDeadline = null;
  await settleEscrow(env, m);
  await emitBoardgameProgression(env, m);
  await removeUserActive(env, guildId, m.players[0].userId, m.id);
  await removeUserActive(env, guildId, m.players[1].userId, m.id);
  await saveMatch(env, m);
  return { ok: true, match: redactMatch(m, userId) };
}

/**
 * Add me to the random-matchup queue for `game`. If someone else is
 * already waiting (compatible wager), pair us up + start the match.
 * Otherwise I'm in the queue and snapshot will show "waiting".
 */
export async function queueJoin(env, guildId, userId, displayName, game, wager) {
  const adapter = getAdapter(game);
  if (!adapter) return { ok: false, error: 'bad-game' };

  const optIn = await env.LOADOUT_BOLTS.get(OPTIN_PREFIX + guildId + ':' + userId);
  if (optIn !== '1') {
    return { ok: false, error: 'not-opted-in', message: 'Opt in to random matchups first.' };
  }

  const userActive = await loadUserActive(env, guildId, userId);
  if (userActive.activeMatchIds.length >= MAX_ACTIVE_PER_USER) {
    return { ok: false, error: 'too-many-active', message: 'Finish a game in progress first.' };
  }

  const w = clampWager(wager);

  // Already queued? noop.
  const q = await loadQueue(env, game, guildId);
  if (q.find(e => e.userId === userId)) {
    return { ok: true, status: 'already-queued', queueSize: q.length };
  }

  // Pair with the closest-wager existing entry (skip ourselves).
  const candidate = q
    .filter(e => e.userId !== userId)
    .sort((a, b) => Math.abs(a.wager - w) - Math.abs(b.wager - w))[0];

  if (candidate) {
    // Settle on the LOWER of the two wagers so neither side over-commits.
    const matchWager = Math.min(candidate.wager, w);
    // Charge both. If either fails (e.g. candidate spent their bolts
    // elsewhere while sitting in the queue), drop them and try the next
    // best candidate by tail-recursing through the rest of the list.
    const remaining = q.filter(e => e.userId !== userId && e.userId !== candidate.userId);

    const chargeMe = matchWager > 0
      ? await spend(env, guildId, userId, matchWager, 'boardgames:wager:' + game)
      : { ok: true };
    if (!chargeMe.ok) {
      return { ok: false, error: 'insufficient', message: chargeMe.reason };
    }

    // Candidate already has matchWager escrowed (they paid on queue-
    // join). If their queued wager was higher than matchWager, refund
    // the difference now.
    if (candidate.wager > matchWager) {
      await earn(env, guildId, candidate.userId, candidate.wager - matchWager,
        'boardgames:queue:wager-equalized');
    }

    await saveQueue(env, game, guildId, remaining);

    const match = await openMatch(env, guildId, game, matchWager, [
      { userId: candidate.userId, displayName: candidate.displayName || 'Player' },
      { userId, displayName: displayName || 'Player' },
    ]);
    return { ok: true, status: 'matched', matchId: match.id };
  }

  // No candidate, escrow my wager + sit in the queue.
  if (w > 0) {
    const chargeMe = await spend(env, guildId, userId, w, 'boardgames:queue:escrow:' + game);
    if (!chargeMe.ok) return { ok: false, error: 'insufficient', message: chargeMe.reason };
  }
  q.push({ userId, displayName: displayName || 'Player', wager: w, joinedAt: Date.now() });
  await saveQueue(env, game, guildId, q);
  return { ok: true, status: 'queued', queueSize: q.length };
}

/**
 * Leave the queue, refunding the escrowed wager.
 */
export async function queueLeave(env, guildId, userId, game) {
  const q = await loadQueue(env, game, guildId);
  const me = q.find(e => e.userId === userId);
  if (!me) return { ok: true, status: 'not-queued' };
  if (me.wager > 0) {
    await earn(env, guildId, userId, me.wager, 'boardgames:queue:leave-refund');
  }
  await saveQueue(env, game, guildId, q.filter(e => e.userId !== userId));
  return { ok: true, status: 'left' };
}

/**
 * Create a direct-challenge request from one player to another. The
 * target sees it in their snapshot inbox + can accept or decline.
 *
 * Wager is NOT escrowed here, we charge on accept. That avoids the
 * common UX trap of "I challenged 5 friends for 1000 bolts each and
 * now my balance is locked while they ignore me." The wager is just
 * the proposed stake.
 */
export async function challengeCreate(env, guildId, fromId, fromName, toId, toName, game, wager) {
  if (!getAdapter(game)) return { ok: false, error: 'bad-game' };
  if (fromId === toId) return { ok: false, error: 'self-challenge' };
  if (!/^\d{5,25}$/.test(toId)) return { ok: false, error: 'bad-target' };

  const w = clampWager(wager);

  // Stop a player from spamming the same target.
  const inboxRaw = await env.LOADOUT_BOLTS.get(USER_CHALLENGES_PREFIX + toId, { type: 'json' });
  const inbox = Array.isArray(inboxRaw) ? inboxRaw : [];
  for (const id of inbox) {
    const c = await env.LOADOUT_BOLTS.get(CHALLENGE_PREFIX + id, { type: 'json' });
    if (c && c.fromId === fromId && c.game === game && c.expiresAt > Date.now()) {
      return { ok: false, error: 'already-pending', message: 'You already have a pending challenge to this user for this game.' };
    }
  }

  const id = randomId('ch');
  const now = Date.now();
  const challenge = {
    id, game,
    fromId, fromName: fromName || 'Player',
    toId, toName: toName || 'Player',
    wager: w,
    createdAt: now,
    expiresAt: now + CHALLENGE_TTL_MS,
    guildId,
  };
  await env.LOADOUT_BOLTS.put(CHALLENGE_PREFIX + id, JSON.stringify(challenge),
    { expirationTtl: CHALLENGE_TTL_S });
  inbox.push(id);
  await env.LOADOUT_BOLTS.put(USER_CHALLENGES_PREFIX + toId, JSON.stringify(inbox.slice(-25)),
    { expirationTtl: CHALLENGE_TTL_S * 6 });
  return { ok: true, challenge };
}

export async function challengeAccept(env, guildId, userId, displayName, challengeId) {
  const c = await env.LOADOUT_BOLTS.get(CHALLENGE_PREFIX + challengeId, { type: 'json' });
  if (!c) return { ok: false, error: 'not-found' };
  if (c.toId !== userId) return { ok: false, error: 'forbidden' };
  if (c.expiresAt < Date.now()) return { ok: false, error: 'expired' };

  // Charge both sides now. If either fails, the challenge is gone.
  if (c.wager > 0) {
    const chargeChallenger = await spend(env, guildId, c.fromId, c.wager, 'boardgames:wager:' + c.game);
    if (!chargeChallenger.ok) {
      await env.LOADOUT_BOLTS.delete(CHALLENGE_PREFIX + challengeId);
      return { ok: false, error: 'challenger-broke', message: "Challenger can't cover the wager anymore." };
    }
    const chargeTarget = await spend(env, guildId, userId, c.wager, 'boardgames:wager:' + c.game);
    if (!chargeTarget.ok) {
      // Refund the challenger.
      await earn(env, guildId, c.fromId, c.wager, 'boardgames:wager:refund-cant-cover');
      return { ok: false, error: 'insufficient', message: chargeTarget.reason };
    }
  }
  await env.LOADOUT_BOLTS.delete(CHALLENGE_PREFIX + challengeId);

  // P1 = the challenger (gets to move first).
  const match = await openMatch(env, guildId, c.game, c.wager, [
    { userId: c.fromId, displayName: c.fromName || 'Player' },
    { userId, displayName: displayName || c.toName || 'Player' },
  ]);
  return { ok: true, matchId: match.id };
}

export async function challengeDecline(env, userId, challengeId) {
  const c = await env.LOADOUT_BOLTS.get(CHALLENGE_PREFIX + challengeId, { type: 'json' });
  if (!c) return { ok: false, error: 'not-found' };
  if (c.toId !== userId && c.fromId !== userId) return { ok: false, error: 'forbidden' };
  // Wager wasn't charged yet, nothing to refund.
  await env.LOADOUT_BOLTS.delete(CHALLENGE_PREFIX + challengeId);
  return { ok: true };
}

// ── Internals ────────────────────────────────────────────────────────

async function openMatch(env, guildId, game, wager, players) {
  const adapter = getAdapter(game);
  const now = Date.now();
  const match = {
    id: randomId('m'),
    game,
    players,
    wager,
    pot: wager * 2,
    state: adapter.initialState(),
    status: 'active',
    turn: 'p1',
    winner: null,
    history: [],
    createdAt: now,
    updatedAt: now,
    turnDeadline: now + TURN_DEADLINE_MS,
    guildId,
    escrowed: wager > 0,
  };
  await saveMatch(env, match);
  await addUserActive(env, guildId, players[0].userId, match.id);
  await addUserActive(env, guildId, players[1].userId, match.id);
  // First-move push: ping the player on the clock at start-of-match.
  try { await notifyYourTurn(env, match, players[0].userId); }
  catch { /* best-effort */ }
  return match;
}

/**
 * Open a solo match against an AI opponent. The human is always p1 (so
 * they move first); the AI is a synthetic p2 whose replies are computed
 * server-side in applyMove. No wager / escrow, vs-AI is practice.
 */
export async function openAiMatch(env, guildId, game, difficulty, human) {
  const adapter = getAdapter(game);
  if (!adapter) return { ok: false, error: 'bad-game' };
  if (!isValidDifficulty(difficulty)) return { ok: false, error: 'bad-difficulty' };

  const userActive = await loadUserActive(env, guildId, human.userId);
  if ((userActive.activeMatchIds || []).length >= MAX_ACTIVE_PER_USER) {
    return { ok: false, error: 'too-many-active', message: 'Finish a game in progress first.' };
  }

  const persona = AI_PERSONAS[difficulty];
  const now = Date.now();
  const match = {
    id: randomId('m'),
    game,
    players: [
      { userId: human.userId, displayName: human.displayName || 'Player' },
      { userId: AI_USER_ID, displayName: persona.name },
    ],
    wager: 0,
    pot: 0,
    state: adapter.initialState(),
    status: 'active',
    turn: 'p1',
    winner: null,
    history: [],
    createdAt: now,
    updatedAt: now,
    turnDeadline: now + TURN_DEADLINE_MS,
    guildId,
    escrowed: false,
    ai: { side: 'p2', difficulty },
  };
  await saveMatch(env, match);
  await addUserActive(env, guildId, human.userId, match.id);
  return { ok: true, matchId: match.id, match: redactMatch(match, human.userId) };
}

// Play out the AI's reply(s) on a vs-AI match, mutating `m` in place. A
// checkers multi-jump keeps the AI on the move, so we loop until it's
// the human's turn again (or the match ends). Pure/synchronous: pickAiMove
// + adapter.applyMove don't touch KV. The guard caps a pathological loop.
function applyAiTurns(adapter, m) {
  const aiSide = m.ai.side;
  let guard = 0;
  while (m.status === 'active' && adapter.sideToMove(m.state) === aiSide && guard++ < 80) {
    const move = pickAiMove(adapter, m.game, m.state, aiSide, m.ai.difficulty);
    if (!move) break;
    const res = adapter.applyMove(m.state, aiSide, move);
    if (!res.ok) break;
    m.state = res.state;
    m.lastMove = { side: aiSide, move, ts: Date.now() };
    m.history = m.history || [];
    m.history.push(m.lastMove);
    if (res.terminal) {
      m.status = 'finished';
      m.winner = res.terminal.winner;
      m.winReason = res.terminal.reason || null;
      m.turnDeadline = null;
      break;
    }
  }
}

async function settleEscrow(env, m) {
  if (!m.escrowed || m.wager <= 0) return;
  const [p1, p2] = m.players;
  if (m.winner === 'draw') {
    await earn(env, m.guildId, p1.userId, m.wager, 'boardgames:refund-draw');
    await earn(env, m.guildId, p2.userId, m.wager, 'boardgames:refund-draw');
  } else if (m.winner === 'p1') {
    await earn(env, m.guildId, p1.userId, m.pot, 'boardgames:winnings:' + m.game);
  } else if (m.winner === 'p2') {
    await earn(env, m.guildId, p2.userId, m.pot, 'boardgames:winnings:' + m.game);
  }
}

// PROGRESSION (P1), fire match.played for both sides + match.won for
// the winner. Called by the engine right after the match flips to
// finished/abandoned. Dedup by matchId so re-running emits once.
export async function emitBoardgameProgression(env, m) {
  if (!m || m.status === 'active' || m.status === 'waiting') return;
  // vs-AI is practice: no PvP progression / quest / achievement credit
  // (and the synthetic AI id must never receive events).
  if (m.ai) return;
  try {
    const { emitProgressionEvent } = await import('./progression/event-bus.js');
    const [p1, p2] = m.players;
    for (const side of [p1, p2]) {
      if (!side?.userId) continue;
      await emitProgressionEvent(env, {
        kind: 'board.match.played', userId: side.userId, guildId: m.guildId,
        meta: { matchId: m.id, game: m.game }, stableKeys: ['matchId'],
      });
    }
    if (m.winner === 'p1' || m.winner === 'p2') {
      const w = m.winner === 'p1' ? p1 : p2;
      if (w?.userId) {
        await emitProgressionEvent(env, {
          kind: 'board.match.won', userId: w.userId, guildId: m.guildId,
          meta: { matchId: m.id, game: m.game }, stableKeys: ['matchId'],
        });
      }
    }
  } catch { /* non-fatal */ }
}

// PROGRESSION (P2), board games headline stats. Walks bg:match:*
// for matches this user appears in. Capped at 5 list pages so a
// flooded match index can't OOM the profile page.
export async function getStatsFor(env, userId, _guildId = null) {
  let played = 0, wins = 0;
  const byGame = {};
  let cursor;
  for (let i = 0; i < 5; i++) {
    const r = await env.LOADOUT_BOLTS.list({ prefix: 'bg:match:', cursor, limit: 1000 });
    for (const k of r.keys) {
      const m = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
      if (!m || !Array.isArray(m.players)) continue;
      if (m.ai) continue;   // vs-AI practice doesn't count toward PvP W/L
      const p1 = m.players[0]?.userId, p2 = m.players[1]?.userId;
      const side = p1 === userId ? 'p1' : p2 === userId ? 'p2' : null;
      if (!side) continue;
      if (m.status !== 'finished' && m.status !== 'abandoned') continue;
      played++;
      byGame[m.game] = byGame[m.game] || { played: 0, won: 0 };
      byGame[m.game].played++;
      if (m.winner === side) {
        wins++;
        byGame[m.game].won++;
      }
    }
    if (r.list_complete) break;
    cursor = r.cursor;
  }
  const winRate = played > 0 ? Math.round((wins / played) * 100) : 0;
  return {
    primary: { label: 'W/L', value: `${wins}-${played - wins}` },
    secondary: [
      { label: 'Win rate', value: winRate + '%' },
      { label: 'Chess',    value: `${byGame.chess?.won    || 0}/${byGame.chess?.played    || 0}` },
      { label: 'Checkers', value: `${byGame.checkers?.won || 0}/${byGame.checkers?.played || 0}` },
      { label: 'Connect 4',value: `${byGame.connect4?.won || 0}/${byGame.connect4?.played || 0}` },
      { label: 'Tanks',    value: `${byGame.tanks?.won    || 0}/${byGame.tanks?.played    || 0}` },
    ],
    iconKind: 'board-pawn',
  };
}

// Redact things the OTHER player shouldn't see. For perfect-information
// games (chess/checkers/connect4) this is mostly identity, both sides
// see the board. We still surface a `you` field so the client knows
// which side it's playing without re-deriving from userId.
//
// We ALSO include the side-to-move's legal moves so the UI can render
// destination hints + forced-capture markers without re-implementing
// the rules in TypeScript. Returning legals only for the side whose
// turn it is keeps the payload small (and gives nothing useful to the
// opponent, chess/checkers are perfect-info anyway).
function redactMatch(m, userId) {
  const youIdx = m.players[0].userId === userId ? 0 : 1;
  const adapter = getAdapter(m.game);
  let legalMoves = [];
  if (adapter && (m.status === 'active' || m.status === 'waiting')) {
    try {
      const toMove = adapter.sideToMove(m.state);
      legalMoves = adapter.legalMoves(m.state, toMove) || [];
    } catch { /* leave empty */ }
  }
  // Async / correspondence model: surface the per-move clock so the
  // client can render countdowns without computing them.
  const turnDeadline = (m.status === 'active' || m.status === 'waiting')
    ? (m.turnDeadline || null)
    : null;
  const turnSecondsLeft = turnDeadline
    ? Math.max(0, Math.floor((turnDeadline - Date.now()) / 1000))
    : null;
  return {
    id: m.id,
    game: m.game,
    players: m.players,
    you: youIdx === 0 ? 'p1' : 'p2',
    ai: m.ai || null,
    wager: m.wager,
    pot: m.pot,
    state: m.state,
    status: m.status,
    winner: m.winner,
    winReason: m.winReason || null,
    lastMove: m.lastMove || null,
    legalMoves,
    history: m.history || [],
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    turnDeadline,
    turnSecondsLeft,
  };
}

// ── Async-deadline machinery ─────────────────────────────────────────

/**
 * If the match is active and its turn-deadline has passed, force-flip
 * it to abandoned with the on-the-clock player as the loser. Idempotent:
 * returns the same match unchanged if nothing's expired.
 *
 * Legacy matches that pre-date the turnDeadline field get a one-time
 * grace stamp (set the deadline to now + 24h on first read) so they
 * don't all get auto-forfeit the moment this ships.
 */
export async function checkAndExpireMatch(env, m) {
  if (!m) return m;
  if (m.status !== 'active' && m.status !== 'waiting') return m;
  const adapter = getAdapter(m.game);
  if (!adapter) return m;

  if (!m.turnDeadline) {
    m.turnDeadline = Date.now() + TURN_DEADLINE_MS;
    await saveMatch(env, m);
    return m;
  }
  if (m.turnDeadline > Date.now()) return m;

  const toMove = adapter.sideToMove(m.state);
  const loserIdx = toMove === 'p1' ? 0 : 1;
  m.status = 'abandoned';
  m.winner = loserIdx === 0 ? 'p2' : 'p1';
  m.winReason = 'timeout';
  m.turnDeadline = null;
  await settleEscrow(env, m);
  await emitBoardgameProgression(env, m);
  await removeUserActive(env, m.guildId, m.players[0].userId, m.id);
  await removeUserActive(env, m.guildId, m.players[1].userId, m.id);
  await saveMatch(env, m);
  return m;
}

/**
 * Worker cron tick, scans every match key for expired ones and
 * resolves them. Catches abandoned games no one is actively viewing
 * (the on-read expiry path in snapshot/getMatch/applyMove handles the
 * ones that ARE being viewed). Cheap: ~one KV list + per-match get +
 * conditional put.
 *
 * Returns { scanned, expired } for the cron log.
 */
export async function cronSweepExpiredMatches(env) {
  if (!env.LOADOUT_BOLTS) return { scanned: 0, expired: 0 };
  let cursor;
  let scanned = 0;
  let expired = 0;
  // Cap iterations: KV list returns up to 1000 keys per page. Five
  // pages = up to 5k active matches, plenty of headroom for a hobby
  // community and bounded so a runaway state can't pin the cron tick.
  for (let i = 0; i < 5; i++) {
    const r = await env.LOADOUT_BOLTS.list({ prefix: MATCH_PREFIX, cursor, limit: 1000 });
    for (const k of r.keys) {
      scanned++;
      const m = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
      if (!m) continue;
      if (m.status !== 'active' && m.status !== 'waiting') continue;
      if (!m.turnDeadline || m.turnDeadline > Date.now()) continue;
      await checkAndExpireMatch(env, m);
      expired++;
    }
    if (r.list_complete) break;
    cursor = r.cursor;
  }
  return { scanned, expired };
}

// HMAC-signed POST to aquilo-site /api/push/external with audience
// filtered to the target player's Discord ID + the boardYourTurn tag
// (which subscribers can opt out of via NotificationPrefs). Mirrors the
// pattern in daily-bonus-push.js + clash-push.js, one secret, one
// rotation point. Failures are swallowed so a push outage never
// blocks a move.
async function notifyYourTurn(env, m, targetUserId) {
  const secret = env.AQUILO_SITE_WEB_SECRET || env.CLASH_PUSH_SECRET;
  if (!secret) return;
  if (!/^\d{5,25}$/.test(String(targetUserId))) return;
  const opponent = m.players[m.players[0].userId === targetUserId ? 1 : 0];
  const gameLabel = m.game === 'connect4' ? 'Connect Four'
    : m.game === 'checkers' ? 'Checkers'
    : m.game === 'chess' ? 'Chess'
    : m.game;
  const body = m.wager > 0
    ? `${opponent.displayName || 'Opponent'} moved, ${m.pot.toLocaleString()} bolts on the line. You have 24 h.`
    : `${opponent.displayName || 'Opponent'} moved, you have 24 h to reply.`;
  const payload = {
    kind: 'board.your-turn',
    title: `Your move, ${gameLabel}`,
    body,
    url: `https://aquilo.gg/play/board/${m.game}/match/?id=${m.id}`,
    audience: { kind: 'user', userIds: [String(targetUserId)] },
    tag: 'boardYourTurn',
    matchId: m.id,
    ts: Date.now(),
  };
  const ts = String(Math.floor(Date.now() / 1000));
  const message = ts + '\n' + JSON.stringify(payload);
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  const sigHex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  const url = env.AQUILO_PUSH_URL || 'https://aquilo.gg/api/push/external';
  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-aquilo-web-ts': ts,
        'x-aquilo-web-sig': sigHex,
      },
      body: JSON.stringify(payload),
    });
  } catch { /* best-effort */ }
}

// Convenience for the snapshot endpoint, fetch the wallet balance so
// the client doesn't have to make a separate call.
export async function snapshotWithWallet(env, guildId, userId) {
  const snap = await snapshot(env, guildId, userId);
  const w = await getWallet(env, guildId, userId);
  return { ...snap, balance: w.balance || 0 };
}
