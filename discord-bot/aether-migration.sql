-- Aether economy ledger (discord-bot/aether.js).
--
-- Aether is Aquilo's premium/meta currency. The passive live-accrual
-- counter (wallet.aether in stream-bonus.js) fuels Clash; THIS D1
-- ledger is the tracked, spendable economy with a full transaction
-- log + milestone grants. A user's D1 balance is lazily seeded from
-- their legacy wallet.aether the first time the ledger is touched, so
-- the two never fragment.
--
-- Apply once with:
--   npx wrangler d1 execute aquilo_bot_db --file=./aether-migration.sql --remote
--
-- Idempotent — CREATE IF NOT EXISTS throughout. Safe to re-run.

-- ── user_aether ────────────────────────────────────────────────────
-- One row per (guild, user). balance is the current spendable amount;
-- lifetime_* are monotonic totals for stats/leaderboards.
CREATE TABLE IF NOT EXISTS user_aether (
  guild_id        TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  balance         INTEGER NOT NULL DEFAULT 0,
  lifetime_earned INTEGER NOT NULL DEFAULT 0,
  lifetime_spent  INTEGER NOT NULL DEFAULT 0,
  seeded          INTEGER NOT NULL DEFAULT 0,   -- 1 once legacy wallet.aether folded in
  updated_at      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);

-- ── aether_transaction ─────────────────────────────────────────────
-- Append-only ledger. delta is signed (+earn / -spend). balance_after
-- is the post-apply balance so history reads need no running total.
CREATE TABLE IF NOT EXISTS aether_transaction (
  id            TEXT PRIMARY KEY,               -- uuid
  guild_id      TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  delta         INTEGER NOT NULL,
  reason        TEXT NOT NULL,
  balance_after INTEGER NOT NULL,
  created_at    INTEGER NOT NULL                -- ms epoch
);
-- "this user's history, newest first".
CREATE INDEX IF NOT EXISTS idx_aether_tx_user
  ON aether_transaction (guild_id, user_id, created_at DESC);
