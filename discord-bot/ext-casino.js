// Bolts casino for the Twitch panel (/ext/wallet + /ext/casino/*).
//
// Worker-authoritative games that bet/earn the shared Bolts wallet
// (wallet.js, KV `wallet:<guild>:<userId>`). Unlike the old DLL-driven
// minigame surface (sunset), everything settles server-side here — no
// local engine needed. Daily claim to earn; slots / coinflip / dice to
// gamble. Big wins are announced in Twitch chat (best-effort).
//
// Identity: userId is the panel's `tw:<twitchId>` (from ext.js
// resolveLoadoutUserId). Same wallet KV namespace the Discord/site
// economy uses, so a future identity-merge unifies balances for linked
// viewers; today panel viewers get their own tw: wallet.

import { json, debounced } from './ext-shared.js';
import { getWallet, putWallet } from './wallet.js';
import { sendChatMessage } from './twitch-helix.js';

const MIN_BET = 5;
const MAX_BET = 1000;
const DAILY_BASE = 100;
const DAILY_STREAK_BONUS = 10;
const DAILY_STREAK_CAP = 7;
const DAILY_COOLDOWN_MS = 20 * 60 * 60 * 1000; // ~once/day
const DAILY_STREAK_GRACE_MS = 44 * 60 * 60 * 1000; // keep streak if back within ~2 days
const ANNOUNCE_NET = 500; // announce wins with net >= this

// Slot reels — symbol keys map to glossy panel icons (no emoji assets).
// bolt is rarest (jackpot); rock commonest.
const SLOT_SYMBOLS = ['bolt', 'star', 'flame', 'trophy', 'sword', 'rock'];
const SLOT_WEIGHTS = [1, 3, 3, 2, 4, 5];
const SLOT_WEIGHT_TOTAL = SLOT_WEIGHTS.reduce((a, b) => a + b, 0);

const cleanName = (s) => String(s || '').replace(/[^\w \-]/g, '').trim().slice(0, 25);

function walletView(w) {
  return {
    balance: w.balance || 0,
    lifetimeEarned: w.lifetimeEarned || 0,
    lifetimeSpent: w.lifetimeSpent || 0,
    dailyStreak: w.dailyStreak || 0,
    lastDailyUtc: w.lastDailyUtc || 0,
  };
}

function rollSlot() {
  let r = Math.random() * SLOT_WEIGHT_TOTAL;
  for (let i = 0; i < SLOT_SYMBOLS.length; i++) {
    r -= SLOT_WEIGHTS[i];
    if (r < 0) return SLOT_SYMBOLS[i];
  }
  return SLOT_SYMBOLS[SLOT_SYMBOLS.length - 1];
}

// Single read-modify-write settle: debit bet, credit payout, one KV put.
async function settle(env, guildId, userId, bet, payout, reason) {
  const w = await getWallet(env, guildId, userId);
  if ((w.balance || 0) < bet) return { ok: false, reason: 'insufficient', balance: w.balance || 0 };
  w.balance = (w.balance || 0) - bet + payout;
  w.lifetimeSpent = (w.lifetimeSpent || 0) + bet;
  if (payout > 0) {
    w.lifetimeEarned = (w.lifetimeEarned || 0) + payout;
    w.lastEarnUtc = Date.now();
    w.lastEarnReason = reason;
  }
  w.lastSpendUtc = Date.now();
  w.lastSpendReason = reason;
  await putWallet(env, guildId, userId, w);
  return { ok: true, wallet: w };
}

function announce(env, ctx, text) {
  try {
    const p = sendChatMessage(env, text);
    if (ctx && ctx.waitUntil) ctx.waitUntil(Promise.resolve(p).catch(() => {}));
  } catch { /* best-effort */ }
}

function parseBet(body, balance) {
  const n = Math.floor(Number(body && body.bet) || 0);
  if (!n || n < MIN_BET) return { err: `Minimum bet is ${MIN_BET} Bolts.` };
  if (n > MAX_BET) return { err: `Maximum bet is ${MAX_BET} Bolts.` };
  if (n > balance) return { err: 'Not enough Bolts for that bet.' };
  return { bet: n };
}

// GET /ext/wallet — real balance (drives the panel Wallet tab + header).
export async function handleExtWallet(env, guildId, userId) {
  const w = await getWallet(env, guildId, userId);
  return json({ ok: true, wallet: walletView(w) });
}

export async function handleExtCasino(env, ctx, guildId, userId, payload, sub, req) {
  let body = {};
  if (req.method === 'POST') { try { body = await req.json(); } catch { body = {}; } }
  const who = cleanName(body.name) || 'Someone';

  // Daily claim ---------------------------------------------------------
  if (req.method === 'POST' && sub === 'daily') {
    const w = await getWallet(env, guildId, userId);
    const now = Date.now();
    const since = now - (w.lastDailyUtc || 0);
    if (w.lastDailyUtc && since < DAILY_COOLDOWN_MS) {
      return json({ error: 'cooldown', nextAt: (w.lastDailyUtc || 0) + DAILY_COOLDOWN_MS, wallet: walletView(w) }, 429);
    }
    const streak = (w.lastDailyUtc && since < DAILY_STREAK_GRACE_MS) ? (w.dailyStreak || 0) + 1 : 1;
    const bonus = Math.min(streak, DAILY_STREAK_CAP) * DAILY_STREAK_BONUS;
    const amount = DAILY_BASE + bonus;
    w.balance = (w.balance || 0) + amount;
    w.lifetimeEarned = (w.lifetimeEarned || 0) + amount;
    w.lastEarnUtc = now;
    w.lastEarnReason = 'daily';
    w.dailyStreak = streak;
    w.lastDailyUtc = now;
    await putWallet(env, guildId, userId, w);
    return json({ ok: true, amount, streak, wallet: walletView(w) });
  }

  // Games rate-limit (per-viewer) --------------------------------------
  if (req.method === 'POST' && (sub === 'slots' || sub === 'coinflip' || sub === 'dice')) {
    if (await debounced(env, 'casino', guildId, userId)) {
      const w = await getWallet(env, guildId, userId);
      return json({ error: 'slow-down', message: 'One play every few seconds.', wallet: walletView(w) }, 429);
    }
  }

  // Slots ---------------------------------------------------------------
  if (req.method === 'POST' && sub === 'slots') {
    const w0 = await getWallet(env, guildId, userId);
    const p = parseBet(body, w0.balance || 0);
    if (p.err) return json({ error: 'bad-bet', message: p.err, wallet: walletView(w0) }, 400);
    const reels = [rollSlot(), rollSlot(), rollSlot()];
    let mult = 0;
    if (reels[0] === reels[1] && reels[1] === reels[2]) {
      mult = reels[0] === 'bolt' ? 20 : 8;
    } else if (reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2]) {
      mult = 1.5;
    }
    const payout = Math.floor(p.bet * mult);
    const r = await settle(env, guildId, userId, p.bet, payout, 'slots');
    if (!r.ok) return json({ error: 'insufficient', wallet: walletView(w0) }, 400);
    const net = payout - p.bet;
    if (net >= ANNOUNCE_NET) announce(env, ctx, `🎰 ${who} hit ${reels.join('-')} on slots for +${net} Bolts!`);
    return json({ ok: true, game: 'slots', reels, mult, payout, net, wallet: walletView(r.wallet) });
  }

  // Coinflip ------------------------------------------------------------
  if (req.method === 'POST' && sub === 'coinflip') {
    const w0 = await getWallet(env, guildId, userId);
    const p = parseBet(body, w0.balance || 0);
    if (p.err) return json({ error: 'bad-bet', message: p.err, wallet: walletView(w0) }, 400);
    const side = String(body.side || '').toLowerCase() === 'tails' ? 'tails' : 'heads';
    const result = Math.random() < 0.5 ? 'heads' : 'tails';
    const won = side === result;
    const payout = won ? p.bet * 2 : 0;
    const r = await settle(env, guildId, userId, p.bet, payout, 'coinflip');
    if (!r.ok) return json({ error: 'insufficient', wallet: walletView(w0) }, 400);
    const net = payout - p.bet;
    if (net >= ANNOUNCE_NET) announce(env, ctx, `🪙 ${who} called ${side} and won +${net} Bolts on the coinflip!`);
    return json({ ok: true, game: 'coinflip', side, result, won, payout, net, wallet: walletView(r.wallet) });
  }

  // Dice (pick 1–6, ×5 on match) ---------------------------------------
  if (req.method === 'POST' && sub === 'dice') {
    const w0 = await getWallet(env, guildId, userId);
    const p = parseBet(body, w0.balance || 0);
    if (p.err) return json({ error: 'bad-bet', message: p.err, wallet: walletView(w0) }, 400);
    let pick = Math.floor(Number(body.pick) || 0);
    if (pick < 1 || pick > 6) pick = 1 + Math.floor(Math.random() * 6);
    const roll = 1 + Math.floor(Math.random() * 6);
    const won = pick === roll;
    const payout = won ? p.bet * 5 : 0;
    const r = await settle(env, guildId, userId, p.bet, payout, 'dice');
    if (!r.ok) return json({ error: 'insufficient', wallet: walletView(w0) }, 400);
    const net = payout - p.bet;
    if (net >= ANNOUNCE_NET) announce(env, ctx, `🎲 ${who} called ${pick}, rolled ${roll}, and won +${net} Bolts!`);
    return json({ ok: true, game: 'dice', pick, roll, won, payout, net, wallet: walletView(r.wallet) });
  }

  return json({ error: 'not-found' }, 404);
}
