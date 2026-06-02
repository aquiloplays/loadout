// Gear-art archetype slugs — single source of truth for the hero
// paper-doll worn-overlay layer (Phase 2, 2026-06).
//
// The 185 SHOP_POOL rows collapse to ~50 visual ARCHETYPES: every sword
// shares one in-hand silhouette, every plate chestpiece shares one torso
// silhouette, etc. We pre-render one base overlay per archetype and tint
// it per-rarity client-side (CSS), so a handful of inpaints dress the
// whole catalogue. See tools/gear-worn-overlay-pipeline.py.
//
// Worn-overlay URL (built by character-composite.js):
//   /asset/gear-art/<slot>/<slug>/<sex>-worn.png
//   -> KV pixel-art-gear:<slot>:<slug>:<sex>-worn
//
// Every archetype is rendered per-sex: the Phase 1 bodies differ in
// vertical framing, scale, and torso/hand position between male and
// female, so a single overlay can't register across both. (Within a
// sex, class build varies less — overlays are extracted from a median-
// build rep and tolerate the residual, same as Phase 1 hair.)
//
// Rarity is NOT in the key — the base art is rarity-agnostic; the rarity
// sheen is a CSS tint (see rarityTintHex). gearArtSlug() is the same
// mapping used at mint (dungeon.js stamps item.art) AND at render
// (character-composite.js, as a fallback for legacy/lootbox bag items
// that predate the stamp), so the two can never drift.

// Explicit weapon types carried on SHOP_POOL rows.
const WEAPON_TYPES = new Set([
  'sword', 'axe', 'hammer', 'dagger', 'bow', 'crossbow', 'sling',
  'wand', 'staff', 'tome', 'orb', 'holy', 'polearm',
]);

// Fallback: infer a weapon type from the item name (starter gear and
// legacy bag items don't carry weaponType). First match wins.
const WEAPON_NAME_RULES = [
  [/sword|sabre|saber|flamberge|cleaver|drakebane|soulreaver|bossreaver|vampire blade|wraithblade/, 'sword'],
  [/\baxe\b|greataxe|lifedrinker axe/, 'axe'],
  [/hammer|maul|mace|cudgel|\bclub\b|doomhammer/, 'hammer'],
  [/dagger|daggers|stiletto|knives|knife|kris|heartseeker|whisperblade|bloodfang/, 'dagger'],
  [/crossbow/, 'crossbow'],
  [/\bbow\b|longbow|shortbow|kingbow|vorpal bow/, 'bow'],
  [/sling/, 'sling'],
  [/wand/, 'wand'],
  [/tome|grimoire|book/, 'tome'],
  [/\borb\b/, 'orb'],
  [/holy symbol|sun cross|crucifix|\bcross\b/, 'holy'],
  [/halberd|polearm|glaive|spear/, 'polearm'],
  [/staff|cudgel|quarterstaff|stave|\bcane\b/, 'staff'],
];

// Known set -> coarse material (sets are visually coherent).
const SET_MATERIAL = {
  ironclad: 'mail', knights: 'plate', dragonscale: 'plate', highborn: 'plate',
  marauder: 'plate', reaver: 'plate',
  arcane: 'robe', vestal: 'robe', suntouched: 'robe', stormcaller: 'robe', voidweave: 'robe',
  forester: 'leather', druidic: 'leather', shadow: 'leather', highwayman: 'leather',
  wayfarer: 'cloth',
};

// Fallback material keyword rules over (setName + name). First match wins.
const MATERIAL_NAME_RULES = [
  [/plate|cuirass|sabaton|greave|tasset|gauntlet|knight|dragon|highborn|marauder|reaver|aegis|bulwark|visor|wyvern|resilience|plated|highborn/, 'plate'],
  [/mail|chain|ironclad|\biron\b|steel/, 'mail'],
  [/leather|hide|forester|hunter|druid|ranger|garb|mossfoot|antlered|stealth|highwayman|whisperstep|soft sole|reinforced/, 'leather'],
  [/robe|vestal|arcane|sun-?touched|sun crown|circlet|cowl|voidweave|stormcaller|shadow cowl|holy|priest|cleric|vestment/, 'robe'],
];
const ARMOR_SLOTS = new Set(['head', 'chest', 'legs', 'boots']);
// Boots have no distinct 'robe' silhouette — robe footwear reads as cloth.
const SLOT_MATERIALS = {
  head:  ['cloth', 'leather', 'mail', 'plate', 'robe'],
  chest: ['cloth', 'leather', 'mail', 'plate', 'robe'],
  legs:  ['cloth', 'leather', 'mail', 'plate', 'robe'],
  boots: ['cloth', 'leather', 'mail', 'plate'],
};

function norm(s) { return String(s || '').toLowerCase(); }

function weaponArchetype(item) {
  const wt = norm(item.weaponType);
  if (wt && WEAPON_TYPES.has(wt)) return wt;
  const name = norm(item.name);
  for (const [re, t] of WEAPON_NAME_RULES) if (re.test(name)) return t;
  return 'sword'; // safe default silhouette
}

function armorMaterial(item) {
  const set = norm(item.setName);
  if (set && SET_MATERIAL[set]) {
    const m = SET_MATERIAL[set];
    // boots downgrade robe->cloth (no robe boot silhouette)
    if (item.slot === 'boots' && m === 'robe') return 'cloth';
    return m;
  }
  const hay = `${set} ${norm(item.name)}`;
  for (const [re, m] of MATERIAL_NAME_RULES) {
    if (re.test(hay)) return (item.slot === 'boots' && m === 'robe') ? 'cloth' : m;
  }
  return 'cloth';
}

// Map a gear item -> its worn-overlay archetype identity, or null when
// the item has no paper-doll layer (consumables, unknown slots).
//   { slot, slug }
// `slug` is the archetype within the slot. Every archetype is rendered
// per-sex (see header), so callers always pick the <sex>-worn variant.
export function gearArtSlug(item) {
  if (!item) return null;
  const slot = norm(item.slot);
  if (slot === 'weapon') return { slot, slug: weaponArchetype(item) };
  if (ARMOR_SLOTS.has(slot)) return { slot, slug: armorMaterial(item) };
  if (slot === 'trinket')  return { slot: 'trinket', slug: 'amulet' };
  return null; // consumable / unrenderable
}

// Compact stamp stored on the bag item at mint: "<slot>/<slug>".
export function gearArtStamp(item) {
  const a = gearArtSlug(item);
  return a ? `${a.slot}/${a.slug}` : '';
}

// Rarity sheen applied as a client-side CSS tint over the rarity-
// agnostic base overlay. common = no tint.
export function rarityTintHex(rarity) {
  return ({
    uncommon: '#5bff95', rare: '#4a8aff', epic: '#a98fff', legendary: '#ffd166',
  })[norm(rarity)] || null;
}

// Enumerate every distinct archetype the catalogue actually uses, given
// the SHOP_POOL rows. Returns the work-list the bulk runner generates:
//   [{ slot, slug, sexed }]  (deduped)
export function enumerateArchetypes(rows) {
  const seen = new Map();
  for (const r of rows) {
    const a = gearArtSlug(r);
    if (!a) continue;
    seen.set(`${a.slot}/${a.slug}`, a);
  }
  return [...seen.values()].sort((x, y) =>
    (x.slot + x.slug).localeCompare(y.slot + y.slug));
}

export { SLOT_MATERIALS, WEAPON_TYPES };
