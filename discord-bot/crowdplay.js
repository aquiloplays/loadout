// CrowdPlay: Twitch Extension surface for the aquilo-crowdplay engine
//
// The CrowdPlay engine itself runs on Clay's PC (Desktop/Aquilo/aquilo-crowdplay)
// and talks to per-game adapters (Half Sword, Hitman: WoA, Pokemon Platinum,
// Chained Together, Enshrouded, Days Gone). This worker module is the panel
// surface for viewers + the relay that lets the local engine and the Twitch
// panel see each other:
//
//   * GET  /web/crowdplay/active        public  -> {ok, active, game{slug,display}, supported[]}
//                                                  Resolved from the live Twitch
//                                                  category. Same category->slug
//                                                  pipeline scratch-off uses, plus
//                                                  the 6 CrowdPlay games.
//   * GET  /web/crowdplay/state         public  -> {ok, round, lastResult, lastEffect}
//                                                  Whatever the local engine
//                                                  most recently relayed. Empty
//                                                  when the engine isn't running.
//   * POST /web/crowdplay/state         token   -> local engine pushes a
//                                                  {round|tick|result|effect} event.
//                                                  Stored in KV with TTL.
//   * POST /web/crowdplay/vote          (ext)   -> Twitch panel vote.
//                                                  Body: { userId, number, gameSlug }
//                                                  Queued for the local engine to
//                                                  drain via GET /web/crowdplay/pending.
//   * GET  /web/crowdplay/pending       token   -> drain the queued viewer votes
//                                                  and panel bit triggers.
//
// KV (LOADOUT_BOLTS):
//   crowdplay:state          state snapshot (60s TTL)
//   crowdplay:manifest       active manifest snapshot pushed by engine (1h TTL)
//   crowdplay:history        rolling list of the last 50 fires (1h TTL)
//   crowdplay:pending        FIFO of pending viewer + dock events (5m TTL)
//   crowdplay:config         tunable config (game allowlist toggle etc.)
//
// Auth: writes / drains are gated by env.CROWDPLAY_TOKEN (header
// `x-crowdplay-token` or `?token=`). Reads are public so the Twitch Extension
// (and OBS overlay) can poll without secrets.

import { getChannelGame } from './twitch-helix.js';

// ── Game catalog ────────────────────────────────────────────────────
// Slug -> display + the Twitch category aliases that map to it. Add new
// CrowdPlay-enabled games here.
// CrowdPlay-supported game catalog. 2026-06-10 focus pass: one game.
//
// Every other game was scrapped to focus engineering on Hitman: World
// of Assassination. CC-supported games are better served by CC's own
// pipeline; non-CC games (Half Sword etc.) weren't worth the per-game
// adapter cost. Hitman is the streamer's main game and CC doesn't
// support it, so it gets the focus.
//
// Re-adding a game later is just a row in this map + a new manifest +
// either a CC reference or a custom adapter.
export const CROWDPLAY_GAMES = {
  'hitman-woa':         { display: 'Hitman: World of Assassination',
    aliases: ['HITMAN World of Assassination', 'Hitman World of Assassination',
              'Hitman 3', 'HITMAN 3', 'HITMAN III'] },
  'chained-together':   { display: 'Chained Together',
    aliases: ['Chained Together'] },
  'burglin-gnomes':     { display: "Burglin' Gnomes",
    aliases: ["Burglin' Gnomes", 'Burglin Gnomes', 'Burgling Gnomes', 'Gnomium'] },
  'roadside-research':  { display: 'Roadside Research',
    aliases: ['Roadside Research'] },
  'meccha-chameleon':   { display: 'MECCHA CHAMELEON',
    aliases: ['MECCHA CHAMELEON', 'Meccha Chameleon', 'Mecha Chameleon'] },
  'left-4-dead-2':      { display: 'Left 4 Dead 2',
    aliases: ['Left 4 Dead 2', 'L4D2'] },
};

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// Reverse index: normalized Twitch game name -> CrowdPlay slug.
const NAME_INDEX = (() => {
  const idx = {};
  for (const [slug, def] of Object.entries(CROWDPLAY_GAMES)) {
    idx[norm(def.display)] = slug;
    for (const a of def.aliases) idx[norm(a)] = slug;
  }
  return idx;
})();

function slugForCategory(gameName) {
  if (!gameName) return null;
  const key = norm(gameName);
  if (NAME_INDEX[key]) return NAME_INDEX[key];
  for (const [n, slug] of Object.entries(NAME_INDEX)) {
    if (key.startsWith(n) || n.startsWith(key)) return slug;
  }
  return null;
}

// ── KV helpers ──────────────────────────────────────────────────────
const K_STATE = 'crowdplay:state';
const K_MANIFEST = 'crowdplay:manifest';
const K_HISTORY = 'crowdplay:history';
const K_PENDING = 'crowdplay:pending';
const STATE_TTL_SEC = 60;
const MANIFEST_TTL_SEC = 3600;
const HISTORY_TTL_SEC = 3600;
const HISTORY_CAP = 50;
const PENDING_TTL_SEC = 300;

async function kvGet(env, key, asJson = false) {
  if (!env || !env.LOADOUT_BOLTS) return null;
  try { return await env.LOADOUT_BOLTS.get(key, asJson ? { type: 'json' } : undefined); }
  catch { return null; }
}
async function kvPut(env, key, val, ttl) {
  if (!env || !env.LOADOUT_BOLTS) return;
  try {
    await env.LOADOUT_BOLTS.put(key, typeof val === 'string' ? val : JSON.stringify(val),
      ttl ? { expirationTtl: ttl } : undefined);
  } catch { /* idle */ }
}

// ── Resp + auth helpers ────────────────────────────────────────────
function jsonResp(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status,
    headers: { 'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'Authorization, Content-Type, x-crowdplay-token, x-twitch-extension-jwt',
      'access-control-allow-methods': 'GET,POST,OPTIONS', ...extra } });
}
function tokenOk(req, env, url) {
  const want = String(env.CROWDPLAY_TOKEN || '').trim();
  if (!want) return false;
  const got = req.headers.get('x-crowdplay-token') || url.searchParams.get('token') || '';
  return got && got === want;
}

// ── Public surface ─────────────────────────────────────────────────
async function resolveActive(env) {
  const broadcasterId = String(env.CLAY_TWITCH_CHANNEL_ID || '').trim();
  if (!broadcasterId) return { active: false, reason: 'no-broadcaster' };
  const ch = await getChannelGame(env, broadcasterId).catch(() => null);
  const gameName = ch?.gameName || null;
  const slug = slugForCategory(gameName);
  if (!slug) return { active: false, twitchName: gameName };
  const def = CROWDPLAY_GAMES[slug];
  return { active: true, slug, display: def.display, twitchName: gameName };
}

export async function handleCrowdplay(req, env, path) {
  const url = new URL(req.url);
  const method = req.method.toUpperCase();
  if (method === 'OPTIONS') return jsonResp({ ok: true });

  // Active-game probe. Panel polls this every ~20s to decide whether to
  // show the CrowdPlay surface. Cached for 10s so a panel surge doesn't
  // hammer the Helix lookup.
  if (method === 'GET' && path === '/web/crowdplay/active') {
    const a = await resolveActive(env);
    return jsonResp({ ok: true, ...a,
      supported: Object.entries(CROWDPLAY_GAMES).map(([slug, d]) =>
        ({ slug, display: d.display })) },
      200, { 'cache-control': 'public, max-age=10' });
  }

  // State snapshot. Whatever the local engine most recently posted.
  if (method === 'GET' && path === '/web/crowdplay/state') {
    const s = (await kvGet(env, K_STATE, true)) || null;
    return jsonResp({ ok: true, state: s },
      200, { 'cache-control': 'public, max-age=2' });
  }

  // Local engine pushes round + result events here. Body shape:
  //   { event: 'round'|'tick'|'result'|'effect', game, payload }
  // We keep the most recent snapshot of each event type.
  if (method === 'POST' && path === '/web/crowdplay/state') {
    if (!tokenOk(req, env, url)) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
    let body;
    try { body = await req.json(); } catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
    if (!body || typeof body !== 'object') return jsonResp({ ok: false, error: 'bad-body' }, 400);
    const prev = (await kvGet(env, K_STATE, true)) || {};
    const next = { ...prev, [body.event || 'unknown']: { ...body, _at: Date.now() }, _at: Date.now() };
    if (body.event === 'round')  next.round = { ...body, _at: Date.now() };
    if (body.event === 'tick')   next.round = { ...(next.round || {}), ...body, _at: Date.now() };
    if (body.event === 'result') next.lastResult = { ...body, _at: Date.now() };
    if (body.event === 'effect') next.lastEffect = { ...body, _at: Date.now() };
    if (body.game) next.game = body.game;
    await kvPut(env, K_STATE, next, STATE_TTL_SEC);
    return jsonResp({ ok: true });
  }

  // Viewer vote from the Twitch panel. We DO NOT verify the Twitch JWT here
  // (the panel sends the opaque viewer id alongside; the engine cooldowns
  // vote-per-user). If you need stronger auth, plumb the JWT through and
  // verify with env.TWITCH_EXT_SECRET.
  if (method === 'POST' && path === '/web/crowdplay/vote') {
    let body;
    try { body = await req.json(); } catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
    const userId = String((body && body.userId) || '').trim();
    const number = parseInt(body && body.number, 10);
    const gameSlug = String((body && body.gameSlug) || '').trim();
    if (!userId || !Number.isInteger(number) || number < 1 || number > 4) {
      return jsonResp({ ok: false, error: 'bad-vote' }, 400);
    }
    const prev = (await kvGet(env, K_PENDING, true)) || { events: [] };
    prev.events.push({ kind: 'vote', userId, number, gameSlug, _at: Date.now() });
    if (prev.events.length > 500) prev.events.splice(0, prev.events.length - 500);
    await kvPut(env, K_PENDING, prev, PENDING_TTL_SEC);
    return jsonResp({ ok: true });
  }

  // Direct-buy: viewer spends bolts (or, later, bits) to fire an effect
  // immediately. The current manifest's effect.costBolts dictates the price;
  // we check the user's bolts balance in LOADOUT_BOLTS::bolts:<userId>
  // before queuing. Engine fires when it drains the buy event.
  if (method === 'POST' && path === '/web/crowdplay/buy') {
    let body;
    try { body = await req.json(); } catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
    const userId = String((body && body.userId) || '').trim();
    const effectId = String((body && body.effectId) || '').trim();
    if (!userId || !effectId) return jsonResp({ ok: false, error: 'bad-buy' }, 400);
    const m = (await kvGet(env, K_MANIFEST, true)) || null;
    const eff = m && Array.isArray(m.effects) && m.effects.find((e) => e.id === effectId);
    if (!eff) return jsonResp({ ok: false, error: 'unknown-effect' }, 404);
    const cost = Math.max(0, parseInt(eff.costBolts, 10) || 0);
    if (cost <= 0) return jsonResp({ ok: false, error: 'not-purchasable' }, 400);
    // Bolts balance check + atomic-ish debit. Best-effort: KV doesn't give us
    // CAS, so two concurrent buys could over-spend the wallet by one txn.
    // Acceptable here; tighter accounting can move to D1 later.
    const balKey = `bolts:${userId}`;
    const bal = parseInt(await kvGet(env, balKey), 10) || 0;
    if (bal < cost) return jsonResp({ ok: false, error: 'insufficient-bolts', balance: bal, cost }, 402);
    await kvPut(env, balKey, String(bal - cost));
    const prev = (await kvGet(env, K_PENDING, true)) || { events: [] };
    prev.events.push({ kind: 'buy', effectId, user: userId, cost, _at: Date.now() });
    if (prev.events.length > 500) prev.events.splice(0, prev.events.length - 500);
    await kvPut(env, K_PENDING, prev, PENDING_TTL_SEC);
    return jsonResp({ ok: true, balance: bal - cost });
  }

  // Local engine drains queued panel votes / bit triggers / dock controls.
  // Atomic-ish: we read + clear in two ops; KV doesn't give us CAS, so a
  // tiny race is accepted (worst case: one or two events show up twice).
  if (method === 'GET' && path === '/web/crowdplay/pending') {
    if (!tokenOk(req, env, url)) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
    const cur = (await kvGet(env, K_PENDING, true)) || { events: [] };
    await kvPut(env, K_PENDING, { events: [] }, PENDING_TTL_SEC);
    return jsonResp({ ok: true, events: cur.events || [] });
  }

  // ── Dock surface ──────────────────────────────────────────────────
  // Manifest snapshot. Pushed by the engine on boot + after each in-place
  // dock edit. Public read so the dock can render the effects/triggers
  // tables without any auth.
  if (method === 'GET' && path === '/web/crowdplay/manifest') {
    const m = (await kvGet(env, K_MANIFEST, true)) || null;
    return jsonResp({ ok: true, manifest: m },
      200, { 'cache-control': 'public, max-age=5' });
  }
  if (method === 'POST' && path === '/web/crowdplay/manifest') {
    if (!tokenOk(req, env, url)) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
    let body;
    try { body = await req.json(); } catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
    if (!body || !body.manifest || typeof body.manifest !== 'object') {
      return jsonResp({ ok: false, error: 'bad-body' }, 400);
    }
    await kvPut(env, K_MANIFEST, { ...body.manifest, _at: Date.now() }, MANIFEST_TTL_SEC);
    return jsonResp({ ok: true });
  }

  // Fire history (rolling). Engine appends one entry per dispatch; the
  // dock renders the tail. Cap keeps KV writes bounded.
  if (method === 'GET' && path === '/web/crowdplay/history') {
    const h = (await kvGet(env, K_HISTORY, true)) || { entries: [] };
    return jsonResp({ ok: true, entries: h.entries || [] },
      200, { 'cache-control': 'public, max-age=2' });
  }
  if (method === 'POST' && path === '/web/crowdplay/history') {
    if (!tokenOk(req, env, url)) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
    let body;
    try { body = await req.json(); } catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
    const entry = body && body.entry;
    if (!entry || typeof entry !== 'object') return jsonResp({ ok: false, error: 'bad-body' }, 400);
    const prev = (await kvGet(env, K_HISTORY, true)) || { entries: [] };
    prev.entries.push({ ...entry, _at: Date.now() });
    if (prev.entries.length > HISTORY_CAP) prev.entries.splice(0, prev.entries.length - HISTORY_CAP);
    await kvPut(env, K_HISTORY, prev, HISTORY_TTL_SEC);
    return jsonResp({ ok: true });
  }

  // Dock-side control plane. The dock POSTs typed control events; we drop
  // them into the same pending queue that already drains votes, the engine
  // picks them up on its next poll. Supported kinds:
  //   { kind: 'force-fire',  effectId }
  //   { kind: 'pause' } / { kind: 'resume' } / { kind: 'skip-round' }
  //   { kind: 'manifest-edit', patch: { effects?: {<id>:{weight?,cooldownSec?,votable?,label?}},
  //                                     triggers?: { ... } } }
  // Returns { ok, queued: <id> } so the dock can show "queued".
  if (method === 'POST' && path === '/web/crowdplay/control') {
    if (!tokenOk(req, env, url)) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
    let body;
    try { body = await req.json(); } catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
    if (!body || typeof body !== 'object' || !body.kind) {
      return jsonResp({ ok: false, error: 'bad-body' }, 400);
    }
    const allowed = new Set([
      'force-fire', 'pause', 'resume', 'skip-round', 'manifest-edit',
      'mode-set', 'mute-add', 'mute-remove', 'mute-replace', 'bits-cd-set',
    ]);
    if (!allowed.has(body.kind)) return jsonResp({ ok: false, error: 'bad-kind' }, 400);
    const prev = (await kvGet(env, K_PENDING, true)) || { events: [] };
    const id = 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    prev.events.push({ ...body, _id: id, _at: Date.now() });
    if (prev.events.length > 500) prev.events.splice(0, prev.events.length - 500);
    await kvPut(env, K_PENDING, prev, PENDING_TTL_SEC);
    return jsonResp({ ok: true, queued: id });
  }

  // ── Scratch-to-fire ────────────────────────────────────────────────
  // The scratch-off system on aquilo.gg/scratch awards a "fire one
  // CrowdPlay effect" prize. After server-side validation of the scratch
  // credential, the panel hits this endpoint. We append a force-fire to
  // the same pending queue the engine drains - no separate code path.
  //
  // Body: { effectId, viewer, scratchTicket } - scratchTicket validated
  // against the scratch state KV so the same ticket can't fire twice.
  if (method === 'POST' && path === '/web/crowdplay/scratch-fire') {
    if (!tokenOk(req, env, url)) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
    let body;
    try { body = await req.json(); } catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
    const { effectId, viewer, scratchTicket } = body || {};
    if (!effectId || !viewer || !scratchTicket) {
      return jsonResp({ ok: false, error: 'missing-fields' }, 400);
    }
    // Prevent ticket reuse: mark spent in KV (7 day TTL).
    const spentKey = `crowdplay:scratch:spent:${scratchTicket}`;
    if (await kvGet(env, spentKey)) return jsonResp({ ok: false, error: 'ticket-used' }, 409);
    await kvPut(env, spentKey, '1', 604800);

    const prev = (await kvGet(env, K_PENDING, true)) || { events: [] };
    const id = 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    prev.events.push({
      kind: 'force-fire', effectId, source: 'scratch', viewer,
      _id: id, _at: Date.now(),
    });
    if (prev.events.length > 500) prev.events.splice(0, prev.events.length - 500);
    await kvPut(env, K_PENDING, prev, PENDING_TTL_SEC);
    return jsonResp({ ok: true, queued: id, fired: effectId, by: viewer });
  }

  // ── Scratch-to-open-vote ───────────────────────────────────────────
  // Bigger scratch prize: opens a fresh vote round with the scratcher
  // credited as sponsor. Engine reuses openRoundFromTrigger().
  if (method === 'POST' && path === '/web/crowdplay/scratch-vote') {
    if (!tokenOk(req, env, url)) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
    let body;
    try { body = await req.json(); } catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
    const { viewer, scratchTicket } = body || {};
    if (!viewer || !scratchTicket) return jsonResp({ ok: false, error: 'missing-fields' }, 400);
    const spentKey = `crowdplay:scratch:spent:${scratchTicket}`;
    if (await kvGet(env, spentKey)) return jsonResp({ ok: false, error: 'ticket-used' }, 409);
    await kvPut(env, spentKey, '1', 604800);

    const prev = (await kvGet(env, K_PENDING, true)) || { events: [] };
    const id = 'sv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    prev.events.push({
      kind: 'open-round', sponsor: { user: viewer, source: 'scratch' },
      _id: id, _at: Date.now(),
    });
    if (prev.events.length > 500) prev.events.splice(0, prev.events.length - 500);
    await kvPut(env, K_PENDING, prev, PENDING_TTL_SEC);
    return jsonResp({ ok: true, queued: id, by: viewer });
  }

  // ── Crowd Control webhook listener ─────────────────────────────────
  // CC's developer feed POSTs effect-fired events here. We forward them
  // as a 'cc-effect' bus event for the overlay + engagement layer for
  // combo detection.
  //
  // Auth: a SEPARATE token (CC_WEBHOOK_TOKEN env var, falls back to the
  // main CROWDPLAY_TOKEN). Lets CC have a credential that doesn't grant
  // them /control or /buy access. Header: x-cc-webhook-token.
  if (method === 'POST' && path === '/web/crowdplay/cc-event') {
    const wantCc = String(env.CC_WEBHOOK_TOKEN || env.CROWDPLAY_TOKEN || '').trim();
    const gotCc = req.headers.get('x-cc-webhook-token') || req.headers.get('x-crowdplay-token') || '';
    if (!wantCc || gotCc !== wantCc) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
    let body;
    try { body = await req.json(); } catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
    if (!body || !body.effect) return jsonResp({ ok: false, error: 'bad-body' }, 400);
    const prev = (await kvGet(env, K_PENDING, true)) || { events: [] };
    const id = 'cc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    prev.events.push({
      kind: 'cc-effect', effect: body.effect, viewer: body.viewer || null,
      ts: body.ts || Date.now(), _id: id, _at: Date.now(),
    });
    if (prev.events.length > 500) prev.events.splice(0, prev.events.length - 500);
    await kvPut(env, K_PENDING, prev, PENDING_TTL_SEC);
    return jsonResp({ ok: true, queued: id });
  }

  return jsonResp({ ok: false, error: 'not-found' }, 404);
}
