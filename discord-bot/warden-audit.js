// Warden — audit log.
//
// Every mod action (manual, REST, WS, or auto-term) writes a row to
// warden_audit. Rows carry the acting mod's identity (server-stamped
// upstream), the platform, the target, and a free-form `detail` string
// (JSON or plain text — callers stringify).
//
// History is bounded best-effort: on each insert we occasionally prune
// rows older than ~30 days for the streamer, and cap the per-streamer
// row count. Pruning is sampled (not run on every write) to keep the
// hot path cheap; the audit table is small and bounded, not a firehose.

import { ensureSchema, newId, now } from './warden-db.js';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // ~30 days
const MAX_ROWS_PER_STREAMER = 5000;
const PRUNE_SAMPLE = 0.05; // prune on ~5% of inserts

// Best-effort prune. Never throws — pruning failure must not fail the
// action that triggered the audit write.
async function maybePrune(env, streamerId) {
  if (Math.random() > PRUNE_SAMPLE) return;
  const cutoff = now() - RETENTION_MS;
  try {
    await env.DB.prepare(
      `DELETE FROM warden_audit WHERE streamer_id = ? AND ts < ?`
    ).bind(streamerId, cutoff).run();
    // Cap remaining rows: delete everything past the newest MAX_ROWS.
    await env.DB.prepare(
      `DELETE FROM warden_audit
         WHERE streamer_id = ?
           AND id NOT IN (
             SELECT id FROM warden_audit
              WHERE streamer_id = ?
              ORDER BY ts DESC
              LIMIT ?
           )`
    ).bind(streamerId, streamerId, MAX_ROWS_PER_STREAMER).run();
  } catch { /* non-fatal */ }
}

// Insert one audit row. Returns the row (with generated id + ts) so
// callers can broadcast it into the WardenRoom feed. `detail` is
// stringified if an object is passed.
export async function addAudit(env, {
  streamerId, actorId, actorLogin, action, platform,
  targetLogin, targetId, detail,
}) {
  await ensureSchema(env);
  const id = newId();
  const ts = now();
  let detailStr = detail;
  if (detail != null && typeof detail !== 'string') {
    try { detailStr = JSON.stringify(detail); } catch { detailStr = String(detail); }
  }
  const row = {
    id,
    streamer_id: String(streamerId || ''),
    actor_id: actorId == null ? null : String(actorId),
    actor_login: actorLogin == null ? null : String(actorLogin),
    action: action == null ? null : String(action),
    platform: platform == null ? null : String(platform),
    target_login: targetLogin == null ? null : String(targetLogin),
    target_id: targetId == null ? null : String(targetId),
    detail: detailStr == null ? null : String(detailStr),
    ts,
  };
  try {
    await env.DB.prepare(
      `INSERT INTO warden_audit
         (id, streamer_id, actor_id, actor_login, action, platform, target_login, target_id, detail, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      row.id, row.streamer_id, row.actor_id, row.actor_login, row.action,
      row.platform, row.target_login, row.target_id, row.detail, row.ts,
    ).run();
  } catch { /* audit write is best-effort; never break the action */ }
  await maybePrune(env, row.streamer_id);
  return row;
}

// List recent audit rows for a streamer, newest first. `before` is a
// ts cursor for pagination (rows strictly older than it).
export async function listAudit(env, streamerId, { limit, before } = {}) {
  await ensureSchema(env);
  const lim = Math.max(1, Math.min(Number(limit) || 100, 500));
  const sid = String(streamerId || '');
  try {
    let stmt;
    if (before != null && Number.isFinite(Number(before))) {
      stmt = env.DB.prepare(
        `SELECT id, streamer_id, actor_id, actor_login, action, platform,
                target_login, target_id, detail, ts
           FROM warden_audit
          WHERE streamer_id = ? AND ts < ?
          ORDER BY ts DESC
          LIMIT ?`
      ).bind(sid, Number(before), lim);
    } else {
      stmt = env.DB.prepare(
        `SELECT id, streamer_id, actor_id, actor_login, action, platform,
                target_login, target_id, detail, ts
           FROM warden_audit
          WHERE streamer_id = ?
          ORDER BY ts DESC
          LIMIT ?`
      ).bind(sid, lim);
    }
    const { results } = await stmt.all();
    return results || [];
  } catch {
    return [];
  }
}
