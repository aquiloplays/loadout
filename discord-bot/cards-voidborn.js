// Boltbound, "Voidborn" expansion (CR-2, inaugural quarterly set).
//
// 50 pullable cards: 30 minions + 15 spells + 5 legendaries, plus a
// handful of summon-only tokens. Theme: cosmic horror, the dark between
// stars, things that do not stay buried. Mechanics lean on the CR-2
// additions: Stealth (Veiled), Reborn (Phoenix), Recruit, and Deathrattle
// synergies, with an Umbra tribe running through the minions.
//
// Card `text` is the rules line (display-only; the resolver dispatches off
// keywords + abilities). `flavor` is the dark-humoured throwaway line in
// the Aquilo voice. All cards carry set:'voidborn'. Released today, so
// they are immediately deckable + pullable from a Voidborn pack.
//
// Power budget mirrors the core catalogue: a vanilla body is roughly
// (atk + hp) = 2*mana + 1; keywords and effects trade stat points down.
// Nothing here uses a mechanic the resolver doesn't implement (the
// schemaCheck in cards-content.js enforces that at load).

const SET = 'voidborn';
const UMBRA = 'umbra';

// ── Summon-only tokens ───────────────────────────────────────────────
export const VOIDBORN_TOKENS = [
  { id: 'voidborn.tok.wisp',     name: 'Guttering Wisp',  type: 'minion', token: true, mana: 0, atk: 1, hp: 1, tribe: UMBRA,
    flavor: 'It was somebody, once. It is mostly light now.' },
  { id: 'voidborn.tok.husk',     name: 'Patched Husk',    type: 'minion', token: true, mana: 0, atk: 2, hp: 2, tribe: UMBRA, keywords: ['taunt'],
    text: 'Taunt.', flavor: 'Stuffed with whatever was lying around.' },
  { id: 'voidborn.tok.warden',   name: 'Cellar Warden',   type: 'minion', token: true, mana: 0, atk: 3, hp: 3, tribe: UMBRA, keywords: ['taunt'],
    text: 'Taunt.', flavor: 'It guards the stairs. It does not know why.' },
  { id: 'voidborn.tok.guardian', name: 'Threshold Guardian', type: 'minion', token: true, mana: 0, atk: 4, hp: 4, tribe: UMBRA, keywords: ['taunt'],
    text: 'Taunt.', flavor: 'Standing in a doorway is a whole career to some people.' },
];

// ── Commons (21: 14 minions + 7 spells) ──────────────────────────────
const COMMONS = [
  // Minions
  { id: 'voidborn.c01', name: 'Drift Lantern', type: 'minion', mana: 1, atk: 1, hp: 2, tribe: UMBRA,
    abilities: [{ trigger: 'onDeath', effect: 'draw', value: 1 }],
    text: 'Deathrattle: draw a card.',
    flavor: 'Burns brightest on the way out. Like most of us.' },
  { id: 'voidborn.c02', name: 'Quiet Understudy', type: 'minion', mana: 1, atk: 2, hp: 1, tribe: UMBRA, keywords: ['stealth'],
    text: 'Veiled.',
    flavor: 'Learning the part by watching you fail it.' },
  { id: 'voidborn.c03', name: 'Pale Tagalong', type: 'minion', mana: 2, atk: 2, hp: 2, tribe: UMBRA,
    abilities: [{ trigger: 'onDeath', effect: 'summon', target: 'self', cardId: 'voidborn.tok.wisp' }],
    text: 'Deathrattle: summon a 1/1 Wisp.',
    flavor: 'Brought a friend. Leaves a friend.' },
  { id: 'voidborn.c04', name: 'Quiet Neighbor', type: 'minion', mana: 2, atk: 1, hp: 3, tribe: UMBRA, keywords: ['taunt'],
    text: 'Taunt.',
    flavor: 'Keeps to itself. Keeps you to itself too.' },
  { id: 'voidborn.c05', name: 'Gutter Astronomer', type: 'minion', mana: 2, atk: 3, hp: 2,
    abilities: [{ trigger: 'onPlay', effect: 'peekDeck', value: 1 }],
    text: 'Battlecry: look at the top card of your deck.',
    flavor: 'Found the stars by looking down a drain. They look back.' },
  { id: 'voidborn.c06', name: 'Hungry Cartographer', type: 'minion', mana: 3, atk: 3, hp: 3, tribe: UMBRA,
    abilities: [{ trigger: 'onDeath', effect: 'damage', target: 'randomEnemyMinion', value: 1 }],
    text: 'Deathrattle: deal 1 damage to a random enemy minion.',
    flavor: 'Mapped the dark thoroughly. Filed the report in person.' },
  { id: 'voidborn.c07', name: 'Threadbare Revenant', type: 'minion', mana: 3, atk: 2, hp: 3, tribe: UMBRA, keywords: ['reborn'],
    text: 'Reborn.',
    flavor: 'Death was fine. The paperwork was the issue.' },
  { id: 'voidborn.c08', name: 'Lightless Clerk', type: 'minion', mana: 3, atk: 2, hp: 4, tribe: UMBRA,
    flavor: 'Files everything. Including you, eventually.' },
  { id: 'voidborn.c09', name: 'Cellar Thing', type: 'minion', mana: 4, atk: 4, hp: 4, tribe: UMBRA,
    abilities: [{ trigger: 'onDeath', effect: 'summon', target: 'self', cardId: 'voidborn.tok.husk' }],
    text: 'Deathrattle: summon a 2/2 Husk with Taunt.',
    flavor: 'You heard it before you owned the house.' },
  { id: 'voidborn.c10', name: 'Patient Lurker', type: 'minion', mana: 4, atk: 3, hp: 4, tribe: UMBRA, keywords: ['stealth'],
    text: 'Veiled.',
    flavor: 'It has waited longer than this for less than you.' },
  { id: 'voidborn.c11', name: 'Overfed Shade', type: 'minion', mana: 5, atk: 4, hp: 4, tribe: UMBRA, keywords: ['lifesteal'],
    text: 'Drain.',
    flavor: 'Ate the room. Still peckish.' },
  { id: 'voidborn.c12', name: 'Collapsed Choir', type: 'minion', mana: 5, atk: 4, hp: 5, tribe: UMBRA,
    abilities: [{ trigger: 'onDeath', effect: 'damage', target: 'allEnemyMinions', value: 1 }],
    text: 'Deathrattle: deal 1 damage to all enemy minions.',
    flavor: 'They only ever knew the one note. They held it.' },
  { id: 'voidborn.c13', name: 'The Long Quiet', type: 'minion', mana: 6, atk: 5, hp: 6, tribe: UMBRA, keywords: ['taunt'],
    text: 'Taunt.',
    flavor: 'Not peace. Just the part before the rest of it.' },
  { id: 'voidborn.c14', name: 'Starved Colossus', type: 'minion', mana: 7, atk: 7, hp: 6, tribe: UMBRA,
    abilities: [
      { trigger: 'onDeath', effect: 'summon', target: 'self', cardId: 'voidborn.tok.wisp' },
      { trigger: 'onDeath', effect: 'summon', target: 'self', cardId: 'voidborn.tok.wisp' },
    ],
    text: 'Deathrattle: summon two 1/1 Wisps.',
    flavor: 'Big enough to cast a shadow you could move into.' },
  // Spells
  { id: 'voidborn.c15', name: 'Snuff', type: 'spell', mana: 1,
    abilities: [{ trigger: 'onCast', effect: 'damage', target: 'pickedTarget', value: 2, filter: { type: 'minion' } }],
    text: 'Deal 2 damage to a minion.',
    flavor: 'Two fingers. No ceremony.' },
  { id: 'voidborn.c16', name: 'Bad Omen', type: 'spell', mana: 2,
    abilities: [{ trigger: 'onCast', effect: 'damage', target: 'pickedTarget', value: 3, filter: { type: 'minion' } }],
    text: 'Deal 3 damage to a minion.',
    flavor: 'You knew. You always know. You play anyway.' },
  { id: 'voidborn.c17', name: 'Skim the Dark', type: 'spell', mana: 2,
    abilities: [{ trigger: 'onCast', effect: 'draw', value: 2 }],
    text: 'Draw 2 cards.',
    flavor: 'Read the bottom of the well. The well has notes.' },
  { id: 'voidborn.c18', name: 'Last Rites', type: 'spell', mana: 3,
    abilities: [{ trigger: 'onCast', effect: 'returnToHand', target: 'lastDeadFriendly' }],
    text: 'Return the last friendly minion that died to your hand.',
    flavor: 'A funeral you can undo. The guests will be annoyed.' },
  { id: 'voidborn.c19', name: 'Creeping Dread', type: 'spell', mana: 3,
    abilities: [
      { trigger: 'onCast', effect: 'damage', target: 'pickedTarget', value: 1, filter: { type: 'minion' } },
      { trigger: 'onCast', effect: 'freeze', target: 'pickedTarget', filter: { type: 'minion' } },
    ],
    text: 'Deal 1 damage to a minion and Freeze it.',
    flavor: 'It is behind you. It was always going to be behind you.' },
  { id: 'voidborn.c20', name: 'Feed the Dark', type: 'spell', mana: 4,
    abilities: [{ trigger: 'onCast', effect: 'damage', target: 'allEnemyMinions', value: 2 }],
    text: 'Deal 2 damage to all enemy minions.',
    flavor: 'It is not picky. That is the comforting part.' },
  { id: 'voidborn.c21', name: 'Cold Comfort', type: 'spell', mana: 2,
    abilities: [{ trigger: 'onCast', effect: 'buff', target: 'pickedTarget', valueAtk: 1, valueHp: 2, filter: { type: 'friendly-minion' } }],
    text: 'Give a friendly minion +1/+2.',
    flavor: 'The dark keeps you. It does not keep you warm.' },
];

// ── Uncommons (15: 11 minions + 4 spells) ────────────────────────────
const UNCOMMONS = [
  { id: 'voidborn.u01', name: 'Veiled Pickpocket', type: 'minion', mana: 2, atk: 2, hp: 2, tribe: UMBRA, keywords: ['stealth'],
    abilities: [{ trigger: 'onDeath', effect: 'draw', value: 1 }],
    text: 'Veiled. Deathrattle: draw a card.',
    flavor: 'Took your watch. Left you the time.' },
  { id: 'voidborn.u02', name: 'Marrow Accountant', type: 'minion', mana: 3, atk: 2, hp: 3, tribe: UMBRA,
    abilities: [{ trigger: 'onDeath', effect: 'buff', target: 'randomFriendlyMinion', valueAtk: 2, valueHp: 2 }],
    text: 'Deathrattle: give a random friendly minion +2/+2.',
    flavor: 'Balances the books in bone. The numbers always work out.' },
  { id: 'voidborn.u03', name: 'Understairs Dweller', type: 'minion', mana: 3, atk: 2, hp: 2, tribe: UMBRA, keywords: ['stealth', 'poison'],
    text: 'Veiled. Venomous.',
    flavor: 'Lives where the steps do not reach. Reaches anyway.' },
  { id: 'voidborn.u04', name: 'Twice-Buried', type: 'minion', mana: 4, atk: 3, hp: 3, tribe: UMBRA, keywords: ['reborn'],
    text: 'Reborn.',
    flavor: 'The second grave was a formality. So was the first.' },
  { id: 'voidborn.u05', name: 'Choir of One', type: 'minion', mana: 4, atk: 3, hp: 4, tribe: UMBRA,
    abilities: [{ trigger: 'onDeath', effect: 'summon', target: 'self', cardId: 'voidborn.tok.husk' }],
    text: 'Deathrattle: summon a 2/2 Husk with Taunt.',
    flavor: 'Sings every part. Badly. Loudly. Forever.' },
  { id: 'voidborn.u06', name: 'Recruiter from Below', type: 'minion', mana: 4, atk: 3, hp: 3, tribe: UMBRA,
    abilities: [{ trigger: 'onPlay', effect: 'recruit', value: 2 }],
    text: 'Battlecry: Recruit a minion that costs 2 or less from your deck.',
    flavor: 'Always hiring. Terrible benefits. No exit interview.' },
  { id: 'voidborn.u07', name: 'Umbral Matron', type: 'minion', mana: 5, atk: 4, hp: 4, tribe: UMBRA,
    abilities: [{ trigger: 'onPlay', effect: 'buff', target: 'allFriendlyTribe', tribe: UMBRA, valueAtk: 1, valueHp: 1 }],
    text: 'Battlecry: give your Umbra minions +1/+1.',
    flavor: 'Keeps a large family. Keeps them close. Keeps them.' },
  { id: 'voidborn.u08', name: 'The Tenant', type: 'minion', mana: 5, atk: 4, hp: 5, tribe: UMBRA, keywords: ['taunt'],
    abilities: [{ trigger: 'onDeath', effect: 'damage', target: 'oppHero', value: 2 }],
    text: 'Taunt. Deathrattle: deal 2 damage to the enemy hero.',
    flavor: 'Paid the deposit in advance. Took it out of you.' },
  { id: 'voidborn.u09', name: 'Gallows Regular', type: 'minion', mana: 5, atk: 5, hp: 5, tribe: UMBRA, keywords: ['reborn'],
    text: 'Reborn.',
    flavor: 'Knows the rope by name. The rope is tired of it.' },
  { id: 'voidborn.u10', name: 'Sediment Horror', type: 'minion', mana: 6, atk: 5, hp: 5, tribe: UMBRA,
    abilities: [
      { trigger: 'onDeath', effect: 'summon', target: 'self', cardId: 'voidborn.tok.husk' },
      { trigger: 'onDeath', effect: 'summon', target: 'self', cardId: 'voidborn.tok.husk' },
    ],
    text: 'Deathrattle: summon two 2/2 Husks with Taunt.',
    flavor: 'Settled out of everything that ever drowned here.' },
  { id: 'voidborn.u11', name: 'Appetite', type: 'minion', mana: 6, atk: 6, hp: 5, tribe: UMBRA, keywords: ['lifesteal'],
    text: 'Drain.',
    flavor: 'Not a metaphor. Bring a bib.' },
  // Spells
  { id: 'voidborn.u12', name: 'Exhume', type: 'spell', mana: 3,
    abilities: [{ trigger: 'onCast', effect: 'recruit', value: 3 }],
    text: 'Recruit a minion that costs 3 or less from your deck.',
    flavor: 'Dig here. No, do not ask why here.' },
  { id: 'voidborn.u13', name: 'Voidlance', type: 'spell', mana: 4,
    abilities: [{ trigger: 'onCast', effect: 'damage', target: 'pickedTarget', value: 4 }],
    text: 'Deal 4 damage to any target.',
    flavor: 'Threw the dark at it. Point first.' },
  { id: 'voidborn.u14', name: 'Unmake', type: 'spell', mana: 4,
    abilities: [{ trigger: 'onCast', effect: 'destroy', target: 'pickedTarget', filter: { type: 'enemy-minion' } }],
    text: 'Destroy an enemy minion.',
    flavor: 'Not killed. Reconsidered, retroactively.' },
  { id: 'voidborn.u15', name: 'Witching Hour', type: 'spell', mana: 5,
    abilities: [{ trigger: 'onCast', effect: 'damage', target: 'allEnemy', value: 2 }],
    text: 'Deal 2 damage to all enemies.',
    flavor: 'It comes around once a night. It is always now.' },
];

// ── Rares (9: 5 minions + 4 spells) ──────────────────────────────────
const RARES = [
  { id: 'voidborn.r01', name: 'Mother of Husks', type: 'minion', mana: 5, atk: 3, hp: 4, tribe: UMBRA,
    abilities: [
      { trigger: 'onDeath', effect: 'summon', target: 'self', cardId: 'voidborn.tok.husk' },
      { trigger: 'onDeath', effect: 'summon', target: 'self', cardId: 'voidborn.tok.husk' },
      { trigger: 'onDeath', effect: 'summon', target: 'self', cardId: 'voidborn.tok.husk' },
    ],
    text: 'Deathrattle: summon three 2/2 Husks with Taunt.',
    flavor: 'Devoted parent. Poor record on letting go.' },
  { id: 'voidborn.r02', name: 'The Quiet Half', type: 'minion', mana: 4, atk: 4, hp: 3, tribe: UMBRA, keywords: ['stealth', 'lifesteal'],
    text: 'Veiled. Drain.',
    flavor: 'The half of you that gets things done.' },
  { id: 'voidborn.r03', name: 'Gravewright', type: 'minion', mana: 5, atk: 4, hp: 5, tribe: UMBRA,
    abilities: [{ trigger: 'onPlay', effect: 'recruit', value: 4 }],
    text: 'Battlecry: Recruit a minion that costs 4 or less from your deck.',
    flavor: 'Builds to spec. The spec is screaming.' },
  { id: 'voidborn.r04', name: 'Echo of Echoes', type: 'minion', mana: 4, atk: 3, hp: 3, tribe: UMBRA, keywords: ['reborn'],
    abilities: [{ trigger: 'onDeath', effect: 'draw', value: 1 }],
    text: 'Reborn. Deathrattle: draw a card.',
    flavor: 'Says everything twice. Says everything twice.' },
  { id: 'voidborn.r05', name: 'Patron of the Deep', type: 'minion', mana: 6, atk: 5, hp: 5, tribe: UMBRA, keywords: ['taunt'],
    abilities: [{ trigger: 'onPlay', effect: 'buff', target: 'allFriendlyTribe', tribe: UMBRA, valueAtk: 1, valueHp: 1 }],
    text: 'Taunt. Battlecry: give your Umbra minions +1/+1.',
    flavor: 'Funds the arts. The art is a hole. It is well funded.' },
  // Spells
  { id: 'voidborn.r06', name: 'Total Eclipse', type: 'spell', mana: 5,
    abilities: [{ trigger: 'onCast', effect: 'damage', target: 'allEnemyMinions', value: 3 }],
    text: 'Deal 3 damage to all enemy minions.',
    flavor: 'Lights out. Everyone. Yes, you heard.' },
  { id: 'voidborn.r07', name: 'Conscription', type: 'spell', mana: 4,
    abilities: [
      { trigger: 'onCast', effect: 'recruit', value: 2 },
      { trigger: 'onCast', effect: 'recruit', value: 2 },
    ],
    text: 'Recruit two minions that cost 2 or less from your deck.',
    flavor: 'You volunteered. The form was very dark.' },
  { id: 'voidborn.r08', name: 'Second Death', type: 'spell', mana: 3,
    abilities: [{ trigger: 'onCast', effect: 'damage', target: 'pickedTarget', value: 6, filter: { type: 'minion' } }],
    text: 'Deal 6 damage to a minion.',
    flavor: 'The first one clearly did not take.' },
  { id: 'voidborn.r09', name: 'The Wages', type: 'spell', mana: 6,
    abilities: [
      { trigger: 'onCast', effect: 'damage', target: 'allEnemy', value: 3 },
      { trigger: 'onCast', effect: 'heal', target: 'selfHero', value: 3 },
    ],
    text: 'Deal 3 damage to all enemies. Heal your hero 3.',
    flavor: 'Everyone gets paid. You get paid back.' },
];

// ── Legendaries (5 minions) ──────────────────────────────────────────
const LEGENDARIES = [
  { id: 'voidborn.l01', name: 'Sael, the Last Lit Window', type: 'minion', mana: 7, atk: 6, hp: 6, tribe: UMBRA, keywords: ['reborn'],
    abilities: [{ trigger: 'onDeath', effect: 'summon', target: 'self', cardId: 'voidborn.tok.guardian' }],
    text: 'Reborn. Deathrattle: summon a 4/4 Threshold Guardian with Taunt.',
    flavor: 'Somebody is still awake up there. That is the bad news.' },
  { id: 'voidborn.l02', name: 'The Thing in the Walls', type: 'minion', mana: 6, atk: 4, hp: 4, tribe: UMBRA, keywords: ['stealth'],
    abilities: [{ trigger: 'onPlay', effect: 'recruit', value: 5 }],
    text: 'Veiled. Battlecry: Recruit a minion that costs 5 or less from your deck.',
    flavor: 'You have lived with it for years. It pays no rent.' },
  { id: 'voidborn.l03', name: 'Choirmaster Null', type: 'minion', mana: 8, atk: 6, hp: 8, tribe: UMBRA, keywords: ['taunt'],
    abilities: [
      { trigger: 'onDeath', effect: 'summon', target: 'self', cardId: 'voidborn.tok.warden' },
      { trigger: 'onDeath', effect: 'summon', target: 'self', cardId: 'voidborn.tok.warden' },
    ],
    text: 'Taunt. Deathrattle: summon two 3/3 Cellar Wardens with Taunt.',
    flavor: 'Conducts the silence. Demands an encore.' },
  { id: 'voidborn.l04', name: 'The Returned', type: 'minion', mana: 5, atk: 4, hp: 5, tribe: UMBRA, keywords: ['reborn'],
    abilities: [{ trigger: 'onDeath', effect: 'buff', target: 'allFriendlyTribe', tribe: UMBRA, valueAtk: 2, valueHp: 2 }],
    text: 'Reborn. Deathrattle: give your Umbra minions +2/+2.',
    flavor: 'Came back wrong, then came back again, worse, on purpose.' },
  { id: 'voidborn.l05', name: 'Grandmother', type: 'minion', mana: 9, atk: 8, hp: 8, tribe: UMBRA,
    abilities: [
      { trigger: 'onPlay',  effect: 'damage', target: 'allEnemyMinions', value: 4 },
      { trigger: 'onDeath', effect: 'damage', target: 'allEnemyMinions', value: 4 },
    ],
    text: 'Battlecry and Deathrattle: deal 4 damage to all enemy minions.',
    flavor: 'She has seen it all before. She is not impressed. She is hungry.' },
];

// ── Assemble + stamp set ─────────────────────────────────────────────
const stamp = (c, rarity) => ({ ...c, set: SET, rarity });

export const VOIDBORN_CARDS = [
  ...COMMONS.map(c => stamp(c, 'common')),
  ...UNCOMMONS.map(c => stamp(c, 'uncommon')),
  ...RARES.map(c => stamp(c, 'rare')),
  ...LEGENDARIES.map(c => stamp(c, 'legendary')),
  ...VOIDBORN_TOKENS.map(c => stamp(c, 'token')),
];

// Sanity: the pullable count (everything but tokens) must be exactly 50.
(function voidbornCountCheck() {
  const pullable = VOIDBORN_CARDS.filter(c => !c.token).length;
  if (pullable !== 50) {
    throw new Error(`cards-voidborn.js: expected 50 pullable cards, got ${pullable}`);
  }
})();
