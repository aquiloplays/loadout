-- scene-themer-migration.sql
--
-- Scene Themer config table. Mirrors the cam-border + overlay-canvas
-- pattern: one row per saved mapping config, snake_case columns, id is
-- a short slug typed by the streamer. The mapping array (Twitch category
-- -> OBS source group name) is stored as JSON in mappings_json so we can
-- treat it as one opaque blob server-side and precompute the lookup KV
-- on PUT. mapping_count is denormalized for the tier-limit enforcement
-- on the LIST view.
--
-- Apply:
--   wrangler d1 execute aquilo --file discord-bot/scene-themer-migration.sql
--
-- The handler also runs CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT
-- EXISTS at request time (see ensureSchema in scene-themer.js) so this
-- migration is for clean explicit deploys; production was bootstrapped
-- the same way as cam-border.

CREATE TABLE IF NOT EXISTS scene_themer_configs (
  id              TEXT    PRIMARY KEY,
  owner_id        TEXT    NOT NULL,
  owner_type      TEXT    NOT NULL DEFAULT 'twitch',
  owner_email     TEXT,
  broadcaster_id  TEXT,
  label           TEXT    NOT NULL DEFAULT '',
  mappings_json   TEXT    NOT NULL DEFAULT '[]',
  default_group   TEXT    NOT NULL DEFAULT 'theme_default',
  scene_name      TEXT    NOT NULL DEFAULT 'Game',
  webhook_url     TEXT,
  visibility      TEXT    NOT NULL DEFAULT 'private',
  required_tier   TEXT    NOT NULL DEFAULT '',
  mapping_count   INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scene_themer_owner
  ON scene_themer_configs(owner_id, owner_type);

CREATE INDEX IF NOT EXISTS idx_scene_themer_broadcaster
  ON scene_themer_configs(broadcaster_id);

CREATE INDEX IF NOT EXISTS idx_scene_themer_updated
  ON scene_themer_configs(updated_at);
