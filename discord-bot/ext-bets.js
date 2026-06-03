// ext-bets.js, Twitch-panel handlers for sports betting.
//
// The website + Discord call into bet.js directly via /web/bet/* and
// /bet sports place. This module wraps the same `runPlaceJson` for the
// Twitch panel under /ext/bets/*, with the same wallet, same caps, and
// the same KV-shared bets store, single source of truth, no logic fork.
//
// Routes:
//   POST /ext/bets/snapshot           -> { ok, balance, active, history, games }
//   POST /ext/bets/place              { gameId, kind, side, bolts }
//                                      Solo bet (moneyline/spread/total).
//   POST /ext/bets/parlay             { bolts, legs:[{game,kind,side}] }
//                                      2-10 leg parlay. Same engine as web.
//
// Auth: the calling ext.js dispatcher has already verified the Twitch
// extension JWT + resolved (guildId, userId='tw:<twId>') for the
// linked viewer. We receive both as args.

import { runPlaceJson, runPlaceParlayJson, getUserBetsPublic, publicSportsSnapshot, readGamesCache, refreshGamesCache } from './bet.js';
import { getWallet } from './wallet.js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS },
  });
}

const ROUTES = new Set([
  'bets/snapshot',
  'bets/place',
  'bets/parlay',
]);

export function isExtBetsRoute(route) {
  return ROUTES.has(route);
}

export async function handleExtBets(env, guildId, userId, req, route) {
  // Snapshot is the page-load read, pure read of upcoming games +
  // user's active/history + wallet balance. No write rate-limit.
  if (route === 'bets/snapshot') {
    const bets = await getUserBetsPublic(env, guildId, userId);
    const wallet = await getWallet(env, guildId, userId);

    // Reuse publicSportsSnapshot for the upcoming-games slice. It
    // returns a Response, drill in to grab the body so we can merge.
    let games = [];
    try {
      const r = await publicSportsSnapshot(env);
      const body = await r.json();
      games = Array.isArray(body.games) ? body.games : [];
    } catch {
      games = await readGamesCache(env);
      if (games.length === 0) {
        try { games = await refreshGamesCache(env); } catch { games = []; }
      }
    }

    return json({
      ok: true,
      balance: wallet.balance || 0,
      active: Array.isArray(bets.active) ? bets.active : [],
      history: Array.isArray(bets.history) ? bets.history.slice(-20).reverse() : [],
      games,
    });
  }

  let body = {};
  try {
    if (req.method === 'POST') body = await req.json();
  } catch { return json({ ok: false, error: 'bad-json' }, 400); }

  if (route === 'bets/place') {
    const kind = String(body.kind || 'moneyline').toLowerCase();
    if (kind !== 'moneyline' && kind !== 'spread' && kind !== 'total') {
      return json({ ok: false, error: 'bad-kind', message: 'kind must be moneyline, spread, or total.' }, 400);
    }
    const r = await runPlaceJson(env, guildId, userId, {
      game: String(body.gameId || '').trim(),
      kind,
      side: String(body.side || '').toLowerCase(),
      bolts: Math.floor(Number(body.bolts) || 0),
    });
    return json(r, r.ok ? 200 : 400);
  }

  if (route === 'bets/parlay') {
    const legs = Array.isArray(body.legs) ? body.legs : [];
    if (legs.length < 2) return json({ ok: false, error: 'too-few-legs', message: 'A parlay needs at least 2 legs.' }, 400);
    const r = await runPlaceParlayJson(env, guildId, userId, {
      bolts: Math.floor(Number(body.bolts) || 0),
      legs,
    });
    return json(r, r.ok ? 200 : 400);
  }

  return json({ ok: false, error: 'not-found' }, 404);
}
