// Aurora Spire, northern lights, sky-veils, dream-spirits, wind.
// 5 events: 2 pure upside, 2 tradeoff, 1 gamble.

export const AURORA_SPIRE_EVENTS = Object.freeze([
  {
    id: 'sky-veil-dance',
    name: 'Dance Beneath the Veil',
    description:
      "Ribbons of green and violet light fall like silk to the floor. Other climbers whirl through them, eyes lit. A drum somewhere keeps the time.",
    choices: [
      {
        id: 'join',
        label: 'Join the dance',
        outcomes: [
          { weight: 60, effect: { type: 'hp_gain', amount: 10 },        text: 'You spin until your wounds knit. (+10 HP)' },
          { weight: 40, effect: { type: 'buff', name: 'aurora-grace', floors: 3 }, text: 'A shimmer settles on your shoulders, Aurora Grace, 3 floors.' },
        ],
      },
      {
        id: 'watch',
        label: 'Sit and watch',
        outcomes: [
          { weight: 100, effect: { type: 'card_upgrade', count: 1 }, text: 'Watching, you understand a card better. (+1 upgrade)' },
        ],
      },
    ],
  },
  {
    id: 'dream-spirit-pact',
    name: 'The Dream-Spirit Pact',
    description:
      "A pale, antlered figure offers you a sip from a cup of starlit water. She warns: 'Drink and you will dream. What you find in the dream is yours, what finds you, is also yours.'",
    choices: [
      {
        id: 'drink',
        label: 'Drink',
        outcomes: [
          { weight: 50, effect: { type: 'card_grant', rarity: 'rare' },  text: 'You wake clutching a card that was not there before.' },
          { weight: 30, effect: { type: 'relic_grant', tier: 'minor' }, text: 'A sliver of dream solidifies into a relic in your hand.' },
          { weight: 20, effect: { type: 'hp_loss', amount: 6 },          text: 'Something in the dream bit you. (-6 HP)' },
        ],
      },
      {
        id: 'pour-out',
        label: 'Pour it out as offering',
        outcomes: [
          { weight: 100, effect: { type: 'bolts_gain', amount: 15 }, text: 'She nods and presses 15 bolts into your palm.' },
        ],
      },
      {
        id: 'decline',
        label: 'Politely decline',
        outcomes: [
          { weight: 100, effect: { type: 'none' }, text: 'She smiles. The cup vanishes. So does she.' },
        ],
      },
    ],
  },
  {
    id: 'wind-runners',
    name: 'The Wind-Runners',
    description:
      "Two children of the air race past, leaving cold trails. One drops a cloak-pin. They look back, daring you.",
    choices: [
      {
        id: 'chase',
        label: 'Chase them',
        outcomes: [
          { weight: 70, effect: { type: 'relic_grant', tier: 'minor' }, text: 'You catch the dropped pin, a minor relic.' },
          { weight: 30, effect: { type: 'hp_loss', amount: 4 },          text: 'You skid on frost and land hard. (-4 HP)' },
        ],
      },
      {
        id: 'shout-thanks',
        label: 'Shout your thanks and keep climbing',
        outcomes: [
          { weight: 100, effect: { type: 'bolts_gain', amount: 10 }, text: 'They circle back, drop 10 bolts at your feet, and are gone.' },
        ],
      },
    ],
  },
  {
    id: 'star-map-shrine',
    name: 'The Star-Map Shrine',
    description:
      "A polished obsidian basin holds a map of stars that shift as you breathe on them. A small inscription invites you to chart your own path.",
    choices: [
      {
        id: 'chart-bold',
        label: 'Chart a bold course',
        outcomes: [
          { weight: 100, effect: { type: 'buff', name: 'starbound', floors: 5 }, text: 'Starbound: +1 card draw on combat for 5 floors.' },
        ],
      },
      {
        id: 'chart-safe',
        label: 'Chart a cautious course',
        outcomes: [
          { weight: 100, effect: { type: 'hp_gain', amount: 15 }, text: 'You spend a while breathing. The basin warms you. (+15 HP)' },
        ],
      },
    ],
  },
  {
    id: 'frozen-traveler',
    name: 'The Frozen Traveler',
    description:
      "A climber sits cross-legged in a snowdrift, eyes closed, blue-lipped but smiling. A satchel rests at their side.",
    choices: [
      {
        id: 'rouse',
        label: 'Try to rouse them',
        outcomes: [
          { weight: 60, effect: { type: 'card_grant', rarity: 'uncommon' }, text: 'They blink awake, thank you, press a card into your hand, and walk on.' },
          { weight: 40, effect: { type: 'hp_gain', amount: 5 },              text: 'They smile but do not wake. You leave a blanket. (+5 HP from kindness)' },
        ],
      },
      {
        id: 'loot',
        label: 'Take the satchel',
        outcomes: [
          { weight: 70, effect: { type: 'bolts_gain', amount: 35 }, text: 'You find 35 bolts inside. They do not stir.' },
          { weight: 30, effect: { type: 'hp_loss', amount: 8 },     text: 'Their hand snaps shut on your wrist. The cold bites. (-8 HP)' },
        ],
      },
      {
        id: 'leave',
        label: 'Leave them be',
        outcomes: [
          { weight: 100, effect: { type: 'none' }, text: 'You walk on. The snow falls a little softer behind you.' },
        ],
      },
    ],
  },
]);
