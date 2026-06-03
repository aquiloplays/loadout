-- Boltbound Arena draft mode (RET-5, Clay 2026-06).
--
-- Apply once with:
--   npx wrangler d1 execute aquilo_bot_db --file=./boltbound-arena-migration.sql --remote
--
-- Idempotent. One row per run; an active run is status drafting|active.
-- Arena tickets live in KV (cards:arena-tickets:<userId>), not here.

CREATE TABLE IF NOT EXISTS arena_run (
  run_id          TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  guild_id        TEXT,
  status          TEXT NOT NULL,               -- drafting | active | complete | retired
  deck_json       TEXT NOT NULL DEFAULT '[]',  -- picked card ids (grows to 30)
  offer_json      TEXT NOT NULL DEFAULT '[]',  -- current 3-card offer while drafting
  pick_number     INTEGER NOT NULL DEFAULT 0,
  wins            INTEGER NOT NULL DEFAULT 0,
  losses          INTEGER NOT NULL DEFAULT 0,
  rewards_claimed INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  ended_at        INTEGER
);
-- "this user's active run" + history, newest first.
CREATE INDEX IF NOT EXISTS idx_arena_run_user
  ON arena_run (user_id, status, created_at DESC);
