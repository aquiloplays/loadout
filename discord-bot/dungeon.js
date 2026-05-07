// Worker-side dungeon RPG hub. The canonical hero state lives in the
// DLL (dungeon-heroes.json); this Worker file holds a parallel hero
// per Discord user keyed by guild+userId so off-stream slash commands
// (/hero, /inventory, /equip, /sell, /shop, /training) work without
// the DLL being awake. The DLL's nightly sync (Phase 2) will reconcile.
//
// KV layout (in LOADOUT_BOLTS namespace, shared with wallet.js):
//   d:hero:<guildId>:<discordUserId>  ->  HeroState JSON
//   d:shop:<guildId>                  ->  optional streamer-customised shop pool

import { getWallet, applyVaultDelta } from './wallet.js';

// Worker-side shop pool — full catalog mirror of the DLL's
// DungeonContent.Loot. The /loadout shop view doesn't show this
// whole list; instead, the Worker picks a deterministic 12-item
// rotation each day (date-seeded) so viewers come back daily for
// new stock. Keep names + stats in sync with the DLL catalog.
const SHOP_POOL = [
  // slot, rarity, name, glyph, atk, def, gold (price), setName, weaponType, preferredClass
  // ── Common ──
  ['weapon',  'common', 'Wooden Sword',     '🗡',  1, 0,  16, '',          'sword',   'warrior'],
  ['weapon',  'common', 'Bronze Shortsword', '🗡', 1, 0,  20, '',          'sword',   'warrior'],
  ['weapon',  'common', 'Wooden Club',      '🏏',  1, 0,  16, '',          'hammer',  'warrior'],
  ['weapon',  'common', 'Hand Axe',         '🪓',  1, 0,  18, '',          'axe',     'warrior'],
  ['weapon',  'common', 'Rusty Dagger',     '🗡',  1, 0,  18, '',          'dagger',  'rogue'],
  ['weapon',  'common', 'Throwing Knives',  '🔪',  1, 0,  18, '',          'dagger',  'rogue'],
  ['weapon',  'common', 'Shortbow',         '🏹',  1, 0,  20, '',          'bow',     'ranger'],
  ['weapon',  'common', 'Hunter\'s Sling',   '🪨', 1, 0,  18, '',          'sling',   'ranger'],
  ['weapon',  'common', 'Apprentice Wand',  '🪄',  1, 0,  22, '',          'wand',    'mage'],
  ['weapon',  'common', 'Twigwand',         '🌿',  1, 0,  20, '',          'wand',    'mage'],
  ['weapon',  'common', 'Walking Staff',    '🥢',  1, 1,  22, '',          'staff',   'healer'],
  ['weapon',  'common', 'Quarterstaff',     '🥢',  1, 1,  24, '',          'staff',   'healer'],
  ['head',    'common', 'Leather Cap',      '🧢',  0, 1,  18, '',          '', ''],
  ['head',    'common', 'Cloth Hood',       '👤',  0, 1,  18, '',          '', ''],
  ['head',    'common', 'Wayfarer Hat',     '🎩',  0, 1,  22, 'wayfarer',  '', ''],
  ['head',    'common', 'Padded Coif',      '🧣',  0, 1,  18, '',          '', ''],
  ['chest',   'common', 'Cloth Tunic',      '👕',  0, 1,  18, '',          '', ''],
  ['chest',   'common', 'Hide Vest',        '🦬',  0, 1,  16, '',          '', ''],
  ['chest',   'common', 'Wayfarer Vest',    '👔',  0, 1,  22, 'wayfarer',  '', ''],
  ['chest',   'common', 'Quilted Doublet',  '🧥',  0, 1,  20, '',          '', ''],
  ['legs',    'common', 'Hempen Trousers',  '👖',  0, 1,  16, '',          '', ''],
  ['legs',    'common', 'Patchwork Greaves', '🧱', 0, 1,  18, '',          '', ''],
  ['legs',    'common', 'Wayfarer Trousers', '👖', 0, 1,  22, 'wayfarer',  '', ''],
  ['boots',   'common', 'Worn Boots',       '🥾',  0, 1,  16, '',          '', ''],
  ['boots',   'common', 'Sandals',          '🩴',  0, 1,  14, '',          '', ''],
  ['boots',   'common', 'Wayfarer Shoes',   '👟',  0, 1,  22, 'wayfarer',  '', ''],
  ['trinket', 'common', 'Crow Feather',     '🪶',  0, 1,  18, '',          '', ''],
  ['trinket', 'common', 'Wooden Charm',     '🪵',  0, 1,  16, '',          '', ''],
  ['trinket', 'common', 'Brass Ring',       '💍',  0, 1,  18, '',          '', ''],
  ['trinket', 'common', 'Lucky Coin',       '🪙',  1, 0,  22, '',          '', ''],

  // ── Uncommon ──
  ['weapon',  'uncommon', 'Steel Longsword',  '⚔',   2, 0,  60, '',         'sword',   'warrior'],
  ['weapon',  'uncommon', 'Knight\'s Sword',  '⚔',   3, 0,  68, '',         'sword',   'warrior'],
  ['weapon',  'uncommon', 'Iron War Axe',     '🪓',  2, 0,  65, '',         'axe',     'warrior'],
  ['weapon',  'uncommon', 'Battle Axe',       '🪓',  3, 0,  72, '',         'axe',     'warrior'],
  ['weapon',  'uncommon', 'Steel Maul',       '🔨',  3, 0,  70, '',         'hammer',  'warrior'],
  ['weapon',  'uncommon', 'Iron Halberd',     '⚔',   3, 1,  78, '',         'polearm', 'warrior'],
  ['weapon',  'uncommon', 'Hunter\'s Bow',    '🏹',  2, 0,  60, '',         'bow',     'ranger'],
  ['weapon',  'uncommon', 'Yew Longbow',      '🏹',  3, 0,  72, '',         'bow',     'ranger'],
  ['weapon',  'uncommon', 'Hand Crossbow',    '🎯',  3, 0,  74, '',         'crossbow','ranger'],
  ['weapon',  'uncommon', 'Stiletto',         '🗡',  2, 0,  60, '',         'dagger',  'rogue'],
  ['weapon',  'uncommon', 'Pair of Daggers',  '🗡',  3, 0,  72, '',         'dagger',  'rogue'],
  ['weapon',  'uncommon', 'Apprentice Tome',  '📕',  2, 0,  68, '',         'tome',    'mage'],
  ['weapon',  'uncommon', 'Crystal Wand',     '🪄',  3, 0,  76, '',         'wand',    'mage'],
  ['weapon',  'uncommon', 'Apprentice Staff', '🥢',  2, 1,  68, '',         'staff',   'mage'],
  ['weapon',  'uncommon', 'Glass Orb',        '🔮',  2, 1,  72, '',         'orb',     'mage'],
  ['weapon',  'uncommon', 'Healer\'s Cane',   '🪄',  1, 2,  68, '',         'staff',   'healer'],
  ['weapon',  'uncommon', 'Oaken Holy Symbol','✝',   2, 1,  72, '',         'holy',    'healer'],
  ['head',    'uncommon', 'Iron Helm',        '⛑',   0, 2,  55, 'ironclad', '', 'warrior'],
  ['chest',   'uncommon', 'Chainmail',        '🦺',  0, 2,  60, 'ironclad', '', 'warrior'],
  ['legs',    'uncommon', 'Iron Greaves',     '🦿',  0, 2,  55, 'ironclad', '', 'warrior'],
  ['boots',   'uncommon', 'Iron Sabatons',    '👢',  0, 2,  55, 'ironclad', '', 'warrior'],
  ['head',    'uncommon', 'Mage\'s Circlet',  '🔮',  1, 1,  70, 'arcane',   '', 'mage'],
  ['chest',   'uncommon', 'Arcane Robes',     '🥋',  1, 1,  70, 'arcane',   '', 'mage'],
  ['legs',    'uncommon', 'Arcane Skirt',     '🧣',  1, 1,  65, 'arcane',   '', 'mage'],
  ['boots',   'uncommon', 'Arcane Slippers',  '🥿',  1, 1,  60, 'arcane',   '', 'mage'],
  ['head',    'uncommon', 'Forester\'s Cap',  '🧢',  1, 1,  60, 'forester', '', 'ranger'],
  ['chest',   'uncommon', 'Hunter\'s Garb',   '🦺',  1, 1,  65, 'forester', '', 'ranger'],
  ['legs',    'uncommon', 'Forest Trousers',  '👖',  1, 1,  60, 'forester', '', 'ranger'],
  ['boots',   'uncommon', 'Soft Soles',       '🥾',  1, 1,  58, 'forester', '', 'ranger'],
  ['head',    'uncommon', 'Holy Coif',        '🥽',  0, 2,  65, 'vestal',   '', 'healer'],
  ['chest',   'uncommon', 'Vestal Robes',     '👘',  0, 2,  70, 'vestal',   '', 'healer'],
  ['legs',    'uncommon', 'Vestal Skirt',     '🧣',  0, 2,  60, 'vestal',   '', 'healer'],
  ['boots',   'uncommon', 'Vestal Slippers',  '🩰',  0, 2,  55, 'vestal',   '', 'healer'],
  ['trinket', 'uncommon', 'Lucky Charm',      '🍀',  1, 1,  70, '',         '', ''],
  ['trinket', 'uncommon', 'Iron Ring',        '💍',  0, 2,  75, 'ironclad', '', 'warrior'],
  ['trinket', 'uncommon', 'Owl Pendant',      '🦉',  1, 1,  72, '',         '', ''],
  ['trinket', 'uncommon', 'Compass',          '🧭',  0, 2,  70, '',         '', ''],

  // ── Rare ──
  ['weapon',  'rare', 'Frost Hammer',         '🔨',  4, 0, 180, '',           'hammer', 'warrior'],
  ['weapon',  'rare', 'Flamberge',            '⚔',   5, 0, 200, '',           'sword',  'warrior'],
  ['weapon',  'rare', 'Greataxe',             '🪓',  5, 0, 195, '',           'axe',    'warrior'],
  ['weapon',  'rare', 'Steel Halberd',        '⚔',   4, 1, 200, '',           'polearm','warrior'],
  ['weapon',  'rare', 'Wraithblade',          '🗡',  4, 1, 195, '',           'dagger', 'rogue'],
  ['weapon',  'rare', 'Shadow Daggers',       '🗡',  5, 0, 220, 'shadow',     'dagger', 'rogue'],
  ['weapon',  'rare', 'Silver Crossbow',      '🎯',  4, 0, 180, '',           'crossbow','ranger'],
  ['weapon',  'rare', 'Composite Longbow',    '🏹',  5, 0, 200, '',           'bow',    'ranger'],
  ['weapon',  'rare', 'Shadow Staff',         '🪄',  4, 1, 195, '',           'staff',  'mage'],
  ['weapon',  'rare', 'Druid\'s Staff',       '🌿',  3, 2, 195, '',           'staff',  'mage'],
  ['weapon',  'rare', 'Crystal Orb',          '🔮',  4, 1, 200, '',           'orb',    'mage'],
  ['weapon',  'rare', 'Forbidden Tome',       '📕',  4, 1, 205, '',           'tome',   'mage'],
  ['weapon',  'rare', 'Sun Cross',            '✝',   3, 2, 200, '',           'holy',   'healer'],
  ['weapon',  'rare', 'Healing Staff',        '🥢',  2, 3, 200, '',           'staff',  'healer'],
  ['head',    'rare', 'Knight\'s Helm',       '⛑',   1, 4, 200, 'knights',    '', 'warrior'],
  ['chest',   'rare', 'Knight\'s Cuirass',    '🛡',  1, 4, 220, 'knights',    '', 'warrior'],
  ['legs',    'rare', 'Knight\'s Tassets',    '🦿',  1, 4, 200, 'knights',    '', 'warrior'],
  ['boots',   'rare', 'Knight\'s Sabatons',   '👢',  1, 4, 195, 'knights',    '', 'warrior'],
  ['head',    'rare', 'Dragon Helm',          '🐉',  1, 4, 220, 'dragonscale','', 'warrior'],
  ['chest',   'rare', 'Dragonscale Plate',    '🐲',  2, 4, 240, 'dragonscale','', 'warrior'],
  ['legs',    'rare', 'Dragonscale Tassets',  '🐲',  1, 4, 220, 'dragonscale','', 'warrior'],
  ['head',    'rare', 'Antlered Hood',        '🦌',  2, 3, 200, 'druidic',    '', 'ranger'],
  ['chest',   'rare', 'Druidic Robes',        '🌿',  2, 3, 220, 'druidic',    '', 'ranger'],
  ['legs',    'rare', 'Druidic Pants',        '🍃',  2, 3, 200, 'druidic',    '', 'ranger'],
  ['boots',   'rare', 'Mossfoot Boots',       '🍂',  2, 3, 195, 'druidic',    '', 'ranger'],
  ['head',    'rare', 'Sun Crown',            '☀',   1, 4, 210, 'suntouched', '', 'healer'],
  ['chest',   'rare', 'Sun-touched Robes',    '👘',  1, 4, 230, 'suntouched', '', 'healer'],
  ['legs',    'rare', 'Sun-touched Skirt',    '🧣',  1, 4, 210, 'suntouched', '', 'healer'],
  ['head',    'rare', 'Stormcaller Cowl',     '⛈',  3, 2, 215, 'stormcaller','', 'mage'],
  ['chest',   'rare', 'Stormcaller Vest',     '⚡',  3, 2, 230, 'stormcaller','', 'mage'],
  ['chest',   'rare', 'Plated Cuirass',       '🛡',  1, 4, 220, '',           '', ''],
  ['boots',   'rare', 'Stormstride Boots',    '⛈',  1, 3, 200, '',           '', ''],
  ['trinket', 'rare', 'Healing Amulet',       '📿',  0, 3, 220, '',           '', ''],
  ['trinket', 'rare', 'Shadow Cloak Pin',     '🎗',  2, 2, 240, 'shadow',     '', 'rogue'],
  ['trinket', 'rare', 'Phoenix Down',         '🔥',  2, 2, 230, '',           '', ''],
  ['trinket', 'rare', 'Wolf Tooth',           '🐺',  2, 2, 220, '',           '', ''],
  ['trinket', 'rare', 'Forest Pendant',       '🍃',  2, 2, 220, 'druidic',    '', 'ranger'],
  ['trinket', 'rare', 'Vestal Pendant',       '📿',  1, 3, 220, 'vestal',     '', 'healer'],
  ['trinket', 'rare', 'Storm Sigil',          '⚡',  3, 2, 220, 'stormcaller','', 'mage'],

  // ── Epic ──
  ['weapon',  'epic', 'Drakebane Sword',      '🗡',  7, 1, 600, '',           'sword',  'warrior'],
  ['weapon',  'epic', 'Soulreaver',           '💀',  8, 0, 650, '',           'sword',  'warrior'],
  ['weapon',  'epic', 'Doomhammer',           '🔨',  8, 1, 660, '',           'hammer', 'warrior'],
  ['weapon',  'epic', 'Cleaver of Kings',     '🪓',  8, 0, 640, '',           'axe',    'warrior'],
  ['weapon',  'epic', 'Stormcaller Staff',    '⚡',  7, 2, 680, 'stormcaller','staff',  'mage'],
  ['weapon',  'epic', 'Grimoire of Storms',   '📘',  7, 2, 680, '',           'tome',   'mage'],
  ['weapon',  'epic', 'Voidcaller Wand',      '🪄',  8, 1, 690, '',           'wand',   'mage'],
  ['weapon',  'epic', 'Vorpal Bow',           '🏹',  8, 0, 650, '',           'bow',    'ranger'],
  ['weapon',  'epic', 'Skywatcher Crossbow',  '🎯',  8, 0, 660, '',           'crossbow','ranger'],
  ['weapon',  'epic', 'Whisperblades',        '🗡',  8, 0, 660, '',           'dagger', 'rogue'],
  ['weapon',  'epic', 'Heartseeker',          '🗡',  9, 0, 700, '',           'dagger', 'rogue'],
  ['weapon',  'epic', 'Phoenix Staff',        '🔥',  6, 4, 700, '',           'staff',  'healer'],
  ['head',    'epic', 'Voidweave Hood',       '🌑',  4, 3, 660, 'voidweave',  '', 'mage'],
  ['chest',   'epic', 'Voidweave Robe',       '🌑',  4, 4, 700, 'voidweave',  '', 'mage'],
  ['head',    'epic', 'Shadow Cowl',          '🥷',  3, 4, 660, 'shadow',     '', 'rogue'],
  ['chest',   'epic', 'Shadow Cuirass',       '🌙',  3, 5, 700, 'shadow',     '', 'rogue'],
  ['boots',   'epic', 'Shadowstep Boots',     '👞',  4, 3, 680, 'shadow',     '', 'rogue'],
  ['head',    'epic', 'Highborn Helm',        '👑',  3, 5, 700, 'highborn',   '', 'warrior'],
  ['chest',   'epic', 'Highborn Plate',       '🛡',  3, 6, 740, 'highborn',   '', 'warrior'],
  ['head',    'epic', 'Wyvern Crown',         '👑',  2, 5, 600, '',           '', ''],
  ['boots',   'epic', 'Sevenleague Boots',    '👢',  2, 5, 660, '',           '', ''],
  ['trinket', 'epic', 'Phoenix Feather',      '🪶',  3, 4, 660, '',           '', ''],
  ['trinket', 'epic', 'Soul Lantern',         '🏮',  4, 3, 720, '',           '', ''],
  ['trinket', 'epic', 'Storm Heart',          '⚡',  4, 3, 700, '',           '', ''],
  ['trinket', 'epic', 'Voidstone',            '🌑',  5, 2, 680, 'voidweave',  '', 'mage'],
  ['trinket', 'epic', 'Shadow Mask',          '🎭',  4, 3, 690, 'shadow',     '', 'rogue']
];

// ── Daily shop rotation ─────────────────────────────────────────────
// The Worker picks a deterministic 12-item subset from SHOP_POOL each
// UTC day and caches it in KV so repeat /loadout shop opens within
// the same day return identical stock. Date is the seed so the same
// guild sees the same rotation across viewers (no per-viewer
// fairness games), and rotates at midnight UTC on the dot.
const SHOP_DAILY_PICKS = 12;

function dayKey() {
  // ISO YYYY-MM-DD in UTC.
  const d = new Date();
  return d.getUTCFullYear() + '-' +
         String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
         String(d.getUTCDate()).padStart(2, '0');
}

function dailySeed(guildId) {
  // 32-bit hash of (guildId + dayKey). Mulberry32-friendly seed.
  const s = (guildId || '') + ':' + dayKey();
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let t = seed;
  return function () {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export async function getDailyShop(env, guildId) {
  const today = dayKey();
  const cacheKey = 'd:shop-daily:' + guildId + ':' + today;
  const cached = await env.LOADOUT_BOLTS.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch { /* fall through */ }
  }
  // Build the rotation: weighted picks with rarity tiers represented.
  // Quotas: 4 common, 4 uncommon, 3 rare, 1 epic — feels like a real
  // shop window where the cool stuff costs more.
  const rng = mulberry32(dailySeed(guildId));
  const byRarity = { common: [], uncommon: [], rare: [], epic: [] };
  for (const row of SHOP_POOL) {
    const r = row[1];
    if (byRarity[r]) byRarity[r].push(row);
  }
  const quotas = { common: 4, uncommon: 4, rare: 3, epic: 1 };
  const picks = [];
  for (const tier of Object.keys(quotas)) {
    const pool = byRarity[tier];
    const need = Math.min(quotas[tier], pool.length);
    // Weighted shuffle: each pool entry gets a random key, sort, take N.
    const tagged = pool.map(p => [rng(), p]);
    tagged.sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < need; i++) picks.push(tagged[i][1]);
  }

  const stock = {
    day: today,
    items: picks
  };
  // Cache for ~26 hours (slack past midnight) so a request right at
  // the rollover doesn't double-fetch. KV TTL is at-least-once;
  // expirationTtl in seconds.
  await env.LOADOUT_BOLTS.put(cacheKey, JSON.stringify(stock), { expirationTtl: 26 * 60 * 60 });
  return stock;
}

function msUntilNextUtcMidnight() {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0);
  return next - now.getTime();
}
function fmtRotateIn(ms) {
  if (ms <= 0) return '0m';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? (h + 'h ' + m + 'm') : (m + 'm');
}

const SLOTS = ['weapon', 'head', 'chest', 'legs', 'boots', 'trinket'];

const HERO_KEY = (guild, userId) => 'd:hero:' + guild + ':' + userId;

// -------------------- store ops --------------------

async function loadHero(env, guild, userId) {
  // Two-layer lookup so /loadout reflects stream-earned gear from the
  // DLL push:
  //   1. d:hero-by-handle:<guild>:<platform>:<handle> — DLL pushes
  //      dungeon-heroes.json on the existing sync cadence; resolve via
  //      wallet → first identity link.
  //   2. d:hero:<guild>:<userId> — Worker-local progression (off-stream
  //      shop buys, training, equips). Used as fallback for unlinked
  //      viewers and merged on top so Discord-side mutations win for
  //      slots the DLL hasn't touched.
  const w = await getWallet(env, guild, userId);
  const link = (w.links || [])[0];
  let dllHero = null;
  if (link?.platform && link?.username) {
    const raw = await env.LOADOUT_BOLTS.get(
      `d:hero-by-handle:${guild}:${link.platform.toLowerCase()}:${link.username.toLowerCase()}`);
    if (raw) {
      try { dllHero = JSON.parse(raw); } catch { /* swallow */ }
    }
  }
  const raw = await env.LOADOUT_BOLTS.get(HERO_KEY(guild, userId));
  let local = null;
  if (raw) { try { local = JSON.parse(raw); } catch { /* swallow */ } }

  if (dllHero && local) {
    // Merge plan — different fields have different sources of truth:
    //
    //   DLL canonical (set by !dungeon runs, can't be set on Discord):
    //     level, xp, hpMax, hpCurrent, dungeonsSurvived, bossesSlain,
    //     legendariesFound, mythicsFound, achievements, dungeonsVisited.
    //
    //   Discord canonical (set by /loadout, never touched by !dungeon):
    //     avatar, className, custom. Earlier this was lost — the merge
    //     overwrote them with the DLL's empty defaults on every read.
    //     Fix is to keep local's value for each whenever it's set,
    //     falling back to the DLL-pushed value only when local is blank.
    //
    //   Both can mutate (union):
    //     bag — DLL adds dungeon drops, Discord adds /shop-buy items.
    //     equipped — Discord sets via /equip, DLL only when a !dungeon
    //                drop is auto-equipped (rare).
    const merged = newHero();
    Object.assign(merged, dllHero);
    if (local.avatar)    merged.avatar    = local.avatar;
    if (local.className) merged.className = local.className;
    if (local.custom && Object.keys(local.custom).length > 0) {
      merged.custom = Object.assign({}, dllHero.custom || {}, local.custom);
    }
    const ids = new Set((dllHero.bag || []).map(it => it.id));
    merged.bag = [...(dllHero.bag || []), ...((local.bag || []).filter(it => !ids.has(it.id)))];
    merged.equipped = Object.assign({}, local.equipped || {}, dllHero.equipped || {});
    return merged;
  }
  if (dllHero) return Object.assign(newHero(), dllHero);
  if (local)   return Object.assign(newHero(), local);
  return newHero();
}

async function saveHero(env, guild, userId, hero) {
  hero.lastUpdatedUtc = new Date().toISOString();
  await env.LOADOUT_BOLTS.put(HERO_KEY(guild, userId), JSON.stringify(hero));
}

function newHero() {
  return {
    avatar: '',         // viewer-supplied URL (Twitch profile pic, custom upload, etc.)
    className: '',      // one of: warrior / mage / rogue / ranger / healer
    custom: {},         // free-form: skinTone, hairColor, hairStyle, eyeColor, primary, secondary, cape
    level: 1,
    xp: 0,
    hpMax: 25,
    hpCurrent: 25,
    bag: [],            // [{id, slot, rarity, name, glyph, powerBonus, defenseBonus, goldValue, setName}]
    equipped: {},       // slot -> id
    duelsWon: 0,
    duelsLost: 0,
    dungeonsSurvived: 0,
    bossesSlain: 0,
    legendariesFound: 0,
    mythicsFound: 0,
    achievements: [],
    dungeonsVisited: [],
    createdUtc: new Date().toISOString(),
    lastUpdatedUtc: new Date().toISOString()
  };
}

// Customization palettes mirrored from the overlay so /loadout
// pickers can offer the same options. Keep in sync with main.js
// SKIN_TONES / HAIR_COLORS / EYE_COLORS / CAPE_PRESETS.
export const CUSTOM_OPTIONS = {
  skinTone:  ['fair', 'tan', 'olive', 'deep', 'pale-blue', 'pale-green'],
  hairColor: ['black', 'brown', 'blonde', 'red', 'white', 'pink', 'blue', 'green'],
  hairStyle: ['short', 'long', 'spiky', 'mohawk', 'braids', 'bald'],
  eyeColor:  ['brown', 'blue', 'green', 'amber', 'red'],
  cape:      ['none', 'cloak', 'wing', 'scarf']
};

// Class table — mirrors DungeonContent.Classes on the DLL side. Used
// for stat bonuses + tint colour + glyph rendering in /loadout. Keep
// in sync with src/Loadout.Core/Games/Dungeon/DungeonContent.cs.
export const CLASSES = {
  warrior: { name: 'Warrior', glyph: '⚔',  tint: 0xF85149, atk: 2, def: 0,  hp: 0 },
  mage:    { name: 'Mage',    glyph: '🪄', tint: 0xB452FF, atk: 1, def: 1,  hp: 0 },
  rogue:   { name: 'Rogue',   glyph: '🗡', tint: 0x3FB950, atk: 2, def: -1, hp: 0 },
  ranger:  { name: 'Ranger',  glyph: '🏹', tint: 0xF0B429, atk: 1, def: 0,  hp: 0 },
  healer:  { name: 'Healer',  glyph: '✨', tint: 0x00F2EA, atk: 0, def: 1,  hp: 5 }
};

function bagIndex(hero) {
  const ix = {};
  for (const it of hero.bag || []) ix[it.id] = it;
  return ix;
}

function attackOf(hero) {
  let g = 0;
  const ix = bagIndex(hero);
  for (const id of Object.values(hero.equipped || {})) if (ix[id]) g += ix[id].powerBonus || 0;
  const cls = CLASSES[hero.className];
  return 4 + (hero.level - 1) + g + (cls?.atk || 0);
}

function defenseOf(hero) {
  let g = 0;
  const ix = bagIndex(hero);
  for (const id of Object.values(hero.equipped || {})) if (ix[id]) g += ix[id].defenseBonus || 0;
  const cls = CLASSES[hero.className];
  return Math.floor((hero.level - 1) / 2) + g + (cls?.def || 0);
}

function rarityColour(r) {
  // Discord embed colour ints — match the overlay rarity palette so the
  // "epic glow" reads consistently across surfaces.
  switch (r) {
    case 'uncommon':  return 0x46D160;
    case 'rare':      return 0x3A86FF;
    case 'epic':      return 0xB452FF;
    case 'legendary': return 0xF0B429;
    default:          return 0xB0B0B0;
  }
}

// -------------------- public command implementations --------------------

/// Build a Discord CDN URL for a user's avatar. Used as the fallback
/// when hero.avatar isn't set so viewers don't have to manually paste
/// a URL — the avatar they already have in Discord just shows up.
/// Falls back to Discord's default coloured-circle avatar (six images
/// indexed by user-id) when the user has no custom upload.
export function discordAvatarUrl(user) {
  if (!user?.id) return '';
  if (user.avatar) {
    return 'https://cdn.discordapp.com/avatars/' + user.id + '/' + user.avatar + '.png?size=128';
  }
  // Default avatar bucket — Discord's six fallback images. The "new
  // username system" formula uses (id >> 22) % 6; legacy discrim was
  // discrim % 5. We use the new formula since legacy discriminators
  // are gone everywhere now.
  let idx = 0;
  try { idx = Number((BigInt(user.id) >> 22n) % 6n); } catch { idx = 0; }
  return 'https://cdn.discordapp.com/embed/avatars/' + idx + '.png';
}

/// Build a deterministic pixel-art portrait URL for a hero using
/// DiceBear's public pixel-art generator. Same seed always produces
/// the same character; different classes get different seeds so a
/// warrior and a mage on the same Discord account look different.
/// Class tint becomes the background colour.
///
/// Why DiceBear instead of the overlay's own SVG sprite: Discord's
/// embed media proxy reliably renders DiceBear's PNG output. Inline
/// SVGs from a Worker route get filtered out of embeds. The portrait
/// here is a "Discord-side" character — viewers still see their
/// composed pixel-art sprite (with chosen skin/hair/cape) on the
/// dungeon overlay; the two surfaces stay distinct on purpose.
export function characterPortraitUrl(hero, callerUser, callerName, fallback) {
  if (hero?.avatar) return hero.avatar;
  if (hero?.className && CLASSES[hero.className]) {
    const cls = CLASSES[hero.className];
    const bgHex = cls.tint.toString(16).padStart(6, '0');
    const seedSrc = (callerName || callerUser?.id || 'hero') + '-' + hero.className;
    return 'https://api.dicebear.com/9.x/pixel-art/png?seed=' +
           encodeURIComponent(seedSrc) +
           '&size=256&backgroundColor=' + bgHex;
  }
  return fallback || '';
}

export async function cmdHero(env, guild, callerId, targetUser, callerName, callerUser) {
  const targetId = targetUser?.id || callerId;
  const targetName = targetUser?.username || (targetId === callerId ? callerName : 'that hero');
  const hero = await loadHero(env, guild, targetId);

  const atk = attackOf(hero);
  const def = defenseOf(hero);
  const cls = CLASSES[hero.className];
  const equippedLines = SLOTS.map(s => {
    const id = hero.equipped?.[s];
    const it = id ? (hero.bag || []).find(x => x.id === id) : null;
    return '`' + s.padEnd(7) + '` ' + (it ? (it.glyph + ' ' + it.name + ' (' + it.rarity + ')') : '_empty_');
  });

  const titleClass = cls ? (cls.glyph + ' ' + cls.name) : '⚔';
  const embed = {
    title: titleClass + '   ' + targetName + ' — Lv ' + hero.level,
    description:
      '**HP** ' + hero.hpCurrent + ' / ' + hero.hpMax +
      '   **ATK** ' + atk +
      '   **DEF** ' + def + '\n' +
      '**XP** ' + hero.xp + '\n' +
      '**Dungeons** ' + (hero.dungeonsSurvived || 0) + ' survived' +
      (hero.duelsWon ? '   **Duels** ' + hero.duelsWon + 'W / ' + (hero.duelsLost || 0) + 'L' : '') +
      '\n\n' + equippedLines.join('\n'),
    color: cls?.tint || 0x3A86FF
  };
  // Embed thumbnail slot (top-right ~80px). Three-tier portrait:
  //   1. hero.avatar — explicit URL the viewer pasted (legacy)
  //   2. DiceBear pixel-art portrait when a class is set — gives
  //      every viewer a distinct character that actually LOOKS like
  //      a pixel-art hero rather than just their Discord pic.
  //   3. Discord avatar fallback — for viewers who haven't picked a
  //      class yet, so they still see something.
  // If a fetch fails Discord just hides the thumbnail; the rest of
  // the embed still renders.
  const thumbUrl = characterPortraitUrl(hero, callerUser, targetName,
    callerUser ? discordAvatarUrl(callerUser) : '');
  if (thumbUrl) embed.thumbnail = { url: thumbUrl };
  // Also use the portrait as the embed image (bigger render, below
  // the description) when the viewer has actually set a class.
  // Otherwise the embed only has the small thumbnail in the corner.
  if (hero.className && CLASSES[hero.className]) {
    embed.image = { url: thumbUrl };
  }

  return {
    embeds: [embed],
    ephemeral: targetId !== callerId
  };
}

// Mutators for the /loadout Character sub-view. Worker-side state
// is the source of truth here; the DLL respects whatever the Worker
// pushed last when both sides have a hero (see loadHero merge).
export async function cmdSetAvatar(env, guild, userId, url) {
  const trimmed = (url || '').trim();
  if (trimmed && !/^https?:\/\//i.test(trimmed)) {
    return { content: '❌ Avatar must be an https:// URL (or blank to clear).', ephemeral: true };
  }
  const hero = await loadHero(env, guild, userId);
  hero.avatar = trimmed;
  await saveHero(env, guild, userId, hero);
  return { content: trimmed ? '👤 Avatar saved.' : '👤 Avatar cleared.' };
}

export async function cmdSetClass(env, guild, userId, className) {
  const key = (className || '').toLowerCase().trim();
  if (!CLASSES[key]) return { content: '❌ Unknown class.', ephemeral: true };
  const hero = await loadHero(env, guild, userId);
  // Re-base HpMax so the class-specific HP bonus lands correctly when
  // switching mid-progression. Old class bonus comes off first.
  const oldBonus = (CLASSES[hero.className]?.hp) || 0;
  const newBonus = CLASSES[key].hp;
  const delta = newBonus - oldBonus;
  hero.hpMax = Math.max(1, hero.hpMax + delta);
  hero.hpCurrent = Math.max(0, Math.min(hero.hpMax, hero.hpCurrent + delta));
  hero.className = key;
  await saveHero(env, guild, userId, hero);
  const cls = CLASSES[key];
  return { content: '🎭 Class set to ' + cls.glyph + ' **' + cls.name + '** (+' + cls.atk + ' ATK · +' + cls.def + ' DEF · +' + cls.hp + ' HP).' };
}

/// Customization mutator — accepts any (key, value) pair where the
/// value comes from the curated CUSTOM_OPTIONS list. "" / "none"
/// clears the slot. Keeps the customization map small + sane.
export async function cmdSetCustom(env, guild, userId, key, value) {
  const k = (key || '').trim();
  const v = (value || '').trim().toLowerCase();
  if (!CUSTOM_OPTIONS[k]) return { content: '❌ Unknown customization key.', ephemeral: true };
  if (v && !CUSTOM_OPTIONS[k].includes(v)) {
    return { content: '❌ Unknown ' + k + ' value. Pick from: ' + CUSTOM_OPTIONS[k].join(', '), ephemeral: true };
  }
  const hero = await loadHero(env, guild, userId);
  if (!hero.custom) hero.custom = {};
  if (!v || v === 'none') delete hero.custom[k];
  else hero.custom[k] = v;
  await saveHero(env, guild, userId, hero);
  return { content: '🎨 ' + k + ' = ' + (v || 'default') + '.' };
}

export async function cmdInventory(env, guild, userId) {
  const hero = await loadHero(env, guild, userId);
  if (!Array.isArray(hero.bag) || hero.bag.length === 0) {
    return { content: '🎒 Your bag is empty. Run a `!dungeon` on stream or `/shop-buy` here to acquire gear.', ephemeral: true };
  }
  // Sort by rarity (legendary first) so the best stuff is at the top.
  const order = { legendary: 4, epic: 3, rare: 2, uncommon: 1, common: 0 };
  const lines = [...hero.bag]
    .sort((a, b) => (order[b.rarity] || 0) - (order[a.rarity] || 0))
    .slice(0, 25)
    .map(it => {
      const eq = Object.values(hero.equipped || {}).includes(it.id) ? '  📌' : '';
      const stats = [];
      if (it.powerBonus)   stats.push('+' + it.powerBonus + ' ATK');
      if (it.defenseBonus) stats.push('+' + it.defenseBonus + ' DEF');
      return '`' + it.id.slice(0, 6) + '`  ' + it.glyph + '  **' + it.name + '** _(' + it.rarity + ' ' + it.slot + ')_  ' +
             stats.join(' ') + eq;
    });
  return {
    content: '🎒 **Bag** (' + hero.bag.length + ' items)\n' + lines.join('\n') +
             '\n\n_Use_ `/equip item_id:<6-char>` _from above to equip._',
    ephemeral: true
  };
}

export async function cmdEquip(env, guild, userId, itemIdPrefix) {
  const hero = await loadHero(env, guild, userId);
  const it = (hero.bag || []).find(x => x.id.startsWith(itemIdPrefix));
  if (!it) return { content: 'No item with id `' + itemIdPrefix + '` in your bag. Run `/inventory` for ids.', ephemeral: true };
  if (!SLOTS.includes(it.slot)) return { content: 'That item has no equip slot.', ephemeral: true };
  if (!hero.equipped) hero.equipped = {};
  hero.equipped[it.slot] = it.id;
  await saveHero(env, guild, userId, hero);
  return {
    content: '✅ Equipped ' + it.glyph + ' **' + it.name + '** in your `' + it.slot + '` slot.',
    ephemeral: true
  };
}

export async function cmdUnequip(env, guild, userId, slot) {
  const hero = await loadHero(env, guild, userId);
  if (!hero.equipped || !hero.equipped[slot]) {
    return { content: 'Nothing equipped in `' + slot + '`.', ephemeral: true };
  }
  delete hero.equipped[slot];
  await saveHero(env, guild, userId, hero);
  return { content: '🧤 Unequipped your `' + slot + '`.', ephemeral: true };
}

export async function cmdSell(env, guild, userId, itemIdPrefix) {
  const hero = await loadHero(env, guild, userId);
  const it = (hero.bag || []).find(x => x.id.startsWith(itemIdPrefix));
  if (!it) return { content: 'No item with id `' + itemIdPrefix + '` in your bag.', ephemeral: true };

  const refund = Math.max(1, Math.floor((it.goldValue || 1) / 2));
  hero.bag = hero.bag.filter(x => x.id !== it.id);
  // Unequip if the sold item was equipped.
  for (const s of Object.keys(hero.equipped || {})) {
    if (hero.equipped[s] === it.id) delete hero.equipped[s];
  }
  await saveHero(env, guild, userId, hero);

  // Refund as bolts to the wallet.
  await applyVaultDelta(env, guild, userId, refund, 'dungeon-sell');
  return {
    content: '💰 Sold ' + it.glyph + ' **' + it.name + '** for **' + refund + '** bolts.',
    ephemeral: true
  };
}

export async function cmdShop(env, guild, userId) {
  const stock = await getDailyShop(env, guild);
  const hero = await loadHero(env, guild, userId);
  const heroClass = (hero?.className || '').toLowerCase();
  const lines = stock.items.map(row => {
    const [slot, rarity, name, glyph, atk, def, gold, setName, weaponType, preferredClass] = row;
    const stats = [];
    if (atk) stats.push('+' + atk + ' ATK');
    if (def) stats.push('+' + def + ' DEF');
    if (setName)        stats.push('_set:_ ' + setName);
    // Class-affinity tag — viewers spot at-a-glance which items
    // match their class so they buy gear that pulls extra weight.
    let suffix = '';
    if (preferredClass) {
      const matches = heroClass && preferredClass === heroClass;
      suffix = matches ? '  ✨ **YOUR CLASS**' : '  _(for ' + preferredClass + ')_';
    }
    return '`' + String(gold).padStart(4) + 'b` ' + glyph + ' **' + name + '** _(' + rarity + ' ' + slot + ')_  ' +
           stats.join(' ') + suffix;
  });
  const rotateIn = fmtRotateIn(msUntilNextUtcMidnight());
  return {
    content: '🏪 **Dungeon Shop** — _stock rotates in ' + rotateIn + '_\n' +
             lines.join('\n') +
             '\n\n_Use_ `/loadout` _→ Shop → Buy to purchase. Today\'s stock is fixed; new items tomorrow._',
    ephemeral: true
  };
}

export async function cmdShopBuy(env, guild, userId, itemName) {
  // Daily-rotation gate: only items in today's stock are buyable. The
  // viewer might know the name of an item from a previous day — surface
  // a clear "not in today's stock" reply instead of letting them buy
  // anything from the full pool.
  const stock = await getDailyShop(env, guild);
  const hit = stock.items.find(([_s, _r, name]) =>
    name.toLowerCase().includes((itemName || '').toLowerCase()));
  if (!hit) return { content: 'That item isn\'t in today\'s stock. Run `/loadout` → Shop to see the rotation — restocks at midnight UTC.', ephemeral: true };
  const [slot, rarity, name, glyph, atk, def, price, setName, weaponType, preferredClass] = hit;

  const w = await getWallet(env, guild, userId);
  if ((w.balance || 0) < price) {
    return { content: '💸 You need **' + price + '** bolts (you have ' + (w.balance || 0) + '). Run `/daily` or earn more on stream.', ephemeral: true };
  }

  // Deduct via wallet's negative-delta path so the lifetime-earned counter
  // doesn't grow when the viewer is just shifting bolts → gear.
  const debit = await applyVaultDelta(env, guild, userId, -price, 'dungeon-shop');
  if (!debit?.ok && debit?.balance == null) {
    return { content: '❌ Couldn\'t debit your wallet. Try again.', ephemeral: true };
  }

  const hero = await loadHero(env, guild, userId);
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  hero.bag = hero.bag || [];
  hero.bag.push({
    id,
    slot, rarity, name, glyph,
    powerBonus: atk, defenseBonus: def,
    goldValue: price,
    setName: setName || '',
    weaponType: weaponType || '',
    preferredClass: preferredClass || '',
    foundIn: 'shop',
    foundUtc: new Date().toISOString()
  });
  await saveHero(env, guild, userId, hero);

  return {
    content: '🛒 Bought ' + glyph + ' **' + name + '** for **' + price + '** bolts. Equip it with `/equip item_id:' + id.slice(0, 6) + '`.'
  };
}

export async function cmdTraining(env, guild, userId, focus, rounds) {
  const r = Math.max(1, Math.min(50, rounds || 5));
  const cost = r * 10;

  const w = await getWallet(env, guild, userId);
  if ((w.balance || 0) < cost) {
    return { content: '💸 Training costs **' + cost + '** bolts (you have ' + (w.balance || 0) + ').', ephemeral: true };
  }
  await applyVaultDelta(env, guild, userId, -cost, 'dungeon-training');

  const hero = await loadHero(env, guild, userId);
  let summary;
  if (focus === 'hp') {
    const gain = r;                    // +1 HP per round
    hero.hpMax += gain;
    hero.hpCurrent = Math.min(hero.hpMax, hero.hpCurrent + gain);
    summary = '+' + gain + ' max HP';
  } else if (focus === 'attack') {
    const xp = r * 6;                  // bonus XP for the strength grind
    hero.xp += xp;
    while (hero.xp >= xpForLevel(hero.level)) {
      hero.xp -= xpForLevel(hero.level);
      hero.level++;
      hero.hpMax += 5;
      hero.hpCurrent = hero.hpMax;
    }
    summary = '+' + xp + ' XP (now Lv ' + hero.level + ')';
  } else {
    // dodge: full heal, half-XP — defensive focus
    const xp = r * 3;
    hero.xp += xp;
    hero.hpCurrent = hero.hpMax;
    summary = '+' + xp + ' XP and a full HP refill';
  }
  await saveHero(env, guild, userId, hero);

  return {
    content: '🥋 Trained **' + r + '** rounds (-' + cost + ' bolts). ' + summary + '.'
  };
}

function xpForLevel(level) {
  if (level <= 1) return 50;
  return 50 + (level - 1) * 35 + (level - 1) * (level - 1) * 8;
}
