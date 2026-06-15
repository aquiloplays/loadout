-- tikfinity-keys-migration.sql
--
-- Per-streamer personalised TikFinity webhook keys. Backs the
-- /tikfinity/event?key=... ingest route + the /tikfinity-setup
-- wizard on aquilo-site. See tikfinity-keys.js for the runtime,
-- which also creates this table lazily on first hit (CREATE TABLE
-- IF NOT EXISTS), so applying this file manually is optional; it
-- exists for reviewable migration history.
--
-- user_id: streamer's stable identity (Discord snowflake for v1, the
--   site session subject for v2 once we drop the owner gate).
-- key: 32+ char URL-safe random token. UNIQUE so we can index lookups
--   by key (the ingest path does WHERE key = ?).
-- revoked_at: set non-null when "Reset my key" is clicked; the lookup
--   refuses revoked keys so an old TikFinity install can't keep
--   posting after rotation.

CREATE TABLE IF NOT EXISTS tikfinity_keys (
  user_id       TEXT PRIMARY KEY,
  key           TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  last_event_at INTEGER,
  event_count   INTEGER NOT NULL DEFAULT 0,
  revoked_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tikfinity_keys_key ON tikfinity_keys(key);
