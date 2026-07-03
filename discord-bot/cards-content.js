// Boltbound, card catalogue + ability schema + champion + NPC decks.
//
// Static content only, no KV I/O. Imported by cards-battle.js (ability
// dispatch), cards-packs.js (rarity pools for pull rolls), and
// cards-decks.js (per-card deck-cap lookups).
//
// See CARD-GAME-DESIGN.md §3 for the locked roster shape. Card IDs are
// stable identifiers, collection records reference cards by id, so
// renaming an existing card means MIGRATING the collection, not just
// renaming the key here.
//
// Sprite convention (matches Clash + Character systems):
//   aquilo-gg/sprites/cards/<cardId>.png        common/uncommon/rare 64x80 PNG
//   aquilo-gg/sprites/cards/<cardId>.png        legendary tier: APNG animated
// Both are served from https://aquilo.gg/sprites/cards/<cardId>.png, the
// extension is .png either way (animated PNGs use the .png extension).
//
// LOCKED ABILITY KEYS, extending this set is the right place to grow
// the design space; ad-hoc ability strings in card records are NOT
// supported. The battle resolver only understands what's listed here.

// ── Ability key dictionary ───────────────────────────────────────────
//
// Each card's `abilities` field is an array of { trigger, effect, ... }
// entries. The resolver walks them in array order on each trigger fire.
// Effects can have side-effects on the match state; targets are picked
// either deterministically (e.g. 'allEnemyMinions') or via the seeded
// RNG ('randomEnemyMinion'). Spell cards have abilities under the
// implicit 'onCast' trigger.

// Effect backfill for the 174 vanilla filler cards (see
// tools/gen-card-effects.mjs). Merged onto the matching cards in the
// CARDS assembly below so the effects persist for the engine, the site,
// and card-art regens alike. Each entry is a single engine-supported
// keyword (power-budgeted) + matching text.
import { GENERATED_EFFECTS } from './card-effects-backfill.js';
import { SET_IDS } from './boltbound-sets.js';

export const TRIGGERS = [
  'onPlay',         // minion summoned from hand, OR spell cast
  'onCast',         // alias for onPlay used by spell cards
  'onAttack',       // minion is the attacker this strike
  'onDamage',       // minion took damage (incl. attackers via combat)
  'onDeath',        // minion died (HP <= 0)
  'endOfTurn',      // end of *your* turn (the side this minion belongs to)
  'startOfTurn',    // start of *your* turn
  'combo',          // fires only if this is NOT the first card you played this turn
];

export const EFFECTS = [
  'damage',         // value: N. target: see TARGETS. RNG-amenable.
  'heal',           // value: N. target: see TARGETS.
  'draw',           // value: N. self only.
  'discard',        // value: N. target: self or opp. Random hand discard.
  'summon',         // value: cardId of token to summon. target: side ('self'|'opp')
  'buff',           // valueAtk, valueHp. target: see TARGETS. Permanent.
  'buffThisTurn',   // valueAtk. target: see TARGETS. Wears off endOfTurn.
  'destroy',        // target: see TARGETS. Sets HP to 0 directly.
  'returnToHand',   // target: see TARGETS. With optional buffAtk/buffHp.
  'copyOpponentCard', // target: random card in opponent's hand. To self hand.
  'silence',        // strip all abilities + status from target minion
  'counter',        // mark next opponent spell as countered
  'manaThisTurn',   // value: N. Adds temporary mana to self this turn only.
  'peekDeck',       // value: N. Look at the top N of deck (UI affordance).
  // ('fatigue' as a card EFFECT was declared but never implemented in
  // runEffect; removed so schemaCheck can't approve a silent-no-op card.
  // Deck-empty fatigue lives in drawTurnStart; the Cinder Apex boss's
  // fatigue doubling is a separate spire mechanic, both unaffected.)
  'freeze',         // target: see TARGETS. Frozen minions skip their next turn.
  'cloneSelf',      // summon a fresh copy of the source minion (self side).
  'reSummon',       // onDeath: resurrect the dying minion once (no loop).
  'revealAndDraw',  // value: N. Reveal the top N of deck and draw them.
  'doubleBattlecry',// re-fire the most recent other friendly minion's onPlay.
  // CR-2 (Voidborn expansion), deeper TCG mechanics.
  'recruit',        // value: maxMana. Pull a friendly minion of cost<=N from
                    //   your deck and summon it to your board.
  'adapt',          // grant the source one of a deterministic buff set (see
                    //   ADAPT_POOL). action.adaptChoice picks; else seeded.
  'discover',       // reveal 3 candidate cards (by ab.pool/type) and add one
                    //   to hand. action.discoverChoice picks; else seeded.
];

export const TARGETS = [
  'oppHero',
  'selfHero',
  'pickedTarget',         // chosen by the player at play-time (a minion or hero)
  'allEnemyMinions',
  'allEnemy',              // all enemy minions PLUS the enemy hero
  'allEnemies',           // alias of allEnemy (legacy spelling on one card)
  'allFriendlyMinions',
  'allMinions',
  'allOtherMinions',      // every minion on the board except the source
  'randomEnemyMinion',
  'randomFriendlyMinion',
  'oppHand',
  'selfHand',
  'self',                 // the card itself (for onDeath returnToHand etc.)
  'sourceMinion',         // the minion that owns the ability (onAttack self-heal)
  'lastDeadFriendly',     // resurrect target, last friendly that hit graveyard
  'allFriendlyTribe',     // friendly minions sharing ab.tribe (tribal synergy)
];

export const KEYWORDS = [
  'taunt',         // enemy attackers must target a taunt before other minions/hero
  'charge',        // can attack the turn played
  'rush',          // can attack the turn played, MINIONS ONLY (not enemy hero)
  'shield',        // first damage instance is negated; consumed on use (Ward)
  'stealth',       // cannot be targeted by enemies until this minion attacks (Veiled)
  'lifesteal',     // damage dealt by this minion heals self hero (Drain)
  'poison',        // any damage this minion deals to a minion kills it (Venomous)
  'reach',         // can attack hero even when enemy has taunts
  'spell-immune',  // ignored by enemy spells
  'reborn',        // first time it dies, returns to the board with 1 HP (Phoenix)
];

// Tribal tags (the `tribe` field on a card). Cards with matching tribes
// can buff/check one another via the allFriendlyTribe target. Aquilo
// flavour names map onto the six expansion families:
//   inferno (fire) · tide (water) · tempest (storm) · hallow (light)
//   · umbra (shadow) · verdant (nature).
export const TRIBES = ['inferno', 'tide', 'tempest', 'hallow', 'umbra', 'verdant'];

// Adapt buff pool, the source minion gains one of these on adapt. Kept
// deterministic + small so the engine can resolve it without a UI round
// trip (action.adaptChoice picks an index; otherwise the seeded RNG does).
export const ADAPT_POOL = [
  { label: '+1/+1',        buff: { valueAtk: 1, valueHp: 1 } },
  { label: '+3 attack',    buff: { valueAtk: 3, valueHp: 0 } },
  { label: 'Taunt',        keyword: 'taunt' },
  { label: 'Ward',         keyword: 'shield' },
  { label: 'Drain',        keyword: 'lifesteal' },
  { label: 'Venomous',     keyword: 'poison' },
];

// Convenience normaliser used by the resolver. Cards always carry a
// `keywords` array (possibly empty) so the resolver can do
// `card.keywords.includes('taunt')` without null-guarding.
export function normaliseCard(c) {
  return {
    id: c.id,
    name: c.name,
    rarity: c.rarity,
    type: c.type,                // 'minion' | 'spell' | 'champion'
    mana: c.mana,
    atk: c.atk || 0,
    hp:  c.hp  || 0,
    keywords: Array.isArray(c.keywords) ? c.keywords.slice() : [],
    abilities: Array.isArray(c.abilities) ? c.abilities.map(a => ({ ...a })) : [],
    needsTarget: c.abilities?.some(a => a.target === 'pickedTarget') || false,
    text: c.text || '',
    flavor: c.flavor || '',      // display-only flavour line (Aquilo voice)
    token: !!c.token,            // tokens cannot appear in decks
    spriteId: c.spriteId || `cards/${c.id}.png`,
    // CR-2 expansion-set fields. Cards without these default to the
    // original "core" set so the existing 1267-card catalogue is
    // unaffected (everything pre-expansion reads as set:'core').
    set: c.set || 'core',
    tribe: c.tribe || null,      // null = no tribe (most core cards)
    // Overload (X): the card costs its printed mana but locks X of your
    // mana crystals next turn. 0 = no overload. Clamped 0..3.
    overload: Math.max(0, Math.min(3, c.overload || 0)),
    // Choose One: when true, the card carries two onPlay ability groups
    // tagged `option:0` / `option:1`; the resolver fires the one the
    // player picked (action.chooseOption), defaulting to 0.
    chooseOne: !!c.chooseOne,
  };
}

// ── Champions ────────────────────────────────────────────────────────
//
// Mirror discord-bot/dungeon.js CLASSES. Each viewer's deck contains
// EXACTLY ONE Champion card, bound to whatever class their HeroState
// currently has. A class swap auto-updates every deck's Champion.
//
// Champions are NOT pullable from packs, they're granted on
// first-/boltbound and re-granted on class change.

const CHAMPIONS_RAW = {
  warrior: {
    id: 'champ.warrior',
    name: 'Champion of Steel',
    rarity: 'champion', type: 'champion',
    mana: 4, atk: 4, hp: 6,
    keywords: ['charge'],
    text: 'Charge. (Can attack the turn it\'s played.)',
  },
  mage: {
    id: 'champ.mage',
    name: 'Champion of Arcana',
    rarity: 'champion', type: 'champion',
    mana: 4, atk: 3, hp: 4,
    keywords: [],
    abilities: [{ trigger: 'onPlay', effect: 'damage', target: 'pickedTarget', value: 2 }],
    text: 'Battlecry: deal 2 damage to any target.',
  },
  rogue: {
    id: 'champ.rogue',
    name: 'Champion of Shadows',
    rarity: 'champion', type: 'champion',
    mana: 3, atk: 4, hp: 5,
    keywords: ['stealth'],
    text: 'Stealth (cannot be targeted next turn).',
  },
  ranger: {
    id: 'champ.ranger',
    name: 'Champion of the Wilds',
    rarity: 'champion', type: 'champion',
    mana: 4, atk: 3, hp: 5,
    keywords: ['reach'],
    text: 'Reach (can attack the enemy hero even through Taunts).',
  },
  healer: {
    id: 'champ.healer',
    name: 'Champion of Light',
    rarity: 'champion', type: 'champion',
    mana: 4, atk: 2, hp: 5,
    keywords: [],
    abilities: [
      { trigger: 'onPlay',    effect: 'heal', target: 'selfHero', value: 4 },
      { trigger: 'endOfTurn', effect: 'heal', target: 'selfHero', value: 1 },
    ],
    text: 'Battlecry: heal you 4. End of your turn: heal you 1.',
  },
};

export const CHAMPIONS = Object.fromEntries(
  Object.entries(CHAMPIONS_RAW).map(([k, c]) => [k, normaliseCard(c)])
);

// Map a dungeon class key -> Champion card id. dungeon.js uses
// 'warrior'/'mage'/'rogue'/'ranger'/'healer' for `hero.className`.
export function championForClass(cls) {
  return CHAMPIONS[cls]?.id || CHAMPIONS.warrior.id;
}

// ── Legendaries, heroes (5) ─────────────────────────────────────────
//
// See CARD-GAME-DESIGN.md §3.2. One copy per deck. Animated APNG sprite
// tier (matches Excalibur in the dungeon catalogue).

const LEGEND_HEROES = [
  {
    id: 'leg.solara',
    name: 'Solara, the Sunblade',
    rarity: 'legendary', type: 'minion',
    mana: 7, atk: 5, hp: 7,
    abilities: [{ trigger: 'onPlay', effect: 'damage', target: 'allEnemyMinions', value: 3 }],
    text: 'Battlecry: deal 3 damage to all enemy minions.',
  },
  {
    id: 'leg.korrik',
    name: 'Korrik the Bonecrusher',
    rarity: 'legendary', type: 'minion',
    mana: 6, atk: 6, hp: 8,
    keywords: ['taunt', 'spell-immune'],
    text: 'Taunt. Cannot be targeted by spells.',
  },
  {
    id: 'leg.mireth',
    name: 'Mireth, Relic Whisperer',
    rarity: 'legendary', type: 'minion',
    mana: 5, atk: 3, hp: 4,
    abilities: [{ trigger: 'onPlay', effect: 'copyOpponentCard', target: 'oppHand' }],
    text: 'Battlecry: copy a random card in your opponent\'s hand into your hand.',
  },
  {
    id: 'leg.thalor',
    name: 'Thalor, the Stormwarden',
    rarity: 'legendary', type: 'minion',
    mana: 8, atk: 6, hp: 6,
    abilities: [
      { trigger: 'onPlay', effect: 'damage', target: 'allEnemyMinions', value: 2 },
      { trigger: 'onPlay', effect: 'damage', target: 'oppHero', value: 2 },
    ],
    text: 'Battlecry: deal 2 damage to every enemy minion AND the enemy hero.',
  },
  {
    id: 'leg.nyx',
    name: 'Nyx, Pact-Bound',
    rarity: 'legendary', type: 'minion',
    mana: 5, atk: 4, hp: 5,
    abilities: [{ trigger: 'onDeath', effect: 'returnToHand', target: 'self', buffAtk: 1, buffHp: 1 }],
    text: 'Deathrattle: return to your hand with +1/+1.',
  },
];

// ── Legendaries, dungeon bosses (5) ─────────────────────────────────

const LEGEND_BOSSES = [
  {
    id: 'leg.bonetyrant',
    name: 'The Bone Tyrant',
    rarity: 'legendary', type: 'minion',
    mana: 9, atk: 8, hp: 10,
    keywords: ['taunt'],
    abilities: [
      { trigger: 'onDeath', effect: 'summon', target: 'self',  cardId: 'tok.boneknight' },
      { trigger: 'onDeath', effect: 'summon', target: 'self',  cardId: 'tok.boneknight' },
    ],
    text: 'Taunt. Deathrattle: summon two 3/3 Bone Knights.',
  },
  {
    id: 'leg.voltaicwyrm',
    name: 'Voltaic Wyrm',
    rarity: 'legendary', type: 'minion',
    mana: 8, atk: 7, hp: 7,
    keywords: ['charge'],
    abilities: [{ trigger: 'onAttack', effect: 'damage', target: 'allOtherMinions', value: 1 }],
    text: 'Charge. After this attacks, deal 1 damage to every OTHER minion.',
  },
  {
    id: 'leg.vaultlich',
    name: 'The Relic Lich',
    rarity: 'legendary', type: 'minion',
    mana: 7, atk: 4, hp: 5,
    abilities: [{ trigger: 'onPlay', effect: 'draw', target: 'self', value: 3 }],
    text: 'Battlecry: draw 3 cards.',
  },
  {
    id: 'leg.warchief',
    name: 'Goblin Warchief',
    rarity: 'legendary', type: 'minion',
    mana: 6, atk: 5, hp: 6,
    abilities: [
      { trigger: 'onPlay', effect: 'summon', target: 'self', cardId: 'tok.gobscrap' },
      { trigger: 'onPlay', effect: 'summon', target: 'self', cardId: 'tok.gobscrap' },
      { trigger: 'onPlay', effect: 'summon', target: 'self', cardId: 'tok.gobscrap' },
    ],
    text: 'Battlecry: summon three 1/1 Goblin Scrappers with Charge.',
  },
  {
    id: 'leg.hollowking',
    name: 'The Hollow King',
    rarity: 'legendary', type: 'minion',
    mana: 10, atk: 10, hp: 12,
    keywords: ['cannot-attack-unless-3-spells'],   // resolver-special flag
    text: 'Cannot attack unless you played at least 3 spells this match.',
  },
];

// ── Rares (14) ───────────────────────────────────────────────────────

const RARES = [
  // Minions
  {
    id: 'r.voltaicmage', name: 'Voltaic Mage',
    rarity: 'rare', type: 'minion', mana: 4, atk: 3, hp: 4,
    abilities: [{ trigger: 'spellDamageBonus', effect: 'buff', target: 'self', value: 1 }],
    text: 'Your spells deal +1 damage while this is on the board.',
  },
  {
    id: 'r.sapper', name: 'Sapper Rogue',
    rarity: 'rare', type: 'minion', mana: 3, atk: 4, hp: 2,
    abilities: [{ trigger: 'onPlay', effect: 'destroy', target: 'pickedTarget', filter: { maxMana: 1, type: 'minion' } }],
    text: 'Battlecry: destroy a 1-mana enemy minion.',
  },
  {
    id: 'r.boltknight', name: 'Bolt Knight',
    rarity: 'rare', type: 'minion', mana: 4, atk: 4, hp: 5,
    keywords: ['taunt'],
    text: 'Taunt.',
  },
  {
    id: 'r.healercleric', name: 'Healer Cleric',
    rarity: 'rare', type: 'minion', mana: 2, atk: 1, hp: 3,
    abilities: [{ trigger: 'endOfTurn', effect: 'heal', target: 'randomFriendlyMinion', value: 2 }],
    text: 'End of your turn: heal a friendly minion for 2.',
  },
  {
    id: 'r.archertwin', name: 'Archer Twin',
    rarity: 'rare', type: 'minion', mana: 3, atk: 2, hp: 3,
    abilities: [
      { trigger: 'onPlay', effect: 'damage', target: 'pickedTarget', value: 1 },
      { trigger: 'onPlay', effect: 'damage', target: 'pickedTarget', value: 1 },
    ],
    text: 'Battlecry: deal 1 damage twice.',
  },
  {
    id: 'r.boltengineer', name: 'Bolt Engineer',
    rarity: 'rare', type: 'minion', mana: 2, atk: 2, hp: 2,
    abilities: [{ trigger: 'onPlay', effect: 'manaThisTurn', target: 'self', value: 1 }],
    text: 'Battlecry: gain 1 mana this turn only.',
  },
  {
    id: 'r.vaultsniffer', name: 'Relic Sniffer',
    rarity: 'rare', type: 'minion', mana: 1, atk: 1, hp: 2,
    abilities: [{ trigger: 'onPlay', effect: 'peekDeck', target: 'self', value: 1 }],
    text: 'Battlecry: look at the top card of your deck.',
  },
  // Spells
  {
    id: 'r.forgebrand', name: 'Forge Brand',
    rarity: 'rare', type: 'spell', mana: 2,
    abilities: [{ trigger: 'onCast', effect: 'buffThisTurn', target: 'pickedTarget', valueAtk: 2, valueHp: 2, filter: { type: 'friendly-minion' } }],
    text: 'Give a friendly minion +2/+2 this turn.',
  },
  {
    id: 'r.gobpowder', name: 'Goblin Powder',
    rarity: 'rare', type: 'spell', mana: 1,
    abilities: [{ trigger: 'onCast', effect: 'damage', target: 'pickedTarget', value: 2, filter: { type: 'minion' } }],
    text: 'Deal 2 damage to any minion.',
  },
  {
    id: 'r.voltaicsurge', name: 'Voltaic Surge',
    rarity: 'rare', type: 'spell', mana: 4,
    abilities: [
      { trigger: 'onCast', effect: 'damage', target: 'pickedTarget', value: 2 },
      { trigger: 'onCast', effect: 'damage', target: 'pickedTarget', value: 2 },
    ],
    text: 'Deal 4 damage split between any two targets.',
  },
  {
    id: 'r.vaultseal', name: 'Relic Seal',
    rarity: 'rare', type: 'spell', mana: 3,
    abilities: [{ trigger: 'onCast', effect: 'counter', target: 'oppNextSpell' }],
    text: 'Counter the next spell your opponent plays.',
  },
  {
    id: 'r.boltstorm', name: 'Bolt Storm',
    rarity: 'rare', type: 'spell', mana: 5,
    abilities: [
      { trigger: 'onCast', effect: 'damage', target: 'allEnemyMinions', value: 1 },
      { trigger: 'onCast', effect: 'damage', target: 'allEnemyMinions', value: 1 },
    ],
    text: 'Deal 1 damage to all enemy minions twice.',
  },
  {
    id: 'r.mend', name: 'Mend',
    rarity: 'rare', type: 'spell', mana: 1,
    abilities: [{ trigger: 'onCast', effect: 'heal', target: 'pickedTarget', value: 4, filter: { type: 'hero' } }],
    text: 'Heal a hero for 4.',
  },
  {
    id: 'r.resurrect', name: 'Resurrect',
    rarity: 'rare', type: 'spell', mana: 4,
    abilities: [{ trigger: 'onCast', effect: 'returnToHand', target: 'lastDeadFriendly' }],
    text: 'Return the last friendly minion that died to your hand.',
  },
];

// ── Uncommons (20) ───────────────────────────────────────────────────
//
// Each has ONE keyword or one tiny effect.

const UNCOMMONS = [
  { id: 'u.scrapper',     name: 'Scrapper',          mana: 1, atk: 2, hp: 1, type: 'minion', keywords: ['charge'],    text: 'Charge.' },
  { id: 'u.shieldguard',  name: 'Shield Guard',      mana: 2, atk: 1, hp: 4, type: 'minion', keywords: ['taunt'],     text: 'Taunt.' },
  { id: 'u.glasscat',     name: 'Glass Cat',         mana: 1, atk: 3, hp: 1, type: 'minion' },
  { id: 'u.honeybadger',  name: 'Honey Badger',      mana: 2, atk: 2, hp: 3, type: 'minion', keywords: ['poison'],    text: 'Poison.' },
  { id: 'u.spittingrat',  name: 'Spitting Rat',      mana: 2, atk: 1, hp: 2, type: 'minion',
    abilities: [{ trigger: 'onPlay', effect: 'damage', target: 'pickedTarget', value: 1 }],
    text: 'Battlecry: deal 1 damage.' },
  { id: 'u.runesinger',   name: 'Rune Singer',       mana: 3, atk: 2, hp: 3, type: 'minion',
    abilities: [{ trigger: 'onPlay', effect: 'draw', target: 'self', value: 1 }],
    text: 'Battlecry: draw a card.' },
  { id: 'u.stoutwarden',  name: 'Stout Warden',      mana: 3, atk: 2, hp: 5, type: 'minion', keywords: ['taunt'],     text: 'Taunt.' },
  { id: 'u.scoutarcher',  name: 'Scout Archer',      mana: 3, atk: 3, hp: 2, type: 'minion', keywords: ['reach'],     text: 'Reach.' },
  { id: 'u.bloodhound',   name: 'Bloodhound',        mana: 3, atk: 3, hp: 3, type: 'minion', keywords: ['lifesteal'], text: 'Lifesteal.' },
  { id: 'u.daggerthief',  name: 'Dagger Thief',      mana: 2, atk: 3, hp: 2, type: 'minion', keywords: ['stealth'],   text: 'Stealth.' },
  { id: 'u.warpriest',    name: 'War Priest',        mana: 4, atk: 3, hp: 4, type: 'minion',
    abilities: [{ trigger: 'onPlay', effect: 'heal', target: 'selfHero', value: 2 }],
    text: 'Battlecry: heal you 2.' },
  { id: 'u.tankknight',   name: 'Tank Knight',       mana: 5, atk: 4, hp: 6, type: 'minion', keywords: ['shield'],    text: 'Shield.' },
  { id: 'u.coppergolem',  name: 'Copper Golem',      mana: 4, atk: 3, hp: 5, type: 'minion' },
  { id: 'u.ironvanguard', name: 'Iron Vanguard',     mana: 5, atk: 4, hp: 5, type: 'minion', keywords: ['taunt'],     text: 'Taunt.' },
  { id: 'u.boltcarrier',  name: 'Bolt Carrier',      mana: 3, atk: 2, hp: 4, type: 'minion',
    abilities: [{ trigger: 'onDeath', effect: 'manaThisTurn', target: 'oppHero', value: -1 }],
    text: 'Deathrattle: opponent loses 1 mana next turn.' },
  // Uncommon spells
  { id: 'u.boltbolt',     name: 'Bolt',              mana: 1, type: 'spell',
    abilities: [{ trigger: 'onCast', effect: 'damage', target: 'pickedTarget', value: 2 }],
    text: 'Deal 2 damage.' },
  { id: 'u.smallheal',    name: 'Small Heal',        mana: 1, type: 'spell',
    abilities: [{ trigger: 'onCast', effect: 'heal', target: 'pickedTarget', value: 3, filter: { type: 'hero' } }],
    text: 'Heal a hero for 3.' },
  { id: 'u.smallbuff',    name: 'Smithing Touch',    mana: 1, type: 'spell',
    abilities: [{ trigger: 'onCast', effect: 'buff', target: 'pickedTarget', valueAtk: 1, valueHp: 1, filter: { type: 'friendly-minion' } }],
    text: 'Give a friendly minion +1/+1.' },
  { id: 'u.firebolt',     name: 'Fire Bolt',         mana: 2, type: 'spell',
    abilities: [{ trigger: 'onCast', effect: 'damage', target: 'pickedTarget', value: 3 }],
    text: 'Deal 3 damage.' },
  { id: 'u.cardraw2',     name: 'Quick Study',       mana: 2, type: 'spell',
    abilities: [{ trigger: 'onCast', effect: 'draw', target: 'self', value: 2 }],
    text: 'Draw 2 cards.' },
];

// ── Commons (32) ─────────────────────────────────────────────────────

const COMMONS = [
  // 1-mana
  { id: 'c.acolyte',     name: 'Acolyte',          mana: 1, atk: 1, hp: 2, type: 'minion' },
  { id: 'c.bolt1',       name: 'Tiny Bolt',        mana: 1, type: 'spell',
    abilities: [{ trigger: 'onCast', effect: 'damage', target: 'pickedTarget', value: 1 }], text: 'Deal 1 damage.' },
  { id: 'c.heal1',       name: 'Small Mend',       mana: 1, type: 'spell',
    abilities: [{ trigger: 'onCast', effect: 'heal', target: 'pickedTarget', value: 2, filter: { type: 'hero' } }], text: 'Heal a hero for 2.' },
  { id: 'c.gobrunt',     name: 'Goblin Runt',      mana: 1, atk: 2, hp: 1, type: 'minion' },
  // 2-mana
  { id: 'c.ironguard',   name: 'Iron Guard',       mana: 2, atk: 2, hp: 3, type: 'minion' },
  { id: 'c.imp',         name: 'Imp',              mana: 2, atk: 3, hp: 2, type: 'minion' },
  { id: 'c.skeleton',    name: 'Skeleton',         mana: 2, atk: 2, hp: 2, type: 'minion' },
  { id: 'c.lookout',     name: 'Lookout',          mana: 2, atk: 1, hp: 3, type: 'minion' },
  { id: 'c.smolspell',   name: 'Apprentice Spark', mana: 2, type: 'spell',
    abilities: [{ trigger: 'onCast', effect: 'damage', target: 'pickedTarget', value: 2 }], text: 'Deal 2 damage.' },
  // 3-mana
  { id: 'c.swordhand',   name: 'Swordhand',        mana: 3, atk: 3, hp: 3, type: 'minion' },
  { id: 'c.bowman',      name: 'Bowman',           mana: 3, atk: 2, hp: 4, type: 'minion' },
  { id: 'c.pagewizard',  name: 'Page Wizard',      mana: 3, atk: 2, hp: 3, type: 'minion' },
  { id: 'c.wolf',        name: 'Grey Wolf',        mana: 3, atk: 4, hp: 2, type: 'minion' },
  // 4-mana
  { id: 'c.captain',     name: 'Captain',          mana: 4, atk: 3, hp: 5, type: 'minion' },
  { id: 'c.boar',        name: 'Wild Boar',        mana: 4, atk: 4, hp: 4, type: 'minion' },
  { id: 'c.cleric4',     name: 'Cleric',           mana: 4, atk: 3, hp: 4, type: 'minion' },
  { id: 'c.zombie4',     name: 'Risen Zombie',     mana: 4, atk: 4, hp: 3, type: 'minion' },
  // 5-mana
  { id: 'c.knight5',     name: 'Knight',           mana: 5, atk: 4, hp: 5, type: 'minion' },
  { id: 'c.troll5',      name: 'Cave Troll',       mana: 5, atk: 5, hp: 4, type: 'minion' },
  { id: 'c.guardian5',   name: 'Guardian',         mana: 5, atk: 3, hp: 6, type: 'minion' },
  // 6-mana
  { id: 'c.ogre6',       name: 'Ogre',             mana: 6, atk: 6, hp: 5, type: 'minion' },
  { id: 'c.warlord6',    name: 'Warlord',          mana: 6, atk: 5, hp: 6, type: 'minion' },
  // 7-mana
  { id: 'c.warbear7',    name: 'War Bear',         mana: 7, atk: 7, hp: 6, type: 'minion' },
  // Common spells
  { id: 'c.flamesword',  name: 'Flame Sword',      mana: 3, type: 'spell',
    abilities: [{ trigger: 'onCast', effect: 'buff', target: 'pickedTarget', valueAtk: 2, valueHp: 0, filter: { type: 'friendly-minion' } }],
    text: 'Give a friendly minion +2 attack.' },
  { id: 'c.healflash',   name: 'Heal Flash',       mana: 2, type: 'spell',
    abilities: [{ trigger: 'onCast', effect: 'heal', target: 'pickedTarget', value: 4, filter: { type: 'hero' } }],
    text: 'Heal a hero for 4.' },
  { id: 'c.boltvolley',  name: 'Bolt Volley',      mana: 3, type: 'spell',
    abilities: [
      { trigger: 'onCast', effect: 'damage', target: 'pickedTarget', value: 1 },
      { trigger: 'onCast', effect: 'damage', target: 'pickedTarget', value: 1 },
      { trigger: 'onCast', effect: 'damage', target: 'pickedTarget', value: 1 },
    ],
    text: 'Deal 1 damage three times.' },
  { id: 'c.cardraw1',    name: 'Study',            mana: 1, type: 'spell',
    abilities: [{ trigger: 'onCast', effect: 'draw', target: 'self', value: 1 }],
    text: 'Draw a card.' },
  { id: 'c.smiteminion', name: 'Smite',            mana: 2, type: 'spell',
    abilities: [{ trigger: 'onCast', effect: 'damage', target: 'pickedTarget', value: 3, filter: { type: 'minion' } }],
    text: 'Deal 3 damage to a minion.' },
  { id: 'c.shieldself',  name: 'Iron Skin',        mana: 1, type: 'spell',
    abilities: [{ trigger: 'onCast', effect: 'buffThisTurn', target: 'selfHero', valueAtk: 0, valueHp: 4 }],
    text: 'Your hero gains +4 HP this turn (acts like a shield).' },
  { id: 'c.firebreath',  name: 'Fire Breath',      mana: 4, type: 'spell',
    abilities: [{ trigger: 'onCast', effect: 'damage', target: 'allEnemyMinions', value: 1 }],
    text: 'Deal 1 damage to all enemy minions.' },
  { id: 'c.battlecry',   name: 'Battle Cry',       mana: 3, type: 'spell',
    abilities: [{ trigger: 'onCast', effect: 'buffThisTurn', target: 'allFriendlyMinions', valueAtk: 1 }],
    text: 'Your minions have +1 attack this turn.' },
];

// ── Tokens, summoned, not pullable ──────────────────────────────────
//
// These cards never appear in a deck or the collection. They're spawned
// by other cards' summon effects.

const TOKENS = [
  { id: 'tok.boneknight', name: 'Bone Knight',     mana: 0, atk: 3, hp: 3, type: 'minion', token: true },
  { id: 'tok.gobscrap',   name: 'Goblin Scrapper', mana: 0, atk: 1, hp: 1, type: 'minion', token: true, keywords: ['charge'] },
];

// ── Compose the catalogue ────────────────────────────────────────────

// Rarity is set explicitly on champions/legendaries/rares above;
// uncommons/commons/tokens omit it for brevity and get it stamped here.
//
// CR-1 EXPANSION: cards-expansion.js generates ~1,170 additional cards
// across 15 families under the `<family>.<rarity-letter>NNN` ID scheme.
// Merged here at module load so battle/packs/decks see one catalogue.
import { EXPANSION_CARDS } from './cards-expansion.js';
import { SPIRE_LEGENDARIES, SPIRE_TOKENS } from './spire-cards.js';
// CR-2, the first quarterly expansion. Already rarity-stamped + set-tagged
// in its own module; merged in as-is (no per-rarity .map needed).
import { VOIDBORN_CARDS } from './cards-voidborn.js';
// CR-2 scale-up, procedurally generated bulk of all 4 expansions (200/set):
// the 150 Voidborn top-up + Tides/Embercrown/Verdant whole. Already
// rarity/set/tribe-stamped. See cards-expansion-bulk.js.
import { EXPANSION_BULK_CARDS, EXPANSION_BULK_TOKENS } from './cards-expansion-bulk.js';
// Per-id DISPLAY-text diversification (tools/diversify-effects.py). Many
// procedurally-generated cards shared identical effect descriptions; this
// map rewrites only the `text` string with variety. Mechanics, keywords,
// abilities, and numbers are untouched, applied as the LAST merge below.
import { CARD_TEXT_OVERRIDES } from './card-text-overrides.js';

const RAW_ROSTER = [
  ...Object.values(CHAMPIONS_RAW),
  ...LEGEND_HEROES,
  ...LEGEND_BOSSES,
  ...RARES,
  ...UNCOMMONS.map(c => ({ ...c, rarity: 'uncommon' })),
  ...COMMONS.map(c => ({ ...c, rarity: 'common' })),
  ...TOKENS.map(c => ({ ...c, rarity: 'token' })),
  ...EXPANSION_CARDS,
  // Spire seasonal exclusives, legendary minions granted via boss-clear.
  ...SPIRE_LEGENDARIES.map(c => ({ ...c, rarity: 'legendary' })),
  ...SPIRE_TOKENS.map(c => ({ ...c, rarity: 'token' })),
  // CR-2 Voidborn expansion (already rarity-stamped + set:'voidborn').
  ...VOIDBORN_CARDS,
  // CR-2 bulk generator, 150 Voidborn top-up + Tides/Embercrown/Verdant
  // (200 each) + their tokens. Already rarity/set/tribe-stamped.
  ...EXPANSION_BULK_CARDS,
  ...EXPANSION_BULK_TOKENS,
];

export const CARDS = Object.fromEntries(
  RAW_ROSTER.map(c => [c.id, normaliseCard({
    ...c,
    ...(GENERATED_EFFECTS[c.id] || {}),
    // Display-text override wins last; only ever touches `text`.
    ...(CARD_TEXT_OVERRIDES[c.id] ? { text: CARD_TEXT_OVERRIDES[c.id] } : {}),
  })])
);

// Sanity check at module load, duplicate IDs would silently overwrite,
// which is a content bug we want to find at deploy time, not at runtime.
(function dedupeCheck() {
  const seen = new Set();
  for (const c of RAW_ROSTER) {
    if (seen.has(c.id)) {
      throw new Error('cards-content.js: duplicate card id ' + c.id);
    }
    seen.add(c.id);
  }
})();

// Schema check at module load, keeps authoring errors in expansion data
// files (cards-voidborn.js, future sets) from shipping as silent no-ops.
// Validates the locked dictionaries: every keyword/trigger/effect/target
// a card references must be implemented. Cheap to run, runs once.
(function schemaCheck() {
  const KW = new Set(KEYWORDS.concat(['regen', 'cannot-attack-unless-3-spells']));
  const TR = new Set(TRIGGERS.concat(['spellDamageBonus']));
  const EF = new Set(EFFECTS);
  const TG = new Set(TARGETS.concat(['oppNextSpell', 'opp']));   // summon side + counter target sentinels
  for (const c of Object.values(CARDS)) {
    if (!SET_IDS.includes(c.set)) {
      throw new Error(`cards-content.js: card ${c.id} has unknown set "${c.set}"`);
    }
    // Deep keyword/ability validation is scoped to EXPANSION cards only.
    // The legacy "core" catalogue was audited at 2026-05-31 and carries a
    // few vestigial-but-harmless target strings; we don't retroactively
    // rewrite it. New sets (voidborn and onward) get the strict check so
    // a typo can never ship as a silent no-op.
    // Spire exclusives read as set:'core' (they predate the set field) but
    // are hand-authored prestige cards, not legacy-generated filler, so we
    // still hold them to the strict schema, catching a no-op battlecry.
    const isSpire = (c.id || '').startsWith('spire.');
    if ((c.set || 'core') === 'core' && !isSpire) continue;
    for (const k of c.keywords || []) {
      if (!KW.has(k)) throw new Error(`cards-content.js: card ${c.id} has unknown keyword "${k}"`);
    }
    for (const ab of c.abilities || []) {
      if (ab.trigger && !TR.has(ab.trigger)) throw new Error(`cards-content.js: card ${c.id} unknown trigger "${ab.trigger}"`);
      if (ab.effect && !EF.has(ab.effect)) throw new Error(`cards-content.js: card ${c.id} unknown effect "${ab.effect}"`);
      if (ab.target && !TG.has(ab.target)) throw new Error(`cards-content.js: card ${c.id} unknown target "${ab.target}"`);
    }
  }
})();

// ── Per-rarity card pools used by pack rolls + deck validation ───────

// Per-set rarity pools. A pack only ever pulls from ONE set; tokens +
// champions are never pullable. `rarityPoolsForSet('core')` reproduces
// the pre-expansion behaviour exactly (every legacy card is set:'core').
export function rarityPoolsForSet(setId) {
  const inSet = Object.values(CARDS).filter(c => (c.set || 'core') === setId && !c.token);
  return {
    common:    inSet.filter(c => c.rarity === 'common'),
    uncommon:  inSet.filter(c => c.rarity === 'uncommon'),
    rare:      inSet.filter(c => c.rarity === 'rare'),
    legendary: inSet.filter(c => c.rarity === 'legendary'),
  };
}

// Default pool = the core set. pullPack() uses this when no set is
// specified, so all legacy pack sources (Clash drops, lootbox, daily,
// purchase) keep pulling core cards and expansion cards never leak in.
export const RARITY_POOLS = rarityPoolsForSet('core');

export const RARITY_DECK_CAP = {
  champion: 1,        // always exactly 1 in your deck
  common: 4,
  uncommon: 3,
  rare: 2,
  legendary: 1,
};

// Bolts refunded when a pull comes back as a duplicate past your deck cap.
export const DUPE_BOLTS = {
  common: 5,
  uncommon: 20,
  rare: 100,
  legendary: 500,
};

// ── Pack definitions ─────────────────────────────────────────────────
//
// `weights` is the per-slot rarity weighting. The pack opens by rolling
// 3 slots; for each, we pick a rarity using these weights, then a
// uniform card within that rarity's pool. Champions are never pulled.
//
// PACK SIZE: 3 cards (universal rule, 2026-06-02). Packs were 5 cards;
// the rarity weights below were rebalanced so the *value* per pack holds
// despite the smaller size, the non-common rates were scaled up by ~5/3
// and the common filler trimmed, so a 3-card pack carries roughly the
// same expected count of uncommon / rare / legendary as the old 5-card
// pack. The smaller pack is therefore richer per card, not just shorter.

export const PACKS = {
  common: {
    id: 'common',
    name: 'Boltbound Common Pack',
    cards: 3,
    // The free/daily floor pack. Pure-common at 5 cards felt like enough;
    // at 3 cards we sprinkle a real uncommon chance so the daily claim
    // still feels worth opening.
    weights: { common: 80, uncommon: 20, rare: 0, legendary: 0 },
    priceBolts: null,            // not directly purchasable
  },
  bolt: {
    id: 'bolt',
    name: 'Boltbound Bolt Pack',
    cards: 3,
    // Was 60/30/9/1 over 5 slots (expected ~1.5 uncommon, 0.45 rare,
    // 0.05 legendary). Rebalanced over 3 slots to hold those expected
    // counts: uncommon/rare/legendary scaled up, commons trimmed.
    weights: { common: 33, uncommon: 50, rare: 15, legendary: 2 },
    priceBolts: 250,
  },
  voltaic: {
    id: 'voltaic',
    name: 'Boltbound Voltaic Pack',
    cards: 3,
    // The premium drop-only pack. Was 30/40/25/5 over 5 slots (expected
    // ~1.5 rare+legendary per pack). Rebalanced over 3 slots to keep that
    // rare+ value: ~half of every slot is now rare-or-better.
    weights: { common: 10, uncommon: 40, rare: 42, legendary: 8 },
    priceBolts: null,            // drop-only, Clash 3-star + lootbox + Patreon
  },
};

export const PACK_IDS = Object.keys(PACKS);

// ── NPC archetype decks ──────────────────────────────────────────────
//
// One deck per archetype. Cards are listed as cardId entries (with
// repetition for multiples). The archetype's decision policy lives in
// cards-match.js, these decks are paired with that policy so the
// behaviour reads naturally.
//
// Each deck is exactly 20 cards (deckSize) including its champion.
// Champion slot is filled at match-create with the same class
// distribution the bot's archetype prefers, Aggro likes Warrior,
// Control likes Mage, Midrange likes Ranger.

export const NPC_DECKS = {
  aggro: {
    champion: 'warrior',
    cards: [
      'c.gobrunt', 'c.gobrunt', 'c.gobrunt', 'c.gobrunt',
      'u.scrapper', 'u.scrapper',
      'u.glasscat', 'u.glasscat',
      'c.imp', 'c.imp',
      'u.daggerthief', 'u.daggerthief',
      'c.swordhand', 'c.swordhand',
      'u.boltbolt', 'u.boltbolt',
      'u.firebolt',
      'c.flamesword',
      'r.boltknight',
    ],
  },
  control: {
    champion: 'mage',
    cards: [
      'c.acolyte', 'c.acolyte',
      'c.heal1', 'c.heal1',
      'u.shieldguard', 'u.shieldguard',
      'u.stoutwarden', 'u.stoutwarden',
      'c.cleric4', 'c.cleric4',
      'c.guardian5',
      'u.tankknight',
      'r.healercleric', 'r.healercleric',
      'r.voltaicmage',
      'r.boltstorm',
      'r.mend',
      'c.firebreath',
      'leg.solara',
    ],
  },
  midrange: {
    champion: 'ranger',
    cards: [
      'c.ironguard', 'c.ironguard',
      'c.swordhand', 'c.swordhand',
      'u.runesinger', 'u.runesinger',
      'u.scoutarcher', 'u.scoutarcher',
      'u.warpriest',
      'c.captain', 'c.captain',
      'c.boar', 'c.boar',
      'c.knight5',
      'r.boltknight',
      'r.archertwin',
      'r.forgebrand',
      'r.voltaicsurge',
      'leg.korrik',
    ],
  },
  // CR-1 archetypes, pull from the expanded family pools.
  // Tribal-beast: leans hard on the beast + wild families.
  tribal: {
    champion: 'ranger',
    cards: [
      'beast.c001', 'beast.c001', 'beast.c005', 'beast.c005',
      'beast.c011', 'beast.c011', 'beast.c017',
      'beast.u005', 'beast.u005',
      'wild.c005', 'wild.c005', 'wild.c011',
      'wild.u005', 'wild.u005',
      'beast.r001',
      'wild.r001',
      'beast.l001',
      'beast.cs01', 'beast.cs02',
    ],
  },
  // Burn: fire + storm spells and aggressive minions.
  burn: {
    champion: 'mage',
    cards: [
      'fire.c001', 'fire.c001', 'fire.c005', 'fire.c005',
      'fire.cs01', 'fire.cs02', 'fire.cs04',
      'storm.c001', 'storm.c001',
      'storm.cs01', 'storm.cs02',
      'fire.u005', 'fire.u005',
      'storm.u005',
      'fire.r003',
      'storm.r003',
      'fire.us01',
      'storm.us01',
      'fire.l001',
    ],
  },
  // Swarm: goblin + demon, lots of cheap minions and onPlay summons.
  swarm: {
    champion: 'rogue',
    cards: [
      'goblin.c001', 'goblin.c001', 'goblin.c005', 'goblin.c005',
      'goblin.c011', 'goblin.c011', 'goblin.c017',
      'demon.c001', 'demon.c001', 'demon.c005',
      'goblin.u005', 'goblin.u005',
      'demon.u005', 'demon.u005',
      'goblin.r003',
      'demon.r003',
      'goblin.cs01',
      'demon.cs01',
      'goblin.l001',
    ],
  },
};

// Quick validity check at module load, NPC decks must reference
// real card ids.
(function npcDeckCheck() {
  for (const [arch, deck] of Object.entries(NPC_DECKS)) {
    for (const id of deck.cards) {
      if (!CARDS[id]) {
        throw new Error(`cards-content.js: NPC deck "${arch}" references missing card ${id}`);
      }
    }
  }
})();

// ── Sprite ID helper ─────────────────────────────────────────────────
//
// Public path: https://aquilo.gg/sprites/cards/<cardId>.png (animated
// for legendary tier). Used by the Discord embed renderer + later by
// the web battler + pack opener.

export function spriteIdForCard(cardId) {
  const c = CARDS[cardId];
  if (!c) return null;
  return c.spriteId;
}

// ── Catalogue lookup helpers ─────────────────────────────────────────

export function getCard(id) {
  return CARDS[id] || null;
}

// Validate a deck, used by cards-decks.js. Champions count toward the
// 20-card total. Duplicates obey RARITY_DECK_CAP. Tokens are never
// allowed in a deck.
export const DECK_SIZE = 20;

export function validateDeck(deck) {
  if (!Array.isArray(deck?.cards) || deck.cards.length !== DECK_SIZE) {
    return { ok: false, error: `deck must be exactly ${DECK_SIZE} cards (you have ${deck?.cards?.length ?? 0})` };
  }
  let championCount = 0;
  const counts = new Map();
  for (const id of deck.cards) {
    const c = CARDS[id];
    if (!c) return { ok: false, error: `unknown card: ${id}` };
    if (c.token) return { ok: false, error: `tokens cannot be in decks: ${id}` };
    // NOTE: the "unreleased set" gate is NOT here, release is KV-driven
    // (boltbound-release.js) and validateDeck is a pure/sync function. The
    // env-aware check lives in cards-decks.js saveDeck so a KV release/hide
    // takes effect without this static date lying.
    counts.set(id, (counts.get(id) || 0) + 1);
    if (c.rarity === 'champion') championCount++;
  }
  if (championCount !== 1) {
    return { ok: false, error: `deck must contain exactly 1 Champion (you have ${championCount})` };
  }
  for (const [id, n] of counts) {
    const c = CARDS[id];
    const cap = RARITY_DECK_CAP[c.rarity] || 1;
    if (n > cap) {
      return { ok: false, error: `${c.name}: ${n}× exceeds cap of ${cap}` };
    }
  }
  return { ok: true };
}
