// Boltbound — programmatic card catalogue generator.
//
// Generates ~900 cards from a (family × mana × rarity × variant) grid.
// Hand-curated champions, legendaries, and signature rares stay in
// cards-content.js; this module is the bulk-generator that grows the
// catalogue to 1,000+ without per-card authoring.
//
// See CARD-GAME-DESIGN.md §13 for the design rationale + stat curve.
// Determinism: same code in => same card ids and stats out, so the
// catalogue is byte-stable across deploys.
//
// Exports:
//   FAMILIES                — family configuration table
//   ARCHETYPE_BIAS          — per-archetype atk/hp split
//   generateCatalogue()     — returns flat [card, ...] array
//   generateSpriteManifest()— [{id, family, archetype, ...}] for the
//                              sprite generator to consume

// ── Constants / curve ────────────────────────────────────────────────

// Vanilla baseline: stat sum at mana M = M*2 + 1.
//   1m → 3 (e.g. 2/1, 1/2)
//   2m → 5
//   3m → 7
//   ...
//   10m → 21
export function vanillaTotal(mana) {
  return mana * 2 + 1;
}

// Per-rarity stat multiplier — see §13.4. Keywords/abilities cost
// stats, not the other way around.
export const RARITY_STAT_MULT = {
  common:    1.00,
  uncommon:  0.85,
  rare:      0.80,
  legendary: 1.00,
};

// Per-archetype atk/hp split (sums to 1.0). Drives stat shape.
export const ARCHETYPE_BIAS = {
  'aggro-swarm':     { atkBias: 0.60, hpBias: 0.40 },
  'balanced':        { atkBias: 0.50, hpBias: 0.50 },
  'taunt-tank':      { atkBias: 0.35, hpBias: 0.65 },
  'caster':          { atkBias: 0.55, hpBias: 0.45 },
  'stealth-utility': { atkBias: 0.60, hpBias: 0.40 },
  'undead':          { atkBias: 0.45, hpBias: 0.55 },
  'holy':            { atkBias: 0.40, hpBias: 0.60 },
  'elemental':       { atkBias: 0.50, hpBias: 0.50 },
  'dragon':          { atkBias: 0.55, hpBias: 0.55 }, // +10% intentional flagship swing
  'wild-beast':      { atkBias: 0.55, hpBias: 0.45 },
  'demon':           { atkBias: 0.60, hpBias: 0.45 }, // overstatted, downside in ability
};

function statsFor(mana, archetypeKey, rarity, variantOffset = 0) {
  const arch = ARCHETYPE_BIAS[archetypeKey] || ARCHETYPE_BIAS.balanced;
  const mult = RARITY_STAT_MULT[rarity] ?? 1;
  const total = Math.round(vanillaTotal(mana) * mult);
  let atk = Math.max(0, Math.round(total * arch.atkBias));
  let hp  = Math.max(1, total - atk);
  // Variant offset shuffles ±1 inside the curve, sum-preserving.
  if (variantOffset !== 0) {
    if (variantOffset > 0 && hp > 1) { atk += 1; hp -= 1; }
    else if (variantOffset < 0 && atk > 0) { atk -= 1; hp += 1; }
  }
  return { atk, hp };
}

// ── Family configuration table ───────────────────────────────────────

// Each family declares its archetype, sprite-template hints, signature
// keyword, allowed secondary keyword pool, and mana range. The
// generator emits cards across that range at each rarity tier.

export const FAMILIES = [
  // ── Aggro / swarm ─────────────────────────────────────────────────
  {
    key: 'gob',
    name: 'Goblin',
    archetype: 'aggro-swarm',
    palette: 'leather',
    skin: 'green',
    template: 'humanoid-small',
    weapon: 'club',
    sig: 'charge',
    keywords: ['charge'],
    keywordPool: ['charge', 'poison'],
    minMana: 1, maxMana: 5,
    nameSuffixes: ['Runt', 'Brute', 'Scout', 'Whelp', 'Tinkerer', 'Burner', 'Wretch', 'Howler', 'Shanker', 'Bomber'],
  },
  {
    key: 'verm',
    name: 'Vermin',
    archetype: 'aggro-swarm',
    palette: 'leather',
    skin: 'grey',
    template: 'beast-small',
    weapon: null,
    sig: 'charge',
    keywords: [],
    keywordPool: ['charge', 'poison', 'lifesteal'],
    minMana: 1, maxMana: 3,
    nameSuffixes: ['Rat', 'Spider', 'Snake', 'Roach', 'Worm', 'Bat', 'Centipede', 'Scarab'],
  },
  {
    key: 'pir',
    name: 'Pirate',
    archetype: 'aggro-swarm',
    palette: 'leather',
    skin: 'tan',
    template: 'humanoid',
    weapon: 'cutlass',
    sig: 'charge',
    keywords: [],
    keywordPool: ['charge', 'stealth'],
    minMana: 2, maxMana: 7,
    nameSuffixes: ['Deckhand', 'Cutthroat', 'Boatswain', 'Quartermaster', 'Gunner', 'Captain', 'Cabin Boy', 'Marauder', 'Sea Dog', 'Privateer'],
  },
  {
    key: 'ban',
    name: 'Bandit',
    archetype: 'aggro-swarm',
    palette: 'leather',
    skin: 'tan',
    template: 'humanoid',
    weapon: 'dagger',
    sig: null,
    keywords: [],
    keywordPool: ['stealth', 'charge'],
    minMana: 1, maxMana: 5,
    nameSuffixes: ['Footpad', 'Cutpurse', 'Highwayman', 'Outlaw', 'Brigand', 'Marauder', 'Reaver'],
  },

  // ── Tank / taunt ──────────────────────────────────────────────────
  {
    key: 'knt',
    name: 'Knight',
    archetype: 'taunt-tank',
    palette: 'steel',
    skin: 'fair',
    template: 'humanoid-armor',
    weapon: 'sword',
    sig: 'taunt',
    keywords: ['taunt'],
    keywordPool: ['taunt', 'shield'],
    minMana: 2, maxMana: 8,
    nameSuffixes: ['Squire', 'Knight', 'Captain', 'Marshal', 'Champion', 'Defender', 'Vanguard', 'Sentinel', 'Banner-Knight', 'Lord-Knight'],
  },
  {
    key: 'pal',
    name: 'Paladin',
    archetype: 'holy',
    palette: 'gold',
    skin: 'fair',
    template: 'humanoid-armor',
    weapon: 'hammer',
    sig: 'shield',
    keywords: ['shield'],
    keywordPool: ['shield', 'taunt', 'lifesteal'],
    minMana: 3, maxMana: 8,
    nameSuffixes: ['Initiate', 'Acolyte', 'Templar', 'Crusader', 'Champion', 'Lightbringer', 'Justiciar'],
  },
  {
    key: 'vlt',
    name: 'Vault Guard',
    archetype: 'taunt-tank',
    palette: 'steel',
    skin: 'fair',
    template: 'humanoid-armor',
    weapon: 'halberd',
    sig: 'taunt',
    keywords: ['taunt'],
    keywordPool: ['taunt', 'shield'],
    minMana: 3, maxMana: 7,
    nameSuffixes: ['Watcher', 'Warden', 'Sealer', 'Guardian', 'Custodian', 'Sentinel'],
  },
  {
    key: 'tre',
    name: 'Treant',
    archetype: 'taunt-tank',
    palette: 'wood',
    skin: 'green',
    template: 'creature-tree',
    weapon: null,
    sig: 'taunt',
    keywords: ['taunt'],
    keywordPool: ['taunt'],
    minMana: 3, maxMana: 9,
    nameSuffixes: ['Sapling', 'Sprout', 'Ironbark', 'Oakheart', 'Elder', 'Wisewood', 'Old-Grove'],
  },
  {
    key: 'con',
    name: 'Construct',
    archetype: 'taunt-tank',
    palette: 'bronze',
    skin: 'stone',
    template: 'creature-golem',
    weapon: null,
    sig: null,
    keywords: [],
    keywordPool: ['taunt', 'shield', 'spell-immune'],
    minMana: 3, maxMana: 9,
    nameSuffixes: ['Cog', 'Sentry', 'Sentinel', 'Engine', 'Juggernaut', 'Colossus', 'Titan'],
  },

  // ── Caster ────────────────────────────────────────────────────────
  {
    key: 'mag',
    name: 'Mage',
    archetype: 'caster',
    palette: 'arcane',
    skin: 'pale',
    template: 'humanoid-robed',
    weapon: 'staff',
    sig: null,
    keywords: [],
    keywordPool: [],
    minMana: 2, maxMana: 7,
    nameSuffixes: ['Apprentice', 'Adept', 'Conjurer', 'Sorcerer', 'Archmage', 'Magister'],
  },
  {
    key: 'sor',
    name: 'Sorcerer',
    archetype: 'caster',
    palette: 'fire',
    skin: 'pale',
    template: 'humanoid-robed',
    weapon: 'staff',
    sig: null,
    keywords: [],
    keywordPool: [],
    minMana: 3, maxMana: 8,
    nameSuffixes: ['Initiate', 'Pyromancer', 'Hydromancer', 'Aeromancer', 'Geomancer', 'Chronomancer'],
  },
  {
    key: 'vmg',
    name: 'Voltaic Adept',
    archetype: 'caster',
    palette: 'voltaic',
    skin: 'pale',
    template: 'humanoid-robed',
    weapon: 'staff',
    sig: null,
    keywords: [],
    keywordPool: [],
    minMana: 2, maxMana: 7,
    nameSuffixes: ['Spark', 'Bolt', 'Surge', 'Storm', 'Tempest', 'Vault-Speaker'],
  },
  {
    key: 'orc',
    name: 'Oracle',
    archetype: 'caster',
    palette: 'holy',
    skin: 'fair',
    template: 'humanoid-robed',
    weapon: 'orb',
    sig: null,
    keywords: [],
    keywordPool: [],
    minMana: 2, maxMana: 6,
    nameSuffixes: ['Seer', 'Diviner', 'Augur', 'Prophet', 'Visionary'],
  },
  {
    key: 'mys',
    name: 'Mystic',
    archetype: 'caster',
    palette: 'arcane',
    skin: 'pale',
    template: 'humanoid-robed',
    weapon: 'orb',
    sig: null,
    keywords: [],
    keywordPool: [],
    minMana: 2, maxMana: 6,
    nameSuffixes: ['Acolyte', 'Initiate', 'Scribe', 'Sage', 'Hierophant'],
  },

  // ── Stealth / utility ─────────────────────────────────────────────
  {
    key: 'rog',
    name: 'Rogue',
    archetype: 'stealth-utility',
    palette: 'leather-black',
    skin: 'tan',
    template: 'humanoid',
    weapon: 'dagger',
    sig: 'stealth',
    keywords: ['stealth'],
    keywordPool: ['stealth', 'poison'],
    minMana: 2, maxMana: 6,
    nameSuffixes: ['Thug', 'Assassin', 'Shadeblade', 'Backstabber', 'Nightblade', 'Whisperer'],
  },
  {
    key: 'nin',
    name: 'Ninja',
    archetype: 'stealth-utility',
    palette: 'leather-black',
    skin: 'pale',
    template: 'humanoid',
    weapon: 'dagger',
    sig: 'stealth',
    keywords: ['stealth', 'charge'],
    keywordPool: ['stealth', 'charge'],
    minMana: 3, maxMana: 7,
    nameSuffixes: ['Novice', 'Genin', 'Chunin', 'Jonin', 'Master', 'Shadowmaster'],
  },
  {
    key: 'bnt',
    name: 'Bounty Hunter',
    archetype: 'stealth-utility',
    palette: 'leather',
    skin: 'tan',
    template: 'humanoid',
    weapon: 'crossbow',
    sig: null,
    keywords: [],
    keywordPool: ['reach', 'stealth'],
    minMana: 3, maxMana: 7,
    nameSuffixes: ['Tracker', 'Stalker', 'Hunter', 'Reaper', 'Slayer'],
  },
  {
    key: 'pha',
    name: 'Phantom',
    archetype: 'stealth-utility',
    palette: 'shadow',
    skin: 'purple',
    template: 'creature-wisp',
    weapon: null,
    sig: 'stealth',
    keywords: ['stealth'],
    keywordPool: ['stealth'],
    minMana: 2, maxMana: 6,
    nameSuffixes: ['Wisp', 'Specter', 'Wraith-Light', 'Shade', 'Haunt'],
  },

  // ── Beast / wild ──────────────────────────────────────────────────
  {
    key: 'bst',
    name: 'Beast',
    archetype: 'wild-beast',
    palette: 'leather',
    skin: 'tan',
    template: 'beast',
    weapon: null,
    sig: null,
    keywords: [],
    keywordPool: ['charge', 'poison', 'lifesteal'],
    minMana: 2, maxMana: 8,
    nameSuffixes: ['Wolf', 'Boar', 'Bear', 'Hawk', 'Lion', 'Stag', 'Tiger', 'Owl', 'Lynx', 'Direwolf'],
  },
  {
    key: 'rng',
    name: 'Ranger',
    archetype: 'stealth-utility',
    palette: 'leather',
    skin: 'tan',
    template: 'humanoid',
    weapon: 'bow',
    sig: 'reach',
    keywords: ['reach'],
    keywordPool: ['reach', 'stealth'],
    minMana: 2, maxMana: 6,
    nameSuffixes: ['Scout', 'Tracker', 'Marksman', 'Pathfinder', 'Warden', 'Huntmaster'],
  },
  {
    key: 'dru',
    name: 'Druid',
    archetype: 'balanced',
    palette: 'nature',
    skin: 'fair',
    template: 'humanoid-robed',
    weapon: 'staff',
    sig: null,
    keywords: [],
    keywordPool: ['taunt'],
    minMana: 2, maxMana: 7,
    nameSuffixes: ['Initiate', 'Lorekeeper', 'Greenmender', 'Seedling', 'Elder', 'Archdruid'],
  },
  {
    key: 'hnt',
    name: 'Hunter',
    archetype: 'stealth-utility',
    palette: 'leather',
    skin: 'fair',
    template: 'humanoid',
    weapon: 'bow',
    sig: 'reach',
    keywords: ['reach'],
    keywordPool: ['reach', 'charge'],
    minMana: 2, maxMana: 6,
    nameSuffixes: ['Trapper', 'Snare-Master', 'Houndsman', 'Falconer', 'Bowman', 'Stalker'],
  },

  // ── Undead / death ────────────────────────────────────────────────
  {
    key: 'ske',
    name: 'Skeleton',
    archetype: 'undead',
    palette: 'iron',
    skin: 'bone',
    template: 'humanoid-skeletal',
    weapon: 'sword',
    sig: null,
    keywords: [],
    keywordPool: ['taunt', 'charge'],
    minMana: 1, maxMana: 6,
    nameSuffixes: ['Servant', 'Warrior', 'Knight', 'Captain', 'Champion', 'Lord'],
  },
  {
    key: 'nec',
    name: 'Necromancer',
    archetype: 'caster',
    palette: 'shadow',
    skin: 'pale',
    template: 'humanoid-robed',
    weapon: 'staff',
    sig: null,
    keywords: [],
    keywordPool: [],
    minMana: 3, maxMana: 8,
    nameSuffixes: ['Acolyte', 'Adept', 'Cultist', 'Lord', 'Master', 'Archnecromancer'],
  },
  {
    key: 'ghl',
    name: 'Ghoul',
    archetype: 'undead',
    palette: 'leather',
    skin: 'grey',
    template: 'creature-zombie',
    weapon: null,
    sig: null,
    keywords: [],
    keywordPool: ['poison', 'lifesteal'],
    minMana: 2, maxMana: 6,
    nameSuffixes: ['Stalker', 'Devourer', 'Ravener', 'Glutton', 'Carrion-King'],
  },
  {
    key: 'lic',
    name: 'Lich-Kin',
    archetype: 'caster',
    palette: 'shadow',
    skin: 'bone',
    template: 'humanoid-robed',
    weapon: 'staff',
    sig: null,
    keywords: [],
    keywordPool: ['spell-immune'],
    minMana: 5, maxMana: 9,
    nameSuffixes: ['Apprentice', 'Bound', 'Ascendant', 'Sovereign'],
  },
  {
    key: 'wrt',
    name: 'Wraith',
    archetype: 'stealth-utility',
    palette: 'shadow',
    skin: 'purple',
    template: 'creature-wisp',
    weapon: null,
    sig: null,
    keywords: [],
    keywordPool: ['stealth', 'spell-immune'],
    minMana: 3, maxMana: 7,
    nameSuffixes: ['Shade', 'Spectre', 'Banshee', 'Howler', 'Doomsinger'],
  },

  // ── Demon / sacrifice ─────────────────────────────────────────────
  {
    key: 'dem',
    name: 'Demon',
    archetype: 'demon',
    palette: 'fire',
    skin: 'red',
    template: 'humanoid',
    weapon: 'axe',
    sig: null,
    keywords: [],
    keywordPool: ['charge', 'lifesteal'],
    minMana: 3, maxMana: 9,
    nameSuffixes: ['Imp', 'Hellion', 'Brute', 'Fiend', 'Tormentor', 'Devourer', 'Overlord'],
  },
  {
    key: 'wlk',
    name: 'Warlock',
    archetype: 'caster',
    palette: 'shadow',
    skin: 'pale',
    template: 'humanoid-robed',
    weapon: 'orb',
    sig: null,
    keywords: [],
    keywordPool: [],
    minMana: 3, maxMana: 8,
    nameSuffixes: ['Initiate', 'Pact-Sworn', 'Hex-Caller', 'Doombringer', 'Soulbinder'],
  },
  {
    key: 'cul',
    name: 'Cultist',
    archetype: 'balanced',
    palette: 'leather-black',
    skin: 'pale',
    template: 'humanoid-robed',
    weapon: 'dagger',
    sig: null,
    keywords: [],
    keywordPool: ['poison'],
    minMana: 2, maxMana: 6,
    nameSuffixes: ['Devotee', 'Faithful', 'Zealot', 'Anointed', 'High-Priest'],
  },
  {
    key: 'hsp',
    name: 'Hellspawn',
    archetype: 'demon',
    palette: 'fire',
    skin: 'red',
    template: 'creature-imp',
    weapon: null,
    sig: 'charge',
    keywords: ['charge'],
    keywordPool: ['charge', 'lifesteal'],
    minMana: 2, maxMana: 6,
    nameSuffixes: ['Imp', 'Whelpling', 'Cinder-Pup', 'Maw-Spawn', 'Hellhound'],
  },

  // ── Holy / heal ───────────────────────────────────────────────────
  {
    key: 'pri',
    name: 'Priest',
    archetype: 'holy',
    palette: 'cloth-linen',
    skin: 'fair',
    template: 'humanoid-robed',
    weapon: 'staff',
    sig: null,
    keywords: [],
    keywordPool: ['lifesteal'],
    minMana: 2, maxMana: 7,
    nameSuffixes: ['Novice', 'Acolyte', 'Pastor', 'Bishop', 'Patriarch', 'High-Priest'],
  },
  {
    key: 'spi',
    name: 'Spirit',
    archetype: 'holy',
    palette: 'holy',
    skin: 'pale',
    template: 'creature-wisp',
    weapon: null,
    sig: 'spell-immune',
    keywords: [],
    keywordPool: ['spell-immune'],
    minMana: 2, maxMana: 7,
    nameSuffixes: ['Light', 'Lantern', 'Glow', 'Beacon', 'Radiance'],
  },
  {
    key: 'cle',
    name: 'Cleric',
    archetype: 'holy',
    palette: 'cloth-linen',
    skin: 'fair',
    template: 'humanoid',
    weapon: 'mace',
    sig: null,
    keywords: [],
    keywordPool: ['lifesteal'],
    minMana: 2, maxMana: 6,
    nameSuffixes: ['Novitiate', 'Curate', 'Warder', 'Healer', 'Light-Bringer'],
  },

  // ── Elemental ─────────────────────────────────────────────────────
  {
    key: 'efr',
    name: 'Fire Elemental',
    archetype: 'elemental',
    palette: 'fire',
    skin: 'fire',
    template: 'creature-elemental',
    weapon: null,
    sig: null,
    keywords: [],
    keywordPool: ['charge'],
    minMana: 2, maxMana: 8,
    nameSuffixes: ['Cinder', 'Ember', 'Flame', 'Inferno', 'Pyre', 'Conflagrant'],
  },
  {
    key: 'efz',
    name: 'Frost Elemental',
    archetype: 'elemental',
    palette: 'frost',
    skin: 'ice',
    template: 'creature-elemental',
    weapon: null,
    sig: null,
    keywords: [],
    keywordPool: ['taunt'],
    minMana: 2, maxMana: 8,
    nameSuffixes: ['Snow', 'Hail', 'Glacier', 'Blizzard', 'Frost-Giant'],
  },
  {
    key: 'est',
    name: 'Storm Elemental',
    archetype: 'elemental',
    palette: 'voltaic',
    skin: 'electric',
    template: 'creature-elemental',
    weapon: null,
    sig: null,
    keywords: [],
    keywordPool: ['charge'],
    minMana: 2, maxMana: 8,
    nameSuffixes: ['Spark', 'Bolt', 'Thunder', 'Tempest', 'Maelstrom'],
  },
  {
    key: 'eer',
    name: 'Earth Elemental',
    archetype: 'elemental',
    palette: 'stone',
    skin: 'stone',
    template: 'creature-elemental',
    weapon: null,
    sig: 'taunt',
    keywords: ['taunt'],
    keywordPool: ['taunt'],
    minMana: 3, maxMana: 9,
    nameSuffixes: ['Pebble', 'Rockling', 'Boulder', 'Stoneheart', 'Mountain'],
  },

  // ── Misc flagships ────────────────────────────────────────────────
  {
    key: 'dra',
    name: 'Dragon',
    archetype: 'dragon',
    palette: 'gold',
    skin: 'red',
    template: 'creature-dragon',
    weapon: null,
    sig: null,
    keywords: [],
    keywordPool: ['charge'],
    minMana: 5, maxMana: 10,
    nameSuffixes: ['Wyrmling', 'Drake', 'Wyvern', 'Wyrm', 'Ancient', 'Worldbreaker'],
  },
  {
    key: 'wit',
    name: 'Witch',
    archetype: 'caster',
    palette: 'shadow',
    skin: 'green',
    template: 'humanoid-robed',
    weapon: 'staff',
    sig: null,
    keywords: [],
    keywordPool: ['poison'],
    minMana: 3, maxMana: 7,
    nameSuffixes: ['Hex', 'Crone', 'Hag', 'Coven-Mother', 'Black-Witch'],
  },
  {
    key: 'ber',
    name: 'Berserker',
    archetype: 'aggro-swarm',
    palette: 'leather',
    skin: 'tan',
    template: 'humanoid',
    weapon: 'axe',
    sig: 'charge',
    keywords: ['charge'],
    keywordPool: ['charge', 'lifesteal'],
    minMana: 3, maxMana: 7,
    nameSuffixes: ['Bloodied', 'Reaver', 'Skullsplitter', 'Bone-Rager', 'Doom-Lord'],
  },
  {
    key: 'sha',
    name: 'Shaman',
    archetype: 'balanced',
    palette: 'leather',
    skin: 'tan',
    template: 'humanoid-robed',
    weapon: 'staff',
    sig: null,
    keywords: [],
    keywordPool: ['taunt'],
    minMana: 2, maxMana: 6,
    nameSuffixes: ['Apprentice', 'Totem-Carver', 'Spirit-Caller', 'Storm-Seer', 'Elder'],
  },
  {
    key: 'bar',
    name: 'Bardic',
    archetype: 'balanced',
    palette: 'cloth-linen',
    skin: 'fair',
    template: 'humanoid',
    weapon: 'lute',
    sig: null,
    keywords: [],
    keywordPool: [],
    minMana: 2, maxMana: 6,
    nameSuffixes: ['Wanderer', 'Lutenist', 'Skald', 'Loremaster', 'Bard-King'],
  },
];

// ── Effect templates (for uncommon "tiny effect" + rare ability) ─────
//
// Each entry's `effect` is a card-content ability object the resolver
// already understands (see cards-content.js EFFECTS dictionary).
// `appliesTo` lets the family table opt in/out.

const UNCOMMON_TINY_EFFECTS = {
  // Battlecry damage 1 to picked target.
  zap1: {
    text: 'Battlecry: deal 1 damage.',
    abilities: [{ trigger: 'onPlay', effect: 'damage', target: 'pickedTarget', value: 1 }],
    needsTarget: true,
  },
  heal1: {
    text: 'Battlecry: heal you 2.',
    abilities: [{ trigger: 'onPlay', effect: 'heal', target: 'selfHero', value: 2 }],
  },
  draw1: {
    text: 'Battlecry: draw a card.',
    abilities: [{ trigger: 'onPlay', effect: 'draw', target: 'self', value: 1 }],
  },
  buffFriend: {
    text: 'Battlecry: give a friendly minion +1 HP.',
    abilities: [{ trigger: 'onPlay', effect: 'buff', target: 'randomFriendlyMinion', valueAtk: 0, valueHp: 1 }],
  },
  endHeal: {
    text: 'End of your turn: heal you 1.',
    abilities: [{ trigger: 'endOfTurn', effect: 'heal', target: 'selfHero', value: 1 }],
  },
};

// Rare-tier abilities are stronger / conditional.
const RARE_ABILITIES = {
  zap2pick: {
    text: 'Battlecry: deal 2 damage to any target.',
    abilities: [{ trigger: 'onPlay', effect: 'damage', target: 'pickedTarget', value: 2 }],
    needsTarget: true,
  },
  zap1aoe: {
    text: 'Battlecry: deal 1 damage to all enemy minions.',
    abilities: [{ trigger: 'onPlay', effect: 'damage', target: 'allEnemyMinions', value: 1 }],
  },
  heal3: {
    text: 'Battlecry: heal you 3.',
    abilities: [{ trigger: 'onPlay', effect: 'heal', target: 'selfHero', value: 3 }],
  },
  draw2: {
    text: 'Battlecry: draw 2 cards.',
    abilities: [{ trigger: 'onPlay', effect: 'draw', target: 'self', value: 2 }],
  },
  buffAllFriends: {
    text: 'Battlecry: give your other minions +1 ATK.',
    abilities: [{ trigger: 'onPlay', effect: 'buff', target: 'allFriendlyMinions', valueAtk: 1, valueHp: 0 }],
  },
  endDmgRandom: {
    text: 'End of your turn: deal 1 damage to a random enemy.',
    abilities: [{ trigger: 'endOfTurn', effect: 'damage', target: 'randomEnemyMinion', value: 1 }],
  },
  deathSummon: {
    text: 'Deathrattle: summon a 1/1 token.',
    abilities: [{ trigger: 'onDeath', effect: 'summon', target: 'self', cardId: 'tok.spawnling' }],
  },
  deathHeal: {
    text: 'Deathrattle: heal you 3.',
    abilities: [{ trigger: 'onDeath', effect: 'heal', target: 'selfHero', value: 3 }],
  },
};

// Per-family allowed effect picks. Picked deterministically by mana,
// so each (family, mana, rarity) cell yields a stable variant.
const FAMILY_EFFECT_POOL = {
  // aggro / damage flavored
  'aggro-swarm':     { uncommon: ['zap1'],        rare: ['zap2pick', 'zap1aoe', 'endDmgRandom'] },
  'stealth-utility': { uncommon: ['draw1'],       rare: ['draw2', 'zap2pick'] },
  'taunt-tank':      { uncommon: ['heal1'],       rare: ['heal3', 'buffAllFriends'] },
  'caster':          { uncommon: ['zap1', 'draw1'], rare: ['zap2pick', 'zap1aoe', 'draw2'] },
  'wild-beast':      { uncommon: ['zap1'],        rare: ['zap2pick', 'endDmgRandom'] },
  'undead':          { uncommon: ['endHeal'],     rare: ['deathSummon', 'deathHeal'] },
  'holy':            { uncommon: ['heal1', 'endHeal'], rare: ['heal3', 'buffAllFriends'] },
  'elemental':       { uncommon: ['zap1'],        rare: ['zap1aoe', 'zap2pick'] },
  'dragon':          { uncommon: ['zap1'],        rare: ['zap1aoe', 'zap2pick'] },
  'demon':           { uncommon: ['zap1'],        rare: ['zap2pick', 'endDmgRandom'] },
  'balanced':        { uncommon: ['draw1', 'buffFriend'], rare: ['draw2', 'buffAllFriends'] },
};

// ── Generation primitives ────────────────────────────────────────────

function pickDeterministic(arr, seed) {
  if (!arr || !arr.length) return null;
  return arr[seed % arr.length];
}

function nameFor(family, suffixIdx, prefix = null) {
  const suf = family.nameSuffixes[suffixIdx % family.nameSuffixes.length];
  if (prefix) return `${prefix} ${family.name} ${suf}`.trim();
  return `${family.name} ${suf}`;
}

function idFor(family, rarity, mana, variant) {
  // Stable card id: rarity-tier + family key + mana + variant index
  const tag = { common: 'c', uncommon: 'u', rare: 'r' }[rarity] || 'x';
  return `${tag}.${family.key}.m${mana}.v${variant}`;
}

// ── Minion factory ───────────────────────────────────────────────────

function makeMinion(family, mana, rarity, variant) {
  const offset = variant % 2 === 0 ? 0 : (variant % 4 < 2 ? 1 : -1);
  const stats = statsFor(mana, family.archetype, rarity, offset);
  const name = nameFor(family, variant + mana);

  let keywords = [];
  let abilities = [];
  let text = '';
  let needsTarget = false;

  if (rarity === 'common') {
    // Vanilla glue — no keyword, no ability.
    text = '';
  } else if (rarity === 'uncommon') {
    // Either: family signature keyword, OR one tiny effect — alternates by variant.
    if (variant % 2 === 0 && family.sig) {
      keywords = [family.sig];
      text = sentenceFor(family.sig);
    } else if (family.keywordPool.length && variant % 2 === 0) {
      const kw = pickDeterministic(family.keywordPool, variant + mana);
      keywords = [kw];
      text = sentenceFor(kw);
    } else {
      const pool = FAMILY_EFFECT_POOL[family.archetype]?.uncommon || ['zap1'];
      const fxKey = pickDeterministic(pool, variant + mana);
      const fx = UNCOMMON_TINY_EFFECTS[fxKey];
      if (fx) {
        abilities = fx.abilities.map(a => ({ ...a }));
        text = fx.text;
        needsTarget = !!fx.needsTarget;
        if (family.sig) keywords = [family.sig];
      }
    }
  } else if (rarity === 'rare') {
    // Family signature keyword AND a rare ability.
    if (family.sig) keywords = [family.sig];
    const pool = FAMILY_EFFECT_POOL[family.archetype]?.rare || ['zap2pick'];
    const fxKey = pickDeterministic(pool, variant + mana);
    const fx = RARE_ABILITIES[fxKey];
    if (fx) {
      abilities = fx.abilities.map(a => ({ ...a }));
      text = fx.text;
      needsTarget = !!fx.needsTarget;
      if (keywords.length) {
        text = `${sentenceFor(keywords[0])} ${text}`.trim();
      }
    }
  }

  return {
    id: idFor(family, rarity, mana, variant),
    name,
    rarity,
    type: 'minion',
    mana,
    atk: stats.atk,
    hp: stats.hp,
    keywords,
    abilities,
    text,
    family: family.key,
    archetype: family.archetype,
    needsTarget,
  };
}

function sentenceFor(kw) {
  switch (kw) {
    case 'taunt':        return 'Taunt.';
    case 'charge':       return 'Charge.';
    case 'shield':       return 'Shield.';
    case 'stealth':      return 'Stealth.';
    case 'lifesteal':    return 'Lifesteal.';
    case 'poison':       return 'Poison.';
    case 'reach':        return 'Reach.';
    case 'spell-immune': return 'Cannot be targeted by spells.';
    default: return '';
  }
}

// ── Spell schools ────────────────────────────────────────────────────

const SPELL_SCHOOLS = [
  {
    key: 'fir', name: 'Fire', palette: 'fire', glyph: 'flame',
    spells: [
      { effect: 'damage', value: 1, target: 'pickedTarget', mana: 1, name: 'Spark',         rarity: 'common',   text: 'Deal 1 damage.' },
      { effect: 'damage', value: 2, target: 'pickedTarget', mana: 2, name: 'Bolt',          rarity: 'common',   text: 'Deal 2 damage.' },
      { effect: 'damage', value: 3, target: 'pickedTarget', mana: 3, name: 'Fire Bolt',     rarity: 'common',   text: 'Deal 3 damage.' },
      { effect: 'damage', value: 4, target: 'pickedTarget', mana: 4, name: 'Fireball',      rarity: 'uncommon', text: 'Deal 4 damage.' },
      { effect: 'damage', value: 5, target: 'pickedTarget', mana: 5, name: 'Inferno',       rarity: 'uncommon', text: 'Deal 5 damage.' },
      { effect: 'damage', value: 6, target: 'pickedTarget', mana: 6, name: 'Conflagration', rarity: 'rare',     text: 'Deal 6 damage.' },
      { effect: 'damage', value: 1, target: 'allEnemyMinions', mana: 2, name: 'Fire Spray', rarity: 'uncommon', text: 'Deal 1 damage to all enemy minions.' },
      { effect: 'damage', value: 2, target: 'allEnemyMinions', mana: 4, name: 'Pyre Wave',  rarity: 'rare',     text: 'Deal 2 damage to all enemy minions.' },
      { effect: 'damage', value: 3, target: 'allEnemyMinions', mana: 6, name: 'Firestorm',  rarity: 'rare',     text: 'Deal 3 damage to all enemy minions.' },
      { effect: 'damage', value: 4, target: 'allEnemyMinions', mana: 7, name: 'Cataclysm',  rarity: 'rare',     text: 'Deal 4 damage to all enemy minions.' },
    ],
  },
  {
    key: 'fro', name: 'Frost', palette: 'frost', glyph: 'crystal',
    spells: [
      { effect: 'damage', value: 1, target: 'pickedTarget', mana: 1, name: 'Chill',         rarity: 'common',   text: 'Deal 1 damage.' },
      { effect: 'damage', value: 2, target: 'pickedTarget', mana: 2, name: 'Ice Lance',     rarity: 'common',   text: 'Deal 2 damage.' },
      { effect: 'damage', value: 3, target: 'pickedTarget', mana: 3, name: 'Frost Bolt',    rarity: 'common',   text: 'Deal 3 damage.' },
      { effect: 'damage', value: 4, target: 'pickedTarget', mana: 4, name: 'Glacial Spike', rarity: 'uncommon', text: 'Deal 4 damage.' },
      { effect: 'damage', value: 2, target: 'allEnemyMinions', mana: 4, name: 'Hailstorm',  rarity: 'rare',     text: 'Deal 2 damage to all enemy minions.' },
      { effect: 'damage', value: 1, target: 'allMinions',      mana: 3, name: 'Cone of Cold', rarity: 'uncommon', text: 'Deal 1 damage to all minions.' },
      { effect: 'damage', value: 3, target: 'allEnemyMinions', mana: 6, name: 'Blizzard',   rarity: 'rare',     text: 'Deal 3 damage to all enemy minions.' },
      { effect: 'heal',   value: 4, target: 'pickedTarget',    mana: 2, name: 'Soothing Cool', rarity: 'common', text: 'Heal a hero for 4.' },
    ],
  },
  {
    key: 'hol', name: 'Holy', palette: 'holy', glyph: 'cross',
    spells: [
      { effect: 'heal', value: 2, target: 'pickedTarget',  mana: 1, name: 'Small Light',   rarity: 'common',   text: 'Heal a hero for 2.', filter: { type: 'hero' } },
      { effect: 'heal', value: 3, target: 'pickedTarget',  mana: 1, name: 'Mend Wounds',   rarity: 'common',   text: 'Heal a hero for 3.', filter: { type: 'hero' } },
      { effect: 'heal', value: 4, target: 'pickedTarget',  mana: 2, name: 'Heal Flash',    rarity: 'common',   text: 'Heal a hero for 4.', filter: { type: 'hero' } },
      { effect: 'heal', value: 5, target: 'pickedTarget',  mana: 3, name: 'Greater Heal',  rarity: 'uncommon', text: 'Heal a hero for 5.', filter: { type: 'hero' } },
      { effect: 'heal', value: 6, target: 'pickedTarget',  mana: 4, name: 'Sanctify',      rarity: 'rare',     text: 'Heal a hero for 6.', filter: { type: 'hero' } },
      { effect: 'heal', value: 8, target: 'pickedTarget',  mana: 6, name: 'Divine Touch',  rarity: 'rare',     text: 'Heal a hero for 8.', filter: { type: 'hero' } },
      { effect: 'buff', valueAtk: 0, valueHp: 4, target: 'selfHero',       mana: 1, name: 'Iron Skin',     rarity: 'common',   text: 'Your hero gains +4 HP this turn.' },
      { effect: 'buff', valueAtk: 1, valueHp: 1, target: 'allFriendlyMinions', mana: 4, name: 'Bless Host',    rarity: 'rare',     text: 'Give your minions +1/+1.' },
    ],
  },
  {
    key: 'sha', name: 'Shadow', palette: 'shadow', glyph: 'skull',
    spells: [
      { effect: 'damage', value: 2, target: 'pickedTarget', mana: 2, name: 'Shadow Bolt',  rarity: 'common',   text: 'Deal 2 damage.' },
      { effect: 'damage', value: 3, target: 'pickedTarget', mana: 3, name: 'Soul Drain',   rarity: 'common',   text: 'Deal 3 damage.' },
      { effect: 'damage', value: 4, target: 'pickedTarget', mana: 4, name: 'Death Coil',   rarity: 'uncommon', text: 'Deal 4 damage.' },
      { effect: 'discard', value: 1, target: 'oppHand',     mana: 2, name: 'Mind Pry',     rarity: 'uncommon', text: 'Opponent discards a random card.' },
      { effect: 'damage', value: 2, target: 'allEnemyMinions', mana: 4, name: 'Shadow Wave', rarity: 'rare',  text: 'Deal 2 damage to all enemy minions.' },
      { effect: 'damage', value: 3, target: 'allEnemyMinions', mana: 6, name: 'Doom Cloud',  rarity: 'rare',  text: 'Deal 3 damage to all enemy minions.' },
    ],
  },
  {
    key: 'nat', name: 'Nature', palette: 'nature', glyph: 'leaf',
    spells: [
      { effect: 'buff', valueAtk: 1, valueHp: 1, target: 'pickedTarget', mana: 1, name: 'Smithing Touch', rarity: 'common', text: 'Give a friendly minion +1/+1.', filter: { type: 'friendly-minion' } },
      { effect: 'buff', valueAtk: 2, valueHp: 2, target: 'pickedTarget', mana: 2, name: 'Forge Brand',    rarity: 'rare',   text: 'Give a friendly minion +2/+2 this turn.', filter: { type: 'friendly-minion' } },
      { effect: 'buff', valueAtk: 2, valueHp: 0, target: 'pickedTarget', mana: 3, name: 'Flame Sword',    rarity: 'common', text: 'Give a friendly minion +2 ATK.', filter: { type: 'friendly-minion' } },
      { effect: 'buff', valueAtk: 3, valueHp: 3, target: 'pickedTarget', mana: 4, name: 'Wild Growth',    rarity: 'rare',   text: 'Give a friendly minion +3/+3.', filter: { type: 'friendly-minion' } },
      { effect: 'heal', value: 4, target: 'allFriendlyMinions', mana: 4, name: 'Healing Rain', rarity: 'rare', text: 'Heal all friendly minions for 4.' },
      { effect: 'buff', valueAtk: 1, target: 'allFriendlyMinions', mana: 3, name: 'Battle Cry', rarity: 'common', text: 'Your minions have +1 attack this turn.' },
    ],
  },
  {
    key: 'arc', name: 'Arcane', palette: 'arcane', glyph: 'sigil',
    spells: [
      { effect: 'draw',  value: 1, target: 'self', mana: 1, name: 'Study',        rarity: 'common',   text: 'Draw a card.' },
      { effect: 'draw',  value: 2, target: 'self', mana: 2, name: 'Quick Study',  rarity: 'uncommon', text: 'Draw 2 cards.' },
      { effect: 'draw',  value: 3, target: 'self', mana: 4, name: 'Tome Study',   rarity: 'rare',     text: 'Draw 3 cards.' },
      { effect: 'counter', target: 'oppNextSpell', mana: 3, name: 'Vault Seal',   rarity: 'rare',     text: "Counter your opponent's next spell." },
      { effect: 'damage', value: 2, target: 'pickedTarget', mana: 2, name: 'Arcane Bolt',  rarity: 'common', text: 'Deal 2 damage.' },
      { effect: 'damage', value: 3, target: 'pickedTarget', mana: 3, name: 'Arcane Lance', rarity: 'common', text: 'Deal 3 damage.' },
      { effect: 'damage', value: 5, target: 'pickedTarget', mana: 5, name: 'Polymorph Strike', rarity: 'rare', text: 'Deal 5 damage.' },
    ],
  },
  {
    key: 'sto', name: 'Storm', palette: 'voltaic', glyph: 'bolt',
    spells: [
      { effect: 'damage', value: 1, target: 'pickedTarget', mana: 1, name: 'Tiny Bolt',    rarity: 'common',   text: 'Deal 1 damage.' },
      { effect: 'damage', value: 2, target: 'pickedTarget', mana: 2, name: 'Lightning',    rarity: 'common',   text: 'Deal 2 damage.' },
      { effect: 'damage', value: 3, target: 'pickedTarget', mana: 3, name: 'Thunderclap',  rarity: 'common',   text: 'Deal 3 damage.' },
      { effect: 'damage', value: 4, target: 'pickedTarget', mana: 4, name: 'Voltaic Surge',rarity: 'uncommon', text: 'Deal 4 damage.' },
      { effect: 'damage', value: 1, target: 'allEnemyMinions', mana: 2, name: 'Static Field', rarity: 'common', text: 'Deal 1 damage to all enemy minions.' },
      { effect: 'damage', value: 2, target: 'allEnemyMinions', mana: 4, name: 'Bolt Storm',   rarity: 'rare',  text: 'Deal 2 damage to all enemy minions.' },
      { effect: 'damage', value: 3, target: 'allEnemyMinions', mana: 6, name: 'Tempest',      rarity: 'rare',  text: 'Deal 3 damage to all enemy minions.' },
    ],
  },
];

function makeSpell(school, spec, variantIdx) {
  const ab = { trigger: 'onCast', effect: spec.effect };
  if (spec.value !== undefined) ab.value = spec.value;
  if (spec.target) ab.target = spec.target;
  if (spec.valueAtk !== undefined) ab.valueAtk = spec.valueAtk;
  if (spec.valueHp  !== undefined) ab.valueHp  = spec.valueHp;
  if (spec.filter) ab.filter = { ...spec.filter };
  const tag = { common: 'c', uncommon: 'u', rare: 'r' }[spec.rarity] || 'x';
  return {
    id: `${tag}.sp.${school.key}.${variantIdx}`,
    name: spec.name,
    rarity: spec.rarity,
    type: 'spell',
    mana: spec.mana,
    keywords: [],
    abilities: [ab],
    text: spec.text,
    school: school.key,
    schoolGlyph: school.glyph,
    schoolPalette: school.palette,
    needsTarget: spec.target === 'pickedTarget',
  };
}

// ── Public: generate the procedural catalogue ────────────────────────
//
// Returns a flat array of card records ready for normaliseCard().
// Stable, deterministic, side-effect-free.

export function generateCatalogue() {
  const out = [];

  // Family minions: at each mana from family.minMana..family.maxMana,
  // emit (commonVariants, uncommonVariants, rareVariants) cards.
  // The variant counts are tuned so a family of mana-range 6 yields
  // ~30 cards.

  for (const family of FAMILIES) {
    for (let mana = family.minMana; mana <= family.maxMana; mana++) {
      // Variants per rarity tier — common dominates, then uncommon, rare sparse.
      const commonV = 3;
      const uncommonV = 2;
      const rareV = mana >= family.minMana + 1 ? 1 : 0; // skip rare at very low mana

      for (let v = 0; v < commonV; v++) out.push(makeMinion(family, mana, 'common', v));
      for (let v = 0; v < uncommonV; v++) out.push(makeMinion(family, mana, 'uncommon', v));
      for (let v = 0; v < rareV; v++) out.push(makeMinion(family, mana, 'rare', v));
    }
  }

  // Spell schools.
  for (const school of SPELL_SCHOOLS) {
    school.spells.forEach((spec, i) => out.push(makeSpell(school, spec, i)));
  }

  return out;
}

// Sprite manifest — the sprite generator consumes this to render each
// card with the right family template / palette / glyph. Returned
// flat list mirrors what's in the JS catalogue.

export function generateSpriteManifest() {
  const manifest = [];
  for (const family of FAMILIES) {
    for (let mana = family.minMana; mana <= family.maxMana; mana++) {
      const commonV = 3, uncommonV = 2;
      const rareV = mana >= family.minMana + 1 ? 1 : 0;
      const make = (rarity, v) => manifest.push({
        id: idFor(family, rarity, mana, v),
        family: family.key,
        archetype: family.archetype,
        palette: family.palette,
        skin: family.skin,
        template: family.template,
        weapon: family.weapon,
        rarity,
        mana,
        variant: v,
      });
      for (let v = 0; v < commonV; v++) make('common', v);
      for (let v = 0; v < uncommonV; v++) make('uncommon', v);
      for (let v = 0; v < rareV; v++) make('rare', v);
    }
  }
  for (const school of SPELL_SCHOOLS) {
    school.spells.forEach((spec, i) => {
      const tag = { common: 'c', uncommon: 'u', rare: 'r' }[spec.rarity] || 'x';
      manifest.push({
        id: `${tag}.sp.${school.key}.${i}`,
        family: 'spell',
        school: school.key,
        palette: school.palette,
        glyph: school.glyph,
        rarity: spec.rarity,
        mana: spec.mana,
        effect: spec.effect,
        spellTarget: spec.target,
      });
    });
  }
  return manifest;
}
