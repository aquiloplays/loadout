// Card-art suggestion helpers, given a Boltbound cardId, derive
// (a) 4-6 Giphy/Tenor search terms that match the card's name +
// function so the editor UI can pre-populate suggestions, and (b)
// a 1-line plain-English description rendered alongside the card.
//
// Surface is /web/cards/suggest-art-terms (see web.js). Site does
// the actual Giphy search using the returned terms.
//
// No state, pure read against the static cards-content catalogue.

import { CARDS } from './cards-content.js';

// Words a name-token like "the", "of", "a" carry no search signal;
// drop them so search terms stay focused on the evocative words.
const STOPWORDS = new Set([
  'the', 'of', 'a', 'an', 'and', 'or', 'to', 'for', 'in', 'on',
  'at', 'with', 'by', 'from', 'as', 'is', 'be',
]);

// Effect-name → search-term overrides. The card system uses dry
// internal names ('damage', 'heal'); meme-GIF search wants vivid
// evocations ('explosion', 'healing'). Multiple terms allowed per
// effect, picker can de-dup downstream.
const EFFECT_TERMS = {
  damage:    ['explosion', 'attack'],
  heal:      ['healing', 'recovery'],
  draw:      ['shuffle cards', 'magic'],
  buff:      ['power up', 'transformation'],
  debuff:    ['weakened', 'fail'],
  summon:    ['summoning', 'portal'],
  destroy:   ['destruction', 'smash'],
  silence:   ['mute', 'shush'],
  freeze:    ['frozen', 'ice'],
  stun:      ['knockout', 'dizzy'],
  taunt:     ['challenge', 'fight me'],
  lifesteal: ['vampire', 'drain'],
  stealth:   ['sneak', 'hidden'],
  charge:    ['charge', 'rush'],
};

// Keyword → search-term mappings (Boltbound's `keywords` array lives
// alongside abilities; not always 1-1 with EFFECT_TERMS).
const KEYWORD_TERMS = {
  charge:    ['charge'],
  stealth:   ['sneak attack'],
  taunt:     ['provoke'],
  lifesteal: ['vampire'],
  poison:    ['toxic'],
  rush:      ['rush'],
  flying:    ['flying'],
};

// Type-based floor so a generic card name still has SOMETHING to
// search on.
const TYPE_FALLBACK = {
  champion: ['hero', 'champion'],
  minion:   ['monster', 'creature'],
  spell:    ['magic', 'spell'],
  token:    ['minion', 'helper'],
};

function tokenizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t && !STOPWORDS.has(t));
}

// Given a cardId, return suggested search terms + description.
// Falls back gracefully when the card isn't in the catalogue.
export function suggestArtTerms(cardId) {
  const card = CARDS[cardId];
  if (!card) {
    return { ok: false, error: 'unknown-card', cardId };
  }
  const terms = new Set();

  // 1. Name tokens, usually the most evocative cues.
  const nameWords = tokenizeName(card.name);
  for (const tok of nameWords) terms.add(tok);

  // 2. Multi-word phrases from the name (e.g. "Lightning Strike" gets
  // both "lightning" + "lightning strike", phrase often searches
  // better on Giphy than single words).
  if (nameWords.length >= 2) {
    terms.add(nameWords.slice(0, 2).join(' '));
  }

  // 3. Ability effects.
  for (const ab of (card.abilities || [])) {
    const fx = String(ab?.effect || '').toLowerCase();
    if (EFFECT_TERMS[fx]) for (const t of EFFECT_TERMS[fx]) terms.add(t);
  }

  // 4. Keywords.
  for (const kw of (card.keywords || [])) {
    const lk = String(kw).toLowerCase();
    if (KEYWORD_TERMS[lk]) for (const t of KEYWORD_TERMS[lk]) terms.add(t);
    else terms.add(lk);
  }

  // 5. Type-based floor.
  const typeTerms = TYPE_FALLBACK[String(card.type || '').toLowerCase()] || ['fantasy'];
  for (const t of typeTerms) terms.add(t);

  // Trim to a useful count. Order by string length (shorter first =
  // broader search) so the editor's first picks are the most
  // searchable.
  const list = [...terms].sort((a, b) => a.length - b.length).slice(0, 6);
  return {
    ok: true,
    cardId,
    cardName:    card.name,
    cardType:    card.type,
    searchTerms: list,
    description: describeCard(card),
  };
}

// 1-line plain-English description. Prefer the catalogue's `text`
// field (already human-written) but stitch one together from
// type/mana/stats/keywords/abilities if missing. Capped at 200
// chars so it fits under the card art in any embed.
export function describeCard(card) {
  if (!card) return '';
  const typeLabel = ({
    champion: 'Champion',
    minion:   'Minion',
    spell:    'Spell',
    token:    'Token',
  })[String(card.type || '').toLowerCase()] || 'Card';

  if (card.text && typeof card.text === 'string' && card.text.trim()) {
    const stats = (card.type === 'minion' || card.type === 'champion')
      ? ` (${card.atk}/${card.hp})`
      : '';
    return `${typeLabel}${stats}, ${card.text.trim()}`.slice(0, 200);
  }

  const parts = [];
  if (card.type === 'minion' || card.type === 'champion') {
    parts.push(`${card.atk}/${card.hp}`);
  }
  if (Array.isArray(card.keywords) && card.keywords.length) {
    parts.push(card.keywords.join(', '));
  }
  if (Array.isArray(card.abilities) && card.abilities.length) {
    const ab = card.abilities[0];
    if (ab?.effect) {
      parts.push(`${ab.trigger || 'on play'}: ${ab.effect}${ab.value ? ' ' + ab.value : ''}`);
    }
  }
  if (parts.length === 0) parts.push('No effect text on file.');
  return `${typeLabel}, ${parts.join(' · ')}`.slice(0, 200);
}
