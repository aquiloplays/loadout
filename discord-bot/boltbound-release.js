// Boltbound — KV-backed expansion release overrides.
//
// The registry in boltbound-sets.js gives each expansion a far-future
// placeholder releaseUtc (so everything ships HIDDEN). Clay flips a set
// live by writing an override here; reverting drops it back to hidden.
// One KV key holds the whole override map so the read is a single GET.
//
//   KV `boltbound:expansion-releases` = { "<slug>": <epochMs>, ... }
//
// Effective release = override[slug] ?? registry.releaseUtc. `core` is
// always live. Gating (packs + deck builder + the sets gallery) routes
// through here so a release/hide takes effect immediately, no redeploy.

import { SETS } from './boltbound-sets.js';

const RELEASES_KEY = 'boltbound:expansion-releases';

export async function getReleaseOverrides(env) {
  try {
    return (await env.LOADOUT_BOLTS.get(RELEASES_KEY, { type: 'json' })) || {};
  } catch {
    return {};
  }
}

// Effective release timestamp for a set given an override map.
export function effectiveReleaseUtc(slug, overrides) {
  const s = SETS[slug];
  if (!s) return Infinity;                 // unknown set is never released
  const o = overrides && overrides[slug];
  return (typeof o === 'number') ? o : s.releaseUtc;
}

// Is this set playable/pullable right now? core is always true.
export async function isExpansionReleased(env, slug, now = Date.now()) {
  if (!slug || slug === 'core') return true;
  if (!SETS[slug]) return false;
  const ov = await getReleaseOverrides(env);
  return now >= effectiveReleaseUtc(slug, ov);
}

// { slug: effectiveReleaseUtc } for every registered set.
export async function listEffectiveReleases(env) {
  const ov = await getReleaseOverrides(env);
  const out = {};
  for (const id of Object.keys(SETS)) out[id] = effectiveReleaseUtc(id, ov);
  return out;
}

// Slugs released as of `now` (always includes 'core').
export async function releasedSetIds(env, now = Date.now()) {
  const eff = await listEffectiveReleases(env);
  return Object.keys(eff).filter((id) => now >= eff[id]);
}

// Set/clear an override. atMs=number releases (or schedules); atMs=null
// reverts to the registry placeholder (hidden). Returns the new map.
export async function setExpansionRelease(env, slug, atMs) {
  if (!SETS[slug] || slug === 'core') {
    throw new Error('cannot override release for set: ' + slug);
  }
  const ov = await getReleaseOverrides(env);
  if (atMs === null || atMs === undefined) delete ov[slug];
  else ov[slug] = Number(atMs);
  await env.LOADOUT_BOLTS.put(RELEASES_KEY, JSON.stringify(ov));
  return ov;
}
