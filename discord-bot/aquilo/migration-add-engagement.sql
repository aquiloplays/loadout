-- Engagement features migration: daily this-or-that polls + game suggestions.
-- Apply once with:
--   npx wrangler d1 execute aquilo_bot_db --file=./migration-add-engagement.sql --remote
-- Idempotent (CREATE TABLE IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS daily_polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  opt_a TEXT NOT NULL,
  opt_b TEXT NOT NULL,
  posted_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_daily_polls_open ON daily_polls (guild_id, closed_at);

CREATE TABLE IF NOT EXISTS daily_votes (
  poll_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  choice  TEXT NOT NULL,                -- 'a' or 'b'
  voted_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (poll_id, user_id),
  FOREIGN KEY (poll_id) REFERENCES daily_polls (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS game_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  game_name TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'dismissed'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_suggestions_pending ON game_suggestions (guild_id, status);
