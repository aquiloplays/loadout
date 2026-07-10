// Tank Battle — the in-panel turn-based artillery game backend for the
// Aquilo Twitch extension.
//
// The game (from the panel frontend, public/twitch-panel/panel.js):
//   Lobby → join (Bolts entry fee, pooled into a pot) → mod/any player
//   starts once 2+ tanks are in → players take turns firing (set power
//   1–100 + a left/right direction; the SERVER does the ballistics +
//   wind and computes the landing point and damage) → last tank standing
//   takes the whole pot. A shared, per-channel battlefield: one battle
//   per Twitch channel at a time.
//
// Multi-tenant: `guildId` and `userId` are ALREADY resolved per-channel
// by ext.js (guildId = channel namespace, userId = `tw:<id>`). We use
// them verbatim and NEVER re-derive. The battle is shared state, so it
// lives at a single per-channel key `tanks:<guildId>`; every state read
// is personalized for the caller (me / joined / myTurn) at render time.
//
// Everything that matters is computed server-side: the client only sends
// power (1–100) and dir (±1); it never sends aim, landing, or damage.
//
// Routes (all under /ext/tanks/):
//   GET  /ext/tanks/state          -> full battle state (personalized)
//   POST /ext/tanks/join  {name}   -> open/join a lobby (spends entryFee)
//   POST /ext/tanks/start {name}   -> begin the battle (2+ tanks)
//   POST /ext/tanks/fire  {power,dir,name} -> take your shot
//   POST /ext/tanks/cancel {name}  -> mod: end + refund every entry fee

import { getWallet, putWallet, earn, spend } from './wallet.js';

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

// ── tunables ─────────────────────────────────────────────────────────
const ENTRY_FEE = 50;          // Bolts per tank; whole lobby pools into the pot
const MAX_PLAYERS = 6;         // lobby cap
const START_HP = 100;
const FIELD_MIN = 8;           // battlefield x spread (percent)
const FIELD_MAX = 92;
const RANGE_FACTOR = 0.85;     // power 100 → ~85% of field width travelled
const SCATTER = 2;             // ± percent random scatter on every shot
const WIND_MAX = 8;            // wind is an integer in [-8, 8] percent
const HIT_RADIUS = 7;          // a shot landing within this of a tank hits it
const DMG_MIN = 18;            // edge-of-radius damage
const DMG_MAX = 60;            // dead-centre damage
const GAME_TTL = 6 * 60 * 60;  // stale battles self-clean after 6h

const gameKey = (guildId) => `tanks:${guildId}`;

// Light anti-spam on the mutating routes, keyed with guildId so it stays
// channel-isolated. Stored value is Date.now(); the timestamp enforces
// the real ~700ms window (KV TTL floors at 60s).
const SPAM_WINDOW_MS = 700;
const cdKey = (guildId, userId) => `tankcd:${guildId}:${userId}`;

async function rateLimited(env, guildId, userId) {
  try {
    const key = cdKey(guildId, userId);
    const last = parseInt((await env.LOADOUT_BOLTS.get(key)) || '0', 10);
    const now = Date.now();
    if (last && now - last < SPAM_WINDOW_MS) return true;
    await env.LOADOUT_BOLTS.put(key, String(now), { expirationTtl: 60 });
    return false;
  } catch {
    // Never block a shot because the cooldown store hiccuped.
    return false;
  }
}

// ── storage ──────────────────────────────────────────────────────────
async function loadGame(env, guildId) {
  try {
    return await env.LOADOUT_BOLTS.get(gameKey(guildId), { type: 'json' });
  } catch {
    return null;
  }
}

async function saveGame(env, guildId, g) {
  await env.LOADOUT_BOLTS.put(gameKey(guildId), JSON.stringify(g), {
    expirationTtl: GAME_TTL,
  });
}

async function clearGame(env, guildId) {
  try { await env.LOADOUT_BOLTS.delete(gameKey(guildId)); } catch { /* idle */ }
}

// Persist the viewer's display name onto their wallet so any Bolts
// leaderboard renders a name (cosmetic; never fail a play over it).
async function rememberName(env, guildId, userId, name) {
  const nm = (name || '').toString().trim().slice(0, 40);
  if (!nm) return;
  try {
    const w = await getWallet(env, guildId, userId);
    if (w.name !== nm) {
      w.name = nm;
      await putWallet(env, guildId, userId, w);
    }
  } catch { /* name is cosmetic */ }
}

// ── helpers ──────────────────────────────────────────────────────────
function cleanName(meta, body) {
  const nm = ((meta && meta.name) || (body && body.name) || '').toString().trim();
  return nm.slice(0, 40);
}

// Spread the live tanks evenly across the battlefield. Called on every
// lobby join (repositions), then frozen once the battle starts (joins
// are refused during battle).
function assignPositions(g) {
  const n = g.players.length;
  g.players.forEach((p, i) => {
    p.x = n <= 1 ? 50 : Math.round(FIELD_MIN + ((FIELD_MAX - FIELD_MIN) * i) / (n - 1));
  });
}

function rollWind() {
  return Math.floor(Math.random() * (WIND_MAX * 2 + 1)) - WIND_MAX;
}

function aliveCount(g) {
  return g.players.filter((p) => p.alive).length;
}

// Next alive player after fromIdx (wraps). Falls back to fromIdx.
function nextAliveIdx(g, fromIdx) {
  const n = g.players.length;
  for (let step = 1; step <= n; step++) {
    const idx = (fromIdx + step) % n;
    if (g.players[idx].alive) return idx;
  }
  return fromIdx;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Build the caller-personalized state object the panel renders. Shared
// battle fields plus per-viewer me/joined/myTurn.
function stateView(g, userId) {
  const idle = { active: false, status: 'idle', entryFee: ENTRY_FEE, pot: 0, players: [] };
  if (!g || !g.status || g.status === 'idle') return idle;

  const active = g.status === 'lobby' || g.status === 'battle';
  const players = g.players.map((p) => ({
    name: p.name,
    x: p.x,
    hp: Math.max(0, p.hp),
    alive: p.alive,
    me: p.id === userId,
  }));

  let turnName = null;
  let myTurn = false;
  if (g.status === 'battle') {
    const cur = g.players[g.turnIdx];
    if (cur) {
      turnName = cur.name;
      myTurn = cur.id === userId && cur.alive;
    }
  }

  return {
    active,
    status: g.status,
    entryFee: ENTRY_FEE,
    pot: g.pot || 0,
    wind: g.wind || 0,
    players,
    lastShot: g.lastShot || null,
    winner: g.winner || null,
    turnName,
    joined: g.players.some((p) => p.id === userId),
    myTurn,
  };
}

// ── actions ──────────────────────────────────────────────────────────

// Open a fresh lobby (or join the running one). Spends the entry fee
// into the pot. A finished ('done') battle is recycled into a new lobby.
async function doJoin(env, guildId, userId, name) {
  if (!name) {
    return json({ error: 'identity-required', message: 'Share your Twitch identity to play.' }, 400);
  }

  let g = await loadGame(env, guildId);

  // A battle already underway can't be joined.
  if (g && g.status === 'battle') {
    return json({ error: 'in-progress', message: 'A battle is already underway.' }, 409);
  }

  // No game, or the previous one finished → start a brand-new lobby.
  if (!g || g.status === 'idle' || g.status === 'done') {
    g = { status: 'lobby', pot: 0, wind: 0, turnIdx: 0, lastShot: null, winner: null, players: [] };
  }

  // Already in this lobby — no double charge, just echo state.
  if (g.players.some((p) => p.id === userId)) {
    await saveGame(env, guildId, g);
    return json(stateView(g, userId));
  }

  if (g.players.length >= MAX_PLAYERS) {
    return json({ error: 'full', message: 'Lobby is full.' }, 409);
  }

  // Charge the entry fee first; only seat the tank if the spend clears.
  const paid = await spend(env, guildId, userId, ENTRY_FEE, 'tanks:entry');
  if (!paid.ok) {
    return json({ error: 'insufficient', message: 'Not enough Bolts.' }, 402);
  }

  g.players.push({ id: userId, name, hp: START_HP, alive: true, x: 50 });
  g.pot = (g.pot || 0) + ENTRY_FEE;
  assignPositions(g);
  await saveGame(env, guildId, g);
  return json(stateView(g, userId));
}

// Begin the battle. Any seated player (or a mod) may start once 2+ tanks
// are in.
async function doStart(env, guildId, userId, isClay) {
  const g = await loadGame(env, guildId);
  if (!g || g.status !== 'lobby') {
    return json({ error: 'not-found', message: 'No lobby to start.' }, 404);
  }
  const joined = g.players.some((p) => p.id === userId);
  if (!joined && !isClay) {
    return json({ error: 'forbidden', message: 'Join the lobby first.' }, 403);
  }
  if (g.players.length < 2) {
    return json({ error: 'need-players', message: 'Need 2+ tanks.' }, 400);
  }

  g.status = 'battle';
  assignPositions(g);
  g.wind = rollWind();
  g.turnIdx = 0;
  g.lastShot = null;
  await saveGame(env, guildId, g);
  return json(stateView(g, userId));
}

// Take a shot. The client sends only power (1–100) + dir (±1); the
// server owns the ballistics, wind, landing point, and damage.
async function doFire(env, guildId, userId, body) {
  const g = await loadGame(env, guildId);
  if (!g || g.status !== 'battle') {
    return json({ error: 'not-your-turn', message: 'No battle in progress.' }, 409);
  }
  const cur = g.players[g.turnIdx];
  if (!cur || cur.id !== userId || !cur.alive) {
    return json({ error: 'not-your-turn', message: 'Not your turn.' }, 409);
  }

  const power = clamp(Math.floor(Number(body.power)), 1, 100) || 1;
  const dir = Number(body.dir) < 0 ? -1 : 1;

  // Ballistics: distance travelled scales with power; wind pushes the
  // shell along the +x axis; a little scatter keeps it honest.
  const scatter = (Math.random() * 2 - 1) * SCATTER;
  const rawLanding = cur.x + dir * (power * RANGE_FACTOR) + g.wind + scatter;
  const landing = Math.round(clamp(rawLanding, 0, 100));

  // Closest enemy tank within the blast radius takes the hit.
  let target = null;
  let bestDist = Infinity;
  for (const p of g.players) {
    if (!p.alive || p.id === userId) continue;
    const dist = Math.abs(rawLanding - p.x);
    if (dist <= HIT_RADIUS && dist < bestDist) {
      bestDist = dist;
      target = p;
    }
  }

  const shot = { by: cur.name, power, dir, landing, hit: null, dmg: 0, killed: false };
  if (target) {
    // Dead-centre → DMG_MAX, edge of radius → DMG_MIN.
    const dmg = Math.round(DMG_MIN + (DMG_MAX - DMG_MIN) * (1 - bestDist / HIT_RADIUS));
    target.hp = Math.max(0, target.hp - dmg);
    shot.hit = target.name;
    shot.dmg = dmg;
    if (target.hp <= 0) {
      target.alive = false;
      shot.killed = true;
    }
  }
  g.lastShot = shot;

  // Win check → last tank standing takes the pot.
  if (aliveCount(g) <= 1) {
    const survivor = g.players.find((p) => p.alive) || null;
    g.status = 'done';
    const pot = g.pot || 0;
    if (survivor) {
      try { await earn(env, guildId, survivor.id, pot, 'tanks:win'); } catch { /* pot payout best-effort */ }
      g.winner = { name: survivor.name, pot };
      // Surface the battle finish on the OBS overlay event bus (best-effort).
      try {
        const { pushGameEvent } = await import('./ext-events.js');
        await pushGameEvent(env, guildId, { type: 'tanks-win', name: survivor.name || 'A tank', amount: pot });
      } catch { /* overlay flourish must never break the game */ }
    } else {
      g.winner = null;
    }
    await saveGame(env, guildId, g);
    return json(stateView(g, userId));
  }

  // Otherwise pass the turn to the next living tank and re-roll wind.
  g.turnIdx = nextAliveIdx(g, g.turnIdx);
  g.wind = rollWind();
  await saveGame(env, guildId, g);
  return json(stateView(g, userId));
}

// Mod-only: end the battle and refund every entry fee.
async function doCancel(env, guildId, userId, isClay) {
  if (!isClay) {
    return json({ error: 'forbidden', message: 'Mods only.' }, 403);
  }
  const g = await loadGame(env, guildId);
  if (!g || g.status === 'idle') {
    return json(stateView(null, userId));
  }
  if (g.status !== 'done') {
    for (const p of g.players) {
      try { await earn(env, guildId, p.id, ENTRY_FEE, 'tanks:refund'); } catch { /* refund best-effort */ }
    }
  }
  await clearGame(env, guildId);
  return json(stateView(null, userId));
}

// ── entry point ──────────────────────────────────────────────────────
// sub: the action after /ext/tanks/ ('state'|'join'|'start'|'fire'|
// 'cancel'). meta = { twId, name, isClay }.
export async function handleTanks(env, guildId, userId, sub, req, meta) {
  meta = meta || {};

  // Read-only state — no rate limit.
  if (sub === 'state') {
    const g = await loadGame(env, guildId);
    return json(stateView(g, userId));
  }

  // Everything else mutates the shared battle — POST + anti-spam gated.
  const body = await req.json().catch(() => ({}));

  if (await rateLimited(env, guildId, userId)) {
    return json({ error: 'rate', message: 'Slow down a sec.' }, 429);
  }

  const name = cleanName(meta, body);
  // Stamp the display name on the wallet so leaderboards have a name.
  await rememberName(env, guildId, userId, name);

  switch (sub) {
    case 'join':   return doJoin(env, guildId, userId, name);
    case 'start':  return doStart(env, guildId, userId, !!meta.isClay);
    case 'fire':   return doFire(env, guildId, userId, body);
    case 'cancel': return doCancel(env, guildId, userId, !!meta.isClay);
    default:       return json({ error: 'not-found' }, 404);
  }
}
