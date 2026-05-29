// Character composite render manifest.
//
// 2026-05-29 Phase A. The site renderer composites a hero out of
// stacked PNG layers — base body + hair + eyes + facial + per-slot
// gear-on-character overlays. This module emits the list of asset
// URLs to fetch for a given (look + equipped) state so the site
// renderer doesn't need to know the URL convention.
//
// Phase A layer set:
//   1. body — /asset/hero-art/<class>(-female)?.png   (Phase A live)
//   2. hair — /asset/hero-art/hair/<style>-<sex>.png   (Phase B — chip)
//   3. eyes — /asset/hero-art/eyes/<style>.png        (Phase B — chip)
//   4. facial — /asset/hero-art/facial/<style>.png    (male only, Phase B)
//   5. gear overlays — /asset/gear-art/<slot>/<slug>/<rarity>-worn.png
//                                                       (Phase C — chip)
//
// Phase A returns the base layer + stub URLs for B/C so the site can
// build the layered DIV with src tags that 404 cleanly until Phase
// B/C assets land. Each entry carries a `phase` hint so the site can
// skip/fall-back per layer.

const WORKER_HOST = 'loadout-discord.aquiloplays.workers.dev';

const PHASE_A_LIVE   = 'A';
const PHASE_B_CHIP   = 'B';
const PHASE_C_CHIP   = 'C';

function slugify(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Given the hero record, return the manifest the site renderer
// consumes. Tolerates partial / legacy hero records (defaults to male
// + clean if the new Phase A fields are missing).
export function buildCompositeManifest(hero) {
  const className = String(hero?.className || 'warrior').toLowerCase();
  const sex       = (hero?.custom?.sex === 'female') ? 'female' : 'male';
  const hairStyle = hero?.custom?.hairStyle || 'short-tousled';
  const hairColor = hero?.custom?.hairColor || 'brown';
  const eyeColor  = hero?.custom?.eyeColor  || 'brown';
  const skinTone  = hero?.custom?.skinTone  || 'fair';
  const facial    = hero?.custom?.facial    || 'clean';
  const equipped  = hero?.equipped || {};

  const layers = [];

  // 1. Base body — class + sex. Phase A: live URL for both sexes.
  const bodyClassPart = sex === 'female' ? `${className}-female` : className;
  layers.push({
    kind:    'body',
    url:     `https://${WORKER_HOST}/asset/hero-art/${bodyClassPart}.png`,
    z:       0,
    phase:   PHASE_A_LIVE,
    meta:    { className, sex, skinTone },
  });

  // 2. Hair sprite. Phase B URL pattern — the asset isn't generated
  // yet so the renderer will 404 until the chip lands. Color is
  // applied via CSS filter on the site side (no per-color sprite).
  layers.push({
    kind:    'hair',
    url:     `https://${WORKER_HOST}/asset/hero-art/hair/${hairStyle}-${sex}.png`,
    z:       30,
    phase:   PHASE_B_CHIP,
    meta:    { hairStyle, hairColor, sex },
    tintHex: hexForHairColor(hairColor),
  });

  // 3. Eyes — alpha-only sprite, color applied programmatically.
  layers.push({
    kind:    'eyes',
    url:     `https://${WORKER_HOST}/asset/hero-art/eyes/round.png`,
    z:       20,
    phase:   PHASE_B_CHIP,
    meta:    { eyeColor },
    tintHex: hexForEyeColor(eyeColor),
  });

  // 4. Facial hair — male only. Skip for female; female char's facial
  // value is a no-op render-side.
  if (sex === 'male' && facial !== 'clean') {
    layers.push({
      kind:  'facial',
      url:   `https://${WORKER_HOST}/asset/hero-art/facial/${facial}.png`,
      z:     22,
      phase: PHASE_B_CHIP,
      meta:  { facial },
    });
  }

  // 5. Per-slot gear overlays. The slot list mirrors SHOP_POOL slots
  // (weapon, head, chest, legs, boots, trinket). Each equipped item
  // has an itemId; the site reaches into the player's bag to read the
  // (slot, name, rarity) for that id. For URL construction we use the
  // item record passed inline on equipped[slot] if present (modern
  // shape) else just emit the bare slot for the site to resolve.
  const GEAR_SLOTS = ['weapon', 'head', 'chest', 'legs', 'boots', 'trinket', 'hands'];
  const baseZ = 40;
  for (const slot of GEAR_SLOTS) {
    const item = equipped[slot];
    if (!item) continue;
    if (typeof item === 'string') {
      // Bare item id; site resolves the slug/rarity client-side.
      layers.push({
        kind:    'gear',
        slot,
        itemId:  item,
        url:     null,
        z:       baseZ + GEAR_SLOTS.indexOf(slot),
        phase:   PHASE_C_CHIP,
      });
      continue;
    }
    const slug   = slugify(item.name || '');
    const rarity = String(item.rarity || 'common').toLowerCase();
    layers.push({
      kind:    'gear',
      slot,
      itemId:  item.id || null,
      url:     `https://${WORKER_HOST}/asset/gear-art/${slot}/${slug}/${rarity}-worn.png`,
      iconUrl: `https://${WORKER_HOST}/asset/gear-art/${slot}/${slug}/${rarity}.png`,
      z:       baseZ + GEAR_SLOTS.indexOf(slot),
      phase:   PHASE_C_CHIP,
      meta:    { name: item.name, rarity },
    });
  }

  return {
    sex, className,
    layers,
    look: {
      hair:   { style: hairStyle, color: hairColor },
      eyes:   { style: 'round',   color: eyeColor },
      skin:   skinTone,
      facial,
    },
    equipped,
  };
}

// Coarse hair-color lookup so the site renderer doesn't have to ship
// the palette. Values are CSS-safe hex used as a tint on the alpha
// hair sprite (Phase B asset).
function hexForHairColor(name) {
  return ({
    brown:'#6b4423', black:'#1a1a1a', blonde:'#e9c97b',
    red:'#a8362c',   grey:'#888899',  white:'#f0f0f0',
    violet:'#7c5cff',teal:'#3fb8a6',  pink:'#ff6ab5',
    mint:'#9ee7c8',  silver:'#c0c0d0',copper:'#b87333',
    navy:'#1f2a55',  forest:'#2f5d3a',
  }[name] || '#6b4423');
}
function hexForEyeColor(name) {
  return ({
    brown:'#5b3320', blue:'#3a8fd9', green:'#4fb46d', hazel:'#a07a36',
    amber:'#c97834', violet:'#7c5cff', silver:'#c0c0d0', pink:'#ff6ab5',
  }[name] || '#5b3320');
}
