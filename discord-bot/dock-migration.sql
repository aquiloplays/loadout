-- dock-migration.sql
--
-- D1 schema for the Aquilo Dock per-user state. The dock.js module
-- creates this table lazily on first hit (CREATE TABLE IF NOT EXISTS),
-- so applying this file manually is optional, but the canonical schema
-- lives here for reviewable migration history.
--
-- enabled_tools_json: JSON array of tool ids from the dock registry.
--   Filtered on read against the live registry so a removed tool never
--   resurrects on the client.
-- layout_pref: 'compact' (OBS 400px dock) or 'roomy' (popout tab).

CREATE TABLE IF NOT EXISTS dock_user_state (
  user_id            TEXT PRIMARY KEY,
  enabled_tools_json TEXT NOT NULL DEFAULT '[]',
  layout_pref        TEXT NOT NULL DEFAULT 'compact',
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dock_user_updated ON dock_user_state(updated_at);
