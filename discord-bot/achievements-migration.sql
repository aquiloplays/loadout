-- Root-level achievements module (discord-bot/achievements.js).
--
-- Apply once with:
--   npx wrangler d1 execute aquilo_bot_db --file=./achievements-migration.sql --remote
--
-- Idempotent: all tables + indices use CREATE IF NOT EXISTS, seed
-- rows use INSERT OR IGNORE. Re-running is safe and won't disturb
-- existing user_achievement rows.

-- ── achievement_def ────────────────────────────────────────────────
-- Catalogue of every achievement that can be unlocked. Owned by the
-- worker, not user-editable. Flip `active` to 0 to retire without
-- destroying historic unlocks.
CREATE TABLE IF NOT EXISTS achievement_def (
  id                TEXT PRIMARY KEY,           -- snake-case slug, stable forever
  name              TEXT NOT NULL,
  description       TEXT NOT NULL,
  icon              TEXT NOT NULL,              -- emoji or sprite hint
  tier              TEXT NOT NULL,              -- bronze | silver | gold | platinum
  points            INTEGER NOT NULL DEFAULT 10,
  trigger_type      TEXT NOT NULL,              -- event.type the engine matches against
  trigger_threshold INTEGER,                    -- for cumulative triggers; NULL/1 = one-shot
  active            INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_achievement_def_trigger
  ON achievement_def (trigger_type, active);

-- ── user_achievement ───────────────────────────────────────────────
-- One row per (user, achievement). Composite PK makes INSERT OR
-- IGNORE the idempotency primitive: the second unlock attempt is a
-- harmless no-op.
CREATE TABLE IF NOT EXISTS user_achievement (
  user_id        TEXT NOT NULL,
  achievement_id TEXT NOT NULL,
  unlocked_at    INTEGER NOT NULL,              -- ms since epoch (Date.now())
  PRIMARY KEY (user_id, achievement_id)
);
-- "latest unlocks for this user" (profile page recent feed).
CREATE INDEX IF NOT EXISTS idx_user_achievement_recent
  ON user_achievement (user_id, unlocked_at DESC);
-- "global latest unlocks" (community feed; not used yet but cheap).
CREATE INDEX IF NOT EXISTS idx_user_achievement_global_recent
  ON user_achievement (unlocked_at DESC);

-- ── Seed catalogue (15 starter achievements across games) ──────────
-- Tier scale: bronze (entry) → silver (committed) → gold (veteran) →
-- platinum (mastery). Points roughly track tier (10/25/50/100).
INSERT OR IGNORE INTO achievement_def
  (id, name, description, icon, tier, points, trigger_type, trigger_threshold)
VALUES
  -- Stream check-in ladder
  ('first-checkin',         'First Check-In',         'Check in to your first stream.',                'sun',     'bronze',   10, 'checkin',           1),
  ('checkin-10',            'Regular Viewer',         'Check in 10 times.',                            'sun',     'silver',   25, 'checkin',          10),
  ('checkin-50',            'Loyal Viewer',           'Check in 50 times.',                            'sun',     'gold',     50, 'checkin',          50),
  ('checkin-200',           'Pillar of the Community','Check in 200 times.',                           'sun',     'platinum',100, 'checkin',         200),
  -- Boltbound (the worker dispatches event.type 'boltbound-win' on a victory)
  ('first-boltbound-win',   'First Bolt',             'Win your first Boltbound match.',               'bolt',    'bronze',   10, 'boltbound-win',     1),
  ('boltbound-win-25',      'Storm Caller',           'Win 25 Boltbound matches.',                     'bolt',    'silver',   25, 'boltbound-win',    25),
  ('boltbound-win-100',     'Bolt Lord',              'Win 100 Boltbound matches.',                    'bolt',    'gold',     50, 'boltbound-win',   100),
  -- Counting channel
  ('first-count',           'First Count',            'Count at least once in the counting channel.',  'abacus',  'bronze',   10, 'count',             1),
  ('bolts-counted-50',      'Tally Keeper',           'Count to 50 in the counting channel.',          'abacus',  'silver',   25, 'count',            50),
  ('bolts-counted-500',     'Master of Numbers',      'Count to 500 in the counting channel.',         'abacus',  'gold',     50, 'count',           500),
  -- Spire (Boltbound roguelike)
  ('first-spire-clear',     'Spire Climber',          'Clear the Boltbound Spire once.',               'tower',   'silver',   25, 'spire-clear',       1),
  ('spire-boss-3',          'Spire Champion',         'Clear the Spire boss 3 times.',                 'crown',   'gold',     50, 'spire-clear',       3),
  -- Clash
  ('first-clash-raid',      'First Raid',             'Run your first Clash raid.',                    'shield',  'bronze',   10, 'clash-raid',        1),
  ('clash-three-star',      'Three-Star Raider',      'Land a 3-star Clash raid.',                     'star',    'silver',   25, 'clash-three-star',  1),
  -- Pets
  ('first-pet-tamed',       'First Friend',           'Tame your first pet.',                          'paw',     'bronze',   10, 'pet-tamed',         1);
