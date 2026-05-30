-- Boltbound replay social layer (discord-bot/boltbound-replays-rx.js).
--
-- Apply once with:
--   npx wrangler d1 execute aquilo_bot_db --file=./boltbound-replays-rx-migration.sql --remote
--
-- Idempotent: tables + indices use CREATE IF NOT EXISTS. Re-running
-- is safe and won't disturb existing rows.

-- ── replay_reaction ───────────────────────────────────────────────
-- One row per (replay, user, type). The composite PK is what makes
-- addReaction() idempotent — INSERT OR IGNORE on collision is a
-- no-op and the JS layer signals alreadyReacted:true via a precheck.
CREATE TABLE IF NOT EXISTS replay_reaction (
  replay_id   TEXT    NOT NULL,
  user_id     TEXT    NOT NULL,
  type        TEXT    NOT NULL,       -- like | wow | clutch | gg (see REACTION_TYPES)
  created_at  INTEGER NOT NULL,       -- ms since epoch
  PRIMARY KEY (replay_id, user_id, type)
);
-- "all reactions on this replay" (counts query, viewer-own query).
CREATE INDEX IF NOT EXISTS idx_replay_reaction_replay
  ON replay_reaction (replay_id);
-- "what has this user reacted to lately" (future profile use).
CREATE INDEX IF NOT EXISTS idx_replay_reaction_user_recent
  ON replay_reaction (user_id, created_at DESC);

-- ── replay_comment ────────────────────────────────────────────────
-- One row per comment. id is autoincrement so listComments() can
-- order by (created_at DESC, id DESC) for stable newest-first paging
-- even when two comments land in the same millisecond.
CREATE TABLE IF NOT EXISTS replay_comment (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  replay_id   TEXT    NOT NULL,
  user_id     TEXT    NOT NULL,
  text        TEXT    NOT NULL,       -- <= 500 chars, trim()ed by writer
  turn_index  INTEGER,                -- optional anchor into match.log[]; NULL = general
  created_at  INTEGER NOT NULL        -- ms since epoch
);
-- "comments on this replay" (the only list query we run).
CREATE INDEX IF NOT EXISTS idx_replay_comment_replay_recent
  ON replay_comment (replay_id, created_at DESC, id DESC);
-- "per-user comment count on this replay" (cap precheck in addComment).
CREATE INDEX IF NOT EXISTS idx_replay_comment_replay_user
  ON replay_comment (replay_id, user_id);
