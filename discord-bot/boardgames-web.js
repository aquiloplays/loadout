// /web/board/*, boardgames HTTP surface.
//
// Routes (all POST, dispatched from web.js):
//   board/snapshot         { } -> { matches, challenges, optIn, games, balance }
//   board/opt-in           { on: boolean } -> { optIn }
//   board/match            { matchId } -> { match }
//   board/move             { matchId, move } -> { match }   move shape is per-game
//   board/resign           { matchId } -> { match }
//   board/queue/join       { game, wager, displayName? } -> { status, matchId? }
//   board/queue/leave      { game } -> { status }
//   board/challenge/create { game, wager, toId, toName?, fromName? } -> { challenge }
//   board/challenge/accept { challengeId, displayName? } -> { matchId }
//   board/challenge/decline{ challengeId } -> { ok }
//
// The web.js wrapper has already verified the HMAC + extracted the
// session's verified (guildId, discordId). We receive both as args.

import {
  snapshotWithWallet,
  setOptIn,
  getMatch,
  applyMove,
  resign,
  queueJoin,
  queueLeave,
  challengeCreate,
  challengeAccept,
  challengeDecline,
  getAdapter,
} from './boardgames-engine.js';

const BOARD_ROUTES = new Set([
  'board/snapshot',
  'board/opt-in',
  'board/match',
  'board/move',
  'board/resign',
  'board/queue/join',
  'board/queue/leave',
  'board/challenge/create',
  'board/challenge/accept',
  'board/challenge/decline',
]);

export function isBoardRoute(sub) {
  return BOARD_ROUTES.has(sub);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export async function routeBoard(env, route, guildId, discordId, body) {
  const displayName = typeof body.displayName === 'string' ? body.displayName.slice(0, 32) : null;

  if (route === 'board/snapshot') {
    const s = await snapshotWithWallet(env, guildId, discordId);
    return json(s);
  }

  if (route === 'board/opt-in') {
    const on = !!body.on;
    const r = await setOptIn(env, guildId, discordId, on);
    return json(r);
  }

  if (route === 'board/match') {
    const matchId = String(body.matchId || '');
    if (!matchId) return json({ ok: false, error: 'bad-request' }, 400);
    const r = await getMatch(env, discordId, matchId);
    if (!r.ok) return json(r, r.error === 'forbidden' ? 403 : 404);
    return json(r);
  }

  if (route === 'board/move') {
    const matchId = String(body.matchId || '');
    if (!matchId) return json({ ok: false, error: 'bad-request' }, 400);
    const move = body.move;
    if (!move || typeof move !== 'object') return json({ ok: false, error: 'bad-move' }, 400);
    const r = await applyMove(env, guildId, discordId, matchId, move);
    return json(r, r.ok ? 200 : 400);
  }

  if (route === 'board/resign') {
    const matchId = String(body.matchId || '');
    if (!matchId) return json({ ok: false, error: 'bad-request' }, 400);
    const r = await resign(env, guildId, discordId, matchId);
    return json(r, r.ok ? 200 : 400);
  }

  if (route === 'board/queue/join') {
    const game = String(body.game || '');
    if (!getAdapter(game)) return json({ ok: false, error: 'bad-game' }, 400);
    const wager = Number(body.wager) || 0;
    const r = await queueJoin(env, guildId, discordId, displayName, game, wager);
    return json(r, r.ok ? 200 : 400);
  }

  if (route === 'board/queue/leave') {
    const game = String(body.game || '');
    if (!getAdapter(game)) return json({ ok: false, error: 'bad-game' }, 400);
    const r = await queueLeave(env, guildId, discordId, game);
    return json(r);
  }

  if (route === 'board/challenge/create') {
    const game = String(body.game || '');
    if (!getAdapter(game)) return json({ ok: false, error: 'bad-game' }, 400);
    const toId = String(body.toId || '');
    if (!/^\d{5,25}$/.test(toId)) return json({ ok: false, error: 'bad-target' }, 400);
    const wager = Number(body.wager) || 0;
    const toName = typeof body.toName === 'string' ? body.toName.slice(0, 32) : null;
    const fromName = typeof body.fromName === 'string' ? body.fromName.slice(0, 32) : displayName;
    const r = await challengeCreate(env, guildId, discordId, fromName, toId, toName, game, wager);
    return json(r, r.ok ? 200 : 400);
  }

  if (route === 'board/challenge/accept') {
    const challengeId = String(body.challengeId || '');
    if (!challengeId) return json({ ok: false, error: 'bad-request' }, 400);
    const r = await challengeAccept(env, guildId, discordId, displayName, challengeId);
    return json(r, r.ok ? 200 : 400);
  }

  if (route === 'board/challenge/decline') {
    const challengeId = String(body.challengeId || '');
    if (!challengeId) return json({ ok: false, error: 'bad-request' }, 400);
    const r = await challengeDecline(env, discordId, challengeId);
    return json(r);
  }

  return json({ ok: false, error: 'not-found' }, 404);
}
