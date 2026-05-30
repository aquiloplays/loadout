// Mirror Garden — silver pools, doubles, illusions, reflective topiary.
// 5 events: 1 pure upside, 3 tradeoff, 1 gamble.

export const MIRROR_GARDEN_EVENTS = Object.freeze([
  {
    id: 'silver-pool',
    name: 'The Silver Pool',
    description:
      "A pool of perfectly still quicksilver shows your reflection — but the reflection is not quite you. It smiles when you do not.",
    choices: [
      {
        id: 'speak',
        label: 'Speak with the reflection',
        outcomes: [
          { weight: 50, effect: { type: 'card_upgrade', count: 2 },               text: 'It teaches you something about yourself. Two cards improve.' },
          { weight: 30, effect: { type: 'card_remove', criteria: 'random' },     text: 'It takes a card from you "for safekeeping."' },
          { weight: 20, effect: { type: 'card_grant', rarity: 'rare' },           text: 'It hands you a card from its side of the pool.' },
        ],
      },
      {
        id: 'shatter',
        label: 'Shatter the pool',
        outcomes: [
          { weight: 60, effect: { type: 'relic_grant', tier: 'minor' }, text: 'A shard becomes a small silver charm. Minor relic.' },
          { weight: 40, effect: { type: 'hp_loss', amount: 10 },         text: 'The reflection screams as it dies. So does your head, for an hour. (-10 HP)' },
        ],
      },
      {
        id: 'walk-on',
        label: 'Walk on',
        outcomes: [
          { weight: 100, effect: { type: 'none' }, text: 'The reflection waves. You do not wave back.' },
        ],
      },
    ],
  },
  {
    id: 'topiary-twin',
    name: 'The Topiary Twin',
    description:
      "A hedge sculpted exactly into your likeness stands at a fork in the garden. It blinks. Or you imagine it does.",
    choices: [
      {
        id: 'trim',
        label: 'Trim its hair to match yours',
        outcomes: [
          { weight: 100, effect: { type: 'hp_gain', amount: 18 }, text: 'You feel oddly cared for, doing it. (+18 HP)' },
        ],
      },
      {
        id: 'destroy',
        label: 'Tear it apart',
        outcomes: [
          { weight: 55, effect: { type: 'card_grant', rarity: 'rare' }, text: 'A card falls out of the wreckage. You add it to your deck.' },
          { weight: 45, effect: { type: 'hp_loss', amount: 12 },         text: 'Every cut you make appears as a bruise on your own skin. (-12 HP)' },
        ],
      },
    ],
  },
  {
    id: 'double-shrine',
    name: 'The Shrine of Doubles',
    description:
      "Two identical shrines sit side by side. One is real, one is a perfect illusion. Neither bears any mark to tell them apart.",
    choices: [
      {
        id: 'pray-left',
        label: 'Pray at the left shrine',
        outcomes: [
          { weight: 50, effect: { type: 'relic_grant', tier: 'minor' }, text: 'A minor relic appears in your palm.' },
          { weight: 50, effect: { type: 'none' },                        text: 'You feel deeply foolish. The illusion fades.' },
        ],
      },
      {
        id: 'pray-right',
        label: 'Pray at the right shrine',
        outcomes: [
          { weight: 50, effect: { type: 'relic_grant', tier: 'minor' }, text: 'A minor relic appears in your palm.' },
          { weight: 50, effect: { type: 'none' },                        text: 'You feel deeply foolish. The illusion fades.' },
        ],
      },
      {
        id: 'pray-both',
        label: 'Pray at both',
        outcomes: [
          { weight: 60, effect: { type: 'relic_grant', tier: 'minor' }, text: 'You get the relic anyway. The illusion shrugs.' },
          { weight: 40, effect: { type: 'bolts_loss', amount: 20 },     text: 'Both shrines demand an offering. The illusion takes its share. (-20 bolts)' },
        ],
      },
    ],
  },
  {
    id: 'mirror-duel',
    name: 'The Mirror Duel',
    description:
      "Your reflection steps out of a tall standing mirror. It is armed. It is also faster than you. It nods, and waits.",
    choices: [
      {
        id: 'fight',
        label: 'Fight your reflection',
        outcomes: [
          { weight: 45, effect: { type: 'relic_grant', tier: 'major' }, text: 'You win, just barely. Its sword becomes a major relic.' },
          { weight: 35, effect: { type: 'hp_loss', amount: 18 },         text: 'You lose. It lets you live, smirking. (-18 HP)' },
          { weight: 20, effect: { type: 'card_upgrade', count: 2 },      text: 'You fight to a draw. Two cards improve from the practice.' },
        ],
      },
      {
        id: 'mirror-back',
        label: 'Step into the mirror yourself',
        outcomes: [
          { weight: 70, effect: { type: 'card_grant', rarity: 'epic' }, text: 'You emerge on the other side with a stranger card.' },
          { weight: 30, effect: { type: 'hp_loss', amount: 8 },          text: 'The mirror is colder than you expected. (-8 HP)' },
        ],
      },
    ],
  },
  {
    id: 'whispering-fountain',
    name: 'The Whispering Fountain',
    description:
      "A small fountain murmurs sentences in your own voice — sentences you do not remember saying. A coin slot is etched into the basin.",
    choices: [
      {
        id: 'feed',
        label: 'Feed it 20 bolts',
        outcomes: [
          { weight: 100, effect: { type: 'buff', name: 'self-reflection', floors: 3 }, text: 'Self-Reflection: card draw improves by 1 on turn 1 for 3 floors.' },
        ],
      },
      {
        id: 'listen',
        label: 'Listen for a while',
        outcomes: [
          { weight: 60, effect: { type: 'card_upgrade', count: 1 }, text: "You hear advice you didn't know you had. A card improves." },
          { weight: 40, effect: { type: 'hp_gain', amount: 8 },     text: 'You forgive yourself for something. (+8 HP)' },
        ],
      },
    ],
  },
]);
