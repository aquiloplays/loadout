-- Boltbound ranked ladder (RET-4, Clay 2026-06).
--
-- Apply once with:
--   npx wrangler d1 execute aquilo_bot_db --file=./boltbound-ranked-migration.sql --remote
--
-- Idempotent: CREATE IF NOT EXISTS + indices. ranked_player is one row
-- per user (current season + counters); ranked_season logs each closed
-- season for the monthly settle cron's bookkeeping.

CREATE TABLE IF NOT EXISTS ranked_player (
  user_id        TEXT PRIMARY KEY,
  guild_id       TEXT,                          -- where to credit season rewards
  season         TEXT NOT NULL,                 -- 'YYYY-MM' (UTC)
  rank_index     INTEGER NOT NULL DEFAULT 0,    -- 0=Bronze5 … 24=Diamond1, 25=Legend
  stars          INTEGER NOT NULL DEFAULT 0,    -- 0..4 within a division
  losses_at_zero INTEGER NOT NULL DEFAULT 0,    -- demotion counter at 0 stars
  floor_index    INTEGER NOT NULL DEFAULT 0,    -- protected floor (bottom of highest tier reached)
  peak_index     INTEGER NOT NULL DEFAULT 0,    -- highest rank_index this season (drives rewards)
  wins           INTEGER NOT NULL DEFAULT 0,
  losses         INTEGER NOT NULL DEFAULT 0,
  cosmetics      TEXT NOT NULL DEFAULT '[]',    -- JSON array of earned cosmetics
  updated_at     INTEGER NOT NULL DEFAULT 0
);
-- Leaderboard query: current season ordered by rank then stars.
CREATE INDEX IF NOT EXISTS idx_ranked_player_board
  ON ranked_player (season, rank_index DESC, stars DESC);
-- Season-close scan: rows still on a previous season.
CREATE INDEX IF NOT EXISTS idx_ranked_player_season
  ON ranked_player (season);

CREATE TABLE IF NOT EXISTS ranked_season (
  season_id   TEXT PRIMARY KEY,                 -- 'YYYY-MM'
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  closed      INTEGER NOT NULL DEFAULT 0
);
