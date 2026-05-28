-- Support-ticket system v2 (Clay 2026-05-28). Extends the existing
-- `tickets` table with category / priority / threading / assignment +
-- adds a per-message timeline table. Apply once with:
--   npx wrangler d1 execute aquilo_bot_db --file=./migration-add-support-tickets.sql --remote
-- Idempotent — every ALTER + CREATE is gated. D1 ignores duplicate
-- column errors via the OR IGNORE / IF NOT EXISTS pattern.

-- 1. Extend the existing `tickets` table with the v2 columns. SQLite
--    doesn't support IF NOT EXISTS on ALTER TABLE, so each ADD COLUMN
--    is wrapped in a separate statement — the migration runner can
--    tolerate "duplicate column" errors when re-running.
ALTER TABLE tickets ADD COLUMN thread_id        TEXT;
ALTER TABLE tickets ADD COLUMN category         TEXT;
ALTER TABLE tickets ADD COLUMN subject          TEXT;
ALTER TABLE tickets ADD COLUMN description      TEXT;
ALTER TABLE tickets ADD COLUMN priority         TEXT DEFAULT 'normal';
ALTER TABLE tickets ADD COLUMN assignee_user_id TEXT;
ALTER TABLE tickets ADD COLUMN updated_at       TEXT;
ALTER TABLE tickets ADD COLUMN close_reason     TEXT;
-- `requester_user_id` is the v2 name; keep `opener_user_id` for back-
-- compat with the original aquilo/tickets.js. New code writes to
-- BOTH columns on insert; reads prefer requester_user_id.
ALTER TABLE tickets ADD COLUMN requester_user_id TEXT;

CREATE INDEX IF NOT EXISTS idx_tickets_category ON tickets (guild_id, category, status);
CREATE INDEX IF NOT EXISTS idx_tickets_priority ON tickets (guild_id, priority, status);
CREATE INDEX IF NOT EXISTS idx_tickets_assignee ON tickets (guild_id, assignee_user_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_requester ON tickets (guild_id, requester_user_id, status);

-- 2. Per-message activity log. Captures: viewer / staff messages,
--    status changes, assignment changes, category changes,
--    priority changes. The Discord thread is the source of truth
--    for chat content; this table mirrors so the PWA admin UI can
--    render a timeline without paginating Discord.
CREATE TABLE IF NOT EXISTS ticket_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id       INTEGER NOT NULL,
  guild_id        TEXT NOT NULL,
  kind            TEXT NOT NULL,   -- 'message' | 'status' | 'assign' | 'category' | 'priority' | 'close'
  user_id         TEXT,            -- author for kind='message', actor for the others
  username        TEXT,
  content         TEXT,            -- the message body, or a human-readable change summary
  meta            TEXT,            -- optional JSON-encoded structured payload
  discord_message_id TEXT,         -- when kind='message' and we know the Discord snowflake
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON ticket_messages (ticket_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ticket_messages_guild  ON ticket_messages (guild_id, created_at);
