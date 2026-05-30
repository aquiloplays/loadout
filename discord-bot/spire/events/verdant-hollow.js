// Verdant Hollow — overgrown jungle, druids, fae bargains, root-runes.
// 5 events: 2 pure upside, 2 tradeoff, 1 gamble.

export const VERDANT_HOLLOW_EVENTS = Object.freeze([
  {
    id: 'mossy-shrine',
    name: 'The Mossy Shrine',
    description:
      "A shrine to a forgotten grove-spirit, its statue softened by centuries of moss. Wildflowers grow at its base, watered by an unseen spring.",
    choices: [
      {
        id: 'rest',
        label: 'Rest here a while',
        outcomes: [
          { weight: 100, effect: { type: 'hp_gain', amount: 20 }, text: 'You sleep among the flowers and wake whole. (+20 HP)' },
        ],
      },
      {
        id: 'pray',
        label: 'Leave an offering of bolts',
        outcomes: [
          { weight: 60, effect: { type: 'card_upgrade', count: 1 }, text: 'A vine creeps into your pack and improves a card.' },
          { weight: 40, effect: { type: 'card_grant', rarity: 'uncommon' }, text: 'A flower seeds into your hand and becomes a card.' },
        ],
      },
    ],
  },
  {
    id: 'fae-circle',
    name: 'The Fae Circle',
    description:
      "Mushrooms grow in a perfect ring. Faint music drifts from inside it. Three small figures wave you closer.",
    choices: [
      {
        id: 'step-in',
        label: 'Step into the circle',
        outcomes: [
          { weight: 45, effect: { type: 'relic_grant', tier: 'major' }, text: 'They crown you with vines and slip a major relic into your pocket.' },
          { weight: 35, effect: { type: 'card_remove', criteria: 'cheapest' }, text: 'They trade a card from your deck for a kiss on the cheek.' },
          { weight: 20, effect: { type: 'hp_loss', amount: 8 },                 text: 'You leave the circle and twelve hours have passed. (-8 HP from hunger)' },
        ],
      },
      {
        id: 'trade',
        label: 'Trade them a coin from outside the circle',
        outcomes: [
          { weight: 80, effect: { type: 'card_grant', rarity: 'rare' }, text: 'A small hand reaches out with a folded card. You pay 20 bolts.' },
          { weight: 20, effect: { type: 'bolts_loss', amount: 20 },     text: 'The hand snatches the coin. Nothing returns. (-20 bolts)' },
        ],
      },
      {
        id: 'flee',
        label: 'Hurry past',
        outcomes: [
          { weight: 100, effect: { type: 'none' }, text: 'The music fades behind you.' },
        ],
      },
    ],
  },
  {
    id: 'old-druid',
    name: 'The Old Druid',
    description:
      "A gnarled old man in bark-armor sits sharpening a stone knife. He looks up at you. 'I can prune your weakness,' he says, 'if you trust the cut.'",
    choices: [
      {
        id: 'be-pruned',
        label: 'Let him prune your deck',
        outcomes: [
          { weight: 100, effect: { type: 'card_remove', criteria: 'lowest-tier' }, text: 'He snips. A weak card is gone. You feel lighter.' },
        ],
      },
      {
        id: 'be-trained',
        label: 'Spar with him instead',
        outcomes: [
          { weight: 60, effect: { type: 'card_upgrade', count: 1 }, text: 'He thwacks you a dozen times, then nods. A card improves.' },
          { weight: 40, effect: { type: 'hp_loss', amount: 6 },     text: "He thwacks you a dozen times. That's it. (-6 HP)" },
        ],
      },
    ],
  },
  {
    id: 'root-rune',
    name: 'The Root-Rune',
    description:
      "A rune is burned into a great root that crosses your path. It pulses gently. A small sign reads: STAND ON IT IF YOU DARE.",
    choices: [
      {
        id: 'stand',
        label: 'Stand on the rune',
        outcomes: [
          { weight: 50, effect: { type: 'buff', name: 'rooted', floors: 4 },         text: 'Rooted: minions you summon gain +1 HP for 4 floors.' },
          { weight: 30, effect: { type: 'hp_gain', amount: 12 },                      text: 'The rune warms you. (+12 HP)' },
          { weight: 20, effect: { type: 'card_grant', rarity: 'uncommon' },           text: 'A bramble-card pushes up through the root and into your hand.' },
        ],
      },
      {
        id: 'skip',
        label: 'Step around it',
        outcomes: [
          { weight: 100, effect: { type: 'none' }, text: 'You give the rune a wide berth. Caution is its own reward, sometimes.' },
        ],
      },
    ],
  },
  {
    id: 'spore-mother',
    name: 'The Spore-Mother',
    description:
      "A mound of luminous fungus the size of a horse pulses in time with your heart. It seems to know you are there.",
    choices: [
      {
        id: 'inhale',
        label: 'Breathe in the spores',
        outcomes: [
          { weight: 55, effect: { type: 'card_grant', rarity: 'rare' }, text: 'A vision blooms in your mind. You wake with a new card.' },
          { weight: 30, effect: { type: 'hp_gain', amount: 10 },         text: 'Your blood runs clean. (+10 HP)' },
          { weight: 15, effect: { type: 'hp_loss', amount: 10 },         text: 'You cough up something black for an hour. (-10 HP)' },
        ],
      },
      {
        id: 'harvest',
        label: 'Cut a chunk away',
        outcomes: [
          { weight: 70, effect: { type: 'bolts_gain', amount: 25 }, text: 'The chunk fetches 25 bolts later at a market.' },
          { weight: 30, effect: { type: 'hp_loss', amount: 6 },     text: 'It bursts in your hand in a shower of spores. (-6 HP)' },
        ],
      },
    ],
  },
]);
