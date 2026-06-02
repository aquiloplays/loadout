-- Twitch panel scratch-off cards — per-game scratch tickets, outcome
-- pools, and the Streamer.bot action registry. ADDITIVE and independent
-- of every other subsystem (cards / clash / vault / hero / death-count).
--
-- Bound to env.DB (aquilo_bot_db). Apply with:
--   npx wrangler d1 execute aquilo_bot_db --file=./scratch-off-migration.sql --remote
--
-- The worker also lazily self-applies these statements on first request
-- (ensureSchema() in scratch-off.js), so a missed migration degrades
-- gracefully rather than 500ing. Running this file is still preferred so
-- the tables exist before the first cold request.
--
-- Idempotent: CREATE TABLE / INDEX IF NOT EXISTS. All timestamps are
-- INTEGER ms-epoch (Date.now()), matching achievements/pass/aether/vault.
-- JSON payloads are TEXT, parsed/stringified in JS (no SQL json_extract).

-- A minted scratch ticket. outcome is decided SERVER-SIDE at mint time
-- (anti-cheat) but withheld from the client until scratch_pct crosses the
-- reveal threshold. outcome: 'lose' | 'challenge' | 'tamper'.
CREATE TABLE IF NOT EXISTS scratch_ticket (
  id            TEXT PRIMARY KEY,                  -- 'st_<ms>_<rand>'
  user_id       TEXT NOT NULL,                     -- Twitch viewer opaque id
  user_name     TEXT,                              -- display name at mint
  game_slug     TEXT NOT NULL,                     -- detected game at mint (or 'generic')
  game_name     TEXT,                              -- display name of the game
  bits          INTEGER NOT NULL DEFAULT 0,        -- bits spent (0 = test/comp)
  sku           TEXT,                              -- twitch product sku
  txn_id        TEXT,                              -- twitch transaction id (idempotency)
  outcome       TEXT NOT NULL DEFAULT 'lose',      -- lose|challenge|tamper (decided at mint)
  outcome_data  TEXT NOT NULL DEFAULT '{}',        -- JSON {poolId,body,durationSec,actionKey,...}
  scratch_pct   INTEGER NOT NULL DEFAULT 0,        -- 0..100 highest scratched %
  revealed      INTEGER NOT NULL DEFAULT 0,        -- 0|1 (crossed reveal threshold)
  triggered     INTEGER NOT NULL DEFAULT 0,        -- 0|1 (challenge/tamper fired on stream)
  purchased_at  INTEGER NOT NULL DEFAULT 0,
  scratched_at  INTEGER,                           -- when revealed (null = unrevealed)
  triggered_at  INTEGER                            -- when fired (null = not fired)
);

CREATE INDEX IF NOT EXISTS idx_scratch_ticket_user    ON scratch_ticket(user_id, purchased_at DESC);
CREATE INDEX IF NOT EXISTS idx_scratch_ticket_txn     ON scratch_ticket(txn_id);
CREATE INDEX IF NOT EXISTS idx_scratch_ticket_pending ON scratch_ticket(revealed, outcome, triggered);

-- Per-game pool of possible non-losing outcomes. kind: 'challenge'
-- (chat-driven thing Clay performs live) | 'tamper' (Streamer.bot control
-- tamper). weight biases the random pick within a game. duration_sec is
-- the tamper/challenge length (0 = instantaneous / open-ended). action_key
-- references scratch_streamer_bot_action.action_key for tampers (null for
-- challenges). game_slug 'generic' is the fallback pool for any game with
-- no specific entries.
CREATE TABLE IF NOT EXISTS scratch_outcome_pool (
  id           TEXT PRIMARY KEY,                   -- 'op_<slug>_<n>'
  game_slug    TEXT NOT NULL,
  kind         TEXT NOT NULL,                      -- challenge|tamper
  body         TEXT NOT NULL,                      -- the challenge/tamper text shown to chat
  action_key   TEXT,                               -- streamer_bot action key (tamper only)
  weight       INTEGER NOT NULL DEFAULT 10,
  duration_sec INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_scratch_pool_game ON scratch_outcome_pool(game_slug, active, kind);

-- Registry of allowed Streamer.bot actions a 'tamper' outcome can fire.
-- The Loadout-side relay (see SCRATCH-OFF-STREAMERBOT.md) maps action_key
-- to a Streamer.bot action id and posts to its local WebSocket server.
CREATE TABLE IF NOT EXISTS scratch_streamer_bot_action (
  action_key           TEXT PRIMARY KEY,           -- 'invert_mouse'
  action_name          TEXT NOT NULL,              -- 'Invert Mouse'
  default_duration_sec INTEGER NOT NULL DEFAULT 30,
  cooldown_sec         INTEGER NOT NULL DEFAULT 0,
  description          TEXT,
  active               INTEGER NOT NULL DEFAULT 1
);
