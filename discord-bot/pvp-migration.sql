-- pvp-migration.sql
-- PvP duels — viewer-vs-viewer (or vs-Aquilo) D20 hero battles.
-- Additive, bound to env.DB (aquilo_bot_db). Apply once with:
--   npx wrangler d1 execute aquilo_bot_db --file=./pvp-migration.sql --remote
-- Also self-applied lazily via ensureSchema() in pvp.js (byte-identical),
-- so a cold isolate works even if this was never run. Idempotent.
-- Timestamps INTEGER ms-epoch (Date.now()). JSON payloads TEXT (jparse in JS).
-- Current champion is held in KV (pvp:champion:<guild>), not a table.

CREATE TABLE IF NOT EXISTS pvp_battle (
  id              TEXT PRIMARY KEY,                 -- 'pb_<ms>_<rand>'
  guild_id        TEXT,
  mode            TEXT NOT NULL DEFAULT 'direct',   -- direct|queue|champion
  challenger_id   TEXT NOT NULL,
  challenger_name TEXT,
  opponent_id     TEXT,                             -- null until matched (queue)
  opponent_name   TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending|active|resolved|declined|expired
  winner_id       TEXT,                             -- null until resolved
  wager           INTEGER NOT NULL DEFAULT 0,       -- per-side bolt stake
  seed            TEXT,                             -- rng seed for deterministic replay
  result          TEXT NOT NULL DEFAULT '{}',       -- JSON {winner,rounds,turns,final,combatants}
  prefight_ms     INTEGER NOT NULL DEFAULT 20000,   -- spectator pick/bet window
  created_at      INTEGER NOT NULL DEFAULT 0,
  started_at      INTEGER,                          -- accept time (window opens); null = not started
  resolved_at     INTEGER,                          -- window-closed + settled; null = not settled
  settled         INTEGER NOT NULL DEFAULT 0        -- 0|1 payouts applied
);
CREATE INDEX IF NOT EXISTS idx_pvp_battle_guild_status ON pvp_battle(guild_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pvp_battle_challenger   ON pvp_battle(challenger_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pvp_battle_opponent     ON pvp_battle(opponent_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pvp_match_event (
  id         TEXT PRIMARY KEY,                      -- 'pe_<ms>_<rand>'
  battle_id  TEXT NOT NULL,
  seq        INTEGER NOT NULL DEFAULT 0,            -- turn ordering within battle
  actor      TEXT,                                  -- 'a'|'b'
  target     TEXT,                                  -- 'a'|'b'
  action     TEXT,                                  -- attack|ultimate|tick|reflect|frozen
  result     TEXT,                                  -- hit|crit|miss|dodge|block|execute|survive|tick|heal|skip|ultimate
  roll       INTEGER NOT NULL DEFAULT 0,
  damage     INTEGER NOT NULL DEFAULT 0,
  heal       INTEGER NOT NULL DEFAULT 0,
  effect     TEXT,                                  -- burning|poisoned|freeze|marked|blessed|null
  hp_a       INTEGER NOT NULL DEFAULT 0,
  hp_b       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pvp_match_event_battle ON pvp_match_event(battle_id, seq);

CREATE TABLE IF NOT EXISTS pvp_spectator_pick (
  id          TEXT PRIMARY KEY,                     -- 'pp_<ms>_<rand>'
  battle_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  user_name   TEXT,
  picked_side TEXT NOT NULL,                        -- 'a'|'b'
  correct     INTEGER NOT NULL DEFAULT 0,           -- 0|1 set at settle
  reward      INTEGER NOT NULL DEFAULT 0,           -- bolts awarded at settle
  created_at  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pvp_spectator_pick_battle ON pvp_spectator_pick(battle_id, user_id);

CREATE TABLE IF NOT EXISTS pvp_bet (
  id          TEXT PRIMARY KEY,                     -- 'pbet_<ms>_<rand>'
  battle_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  user_name   TEXT,
  picked_side TEXT NOT NULL,                        -- 'a'|'b'
  amount      INTEGER NOT NULL DEFAULT 0,           -- bolts staked
  payout      INTEGER NOT NULL DEFAULT 0,           -- 0 until settled
  settled     INTEGER NOT NULL DEFAULT 0,           -- 0|1
  created_at  INTEGER NOT NULL DEFAULT 0,
  settled_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pvp_bet_battle ON pvp_bet(battle_id, settled);
CREATE INDEX IF NOT EXISTS idx_pvp_bet_user   ON pvp_bet(user_id, created_at DESC);
