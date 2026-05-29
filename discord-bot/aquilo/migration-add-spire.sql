-- Boltbound Seasonal Spire (Clay 2026-05-28). Solo roguelike tower
-- mode — 10 floors of NPCs, boss at top, monthly themed rotation.
--
-- Apply once with:
--   npx wrangler d1 execute aquilo_bot_db --file=./migration-add-spire.sql --remote
--
-- Idempotent — all tables are CREATE IF NOT EXISTS and indices are
-- IF NOT EXISTS. Safe to re-run.

-- ── spire_seasons ───────────────────────────────────────────────────
-- One row per (themeId, month) — the 1st-of-month cron writes a fresh
-- row when it rotates to the next theme. Older rows are kept for the
-- leaderboard archive view (historical season standings).
CREATE TABLE IF NOT EXISTS spire_seasons (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  theme_id        TEXT NOT NULL,            -- ember-court, aurora-spire, etc.
  name            TEXT NOT NULL,            -- human-readable: "Ember Court"
  theme_data      TEXT NOT NULL,            -- JSON: visual treatment, boss mechanic spec, curated card pool refs
  starts_at       TEXT NOT NULL,            -- ISO 8601 UTC, e.g. 2026-06-01T00:00:00Z
  ends_at         TEXT NOT NULL,
  -- Seasonal exclusive card the boss-clear unlocks (e.g. ember.legendary)
  seasonal_exclusive_card_id TEXT,
  -- Boolean-ish: 1 if this is the currently-active season (only one
  -- at a time). Cleared on rotation, set on the new row.
  is_active       INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_spire_seasons_theme_month
  ON spire_seasons (theme_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_spire_seasons_active
  ON spire_seasons (is_active, starts_at);

-- ── spire_runs ──────────────────────────────────────────────────────
-- One row per (user, season, attempt). New row each /start; status
-- mutates as the run advances. Failed runs stay as historical records.
CREATE TABLE IF NOT EXISTS spire_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         TEXT NOT NULL,
  guild_id        TEXT NOT NULL,
  season_id       INTEGER NOT NULL,         -- FK → spire_seasons.id
  current_floor   INTEGER NOT NULL DEFAULT 1,
  lives_remaining INTEGER NOT NULL DEFAULT 3,
  status          TEXT NOT NULL DEFAULT 'active',  -- active | completed | failed | abandoned
  deck_snapshot   TEXT NOT NULL,            -- JSON: { championClass, cards: [...] } captured at /start
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at    TEXT,                     -- set when status becomes completed/failed/abandoned
  -- Floor-clear timeline as JSON array — used by leaderboard for
  -- "fastest clear time" without joining a per-floor table.
  floor_clears    TEXT,                     -- JSON: [{floor, wonAt, lifeLost?}]
  updated_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_spire_runs_user_season
  ON spire_runs (user_id, season_id, status);
CREATE INDEX IF NOT EXISTS idx_spire_runs_guild_active
  ON spire_runs (guild_id, status, season_id);
-- A user has at most ONE active run per season. Enforced at the
-- application layer; the index supports the lookup.
CREATE INDEX IF NOT EXISTS idx_spire_runs_active_lookup
  ON spire_runs (user_id, season_id, status);

-- ── spire_clears ────────────────────────────────────────────────────
-- One row per (user, season) the FIRST time they boss-clear. Used to
-- gate first-clear vs subsequent rewards. Also tracks attempts_count
-- so the embed can show "cleared on attempt 3".
CREATE TABLE IF NOT EXISTS spire_clears (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         TEXT NOT NULL,
  season_id       INTEGER NOT NULL,
  guild_id        TEXT NOT NULL,
  completed_at    TEXT NOT NULL DEFAULT (datetime('now')),
  attempts_count  INTEGER NOT NULL DEFAULT 1,
  run_id          INTEGER,                  -- which spire_run finally cleared
  clear_time_seconds INTEGER,               -- total time from first /start of this season to boss-clear
  -- Per-milestone first-clear flags. Subsequent runs within the SAME
  -- season hit /result on these floors but only the first sets the
  -- flag (used to gate Rare pack / Epic pack / Legendary pack grants).
  floor5_first_claimed INTEGER NOT NULL DEFAULT 0,
  floor9_first_claimed INTEGER NOT NULL DEFAULT 0,
  boss_first_claimed   INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_spire_clears_user_season
  ON spire_clears (user_id, season_id);
CREATE INDEX IF NOT EXISTS idx_spire_clears_season_time
  ON spire_clears (season_id, clear_time_seconds);
CREATE INDEX IF NOT EXISTS idx_spire_clears_guild_season
  ON spire_clears (guild_id, season_id, completed_at);

-- ── spire_npcs ──────────────────────────────────────────────────────
-- The roster of NPCs the player faces. Each season has 10 entries
-- (one per floor, or a few per floor range). Floor_min/max defines
-- the range the NPC can appear on (e.g. an "easy" NPC at floors 1-3,
-- a "boss" at floor 10). The deck_template is the JSON definition
-- generateSpireNpcDeck consumes; the actual deck for a fight is
-- materialised at run time using the catalogue + the template.
CREATE TABLE IF NOT EXISTS spire_npcs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id       INTEGER NOT NULL,
  npc_key         TEXT NOT NULL,            -- stable id: 'ember.guard.01', 'ember.boss'
  name            TEXT NOT NULL,            -- "Embershield Guard"
  floor_min       INTEGER NOT NULL,         -- 1
  floor_max       INTEGER NOT NULL,         -- 3
  difficulty_tier TEXT NOT NULL,            -- 'easy' | 'medium' | 'hard' | 'boss'
  deck_template   TEXT NOT NULL,            -- JSON: { champion, cardPool, sizeMin, sizeMax, raresAllowed }
  portrait        TEXT,                     -- aquilo.gg/sprites/spire-npcs/<key>.png
  flavor_text     TEXT,                     -- shown in floor preview
  -- Boss-only: per-season special mechanic spec. Null for non-boss
  -- NPCs. Engine reads this when match.kind='spire-boss'.
  boss_mechanic   TEXT,                     -- JSON: { id, phase, params } or null
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_spire_npcs_season_key
  ON spire_npcs (season_id, npc_key);
CREATE INDEX IF NOT EXISTS idx_spire_npcs_season_floor
  ON spire_npcs (season_id, floor_min, floor_max);
CREATE INDEX IF NOT EXISTS idx_spire_npcs_difficulty
  ON spire_npcs (season_id, difficulty_tier);

-- ── spire_leaderboards_archive ──────────────────────────────────────
-- On monthly rotation, the cron snapshots the outgoing season's
-- leaderboard (top N clear times + total clear count) here, so the
-- historical-season view doesn't depend on scanning spire_clears.
CREATE TABLE IF NOT EXISTS spire_leaderboards_archive (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id       INTEGER NOT NULL,
  theme_id        TEXT NOT NULL,
  total_clears    INTEGER NOT NULL DEFAULT 0,
  fastest_time_seconds INTEGER,
  -- JSON array of top 20: [{userId, username, clearTime, attempts}, ...]
  top_clears      TEXT,
  archived_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_spire_archive_season
  ON spire_leaderboards_archive (season_id);
