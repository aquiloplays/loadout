// Boltbound — expansion-set registry + release scheduling.
//
// Single source of truth for which card sets exist, their theme/palette,
// the mechanics they lean on, and WHEN they unlock. Pure metadata: this
// module imports nothing (so cards-content.js can import SET_IDS for
// validation without a require cycle). Card COUNTS are computed at the
// call site from the catalogue (see cards-web.js routeSets).
//
// Release model: a set's cards are hidden from pack pulls + the deck
// builder until `releaseUtc`. `core` is always live. New quarterly drops
// are $3 each ($12/year) — the price lives on the storefront, not here.
//
// Scheduling note: every timestamp is computed with Date.UTC at module
// load (NOT Date.now), so the registry itself stays deterministic; only
// the isReleased()/timeUntil() helpers read the clock, and they take an
// explicit `now` so callers in deterministic contexts can pass a fixed
// value.

const D = (y, m, d) => Date.UTC(y, m - 1, d);   // m is 1-based for sanity

// Placeholder release for STAGED-but-unreleased expansions. Clay flips a
// set live by writing a KV override (see boltbound-release.js + the admin
// endpoint POST /web/admin/expansion/<slug>/release). The registry date
// stays in 2099 so a set is hidden until someone explicitly releases it,
// and reverting (POST .../hide) drops the override back to this placeholder.
const UNRELEASED = D(2099, 12, 31);

export const SETS = {
  core: {
    id: 'core',
    name: 'Core',
    releaseUtc: D(2026, 5, 1),
    plannedCount: null,                 // the whole legacy catalogue
    quarter: 'Live',
    theme: { primary: '#7c5cff', secondary: '#22d3ee', accent: '#5bff95' },
    blurb: 'The founding Boltbound catalogue. Always in rotation.',
    mechanics: ['Taunt', 'Charge', 'Battlecry', 'Deathrattle'],
    hidden: false,                      // core is never shown as "purchasable"
  },
  voidborn: {
    id: 'voidborn',
    name: 'Voidborn',
    releaseUtc: UNRELEASED,             // staged hidden until Clay releases it
    plannedCount: 200,
    quarter: 'Q3 2026',
    theme: { primary: '#7b2cff', secondary: '#3dd66a', accent: '#b388ff' },
    blurb: 'Cosmic horror crawls in from the dark between stars. What dies down there does not always stay dead.',
    mechanics: ['Stealth', 'Reborn', 'Recruit', 'Deathrattle'],
    tribe: 'umbra',
  },
  'tides-of-aether': {
    id: 'tides-of-aether',
    name: 'Tides of Aether',
    releaseUtc: UNRELEASED,             // Q4 2026 (staged hidden)
    plannedCount: 200,
    quarter: 'Q4 2026',
    theme: { primary: '#1e6fff', secondary: '#22d3ee', accent: '#7fe7ff' },
    blurb: 'The storm-tide rises. Freeze the board, ride the Overload, and let the spells do the talking.',
    mechanics: ['Freeze', 'Overload', 'Spell Damage', 'Tide tribal'],
    tribe: 'tide',
  },
  'embercrown-rising': {
    id: 'embercrown-rising',
    name: 'Embercrown Rising',
    releaseUtc: UNRELEASED,             // Q1 2027 (staged hidden)
    plannedCount: 200,
    quarter: 'Q1 2027',
    theme: { primary: '#ff5a3c', secondary: '#ffc24b', accent: '#ff8a5b' },
    blurb: 'A crown forged in open flame. Strike first, chain the Combo, and burn the rest down.',
    mechanics: ['Combo', 'Charge', 'Rush', 'Inferno tribal'],
    tribe: 'inferno',
  },
  'verdant-awakening': {
    id: 'verdant-awakening',
    name: 'Verdant Awakening',
    releaseUtc: UNRELEASED,             // Q2 2027 (staged hidden)
    plannedCount: 200,
    quarter: 'Q2 2027',
    theme: { primary: '#27c93f', secondary: '#7dffb0', accent: '#39ffc2' },
    blurb: 'Something old wakes under the roots. It grows whether you tend it or not.',
    mechanics: ['Adapt', 'End-of-Turn buffs', 'Lifesteal', 'Verdant tribal'],
    tribe: 'verdant',
  },
};

export const SET_IDS = Object.keys(SETS);

export function getSet(setId) { return SETS[setId] || null; }

export function isReleased(setId, now = Date.now()) {
  const s = SETS[setId];
  if (!s) return false;
  return now >= s.releaseUtc;
}

// ms until a set unlocks (0 if already live, null if unknown set).
export function timeUntilRelease(setId, now = Date.now()) {
  const s = SETS[setId];
  if (!s) return null;
  return Math.max(0, s.releaseUtc - now);
}

// Sets the player can actually open / build with right now.
export function releasedSetIds(now = Date.now()) {
  return SET_IDS.filter(id => isReleased(id, now));
}

// A set counts as "newly released" for the first 7 days after launch —
// drives the site banner + the expansion.released announcement window.
const NEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export function isNewlyReleased(setId, now = Date.now()) {
  const s = SETS[setId];
  if (!s) return false;
  return now >= s.releaseUtc && (now - s.releaseUtc) < NEW_WINDOW_MS;
}

// The most-recently-released set (used as the pack-opener default).
export function latestReleasedSetId(now = Date.now()) {
  const live = releasedSetIds(now)
    .filter(id => id !== 'core')
    .sort((a, b) => SETS[b].releaseUtc - SETS[a].releaseUtc);
  return live[0] || 'core';
}
