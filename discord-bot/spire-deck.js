// Spire NPC deck generator.
//
// generateSpireNpcDeck(env, seasonId, floor) → { championClass, cards[] }
//
// Pulls the floor's NPC row from spire_npcs (D1), reads its
// deck_template (JSON), and materialises a concrete 20-card deck
// using the catalogue + the template + season's curated card pool.
//
// Template shape (stored in spire_npcs.deck_template):
//   {
//     champion: 'warrior' | 'mage' | 'rogue' | 'ranger' | 'healer',
//     baseArchetype?: 'aggro' | 'control' | 'midrange' | 'tribal' | 'burn' | 'swarm',
//     poolTags?: string[],          // overrides season's curatedCardPool
//     sizeMin?: number,             // default 18
//     sizeMax?: number,             // default 20
//     raresAllowed?: number,        // default 0/1/2/3 by tier
//     forceCardIds?: string[],      // always include these (e.g. boss-only legendaries)
//     champion?: string,
//   }
//
// Tier baselines (when template fields are omitted):
//   easy   (floors 1-3):  16 cards, 0 rares, only commons + uncommons
//   medium (floors 4-6):  18 cards, 1 rare
//   hard   (floors 7-9):  20 cards, 2 rares
//   boss   (floor 10):    20 cards, 3 rares + 1 forced legendary + boss mechanic
//
// The card pool is the catalogue filtered by:
//   1. card.token === false (tokens can't appear in decks)
//   2. rarity allowed by the tier
//   3. (card.id OR card.name) substring-matches at least one poolTag
//      when poolTags is non-empty
//
// Deterministic when given a seed (matchId), so a player can't
// quit-retry to re-roll the boss into a softer deck.

import { CARDS } from './cards-content.js';
import { SPIRE_THEMES } from './spire-seasons.js';

const DEFAULTS = {
  easy:   { size: 16, rares: 0, allowedRarities: ['common', 'uncommon'] },
  medium: { size: 18, rares: 1, allowedRarities: ['common', 'uncommon', 'rare'] },
  hard:   { size: 20, rares: 2, allowedRarities: ['common', 'uncommon', 'rare'] },
  boss:   { size: 20, rares: 3, allowedRarities: ['common', 'uncommon', 'rare', 'legendary'] },
};

// Pull all non-token cards from the catalogue once. Module-level so
// every generator call is just a filter pass over a fresh array.
const NON_TOKEN_POOL = Object.values(CARDS)
  .filter(c => !c.token && c.type !== 'champion');

function seededRng(seedStr) {
  // FNV-1a 32-bit hash → seed Mulberry32 PRNG. Deterministic.
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let s = h || 1;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickN(arr, n, rng) {
  // Sample-without-replacement up to n. If arr.length < n, return all.
  const pool = arr.slice();
  const out = [];
  while (out.length < n && pool.length) {
    const i = Math.floor(rng() * pool.length);
    out.push(pool[i]);
    pool.splice(i, 1);
  }
  return out;
}

// Card-pool filter that respects:
//   - tier rarity allowlist
//   - season's curatedCardPool tags (substring on id OR name lowercase)
//   - override poolTags from the template (replaces season tags)
//   - mana curve sanity (skip cards with mana > 8 for easy/medium tiers)
function filterPoolByTagsAndTier(themeTags, templatePoolTags, tier) {
  const tagBag = (Array.isArray(templatePoolTags) && templatePoolTags.length)
    ? templatePoolTags
    : (themeTags || []);
  const tagsLower = tagBag.map(t => String(t).toLowerCase());
  const allowed = new Set(DEFAULTS[tier].allowedRarities);
  const manaCap = (tier === 'easy' || tier === 'medium') ? 7 : 12;
  return NON_TOKEN_POOL.filter(c => {
    if (!allowed.has(c.rarity)) return false;
    if (c.mana > manaCap) return false;
    if (!tagsLower.length) return true;
    const hay = (c.id + ' ' + (c.name || '')).toLowerCase();
    return tagsLower.some(tag => hay.includes(tag));
  });
}

// Untagged pool, fallback when the tagged pool is too thin to fill
// the deck size. Same rarity + mana filter.
function filterPoolByTier(tier) {
  const allowed = new Set(DEFAULTS[tier].allowedRarities);
  const manaCap = (tier === 'easy' || tier === 'medium') ? 7 : 12;
  return NON_TOKEN_POOL.filter(c => allowed.has(c.rarity) && c.mana <= manaCap);
}

// Resolve a champion cardId for the given class. The catalogue stores
// these as champ.<class> for every class except `healer` which uses
// champ.healer; safe to derive directly.
function championIdForClass(cls) {
  const id = `champ.${cls || 'warrior'}`;
  return CARDS[id] ? id : 'champ.warrior';
}

// Pulls the season's curated tags from spire-seasons.js by themeId.
function themeTagsForSeason(themeId) {
  const t = SPIRE_THEMES.find(s => s.themeId === themeId);
  return t?.curatedCardPool || [];
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Generate an NPC deck for a given floor, given the season + an NPC
 * row from spire_npcs (or null to fall back to tier defaults).
 *
 * @param {string} themeId, season themeId (e.g. 'ember-court')
 * @param {object} npcRow, { difficulty_tier, deck_template, ... } from spire_npcs
 * @param {string} seedKey, deterministic seed (use spire_runs.id + ':' + floor)
 * @returns {{championClass, cards: string[]}}
 */
export function generateSpireNpcDeck(themeId, npcRow, seedKey) {
  if (!npcRow) {
    // Fallback: tier-default deck with no theme tags. Used when the
    // spire_npcs roster hasn't been populated yet (admin setup gap).
    return generateFallbackDeck('medium', themeId, seedKey);
  }

  let template = {};
  try { template = JSON.parse(npcRow.deck_template || '{}'); }
  catch { template = {}; }

  const tier  = String(npcRow.difficulty_tier || 'medium').toLowerCase();
  const baseDefaults = DEFAULTS[tier] || DEFAULTS.medium;
  const size  = clamp(template.sizeMin || baseDefaults.size, 12, 24);
  const rares = template.raresAllowed != null
    ? clamp(template.raresAllowed, 0, 5)
    : baseDefaults.rares;
  const themeTags = themeTagsForSeason(themeId);
  const poolTags  = Array.isArray(template.poolTags) && template.poolTags.length
    ? template.poolTags : themeTags;
  const rng = seededRng((seedKey || '') + ':' + (npcRow.npc_key || ''));

  // 1. Forced cards first (e.g. boss-only legendaries from the seasonal
  //    exclusive list, present in the catalogue, gated by the template).
  const out = [];
  const forced = Array.isArray(template.forceCardIds) ? template.forceCardIds : [];
  for (const id of forced) {
    if (out.length >= size) break;
    if (CARDS[id] && !CARDS[id].token) out.push(id);
  }

  // 2. Themed pool, fill the bulk of the deck.
  const themed = filterPoolByTagsAndTier(themeTags, poolTags, tier);
  if (themed.length) {
    // Cap rare picks to the template's raresAllowed.
    const rareSlots = pickN(themed.filter(c => c.rarity === 'rare'), rares, rng).map(c => c.id);
    out.push(...rareSlots);
    // Remaining slots: commons + uncommons from the theme pool.
    const nonRares = themed.filter(c => c.rarity !== 'rare' && c.rarity !== 'legendary');
    while (out.length < size && nonRares.length) {
      const pick = nonRares[Math.floor(rng() * nonRares.length)];
      out.push(pick.id);
    }
  }

  // 3. Untagged fallback, if the theme pool was too thin, top up with
  //    catalogue commons/uncommons so the deck always fills.
  if (out.length < size) {
    const fallback = filterPoolByTier(tier).filter(c => c.rarity !== 'rare' && c.rarity !== 'legendary');
    while (out.length < size && fallback.length) {
      const pick = fallback[Math.floor(rng() * fallback.length)];
      out.push(pick.id);
    }
  }

  const championClass = String(template.champion || 'warrior');
  return {
    championClass,
    cards: out.slice(0, size),   // hard cap in case forced + themed overshoots
  };
}

function generateFallbackDeck(tier, themeId, seedKey) {
  const baseDefaults = DEFAULTS[tier] || DEFAULTS.medium;
  const rng = seededRng((seedKey || '') + ':fallback:' + (themeId || ''));
  const pool = filterPoolByTier(tier);
  const out = [];
  while (out.length < baseDefaults.size && pool.length) {
    const pick = pool[Math.floor(rng() * pool.length)];
    out.push(pick.id);
  }
  return { championClass: 'warrior', cards: out };
}

function clamp(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

// Pick the floor's difficulty tier given the floor number, when the
// caller doesn't have an NPC row yet (e.g. /season preview embed).
export function tierForFloor(floor) {
  if (floor >= 10) return 'boss';
  if (floor >= 7)  return 'hard';
  if (floor >= 4)  return 'medium';
  return 'easy';
}
