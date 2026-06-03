-- Boltbound launch achievements (RET-3, Clay 2026-06).
--
-- Additive seed for the shared achievement_def table (created by
-- achievements-migration.sql — run that first). The Boltbound gallery
-- shows every def whose trigger_type starts with 'boltbound' (see
-- cards-web.js routeAchievementsMe), so these all surface there.
--
-- Apply once with:
--   npx wrangler d1 execute aquilo_bot_db --file=./boltbound-achievements-migration.sql --remote
--
-- Idempotent: INSERT OR IGNORE keyed on id. Trigger types are fed
-- cumulative counts by boltbound-stats.js (statForTrigger/triggerEvents).
-- combo/crit have no web-layer signal yet, so they stay locked until the
-- match engine emits them (gallery shows them as "no progress").
--
-- Tier scale: bronze (entry) → silver → gold → platinum. Points 10/25/50/100.

INSERT OR IGNORE INTO achievement_def
  (id, name, description, icon, tier, points, trigger_type, trigger_threshold)
VALUES
  -- ── Wins ─────────────────────────────────────────────────────────
  ('bb.win.5',     'Finding Your Feet',  'Win 5 Boltbound matches.',              'bolt',  'bronze',   10, 'boltbound-win',    5),
  ('bb.win.10',    'Contender',          'Win 10 Boltbound matches.',             'bolt',  'bronze',   10, 'boltbound-win',   10),
  ('bb.win.50',    'Veteran',            'Win 50 Boltbound matches.',             'bolt',  'gold',     50, 'boltbound-win',   50),
  ('bb.win.250',   'Living Legend',      'Win 250 Boltbound matches.',            'crown', 'platinum',100, 'boltbound-win',  250),
  -- ── Matches played ───────────────────────────────────────────────
  ('bb.match.10',  'Warmed Up',          'Play 10 Boltbound matches.',            'cards', 'bronze',   10, 'boltbound-match',  10),
  ('bb.match.50',  'Committed',          'Play 50 Boltbound matches.',            'cards', 'silver',   25, 'boltbound-match',  50),
  ('bb.match.100', 'The Long Haul',      'Play 100 Boltbound matches.',           'cards', 'gold',     50, 'boltbound-match', 100),
  ('bb.match.500', 'No Life Like It',    'Play 500 Boltbound matches.',           'cards', 'platinum',100, 'boltbound-match', 500),
  -- ── Packs ────────────────────────────────────────────────────────
  ('bb.pack.10',   'Pack Opener',        'Open 10 packs.',                        'gift',  'bronze',   10, 'boltbound-pack',   10),
  ('bb.pack.50',   'Pack Habit',         'Open 50 packs.',                        'gift',  'silver',   25, 'boltbound-pack',   50),
  ('bb.pack.100',  'Pack Rat',           'Open 100 packs.',                       'gift',  'gold',     50, 'boltbound-pack',  100),
  ('bb.pack.500',  'Cardboard Baron',    'Open 500 packs.',                       'gift',  'platinum',100, 'boltbound-pack',  500),
  -- ── Cards played ─────────────────────────────────────────────────
  ('bb.cards.100', 'Hand Cramp',         'Play 100 cards.',                       'hand',  'bronze',   10, 'boltbound-cards', 100),
  ('bb.cards.1k',  'Tempo Engine',       'Play 1,000 cards.',                     'hand',  'silver',   25, 'boltbound-cards', 1000),
  ('bb.cards.5k',  'Deck Devourer',      'Play 5,000 cards.',                     'hand',  'gold',     50, 'boltbound-cards', 5000),
  -- ── Spells ───────────────────────────────────────────────────────
  ('bb.spell.50',  'Apprentice',         'Cast 50 spells.',                       'spark', 'bronze',   10, 'boltbound-spell',   50),
  ('bb.spell.500', 'Spellslinger',       'Cast 500 spells.',                      'spark', 'silver',   25, 'boltbound-spell',  500),
  ('bb.spell.2k',  'Archmage',           'Cast 2,000 spells.',                    'spark', 'gold',     50, 'boltbound-spell', 2000),
  -- ── Summons ──────────────────────────────────────────────────────
  ('bb.summon.50', 'Recruiter',          'Summon 50 minions.',                    'flag',  'bronze',   10, 'boltbound-summon',   50),
  ('bb.summon.500','Warlord',            'Summon 500 minions.',                   'flag',  'silver',   25, 'boltbound-summon',  500),
  ('bb.summon.2k', 'Endless Legion',     'Summon 2,000 minions.',                 'flag',  'gold',     50, 'boltbound-summon', 2000),
  -- ── Win streaks ──────────────────────────────────────────────────
  ('bb.streak.3',  'On a Roll',          'Win 3 matches in a row.',               'fire',  'bronze',   10, 'boltbound-streak',  3),
  ('bb.streak.5',  'Deathless',          'Win 5 matches in a row.',               'fire',  'silver',   25, 'boltbound-streak',  5),
  ('bb.streak.10', 'Untouchable',        'Win 10 matches in a row.',              'fire',  'gold',     50, 'boltbound-streak', 10),
  -- ── Class mastery (win 50 with each champion class) ──────────────
  ('bb.class.warrior', 'Warrior Mastery', 'Win 50 matches as a Warrior.',         'sword', 'gold',     50, 'boltbound-class-warrior', 50),
  ('bb.class.mage',    'Mage Mastery',    'Win 50 matches as a Mage.',            'wand',  'gold',     50, 'boltbound-class-mage',    50),
  ('bb.class.rogue',   'Rogue Mastery',   'Win 50 matches as a Rogue.',           'dagger','gold',     50, 'boltbound-class-rogue',   50),
  ('bb.class.ranger',  'Ranger Mastery',  'Win 50 matches as a Ranger.',          'bow',   'gold',     50, 'boltbound-class-ranger',  50),
  ('bb.class.healer',  'Healer Mastery',  'Win 50 matches as a Healer.',          'cross', 'gold',     50, 'boltbound-class-healer',  50),
  -- ── Engine-signalled (no web hook yet; surface as locked) ────────
  ('bb.combo.50',  'Combo Master',       'Trigger 50 combos.',                    'link',  'silver',   25, 'boltbound-combo',  50),
  ('bb.crit.20',   'Crit Storm',         'Deal 20+ damage in a single turn.',     'burst', 'gold',     50, 'boltbound-crit',   20);
