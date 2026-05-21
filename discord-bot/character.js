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
import { loadHero, CHARACTER_LOOK_OPTIONS, applyLookBackfill } from './dungeon.js';
import { getPet, computeMood } from './pet.js';

// ── Sprite source URL ────────────────────────────────────────────
//
// Sprites are committed at aquilo-gg/sprites/ and served from the
// Cloudflare Pages mirror at widget.aquilo.gg/sprites/...
//
// Override via SPRITE_BASE_URL env var (used in local testing).
function spriteBase(env) {
  return (env && env.SPRITE_BASE_URL) || 'https://widget.aquilo.gg/sprites';
}

// In-memory cache. Decoded layers stay in this map until the Worker
// isolate cycles. Keys are URLs; values are decoded image objects
// `{ width, height, pixels }`. ~9 KB per 40×56 sprite — ~5 MB for
// the full 500-sprite roster, well under the 128 MB isolate budget.
const SPRITE_CACHE = new Map();

async function fetchSprite(env, relPath) {
  const url = spriteBase(env) + '/' + relPath.replace(/^\/+/, '');
  if (SPRITE_CACHE.has(url)) return SPRITE_CACHE.get(url);
  const res = await fetch(url, { cf: { cacheTtl: 3600 } });
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
// composes back-to-front. Per CHARACTER-SYSTEM-DESIGN.md §4 z-order:
//
//   z=10 back-accessory  (trinket if back)
//   z=15 pet             (cosmetic, in-frame)
//   z=20 body            (figure base)
//   z=30 legs
//   z=35 boots
//   z=40 chest
//   z=45 front-trinket   (if non-back)
//   z=60 hair
//   z=65 face overlay    (eyes + accent)
//   z=70 head            (helmets cover hair via z-order)
//   z=80 weapon
//   z=90 fx              (legendary glow particles)
//
// Slots without a sprite are simply skipped — no placeholder layer
// rendered. The figure body always renders; everything else is
// optional.
async function resolveLayers(env, hero, pet, opts) {
  const layers = [];
  const eq = hero.equipped || {};
  const inv = Object.fromEntries((hero.bag || []).map(it => [it.id, it]));

  // Helpers
  const itemSlot = (slot) => inv[eq[slot]];

  // z=10 — back accessory (trinket flagged with back-cape semantics)
  const trinket = itemSlot('trinket');
  if (trinket?.spriteId && /-cape$|-wing$|-cloak$/.test(trinket.spriteId)) {
    layers.push({ rel: `gear/trinket/${trinket.spriteId}.png` });
  }

  // z=15 — pet (cosmetic, only if not suppressed by ?nopet=1)
  if (pet && !opts.nopet) {
    layers.push({ rel: `pet/${pet.species}-${pet.colour}.png` });
    const mood = computeMood(pet);
    if (mood?.hint) layers.push({ rel: `pet/mood-${mood.hint}.png` });
  }

  // z=20 — body
  layers.push({ rel: `figure/body-${hero.custom.bodyType || 'slim'}-${hero.custom.skinTone || 'fair'}.png` });

  // z=30 / 35 / 40 — legs, boots, chest gear
  for (const slot of ['legs', 'boots', 'chest']) {
    const it = itemSlot(slot);
    if (it?.spriteId) layers.push({ rel: `gear/${slot}/${it.spriteId}.png` });
  }

  // z=45 — front trinket (non-back)
  if (trinket?.spriteId && !/-cape$|-wing$|-cloak$/.test(trinket.spriteId)) {
    layers.push({ rel: `gear/trinket/${trinket.spriteId}.png` });
  }

  // z=60 — hair (palette-swapped per hero hair colour)
  if (hero.custom.hairStyle && hero.custom.hairStyle !== 'bald') {
    layers.push({
      rel: `figure/hair-${hero.custom.hairStyle}.png`,
      paletteFor: 'hair', colourKey: hero.custom.hairColor || 'brown',
    });
  }

  // z=65 — face overlay (eye colour + accent)
  if (hero.custom.eyeColor) {
    layers.push({ rel: `figure/eyes-${hero.custom.eyeColor}.png` });
  }
  if (hero.custom.accent && hero.custom.accent !== 'none') {
    layers.push({ rel: `figure/accent-${hero.custom.accent}.png` });
  }

  // z=70 — head gear (over hair)
  const head = itemSlot('head');
  if (head?.spriteId) layers.push({ rel: `gear/head/${head.spriteId}.png` });

  // z=80 — weapon
  const weapon = itemSlot('weapon');
  if (weapon?.spriteId) layers.push({ rel: `gear/weapon/${weapon.spriteId}.png` });

  // z=90 — fx (legendary glow). Authored as a per-piece halo overlay.
  for (const slot of ['weapon', 'chest', 'head', 'trinket']) {
    const it = itemSlot(slot);
    if (it?.rarity === 'legendary' && it.spriteId) {
      layers.push({ rel: `gear/fx/${it.spriteId}.png`, optional: true });
    }
  }

  return layers;
}

// Build a single-shot palette map for hair palette swap.
// Hair sprites are authored at the "brown" reference palette
// (matches build-sprites.ps1 $HAIR_COLOURS.brown).
const HAIR_REF = { shadow: [0x3b, 0x25, 0x1a], base: [0x5a, 0x3a, 0x26], high: [0x7a, 0x52, 0x36] };
const HAIR_COLOURS_RGB = {
  brown:   { shadow: [0x3b, 0x25, 0x1a], base: [0x5a, 0x3a, 0x26], high: [0x7a, 0x52, 0x36] },
  black:   { shadow: [0x16, 0x16, 0x18], base: [0x2a, 0x2a, 0x30], high: [0x42, 0x42, 0x4a] },
  blonde:  { shadow: [0xa3, 0x7a, 0x30], base: [0xd4, 0xa6, 0x4a], high: [0xf4, 0xd2, 0x7a] },
  red:     { shadow: [0x7a, 0x20, 0x18], base: [0xb5, 0x34, 0x20], high: [0xd8, 0x55, 0x3a] },
  grey:    { shadow: [0x5f, 0x63, 0x6c], base: [0x87, 0x8b, 0x95], high: [0xb3, 0xb8, 0xc2] },
  white:   { shadow: [0xc8, 0xcc, 0xd6], base: [0xe6, 0xe9, 0xef], high: [0xff, 0xff, 0xff] },
  violet:  { shadow: [0x5a, 0x40, 0xb0], base: [0x7c, 0x5c, 0xff], high: [0xa8, 0x90, 0xff] },
  teal:    { shadow: [0x2f, 0x8a, 0x78], base: [0x5f, 0xc4, 0xa8], high: [0x92, 0xe6, 0xcd] },
  pink:    { shadow: [0xc1, 0x46, 0x88], base: [0xe8, 0x7a, 0xb0], high: [0xff, 0xab, 0xcf] },
  mint:    { shadow: [0x3d, 0xa7, 0x6c], base: [0x5b, 0xe0, 0x98], high: [0x90, 0xff, 0xc4] },
  silver:  { shadow: [0x7a, 0x80, 0x90], base: [0xa8, 0xaf, 0xbc], high: [0xd4, 0xd8, 0xe0] },
  copper:  { shadow: [0x9c, 0x4a, 0x1f], base: [0xcf, 0x72, 0x40], high: [0xf0, 0x98, 0x66] },
  navy:    { shadow: [0x17, 0x20, 0x46], base: [0x29, 0x3a, 0x78], high: [0x3e, 0x53, 0x9c] },
  forest:  { shadow: [0x1a, 0x3a, 0x20], base: [0x2e, 0x5c, 0x34], high: [0x4b, 0x85, 0x50] },
};
function hairPaletteMap(colourKey) {
  const target = HAIR_COLOURS_RGB[colourKey] || HAIR_COLOURS_RGB.brown;
  return [
    { from: HAIR_REF.shadow, to: target.shadow },
    { from: HAIR_REF.base,   to: target.base   },
    { from: HAIR_REF.high,   to: target.high   },
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

  const layerSpecs = await resolveLayers(env, hero, pet, opts);
  const layers = [];
  for (const spec of layerSpecs) {
    const img = await fetchSprite(env, spec.rel);
    if (!img) {
      if (spec.optional) continue;
      // Missing required layer (e.g. figure body for an unknown
      // skinTone). Don't crash the render — substitute a blank
      // layer so the pipeline still emits a PNG. This should never
      // happen post-Phase-2; if it does, the absence is visible
      // and easy to spot.
      layers.push(blank(40, 56));
      continue;
    }
    if (spec.paletteFor === 'hair') {
      layers.push(paletteSwap(img, hairPaletteMap(spec.colourKey)));
    } else {
      layers.push(img);
    }
  }

  if (!layers.length) layers.push(blank(40, 56));
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
  return `${base}/character/render/${guildId}/${userId}.png?v=${version || 0}`;
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
