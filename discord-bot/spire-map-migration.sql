-- spire-map-migration.sql
-- Per-run branching-path map state. One row per active or recent
-- spire run. Cleanup query (run from a cron or maintenance script)
-- can drop rows where updated_at < (now - 30 days) since the parent
-- spire_runs row owns long-term history.

CREATE TABLE IF NOT EXISTS spire_run_map (
  run_id          TEXT PRIMARY KEY,        -- foreign-keyed to spire_runs.id (TEXT)
  map_json        TEXT NOT NULL,           -- full DAG payload (see spire-map.js generateMap)
  current_node    TEXT,                    -- nodeId of the player's current position; NULL = pre-entry
  completed_nodes TEXT NOT NULL DEFAULT '[]', -- JSON array of nodeIds the player has resolved
  updated_at      INTEGER NOT NULL         -- ms epoch — for cleanup queries
);

-- Index for cleanup / "show me stale runs" queries. Most reads are
-- by primary key so we don't bother indexing current_node.
CREATE INDEX IF NOT EXISTS idx_spire_run_map_updated_at
  ON spire_run_map (updated_at);
