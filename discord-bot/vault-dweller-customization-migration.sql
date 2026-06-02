-- Aquilo's Vault — per-user DWELLER customization (NEW, additive).
--
-- Lets a community member style their own vault dweller (the paper-doll
-- shown in the cross-section viewer) by reusing the Hero Phase-1
-- customization framework: sex + class + skin tone + hair + eyes +
-- (male) facial hair, plus a vault-specific OUTFIT overlay
-- (jumpsuit free; reinforced / hazmat are premium-gated).
--
-- This is INTENTIONALLY separate from the legacy per-user FS-Bot RPG
-- (Railway vault.db) AND from vault_dweller (which carries the
-- gameplay row: class / assigned_room / contribution). vault_dweller
-- stays the source of truth for assignment + contribution; this table
-- only carries cosmetic appearance, keyed by the same user_id.
--
-- Bound to env.DB (aquilo_bot_db). Apply with:
--   npx wrangler d1 execute aquilo_bot_db --file=./vault-dweller-customization-migration.sql --remote
-- Idempotent: CREATE TABLE / INDEX IF NOT EXISTS. All timestamps are
-- INTEGER ms-epoch (Date.now()). hair / eyes are JSON TEXT
-- ({ style, color }), parsed/stringified in JS (no SQL json_extract).
--
-- DO NOT couple core vault reads to this table: vault-community.js wraps
-- every read in try/catch and returns null when the table is missing,
-- so the vault keeps working before this migration is applied.

CREATE TABLE IF NOT EXISTS vault_dweller_customization (
  user_id    TEXT PRIMARY KEY,                 -- Discord snowflake (matches vault_dweller.user_id)
  guild_id   TEXT,                             -- owning guild (vault tenant)
  sex        TEXT,                             -- 'male' | 'female'
  class_key  TEXT,                             -- warrior|mage|rogue|ranger|healer
  skin_tone  TEXT,                             -- SKIN_TONES key (heroCustomization.ts)
  outfit     TEXT,                             -- 'jumpsuit' (free) | 'reinforced' | 'hazmat' (premium)
  hair       TEXT,                             -- JSON { style, color }
  eyes       TEXT,                             -- JSON { style, color }
  facial     TEXT,                             -- male-only; 'clean' = none
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_vault_dweller_cust_guild ON vault_dweller_customization(guild_id);
