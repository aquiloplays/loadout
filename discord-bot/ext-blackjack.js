// Bolts blackjack for the Twitch panel (/ext/blackjack/*).
//
// Worker-AUTHORITATIVE: the shoe is shuffled + dealt server-side and the game
// state (including the dealer hole card + remaining deck) lives ONLY in KV —
// the client is sent the player's cards + the dealer's UP card during play, and
// the dealer hand is revealed only once the hand is over. Bets settle the same
// shared Bolts wallet the casino uses (ext-casino.js settle()).
//
// Rules (v1): 1 fresh 52-card deck per hand, dealer STANDS on all 17 (S17),
// blackjack (natural 21) pays 3:2, regular win pays 1:1, push refunds, double
// (first action only) doubles the bet for exactly one more card then stands.
// No split / insurance in v1. Standard S17/3:2 is a thin ~0.5% house edge, so
// blackjack drains Bolts slowly rather than inflating them.
//
// Identity/economy mirror the casino: userId = tw:<twitchId>; opaque-id viewers
// may play (only the daily faucet is identity-gated). Bet limits + settle come
// from ext-casino.js so the two games stay consistent.

import { json, debounced } from './ext-shared.js';
import { getWallet } from './wallet.js';
import { settle, parseBet, walletView, announce, cleanName } from './ext-casino.js';

const STATE_KEY = (g, u) => `blackjack:${g}:${u}`;
const STATE_TTL = 600;               // 10 min — an abandoned hand self-cleans
const ANNOUNCE_NET = 500;            // announce wins with net >= this

// ── Cards ────────────────────────────────────────────────────────────
// A card is a 2-char string: rank(A,2..9,T,J,Q,K) + suit(s,h,d,c).
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];
const SUITS = ['s', 'h', 'd', 'c'];

function freshDeck() {
  const d = [];
  for (const r of RANKS) for (const s of SUITS) d.push(r + s);
  return d;
}

// Cryptographic Fisher–Yates — a card shoe is predictable enough that we harden
// the RNG beyond the casino's Math.random single-roll outcomes.
function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    // Unbiased index in [0, i] via rejection sampling on a 32-bit draw.
    const max = i + 1;
    const limit = Math.floor(0x100000000 / max) * max;
    let x;
    const buf = new Uint32Array(1);
    do { crypto.getRandomValues(buf); x = buf[0]; } while (x >= limit);
    const j = x % max;
    const t = deck[i]; deck[i] = deck[j]; deck[j] = t;
  }
  return deck;
}

function cardValue(rank) {
  if (rank === 'A') return 11;
  if (rank === 'T' || rank === 'J' || rank === 'Q' || rank === 'K') return 10;
  return Number(rank);
}

// Best total with soft-ace handling; also reports whether the hand is "soft".
function handTotal(cards) {
  let total = 0, aces = 0;
  for (const c of cards) {
    const v = cardValue(c[0]);
    total += v;
    if (c[0] === 'A') aces++;
  }
  let soft = aces > 0;
  while (total > 21 && aces > 0) { total -= 10; aces--; }   // demote aces 11→1
  if (aces === 0) soft = false;
  return { total, soft: soft && total <= 21 };
}

function isBlackjack(cards) {
  return cards.length === 2 && handTotal(cards).total === 21;
}

// What the client is allowed to see WHILE the hand is live: its own cards + the
// dealer's up-card only (hole card + remaining deck stay server-side).
function liveView(g) {
  const pt = handTotal(g.player);
  return {
    gameId: g.gameId,
    bet: g.bet,
    doubled: !!g.doubled,
    phase: g.phase,
    player: g.player,
    playerTotal: pt.total,
    playerSoft: pt.soft,
    dealerUp: g.dealer[0],
    canDouble: g.phase === 'player' && g.player.length === 2 && !g.doubled,
  };
}

// Full reveal once the hand is over.
function finalView(g, outcome, payout, net) {
  const pt = handTotal(g.player);
  const dt = handTotal(g.dealer);
  return {
    gameId: g.gameId,
    bet: g.bet,
    doubled: !!g.doubled,
    phase: 'done',
    player: g.player,
    playerTotal: pt.total,
    dealer: g.dealer,
    dealerTotal: dt.total,
    outcome,          // 'blackjack' | 'win' | 'push' | 'lose' | 'bust'
    payout,           // total Bolts credited back (0 on loss)
    net,              // payout - totalStaked
  };
}

async function loadGame(env, guildId, userId) {
  try { return await env.LOADOUT_BOLTS.get(STATE_KEY(guildId, userId), { type: 'json' }); }
  catch { return null; }
}
async function saveGame(env, guildId, userId, g) {
  await env.LOADOUT_BOLTS.put(STATE_KEY(guildId, userId), JSON.stringify(g), { expirationTtl: STATE_TTL });
}
async function clearGame(env, guildId, userId) {
  try { await env.LOADOUT_BOLTS.delete(STATE_KEY(guildId, userId)); return true; }
  catch { return false; }
}

// Resolve a finished/standing hand: dealer draws to S17, compute payout, credit,
// clear state. `staked` = total Bolts already debited (bet, doubled = 2×bet).
async function resolve(env, ctx, guildId, userId, g, chanId, who) {
  const staked = g.bet * (g.doubled ? 2 : 1);
  const pt = handTotal(g.player).total;
  const playerBJ = isBlackjack(g.player) && !g.doubled;   // natural (2-card 21)
  const dealerBJ = isBlackjack(g.dealer);

  let outcome, payoutMult;
  if (pt > 21) {
    // Player bust — immediate loss; the dealer needn't draw.
    outcome = 'bust'; payoutMult = 0;
  } else if (playerBJ || dealerBJ) {
    // Naturals settle immediately (a natural beats a dealer's drawn-to 21).
    if (playerBJ && dealerBJ) { outcome = 'push'; payoutMult = 1; }
    else if (playerBJ) { outcome = 'blackjack'; payoutMult = 2.5; }   // 3:2
    else { outcome = 'lose'; payoutMult = 0; }                        // dealer natural
  } else {
    // Dealer plays: hit until 17+ (stands on all 17, incl. soft 17).
    while (handTotal(g.dealer).total < 17) g.dealer.push(g.deck.pop());
    const dt = handTotal(g.dealer).total;
    if (dt > 21) { outcome = 'win'; payoutMult = 2; }
    else if (pt > dt) { outcome = 'win'; payoutMult = 2; }
    else if (pt === dt) { outcome = 'push'; payoutMult = 1; }
    else { outcome = 'lose'; payoutMult = 0; }
  }

  const payout = Math.floor(staked * payoutMult);
  // Idempotency: remove the hand BEFORE crediting. Only credit if the delete
  // committed — so if a KV delete flakes and the client re-sends the terminal
  // action, the payout settles exactly once (on the attempt whose delete
  // succeeds), never twice. A resolved+cleared hand reads as 'no-hand' on retry.
  const cleared = await clearGame(env, guildId, userId);
  if (!cleared) {
    return json({ error: 'retry', message: 'Finishing that hand — give it a second.' }, 503);
  }
  // Credit-only leg: the stake was already debited on deal/double, so settle
  // with bet=0 and just credit the payout.
  const r = payout > 0 ? await settle(env, guildId, userId, 0, payout, 'blackjack') : null;
  const w = r && r.ok ? r.wallet : await getWallet(env, guildId, userId);
  const net = payout - staked;
  if (net >= ANNOUNCE_NET) {
    announce(env, ctx, chanId, `🃏 ${who} won +${net} Bolts at blackjack${outcome === 'blackjack' ? ' with a natural 21!' : '!'}`);
  }
  return json({ ok: true, ...finalView(g, outcome, payout, net), wallet: walletView(w) });
}

export async function handleExtBlackjack(env, ctx, guildId, userId, payload, sub, req) {
  const chanId = payload && payload.channel_id;

  // GET /ext/blackjack/state — resume a live hand (or report none).
  if (req.method === 'GET' && sub === 'state') {
    const g = await loadGame(env, guildId, userId);
    const w = await getWallet(env, guildId, userId);
    if (!g || g.phase !== 'player') return json({ ok: true, game: null, wallet: walletView(w) });
    return json({ ok: true, game: liveView(g), wallet: walletView(w) });
  }

  if (req.method !== 'POST') return json({ error: 'not-found' }, 404);
  let body = {}; try { body = await req.json(); } catch { body = {}; }
  const who = cleanName(body.name) || 'Someone';

  // Per-viewer rate-limit on every mutating action.
  if (await debounced(env, 'blackjack', guildId, userId)) {
    const w = await getWallet(env, guildId, userId);
    return json({ error: 'slow-down', message: 'One move at a time.', wallet: walletView(w) }, 429);
  }

  // ── Deal a new hand ────────────────────────────────────────────────
  if (sub === 'deal') {
    const existing = await loadGame(env, guildId, userId);
    if (existing && existing.phase === 'player') {
      return json({ error: 'in-progress', message: 'Finish your current hand first.', game: liveView(existing) }, 409);
    }
    const w0 = await getWallet(env, guildId, userId);
    const p = parseBet(body, w0.balance || 0);
    if (p.err) return json({ error: 'bad-bet', message: p.err, wallet: walletView(w0) }, 400);

    // Debit the stake up front so it's committed server-side.
    const r = await settle(env, guildId, userId, p.bet, 0, 'blackjack');
    if (!r.ok) return json({ error: 'insufficient', wallet: walletView(w0) }, 400);

    const deck = shuffle(freshDeck());
    const g = {
      gameId: [Date.now().toString(36), (deck[0] + deck[1])].join('-'),
      bet: p.bet,
      deck,
      player: [deck.pop(), deck.pop()],
      dealer: [deck.pop(), deck.pop()],
      phase: 'player',
      doubled: false,
    };

    // Persist the hand BEFORE anything else so a lost-response retry of /deal
    // sees an in-progress hand (409) instead of debiting a second stake.
    await saveGame(env, guildId, userId, g);

    // Naturals resolve immediately (no player action). resolve() clears the
    // hand it just saved and credits exactly once (delete-before-credit).
    if (isBlackjack(g.player) || isBlackjack(g.dealer)) {
      return await resolve(env, ctx, guildId, userId, g, chanId, who);
    }
    return json({ ok: true, game: liveView(g), wallet: walletView(r.wallet) });
  }

  // Actions below need a live hand.
  const g = await loadGame(env, guildId, userId);
  if (!g || g.phase !== 'player') {
    const w = await getWallet(env, guildId, userId);
    return json({ error: 'no-hand', message: 'Deal a hand first.', wallet: walletView(w) }, 409);
  }
  // Bind the action to the exact hand the client is looking at.
  if (body.gameId && String(body.gameId) !== String(g.gameId)) {
    return json({ error: 'stale', message: 'That hand already moved on.', game: liveView(g) }, 409);
  }

  // ── Hit ────────────────────────────────────────────────────────────
  if (sub === 'hit') {
    g.player.push(g.deck.pop());
    if (handTotal(g.player).total > 21) {
      g.phase = 'done';
      return await resolve(env, ctx, guildId, userId, g, chanId, who);   // bust
    }
    await saveGame(env, guildId, userId, g);
    return json({ ok: true, game: liveView(g), wallet: walletView(await getWallet(env, guildId, userId)) });
  }

  // ── Stand ──────────────────────────────────────────────────────────
  if (sub === 'stand') {
    g.phase = 'done';
    return await resolve(env, ctx, guildId, userId, g, chanId, who);
  }

  // ── Double (first action only): debit a second equal bet, one card, stand ─
  if (sub === 'double') {
    if (g.player.length !== 2 || g.doubled) {
      return json({ error: 'cant-double', message: 'You can only double on your first two cards.', game: liveView(g) }, 400);
    }
    const r = await settle(env, guildId, userId, g.bet, 0, 'blackjack');   // second stake
    if (!r.ok) {
      return json({ error: 'insufficient', message: 'Not enough Bolts to double.', game: liveView(g), wallet: walletView(await getWallet(env, guildId, userId)) }, 400);
    }
    g.doubled = true;
    g.player.push(g.deck.pop());
    g.phase = 'done';
    // Persist the committed double (doubled=true, phase=done) BEFORE resolving
    // so a lost-response retry reads phase!=='player' → 'no-hand' and can't
    // debit the second stake again.
    await saveGame(env, guildId, userId, g);
    return await resolve(env, ctx, guildId, userId, g, chanId, who);
  }

  return json({ error: 'not-found' }, 404);
}
