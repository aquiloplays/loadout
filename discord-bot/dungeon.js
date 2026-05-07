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

// Static loot pool — duplicated from DLL/Games/Dungeon/DungeonContent.cs
// so the Worker can roll without round-tripping. Subset chosen to fit
// the 6 equip slots + a couple of consumables.
const SHOP_POOL = [
  // slot, rarity, name, glyph, atk, def, gold (price)
  ['weapon',  'common',    'Bronze Shortsword', '🗡️', 1, 0,  20 ],
  ['weapon',  'uncommon',  'Steel Longsword',   '⚔️', 2, 0,  60 ],
  ['weapon',  'rare',      'Frost Hammer',      '🔨', 4, 0, 180 ],
  ['head',    'common',    'Leather Cap',       '🧢', 0, 1,  18 ],
  ['head',    'uncommon',  'Iron Helm',         '⛑️', 0, 2,  55 ],
  ['chest',   'common',    'Cloth Tunic',       '👕', 0, 1,  18 ],
  ['chest',   'uncommon',  'Chainmail',         '🦺', 0, 2,  60 ],
  ['boots',   'common',    'Worn Boots',        '🥾', 0, 1,  16 ],
  ['trinket', 'uncommon',  'Lucky Charm',       '🍀', 1, 1,  70 ],
  ['trinket', 'rare',      'Healing Amulet',    '📿', 0, 3, 220 ],
];

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
    // Merge: DLL is canonical for level/XP/HP/dungeons-stats; bag is
    // unioned (Discord shop additions live alongside dungeon drops);
    // equipped slots merged with DLL winning when both have an entry
    // for the same slot.
    const merged = newHero();
    Object.assign(merged, dllHero);
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
    level: 1,
    xp: 0,
    hpMax: 25,
    hpCurrent: 25,
    bag: [],            // [{id, slot, rarity, name, glyph, powerBonus, defenseBonus, goldValue}]
    equipped: {},       // slot -> id
    duelsWon: 0,
    duelsLost: 0,
    dungeonsSurvived: 0,
    createdUtc: new Date().toISOString(),
    lastUpdatedUtc: new Date().toISOString()
  };
}

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

export async function cmdHero(env, guild, callerId, targetUser, callerName) {
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
  // Avatar shows in the embed's thumbnail slot — Discord renders it
  // top-right at ~80px, exactly the right size for a viewer's
  // character portrait. If the URL ever 404s Discord just hides the
  // thumbnail; the rest of the embed still renders.
  if (hero.avatar) embed.thumbnail = { url: hero.avatar };

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
  const lines = SHOP_POOL.map(([slot, rarity, name, glyph, atk, def, gold]) => {
    const stats = [];
    if (atk) stats.push('+' + atk + ' ATK');
    if (def) stats.push('+' + def + ' DEF');
    return '`' + String(gold).padStart(4) + 'b` ' + glyph + ' **' + name + '** _(' + rarity + ' ' + slot + ')_  ' + stats.join(' ');
  });
  return {
    content: '🏪 **Dungeon Shop**\n' + lines.join('\n') +
             '\n\n_Use_ `/shop-buy item:<name>` _to purchase. Bolts are deducted from your wallet._',
    ephemeral: true
  };
}

export async function cmdShopBuy(env, guild, userId, itemName) {
  const hit = SHOP_POOL.find(([_s, _r, name]) =>
    name.toLowerCase().includes((itemName || '').toLowerCase()));
  if (!hit) return { content: 'No shop item matches `' + itemName + '`. Run `/shop` for the list.', ephemeral: true };
  const [slot, rarity, name, glyph, atk, def, price] = hit;

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
