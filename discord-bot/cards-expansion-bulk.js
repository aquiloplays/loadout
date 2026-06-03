// Boltbound — bulk expansion-set generator (CR-2 scale-up to 200/set).
//
// Clay 2026-06-03: each quarterly expansion is now 200 cards (~120 minions
// + ~60 spells + ~20 legendaries). Voidborn keeps its 50 hand-authored
// cards (cards-voidborn.js) and this generator tops it up to 200; the
// other three sets (Tides of Aether, Embercrown Rising, Verdant Awakening)
// are generated whole. All cards are stamped with their `set` + `tribe`
// and keep the set's mechanic focus, with 4x the variety vs the hand set.
//
// DETERMINISTIC: every choice is keyed off the card id via a string hash,
// so the same definitions always produce the same catalogue (stable diffs,
// stable card art ids). No Date.now / Math.random.
//
// Text is display-only (the resolver runs keywords + abilities). Names +
// flavour are assembled from per-set word pools in the Aquilo voice: dry,
// dark-humoured, no em dashes, no fantasy cliche.
//
// IDs: `<slug>.x<NNN>` for cards, `<slug>.t<N>` for generated tokens — a
// distinct namespace from the hand-authored `voidborn.c01` / `voidborn.tok.*`
// so nothing collides (verified by the dedupe + schema checks in
// cards-content.js).

// ── Seeded helpers ───────────────────────────────────────────────────
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
// A small deterministic picker: pick(seed, n) -> 0..n-1.
function pick(seedStr, n) { return n <= 0 ? 0 : hashStr(seedStr) % n; }
function choose(seedStr, arr) { return arr[pick(seedStr, arr.length)]; }

// Vanilla stat budget — mirrors cards-expansion.js: 2*mana+1 + rarity
// bonus, minus the cost of keywords/abilities, split by a bias.
const RARITY_BONUS = { common: 0, uncommon: 1, rare: 2, legendary: 4 };
const KW_COST = { taunt: 0, charge: 2, rush: 1, shield: 1, stealth: 1, lifesteal: 2, poison: 2, reach: 1, 'spell-immune': 2, reborn: 2, echo: 1 };
function abilityCost(abilities, keywords) {
  let c = 0;
  for (const k of keywords || []) c += KW_COST[k] || 0;
  for (const a of abilities || []) {
    if (a.trigger === 'onPlay' || a.trigger === 'onCast') {
      if (a.effect === 'damage') c += (String(a.target).startsWith('allEnemy')) ? (a.value || 0) * 2 : (a.value || 0);
      if (a.effect === 'heal')   c += Math.ceil((a.value || 0) / 2);
      if (a.effect === 'draw')   c += (a.value || 0) * 2;
      if (a.effect === 'buff')   c += (a.valueAtk || 0) + (a.valueHp || 0);
      if (a.effect === 'destroy') c += 3;
      if (a.effect === 'summon') c += 1;
      if (a.effect === 'freeze') c += 1;
      if (a.effect === 'recruit') c += 2;
      if (a.effect === 'adapt')  c += 2;
    }
    if (a.trigger === 'onDeath') { if (a.effect === 'summon') c += 1; if (a.effect === 'damage') c += 1; if (a.effect === 'draw') c += 1; if (a.effect === 'buff') c += 1; }
    if (a.trigger === 'endOfTurn' || a.trigger === 'startOfTurn') c += (a.value || 0) + (a.valueAtk || 0) + (a.valueHp || 0);
    if (a.trigger === 'combo') c += Math.ceil(((a.value || 0) + (a.valueAtk || 0)) / 2);
    if (a.trigger === 'spellDamageBonus') c += (a.value || 0);
  }
  return c;
}
function statsFromBudget(mana, rarity, abilities, keywords, split) {
  const base = 2 * mana + 1 + (RARITY_BONUS[rarity] || 0);
  const budget = Math.max(2, base - abilityCost(abilities, keywords));
  let atk = Math.max(1, Math.round(budget / 2 + (split || 0)));
  let hp = Math.max(1, budget - atk);
  if (mana === 1) { atk = Math.min(atk, 3); hp = Math.min(hp, 3); }
  if (mana === 2) { atk = Math.min(atk, 4); hp = Math.min(hp, 5); }
  // Overload cards over-stat slightly (the lock pays for it).
  return { atk, hp };
}

// ── Per-set theming ──────────────────────────────────────────────────
//
// Each set carries: tribe, name word pools, flavour fragments, and the
// keyword/effect palette that expresses its mechanic focus. Tokens are
// declared per set (summon targets for deathrattles/battlecries).

const SETS_CFG = {
  voidborn: {
    tribe: 'umbra',
    // Voidborn already has 50 hand cards; generate the remaining 150.
    counts: { common: 69, uncommon: 45, rare: 21, legendary: 15 },
    keywords: ['stealth', 'reborn', 'taunt', 'lifesteal', 'poison'],
    keywordWeight: ['stealth', 'stealth', 'reborn', 'reborn', 'taunt', 'lifesteal', 'poison'],
    spellEffects: ['damage', 'damageAoe', 'recruit', 'destroy', 'draw', 'returnDead'],
    deathrattle: true,
    adj: ['Hollow', 'Pale', 'Lightless', 'Starved', 'Buried', 'Quiet', 'Veiled', 'Sunken', 'Forgotten', 'Wormed', 'Cold', 'Grave', 'Eyeless', 'Drowned', 'Unlit', 'Husked', 'Marrow', 'Gutter', 'Faded', 'Lost', 'Creeping', 'Rotting', 'Whispering', 'Nameless', 'Sleepless'],
    noun: ['Lurker', 'Revenant', 'Choir', 'Tenant', 'Warden', 'Colossus', 'Acolyte', 'Mourner', 'Sexton', 'Effigy', 'Wretch', 'Heir', 'Custodian', 'Vagrant', 'Sentinel', 'Phantom', 'Gravecaller', 'Astronomer', 'Cartographer', 'Undertaker', 'Hollow', 'Shade', 'Thing', 'Watcher', 'Crawler'],
    flavour: [
      'It was somebody, once.',
      'The dark keeps a guest list.',
      'You heard it before you owned the house.',
      'Death was fine. The paperwork was the issue.',
      'It has waited longer than this for less than you.',
      'Not killed. Reconsidered, retroactively.',
      'Files everything. Including you, eventually.',
      'Came back wrong, then came back again, worse.',
      'The well has notes.',
      'Stuffed with whatever was lying around.',
      'It is behind you. It was always going to be.',
      'Brought a friend. Leaves a friend.',
    ],
    tokens: [
      { suffix: 't1', name: 'Void Wisp', atk: 1, hp: 1, keywords: [] },
      { suffix: 't2', name: 'Grave Husk', atk: 2, hp: 2, keywords: ['taunt'] },
    ],
  },
  'tides-of-aether': {
    tribe: 'tide',
    counts: { common: 90, uncommon: 60, rare: 30, legendary: 20 },
    keywords: ['shield', 'taunt', 'rush', 'lifesteal'],
    keywordWeight: ['shield', 'shield', 'taunt', 'rush'],
    spellEffects: ['damage', 'freeze', 'damageFreeze', 'draw', 'damageAoe', 'buff', 'overloadBolt'],
    deathrattle: false,
    overload: true,         // some tides cards carry Overload
    spellDamage: true,      // some tides minions grant +spell damage
    adj: ['Tidal', 'Brackish', 'Frostbound', 'Storm', 'Deepwater', 'Glacial', 'Surging', 'Riptide', 'Briny', 'Squall', 'Undertow', 'Hailstone', 'Maelstrom', 'Saltworn', 'Drowning', 'Abyssal', 'Sleetborn', 'Currents', 'Thundercrest', 'Mistveil', 'Coral', 'Leviathan', 'Reefbound', 'Spindrift', 'Galewrack'],
    noun: ['Marauder', 'Tidecaller', 'Naiad', 'Drake', 'Sailor', 'Warden', 'Serpent', 'Mariner', 'Oracle', 'Diver', 'Stormsinger', 'Kraken', 'Pilot', 'Frostmage', 'Surgeon', 'Anchor', 'Coilfish', 'Tempest', 'Glacier', 'Whaler', 'Pearl', 'Eddy', 'Squallhand', 'Brinewright', 'Hydromancer'],
    flavour: [
      'The tide does not negotiate. It collects.',
      'Cold enough to make the decision for you.',
      'It rode in on weather you did not order.',
      'The deep keeps better records than the living.',
      'Freeze first. Ask the questions to a statue.',
      'Storms are just the sky losing its temper.',
      'You can hold your breath. It can wait longer.',
      'Every drop remembers where it has been.',
      'The current always wins. It just takes its time.',
      'It learned patience from glaciers.',
      'Salt in the wound is a feature, not a bug.',
      'Lightning is the sea showing off.',
    ],
    tokens: [
      { suffix: 't1', name: 'Tide Sprite', atk: 1, hp: 2, keywords: [] },
      { suffix: 't2', name: 'Ice Bulwark', atk: 0, hp: 4, keywords: ['taunt'] },
    ],
  },
  'embercrown-rising': {
    tribe: 'inferno',
    counts: { common: 90, uncommon: 60, rare: 30, legendary: 20 },
    keywords: ['charge', 'rush', 'taunt', 'lifesteal'],
    keywordWeight: ['charge', 'rush', 'rush', 'charge', 'taunt'],
    spellEffects: ['damage', 'damageAoe', 'buffThisTurn', 'comboBolt', 'buff', 'draw'],
    deathrattle: false,
    combo: true,            // some embercrown cards carry a Combo effect
    adj: ['Ember', 'Crowned', 'Ashen', 'Smoldering', 'Molten', 'Gilded', 'Cinder', 'Scorched', 'Pyre', 'Brazen', 'Searing', 'Forgeborn', 'Blazing', 'Charred', 'Sunlit', 'Wildfire', 'Kindled', 'Magma', 'Furnace', 'Roaring', 'Vermillion', 'Coalheart', 'Flarewrought', 'Goldfire', 'Emberclad'],
    noun: ['Vanguard', 'Monarch', 'Pyromancer', 'Charger', 'Knight', 'Herald', 'Drake', 'Duelist', 'Sovereign', 'Lancer', 'Firebrand', 'Marshal', 'Salamander', 'Champion', 'Courtier', 'Reaver', 'Phoenix', 'Warlord', 'Bladeguard', 'Inferno', 'Crownsworn', 'Ashblade', 'Flamebearer', 'Hotspur', 'Emberkin'],
    flavour: [
      'A crown forged in open flame fits no one comfortably.',
      'Strike first. Apologise to the ashes later.',
      'It does not rule. It just burns brighter than the rest.',
      'Momentum is a kind of mercy. This has neither.',
      'The fire took an oath. The fire keeps it.',
      'Royalty by combustion.',
      'Why wait a turn when you can wait none.',
      'Every ember thinks it could be the one that catches.',
      'It bows to no one and warms the room regardless.',
      'The throne is hot. That is the point.',
      'Speed is just patience that gave up.',
      'It came to win, not to be remembered fondly.',
    ],
    tokens: [
      { suffix: 't1', name: 'Cinder Imp', atk: 2, hp: 1, keywords: ['charge'] },
      { suffix: 't2', name: 'Ember Hound', atk: 2, hp: 2, keywords: ['rush'] },
    ],
  },
  'verdant-awakening': {
    tribe: 'verdant',
    counts: { common: 90, uncommon: 60, rare: 30, legendary: 20 },
    keywords: ['lifesteal', 'taunt', 'shield', 'reach'],
    keywordWeight: ['lifesteal', 'lifesteal', 'taunt', 'shield'],
    spellEffects: ['heal', 'buff', 'adaptBolt', 'damage', 'draw', 'summonBolt'],
    deathrattle: false,
    endOfTurn: true,        // verdant leans on end-of-turn growth
    adapt: true,
    adj: ['Verdant', 'Bloomed', 'Thornclad', 'Mossgrown', 'Bramble', 'Bioluminescent', 'Rootbound', 'Sunbathed', 'Overgrown', 'Petalled', 'Sapworn', 'Wildgrown', 'Greenmantle', 'Spored', 'Florid', 'Tanglewild', 'Dewlit', 'Loamheart', 'Briarborn', 'Seedling', 'Canopy', 'Vinewreathed', 'Glowcap', 'Fernshade', 'Quickroot'],
    noun: ['Warden', 'Druid', 'Bloomcaller', 'Stag', 'Treant', 'Gardener', 'Beast', 'Shepherd', 'Grovekeeper', 'Boar', 'Sporeling', 'Matron', 'Verdurion', 'Tender', 'Bramblekin', 'Elder', 'Thornback', 'Cultivar', 'Wildling', 'Rootspeaker', 'Mossheart', 'Burrower', 'Canopist', 'Seedmother', 'Greenwarden'],
    flavour: [
      'Something old wakes under the roots.',
      'It grows whether you tend it or not.',
      'Patience, but with teeth.',
      'The garden remembers who pulled the weeds.',
      'Life finds a way, then bills you for it.',
      'Slow is just fast that intends to last.',
      'It heals. It also keeps the receipts.',
      'Every season it comes back a little wronger.',
      'The forest does not forgive. It composts.',
      'Bloom now. Regret is for animals.',
      'It adapts. You do not get a vote.',
      'Roots go down so the rest can come up.',
    ],
    tokens: [
      { suffix: 't1', name: 'Sapling', atk: 1, hp: 1, keywords: [] },
      { suffix: 't2', name: 'Thornwall', atk: 1, hp: 3, keywords: ['taunt'] },
    ],
  },
};

// Mana curves by rarity (indexed by card position within the rarity).
const MANA_CURVE = {
  common:    [1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 5, 6],
  uncommon:  [2, 2, 3, 3, 4, 4, 5, 5, 6, 7],
  rare:      [3, 4, 4, 5, 5, 6, 7, 8],
  legendary: [5, 6, 6, 7, 7, 8, 9, 10],
};
const SPELL_EVERY = { common: 3, uncommon: 3, rare: 3, legendary: 5 };  // 1-in-N cards is a spell

// ── Name assignment (deterministic, de-duplicated) ───────────────────
function buildNamePool(cfg, slug, n) {
  const out = [];
  const seen = new Set();
  let i = 0;
  // Walk adj x noun in a hash-shuffled order so names feel varied.
  while (out.length < n && i < cfg.adj.length * cfg.noun.length * 2) {
    const a = cfg.adj[(i * 7 + 3) % cfg.adj.length];
    const nn = cfg.noun[(i * 13 + 5) % cfg.noun.length];
    const name = `${a} ${nn}`;
    if (!seen.has(name)) { seen.add(name); out.push(name); }
    i++;
  }
  // Fallback: number any shortfall (shouldn't happen with 25x25 pools).
  while (out.length < n) out.push(`${choose(slug + out.length, cfg.adj)} ${choose(slug + 'b' + out.length, cfg.noun)} ${out.length}`);
  return out;
}

// ── Effect text (display-only) from mechanics ────────────────────────
function rulesText(card, cfg) {
  const parts = [];
  const kw = card.keywords || [];
  const KWLABEL = { taunt: 'Taunt', charge: 'Charge', rush: 'Rush', shield: 'Ward', stealth: 'Veiled', lifesteal: 'Drain', poison: 'Venomous', reach: 'Reach', 'spell-immune': 'Spell Warded', reborn: 'Reborn', echo: 'Echo' };
  for (const k of kw) if (KWLABEL[k]) parts.push(KWLABEL[k] + '.');
  if (card.overload) parts.push(`Overload (${card.overload}).`);
  for (const a of card.abilities || []) {
    const tgtMin = a.target === 'allEnemyMinions' ? 'all enemy minions' : a.target === 'allEnemy' ? 'all enemies' : a.target === 'pickedTarget' ? (a.filter?.type === 'minion' ? 'a minion' : 'any target') : 'a target';
    if (a.trigger === 'onPlay' || a.trigger === 'onCast') {
      const pre = card.type === 'spell' ? '' : 'Battlecry: ';
      if (a.effect === 'damage') parts.push(`${pre}deal ${a.value} damage to ${tgtMin}.`);
      else if (a.effect === 'heal') parts.push(`${pre}restore ${a.value} health to ${a.target === 'selfHero' ? 'your hero' : 'a target'}.`);
      else if (a.effect === 'draw') parts.push(`${pre}draw ${a.value} card${a.value > 1 ? 's' : ''}.`);
      else if (a.effect === 'buff') parts.push(`${pre}give ${a.target === 'allFriendlyTribe' ? `your ${cfg.tribe} minions` : 'a friendly minion'} +${a.valueAtk || 0}/+${a.valueHp || 0}.`);
      else if (a.effect === 'buffThisTurn') parts.push(`${pre}give ${a.target === 'allFriendlyMinions' ? 'your minions' : 'a friendly minion'} +${a.valueAtk || 0}/+${a.valueHp || 0} this turn.`);
      else if (a.effect === 'freeze') parts.push(`${pre}Freeze ${tgtMin}.`);
      else if (a.effect === 'destroy') parts.push(`${pre}destroy an enemy minion.`);
      else if (a.effect === 'recruit') parts.push(`${pre}Recruit a minion that costs ${a.value} or less.`);
      else if (a.effect === 'adapt') parts.push(`${pre}Adapt.`);
      else if (a.effect === 'returnToHand') parts.push(`${pre}return the last friendly minion that died to your hand.`);
      else if (a.effect === 'summon') parts.push(`${pre}summon a ${tokenLabel(a.cardId)}.`);
    } else if (a.trigger === 'onDeath') {
      if (a.effect === 'summon') parts.push(`Deathrattle: summon a ${tokenLabel(a.cardId)}.`);
      else if (a.effect === 'draw') parts.push('Deathrattle: draw a card.');
      else if (a.effect === 'damage') parts.push(`Deathrattle: deal ${a.value} damage to ${tgtMin}.`);
      else if (a.effect === 'buff') parts.push(`Deathrattle: give ${a.target === 'allFriendlyTribe' ? `your ${cfg.tribe} minions` : 'a friendly minion'} +${a.valueAtk || 0}/+${a.valueHp || 0}.`);
    } else if (a.trigger === 'endOfTurn') {
      if (a.effect === 'heal') parts.push(`End of your turn: restore ${a.value} health to ${a.target === 'selfHero' ? 'your hero' : 'a friendly minion'}.`);
      else if (a.effect === 'buff') parts.push(`End of your turn: give ${a.target === 'allFriendlyTribe' ? `your ${cfg.tribe} minions` : 'a friendly minion'} +${a.valueAtk || 0}/+${a.valueHp || 0}.`);
    } else if (a.trigger === 'combo') {
      if (a.effect === 'damage') parts.push(`Combo: deal an extra ${a.value} damage to ${tgtMin}.`);
      else if (a.effect === 'buffThisTurn') parts.push(`Combo: give it +${a.valueAtk || 0}/+${a.valueHp || 0} this turn.`);
      else if (a.effect === 'draw') parts.push('Combo: draw a card.');
    } else if (a.trigger === 'spellDamageBonus') {
      parts.push('Your spells deal +1 damage while this is on the board.');
    }
  }
  return parts.join(' ').trim();
}
// Token display names are resolved lazily (the catalogue has the real
// stats); we just need a readable label for the rules string.
const TOKEN_LABELS = {};
function tokenLabel(id) { return TOKEN_LABELS[id] || 'token'; }

// ── Per-card mechanic assignment ─────────────────────────────────────
//
// Walks deterministically so the same id always yields the same card.
// `idx` is the card's position within its (set, rarity) bucket.
function buildCard(slug, cfg, rarity, idx, name) {
  const id = `${slug}.x${String(globalCounter[slug]++).padStart(3, '0')}`;
  const seed = id;
  const curve = MANA_CURVE[rarity];
  const mana = curve[idx % curve.length];
  const isSpell = (idx % SPELL_EVERY[rarity]) === (SPELL_EVERY[rarity] - 1) && rarity !== 'legendary'
    ? true
    : rarity === 'legendary' ? (idx % 5 === 4) : false;

  const card = { id, set: slug, rarity, tribe: isSpell ? null : cfg.tribe, keywords: [], abilities: [] };

  if (isSpell) {
    card.type = 'spell';
    card.mana = mana;
    assignSpell(card, cfg, seed, mana, rarity);
  } else {
    card.type = 'minion';
    card.mana = mana;
    assignMinion(card, cfg, seed, mana, rarity, idx);
    const split = (pick(seed + 'split', 3) - 1);  // -1,0,1
    const { atk, hp } = statsFromBudget(mana, rarity, card.abilities, card.keywords, split);
    card.atk = atk; card.hp = hp;
  }
  card.name = name;
  card.text = rulesText(card, cfg);
  card.flavor = choose(seed + 'flav', cfg.flavour);
  return card;
}

function tokenId(slug, suffix) { return `${slug}.${suffix}`; }

function assignMinion(card, cfg, seed, mana, rarity, idx) {
  const slug = card.set;
  const roll = pick(seed + 'role', 10);
  // Legendaries always get a splashy ability; others mix keyword/ability/vanilla.
  if (rarity === 'legendary') {
    assignLegendaryMinion(card, cfg, seed, mana);
    return;
  }
  // ~45% keyword minion, ~40% ability minion, ~15% vanilla (commons more vanilla).
  const vanillaCut = rarity === 'common' ? 2 : 1;
  if (roll < vanillaCut) {
    return; // vanilla
  }
  if (roll < 5) {
    // Keyword minion (weighted to the set's focus).
    const kw = choose(seed + 'kw', cfg.keywordWeight);
    card.keywords.push(kw);
    // Tides minions sometimes also grant spell damage.
    if (cfg.spellDamage && pick(seed + 'sd', 5) === 0 && mana >= 3) {
      card.abilities.push({ trigger: 'spellDamageBonus', effect: 'buff', target: 'self', value: 1 });
      card.keywords = [];  // spell-damage anchor is the identity; drop the kw
    }
    return;
  }
  // Ability minion — set-flavoured.
  if (cfg.deathrattle && pick(seed + 'dr', 2) === 0) {
    // Deathrattle minion (voidborn focus).
    const drRoll = pick(seed + 'drk', 4);
    if (drRoll === 0) card.abilities.push({ trigger: 'onDeath', effect: 'summon', target: 'self', cardId: tokenId(slug, choose(seed + 'tok', cfg.tokens).suffix) });
    else if (drRoll === 1) card.abilities.push({ trigger: 'onDeath', effect: 'draw', value: 1 });
    else if (drRoll === 2) card.abilities.push({ trigger: 'onDeath', effect: 'damage', target: 'randomEnemyMinion', value: 1 + (rarity === 'rare' ? 1 : 0) });
    else card.abilities.push({ trigger: 'onDeath', effect: 'buff', target: 'randomFriendlyMinion', valueAtk: 1 + (rarity === 'rare' ? 1 : 0), valueHp: 1 + (rarity === 'rare' ? 1 : 0) });
    return;
  }
  if (cfg.endOfTurn && pick(seed + 'eot', 2) === 0) {
    const v = rarity === 'rare' ? 2 : 1;
    if (pick(seed + 'eotk', 2) === 0) card.abilities.push({ trigger: 'endOfTurn', effect: 'heal', target: 'selfHero', value: v });
    else card.abilities.push({ trigger: 'endOfTurn', effect: 'buff', target: 'randomFriendlyMinion', valueAtk: v, valueHp: v });
    return;
  }
  if (cfg.combo && pick(seed + 'cmb', 2) === 0) {
    card.abilities.push({ trigger: 'combo', effect: 'damage', target: 'pickedTarget', value: rarity === 'rare' ? 3 : 2, filter: { type: 'minion' } });
    card.needsTargetHint = true;
    return;
  }
  // Generic battlecry.
  const bc = pick(seed + 'bc', 5);
  if (bc === 0) card.abilities.push({ trigger: 'onPlay', effect: 'damage', target: 'pickedTarget', value: mana >= 5 ? 3 : 2, filter: { type: 'minion' } });
  else if (bc === 1) card.abilities.push({ trigger: 'onPlay', effect: 'draw', value: 1 });
  else if (bc === 2) card.abilities.push({ trigger: 'onPlay', effect: 'heal', target: 'selfHero', value: rarity === 'rare' ? 4 : 2 });
  else if (bc === 3 && cfg.tribe) card.abilities.push({ trigger: 'onPlay', effect: 'buff', target: 'allFriendlyTribe', tribe: cfg.tribe, valueAtk: 1, valueHp: 1 });
  else card.abilities.push({ trigger: 'onPlay', effect: 'summon', target: 'self', cardId: tokenId(slug, cfg.tokens[0].suffix) });
}

function assignLegendaryMinion(card, cfg, seed, mana) {
  const slug = card.set;
  const r = pick(seed + 'leg', 6);
  if (r === 0) card.abilities.push({ trigger: 'onPlay', effect: 'damage', target: 'allEnemyMinions', value: mana >= 8 ? 4 : 3 });
  else if (r === 1) { card.abilities.push({ trigger: 'onDeath', effect: 'summon', target: 'self', cardId: tokenId(slug, cfg.tokens[1].suffix) }); card.abilities.push({ trigger: 'onDeath', effect: 'summon', target: 'self', cardId: tokenId(slug, cfg.tokens[1].suffix) }); card.keywords.push('taunt'); }
  else if (r === 2 && cfg.keywords.includes('reborn')) { card.keywords.push('reborn'); card.abilities.push({ trigger: 'onDeath', effect: 'buff', target: 'allFriendlyTribe', tribe: cfg.tribe, valueAtk: 2, valueHp: 2 }); }
  else if (r === 3) card.abilities.push({ trigger: 'onPlay', effect: 'recruit', value: mana >= 8 ? 5 : 4 });
  else if (r === 4) { card.abilities.push({ trigger: 'onPlay', effect: 'buff', target: 'allFriendlyTribe', tribe: cfg.tribe, valueAtk: 2, valueHp: 2 }); card.keywords.push('taunt'); }
  else { card.abilities.push({ trigger: 'onPlay', effect: 'damage', target: 'allEnemy', value: 3 }); if (cfg.keywords.includes('lifesteal')) card.keywords.push('lifesteal'); }
}

function assignSpell(card, cfg, seed, mana, rarity) {
  const eff = choose(seed + 'sp', cfg.spellEffects);
  const big = rarity === 'rare' || rarity === 'legendary';
  switch (eff) {
    case 'damage':
      card.abilities.push({ trigger: 'onCast', effect: 'damage', target: 'pickedTarget', value: Math.min(8, mana + (big ? 2 : 1)), filter: { type: 'minion' } });
      break;
    case 'damageAoe':
      card.abilities.push({ trigger: 'onCast', effect: 'damage', target: 'allEnemyMinions', value: Math.max(1, Math.min(4, mana - 1)) });
      break;
    case 'freeze':
      card.abilities.push({ trigger: 'onCast', effect: 'freeze', target: 'pickedTarget', filter: { type: 'minion' } });
      card.abilities.push({ trigger: 'onCast', effect: 'damage', target: 'pickedTarget', value: 1, filter: { type: 'minion' } });
      break;
    case 'damageFreeze':
      card.abilities.push({ trigger: 'onCast', effect: 'damage', target: 'allEnemyMinions', value: 1 });
      card.abilities.push({ trigger: 'onCast', effect: 'freeze', target: 'allEnemyMinions' });
      break;
    case 'overloadBolt':
      card.abilities.push({ trigger: 'onCast', effect: 'damage', target: 'pickedTarget', value: mana + 3 });
      card.overload = Math.min(3, 1 + (big ? 1 : 0));
      break;
    case 'comboBolt':
      card.abilities.push({ trigger: 'onCast', effect: 'damage', target: 'pickedTarget', value: 2, filter: { type: 'minion' } });
      card.abilities.push({ trigger: 'combo', effect: 'damage', target: 'pickedTarget', value: 2, filter: { type: 'minion' } });
      break;
    case 'buff':
      card.abilities.push({ trigger: 'onCast', effect: 'buff', target: 'pickedTarget', valueAtk: big ? 3 : 2, valueHp: big ? 3 : 2, filter: { type: 'friendly-minion' } });
      break;
    case 'buffThisTurn':
      card.abilities.push({ trigger: 'onCast', effect: 'buffThisTurn', target: 'allFriendlyMinions', valueAtk: big ? 2 : 1 });
      break;
    case 'heal':
      card.abilities.push({ trigger: 'onCast', effect: 'heal', target: 'selfHero', value: big ? 6 : 4 });
      break;
    case 'draw':
      card.abilities.push({ trigger: 'onCast', effect: 'draw', value: big ? 3 : 2 });
      break;
    case 'destroy':
      card.abilities.push({ trigger: 'onCast', effect: 'destroy', target: 'pickedTarget', filter: { type: 'enemy-minion' } });
      break;
    case 'recruit':
      card.abilities.push({ trigger: 'onCast', effect: 'recruit', value: big ? 4 : 3 });
      break;
    case 'returnDead':
      card.abilities.push({ trigger: 'onCast', effect: 'returnToHand', target: 'lastDeadFriendly' });
      break;
    case 'adaptBolt':
      card.abilities.push({ trigger: 'onCast', effect: 'buff', target: 'pickedTarget', valueAtk: 1, valueHp: 2, filter: { type: 'friendly-minion' } });
      break;
    case 'summonBolt':
      card.abilities.push({ trigger: 'onCast', effect: 'summon', target: 'self', cardId: tokenId(card.set, cfg.tokens[0].suffix) });
      card.abilities.push({ trigger: 'onCast', effect: 'summon', target: 'self', cardId: tokenId(card.set, cfg.tokens[0].suffix) });
      break;
  }
}

// ── Build everything ─────────────────────────────────────────────────
const globalCounter = {};

function buildAll() {
  const cards = [];
  const tokens = [];
  for (const [slug, cfg] of Object.entries(SETS_CFG)) {
    globalCounter[slug] = 1;
    // Register token labels + token cards first (so rules text resolves).
    for (const t of cfg.tokens) {
      const id = tokenId(slug, t.suffix);
      TOKEN_LABELS[id] = t.name;
      tokens.push({
        id, name: t.name, type: 'minion', token: true, rarity: 'token',
        set: slug, tribe: cfg.tribe, mana: 0, atk: t.atk, hp: t.hp,
        keywords: t.keywords.slice(), abilities: [],
        text: t.keywords.map((k) => ({ taunt: 'Taunt', charge: 'Charge', rush: 'Rush' }[k] || '')).filter(Boolean).join(' '),
        flavor: '',
      });
    }
    for (const rarity of ['common', 'uncommon', 'rare', 'legendary']) {
      const n = cfg.counts[rarity];
      const names = buildNamePool(cfg, slug + rarity, n);
      for (let i = 0; i < n; i++) {
        cards.push(buildCard(slug, cfg, rarity, i, names[i]));
      }
    }
  }
  // strip helper-only fields
  for (const c of cards) delete c.needsTargetHint;
  return { cards, tokens };
}

const built = buildAll();
export const EXPANSION_BULK_CARDS = built.cards;
export const EXPANSION_BULK_TOKENS = built.tokens;
