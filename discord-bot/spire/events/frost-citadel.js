// Frost Citadel, ice, snow, glacier-knights, frozen hearts.
// 5 events: 1 pure upside, 3 tradeoff, 1 gamble.

export const FROST_CITADEL_EVENTS = Object.freeze([
  {
    id: 'glacier-knight',
    name: 'The Glacier Knight',
    description:
      "A knight stands frozen in a slab of perfectly clear ice. Their hand rests on the hilt of a sword. The sword glows, faintly.",
    choices: [
      {
        id: 'chip',
        label: 'Chip them free',
        outcomes: [
          { weight: 45, effect: { type: 'card_grant', rarity: 'epic' }, text: 'The knight bows, hands you a card, walks into the snow, and is gone.' },
          { weight: 35, effect: { type: 'relic_grant', tier: 'minor' }, text: 'The knight gives you a frost-rune token, then collapses to dust.' },
          { weight: 20, effect: { type: 'hp_loss', amount: 10 },         text: 'The sword slips loose and bites your hand. (-10 HP)' },
        ],
      },
      {
        id: 'pry-sword',
        label: 'Just pry the sword loose',
        outcomes: [
          { weight: 70, effect: { type: 'relic_grant', tier: 'minor' }, text: 'The sword comes free. A minor relic.' },
          { weight: 30, effect: { type: 'hp_loss', amount: 6 },          text: 'The blade is cold enough to burn. (-6 HP)' },
        ],
      },
      {
        id: 'leave',
        label: 'Leave them be',
        outcomes: [
          { weight: 100, effect: { type: 'none' }, text: 'You move on. The sword glows a little brighter for a moment.' },
        ],
      },
    ],
  },
  {
    id: 'frozen-heart',
    name: 'The Frozen Heart',
    description:
      "A pulsing crystal heart hangs in midair in the center of a small ice-cave. Frost flowers bloom on the floor beneath it.",
    choices: [
      {
        id: 'take-it',
        label: 'Take the heart',
        outcomes: [
          { weight: 60, effect: { type: 'relic_grant', tier: 'major' }, text: 'It settles cold and steady in your chest pocket. Major relic.' },
          { weight: 40, effect: { type: 'hp_loss', amount: 12 },         text: 'The cold hammers up your arm. (-12 HP)' },
        ],
      },
      {
        id: 'warm-it',
        label: 'Warm it with your breath',
        outcomes: [
          { weight: 100, effect: { type: 'card_upgrade', count: 1 }, text: 'It pulses once, kindly, and a card in your deck warms with it.' },
        ],
      },
    ],
  },
  {
    id: 'snow-pilgrim',
    name: 'The Snow Pilgrim',
    description:
      "An old pilgrim sits in the snow, knitting a scarf from frost itself. She offers it to you.",
    choices: [
      {
        id: 'accept',
        label: 'Accept the scarf',
        outcomes: [
          { weight: 100, effect: { type: 'buff', name: 'frostward', floors: 4 }, text: 'Frostward: -1 damage taken from spells for 4 floors.' },
        ],
      },
      {
        id: 'pay',
        label: 'Pay her 20 bolts for it',
        outcomes: [
          { weight: 100, effect: { type: 'relic_grant', tier: 'minor' }, text: 'She refuses the bolts but tucks a hairpin into your palm anyway.' },
        ],
      },
      {
        id: 'refuse',
        label: 'Refuse politely',
        outcomes: [
          { weight: 100, effect: { type: 'hp_gain', amount: 5 }, text: 'She blesses you. You feel a small warmth. (+5 HP)' },
        ],
      },
    ],
  },
  {
    id: 'ice-fishing',
    name: 'The Ice-Fishing Hole',
    description:
      "A hole has been cut in the frozen river. A pole and bait lie beside it. Something dark moves in the water below.",
    choices: [
      {
        id: 'fish',
        label: 'Fish for a while',
        outcomes: [
          { weight: 50, effect: { type: 'bolts_gain', amount: 30 },     text: 'You catch a silverfin worth 30 bolts at market.' },
          { weight: 30, effect: { type: 'card_grant', rarity: 'uncommon' }, text: 'You catch a kelp-card. It tastes terrible but you keep it.' },
          { weight: 20, effect: { type: 'hp_loss', amount: 8 },          text: 'Something with too many eyes drags the pole down. You let go just in time. (-8 HP)' },
        ],
      },
      {
        id: 'spear',
        label: 'Skip the pole and try to spear something',
        outcomes: [
          { weight: 40, effect: { type: 'bolts_gain', amount: 50 }, text: 'You spear a sleek black trout. (+50 bolts)' },
          { weight: 30, effect: { type: 'hp_loss', amount: 15 },     text: 'You overbalance and go through the ice. (-15 HP)' },
          { weight: 30, effect: { type: 'none' },                    text: 'You miss everything. The water is still.' },
        ],
      },
    ],
  },
  {
    id: 'avalanche-shrine',
    name: 'The Avalanche Shrine',
    description:
      "A small shrine sits at the foot of a sheer snow-laden slope. A bronze bell hangs above it, marked PEAL TO BE BLESSED.",
    choices: [
      {
        id: 'ring',
        label: 'Ring the bell softly',
        outcomes: [
          { weight: 75, effect: { type: 'hp_gain', amount: 15 },        text: 'A gentle hush. You feel cared for. (+15 HP)' },
          { weight: 25, effect: { type: 'relic_grant', tier: 'minor' }, text: 'A small ice charm tinkles down. Minor relic.' },
        ],
      },
      {
        id: 'ring-hard',
        label: 'Ring it as hard as you can',
        outcomes: [
          { weight: 50, effect: { type: 'relic_grant', tier: 'major' }, text: 'The slope holds. A snow-spirit hands you a major relic.' },
          { weight: 50, effect: { type: 'hp_loss', amount: 20 },         text: 'The slope does not hold. (-20 HP)' },
        ],
      },
    ],
  },
]);
