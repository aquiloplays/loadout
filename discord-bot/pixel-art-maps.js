// Pixel-art asset maps for the bootstrap response.
//
// The 2026-05-29 asset overhaul shipped 4 new categories of pixel
// art alongside the existing v9 card art:
//   - heroes  (5 classes)         -> pixel-art-hero:<classId>
//   - gear    (185 SHOP_POOL rows) -> pixel-art-gear:<slot>:<slug>:<rarity>
//   - clash   (156 buildings + 12 troops)
//                                  -> pixel-art-clash:buildings:<kind>:<level>
//                                  -> pixel-art-clash:units:<id>
//   - pets    (8 species)         -> pixel-art-pet:<id>
//
// This module lists all four KV prefixes (in parallel, KV list is one
// round-trip per page, no per-key GET) and shapes them into the maps
// the PWA renderers expect:
//
//   globalHeroArt:  { [classId]:    url }
//   globalGearArt:  { [slot]: { [slug]: { [rarity]: url } } }
//   globalClashArt: { buildings: { [kind]: { [level]: url } },
//                     troops:    { [id]: url } }
//   globalPetArt:   { [petId]:     url }
//
// Each URL is deterministic from the KV key, so we don't need to GET
// any values, `list` returns names only, which is the cheapest KV
// operation. For ~370 keys total spread across 4 prefixes, this adds
// ~100-200ms to the bootstrap (one list round-trip per prefix, all
// fired in parallel).

const WORKER_HOST = 'loadout-discord.aquiloplays.workers.dev';

function makeUrl(path) {
  return `https://${WORKER_HOST}/asset/${path}.png`;
}

// One list-page-loop per prefix. Cap at 4 pages (4000 keys) which is
// well beyond any current asset roster.
async function listKeys(env, prefix) {
  const out = [];
  let cursor;
  for (let i = 0; i < 4; i++) {
    const page = await env.LOADOUT_BOLTS.list({ prefix, cursor });
    for (const k of (page.keys || [])) out.push(k.name);
    if (page.list_complete || !page.cursor) break;
    cursor = page.cursor;
  }
  return out;
}

function buildHeroMap(keys) {
  const out = {};
  for (const k of keys) {
    const classId = k.slice('pixel-art-hero:'.length);
    if (classId) out[classId] = makeUrl(`hero-art/${classId}`);
  }
  return out;
}

function buildGearMap(keys) {
  // keys: pixel-art-gear:<slot>:<slug>:<rarity>
  const out = {};
  for (const k of keys) {
    const parts = k.slice('pixel-art-gear:'.length).split(':');
    if (parts.length < 3) continue;
    const [slot, slug, rarity] = parts;
    if (!slot || !slug || !rarity) continue;
    if (!out[slot])             out[slot] = {};
    if (!out[slot][slug])       out[slot][slug] = {};
    out[slot][slug][rarity] = makeUrl(`gear-art/${slot}/${slug}/${rarity}`);
  }
  return out;
}

function buildClashMap(keys) {
  // keys come in two shapes:
  //   pixel-art-clash:buildings:<kind>:<level>
  //   pixel-art-clash:units:<id>
  const out = { buildings: {}, troops: {} };
  for (const k of keys) {
    const parts = k.slice('pixel-art-clash:'.length).split(':');
    if (parts[0] === 'buildings' && parts.length >= 3) {
      const [, kind, level] = parts;
      if (!kind || !level) continue;
      if (!out.buildings[kind]) out.buildings[kind] = {};
      out.buildings[kind][level] = makeUrl(`clash-art/buildings/${kind}/${level}`);
    } else if (parts[0] === 'units' && parts.length >= 2) {
      const id = parts[1];
      if (!id) continue;
      out.troops[id] = makeUrl(`clash-art/units/${id}`);
    }
  }
  return out;
}

function buildPetMap(keys) {
  const out = {};
  for (const k of keys) {
    const petId = k.slice('pixel-art-pet:'.length);
    if (petId) out[petId] = makeUrl(`pet-art/${petId}`);
  }
  return out;
}

// One call → four maps. Returns the object the bootstrap route can
// spread into its response.
export async function listAllPixelArtMaps(env) {
  const [heroKeys, gearKeys, clashKeys, petKeys] = await Promise.all([
    listKeys(env, 'pixel-art-hero:'),
    listKeys(env, 'pixel-art-gear:'),
    listKeys(env, 'pixel-art-clash:'),
    listKeys(env, 'pixel-art-pet:'),
  ]);
  return {
    globalHeroArt:  buildHeroMap(heroKeys),
    globalGearArt:  buildGearMap(gearKeys),
    globalClashArt: buildClashMap(clashKeys),
    globalPetArt:   buildPetMap(petKeys),
  };
}
