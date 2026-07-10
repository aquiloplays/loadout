// Casino, the in-panel Bolts games backend for the Aquilo Twitch extension.
//
// Server-authoritative slots / coinflip / dice + a once-a-day claim, all
// betting/earning the real per-channel Bolts wallet. Also serves the shared
// GET /ext/wallet route (the caller routes that here with sub==='wallet').
//
// Multi-tenant: `guildId` and `userId` are ALREADY resolved by nsFor() in
// ext.js — guildId is the per-channel namespace, userId is `tw:<id>`. We use
// them verbatim and NEVER re-derive. Any KV state we add is keyed with the
// guildId so it stays channel-isolated.
//
// Routes (all under /ext/casino/ except the shared wallet GET):
//   GET  /ext/wallet               -> { ok, wallet }
//   GET  /ext/casino/leaderboard   -> { ok, entries[], me, total }
//   POST /ext/casino/daily {name}  -> { wallet, amount, streak } | 429 {error:'cooldown'}
//   POST /ext/casino/slots    {bet,name}      -> { wallet, game:'slots', reels, net }
//   POST /ext/casino/coinflip {bet,side,name} -> { wallet, game:'coinflip', side, result, net }
//   POST /ext/casino/dice     {bet,pick,name} -> { wallet, game:'dice', pick, roll, net }

import { getWallet, putWallet, earn, spend, leaderboard } from './wallet.js';
import { walletView, computeRank } from './ext-econ.js';

// ── local JSON helper (CORS + no-store) ──────────────────────────────
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    },
  });
}

// Slots faces MUST come from this set only — the panel renders each reel via
// glossyIcon(sym), which only knows these six sprites.
const SLOT_SYMBOLS = ['bolt', 'star', 'flame', 'shield', 'sword', 'trophy'];

// Bet bounds (re-validated server-side; the panel clamps the same range).
const MIN_BET = 5;
const MAX_BET = 1000;

// Daily claim.
const DAILY_COOLDOWN_MS = 20 * 3600 * 1000; // 20h until claimable again
const DAILY_STREAK_RESET_MS = 48 * 3600 * 1000; // >48h gap breaks the streak
const DAILY_BASE = 100;
const DAILY_STREAK_BONUS = 15; // per streak day, capped at 7 days

// Light anti-spam on the POST game routes. Keyed with guildId so it stays
// channel-isolated. Stored value is Date.now(); TTL floors at 60s in KV but
// the timestamp enforces the real ~800ms window.
const SPAM_WINDOW_MS = 800;
const SPAM_TTL = 2;
const cdKey = (guildId, userId) => `casinocd:${guildId}:${userId}`;

// True when the caller is still inside the anti-spam window.
async function rateLimited(env, guildId, userId) {
  try {
    const key = cdKey(guildId, userId);
    const last = parseInt((await env.LOADOUT_BOLTS.get(key)) || '0', 10);
    const now = Date.now();
    if (last && now - last < SPAM_WINDOW_MS) return true;
    await env.LOADOUT_BOLTS.put(key, String(now), { expirationTtl: SPAM_TTL });
    return false;
  } catch {
    // Best-effort — never block a play because the cooldown store hiccuped.
    return false;
  }
}

// Persist the viewer's display name onto their wallet so the leaderboard can
// render a name instead of a bare id. Direct read/putWallet is fine here.
async function rememberName(env, guildId, userId, name) {
  const nm = (name || '').toString().trim().slice(0, 40);
  if (!nm) return;
  try {
    const w = await getWallet(env, guildId, userId);
    if (w.name !== nm) {
      w.name = nm;
      await putWallet(env, guildId, userId, w);
    }
  } catch {
    /* name is cosmetic — never fail a play over it */
  }
}

// Validate the requested bet against the wallet balance. Returns either a
// { bet } on success or a Response to short-circuit with.
function validateBet(raw, balance) {
  const bet = Math.floor(Number(raw));
  if (!Number.isFinite(bet) || bet < MIN_BET || bet > MAX_BET) {
    return { err: json({ error: 'bad-bet', message: 'Check your bet.' }, 400) };
  }
  if (balance < bet) {
    return { err: json({ error: 'insufficient', message: 'Not enough Bolts.' }, 400) };
  }
  return { bet };
}

// Debit the bet, credit winnings, and return the fresh wallet view + net.
async function settle(env, guildId, userId, bet, winnings, reason) {
  await spend(env, guildId, userId, bet, `casino:${reason}:bet`);
  if (winnings > 0) await earn(env, guildId, userId, winnings, `casino:${reason}:win`);
  const wallet = await walletView(env, guildId, userId);
  const net = winnings - bet;
  // Surface a big win on the OBS overlay event bus (best-effort).
  if (net >= 250) {
    try {
      const { pushGameEvent } = await import('./ext-events.js');
      await pushGameEvent(env, guildId, { type: 'casino-win', game: reason, name: wallet.name || 'A viewer', amount: net });
    } catch { /* overlay flourish must never break a play */ }
  }
  return { wallet, net };
}

// ── daily claim ──────────────────────────────────────────────────────
async function handleDaily(env, guildId, userId) {
  const w = await getWallet(env, guildId, userId);
  const now = Date.now();
  const last = w.lastDailyUtc || 0;
  if (last && now - last < DAILY_COOLDOWN_MS) {
    return json({ error: 'cooldown', message: 'Daily already claimed — come back later.' }, 429);
  }

  // Continue the streak if the previous claim was within the reset window,
  // otherwise start over at 1.
  const priorStreak = w.dailyStreak || 0;
  const streak = (last && now - last <= DAILY_STREAK_RESET_MS) ? priorStreak + 1 : 1;
  w.dailyStreak = streak;
  w.lastDailyUtc = now;
  await putWallet(env, guildId, userId, w);

  const amount = DAILY_BASE + Math.min(streak, 7) * DAILY_STREAK_BONUS;
  await earn(env, guildId, userId, amount, 'casino:daily');

  const wallet = await walletView(env, guildId, userId);
  return json({ wallet, amount, streak });
}

// ── slots ────────────────────────────────────────────────────────────
async function handleSlots(env, guildId, userId, body) {
  const balance = (await getWallet(env, guildId, userId)).balance || 0;
  const v = validateBet(body.bet, balance);
  if (v.err) return v.err;
  const bet = v.bet;

  const reels = [pick(SLOT_SYMBOLS), pick(SLOT_SYMBOLS), pick(SLOT_SYMBOLS)];
  let winnings = 0;
  if (reels[0] === reels[1] && reels[1] === reels[2]) winnings = bet * 10; // 3-match
  else if (reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2]) winnings = bet * 2; // 2-match

  const { wallet, net } = await settle(env, guildId, userId, bet, winnings, 'slots');
  return json({ wallet, game: 'slots', reels, net });
}

// ── coinflip ─────────────────────────────────────────────────────────
async function handleCoinflip(env, guildId, userId, body) {
  const balance = (await getWallet(env, guildId, userId)).balance || 0;
  const v = validateBet(body.bet, balance);
  if (v.err) return v.err;
  const bet = v.bet;

  const side = body.side === 'tails' ? 'tails' : 'heads';
  const result = Math.random() < 0.5 ? 'heads' : 'tails';
  const winnings = result === side ? bet * 2 : 0;

  const { wallet, net } = await settle(env, guildId, userId, bet, winnings, 'coinflip');
  return json({ wallet, game: 'coinflip', side, result, net });
}

// ── dice ─────────────────────────────────────────────────────────────
async function handleDice(env, guildId, userId, body) {
  const balance = (await getWallet(env, guildId, userId)).balance || 0;
  const v = validateBet(body.bet, balance);
  if (v.err) return v.err;
  const bet = v.bet;

  let pickN = Math.floor(Number(body.pick));
  if (!Number.isFinite(pickN) || pickN < 1 || pickN > 6) pickN = 1;
  const roll = 1 + Math.floor(Math.random() * 6);
  const winnings = roll === pickN ? bet * 5 : 0;

  const { wallet, net } = await settle(env, guildId, userId, bet, winnings, 'dice');
  return json({ wallet, game: 'dice', pick: pickN, roll, net });
}

// ── leaderboard ──────────────────────────────────────────────────────
async function handleLeaderboard(env, guildId, userId) {
  const rows = await leaderboard(env, guildId, 10);
  const entries = rows.map((r, i) => ({
    rank: i + 1,
    name: (r.w && r.w.name) || 'Viewer',
    balance: (r.w && r.w.balance) || 0,
    tierRank: computeRank(r.w && r.w.lifetimeEarned),
    // avatar intentionally omitted (undefined) — the panel hides it.
  }));

  // Where does the caller sit? leaderboard() only returns the top slice, so
  // find them in it if present; otherwise report their own balance with an
  // unknown rank (0) rather than a wrong one.
  const meRow = rows.findIndex((r) => r.userId === userId);
  const meWallet = await getWallet(env, guildId, userId);
  const me = {
    rank: meRow >= 0 ? meRow + 1 : 0,
    balance: meWallet.balance || 0,
  };

  return json({ ok: true, entries, me, total: rows.length });
}

// ── entry point ──────────────────────────────────────────────────────
// sub: the action after /ext/casino/ ('daily'|'slots'|'coinflip'|'dice'|
// 'leaderboard'), or 'wallet' for the shared GET /ext/wallet route.
// meta = { twId, name, isClay }.
export async function handleCasino(env, guildId, userId, sub, req, meta) {
  meta = meta || {};

  // Shared wallet GET — no rate limit, just the fresh wallet view.
  if (sub === 'wallet') {
    return json({ ok: true, wallet: await walletView(env, guildId, userId) });
  }

  // Read-only leaderboard — no rate limit.
  if (sub === 'leaderboard') {
    return handleLeaderboard(env, guildId, userId);
  }

  // Everything else mutates the wallet — POST + anti-spam gated.
  const body = await req.json().catch(() => ({}));

  if (await rateLimited(env, guildId, userId)) {
    return json({ error: 'rate', message: 'Slow down a sec.' }, 429);
  }

  // Stamp the display name on every play so the leaderboard has a name.
  await rememberName(env, guildId, userId, meta.name || body.name);

  switch (sub) {
    case 'daily':    return handleDaily(env, guildId, userId);
    case 'slots':    return handleSlots(env, guildId, userId, body);
    case 'coinflip': return handleCoinflip(env, guildId, userId, body);
    case 'dice':     return handleDice(env, guildId, userId, body);
    default:         return json({ error: 'not-found' }, 404);
  }
}

// Uniform pick from an array.
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
