// Boltbound replay reactions + comments, social layer on top of the
// existing Boltbound replay infra (cards-battle.js emits the match.log
// snapshot, the replay store is keyed by `replayId`).
//
// This module owns the social state ONLY, it never mutates the
// replay itself. Reactions + comments are stored in their own D1
// tables (replay_reaction + replay_comment), keyed by replayId.
//
// Storage:
//   D1 replay_reaction   PK (replayId, userId, type), idempotent toggle
//   D1 replay_comment    autoincrement id, FK-style replayId
//
// Endpoints (all under /web/boltbound/replays/<id>/…):
//   POST .../react      { type }, HMAC, write
//   POST .../comment    { text, turnIndex? }, HMAC, write
//   GET  .../reactions  ?viewer=<userId>, public, counts + viewer's own
//   GET  .../comments   ?limit=&offset=, public, newest-first
//
// Reactions:
//   Allowed types are frozen, REACTION_TYPES. addReaction() is
//   idempotent on (replayId,userId,type): re-firing returns
//   alreadyReacted:true without throwing on the unique-key conflict.
//
// Comments:
//   Hard cap of 500 chars per body (trimmed). Per-user per-replay
//   limit of MAX_COMMENTS_PER_USER (50), enforced via a COUNT(*)
//   precheck so the user gets a clean { ok:false, reason:'cap-reached' }
//   instead of an opaque insert error.

const MAX_COMMENT_CHARS    = 500;
const MAX_COMMENTS_PER_USER = 50;

// Frozen so callers can `.includes()` and trust the order won't shift
// out from under a UI dropdown. Add new ones at the END of the list.
export const REACTION_TYPES = Object.freeze(['like', 'wow', 'clutch', 'gg']);

function isValidType(t) {
  return typeof t === 'string' && REACTION_TYPES.includes(t);
}

async function db(env) {
  if (!env.DB) throw new Error('boltbound-replays-rx: no D1 binding (env.DB missing)');
  return env.DB;
}

// ── Reactions ────────────────────────────────────────────────────

// Toggle a single reaction on. Idempotent, re-firing the same
// (replayId, userId, type) returns { ok:true, alreadyReacted:true }
// instead of bumping the row twice.
export async function addReaction(env, replayId, userId, type) {
  if (!replayId || !userId) return { ok: false, error: 'ids-required' };
  if (!isValidType(type)) {
    return { ok: false, error: 'bad-type', allowed: REACTION_TYPES.slice() };
  }
  const D = await db(env);
  // Pre-check existence so we can distinguish first-react from re-react
  // in the response, INSERT OR IGNORE would silently no-op and we'd
  // lose the signal.
  const existing = await D.prepare(
    `SELECT 1 AS hit FROM replay_reaction
      WHERE replay_id = ? AND user_id = ? AND type = ?`
  ).bind(replayId, userId, type).first();
  if (existing) return { ok: true, alreadyReacted: true };

  await D.prepare(
    `INSERT OR IGNORE INTO replay_reaction (replay_id, user_id, type, created_at)
     VALUES (?, ?, ?, ?)`
  ).bind(replayId, userId, type, Date.now()).run();
  return { ok: true, alreadyReacted: false };
}

// Remove a single reaction. Always returns ok:true, the caller's UI
// is toggle-style, so "remove what's not there" is not an error.
export async function removeReaction(env, replayId, userId, type) {
  if (!replayId || !userId) return { ok: false, error: 'ids-required' };
  if (!isValidType(type)) {
    return { ok: false, error: 'bad-type', allowed: REACTION_TYPES.slice() };
  }
  const D = await db(env);
  await D.prepare(
    `DELETE FROM replay_reaction
      WHERE replay_id = ? AND user_id = ? AND type = ?`
  ).bind(replayId, userId, type).run();
  return { ok: true };
}

// Aggregated counts + (optional) the viewer's own reaction set.
// Shape: { counts: { like: 3, gg: 1, ... }, viewerReactions: ['like'] }
// counts always includes every REACTION_TYPES key, defaulting to 0,
// so the UI doesn't have to branch on missing keys.
export async function getReactions(env, replayId, viewerUserId = null) {
  if (!replayId) return { counts: zeroCounts(), viewerReactions: [] };
  const D = await db(env);
  const rows = await D.prepare(
    `SELECT type, COUNT(*) AS n FROM replay_reaction
      WHERE replay_id = ?
      GROUP BY type`
  ).bind(replayId).all();
  const counts = zeroCounts();
  for (const r of (rows?.results || [])) {
    if (REACTION_TYPES.includes(r.type)) counts[r.type] = Number(r.n) || 0;
  }
  let viewerReactions = [];
  if (viewerUserId) {
    const my = await D.prepare(
      `SELECT type FROM replay_reaction
        WHERE replay_id = ? AND user_id = ?`
    ).bind(replayId, viewerUserId).all();
    viewerReactions = (my?.results || [])
      .map(r => r.type)
      .filter(t => REACTION_TYPES.includes(t));
  }
  return { counts, viewerReactions };
}

function zeroCounts() {
  const o = {};
  for (const t of REACTION_TYPES) o[t] = 0;
  return o;
}

// ── Comments ─────────────────────────────────────────────────────

// Add a comment on a replay. turnIndex is optional, when set, the UI
// can anchor the comment to a specific turn in the replay timeline.
// Enforces the per-user/per-replay cap up-front so we return a clean
// reason instead of relying on a DB-side constraint.
export async function addComment(env, replayId, userId, text, turnIndex = null) {
  if (!replayId || !userId) return { ok: false, reason: 'ids-required' };
  const body = String(text || '').trim();
  if (!body) return { ok: false, reason: 'empty' };
  if (body.length > MAX_COMMENT_CHARS) {
    return { ok: false, reason: 'too-long', max: MAX_COMMENT_CHARS, length: body.length };
  }
  let ti = null;
  if (turnIndex !== null && turnIndex !== undefined && turnIndex !== '') {
    const n = Number(turnIndex);
    if (!Number.isFinite(n) || n < 0) {
      return { ok: false, reason: 'bad-turn-index' };
    }
    ti = Math.floor(n);
  }
  const D = await db(env);
  const countRow = await D.prepare(
    `SELECT COUNT(*) AS n FROM replay_comment
      WHERE replay_id = ? AND user_id = ?`
  ).bind(replayId, userId).first();
  const used = Number(countRow?.n) || 0;
  if (used >= MAX_COMMENTS_PER_USER) {
    return { ok: false, reason: 'cap-reached', max: MAX_COMMENTS_PER_USER };
  }
  const createdAt = Date.now();
  const res = await D.prepare(
    `INSERT INTO replay_comment (replay_id, user_id, text, turn_index, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(replayId, userId, body, ti, createdAt).run();
  const commentId =
    res?.meta?.last_row_id ?? res?.lastRowId ?? res?.meta?.lastRowId ?? null;
  return { ok: true, commentId, createdAt };
}

// Newest-first listing. opts: { limit=50, offset=0 }. limit is capped
// to 100 so a misbehaving client can't ask for the whole table.
export async function listComments(env, replayId, opts = {}) {
  if (!replayId) return [];
  const limit  = Math.min(100, Math.max(1, Number(opts.limit)  || 50));
  const offset = Math.max(0,        Number(opts.offset) || 0);
  const D = await db(env);
  const rows = await D.prepare(
    `SELECT id, replay_id, user_id, text, turn_index, created_at
       FROM replay_comment
      WHERE replay_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?`
  ).bind(replayId, limit, offset).all();
  return (rows?.results || []).map(r => ({
    id:        Number(r.id),
    replayId:  r.replay_id,
    userId:    r.user_id,
    text:      r.text,
    turnIndex: r.turn_index === null || r.turn_index === undefined
      ? null
      : Number(r.turn_index),
    createdAt: Number(r.created_at) || 0,
  }));
}

// ── HTTP route handler ───────────────────────────────────────────
// Mirrors friends.js / daily-quests.js pattern: GETs are public, POSTs
// are HMAC-gated against AQUILO_SITE_WEB_SECRET via shared auth.js.

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
  const { verifyHmac } = await import('./auth.js');
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

// Parse the replayId out of /web/boltbound/replays/<id>/<sub>.
// Returns { replayId, sub } or null if the path doesn't match.
function _parsePath(path) {
  const PREFIX = '/web/boltbound/replays/';
  if (!path.startsWith(PREFIX)) return null;
  const rest = path.slice(PREFIX.length);
  if (!rest) return null;
  const parts = rest.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return { replayId: parts[0], sub: parts[1] };
}

export async function handleReplayRxRoute(req, env, path) {
  const parsed = _parsePath(path);
  if (!parsed) return _json({ error: 'unknown-op' }, 404);
  const { replayId, sub } = parsed;

  // GET /web/boltbound/replays/<id>/reactions[?viewer=<userId>]
  if (req.method === 'GET' && sub === 'reactions') {
    const url = new URL(req.url);
    const viewer = url.searchParams.get('viewer') || null;
    const r = await getReactions(env, replayId, viewer);
    return _json({ replayId, ...r });
  }
  // GET /web/boltbound/replays/<id>/comments[?limit=&offset=]
  if (req.method === 'GET' && sub === 'comments') {
    const url = new URL(req.url);
    const limit  = Number(url.searchParams.get('limit'))  || 50;
    const offset = Number(url.searchParams.get('offset')) || 0;
    const list = await listComments(env, replayId, { limit, offset });
    return _json({ replayId, comments: list, limit, offset });
  }

  // POSTs require HMAC.
  if (req.method !== 'POST') return _json({ error: 'method-not-allowed' }, 405);
  const gate = await _gateHmac(req, env);
  if (!gate.ok) return _json({ error: gate.error }, gate.status);
  const b = gate.body || {};
  const userId = String(b.userId || '').trim();
  if (!userId) return _json({ error: 'userId required' }, 400);

  if (sub === 'react') {
    const type = String(b.type || '').trim();
    if (!type) return _json({ error: 'type required' }, 400);
    // Allow toggle-off via { remove: true } so the same endpoint can
    // power both halves of a toggle UI.
    if (b.remove === true) {
      const r = await removeReaction(env, replayId, userId, type);
      return _json({ replayId, ...r }, r.ok ? 200 : 400);
    }
    const r = await addReaction(env, replayId, userId, type);
    return _json({ replayId, ...r }, r.ok ? 200 : 400);
  }
  if (sub === 'comment') {
    const text = String(b.text || '');
    const turnIndex = b.turnIndex ?? b.turn_index ?? null;
    const r = await addComment(env, replayId, userId, text, turnIndex);
    return _json({ replayId, ...r }, r.ok ? 200 : 400);
  }
  return _json({ error: 'unknown-op' }, 404);
}

// ── Test-only helpers ────────────────────────────────────────────
export const __internals = {
  MAX_COMMENT_CHARS,
  MAX_COMMENTS_PER_USER,
  zeroCounts,
  isValidType,
};
