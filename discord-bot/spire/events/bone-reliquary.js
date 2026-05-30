// Bone Reliquary — necromancy, ossuaries, soul-coin, gravetenders.
// 5 events: 1 pure upside, 2 tradeoff, 2 gamble.

export const BONE_RELIQUARY_EVENTS = Object.freeze([
  {
    id: 'soul-coin',
    name: 'The Soul-Coin',
    description:
      "A single coin of bone sits on a velvet cushion. One side shows a sleeping face; the other, an open mouth. A small note reads, GIVE FOR GAIN. KEEP FOR DOOM.",
    choices: [
      {
        id: 'give',
        label: 'Surrender the coin to the reliquary',
        outcomes: [
          { weight: 100, effect: { type: 'relic_grant', tier: 'major' }, text: 'A drawer slides open. A major relic awaits.' },
        ],
      },
      {
        id: 'keep',
        label: 'Pocket the coin',
        outcomes: [
          { weight: 40, effect: { type: 'bolts_gain', amount: 80 }, text: 'No doom comes. You sell it for 80 bolts.' },
          { weight: 40, effect: { type: 'hp_loss', amount: 20 },     text: 'A cold hand passes through your chest. (-20 HP)' },
          { weight: 20, effect: { type: 'card_remove', criteria: 'random' }, text: 'A card crumbles to dust in your hand.' },
        ],
      },
    ],
  },
  {
    id: 'gravetender',
    name: 'The Gravetender',
    description:
      "An old woman with a wreath of teeth sweeps an ossuary floor. 'Bring me one bone of your past failures,' she says, 'and I will weigh it for you.'",
    choices: [
      {
        id: 'submit',
        label: 'Submit a card from your deck for weighing',
        outcomes: [
          { weight: 100, effect: { type: 'card_upgrade', count: 2 }, text: 'She tsks, polishes, and returns it stronger. Two cards improve.' },
        ],
      },
      {
        id: 'leave-bolts',
        label: 'Leave 30 bolts in her broom',
        outcomes: [
          { weight: 70, effect: { type: 'relic_grant', tier: 'minor' }, text: 'She nods. A small carved knuckle settles into your hand.' },
          { weight: 30, effect: { type: 'hp_gain', amount: 10 },         text: 'She nods. A great weight lifts from your shoulders. (+10 HP)' },
        ],
      },
    ],
  },
  {
    id: 'bone-pile',
    name: 'The Bone Pile',
    description:
      "A heap of bones reaches the ceiling. Something glints inside it. Something else moves.",
    choices: [
      {
        id: 'dig',
        label: 'Dig for the glint',
        outcomes: [
          { weight: 45, effect: { type: 'relic_grant', tier: 'minor' }, text: 'A ring of bone slides onto your finger. Minor relic.' },
          { weight: 35, effect: { type: 'bolts_gain', amount: 30 },     text: 'You uncover 30 bolts among the femurs.' },
          { weight: 20, effect: { type: 'hp_loss', amount: 14 },         text: 'A bone-hand grabs your wrist. You wrench free, bleeding. (-14 HP)' },
        ],
      },
      {
        id: 'walk-on',
        label: 'Leave it alone',
        outcomes: [
          { weight: 100, effect: { type: 'none' }, text: 'You give the pile a wide berth.' },
        ],
      },
    ],
  },
  {
    id: 'lichs-library',
    name: "The Lich's Library",
    description:
      "Shelves of black books line a quiet hall. A lich in patched robes looks up from his desk. 'A loan, perhaps?' he offers.",
    choices: [
      {
        id: 'borrow',
        label: 'Borrow a tome',
        outcomes: [
          { weight: 60, effect: { type: 'card_grant', rarity: 'rare' }, text: 'You learn a new card. The lich nods.' },
          { weight: 25, effect: { type: 'card_upgrade', count: 1 },     text: 'You sharpen an old card. The lich nods.' },
          { weight: 15, effect: { type: 'hp_loss', amount: 8 },          text: 'Reading the wrong sentence aloud burns your tongue. (-8 HP)' },
        ],
      },
      {
        id: 'donate',
        label: 'Donate 25 bolts to his upkeep',
        outcomes: [
          { weight: 100, effect: { type: 'buff', name: 'lich-favor', floors: 4 }, text: 'Lich Favor: undead enemies deal -1 damage for 4 floors.' },
        ],
      },
      {
        id: 'steal',
        label: 'Pocket a book and run',
        outcomes: [
          { weight: 30, effect: { type: 'card_grant', rarity: 'epic' }, text: 'You escape with a real prize.' },
          { weight: 40, effect: { type: 'hp_loss', amount: 12 },         text: 'A bone-hand catches your ankle. (-12 HP)' },
          { weight: 30, effect: { type: 'card_remove', criteria: 'random' }, text: 'The lich curses you. A card rots from your deck.' },
        ],
      },
    ],
  },
  {
    id: 'gravewell',
    name: 'The Gravewell',
    description:
      "A circular pit in the floor goes down farther than your torchlight can reach. A rope ladder is anchored at the rim.",
    choices: [
      {
        id: 'descend',
        label: 'Climb down',
        outcomes: [
          { weight: 40, effect: { type: 'relic_grant', tier: 'major' }, text: 'You find a sarcophagus with a major relic on the lid.' },
          { weight: 30, effect: { type: 'bolts_gain', amount: 45 },     text: 'A pile of grave-coins waits at the bottom. (+45 bolts)' },
          { weight: 30, effect: { type: 'hp_loss', amount: 18 },         text: 'Something cold breathes on your neck. You scramble back up. (-18 HP)' },
        ],
      },
      {
        id: 'drop-item',
        label: 'Drop a card down as offering',
        outcomes: [
          { weight: 70, effect: { type: 'card_remove', criteria: 'cheapest' }, text: 'A cheap card drifts down. The well goes quiet.' },
          { weight: 30, effect: { type: 'relic_grant', tier: 'minor' }, text: 'The card drifts down. A trinket floats back up.' },
        ],
      },
    ],
  },
]);
