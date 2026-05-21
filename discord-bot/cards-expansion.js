// Boltbound — CR-1 expansion catalogue.
//
// Generated from declarative family definitions. ~960 new cards across
// 15 families × 4 rarities. The existing 82 cards in cards-content.js
// ship unchanged with their single-prefix IDs (`c.*`, `u.*`, `r.*`,
// `leg.*`, `champ.*`, `tok.*`). New cards use `<family>.<rarity>nnn`
// ID format so they CANNOT collide.
//
// See CARD-GAME-DESIGN.md §13-15 for the locked structure.
//
// This file is read by cards-content.js which merges EXPANSION_CARDS
// into its CARDS map at module load. Other modules (battle, packs,
// decks, state) see one unified catalogue.
//
// ─────────────────────────────────────────────────────────────────────
// Generator approach: each family declares its name lists + ability
// palette + visual archetype. The buildFamily() function below stamps
// out cards from these declarations. The output is deterministic — same
// declarations always produce the same card records — so anyone
// auditing the catalogue gets a stable diff per change.

// ── Vanilla stat formula ─────────────────────────────────────────────
//
// For minions, baseline budget = 2 × mana + 1 (so a 3-mana vanilla
// common is 3/4 or 4/3 or 2/5). Rarity adds: common +0, uncommon +1,
// rare +2, legendary +3 to budget. Each ability/keyword subtracts.
// See §13.3.

const RARITY_BONUS = { common: 0, uncommon: 1, rare: 2, legendary: 4 };

// Cost of abilities/keywords against the stat budget.
function abilityCost(ab, kw) {
  let cost = 0;
  for (const k of kw || []) {
    cost += ({ taunt: 0, charge: 2, shield: 1, stealth: 1, lifesteal: 2, poison: 2, reach: 1, 'spell-immune': 2, rush: 1, regen: 1, 'divine-light': 1, wisp: 1 })[k] || 0;
  }
  for (const a of ab || []) {
    if (a.trigger === 'onPlay' || a.trigger === 'onCast') {
      if (a.effect === 'damage') cost += (a.target === 'allEnemyMinions' || a.target === 'allEnemy') ? (a.value || 0) * 2 : (a.value || 0);
      if (a.effect === 'heal') cost += Math.ceil((a.value || 0) / 2);
      if (a.effect === 'draw') cost += (a.value || 0) * 2;
      if (a.effect === 'buff')  cost += ((a.valueAtk || 0) + (a.valueHp || 0));
      if (a.effect === 'destroy') cost += 3;
      if (a.effect === 'summon') cost += 1;
      if (a.effect === 'freeze') cost += 1;
    }
    if (a.trigger === 'onDeath') {
      if (a.effect === 'summon') cost += 1;
      if (a.effect === 'damage') cost += 1;
    }
    if (a.trigger === 'endOfTurn') {
      if (a.effect === 'heal') cost += (a.value || 0);
      if (a.effect === 'damage') cost += (a.value || 0);
    }
    if (a.trigger === 'spellDamageBonus') cost += (a.value || 0);
  }
  return cost;
}

// Compute (atk, hp) from mana + rarity + abilities + a split bias.
//   split: 0 = balanced, +1 = atk-leaning, -1 = hp-leaning
function statsFromBudget(mana, rarity, abilities, keywords, split = 0) {
  const baseBudget = 2 * mana + 1 + (RARITY_BONUS[rarity] || 0);
  const cost = abilityCost(abilities, keywords);
  const budget = Math.max(1, baseBudget - cost);
  // Floor: every minion gets at least 1/1.
  let atk = Math.max(1, Math.round(budget / 2 + split));
  let hp = Math.max(1, budget - atk);
  // 1-mana minions don't roll giant: cap atk at mana+2, hp at mana+2.
  if (mana === 1) { atk = Math.min(atk, 3); hp = Math.min(hp, 3); }
  if (mana === 2) { atk = Math.min(atk, 4); hp = Math.min(hp, 5); }
  return { atk, hp };
}

// ── Family declarations ──────────────────────────────────────────────
//
// Each family lists name pools per rarity. We size the pools to match
// the per-family count (36c / 18u / 8r / 2l). The buildFamily()
// generator below assigns mana costs + ability templates by walking
// these lists in order — same input → same output.

// Mana distribution per common name (per family). 36 names — 4@1, 6@2,
// 6@3, 6@4, 5@5, 4@6, 3@7, 2@8. Index 0..35.
const COMMON_MANA = [
  1,1,1,1,
  2,2,2,2,2,2,
  3,3,3,3,3,3,
  4,4,4,4,4,4,
  5,5,5,5,5,
  6,6,6,6,
  7,7,7,
  8,8,
];

// Uncommon: 18 names — leans mid-curve. 2@2, 3@3, 4@4, 3@5, 3@6, 2@7, 1@8.
const UNCOMMON_MANA = [
  2,2,
  3,3,3,
  4,4,4,4,
  5,5,5,
  6,6,6,
  7,7,
  8,
];

// Rare: 8 names. Mid-to-high. 1@3, 2@4, 2@5, 1@6, 1@7, 1@8.
const RARE_MANA = [3, 4,4, 5,5, 6, 7, 8];

// Legendary: 2 cards — one mid-cost (5-7), one big (8-10).
const LEGENDARY_MANA = [6, 9];

// ── Ability templates ────────────────────────────────────────────────
//
// Each family points to which templates apply at which rarity.
// `weight` controls how often a given template is picked along the
// curve; we use a deterministic walk (template index = card index %
// pool size) so the catalogue stays stable across regens.

// Legendary templates — every legendary has at least one unique
// mechanic. Each family's 2 legendaries cycle through these.
const MINION_TEMPLATES_LEGENDARY = [
  // 1: AoE on-play
  { abilities: [{ trigger: 'onPlay', effect: 'damage', target: 'allEnemyMinions', value: 2 }] },
  // 2: Taunt + big-stats anchor
  { keywords: ['taunt', 'shield'] },
  // 3: Battlecry: damage hero + minions
  { abilities: [
    { trigger: 'onPlay', effect: 'damage', target: 'allEnemyMinions', value: 1 },
    { trigger: 'onPlay', effect: 'damage', target: 'oppHero', value: 2 },
  ] },
  // 4: Draw payoff
  { abilities: [{ trigger: 'onPlay', effect: 'draw', target: 'self', value: 3 }] },
  // 5: Charge + lifesteal
  { keywords: ['charge', 'lifesteal'] },
  // 6: Mass buff
  { abilities: [{ trigger: 'onPlay', effect: 'buff', target: 'allFriendlyMinions', valueAtk: 1, valueHp: 1 }] },
  // 7: Token-summon swarmer
  { abilities: [
    { trigger: 'onPlay', effect: 'summon', target: 'self', cardId: null },
    { trigger: 'onPlay', effect: 'summon', target: 'self', cardId: null },
    { trigger: 'onPlay', effect: 'summon', target: 'self', cardId: null },
  ] },
  // 8: Deathrattle summoner
  { abilities: [
    { trigger: 'onDeath', effect: 'summon', target: 'self', cardId: null },
    { trigger: 'onDeath', effect: 'summon', target: 'self', cardId: null },
  ], keywords: ['taunt'] },
];

// Standard minion templates — used by physical / vanilla-ish families.
const MINION_TEMPLATES_BASIC = {
  common: [
    { keywords: [] },                                        // vanilla
    { keywords: [] },                                        // vanilla x2
    { keywords: ['taunt'] },
    { keywords: ['charge'], if: (m) => m <= 4 },             // cheap charge
    { keywords: ['shield'] },
    { abilities: [{ trigger: 'onPlay', effect: 'damage', target: 'pickedTarget', value: 1 }] },
    { abilities: [{ trigger: 'onPlay', effect: 'heal', target: 'selfHero', value: 2 }] },
    { abilities: [{ trigger: 'onDeath', effect: 'damage', target: 'randomEnemyMinion', value: 1 }] },
  ],
  uncommon: [
    { keywords: ['taunt'] },
    { keywords: ['charge'] },
    { keywords: ['lifesteal'] },
    { keywords: ['rush'] },
    { abilities: [{ trigger: 'onPlay', effect: 'damage', target: 'pickedTarget', value: 2 }] },
    { abilities: [{ trigger: 'onPlay', effect: 'heal', target: 'selfHero', value: 3 }] },
    { abilities: [{ trigger: 'onPlay', effect: 'draw', target: 'self', value: 1 }] },
    { abilities: [{ trigger: 'onDeath', effect: 'summon', target: 'self', cardId: null /* tribe token; resolved below */ }] },
    { abilities: [{ trigger: 'endOfTurn', effect: 'heal', target: 'selfHero', value: 1 }], keywords: ['regen'] },
  ],
  rare: [
    { keywords: ['taunt', 'shield'] },
    { keywords: ['charge', 'lifesteal'] },
    { abilities: [{ trigger: 'onPlay', effect: 'damage', target: 'allEnemyMinions', value: 1 }] },
    { abilities: [{ trigger: 'onPlay', effect: 'buff', target: 'allFriendlyMinions', valueAtk: 1, valueHp: 1 }] },
    { abilities: [{ trigger: 'onPlay', effect: 'draw', target: 'self', value: 2 }] },
    { abilities: [{ trigger: 'onDeath', effect: 'summon', target: 'self', cardId: null }] },
  ],
};

// Spells per family — light vs heavy variants
const SPELL_TEMPLATES = {
  common: [
    { effect: 'damage', target: 'pickedTarget', value: 1, mana: 1 },
    { effect: 'damage', target: 'pickedTarget', value: 2, mana: 2 },
    { effect: 'heal', target: 'pickedTarget', value: 3, mana: 2, filter: { type: 'hero' } },
    { effect: 'draw', target: 'self', value: 1, mana: 1 },
    { effect: 'buff', target: 'pickedTarget', valueAtk: 1, valueHp: 1, mana: 1, filter: { type: 'friendly-minion' } },
    { effect: 'damage', target: 'allEnemyMinions', value: 1, mana: 3 },
    { effect: 'heal', target: 'pickedTarget', value: 4, mana: 3, filter: { type: 'hero' } },
  ],
  uncommon: [
    { effect: 'damage', target: 'pickedTarget', value: 3, mana: 3 },
    { effect: 'damage', target: 'pickedTarget', value: 4, mana: 4 },
    { effect: 'heal', target: 'pickedTarget', value: 5, mana: 3, filter: { type: 'hero' } },
    { effect: 'draw', target: 'self', value: 2, mana: 3 },
    { effect: 'buff', target: 'pickedTarget', valueAtk: 2, valueHp: 2, mana: 2, filter: { type: 'friendly-minion' } },
  ],
  rare: [
    { effect: 'damage', target: 'allEnemyMinions', value: 2, mana: 4 },
    { effect: 'damage', target: 'pickedTarget', value: 5, mana: 5 },
    { effect: 'destroy', target: 'pickedTarget', mana: 5, filter: { type: 'minion' } },
    { effect: 'draw', target: 'self', value: 3, mana: 4 },
  ],
};

// ── Family blocks ────────────────────────────────────────────────────

const FAMILIES = [
  // ── beast ─────────────────────────────────────────────────────────
  {
    id: 'beast', tribe: 'beast', paletteHint: 'fur-brown',
    archetypes: { minion: 'beast-quad', flyer: 'beast-bird', spellGlyph: 'leaf' },
    minionNames: {
      common: [
        // 4@1, 6@2, 6@3, 6@4, 5@5, 4@6, 3@7, 2@8
        'Forest Pup','Plains Hare','Cave Newt','Brindle Mouse',
        'Grey Wolf','Striped Boar','Marsh Toad','River Otter','Hill Goat','Thicket Fox',
        'Wild Stag','Mountain Lynx','Hunting Hound','Ridge Ram','Pine Marten','Dust Coyote',
        'Lowland Bear','Tundra Hare','Bramble Boar','Saber Cat','Highland Elk','Iron Wolfhound',
        'Burrow Badger','Steppe Mastiff','Hollow Wyvernling','Vale Tiger','Ridgeline Stag',
        'Old Bear','Mire Crocodile','Bone-Browed Ram','Dire Wolf',
        'Pack Alpha','Black Boar','Forest King',
        'Great Ursine','Storm-Marked Stag',
      ],
      uncommon: [
        // 2@2, 3@3, 4@4, 3@5, 3@6, 2@7, 1@8
        'Pack Cub','Hunt Pup',
        'Wild Hound','Vale Boar','Marsh Lurker',
        'Saber Pack','Bramble Stalker','Iron Hound','Bog Boar',
        'Pack Sentinel','Lone Wolf','Mountain Crag-Cat',
        'Bear Mother','Stag Lord','Wolf Matron',
        'Old Tiger','Granite Bear',
        'Ancient Pack-Father',
      ],
      rare: [
        'Pack Hunter','Saber Patriarch',
        'Den Mother','Crag-Cat Alpha',
        'Forest Warden','Bramble Sovereign',
        'Old Bear King',
        'Ridgeline Ursine',
      ],
      legendary: ['Korr, Pack Father', 'Ironclaw the Untamed'],
    },
    spellNames: {
      common: [/* 7 */ 'Quick Bite','Trail Sense','Pack Cry','Nature\'s Mend','Branch Snare','Wild Charge','Howl'],
      uncommon: [/* 4 */ 'Hunting Volley','Lush Growth','Wild Surge','Beast Sense'],
      rare:     [/* 2 */ 'Stampede','Apex Hunt'],
    },
    minionTemplates: 'basic',
    splitBias: 0,    // balanced
  },
  // ── undead ────────────────────────────────────────────────────────
  {
    id: 'undead', tribe: 'undead', paletteHint: 'bone-grey',
    archetypes: { minion: 'undead-skeleton', spellGlyph: 'skull' },
    minionNames: {
      common: [
        'Crawling Hand','Grave Worm','Tomb Beetle','Withered Sprite',
        'Restless Skull','Bone Pup','Grave Ghoul','Shamble Husk','Cairn Wisp','Ash Ghoul',
        'Skeleton Spearman','Bone Lancer','Tomb Reaver','Crypt Slinker','Stitched Husk','Ash Walker',
        'Bone Knight','Crypt Marauder','Tombward Sentinel','Cinder Skeleton','Wraith Squire','Pale Soldier',
        'Wight Captain','Grave Brute','Withered Reaper','Veiled Cultist','Ossified Vanguard',
        'Charnel Ogre','Coffin Lord','Bonebound Behemoth','Crypt Tyrant',
        'Tomb Sovereign','Pale Warlord','Cinder Reaper',
        'Bone Colossus','Ash Throne',
      ],
      uncommon: [
        'Risen Drone','Crawler Mass',
        'Bone Pikeman','Grave Reaper','Wight Marauder',
        'Cinder Knight','Pale Champion','Ossuary Guard','Charnel Sergeant',
        'Crypt Vanguard','Bone Tyrant Spawn','Pale Vizier',
        'Coffin Marshal','Grave Sovereign','Tomb Marshal',
        'Wight Lord','Pale Warlock',
        'Ashen Patriarch',
      ],
      rare: [
        'Cinder Captain','Pale Inquisitor',
        'Crypt Warden','Bonewright Smith',
        'Charnel Marshal','Ossuary Tyrant',
        'Coffin Sovereign',
        'Wraith General',
      ],
      legendary: ['Mortis, the Cold Crown', 'Ossarion the Bone-Throne'],
    },
    spellNames: {
      common: ['Whisper','Curse Brand','Drain Touch','Soul Sip','Tomb Veil','Wither','Death Knell'],
      uncommon: ['Plague','Soul Burst','Death Pulse','Ashen Drain'],
      rare: ['Mass Wither','Soulreave'],
    },
    minionTemplates: 'basic',
    splitBias: 0,
    extraKeywordWeight: { regen: 0 }, // undead don't regen
  },
  // ── fire ──────────────────────────────────────────────────────────
  {
    id: 'fire', tribe: 'elemental', paletteHint: 'flame-orange',
    archetypes: { minion: 'elemental-fire', spellGlyph: 'flame' },
    minionNames: {
      common: [
        'Spark','Cinder Imp','Tinder Wisp','Ember Mote',
        'Flame Imp','Glowing Coal','Ash Sprite','Soot Imp','Ember Snake','Bramble Flame',
        'Salamander','Fire Lizard','Pyre Sprite','Sun Wisp','Flame Sentry','Pyre Husk',
        'Fire Magister','Ember Hound','Pyre Knight','Coal Warden','Furnace Imp','Soot Hound',
        'Sunfire Drake','Cinder Knight','Pyre Captain','Ash Knight','Flame Tyrant',
        'Volcanic Brute','Pyre Lord','Furnace Brute','Ember Ogre',
        'Flame Magister','Inferno Brute','Magma Lord',
        'Pyre Colossus','Magma Tyrant',
      ],
      uncommon: [
        'Soot Sprite','Cinder Pup',
        'Flame Acolyte','Ember Stalker','Salamander Brood',
        'Pyre Acolyte','Flame Knight','Ember Magister','Soot Knight',
        'Salamander Patriarch','Pyre Sergeant','Flame Vanguard',
        'Inferno Knight','Pyre Magister','Magma Lord',
        'Volcanic Patriarch','Sunfire Marshal',
        'Inferno Patriarch',
      ],
      rare: [
        'Pyre Patriarch','Magma Knight',
        'Cinder Tyrant','Flame Magister-Lord',
        'Volcanic Sovereign','Sunfire Tyrant',
        'Inferno Sovereign',
        'Pyre Marshal',
      ],
      legendary: ['Solenne, Ember-Crowned', 'Aurix, the Burning Forge'],
    },
    spellNames: {
      common: ['Spark','Flame Bolt','Cinder Touch','Pyre Blast','Sunflare','Ember Pulse','Flame Lash'],
      uncommon: ['Firebolt','Pyre Blast','Flame Surge','Cinder Pulse'],
      rare: ['Inferno','Pyroclasm'],
    },
    minionTemplates: 'basic',
    splitBias: 1,   // fire leans aggressive
    spellHeavy: true, // bumps spell ratio slightly
  },
  // ── frost ─────────────────────────────────────────────────────────
  {
    id: 'frost', tribe: 'elemental', paletteHint: 'ice-cyan',
    archetypes: { minion: 'elemental-frost', spellGlyph: 'crystal' },
    minionNames: {
      common: [
        'Frost Mote','Snow Pup','Icicle Sprite','Glacier Speck',
        'Frost Wisp','Hailstone Mote','Snowdrift Sprite','Ice Lizard','Sleet Imp','Glacier Sprite',
        'Frost Spearman','Ice Crawler','Sleet Marauder','Snow Sentinel','Glacier Hound','Hail Speaker',
        'Frost Knight','Glacier Captain','Sleet Magister','Ice Warden','Hail Sergeant','Snow Acolyte',
        'Frost Patriarch','Glacier Sovereign','Hail Marshal','Sleet Knight','Snow King',
        'Ice Tyrant','Glacier Lord','Hail Patriarch','Frost Sovereign',
        'Frost Throne','Glacier Tyrant','Hail Marshal-Lord',
        'Frost Colossus','Glacier Wyrm',
      ],
      uncommon: [
        'Sleet Pup','Frost Cub',
        'Snow Acolyte','Ice Stalker','Glacier Patrol',
        'Sleet Knight','Frost Sentinel','Hail Knight','Snow Vanguard',
        'Glacier Patriarch','Sleet Sergeant','Frost Vanguard',
        'Ice Lord','Snow Magister','Glacier Marshal',
        'Frost Patriarch','Sleet Marshal',
        'Hail Patriarch',
      ],
      rare: [
        'Frost Marshal','Glacier Knight',
        'Sleet Tyrant','Ice Sovereign',
        'Hail Patriarch-Lord','Snow Tyrant',
        'Glacier Magister',
        'Ice Patriarch',
      ],
      legendary: ['Vereth, Glacier Crown', 'Skadrik, the Endless Winter'],
    },
    spellNames: {
      common: ['Chill','Frost Bolt','Snowdrift','Glacial Touch','Ice Pulse','Sleet','Frost Veil'],
      uncommon: ['Freeze','Ice Surge','Hailstorm','Glacier Bolt'],
      rare: ['Blizzard','Deep Freeze'],
    },
    minionTemplates: 'basic',
    splitBias: -1,  // frost leans hp-heavy
  },
  // ── storm ─────────────────────────────────────────────────────────
  {
    id: 'storm', tribe: 'elemental', paletteHint: 'voltaic-blue',
    archetypes: { minion: 'elemental-storm', spellGlyph: 'bolt' },
    minionNames: {
      common: [
        'Spark Mote','Static Sprite','Arc Imp','Wind Speck',
        'Storm Wisp','Squall Sprite','Volt Imp','Tempest Mote','Surge Drop','Lightning Bug',
        'Storm Hound','Voltaic Marten','Surge Knight','Tempest Sentinel','Static Hawk','Squall Hound',
        'Storm Knight','Voltaic Acolyte','Surge Magister','Tempest Hound','Static Knight','Squall Knight',
        'Storm Sovereign','Voltaic Patriarch','Surge Magister-Lord','Tempest Knight','Static Tyrant',
        'Storm Patriarch','Voltaic Tyrant','Surge Knight-Lord','Tempest Sovereign',
        'Storm Marshal','Voltaic Magister','Surge Patriarch',
        'Storm Colossus','Voltaic Magister-King',
      ],
      uncommon: [
        'Static Pup','Squall Speck',
        'Storm Acolyte','Surge Stalker','Tempest Wisp',
        'Voltaic Sentinel','Storm Knight','Surge Knight','Squall Marshal',
        'Tempest Patriarch','Voltaic Magister','Storm Sergeant',
        'Surge Sovereign','Static Knight','Squall Patriarch',
        'Tempest Lord','Storm Patriarch',
        'Voltaic Crown',
      ],
      rare: [
        'Storm Marshal','Voltaic Patriarch',
        'Surge Tyrant','Tempest Sovereign',
        'Static Magister','Squall Tyrant',
        'Voltaic Knight-Lord',
        'Storm Tyrant',
      ],
      legendary: ['Volther, Storm-Crowned', 'Arclyx, the Tempest King'],
    },
    spellNames: {
      common: ['Spark','Volt Touch','Bolt','Surge','Static Flash','Squall','Tempest Cry'],
      uncommon: ['Bolt Volley','Surge Cascade','Tempest Strike','Voltaic Pulse'],
      rare: ['Storm Cascade','Voltaic Storm'],
    },
    minionTemplates: 'basic',
    splitBias: 1,
    spellHeavy: true,
  },
  // ── shadow ────────────────────────────────────────────────────────
  {
    id: 'shadow', tribe: 'shadow', paletteHint: 'shadow-violet',
    archetypes: { minion: 'humanoid-rogue', spellGlyph: 'eye' },
    minionNames: {
      common: [
        'Slip','Whisper','Hush','Footpad',
        'Shade Imp','Soot Whisper','Veiled Pup','Cloak Sprite','Sable Sprite','Sneak',
        'Shadow Stalker','Pale Rogue','Veil Walker','Cloak Marten','Sable Hound','Shade Hound',
        'Shadow Knight','Veil Acolyte','Cloak Magister','Sable Knight','Pale Marauder','Shade Knight',
        'Shadow Sovereign','Veil Patriarch','Cloak Knight-Lord','Sable Knight','Pale Sovereign',
        'Shadow Patriarch','Veil Tyrant','Cloak Sovereign','Sable Tyrant',
        'Shadow Marshal','Veil Magister','Cloak Patriarch',
        'Shadow Colossus','Veil Magister-King',
      ],
      uncommon: [
        'Slip Imp','Hush Sprite',
        'Shadow Acolyte','Veil Stalker','Cloak Wisp',
        'Sable Knight','Shadow Patrol','Veil Knight','Cloak Marshal',
        'Pale Knight','Veil Patrol','Shadow Sergeant',
        'Sable Sovereign','Veil Knight-Lord','Shadow Marshal',
        'Cloak Lord','Veil Patriarch',
        'Shadow Crown',
      ],
      rare: [
        'Shadow Marshal','Veil Patriarch',
        'Cloak Tyrant','Sable Sovereign',
        'Pale Magister','Shadow Tyrant',
        'Veil Knight-Lord',
        'Cloak Tyrant',
      ],
      legendary: ['Nyssa, the Veiled Knife', 'Murran the Hollow Step'],
    },
    spellNames: {
      common: ['Veil','Slip','Hex','Sap','Cloak','Whisper','Sable Mark'],
      uncommon: ['Eviscerate','Veil Pulse','Hex Brand','Slip Step'],
      rare: ['Assassinate','Veil of Mist'],
    },
    minionTemplates: 'basic',
    splitBias: 1,
    stealthHeavy: true,
  },
  // ── light ─────────────────────────────────────────────────────────
  {
    id: 'light', tribe: 'light', paletteHint: 'gold-cream',
    archetypes: { minion: 'humanoid-priest', spellGlyph: 'sun' },
    minionNames: {
      common: [
        'Novice','Acolyte','Postulant','Page',
        'Initiate','Lay Brother','Beadle','Devoted','Almsgiver','Sister-Penitent',
        'Cleric','Choir','Verger','Server','Reader','Catechist',
        'Templar','Crusader','Defender','Sun-Knight','Light-Bearer','Lay Knight',
        'Paladin','Lightwright','Sun-Templar','Dawn-Bearer','Hospitalier',
        'High Templar','Sun-Captain','Lightward-Knight','Dawn-Captain',
        'Solar Patriarch','High Verger','Sun-Marshal',
        'Solar Champion','Sun-Throne',
      ],
      uncommon: [
        'Novice','Postulant',
        'Server','Reader','Catechist',
        'Templar','Crusader','Defender','Hospitalier',
        'Sun-Knight','Dawn-Bearer','Lightwright',
        'High Templar','Sun-Captain','Dawn-Captain',
        'Solar Patriarch','High Verger',
        'Sun-Throne',
      ],
      rare: [
        'Sun-Captain','Lightward Knight',
        'Dawn Patriarch','Solar Magister',
        'High Templar','Sun-Marshal',
        'Solar Champion',
        'Sun Patriarch',
      ],
      legendary: ['Aurellia, Dawn-Crowned', 'Sanctus the Lightward'],
    },
    spellNames: {
      common: ['Bless','Mend','Sanctify','Light','Solar Touch','Dawn','Prayer'],
      uncommon: ['Greater Mend','Sanctify','Solar Brand','Sun Pulse'],
      rare: ['Sun-Strike','Solar Blessing'],
    },
    minionTemplates: 'basic',
    splitBias: -1,
    healHeavy: true,
  },
  // ── arcane ────────────────────────────────────────────────────────
  {
    id: 'arcane', tribe: 'arcane', paletteHint: 'arcane-purple',
    archetypes: { minion: 'humanoid-mage', spellGlyph: 'rune' },
    minionNames: {
      common: [
        'Cantripper','Apprentice','Scribe','Rune Mote',
        'Mage Initiate','Spell-Page','Scribe','Rune Imp','Glyph Mote','Cipher Sprite',
        'Mage','Wizard','Rune Knight','Glyph Marten','Cipher Hound','Scribe-Knight',
        'Magus','Archivist','Rune Sovereign','Glyph Knight','Cipher Knight','Spell-Knight',
        'Archmage','Glyph Magister','Cipher Sovereign','Rune Magister','Spell-Tyrant',
        'Cipher Magister','Rune Patriarch','Glyph Sovereign','Magus Patriarch',
        'Archmagus','Rune Knight-Lord','Cipher Patriarch',
        'Archmagus Lord','Rune Throne',
      ],
      uncommon: [
        'Cantripper','Spell-Page',
        'Scribe','Rune Imp','Cipher Mote',
        'Mage','Rune Knight','Glyph Marten','Cipher Knight',
        'Magus','Archivist','Rune Sovereign',
        'Archmage','Glyph Magister','Cipher Sovereign',
        'Archmagus','Rune Knight-Lord',
        'Archmagus Lord',
      ],
      rare: [
        'Archmage','Glyph Magister',
        'Cipher Sovereign','Rune Patriarch',
        'Archmagus','Cipher Patriarch',
        'Spell-Throne',
        'Rune Throne',
      ],
      legendary: ['Mirelle, the Spelled-Crown', 'Veraxis the Cipher-Lord'],
    },
    spellNames: {
      common: ['Spark','Cantrip','Rune Bolt','Glyph','Cipher','Page Turn','Rune Touch'],
      uncommon: ['Arcane Bolt','Page of Power','Rune Cascade','Cipher Storm'],
      rare: ['Polymorph','Arcane Storm'],
    },
    minionTemplates: 'basic',
    splitBias: -1,
    drawHeavy: true,
  },
  // ── wild ──────────────────────────────────────────────────────────
  {
    id: 'wild', tribe: 'beast', paletteHint: 'leaf-green',
    archetypes: { minion: 'humanoid-warrior', flyer: 'beast-bird', spellGlyph: 'leaf' },
    minionNames: {
      common: [
        'Forester','Sapling','Trapper','Acorn Sprite',
        'Ranger','Tracker','Druid Initiate','Sapling Spirit','Hollow Sprite','Vine Mote',
        'Wilds Knight','Glade Marten','Forester','Hollow Marten','Druid','Sap-Knight',
        'Ranger Captain','Druid','Sap-Magister','Hollow Knight','Vine Knight','Forester-Lord',
        'Glade Patriarch','Druid Magister','Sap Sovereign','Hollow Patriarch','Vine Patriarch',
        'Wilds Patriarch','Sap Tyrant','Hollow Tyrant','Vine Tyrant',
        'Wilds Marshal','Glade Magister','Sap Patriarch',
        'Wilds Colossus','Glade Throne',
      ],
      uncommon: [
        'Sapling','Acorn Sprite',
        'Tracker','Druid Initiate','Hollow Sprite',
        'Wilds Knight','Glade Marten','Hollow Marten','Sap-Knight',
        'Druid','Sap Sovereign','Hollow Patriarch',
        'Glade Patriarch','Druid Magister','Vine Patriarch',
        'Wilds Patriarch','Glade Magister',
        'Wilds Crown',
      ],
      rare: [
        'Glade Patriarch','Druid Magister',
        'Sap Sovereign','Hollow Sovereign',
        'Vine Sovereign','Wilds Tyrant',
        'Wilds Marshal',
        'Glade Throne',
      ],
      legendary: ['Verdelle, Glade-Crowned', 'Hollow King of the Vines'],
    },
    spellNames: {
      common: ['Vine','Sapling','Glade Touch','Hollow Mend','Branch Snare','Wild Surge','Lush Pulse'],
      uncommon: ['Verdant Pulse','Glade Strike','Hollow Roar','Wild Charge'],
      rare: ['Stampede','Vine Storm'],
    },
    minionTemplates: 'basic',
    splitBias: 0,
  },
  // ── forge ─────────────────────────────────────────────────────────
  {
    id: 'forge', tribe: 'construct', paletteHint: 'iron-grey',
    archetypes: { minion: 'construct-golem', mech: 'construct-mech', spellGlyph: 'gear' },
    minionNames: {
      common: [
        'Brass Cog','Iron Hand','Tin Buzzer','Pin Sprite',
        'Smith\'s Hand','Forge Imp','Anvil Sprite','Brass Marten','Iron Pup','Hammer Sprite',
        'Forgewright','Brass Knight','Iron Hound','Anvil Knight','Pin Knight','Smith-Knight',
        'Iron Patriarch','Brass Magister','Anvil Sovereign','Forge Knight','Smith Sovereign','Pin Magister',
        'Forge Tyrant','Iron Sovereign','Anvil Patriarch','Brass Sovereign','Smith Patriarch',
        'Forge Patriarch','Iron Tyrant','Brass Tyrant','Anvil Tyrant',
        'Forge Marshal','Iron Magister','Brass Patriarch',
        'Iron Colossus','Forge Throne',
      ],
      uncommon: [
        'Pin Sprite','Brass Cog',
        'Forge Imp','Anvil Sprite','Iron Pup',
        'Forgewright','Brass Knight','Iron Hound','Smith-Knight',
        'Iron Patriarch','Brass Magister','Forge Knight',
        'Forge Tyrant','Iron Sovereign','Brass Sovereign',
        'Forge Patriarch','Iron Tyrant',
        'Forge Crown',
      ],
      rare: [
        'Forge Patriarch','Iron Tyrant',
        'Brass Sovereign','Anvil Patriarch',
        'Smith Patriarch','Forge Sovereign',
        'Iron Magister',
        'Forge Throne',
      ],
      legendary: ['Galvon, the Forge-Crowned', 'Brassix, Iron-Throne'],
    },
    spellNames: {
      common: ['Spark','Brand','Hammer','Anvil','Pin','Brace','Reinforce'],
      uncommon: ['Forge Brand','Iron Brace','Brass Reinforce','Anvil Drop'],
      rare: ['Anvil Strike','Forge Storm'],
    },
    minionTemplates: 'basic',
    splitBias: -1,
    buffHeavy: true,
  },
  // ── goblin ────────────────────────────────────────────────────────
  {
    id: 'goblin', tribe: 'goblin', paletteHint: 'goblin-green',
    archetypes: { minion: 'humanoid-rogue', spellGlyph: 'bomb' },
    minionNames: {
      common: [
        'Goblin Runt','Goblin Sneak','Goblin Pup','Goblin Speck',
        'Goblin Scrapper','Goblin Mauler','Goblin Tinker','Goblin Sapper','Goblin Shaman','Goblin Imp',
        'Goblin Knight','Goblin Sergeant','Goblin Marauder','Goblin Magister','Goblin Hound','Goblin Lurker',
        'Goblin Captain','Goblin Knight','Goblin Patriarch','Goblin Hound-Lord','Goblin Magister-Lord','Goblin Sergeant',
        'Goblin Tyrant','Goblin Sovereign','Goblin Patriarch','Goblin Marshal','Goblin Knight-Lord',
        'Goblin Magister','Goblin Sovereign','Goblin Tyrant','Goblin Patriarch-Lord',
        'Goblin Marshal','Goblin Magister-Lord','Goblin Patriarch',
        'Goblin Colossus','Goblin Throne',
      ],
      uncommon: [
        'Goblin Sapper','Goblin Tinker',
        'Goblin Marauder','Goblin Hound','Goblin Imp',
        'Goblin Knight','Goblin Sergeant','Goblin Magister','Goblin Sapper-Lord',
        'Goblin Captain','Goblin Sovereign','Goblin Patriarch',
        'Goblin Tyrant','Goblin Marshal','Goblin Knight-Lord',
        'Goblin Magister-Lord','Goblin Patriarch-Lord',
        'Goblin Crown',
      ],
      rare: [
        'Goblin Sovereign','Goblin Patriarch',
        'Goblin Tyrant','Goblin Marshal',
        'Goblin Magister-Lord','Goblin Knight-Lord',
        'Goblin Throne',
        'Goblin Patriarch-Lord',
      ],
      legendary: ['Sapper-King Gnarl', 'Warchief Vrok'],
    },
    spellNames: {
      common: ['Boom','Powder','Spark','Pickpocket','Smash','Stab','Trip Wire'],
      uncommon: ['Goblin Powder','Sapper Trap','Mauler Cry','Tinker\'s Brand'],
      rare: ['Goblin Stampede','Sapper Storm'],
    },
    minionTemplates: 'basic',
    splitBias: 1,
    chargeHeavy: true,
  },
  // ── dragon ────────────────────────────────────────────────────────
  {
    id: 'dragon', tribe: 'dragon', paletteHint: 'dragon-crimson',
    archetypes: { minion: 'dragon-flier', spellGlyph: 'dragon' },
    minionNames: {
      common: [
        'Dragon Hatchling','Wyrm Pup','Drake Whelp','Drake Imp',
        'Wyrmling','Drake Pup','Drake Sprite','Wyrmling Knight','Drake Imp-Lord','Wyrm Imp',
        'Drake Knight','Wyrm Knight','Drakelet','Wyrmward','Drake-Marten','Wyrm-Marten',
        'Drake Magister','Wyrm Magister','Drake Sovereign','Wyrm Sovereign','Drake Patriarch','Wyrm Patriarch',
        'Drake Tyrant','Wyrm Tyrant','Drake Patriarch','Wyrm Magister-Lord','Drake Magister-Lord',
        'Drake Throne','Wyrm Throne','Drake Sovereign-Lord','Wyrm Sovereign-Lord',
        'Drake Patriarch-Lord','Wyrm Patriarch-Lord','Drake Marshal',
        'Drake Colossus','Wyrm Colossus',
      ],
      uncommon: [
        'Drake Whelp','Wyrm Whelp',
        'Drake Pup','Wyrmling','Drake Imp',
        'Drake Knight','Wyrm Knight','Drake-Marten','Wyrm-Marten',
        'Drake Magister','Wyrm Magister','Drake Sovereign',
        'Drake Tyrant','Wyrm Tyrant','Drake Patriarch',
        'Drake Patriarch-Lord','Wyrm Patriarch-Lord',
        'Drake Throne',
      ],
      rare: [
        'Drake Patriarch','Wyrm Patriarch',
        'Drake Sovereign','Wyrm Sovereign',
        'Drake Magister-Lord','Wyrm Magister-Lord',
        'Drake Throne',
        'Wyrm Throne',
      ],
      legendary: ['Drakarion, the Crimson Wyrm', 'Vorath the Sky-Crowned'],
    },
    spellNames: {
      common: ['Breath','Wyrm Sigh','Flame Sigh','Wing Beat','Dragon Mark','Drake Pulse','Drake Cry'],
      uncommon: ['Dragon Breath','Wyrm Surge','Drake Brand','Drake Strike'],
      rare: ['Dragonfire','Wyrm Storm'],
    },
    minionTemplates: 'basic',
    splitBias: 1,
    bigHeavy: true,
  },
  // ── demon ─────────────────────────────────────────────────────────
  {
    id: 'demon', tribe: 'demon', paletteHint: 'demon-magenta',
    archetypes: { minion: 'demon-fiend', spellGlyph: 'pact' },
    minionNames: {
      common: [
        'Imp','Fiendlet','Pact Mote','Hex Speck',
        'Fiend','Pact Imp','Hex Imp','Demon-Pup','Pact Sprite','Hex Sprite',
        'Demon Knight','Fiend Knight','Pact Knight','Hex Knight','Demon-Marten','Fiend-Marten',
        'Demon Magister','Fiend Magister','Pact Magister','Hex Magister','Demon Sovereign','Fiend Sovereign',
        'Demon Tyrant','Fiend Tyrant','Pact Tyrant','Hex Tyrant','Demon Patriarch',
        'Demon Throne','Fiend Throne','Pact Sovereign','Hex Sovereign',
        'Demon Patriarch','Fiend Patriarch','Pact Patriarch',
        'Demon Colossus','Fiend Throne-Lord',
      ],
      uncommon: [
        'Imp','Fiendlet',
        'Pact Imp','Hex Imp','Demon Pup',
        'Demon Knight','Fiend Knight','Pact Knight','Hex Knight',
        'Demon Magister','Fiend Magister','Pact Magister',
        'Demon Tyrant','Fiend Tyrant','Pact Tyrant',
        'Demon Patriarch','Fiend Patriarch',
        'Demon Crown',
      ],
      rare: [
        'Demon Patriarch','Fiend Patriarch',
        'Pact Sovereign','Hex Sovereign',
        'Demon Throne','Fiend Throne-Lord',
        'Pact Throne',
        'Demon Crown',
      ],
      legendary: ['Lukress, Pact-Bound Queen', 'Maelos the Hex-Crowned'],
    },
    spellNames: {
      common: ['Pact','Hex','Brand','Soul Sip','Pact Touch','Hex Mark','Soul Brand'],
      uncommon: ['Pact Storm','Hex Pulse','Soul Brand','Pact Strike'],
      rare: ['Soul Reave','Hex Storm'],
    },
    minionTemplates: 'basic',
    splitBias: 1,
    selfDamageHeavy: true,
  },
  // ── fae ───────────────────────────────────────────────────────────
  {
    id: 'fae', tribe: 'fae', paletteHint: 'fae-rose',
    archetypes: { minion: 'beast-bird', spellGlyph: 'star' },
    minionNames: {
      common: [
        'Pixie','Sprite','Mote','Wisp',
        'Pixie','Sprite-Knight','Faerie','Wisp-Knight','Mote-Knight','Fae-Imp',
        'Fae Knight','Sprite-Magister','Pixie Magister','Wisp Knight','Mote Sovereign','Fae-Marten',
        'Fae Magister','Sprite Sovereign','Pixie Sovereign','Wisp Magister','Mote Tyrant','Fae Tyrant',
        'Fae Patriarch','Sprite Tyrant','Pixie Tyrant','Wisp Tyrant','Mote Patriarch',
        'Fae Throne','Sprite Throne','Pixie Throne','Wisp Throne',
        'Fae Patriarch','Sprite Patriarch','Pixie Patriarch',
        'Fae Colossus','Sprite Colossus',
      ],
      uncommon: [
        'Pixie','Sprite',
        'Mote','Wisp','Fae-Imp',
        'Fae Knight','Sprite Knight','Pixie Knight','Wisp Knight',
        'Fae Magister','Sprite Magister','Pixie Magister',
        'Fae Tyrant','Sprite Tyrant','Pixie Tyrant',
        'Fae Patriarch','Sprite Patriarch',
        'Fae Crown',
      ],
      rare: [
        'Fae Patriarch','Sprite Patriarch',
        'Pixie Sovereign','Wisp Sovereign',
        'Mote Patriarch','Fae Sovereign',
        'Sprite Throne',
        'Fae Crown',
      ],
      legendary: ['Faelin, Star-Crowned', 'Sylvaris the Hollow Bloom'],
    },
    spellNames: {
      common: ['Charm','Sparkle','Mote','Wisp','Pixie Touch','Sprite Pulse','Charm Touch'],
      uncommon: ['Mass Charm','Pixie Surge','Sprite Brand','Wisp Cascade'],
      rare: ['Faerie Storm','Charm Storm'],
    },
    minionTemplates: 'basic',
    splitBias: 0,
    wispHeavy: true,
  },
  // ── vault ─────────────────────────────────────────────────────────
  {
    id: 'vault', tribe: 'vault', paletteHint: 'vault-gold',
    archetypes: { minion: 'humanoid-rogue', spellGlyph: 'key' },
    minionNames: {
      common: [
        'Apprentice Hunter','Vault Mote','Treasure Sprite','Key Sprite',
        'Vault Imp','Treasure Knight','Key Knight','Vault Sprite','Treasure-Pup','Vault Pup',
        'Vault Knight','Treasure Magister','Key Magister','Vault-Marten','Treasure-Marten','Vault Marten',
        'Vault Magister','Treasure Sovereign','Key Sovereign','Vault Sovereign','Treasure Patriarch','Vault Patriarch',
        'Vault Tyrant','Treasure Tyrant','Key Tyrant','Vault Patriarch','Treasure Patriarch',
        'Vault Throne','Treasure Throne','Key Throne','Vault Sovereign-Lord',
        'Vault Patriarch','Treasure Patriarch-Lord','Key Patriarch',
        'Vault Colossus','Treasure Colossus',
      ],
      uncommon: [
        'Vault Imp','Treasure Sprite',
        'Vault Sprite','Key Sprite','Treasure Pup',
        'Vault Knight','Treasure Magister','Key Magister','Vault-Marten',
        'Vault Magister','Treasure Sovereign','Key Sovereign',
        'Vault Tyrant','Treasure Tyrant','Key Tyrant',
        'Vault Patriarch','Treasure Patriarch',
        'Vault Crown',
      ],
      rare: [
        'Vault Patriarch','Treasure Patriarch',
        'Key Sovereign','Vault Sovereign-Lord',
        'Vault Magister-Lord','Treasure Magister-Lord',
        'Vault Throne',
        'Treasure Throne',
      ],
      legendary: ['Calderon, Vault-Crowned', 'Aurellis the Key-Sovereign'],
    },
    spellNames: {
      common: ['Pry','Dig','Mark','Vault Touch','Treasure Touch','Key Touch','Vault Mark'],
      uncommon: ['Vault Pulse','Treasure Surge','Key Cascade','Vault Brand'],
      rare: ['Vault Storm','Treasure Strike'],
    },
    minionTemplates: 'basic',
    splitBias: -1,
    drawHeavy: true,
  },
];

// ── Generator ────────────────────────────────────────────────────────

function pickTemplate(templates, idx, mana) {
  // Walk the template list with wraparound; respect `if` predicates.
  for (let attempt = 0; attempt < templates.length; attempt++) {
    const t = templates[(idx + attempt) % templates.length];
    if (t.if && !t.if(mana)) continue;
    return t;
  }
  return templates[0];
}

function makeMinion({ id, name, rarity, family, mana, template, splitBias = 0, tribe }) {
  const abilities = (template.abilities || []).map(a => ({ ...a }));
  const keywords = (template.keywords || []).slice();
  const { atk, hp } = statsFromBudget(mana, rarity, abilities, keywords, splitBias);
  // Patch onDeath summon cardId to the family's tribe token if unset.
  for (const a of abilities) {
    if (a.effect === 'summon' && a.cardId == null) a.cardId = 'tok.' + family + '.swarm';
  }
  return {
    id, name, rarity, type: 'minion', mana, atk, hp,
    keywords, abilities,
    text: textForMinion(template, atk, hp, mana),
    tribe,
    family,
    visualArchetype: null,   // filled by buildFamily caller
  };
}

function makeSpell({ id, name, rarity, family, template, tribe }) {
  const ab = { trigger: 'onCast', ...template };
  delete ab.mana;
  return {
    id, name, rarity, type: 'spell', mana: template.mana,
    keywords: [],
    abilities: [ab],
    text: textForSpell(template),
    tribe,
    family,
    visualArchetype: null,
  };
}

function textForMinion(t, atk, hp, mana) {
  const bits = [];
  for (const k of t.keywords || []) bits.push(({
    taunt: 'Taunt', charge: 'Charge', shield: 'Shield', stealth: 'Stealth',
    lifesteal: 'Lifesteal', poison: 'Poison', reach: 'Reach', rush: 'Rush',
    regen: 'Regen', wisp: 'Wisp', 'divine-light': 'Divine Light',
    'spell-immune': 'Spell Immune',
  }[k] || k));
  for (const a of t.abilities || []) {
    bits.push(abilityText(a));
  }
  return bits.join(' · ');
}

function textForSpell(t) { return abilityText(t); }

function abilityText(a) {
  const trig = a.trigger === 'onCast' ? '' : ({
    onPlay: 'Battlecry: ', onDeath: 'Deathrattle: ',
    endOfTurn: 'End of turn: ', onAttack: 'On attack: ',
  }[a.trigger] || '');
  let body = '';
  switch (a.effect) {
    case 'damage': body = `deal ${a.value} damage` + targetText(a.target); break;
    case 'heal':   body = `heal ${a.value}` + targetText(a.target); break;
    case 'draw':   body = `draw ${a.value} card${a.value > 1 ? 's' : ''}`; break;
    case 'buff':   body = `give ${targetText(a.target).trim() || 'a target'} +${a.valueAtk || 0}/+${a.valueHp || 0}`; break;
    case 'summon': body = `summon a token`; break;
    case 'destroy':body = `destroy ${targetText(a.target).trim() || 'target'}`; break;
    case 'freeze': body = `freeze ${targetText(a.target).trim() || 'target'}`; break;
    default: body = a.effect;
  }
  return trig + body + '.';
}

function targetText(t) {
  switch (t) {
    case 'pickedTarget':       return ' to any target';
    case 'oppHero':            return ' to enemy hero';
    case 'selfHero':           return ' to your hero';
    case 'allEnemyMinions':    return ' to all enemy minions';
    case 'allFriendlyMinions': return ' to all friendly minions';
    case 'randomEnemyMinion':  return ' to a random enemy';
    case 'randomFriendlyMinion': return ' to a random friend';
    default: return '';
  }
}

// ── Build a family's cards ───────────────────────────────────────────

function buildFamily(fam, famIndex) {
  const out = [];
  const tribe = fam.tribe;
  const archetypeM = fam.archetypes.minion || 'humanoid-warrior';
  const archetypeF = fam.archetypes.flyer || archetypeM;
  const archetypeS = 'spell-' + (fam.archetypes.spellGlyph || 'circle');
  // Each family rotates which 2 of the 8 legendary templates it uses.
  const legBase = (famIndex * 2) % MINION_TEMPLATES_LEGENDARY.length;

  for (const rarity of ['common', 'uncommon', 'rare', 'legendary']) {
    const minionNames = fam.minionNames?.[rarity] || [];
    const spellNames  = fam.spellNames?.[rarity] || [];
    // For commons: pull mana from COMMON_MANA, similarly for others.
    const manaList = rarity === 'common' ? COMMON_MANA
                   : rarity === 'uncommon' ? UNCOMMON_MANA
                   : rarity === 'rare' ? RARE_MANA
                   : LEGENDARY_MANA;
    // Total cards at this rarity = minionNames.length. Spell count from spellNames.
    const totalMinions = minionNames.length;
    const spellCount = Math.min(spellNames.length, rarity === 'common' ? 7 : rarity === 'uncommon' ? 4 : 2);
    // Spells take the LAST `spellCount` slots' mana; minions take the rest.
    const minionMana = manaList.slice(0, totalMinions);
    const minionTemplates = rarity === 'legendary'
      ? MINION_TEMPLATES_LEGENDARY
      : (MINION_TEMPLATES_BASIC[rarity] || MINION_TEMPLATES_BASIC.common);

    // Minions
    for (let i = 0; i < totalMinions; i++) {
      const name = minionNames[i];
      if (!name) continue;
      const mana = minionMana[i] || 4;
      // For legendaries, rotate template selection per family so each
      // family's two legendaries pick a different pair from the pool.
      const tIdx = rarity === 'legendary' ? (legBase + i) % MINION_TEMPLATES_LEGENDARY.length : i;
      const template = pickTemplate(minionTemplates, tIdx, mana);
      const id = `${fam.id}.${rarity[0]}${String(i + 1).padStart(3, '0')}`;
      const minion = makeMinion({ id, name, rarity, family: fam.id, mana, template, splitBias: fam.splitBias || 0, tribe });
      // Visual archetype hint — flyers for high-mana dragons + fae.
      if (fam.id === 'dragon' || fam.id === 'fae') minion.visualArchetype = mana >= 5 ? archetypeF : archetypeM;
      else minion.visualArchetype = archetypeM;
      out.push(minion);
    }

    // Spells (separate ID block to avoid collision: `<fam>.<rarity>s001` etc.)
    if (rarity !== 'legendary') {
      const sTemplates = SPELL_TEMPLATES[rarity] || SPELL_TEMPLATES.common;
      for (let j = 0; j < spellCount; j++) {
        const name = spellNames[j];
        if (!name) continue;
        const template = sTemplates[j % sTemplates.length];
        const id = `${fam.id}.${rarity[0]}s${String(j + 1).padStart(2, '0')}`;
        const spell = makeSpell({ id, name, rarity, family: fam.id, template, tribe });
        spell.visualArchetype = archetypeS;
        out.push(spell);
      }
    }
  }

  // One token per family — used by onDeath:summon templates.
  out.push({
    id: `tok.${fam.id}.swarm`,
    name: `${fam.id.charAt(0).toUpperCase() + fam.id.slice(1)} Swarm`,
    rarity: 'token', type: 'minion',
    mana: 0, atk: 1, hp: 1,
    keywords: ['charge'],
    abilities: [],
    text: 'Charge.',
    tribe,
    family: fam.id,
    token: true,
    visualArchetype: archetypeM,
  });

  return out;
}

// ── Export the full expansion ────────────────────────────────────────

export const EXPANSION_FAMILIES = FAMILIES.map(f => ({ id: f.id, tribe: f.tribe, paletteHint: f.paletteHint, archetypes: f.archetypes }));

export const EXPANSION_CARDS = (function build() {
  const all = [];
  for (let i = 0; i < FAMILIES.length; i++) all.push(...buildFamily(FAMILIES[i], i));
  // Name dedupe — across the whole expansion (a "Pack Knight" should
  // only exist once even if multiple families/lists supply it).
  // Adds Roman numeral suffix II, III etc. when duplicates appear.
  const seenNames = new Map();        // name -> count
  const toRoman = (n) => ['', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'][n] || `+${n}`;
  for (const c of all) {
    const n = (seenNames.get(c.name) || 0) + 1;
    seenNames.set(c.name, n);
    if (n > 1) c.name = `${c.name} ${toRoman(n)}`;
  }
  return all;
})();

// Sanity check at module load.
(function dedupe() {
  const ids = new Set();
  const names = new Set();
  for (const c of EXPANSION_CARDS) {
    if (ids.has(c.id)) throw new Error('cards-expansion.js: duplicate id ' + c.id);
    ids.add(c.id);
    if (names.has(c.name)) throw new Error('cards-expansion.js: duplicate name (post-dedupe) ' + c.name);
    names.add(c.name);
  }
})();
