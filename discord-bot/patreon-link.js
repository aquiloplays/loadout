// Patreon-link gate — the shared check for all Patreon-perk features
// (cosmetics pack, priority queue access, hero campaign slots, future
// items 22-24+).
//
// Per Clay 2026-05: the gate is "any tier — free OR paid". Don't
// require a paid Patreon membership. The check just confirms the
// user has linked their Patreon account at all (via the existing
// auth.aquilo.gg OAuth flow).
//
// Three signals (matches quests.js linked-patreon completion logic):
//   1. `quest:patreon-linked:<g>:<u>` — explicit flag set by
//      /web/quest/mark-patreon-linked when the site's OAuth callback
//      completes. THE preferred signal (most reliable).
//   2. `patreon:tier:<userId>` — written by ext-patreon-link.js +
//      the site OAuth handler when the Patreon profile has an
//      image_url. Unreliable for free-tier users without an avatar.
//   3. `wallet:<g>:<u>.links` contains a `patreon` entry — the
//      bulletproof bottom-half signal (link handler unconditionally
//      merges every linked platform into w.links).
//
// Any one signal present → linked. All three absent → not linked.
//
// Caching: an in-memory per-isolate cache keeps repeat lookups inside
// the same request cheap (cosmetics + priority queue + campaign all
// might check the same user in one flow). TTL is short (60s) — KV is
// already fast and we don't want to mask a freshly-linked user.

const _cache = new Map();   // key: g|u → { value, expiresAt }
const CACHE_TTL_MS = 60 * 1000;

function cacheKey(guildId, userId) { return `${guildId}|${userId}`; }

function cacheGet(g, u) {
  const k = cacheKey(g, u);
  const hit = _cache.get(k);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  if (hit) _cache.delete(k);
  return undefined;
}

function cacheSet(g, u, value) {
  _cache.set(cacheKey(g, u), { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

// Public: does this user have ANY tier of Patreon linked (free OR paid)?
// Returns boolean. Never throws — every signal lookup is wrapped so a
// transient KV error degrades to "not linked" instead of breaking the
// caller's flow.
export async function userHasPatreon(env, guildId, userId) {
  if (!env?.LOADOUT_BOLTS || !guildId || !userId) return false;
  const cached = cacheGet(guildId, userId);
  if (cached !== undefined) return cached;

  // Signal 1 — explicit flag from site OAuth callback.
  try {
    const flag = await env.LOADOUT_BOLTS.get(`quest:patreon-linked:${guildId}:${userId}`);
    if (flag) { cacheSet(guildId, userId, true); return true; }
  } catch { /* ignore */ }

  // Signal 2 — patreon:tier:<userId> presence.
  try {
    const tier = await env.LOADOUT_BOLTS.get(`patreon:tier:${userId}`, { type: 'json' });
    if (tier && (tier.tier || tier.imageUrl || tier.image_url || tier.linked_at)) {
      cacheSet(guildId, userId, true);
      return true;
    }
  } catch { /* ignore */ }

  // Signal 3 — wallet.links contains a patreon entry.
  try {
    const wallet = await env.LOADOUT_BOLTS.get(`wallet:${guildId}:${userId}`, { type: 'json' });
    const links = Array.isArray(wallet?.links) ? wallet.links : [];
    if (links.some(l => l && String(l.platform || '').toLowerCase() === 'patreon')) {
      cacheSet(guildId, userId, true);
      return true;
    }
  } catch { /* ignore */ }

  cacheSet(guildId, userId, false);
  return false;
}

// Public: structured tier detail. Returns
//   { linked: bool, tier?: string, paid?: bool, source?: string }
// `tier` is the raw Patreon tier name when known (e.g. "Tier 3
// Patron"); some signals only carry the existence of a link, not the
// tier label. `paid` is best-effort — derived from tier name patterns
// ("free" or no tier → false; anything else → true). Features that
// need to distinguish free vs paid (none of items 22-24 do today)
// can read this; features that only need the link-or-not check
// should use userHasPatreon() instead.
export async function getPatreonTier(env, userId) {
  if (!env?.LOADOUT_BOLTS || !userId) return { linked: false };
  try {
    const rec = await env.LOADOUT_BOLTS.get(`patreon:tier:${userId}`, { type: 'json' });
    if (rec) {
      const tier = String(rec.tier || rec.tierName || '').trim();
      const paid = !!tier && !/^free$/i.test(tier);
      return { linked: true, tier: tier || null, paid, source: 'patreon:tier' };
    }
  } catch { /* fall through */ }
  // No tier record but the user might still be linked per signals 1/3.
  // Don't double-check here — let the caller use userHasPatreon() if
  // they only need link-or-not.
  return { linked: false };
}

// Public: invalidate the in-memory cache for a specific user. Called
// by the site's OAuth callback handler so a freshly-linked user's
// next request sees the updated state without waiting 60s.
export function invalidateCache(guildId, userId) {
  if (!guildId && !userId) { _cache.clear(); return; }
  if (guildId && userId) { _cache.delete(cacheKey(guildId, userId)); return; }
  for (const k of [..._cache.keys()]) {
    const [g, u] = k.split('|');
    if ((guildId && g === guildId) || (userId && u === userId)) _cache.delete(k);
  }
}
