-- Aquilo Kitchen schema (Clay's personal recipe library + weekly meal plan).
--
-- Apply with:
--   npx wrangler d1 execute aquilo_bot_db --file=./kitchen-migration.sql --remote
--
-- Owner-only data. Every row is scoped to a user_id (Clay's Discord id).
-- kitchen_recipes is the rotating recipe library (seeded once via Haiku,
-- regenerated on demand). kitchen_picks records which recipes were chosen
-- for a given week so the dashboard, push tap, and grocery list all read
-- the same set. kitchen_pantry tracks what is on hand so the grocery list
-- can deduplicate. kitchen_prefs (KV-backed in code) keeps the user-facing
-- toggles (allergies, weekly count, push schedule).

CREATE TABLE IF NOT EXISTS kitchen_recipes (
  id                TEXT PRIMARY KEY,             -- rcp_<hash20>
  user_id           TEXT NOT NULL,                -- owner's Discord id
  title             TEXT NOT NULL,
  type              TEXT NOT NULL,                -- meal / snack / side / infant
  cuisine           TEXT,                          -- italian / mexican / asian / american / ...
  protein           TEXT,                          -- chicken / beef / eggs / beans / tofu / fish / none
  ingredients_json  TEXT NOT NULL,                -- JSON [{name, qty, unit, pantryStaple}, ...]
  steps_json        TEXT NOT NULL,                -- JSON [step1, step2, ...]
  prep_min          INTEGER NOT NULL DEFAULT 0,
  cook_min          INTEGER NOT NULL DEFAULT 0,
  cost_estimate_usd REAL NOT NULL DEFAULT 0,      -- per-serving estimate
  servings          INTEGER NOT NULL DEFAULT 4,
  kid_friendly      INTEGER NOT NULL DEFAULT 1,
  infant_safe       INTEGER NOT NULL DEFAULT 0,
  infant_age_months INTEGER,                       -- 6 / 12 / 18 when infant_safe = 1
  tags_json         TEXT,                          -- JSON tags (mild, finger-food, freezer, etc.)
  notes             TEXT,                          -- picky-eater tips + presentation
  picked_count      INTEGER NOT NULL DEFAULT 0,   -- how many times surfaced in a weekly pick
  last_pushed_at    INTEGER,                       -- ms epoch, blocks 6-week repeats
  generated_at      INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_kr_user ON kitchen_recipes(user_id);
CREATE INDEX IF NOT EXISTS idx_kr_type ON kitchen_recipes(user_id, type);
CREATE INDEX IF NOT EXISTS idx_kr_pushed ON kitchen_recipes(user_id, last_pushed_at);

CREATE TABLE IF NOT EXISTS kitchen_picks (
  id                TEXT PRIMARY KEY,             -- pck_<weekKey>
  user_id           TEXT NOT NULL,
  week_key          TEXT NOT NULL,                -- YYYY-Www (ISO week)
  meal_ids_json     TEXT NOT NULL,                -- JSON [recipeId, ...]
  snack_ids_json    TEXT NOT NULL,
  infant_ids_json   TEXT NOT NULL,
  total_cost_usd    REAL NOT NULL DEFAULT 0,
  picked_at         INTEGER NOT NULL DEFAULT 0,
  pushed_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_kp_user ON kitchen_picks(user_id, week_key);

CREATE TABLE IF NOT EXISTS kitchen_pantry (
  id           TEXT PRIMARY KEY,                  -- pan_<hash16>
  user_id      TEXT NOT NULL,
  ingredient   TEXT NOT NULL,                     -- normalized lowercase
  display_name TEXT,                              -- as the user typed it
  qty          REAL,
  unit         TEXT,
  expiry       INTEGER,                            -- ms epoch (optional)
  added_at     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pan_user ON kitchen_pantry(user_id);
CREATE INDEX IF NOT EXISTS idx_pan_ing ON kitchen_pantry(user_id, ingredient);
