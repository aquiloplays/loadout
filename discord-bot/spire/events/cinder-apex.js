// Cinder Apex, volcano summit, ash, dragons, lava-glass forges.
// 5 events: 1 pure upside, 2 tradeoff, 2 gamble.

export const CINDER_APEX_EVENTS = Object.freeze([
  {
    id: 'ash-pilgrim',
    name: 'The Ash Pilgrim',
    description:
      "A figure wrapped head-to-toe in soot-cloth kneels beside the path, palms open. Ash drifts across the trail.",
    choices: [
      {
        id: 'alms',
        label: 'Give 20 bolts',
        outcomes: [
          { weight: 100, effect: { type: 'buff', name: 'ash-blessing', floors: 5 }, text: 'Ash-Blessing: heal 2 HP per floor for 5 floors.' },
        ],
      },
      {
        id: 'food',
        label: 'Share your rations',
        outcomes: [
          { weight: 100, effect: { type: 'hp_gain', amount: 8 }, text: 'They press a small charm into your hand. You feel watched over. (+8 HP)' },
        ],
      },
      {
        id: 'pass',
        label: 'Walk past',
        outcomes: [
          { weight: 100, effect: { type: 'none' }, text: 'The ash settles back into their palms.' },
        ],
      },
    ],
  },
  {
    id: 'dragon-egg',
    name: "The Dragon's Egg",
    description:
      "A leathery egg the size of a barrel rests on a basalt shelf above a lava vent. Something kicks inside it. Once.",
    choices: [
      {
        id: 'take',
        label: 'Steal the egg',
        outcomes: [
          { weight: 40, effect: { type: 'relic_grant', tier: 'major' }, text: 'You slip away with the egg. A major relic warm in your pack.' },
          { weight: 35, effect: { type: 'hp_loss', amount: 18 },         text: 'The mother returns. You leave the egg and flee. (-18 HP)' },
          { weight: 25, effect: { type: 'card_grant', rarity: 'epic' }, text: 'The egg cracks open. A small wyrm bonds to you and becomes a card.' },
        ],
      },
      {
        id: 'warm',
        label: 'Add wood to the brazier and warm the egg',
        outcomes: [
          { weight: 70, effect: { type: 'card_grant', rarity: 'rare' }, text: 'A new wyrm joins your deck.' },
          { weight: 30, effect: { type: 'hp_gain', amount: 10 },         text: 'You feel oddly proud. (+10 HP)' },
        ],
      },
      {
        id: 'leave',
        label: 'Leave it',
        outcomes: [
          { weight: 100, effect: { type: 'none' }, text: 'The egg rocks once and goes still.' },
        ],
      },
    ],
  },
  {
    id: 'lava-glass-forge',
    name: 'The Lava-Glass Forge',
    description:
      "An unattended forge sits open at the trailside. A vat of molten glass bubbles in its heart. A pair of tongs lies ready.",
    choices: [
      {
        id: 'forge',
        label: 'Forge a piece of equipment',
        outcomes: [
          { weight: 60, effect: { type: 'card_upgrade', count: 2 }, text: 'You hammer until two cards in your deck glow keener.' },
          { weight: 40, effect: { type: 'hp_loss', amount: 8 },     text: 'The glass splinters; you catch a shard in the cheek. (-8 HP)' },
        ],
      },
      {
        id: 'pour-relic',
        label: 'Pour a small relic-mold (-25 bolts)',
        outcomes: [
          { weight: 75, effect: { type: 'relic_grant', tier: 'minor' }, text: 'A lava-glass charm cools in your palm.' },
          { weight: 25, effect: { type: 'relic_grant', tier: 'major' }, text: 'It comes out unreasonably well. Major relic.' },
        ],
      },
    ],
  },
  {
    id: 'caldera-rim',
    name: 'The Caldera Rim',
    description:
      "The trail narrows to a thin lip over the caldera. The wind howls. Coins glint among the rocks at the very edge.",
    choices: [
      {
        id: 'reach',
        label: 'Reach for the coins',
        outcomes: [
          { weight: 50, effect: { type: 'bolts_gain', amount: 50 }, text: 'You snatch 50 bolts and stagger back to safety.' },
          { weight: 30, effect: { type: 'hp_loss', amount: 15 },     text: 'The rock crumbles. You catch yourself, barely. (-15 HP)' },
          { weight: 20, effect: { type: 'relic_grant', tier: 'minor' }, text: 'Among the coins is a small lava-glass ring.' },
        ],
      },
      {
        id: 'shout',
        label: 'Shout into the caldera and walk on',
        outcomes: [
          { weight: 60, effect: { type: 'hp_gain', amount: 6 }, text: 'You feel lighter for it. (+6 HP)' },
          { weight: 40, effect: { type: 'none' },               text: 'The wind takes your voice and gives nothing back.' },
        ],
      },
    ],
  },
  {
    id: 'salamander-merchant',
    name: 'The Salamander Merchant',
    description:
      "A merchant whose lower half is a great red salamander coils across the path. Its eyes are kind. Its wares smell of brimstone.",
    choices: [
      {
        id: 'buy-card',
        label: 'Buy a flame-charm card (40 bolts)',
        outcomes: [
          { weight: 100, effect: { type: 'card_grant', rarity: 'epic' }, text: 'The card hisses softly as it enters your deck.' },
        ],
      },
      {
        id: 'buy-relic',
        label: 'Buy a heat-ward relic (60 bolts)',
        outcomes: [
          { weight: 100, effect: { type: 'relic_grant', tier: 'major' }, text: 'You feel cool, even as the air shimmers.' },
        ],
      },
      {
        id: 'haggle',
        label: 'Haggle aggressively',
        outcomes: [
          { weight: 50, effect: { type: 'card_grant', rarity: 'rare' }, text: 'You get a card at a steep discount.' },
          { weight: 50, effect: { type: 'hp_loss', amount: 10 },         text: 'The salamander spits. You flee, scorched. (-10 HP)' },
        ],
      },
    ],
  },
]);
