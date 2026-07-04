// Boltbound, in-match emote broadcaster.
//
// During a live Boltbound match the two players can lob a tiny set of
// curated emotes at each other (wave / party / think / embarrassed /
// fire / pray). The site renders them as a brief overlay on the
// opponent's side; this module is the worker-side persistence + rate
// limit + broadcast helper.
//
// Storage:
//   KV emote-rl:<matchId>:<side>   { lastTs: number, count: number }
//       Rate-limit window, `count` is the per-match-per-player total
//       since the match started (caps at PER_MATCH_CAP). `lastTs` is the
//       most recent emote ms so we can enforce the 5s gap. TTL ~6h so
//       the row evicts itself when matchId expires.
//
//   KV emote-feed:<matchId>        [{ side, emoteId, ts }, ...]
//       Ring buffer of the last FEED_CAP emotes for this match, the
//       site polls this when it can't keep a live SSE open, and any
//       future SSE bus reads from the same key so reconnects don't
//       lose the last few seconds of emotes.
//
// There is no global match-SSE broadcaster in the worker today (no
// `text/event-stream` route exists), so sendEmote returns the
// broadcast payload to the caller and persists the feed entry. The
// site polls /web/boltbound/emote/feed via cards-web.js (out of scope
// here, see endpointsToWire). When/if a real SSE bus lands, hook it
// into the `broadcast` payload return of sendEmote.

import { verifyHmac } from './auth.js';

// Locked set, adding emotes is a server+client change so we freeze
// the array to make accidental mutations a clear runtime error. These
// are the SITE-canonical ids (src/lib/boltbound/emotes.ts): the client
// ships them in the emote bar, so they are authoritative.
export const ALLOWED_EMOTES = Object.freeze([
  'hello', 'wp', 'think', 'oops', 'bringit', 'gl',
]);
const EMOTE_SET = new Set(ALLOWED_EMOTES);

const ALLOWED_SIDES = new Set(['A', 'B']);

const MIN_GAP_MS    = 5_000;          // 1 emote / 5s
const PER_MATCH_CAP = 10;             // total per (match, side)
const RL_TTL_S      = 6 * 60 * 60;    // KV TTL covers match lifetime
const FEED_CAP      = 20;             // ring-buffer size for the feed

const RL_KEY   = (matchId, side) => `emote-rl:${matchId}:${side}`;
const FEED_KEY = (matchId)       => `emote-feed:${matchId}`;

// ── Public API ────────────────────────────────────────────────────

// sendEmote, rate-limit check, append to feed, return broadcast
// payload. Returns one of:
//   { ok: true, broadcast: { matchId, playerSide, emoteId, ts } }
//   { ok: false, reason: 'invalid-emote' | 'invalid-side' |
//                        'invalid-match' | 'rate-limited' |
//                        'match-cap' | 'kv-unavailable',
//     retryAfterMs?: number, count?: number }
//
// Callers (HTTP handler, future Discord button) treat ok:false as a
// soft failure, never throws. nowMs is injectable for tests.
export async function sendEmote(env, matchId, playerSide, emoteId, nowMs) {
  if (!env || !env.LOADOUT_BOLTS) {
    return { ok: false, reason: 'kv-unavailable' };
  }
  const mid  = String(matchId  || '').trim();
  const side = String(playerSide || '').trim().toUpperCase();
  const eid  = String(emoteId  || '').trim();
  if (!mid)                  return { ok: false, reason: 'invalid-match' };
  if (!ALLOWED_SIDES.has(side)) return { ok: false, reason: 'invalid-side' };
  if (!EMOTE_SET.has(eid))   return { ok: false, reason: 'invalid-emote' };

  const now = Number.isFinite(nowMs) ? Number(nowMs) : Date.now();

  // Rate-limit gate, read current row, check gap + cap, then bump.
  let rl;
  try {
    rl = await env.LOADOUT_BOLTS.get(RL_KEY(mid, side), { type: 'json' });
  } catch {
    rl = null;
  }
  rl = rl || { lastTs: 0, count: 0 };
  const lastTs = Number(rl.lastTs) || 0;
  const count  = Number(rl.count)  || 0;

  if (count >= PER_MATCH_CAP) {
    return { ok: false, reason: 'match-cap', count };
  }
  const since = now - lastTs;
  if (lastTs > 0 && since < MIN_GAP_MS) {
    return { ok: false, reason: 'rate-limited', retryAfterMs: MIN_GAP_MS - since };
  }

  // Update RL row.
  const nextRl = { lastTs: now, count: count + 1 };
  try {
    await env.LOADOUT_BOLTS.put(
      RL_KEY(mid, side),
      JSON.stringify(nextRl),
      { expirationTtl: RL_TTL_S },
    );
  } catch { /* non-fatal, worst case caller can re-spam */ }

  // Append to the feed ring buffer. Newest at the tail; cap at
  // FEED_CAP. Best-effort, feed loss just means the next poll is
  // empty, the emote still fired locally on the sender's client.
  try {
    let feed = await env.LOADOUT_BOLTS.get(FEED_KEY(mid), { type: 'json' });
    if (!Array.isArray(feed)) feed = [];
    feed.push({ side, emoteId: eid, ts: now });
    if (feed.length > FEED_CAP) feed = feed.slice(-FEED_CAP);
    await env.LOADOUT_BOLTS.put(
      FEED_KEY(mid),
      JSON.stringify(feed),
      { expirationTtl: RL_TTL_S },
    );
  } catch { /* non-fatal */ }

  const broadcast = { matchId: mid, playerSide: side, emoteId: eid, ts: now };
  return { ok: true, broadcast };
}

// readFeed, the polling endpoint. Returns up to FEED_CAP recent
// emotes, optionally filtered by `sinceTs` so the site can ask "give
// me everything after the last one I rendered."
export async function readFeed(env, matchId, sinceTs) {
  if (!env || !env.LOADOUT_BOLTS) return [];
  const mid = String(matchId || '').trim();
  if (!mid) return [];
  let feed;
  try {
    feed = await env.LOADOUT_BOLTS.get(FEED_KEY(mid), { type: 'json' });
  } catch {
    feed = null;
  }
  if (!Array.isArray(feed)) return [];
  const cutoff = Number(sinceTs) || 0;
  return cutoff > 0 ? feed.filter(e => Number(e.ts) > cutoff) : feed;
}

// ── HTTP route handler ────────────────────────────────────────────
// Mirrors the daily-quests.js handler pattern: HMAC-gated POST for
// writes; the feed read is GET + unauthenticated (it's per-match
// public state, no PII).
//
// Routes (path is the full request path, eg '/web/boltbound/emote'):
//   POST /web/boltbound/emote              { matchId, emoteId, playerSide }
//   GET  /web/boltbound/emote/feed/:mid[?sinceTs=…]

function _json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });
}

async function _gateHmac(req, env) {
  if (!env.AQUILO_SITE_WEB_SECRET) {
    return { ok: false, status: 503, error: 'AQUILO_SITE_WEB_SECRET missing' };
  }
  const bodyText = req.method === 'POST' ? await req.text() : '';
  const ts  = req.headers.get('x-aquilo-web-ts');
  const sig = req.headers.get('x-aquilo-web-sig');
  const ok  = await verifyHmac(env.AQUILO_SITE_WEB_SECRET, ts || '', bodyText, sig || '');
  if (!ok) return { ok: false, status: 401, error: 'unauthorized' };
  let body = {};
  if (bodyText) {
    try { body = JSON.parse(bodyText); }
    catch { return { ok: false, status: 400, error: 'bad-json' }; }
  }
  return { ok: true, body };
}

export async function handleEmoteRoute(req, env, path) {
  // GET feed, public, no HMAC. Path: /web/boltbound/emote/feed/<matchId>
  if (req.method === 'GET' && path.startsWith('/web/boltbound/emote/feed/')) {
    const matchId = path.slice('/web/boltbound/emote/feed/'.length).split('/')[0];
    if (!matchId) return _json({ error: 'matchId required' }, 400);
    const url = new URL(req.url);
    const sinceTs = Number(url.searchParams.get('sinceTs')) || 0;
    const events = await readFeed(env, matchId, sinceTs);
    return _json({ matchId, events });
  }

  // POST emote, HMAC-gated.
  if (req.method === 'POST' && path === '/web/boltbound/emote') {
    const gate = await _gateHmac(req, env);
    if (!gate.ok) return _json({ error: gate.error }, gate.status);
    const b = gate.body || {};
    const r = await sendEmote(env, b.matchId, b.playerSide, b.emoteId);
    return _json(r, r.ok ? 200 : 400);
  }

  return _json({ error: 'unknown-op' }, 404);
}

// ── Test-only internals ───────────────────────────────────────────
export const __internals = {
  MIN_GAP_MS, PER_MATCH_CAP, FEED_CAP, RL_TTL_S,
  RL_KEY, FEED_KEY,
};
