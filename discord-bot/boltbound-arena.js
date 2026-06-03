// Boltbound — Arena draft mode (RET-5).
//
// Hearthstone-style Arena: pay 1000 Bolts or 1 Arena ticket, draft a
// 30-card deck (shown 3 at a time, pick one, x30, weighted toward
// commons/rares with legendaries ~1 pick in 30), then run until 3
// losses or 12 wins. Rewards escalate with the final win count.
//
// v1 match resolution: matches are resolved by a DRAFT-SENSITIVE
// probabilistic model — a stronger drafted deck (better curve + bombs)
// wins more, against an opponent whose strength ramps with your win
// count. This keeps draft decisions meaningful and the run self-
// contained; swapping to the interactive engine later only changes
// resolveArenaMatch() (the draft + run + reward loop is unchanged).
//
// D1: arena_run (one active run per user; history rows kept).
// KV: cards:arena-tickets:<userId> (ticket balance).

import { CARDS } from './cards-content.js';
import { getWallet, spend, applyVaultDelta } from './wallet.js';
import { creditPack } from './cards-packs.js';

const ENTRY_BOLTS = 1000;
const DECK_SIZE = 30;
const OFFER_SIZE = 3;
const MAX_WINS = 12;
const MAX_LOSSES = 3;
const TICKETS_KEY = (userId) => `cards:arena-tickets:${userId}`;

function db(env) {
  if (!env || !env.DB) throw new Error('arena: no D1 binding (env.DB missing)');
  return env.DB;
}
function newId() { return crypto.randomUUID(); }

// Deterministic PRNG (xmur3 + mulberry32) seeded by a string.
function makeRng(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let s = (h >>> 0) || 1;
  return function rng() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Draft pool ──────────────────────────────────────────────────────

// Rarity → draft weight (legendaries rare) and a power bonus used by
// the deck-strength model.
const RARITY_WEIGHT = { common: 100, uncommon: 45, rare: 22, epic: 7, legendary: 3 };
const RARITY_POWER  = { common: 0, uncommon: 1, rare: 3, epic: 6, legendary: 10 };

let _poolCache = null;
function draftPool() {
  if (_poolCache) return _poolCache;
  _poolCache = Object.values(CARDS).filter(c =>
    c && !c.token && c.rarity !== 'champion' && c.rarity !== 'token' &&
    RARITY_WEIGHT[c.rarity] != null
  );
  return _poolCache;
}

// Draw OFFER_SIZE distinct cards by weighted rarity. Seeded per pick so
// the same run/pick always offers the same trio (replay-stable).
function rollOffer(runId, pickNumber) {
  const pool = draftPool();
  const rng = makeRng(`arena:${runId}:pick:${pickNumber}`);
  const chosen = [];
  const usedIds = new Set();
  let guard = 0;
  while (chosen.length < OFFER_SIZE && guard++ < 500) {
    const total = pool.reduce((s, c) => s + (usedIds.has(c.id) ? 0 : (RARITY_WEIGHT[c.rarity] || 1)), 0);
    let pick = rng() * total;
    let card = null;
    for (const c of pool) {
      if (usedIds.has(c.id)) continue;
      pick -= (RARITY_WEIGHT[c.rarity] || 1);
      if (pick <= 0) { card = c; break; }
    }
    if (card && !usedIds.has(card.id)) { usedIds.add(card.id); chosen.push(card.id); }
  }
  return chosen;
}

function cardBrief(id) {
  const c = CARDS[id];
  if (!c) return { id, name: id };
  return { id: c.id, name: c.name, rarity: c.rarity, type: c.type, mana: c.mana, atk: c.atk, hp: c.hp, keywords: c.keywords || [], text: c.text, spriteId: c.spriteId };
}

// ── Deck strength + match resolution ────────────────────────────────

function deckStrength(deckIds) {
  if (!deckIds.length) return 0;
  let total = 0;
  for (const id of deckIds) {
    const c = CARDS[id];
    if (!c) continue;
    total += (c.atk || 0) + (c.hp || 0) + (RARITY_POWER[c.rarity] || 0);
  }
  return total / deckIds.length; // average card value
}

// Win probability vs an opponent that ramps with your win count. Clamped
// so even a great deck can lose and a weak one can win.
function winProbability(deckIds, wins) {
  const s = deckStrength(deckIds);
  const target = 7 + wins * 0.45;
  const p = 1 / (1 + Math.exp(-(s - target) * 0.5));
  return Math.max(0.2, Math.min(0.85, p));
}

function resolveArenaMatch(run) {
  const p = winProbability(run.deck, run.wins);
  const rng = makeRng(`arena:${run.run_id}:match:${run.wins}:${run.losses}`);
  return rng() < p;
}

// ── Rewards (by final win count) ────────────────────────────────────

function rewardsForWins(w) {
  if (w >= 12) return { bolts: 500, packs: [{ type: 'voltaic', n: 5 }], tickets: 2, cosmetic: 'golden-legendary' };
  if (w >= 9)  return { bolts: 200, packs: [{ type: 'bolt', n: 3 }], tickets: 1 };
  if (w >= 6)  return { bolts: 100, packs: [{ type: 'bolt', n: 2 }], tickets: 0 };
  if (w >= 3)  return { bolts: 0,   packs: [{ type: 'bolt', n: 1 }], tickets: 0 };
  return { bolts: 50, packs: [], tickets: 0 };
}

// ── Tickets ─────────────────────────────────────────────────────────

export async function getTickets(env, userId) {
  const v = await env.LOADOUT_BOLTS.get(TICKETS_KEY(userId));
  return parseInt(v || '0', 10) || 0;
}
async function addTickets(env, userId, delta) {
  const cur = await getTickets(env, userId);
  const next = Math.max(0, cur + (delta | 0));
  await env.LOADOUT_BOLTS.put(TICKETS_KEY(userId), String(next));
  return next;
}

// ── Run IO ──────────────────────────────────────────────────────────

function parseRun(r) {
  if (!r) return null;
  let deck = [], offer = [];
  try { deck = JSON.parse(r.deck_json || '[]'); } catch { deck = []; }
  try { offer = JSON.parse(r.offer_json || '[]'); } catch { offer = []; }
  return {
    run_id: r.run_id, user_id: r.user_id, guild_id: r.guild_id || null,
    status: r.status, deck, offer,
    pick_number: Number(r.pick_number) || 0,
    wins: Number(r.wins) || 0, losses: Number(r.losses) || 0,
    rewards_claimed: Number(r.rewards_claimed) === 1,
    created_at: Number(r.created_at) || 0,
  };
}

async function activeRun(env, userId) {
  const r = await db(env).prepare(
    `SELECT * FROM arena_run WHERE user_id = ? AND status IN ('drafting','active')
      ORDER BY created_at DESC LIMIT 1`
  ).bind(String(userId)).first();
  return parseRun(r);
}

async function writeRun(env, run) {
  await db(env).prepare(
    `INSERT INTO arena_run
       (run_id, user_id, guild_id, status, deck_json, offer_json, pick_number,
        wins, losses, rewards_claimed, created_at, ended_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(run_id) DO UPDATE SET
       status=excluded.status, deck_json=excluded.deck_json,
       offer_json=excluded.offer_json, pick_number=excluded.pick_number,
       wins=excluded.wins, losses=excluded.losses,
       rewards_claimed=excluded.rewards_claimed, ended_at=excluded.ended_at`
  ).bind(
    run.run_id, run.user_id, run.guild_id, run.status,
    JSON.stringify(run.deck), JSON.stringify(run.offer), run.pick_number,
    run.wins, run.losses, run.rewards_claimed ? 1 : 0, run.created_at,
    (run.status === 'complete' || run.status === 'retired') ? Date.now() : null,
  ).run();
}

function viewRun(run, extra = {}) {
  if (!run) return null;
  return {
    runId: run.run_id,
    status: run.status,
    pick: run.pick_number,
    deckSize: run.deck.length,
    needed: DECK_SIZE,
    offer: run.status === 'drafting' ? run.offer.map(cardBrief) : [],
    deck: run.deck.map(cardBrief),
    wins: run.wins,
    losses: run.losses,
    maxWins: MAX_WINS,
    maxLosses: MAX_LOSSES,
    ...extra,
  };
}

// ── Public API ──────────────────────────────────────────────────────

export async function getArenaState(env, guildId, userId) {
  const run = await activeRun(env, userId);
  const [tickets, wallet] = await Promise.all([getTickets(env, userId), getWallet(env, guildId, userId)]);
  return {
    ok: true,
    entryBolts: ENTRY_BOLTS,
    tickets,
    bolts: wallet.balance || 0,
    run: viewRun(run),
  };
}

export async function startArenaRun(env, guildId, userId, useTicket) {
  const existing = await activeRun(env, userId);
  if (existing) return { ok: false, error: 'run-in-progress' };

  if (useTicket) {
    const t = await getTickets(env, userId);
    if (t < 1) return { ok: false, error: 'no-ticket' };
    await addTickets(env, userId, -1);
  } else {
    const r = await spend(env, guildId, userId, ENTRY_BOLTS, 'arena-entry');
    if (!r.ok) return { ok: false, error: 'insufficient-bolts', need: ENTRY_BOLTS };
  }

  const run = {
    run_id: newId(), user_id: String(userId), guild_id: guildId || null,
    status: 'drafting', deck: [], offer: [], pick_number: 0,
    wins: 0, losses: 0, rewards_claimed: false, created_at: Date.now(),
  };
  run.offer = rollOffer(run.run_id, 0);
  await writeRun(env, run);
  return { ok: true, run: viewRun(run) };
}

export async function pickArenaCard(env, guildId, userId, cardId) {
  const run = await activeRun(env, userId);
  if (!run) return { ok: false, error: 'no-run' };
  if (run.status !== 'drafting') return { ok: false, error: 'not-drafting' };
  if (!run.offer.includes(cardId)) return { ok: false, error: 'not-in-offer' };

  run.deck.push(cardId);
  run.pick_number += 1;
  if (run.deck.length >= DECK_SIZE) {
    run.status = 'active';
    run.offer = [];
  } else {
    run.offer = rollOffer(run.run_id, run.pick_number);
  }
  await writeRun(env, run);
  return { ok: true, run: viewRun(run) };
}

// Resolve the next match in an active run. Returns the result + updated
// run; when the run ends (3 losses or 12 wins) rewards are granted.
export async function playArenaMatch(env, guildId, userId) {
  const run = await activeRun(env, userId);
  if (!run) return { ok: false, error: 'no-run' };
  if (run.status !== 'active') return { ok: false, error: 'not-active' };

  const won = resolveArenaMatch(run);
  if (won) run.wins += 1; else run.losses += 1;

  let rewards = null;
  if (run.wins >= MAX_WINS || run.losses >= MAX_LOSSES) {
    run.status = 'complete';
    rewards = await grantRewards(env, run);
  }
  await writeRun(env, run);
  return { ok: true, won, run: viewRun(run), rewards };
}

// Forfeit the run, banking rewards for the wins earned so far.
export async function retireArenaRun(env, guildId, userId) {
  const run = await activeRun(env, userId);
  if (!run) return { ok: false, error: 'no-run' };
  if (run.status === 'drafting') {
    // Abandoning mid-draft: no rewards, just close it.
    run.status = 'retired';
    await writeRun(env, run);
    return { ok: true, run: viewRun(run), rewards: null };
  }
  run.status = 'complete';
  const rewards = await grantRewards(env, run);
  await writeRun(env, run);
  return { ok: true, run: viewRun(run), rewards };
}

async function grantRewards(env, run) {
  if (run.rewards_claimed) return null;
  run.rewards_claimed = true;
  const reward = rewardsForWins(run.wins);
  const guildId = run.guild_id || env.AQUILO_VAULT_GUILD_ID;
  const out = { wins: run.wins, bolts: reward.bolts || 0, tickets: reward.tickets || 0, packs: [], cosmetic: reward.cosmetic || null };
  if (reward.bolts && guildId) {
    try { await applyVaultDelta(env, guildId, run.user_id, reward.bolts, `arena:${run.wins}w`); }
    catch (e) { out.boltsError = e?.message || String(e); }
  }
  if (reward.tickets) { try { out.ticketBalance = await addTickets(env, run.user_id, reward.tickets); } catch { /* noop */ } }
  for (const p of (reward.packs || [])) {
    for (let i = 0; i < (p.n || 1); i++) {
      try {
        const r = await creditPack(env, guildId, run.user_id, p.type, `arena:${run.wins}w`);
        if (r.ok && r.pack) out.packs.push({ packId: r.pack.id, packType: r.pack.packType });
      } catch (e) { out.packError = e?.message || String(e); }
    }
  }
  return out;
}

export async function getArenaHistory(env, userId, limit = 10) {
  const lim = Math.max(1, Math.min(25, Number(limit) || 10));
  const { results } = await db(env).prepare(
    `SELECT run_id, status, wins, losses, created_at, ended_at
       FROM arena_run WHERE user_id = ? AND status IN ('complete','retired')
      ORDER BY created_at DESC LIMIT ?`
  ).bind(String(userId), lim).all();
  return {
    ok: true,
    runs: (results || []).map(r => ({
      runId: r.run_id, status: r.status,
      wins: Number(r.wins) || 0, losses: Number(r.losses) || 0,
      endedAt: Number(r.ended_at) || null,
    })),
  };
}

export const __internals = { rollOffer, deckStrength, winProbability, rewardsForWins };
