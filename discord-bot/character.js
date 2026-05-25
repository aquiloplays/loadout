// Character system — paper-doll render endpoint + sprite lookup +
// /character slash command dispatch.
//
// One source of truth for "given a hero + their pet, return the
// pixel-art PNG that surfaces everywhere" (Discord embeds, Twitch
// panel, web profile, dungeon overlay). See CHARACTER-SYSTEM-DESIGN.md.
//
// The compositor here is *thin*: it asks png-codec for layer decode
// + paint, then encodes the result. Sprite assets live on the Pages
// site (aquilo-gg/sprites/*); we fetch them by URL and cache the
// decoded layers in module scope for the lifetime of the Worker
// isolate (a few minutes typically).

import { decodePng, encodePng, compose, paletteSwap } from './png-codec.js';
import {
  loadHero,
  CHARACTER_LOOK_OPTIONS,
  applyLookBackfill,
  CLASSES,
  STARTER_GEAR,
  applyClassSelection,
} from './dungeon.js';
import { getPet, computeMood } from './pet.js';
import { getWallet, spend, earn } from './wallet.js';

// Reset price — pay this many Bolts to unlock a locked character so
// the player can re-pick class + customisation.
export const CHARACTER_RESET_COST = 5000;

// ── Sprite source URL ────────────────────────────────────────────
//
// Sprites are committed at aquilo-gg/sprites/ and vendored into the
// aquilo-site repo's public/sprites/ folder, served by Cloudflare
// Pages at https://aquilo.gg/sprites/...
//
// The widget.aquilo.gg mirror was the original plan but the Pages
// project for that hostname never got created — until/unless it does,
// the canonical source is aquilo.gg directly. Override via the
// SPRITE_BASE_URL env var if you want to test against a different
// origin (e.g. a Pages preview deploy).
function spriteBase(env) {
  return (env && env.SPRITE_BASE_URL) || 'https://aquilo.gg/sprites';
}

// In-memory cache. Decoded layers stay in this map until the Worker
// isolate cycles. Keys are URLs; values are decoded image objects
// `{ width, height, pixels }`. ~20 KB per 64×80 sprite — ~10 MB for
// the full 500-sprite roster, well under the 128 MB isolate budget.
const SPRITE_CACHE = new Map();

// Asset version stamp. Appended as a query string to every sprite
// fetch so we can bypass the Cloudflare Pages edge cache (and the
// Worker's in-memory SPRITE_CACHE, which keys on the full URL) when
// a new generator pass ships. Also baked into renderPreviewUrl so
// the *composed* /character/render URL changes too — that busts the
// downstream layer (Discord embed URL cache, browser <img> cache,
// any CDN that fronts the worker). The aquilo-site repo still has
// to be manually re-vendored from aquilo-gg/sprites/ for the new
// files to exist on the Pages origin — this version stamp only
// handles caches once they're up.
//
// Bump history:
//   v2-rpg      I1 (2026-05) — retro-RPG body sprite rework
//   v3-figure   L1 (2026-05) — game-icon figure rework + characterful
//                              pets + retuned gear paper-doll anchors
//   v4-figure   L2 (2026-05) — deep figure rework after Clay flagged
//                              v3 as still janky: continuous-flow arms
//                              with bicep bulge (no segmented joints),
//                              wider neck with trapezius shading,
//                              torso with pectoral/waist/hip
//                              construction, legs with knee+calf flow,
//                              bigger hand circles, peasant tunic with
//                              full garment construction (collar,
//                              sleeve caps, cinched waist, A-line hem,
//                              fold lines), redesigned robe shape with
//                              sleeve openings/sash/skirt-folds (no
//                              longer a plain cone), redesigned hood
//                              that drapes around the face instead of
//                              sealing it shut.
//   v5-figure   L3 (2026-05) — full proportion + form rebuild after
//                              Clay flagged L2 as still bottom-heavy
//                              with a head pasted on. New deliberate
//                              4-heads-tall ratio (HEAD_R 28→18,
//                              SHOULDER_Y 80→58, longer torso + legs),
//                              tapering arms with bicep bulge held
//                              away from torso with a visible gap
//                              (no more body bulges, no more
//                              segmented joints), cel-shaded flat
//                              fills replacing balloon radial
//                              gradients (defined light-side /
//                              shadow-side / form lines), robe rebuilt
//                              as a clean A-line (narrow shoulders →
//                              wide hem, no mid-bulge) with separate
//                              sleeve drape masses, wizard-long hair
//                              cut down from a chest-covering curtain
//                              to slim side strands, default tunic
//                              with visible short sleeves so it reads
//                              as a tunic not a tank top.
//   v6-arms     L3+ (2026-05) — targeted ARMS-only fix after Clay
//                              flagged L3 arms as over-corrected:
//                              too long (hanging to mid-thigh), too
//                              bulky at shoulder, dramatic carrot
//                              taper, splayed away from torso, tiny
//                              ball hands. Now slim near-vertical
//                              limbs: HAND_Y 116→108 (hip level),
//                              HAND_OFFSET_X 26→22 (close to body),
//                              ARM_GAP 3→1, armShoulderW 11→7,
//                              armWristW 4→5 (gentler taper, ~75 %
//                              not ~35 %), HAND_R 7→5 (proportional
//                              to wrist, ~50 % wider). Removed the
//                              bicep bulge Bezier — arms run nearly
//                              straight with subtle taper.
//   v7-polish   L4 (2026-05) — polish pass: more expressive eyes
//                              (full iris + inner ring + double
//                              gloss + lower lid line), friendly
//                              mouth with corner upturns + lower-lip
//                              hint, lighter+arched brows, mitt-shape
//                              hands with thumb bump on the inner
//                              side, smoothed arms (no shoulder Q
//                              bow), armpit AO + arm form highlights
//                              (light side / shadow side), tidier
//                              curly-afro silhouette that sits on
//                              the head rather than floating above.
//   v8-layers   L5 (2026-05) — layering framework fix after Clay
//                              flagged the composite as "stacked
//                              stickers" with legs in front of tunic
//                              and weapons floating beside hands:
//                              split default-clothing into separate
//                              trousers (z=22, painted over by leg
//                              gear) + tunic (z=33, skirt covers
//                              the TOP of leg gear); weapon anchor
//                              re-aligned to the right hand
//                              (cx=86, cy=108) so the icon center
//                              lands on the palm; new hand-overlay
//                              layer at z=79 re-paints the hand on
//                              top of the weapon so the figure
//                              visibly grips it. Framework remains
//                              fully generic — every gear item in
//                              every slot composes on any body type.
const SPRITE_ASSET_VERSION = 'v8-layers';

// Canvas size — pixel-perfect compose, all layers share these dims.
// Glossy bar (2026-05 art campaign, see tools/build-character-glossy.mjs
// + tools/glossy-art-kit.mjs) replaces the retired 64×80 pixel
// pipeline with an HD 128×160 figure canvas. Every layer the
// resolver returns is baked at this size (body, hair, eyes,
// accent, default-clothing, gear figure-layers) so png-codec's
// compose() can stack them without the dimension-mismatch throw.
const SPRITE_W = 128;
const SPRITE_H = 160;

async function fetchSprite(env, relPath) {
  const baseUrl = spriteBase(env) + '/' + relPath.replace(/^\/+/, '');
  // Asset-version stamp busts Pages' edge cache when generator output
  // changes. The Worker's in-memory cache key includes the version
  // too so a deploy bumps the in-isolate decode cache automatically.
  const url = baseUrl + '?av=' + encodeURIComponent(SPRITE_ASSET_VERSION);
  if (SPRITE_CACHE.has(url)) return SPRITE_CACHE.get(url);
  // 5-min CF cache (was 1h) — once the aquilo-site mirror updates,
  // a stale layer cycles within minutes instead of an hour.
  const res = await fetch(url, { cf: { cacheTtl: 300 } });
  if (!res.ok) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  let decoded;
  try { decoded = await decodePng(buf); }
  catch (e) { console.warn('[character] decode failed for', url, e.message); return null; }
  SPRITE_CACHE.set(url, decoded);
  return decoded;
}

// ── Layer resolution from a hero record ──────────────────────────
//
// Walks the look + equipped slots and returns an ordered list of
// `{ relPath, paletteMap? }` entries that the compositor fetches +
// composes back-to-front.
//
// Z-ORDER (L5 — fixed so the figure reads as ONE character, not
// stacked stickers). Each slot describes WHY that index, not just
// what:
//
//   z=10 back-trinket    cape/cloak/wings drape behind the body
//   z=15 pet             companion lower-right, behind the body
//   z=20 body            figure base (skin: torso + arms + legs)
//   z=22 default-trousers   bare-legs cover; leg gear paints over
//   z=30 legs gear       tassets / pants / greaves — covers trousers
//   z=33 default-tunic   tunic skirt covers TOP of legs gear so the
//                        skirt visibly drapes over the legs (FIX for
//                        Clay's "legs render in front of tunic" bug);
//                        chest gear later still covers the bodice
//   z=35 boots           on top of trouser/leg-gear bottom
//   z=40 chest           cuirass / robe / coat covers tunic bodice
//   z=45 front-trinket   amulet / pendant over chest
//   z=60 hair            on top of head
//   z=65 face overlay    eyes + accent on the head
//   z=70 head gear       helmet / hood — covers hair
//   z=78 weapon          painted BEFORE the hand-overlay so the
//                        hand visibly grips the weapon at z=79
//   z=79 hand-overlay    re-paints the right hand on top of the
//                        weapon grip — "held in hand", not "next to"
//   z=90 fx              legendary glow particles on top
//
// Slots without a sprite are skipped — no placeholder. The body
// always renders; everything else is optional.
async function resolveLayers(env, hero, pet, opts) {
  const layers = [];
  const eq = hero.equipped || {};
  const inv = Object.fromEntries((hero.bag || []).map(it => [it.id, it]));

  // Slug derived from the item name (used inside the safeId
  // builder). Mirrors the slugify in tools/build-gear-glossy.mjs so
  // runtime path matches the on-disk filename.
  function nameSlug(s) {
    return String(s || '').toLowerCase()
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
  // Glossy gear filename pattern: <slot>-<rarity>-<snake-name>.
  // Items in the bag carry slot + rarity + name already; if a
  // catalogue row has an explicit spriteId we honour that (it
  // overrides the pattern — used by tests + future curated drops).
  function gearSafeId(it) {
    if (!it) return null;
    if (it.spriteId) return it.spriteId;
    const slug = nameSlug(it.name);
    if (!slug) return null;
    return `${it.slot}-${it.rarity}-${slug}`;
  }
  const itemSlot = (slot) => inv[eq[slot]];

  // z=10 — back accessory (trinket flagged with back-cape semantics)
  const trinket = itemSlot('trinket');
  const trinketSafe = gearSafeId(trinket);
  const isBackTrinket = trinketSafe && /(^|-)(cape|cloak|wings?|mantle|drape|veil|feather)(-|$)/.test(trinketSafe);
  if (trinketSafe && isBackTrinket) {
    layers.push({ rel: `gear/figure/trinket/${trinketSafe}.png` });
  }

  // z=15 — pet (cosmetic companion, lower-right of the figure
  // canvas beside the hero). Glossy 128×160 PNGs at
  // pet/glossy/<species>-<colour>.png; mood overlay at
  // pet/glossy/mood-<hint>.png floats above the pet head.
  // Marked optional so missing assets (mid-vendor) degrade.
  if (pet && !opts.nopet) {
    layers.push({ rel: `pet/glossy/${pet.species}-${pet.colour}.png`, optional: true });
    const mood = computeMood(pet);
    if (mood?.hint) layers.push({ rel: `pet/glossy/mood-${mood.hint}.png`, optional: true });
  }

  // z=20 — body (glossy 128×160)
  layers.push({ rel: `figure/glossy/body-${hero.custom.bodyType || 'slim'}-${hero.custom.skinTone || 'fair'}.png` });

  // z=22 — DEFAULT TROUSERS. Bare-legs cover; gets painted over by
  // leg gear (z=30) when equipped. Optional so an older mirror that
  // only has the legacy default-clothing.png still composes.
  layers.push({ rel: 'figure/glossy/default-trousers.png', optional: true });

  // z=30 — legs gear (paints over default trousers)
  {
    const it = itemSlot('legs');
    const sid = gearSafeId(it);
    if (sid) layers.push({ rel: `gear/figure/legs/${sid}.png` });
  }

  // z=33 — DEFAULT TUNIC (bodice + sleeves + belt + skirt). Drawn
  // AFTER leg gear so the tunic SKIRT visibly covers the top of any
  // equipped leg gear. Chest gear (z=40) still covers the bodice.
  // Optional so a stale mirror falls through to the legacy single
  // default-clothing.png at z=25.
  layers.push({ rel: 'figure/glossy/default-tunic.png', optional: true });

  // z=35 — boots
  {
    const it = itemSlot('boots');
    const sid = gearSafeId(it);
    if (sid) layers.push({ rel: `gear/figure/boots/${sid}.png` });
  }

  // z=40 — chest gear (cuirass / robe / coat). Painted over the
  // tunic bodice; leaves the skirt at z=33 visible below.
  {
    const it = itemSlot('chest');
    const sid = gearSafeId(it);
    if (sid) layers.push({ rel: `gear/figure/chest/${sid}.png` });
  }

  // z=45 — front trinket (non-back)
  if (trinketSafe && !isBackTrinket) {
    layers.push({ rel: `gear/figure/trinket/${trinketSafe}.png` });
  }

  // z=60 — hair. Glossy ships per-(style,colour) variants —
  // gradient fills don't survive paletteSwap cleanly, so we bake
  // the colour into the file instead of swapping at render time.
  if (hero.custom.hairStyle && hero.custom.hairStyle !== 'bald') {
    layers.push({
      rel: `figure/glossy/hair-${hero.custom.hairStyle}-${hero.custom.hairColor || 'brown'}.png`,
    });
  }

  // z=65 — face overlay (eye colour + accent)
  if (hero.custom.eyeColor) {
    layers.push({ rel: `figure/glossy/eyes-${hero.custom.eyeColor}.png` });
  }
  if (hero.custom.accent && hero.custom.accent !== 'none') {
    layers.push({ rel: `figure/glossy/accent-${hero.custom.accent}.png` });
  }

  // z=70 — head gear (over hair)
  const head = itemSlot('head');
  const headSafe = gearSafeId(head);
  if (headSafe) layers.push({ rel: `gear/figure/head/${headSafe}.png` });

  // z=78 — weapon, painted BEFORE the hand-overlay so the hand
  // appears to grip the weapon (not float beside it).
  const weapon = itemSlot('weapon');
  const weaponSafe = gearSafeId(weapon);
  if (weaponSafe) layers.push({ rel: `gear/figure/weapon/${weaponSafe}.png` });

  // z=79 — HAND OVERLAY. Re-paints the right hand on top of the
  // weapon so the figure visibly grips the weapon. Skin-tone matches
  // the body. Optional — when the mirror is mid-vendor and the
  // hand-overlay PNG doesn't exist yet, weapon still renders fine.
  if (weaponSafe) {
    layers.push({
      rel: `figure/glossy/hand-overlay-${hero.custom.skinTone || 'fair'}.png`,
      optional: true,
    });
  }

  // z=90 — fx (legendary halo overlays). One per-slot halo at
  // gear/figure/fx/<slot>.png, painted ABOVE the equipped gear so
  // the glow reads as overlay magic. Dedup'd by slot so a hero
  // wearing two legendaries in the same slot (impossible) doesn't
  // double-paint. Optional so the absence of a halo file silently
  // skips instead of crashing.
  const fxSlotsSeen = new Set();
  for (const slot of ['weapon', 'chest', 'head', 'trinket', 'legs', 'boots']) {
    const it = itemSlot(slot);
    if (it?.rarity === 'legendary' && !fxSlotsSeen.has(slot)) {
      fxSlotsSeen.add(slot);
      layers.push({ rel: `gear/figure/fx/${slot}.png`, optional: true });
    }
  }

  return layers;
}

// Build a single-shot palette map for hair palette swap.
// Hair sprites are authored at the "brown" reference palette
// (matches build-sprites.ps1 $HAIR_COLOURS.brown).
//
// HD bar (Phase-4) hair uses 5 tone steps — deep / shadow / base /
// high / top — to support proper upper-left-light shading on the
// larger 64×80 canvas. Old 3-tone sprites no longer ship; if you
// ever resurrect them, just leave the deep/top entries unmatched
// (paletteSwap silently skips pixels that don't match any from).
const HAIR_REF = {
  deep:   [0x22, 0x12, 0x0b],
  shadow: [0x3b, 0x25, 0x1a],
  base:   [0x5a, 0x3a, 0x26],
  high:   [0x7a, 0x52, 0x36],
  top:    [0xa0, 0x72, 0x48],
};
const HAIR_COLOURS_RGB = {
  brown:  HAIR_REF,
  black:  { deep:[0x08,0x08,0x0a], shadow:[0x16,0x16,0x18], base:[0x2a,0x2a,0x30], high:[0x42,0x42,0x4a], top:[0x5a,0x5b,0x66] },
  blonde: { deep:[0x6c,0x4e,0x10], shadow:[0xa3,0x7a,0x30], base:[0xd4,0xa6,0x4a], high:[0xf4,0xd2,0x7a], top:[0xff,0xf0,0xb8] },
  red:    { deep:[0x4a,0x10,0x0a], shadow:[0x7a,0x20,0x18], base:[0xb5,0x34,0x20], high:[0xd8,0x55,0x3a], top:[0xf0,0x80,0x60] },
  grey:   { deep:[0x3e,0x42,0x4a], shadow:[0x5f,0x63,0x6c], base:[0x87,0x8b,0x95], high:[0xb3,0xb8,0xc2], top:[0xd2,0xd6,0xde] },
  white:  { deep:[0xa4,0xa8,0xb2], shadow:[0xc8,0xcc,0xd6], base:[0xe6,0xe9,0xef], high:[0xff,0xff,0xff], top:[0xff,0xff,0xff] },
  violet: { deep:[0x3a,0x28,0x80], shadow:[0x5a,0x40,0xb0], base:[0x7c,0x5c,0xff], high:[0xa8,0x90,0xff], top:[0xcd,0xb8,0xff] },
  teal:   { deep:[0x1a,0x5a,0x4a], shadow:[0x2f,0x8a,0x78], base:[0x5f,0xc4,0xa8], high:[0x92,0xe6,0xcd], top:[0xbd,0xf5,0xe0] },
  pink:   { deep:[0x85,0x20,0x48], shadow:[0xc1,0x46,0x88], base:[0xe8,0x7a,0xb0], high:[0xff,0xab,0xcf], top:[0xff,0xd0,0xe2] },
  mint:   { deep:[0x22,0x78,0x4a], shadow:[0x3d,0xa7,0x6c], base:[0x5b,0xe0,0x98], high:[0x90,0xff,0xc4], top:[0xc4,0xff,0xe0] },
  silver: { deep:[0x52,0x58,0x68], shadow:[0x7a,0x80,0x90], base:[0xa8,0xaf,0xbc], high:[0xd4,0xd8,0xe0], top:[0xee,0xf0,0xf5] },
  copper: { deep:[0x68,0x26,0x0a], shadow:[0x9c,0x4a,0x1f], base:[0xcf,0x72,0x40], high:[0xf0,0x98,0x66], top:[0xff,0xb8,0x8a] },
  navy:   { deep:[0x0a,0x12,0x30], shadow:[0x17,0x20,0x46], base:[0x29,0x3a,0x78], high:[0x3e,0x53,0x9c], top:[0x5a,0x72,0xc0] },
  forest: { deep:[0x0a,0x24,0x10], shadow:[0x1a,0x3a,0x20], base:[0x2e,0x5c,0x34], high:[0x4b,0x85,0x50], top:[0x74,0xa8,0x78] },
};
function hairPaletteMap(colourKey) {
  const target = HAIR_COLOURS_RGB[colourKey] || HAIR_COLOURS_RGB.brown;
  return [
    { from: HAIR_REF.deep,   to: target.deep   },
    { from: HAIR_REF.shadow, to: target.shadow },
    { from: HAIR_REF.base,   to: target.base   },
    { from: HAIR_REF.high,   to: target.high   },
    { from: HAIR_REF.top,    to: target.top    },
  ];
}

// ── The render endpoint ─────────────────────────────────────────
//
// GET /character/render/<guildId>/<userId>.png
//   Public read. ETag tied to lookVersion + equipped-set hash so
//   Discord caches behave. ~5 ms cold render, ~1 ms warm.
//
// ?nopet=1 suppresses the pet layer (used by Clash raid replays
//          and other contexts that need a pet-free figure).
// ?v=<N>  cache-buster pinned to hero.lookVersion by callers.
export async function handleCharacterRender(req, env, path) {
  // Path shape: /character/render/<guildId>/<userId>.png
  const m = path.match(/^\/character\/render\/(\d{5,25})\/(\d{5,25})\.png$/);
  if (!m) return new Response('not-found', { status: 404 });
  const guildId = m[1], userId = m[2];

  const url = new URL(req.url);
  const opts = { nopet: url.searchParams.get('nopet') === '1' };

  const hero = applyLookBackfill(await loadHero(env, guildId, userId), userId);
  const pet = await getPet(env, guildId, userId);

  // Query-string look override.
  //
  // Without this the preview can only show the LAST-SAVED look — the
  // /play character editor would have to save after every pick to see
  // a change. We let each axis be overridden via ?bodyType=, ?skinTone=,
  // ... and apply them in-memory before resolveLayers. Each axis is
  // validated against CHARACTER_LOOK_OPTIONS; unknown values are
  // silently ignored so the URL is always renderable (returning a 4xx
  // here would break the live preview's <img> in flight).
  //
  // Caller is responsible for cache-busting (?v= already changes when
  // any axis flips — we don't enforce that, but the site pins it).
  const lookKeys = ['bodyType', 'skinTone', 'hairStyle', 'hairColor', 'eyeColor', 'accent'];
  let looksOverridden = false;
  for (const k of lookKeys) {
    const v = url.searchParams.get(k);
    if (v != null && CHARACTER_LOOK_OPTIONS[k] && CHARACTER_LOOK_OPTIONS[k].includes(v)) {
      hero.custom = hero.custom || {};
      hero.custom[k] = v;
      looksOverridden = true;
    }
  }

  const layerSpecs = await resolveLayers(env, hero, pet, opts);
  // Seed a canvas-dim transparent layer FIRST so png-codec compose's
  // "take dims from layers[0]" can't be hijacked by a rogue layer
  // (e.g. a vendor-mid asset still at legacy 64×80) — the seed
  // pins the output to SPRITE_W × SPRITE_H and the resilient
  // compositor silently drops anything else that doesn't match.
  const layers = [blank(SPRITE_W, SPRITE_H)];
  for (const spec of layerSpecs) {
    const img = await fetchSprite(env, spec.rel);
    if (!img) {
      if (spec.optional) continue;
      // Missing required layer. Substitute a blank so the pipeline
      // emits a PNG even mid-vendor. Should never happen post-flip;
      // if it does, the absence is visible and easy to spot.
      layers.push(blank(SPRITE_W, SPRITE_H));
      continue;
    }
    if (spec.paletteFor === 'hair') {
      // Defensive — paletteSwap requires matching pixel layout; if
      // the layer has unexpected dims (vendor accident) we let the
      // compositor's resilience handle the skip.
      try { layers.push(paletteSwap(img, hairPaletteMap(spec.colourKey))); }
      catch (e) { console.warn('[character] paletteSwap failed:', e && e.message); layers.push(img); }
    } else {
      layers.push(img);
    }
  }

  const composed = compose(layers);
  const png = await encodePng(composed);

  return new Response(png, {
    status: 200,
    headers: {
      'content-type': 'image/png',
      // Cache-bust via ?v= bumped on lookVersion / equipped change.
      'cache-control': 'public, max-age=300, must-revalidate',
      'access-control-allow-origin': '*',
    },
  });
}

function blank(width, height) {
  return { width, height, pixels: new Uint8Array(width * height * 4) };
}

// ── /character slash command — Discord ephemeral editor ──────────
//
// Five select-menus + Save / Random / Cancel buttons + a live
// preview embed image. The preview is just the render endpoint URL
// with ?v=<lookVersion> bumped per save; Discord re-fetches when
// the URL changes.

const COMPONENT_ACTION_ROW = 1;
const COMPONENT_SELECT     = 3;
const COMPONENT_BUTTON     = 2;
const STYLE_PRIMARY        = 1;
const STYLE_SECONDARY      = 2;
const STYLE_SUCCESS        = 3;
const RESP_CHAT            = 4;
const RESP_UPDATE          = 7;
const FLAG_EPHEMERAL       = 64;

function ephemeral(content, components = []) {
  return { type: RESP_CHAT, data: { content, flags: FLAG_EPHEMERAL, components } };
}

function renderPreviewUrl(env, guildId, userId, version) {
  const base = (env && env.PUBLIC_WORKER_URL) || 'https://loadout-discord.aquiloplays.workers.dev';
  // ?v=<lookVersion> bumps when the player edits their look; &av=
  // <SPRITE_ASSET_VERSION> bumps when the art pipeline ships a new
  // pass. Either changing forces every downstream cache (Discord
  // embed, browser <img>, edge CDN) to see a new URL and refetch.
  const av = encodeURIComponent(SPRITE_ASSET_VERSION);
  return `${base}/character/render/${guildId}/${userId}.png?v=${version || 0}&av=${av}`;
}

// Build the editor message — selects + preview + buttons.
async function buildEditor(env, guildId, userId) {
  const hero = applyLookBackfill(await loadHero(env, guildId, userId), userId);
  const look = hero.custom;
  const preview = renderPreviewUrl(env, guildId, userId, hero.lookVersion || 0);
  const selectRow = (id, placeholder, options, selectedValue) => ({
    type: COMPONENT_ACTION_ROW,
    components: [{
      type: COMPONENT_SELECT,
      custom_id: id,
      placeholder,
      options: options.slice(0, 25).map(v => ({
        label: v.replace(/[_-]/g, ' '),
        value: v,
        default: v === selectedValue,
      })),
    }],
  });

  return {
    embeds: [{
      title: '👤 Character editor',
      description: 'Pick your look. **Save** persists it; **Random** rolls a fresh look; **Cancel** keeps the previous save.',
      image: { url: preview },
      color: 0x7c5cff,
    }],
    components: [
      selectRow('character:set:bodyType',  'Body type',  CHARACTER_LOOK_OPTIONS.bodyType,  look.bodyType),
      selectRow('character:set:skinTone',  'Skin tone',  CHARACTER_LOOK_OPTIONS.skinTone,  look.skinTone),
      selectRow('character:set:hairStyle', 'Hair style', CHARACTER_LOOK_OPTIONS.hairStyle, look.hairStyle),
      selectRow('character:set:hairColor', 'Hair colour', CHARACTER_LOOK_OPTIONS.hairColor, look.hairColor),
      {
        type: COMPONENT_ACTION_ROW,
        components: [
          { type: COMPONENT_BUTTON, style: STYLE_SECONDARY, label: '🎨 Random', custom_id: 'character:random' },
          { type: COMPONENT_BUTTON, style: STYLE_SUCCESS,   label: '💾 Save',   custom_id: 'character:save' },
          { type: COMPONENT_BUTTON, style: STYLE_PRIMARY,   label: '👁 Eyes/accent…', custom_id: 'character:eyes' },
        ],
      },
    ],
    flags: FLAG_EPHEMERAL,
  };
}

// Discord slash command entry. Imported from commands.js.
export async function handleCharacterCommand(env, data) {
  const guildId = data.guild_id;
  const userId = data?.member?.user?.id || data?.user?.id;
  if (!guildId || !userId) return ephemeral('Run this in a server.');
  return { type: RESP_CHAT, data: await buildEditor(env, guildId, userId) };
}

// Discord component handler — routes all `character:*` custom_ids.
export async function handleCharacterComponent(env, data) {
  const cid = data.data?.custom_id || '';
  const guildId = data.guild_id;
  const userId = data?.member?.user?.id || data?.user?.id;
  if (!guildId || !userId) return ephemeral('Run this in a server.');

  // Selects: character:set:<axis>  → update hero.custom[axis] → re-render
  if (cid.startsWith('character:set:')) {
    const axis = cid.slice('character:set:'.length);
    const value = data.data?.values?.[0];
    if (!CHARACTER_LOOK_OPTIONS[axis] || !CHARACTER_LOOK_OPTIONS[axis].includes(value)) {
      return ephemeral('Bad option.');
    }
    await updateLookField(env, guildId, userId, axis, value, /*bumpVersion=*/true);
    return { type: RESP_UPDATE, data: await buildEditor(env, guildId, userId) };
  }
  if (cid === 'character:random') {
    await randomiseLook(env, guildId, userId);
    return { type: RESP_UPDATE, data: await buildEditor(env, guildId, userId) };
  }
  if (cid === 'character:save') {
    // No-op — every select already saved + bumped lookVersion.
    return ephemeral('💾 Saved.');
  }
  if (cid === 'character:eyes') {
    // Second pass UI: eyes + accent in their own ephemeral.
    return { type: RESP_UPDATE, data: await buildEyesEditor(env, guildId, userId) };
  }
  if (cid.startsWith('character:eye:')) {
    const value = data.data?.values?.[0];
    await updateLookField(env, guildId, userId, 'eyeColor', value, true);
    return { type: RESP_UPDATE, data: await buildEyesEditor(env, guildId, userId) };
  }
  if (cid.startsWith('character:accent:')) {
    const value = data.data?.values?.[0];
    await updateLookField(env, guildId, userId, 'accent', value, true);
    return { type: RESP_UPDATE, data: await buildEyesEditor(env, guildId, userId) };
  }
  if (cid === 'character:back') {
    return { type: RESP_UPDATE, data: await buildEditor(env, guildId, userId) };
  }
  return ephemeral('Unknown character action.');
}

async function buildEyesEditor(env, guildId, userId) {
  const hero = applyLookBackfill(await loadHero(env, guildId, userId), userId);
  const look = hero.custom;
  const preview = renderPreviewUrl(env, guildId, userId, hero.lookVersion || 0);
  return {
    embeds: [{
      title: '👁 Eyes + accent',
      description: 'Fine-tune your face.',
      image: { url: preview },
      color: 0x7c5cff,
    }],
    components: [
      {
        type: COMPONENT_ACTION_ROW,
        components: [{
          type: COMPONENT_SELECT,
          custom_id: 'character:eye:set',
          placeholder: 'Eye colour',
          options: CHARACTER_LOOK_OPTIONS.eyeColor.map(v => ({
            label: v, value: v, default: v === look.eyeColor,
          })),
        }],
      },
      {
        type: COMPONENT_ACTION_ROW,
        components: [{
          type: COMPONENT_SELECT,
          custom_id: 'character:accent:set',
          placeholder: 'Accent',
          options: CHARACTER_LOOK_OPTIONS.accent.map(v => ({
            label: v.replace(/-/g, ' '), value: v, default: v === look.accent,
          })),
        }],
      },
      {
        type: COMPONENT_ACTION_ROW,
        components: [
          { type: COMPONENT_BUTTON, style: STYLE_SECONDARY, label: '◀ Back', custom_id: 'character:back' },
        ],
      },
    ],
    flags: FLAG_EPHEMERAL,
  };
}

// Persistence helpers — write through to the existing hero record.
// We load via the same shared loader to inherit the DLL-merge so
// editing a look doesn't accidentally wipe DLL-canonical stats.
async function updateLookField(env, guildId, userId, field, value, bumpVersion) {
  const hero = applyLookBackfill(await loadHero(env, guildId, userId), userId);
  hero.custom = hero.custom || {};
  hero.custom[field] = value;
  if (bumpVersion) hero.lookVersion = (hero.lookVersion || 0) + 1;
  // Save under the same key the existing loader writes to.
  hero.lastUpdatedUtc = new Date().toISOString();
  await env.LOADOUT_BOLTS.put(`d:hero:${guildId}:${userId}`, JSON.stringify(hero));
  return hero;
}

async function randomiseLook(env, guildId, userId) {
  const hero = applyLookBackfill(await loadHero(env, guildId, userId), userId);
  hero.custom = hero.custom || {};
  for (const axis of ['bodyType', 'skinTone', 'hairStyle', 'hairColor', 'eyeColor', 'accent']) {
    const opts = CHARACTER_LOOK_OPTIONS[axis];
    hero.custom[axis] = opts[Math.floor(Math.random() * opts.length)];
  }
  hero.lookVersion = (hero.lookVersion || 0) + 1;
  hero.lastUpdatedUtc = new Date().toISOString();
  await env.LOADOUT_BOLTS.put(`d:hero:${guildId}:${userId}`, JSON.stringify(hero));
  return hero;
}

// ── Web RPC helpers ───────────────────────────────────────────────
//
// Read + save the look block for the aquilo.gg /character page. Same
// hero record, same Phase-0 backfill, same lookVersion bump as the
// Discord editor — so a save from the web bumps the cache-buster
// pinned in render URLs everywhere (Discord embed, Twitch panel,
// site preview) and the next embed re-fetches.

const LOOK_AXES = ['bodyType', 'skinTone', 'hairStyle', 'hairColor', 'eyeColor', 'accent'];

// Hair colour swatches for the web picker — hex strings derived from
// the base (mid-tone) colour in HAIR_COLOURS_RGB above. Keeping the
// derivation here so it stays in lockstep with the actual palette
// swap the renderer uses.
function rgbToHex([r, g, b]) {
  const h = (n) => n.toString(16).padStart(2, '0');
  return '#' + h(r) + h(g) + h(b);
}
function buildHairSwatches() {
  const out = {};
  for (const k of Object.keys(HAIR_COLOURS_RGB)) {
    out[k] = rgbToHex(HAIR_COLOURS_RGB[k].base);
  }
  return out;
}

// Build the render URL the way the Discord editor does — pinned to
// hero.lookVersion so the web UI's <img> tag swaps automatically on
// save.
function buildRenderUrl(env, guildId, userId, version) {
  return renderPreviewUrl(env, guildId, userId, version);
}

// GET: returns the player's current look + the full option catalogue.
// The site uses this on /character page load. Always succeeds — Phase
// 0 backfill guarantees a complete look even for first-time visitors.
//
// Also carries class state so the web editor can render the class
// picker alongside the look pickers:
//   - className          current selection (may be null if first-time)
//   - classes            full class catalogue with stats + starter-gear
//                        preview, so the picker can show "what you get"
//                        before the user commits
//   - starterGranted     whether starter gear has already been granted
//                        (so the UI can decide whether to show the
//                        first-time-grant hint)
export async function getCharacterLookWeb(env, guildId, userId) {
  const hero = applyLookBackfill(await loadHero(env, guildId, userId), userId);
  const look = {};
  for (const axis of LOOK_AXES) look[axis] = hero.custom[axis];
  const classes = Object.keys(CLASSES).map((key) => {
    const c = CLASSES[key];
    return {
      key,
      name: c.name,
      atk: c.atk,
      def: c.def,
      hp: c.hp,
      starterGear: (STARTER_GEAR[key] || []).map((it) => ({
        slot: it.slot,
        name: it.name,
        powerBonus: it.powerBonus,
        defenseBonus: it.defenseBonus,
      })),
    };
  });
  return {
    ok: true,
    look,
    lookVersion: hero.lookVersion || 0,
    renderUrl: buildRenderUrl(env, guildId, userId, hero.lookVersion || 0),
    options: {
      bodyType:  [...CHARACTER_LOOK_OPTIONS.bodyType],
      skinTone:  [...CHARACTER_LOOK_OPTIONS.skinTone],
      hairStyle: [...CHARACTER_LOOK_OPTIONS.hairStyle],
      hairColor: [...CHARACTER_LOOK_OPTIONS.hairColor],
      eyeColor:  [...CHARACTER_LOOK_OPTIONS.eyeColor],
      accent:    [...CHARACTER_LOOK_OPTIONS.accent],
    },
    hairSwatches: buildHairSwatches(),
    className: hero.className || null,
    starterGranted: !!hero.starterGranted,
    classes,
    // Lock state — true once the player has committed via
    // saveCharacterLookWeb. While locked, /web/character/save and
    // /web/character/class both reject with `error: 'character-locked'`;
    // the only path back to an editable character is paying
    // CHARACTER_RESET_COST via /web/character/reset.
    locked: !!hero.locked,
    resetCost: CHARACTER_RESET_COST,
  };
}

// SAVE CLASS: set the hero's class. On first-time selection (when
// hero.starterGranted is still false) the class's starter-gear loadout
// is minted into the hero's bag. Subsequent class changes only flip
// className + HP — no re-granting.
//
// Lock semantics: once hero.locked is true (set by the first
// saveCharacterLookWeb), this route rejects with `character-locked`.
// The player must pay CHARACTER_RESET_COST via /web/character/reset to
// unlock, then they can re-pick their class.
//
// Returns:
//   { ok: true, className, classMeta, granted: [items], starterGranted, hpMax }
//   { ok: false, error: 'bad-class' }
//   { ok: false, error: 'character-locked', resetCost }
export async function applyClassWeb(env, guildId, userId, className) {
  const key = String(className || '').toLowerCase().trim();
  if (!CLASSES[key]) {
    return { ok: false, error: 'bad-class', value: String(className || '').slice(0, 32) };
  }
  const hero = applyLookBackfill(await loadHero(env, guildId, userId), userId);
  if (hero.locked) {
    return {
      ok: false,
      error: 'character-locked',
      resetCost: CHARACTER_RESET_COST,
      message: `Character is locked. Reset for ${CHARACTER_RESET_COST} Bolts to re-pick.`,
    };
  }
  return await applyClassSelection(env, guildId, userId, key);
}

// SAVE: validates each axis against CHARACTER_LOOK_OPTIONS, then
// writes through. Body shape: { look: { bodyType, skinTone, ... } }.
// Partial updates are allowed — unspecified fields keep their current
// value. Unknown fields are ignored; bad values reject the whole save
// with `{ ok: false, error: 'bad-look', field, value }` so the UI
// can highlight the offending picker.
//
// Lock semantics: the first successful save (or any save against an
// unlocked hero) sets hero.locked = true. From that point on every
// /web/character/save returns `error: 'character-locked'` until the
// player pays CHARACTER_RESET_COST via /web/character/reset. The
// per-axis Phase-0 backfill is unaffected — fresh visitors get a
// deterministic default look on GET, and the first save commits it
// (locking) regardless of whether they actually changed anything.
export async function saveCharacterLookWeb(env, guildId, userId, lookPatch) {
  if (!lookPatch || typeof lookPatch !== 'object') {
    return { ok: false, error: 'bad-body', message: 'look object required' };
  }
  // Validate all submitted fields up front so we don't half-write a
  // bad payload.
  for (const axis of LOOK_AXES) {
    if (lookPatch[axis] == null) continue;
    const v = lookPatch[axis];
    if (!CHARACTER_LOOK_OPTIONS[axis].includes(v)) {
      return { ok: false, error: 'bad-look', field: axis, value: String(v).slice(0, 32) };
    }
  }
  const hero = applyLookBackfill(await loadHero(env, guildId, userId), userId);
  if (hero.locked) {
    return {
      ok: false,
      error: 'character-locked',
      resetCost: CHARACTER_RESET_COST,
      message: `Character is locked. Reset for ${CHARACTER_RESET_COST} Bolts to make changes.`,
    };
  }
  hero.custom = hero.custom || {};
  let changed = false;
  for (const axis of LOOK_AXES) {
    if (lookPatch[axis] != null && hero.custom[axis] !== lookPatch[axis]) {
      hero.custom[axis] = lookPatch[axis];
      changed = true;
    }
  }
  if (changed) hero.lookVersion = (hero.lookVersion || 0) + 1;
  hero.locked = true;
  hero.lastUpdatedUtc = new Date().toISOString();
  await env.LOADOUT_BOLTS.put(`d:hero:${guildId}:${userId}`, JSON.stringify(hero));
  const look = {};
  for (const axis of LOOK_AXES) look[axis] = hero.custom[axis];
  return {
    ok: true,
    look,
    lookVersion: hero.lookVersion || 0,
    renderUrl: buildRenderUrl(env, guildId, userId, hero.lookVersion || 0),
    changed,
    locked: true,
  };
}

// RESET: spend CHARACTER_RESET_COST Bolts to unlock a locked
// character so the player can re-pick class + customisation.
//
// Atomicity model — KV is eventually-consistent so we sequence
// carefully and compensate on failure:
//   1. Pre-check: load hero. If not locked → return `not-locked` (no
//      charge). If wallet < cost → return `insufficient-bolts` (no
//      charge, no state change).
//   2. Charge via wallet.spend (single-key transaction).
//   3. Set hero.locked = false and write.
//   4. If step 3 throws, refund via earn() so the player isn't left
//      with a charged wallet AND a still-locked character.
//
// Look + class are preserved across reset — the player keeps their
// existing picks, but can now change them. Re-picking + saving will
// re-lock.
//
// Returns:
//   { ok: true, charged, wallet:{balance,lifetimeEarned,lifetimeSpent},
//     locked: false, look, lookVersion, renderUrl }
//   { ok: false, error: 'not-locked', message }
//   { ok: false, error: 'insufficient-bolts', required, balance }
//   { ok: false, error: 'reset-failed', message }   // refund applied
export async function resetCharacterWeb(env, guildId, userId) {
  const hero = applyLookBackfill(await loadHero(env, guildId, userId), userId);
  if (!hero.locked) {
    const wallet = await getWallet(env, guildId, userId);
    return {
      ok: false,
      error: 'not-locked',
      message: 'Character is not locked. Nothing to reset.',
      wallet: walletSnap(wallet),
    };
  }
  const wallet = await getWallet(env, guildId, userId);
  if ((wallet.balance || 0) < CHARACTER_RESET_COST) {
    return {
      ok: false,
      error: 'insufficient-bolts',
      required: CHARACTER_RESET_COST,
      balance: wallet.balance || 0,
      message: `Need ${CHARACTER_RESET_COST} Bolts; you have ${wallet.balance || 0}.`,
      wallet: walletSnap(wallet),
    };
  }

  const spendRes = await spend(env, guildId, userId, CHARACTER_RESET_COST, 'character-reset');
  if (!spendRes.ok) {
    // Lost a race to another debit between the pre-check and the
    // spend. Surface the same typed error so the UI handles it
    // uniformly.
    const after = await getWallet(env, guildId, userId);
    return {
      ok: false,
      error: 'insufficient-bolts',
      required: CHARACTER_RESET_COST,
      balance: after.balance || 0,
      message: `Need ${CHARACTER_RESET_COST} Bolts; you have ${after.balance || 0}.`,
      wallet: walletSnap(after),
    };
  }

  try {
    hero.locked = false;
    hero.lastUpdatedUtc = new Date().toISOString();
    await env.LOADOUT_BOLTS.put(`d:hero:${guildId}:${userId}`, JSON.stringify(hero));
  } catch (err) {
    // Compensate — refund the spend so the player isn't charged for a
    // reset that didn't land.
    await earn(env, guildId, userId, CHARACTER_RESET_COST, 'character-reset-refund');
    const after = await getWallet(env, guildId, userId);
    return {
      ok: false,
      error: 'reset-failed',
      message: 'Reset failed; Bolts refunded. Try again.',
      wallet: walletSnap(after),
    };
  }

  const after = await getWallet(env, guildId, userId);
  const look = {};
  for (const axis of LOOK_AXES) look[axis] = hero.custom[axis];
  return {
    ok: true,
    charged: CHARACTER_RESET_COST,
    locked: false,
    wallet: walletSnap(after),
    look,
    lookVersion: hero.lookVersion || 0,
    renderUrl: buildRenderUrl(env, guildId, userId, hero.lookVersion || 0),
  };
}

function walletSnap(w) {
  return {
    balance: w?.balance || 0,
    lifetimeEarned: w?.lifetimeEarned || 0,
    lifetimeSpent: w?.lifetimeSpent || 0,
  };
}

// PROGRESSION (P2) — hero stats card. Reads d:hero:<guildId>:<userId>
// across every guild (account-wide hero view). Picks the highest-level
// hero as the headline.
export async function getStatsFor(env, userId, _guildId = null) {
  let bestLevel = 0;
  let bestClass = '';
  let totalHeroes = 0;
  let totalGold = 0;
  let cursor;
  for (let i = 0; i < 5; i++) {
    const r = await env.LOADOUT_BOLTS.list({ prefix: 'd:hero:', cursor, limit: 1000 });
    for (const k of r.keys) {
      if (!k.name.endsWith(':' + userId)) continue;
      const h = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
      if (!h) continue;
      totalHeroes++;
      if ((h.level || 0) > bestLevel) {
        bestLevel = h.level || 0;
        bestClass = h.class || '';
      }
      totalGold += h.gold || 0;
    }
    if (r.list_complete) break;
    cursor = r.cursor;
  }
  return {
    primary: { label: 'Hero', value: bestLevel > 0 ? `L${bestLevel} ${bestClass}` : 'none' },
    secondary: [
      { label: 'Heroes', value: totalHeroes },
      { label: 'Gold', value: totalGold },
    ],
    iconKind: 'hero-sword',
  };
}
