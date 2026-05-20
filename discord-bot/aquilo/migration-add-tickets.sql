-- Ticketing system. Apply once with:
--   npx wrangler d1 execute aquilo_bot_db --file=./migration-add-tickets.sql --remote
-- Idempotent (CREATE TABLE IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS ticket_config (
  guild_id TEXT PRIMARY KEY,
  panel_title TEXT DEFAULT 'Support Tickets',
  panel_description TEXT DEFAULT 'Need help? Pick a category below to open a private ticket. Staff will be with you shortly.',
  staff_role_id TEXT,
  category_id TEXT,
  log_channel_id TEXT,
  panel_channel_id TEXT,
  panel_message_id TEXT
);

CREATE TABLE IF NOT EXISTS ticket_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  label TEXT NOT NULL,
  emoji TEXT,
  description TEXT,
  ping_role_id TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ticket_types_guild ON ticket_types (guild_id, sort_order);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  opener_user_id TEXT NOT NULL,
  type_label TEXT,
  status TEXT NOT NULL DEFAULT 'open',     -- 'open' | 'closed' | 'deleted'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT,
  closed_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_tickets_open ON tickets (guild_id, opener_user_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_channel ON tickets (channel_id);
