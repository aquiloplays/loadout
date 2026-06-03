// Stargazer Court, astrolabes, planetariums, oracles, cosmic patrons.
// 5 events: 2 pure upside, 2 tradeoff, 1 gamble.

export const STARGAZER_COURT_EVENTS = Object.freeze([
  {
    id: 'star-chart',
    name: 'The Star-Chart',
    description:
      "A vast chart of the heavens covers the floor. A robed astronomer kneels at the center, plotting your fate with a piece of chalk.",
    choices: [
      {
        id: 'reading',
        label: 'Receive a reading',
        outcomes: [
          { weight: 60, effect: { type: 'buff', name: 'starsight', floors: 5 },    text: 'Starsight: see the top card of your draw pile for 5 floors.' },
          { weight: 40, effect: { type: 'card_upgrade', count: 1 },                 text: 'A small change in fate, one card improves.' },
        ],
      },
      {
        id: 'commission',
        label: 'Commission a custom chart (-30 bolts)',
        outcomes: [
          { weight: 100, effect: { type: 'relic_grant', tier: 'major' }, text: 'A folded chart slides into your pack, a major relic.' },
        ],
      },
    ],
  },
  {
    id: 'comet-fragment',
    name: 'The Comet Fragment',
    description:
      "A still-warm shard of fallen comet sits inside a glass dome. The dome is unlocked. A guard sleeps a few feet away.",
    choices: [
      {
        id: 'take-quiet',
        label: 'Take it quietly',
        outcomes: [
          { weight: 65, effect: { type: 'relic_grant', tier: 'major' }, text: 'You slip the shard into your pack. Major relic.' },
          { weight: 35, effect: { type: 'hp_loss', amount: 10 },         text: 'The shard sears your hand on contact. You yelp; the guard stirs but does not wake. (-10 HP, no relic)' },
        ],
      },
      {
        id: 'request',
        label: 'Wake the guard and request to examine it (-25 bolts as donation)',
        outcomes: [
          { weight: 100, effect: { type: 'card_grant', rarity: 'rare' }, text: 'The guard accepts your donation. A study session yields a star-card.' },
        ],
      },
      {
        id: 'leave',
        label: 'Leave it',
        outcomes: [
          { weight: 100, effect: { type: 'none' }, text: 'You give it a long look and walk on.' },
        ],
      },
    ],
  },
  {
    id: 'oracle',
    name: 'The Court Oracle',
    description:
      "A blindfolded oracle in a crown of silver stars offers to answer three questions for the price of three things you do not yet know you have.",
    choices: [
      {
        id: 'ask',
        label: 'Submit to the bargain',
        outcomes: [
          { weight: 50, effect: { type: 'card_upgrade', count: 2 },               text: 'You leave wiser. Two cards improve.' },
          { weight: 30, effect: { type: 'card_remove', criteria: 'random' },     text: 'A truth she tells you erases a card from your memory.' },
          { weight: 20, effect: { type: 'relic_grant', tier: 'minor' },          text: 'She presses a sliver of crystal into your hand. Minor relic.' },
        ],
      },
      {
        id: 'small-question',
        label: 'Ask only one small question',
        outcomes: [
          { weight: 100, effect: { type: 'buff', name: 'foresight', floors: 2 }, text: 'Foresight: you may peek at the next event for 2 floors.' },
        ],
      },
    ],
  },
  {
    id: 'planetarium',
    name: 'The Living Planetarium',
    description:
      "A great clockwork orrery turns slowly above you. A small attendant invites you to step onto the central plate.",
    choices: [
      {
        id: 'step-on',
        label: 'Step onto the plate',
        outcomes: [
          { weight: 50, effect: { type: 'hp_gain', amount: 18 },         text: 'You orbit the model sun once. You feel held. (+18 HP)' },
          { weight: 30, effect: { type: 'card_grant', rarity: 'rare' }, text: 'A planet drops a small token of itself into your hand.' },
          { weight: 20, effect: { type: 'hp_loss', amount: 6 },          text: 'A planet swings low and clips your shoulder. (-6 HP)' },
        ],
      },
      {
        id: 'watch',
        label: 'Watch from the gallery',
        outcomes: [
          { weight: 100, effect: { type: 'card_upgrade', count: 1 }, text: 'A pattern resolves in your mind. A card improves.' },
        ],
      },
    ],
  },
  {
    id: 'cosmic-patron',
    name: 'The Cosmic Patron',
    description:
      "A figure made of negative space stands at the end of the gallery. It does not speak. It offers a single card from a deck of its own.",
    choices: [
      {
        id: 'accept',
        label: 'Accept the card',
        outcomes: [
          { weight: 60, effect: { type: 'card_grant', rarity: 'legendary' }, text: 'The card joins your deck. The figure inclines its head.' },
          { weight: 40, effect: { type: 'card_remove', criteria: 'random' }, text: 'A card of yours vanishes in exchange. You did not see that coming.' },
        ],
      },
      {
        id: 'offer-back',
        label: 'Offer one of yours in return',
        outcomes: [
          { weight: 100, effect: { type: 'card_upgrade', count: 2 }, text: 'It takes your card, blesses it, and returns it improved, along with another.' },
        ],
      },
      {
        id: 'refuse',
        label: 'Refuse',
        outcomes: [
          { weight: 100, effect: { type: 'none' }, text: 'The figure dissolves into the dark between the stars.' },
        ],
      },
    ],
  },
]);
