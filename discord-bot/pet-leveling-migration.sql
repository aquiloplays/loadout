-- Pet Leveling + Abilities + Evolutions (Clay 2026-05-30).
-- Adds a progression layer on top of the existing cosmetic pet system
-- (discord-bot/pet.js). Pet state itself still lives in KV
-- (pet:<guildId>:<userId>) — this migration only adds the STATIC
-- catalogue tables (ability defs + evolution chains). Per-pet level/xp
-- + unlocked abilities are stored as soft-extend fields on the KV
-- record, defaulted on read so existing pets backfill transparently.
--
-- Apply once with:
--   npx wrangler d1 execute aquilo_bot_db --file=./pet-leveling-migration.sql --remote
--
-- Idempotent — all tables are CREATE IF NOT EXISTS, indices use
-- IF NOT EXISTS, seed rows use INSERT OR IGNORE. Safe to re-run.

-- ── pet_ability_def ────────────────────────────────────────────────
-- Catalogue of every ability a pet can have. Owned by the worker.
-- min_level = the pet level at which this ability becomes available
-- to unlock. trigger_type drives where pet-leveling.js's hook fires
-- (passive = always-on, the rest are event-driven).
CREATE TABLE IF NOT EXISTS pet_ability_def (
  id                   TEXT PRIMARY KEY,           -- snake-case slug
  name                 TEXT NOT NULL,
  description          TEXT NOT NULL,
  icon                 TEXT NOT NULL,              -- emoji / sprite hint
  trigger_type         TEXT NOT NULL,              -- passive | active | on-feed | on-battle-start | on-low-hp
  trigger_payload_json TEXT NOT NULL DEFAULT '{}', -- JSON: { effect, magnitude, ... }
  min_level            INTEGER NOT NULL DEFAULT 1, -- unlock threshold
  species_pool         TEXT,                       -- comma-sep species filter or NULL = any
  active               INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_pet_ability_def_active
  ON pet_ability_def (active, min_level);

-- ── pet_evolution_chain ────────────────────────────────────────────
-- Directed graph of species → species evolutions. base_pet_id is the
-- species slug from pet.js SPECIES. evolves_to_pet_id may be a new
-- "evolved" species marker (e.g. 'dragonling_voltaic') that the render
-- pipeline knows how to draw. condition_json holds the gating logic
-- evaluated by tryEvolvePet (require_companion_active, location, etc).
CREATE TABLE IF NOT EXISTS pet_evolution_chain (
  id                TEXT PRIMARY KEY,              -- 'dragonling->voltaic_drake'
  base_pet_id       TEXT NOT NULL,                 -- species slug pre-evolution
  evolves_at_level  INTEGER NOT NULL,              -- minimum pet.level to qualify
  evolves_to_pet_id TEXT NOT NULL,                 -- species slug post-evolution
  condition_json    TEXT NOT NULL DEFAULT '{}',    -- JSON: { require_companion_active?, location?, min_happiness? }
  active            INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_pet_evolution_chain_base
  ON pet_evolution_chain (base_pet_id, active);

-- ── Seed: 15 starter abilities ─────────────────────────────────────
-- Spread across the 8 base species archetypes from pet.js. Min_level
-- ladder: 1 (innate), 3 (early), 5 (mid), 8 (late), 12 (capstone).
INSERT OR IGNORE INTO pet_ability_def
  (id, name, description, icon, trigger_type, trigger_payload_json, min_level, species_pool)
VALUES
  ('fire-breath',        'Fire Breath',        'Adds 1d6 fire damage to your hero''s first hit.',         'flame',    'on-battle-start', '{"damageBonus":6,"element":"fire"}',     5, 'dragonling'),
  ('healing-aura',       'Healing Aura',       'Heals your hero for 5 HP at the start of each battle.',   'sparkle',  'on-battle-start', '{"healAmount":5}',                       3, 'cat,bunny,frog'),
  ('scout-vision',       'Scout Vision',       'Reveals the next encounter type before you commit.',      'eye',      'passive',         '{"effect":"reveal-next"}',               5, 'owl,fox'),
  ('treasure-finder',    'Treasure Finder',    '+10% bolts dropped from dungeon clears.',                 'coin',     'passive',         '{"boltsMult":1.10}',                     3, 'fox,slime'),
  ('last-stand',         'Last Stand',         'When hero drops below 25% HP, restores 15 HP (once).',    'heart',    'on-low-hp',       '{"healAmount":15,"threshold":0.25}',     8, 'dog,dragonling'),
  ('warm-coat',          'Warm Coat',          'Cleanliness decays 50%% slower.',                         'leaf',     'passive',         '{"decayMult":{"cleanliness":0.5}}',      1, 'cat,bunny,fox,owl'),
  ('big-appetite',       'Big Appetite',       'Feeding grants +2 XP to the pet.',                        'fork',     'on-feed',         '{"xpBonus":2}',                          1, 'dog,slime,dragonling'),
  ('ribbit-burst',       'Ribbit Burst',       'Stuns the first enemy for 1 round.',                      'frog',     'on-battle-start', '{"effect":"stun","duration":1}',         5, 'frog'),
  ('starlight-blessing', 'Starlight Blessing', '+1 to all hero saving throws while pet is active.',       'star',     'passive',         '{"saveBonus":1}',                        8, 'bunny,owl'),
  ('vault-sniffer',      'Vault Sniffer',      'Daily check-in grants +5 bolts.',                         'paw',      'passive',         '{"checkinBonus":5}',                     1, NULL),
  ('shock-bite',         'Shock Bite',         '20%% chance to interrupt an enemy''s spell.',             'bolt',     'on-battle-start', '{"effect":"interrupt","chance":0.2}',    12, 'dragonling,fox'),
  ('soothing-purr',      'Soothing Purr',      'Hero immune to fear for the first 2 rounds.',            'cat',      'on-battle-start', '{"effect":"immune-fear","duration":2}',  5, 'cat'),
  ('sticky-grip',        'Sticky Grip',        'Prevents the next gear-drop from being lost on death.',   'shield',   'passive',         '{"effect":"gear-save"}',                 12, 'slime,frog'),
  ('hunter-instinct',    'Hunter Instinct',    'First attack each battle crits on a 19+.',               'crosshair','on-battle-start', '{"critRangeExtend":1}',                  8, 'dog,fox,owl'),
  ('aurora-veil',        'Aurora Veil',        'Once per day, ignores a killing blow (hero survives 1).', 'aurora',   'on-low-hp',       '{"effect":"death-save","dailyCharges":1}',12, 'dragonling,bunny,owl');

-- ── Seed: 8 starter evolutions ─────────────────────────────────────
-- Mirrors the brand colors from pet.js. evolves_to_pet_id values are
-- new species slugs the render side will need to gain art for, but
-- the data model is forward-compatible — unknown species fall back to
-- the base species sprite until art lands.
INSERT OR IGNORE INTO pet_evolution_chain
  (id, base_pet_id, evolves_at_level, evolves_to_pet_id, condition_json)
VALUES
  ('dragonling->voltaic_drake',  'dragonling', 10, 'voltaic_drake',   '{"min_happiness":50}'),
  ('cat->shadow_lynx',           'cat',         8, 'shadow_lynx',     '{}'),
  ('fox->aurora_kitsune',        'fox',        12, 'aurora_kitsune',  '{"require_companion_active":true}'),
  ('owl->celestial_owl',         'owl',        10, 'celestial_owl',   '{"min_happiness":60}'),
  ('slime->prismatic_slime',     'slime',       6, 'prismatic_slime', '{}'),
  ('frog->thunder_toad',         'frog',        8, 'thunder_toad',    '{"location":"spire"}'),
  ('bunny->moon_hare',           'bunny',      10, 'moon_hare',       '{"min_happiness":70}'),
  ('dog->stormhound',            'dog',        10, 'stormhound',      '{"require_companion_active":true}');
