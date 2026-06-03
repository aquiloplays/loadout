// Clockwork Foundry, brass, steam, gear-priests, automatons, oil.
// 6 events: 2 pure upside, 3 tradeoff, 1 gamble.

export const CLOCKWORK_FOUNDRY_EVENTS = Object.freeze([
  {
    id: 'broken-automaton',
    name: 'The Broken Automaton',
    description:
      "A brass humanoid slumps against the wall, a tangle of springs spilling from its chest. Its single eye dims as you approach, then brightens.",
    choices: [
      {
        id: 'repair',
        label: 'Spend 20 bolts on parts and fix it',
        outcomes: [
          { weight: 75, effect: { type: 'card_grant', rarity: 'rare' }, text: 'It stands, salutes, presses a brass card into your palm, and walks off.' },
          { weight: 25, effect: { type: 'relic_grant', tier: 'minor' }, text: 'Its eye plate pops loose into your hand as a token of thanks.' },
        ],
      },
      {
        id: 'scrap',
        label: 'Scrap it for parts',
        outcomes: [
          { weight: 80, effect: { type: 'bolts_gain', amount: 35 }, text: 'You strip out 35 bolts worth of brass.' },
          { weight: 20, effect: { type: 'hp_loss', amount: 6 },     text: 'A spring uncoils into your shoulder. (-6 HP)' },
        ],
      },
      {
        id: 'leave',
        label: 'Leave it dignified',
        outcomes: [
          { weight: 100, effect: { type: 'none' }, text: 'The eye dims again as you pass.' },
        ],
      },
    ],
  },
  {
    id: 'oil-bath',
    name: 'The Oil Bath',
    description:
      "A great copper tub of warm, dark oil bubbles in the corner. A sign reads: REFITS YOUR GEAR, OR YOUR SKIN, FOR A FEE.",
    choices: [
      {
        id: 'dip-gear',
        label: 'Dip your gear in (cost: 15 bolts)',
        outcomes: [
          { weight: 100, effect: { type: 'card_upgrade', count: 2 }, text: 'Two of your cards come out gleaming and improved.' },
        ],
      },
      {
        id: 'dip-self',
        label: 'Dip yourself in (cost: nothing)',
        outcomes: [
          { weight: 55, effect: { type: 'hp_gain', amount: 20 },             text: 'You emerge slick, warm, and reborn. (+20 HP)' },
          { weight: 30, effect: { type: 'buff', name: 'oil-slick', floors: 3 }, text: 'Oil-Slick: enemy attacks have a 25% miss chance for 3 floors.' },
          { weight: 15, effect: { type: 'hp_loss', amount: 10 },              text: 'The oil was hotter than it looked. (-10 HP)' },
        ],
      },
    ],
  },
  {
    id: 'gear-priest',
    name: 'The Gear-Priest',
    description:
      "A robed mechanic adjusts a small altar of meshing brass cogs. 'Your deck is a machine,' she says. 'Let me tune it.'",
    choices: [
      {
        id: 'tune',
        label: 'Let her tune it',
        outcomes: [
          { weight: 60, effect: { type: 'card_upgrade', count: 1 },               text: 'A card hums to her wrench and improves.' },
          { weight: 40, effect: { type: 'card_remove', criteria: 'lowest-tier' }, text: 'She removes a card she calls "dead weight." She is probably right.' },
        ],
      },
      {
        id: 'apprentice',
        label: 'Ask to apprentice for an hour',
        outcomes: [
          { weight: 100, effect: { type: 'buff', name: 'engineered', floors: 4 }, text: 'Engineered: card costs reduced by 1 (min 1) on the first card each turn for 4 floors.' },
        ],
      },
    ],
  },
  {
    id: 'lever-puzzle',
    name: 'The Lever Puzzle',
    description:
      "A wall of unlabeled levers. A small plaque: PULL ONE, NO MORE. The metal is warm.",
    choices: [
      {
        id: 'left',
        label: 'Pull the leftmost lever',
        outcomes: [
          { weight: 100, effect: { type: 'card_grant', rarity: 'uncommon' }, text: 'A small drawer pops open. A card waits inside.' },
        ],
      },
      {
        id: 'right',
        label: 'Pull the rightmost lever',
        outcomes: [
          { weight: 100, effect: { type: 'bolts_gain', amount: 25 }, text: 'Coins clatter into a pan at your feet. (+25 bolts)' },
        ],
      },
      {
        id: 'middle',
        label: 'Pull the middle lever',
        outcomes: [
          { weight: 40, effect: { type: 'relic_grant', tier: 'major' }, text: 'A pedestal rises with a major relic on it.' },
          { weight: 30, effect: { type: 'hp_loss', amount: 12 },         text: 'Steam blasts you in the face. (-12 HP)' },
          { weight: 30, effect: { type: 'none' },                        text: 'Nothing happens. The metal cools.' },
        ],
      },
    ],
  },
  {
    id: 'steam-vent',
    name: 'The Steam Vent',
    description:
      "A vent in the floor hisses out warm, fragrant steam. A folded note pinned next to it reads, 'Breathe deep. Or hold a coin over it. Up to you.'",
    choices: [
      {
        id: 'breathe',
        label: 'Breathe deep',
        outcomes: [
          { weight: 100, effect: { type: 'hp_gain', amount: 12 }, text: 'Aches melt out of your shoulders. (+12 HP)' },
        ],
      },
      {
        id: 'coin',
        label: 'Hold a coin over the vent (-10 bolts)',
        outcomes: [
          { weight: 70, effect: { type: 'relic_grant', tier: 'minor' }, text: 'The coin melts and reforms as a small steamward token. Minor relic.' },
          { weight: 30, effect: { type: 'none' },                        text: 'The coin simply melts. You lose 10 bolts and gain nothing else.' },
        ],
      },
    ],
  },
  {
    id: 'foreman-wager',
    name: "The Foreman's Wager",
    description:
      "A thick-armed foreman gestures at a stress-test rig. 'Lift my hammer ten times,' he says, 'and I'll pay you. Drop it and you pay me.'",
    choices: [
      {
        id: 'lift',
        label: 'Take the bet',
        outcomes: [
          { weight: 55, effect: { type: 'bolts_gain', amount: 40 }, text: 'You lift ten clean. (+40 bolts)' },
          { weight: 45, effect: { type: 'hp_loss', amount: 8 },      text: 'You drop it on rep nine. Foreman shakes his head. (-8 HP, no bolts)' },
        ],
      },
      {
        id: 'pass',
        label: 'Pass',
        outcomes: [
          { weight: 100, effect: { type: 'none' }, text: 'He shrugs and goes back to filing a wedge.' },
        ],
      },
    ],
  },
]);
