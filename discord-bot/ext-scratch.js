// Scratch-off, the in-panel Bolts game backend for the Aquilo Twitch extension.
//
// A single-ticket scratch card on the real per-channel Bolts wallet. The panel
// pays COST for a ticket, we roll a weighted outcome, and hand back a 3x3 grid
// of symbols that HONESTLY matches the result (a real 3-match on a win, no
// accidental 3-match on a loss).
//
// Multi-tenant: `guildId` and `userId` are ALREADY resolved by nsFor() in
// ext.js — guildId is the per-channel namespace, userId is `tw:<id>`. We use
// them verbatim and NEVER re-derive. Any KV state we add is keyed with the
// guildId so it stays channel-isolated.
//
// Routes (all under /ext/scratch/):
//   GET  /ext/scratch/state        -> { ok, wallet, cost }
//   POST /ext/scratch/buy {name}   -> { ok, wallet, tiles, win, prize, net, tier }
//                                     | 429 {error:'rate'} | 400 {error:'insufficient'}

import { getWallet, putWallet, earn, spend } from './wallet.js';
import { walletView } from './ext-econ.js';

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

// Grid symbols MUST come from this set only — the panel renders each tile via
// glossyIcon(sym), which only knows these six sprites.
const SYMBOLS = ['bolt', 'star', 'flame', 'shield', 'sword', 'trophy'];

// Price of one ticket.
const COST = 50;

// Weighted outcomes. Expected payout MUST stay below COST so this is never a
// Bolts faucet:
//   EV = .70*0 + .20*75 + .07*150 + .025*300 + .005*1000
//      = 0 + 15 + 10.5 + 7.5 + 5 = 38  (< 50 = COST)
const OUTCOMES = [
  { tier: 'none',    prize: 0,    p: 0.70 },
  { tier: 'small',   prize: 75,   p: 0.20 }, // x1.5
  { tier: 'good',    prize: 150,  p: 0.07 }, // x3
  { tier: 'great',   prize: 300,  p: 0.025 }, // x6
  { tier: 'jackpot', prize: 1000, p: 0.005 }, // x20
];

// Light anti-spam on the buy route. Keyed with guildId so it stays channel-
// isolated. Stored value is Date.now(); TTL floors low in KV but the timestamp
// enforces the real ~800ms window.
const SPAM_WINDOW_MS = 800;
const SPAM_TTL = 2;
const cdKey = (guildId, userId) => `scratchcd:${guildId}:${userId}`;

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

// Persist the viewer's display name onto their wallet so any name-aware surface
// can render it (cosmetic; mirrors rememberName in ext-casino.js).
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

// ── grid construction ────────────────────────────────────────────────
// Uniform pick from an array.
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Fisher–Yates in place.
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Build a 9-tile grid that matches the outcome:
//  - win  -> guarantee >=3 of one chosen prize symbol (a real 3-match), and
//            fill the rest so no OTHER symbol also hits 3+ (keeps the win read
//            unambiguous).
//  - lose -> guarantee NO symbol appears 3+ times (cap every symbol at 2).
function buildTiles(win) {
  if (win) {
    const prizeSym = pick(SYMBOLS);
    const others = SYMBOLS.filter((s) => s !== prizeSym);
    const tiles = [prizeSym, prizeSym, prizeSym];
    // Fill the remaining 6 with non-prize symbols, each capped at 2 so only the
    // prize symbol forms a 3-match.
    const counts = {};
    while (tiles.length < 9) {
      const candidates = others.filter((s) => (counts[s] || 0) < 2);
      const s = pick(candidates);
      counts[s] = (counts[s] || 0) + 1;
      tiles.push(s);
    }
    return shuffle(tiles);
  }

  // Losing grid: cap every symbol at 2.
  const counts = {};
  const tiles = [];
  while (tiles.length < 9) {
    const candidates = SYMBOLS.filter((s) => (counts[s] || 0) < 2);
    const s = pick(candidates);
    counts[s] = (counts[s] || 0) + 1;
    tiles.push(s);
  }
  return shuffle(tiles);
}

// Roll a weighted outcome.
function rollOutcome() {
  const r = Math.random();
  let acc = 0;
  for (const o of OUTCOMES) {
    acc += o.p;
    if (r < acc) return o;
  }
  return OUTCOMES[0]; // rounding fallback -> lose
}

// ── buy a ticket ─────────────────────────────────────────────────────
async function handleBuy(env, guildId, userId) {
  const balance = (await getWallet(env, guildId, userId)).balance || 0;
  if (balance < COST) {
    return json({ error: 'insufficient', message: 'Not enough Bolts.' }, 400);
  }

  await spend(env, guildId, userId, COST, 'scratch:buy');

  const outcome = rollOutcome();
  const prize = outcome.prize;
  const tier = outcome.tier;
  const win = prize > 0;

  if (win) await earn(env, guildId, userId, prize, 'scratch:' + tier);

  const tiles = buildTiles(win);
  const net = prize - COST;
  const wallet = await walletView(env, guildId, userId);

  // Surface a jackpot/great scratch on the OBS overlay event bus (best-effort).
  if (tier === 'great' || tier === 'jackpot') {
    try {
      const { pushGameEvent } = await import('./ext-events.js');
      await pushGameEvent(env, guildId, { type: 'scratch-win', name: wallet.name || 'A viewer', amount: prize, tier });
    } catch { /* overlay flourish must never break a play */ }
  }

  return json({ ok: true, wallet, tiles, win, prize, net, tier });
}

// ── entry point ──────────────────────────────────────────────────────
// sub: the action after /ext/scratch/ ('state'|'buy').
// meta = { twId, name, isClay }.
export async function handlePanelScratch(env, guildId, userId, sub, req, meta) {
  meta = meta || {};

  // Read-only state — no rate limit, just the fresh wallet view + ticket cost.
  if (sub === 'state') {
    return json({ ok: true, wallet: await walletView(env, guildId, userId), cost: COST });
  }

  if (sub === 'buy') {
    const body = await req.json().catch(() => ({}));

    if (await rateLimited(env, guildId, userId)) {
      return json({ error: 'rate', message: 'Slow down a sec.' }, 429);
    }

    // Stamp the display name opportunistically (cosmetic).
    await rememberName(env, guildId, userId, meta.name || body.name);

    return handleBuy(env, guildId, userId);
  }

  return json({ error: 'not-found' }, 404);
}
