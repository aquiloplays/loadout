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

import { gearArtSlug, rarityTintHex } from './gear-art-slugs.js';

const WORKER_HOST = 'loadout-discord.aquiloplays.workers.dev';

const PHASE_A_LIVE   = 'A';
const PHASE_B_LIVE   = 'B';   // 2026-05-29 hair/eyes/facial sprites live
const PHASE_B_CHIP   = 'B';   // legacy alias; kept for any remaining stub paths
const PHASE_C_CHIP   = 'C';

function slugify(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Parse the "<slot>/<slug>" art stamp into the gearArtSlug shape, or null.
function parseArtStamp(art) {
  if (typeof art !== 'string') return null;
  const [slot, slug, extra] = art.split('/');
  if (!slot || !slug || extra) return null;
  return { slot, slug };
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

  // 2. Hair sprite (Phase B — LIVE 2026-05-29). KV key shape is
  // pixel-art-hero-hair:<sex>-<style>; site renders the alpha sprite
  // and tints via CSS filter using `tintHex` (no per-color sprite).
  layers.push({
    kind:    'hair',
    url:     `https://${WORKER_HOST}/asset/hero-hair/${sex}-${hairStyle}.png`,
    z:       30,
    phase:   PHASE_B_LIVE,
    meta:    { hairStyle, hairColor, sex },
    tintHex: hexForHairColor(hairColor),
  });

  // 3. Eyes — alpha-only sprite, color applied programmatically.
  // eyeStyle isn't on the data model (only eyeColor is); default to
  // `round` for everyone. Future iteration may add eyeStyle to the
  // customize UI.
  layers.push({
    kind:    'eyes',
    url:     `https://${WORKER_HOST}/asset/hero-eyes/round.png`,
    z:       20,
    phase:   PHASE_B_LIVE,
    meta:    { eyeColor },
    tintHex: hexForEyeColor(eyeColor),
  });

  // 4. Facial hair — male only. Skip for female; the facial value
  // is a no-op render-side for female characters.
  if (sex === 'male' && facial !== 'clean') {
    layers.push({
      kind:  'facial',
      url:   `https://${WORKER_HOST}/asset/hero-facial/${facial}.png`,
      z:     22,
      phase: PHASE_B_LIVE,
      meta:  { facial },
    });
  }

  // 5. Per-slot gear overlays (Phase 2 — LIVE). equipped[slot] stores a
  // bare bag-instance id (string); we resolve it against hero.bag to get
  // the item record, then map it to its worn-overlay ARCHETYPE via
  // gearArtSlug (item.art is the same value stamped at mint — preferred
  // when present, derived otherwise so legacy/lootbox bag items still
  // render). The overlay is rendered per-sex and the rarity sheen is a
  // CSS tint over the rarity-agnostic base (tintHex). The icon URL keeps
  // the per-item-name convention used by the inventory grid.
  const GEAR_SLOTS = ['weapon', 'head', 'chest', 'legs', 'boots', 'trinket', 'hands'];
  const bagIx = {};
  for (const it of (hero?.bag || [])) if (it && it.id) bagIx[it.id] = it;
  const baseZ = 40;
  for (const slot of GEAR_SLOTS) {
    const ref = equipped[slot];
    if (!ref) continue;
    const item = (typeof ref === 'string') ? bagIx[ref] : ref;
    if (!item) continue; // equipped id not in bag — skip cleanly
    const arch = parseArtStamp(item.art) || gearArtSlug(item);
    if (!arch) continue; // unrenderable (consumable, unknown slot)
    const rarity = String(item.rarity || 'common').toLowerCase();
    const nameSlug = slugify(item.name || '');
    layers.push({
      kind:    'gear',
      slot,
      itemId:  item.id || null,
      url:     `https://${WORKER_HOST}/asset/gear-art/${arch.slot}/${arch.slug}/${sex}-worn.png`,
      iconUrl: nameSlug ? `https://${WORKER_HOST}/asset/gear-art/${slot}/${nameSlug}/${rarity}.png` : null,
      z:       baseZ + GEAR_SLOTS.indexOf(slot),
      phase:   PHASE_C_CHIP,
      tintHex: rarityTintHex(rarity),
      meta:    { name: item.name, rarity, archetype: `${arch.slot}/${arch.slug}` },
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
