// Warden — banned-terms auto-moderation.
//
// A streamer configures terms with a match mode (contains/word/regex)
// and an action (delete/timeout/ban/flag). On each ingested chat
// message, evaluate() checks the message against the streamer's terms
// and, on the first hit, performs the configured action.
//
// Terms are cached per-streamer for a short TTL so the hot chat path
// doesn't hit D1 on every message. Regex terms are compiled once and
// guarded — a malformed pattern is skipped, never thrown.

import { ensureSchema, now } from './warden-db.js';
import { performAction } from './warden-actions.js';

const VALID_MODES = new Set(['contains', 'word', 'regex']);
const VALID_ACTIONS = new Set(['delete', 'timeout', 'ban', 'flag']);
const DEFAULT_TIMEOUT_SECONDS = 600; // 10 min for auto-timeout hits
const MAX_TERM_LEN = 200;

// Per-streamer compiled-term cache. Value: { at, terms:[{term, mode, action, re?}] }.
const CACHE = new Map();
const CACHE_TTL_MS = 15_000;

function cleanTerm(s) {
  return String(s == null ? '' : s).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, MAX_TERM_LEN);
}

// Compile a term row into a matcher. Returns null if the regex is
// malformed (guarded — a bad pattern must never break evaluate()).
function compileTerm(row) {
  const term = cleanTerm(row.term);
  if (!term) return null;
  const mode = VALID_MODES.has(row.mode) ? row.mode : 'contains';
  const action = VALID_ACTIONS.has(row.action) ? row.action : 'delete';
  const out = { term, mode, action };
  if (mode === 'regex') {
    try {
      out.re = new RegExp(term, 'i');
    } catch {
      return null; // skip un-compilable regex
    }
  } else if (mode === 'word') {
    // Word-boundary match, case-insensitive. Escape the literal term.
    try {
      out.re = new RegExp('\\b' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    } catch {
      return null;
    }
  }
  return out;
}

// ── Term CRUD ────────────────────────────────────────────────────────────

export async function listTerms(env, streamerId) {
  await ensureSchema(env);
  try {
    const { results } = await env.DB.prepare(
      `SELECT streamer_id, term, mode, action, added_by, ts
         FROM warden_terms
        WHERE streamer_id = ?
        ORDER BY ts DESC
        LIMIT 1000`
    ).bind(String(streamerId || '')).all();
    return results || [];
  } catch {
    return [];
  }
}

export async function addTerm(env, streamerId, { term, mode, action, addedBy } = {}) {
  await ensureSchema(env);
  const sid = String(streamerId || '');
  const t = cleanTerm(term);
  if (!t) return { ok: false, error: 'empty-term' };
  const m = VALID_MODES.has(mode) ? mode : 'contains';
  const a = VALID_ACTIONS.has(action) ? action : 'delete';
  // Reject un-compilable regex up front so it can't sit dead in the table.
  if (m === 'regex') {
    try { new RegExp(t, 'i'); } catch { return { ok: false, error: 'bad-regex' }; }
  }
  try {
    await env.DB.prepare(
      `INSERT INTO warden_terms (streamer_id, term, mode, action, added_by, ts)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(streamer_id, term) DO UPDATE SET
         mode = excluded.mode,
         action = excluded.action,
         added_by = excluded.added_by,
         ts = excluded.ts`
    ).bind(sid, t, m, a, addedBy == null ? null : String(addedBy), now()).run();
    CACHE.delete(sid);
    return { ok: true, term: t, mode: m, action: a };
  } catch (e) {
    return { ok: false, error: 'term-write-failed', detail: String(e && e.message || e) };
  }
}

export async function removeTerm(env, streamerId, term) {
  await ensureSchema(env);
  const sid = String(streamerId || '');
  try {
    await env.DB.prepare(
      `DELETE FROM warden_terms WHERE streamer_id = ? AND term = ?`
    ).bind(sid, cleanTerm(term)).run();
    CACHE.delete(sid);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'term-remove-failed', detail: String(e && e.message || e) };
  }
}

// Load + compile terms for a streamer, cached briefly.
async function loadCompiled(env, streamerId) {
  const sid = String(streamerId || '');
  const cached = CACHE.get(sid);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.terms;
  const rows = await listTerms(env, sid);
  const terms = [];
  for (const r of rows) {
    const c = compileTerm(r);
    if (c) terms.push(c);
  }
  CACHE.set(sid, { at: Date.now(), terms });
  return terms;
}

function matches(compiled, text) {
  if (compiled.re) return compiled.re.test(text);
  // 'contains' mode — case-insensitive substring.
  return text.toLowerCase().includes(compiled.term.toLowerCase());
}

// ── Evaluate one message ─────────────────────────────────────────────────
// Returns { hit, action?, term? }. On a hit for a non-mod/non-broadcaster
// message, performs the configured action (delete/timeout/ban) via
// performAction, or records a 'flag' (watchlist-style, no enforcement).
export async function evaluate(env, streamerId, msg = {}) {
  const text = String(msg.text || '');
  if (!text) return { hit: false };
  // Never auto-moderate mods or the broadcaster.
  if (msg.isMod || msg.isBroadcaster) return { hit: false };

  let terms;
  try {
    terms = await loadCompiled(env, streamerId);
  } catch {
    return { hit: false };
  }
  if (!terms.length) return { hit: false };

  let hitTerm = null;
  for (const c of terms) {
    try {
      if (matches(c, text)) { hitTerm = c; break; }
    } catch { /* a runtime regex error on one term shouldn't abort the rest */ }
  }
  if (!hitTerm) return { hit: false };

  const platform = String(msg.platform || 'twitch').toLowerCase();
  const action = hitTerm.action;

  // 'flag' is a passive WATCH term: no enforcement, but log an alert so the
  // mod team sees it in the audit / activity feed (and it counts in the
  // mod-activity stats). Use for "ping us, don't punish" phrases — someone
  // asking for a mod, a self-harm mention, a raid keyword.
  if (action === 'flag') {
    try {
      const { addAudit } = await import('./warden-audit.js');
      await addAudit(env, {
        streamerId, actorId: null, actorLogin: 'warden-watch',
        action: 'term-alert', platform,
        targetLogin: msg.login || null,
        detail: { term: hitTerm.term, text: text.slice(0, 140) },
      });
    } catch { /* alerting must never throw into the ingest path */ }
    return { hit: true, action, term: hitTerm.term };
  }

  const params = {
    streamerId,
    actorId: null,           // system actor — auto-mod, not a person
    actorLogin: 'warden-automod',
    platform,
    kind: action,            // delete | timeout | ban
    targetLogin: msg.login,
    messageId: action === 'delete' ? msg.id : undefined,
    seconds: action === 'timeout' ? DEFAULT_TIMEOUT_SECONDS : undefined,
    reason: `Auto-mod: matched banned term (${hitTerm.mode})`,
  };
  let result = null;
  try {
    result = await performAction(env, params);
  } catch { /* auto-action failure must not throw into the ingest path */ }

  return { hit: true, action, term: hitTerm.term, result };
}
