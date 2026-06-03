// Monthly themed cosmetic auto-grant to active Patreon supporters.
//
// 2026-05-29 sprint. First-of-month tick:
//   1. Look up active Spire season (from spire-seasons.js / spire.js).
//   2. Find the cosmetic whose themeSeason matches.
//   3. Walk patreon:tier:*, for each active (tier present, non-free)
//      patron, grant the cosmetic into pbadge:<userId>.
//   4. Idempotent, re-runs don't duplicate.

const KEY_USER_BADGES = (u) => `pbadge:${u}`;

// 12 themed cosmetics, one per Spire season. IDs are stable so future
// runs append to pbadge inventories without conflict.
export const MONTHLY_COSMETICS = Object.freeze([
  { id: 'ember-court-banner',       themeSeason: 'ember-court',       name: 'Ember Court Banner',       kind: 'banner', rarity: 'rare' },
  { id: 'aurora-spire-frame',       themeSeason: 'aurora-spire',      name: 'Aurora Spire Frame',       kind: 'frame',  rarity: 'rare' },
  { id: 'sunken-vault-sigil',       themeSeason: 'sunken-vault',      name: 'Sunken Vault Sigil',       kind: 'sigil',  rarity: 'rare' },
  { id: 'verdant-hollow-banner',    themeSeason: 'verdant-hollow',    name: 'Verdant Hollow Banner',    kind: 'banner', rarity: 'rare' },
  { id: 'sandstorm-bazaar-frame',   themeSeason: 'sandstorm-bazaar',  name: 'Sandstorm Bazaar Frame',   kind: 'frame',  rarity: 'rare' },
  { id: 'frost-citadel-sigil',      themeSeason: 'frost-citadel',     name: 'Frost Citadel Sigil',      kind: 'sigil',  rarity: 'rare' },
  { id: 'clockwork-foundry-banner', themeSeason: 'clockwork-foundry', name: 'Clockwork Foundry Banner', kind: 'banner', rarity: 'rare' },
  { id: 'mirror-garden-frame',      themeSeason: 'mirror-garden',     name: 'Mirror Garden Frame',      kind: 'frame',  rarity: 'rare' },
  { id: 'bone-reliquary-sigil',     themeSeason: 'bone-reliquary',    name: 'Bone Reliquary Sigil',     kind: 'sigil',  rarity: 'rare' },
  { id: 'cinder-apex-banner',       themeSeason: 'cinder-apex',       name: 'Cinder Apex Banner',       kind: 'banner', rarity: 'rare' },
  { id: 'stargazer-court-frame',    themeSeason: 'stargazer-court',   name: 'Stargazer Court Frame',    kind: 'frame',  rarity: 'rare' },
  { id: 'velvet-catacomb-sigil',    themeSeason: 'velvet-catacomb',   name: 'Velvet Catacomb Sigil',    kind: 'sigil',  rarity: 'rare' },
]);

const BY_SEASON = Object.fromEntries(MONTHLY_COSMETICS.map(c => [c.themeSeason, c]));

async function activeSeasonSlug(env) {
  // Best-effort lookup via the spire module. If unavailable, derive from
  // calendar month (Jan = ember-court, Feb = aurora-spire, etc.)
  try {
    const spire = await import('./spire.js');
    if (spire.getActiveSeason) {
      const s = await spire.getActiveSeason(env);
      if (s?.slug) return s.slug;
    }
  } catch { /* fall through */ }
  const order = MONTHLY_COSMETICS.map(c => c.themeSeason);
  return order[new Date().getUTCMonth() % order.length];
}

async function grantBadge(env, userId, cosmeticId) {
  const key = KEY_USER_BADGES(userId);
  const rec = (await env.LOADOUT_BOLTS.get(key, { type: 'json' })) || {
    owned: [], firstEarnedUtc: {}, showcase: [],
  };
  if (rec.owned.includes(cosmeticId)) return { granted: false, alreadyOwned: true };
  rec.owned.push(cosmeticId);
  rec.firstEarnedUtc[cosmeticId] = Date.now();
  await env.LOADOUT_BOLTS.put(key, JSON.stringify(rec));
  return { granted: true };
}

// Public: monthly auto-grant entry point. Returns counts.
export async function runMonthlyAutoGrant(env, opts = {}) {
  const seasonSlug = opts.seasonSlug || await activeSeasonSlug(env);
  const cosmetic = BY_SEASON[seasonSlug];
  if (!cosmetic) {
    return { ok: false, error: 'no-cosmetic-for-season', seasonSlug };
  }
  let cursor, walked = 0, granted = 0, skipped = 0;
  for (let i = 0; i < 6; i++) {
    const page = await env.LOADOUT_BOLTS.list({
      prefix: 'patreon:tier:', cursor, limit: 1000,
    });
    for (const k of (page.keys || [])) {
      walked++;
      const userId = k.name.slice('patreon:tier:'.length);
      const rec = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' }).catch(() => null);
      if (!rec) continue;
      const tier = String(rec.tier || rec.tierName || '').trim().toLowerCase();
      if (!tier || tier === 'free') continue;
      try {
        const r = await grantBadge(env, userId, cosmetic.id);
        if (r.granted) granted++; else skipped++;
      } catch { /* swallow */ }
    }
    if (page.list_complete || !page.cursor) break;
    cursor = page.cursor;
  }
  return { ok: true, seasonSlug, cosmetic, walked, granted, skipped };
}

// Get a user's owned cosmetics list, backs the play/cosmetics/me endpoint.
export async function getCosmeticsForUser(env, userId) {
  const rec = await env.LOADOUT_BOLTS.get(KEY_USER_BADGES(userId), { type: 'json' });
  return {
    ok: true,
    owned: rec?.owned || [],
    showcase: rec?.showcase || [],
    firstEarnedUtc: rec?.firstEarnedUtc || {},
  };
}
