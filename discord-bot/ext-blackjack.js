// Server-authoritative in-panel Blackjack for the Aquilo Twitch extension.
//
// One hand at a time per viewer per channel. The shoe and the dealer hole
// card exist ONLY here in the Worker — the panel (public/twitch-panel/
// panel.js, renderBlackjack) only ever sees the player's full hand plus the
// dealer UP-card until the hand resolves; on resolve we reveal the dealer's
// whole hand. Deal debits the bet; a win pays 2x back (net +bet), a natural
// blackjack pays 3:2, a push refunds the bet, and double doubles the wager,
// draws exactly one card, then auto-stands.
//
// Routes (sub = the action after /ext/blackjack/):
//   GET  /ext/blackjack/state   -> { wallet, game|null }
//   POST /ext/blackjack/deal    -> live game | resolved hand
//   POST /ext/blackjack/hit     -> live game | resolved hand (on bust)
//   POST /ext/blackjack/stand   -> resolved hand
//   POST /ext/blackjack/double  -> resolved hand
//
// Card string encoding matches bjCardSpan(): a single rank char + a lowercase
// suit char, e.g. "As", "Th" (T = ten), "Kd", "2c". Suits s/h/d/c. "??" is the
// hidden hole card the frontend renders as a card back — we never send the
// real hole card until resolve.
//
// `guildId`/`userId` arrive ALREADY per-channel (resolved by nsFor() in ext.js)
// — use them as-is, never re-derive. The in-progress hand lives at
// bj:<guildId>:<userId> in env.LOADOUT_BOLTS and is deleted on resolve.

import { earn, spend } from './wallet.js';
import { walletView } from './ext-econ.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({}, CORS, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    }),
  });
}

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];
const SUITS = ['s', 'h', 'd', 'c'];
const MIN_BET = 5;
const MAX_BET = 1000;

function keyFor(guildId, userId) {
  return `bj:${guildId}:${userId}`;
}

// Fresh single-deck shoe, Fisher–Yates shuffled. Real Worker runtime, so
// Math.random()/Date.now() are fine.
function freshShoe() {
  const deck = [];
  for (const r of RANKS) for (const s of SUITS) deck.push(r + s);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = deck[i]; deck[i] = deck[j]; deck[j] = t;
  }
  return deck;
}

// Best total for a hand, plus whether it is "soft" (an ace still counting 11).
function handValue(cards) {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    const r = c.slice(0, 1);
    if (r === 'A') { aces++; total += 11; }
    else if (r === 'T' || r === 'J' || r === 'Q' || r === 'K') total += 10;
    else total += Number(r);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  const soft = aces > 0; // an ace is still valued at 11
  return { total, soft };
}

function isBlackjack(cards) {
  if (cards.length !== 2) return false;
  return handValue(cards).total === 21;
}

function toBet(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (i !== n) return null; // reject non-integer bets
  if (i < MIN_BET || i > MAX_BET) return null;
  return i;
}

// Public view of a live hand — player's cards + dealer UP-card only. The hole
// card and the remaining shoe never leave the worker until the hand resolves.
function liveGame(g, balance) {
  const pv = handValue(g.player);
  return {
    gameId: g.gameId,
    phase: 'player',
    bet: g.bet,
    doubled: !!g.doubled,
    dealerUp: g.dealer[0],
    player: g.player,
    playerTotal: pv.total,
    playerSoft: pv.soft,
    canDouble: g.player.length === 2 && !g.doubled && balance >= g.bet,
  };
}

// Resolve payout for a finished hand. `wager` is the total at risk (bet, or
// 2*bet when doubled). Returns { outcome, net } and applies the wallet credit.
async function settlePayout(env, guildId, userId, outcome, wager, bet) {
  let net;
  if (outcome === 'blackjack') {
    // Natural 21 pays 3:2 (wager is always the base bet here).
    net = Math.floor(bet * 3 / 2);
    await earn(env, guildId, userId, bet + net, 'blackjack:natural');
  } else if (outcome === 'win') {
    net = wager;                       // pays 2x wager back -> net +wager
    await earn(env, guildId, userId, wager * 2, 'blackjack:win');
  } else if (outcome === 'push') {
    net = 0;
    await earn(env, guildId, userId, wager, 'blackjack:push'); // refund
  } else {
    net = -wager;                      // 'bust' | 'dealer' — bet already gone
  }
  return { outcome, net };
}

async function doneResponse(env, guildId, userId, g, outcome) {
  const wager = g.doubled ? g.bet * 2 : g.bet;
  const { net } = await settlePayout(env, guildId, userId, outcome, wager, g.bet);
  await env.LOADOUT_BOLTS.delete(keyFor(guildId, userId));
  const pv = handValue(g.player);
  const dv = handValue(g.dealer);
  const wallet = await walletView(env, guildId, userId);
  return json({
    phase: 'done',
    outcome,
    player: g.player,
    playerTotal: pv.total,
    dealer: g.dealer,       // full reveal, including the hole card
    dealerTotal: dv.total,
    net,
    wallet,
  });
}

// Dealer draws to completion: hits until >= 17, stands on all 17s (incl. soft).
function dealerPlay(g) {
  let v = handValue(g.dealer);
  while (v.total < 17) {
    g.dealer.push(g.deck.pop());
    v = handValue(g.dealer);
  }
}

export async function handleBlackjack(env, guildId, userId, sub, req, meta) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const key = keyFor(guildId, userId);

  // ── state ──────────────────────────────────────────────────────────────
  if (sub === 'state') {
    const g = await env.LOADOUT_BOLTS.get(key, { type: 'json' });
    const wallet = await walletView(env, guildId, userId);
    const game = (g && g.phase === 'player') ? liveGame(g, wallet.balance) : null;
    return json({ wallet, game });
  }

  const body = await req.json().catch(() => ({}));

  // ── deal ───────────────────────────────────────────────────────────────
  if (sub === 'deal') {
    const existing = await env.LOADOUT_BOLTS.get(key, { type: 'json' });
    if (existing && existing.phase === 'player') {
      const wallet = await walletView(env, guildId, userId);
      return json({ error: 'in-progress', message: 'Finish your current hand first.', game: liveGame(existing, wallet.balance), wallet }, 200);
    }

    const bet = toBet(body.bet);
    if (bet === null) {
      const wallet = await walletView(env, guildId, userId);
      return json({ error: 'bad-bet', message: 'Bet must be a whole number from 5 to 1000 Bolts.', wallet }, 400);
    }

    const debit = await spend(env, guildId, userId, bet, 'blackjack:bet');
    if (!debit.ok) {
      const wallet = await walletView(env, guildId, userId);
      return json({ error: 'insufficient', message: 'Not enough Bolts.', wallet }, 400);
    }

    const deck = freshShoe();
    const player = [deck.pop(), deck.pop()];
    const dealer = [deck.pop(), deck.pop()]; // [0]=up, [1]=hole

    const g = {
      gameId: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      bet,
      doubled: false,
      phase: 'player',
      deck,
      player,
      dealer,
      createdUtc: Date.now(),
    };

    const playerBJ = isBlackjack(player);
    const dealerBJ = isBlackjack(dealer);
    if (playerBJ || dealerBJ) {
      let outcome;
      if (playerBJ && dealerBJ) outcome = 'push';
      else if (playerBJ) outcome = 'blackjack';
      else outcome = 'dealer';
      // No need to persist — settle immediately and reveal the dealer.
      return await doneResponse(env, guildId, userId, g, outcome);
    }

    await env.LOADOUT_BOLTS.put(key, JSON.stringify(g));
    const wallet = await walletView(env, guildId, userId);
    return json({ game: liveGame(g, wallet.balance), wallet });
  }

  // ── hit / stand / double all need a live hand ────────────────────────────
  const g = await env.LOADOUT_BOLTS.get(key, { type: 'json' });
  if (!g || g.phase !== 'player') {
    const wallet = await walletView(env, guildId, userId);
    return json({ error: 'no-hand', message: 'No hand in progress — deal first.', game: null, wallet }, 400);
  }

  if (sub === 'hit') {
    g.player.push(g.deck.pop());
    if (handValue(g.player).total > 21) {
      return await doneResponse(env, guildId, userId, g, 'bust');
    }
    await env.LOADOUT_BOLTS.put(key, JSON.stringify(g));
    const wallet = await walletView(env, guildId, userId);
    return json({ game: liveGame(g, wallet.balance), wallet });
  }

  if (sub === 'stand') {
    dealerPlay(g);
    const p = handValue(g.player).total;
    const d = handValue(g.dealer).total;
    let outcome;
    if (d > 21) outcome = 'win';
    else if (p > d) outcome = 'win';
    else if (p < d) outcome = 'dealer';
    else outcome = 'push';
    return await doneResponse(env, guildId, userId, g, outcome);
  }

  if (sub === 'double') {
    if (g.player.length !== 2 || g.doubled) {
      const wallet = await walletView(env, guildId, userId);
      return json({ error: 'cant-double', message: 'You can only double on your first two cards.', game: liveGame(g, wallet.balance), wallet }, 400);
    }
    const debit = await spend(env, guildId, userId, g.bet, 'blackjack:double');
    if (!debit.ok) {
      const wallet = await walletView(env, guildId, userId);
      return json({ error: 'insufficient', message: 'Not enough Bolts to double.', game: liveGame(g, wallet.balance), wallet }, 400);
    }
    g.doubled = true;
    g.player.push(g.deck.pop());
    if (handValue(g.player).total > 21) {
      return await doneResponse(env, guildId, userId, g, 'bust');
    }
    // Auto-stand after the single double card.
    dealerPlay(g);
    const p = handValue(g.player).total;
    const d = handValue(g.dealer).total;
    let outcome;
    if (d > 21) outcome = 'win';
    else if (p > d) outcome = 'win';
    else if (p < d) outcome = 'dealer';
    else outcome = 'push';
    return await doneResponse(env, guildId, userId, g, outcome);
  }

  return json({ error: 'not-found' }, 404);
}
