-- Self-assign roles via Discord buttons (self-roles.js).
-- Apply with:
--   npx wrangler d1 execute aquilo_bot_db --file=./migration-add-self-roles.sql --remote

CREATE TABLE IF NOT EXISTS self_roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  label TEXT NOT NULL,
  emoji TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (guild_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_self_roles_guild ON self_roles (guild_id, sort_order);
