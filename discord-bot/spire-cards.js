// Boltbound — Seasonal Spire exclusive cards.
//
// One legendary minion per Spire season — only granted to a player
// when they boss-clear that season's spire (first-time only). After
// the season rotates, the card stays in the player's collection but
// is no longer obtainable.
//
// Plus the season tokens (e.g. Verdant Hollow's thorn vine) that boss
// mechanics summon. Tokens are not pullable / not in decks.
//
// Naming convention: `spire.s<NN>.<slug>` — s01-s12, slug from the
// season's seasonalExclusiveCard reference in spire-seasons.js.

// Legendary minions — boss-clear rewards.
export const SPIRE_LEGENDARIES = [
  {
    id: 'spire.s01.embercrown',
    name: 'Embercrown Vassal',
    type: 'minion',
    mana: 6, atk: 5, hp: 6,
    keywords: ['charge'],
    abilities: [{ trigger: 'onPlay', effect: 'damage', target: 'allEnemyMinions', value: 2 }],
    text: 'Charge. Battlecry: deal 2 damage to all enemy minions.',
  },
  {
    id: 'spire.s02.aurorablade',
    name: 'Aurorablade Sentinel',
    type: 'minion',
    mana: 5, atk: 4, hp: 5,
    keywords: ['spell-immune'],
    abilities: [{ trigger: 'onPlay', effect: 'draw', value: 2 }],
    text: 'Cannot be targeted by spells. Battlecry: draw 2 cards.',
  },
  {
    id: 'spire.s03.tidescepter',
    name: 'Tidescepter Marauder',
    type: 'minion',
    mana: 7, atk: 6, hp: 6,
    abilities: [{ trigger: 'onPlay', effect: 'returnToHand', target: 'allEnemyMinions' }],
    text: 'Battlecry: return all enemy minions to their owner\'s hand.',
  },
  {
    id: 'spire.s04.hollowheart',
    name: 'Hollowheart Druid',
    type: 'minion',
    mana: 4, atk: 3, hp: 5,
    keywords: ['taunt'],
    abilities: [{ trigger: 'onPlay', effect: 'summon', value: 2,
                  token: { id: 'spire.token.thorn' } }],
    text: 'Taunt. Battlecry: summon two Thorn Vines (1/2 taunt).',
  },
  {
    id: 'spire.s05.duneturban',
    name: 'Duneturban Sphinx',
    type: 'minion',
    mana: 6, atk: 5, hp: 5,
    abilities: [{ trigger: 'endOfTurn', effect: 'damage', target: 'randomEnemyMinion', value: 1 }],
    text: 'At end of your turn, deal 1 damage to a random enemy minion.',
  },
  {
    id: 'spire.s06.permafrost',
    name: 'Permafrost Lich',
    type: 'minion',
    mana: 7, atk: 5, hp: 7,
    abilities: [{ trigger: 'onPlay', effect: 'freeze', target: 'allEnemyMinions' }],
    text: 'Battlecry: freeze all enemy minions.',
  },
  {
    id: 'spire.s07.cogheart',
    name: 'Cogheart Maestro',
    type: 'minion',
    mana: 5, atk: 4, hp: 4,
    abilities: [{ trigger: 'onPlay', effect: 'doubleBattlecry', target: 'lastFriendly' }],
    text: 'Battlecry: copy the most recent battlecry triggered this turn.',
  },
  {
    id: 'spire.s08.silvermask',
    name: 'Silvermask Twin',
    type: 'minion',
    mana: 4, atk: 4, hp: 4,
    abilities: [{ trigger: 'onPlay', effect: 'cloneSelf' }],
    text: 'Battlecry: summon an exact copy of itself.',
  },
  {
    id: 'spire.s09.relicspine',
    name: 'Relicspine Reaver',
    type: 'minion',
    mana: 6, atk: 6, hp: 4,
    keywords: ['lifesteal'],
    abilities: [{ trigger: 'onDeath', effect: 'reSummon', value: 1 }],
    text: 'Lifesteal. Deathrattle: re-summon with -1 attack.',
  },
  {
    id: 'spire.s10.apexorb',
    name: 'Apexorb Tyrant',
    type: 'minion',
    mana: 8, atk: 8, hp: 8,
    abilities: [{ trigger: 'onPlay', effect: 'damage', target: 'allEnemies', value: 3 }],
    text: 'Battlecry: deal 3 damage to all enemies (minions + hero).',
  },
  {
    id: 'spire.s11.starcharter',
    name: 'Starcharter Magus',
    type: 'minion',
    mana: 5, atk: 3, hp: 5,
    abilities: [{ trigger: 'onPlay', effect: 'revealAndDraw', value: 3 }],
    text: 'Battlecry: look at the top 3 cards of your deck. Draw one.',
  },
  {
    id: 'spire.s12.crimsongoblet',
    name: 'Crimsongoblet Marquise',
    type: 'minion',
    mana: 6, atk: 4, hp: 6,
    keywords: ['lifesteal'],
    abilities: [{ trigger: 'onAttack', effect: 'heal', target: 'self', value: 2 }],
    text: 'Lifesteal. After this attacks, restore 2 HP to itself.',
  },
];

// Tokens summoned by spire effects or seasonal cards. Cannot be pulled
// or appear in decks (token:true gates packs + deckbuilder).
export const SPIRE_TOKENS = [
  { id: 'spire.token.thorn',  name: 'Thorn Vine',  mana: 0, atk: 1, hp: 2, type: 'minion', token: true, keywords: ['taunt'] },
  { id: 'spire.token.ember',  name: 'Ember Mote',   mana: 0, atk: 2, hp: 1, type: 'minion', token: true, keywords: ['charge'] },
  { id: 'spire.token.frost',  name: 'Frost Shard',  mana: 0, atk: 1, hp: 3, type: 'minion', token: true },
];

// Convenience map of cardId → which spire season (themeId) the card
// belongs to. Used by the reward grant path to confirm a player
// owns this season's exclusive (gates the second-clear logic).
export const SPIRE_EXCLUSIVE_BY_THEME = Object.freeze({
  'ember-court':       'spire.s01.embercrown',
  'aurora-spire':      'spire.s02.aurorablade',
  'sunken-vault':      'spire.s03.tidescepter',
  'verdant-hollow':    'spire.s04.hollowheart',
  'sandstorm-bazaar':  'spire.s05.duneturban',
  'frost-citadel':     'spire.s06.permafrost',
  'clockwork-foundry': 'spire.s07.cogheart',
  'mirror-garden':     'spire.s08.silvermask',
  'bone-reliquary':    'spire.s09.relicspine',
  'cinder-apex':       'spire.s10.apexorb',
  'stargazer-court':   'spire.s11.starcharter',
  'velvet-catacomb':   'spire.s12.crimsongoblet',
});
