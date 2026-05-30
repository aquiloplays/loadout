-- Daily Quests (Clay 2026-05-30). Per-day rotating quest set across the
-- Aquilo game surface (check-in, Boltbound, Clash, counting, etc.).
-- Each user gets the same daily rotation; progress + claimed state is
-- per (user, quest, day) so history is preserved indefinitely.
--
-- Apply once with:
--   npx wrangler d1 execute aquilo_bot_db --file=./migration-add-daily-quests.sql --remote
--
-- Idempotent — all tables are CREATE IF NOT EXISTS and indices are
-- IF NOT EXISTS. Safe to re-run. Seed INSERTs use INSERT OR IGNORE.

-- ── daily_quest_def ────────────────────────────────────────────────
-- The catalogue of quest definitions. New defs can be added at any
-- time; weight controls the rotation odds. Setting active=0 retires a
-- quest without deleting the historical user_daily_quest rows that
-- referenced it.
CREATE TABLE IF NOT EXISTS daily_quest_def (
  id           TEXT PRIMARY KEY,           -- stable id: 'checkin.daily', 'boltbound.win.3'
  game         TEXT NOT NULL,              -- 'checkin' | 'boltbound' | 'clash' | 'counting' | 'pet' | 'general'
  type         TEXT NOT NULL,              -- 'count' (do X N times) | 'streak' | 'oneshot'
  threshold    INTEGER NOT NULL DEFAULT 1, -- N (e.g. win 3 matches → threshold=3)
  reward_json  TEXT NOT NULL,              -- JSON: { bolts?, xp?, packId? } — passed to wallet.earn()
  weight       INTEGER NOT NULL DEFAULT 1, -- rotation weight (higher = picked more often)
  active       INTEGER NOT NULL DEFAULT 1, -- 0 retires the def
  title        TEXT,                       -- human-readable: "Win 3 Boltbound matches"
  description  TEXT,                       -- shown under the title in the embed
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_daily_quest_def_active
  ON daily_quest_def (active, game);

-- ── user_daily_quest ───────────────────────────────────────────────
-- One row per (user, quest, day). Created lazily on first
-- incrementQuest() — listTodaysQuests() returns a virtual row with
-- progress=0/claimed=0 until then. `day` is the UTC date string
-- 'YYYY-MM-DD'; rolling the day is just changing the key, no
-- mutation of yesterday's rows.
CREATE TABLE IF NOT EXISTS user_daily_quest (
  user_id   TEXT NOT NULL,
  quest_id  TEXT NOT NULL,
  day       TEXT NOT NULL,                 -- 'YYYY-MM-DD' (UTC)
  progress  INTEGER NOT NULL DEFAULT 0,
  claimed   INTEGER NOT NULL DEFAULT 0,    -- 0/1; set on successful claim
  claimed_at TEXT,                          -- ISO ts when claimed
  PRIMARY KEY (user_id, quest_id, day)
);
CREATE INDEX IF NOT EXISTS idx_user_daily_quest_user_day
  ON user_daily_quest (user_id, day);
CREATE INDEX IF NOT EXISTS idx_user_daily_quest_day
  ON user_daily_quest (day);

-- ── Seed: 10 starter quest defs ─────────────────────────────────────
-- INSERT OR IGNORE so re-running the migration doesn't clobber any
-- tuning edits made via the admin slash command.
INSERT OR IGNORE INTO daily_quest_def
  (id, game, type, threshold, reward_json, weight, active, title, description)
VALUES
  ('checkin.daily',          'checkin',   'oneshot', 1, '{"bolts":10}',           5, 1, 'Daily check-in',           'Run /checkin once today.'),
  ('counting.contrib',       'counting',  'count',   5, '{"bolts":8}',            3, 1, 'Counting contributor',     'Add 5 numbers in #counting.'),
  ('boltbound.play.3',       'boltbound', 'count',   3, '{"bolts":12}',           3, 1, 'Boltbound regular',        'Play 3 Boltbound matches.'),
  ('boltbound.win.1',        'boltbound', 'count',   1, '{"bolts":15}',           4, 1, 'Boltbound winner',         'Win 1 Boltbound match.'),
  ('boltbound.win.3',        'boltbound', 'count',   3, '{"bolts":40,"xp":20}',   2, 1, 'Boltbound triple-threat',  'Win 3 Boltbound matches.'),
  ('clash.build.1',          'clash',     'count',   1, '{"bolts":8}',            3, 1, 'Clash builder',            'Place 1 building in Clash.'),
  ('clash.donate.3',         'clash',     'count',   3, '{"bolts":10}',           2, 1, 'Clash philanthropist',     'Donate 3 cards to your clan.'),
  ('pet.care.2',             'pet',       'count',   2, '{"bolts":6}',            3, 1, 'Pet caretaker',            'Feed or play with your pet 2 times.'),
  ('general.react.5',        'general',   'count',   5, '{"bolts":5}',            4, 1, 'Server enthusiast',        'React to 5 messages.'),
  ('spire.advance.1',        'general',   'count',   1, '{"bolts":12,"xp":10}',   2, 1, 'Spire climber',            'Advance 1 floor in the Seasonal Spire.');
