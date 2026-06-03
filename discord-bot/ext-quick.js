// ext-quick.js, Twitch-panel handlers for the 7 quick-bolts games
// (blackjack, roulette, wheel, hi-lo, mines, plinko, crash).
//
// The website surface (aquilo-site/play) already calls into games-quick.js
// via /api/web/play/* → /web/{game,…} on this worker. This module exposes
// the EXACT same functions over the panel's `/ext/quick/*` route family,
// so a viewer with the panel open gets the same server-authoritative
// results without us forking game logic.
//
// Auth: the calling ext.js dispatcher has already verified the Twitch
// extension JWT + resolved (guildId, userId) for the linked viewer.
// We receive both as args and never look at the request again.
//
// Routes:
//   GET  /ext/quick/snapshot              -> { ok, snapshot, cooldown, balance }
//   POST /ext/quick/blackjack/start       { bet }
//   POST /ext/quick/blackjack/hit
//   POST /ext/quick/blackjack/stand
//   POST /ext/quick/roulette              { bet, pick }
//   POST /ext/quick/wheel                 { bet, risk? }
//   POST /ext/quick/hilo/start            { bet }
//   POST /ext/quick/hilo/guess            { guess: "higher"|"lower" }
//   POST /ext/quick/hilo/cashout
//   POST /ext/quick/mines/start           { bet, bombs? }
//   POST /ext/quick/mines/reveal          { tile }
//   POST /ext/quick/mines/cashout
//   POST /ext/quick/plinko                { bet, risk? }
//   POST /ext/quick/crash                 { bet, cashout? }
//
// Every response carries `balance` so the panel can refresh the wallet
// display without a follow-up round-trip. Cooldown contract matches
// games-quick.js's own: cooldownCheck before write-paths, cooldownTouch
// after a successful play.

import {
  cooldownCheck, cooldownTouch,
  blackjackStart, blackjackHit, blackjackStand,
  roulette, wheel,
  hiloStart, hiloGuess, hiloCashout,
  minesStart, minesReveal, minesCashout,
  plinko,
  quickGamesSnapshot,
} from './games-quick.js';
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

async function withBalance(env, guildId, userId, body) {
  const w = await getWallet(env, guildId, userId);
  return { ...body, balance: w.balance || 0 };
}

// Returns true if this route is one of ours. Cheap O(1) substring check.
const ROUTES = new Set([
  'quick/snapshot',
  'quick/blackjack/start',
  'quick/blackjack/hit',
  'quick/blackjack/stand',
  'quick/roulette',
  'quick/wheel',
  'quick/hilo/start',
  'quick/hilo/guess',
  'quick/hilo/cashout',
  'quick/mines/start',
  'quick/mines/reveal',
  'quick/mines/cashout',
  'quick/plinko',
]);

export function isExtQuickRoute(route) {
  return ROUTES.has(route);
}

export async function handleExtQuick(env, guildId, userId, req, route) {
  // Snapshot is the page-load resume probe, pure read of any in-progress
  // hand state + the cooldown window. Free of writes; never rate-limited.
  if (route === 'quick/snapshot') {
    const snap = await quickGamesSnapshot(env, guildId, userId);
    return json(await withBalance(env, guildId, userId, { ok: true, snapshot: snap }));
  }

  // Every other route is a write; gate on the shared cooldown first.
  // STATEFUL games (blackjack hit/stand, hilo guess/cashout, mines
  // reveal/cashout) intentionally skip this, the cooldown gates only
  // the START action, matching the contract in games-quick.js / web.js.
  const isStart =
    route === 'quick/blackjack/start' ||
    route === 'quick/roulette' ||
    route === 'quick/wheel' ||
    route === 'quick/hilo/start' ||
    route === 'quick/mines/start' ||
    route === 'quick/plinko';

  if (isStart) {
    const cd = await cooldownCheck(env, userId);
    if (!cd.ok) return json({ ok: false, ...cd }, 200);
  }

  let body = {};
  try {
    if (req.method === 'POST') body = await req.json();
  } catch { return json({ ok: false, error: 'bad-json' }, 400); }

  let r;
  switch (route) {
    case 'quick/blackjack/start':
      r = await blackjackStart(env, guildId, userId, num(body.bet));
      break;
    case 'quick/blackjack/hit':
      r = await blackjackHit(env, guildId, userId);
      break;
    case 'quick/blackjack/stand':
      r = await blackjackStand(env, guildId, userId);
      break;
    case 'quick/roulette':
      r = await roulette(env, guildId, userId, num(body.bet), body.pick);
      break;
    case 'quick/wheel':
      r = await wheel(env, guildId, userId, num(body.bet), body.risk || 'medium');
      break;
    case 'quick/hilo/start':
      r = await hiloStart(env, guildId, userId, num(body.bet));
      break;
    case 'quick/hilo/guess':
      r = await hiloGuess(env, guildId, userId, body.guess);
      break;
    case 'quick/hilo/cashout':
      r = await hiloCashout(env, guildId, userId);
      break;
    case 'quick/mines/start':
      r = await minesStart(env, guildId, userId, num(body.bet), num(body.bombs) || 3);
      break;
    case 'quick/mines/reveal':
      r = await minesReveal(env, guildId, userId, num(body.tile));
      break;
    case 'quick/mines/cashout':
      r = await minesCashout(env, guildId, userId);
      break;
    case 'quick/plinko':
      r = await plinko(env, guildId, userId, num(body.bet), body.risk || 'medium');
      break;
    default:
      return json({ ok: false, error: 'not-found' }, 404);
  }

  if (isStart && r && r.ok) {
    // Only arm the next cooldown window if the start actually played
    // (insufficient-balance / bad-bet returns ok:false and we leave
    // the cooldown untouched).
    await cooldownTouch(env, userId);
  }

  return json(await withBalance(env, guildId, userId, r));
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
