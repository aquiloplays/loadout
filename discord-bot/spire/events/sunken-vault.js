// Sunken Vault, water, drowned treasure, eel-priests, kelp-grown stone.
// 5 events: 1 pure upside, 3 tradeoff, 1 gamble.

export const SUNKEN_VAULT_EVENTS = Object.freeze([
  {
    id: 'drowned-chest',
    name: 'The Drowned Chest',
    description:
      "An iron-bound chest sits half-buried in silt. The lock has long since rusted away. Something inside ticks, slowly.",
    choices: [
      {
        id: 'open',
        label: 'Open it',
        outcomes: [
          { weight: 55, effect: { type: 'bolts_gain', amount: 40 },     text: 'Gold coins tumble out, 40 bolts.' },
          { weight: 30, effect: { type: 'relic_grant', tier: 'minor' }, text: 'A barnacled clockwork heart, still beating. Minor relic.' },
          { weight: 15, effect: { type: 'hp_loss', amount: 10 },         text: 'The chest snaps shut on your hand. (-10 HP)' },
        ],
      },
      {
        id: 'leave',
        label: 'Leave it',
        outcomes: [
          { weight: 100, effect: { type: 'none' }, text: 'You walk on. The ticking follows you for a while.' },
        ],
      },
    ],
  },
  {
    id: 'eel-priest',
    name: 'The Eel-Priest',
    description:
      "A long, robed figure with the smooth head of a moray eel offers to bless your deck, but warns that the sea takes as it gives.",
    choices: [
      {
        id: 'accept',
        label: 'Receive the blessing',
        outcomes: [
          { weight: 65, effect: { type: 'card_upgrade', count: 2 },          text: 'Two cards take on a salt-rimed sheen and grow keener.' },
          { weight: 35, effect: { type: 'card_remove', criteria: 'random' }, text: 'A card dissolves into seafoam.' },
        ],
      },
      {
        id: 'offer-coin',
        label: 'Offer coin in tribute',
        outcomes: [
          { weight: 100, effect: { type: 'bolts_loss', amount: 25 }, text: 'You drop 25 bolts in the basin. The priest bows. Nothing more happens.' },
        ],
      },
      {
        id: 'mock',
        label: 'Mock him',
        outcomes: [
          { weight: 100, effect: { type: 'none' }, text: 'He stares. You leave. Your spine does not stop crawling.' },
        ],
      },
    ],
  },
  {
    id: 'kelp-altar',
    name: 'The Kelp Altar',
    description:
      "An altar of black stone is wrapped in living kelp. Coins, teeth, and tiny bones lie heaped on it. A faint hymn rises from the water.",
    choices: [
      {
        id: 'donate',
        label: 'Add 30 bolts to the pile',
        outcomes: [
          { weight: 100, effect: { type: 'relic_grant', tier: 'minor' }, text: 'The kelp parts; a small barnacled trinket rises into your palm.' },
        ],
      },
      {
        id: 'donate-much',
        label: 'Add 80 bolts',
        outcomes: [
          { weight: 75, effect: { type: 'relic_grant', tier: 'major' }, text: 'The altar groans open and offers a major relic.' },
          { weight: 25, effect: { type: 'relic_grant', tier: 'minor' }, text: 'The altar accepts but offers only a minor relic. The sea is fickle.' },
        ],
      },
      {
        id: 'steal',
        label: 'Take coins from the pile',
        outcomes: [
          { weight: 60, effect: { type: 'bolts_gain', amount: 35 }, text: 'You grab a fistful. The hymn falters but does not stop. (+35 bolts)' },
          { weight: 40, effect: { type: 'hp_loss', amount: 12 },    text: 'A kelp tendril whips your ankle. (-12 HP)' },
        ],
      },
    ],
  },
  {
    id: 'pearl-diver',
    name: 'The Pearl Diver',
    description:
      "A woman with gills along her neck offers to dive for a pearl on your behalf, for a fee.",
    choices: [
      {
        id: 'pay-small',
        label: 'Pay 15 bolts',
        outcomes: [
          { weight: 70, effect: { type: 'card_grant', rarity: 'uncommon' }, text: 'She surfaces with a small pearl that becomes a card.' },
          { weight: 30, effect: { type: 'none' },                            text: 'She surfaces empty-handed and apologetic.' },
        ],
      },
      {
        id: 'pay-big',
        label: 'Pay 50 bolts',
        outcomes: [
          { weight: 80, effect: { type: 'card_grant', rarity: 'epic' }, text: 'She comes up with a black pearl the size of a fist.' },
          { weight: 20, effect: { type: 'card_grant', rarity: 'rare' },  text: 'She returns with a smaller pearl than promised, still good.' },
        ],
      },
      {
        id: 'decline',
        label: 'Decline',
        outcomes: [
          { weight: 100, effect: { type: 'none' }, text: 'She nods and slips back into the dark water.' },
        ],
      },
    ],
  },
  {
    id: 'tide-warden',
    name: 'The Tide-Warden',
    description:
      "A statue of a kraken-eyed warden stands at a crossroads of flooded halls. Its hands hold an empty bowl.",
    choices: [
      {
        id: 'bolts-offering',
        label: 'Drop 20 bolts in the bowl',
        outcomes: [
          { weight: 100, effect: { type: 'buff', name: 'tide-favor', floors: 4 }, text: 'Tide Favor: enemy mages spend 1 extra mana for 4 floors.' },
        ],
      },
      {
        id: 'blood-offering',
        label: 'Cut your hand into the bowl',
        outcomes: [
          { weight: 70, effect: { type: 'relic_grant', tier: 'major' }, text: 'The statue blinks, and a kraken-eye sigil lands in your hand.' },
          { weight: 30, effect: { type: 'hp_loss', amount: 15 },         text: 'The bowl drinks more than you gave. (-15 HP)' },
        ],
      },
    ],
  },
]);
