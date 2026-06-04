// Quick-bet bolts games, Blackjack, Roulette, Wheel, Higher/Lower,
// Mines, Plinko, Crash. Companion to games.js (which owns the
// historical coinflip/dice/daily). Kept in a separate module so the
// 2026-05 expansion doesn't trample git history on games.js or fight
// Boltbound for merge position.
//
// House philosophy is identical to games.js: outcomes are
// server-authoritative, RNG is crypto.getRandomValues, payouts are
// generous (small or zero house edge), bolts are play money, the
// game should feel rewarding to play, not punishing.
//
// Every public handler validates its inputs, runs spend() before any
// RNG, and (on a win) issues earn() at the post-payout multiplier.
// All handlers return { ok, ... } so the worker route can branch on
// ok without inspecting the rest.
//
// Cooldown contract: the worker route calls cooldownCheck() BEFORE
// dispatching to the game; the game itself never touches the
// cooldown KV. cooldownTouch() is then called AFTER a successful
// play to start the next window. Stateful games (blackjack, hilo,
// mines) only touch the cooldown on the START action, once you're
// in a hand you can hit/reveal as fast as you like.

import { earn, spend, getWallet } from './wallet.js';

// ── Shared RNG + deck helpers ────────────────────────────────────────

function rng(maxExclusive) {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  const cap = Math.floor(0xFFFFFFFF / maxExclusive) * maxExclusive;
  let v = buf[0];
  while (v >= cap) {
    crypto.getRandomValues(buf);
    v = buf[0];
  }
  return v % maxExclusive;
}

// Uniform float in [0, 1). Used by Plinko/Wheel/Crash where we want
// real-valued randomness, not integer-range. Built from rng so the
// bias-rejection in rng() carries through.
function rngFloat() {
  return rng(1 << 30) / (1 << 30);
}

// 0-51 card ints. suit = id >> 4 (0..3 = ♠♥♦♣), rank = id & 0xF (0..12).
function makeDeck() {
  const d = [];
  for (let s = 0; s < 4; s++) for (let r = 0; r < 13; r++) d.push((s << 4) | r);
  return d;
}
function shuffle(deck) {
  const a = deck.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng(i + 1);
    const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}
function cardSuit(c) { return ['S', 'H', 'D', 'C'][c >> 4]; }
function cardRank(c) {
  const r = c & 0xF;
  return ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'][r];
}
function cardLabel(c) { return cardRank(c) + cardSuit(c); }

// ── Cooldown ─────────────────────────────────────────────────────────
//
// v2 rebalance (2026-05): cooldown extended via economy-pace.js so the
// natural rate of grinding shrinks alongside the new payout floor.
// v1 was 2.5s; v2 is 5s.
import { QUICK_GAME_COOLDOWN_MS, QUICK_GAME_NET_WIN_CAP } from './economy-pace.js';
import { publishActivity } from './activity-do.js';
import { resolveActorName } from './actor-name.js';

const COOLDOWN_MS = QUICK_GAME_COOLDOWN_MS;

// v2 rebalance: cap absolute net win per quick-game at the bet plus
// QUICK_GAME_NET_WIN_CAP. Wagers still play at real odds (so the 36×
// roulette number bet is still a real lottery), the cap stops a
// lucky streak of high-stake wins from minting tens of thousands of
// bolts in an evening. If gross <= bet (a loss or push) the cap is a
// no-op. Used everywhere a `gross` value lands in the wallet.
function capWin(bet, gross) {
  if (!Number.isFinite(gross) || gross <= bet) return gross;
  return Math.min(gross, bet + QUICK_GAME_NET_WIN_CAP);
}
const COOLDOWN_KEY = (uid) => `gamecd:${uid}`;

// Returns { ok: true } if the cooldown is clear, or
// { ok: false, error: 'cooldown', cooldownMs, message } if still cooling.
// Pure read, does NOT extend the cooldown. Use cooldownTouch() to
// arm the next window AFTER a successful play.
export async function cooldownCheck(env, userId) {
  if (!env || !env.LOADOUT_BOLTS) return { ok: true };
  const raw = await env.LOADOUT_BOLTS.get(COOLDOWN_KEY(userId));
  if (!raw) return { ok: true };
  const until = Number(raw) || 0;
  const remain = until - Date.now();
  if (remain <= 0) return { ok: true };
  return {
    ok: false,
    error: 'cooldown',
    cooldownMs: remain,
    message: 'Slow down, wait ' + Math.ceil(remain / 1000) + 's between plays.',
  };
}

export async function cooldownTouch(env, userId, ms) {
  const until = Date.now() + (ms || COOLDOWN_MS);
  try {
    await env.LOADOUT_BOLTS.put(COOLDOWN_KEY(userId), String(until), { expirationTtl: 10 });
  } catch { /* best-effort */ }
  return until;
}

// PROGRESSION (P1), every quick-game play emits a played event +
// optionally a bigwin event if payout > 5× stake. Dedup keyed by a
// per-play synthetic id so concurrent plays in the same minute each
// count. Called from every game's payout path below.
export async function emitQuickGame(env, userId, guildId, kind, bet, gross) {
  try {
    const { emitProgressionEvent } = await import('./progression/event-bus.js');
    const playId = `${kind}:${userId}:${Date.now()}:${Math.floor(Math.random() * 1e6)}`;
    await emitProgressionEvent(env, {
      kind: 'quick.game.played', userId, guildId,
      meta: { game: kind, bet, gross, playId }, stableKeys: ['playId'],
    });
    if (bet > 0 && gross >= bet * 5) {
      await emitProgressionEvent(env, {
        kind: 'quick.game.bigwin', userId, guildId,
        meta: { game: kind, bet, gross, playId }, stableKeys: ['playId'],
      });
    }
  } catch { /* non-fatal */ }
  // Live-activity overlay: a quick game resolved. `gross` is the payout,
  // so net = gross - bet (a push reads as a tiny loss, which is fine for
  // an ambient feed). Resolve a real viewer name (chosen username / Patreon
  // / Discord / Twitch login) so the overlay shows who played.
  const viewer = await resolveActorName(env, guildId, userId).catch(() => null);
  await publishActivity(env, {
    kind: 'minigame.result', userId, viewer, game: kind,
    won: gross > bet, bet, payout: gross - bet,
  }).catch(() => {});
}

// ── Stateful-game session helpers ────────────────────────────────────
//
// Blackjack / Hi-Lo / Mines all keep multi-step state in KV:
//   gamestate:<kind>:<userId>  ->  JSON { ... }
// 30-minute TTL, long enough that a player can be afk, short enough
// that abandoned hands self-clean.

const SESSION_KEY = (kind, uid) => `gamestate:${kind}:${uid}`;
const SESSION_TTL_S = 30 * 60;

async function loadSession(env, kind, userId) {
  const raw = await env.LOADOUT_BOLTS.get(SESSION_KEY(kind, userId));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function saveSession(env, kind, userId, state) {
  await env.LOADOUT_BOLTS.put(
    SESSION_KEY(kind, userId),
    JSON.stringify(state),
    { expirationTtl: SESSION_TTL_S },
  );
}

async function clearSession(env, kind, userId) {
  try { await env.LOADOUT_BOLTS.delete(SESSION_KEY(kind, userId)); } catch { /* ignore */ }
}

// Common balance-shaped tail attached to every response.
async function withBalance(env, guildId, userId, body) {
  const w = await getWallet(env, guildId, userId);
  return { ...body, balance: w.balance || 0 };
}

// ── Blackjack ────────────────────────────────────────────────────────
//
// Standard rules, single deck, S17 (dealer stands on soft 17). No
// double/split for v1, keeps the UI + state minimal. Naturals (21
// from the first two cards) pay 3:2.

function blackjackTotal(cards) {
  let sum = 0;
  let aces = 0;
  for (const c of cards) {
    const r = c & 0xF;
    if (r === 0) { sum += 11; aces++; }
    else if (r >= 10) sum += 10;
    else sum += r + 1;
  }
  while (sum > 21 && aces > 0) { sum -= 10; aces--; }
  return sum;
}
function isNaturalBlackjack(cards) {
  return cards.length === 2 && blackjackTotal(cards) === 21;
}

export async function blackjackStart(env, guildId, userId, bet) {
  if (!Number.isFinite(bet) || bet <= 0) {
    return { ok: false, error: 'bad-bet', message: 'Bet must be a positive number.' };
  }
  // Refuse to start a second hand on top of an existing one, the
  // player has to finish or surrender first (surrender = stand at
  // current total for now).
  const existing = await loadSession(env, 'blackjack', userId);
  if (existing && !existing.finished) {
    return { ok: false, error: 'in-hand', message: 'Finish the current hand first.', state: existing };
  }

  const sp = await spend(env, guildId, userId, bet, 'blackjack:wager');
  if (!sp.ok) return { ok: false, error: 'insufficient', message: sp.reason };

  const deck = shuffle(makeDeck());
  const player = [deck.pop(), deck.pop()];
  const dealer = [deck.pop(), deck.pop()];
  const state = {
    bet, deck, player, dealer, finished: false, outcome: null, payout: 0,
    natural: isNaturalBlackjack(player),
  };

  if (state.natural) {
    // Player has a natural, settle immediately. Dealer also reveals;
    // if dealer also has natural, push (refund), else 3:2 win.
    return await blackjackResolve(env, guildId, userId, state);
  }
  await saveSession(env, 'blackjack', userId, state);
  return await withBalance(env, guildId, userId, {
    ok: true,
    phase: 'player',
    bet,
    player,
    dealer: [dealer[0], -1],          // hide dealer's hole card
    playerTotal: blackjackTotal(player),
    dealerShown: blackjackTotal([dealer[0]]),
  });
}

export async function blackjackHit(env, guildId, userId) {
  const state = await loadSession(env, 'blackjack', userId);
  if (!state || state.finished) {
    return { ok: false, error: 'no-hand', message: 'No hand in progress.' };
  }
  state.player.push(state.deck.pop());
  const total = blackjackTotal(state.player);
  if (total > 21) {
    state.finished = true;
    state.outcome = 'bust';
    state.payout = -state.bet;
    await clearSession(env, 'blackjack', userId);
    return await withBalance(env, guildId, userId, {
      ok: true,
      phase: 'done',
      bet: state.bet,
      player: state.player,
      dealer: state.dealer,
      playerTotal: total,
      dealerTotal: blackjackTotal(state.dealer),
      outcome: 'bust',
      payout: -state.bet,
      explanation: 'Bust at ' + total + '. Lost ' + state.bet + ' bolts.',
    });
  }
  await saveSession(env, 'blackjack', userId, state);
  return await withBalance(env, guildId, userId, {
    ok: true,
    phase: 'player',
    bet: state.bet,
    player: state.player,
    dealer: [state.dealer[0], -1],
    playerTotal: total,
    dealerShown: blackjackTotal([state.dealer[0]]),
  });
}

export async function blackjackStand(env, guildId, userId) {
  const state = await loadSession(env, 'blackjack', userId);
  if (!state || state.finished) {
    return { ok: false, error: 'no-hand', message: 'No hand in progress.' };
  }
  return await blackjackResolve(env, guildId, userId, state);
}

async function blackjackResolve(env, guildId, userId, state) {
  // Dealer draws to 17, stands on soft 17. (Hit-soft-17 is a worse
  // deal for the player; we use S17 to keep the EV friendly.)
  while (blackjackTotal(state.dealer) < 17) {
    state.dealer.push(state.deck.pop());
  }
  const pTotal = blackjackTotal(state.player);
  const dTotal = blackjackTotal(state.dealer);
  const dealerBust = dTotal > 21;
  const dealerNatural = isNaturalBlackjack(state.dealer);

  let outcome, gross, explanation;
  if (state.natural && dealerNatural) {
    outcome = 'push'; gross = state.bet;
    explanation = 'Both naturals, push. Bet refunded.';
  } else if (state.natural) {
    outcome = 'natural'; gross = Math.floor(state.bet * 2.5);
    explanation = 'Blackjack! Paid 3:2, +' + (gross - state.bet) + ' bolts.';
  } else if (dealerBust) {
    outcome = 'dealer-bust'; gross = state.bet * 2;
    explanation = 'Dealer busts at ' + dTotal + '. You win, +' + state.bet + ' bolts.';
  } else if (pTotal > dTotal) {
    outcome = 'win'; gross = state.bet * 2;
    explanation = 'You ' + pTotal + ' vs dealer ' + dTotal + '. +' + state.bet + ' bolts.';
  } else if (pTotal === dTotal) {
    outcome = 'push'; gross = state.bet;
    explanation = 'Push at ' + pTotal + '. Bet refunded.';
  } else {
    outcome = 'lose'; gross = 0;
    explanation = 'Dealer ' + dTotal + ' vs you ' + pTotal + '. Lost ' + state.bet + ' bolts.';
  }

  if (gross > 0) await earn(env, guildId, userId, capWin(state.bet, gross), 'blackjack:' + outcome);
  await emitQuickGame(env, userId, guildId, 'blackjack', state.bet, gross);
  state.finished = true;
  state.outcome = outcome;
  state.payout = gross - state.bet;
  await clearSession(env, 'blackjack', userId);

  return await withBalance(env, guildId, userId, {
    ok: true,
    phase: 'done',
    bet: state.bet,
    player: state.player,
    dealer: state.dealer,
    playerTotal: pTotal,
    dealerTotal: dTotal,
    outcome,
    payout: state.payout,
    explanation,
  });
}

// ── Roulette ────────────────────────────────────────────────────────
//
// European (single 0). One spin per call. Player picks a single bet
// type via `pick` field:
//   { kind: 'number',  number: 0..36 }     35:1
//   { kind: 'color',   color: 'red'|'black' } 1:1
//   { kind: 'parity',  parity: 'odd'|'even' } 1:1
//   { kind: 'range',   range: 'low'|'high' }  1:1 (low=1-18, high=19-36)
//   { kind: 'dozen',   dozen: 1|2|3 }         2:1
// 0 loses every outside bet.

const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

export async function roulette(env, guildId, userId, bet, pick) {
  if (!Number.isFinite(bet) || bet <= 0) {
    return { ok: false, error: 'bad-bet', message: 'Bet must be a positive number.' };
  }
  if (!pick || typeof pick !== 'object') {
    return { ok: false, error: 'bad-pick', message: 'Pick required.' };
  }
  const kind = String(pick.kind || '').toLowerCase();
  let payoutMult = 0;          // gross multiplier on win (bet already deducted)
  let pickLabel = '';
  if (kind === 'number') {
    const n = Number(pick.number);
    if (!Number.isInteger(n) || n < 0 || n > 36) {
      return { ok: false, error: 'bad-pick', message: 'Number must be 0-36.' };
    }
    payoutMult = 36; pickLabel = 'number ' + n; pick.value = n;
  } else if (kind === 'color') {
    if (pick.color !== 'red' && pick.color !== 'black') {
      return { ok: false, error: 'bad-pick', message: 'Color must be red or black.' };
    }
    payoutMult = 2; pickLabel = pick.color;
  } else if (kind === 'parity') {
    if (pick.parity !== 'odd' && pick.parity !== 'even') {
      return { ok: false, error: 'bad-pick', message: 'Parity must be odd or even.' };
    }
    payoutMult = 2; pickLabel = pick.parity;
  } else if (kind === 'range') {
    if (pick.range !== 'low' && pick.range !== 'high') {
      return { ok: false, error: 'bad-pick', message: 'Range must be low or high.' };
    }
    payoutMult = 2; pickLabel = pick.range + ' (' + (pick.range === 'low' ? '1-18' : '19-36') + ')';
  } else if (kind === 'dozen') {
    const d = Number(pick.dozen);
    if (d !== 1 && d !== 2 && d !== 3) {
      return { ok: false, error: 'bad-pick', message: 'Dozen must be 1, 2, or 3.' };
    }
    payoutMult = 3; pickLabel = 'dozen ' + d;
  } else {
    return { ok: false, error: 'bad-pick', message: 'Unknown pick kind.' };
  }

  const sp = await spend(env, guildId, userId, bet, 'roulette:wager');
  if (!sp.ok) return { ok: false, error: 'insufficient', message: sp.reason };

  const spin = rng(37);             // 0..36
  const color = spin === 0 ? 'green' : (RED_NUMBERS.has(spin) ? 'red' : 'black');
  const parity = spin === 0 ? null : (spin % 2 === 0 ? 'even' : 'odd');
  const range = spin === 0 ? null : (spin <= 18 ? 'low' : 'high');
  const dozen = spin === 0 ? 0 : Math.ceil(spin / 12);

  let win = false;
  if (kind === 'number') win = spin === Number(pick.number);
  else if (kind === 'color') win = pick.color === color;
  else if (kind === 'parity') win = pick.parity === parity;
  else if (kind === 'range') win = pick.range === range;
  else if (kind === 'dozen') win = Number(pick.dozen) === dozen;

  const gross = win ? bet * payoutMult : 0;
  if (gross > 0) await earn(env, guildId, userId, capWin(bet, gross), 'roulette:' + kind);
  await emitQuickGame(env, userId, guildId, 'roulette', bet, gross);

  return await withBalance(env, guildId, userId, {
    ok: true,
    won: win,
    spin,
    color,
    bet,
    payout: gross - bet,
    pick: pickLabel,
    explanation: win
      ? 'Landed on ' + spin + ' ' + color + ', you had ' + pickLabel + '. +' + (gross - bet) + ' bolts.'
      : 'Landed on ' + spin + ' ' + color + '. Lost ' + bet + ' bolts.',
  });
}

// ── Wheel ───────────────────────────────────────────────────────────
//
// Stake-style multiplier wheel. Risk selects the segment table:
// low  -> mostly small wins, no zero
// med  -> some zeros, bigger spikes
// high -> mostly zeros, occasional huge spike
// House EV is tuned ~95%, slight house edge, big swing.

const WHEEL_TABLES = {
  low:  [1.5, 1.2, 1.2, 0.0, 1.5, 1.2, 1.2, 0.0, 1.5, 1.2, 1.2, 2.0],
  med:  [0.0, 1.5, 0.0, 1.7, 0.0, 1.5, 0.0, 1.7, 0.0, 1.5, 0.0, 3.0],
  high: [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 9.9, 0.0, 0.0, 0.0, 0.0],
};

export async function wheel(env, guildId, userId, bet, risk) {
  if (!Number.isFinite(bet) || bet <= 0) {
    return { ok: false, error: 'bad-bet', message: 'Bet must be a positive number.' };
  }
  const r = String(risk || 'med').toLowerCase();
  const table = WHEEL_TABLES[r] || WHEEL_TABLES.med;

  const sp = await spend(env, guildId, userId, bet, 'wheel:wager');
  if (!sp.ok) return { ok: false, error: 'insufficient', message: sp.reason };

  const idx = rng(table.length);
  const mult = table[idx];
  const gross = Math.floor(bet * mult);
  if (gross > 0) await earn(env, guildId, userId, capWin(bet, gross), 'wheel:' + r);
  await emitQuickGame(env, userId, guildId, 'wheel', bet, gross);

  return await withBalance(env, guildId, userId, {
    ok: true,
    won: gross > bet,
    bet,
    risk: r,
    segments: table,
    landed: idx,
    multiplier: mult,
    payout: gross - bet,
    explanation: mult <= 0
      ? 'Wheel stopped on 0×, lost ' + bet + ' bolts.'
      : 'Wheel stopped on ' + mult + '×, ' + (gross > bet ? '+' : '') + (gross - bet) + ' bolts.',
  });
}

// ── Higher / Lower ──────────────────────────────────────────────────
//
// Card-strength comparison. Ace = 1, K = 13. On each guess we deal
// from the same deck (no replacement) so the multiplier reflects
// actual odds. Correct → multiplier compounds by 1/probability *
// 0.95 (5% rake). Wrong → bust, lose stake. Cashout pays bet * mult.

function cardValue(c) { return (c & 0xF) + 1; }   // 1..13 (A..K)

function hiloMultiplier(currentVal, guess, deckRemaining) {
  // Probability of winning the next guess (excluding ties, which we
  // treat as PUSH = re-deal; multiplier doesn't tick for a tie).
  let winners = 0;
  let total = 0;
  for (const c of deckRemaining) {
    const v = cardValue(c);
    if (v === currentVal) continue;
    total++;
    if (guess === 'higher' && v > currentVal) winners++;
    if (guess === 'lower' && v < currentVal) winners++;
  }
  if (total === 0 || winners === 0) return 0;
  // 5% rake on the fair multiplier.
  return Math.max(1.01, (total / winners) * 0.95);
}

export async function hiloStart(env, guildId, userId, bet) {
  if (!Number.isFinite(bet) || bet <= 0) {
    return { ok: false, error: 'bad-bet', message: 'Bet must be a positive number.' };
  }
  const existing = await loadSession(env, 'hilo', userId);
  if (existing && !existing.finished) {
    return { ok: false, error: 'in-hand', message: 'Finish the current run first.', state: existing };
  }
  const sp = await spend(env, guildId, userId, bet, 'hilo:wager');
  if (!sp.ok) return { ok: false, error: 'insufficient', message: sp.reason };

  const deck = shuffle(makeDeck());
  const first = deck.pop();
  const state = {
    bet, deck, current: first, multiplier: 1, steps: 0,
    finished: false, history: [first],
  };
  await saveSession(env, 'hilo', userId, state);
  return await withBalance(env, guildId, userId, {
    ok: true,
    phase: 'play',
    bet, current: first, multiplier: 1, steps: 0,
    history: [first],
    // pre-compute the win prob hint for the UI
    higherProb: countMatching(deck, (v) => v > cardValue(first)) / deck.length,
    lowerProb: countMatching(deck, (v) => v < cardValue(first)) / deck.length,
  });
}

function countMatching(deck, pred) {
  let n = 0;
  for (const c of deck) if (pred(cardValue(c))) n++;
  return n;
}

export async function hiloGuess(env, guildId, userId, guess) {
  const state = await loadSession(env, 'hilo', userId);
  if (!state || state.finished) {
    return { ok: false, error: 'no-hand', message: 'No run in progress.' };
  }
  if (guess !== 'higher' && guess !== 'lower') {
    return { ok: false, error: 'bad-guess', message: 'Guess must be higher or lower.' };
  }
  if (!state.deck.length) {
    // Edge case: empty deck, treat as cashout.
    return await hiloCashout(env, guildId, userId);
  }
  const next = state.deck.pop();
  state.history.push(next);
  state.steps++;
  const cv = cardValue(state.current);
  const nv = cardValue(next);
  if (nv === cv) {
    // tie, push, no change to multiplier, deal again
    state.current = next;
    await saveSession(env, 'hilo', userId, state);
    return await withBalance(env, guildId, userId, {
      ok: true,
      phase: 'play',
      tie: true,
      bet: state.bet,
      current: state.current,
      multiplier: state.multiplier,
      steps: state.steps,
      history: state.history,
      explanation: 'Tie, push, free re-deal.',
    });
  }
  const correct = (guess === 'higher' && nv > cv) || (guess === 'lower' && nv < cv);
  if (!correct) {
    state.finished = true;
    state.outcome = 'bust';
    state.payout = -state.bet;
    await clearSession(env, 'hilo', userId);
    return await withBalance(env, guildId, userId, {
      ok: true,
      phase: 'done',
      bet: state.bet,
      current: next,
      previous: state.current,
      multiplier: 0,
      steps: state.steps,
      history: state.history,
      outcome: 'bust',
      payout: -state.bet,
      explanation: 'Wrong! ' + cardLabel(next) + ' is ' + (nv > cv ? 'higher' : 'lower') + '. Lost ' + state.bet + ' bolts.',
    });
  }
  // Correct, bump multiplier using the BEFORE-deal probability.
  const mult = hiloMultiplier(cv, guess, state.deck.concat([next]));
  state.multiplier = state.multiplier * mult;
  state.current = next;
  await saveSession(env, 'hilo', userId, state);
  return await withBalance(env, guildId, userId, {
    ok: true,
    phase: 'play',
    bet: state.bet,
    current: next,
    previous: cv,
    multiplier: state.multiplier,
    steps: state.steps,
    history: state.history,
    higherProb: countMatching(state.deck, (v) => v > nv) / Math.max(1, state.deck.length),
    lowerProb: countMatching(state.deck, (v) => v < nv) / Math.max(1, state.deck.length),
    explanation: 'Right! ' + cardLabel(next) + ' is ' + guess + '. Multiplier ' + state.multiplier.toFixed(2) + '×.',
  });
}

export async function hiloCashout(env, guildId, userId) {
  const state = await loadSession(env, 'hilo', userId);
  if (!state || state.finished) {
    return { ok: false, error: 'no-hand', message: 'No run to cash out.' };
  }
  if (state.steps < 1) {
    return { ok: false, error: 'too-early', message: 'Make at least one correct guess first.' };
  }
  const gross = Math.floor(state.bet * state.multiplier);
  await earn(env, guildId, userId, capWin(state.bet, gross), 'hilo:cashout');
  await emitQuickGame(env, userId, guildId, 'hilo', state.bet, gross);
  state.finished = true;
  state.outcome = 'cashout';
  state.payout = gross - state.bet;
  await clearSession(env, 'hilo', userId);
  return await withBalance(env, guildId, userId, {
    ok: true,
    phase: 'done',
    bet: state.bet,
    multiplier: state.multiplier,
    steps: state.steps,
    history: state.history,
    outcome: 'cashout',
    payout: state.payout,
    explanation: 'Cashed out at ' + state.multiplier.toFixed(2) + '×, +' + (gross - state.bet) + ' bolts.',
  });
}

// ── Mines ───────────────────────────────────────────────────────────
//
// 5×5 grid, 1..24 bombs. Reveal safe tiles to compound a multiplier.
// Cash out at any time. Hit a bomb → lose. The multiplier is the
// EV-fair "no-edge" multiplier with a small rake.

const MINES_GRID_SIZE = 25;
const MINES_RAKE = 0.97;

function minesPayoutMultiplier(bombs, revealed) {
  // Fair multiplier = C(N, revealed) / C(N-bombs, revealed)
  // Closed-form using the safe-tile-by-safe-tile probability ratio.
  let m = 1;
  for (let i = 0; i < revealed; i++) {
    const remainingTiles = MINES_GRID_SIZE - i;
    const remainingSafe = (MINES_GRID_SIZE - bombs) - i;
    if (remainingSafe <= 0) return 0;
    m *= remainingTiles / remainingSafe;
  }
  return m * MINES_RAKE;
}

export async function minesStart(env, guildId, userId, bet, bombs) {
  if (!Number.isFinite(bet) || bet <= 0) {
    return { ok: false, error: 'bad-bet', message: 'Bet must be a positive number.' };
  }
  if (!Number.isInteger(bombs) || bombs < 1 || bombs > 24) {
    return { ok: false, error: 'bad-bombs', message: 'Bombs must be 1-24.' };
  }
  const existing = await loadSession(env, 'mines', userId);
  if (existing && !existing.finished) {
    return { ok: false, error: 'in-hand', message: 'Cash out or bust the current run first.', state: existing };
  }
  const sp = await spend(env, guildId, userId, bet, 'mines:wager');
  if (!sp.ok) return { ok: false, error: 'insufficient', message: sp.reason };

  // Server-side bomb layout, never sent to the client.
  const positions = Array.from({ length: MINES_GRID_SIZE }, (_, i) => i);
  for (let i = positions.length - 1; i > 0; i--) {
    const j = rng(i + 1);
    [positions[i], positions[j]] = [positions[j], positions[i]];
  }
  const bombSet = positions.slice(0, bombs);

  const state = {
    bet, bombs, bombSet, revealed: [], finished: false, multiplier: 1,
  };
  await saveSession(env, 'mines', userId, state);
  return await withBalance(env, guildId, userId, {
    ok: true,
    phase: 'play',
    bet, bombs,
    revealed: [],
    multiplier: 1,
    nextMultiplier: minesPayoutMultiplier(bombs, 1),
  });
}

export async function minesReveal(env, guildId, userId, tile) {
  const state = await loadSession(env, 'mines', userId);
  if (!state || state.finished) {
    return { ok: false, error: 'no-hand', message: 'No run in progress.' };
  }
  const t = Number(tile);
  if (!Number.isInteger(t) || t < 0 || t >= MINES_GRID_SIZE) {
    return { ok: false, error: 'bad-tile', message: 'Tile must be 0-' + (MINES_GRID_SIZE - 1) + '.' };
  }
  if (state.revealed.includes(t)) {
    return { ok: false, error: 'already-revealed', message: 'Already revealed that tile.' };
  }
  if (state.bombSet.includes(t)) {
    state.finished = true;
    state.outcome = 'bust';
    state.payout = -state.bet;
    await clearSession(env, 'mines', userId);
    return await withBalance(env, guildId, userId, {
      ok: true,
      phase: 'done',
      bet: state.bet,
      bombs: state.bombs,
      revealed: state.revealed,
      bombTile: t,
      bombSet: state.bombSet,
      outcome: 'bust',
      payout: -state.bet,
      explanation: '💥 Bomb! Lost ' + state.bet + ' bolts.',
    });
  }
  state.revealed.push(t);
  const m = minesPayoutMultiplier(state.bombs, state.revealed.length);
  state.multiplier = m;
  await saveSession(env, 'mines', userId, state);
  return await withBalance(env, guildId, userId, {
    ok: true,
    phase: 'play',
    bet: state.bet,
    bombs: state.bombs,
    revealed: state.revealed,
    lastTile: t,
    multiplier: m,
    nextMultiplier: minesPayoutMultiplier(state.bombs, state.revealed.length + 1),
  });
}

export async function minesCashout(env, guildId, userId) {
  const state = await loadSession(env, 'mines', userId);
  if (!state || state.finished) {
    return { ok: false, error: 'no-hand', message: 'No run to cash out.' };
  }
  if (state.revealed.length < 1) {
    return { ok: false, error: 'too-early', message: 'Reveal at least one safe tile first.' };
  }
  const gross = Math.floor(state.bet * state.multiplier);
  await earn(env, guildId, userId, capWin(state.bet, gross), 'mines:cashout');
  await emitQuickGame(env, userId, guildId, 'mines', state.bet, gross);
  state.finished = true;
  state.outcome = 'cashout';
  state.payout = gross - state.bet;
  await clearSession(env, 'mines', userId);
  return await withBalance(env, guildId, userId, {
    ok: true,
    phase: 'done',
    bet: state.bet,
    bombs: state.bombs,
    revealed: state.revealed,
    bombSet: state.bombSet,
    multiplier: state.multiplier,
    outcome: 'cashout',
    payout: state.payout,
    explanation: 'Cashed out at ' + state.multiplier.toFixed(2) + '×, +' + (gross - state.bet) + ' bolts.',
  });
}

// ── Plinko ──────────────────────────────────────────────────────────
//
// 12-row board, server simulates the ball. Each level is a 50/50 L/R
// flip; final-bin multiplier comes from PLINKO_TABLES[risk]. We send
// the path back so the UI can animate it.

const PLINKO_ROWS = 12;

const PLINKO_TABLES = {
  low:  [10, 3, 1.5, 1, 0.7, 0.5, 0.4, 0.5, 0.7, 1, 1.5, 3, 10],
  med:  [33, 11, 4, 2, 1.1, 0.5, 0.3, 0.5, 1.1, 2, 4, 11, 33],
  high: [141, 25, 8, 3, 1.5, 0.3, 0.2, 0.3, 1.5, 3, 8, 25, 141],
};

export async function plinko(env, guildId, userId, bet, risk) {
  if (!Number.isFinite(bet) || bet <= 0) {
    return { ok: false, error: 'bad-bet', message: 'Bet must be a positive number.' };
  }
  const r = String(risk || 'med').toLowerCase();
  const table = PLINKO_TABLES[r] || PLINKO_TABLES.med;

  const sp = await spend(env, guildId, userId, bet, 'plinko:wager');
  if (!sp.ok) return { ok: false, error: 'insufficient', message: sp.reason };

  const path = [];
  let pos = 0;
  for (let i = 0; i < PLINKO_ROWS; i++) {
    const right = rng(2);
    path.push(right);
    pos += right;
  }
  const mult = table[pos];
  const gross = Math.floor(bet * mult);
  if (gross > 0) await earn(env, guildId, userId, capWin(bet, gross), 'plinko:' + r);
  await emitQuickGame(env, userId, guildId, 'plinko', bet, gross);

  return await withBalance(env, guildId, userId, {
    ok: true,
    won: gross > bet,
    bet, risk: r,
    rows: PLINKO_ROWS,
    table,
    path,
    landed: pos,
    multiplier: mult,
    payout: gross - bet,
    explanation: mult <= 0
      ? 'Hit ' + mult + '×, lost ' + bet + ' bolts.'
      : 'Hit ' + mult + '×, ' + (gross > bet ? '+' : '') + (gross - bet) + ' bolts.',
  });
}

// ── Crash ───────────────────────────────────────────────────────────
//
// Player picks an auto-cashout multiplier; server picks a bust point.
// If bust >= cashout, payout = bet * cashout. Otherwise bust = lose.
// Bust distribution:
//   - 4% instant bust at 1.00× (matches Stake's "house edge" turn)
//   - else: bust = 0.99 / (1 - r)   with r uniform in (0, 1)
//     => median ≈ 1.97, heavy tail. House edge ≈ 1%.

// ── Snapshot ────────────────────────────────────────────────────────
//
// One read for the /play games surface, returns the active state of
// every stateful game (blackjack/hilo/mines) so the UI can resume an
// in-progress hand on reload.

export async function quickGamesSnapshot(env, guildId, userId) {
  const [bj, hl, mn, cd, w] = await Promise.all([
    loadSession(env, 'blackjack', userId),
    loadSession(env, 'hilo', userId),
    loadSession(env, 'mines', userId),
    env.LOADOUT_BOLTS.get(COOLDOWN_KEY(userId)),
    getWallet(env, guildId, userId),
  ]);
  return {
    ok: true,
    balance: w.balance || 0,
    cooldownUntil: cd ? Number(cd) || 0 : 0,
    sessions: {
      blackjack: bj && !bj.finished ? sanitizeBlackjack(bj) : null,
      hilo: hl && !hl.finished ? sanitizeHilo(hl) : null,
      mines: mn && !mn.finished ? sanitizeMines(mn) : null,
    },
  };
}

function sanitizeBlackjack(s) {
  return {
    bet: s.bet,
    player: s.player,
    dealer: [s.dealer[0], -1],
    playerTotal: blackjackTotal(s.player),
    dealerShown: blackjackTotal([s.dealer[0]]),
  };
}
function sanitizeHilo(s) {
  return { bet: s.bet, current: s.current, multiplier: s.multiplier, steps: s.steps, history: s.history };
}
function sanitizeMines(s) {
  return { bet: s.bet, bombs: s.bombs, revealed: s.revealed, multiplier: s.multiplier };
}

// PROGRESSION (P2), quick-games headline. Cooldown KV doesn't keep
// long-term state; we approximate by counting session ids. The
// achievement engine in P3 will track exact plays via the event log.
export async function getStatsFor(env, userId, _guildId = null) {
  // Quick-games are mostly stateless once a hand resolves, there's
  // no persistent counter to read. Surface the cooldown state + a
  // placeholder until P3 lands the event-driven counters.
  const cd = await cooldownCheck(env, userId);
  return {
    primary: { label: 'Quick games', value: 'see ach.' },
    secondary: [
      { label: 'On cooldown', value: cd.ok ? 'no' : 'yes' },
    ],
    iconKind: 'quick-dice',
  };
}
