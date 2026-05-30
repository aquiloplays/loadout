// Spire Events — themed encounter catalogue.
//
// Each spire theme has its own module exporting an array of events.
// The map-resolver picks a random event from EVENTS_BY_THEME[themeId]
// when a player lands on an "event" tile during a run.
//
// EVENT SHAPE
// -----------
// {
//   id:          'theme-slug',          // unique within a theme
//   name:        'Display name',
//   description: 'Flavor text shown to player (2-3 sentences).',
//   choices: [
//     {
//       id:    'choice-slug',
//       label: 'Player-facing button text',
//       outcomes: [
//         { weight: 60, effect: { type: '...', ...payload }, text: 'Result flavor.' },
//         { weight: 40, effect: { type: '...' },             text: '...' },
//       ],
//     },
//     // ... 2-3 choices per event
//   ],
// }
//
// EFFECT TYPES
// ------------
//   card_grant     { rarity: 'common'|'uncommon'|'rare'|'epic'|'legendary', count?: 1 }
//   card_remove    { criteria: 'random'|'cheapest'|'lowest-tier' }
//   card_upgrade   { count?: 1 }
//   hp_gain        { amount: int }
//   hp_loss        { amount: int }
//   bolts_gain     { amount: int }
//   bolts_loss     { amount: int }
//   relic_grant    { tier: 'minor'|'major' }
//   buff           { name: 'string', floors: int }
//   none           {}
//
// BALANCE
// -------
//   ~30% of events are pure upside (no down-side outcome on any branch).
//   ~50% are tradeoffs (gain one resource at the cost of another).
//   ~20% are gambles (a low-probability bad outcome lurks behind a choice).
//
// Outcome weights within a choice should sum to ~100.

import { EMBER_COURT_EVENTS }      from './ember-court.js';
import { AURORA_SPIRE_EVENTS }     from './aurora-spire.js';
import { SUNKEN_VAULT_EVENTS }     from './sunken-vault.js';
import { VERDANT_HOLLOW_EVENTS }   from './verdant-hollow.js';
import { SANDSTORM_BAZAAR_EVENTS } from './sandstorm-bazaar.js';
import { FROST_CITADEL_EVENTS }    from './frost-citadel.js';
import { CLOCKWORK_FOUNDRY_EVENTS } from './clockwork-foundry.js';
import { MIRROR_GARDEN_EVENTS }    from './mirror-garden.js';
import { BONE_RELIQUARY_EVENTS }   from './bone-reliquary.js';
import { CINDER_APEX_EVENTS }      from './cinder-apex.js';
import { STARGAZER_COURT_EVENTS }  from './stargazer-court.js';
import { VELVET_CATACOMB_EVENTS }  from './velvet-catacomb.js';

export const EVENTS_BY_THEME = Object.freeze({
  'ember-court':       EMBER_COURT_EVENTS,
  'aurora-spire':      AURORA_SPIRE_EVENTS,
  'sunken-vault':      SUNKEN_VAULT_EVENTS,
  'verdant-hollow':    VERDANT_HOLLOW_EVENTS,
  'sandstorm-bazaar':  SANDSTORM_BAZAAR_EVENTS,
  'frost-citadel':     FROST_CITADEL_EVENTS,
  'clockwork-foundry': CLOCKWORK_FOUNDRY_EVENTS,
  'mirror-garden':     MIRROR_GARDEN_EVENTS,
  'bone-reliquary':    BONE_RELIQUARY_EVENTS,
  'cinder-apex':       CINDER_APEX_EVENTS,
  'stargazer-court':   STARGAZER_COURT_EVENTS,
  'velvet-catacomb':   VELVET_CATACOMB_EVENTS,
});
