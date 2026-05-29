// Hero background catalogue + Patreon gating.
//
// 2026-05-29 Phase A.5. The site renderer shows a customizable
// background behind the hero composite. 19 entries — 7 free
// (abstract CSS + scene pixel art) + 12 Patreon-only (spire-themed
// pixel art). Patreon-only entries gate on userHasPaidPatreon —
// non-patrons see them in the list with `asset_url: null` +
// `unlock_url` so the site can render a lock badge.
//
// Asset storage mirrors hero/gear pattern: KV `pixel-art-hero-bg:<id>`
// served at /asset/hero-bg/<id>.png.

import { userHasPaidPatreon } from './patreon-link.js';

const WORKER_HOST = 'loadout-discord.aquiloplays.workers.dev';
const PATREON_URL = 'https://www.patreon.com/cw/aquilo/membership';

// Catalogue. `hasAsset` distinguishes pixel-art entries (true) from
// CSS-only abstracts (false). `cssClass` is non-null for entries that
// carry a CSS class to apply on the site side — abstract entries
// use it as the sole renderer; pixel scenes may use it as an overlay
// (only cosmic-aurora today, for the firefly drift).
export const HERO_BACKGROUNDS = Object.freeze([
  // ── Free — abstract (CSS only) ────────────────────────────────────
  { id: 'aurora-drift',     name: 'Aurora Drift',     category: 'abstract',
    hasAsset: false, cssClass: 'aq-bg-aurora-drift',     patreonOnly: false },
  { id: 'twilight-purple',  name: 'Twilight Purple',  category: 'abstract',
    hasAsset: false, cssClass: 'aq-bg-twilight-purple',  patreonOnly: false },
  { id: 'plain-white',      name: 'Plain White',      category: 'abstract',
    hasAsset: false, cssClass: 'aq-bg-plain-white',      patreonOnly: false },
  { id: 'plain-dark',       name: 'Plain Dark',       category: 'abstract',
    hasAsset: false, cssClass: 'aq-bg-plain-dark',       patreonOnly: false },
  // ── Free — scene (pixel art) ──────────────────────────────────────
  { id: 'forest-day',       name: 'Forest Day',       category: 'scene',
    hasAsset: true,  cssClass: null, patreonOnly: false },
  { id: 'snow-flurries',    name: 'Snow Flurries',    category: 'scene',
    hasAsset: true,  cssClass: null, patreonOnly: false },
  { id: 'beach-sunset',     name: 'Beach Sunset',     category: 'scene',
    hasAsset: true,  cssClass: null, patreonOnly: false },
  // ── Patreon-only — spire-themed (pixel art) ───────────────────────
  // cosmic-aurora also carries a CSS overlay for the firefly layer.
  { id: 'cosmic-aurora',     name: 'Cosmic Aurora',     category: 'spire-themed',
    hasAsset: true,  cssClass: 'aq-bg-cosmic-aurora-overlay', patreonOnly: true },
  { id: 'ember-battlefield', name: 'Ember Battlefield', category: 'spire-themed',
    hasAsset: true,  cssClass: null, patreonOnly: true },
  { id: 'frost-peaks',       name: 'Frost Peaks',       category: 'spire-themed',
    hasAsset: true,  cssClass: null, patreonOnly: true },
  { id: 'sandstorm-bazaar',  name: 'Sandstorm Bazaar',  category: 'spire-themed',
    hasAsset: true,  cssClass: null, patreonOnly: true },
  { id: 'verdant-hollow',    name: 'Verdant Hollow',    category: 'spire-themed',
    hasAsset: true,  cssClass: null, patreonOnly: true },
  { id: 'clockwork-foundry', name: 'Clockwork Foundry', category: 'spire-themed',
    hasAsset: true,  cssClass: null, patreonOnly: true },
  { id: 'stargazer-court',   name: 'Stargazer Court',   category: 'spire-themed',
    hasAsset: true,  cssClass: null, patreonOnly: true },
  { id: 'velvet-catacomb',   name: 'Velvet Catacomb',   category: 'spire-themed',
    hasAsset: true,  cssClass: null, patreonOnly: true },
  { id: 'mirror-garden',     name: 'Mirror Garden',     category: 'spire-themed',
    hasAsset: true,  cssClass: null, patreonOnly: true },
  { id: 'bone-reliquary',    name: 'Bone Reliquary',    category: 'spire-themed',
    hasAsset: true,  cssClass: null, patreonOnly: true },
  { id: 'cinder-apex',       name: 'Cinder Apex',       category: 'spire-themed',
    hasAsset: true,  cssClass: null, patreonOnly: true },
  { id: 'sunken-vault',      name: 'Sunken Vault',      category: 'spire-themed',
    hasAsset: true,  cssClass: null, patreonOnly: true },
]);

const BY_ID = Object.fromEntries(HERO_BACKGROUNDS.map(b => [b.id, b]));

export const DEFAULT_BACKGROUND_ID = 'aurora-drift';

function assetUrl(id) { return `https://${WORKER_HOST}/asset/hero-bg/${id}.png`; }

// Project a catalogue entry to the site-facing shape, honoring the
// caller's Patreon status. Free entries always carry their URL/class;
// Patreon-only entries hide the URL for non-patrons and carry an
// unlock CTA instead.
function projectEntry(entry, isPatron) {
  const isLocked = entry.patreonOnly && !isPatron;
  return {
    id:           entry.id,
    name:         entry.name,
    category:     entry.category,
    asset_url:    (!entry.hasAsset || isLocked) ? null : assetUrl(entry.id),
    css_class:    entry.cssClass,
    patreon_only: entry.patreonOnly,
    ...(isLocked ? { unlock_url: PATREON_URL } : {}),
  };
}

export async function listBackgroundsForUser(env, userId) {
  const isPatron = await userHasPaidPatreon(env, userId).catch(() => false);
  return {
    ok: true,
    backgrounds: HERO_BACKGROUNDS.map(e => projectEntry(e, isPatron)),
    isPatron,
    defaultId: DEFAULT_BACKGROUND_ID,
  };
}

// Server-side gate for character/save. Returns { ok, error?, entry? }.
//   - Unknown id → bad-background
//   - Patreon-only + non-patron → patreon-required + unlockUrl
//   - Otherwise → ok with the catalogue entry
export async function validateBackgroundForUser(env, userId, backgroundId) {
  const entry = BY_ID[backgroundId];
  if (!entry) {
    return { ok: false, error: 'bad-background',
             message: `Unknown background "${backgroundId}".` };
  }
  if (entry.patreonOnly) {
    const isPatron = await userHasPaidPatreon(env, userId).catch(() => false);
    if (!isPatron) {
      return { ok: false, error: 'patreon-required',
               message: `${entry.name} is a Patreon-only background.`,
               unlockUrl: PATREON_URL };
    }
  }
  return { ok: true, entry };
}

// Resolver: returns the URL + CSS class the renderer should use for
// a given hero. Falls through to the default when:
//   - hero has no background set (legacy)
//   - the saved id is no longer in the catalogue (deprecated entry)
//   - the saved id is Patreon-only and the user has lapsed
export async function resolveHeroBackground(env, userId, hero) {
  const savedId = hero?.custom?.background;
  let entry = (savedId && BY_ID[savedId]) || BY_ID[DEFAULT_BACKGROUND_ID];
  if (entry.patreonOnly) {
    const isPatron = await userHasPaidPatreon(env, userId).catch(() => false);
    if (!isPatron) entry = BY_ID[DEFAULT_BACKGROUND_ID];
  }
  return {
    id:        entry.id,
    name:      entry.name,
    asset_url: entry.hasAsset ? assetUrl(entry.id) : null,
    css_class: entry.cssClass,
  };
}

export { HERO_BACKGROUNDS as _catalogue };
