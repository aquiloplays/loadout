-- Campaign sessions — AI-driven D&D-style one-shots (item 4 from
-- Clay 2026-05-28). One row per campaign. Party members each have
-- their own RPG character (existing dungeon.js hero system) which
-- gets cited in the GM system prompt.
--
-- Lifecycle:
--   1. /campaign start  → status='forming', invited_user_ids populated
--   2. Invitees accept   → accepted_user_ids grows
--   3. When all accept   → status='active', premise_id picked,
--                          opening narration generated
--   4. /campaign action  → status stays 'active', history appends
--   5. /campaign end OR  → status='complete' (or 'abandoned')
--      budget exhausted
--
-- Token economy:
--   tokens_in  / tokens_out   = cumulative across all API calls
--   cost_cents                = derived spend in USD cents
--   cost_cap_cents            = hard cap (default $2 / 200¢)
--   When cost_cents >= cost_cap_cents, /campaign action refuses
--   to call the AI and returns a "budget exhausted" notice.

CREATE TABLE IF NOT EXISTS campaign_sessions (
  id                  TEXT PRIMARY KEY,                   -- UUID
  guild_id            TEXT NOT NULL,
  starter_user_id     TEXT NOT NULL,
  invited_user_ids    TEXT NOT NULL DEFAULT '[]',         -- JSON array
  accepted_user_ids   TEXT NOT NULL DEFAULT '[]',         -- JSON array
  declined_user_ids   TEXT NOT NULL DEFAULT '[]',         -- JSON array
  status              TEXT NOT NULL,                       -- 'forming'|'active'|'paused'|'complete'|'abandoned'
  channel_id          TEXT,                                -- private channel, optional
  premise_id          TEXT,                                -- ref to premises catalogue
  history             TEXT NOT NULL DEFAULT '[]',          -- JSON array: [{ role, content, ts, userId? }]
  tokens_in           INTEGER NOT NULL DEFAULT 0,
  tokens_out          INTEGER NOT NULL DEFAULT 0,
  cost_cents          INTEGER NOT NULL DEFAULT 0,
  cost_cap_cents      INTEGER NOT NULL DEFAULT 200,        -- $2 default
  started_at          TEXT NOT NULL DEFAULT (datetime('now')),
  last_beat_at        TEXT,
  completed_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_campaign_sessions_guild_status
  ON campaign_sessions(guild_id, status);

CREATE INDEX IF NOT EXISTS idx_campaign_sessions_starter
  ON campaign_sessions(starter_user_id, status);
