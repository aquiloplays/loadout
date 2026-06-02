-- Aquilo's Vault — community cross-section layer (NEW, additive).
--
-- This is the worker-native rebuild of Aquilo's Vault as a shared,
-- Fallout-Shelter-style cross-section the whole community builds and
-- defends together. It is INTENTIONALLY separate from (and does not
-- touch) the legacy per-user FS-Bot RPG that still lives on Railway in
-- `vault.db` (dwellers/items/raids/factions/…). See
-- memory/vault-rebuild-scope-decision.md.
--
-- Bound to env.DB (aquilo_bot_db). Apply with:
--   npx wrangler d1 execute aquilo_bot_db --file=./vault-community-migration.sql --remote
-- Idempotent: CREATE TABLE / INDEX IF NOT EXISTS. All timestamps are
-- INTEGER ms-epoch (Date.now()), matching achievements/pass/aether.
-- JSON payloads are TEXT, parsed/stringified in JS (no SQL json_extract).

-- Singleton-per-guild shared vault. id = guildId (one row per guild;
-- Aquilo's guild is the only live tenant today).
CREATE TABLE IF NOT EXISTS vault_state (
  id                  TEXT PRIMARY KEY,                 -- guildId
  guild_id            TEXT,
  current_rooms       TEXT NOT NULL DEFAULT '[]',       -- JSON [{id,type,tier,x,y,builtAt}]
  dweller_assignments TEXT NOT NULL DEFAULT '{}',       -- JSON { userId: roomId }
  threats             TEXT NOT NULL DEFAULT '[]',       -- JSON [crisisId, …] (active)
  unlocked_room_types TEXT NOT NULL DEFAULT '[]',       -- JSON [roomTypeKey, …]
  resources           TEXT NOT NULL DEFAULT '{}',       -- JSON {population,water,food,power,happiness,threat}
  expand_progress     INTEGER NOT NULL DEFAULT 0,       -- contributions toward next room
  expand_threshold    INTEGER NOT NULL DEFAULT 100,     -- points needed for next expansion
  created_at          INTEGER NOT NULL DEFAULT 0,
  updated_at          INTEGER NOT NULL DEFAULT 0
);

-- Community members who have opted into the vault. class drives the
-- starter-room assignment (Warrior->Security, Mage->Reactor, …).
CREATE TABLE IF NOT EXISTS vault_dweller (
  user_id            TEXT PRIMARY KEY,
  guild_id           TEXT,
  username           TEXT,
  class              TEXT,                              -- warrior|mage|rogue|ranger|healer|null
  assigned_room      TEXT,                              -- roomId in vault_state.current_rooms
  contribution_total INTEGER NOT NULL DEFAULT 0,        -- lifetime crisis+expansion points (drives Overseer)
  joined_at          INTEGER NOT NULL DEFAULT 0,
  last_seen_in_vault INTEGER NOT NULL DEFAULT 0
);

-- Crises the community resolves together (raiders/fire/radstorm/…).
CREATE TABLE IF NOT EXISTS vault_crisis (
  id            TEXT PRIMARY KEY,                        -- e.g. 'cr_<ms>_<rand>'
  guild_id      TEXT,
  kind          TEXT NOT NULL,                           -- raiders|fire|radstorm|infestation|power-failure
  room_id       TEXT,                                    -- affected room (null = vault-wide)
  severity      INTEGER NOT NULL DEFAULT 1,
  threshold     INTEGER NOT NULL DEFAULT 50,             -- contribution points to resolve
  progress      INTEGER NOT NULL DEFAULT 0,
  contributions TEXT NOT NULL DEFAULT '{}',              -- JSON { userId: points }
  started_at    INTEGER NOT NULL,
  ends_at       INTEGER,                                 -- soft deadline (ms); null = open-ended
  ended_at      INTEGER,                                 -- actual resolution time; null = ACTIVE
  resolution    TEXT                                     -- resolved|failed|expired|null
);

CREATE INDEX IF NOT EXISTS idx_vault_crisis_guild_active ON vault_crisis(guild_id, ended_at, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_vault_dweller_guild_room  ON vault_dweller(guild_id, assigned_room);
