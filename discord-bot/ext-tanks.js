// Tank Battle — worker-authoritative turn-based artillery for the Twitch panel
// (/ext/tanks/*). Up to 4 viewers join a lobby (Bolts entry fee → shared pot),
// then take turns firing (power + direction; simple ballistics + per-round
// wind). The nearest enemy within the blast tolerance takes damage; last tank
// alive wins the pot. Twitch chat announces start + winner. One game per
// channel, KV-backed, TTL-expired.

import { json, debounced } from './ext-shared.js';
import { getWallet, putWallet } from './wallet.js';
import { sendChatMessage } from './twitch-helix.js';

const GAME_KEY = (g) => `tanks:${g}:game`;
const GAME_TTL_S = 30 * 60;
const ENTRY_FEE = 50;
const MAX_PLAYERS = 4;
const START_HP = 100;
const SLOTS = [8, 36, 64, 92];      // tank x-positions across a 0..100 field
const DIST_SCALE = 0.85;            // power → horizontal distance
const WIND_SCALE = 1.3;
const HIT_TOLERANCE = 13;           // within this many x-units of the blast = hit
const MAX_DAMAGE = 45;

const cleanName = (s) => String(s || '').replace(/[^\w \-]/g, '').trim().slice(0, 25);

function announce(env, ctx, text) {
  try {
    const p = sendChatMessage(env, text);
    if (ctx && ctx.waitUntil) ctx.waitUntil(Promise.resolve(p).catch(() => {}));
  } catch { /* best-effort */ }
}

function view(game, meId) {
  if (!game) return { active: false, status: 'idle', entryFee: ENTRY_FEE };
  const players = game.players || [];
  const v = {
    active: game.status === 'lobby' || game.status === 'battle',
    status: game.status, // lobby | battle | done
    pot: game.pot || 0,
    entryFee: ENTRY_FEE,
    maxPlayers: MAX_PLAYERS,
    wind: game.wind || 0,
    players: players.map((p) => ({
      name: p.name, x: p.x, hp: p.hp, alive: p.hp > 0, me: !!(meId && p.userId === meId),
    })),
    turnName: game.status === 'battle' && players[game.turn] ? players[game.turn].name : null,
    lastShot: game.lastShot || null,
    winner: game.winner || null,
    myTurn: false,
    joined: false,
  };
  if (meId) {
    const idx = players.findIndex((p) => p.userId === meId);
    v.joined = idx >= 0;
    v.myTurn = game.status === 'battle' && idx === game.turn && players[idx] && players[idx].hp > 0;
  }
  return v;
}

function alivePlayers(game) {
  return (game.players || []).filter((p) => p.hp > 0);
}

function advanceTurn(game) {
  const n = game.players.length;
  for (let i = 1; i <= n; i++) {
    const idx = (game.turn + i) % n;
    if (game.players[idx].hp > 0) { game.turn = idx; return; }
  }
}

async function save(env, guildId, game) {
  await env.LOADOUT_BOLTS.put(GAME_KEY(guildId), JSON.stringify(game), { expirationTtl: GAME_TTL_S });
}

export async function handleExtTanks(env, ctx, guildId, userId, payload, sub, req) {
  const role = String((payload && payload.role) || 'viewer');
  const isMod = role === 'broadcaster' || role === 'moderator';
  const key = GAME_KEY(guildId);
  const hasIdentity = !!(payload && payload.user_id);

  if (req.method === 'GET' && sub === 'state') {
    const game = await env.LOADOUT_BOLTS.get(key, { type: 'json' });
    return json(view(game, userId));
  }

  let body = {};
  if (req.method === 'POST') { try { body = await req.json(); } catch { body = {}; } }
  const who = cleanName(body.name) || 'A viewer';

  // Join / open a lobby -------------------------------------------------
  if (req.method === 'POST' && sub === 'join') {
    if (!hasIdentity) return json({ error: 'identity-required', message: 'Share your Twitch identity to play for Bolts.' }, 403);
    if (await debounced(env, 'tanks-join', guildId, userId)) {
      const g = await env.LOADOUT_BOLTS.get(key, { type: 'json' });
      return json({ error: 'slow-down', ...view(g, userId) }, 429);
    }
    let game = await env.LOADOUT_BOLTS.get(key, { type: 'json' });
    if (!game || game.status === 'done') {
      game = { status: 'lobby', players: [], pot: 0, wind: 0, turn: 0, createdAt: Date.now() };
    }
    if (game.status !== 'lobby') return json({ error: 'in-progress', message: 'A battle is already underway.', ...view(game, userId) }, 409);
    if (game.players.find((p) => p.userId === userId)) return json({ already: true, ...view(game, userId) });
    if (game.players.length >= MAX_PLAYERS) return json({ error: 'full', message: 'Lobby is full.', ...view(game, userId) }, 409);
    // Charge the entry fee.
    const w = await getWallet(env, guildId, userId);
    if ((w.balance || 0) < ENTRY_FEE) return json({ error: 'insufficient', message: `Need ${ENTRY_FEE} Bolts to join.`, ...view(game, userId) }, 400);
    w.balance -= ENTRY_FEE;
    w.lifetimeSpent = (w.lifetimeSpent || 0) + ENTRY_FEE;
    w.lastSpendReason = 'tanks-entry';
    await putWallet(env, guildId, userId, w);
    game.players.push({ userId, name: who, x: SLOTS[game.players.length], hp: START_HP });
    game.pot += ENTRY_FEE;
    await save(env, guildId, game);
    return json({ ok: true, joined: true, ...view(game, userId) });
  }

  // Start the battle ----------------------------------------------------
  if (req.method === 'POST' && sub === 'start') {
    const game = await env.LOADOUT_BOLTS.get(key, { type: 'json' });
    if (!game || game.status !== 'lobby') return json({ error: 'no-lobby' }, 409);
    const joined = game.players.some((p) => p.userId === userId);
    if (!isMod && !joined) return json({ error: 'forbidden', message: 'Only a player or a mod can start.' }, 403);
    if (game.players.length < 2) return json({ error: 'need-players', message: 'Need at least 2 tanks.', ...view(game, userId) }, 400);
    game.status = 'battle';
    game.wind = Math.round((Math.random() * 6 - 3) * 10) / 10; // -3.0..3.0
    game.turn = 0;
    game.lastShot = null;
    await save(env, guildId, game);
    announce(env, ctx, `💥 Tank battle! ${game.players.length} tanks, ${game.pot} Bolts on the line. Wind ${game.wind > 0 ? '→' : '←'} ${Math.abs(game.wind)}. Last tank standing takes the pot!`);
    return json({ ok: true, ...view(game, userId) });
  }

  // Fire ----------------------------------------------------------------
  if (req.method === 'POST' && sub === 'fire') {
    const game = await env.LOADOUT_BOLTS.get(key, { type: 'json' });
    if (!game || game.status !== 'battle') return json({ error: 'no-battle' }, 409);
    const meIdx = game.players.findIndex((p) => p.userId === userId);
    if (meIdx < 0 || game.players[meIdx].hp <= 0) return json({ error: 'not-in-battle' }, 403);
    if (meIdx !== game.turn) return json({ error: 'not-your-turn', message: 'Wait for your turn.', ...view(game, userId) }, 409);
    if (await debounced(env, 'tanks-fire', guildId, userId)) return json({ error: 'slow-down', ...view(game, userId) }, 429);

    const power = Math.max(1, Math.min(100, Math.floor(Number(body.power) || 0)));
    const dir = Number(body.dir) < 0 ? -1 : 1;
    const me = game.players[meIdx];
    const landing = me.x + dir * power * DIST_SCALE + game.wind * WIND_SCALE;

    // Nearest OTHER living tank to the blast point.
    let best = null, bestDist = Infinity;
    for (const q of game.players) {
      if (q.userId === me.userId || q.hp <= 0) continue;
      const d = Math.abs(q.x - landing);
      if (d < bestDist) { bestDist = d; best = q; }
    }
    let dmg = 0, hitName = null;
    if (best && bestDist <= HIT_TOLERANCE) {
      dmg = Math.max(5, Math.round(MAX_DAMAGE * (1 - bestDist / HIT_TOLERANCE)));
      best.hp = Math.max(0, best.hp - dmg);
      hitName = best.name;
    }
    game.lastShot = { by: me.name, power, dir, landing: Math.round(landing), hit: hitName, dmg, killed: !!(best && best.hp <= 0 && dmg) };

    const alive = alivePlayers(game);
    if (alive.length <= 1) {
      game.status = 'done';
      const winner = alive[0] || null;
      if (winner) {
        const w = await getWallet(env, guildId, winner.userId);
        w.balance = (w.balance || 0) + (game.pot || 0);
        w.lifetimeEarned = (w.lifetimeEarned || 0) + (game.pot || 0);
        w.lastEarnReason = 'tanks-win';
        await putWallet(env, guildId, winner.userId, w);
        game.winner = { name: winner.name, pot: game.pot };
        announce(env, ctx, `🏆 ${winner.name} wins the tank battle and ${game.pot} Bolts! GG.`);
      } else {
        game.winner = { name: null, pot: game.pot };
      }
      await save(env, guildId, game);
      return json({ ok: true, ...view(game, userId) });
    }

    advanceTurn(game);
    await save(env, guildId, game);
    return json({ ok: true, hit: hitName, dmg, ...view(game, userId) });
  }

  // Cancel / refund (mod) ----------------------------------------------
  if (req.method === 'POST' && sub === 'cancel') {
    if (!isMod) return json({ error: 'forbidden' }, 403);
    const game = await env.LOADOUT_BOLTS.get(key, { type: 'json' });
    if (game && game.status !== 'done') {
      // Refund entry fees.
      for (const p of (game.players || [])) {
        try {
          const w = await getWallet(env, guildId, p.userId);
          w.balance = (w.balance || 0) + ENTRY_FEE;
          w.lifetimeSpent = Math.max(0, (w.lifetimeSpent || 0) - ENTRY_FEE);
          await putWallet(env, guildId, p.userId, w);
        } catch { /* best-effort refund */ }
      }
    }
    await env.LOADOUT_BOLTS.delete(key);
    return json({ ok: true, active: false, status: 'idle' });
  }

  return json({ error: 'not-found' }, 404);
}
