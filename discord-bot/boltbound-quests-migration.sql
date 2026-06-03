-- Boltbound daily-quest catalogue (RET-2, Clay 2026-06).
--
-- Additive seed for the shared daily_quest_def table (created by
-- aquilo/migration-add-daily-quests.sql — run that first). These are
-- the ~30 Boltbound quest templates the hub rotates 3-per-day from
-- (one Easy / one Medium / one Hard, see daily-quests.js getRotation).
--
-- Apply once with:
--   npx wrangler d1 execute aquilo_bot_db --file=./boltbound-quests-migration.sql --remote
--
-- Idempotent: INSERT OR IGNORE keyed on the def id. Re-running won't
-- clobber tuning edits or disturb historic user_daily_quest rows.
--
-- ID convention drives event progress (daily-quests.js progressBoltbound):
--   boltbound.play.N    → finishing a match          (event 'play')
--   boltbound.win.N     → winning a match            (event 'win')
--   boltbound.cards.N   → playing N cards            (event 'cards')
--   boltbound.summon.N  → playing N minions          (event 'summon')
--   boltbound.cast.N    → casting N spells           (event 'cast')
--
-- Tier is derived from reward bolts in the rotation picker:
--   <= 50 Easy · 51-150 Medium · > 150 Hard.
-- Easy = 50 Bolts. Medium = 100 Bolts + 5 Aether. Hard = 200 Bolts + 10 Aether.

INSERT OR IGNORE INTO daily_quest_def
  (id, game, type, threshold, reward_json, weight, active, title, description)
VALUES
  -- ── Easy (50 Bolts) ──────────────────────────────────────────────
  ('boltbound.play.1',    'boltbound', 'count', 1,  '{"bolts":50}',            5, 1, 'Warm up',              'Play 1 Boltbound match.'),
  ('boltbound.win.1',     'boltbound', 'count', 1,  '{"bolts":50}',            5, 1, 'First blood',          'Win 1 Boltbound match.'),
  ('boltbound.cards.10',  'boltbound', 'count', 10, '{"bolts":50}',            4, 1, 'Get the reps in',      'Play 10 cards.'),
  ('boltbound.summon.5',  'boltbound', 'count', 5,  '{"bolts":50}',            4, 1, 'Muster the ranks',     'Summon 5 minions.'),
  ('boltbound.cast.5',    'boltbound', 'count', 5,  '{"bolts":50}',            4, 1, 'Spark of arcana',      'Cast 5 spells.'),
  ('boltbound.play.2',    'boltbound', 'count', 2,  '{"bolts":50}',            3, 1, 'Back for more',        'Play 2 Boltbound matches.'),
  ('boltbound.cards.12',  'boltbound', 'count', 12, '{"bolts":50}',            3, 1, 'Hand over fist',       'Play 12 cards.'),
  ('boltbound.summon.6',  'boltbound', 'count', 6,  '{"bolts":50}',            3, 1, 'Field a team',         'Summon 6 minions.'),
  ('boltbound.cast.6',    'boltbound', 'count', 6,  '{"bolts":50}',            3, 1, 'Hex appeal',           'Cast 6 spells.'),
  ('boltbound.win.1b',    'boltbound', 'count', 1,  '{"bolts":50}',            3, 1, 'Take the W',           'Win a match. Any match. We are not picky.'),
  -- ── Medium (100 Bolts + 5 Aether) ────────────────────────────────
  ('boltbound.play.3',    'boltbound', 'count', 3,  '{"bolts":100,"aether":5}', 4, 1, 'Boltbound regular',    'Play 3 Boltbound matches.'),
  ('boltbound.win.2',     'boltbound', 'count', 2,  '{"bolts":100,"aether":5}', 4, 1, 'Double up',            'Win 2 Boltbound matches.'),
  ('boltbound.cards.20',  'boltbound', 'count', 20, '{"bolts":100,"aether":5}', 3, 1, 'Deck the halls',       'Play 20 cards.'),
  ('boltbound.summon.10', 'boltbound', 'count', 10, '{"bolts":100,"aether":5}', 3, 1, 'Swarm tactics',        'Summon 10 minions.'),
  ('boltbound.cast.10',   'boltbound', 'count', 10, '{"bolts":100,"aether":5}', 3, 1, 'Spellslinger',         'Cast 10 spells.'),
  ('boltbound.play.4',    'boltbound', 'count', 4,  '{"bolts":100,"aether":5}', 2, 1, 'Grinder',              'Play 4 Boltbound matches.'),
  ('boltbound.cards.24',  'boltbound', 'count', 24, '{"bolts":100,"aether":5}', 2, 1, 'Tempo merchant',       'Play 24 cards.'),
  ('boltbound.summon.12', 'boltbound', 'count', 12, '{"bolts":100,"aether":5}', 2, 1, 'Standing army',        'Summon 12 minions.'),
  ('boltbound.cast.12',   'boltbound', 'count', 12, '{"bolts":100,"aether":5}', 2, 1, 'Arcane overload',      'Cast 12 spells.'),
  ('boltbound.win.2b',    'boltbound', 'count', 2,  '{"bolts":100,"aether":5}', 3, 1, 'Two for the road',     'Win 2 matches today.'),
  -- ── Hard (200 Bolts + 10 Aether) ─────────────────────────────────
  ('boltbound.win.3',     'boltbound', 'count', 3,  '{"bolts":200,"aether":10}', 3, 1, 'Triple threat',        'Win 3 Boltbound matches.'),
  ('boltbound.win.5',     'boltbound', 'count', 5,  '{"bolts":200,"aether":10}', 2, 1, 'Warpath',              'Win 5 Boltbound matches.'),
  ('boltbound.cast.20',   'boltbound', 'count', 20, '{"bolts":200,"aether":10}', 2, 1, 'Mana burn',            'Cast 20 spells.'),
  ('boltbound.summon.15', 'boltbound', 'count', 15, '{"bolts":200,"aether":10}', 2, 1, 'Endless legion',       'Summon 15 minions.'),
  ('boltbound.cards.30',  'boltbound', 'count', 30, '{"bolts":200,"aether":10}', 2, 1, 'No cards left',        'Play 30 cards.'),
  ('boltbound.play.6',    'boltbound', 'count', 6,  '{"bolts":200,"aether":10}', 2, 1, 'Marathon',             'Play 6 Boltbound matches. Touch grass after.'),
  ('boltbound.win.4',     'boltbound', 'count', 4,  '{"bolts":200,"aether":10}', 2, 1, 'On a tear',            'Win 4 Boltbound matches.'),
  ('boltbound.cast.16',   'boltbound', 'count', 16, '{"bolts":200,"aether":10}', 2, 1, 'Spell economy',        'Cast 16 spells.'),
  ('boltbound.summon.14', 'boltbound', 'count', 14, '{"bolts":200,"aether":10}', 2, 1, 'Conscription',         'Summon 14 minions.'),
  ('boltbound.cards.28',  'boltbound', 'count', 28, '{"bolts":200,"aether":10}', 2, 1, 'Card avalanche',       'Play 28 cards.');
