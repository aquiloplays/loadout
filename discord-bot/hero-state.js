// Shared hero-state primitives. The dungeon RPG gameplay that this file
// used to host (inventory / equip / shop / training) has been archived;
// what remains is the per-user hero record (class, look, level, stats)
// that Boltbound (champion class), the LFG hub, pet, and campaigns still
// read. The canonical hero may also be pushed from the DLL
// (dungeon-heroes.json) on the sync cadence and merged in loadHero.
//
// KV layout (in LOADOUT_BOLTS namespace, shared with wallet.js):
//   d:hero:<guildId>:<discordUserId>  ->  HeroState JSON

import { getWallet } from './wallet.js';
import { gearArtStamp } from './gear-art-slugs.js';

const HERO_KEY = (guild, userId) => 'd:hero:' + guild + ':' + userId;

// -------------------- store ops --------------------

export async function loadHero(env, guild, userId) {
  // Two-layer lookup so /loadout reflects stream-earned gear from the
  // DLL push:
  //   1. d:hero-by-handle:<guild>:<platform>:<handle>, DLL pushes
  //      dungeon-heroes.json on the existing sync cadence; resolve via
  //      wallet → first identity link.
  //   2. d:hero:<guild>:<userId>, Worker-local progression (off-stream
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
    // Merge plan, different fields have different sources of truth:
    //
    //   DLL canonical (set by !dungeon runs, can't be set on Discord):
    //     level, xp, hpMax, hpCurrent, dungeonsSurvived, bossesSlain,
    //     legendariesFound, mythicsFound, achievements, dungeonsVisited.
    //
    //   Discord canonical (set by /loadout, never touched by !dungeon):
    //     avatar, className, custom. Earlier this was lost, the merge
    //     overwrote them with the DLL's empty defaults on every read.
    //     Fix is to keep local's value for each whenever it's set,
    //     falling back to the DLL-pushed value only when local is blank.
    //
    //   Both can mutate (union):
    //     bag, DLL adds dungeon drops, Discord adds /shop-buy items.
    //     equipped, Discord sets via /equip, DLL only when a !dungeon
    //                drop is auto-equipped (rare).
    const merged = newHero();
    Object.assign(merged, dllHero);
    if (local.avatar)    merged.avatar    = local.avatar;
    if (local.className) merged.className = local.className;
    if (local.custom && Object.keys(local.custom).length > 0) {
      merged.custom = Object.assign({}, dllHero.custom || {}, local.custom);
    }
    // `locked` is worker-canonical (DLL has no notion of the
    // character-lock state). Always honour the local value.
    if (typeof local.locked === 'boolean') merged.locked = local.locked;
    const ids = new Set((dllHero.bag || []).map(it => it.id));
    merged.bag = [...(dllHero.bag || []), ...((local.bag || []).filter(it => !ids.has(it.id)))];
    merged.equipped = Object.assign({}, local.equipped || {}, dllHero.equipped || {});
    // lookVersion: highest wins (last save wins from either side).
    merged.lookVersion = Math.max(local.lookVersion || 0, dllHero.lookVersion || 0);
    return applyLookBackfill(merged, userId);
  }
  if (dllHero) return applyLookBackfill(Object.assign(newHero(), dllHero), userId);
  if (local)   return applyLookBackfill(Object.assign(newHero(), local), userId);
  return applyLookBackfill(newHero(), userId);
}

// Updated merge return path: apply Phase 0 backfill on the merged
// hero too, so callers always see complete look data regardless of
// which branch produced the hero.
function _backfillMerged(hero, userId) { return applyLookBackfill(hero, userId); }

export async function saveHero(env, guild, userId, hero) {
  hero.lastUpdatedUtc = new Date().toISOString();
  await env.LOADOUT_BOLTS.put(HERO_KEY(guild, userId), JSON.stringify(hero));
}

function newHero() {
  return {
    avatar: '',         // viewer-supplied URL (Twitch profile pic, custom upload, etc.)
    className: '',      // one of: warrior / mage / rogue / ranger / healer
    custom: {},         // viewer's pixel-art "look", see CHARACTER_LOOK_OPTIONS
                        // below. Phase 0 deterministically backfills any
                        // missing fields on first read so a fresh hero
                        // never renders blank.
    lookVersion: 0,     // bumped on every /character save; pinned in
                        // render URLs so Discord re-fetches the cached
                        // embed image after a customisation change.
    locked: false,      // true once the character has been "created" via
                        // the first class pick. Subsequent look/class
                        // edits reject with character-locked until a
                        // 5,000-Bolt /web/character/reset clears it.
    level: 1,
    xp: 0,
    hpMax: 25,
    hpCurrent: 25,
    // Soft-death state (2026-05-29). Its writer module (hero-death.js)
    // and the Revive Elixir shop were removed at the Bolts economy sunset,
    // so nothing sets these today. The fields stay on the persisted hero
    // record as dormant scaffolding for a future revival and to keep
    // forward-compat with KV heroes that already carry them.
    status: 'alive',
    diedAt: null,       // ISO timestamp of last death, null when alive
    deathReason: null,  // e.g. 'expedition', cleared on revive
    bag: [],            // [{id, slot, rarity, name, glyph, powerBonus, defenseBonus, goldValue, setName, spriteId}]
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

// Pixel-art character "look" palette. Locked by CHARACTER-SYSTEM-DESIGN.md §2.
// The procedural sprite generator (tools/build-sprites.ps1) outputs one
// sprite per cell here, so this list is also the authoritative content
// catalogue for the figure layers.
//
// Field-name compatibility: this lives on `hero.custom` (existing name)
// rather than a new top-level `look` block, so the DLL sync merge in
// loadHero() above keeps treating it as Discord-canonical. The
// design-doc "look" name aliases to this in-code.
export const CHARACTER_LOOK_OPTIONS = {
  bodyType:  ['slim', 'stocky'],
  skinTone:  ['fair', 'porcelain', 'rose', 'tan', 'olive', 'bronze', 'umber', 'ebony', 'pale_violet', 'ash'],
  hairStyle: ['short-tousled', 'long-straight', 'bun', 'mohawk', 'braids', 'curly-afro', 'pixie', 'ponytail', 'bald', 'shaved-sides', 'mullet', 'wizard-long'],
  hairColor: ['brown', 'black', 'blonde', 'red', 'grey', 'white', 'violet', 'teal', 'pink', 'mint', 'silver', 'copper', 'navy', 'forest'],
  eyeColor:  ['brown', 'blue', 'green', 'hazel', 'amber', 'violet', 'silver', 'pink'],
  accent:    ['none', 'freckles', 'eye-shadow', 'face-scar', 'beauty-mark', 'glasses-round'],
  // 2026-05-29, Phase A of the hero customization expansion. Sex
  // toggles male/female base sprite (asset overhaul has both at
  // /asset/hero-art/<class>(-female)?.png). Facial is male-only, // setting it on a female character is a no-op in the renderer.
  sex:       ['male', 'female'],
  facial:    ['clean', 'mustache', 'goatee', 'beard'],
};

// Legacy alias, pre-character-system code (the old custom options
// picker) imported CUSTOM_OPTIONS with a smaller list. We keep the
// name pointing at the new fuller set so existing call sites get the
// upgraded palette without code changes.
export const CUSTOM_OPTIONS = CHARACTER_LOOK_OPTIONS;

// Deterministic Phase 0 default. Given a userId, returns a stable
// "look" object that's consistent across rehydrations, so a fresh
// hero never renders blank, but the same user always sees their own
// pre-customisation default. The hashing is intentionally trivial
// (sum of charcodes mod table length); the goal is stability, not
// cryptographic distribution.
function pickByHash(userId, salt, list) {
  let h = 0;
  const s = String(userId) + ':' + salt;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return list[Math.abs(h) % list.length];
}

export function defaultLookForUser(userId) {
  return {
    bodyType:  pickByHash(userId, 'body',   CHARACTER_LOOK_OPTIONS.bodyType),
    skinTone:  pickByHash(userId, 'skin',   CHARACTER_LOOK_OPTIONS.skinTone),
    hairStyle: pickByHash(userId, 'hair',   CHARACTER_LOOK_OPTIONS.hairStyle),
    hairColor: pickByHash(userId, 'haircol',CHARACTER_LOOK_OPTIONS.hairColor),
    eyeColor:  pickByHash(userId, 'eye',    CHARACTER_LOOK_OPTIONS.eyeColor),
    accent:    'none',
    // Phase A defaults. Existing characters get male+clean via the
    // backfill on first read, Phase B adds a "did you mean female?"
    // hint on the customize page so legacy heroes can opt in.
    sex:       'male',
    facial:    'clean',
  };
}

// Backfill missing look fields on a loaded hero. Used by loadHero so
// every read of a customised-or-not hero hands the renderer a
// complete look object, no per-field null checks downstream.
//
// Important: this MUTATES `hero.custom` in place. The hero is not
// re-saved here (Phase 0 backfill is read-time only); the persistent
// record stays empty until the viewer explicitly customises via
// /character, at which point we save the full look. That keeps the
// DLL sync merge clean, `custom` only contains fields the viewer
// actively set.
export function applyLookBackfill(hero, userId) {
  if (!hero) return hero;
  hero.custom = hero.custom || {};
  const def = defaultLookForUser(userId);
  for (const k of Object.keys(def)) {
    if (hero.custom[k] == null || hero.custom[k] === '') {
      hero.custom[k] = def[k];
    }
  }
  if (typeof hero.lookVersion !== 'number') hero.lookVersion = 0;
  // Legacy records pre-date the character-lock feature. A hero that has
  // already had their class picked (starterGranted=true) has "created"
  // their character, so they start locked on the first read after this
  // ships, matching the new contract without a one-off migration.
  if (typeof hero.locked !== 'boolean') hero.locked = !!hero.starterGranted;
  return hero;
}

// Class table, mirrors DungeonContent.Classes on the DLL side. Used
// for stat bonuses + tint colour + glyph rendering in /loadout. Keep
// in sync with src/Loadout.Core/Games/Dungeon/DungeonContent.cs.
export const CLASSES = {
  warrior: { name: 'Warrior', glyph: '⚔',  tint: 0xF85149, atk: 2, def: 0,  hp: 0 },
  mage:    { name: 'Mage',    glyph: '🪄', tint: 0xB452FF, atk: 1, def: 1,  hp: 0 },
  rogue:   { name: 'Rogue',   glyph: '🗡', tint: 0x3FB950, atk: 2, def: -1, hp: 0 },
  ranger:  { name: 'Ranger',  glyph: '🏹', tint: 0xF0B429, atk: 1, def: 0,  hp: 0 },
  healer:  { name: 'Healer',  glyph: '✨', tint: 0x00F2EA, atk: 0, def: 1,  hp: 5 }
};

// Starter-gear loadout per class. Granted once, the first time a hero
// picks a class (tracked via hero.starterGranted). Re-picking a class
// later (Discord /loadout class … or the web class picker) only
// re-recomputes HP, it never re-grants gear, so you can't farm
// starter sets by churning the picker.
//
// The items are minted inline rather than pulled from DEFAULT_CATALOG
// because the catalog only carries one common item per slot, and the
// goal here is class flavour: each class gets a weapon + head + chest
// that matches their archetype, plus a class-themed trinket. Slot
// totals are identical across classes (5 items each) so power
// progression stays in line.

function bagIndex(hero) {
  const ix = {};
  for (const it of hero.bag || []) ix[it.id] = it;
  return ix;
}

export function attackOf(hero) {
  let g = 0;
  const ix = bagIndex(hero);
  for (const id of Object.values(hero.equipped || {})) if (ix[id]) g += ix[id].powerBonus || 0;
  const cls = CLASSES[hero.className];
  return 4 + (hero.level - 1) + g + (cls?.atk || 0);
}

export function defenseOf(hero) {
  let g = 0;
  const ix = bagIndex(hero);
  for (const id of Object.values(hero.equipped || {})) if (ix[id]) g += ix[id].defenseBonus || 0;
  const cls = CLASSES[hero.className];
  return Math.floor((hero.level - 1) / 2) + g + (cls?.def || 0);
}


/// Build a Discord CDN URL for a user's avatar. Used as the fallback
/// when hero.avatar isn't set so viewers don't have to manually paste
/// a URL, the avatar they already have in Discord just shows up.
/// Falls back to Discord's default coloured-circle avatar (six images
/// indexed by user-id) when the user has no custom upload.
export function discordAvatarUrl(user) {
  if (!user?.id) return '';
  if (user.avatar) {
    return 'https://cdn.discordapp.com/avatars/' + user.id + '/' + user.avatar + '.png?size=128';
  }
  // Default avatar bucket, Discord's six fallback images. The "new
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
/// here is a "Discord-side" character, viewers still see their
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


export const STARTER_GEAR = {
  warrior: [
    { slot: 'weapon',  rarity: 'common', name: 'Bronze Shortsword',  powerBonus: 2, defenseBonus: 0, ability: '',         goldValue: 50 },
    { slot: 'head',    rarity: 'common', name: 'Iron Helm',          powerBonus: 0, defenseBonus: 2, ability: '',         goldValue: 50 },
    { slot: 'chest',   rarity: 'common', name: 'Padded Bulwark',     powerBonus: 0, defenseBonus: 2, ability: '',         goldValue: 45 },
    { slot: 'legs',    rarity: 'common', name: 'Iron Greaves',       powerBonus: 0, defenseBonus: 1, ability: '',         goldValue: 40 },
    { slot: 'trinket', rarity: 'common', name: 'Iron Ward',          powerBonus: 0, defenseBonus: 1, ability: '',         goldValue: 60 },
  ],
  mage: [
    { slot: 'weapon',  rarity: 'common', name: 'Apprentice Staff',   powerBonus: 2, defenseBonus: 0, ability: '',         goldValue: 50 },
    { slot: 'head',    rarity: 'common', name: 'Cloth Hood',         powerBonus: 1, defenseBonus: 0, ability: '',         goldValue: 35 },
    { slot: 'chest',   rarity: 'common', name: 'Arcane Robes',       powerBonus: 1, defenseBonus: 1, ability: '',         goldValue: 50 },
    { slot: 'legs',    rarity: 'common', name: 'Druidic Pants',      powerBonus: 0, defenseBonus: 1, ability: '',         goldValue: 40 },
    { slot: 'trinket', rarity: 'common', name: 'Crystal Orb',        powerBonus: 1, defenseBonus: 0, ability: '',         goldValue: 60 },
  ],
  rogue: [
    { slot: 'weapon',  rarity: 'common', name: 'Rusty Dagger',       powerBonus: 2, defenseBonus: 0, ability: '',         goldValue: 35 },
    { slot: 'head',    rarity: 'common', name: 'Highwayman Mask',    powerBonus: 1, defenseBonus: 0, ability: '',         goldValue: 45 },
    { slot: 'chest',   rarity: 'common', name: 'Highwayman Coat',    powerBonus: 1, defenseBonus: 1, ability: '',         goldValue: 50 },
    { slot: 'legs',    rarity: 'common', name: 'Highwayman Pants',   powerBonus: 0, defenseBonus: 1, ability: '',         goldValue: 40 },
    { slot: 'trinket', rarity: 'common', name: 'Shadow Cloak Pin',   powerBonus: 1, defenseBonus: 0, ability: '',         goldValue: 60 },
  ],
  ranger: [
    { slot: 'weapon',  rarity: 'common', name: 'Shortbow',           powerBonus: 2, defenseBonus: 0, ability: '',         goldValue: 50 },
    { slot: 'head',    rarity: 'common', name: 'Foresters Cap',      powerBonus: 0, defenseBonus: 1, ability: '',         goldValue: 40 },
    { slot: 'chest',   rarity: 'common', name: 'Hunters Garb',       powerBonus: 1, defenseBonus: 1, ability: '',         goldValue: 50 },
    { slot: 'legs',    rarity: 'common', name: 'Forest Trousers',    powerBonus: 0, defenseBonus: 1, ability: '',         goldValue: 40 },
    { slot: 'trinket', rarity: 'common', name: 'Hunters Token',      powerBonus: 1, defenseBonus: 0, ability: '',         goldValue: 60 },
  ],
  healer: [
    { slot: 'weapon',  rarity: 'common', name: 'Healers Cane',       powerBonus: 1, defenseBonus: 0, ability: '',         goldValue: 50 },
    { slot: 'head',    rarity: 'common', name: 'Holy Coif',          powerBonus: 0, defenseBonus: 1, ability: '',         goldValue: 45 },
    { slot: 'chest',   rarity: 'common', name: 'Vestal Robes',       powerBonus: 0, defenseBonus: 2, ability: '',         goldValue: 50 },
    { slot: 'legs',    rarity: 'common', name: 'Vestal Skirt',       powerBonus: 0, defenseBonus: 1, ability: '',         goldValue: 40 },
    { slot: 'trinket', rarity: 'common', name: 'Healing Amulet',     powerBonus: 0, defenseBonus: 1, ability: 'heal',     goldValue: 70 },
  ],
};

/**
 * Apply a class selection to a hero, recomputing HP and (on first
 * selection) granting the class's starter gear loadout.
 *
 * Idempotent on the starter-gear grant: the hero record carries a
 * `starterGranted` boolean once gear has been minted. Subsequent
 * class changes still flip className + HP but don't mint more gear.
 *
 * Both the Discord /loadout class slash command and the web character
 * editor call this through their respective wrappers so the contract
 * stays single-source.
 */
export async function applyClassSelection(env, guild, userId, key) {
  const cls = CLASSES[key];
  if (!cls) return { ok: false, error: 'bad-class' };

  const hero = await loadHero(env, guild, userId);
  // Character-lock gate: once the player has "created" their character
  // (first class pick → starter gear granted → locked=true), class
  // changes are frozen until they pay 5,000 Bolts via
  // /web/character/reset. Defence in depth, the web routes also
  // check this, but applying it here means the Discord /loadout
  // class command honours the same rule.
  if (hero.locked) return { ok: false, error: 'character-locked' };
  const oldBonus = (CLASSES[hero.className]?.hp) || 0;
  const newBonus = cls.hp || 0;
  const delta = newBonus - oldBonus;
  hero.hpMax = Math.max(1, hero.hpMax + delta);
  hero.hpCurrent = Math.max(0, Math.min(hero.hpMax, hero.hpCurrent + delta));
  hero.className = key;

  // First-time grant: mint the class's starter loadout into the bag
  // AND auto-equip each piece into its slot. Newly-minted gear with
  // a class flavour is the player's intended baseline, making them
  // open the equip menu to put it on would feel pointless. Existing
  // equipped items (none, on first-pick) would be respected if the
  // slot is already filled (defence in depth, shouldn't happen on a
  // fresh hero, but cheap to check).
  let granted = [];
  if (!hero.starterGranted) {
    if (!Array.isArray(hero.bag)) hero.bag = [];
    if (!hero.equipped || typeof hero.equipped !== 'object') hero.equipped = {};
    const items = STARTER_GEAR[key] || [];
    for (const it of items) {
      const minted = {
        id: 's_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now().toString(36),
        slot: it.slot,
        rarity: it.rarity,
        name: it.name,
        glyph: '',
        powerBonus: it.powerBonus || 0,
        defenseBonus: it.defenseBonus || 0,
        ability: it.ability || '',
        goldValue: it.goldValue || 0,
        foundIn: 'Starter gear',
        foundUtc: new Date().toISOString(),
      };
      // Paper-doll worn-overlay archetype (additive; the id stays a
      // unique bag-instance handle). Render-side derives this too for
      // legacy bag items, so the stamp is an optimization, not a
      // contract, see gear-art-slugs.js / character-composite.js.
      minted.art = gearArtStamp(minted);
      hero.bag.push(minted);
      granted.push(minted);
      // Auto-equip into the matching slot if it's empty. We don't
      // overwrite an existing equip, a class switch that happens to
      // re-grant gear (it can't today; starterGranted gates that) would
      // leave the player's current loadout intact.
      if (it.slot && !hero.equipped[it.slot]) {
        hero.equipped[it.slot] = minted.id;
      }
    }
    hero.starterGranted = true;
  }

  // Note: we deliberately do NOT set hero.locked=true here. The lock
  // is committed by the look save (saveCharacterLookWeb), that's the
  // single "I'm done picking" act on the web editor. Class pick is a
  // preliminary step the player can do first; locking it here would
  // freeze the look picker before the player even opened it.

  await saveHero(env, guild, userId, hero);
  return {
    ok: true,
    className: key,
    classMeta: { name: cls.name, atk: cls.atk, def: cls.def, hp: cls.hp },
    granted,
    starterGranted: !!hero.starterGranted,
    hpMax: hero.hpMax,
    locked: !!hero.locked,
  };
}
