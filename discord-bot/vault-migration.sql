-- Knowledge Vault schema (Clay's personal highlights store).
--
-- Apply with:
--   npx wrangler d1 execute aquilo_bot_db --file=./vault-migration.sql --remote
--
-- Owner-only data: every row is scoped to a user_id (Clay's Discord id).
-- kindle_highlights and pdf_highlights share the same review-state shape
-- (last_reviewed_at / next_review_at / review_count / ease_factor) so the
-- daily digest (phase 2) can mix both sources with one selection pass.

CREATE TABLE IF NOT EXISTS kindle_highlights (
  id               TEXT PRIMARY KEY,            -- deterministic hash(asin|location|text)
  user_id          TEXT NOT NULL,
  book_title       TEXT NOT NULL DEFAULT '',
  book_author      TEXT NOT NULL DEFAULT '',
  location         TEXT,                         -- kindle location / page label
  asin             TEXT,
  highlight_text   TEXT NOT NULL,
  color            TEXT,                         -- yellow / blue / pink / orange
  note             TEXT,
  favorite         INTEGER NOT NULL DEFAULT 0,
  date_added       INTEGER NOT NULL DEFAULT 0,   -- ms epoch (from kindle, or ingest time)
  last_reviewed_at INTEGER,
  next_review_at   INTEGER,                       -- ms epoch; NULL = not in rotation
  review_count     INTEGER NOT NULL DEFAULT 0,
  ease_factor      REAL NOT NULL DEFAULT 2.5,
  created_at       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_kh_user ON kindle_highlights(user_id);
CREATE INDEX IF NOT EXISTS idx_kh_next ON kindle_highlights(user_id, next_review_at);
CREATE INDEX IF NOT EXISTS idx_kh_book ON kindle_highlights(user_id, book_title);

CREATE TABLE IF NOT EXISTS pdf_documents (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  filename     TEXT NOT NULL,
  title        TEXT,
  page_count   INTEGER NOT NULL DEFAULT 0,
  r2_key       TEXT,                              -- NULL until R2 bucket provisioned
  pages_json   TEXT,                              -- JSON [pageText, ...] (phase 1 text store)
  uploaded_at  INTEGER NOT NULL DEFAULT 0,
  extracted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pdf_user ON pdf_documents(user_id);

CREATE TABLE IF NOT EXISTS pdf_highlights (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  document_id      TEXT NOT NULL,
  page_number      INTEGER NOT NULL DEFAULT 0,
  highlight_text   TEXT NOT NULL,
  color            TEXT,
  note             TEXT,
  favorite         INTEGER NOT NULL DEFAULT 0,
  in_review        INTEGER NOT NULL DEFAULT 0,    -- "add to daily review" toggle
  position         TEXT,                           -- JSON anchor (optional)
  date_added       INTEGER NOT NULL DEFAULT 0,
  last_reviewed_at INTEGER,
  next_review_at   INTEGER,
  review_count     INTEGER NOT NULL DEFAULT 0,
  ease_factor      REAL NOT NULL DEFAULT 2.5
);
CREATE INDEX IF NOT EXISTS idx_ph_user ON pdf_highlights(user_id);
CREATE INDEX IF NOT EXISTS idx_ph_doc ON pdf_highlights(document_id);
CREATE INDEX IF NOT EXISTS idx_ph_next ON pdf_highlights(user_id, next_review_at);
