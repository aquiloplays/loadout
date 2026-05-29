// Seasonal Spire — 12-theme rotation roster.
//
// Each month the 1st-of-month cron picks the next theme by index
// (SPIRE_THEMES[monthIndex]) and writes a fresh row into the
// spire_seasons D1 table. Theme order is FIXED — viewers see the
// same cadence regardless of when they joined.
//
// Each theme:
//   themeId             — stable id used in URLs + KV
//   name                — human-readable
//   description         — 1-line flavour for the season-preview embed
//   visualTreatment     — site renderer hints (palette + tower art)
//   bossMechanic        — { id, phase, params } — engine consumes
//                          when match.kind='spire-boss' AND
//                          season.themeId matches
//   curatedCardPool     — substring tags that filter the catalogue
//                          when generating an NPC deck (theme cohesion)
//   seasonalExclusiveCard — cardId from cards-content the boss-clear
//                          unlocks. Lives in cards-content under
//                          the rarity 'legendary'.
//   bossNpc             — { name, deckTemplate } for floor-10
//
// Rotation logic: SPIRE_THEMES is a 12-entry list. The cron picks by
// (currentMonth - epochMonth) % 12, where epochMonth is the launch
// reference month so the rotation is stable across years.

export const SPIRE_EPOCH = { year: 2026, month: 6 };   // June 2026 = index 0

export const SPIRE_THEMES = Object.freeze([
  {
    themeId:    'ember-court',
    name:       'Ember Court',
    description: 'A burning throne room where every breath singes the bones.',
    visualTreatment: { palette: ['#ff6a3d', '#9c1c1c', '#ffd45e'], tower: 'ember-tower.png' },
    bossMechanic: {
      id:     'ember.end-of-turn-burn',
      phase:  'end-of-turn',
      params: { damageToAllFriendly: 1, message: 'The Ember Court burns — 1 dmg to all your minions.' },
    },
    curatedCardPool: ['fire', 'ember', 'flame', 'pyre', 'cinder'],
    seasonalExclusiveCard: 'spire.s01.embercrown',
    bossNpc: { name: 'Pyrach, Ember Throne', deckTemplate: 'fire-heavy' },
  },
  {
    themeId:    'aurora-spire',
    name:       'Aurora Spire',
    description: 'A celestial tower where light bends and the air hums with stars.',
    visualTreatment: { palette: ['#7c3aed', '#22d3ee', '#a5f3fc'], tower: 'aurora-tower.png' },
    bossMechanic: {
      id:     'aurora.start-of-turn-mana-drain',
      phase:  'start-of-turn',
      params: { manaReduction: 1, floor: 2, message: 'Aurora drain — you have 1 less mana this turn (min 2).' },
    },
    curatedCardPool: ['storm', 'aurora', 'star', 'lumen', 'volt'],
    seasonalExclusiveCard: 'spire.s02.aurorablade',
    bossNpc: { name: 'Caela, Aurora Sovereign', deckTemplate: 'storm-tempo' },
  },
  {
    themeId:    'sunken-vault',
    name:       'Sunken Vault',
    description: 'A drowned treasury where every step rouses the deep things.',
    visualTreatment: { palette: ['#1e3a8a', '#0891b2', '#67e8f9'], tower: 'sunken-tower.png' },
    bossMechanic: {
      id:     'sunken.discard-on-draw',
      phase:  'on-draw',
      params: { discardEveryNth: 4, message: 'The Vault hungers — every 4th draw is discarded.' },
    },
    curatedCardPool: ['tide', 'depth', 'kraken', 'coral', 'siren', 'drown'],
    seasonalExclusiveCard: 'spire.s03.tidescepter',
    bossNpc: { name: 'Maraka the Deep-Hand', deckTemplate: 'tempo-control' },
  },
  {
    themeId:    'verdant-hollow',
    name:       'Verdant Hollow',
    description: 'Roots have eaten the spire — the trees keep score now.',
    visualTreatment: { palette: ['#166534', '#84cc16', '#bef264'], tower: 'verdant-tower.png' },
    bossMechanic: {
      id:     'verdant.summon-thorn',
      phase:  'end-of-turn',
      params: { spawnMinion: { cardId: 'spire.token.thorn', atk: 1, hp: 2 }, message: 'A thorn vine sprouts on the boss board.' },
    },
    curatedCardPool: ['root', 'grove', 'briar', 'verdant', 'thorn', 'leaf'],
    seasonalExclusiveCard: 'spire.s04.hollowheart',
    bossNpc: { name: 'Sylphren, Hollow Crown', deckTemplate: 'swarm' },
  },
  {
    themeId:    'sandstorm-bazaar',
    name:       'Sandstorm Bazaar',
    description: 'A merchant city buried in a thousand years of dunes — the wares now haggle back.',
    visualTreatment: { palette: ['#b45309', '#fbbf24', '#fde68a'], tower: 'sandstorm-tower.png' },
    bossMechanic: {
      id:     'sandstorm.swap-attack',
      phase:  'start-of-turn',
      params: { swapAtkHpEveryNth: 3, message: 'Sandstorm — every 3rd turn, swap atk/hp on all minions.' },
    },
    curatedCardPool: ['sand', 'dune', 'desert', 'bazaar', 'sphinx', 'oasis'],
    seasonalExclusiveCard: 'spire.s05.duneturban',
    bossNpc: { name: 'Iqbah, Bazaar Lich', deckTemplate: 'control' },
  },
  {
    themeId:    'frost-citadel',
    name:       'Frost Citadel',
    description: 'A frozen keep where time itself has gone glacial.',
    visualTreatment: { palette: ['#1e40af', '#7dd3fc', '#dbeafe'], tower: 'frost-tower.png' },
    bossMechanic: {
      id:     'frost.freeze-random',
      phase:  'start-of-turn',
      params: { freezeRandomFriendly: 1, message: 'Frost grips one of your minions — frozen this turn.' },
    },
    curatedCardPool: ['frost', 'ice', 'glacier', 'snow', 'rime', 'winter', 'sleet'],
    seasonalExclusiveCard: 'spire.s06.permafrost',
    bossNpc: { name: 'Vrith of the Long Winter', deckTemplate: 'control' },
  },
  {
    themeId:    'clockwork-foundry',
    name:       'Clockwork Foundry',
    description: 'A factory of gears that grinds champions into spare parts.',
    visualTreatment: { palette: ['#78350f', '#a16207', '#fef3c7'], tower: 'foundry-tower.png' },
    bossMechanic: {
      id:     'foundry.double-effects',
      phase:  'on-play',
      params: { doubleBattlecryEveryNth: 3, message: 'The gears grind — every 3rd boss minion fires twice.' },
    },
    curatedCardPool: ['gear', 'cog', 'forge', 'automaton', 'piston', 'clockwork', 'mech'],
    seasonalExclusiveCard: 'spire.s07.cogheart',
    bossNpc: { name: 'Aurel, Foundry Maestro', deckTemplate: 'tempo-buff' },
  },
  {
    themeId:    'mirror-garden',
    name:       'Mirror Garden',
    description: 'Every reflection is a different you — and they all want the throne.',
    visualTreatment: { palette: ['#831843', '#f472b6', '#fce7f3'], tower: 'mirror-tower.png' },
    bossMechanic: {
      id:     'mirror.copy-minion',
      phase:  'end-of-turn',
      params: { copyRandomFriendlyToBoss: 1, message: 'The Garden mirrors one of your minions to the boss board.' },
    },
    curatedCardPool: ['mirror', 'echo', 'twin', 'reflect', 'shimmer', 'glass'],
    seasonalExclusiveCard: 'spire.s08.silvermask',
    bossMech: 'mirror-copy',
    bossNpc: { name: 'Nyx-Aeve, Mirror Queen', deckTemplate: 'reactive' },
  },
  {
    themeId:    'bone-reliquary',
    name:       'Bone Reliquary',
    description: 'A cathedral of relic-bones that animates when you trespass.',
    visualTreatment: { palette: ['#44403c', '#a8a29e', '#e7e5e4'], tower: 'reliquary-tower.png' },
    bossMechanic: {
      id:     'bone.deathrattle-chain',
      phase:  'on-deathrattle',
      params: { triggerExtraDeathrattle: true, message: 'Each dying minion re-triggers a friendly Deathrattle on the boss side.' },
    },
    curatedCardPool: ['bone', 'skull', 'undead', 'reliquary', 'crypt', 'tomb'],
    seasonalExclusiveCard: 'spire.s09.relicspine',
    bossNpc: { name: 'Ossian, First Saint', deckTemplate: 'deathrattle' },
  },
  {
    themeId:    'cinder-apex',
    name:       'Cinder Apex',
    description: 'A volcanic peak where the air itself is on fire.',
    visualTreatment: { palette: ['#dc2626', '#f59e0b', '#fed7aa'], tower: 'apex-tower.png' },
    bossMechanic: {
      id:     'apex.fatigue-double',
      phase:  'on-draw',
      params: { fatigueMultiplier: 2, message: 'The Apex burns your library — fatigue damage is doubled.' },
    },
    curatedCardPool: ['lava', 'magma', 'volcanic', 'cinder', 'apex', 'meteor'],
    seasonalExclusiveCard: 'spire.s10.apexorb',
    bossNpc: { name: 'Hexen, Apex Tyrant', deckTemplate: 'aggro' },
  },
  {
    themeId:    'stargazer-court',
    name:       'Stargazer Court',
    description: 'A celestial observatory where the stars vote on your fate.',
    visualTreatment: { palette: ['#1e1b4b', '#6366f1', '#c7d2fe'], tower: 'stargazer-tower.png' },
    bossMechanic: {
      id:     'stargazer.predict-redraw',
      phase:  'on-draw',
      params: { revealOpponentTopcard: true, swapIfMatch: true, message: 'The Stargazer sees your draws — if it matches the boss, the boss redraws.' },
    },
    curatedCardPool: ['star', 'cosmos', 'astral', 'nebula', 'stellar', 'celestial'],
    seasonalExclusiveCard: 'spire.s11.starcharter',
    bossNpc: { name: 'Therion, Stargazer Magus', deckTemplate: 'value-engine' },
  },
  {
    themeId:    'velvet-catacomb',
    name:       'Velvet Catacomb',
    description: 'A blood-red catacomb where vampires keep their old grudges fresh.',
    visualTreatment: { palette: ['#7f1d1d', '#be123c', '#fecaca'], tower: 'catacomb-tower.png' },
    bossMechanic: {
      id:     'velvet.lifesteal-boss',
      phase:  'persistent',
      params: { bossLifesteal: true, message: 'The Velvet Catacomb — all boss minion damage heals the boss.' },
    },
    curatedCardPool: ['velvet', 'crimson', 'vampire', 'catacomb', 'blood', 'fang'],
    seasonalExclusiveCard: 'spire.s12.crimsongoblet',
    bossNpc: { name: 'Alyx, Crimson Marquise', deckTemplate: 'lifesteal-control' },
  },
]);

// Resolve the active theme for a given UTC year+month. Stable across
// years — index 0 is the SPIRE_EPOCH month, then rotates forward.
export function themeForMonth(year, month1to12) {
  const epochMonths = SPIRE_EPOCH.year * 12 + (SPIRE_EPOCH.month - 1);
  const targetMonths = year * 12 + (month1to12 - 1);
  const offset = Math.max(0, targetMonths - epochMonths);
  return SPIRE_THEMES[offset % SPIRE_THEMES.length];
}

// UTC month bounds — ISO 8601 timestamps the cron writes into
// spire_seasons.starts_at / ends_at. End is the last second of the
// month so the leaderboard "season ending in" countdown is precise.
export function monthBoundsUtc(year, month1to12) {
  const start = new Date(Date.UTC(year, month1to12 - 1, 1, 0, 0, 0));
  const next  = new Date(Date.UTC(year, month1to12, 1, 0, 0, 0));
  const end   = new Date(next.getTime() - 1000);  // last second of the month
  return { startsAt: start.toISOString(), endsAt: end.toISOString() };
}
