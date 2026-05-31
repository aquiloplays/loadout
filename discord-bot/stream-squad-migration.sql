-- Stream Squad (discord-bot/stream-squad.js) — cross-cutting premium
-- feature #5. Users co-watch a Twitch stream as a group with a shared
-- activity feed (chat reactions, emotes, hype events).
--
-- Apply once with:
--   npx wrangler d1 execute aquilo_bot_db --file=./stream-squad-migration.sql --remote
--
-- Idempotent — all tables + indices use CREATE IF NOT EXISTS. Safe to
-- re-run. No seed data (sessions are created at runtime).

-- ── stream_squad_session ───────────────────────────────────────────
-- One row per co-watch session. ended_at NULL = still active.
-- member_count is the cached count of ACTIVE members (left_at IS NULL),
-- recomputed on every join/leave so it never drifts.
CREATE TABLE IF NOT EXISTS stream_squad_session (
  id             TEXT PRIMARY KEY,            -- uuid
  owner_user_id  TEXT NOT NULL,               -- discord id of the creator
  twitch_channel TEXT NOT NULL,               -- channel login being watched
  started_at     INTEGER NOT NULL,            -- ms epoch
  ended_at       INTEGER,                     -- ms epoch or NULL while active
  member_count   INTEGER NOT NULL DEFAULT 0
);
-- "active sessions, newest first" (list-active surface).
CREATE INDEX IF NOT EXISTS idx_squad_session_active
  ON stream_squad_session (ended_at, started_at DESC);
-- "is there an active squad for this channel?"
CREATE INDEX IF NOT EXISTS idx_squad_session_channel
  ON stream_squad_session (twitch_channel, ended_at);

-- ── stream_squad_member ────────────────────────────────────────────
-- One row per (squad, user). left_at NULL = currently in the squad.
-- Re-joining reuses the row (left_at reset to NULL, joined_at bumped).
CREATE TABLE IF NOT EXISTS stream_squad_member (
  squad_id  TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  left_at   INTEGER,
  PRIMARY KEY (squad_id, user_id)
);
-- "active roster for this squad".
CREATE INDEX IF NOT EXISTS idx_squad_member_active
  ON stream_squad_member (squad_id, left_at);

-- ── stream_squad_event ─────────────────────────────────────────────
-- The shared activity feed. kind: 'reaction' | 'emote' | 'hype' |
-- 'message' | 'join' | 'leave' (extensible — not constrained). payload
-- is an opaque JSON string the client interprets per kind.
CREATE TABLE IF NOT EXISTS stream_squad_event (
  id         TEXT PRIMARY KEY,                -- uuid
  squad_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  payload    TEXT,                            -- JSON string or NULL
  created_at INTEGER NOT NULL                 -- ms epoch
);
-- "feed for this squad, newest first" (paginated reads).
CREATE INDEX IF NOT EXISTS idx_squad_event_feed
  ON stream_squad_event (squad_id, created_at DESC);
