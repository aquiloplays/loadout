-- cam-border config ownership.
--
-- Mirror of the existing per-feature ownership table pattern. KV stores
-- the actual config JSON (hot read path, public-readable); D1 keeps the
-- owner-id + metadata so future Patreon-tier gating can JOIN against
-- patreon membership without touching the overlay hot path.
--
-- One row per saved config. v1 only ever has one row per owner
-- (Clay), but the schema is shaped so v2 can ship "multiple saved
-- configs per user" without a migration.

CREATE TABLE IF NOT EXISTS cam_border_configs (
  id          TEXT    PRIMARY KEY,           -- short slug, e.g. "clay-default"
  owner_id    TEXT    NOT NULL,              -- patreon user id or twitch id
  owner_type  TEXT    NOT NULL DEFAULT 'twitch',  -- 'twitch' | 'patreon'
  label       TEXT    NOT NULL DEFAULT '',   -- human label shown in admin
  visibility  TEXT    NOT NULL DEFAULT 'private',  -- 'private' | 'unlisted' | 'public'
  required_tier TEXT  NOT NULL DEFAULT '',   -- empty = no gate. v2: 'tier-1' | 'tier-2' | 'tier-3'
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cam_border_owner ON cam_border_configs(owner_id, owner_type);
CREATE INDEX IF NOT EXISTS idx_cam_border_updated ON cam_border_configs(updated_at);
