// Progression — season templates + reward table.
//
// PROGRESSION-SYSTEM-DESIGN.md §8. Three templates locked in advance;
// after we cycle through them the engine wraps round to template 0
// again with a fresh seasonId so future seasons stay numbered.
//
// Reward calibration target:
// - Free track: bolts-heavy with a fragment trickle. A daily player
//   should reach tier ~25 in 90 days, ~30 if they push.
// - Premium track: 2× bolts at the base 1.0× Patreon multiplier; bigger
//   fragment + lootbox grants; exclusive badge at mid + max tier.

export const SEASON_LENGTH_MS = 90 * 86400_000;
export const TIER_XP_COST = 1000;
export const TIER_COUNT = 50;
export const CATCH_UP_DAYS = 7;
export const CATCH_UP_MULT = 1.5;

// 50-tier reward table. Each entry: { free: {...}, premium: {...} }.
// Numeric fields (bolts, fragments, lootboxes) scale per Patreon
// multiplier at claim time on the premium track. Badges + titles +
// flair frames are flat.
//
// Notes on the milestone tiers:
//   Tier 10 = mid badge + flair frame (premium)
//   Tier 25 = title unlock
//   Tier 50 = season-max badge + named flair frame
export const REWARD_BASE_TABLE = (() => {
  const rows = [];
  for (let t = 1; t <= TIER_COUNT; t++) {
    const free = {};
    const premium = {};
    // Bolts ramp gently 50 → 350 across the tiers.
    free.bolts = 40 + Math.round((t / TIER_COUNT) * 200);
    premium.bolts = free.bolts * 2;
    // Fragments every other tier on free, every tier on premium.
    if (t % 2 === 0) free.fragments = 25 + Math.floor(t / 2) * 5;
    premium.fragments = 50 + Math.floor(t / 2) * 8;
    // Lootboxes — every 5 tiers free, every 3 premium.
    if (t % 5 === 0) free.lootboxes = 1;
    if (t % 3 === 0) premium.lootboxes = 1;
    rows.push({ free, premium });
  }
  // Milestone overrides.
  rows[9].free.badgeId = '__season:mid';                              // tier 10
  rows[9].premium.badgeId = '__season:mid';
  rows[9].premium.flairFrame = '__season:mid-frame';
  rows[24].free.title = '__season:title-aspirant';                    // tier 25
  rows[24].premium.title = '__season:title-aspirant-premium';
  rows[24].premium.badgeId = '__season:premium-only';
  rows[49].free.badgeId = '__season:max';                             // tier 50
  rows[49].premium.badgeId = '__season:max';
  rows[49].premium.flairFrame = '__season:max-frame';
  return rows;
})();

// __season:* placeholders get rewritten per-template at season-active
// materialisation time (season.js will swap them for the template's
// midBadge / maxBadge / titles). Keeping placeholders lets us share
// the reward table across templates with only the cosmetic strings
// varying.

export const SEASON_TEMPLATES = [
  {
    seasonId: 's2026-q3-emberlight',
    theme:    'Emberlight',
    accent:   'crimson',
    midBadge: 'season-emberlight-mid',
    maxBadge: 'season-emberlight-max',
    seasonChallenges: [
      { id: 'emberlight-fire-deck', kind: 'cards.match.won.pvp', withMeta: { archetype: 'burn' }, countAtLeast: 25, xp: 250, title: 'Pyromancer' },
      { id: 'emberlight-defender',  kind: 'clash.defended.goblin', countAtLeast: 30, xp: 250, title: 'Goblin Bane (Emberlight)' },
      { id: 'emberlight-roller',    kind: 'quick.game.bigwin', countAtLeast: 20, xp: 150, title: 'Hot Streak' },
    ],
  },
  {
    seasonId: 's2026-q4-winterforge',
    theme:    'Winterforge',
    accent:   'sapphire',
    midBadge: 'season-winterforge-mid',
    maxBadge: 'season-winterforge-max',
    seasonChallenges: [
      { id: 'winterforge-control', kind: 'cards.match.won.pvp', withMeta: { archetype: 'control' }, countAtLeast: 30, xp: 300, title: 'Frost Architect' },
      { id: 'winterforge-craft',   kind: 'cards.crafted', countAtLeast: 50, xp: 250, title: 'Forge Master' },
      { id: 'winterforge-clash',   kind: 'clash.raid.won.3', countAtLeast: 15, xp: 250, title: 'Cold Star' },
    ],
  },
  {
    seasonId: 's2027-q1-voltaic-storm',
    theme:    'Voltaic Storm',
    accent:   'violet',
    midBadge: 'season-voltaic-mid',
    maxBadge: 'season-voltaic-max',
    seasonChallenges: [
      { id: 'voltaic-mage',     kind: 'cards.match.won.pvp', withMeta: { archetype: 'midrange' }, countAtLeast: 30, xp: 300, title: 'Storm Speaker' },
      { id: 'voltaic-towers',   kind: 'clash.town.th-reached', withMeta: { th: 8 }, countAtLeast: 1, xp: 400, title: 'Architect of the Storm' },
      { id: 'voltaic-arcade',   kind: 'quick.game.played', countAtLeast: 200, xp: 200, title: 'Spark Hunter' },
    ],
  },
];
