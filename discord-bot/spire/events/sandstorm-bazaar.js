// Sandstorm Bazaar — desert markets, djinn, sun-coins, mirage tents.
// 6 events: 2 pure upside, 3 tradeoff, 1 gamble.

export const SANDSTORM_BAZAAR_EVENTS = Object.freeze([
  {
    id: 'djinn-lamp',
    name: "The Djinn's Lamp",
    description:
      "A tarnished brass lamp lies half-buried in a dune. A faint hum rises from it as your shadow falls across the spout.",
    choices: [
      {
        id: 'rub',
        label: 'Rub the lamp',
        outcomes: [
          { weight: 40, effect: { type: 'relic_grant', tier: 'major' }, text: 'A djinn unfurls and grants you a major relic — and is gone.' },
          { weight: 30, effect: { type: 'card_grant', rarity: 'epic' }, text: 'A djinn smiles and tucks an epic card into your sash.' },
          { weight: 20, effect: { type: 'bolts_gain', amount: 60 },     text: 'A storm of gold coins erupts from the lamp. (+60 bolts)' },
          { weight: 10, effect: { type: 'hp_loss', amount: 12 },         text: 'The djinn was angry. He scorches you and flees. (-12 HP)' },
        ],
      },
      {
        id: 'sell',
        label: 'Sell the lamp at the bazaar',
        outcomes: [
          { weight: 100, effect: { type: 'bolts_gain', amount: 35 }, text: 'A merchant pays 35 bolts without asking questions.' },
        ],
      },
      {
        id: 'leave',
        label: 'Bury it deeper',
        outcomes: [
          { weight: 100, effect: { type: 'none' }, text: 'You cover it and walk on. The hum fades.' },
        ],
      },
    ],
  },
  {
    id: 'mirage-tent',
    name: 'The Mirage Tent',
    description:
      "A silk tent shimmers in and out of view. The flap is open. A pot of tea steams on a low table inside.",
    choices: [
      {
        id: 'enter',
        label: 'Enter and accept tea',
        outcomes: [
          { weight: 70, effect: { type: 'hp_gain', amount: 15 },         text: 'The tea is excellent. You feel reborn. (+15 HP)' },
          { weight: 30, effect: { type: 'card_upgrade', count: 1 },      text: 'You wake from a fever-dream with a card improved.' },
        ],
      },
      {
        id: 'wait',
        label: 'Wait outside until someone returns',
        outcomes: [
          { weight: 100, effect: { type: 'bolts_gain', amount: 10 }, text: 'No one returns. You take 10 bolts from the table and go.' },
        ],
      },
    ],
  },
  {
    id: 'sun-coin-gambit',
    name: 'The Sun-Coin Gambit',
    description:
      "A grinning merchant offers a flat sun-coin. 'Bright side, double; dark side, lose. Best odds in the bazaar — flip once?'",
    choices: [
      {
        id: 'flip-small',
        label: 'Wager 20 bolts',
        outcomes: [
          { weight: 50, effect: { type: 'bolts_gain', amount: 20 }, text: 'Bright side. (+20 bolts net)' },
          { weight: 50, effect: { type: 'bolts_loss', amount: 20 }, text: 'Dark side. (-20 bolts)' },
        ],
      },
      {
        id: 'flip-big',
        label: 'Wager 60 bolts',
        outcomes: [
          { weight: 50, effect: { type: 'bolts_gain', amount: 60 }, text: 'Bright side. (+60 bolts net)' },
          { weight: 50, effect: { type: 'bolts_loss', amount: 60 }, text: 'Dark side. (-60 bolts)' },
        ],
      },
      {
        id: 'pass',
        label: 'Pass',
        outcomes: [
          { weight: 100, effect: { type: 'none' }, text: 'He shrugs. "Suit yourself."' },
        ],
      },
    ],
  },
  {
    id: 'sand-serpent-charmer',
    name: 'The Sand-Serpent Charmer',
    description:
      "A child plays a reed pipe; a great golden serpent sways out of a basket. The child gestures: a coin for a scale?",
    choices: [
      {
        id: 'buy-scale',
        label: 'Pay 25 bolts for a scale',
        outcomes: [
          { weight: 100, effect: { type: 'relic_grant', tier: 'minor' }, text: 'The scale, warm as a sunstone, becomes a relic.' },
        ],
      },
      {
        id: 'pet',
        label: 'Try to pet the serpent',
        outcomes: [
          { weight: 60, effect: { type: 'card_grant', rarity: 'uncommon' }, text: 'It nuzzles you and sheds a small scale-card into your hand.' },
          { weight: 40, effect: { type: 'hp_loss', amount: 8 },              text: 'It bites. The child looks horrified. (-8 HP)' },
        ],
      },
    ],
  },
  {
    id: 'spice-trader',
    name: 'The Spice Trader',
    description:
      "Pouches of red, gold, and indigo powder line the trader's counter. He gestures: 'For the climb. Sharpens the mind.'",
    choices: [
      {
        id: 'red',
        label: 'Buy the red spice (25 bolts)',
        outcomes: [
          { weight: 100, effect: { type: 'buff', name: 'spice-rage', floors: 3 }, text: 'Spice Rage: +1 damage to attacks for 3 floors.' },
        ],
      },
      {
        id: 'gold',
        label: 'Buy the gold spice (25 bolts)',
        outcomes: [
          { weight: 100, effect: { type: 'buff', name: 'spice-luck', floors: 3 }, text: 'Spice Luck: +1 chest reward per floor for 3 floors.' },
        ],
      },
      {
        id: 'indigo',
        label: 'Buy the indigo spice (25 bolts)',
        outcomes: [
          { weight: 100, effect: { type: 'buff', name: 'spice-clarity', floors: 3 }, text: 'Spice Clarity: +1 card draw on combat start for 3 floors.' },
        ],
      },
    ],
  },
  {
    id: 'forgotten-stall',
    name: 'The Forgotten Stall',
    description:
      "A market stall sits unattended, dust on every surface. A hand-lettered sign reads: TAKE ONE, BUT ONLY ONE.",
    choices: [
      {
        id: 'take-relic',
        label: 'Take the relic-like object',
        outcomes: [
          { weight: 100, effect: { type: 'relic_grant', tier: 'minor' }, text: 'It hums faintly in your pack.' },
        ],
      },
      {
        id: 'take-card',
        label: 'Take the parchment scroll',
        outcomes: [
          { weight: 100, effect: { type: 'card_grant', rarity: 'rare' }, text: 'The scroll unfurls into a rare card.' },
        ],
      },
      {
        id: 'take-two',
        label: 'Defy the sign and grab everything',
        outcomes: [
          { weight: 50, effect: { type: 'relic_grant', tier: 'major' }, text: 'No one comes. You pocket a major relic and leave grinning.' },
          { weight: 50, effect: { type: 'hp_loss', amount: 15 },         text: 'A spectral hand catches your throat. You drop everything and flee. (-15 HP)' },
        ],
      },
    ],
  },
]);
