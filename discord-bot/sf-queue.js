// StreamFusion → community-night queue manager.
//
// Two endpoints power the in-app queue panel:
//
//   POST /sf/queue          Returns the active stream-date queue enriched
//                           with per-joiner Steam/Epic/Twitch links pulled
//                           from each joiner's wallet. The standard
//                           /queues/public surface deliberately omits
//                           joiner identity — this endpoint is the
//                           streamer-only equivalent that includes it.
//
//   POST /sf/queue/remove   Drops a joiner from a game queue. Called by
//                           the panel when the streamer marks someone
//                           "done" — keeps the worker's queue in sync
//                           with what the streamer is actually working
//                           through, so Discord /queue view counts stay
//                           accurate while community night is running.
//
// Auth: X-SF-Queue-Key header == env.SF_QUEUE_KEY (wrangler secret).
// Soft-secret model — embedded in the shipped StreamFusion build, same
// as SF_COMMUNITY_KEY. Not a real secret; the gate just stops casual
// abuse of the joiner-identity surface from random people who notice
// the route in the SF build. The exposed identity (Discord display +
// Discord user ID + linked Steam/Epic IDs) is no more sensitive than
// what a Discord member already sees in the same guild — the streamer
// just gets it batched + machine-readable.
//
// Guild resolution: the active-guild pointer (config:active_guild_id in
// STATE KV). Single-tenant deploy, single guild that matters; SF doesn't
// need to know what guild it's targeting.

import { readQueue, todayStreamDate, snapshotQueue } from './queue.js';
import { getActiveGuildId } from './aquilo/config.js';

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

function authOk(req, env) {
  const got = req.headers.get('x-sf-queue-key') || '';
  return !!env.SF_QUEUE_KEY && got === env.SF_QUEUE_KEY;
}

// Per-joiner wallet-link lookup. The wallet record's `links` array holds
// every platform identity the viewer has linked through Loadout. We
// flatten by platform → identifier here so the panel can render
// "Steam: 76561198...", "Epic: someName" without each component having
// to know the array shape.
async function readJoinerLinks(env, guildId, discordUserId) {
  if (!discordUserId) return {};
  try {
    const wallet = await env.LOADOUT_BOLTS.get(
      'wallet:' + guildId + ':' + discordUserId,
      { type: 'json' }
    );
    const links = Array.isArray(wallet?.links) ? wallet.links : [];
    const out = {};
    for (const l of links) {
      if (!l || !l.platform || !l.username) continue;
      const p = String(l.platform).toLowerCase();
      // First-write-wins on duplicate platforms — wallets occasionally
      // accumulate stale entries when a viewer relinks; the freshest
      // link is usually the first one written by the most recent
      // applySnapshot() pass.
      if (!out[p]) out[p] = String(l.username);
    }
    return out;
  } catch {
    return {};
  }
}

// ── POST /sf/queue ─────────────────────────────────────────────────
//
// Body (all fields optional):
//   { streamDate?: "YYYY-MM-DD" }   defaults to today's stream date in
//                                   the schedule's TZ
//
// Response:
//   {
//     ok:          true,
//     guildId:     "<active-guild-id>",
//     streamDate:  "2026-05-22",
//     kind:        "community" | "variety" | "fixed",
//     open:        true | false,
//     closedAt:    null | <epoch ms>,
//     capMode:     "per-match" | "per-night" | null,
//     perMatchCap: <int> | null,
//     perNightCap: <int> | null,
//     totals:      { joiners: <int>, games: <int> },
//     games: [
//       {
//         gameId:   "poker",
//         openedAt: <epoch ms>,
//         count:    <int>,
//         joiners: [
//           {
//             position:      1,
//             discordUserId: "snowflake",
//             display:       "Discord display name",
//             joinedAt:      <epoch ms>,
//             links:         {
//               steam:  "76561198012345678",   // SteamID64
//               epic:   "epic_display_name",
//               twitch: "twitch_login"
//             }
//           },
//           ...
//         ]
//       },
//       ...
//     ]
//   }
//
// When no queue is open for the date yet, returns the same shape as
// /queues/public with empty `games: []` so the panel can render the
// "no queue yet" state without special-casing.
export async function handleSfQueueRead(req, env) {
  if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405);
  if (!authOk(req, env))      return json({ ok: false, error: 'unauthorized' }, 401);

  const guildId = await getActiveGuildId(env);
  if (!guildId) return json({ ok: false, error: 'no_active_guild' }, 503);

  let body = {};
  try { body = await req.json(); }
  catch { /* empty body is fine */ }

  const streamDate = (body && typeof body.streamDate === 'string' && body.streamDate)
    ? body.streamDate
    : await todayStreamDate(env, guildId);

  const record = await readQueue(env, guildId, streamDate);
  if (!record) {
    // No record yet — return the same shape but empty so the panel
    // can render a coherent "queue hasn't been opened yet" state.
    const snap = await snapshotQueue(env, guildId, streamDate);
    return json({
      ok: true,
      guildId,
      streamDate: snap.streamDate,
      kind: snap.kind,
      open: false,
      closedAt: null,
      capMode: snap.capMode,
      perMatchCap: snap.perMatchCap,
      perNightCap: snap.perNightCap,
      totals: { joiners: 0, games: 0 },
      games: [],
    });
  }

  // Walk every joiner across every game and pull their wallet links.
  // Fan out as one Promise.all per game so a wallet read for one game
  // doesn't serialise behind another. Each KV read is ~10ms; a community
  // night with 8 joiners × 1 game = 8 reads = ~80ms total.
  const gameEntries = Object.entries(record.queues);
  const enrichedGames = await Promise.all(
    gameEntries.map(async ([gameId, g]) => {
      const joiners = Array.isArray(g.joiners) ? g.joiners : [];
      const enriched = await Promise.all(
        joiners.map(async (j, idx) => ({
          position:      idx + 1,
          discordUserId: j.discordUserId || '',
          display:       j.display || '',
          joinedAt:      j.joinedAt || 0,
          links:         await readJoinerLinks(env, guildId, j.discordUserId),
        }))
      );
      return {
        gameId,
        openedAt: g.openedAt || record.openedAt,
        count:    joiners.length,
        joiners:  enriched,
      };
    })
  );
  const totalJoiners = enrichedGames.reduce((s, g) => s + g.count, 0);

  return json({
    ok: true,
    guildId,
    streamDate,
    kind:        record.kind,
    open:        !record.closedAt,
    closedAt:    record.closedAt,
    capMode:     record.capMode,
    perMatchCap: record.perMatchCap,
    perNightCap: record.perNightCap,
    totals:      { joiners: totalJoiners, games: enrichedGames.length },
    games:       enrichedGames,
  });
}

// ── POST /sf/queue/remove ──────────────────────────────────────────
//
// Drops a joiner from a game queue. Idempotent — removing someone who
// isn't there returns ok with removed:false.
//
// Body:
//   {
//     gameId:        "poker",                  required
//     discordUserId: "snowflake",              required
//     streamDate?:   "YYYY-MM-DD"              defaults to today
//   }
//
// Response:
//   {
//     ok:        true,
//     removed:   true | false,
//     remaining: <int>      // joiners still in this game queue
//   }
export async function handleSfQueueRemove(req, env) {
  if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405);
  if (!authOk(req, env))      return json({ ok: false, error: 'unauthorized' }, 401);

  const guildId = await getActiveGuildId(env);
  if (!guildId) return json({ ok: false, error: 'no_active_guild' }, 503);

  let body;
  try { body = await req.json(); }
  catch { return json({ ok: false, error: 'bad_json' }, 400); }

  const gameId        = String(body?.gameId        || '').trim();
  const discordUserId = String(body?.discordUserId || '').trim();
  if (!gameId)        return json({ ok: false, error: 'missing_gameId' },        400);
  if (!discordUserId) return json({ ok: false, error: 'missing_discordUserId' }, 400);

  const streamDate = (body && typeof body.streamDate === 'string' && body.streamDate)
    ? body.streamDate
    : await todayStreamDate(env, guildId);

  const record = await readQueue(env, guildId, streamDate);
  if (!record || !record.queues || !record.queues[gameId]) {
    return json({ ok: true, removed: false, remaining: 0 });
  }

  const slot = record.queues[gameId];
  const joiners = Array.isArray(slot.joiners) ? slot.joiners : [];
  const before = joiners.length;
  const kept = joiners.filter((j) => String(j?.discordUserId || '') !== discordUserId);
  if (kept.length === before) {
    return json({ ok: true, removed: false, remaining: before });
  }

  slot.joiners = kept;
  await env.LOADOUT_BOLTS.put(
    'queue:v1:' + guildId + ':' + streamDate,
    JSON.stringify(record)
  );
  return json({ ok: true, removed: true, remaining: kept.length });
}
