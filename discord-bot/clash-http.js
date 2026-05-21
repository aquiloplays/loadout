// Clash HTTP surface (Phase 4 — Loadout side).
//
// Four routes total, all exposed from worker.js's fetch handler:
//
//   GET /clash-leaderboard
//       Public, no auth. Top raiders + top towns across every guild.
//       Mirrors the /leaderboard/<guildId> pattern. Cached 60s.
//
//   GET /clash/town/<guildId>
//       Public, no auth. Returns town + treasury + recent raids for
//       the future Twitch panel + web base-editor read-side.
//
//   GET  /sync/<guildId>/clash               HMAC-gated (X-Loadout-ts/sig)
//   POST /sync/<guildId>/clash/build         HMAC-gated
//   POST /sync/<guildId>/clash/garrison      HMAC-gated
//       Editor sync — the web base-editor reads full state via GET
//       and writes through the POST endpoints. Same per-guild
//       syncSecret used by wallet sync.
//
//   GET /sync/<guildId>/clash-events?since=<ms>   HMAC-gated
//       Ring-buffer pull for the DLL to republish on the local
//       Aquilo Bus. Same shape as /sync/<guildId>/games.

import { getSecret } from './wallet.js';

// Inline copy of auth.js's verifyHmac so this module doesn't pull
// auth.js's discord-interactions dependency in via re-export — keeps
// the unit-test path clean and doesn't grow the cold-start graph.
// Behaviour and accepted skew window match auth.js verbatim.
async function verifyHmac(secret, ts, body, hexSig) {
  const skew = Math.abs(Math.floor(Date.now() / 1000) - parseInt(ts || '0', 10));
  if (!secret || !ts || !hexSig || skew > 300) return false;
  try {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
    );
    if (typeof hexSig !== 'string' || hexSig.length % 2 !== 0) return false;
    const sigBytes = new Uint8Array(hexSig.length / 2);
    for (let i = 0; i < hexSig.length; i += 2) {
      const b = parseInt(hexSig.slice(i, i + 2), 16);
      if (Number.isNaN(b)) return false;
      sigBytes[i >> 1] = b;
    }
    const message = new TextEncoder().encode(ts + '\n' + body);
    return await crypto.subtle.verify('HMAC', key, sigBytes, message);
  } catch { return false; }
}
import {
  getTown, getTreasury, getPrestige, getShield, getQueue,
  topRaiders, topTowns, topContributors,
  isTownExcluded, isExcluded,
  ensureTown,
} from './clash-state.js';
import { getActiveWarId, getWar, getWarBadge } from './clash-war.js';
import {
  BUILDINGS, TROOPS_GARRISON,
  withBuildingSprites, withGarrisonSprites,
} from './clash-content.js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET',
  'access-control-allow-headers': 'content-type',
  'cache-control': 'public, max-age=60',
};

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

// ── GET /clash-leaderboard ──────────────────────────────────────────
//
// Top 25 raiders + top 25 towns, globally. Excluded accounts filtered
// out at the source (clash-state already drops them).
//
// Caching layers, in order of preference:
//   1. Cloudflare Cache API (edge cache) — 60s public. FREE; doesn't
//      burn KV-read quota. Most repeat hits resolve here.
//   2. KV `clash:leaderboard:global` mirror — fallback if Cache API
//      cold. Same 60s TTL, set with a 5x KV TTL so a stale-but-valid
//      copy survives a brief edge eviction.
//
// Why two layers: a busy page that polls the leaderboard would burn
// thousands of KV reads on cache miss (topRaiders/topTowns walk the
// full clash:trophies:* + clash:prestige:* keyspaces and get() each
// hit). Cache API absorbs the steady-state load for free; the KV
// mirror covers the tail.
//
// If KV throws (quota exhausted), we still return a clean JSON 503
// rather than letting the Worker emit a 1101.

const LEADERBOARD_CACHE_KEY = 'clash:leaderboard:global';
const LEADERBOARD_TTL_S = 60;
const LEADERBOARD_EDGE_URL = 'https://loadout-discord.aquiloplays.workers.dev/__cache/clash-leaderboard';

export async function handleClashLeaderboardHttp(req, env) {
  // Layer 1: Cloudflare Cache API. Key by a stable internal URL so we
  // don't depend on the request URL (and so the same cache works for
  // GETs from any origin). `caches` is a CF Workers global; Node test
  // runs don't have it — guard so the test path stays clean.
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheReq = cache ? new Request(LEADERBOARD_EDGE_URL, { method: 'GET' }) : null;
  if (cache && cacheReq) {
    try {
      const hit = await cache.match(cacheReq);
      if (hit) return new Response(hit.body, hit);
    } catch { /* cache miss / unavailable */ }
  }

  // Layer 2: KV mirror. Wrapped — KV exhaustion mustn't crash the
  // response.
  try {
    const cached = await env.LOADOUT_BOLTS.get(LEADERBOARD_CACHE_KEY, { type: 'json' });
    if (cached && (Date.now() - (cached.updatedAt || 0)) < LEADERBOARD_TTL_S * 1000) {
      const resp = json(cached, 200, CORS);
      // Backfill the edge cache so subsequent hits skip KV entirely.
      if (cache && cacheReq) {
        try { await cache.put(cacheReq, resp.clone()); } catch {}
      }
      return resp;
    }
  } catch (err) {
    return clashQuotaErrorOr500(err);
  }

  let raiders, towns;
  try {
    [raiders, towns] = await Promise.all([
      topRaiders(env, 25),
      topTowns(env, 25),
    ]);
  } catch (err) {
    return clashQuotaErrorOr500(err);
  }
  const payload = {
    updatedAt: Date.now(),
    raiders: raiders.map((r, i) => ({
      rank: i + 1,
      userId: r.userId,
      guildId: r.guildId,
      trophies: r.trophies,
      tier: r.tier,
    })),
    towns: towns.map((t, i) => ({
      rank: i + 1,
      guildId: t.guildId,
      score: t.score,
      tier: t.tier,
    })),
  };
  try {
    await env.LOADOUT_BOLTS.put(LEADERBOARD_CACHE_KEY, JSON.stringify(payload), {
      expirationTtl: LEADERBOARD_TTL_S * 5,
    });
  } catch { /* non-fatal */ }
  const resp = json(payload, 200, CORS);
  if (cache && cacheReq) {
    try { await cache.put(cacheReq, resp.clone()); } catch {}
  }
  return resp;
}

// Map a KV quota error to a graceful JSON 503 so callers see
// "service temporarily unavailable" instead of Cloudflare's bare 1101
// HTML page. Anything else surfaces as a 500.
function clashQuotaErrorOr500(err) {
  const msg = String(err?.message || err || '');
  if (msg.includes('limit exceeded')) {
    return json(
      { error: 'kv-quota-exhausted', message: 'Clash is briefly offline while Workers KV resets at 00:00 UTC.' },
      503,
      CORS,
    );
  }
  return json({ error: 'internal', message: msg.slice(0, 200) }, 500, CORS);
}

// ── GET /clash/town/<guildId> ───────────────────────────────────────
//
// Public read for the Twitch panel and the future drag-and-drop web
// editor. Excluded towns get a thin 404-equivalent so they don't
// surface on the open web; their gameplay state still exists, they're
// just invisible to the ranked/public surfaces.

export async function handleClashTownPublic(env, path) {
  const guildId = path.slice('/clash/town/'.length).replace(/\/+$/, '');
  if (!guildId) return json({ error: 'guildId required' }, 400, CORS);
  try {
    return await handleClashTownPublicInner(env, guildId);
  } catch (err) {
    return clashQuotaErrorOr500(err);
  }
}

async function handleClashTownPublicInner(env, guildId) {
  if (await isTownExcluded(env, guildId)) {
    return json({ error: 'town-not-public' }, 404, CORS);
  }
  const town = await getTown(env, guildId);
  if (!town) return json({ error: 'no-town' }, 404, CORS);
  const tres = await getTreasury(env, guildId);
  const prestige = await getPrestige(env, guildId);
  const shield = await getShield(env, guildId);
  const contributors = await topContributors(env, guildId, 5);
  const badge = await getWarBadge(env, guildId);
  let activeWar = null;
  const warId = await getActiveWarId(env, guildId);
  if (warId) {
    const w = await getWar(env, warId);
    if (w) {
      activeWar = {
        warId: w.warId,
        state: w.state,
        opponentGuildId: w.attackerGuildId === guildId ? w.defenderGuildId : w.attackerGuildId,
        scores: w.scores,
        activeEndsUtc: w.activeEndsUtc || null,
      };
    }
  }
  return json({
    updatedAt: Date.now(),
    guildId,
    thLevel: town.thLevel,
    prestige,
    buildings: withBuildingSprites(town.buildings),
    garrison: town.garrison,
    garrisonSprites: withGarrisonSprites(town.garrison).sprites,
    treasury: tres,
    layoutVersion: town.layoutVersion,
    customisation: town.customisation || {},
    shield: shield ? { endsAt: shield.endsAt, reason: shield.reason } : null,
    contributors,
    activeWar,
    victorious: badge ? { wonUtc: badge.wonUtc, expiresUtc: badge.expiresUtc } : null,
    defenderChampion: town.defenderChampion?.acceptedUtc
      ? { userId: town.defenderChampion.userId, acceptedUtc: town.defenderChampion.acceptedUtc, expiresUtc: town.defenderChampion.expiresUtc }
      : null,
    battlePlans: town.battlePlans || 0,
  }, 200, CORS);
}

// ── HMAC gate (shared by /sync/:g/clash and /sync/:g/clash-events) ─

async function gateHmac(req, env, guildId) {
  const ts  = req.headers.get('x-loadout-ts');
  const sig = req.headers.get('x-loadout-sig');
  const body = req.method === 'POST' ? await req.text() : '';
  const stored = await getSecret(env, guildId);
  if (!stored?.secret) return { ok: false, status: 404, error: 'guild not registered' };
  const ok = await verifyHmac(stored.secret, ts || '', body, sig || '');
  if (!ok) return { ok: false, status: 401, error: 'bad signature' };
  return { ok: true, body };
}

// ── GET /sync/<guildId>/clash-events?since=<ms> ─────────────────────

export async function handleClashEventsPull(req, env, path) {
  // path: /sync/<guildId>/clash-events
  const parts = path.split('/').filter(Boolean);
  const guildId = parts[1];
  const gate = await gateHmac(req, env, guildId);
  if (!gate.ok) return new Response(gate.error, { status: gate.status });

  const url = new URL(req.url);
  const sinceMs = parseInt(url.searchParams.get('since') || '0', 10) || 0;
  const all = (await env.LOADOUT_BOLTS.get('clash:events:' + guildId, { type: 'json' })) || [];
  const fresh = all.filter(e => (e.ts || 0) > sinceMs);
  const latest = fresh.length > 0
    ? fresh[fresh.length - 1].ts
    : (all.length > 0 ? all[all.length - 1].ts : sinceMs);
  return json({ events: fresh, ts: latest });
}

// ── /sync/<guildId>/clash[/...] ─────────────────────────────────────
//
// GET  /sync/:g/clash             — full state
// POST /sync/:g/clash/build       — { kind, buildingId? } queue/upgrade
// POST /sync/:g/clash/garrison    — { troopId, count } train garrison
// POST /sync/:g/clash/donate      — { userId, bolts } donate on behalf
//                                    of a Discord-linked viewer
//                                    (web editor uses this when the
//                                    streamer pre-bonds their balance)

export async function handleClashSync(req, env, path) {
  const parts = path.split('/').filter(Boolean);
  // parts[0]='sync', parts[1]=guildId, parts[2]='clash', parts[3]=subpath?
  const guildId = parts[1];
  const sub = parts[3] || '';
  if (!guildId) return new Response('guildId required', { status: 400 });
  const gate = await gateHmac(req, env, guildId);
  if (!gate.ok) return new Response(gate.error, { status: gate.status });

  if (req.method === 'GET' && !sub) {
    await ensureTown(env, guildId, '');
    const town = await getTown(env, guildId);
    const tres = await getTreasury(env, guildId);
    const prestige = await getPrestige(env, guildId);
    const queue = await getQueue(env, 'clash:queue:' + guildId);
    const shield = await getShield(env, guildId);
    const warId = await getActiveWarId(env, guildId);
    const war = warId ? await getWar(env, warId) : null;
    // Enrich the editor payload with sprite paths so the drag-and-
    // drop layout editor can render each building / garrison troop
    // without having to derive the convention itself.
    const townOut = town ? {
      ...town,
      buildings: withBuildingSprites(town.buildings),
      garrisonSprites: withGarrisonSprites(town.garrison).sprites,
    } : town;
    return json({
      updatedAt: Date.now(),
      town: townOut, treasury: tres, prestige, queue, shield,
      war: war
        ? { warId: war.warId, state: war.state, scores: war.scores, activeEndsUtc: war.activeEndsUtc }
        : null,
    });
  }
  if (req.method === 'POST' && sub === 'build') {
    return forwardToSlashHandler(env, guildId, gate.body, 'build');
  }
  if (req.method === 'POST' && sub === 'garrison') {
    return forwardToSlashHandler(env, guildId, gate.body, 'garrison');
  }
  if (req.method === 'POST' && sub === 'donate') {
    return forwardToSlashHandler(env, guildId, gate.body, 'donate');
  }
  return new Response('not found', { status: 404 });
}

// Web editor POSTs land here; we adapt the JSON body into the same
// shape the slash command handlers consume, so the rules live in one
// place. The handler returns a plain string; we wrap to JSON for the
// HTTP caller.
async function forwardToSlashHandler(env, guildId, rawBody, action) {
  let body;
  try { body = JSON.parse(rawBody || '{}'); }
  catch { return json({ error: 'bad-json' }, 400); }

  // Dynamic import to avoid loading the slash dispatch on every cold
  // start of the leaderboard route.
  const clash = await import('./clash.js');

  const userId = String(body.userId || '');
  if (!userId) return json({ error: 'userId required (the streamer or mod acting via the web editor)' }, 400);

  if (action === 'build') {
    const txt = await clash._editorTownBuild?.(env, guildId, userId, body.kind, body.buildingId)
      ?? '❌ editor adapter not wired';
    return json({ result: txt });
  }
  if (action === 'garrison') {
    const txt = await clash._editorTownGarrison?.(env, guildId, userId, body.troopId, body.count)
      ?? '❌ editor adapter not wired';
    return json({ result: txt });
  }
  if (action === 'donate') {
    const txt = await clash._editorDonate?.(env, guildId, userId, body.bolts)
      ?? '❌ editor adapter not wired';
    return json({ result: txt });
  }
  return json({ error: 'no-op' }, 400);
}

// ── Ring-buffer writer (re-exported for clash.js to call) ───────────
//
// Append an event to clash:events:<guildId>, cap to 32 entries. The
// DLL polls /sync/<guildId>/clash-events and republishes on the
// local Aquilo Bus — which the OBS browser-source overlay subscribes
// to. Lightweight; no TTL (events live until the buffer rolls).

const RING_CAP = 32;

export async function appendClashEvent(env, guildId, kind, payload) {
  const key = 'clash:events:' + guildId;
  const all = (await env.LOADOUT_BOLTS.get(key, { type: 'json' })) || [];
  all.push({
    id: 'evt_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    ts: Date.now(),
    kind,
    payload: payload || {},
  });
  if (all.length > RING_CAP) all.splice(0, all.length - RING_CAP);
  await env.LOADOUT_BOLTS.put(key, JSON.stringify(all));
}
