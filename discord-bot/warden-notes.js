// Warden — mod notes, watchlist, and cross-platform identity map.
//
// All three are keyed by (streamer_id, subject_key), where subject_key
// is `<platform>:<login-lowercased>` (BE-1's subjectKey()). Notes are a
// single free-form string per subject (last-writer-wins). Watchlist is
// a flag+reason per subject. Identity links a subject to its known
// logins on other platforms (drives cross-platform ban-sync).

import { ensureSchema, now } from './warden-db.js';

const MAX_NOTE_LEN = 2000;
const MAX_REASON_LEN = 500;

function clean(s, max) {
  return String(s == null ? '' : s)
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .trim()
    .slice(0, max);
}

function normLogin(s) {
  if (s == null) return null;
  const v = String(s).trim().toLowerCase().replace(/[^a-z0-9_\-.]/g, '').slice(0, 40);
  return v || null;
}

// ── Notes ──────────────────────────────────────────────────────────────

export async function getNote(env, streamerId, subjectKey) {
  await ensureSchema(env);
  try {
    const row = await env.DB.prepare(
      `SELECT streamer_id, subject_key, note, author_id, author_login, updated_at
         FROM warden_notes
        WHERE streamer_id = ? AND subject_key = ?`
    ).bind(String(streamerId || ''), String(subjectKey || '')).first();
    return row || null;
  } catch {
    return null;
  }
}

// Upsert the note. An empty note deletes the row.
export async function setNote(env, streamerId, subjectKey, { note, authorId, authorLogin } = {}) {
  await ensureSchema(env);
  const sid = String(streamerId || '');
  const sk = String(subjectKey || '');
  const text = clean(note, MAX_NOTE_LEN);
  try {
    if (!text) {
      await env.DB.prepare(
        `DELETE FROM warden_notes WHERE streamer_id = ? AND subject_key = ?`
      ).bind(sid, sk).run();
      return { ok: true, cleared: true };
    }
    const ts = now();
    await env.DB.prepare(
      `INSERT INTO warden_notes (streamer_id, subject_key, note, author_id, author_login, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(streamer_id, subject_key) DO UPDATE SET
         note = excluded.note,
         author_id = excluded.author_id,
         author_login = excluded.author_login,
         updated_at = excluded.updated_at`
    ).bind(sid, sk, text, authorId == null ? null : String(authorId),
      authorLogin == null ? null : String(authorLogin), ts).run();
    return { ok: true, subjectKey: sk, note: text, updatedAt: ts };
  } catch (e) {
    return { ok: false, error: 'note-write-failed', detail: String(e && e.message || e) };
  }
}

// ── Watchlist ───────────────────────────────────────────────────────────

export async function listWatch(env, streamerId) {
  await ensureSchema(env);
  try {
    const { results } = await env.DB.prepare(
      `SELECT streamer_id, subject_key, reason, flagged_by, ts
         FROM warden_watchlist
        WHERE streamer_id = ?
        ORDER BY ts DESC
        LIMIT 500`
    ).bind(String(streamerId || '')).all();
    return results || [];
  } catch {
    return [];
  }
}

export async function addWatch(env, streamerId, subjectKey, { reason, flaggedBy } = {}) {
  await ensureSchema(env);
  const sid = String(streamerId || '');
  const sk = String(subjectKey || '');
  const r = clean(reason, MAX_REASON_LEN);
  try {
    const ts = now();
    await env.DB.prepare(
      `INSERT INTO warden_watchlist (streamer_id, subject_key, reason, flagged_by, ts)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(streamer_id, subject_key) DO UPDATE SET
         reason = excluded.reason,
         flagged_by = excluded.flagged_by,
         ts = excluded.ts`
    ).bind(sid, sk, r || null, flaggedBy == null ? null : String(flaggedBy), ts).run();
    return { ok: true, subjectKey: sk, reason: r, ts };
  } catch (e) {
    return { ok: false, error: 'watch-write-failed', detail: String(e && e.message || e) };
  }
}

export async function removeWatch(env, streamerId, subjectKey) {
  await ensureSchema(env);
  try {
    await env.DB.prepare(
      `DELETE FROM warden_watchlist WHERE streamer_id = ? AND subject_key = ?`
    ).bind(String(streamerId || ''), String(subjectKey || '')).run();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'watch-remove-failed', detail: String(e && e.message || e) };
  }
}

// ── Cross-platform identity map ──────────────────────────────────────────
// Links a subject (e.g. twitch:someviewer) to their known logins on
// other platforms. Ban-sync joins on this. `links` is a partial object;
// provided keys overwrite, omitted keys are preserved.

export async function getIdentity(env, streamerId, subjectKey) {
  await ensureSchema(env);
  try {
    const row = await env.DB.prepare(
      `SELECT streamer_id, subject_key, twitch_login, youtube_id, kick_login, tiktok_login, updated_at
         FROM warden_identity
        WHERE streamer_id = ? AND subject_key = ?`
    ).bind(String(streamerId || ''), String(subjectKey || '')).first();
    return row || null;
  } catch {
    return null;
  }
}

export async function linkIdentity(env, streamerId, subjectKey, links = {}) {
  await ensureSchema(env);
  const sid = String(streamerId || '');
  const sk = String(subjectKey || '');
  try {
    const existing = await getIdentity(env, sid, sk);
    const merged = {
      twitch_login: existing?.twitch_login ?? null,
      youtube_id: existing?.youtube_id ?? null,
      kick_login: existing?.kick_login ?? null,
      tiktok_login: existing?.tiktok_login ?? null,
    };
    // Accept both snake_case and camelCase keys from callers.
    if ('twitchLogin' in links || 'twitch_login' in links) {
      merged.twitch_login = normLogin(links.twitchLogin ?? links.twitch_login);
    }
    if ('youtubeId' in links || 'youtube_id' in links) {
      const y = links.youtubeId ?? links.youtube_id;
      merged.youtube_id = y == null ? null : String(y).trim().slice(0, 64) || null;
    }
    if ('kickLogin' in links || 'kick_login' in links) {
      merged.kick_login = normLogin(links.kickLogin ?? links.kick_login);
    }
    if ('tiktokLogin' in links || 'tiktok_login' in links) {
      merged.tiktok_login = normLogin(links.tiktokLogin ?? links.tiktok_login);
    }
    const ts = now();
    await env.DB.prepare(
      `INSERT INTO warden_identity
         (streamer_id, subject_key, twitch_login, youtube_id, kick_login, tiktok_login, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(streamer_id, subject_key) DO UPDATE SET
         twitch_login = excluded.twitch_login,
         youtube_id = excluded.youtube_id,
         kick_login = excluded.kick_login,
         tiktok_login = excluded.tiktok_login,
         updated_at = excluded.updated_at`
    ).bind(sid, sk, merged.twitch_login, merged.youtube_id,
      merged.kick_login, merged.tiktok_login, ts).run();
    return { ok: true, subjectKey: sk, ...merged, updated_at: ts };
  } catch (e) {
    return { ok: false, error: 'identity-write-failed', detail: String(e && e.message || e) };
  }
}
