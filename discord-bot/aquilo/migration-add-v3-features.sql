-- v3 features: passport / streak / achievements / welcome / birthdays /
-- trivia / shop / clip-of-the-week / returning-member / leaderboard
-- snapshots. Apply with:
--   npx wrangler d1 execute aquilo_bot_db --file=./migration-add-v3-features.sql --remote

-- Cross-product daily streak. One row per (guild, user).
CREATE TABLE IF NOT EXISTS streaks (
  guild_id      TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  current_days  INTEGER NOT NULL DEFAULT 0,
  longest_days  INTEGER NOT NULL DEFAULT 0,
  last_tick_et  TEXT NOT NULL,                -- yyyy-mm-dd ET of last credit
  total_ticks   INTEGER NOT NULL DEFAULT 0,    -- lifetime days credited
  PRIMARY KEY (guild_id, user_id)
);

-- D1-backed achievements. `key` matches the catalog in achievements.js;
-- earned_at is null while in-progress, populated on completion.
CREATE TABLE IF NOT EXISTS achievements (
  guild_id    TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  key         TEXT NOT NULL,
  progress    INTEGER NOT NULL DEFAULT 0,
  earned_at   TEXT,
  PRIMARY KEY (guild_id, user_id, key)
);
CREATE INDEX IF NOT EXISTS idx_achievements_earned
  ON achievements (guild_id, key, earned_at);

-- Birthdays. MM-DD form (no year — privacy). One row per user.
CREATE TABLE IF NOT EXISTS birthdays (
  guild_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  month_day  TEXT NOT NULL,         -- "MM-DD"
  set_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_birthdays_md
  ON birthdays (guild_id, month_day);

-- Trivia question pool. Streamer-curated; one correct answer + up to 3
-- distractors.
CREATE TABLE IF NOT EXISTS trivia_questions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    TEXT NOT NULL,
  question    TEXT NOT NULL,
  correct     TEXT NOT NULL,
  wrong_1     TEXT,
  wrong_2     TEXT,
  wrong_3     TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  added_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_used   TEXT
);

-- Trivia rounds (one per cron firing). Tracks the answer + who won.
CREATE TABLE IF NOT EXISTS trivia_rounds (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id     TEXT NOT NULL,
  question_id  INTEGER NOT NULL,
  message_id   TEXT,
  posted_at    TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at    TEXT,
  winner_id    TEXT,
  FOREIGN KEY (question_id) REFERENCES trivia_questions (id) ON DELETE CASCADE
);

-- Discord-side Bolts shop. Streamer-managed catalog with weekly restock.
CREATE TABLE IF NOT EXISTS shop_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    TEXT NOT NULL,
  slug        TEXT NOT NULL,       -- machine name, e.g. "color_role_24h"
  label       TEXT NOT NULL,       -- display in shop
  description TEXT,
  price       INTEGER NOT NULL,    -- bolts
  stock       INTEGER,             -- null = infinite
  active      INTEGER NOT NULL DEFAULT 1,
  UNIQUE (guild_id, slug)
);

CREATE TABLE IF NOT EXISTS shop_purchases (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id     TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  item_id      INTEGER NOT NULL,
  bolts_spent  INTEGER NOT NULL,
  bought_at    TEXT NOT NULL DEFAULT (datetime('now')),
  fulfilled    INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (item_id) REFERENCES shop_items (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_shop_purchases_user
  ON shop_purchases (guild_id, user_id, bought_at);

-- Clip-of-the-week: clip URLs posted in #clips get tallied via :clap:
-- reactions. Week boundary = Sunday 00:00 ET. The bot scans #clips
-- weekly to compute the top 3.
CREATE TABLE IF NOT EXISTS clips (
  message_id    TEXT PRIMARY KEY,
  guild_id      TEXT NOT NULL,
  channel_id    TEXT NOT NULL,
  author_id     TEXT NOT NULL,
  url           TEXT NOT NULL,
  posted_at     TEXT NOT NULL DEFAULT (datetime('now')),
  clap_count    INTEGER NOT NULL DEFAULT 0,
  last_synced   TEXT
);
CREATE INDEX IF NOT EXISTS idx_clips_week ON clips (guild_id, posted_at);

-- Returning-member tracking. Records last seen so we can DM after 30+ days.
CREATE TABLE IF NOT EXISTS last_seen (
  guild_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  last_ts    TEXT NOT NULL DEFAULT (datetime('now')),
  dm_sent_at TEXT,                  -- null if no return-DM sent yet
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_last_seen_ts ON last_seen (guild_id, last_ts);

-- Welcome-ritual tracking (one-time first-link).
CREATE TABLE IF NOT EXISTS welcomed (
  guild_id     TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  welcomed_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (guild_id, user_id)
);

-- Member-join dates for "Veteran" achievement + anniversaries.
CREATE TABLE IF NOT EXISTS member_joins (
  guild_id    TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  joined_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (guild_id, user_id)
);
