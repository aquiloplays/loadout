-- Aquilo Pass v2 — D1-backed seasonal battle pass (discord-bot/
-- aquilo-pass-d1.js). Distinct from the legacy KV pass in
-- aquilo-pass.js (50-tier, XP-on-wallet); this is the D1 design Clay
-- specced: 30 tiers/season, free + premium tracks, a reward catalogue
-- table, and a per-user progress table. Namespaced behind
-- /web/pass2/* so both coexist (same pattern as achievements-d1).
--
-- Apply once with:
--   npx wrangler d1 execute aquilo_bot_db --file=./aquilo-pass-d1-migration.sql --remote
--
-- Idempotent — CREATE IF NOT EXISTS + INSERT OR IGNORE. The Season 1
-- seed (definition + 60 reward rows) lives in aquilo-pass-d1.js's
-- seedSeasonOne() so reward tuning stays in code; this file only
-- creates the schema.

-- ── aquilo_pass_season ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS aquilo_pass_season (
  id         TEXT PRIMARY KEY,            -- e.g. 'season-1'
  name       TEXT NOT NULL,
  started_at INTEGER NOT NULL,            -- ms epoch
  ends_at    INTEGER,                     -- ms epoch or NULL (open-ended)
  tiers      INTEGER NOT NULL DEFAULT 30,
  active     INTEGER NOT NULL DEFAULT 1
);

-- ── aquilo_pass_reward ─────────────────────────────────────────────
-- Reward catalogue: one row per (season, tier, track). track is
-- 'free' | 'premium'. kind: 'bolts' | 'aether' | 'cosmetic' | 'pack'.
-- payload is a JSON string interpreted per kind ({amount} / {cosmeticId}
-- / {packId}).
CREATE TABLE IF NOT EXISTS aquilo_pass_reward (
  season_id TEXT NOT NULL,
  tier      INTEGER NOT NULL,
  track     TEXT NOT NULL,                -- free | premium
  kind      TEXT NOT NULL,
  payload   TEXT,
  PRIMARY KEY (season_id, tier, track)
);
CREATE INDEX IF NOT EXISTS idx_pass_reward_season
  ON aquilo_pass_reward (season_id, tier);

-- ── user_pass_progress ─────────────────────────────────────────────
-- Per-user, per-season progress. claimed_free / claimed_premium are
-- comma-separated tier lists (small — max 30 each). premium=1 once the
-- user owns the premium track.
CREATE TABLE IF NOT EXISTS user_pass_progress (
  season_id        TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  xp               INTEGER NOT NULL DEFAULT 0,
  tier             INTEGER NOT NULL DEFAULT 0,
  premium          INTEGER NOT NULL DEFAULT 0,
  claimed_free     TEXT NOT NULL DEFAULT '',
  claimed_premium  TEXT NOT NULL DEFAULT '',
  updated_at       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (season_id, user_id)
);
