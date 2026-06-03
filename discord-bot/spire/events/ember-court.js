// Ember Court, lava, fire, noble bloodlines, throne politics.
// 6 events: 2 pure upside, 3 tradeoff, 1 gamble.

export const EMBER_COURT_EVENTS = Object.freeze([
  {
    id: 'firefall-bargain',
    name: 'The Firefall Throne',
    description:
      "A molten cascade pours from the obsidian throne above. The court whispers that any who drink may be reforged, or rendered ash.",
    choices: [
      {
        id: 'drink-deep',
        label: 'Drink deep from the Firefall',
        outcomes: [
          { weight: 45, effect: { type: 'card_upgrade', count: 2 }, text: 'The fire tempers two of your cards into something keener.' },
          { weight: 35, effect: { type: 'hp_loss', amount: 10 },     text: 'The molten draught scalds you raw. (-10 HP)' },
          { weight: 20, effect: { type: 'relic_grant', tier: 'minor' }, text: 'A drop hardens into a smoldering trinket in your palm.' },
        ],
      },
      {
        id: 'sip-cautious',
        label: 'Sip cautiously',
        outcomes: [
          { weight: 70, effect: { type: 'card_upgrade', count: 1 }, text: 'A single card glows hotter, and stronger.' },
          { weight: 30, effect: { type: 'hp_loss', amount: 5 },     text: 'Even a sip is enough to blister. (-5 HP)' },
        ],
      },
      {
        id: 'walk-away',
        label: 'Walk away',
        outcomes: [
          { weight: 100, effect: { type: 'none' }, text: 'The court hisses at your cowardice, but you keep your skin.' },
        ],
      },
    ],
  },
  {
    id: 'lich-king-bargain',
    name: "Bargain with the Lich Margrave",
    description:
      "A skeletal noble in soot-blackened velvet offers you a deal. He wants a memory of yours, and offers a relic of his court in exchange.",
    choices: [
      {
        id: 'accept',
        label: 'Accept the bargain',
        outcomes: [
          { weight: 60, effect: { type: 'relic_grant', tier: 'major' }, text: 'The Margrave bows; a major relic settles into your hand.' },
          { weight: 40, effect: { type: 'card_remove', criteria: 'random' }, text: 'A card you loved is plucked from your deck and devoured by the cold flame.' },
        ],
      },
      {
        id: 'haggle',
        label: 'Haggle for better terms',
        outcomes: [
          { weight: 50, effect: { type: 'relic_grant', tier: 'minor' }, text: 'He smirks and parts with a lesser keepsake.' },
          { weight: 50, effect: { type: 'bolts_loss', amount: 25 },     text: 'You leave 25 bolts lighter; the Margrave laughs.' },
        ],
      },
      {
        id: 'refuse',
        label: 'Refuse and walk',
        outcomes: [
          { weight: 100, effect: { type: 'none' }, text: 'You back away. The Margrave watches you all the way out.' },
        ],
      },
    ],
  },
  {
    id: 'caged-phoenix',
    name: 'The Caged Phoenix',
    description:
      "A phoenix beats against an iron cage in a forgotten alcove. Its eyes meet yours. The lock looks cheap.",
    choices: [
      {
        id: 'free-it',
        label: 'Pry the cage open',
        outcomes: [
          { weight: 80, effect: { type: 'card_grant', rarity: 'rare' },  text: 'It bursts into flame, drops a single ember, and is gone. (rare card added)' },
          { weight: 20, effect: { type: 'hp_loss', amount: 5 },           text: 'The first beat of its wings catches you across the face. (-5 HP)' },
        ],
      },
      {
        id: 'pluck-feather',
        label: 'Pluck a feather through the bars',
        outcomes: [
          { weight: 100, effect: { type: 'relic_grant', tier: 'minor' }, text: 'A still-warm feather hardens into a relic.' },
        ],
      },
    ],
  },
  {
    id: 'goblin-merchant',
    name: 'Help a Goblin Merchant',
    description:
      "A merchant goblin's cart has thrown a wheel on the lava bridge. His wares, pots, scrolls, a half-melted ring, are sliding toward the edge.",
    choices: [
      {
        id: 'help',
        label: 'Help him push',
        outcomes: [
          { weight: 100, effect: { type: 'bolts_gain', amount: 30 }, text: 'He tosses you 30 bolts and a wink. "Tell no one I was kind."' },
        ],
      },
      {
        id: 'demand-payment',
        label: 'Demand the ring as payment',
        outcomes: [
          { weight: 60, effect: { type: 'relic_grant', tier: 'minor' }, text: 'He grumbles and surrenders the ring.' },
          { weight: 40, effect: { type: 'bolts_loss', amount: 15 },     text: 'He throws the ring into the lava. "Then no one shall have it!" (-15 bolts in shame)' },
        ],
      },
    ],
  },
  {
    id: 'burn-old-tome',
    name: 'Burn an Old Tome',
    description:
      "A tome rests on a brazier pedestal, its pages too damp to read. The brazier crackles invitingly.",
    choices: [
      {
        id: 'burn',
        label: 'Burn the tome',
        outcomes: [
          { weight: 55, effect: { type: 'card_grant', rarity: 'epic' }, text: 'A page floats up, becomes a card, lands in your hand. (epic added)' },
          { weight: 30, effect: { type: 'hp_loss', amount: 8 },          text: 'Cursed smoke fills your lungs. (-8 HP)' },
          { weight: 15, effect: { type: 'relic_grant', tier: 'minor' }, text: 'The cover, charred but whole, becomes a minor relic.' },
        ],
      },
      {
        id: 'read',
        label: 'Try to read it',
        outcomes: [
          { weight: 100, effect: { type: 'card_upgrade', count: 1 }, text: 'You parse one line. A card in your deck improves.' },
        ],
      },
      {
        id: 'leave',
        label: 'Leave the tome',
        outcomes: [
          { weight: 100, effect: { type: 'none' }, text: 'You move on. The brazier sighs.' },
        ],
      },
    ],
  },
  {
    id: 'noble-duel',
    name: 'Challenge a Noble',
    description:
      "An ash-pale noble blocks the corridor. He gestures at his dueling glove and at yours. 'A test of mettle,' he says, 'or pay the toll.'",
    choices: [
      {
        id: 'duel',
        label: 'Accept the duel',
        outcomes: [
          { weight: 50, effect: { type: 'relic_grant', tier: 'major' }, text: 'You win cleanly. He surrenders his dueling pin, a major relic.' },
          { weight: 50, effect: { type: 'hp_loss', amount: 15 },         text: 'You lose. He lets you live, barely. (-15 HP)' },
        ],
      },
      {
        id: 'pay-toll',
        label: 'Pay the toll',
        outcomes: [
          { weight: 100, effect: { type: 'bolts_loss', amount: 40 }, text: 'You drop 40 bolts in his glove and pass.' },
        ],
      },
      {
        id: 'insult',
        label: 'Insult him and run',
        outcomes: [
          { weight: 60, effect: { type: 'none' },                 text: 'He fumes; you escape. No cost.' },
          { weight: 40, effect: { type: 'hp_loss', amount: 5 },  text: 'A thrown dagger nicks your shoulder. (-5 HP)' },
        ],
      },
    ],
  },
]);
