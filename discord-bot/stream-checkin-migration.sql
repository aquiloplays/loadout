-- Stream check-in card config (discord-bot/stream-checkin.js) — per-user
-- customization of the ON-STREAM check-in card (frame / background / anim /
-- badges / tagline). This is SEPARATE from the daily community check-in
-- (community-checkin.js, KV `checkin-card:<g>:<u>`): the daily card tracks
-- streaks + bolts; THIS row drives the OBS "I'm here" card that animates on
-- stream when a viewer hits Check In.
--
-- Apply once with:
--   npx wrangler d1 execute aquilo_bot_db --file=./stream-checkin-migration.sql --remote
--
-- Idempotent — CREATE IF NOT EXISTS. `badges` is a JSON array stored as TEXT
-- (parsed/stringified in JS, no SQL json_extract). No seed data: a user with
-- no row gets defaults (generic supporter frame, no badges).

-- ── user_checkin_card_config ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_checkin_card_config (
  user_id      TEXT PRIMARY KEY,             -- discord id
  frame        TEXT,                          -- frame cosmetic id or NULL
  bg           TEXT,                          -- background slug or NULL
  anim         TEXT,                          -- animation id or NULL
  badges       TEXT NOT NULL DEFAULT '[]',    -- JSON [badgeId, …] (max 3)
  tagline      TEXT,                          -- free text (<=60 chars) or NULL
  last_updated INTEGER NOT NULL DEFAULT 0     -- ms epoch
);
