// Friendly viewer-name resolution for live-activity events (the loadout
// activity overlay). Per Clay: a mini-game event should show the viewer's
// real name, and fall back to their Twitch username when a Patreon / Discord
// name cannot be pulled.
//
// Priority:
//   1. Chosen Aquilo username  (pprofile:<id>.username)   the name they picked
//   2. Patreon display name    (patreon:tier:<id>.displayName / .name)
//   3. Discord display name     (guild member nick / global_name / username)
//   4. Twitch login (username)  (resolveTwitchLoginById, for tw:<id> viewers)
//   5. platform-provided hint   (panel body name / interaction username)
//   6. null  ->  the overlay then shows "A viewer"
//
// Identity shapes: website / Discord plays use the raw Discord snowflake;
// Twitch-panel plays use `tw:<numericTwitchId>` (see ext.js resolveLoadoutUserId).
// For panel identities we first map to a linked Discord id (plink/link:twitch)
// so a linked viewer still resolves via 1-3, and only fall to the raw Twitch
// login for unlinked viewers.
//
// Results are cached in KV (disp:<userId>) so the game hot path does not
// re-fetch on every play. A short negative cache avoids refetch storms while
// still letting a later account-link upgrade the name within minutes.

import { resolveTwitchLoginById } from './ext-loadout.js';

const NAME_TTL = 6 * 60 * 60;   // 6h for a resolved name
const MISS_TTL = 10 * 60;       // 10m negative cache
const MISS = '(none)';          // sentinel: "looked up, found nothing"

function clean(s) {
  const t = String(s == null ? '' : s).trim().slice(0, 40);
  return t || null;
}
async function kvJson(env, key) {
  try { return await env.LOADOUT_BOLTS.get(key, { type: 'json' }); } catch { return null; }
}
async function kvText(env, key) {
  try { return await env.LOADOUT_BOLTS.get(key); } catch { return null; }
}

// Discord guild-member display name, best-effort.
async function discordName(env, guildId, discordId) {
  if (!guildId || !discordId || !env.DISCORD_BOT_TOKEN) return null;
  try {
    const r = await fetch(
      `https://discord.com/api/v10/guilds/${guildId}/members/${discordId}`,
      { headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'User-Agent': 'loadout-discord activity-name' } });
    if (!r.ok) return null;
    const m = await r.json();
    const u = m.user || {};
    return clean(m.nick || u.global_name || u.username);
  } catch { return null; }
}

export async function resolveActorName(env, guildId, userId, hint) {
  if (!env || !env.LOADOUT_BOLTS || !userId) return clean(hint);
  const uid = String(userId);
  const ck = 'disp:' + uid;

  const cached = await kvText(env, ck);
  if (cached) return cached === MISS ? clean(hint) : cached;

  // Map a tw:<id> panel identity to its linked Discord id (if any).
  let twId = null, discordId = null;
  if (uid.startsWith('tw:')) {
    twId = uid.slice(3);
    discordId = (await kvText(env, `plink:twitch:${twId}`)) || (await kvText(env, `link:twitch:${twId}`)) || null;
  } else if (/^\d{5,25}$/.test(uid)) {
    discordId = uid;
  }

  let name = null;

  // 1. Chosen Aquilo username (raw id first, then the linked Discord id).
  for (const key of [uid, discordId].filter(Boolean)) {
    const p = await kvJson(env, `pprofile:${key}`);
    if (p && p.username) { name = clean(p.username); if (name) break; }
  }
  // 2. Patreon display name.
  if (!name) {
    for (const key of [discordId, uid].filter(Boolean)) {
      const rec = await kvJson(env, `patreon:tier:${key}`);
      if (rec) { name = clean(rec.displayName || rec.name); if (name) break; }
    }
  }
  // 3. Discord display name.
  if (!name && discordId) name = await discordName(env, guildId, discordId);
  // 4. Twitch login (unlinked panel viewer).
  if (!name && twId) { try { name = clean(await resolveTwitchLoginById(env, twId)); } catch { /* ignore */ } }
  // 5. Platform-provided hint.
  if (!name) name = clean(hint);

  try {
    await env.LOADOUT_BOLTS.put(ck, name || MISS, { expirationTtl: name ? NAME_TTL : MISS_TTL });
  } catch { /* best-effort */ }
  return name;
}
