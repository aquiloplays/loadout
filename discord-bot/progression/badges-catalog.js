// Progression — badge catalogue.
//
// PROGRESSION-SYSTEM-DESIGN.md §7. Each badge is a 64×64 PNG at
// aquilo-gg/sprites/progression/badges/<id>.png. Badges are awarded
// by achievement unlocks (badgeId field on achievements-catalog),
// season tiers (P6), tournament placements (P7), and admin grants
// (P5 special-events surface).
//
// Schema (engine + UI read these fields):
//   id            unique slug (filename + KV key)
//   name          display name
//   description   one-line explainer (profile tooltip)
//   rarity        common | rare | epic | legendary
//   category      'achievement' | 'season-s1' | 'tournament'
//                 | 'milestone' | 'special'
//   spritePath    relative path for the renderer
//   source        '<achId>' | 'season:<id>:tier<N>' | 'tournament:<id>:1st' | ...
//   shape         hint for the procedural sprite generator
//                 ('star' | 'shield' | 'flame' | 'medal' | 'crown' |
//                  'paw' | 'cards' | 'sword' | 'castle' | 'orb' |
//                  'fang' | 'wing' | 'trophy' | 'lightning')
//   accent        brand colour for the centre glyph
//                 ('violet' | 'gold' | 'crimson' | 'teal' | 'emerald' |
//                  'sapphire' | 'silver' | 'iron' | 'bronze')

export const BADGE_CATALOG = [
  // ── Identity ──────────────────────────────────────────────────────
  { id: 'verified-trio',     name: 'Verified Trio',     rarity: 'rare',
    category: 'achievement', source: 'id.verified-trio',
    description: 'Linked Discord + Twitch + Steam.',
    shape: 'medal', accent: 'sapphire' },
  { id: 'streak-7',          name: '7-Day Streak',      rarity: 'common',
    category: 'achievement', source: 'id.streak-7',
    description: 'A week of daily check-ins.',
    shape: 'flame', accent: 'gold' },
  { id: 'streak-30',         name: '30-Day Streak',     rarity: 'rare',
    category: 'achievement', source: 'id.streak-30',
    description: 'A month of daily check-ins.',
    shape: 'flame', accent: 'crimson' },
  { id: 'streak-100',        name: '100-Day Streak',    rarity: 'legendary',
    category: 'achievement', source: 'id.streak-100',
    description: '100 days unbroken.',
    shape: 'flame', accent: 'violet' },

  // ── Clash ─────────────────────────────────────────────────────────
  { id: 'three-star-raider', name: 'Three-Star Raider', rarity: 'rare',
    category: 'achievement', source: 'clash.first-three-star',
    description: 'First 3-star raid.',
    shape: 'star', accent: 'gold' },
  { id: 'hundred-raider',    name: 'Hundred Raider',    rarity: 'rare',
    category: 'achievement', source: 'clash.raid-100',
    description: '100 raids run.',
    shape: 'shield', accent: 'iron' },
  { id: 'thousand-raider',   name: 'Thousand Raider',   rarity: 'legendary',
    category: 'achievement', source: 'clash.raid-1000',
    description: '1,000 raids run.',
    shape: 'shield', accent: 'violet' },
  { id: 'star-authority',    name: 'Star Authority',    rarity: 'epic',
    category: 'achievement', source: 'clash.three-star-100',
    description: '100 three-star raids.',
    shape: 'star', accent: 'crimson' },
  { id: 'goblin-bane',       name: 'Goblin Bane',       rarity: 'epic',
    category: 'achievement', source: 'clash.goblin-slayer-100',
    description: '100 goblin raids repelled.',
    shape: 'fang', accent: 'emerald' },
  { id: 'king-slayer',       name: 'King Slayer',       rarity: 'epic',
    category: 'achievement', source: 'clash.king-slayer',
    description: 'Goblin King slain.',
    shape: 'crown', accent: 'gold' },
  { id: 'wyrm-slayer',       name: 'Wyrm Slayer',       rarity: 'legendary',
    category: 'achievement', source: 'clash.wyrm-slayer',
    description: 'Wyrm slain.',
    shape: 'wing', accent: 'crimson' },
  { id: 'town-founder',      name: 'Town Founder',      rarity: 'legendary',
    category: 'achievement', source: 'clash.donate-500k',
    description: '500,000 bolts donated.',
    shape: 'castle', accent: 'gold' },
  { id: 'master-architect',  name: 'Master Architect',  rarity: 'rare',
    category: 'achievement', source: 'clash.master-architect',
    description: 'Town Hall L5.',
    shape: 'castle', accent: 'iron' },
  { id: 'high-architect',    name: 'High Architect',    rarity: 'legendary',
    category: 'achievement', source: 'clash.high-architect',
    description: 'Town Hall L10.',
    shape: 'castle', accent: 'violet' },
  { id: 'war-hero',          name: 'War Hero',          rarity: 'epic',
    category: 'achievement', source: 'clash.war-hero',
    description: '5 community wars won.',
    shape: 'medal', accent: 'crimson' },

  // ── Boltbound ─────────────────────────────────────────────────────
  { id: 'full-set',          name: 'Set Completion',    rarity: 'legendary',
    category: 'achievement', source: 'cards.full-set',
    description: 'Full 1,170-card set.',
    shape: 'cards', accent: 'violet' },
  { id: 'legend-magnet',     name: 'Legend Magnet',     rarity: 'epic',
    category: 'achievement', source: 'cards.legendary-10',
    description: '10 legendary pulls.',
    shape: 'star', accent: 'violet' },
  { id: 'master-crafter',    name: 'Master Crafter',    rarity: 'rare',
    category: 'achievement', source: 'cards.craft-50',
    description: '50 packs crafted.',
    shape: 'orb', accent: 'teal' },
  { id: 'pvp-champion',      name: 'PvP Champion',      rarity: 'rare',
    category: 'achievement', source: 'cards.pvp-50',
    description: '50 PvP wins.',
    shape: 'sword', accent: 'sapphire' },
  { id: 'pvp-master',        name: 'PvP Master',        rarity: 'epic',
    category: 'achievement', source: 'cards.pvp-250',
    description: '250 PvP wins.',
    shape: 'sword', accent: 'crimson' },
  { id: 'archetype-master',  name: 'Archetype Master',  rarity: 'legendary',
    category: 'achievement', source: 'cards.archetype-master',
    description: 'Every Boltbound archetype mastered.',
    shape: 'cards', accent: 'gold' },

  // ── Board games ───────────────────────────────────────────────────
  { id: 'chess-grandmaster', name: 'Chess Grandmaster', rarity: 'epic',
    category: 'achievement', source: 'board.chess-100',
    description: '100 chess wins.',
    shape: 'crown', accent: 'silver' },
  { id: 'checkers-master',   name: 'Checkers Master',   rarity: 'epic',
    category: 'achievement', source: 'board.checkers-100',
    description: '100 checkers wins.',
    shape: 'medal', accent: 'gold' },
  { id: 'connect-master',    name: 'Connect Master',    rarity: 'epic',
    category: 'achievement', source: 'board.connect4-100',
    description: '100 connect-4 wins.',
    shape: 'medal', accent: 'crimson' },
  { id: 'triple-threat',     name: 'Triple Threat',     rarity: 'rare',
    category: 'achievement', source: 'board.triple-threat',
    description: 'Won in all three board games.',
    shape: 'medal', accent: 'sapphire' },
  { id: 'board-veteran',     name: 'Board Veteran',     rarity: 'legendary',
    category: 'achievement', source: 'board.won-500',
    description: '500 board game wins.',
    shape: 'trophy', accent: 'gold' },

  // ── Quick games ───────────────────────────────────────────────────
  { id: 'quick-veteran',     name: 'Quick-game Veteran', rarity: 'epic',
    category: 'achievement', source: 'quick.played-1000',
    description: '1,000 quick games played.',
    shape: 'medal', accent: 'teal' },
  { id: 'game-show-host',    name: 'Game-Show Host',    rarity: 'rare',
    category: 'achievement', source: 'quick.allgames',
    description: 'Every quick game played.',
    shape: 'medal', accent: 'violet' },

  // ── Stocks + Bets ────────────────────────────────────────────────
  { id: 'day-trader',        name: 'Day Trader',        rarity: 'rare',
    category: 'achievement', source: 'stocks.trade-100',
    description: '100 trades.',
    shape: 'lightning', accent: 'teal' },
  { id: 'parlay-champion',   name: 'Parlay Champion',   rarity: 'epic',
    category: 'achievement', source: 'bet.parlay-win',
    description: '5-leg parlay won.',
    shape: 'trophy', accent: 'gold' },
  { id: 'hot-hand',          name: 'Hot Hand',          rarity: 'epic',
    category: 'achievement', source: 'bet.streak-5',
    description: '5 winning bets in a row.',
    shape: 'flame', accent: 'crimson' },

  // ── Stream + community ───────────────────────────────────────────
  { id: 'loyal-viewer',      name: 'Loyal Viewer',      rarity: 'rare',
    category: 'achievement', source: 'stream.checkin-50',
    description: '50 stream check-ins.',
    shape: 'medal', accent: 'violet' },
  { id: 'community-pillar',  name: 'Pillar of the Community', rarity: 'legendary',
    category: 'achievement', source: 'stream.checkin-200',
    description: '200 stream check-ins.',
    shape: 'medal', accent: 'gold' },
  { id: 'cheerleader',       name: 'Cheerleader',       rarity: 'rare',
    category: 'achievement', source: 'stream.cheer-100',
    description: '100 cheers.',
    shape: 'star', accent: 'crimson' },
  { id: 'conversationalist', name: 'Conversationalist', rarity: 'rare',
    category: 'achievement', source: 'discord.chatty-10000',
    description: '10,000 Discord messages.',
    shape: 'medal', accent: 'teal' },
  { id: 'subscriber',        name: 'Subscriber',        rarity: 'rare',
    category: 'achievement', source: 'stream.subscriber',
    description: 'Active Twitch subscriber.',
    shape: 'star', accent: 'violet' },
  { id: 'patron',            name: 'Patron',            rarity: 'rare',
    category: 'achievement', source: 'stream.patron',
    description: 'Active Patreon supporter.',
    shape: 'star', accent: 'gold' },

  // ── Pets ──────────────────────────────────────────────────────────
  { id: 'menagerie',         name: 'Menagerie',         rarity: 'rare',
    category: 'achievement', source: 'pet.menagerie-8',
    description: '8 pet species tamed.',
    shape: 'paw', accent: 'emerald' },
  { id: 'legendary-pet',     name: 'Legendary Pet',     rarity: 'epic',
    category: 'achievement', source: 'pet.legendary',
    description: 'A legendary tamed.',
    shape: 'paw', accent: 'gold' },
  { id: 'lifelong-bond',     name: 'Lifelong Bond',     rarity: 'epic',
    category: 'achievement', source: 'pet.fed-365',
    description: '365 feedings.',
    shape: 'paw', accent: 'crimson' },

  // ── Cross-cutting + meta ─────────────────────────────────────────
  { id: 'polyglot',          name: 'Polyglot',          rarity: 'rare',
    category: 'achievement', source: 'meta.polyglot',
    description: 'Every game type played.',
    shape: 'trophy', accent: 'teal' },
  { id: 'renaissance',       name: 'Renaissance Player', rarity: 'epic',
    category: 'achievement', source: 'meta.renaissance',
    description: 'Won at least once in every game type.',
    shape: 'trophy', accent: 'violet' },
  { id: 'level-25',          name: 'Top of the Class',  rarity: 'rare',
    category: 'achievement', source: 'meta.level-25',
    description: 'Account L25.',
    shape: 'star', accent: 'sapphire' },
  { id: 'level-50',          name: 'Veteran',           rarity: 'epic',
    category: 'achievement', source: 'meta.level-50',
    description: 'Account L50.',
    shape: 'star', accent: 'violet' },
  { id: 'level-100',         name: 'Living Legend',     rarity: 'legendary',
    category: 'achievement', source: 'meta.level-100',
    description: 'Account L100.',
    shape: 'star', accent: 'gold' },
  { id: 'achievement-hunter', name: 'Achievement Hunter', rarity: 'rare',
    category: 'achievement', source: 'meta.hunter-50',
    description: '50 achievements unlocked.',
    shape: 'trophy', accent: 'bronze' },
  { id: 'trophy-cabinet',    name: 'Trophy Cabinet',    rarity: 'legendary',
    category: 'achievement', source: 'meta.hunter-100',
    description: '100 achievements unlocked.',
    shape: 'trophy', accent: 'gold' },
];

// Decorate every entry with its sprite path. Sticking to the same
// naming convention the worker emits (clash-v2/* style):
//   progression/badges/<id>.png
for (const b of BADGE_CATALOG) {
  b.spritePath = `progression/badges/${b.id}.png`;
}

export const BADGES_BY_ID = Object.fromEntries(BADGE_CATALOG.map(b => [b.id, b]));
