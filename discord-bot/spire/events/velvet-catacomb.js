// Velvet Catacomb — gothic crypt, candle-mass, vampires, blood-pacts.
// 6 events: 1 pure upside, 3 tradeoff, 2 gamble.

export const VELVET_CATACOMB_EVENTS = Object.freeze([
  {
    id: 'candle-mass',
    name: 'The Candle-Mass',
    description:
      "A choir of pale figures in velvet sing in a language you almost understand. The air is thick with melted wax. A pew waits, empty.",
    choices: [
      {
        id: 'sit',
        label: 'Sit and listen',
        outcomes: [
          { weight: 100, effect: { type: 'hp_gain', amount: 18 }, text: 'The hymn does something to your blood. You feel made new. (+18 HP)' },
        ],
      },
      {
        id: 'join-singing',
        label: 'Join the singing',
        outcomes: [
          { weight: 60, effect: { type: 'buff', name: 'choir-resonance', floors: 4 }, text: 'Choir-Resonance: spells cost 1 less (min 1) on the first cast each combat for 4 floors.' },
          { weight: 40, effect: { type: 'hp_loss', amount: 6 },                       text: 'A note slips. The pale eyes turn. You leave fast. (-6 HP)' },
        ],
      },
    ],
  },
  {
    id: 'blood-pact',
    name: 'The Blood-Pact',
    description:
      "A vampire in midnight silks offers you a quill, an open vein, and a contract written in tasteful crimson.",
    choices: [
      {
        id: 'sign',
        label: 'Sign',
        outcomes: [
          { weight: 55, effect: { type: 'card_grant', rarity: 'legendary' }, text: 'A legendary card slides across the table to you.' },
          { weight: 30, effect: { type: 'hp_loss', amount: 20 },              text: 'He drinks his fee on the spot. You stagger back. (-20 HP)' },
          { weight: 15, effect: { type: 'relic_grant', tier: 'major' },       text: 'He nods, hands you a major relic, and dabs his lips with a napkin.' },
        ],
      },
      {
        id: 'negotiate',
        label: 'Counter-offer in bolts (-50 bolts)',
        outcomes: [
          { weight: 100, effect: { type: 'card_grant', rarity: 'rare' }, text: 'He laughs, takes the bolts, and gives you a rare card. "Charming."' },
        ],
      },
      {
        id: 'walk',
        label: 'Walk away',
        outcomes: [
          { weight: 100, effect: { type: 'none' }, text: 'He bows. "Another time, then." You believe him.' },
        ],
      },
    ],
  },
  {
    id: 'forgotten-sarcophagus',
    name: 'The Forgotten Sarcophagus',
    description:
      "A plain stone sarcophagus tilts open in a side alcove. The skeleton inside still wears a velvet doublet and clutches a small bag.",
    choices: [
      {
        id: 'take-bag',
        label: 'Take the bag',
        outcomes: [
          { weight: 60, effect: { type: 'bolts_gain', amount: 40 }, text: 'You count 40 bolts inside.' },
          { weight: 25, effect: { type: 'relic_grant', tier: 'minor' }, text: 'A velvet pouch holds a small jeweled charm — minor relic.' },
          { weight: 15, effect: { type: 'hp_loss', amount: 10 },         text: 'The skeleton sits up. You drop everything and run. (-10 HP)' },
        ],
      },
      {
        id: 'pay-respects',
        label: 'Cross their hands and close the lid',
        outcomes: [
          { weight: 100, effect: { type: 'hp_gain', amount: 10 }, text: 'Quiet thanks settle over you. (+10 HP)' },
        ],
      },
    ],
  },
  {
    id: 'mourning-veil',
    name: 'The Mourning Veil',
    description:
      "A weeping noblewoman in a thick black veil sits at a shrine of polished bone. 'My beloved,' she says, 'is missing. Find me a token of him and I will reward you.'",
    choices: [
      {
        id: 'offer-card',
        label: 'Offer a card from your deck as a "found token"',
        outcomes: [
          { weight: 65, effect: { type: 'relic_grant', tier: 'major' }, text: 'She wails in gratitude. A major relic is pressed into your hands.' },
          { weight: 35, effect: { type: 'card_remove', criteria: 'random' }, text: 'She accepts the card and vanishes. You feel the absence in your deck.' },
        ],
      },
      {
        id: 'comfort',
        label: 'Sit and comfort her',
        outcomes: [
          { weight: 100, effect: { type: 'buff', name: 'velvet-favor', floors: 3 }, text: 'Velvet Favor: undead allies +1 attack for 3 floors.' },
        ],
      },
      {
        id: 'leave',
        label: 'Leave her to grieve',
        outcomes: [
          { weight: 100, effect: { type: 'none' }, text: 'You bow and leave. She does not look up.' },
        ],
      },
    ],
  },
  {
    id: 'crimson-fountain',
    name: 'The Crimson Fountain',
    description:
      "A fountain runs with something a little too red to be wine. A goblet stands ready. A note: ONE SIP. NO MORE.",
    choices: [
      {
        id: 'one-sip',
        label: 'Take one sip',
        outcomes: [
          { weight: 70, effect: { type: 'card_upgrade', count: 1 }, text: 'A card improves with a soft red glow.' },
          { weight: 30, effect: { type: 'hp_gain', amount: 8 },     text: 'You feel reckless and well. (+8 HP)' },
        ],
      },
      {
        id: 'two-sips',
        label: 'Defy the note and take two sips',
        outcomes: [
          { weight: 40, effect: { type: 'card_upgrade', count: 2 }, text: 'Two cards improve.' },
          { weight: 30, effect: { type: 'relic_grant', tier: 'minor' }, text: 'A small crimson charm bobs up in the goblet.' },
          { weight: 30, effect: { type: 'hp_loss', amount: 15 },     text: 'Your stomach revolts. (-15 HP)' },
        ],
      },
      {
        id: 'leave',
        label: 'Leave',
        outcomes: [
          { weight: 100, effect: { type: 'none' }, text: 'You walk past. The fountain murmurs on.' },
        ],
      },
    ],
  },
  {
    id: 'cobweb-throne',
    name: 'The Cobweb Throne',
    description:
      "A throne draped in centuries of cobweb sits at the head of a long hall. It is unoccupied — or appears to be.",
    choices: [
      {
        id: 'sit',
        label: 'Sit on the throne',
        outcomes: [
          { weight: 40, effect: { type: 'relic_grant', tier: 'major' }, text: 'The throne accepts you. A crown-shard settles into your pack. Major relic.' },
          { weight: 30, effect: { type: 'card_grant', rarity: 'epic' }, text: 'A spectral courtier hands you a card of pact.' },
          { weight: 30, effect: { type: 'hp_loss', amount: 16 },         text: 'The throne does NOT accept you. Cobweb tightens around your throat. (-16 HP)' },
        ],
      },
      {
        id: 'bow',
        label: 'Kneel before the empty throne',
        outcomes: [
          { weight: 100, effect: { type: 'buff', name: 'noble-favor', floors: 4 }, text: 'Noble Favor: you start each combat with +5 block for 4 floors.' },
        ],
      },
    ],
  },
]);
