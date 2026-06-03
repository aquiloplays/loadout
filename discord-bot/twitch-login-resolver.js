// Dynamic Twitch login (username) resolver.
//
// On Twitch the broadcaster_user_id is PERMANENT; the login (username)
// can be changed by the broadcaster at any time. Every place that links
// to twitch.tv/<login> or renders the slug resolves it HERE from the
// canonical broadcaster id, so a username change needs ZERO code or env
// edits, the new login is picked up automatically within the cache TTL
// (or instantly via refreshTwitchLogin / an admin cache-bust).
//
// Resolution order:
//   1. KV cache  twitch:login:<id>   (1-hour TTL)
//   2. Helix     GET /users?id=<id>  -> data[0].login, then cache it
//   3. env.CLAY_TWITCH_LOGIN         (network / Helix failure fallback)
//
// The env fallback exists purely so live functionality keeps working if
// Helix is briefly unreachable; it is only consulted when the API call
// fails. As long as Helix is reachable the resolved login is canonical.
//
// Built on twitch-helix.js (cached app-access-token + helixFetch), so
// it shares the same token cache and graceful null-on-misconfig
// behaviour as the rest of the Twitch integration.

import { getUserById } from './twitch-helix.js';

const LOGIN_KEY = (id) => `twitch:login:${id}`;
const TTL_S = 3600; // 1 hour

// Resolve the current login for a broadcaster id. Defaults to the
// canonical channel (env.CLAY_TWITCH_CHANNEL_ID) when no id is passed.
// Never throws, returns the env fallback (or null) on any failure.
export async function resolveTwitchLogin(env, broadcasterId) {
  const id = String(broadcasterId || (env && env.CLAY_TWITCH_CHANNEL_ID) || '').trim();
  const envFallback = (env && env.CLAY_TWITCH_LOGIN) || null;
  if (!id || !env || !env.LOADOUT_BOLTS) return envFallback;

  // 1. Warm cache.
  try {
    const cached = await env.LOADOUT_BOLTS.get(LOGIN_KEY(id));
    if (cached) return cached;
  } catch { /* fall through to Helix */ }

  // 2. Helix lookup.
  try {
    const user = await getUserById(env, id);
    const login = user && user.login;
    if (login) {
      try {
        await env.LOADOUT_BOLTS.put(LOGIN_KEY(id), login, { expirationTtl: TTL_S });
      } catch { /* cache write is best-effort */ }
      return login;
    }
  } catch { /* fall through to env fallback */ }

  // 3. Helix failed (network / misconfig), env override keeps links live.
  return envFallback;
}

// Resolve the canonical broadcaster's login + id in one shape. Used by
// the public /api/twitch/login worker endpoint and (via that) by
// aquilo-site for its live embeds.
export async function resolveCanonicalLogin(env) {
  const broadcasterId = String((env && env.CLAY_TWITCH_CHANNEL_ID) || '').trim() || null;
  const login = await resolveTwitchLogin(env, broadcasterId);
  return { login: login || null, broadcasterId };
}

// Force a fresh Helix lookup, deleting (and re-priming) the KV cache.
// Lets an admin propagate a just-completed rename immediately rather
// than waiting up to an hour for the TTL to lapse.
export async function refreshTwitchLogin(env, broadcasterId) {
  const id = String(broadcasterId || (env && env.CLAY_TWITCH_CHANNEL_ID) || '').trim();
  if (!id || !env || !env.LOADOUT_BOLTS) return (env && env.CLAY_TWITCH_LOGIN) || null;
  try { await env.LOADOUT_BOLTS.delete(LOGIN_KEY(id)); } catch { /* ignore */ }
  return resolveTwitchLogin(env, id);
}
