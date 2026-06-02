// pvp.js — viewer-vs-viewer (and vs-Aquilo) D20 hero duels.
//
// Self-routing /web/pvp/* module (claimed in worker.js BEFORE the generic
// /web HMAC router so GET reads work). POST mutations are HMAC-gated exactly
// like friends.js; GET reads (battle/queue/snapshot/history) are public-ish
// (CORS-open) but the winner + turn log are withheld during the pre-fight
// spectator window so picks/bets can't peek the outcome.
//
// Flow:
//   challenge → pending row, wager escrowed from challenger, opponent DM'd
//   accept    → opponent wager escrowed, battle resolved server-side
//               (pvp-combat.resolveBattle), full deterministic fight stored,
//               pvp.battle.start emitted to the OBS overlay carrying the
//               ENTIRE fight (the overlay self-animates pre-fight → turns →
//               outro; no fragile per-turn relay streaming).
//   <20s window> spectators pick a side (free, fixed reward) or bet bolts
//               (parimutuel pot). GET battle hides the result this whole time.
//   settle    → on first read after the window (idempotent): pay the wager
//               pot to the winner, settle picks + bets, update the champion.
//
// See .claude/scout/*.md for the grounding on every contract this touches.

import { verifyHmac } from './auth.js';
import { getWallet, spend, earn } from './wallet.js';
import { enqueueOverlay } from './ext-engage.js';
import { publishActivity } from './activity-do.js';
import { loadHero } from './dungeon.js';
import { computeEffectiveStats } from './hero-skills.js';
import { buildCompositeManifest } from './character-composite.js';
import { resolveBattle, combatantFromHero } from './pvp-combat.js';
import { getTenant } from './tenants.js';

// ── tunables ────────────────────────────────────────────────────────────────
const PREFIGHT_MS = 20000;       // spectator pick/bet window
const MAX_WAGER = 100000;        // sane upper bound on a stake
const PICK_REWARD = 10;          // bolts for a correct (free) spectator pick
const HOLD_BONUS = 50;           // bolts the champion earns per successful defense
const THRONE_PRIZE = 50;         // bolts a challenger earns for taking the throne
const HISTORY_LIMIT = 15;

// ── HTTP plumbing ─────────────────────────────────────────────────────────
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-aquilo-web-ts, x-aquilo-web-sig',
};
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS },
  });
}
function db(env) { if (!env || !env.DB) throw new Error('pvp: env.DB (D1) not bound'); return env.DB; }
function now() { return Date.now(); }
function jparse(s, fb) { if (s == null) return fb; try { const v = JSON.parse(s); return v == null ? fb : v; } catch { return fb; } }
function rid(p) { return p + '_' + now().toString(36) + '_' + Math.floor(Math.random() * 1e9).toString(36); }
function idOk(s) { return /^[A-Za-z0-9:_-]{2,40}$/.test(String(s || '')); }

// ── lazy schema (scratch-off.js isolate-flag pattern) ───────────────────────
let _schemaReady = false;
async function ensureSchema(env) {
  if (_schemaReady) return;
  const d = db(env);
  const stmts = [
    `CREATE TABLE IF NOT EXISTS pvp_battle (
      id TEXT PRIMARY KEY, guild_id TEXT, mode TEXT NOT NULL DEFAULT 'direct',
      challenger_id TEXT NOT NULL, challenger_name TEXT, opponent_id TEXT, opponent_name TEXT,
      status TEXT NOT NULL DEFAULT 'pending', winner_id TEXT, wager INTEGER NOT NULL DEFAULT 0,
      seed TEXT, result TEXT NOT NULL DEFAULT '{}', prefight_ms INTEGER NOT NULL DEFAULT 20000,
      created_at INTEGER NOT NULL DEFAULT 0, started_at INTEGER, resolved_at INTEGER,
      settled INTEGER NOT NULL DEFAULT 0)`,
    `CREATE INDEX IF NOT EXISTS idx_pvp_battle_guild_status ON pvp_battle(guild_id, status, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_pvp_battle_challenger ON pvp_battle(challenger_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_pvp_battle_opponent ON pvp_battle(opponent_id, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS pvp_match_event (
      id TEXT PRIMARY KEY, battle_id TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0,
      actor TEXT, target TEXT, action TEXT, result TEXT, roll INTEGER NOT NULL DEFAULT 0,
      damage INTEGER NOT NULL DEFAULT 0, heal INTEGER NOT NULL DEFAULT 0, effect TEXT,
      hp_a INTEGER NOT NULL DEFAULT 0, hp_b INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0)`,
    `CREATE INDEX IF NOT EXISTS idx_pvp_match_event_battle ON pvp_match_event(battle_id, seq)`,
    `CREATE TABLE IF NOT EXISTS pvp_spectator_pick (
      id TEXT PRIMARY KEY, battle_id TEXT NOT NULL, user_id TEXT NOT NULL, user_name TEXT,
      picked_side TEXT NOT NULL, correct INTEGER NOT NULL DEFAULT 0, reward INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0)`,
    `CREATE INDEX IF NOT EXISTS idx_pvp_spectator_pick_battle ON pvp_spectator_pick(battle_id, user_id)`,
    `CREATE TABLE IF NOT EXISTS pvp_bet (
      id TEXT PRIMARY KEY, battle_id TEXT NOT NULL, user_id TEXT NOT NULL, user_name TEXT,
      picked_side TEXT NOT NULL, amount INTEGER NOT NULL DEFAULT 0, payout INTEGER NOT NULL DEFAULT 0,
      settled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0, settled_at INTEGER)`,
    `CREATE INDEX IF NOT EXISTS idx_pvp_bet_battle ON pvp_bet(battle_id, settled)`,
    `CREATE INDEX IF NOT EXISTS idx_pvp_bet_user ON pvp_bet(user_id, created_at DESC)`,
  ];
  for (const s of stmts) await d.prepare(s).run();
  _schemaReady = true;
}

// ── HMAC gate (copy of friends.js gateHmac) ─────────────────────────────────
async function gateHmac(req, env) {
  if (!env.AQUILO_SITE_WEB_SECRET) return { ok: false, status: 503, error: 'not-configured' };
  const bodyText = req.method === 'POST' ? await req.text() : '';
  const ts = req.headers.get('x-aquilo-web-ts');
  const sig = req.headers.get('x-aquilo-web-sig');
  if (!(await verifyHmac(env.AQUILO_SITE_WEB_SECRET, ts || '', bodyText, sig || '')))
    return { ok: false, status: 401, error: 'unauthorized' };
  let body = {};
  if (bodyText) { try { body = JSON.parse(bodyText); } catch { return { ok: false, status: 400, error: 'bad-json' }; } }
  return { ok: true, body };
}

// ── champion (KV) ───────────────────────────────────────────────────────────
const championKey = (g) => `pvp:champion:${g}`;
async function getChampion(env, guildId) {
  const raw = await env.LOADOUT_BOLTS.get(championKey(guildId));
  return raw ? jparse(raw, null) : null;
}
async function setChampion(env, guildId, champ) {
  if (!champ) { await env.LOADOUT_BOLTS.delete(championKey(guildId)); return; }
  await env.LOADOUT_BOLTS.put(championKey(guildId), JSON.stringify(champ));
}

// Resolve the "Aquilo" challenge target → the guild owner's Discord id.
async function resolveAquilo(env, guildId) {
  if (env.AQUILO_OWNER_DISCORD_ID) return String(env.AQUILO_OWNER_DISCORD_ID);
  const t = await getTenant(env, guildId).catch(() => null);
  return t && t.ownerId ? String(t.ownerId) : null;
}

// ── Discord DM (replicated dapi pattern, support-tickets.js:107) ────────────
async function dmUser(env, userId, payload) {
  if (!env.DISCORD_BOT_TOKEN || !userId) return { ok: false };
  try {
    const ch = await fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'POST',
      headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'Content-Type': 'application/json', 'User-Agent': 'loadout-discord pvp' },
      body: JSON.stringify({ recipient_id: String(userId) }),
    });
    const chj = await ch.json().catch(() => null);
    if (!ch.ok || !chj?.id) return { ok: false };
    const r = await fetch(`https://discord.com/api/v10/channels/${chj.id}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'Content-Type': 'application/json', 'User-Agent': 'loadout-discord pvp' },
      body: JSON.stringify(payload),
    });
    return { ok: r.ok };
  } catch { return { ok: false }; }
}

// ── hero → combatant snapshot (with paper-doll art for the overlay) ─────────
async function snapshotFighter(env, guildId, userId, name) {
  const hero = await loadHero(env, guildId, userId);
  const eff = computeEffectiveStats(hero);
  let art = null;
  try { art = buildCompositeManifest(hero); } catch { art = null; }
  const record = await recordFor(env, userId);
  return combatantFromHero(hero, eff, { userId: String(userId), name: name || hero?.custom?.name || 'Fighter', record, art });
}

// W/L record from resolved battles where this user fought.
async function recordFor(env, userId) {
  const d = db(env);
  const row = await d.prepare(
    `SELECT
       SUM(CASE WHEN winner_id = ?1 THEN 1 ELSE 0 END) AS won,
       SUM(CASE WHEN status='resolved' AND winner_id IS NOT NULL AND winner_id <> ?1
                 AND (challenger_id = ?1 OR opponent_id = ?1) THEN 1 ELSE 0 END) AS lost
     FROM pvp_battle WHERE status='resolved' AND (challenger_id = ?1 OR opponent_id = ?1)`
  ).bind(String(userId)).first().catch(() => null);
  return { won: Number(row?.won) || 0, lost: Number(row?.lost) || 0 };
}

// ── public read serialisation ───────────────────────────────────────────────
// During the pre-fight window the result + winner are withheld so spectators
// can't peek. After the window (and settle) the full deterministic fight ships.
function windowOpen(b) { return b.status === 'active' && b.started_at && now() < b.started_at + (b.prefight_ms || PREFIGHT_MS); }

function serializeBattle(b, { reveal }) {
  const result = jparse(b.result, {});
  const base = {
    id: b.id, guildId: b.guild_id, mode: b.mode, wager: b.wager,
    challenger: { userId: b.challenger_id, name: b.challenger_name },
    opponent: b.opponent_id ? { userId: b.opponent_id, name: b.opponent_name } : null,
    status: windowOpen(b) ? 'prefight' : b.status,
    startedAt: b.started_at || null,
    prefightMs: b.prefight_ms || PREFIGHT_MS,
    prefightEndsAt: b.started_at ? b.started_at + (b.prefight_ms || PREFIGHT_MS) : null,
    fighters: result.combatants || null,   // {a,b} snapshots incl. art (safe to show)
  };
  if (reveal) {
    base.winnerId = b.winner_id || null;
    base.winnerSide = result.winner || null;
    base.rounds = result.rounds || 0;
    base.turns = result.turns || [];
    base.final = result.final || null;
  }
  return base;
}

// ════════════════════════════════════════════════════════════════════════════
// Router
// ════════════════════════════════════════════════════════════════════════════
export async function handlePvpRoute(req, env, path) {
  const method = req.method;
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);
  const parts = path.split('/').filter(Boolean);   // ['web','pvp', tail, ...]
  const tail = parts[2] || null;

  try {
    await ensureSchema(env);

    // ---- public GET reads (no HMAC) -------------------------------------
    if (method === 'GET') {
      if (tail === 'battle') return await getBattle(env, parts[3]);
      if (tail === 'queue') return await getQueue(env, url.searchParams.get('guild') || env.AQUILO_VAULT_GUILD_ID);
      if (tail === 'snapshot') return await getSnapshot(env, url.searchParams.get('userId'), url.searchParams.get('guildId') || env.AQUILO_VAULT_GUILD_ID);
      if (tail === 'history') return await getHistory(env, url.searchParams.get('userId'));
      return json({ error: 'not-found' }, 404);
    }

    // ---- HMAC-gated POST mutations --------------------------------------
    if (method === 'POST') {
      const g = await gateHmac(req, env);
      if (!g.ok) return json({ error: g.error }, g.status);
      const body = g.body || {};
      const discordId = String(body.discordId || body.userId || '').trim();
      const guildId = String(body.guildId || env.AQUILO_VAULT_GUILD_ID || '').trim();
      if (!/^\d{5,25}$/.test(discordId)) return json({ error: 'bad-discord-id' }, 400);
      if (!/^\d{5,25}$/.test(guildId)) return json({ error: 'bad-guild-id' }, 400);
      const battleId = String(parts[3] || body.battleId || '').trim();

      if (tail === 'challenge') return await doChallenge(env, guildId, discordId, body);
      if (tail === 'accept') return await doAccept(env, guildId, discordId, battleId);
      if (tail === 'decline') return await doDecline(env, guildId, discordId, battleId);
      if (tail === 'spectator-pick') return await doSpectatorPick(env, guildId, discordId, battleId, parts[4] || body.side, body.userName);
      if (tail === 'bet') return await doBet(env, guildId, discordId, battleId, parts[4] || body.side, Number(parts[5] != null ? parts[5] : body.amount), body.userName);
      return json({ error: 'not-found' }, 404);
    }

    return json({ error: 'method' }, 405);
  } catch (e) {
    return json({ error: 'internal', message: String(e?.message || e) }, 500);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Handlers
// ════════════════════════════════════════════════════════════════════════════

async function doChallenge(env, guildId, discordId, body) {
  const d = db(env);
  const wager = Math.max(0, Math.min(MAX_WAGER, Math.floor(Number(body.wager) || 0)));
  const challengerName = String(body.userName || body.challengerName || 'Challenger').slice(0, 32);

  // Target: a specific discord id, 'aquilo' (the streamer), or 'any' (queue).
  let rawTarget = String(body.target || 'any').trim().toLowerCase();
  let opponentId = null, mode = 'queue';
  if (rawTarget === 'aquilo' || rawTarget === 'streamer') {
    opponentId = await resolveAquilo(env, guildId);
    if (!opponentId) return json({ error: 'no-aquilo', message: 'Streamer identity not configured.' }, 400);
    mode = 'direct';
  } else if (/^\d{5,25}$/.test(rawTarget)) {
    opponentId = rawTarget; mode = 'direct';
  } else if (rawTarget === 'any' || rawTarget === 'queue') {
    opponentId = null; mode = 'queue';
  } else {
    return json({ error: 'bad-target' }, 400);
  }
  if (opponentId && opponentId === discordId) return json({ error: 'self-challenge' }, 400);

  // Escrow the challenger's wager up front.
  if (wager > 0) {
    const r = await spend(env, guildId, discordId, wager, 'pvp:wager:challenge');
    if (!r.ok) return json({ error: 'insufficient', message: 'Not enough bolts for that wager.', balance: r.balance }, 400);
  }

  // Queue mode: if there's a sitting champion (not the challenger), auto-match
  // against them — "next viewer to enter the queue auto-fights the champion".
  let autoStart = false;
  if (mode === 'queue') {
    const champ = await getChampion(env, guildId);
    if (champ && champ.userId && champ.userId !== discordId) {
      opponentId = String(champ.userId);
      mode = 'champion';
      autoStart = true;
    }
  }

  const id = rid('pb');
  await d.prepare(
    `INSERT INTO pvp_battle (id, guild_id, mode, challenger_id, challenger_name, opponent_id, opponent_name, status, wager, prefight_ms, created_at)
     VALUES (?,?,?,?,?,?,?, 'pending', ?, ?, ?)`
  ).bind(id, guildId, mode, discordId, challengerName, opponentId, null, wager, PREFIGHT_MS, now()).run();

  // Champion fights resolve immediately (the throne auto-accepts).
  if (autoStart && opponentId) {
    return await startBattle(env, guildId, id, { acceptorId: opponentId, acceptorWager: 0 });
  }

  // Direct challenge → DM the opponent.
  if (mode === 'direct' && opponentId) {
    await dmUser(env, opponentId, {
      embeds: [{
        title: '⚔️ PvP Challenge',
        description: `**${challengerName}** challenges you to a hero duel${wager ? ` for **${wager}** bolts` : ''}.\nAccept or decline at https://aquilo.gg/play/pvp`,
        color: 0x5b8def,
      }],
    }).catch(() => {});
  }

  await publishActivity(env, {
    kind: 'pvp.challenge.created', guildId, battleId: id,
    challenger: { userId: discordId, name: challengerName },
    opponent: opponentId ? { userId: opponentId } : null,
    mode, wager,
  }).catch(() => {});

  return json({ ok: true, battleId: id, status: 'pending', mode, wager, opponentId });
}

async function doAccept(env, guildId, discordId, battleId) {
  if (!idOk(battleId)) return json({ error: 'bad-battle-id' }, 400);
  const d = db(env);
  const b = await d.prepare(`SELECT * FROM pvp_battle WHERE id=?`).bind(battleId).first();
  if (!b) return json({ error: 'not-found' }, 404);
  if (b.status !== 'pending') return json({ error: 'not-pending', status: b.status }, 409);

  // Queue ('any') battles: the acceptor becomes the opponent. Direct battles:
  // only the named opponent may accept. A fighter can never accept their own.
  if (String(b.challenger_id) === String(discordId)) return json({ error: 'self-accept' }, 400);
  if (b.opponent_id && String(b.opponent_id) !== String(discordId)) return json({ error: 'not-your-challenge' }, 403);

  // Escrow the acceptor's matching wager.
  if (b.wager > 0) {
    const r = await spend(env, guildId, discordId, b.wager, 'pvp:wager:accept');
    if (!r.ok) return json({ error: 'insufficient', message: 'Not enough bolts to match the wager.', balance: r.balance }, 400);
  }
  return await startBattle(env, guildId, battleId, { acceptorId: discordId, acceptorName: null, acceptorWager: b.wager });
}

// Resolve the fight, persist the deterministic result, open the spectator
// window, and fire the overlay. Shared by direct-accept + champion-auto.
async function startBattle(env, guildId, battleId, { acceptorId, acceptorName, acceptorWager }) {
  const d = db(env);
  const b = await d.prepare(`SELECT * FROM pvp_battle WHERE id=?`).bind(battleId).first();
  if (!b) return json({ error: 'not-found' }, 404);

  const aId = String(b.challenger_id);
  const bId = String(acceptorId);
  const a = await snapshotFighter(env, guildId, aId, b.challenger_name);
  const opp = await snapshotFighter(env, guildId, bId, acceptorName || b.opponent_name);

  const seed = `${battleId}:${a.userId}:${opp.userId}`;
  const res = resolveBattle(a, opp, seed);
  const winnerId = res.winner === 'a' ? aId : res.winner === 'b' ? bId : null;
  const startedAt = now();

  await d.prepare(
    `UPDATE pvp_battle SET status='active', opponent_id=?, opponent_name=?, winner_id=?, seed=?, result=?, started_at=? WHERE id=?`
  ).bind(bId, opp.name, winnerId, seed, JSON.stringify(res), startedAt, battleId).run();

  // Persist per-turn events (honours the pvp_match_event contract).
  if (res.turns.length) {
    const ins = res.turns.map(t => d.prepare(
      `INSERT INTO pvp_match_event (id, battle_id, seq, actor, target, action, result, roll, damage, heal, effect, hp_a, hp_b, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(rid('pe'), battleId, t.turn, t.actor, t.target, t.action, t.result, t.roll || 0, t.damage || 0, t.heal || 0, t.effect || null, t.hp.a, t.hp.b, startedAt));
    try { await d.batch(ins); } catch { /* non-fatal: result JSON is authoritative */ }
  }

  // Overlay: ONE event carrying the entire fight. The overlay self-animates
  // pre-fight (PREFIGHT_MS) → turns → outro from this single deterministic
  // payload — no per-turn relay streaming (drain-on-read makes that fragile).
  const overlayPayload = {
    type: 'pvp_battle_start', bus_kind: 'pvp.battle.start',
    battleId, guildId, mode: b.mode, wager: b.wager,
    prefightMs: b.prefight_ms || PREFIGHT_MS,
    a: { ...a }, b: { ...opp },
    winnerSide: res.winner, winnerId,
    turns: res.turns, final: res.final, rounds: res.rounds,
    ts: startedAt,
  };
  await enqueueOverlay(env, overlayPayload).catch(() => {});
  await publishActivity(env, {
    kind: 'pvp.battle.start', guildId, battleId, mode: b.mode, wager: b.wager,
    a: { userId: aId, name: a.name }, b: { userId: bId, name: opp.name },
  }).catch(() => {});

  return json({ ok: true, battleId, status: 'active', prefightMs: b.prefight_ms || PREFIGHT_MS, prefightEndsAt: startedAt + (b.prefight_ms || PREFIGHT_MS) });
}

async function doDecline(env, guildId, discordId, battleId) {
  if (!idOk(battleId)) return json({ error: 'bad-battle-id' }, 400);
  const d = db(env);
  const b = await d.prepare(`SELECT * FROM pvp_battle WHERE id=?`).bind(battleId).first();
  if (!b) return json({ error: 'not-found' }, 404);
  if (b.status !== 'pending') return json({ error: 'not-pending', status: b.status }, 409);
  // Only the named opponent (or challenger cancelling) may decline.
  if (b.opponent_id && String(b.opponent_id) !== String(discordId) && String(b.challenger_id) !== String(discordId))
    return json({ error: 'not-your-challenge' }, 403);

  // Refund the challenger's escrowed wager.
  if (b.wager > 0) await earn(env, guildId, b.challenger_id, b.wager, 'pvp:wager:refund').catch(() => {});
  await d.prepare(`UPDATE pvp_battle SET status='declined', resolved_at=? WHERE id=?`).bind(now(), battleId).run();
  await dmUser(env, b.challenger_id, { content: `Your PvP challenge was declined. ${b.wager ? `Your ${b.wager} bolt wager was refunded.` : ''}` }).catch(() => {});
  return json({ ok: true, status: 'declined' });
}

async function doSpectatorPick(env, guildId, discordId, battleId, side, userName) {
  if (!idOk(battleId)) return json({ error: 'bad-battle-id' }, 400);
  side = String(side || '').toLowerCase();
  if (side !== 'a' && side !== 'b') return json({ error: 'bad-side' }, 400);
  const d = db(env);
  const b = await d.prepare(`SELECT * FROM pvp_battle WHERE id=?`).bind(battleId).first();
  if (!b) return json({ error: 'not-found' }, 404);
  if (!windowOpen(b)) return json({ error: 'window-closed', message: 'The pre-fight pick window is closed.' }, 409);
  // No picking a side you're fighting on.
  if (String(b.challenger_id) === discordId || String(b.opponent_id) === discordId) return json({ error: 'fighter-cannot-pick' }, 403);
  // One pick per spectator (upsert by replacing).
  await d.prepare(`DELETE FROM pvp_spectator_pick WHERE battle_id=? AND user_id=?`).bind(battleId, discordId).run();
  await d.prepare(
    `INSERT INTO pvp_spectator_pick (id, battle_id, user_id, user_name, picked_side, created_at) VALUES (?,?,?,?,?,?)`
  ).bind(rid('pp'), battleId, discordId, String(userName || '').slice(0, 32) || null, side, now()).run();
  return json({ ok: true, side });
}

async function doBet(env, guildId, discordId, battleId, side, amount, userName) {
  if (!idOk(battleId)) return json({ error: 'bad-battle-id' }, 400);
  side = String(side || '').toLowerCase();
  if (side !== 'a' && side !== 'b') return json({ error: 'bad-side' }, 400);
  amount = Math.floor(Number(amount) || 0);
  if (!(amount > 0) || amount > MAX_WAGER) return json({ error: 'bad-amount' }, 400);
  const d = db(env);
  const b = await d.prepare(`SELECT * FROM pvp_battle WHERE id=?`).bind(battleId).first();
  if (!b) return json({ error: 'not-found' }, 404);
  if (!windowOpen(b)) return json({ error: 'window-closed', message: 'Betting is closed for this fight.' }, 409);
  if (String(b.challenger_id) === discordId || String(b.opponent_id) === discordId) return json({ error: 'fighter-cannot-bet' }, 403);
  // One bet per spectator per battle.
  const existing = await d.prepare(`SELECT id FROM pvp_bet WHERE battle_id=? AND user_id=?`).bind(battleId, discordId).first();
  if (existing) return json({ error: 'already-bet' }, 409);

  const r = await spend(env, guildId, discordId, amount, 'pvp:bet:' + battleId);
  if (!r.ok) return json({ error: 'insufficient', message: 'Not enough bolts for that bet.', balance: r.balance }, 400);

  await d.prepare(
    `INSERT INTO pvp_bet (id, battle_id, user_id, user_name, picked_side, amount, created_at) VALUES (?,?,?,?,?,?,?)`
  ).bind(rid('pbet'), battleId, discordId, String(userName || '').slice(0, 32) || null, side, amount, now()).run();
  const w = await getWallet(env, guildId, discordId);
  return json({ ok: true, side, amount, balance: w.balance || 0 });
}

// ── settlement (idempotent; run on first read after the window closes) ──────
async function settleBattle(env, b) {
  const d = db(env);
  if (b.settled || b.status === 'resolved') return b;
  if (b.status !== 'active') return b;
  if (windowOpen(b)) return b;   // window still open — not yet

  const guildId = b.guild_id;
  const res = jparse(b.result, {});
  const winnerId = b.winner_id || null;          // null = draw
  const aId = String(b.challenger_id), bId = String(b.opponent_id);

  // 1) Wager pot → winner (draw refunds both sides).
  if (b.wager > 0) {
    if (!winnerId) {
      await earn(env, guildId, aId, b.wager, 'pvp:wager:draw-refund').catch(() => {});
      await earn(env, guildId, bId, b.wager, 'pvp:wager:draw-refund').catch(() => {});
    } else {
      await earn(env, guildId, winnerId, b.wager * 2, 'pvp:wager:win').catch(() => {});
    }
  }
  // Champion/queue throne prize for the challenger taking the throne.
  if (b.mode === 'champion' && winnerId === aId) {
    await earn(env, guildId, aId, THRONE_PRIZE, 'pvp:throne-prize').catch(() => {});
  }

  // 2) Spectator picks → fixed reward for correct side.
  const picks = (await d.prepare(`SELECT * FROM pvp_spectator_pick WHERE battle_id=?`).bind(b.id).all()).results || [];
  for (const p of picks) {
    const correct = winnerId && ((p.picked_side === 'a' && winnerId === aId) || (p.picked_side === 'b' && winnerId === bId));
    if (correct) await earn(env, guildId, p.user_id, PICK_REWARD, 'pvp:pick-reward').catch(() => {});
    await d.prepare(`UPDATE pvp_spectator_pick SET correct=?, reward=? WHERE id=?`).bind(correct ? 1 : 0, correct ? PICK_REWARD : 0, p.id).run();
  }

  // 3) Bets → parimutuel. Winners split the whole pot proportional to stake.
  const bets = (await d.prepare(`SELECT * FROM pvp_bet WHERE battle_id=? AND settled=0`).bind(b.id).all()).results || [];
  if (bets.length) {
    const winSide = winnerId === aId ? 'a' : winnerId === bId ? 'b' : null;
    const pot = bets.reduce((s, x) => s + (x.amount || 0), 0);
    const winStake = bets.filter(x => x.picked_side === winSide).reduce((s, x) => s + (x.amount || 0), 0);
    for (const x of bets) {
      let payout = 0;
      if (!winSide || winStake === 0) {
        payout = x.amount;   // draw or nobody backed the winner → refund stakes
      } else if (x.picked_side === winSide) {
        payout = Math.floor((x.amount / winStake) * pot);
      }
      if (payout > 0) await earn(env, guildId, x.user_id, payout, 'pvp:bet-payout:' + b.id).catch(() => {});
      await d.prepare(`UPDATE pvp_bet SET payout=?, settled=1, settled_at=? WHERE id=?`).bind(payout, now(), x.id).run();
    }
  }

  // 4) Champion throne update.
  if (winnerId) {
    const winnerName = res.winner === 'a' ? b.challenger_name : b.opponent_name;
    const champ = await getChampion(env, guildId);
    if (champ && String(champ.userId) === String(winnerId)) {
      champ.streak = (champ.streak || 1) + 1;
      champ.lastBattleId = b.id;
      await setChampion(env, guildId, champ);
      await earn(env, guildId, winnerId, HOLD_BONUS, 'pvp:hold-bonus').catch(() => {});
    } else {
      await setChampion(env, guildId, { userId: String(winnerId), name: winnerName || 'Champion', streak: 1, sinceUtc: now(), lastBattleId: b.id });
    }
  }

  await d.prepare(`UPDATE pvp_battle SET status='resolved', settled=1, resolved_at=? WHERE id=?`).bind(now(), b.id).run();
  b.status = 'resolved'; b.settled = 1; b.resolved_at = now();

  await publishActivity(env, {
    kind: 'pvp.battle.end', guildId, battleId: b.id, mode: b.mode,
    winner: winnerId ? { userId: winnerId, name: res.winner === 'a' ? b.challenger_name : b.opponent_name } : null,
    wager: b.wager, rounds: res.rounds || 0,
  }).catch(() => {});
  return b;
}

// Settle any active battles whose pre-fight window has elapsed (self-driving
// payouts without a cron). Bounded sweep, called from list reads.
async function sweepSettlements(env, guildId) {
  const d = db(env);
  const cutoff = now() - PREFIGHT_MS;
  const rows = (await d.prepare(
    `SELECT * FROM pvp_battle WHERE guild_id=? AND status='active' AND settled=0 AND started_at < ? ORDER BY started_at ASC LIMIT 10`
  ).bind(guildId, cutoff).all()).results || [];
  for (const b of rows) { try { await settleBattle(env, b); } catch { /* keep going */ } }
}

// ── reads ────────────────────────────────────────────────────────────────────
async function getBattle(env, battleId) {
  if (!idOk(battleId)) return json({ error: 'bad-battle-id' }, 400);
  const d = db(env);
  let b = await d.prepare(`SELECT * FROM pvp_battle WHERE id=?`).bind(battleId).first();
  if (!b) return json({ error: 'not-found' }, 404);
  if (b.status === 'active' && !windowOpen(b) && !b.settled) b = await settleBattle(env, b);
  const reveal = b.status === 'resolved' || b.status === 'declined';
  return json({ ok: true, battle: serializeBattle(b, { reveal }) });
}

async function getQueue(env, guildId) {
  if (!guildId) return json({ error: 'bad-guild' }, 400);
  const d = db(env);
  await sweepSettlements(env, guildId);
  const rows = (await d.prepare(
    `SELECT id, mode, challenger_id, challenger_name, wager, created_at FROM pvp_battle
     WHERE guild_id=? AND status='pending' AND opponent_id IS NULL ORDER BY created_at ASC LIMIT 25`
  ).bind(guildId).all()).results || [];
  const champion = await getChampion(env, guildId);
  return json({ ok: true, champion, queue: rows.map(r => ({ battleId: r.id, mode: r.mode, challenger: { userId: r.challenger_id, name: r.challenger_name }, wager: r.wager, createdAt: r.created_at })) });
}

async function getSnapshot(env, userId, guildId) {
  userId = String(userId || '').trim();
  if (!/^\d{5,25}$/.test(userId)) return json({ error: 'bad-user' }, 400);
  const d = db(env);
  await sweepSettlements(env, guildId);
  const champion = await getChampion(env, guildId);
  // Pending challenges TO this user (need to accept/decline).
  const incoming = (await d.prepare(
    `SELECT id, mode, challenger_id, challenger_name, wager, created_at FROM pvp_battle
     WHERE opponent_id=? AND status='pending' ORDER BY created_at DESC LIMIT 10`
  ).bind(userId).all()).results || [];
  // This user's own pending/active battles.
  const mine = (await d.prepare(
    `SELECT id, mode, status, challenger_id, opponent_id, wager, started_at, prefight_ms FROM pvp_battle
     WHERE (challenger_id=? OR opponent_id=?) AND status IN ('pending','active') ORDER BY created_at DESC LIMIT 10`
  ).bind(userId, userId).all()).results || [];
  const record = await recordFor(env, userId);
  return json({
    ok: true, userId, champion, record,
    incoming: incoming.map(r => ({ battleId: r.id, mode: r.mode, challenger: { userId: r.challenger_id, name: r.challenger_name }, wager: r.wager, createdAt: r.created_at })),
    active: mine.map(r => ({ battleId: r.id, mode: r.mode, status: r.status, wager: r.wager, startedAt: r.started_at, prefightMs: r.prefight_ms })),
  });
}

async function getHistory(env, userId) {
  userId = String(userId || '').trim();
  if (!/^\d{5,25}$/.test(userId)) return json({ error: 'bad-user' }, 400);
  const d = db(env);
  const rows = (await d.prepare(
    `SELECT id, mode, status, challenger_id, challenger_name, opponent_id, opponent_name, winner_id, wager, resolved_at
     FROM pvp_battle WHERE status='resolved' AND (challenger_id=? OR opponent_id=?) ORDER BY resolved_at DESC LIMIT ?`
  ).bind(userId, userId, HISTORY_LIMIT).all()).results || [];
  return json({
    ok: true, userId,
    history: rows.map(r => ({
      battleId: r.id, mode: r.mode, wager: r.wager, resolvedAt: r.resolved_at,
      you: userId === String(r.challenger_id) ? 'a' : 'b',
      challenger: { userId: r.challenger_id, name: r.challenger_name },
      opponent: { userId: r.opponent_id, name: r.opponent_name },
      winnerId: r.winner_id,
      result: r.winner_id == null ? 'draw' : (String(r.winner_id) === userId ? 'won' : 'lost'),
    })),
  });
}

// Panel bridge — called from ext.js for the "Challenge Aquilo" button. The
// caller resolves the Twitch viewer → discord id (plink). identity is the
// loadout user id ('tw:<id>') if unlinked.
export async function extPvpChallenge(env, guildId, callerId, viewerName, wager) {
  await ensureSchema(env);
  const opponentId = await resolveAquilo(env, guildId);
  if (!opponentId) return { ok: false, error: 'no-aquilo' };
  // doChallenge returns a Response; the panel wants a plain object, so inline
  // the essentials here (auth already done by the panel JWT, no HMAC needed).
  const w = Math.max(0, Math.min(MAX_WAGER, Math.floor(Number(wager) || 0)));
  if (String(callerId) === String(opponentId)) return { ok: false, error: 'self-challenge' };
  if (w > 0) {
    const r = await spend(env, guildId, callerId, w, 'pvp:wager:challenge');
    if (!r.ok) return { ok: false, error: 'insufficient', balance: r.balance };
  }
  const d = db(env);
  const id = rid('pb');
  await d.prepare(
    `INSERT INTO pvp_battle (id, guild_id, mode, challenger_id, challenger_name, opponent_id, status, wager, prefight_ms, created_at)
     VALUES (?,?, 'direct', ?,?,?, 'pending', ?, ?, ?)`
  ).bind(id, guildId, String(callerId), String(viewerName || 'Viewer').slice(0, 32), opponentId, w, PREFIGHT_MS, now()).run();
  await dmUser(env, opponentId, {
    embeds: [{ title: '⚔️ PvP Challenge (Twitch)', description: `**${viewerName || 'A viewer'}** challenges you${w ? ` for **${w}** bolts` : ''} from the panel.`, color: 0x5b8def }],
  }).catch(() => {});
  return { ok: true, battleId: id, wager: w };
}

export async function extPvpState(env, guildId) {
  await ensureSchema(env);
  await sweepSettlements(env, guildId).catch(() => {});
  const champion = await getChampion(env, guildId);
  const d = db(env);
  const active = (await d.prepare(
    `SELECT id, status, started_at, prefight_ms FROM pvp_battle WHERE guild_id=? AND status='active' ORDER BY started_at DESC LIMIT 1`
  ).bind(guildId).first().catch(() => null));
  return { ok: true, champion, activeBattleId: active?.id || null };
}
