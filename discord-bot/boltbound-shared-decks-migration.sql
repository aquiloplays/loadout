-- Boltbound deck sharing / community decks (RET-7, Clay 2026-06).
--
-- Apply once with:
--   npx wrangler d1 execute aquilo_bot_db --file=./boltbound-shared-decks-migration.sql --remote
--
-- Idempotent. day_copies/day_key implement the "most-copied in the last
-- 24h" Deck of the Day without a separate events table: a copy that
-- lands on a new UTC day resets the bucket first.

CREATE TABLE IF NOT EXISTS boltbound_shared_deck (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT NOT NULL,
  name           TEXT NOT NULL,
  description    TEXT,
  champion_class TEXT,
  archetype      TEXT NOT NULL DEFAULT 'other', -- aggro|midrange|control|combo|other
  cards_json     TEXT NOT NULL,                 -- flat array of card ids (with repeats)
  views          INTEGER NOT NULL DEFAULT 0,
  copies         INTEGER NOT NULL DEFAULT 0,
  day_copies     INTEGER NOT NULL DEFAULT 0,    -- copies on day_key (Deck of the Day)
  day_key        TEXT,                          -- 'YYYY-MM-DD' (UTC) for day_copies
  created_at     INTEGER NOT NULL
);
-- Popular list (copies desc) + filters by class / archetype.
CREATE INDEX IF NOT EXISTS idx_shared_deck_popular
  ON boltbound_shared_deck (copies DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shared_deck_class
  ON boltbound_shared_deck (champion_class, archetype);
-- Deck of the Day scan.
CREATE INDEX IF NOT EXISTS idx_shared_deck_day
  ON boltbound_shared_deck (day_key, day_copies DESC);
-- Per-owner trim.
CREATE INDEX IF NOT EXISTS idx_shared_deck_owner
  ON boltbound_shared_deck (owner_id, created_at DESC);
