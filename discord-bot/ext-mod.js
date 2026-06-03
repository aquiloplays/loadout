// Moderator + broadcaster surface for the Twitch panel.
//
// The Twitch extension JWT payload carries `role` = 'viewer' |
// 'moderator' | 'broadcaster' | 'external', signed by Twitch. handleExt
// has already verified the JWT and the channel gate before reaching
// here, we only need to gate on role.
//
// Routes (all JWT-gated, mod/broadcaster role required):
//
//   GET  /ext/mod/state, capabilities + current queue
//                                         snapshot + dungeon cooldown
//                                         so the panel's mod section
//                                         can populate without three
//                                         separate fetches.
//   GET  /ext/mod/games, list of game ids known to the
//                                         site (passes through
//                                         /games/public).
//   POST /ext/mod/queue/open, { gameId, capMode?, cap? }
//   POST /ext/mod/queue/close, { gameId }
//   POST /ext/mod/queue/close-night, close all queues for tonight.
//   POST /ext/mod/dungeon/skip, enqueue a free 'skip' command
//                                         into the DLL command queue
//                                         (no Bits/bolts charge).
//
// All write routes also notify aquilo-site PWA push when relevant
// (queue opened) so the rest of the platform stays in sync.

import { json } from './ext-shared.js';
import {
  openQueue,
  closeQueue,
  closeNight,
  snapshotQueue,
  notifyQueueOpened,
} from './queue.js';
import { dungeonCooldownState } from './ext-panelbridge.js';
import { resolveTwitchLoginById } from './ext-loadout.js';

const MOD_ROLES = new Set(['moderator', 'broadcaster']);

function isMod(payload) {
  if (!payload) return false;
  const r = String(payload.role || '').toLowerCase();
  return MOD_ROLES.has(r);
}

// Public entry. `route` is the suffix after '/ext/mod/'.
export async function handleExtMod(env, guildId, payload, req, ctx, route) {
  if (!isMod(payload)) return json({ error: 'forbidden', reason: 'not-mod' }, 403);

  const r = String(route || '').replace(/\/+$/, '');

  if (req.method === 'GET' && r === 'state') return modState(env, guildId);
  if (req.method === 'GET' && r === 'games') return modGames(env);
  if (req.method === 'POST' && r === 'queue/open') return modQueueOpen(env, guildId, req, ctx);
  if (req.method === 'POST' && r === 'queue/close') return modQueueClose(env, guildId, req);
  if (req.method === 'POST' && r === 'queue/close-night') return modQueueCloseNight(env, guildId);
  if (req.method === 'POST' && r === 'dungeon/skip') return modDungeonSkip(env, payload, req);

  return json({ error: 'not-found' }, 404);
}

// GET /ext/mod/state, bundled snapshot the panel uses to render
// the moderator card without three round-trips.
async function modState(env, guildId) {
  const queueSnap = await snapshotQueue(env, guildId);
  // Pull the dungeon cooldown the same way the panel's existing
  // /ext/dungeon/cooldown does (returns active=false when nothing
  // is in effect).
  const cdResp = await dungeonCooldownState(env);
  let cooldown = { active: false };
  try { cooldown = await cdResp.clone().json(); } catch { /* default */ }

  return json({
    ok: true,
    capabilities: ['queue', 'dungeon-skip'],
    queue: queueSnap,
    dungeonCooldown: cooldown,
  });
}

// GET /ext/mod/games, game catalog the queue admin needs for the
// "Open queue for <game>" picker. Wraps the existing /games/public
// snapshot the bot already builds for the website + panel.
async function modGames(env) {
  try {
    const { handlePublicGamesHttp } = await import('./schedule.js');
    const r = await handlePublicGamesHttp(env);
    const body = await r.clone().json();
    const games = (body && body.games && Array.isArray(body.games.items))
      ? body.games.items.map((g) => ({
          id: g.id,
          name: g.name || g.id,
          accent: g.accent || null,
        }))
      : [];
    return json({ ok: true, games });
  } catch {
    return json({ ok: true, games: [] });
  }
}

// POST /ext/mod/queue/open  body: { gameId, capMode?, cap? }
async function modQueueOpen(env, guildId, req, ctx) {
  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad-json' }, 400); }

  const gameId = String((body && body.gameId) || '').trim().toLowerCase();
  if (!gameId) return json({ error: 'no-game' }, 400);
  const capMode = body && body.capMode === 'per-night' ? 'per-night'
    : body && body.capMode === 'per-match' ? 'per-match'
    : null;
  const cap = body && Number.isFinite(Number(body.cap)) ? Math.floor(Number(body.cap)) : null;

  const result = await openQueue(env, guildId, {
    gameId,
    capMode: capMode || undefined,
    cap: cap || undefined,
    source: 'panel-mod',
  });

  // Fire the PWA push notification on a successful open so the
  // broadcaster's existing audience flow still works when the queue
  // is opened from the panel.
  if (result && result.ok) {
    const fanout = (async () => {
      try { await notifyQueueOpened(env, guildId, result.streamDate, gameId); }
      catch { /* idle */ }
    })();
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(fanout);
    else await fanout;
  }

  return json(result);
}

// POST /ext/mod/queue/close  body: { gameId }
async function modQueueClose(env, guildId, req) {
  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad-json' }, 400); }
  const gameId = String((body && body.gameId) || '').trim().toLowerCase();
  if (!gameId) return json({ error: 'no-game' }, 400);
  const result = await closeQueue(env, guildId, gameId);
  return json(result);
}

// POST /ext/mod/queue/close-night, closes every game queue for tonight.
async function modQueueCloseNight(env, guildId) {
  const result = await closeNight(env, guildId);
  return json(result);
}

// POST /ext/mod/dungeon/skip, free 'skip' command (no Bits/bolts).
// Synthesizes the same dll-pending record that skipCooldown uses for
// paid skips so PanelBridgeModule + DungeonModule replay it the
// existing way. The trusted skip flag is recognised solely by the
// DLL's role check on the record's user.role, which we set to
// 'moderator' or 'broadcaster' here based on the JWT payload.
async function modDungeonSkip(env, payload, req) {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);

  let canonicalName = '';
  if (payload && payload.user_id) {
    canonicalName = (await resolveTwitchLoginById(env, payload.user_id)) || '';
  }
  const record = {
    kind: 'dungeon',
    action: 'skip',
    arg: '',
    user: {
      id: String((payload && (payload.user_id || payload.opaque_user_id)) || ''),
      name: canonicalName || 'moderator',
      role: String((payload && payload.role) || 'moderator').toLowerCase(),
    },
    source: 'mod-panel',
    ts: Date.now(),
  };
  const key =
    'relay:dll-pending:' + record.ts + '-' + Math.random().toString(36).slice(2, 8);
  await env.LOADOUT_BOLTS.put(key, JSON.stringify(record), { expirationTtl: 90 });
  return json({ ok: true });
}
