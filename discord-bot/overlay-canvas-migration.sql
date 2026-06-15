-- overlay-canvas-migration.sql
--
-- Aquilo Overlay Composer (internal codename: overlay-canvas).
--
-- Layout JSON lives in KV under overlay-canvas:layout:<id> for hot reads
-- (every overlay tab in OBS pulls it on load). D1 tracks ownership,
-- discoverability metadata, and tier accounting so we can compute
-- "layouts per owner" without doing a KV scan.
--
-- Run with:
--   wrangler d1 execute aquilo_bot_db --remote --file=overlay-canvas-migration.sql
--
-- Idempotent. Safe to re-run.

CREATE TABLE IF NOT EXISTS overlay_canvas_layouts (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  owner_email   TEXT,
  label         TEXT NOT NULL DEFAULT '',
  visibility    TEXT NOT NULL DEFAULT 'private',  -- 'private' | 'unlisted' | 'public'
  required_tier TEXT NOT NULL DEFAULT 'free',     -- 'free' | 't1' | 't2' | 't3'
  forked_from   TEXT,                              -- nullable, source layout id
  published_at  INTEGER,                           -- ms epoch, NULL until published
  widget_count  INTEGER NOT NULL DEFAULT 0,
  custom_css    INTEGER NOT NULL DEFAULT 0,        -- 0 or 1, T2+ flag
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_overlay_canvas_owner
  ON overlay_canvas_layouts(owner_id);

CREATE INDEX IF NOT EXISTS idx_overlay_canvas_visibility
  ON overlay_canvas_layouts(visibility, required_tier);

CREATE INDEX IF NOT EXISTS idx_overlay_canvas_published
  ON overlay_canvas_layouts(published_at DESC)
  WHERE published_at IS NOT NULL;

-- Reference images for the builder (OBS scene screenshots). One row per
-- owner since the builder only needs the current background. The bytes
-- live in R2 under references/<owner_id>/<key>.
CREATE TABLE IF NOT EXISTS overlay_canvas_reference_images (
  owner_id   TEXT PRIMARY KEY,
  r2_key     TEXT NOT NULL,
  mime       TEXT NOT NULL DEFAULT 'image/png',
  bytes      INTEGER NOT NULL DEFAULT 0,
  width      INTEGER NOT NULL DEFAULT 0,
  height     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
