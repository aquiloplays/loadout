-- D1 schema for aquilo-bot v2.
-- Apply with:
--   npx wrangler d1 execute aquilo_bot_db --file=./schema.sql --remote
--
-- v2 changes vs v1:
--   - Custom-poll model (embed + button voting), so poll_options.answer_id
--     becomes sort_order; new poll_votes table tracks per-user choices.
--   - polls.day_of_week tags each poll to a CN day so the schedule embed
--     can update only that day on close + cross-week exclusion can pull
--     winners by week boundary.
--   - poll_config dropped: channel ids + thresholds now live in
--     wrangler.toml [vars] since this is a single-streamer bot.

CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  art_url TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  dropped_at TEXT,
  UNIQUE (guild_id, name)
);

-- Drop+recreate poll tables. Shape changed for v2 (sort_order, day_of_week,
-- new poll_votes). Safe because no production poll data has accumulated yet.
DROP TABLE IF EXISTS poll_votes;
DROP TABLE IF EXISTS poll_options;
DROP TABLE IF EXISTS polls;
DROP TABLE IF EXISTS poll_config;

CREATE TABLE polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  day_of_week TEXT NOT NULL,           -- 'wednesday' | 'friday' | 'saturday'
  posted_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT,
  winner_game_id INTEGER,
  FOREIGN KEY (winner_game_id) REFERENCES games (id) ON DELETE SET NULL
);

CREATE INDEX idx_polls_guild_open ON polls (guild_id, closed_at);
CREATE INDEX idx_polls_week       ON polls (guild_id, posted_at);

CREATE TABLE poll_options (
  poll_id INTEGER NOT NULL,
  game_id INTEGER NOT NULL,
  sort_order INTEGER NOT NULL,         -- display order in the poll embed (0..N-1)
  PRIMARY KEY (poll_id, game_id),
  FOREIGN KEY (poll_id) REFERENCES polls (id) ON DELETE CASCADE,
  FOREIGN KEY (game_id) REFERENCES games (id) ON DELETE CASCADE
);

CREATE TABLE poll_votes (
  poll_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  game_id INTEGER NOT NULL,
  voted_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (poll_id, user_id),      -- one vote per user, replaceable
  FOREIGN KEY (poll_id) REFERENCES polls (id) ON DELETE CASCADE,
  FOREIGN KEY (game_id) REFERENCES games (id) ON DELETE CASCADE
);

CREATE INDEX idx_poll_votes_game ON poll_votes (poll_id, game_id);
