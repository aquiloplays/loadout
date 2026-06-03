// Twitch-panel Loadout routes — /ext/loadout/*.
//
// Presentation layer over the Discord bot's economy/game logic. Each
// route resolves the viewer through ext.js's `tw:` identity bridge and
// calls the structured `do*` cores in dungeon.js (or games/wallet
// directly), returning panel-ready JSON instead of Discord text.
//
// Mutating routes carry a light ~3s per-viewer debounce
// (KV extcd:<action>:<guild>:<userId>) to absorb double-taps; deeper
// gameplay caps (per-day spend/train/gift) are deferred to a config pass.

import { getWallet, transfer } from './wallet.js';
import { getProfile } from './profiles.js';
import { recordStat } from './recap.js';

import { json, debounced } from './ext-shared.js';

// Twitch app token (client-credentials, cached) — used to resolve a
// gift recipient's login name to a numeric id, and reused by the
// Tier 1 /ext/vods route.
export async function getTwitchAppToken(env) {
  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) return null;
  const cached = await env.LOADOUT_BOLTS.get('twitch:apptoken');
  if (cached) return cached;
  try {
    const res = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `client_id=${encodeURIComponent(env.TWITCH_CLIENT_ID)}` +
            `&client_secret=${encodeURIComponent(env.TWITCH_CLIENT_SECRET)}` +
            `&grant_type=client_credentials`,
    });
    if (!res.ok) return null;
    const d = await res.json();
    if (!d || !d.access_token) return null;
    await env.LOADOUT_BOLTS.put('twitch:apptoken', d.access_token, {
      expirationTtl: Math.max(60, (d.expires_in || 3600) - 600),
    });
    return d.access_token;
  } catch {
    return null;
  }
}

// Resolve a numeric Twitch user_id to its canonical login (chat username).
// Cached per id for 24 h. Used by the panel-bridge so a command queued by
// an identity-shared viewer credits the same wallet their chat plays do —
// `tw:<login>` is the canonical key, and the panel JWT only carries the
// numeric id. Returns null for opaque-only viewers or on any failure
// (caller falls back to the panel-body name).
export async function resolveTwitchLoginById(env, userId) {
  if (!userId) return null;
  const ck = 'helix:login:' + userId;
  const cached = await env.LOADOUT_BOLTS.get(ck);
  if (cached) return cached;
  const token = await getTwitchAppToken(env);
  if (!token) return null;
  try {
    const res = await fetch(
      'https://api.twitch.tv/helix/users?id=' + encodeURIComponent(userId),
      {
        headers: {
          'Client-Id': env.TWITCH_CLIENT_ID,
          Authorization: 'Bearer ' + token,
        },
      },
    );
    if (!res.ok) return null;
    const d = await res.json();
    const u = d && d.data && d.data[0];
    if (!u || !u.login) return null;
    await env.LOADOUT_BOLTS.put(ck, u.login, { expirationTtl: 60 * 60 * 24 });
    return u.login;
  } catch {
    return null;
  }
}

async function resolveTwitchLogin(env, login) {
  const token = await getTwitchAppToken(env);
  if (!token) return null;
  try {
    const res = await fetch(
      'https://api.twitch.tv/helix/users?login=' + encodeURIComponent(login),
      { headers: { 'Client-Id': env.TWITCH_CLIENT_ID, Authorization: 'Bearer ' + token } },
    );
    if (!res.ok) return null;
    const d = await res.json();
    const u = d && d.data && d.data[0];
    return u ? { id: String(u.id), login: u.login, displayName: u.display_name } : null;
  } catch {
    return null;
  }
}

// Trim a bag/shop item to the fields the panel renders.
function panelItem(it) {
  return {
    id: it.id,
    slot: it.slot || '',
    rarity: it.rarity || 'common',
    name: it.name || '',
    glyph: it.glyph || '',
    powerBonus: it.powerBonus || 0,
    defenseBonus: it.defenseBonus || 0,
    ability: it.ability || '',
    goldValue: it.goldValue || 0,
  };
}

