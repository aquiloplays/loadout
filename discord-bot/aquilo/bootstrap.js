// Idempotent guild bootstrap. Resolves guild_id from SCHEDULE_CHANNEL_ID
// (cached in KV), then ensures the 8 community-night games are seeded with
// cover art for that guild. Safe to call from any handler/cron.
//
// Cover art URLs were sourced from Steam's hashed asset CDN where the game
// is on Steam. Minecraft (not on Steam) falls back to a Wikimedia PNG of
// the cube logo.

import { discordFetch } from './util.js';

const KV_GUILD_ID = 'guild_id';

const DEFAULT_GAMES = [
  { name: 'MIMESIS',                  art_url: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2827200/8a2a6edc97fbf23ea6941974bdf4ed9a6ab34eb4/header.jpg' },
  { name: 'RV There Yet?',            art_url: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3949040/cae24b4ed7f4531be51f0d63f785b7d253f92dc3/header.jpg' },
  { name: 'Lethal Company',           art_url: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1966720/header.jpg' },
  { name: 'R.E.P.O.',                 art_url: 'https://cdn.cloudflare.steamstatic.com/steam/apps/3241660/header.jpg' },
  { name: 'Pratfall',                 art_url: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/4244510/aa5134d11626034935daa974478c834d03d73f54/header.jpg' },
  { name: 'PEAK',                     art_url: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3527290/31bac6b2eccf09b368f5e95ce510bae2baf3cfcd/header.jpg' },
  { name: 'Super Battle Golf',        art_url: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/4069520/2d9b9b6bc0ac18c6eb76f5e38b649425d9202759/header_alt_assets_0.jpg' },
  { name: 'Content Warning',          art_url: 'https://cdn.cloudflare.steamstatic.com/steam/apps/2881650/header.jpg' },
  // Added in v3 of the bootstrap seed.
  { name: 'Roadside Research',        art_url: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3643170/e8707becb09bab0865bb3441968ee41694e9b83e/header_alt_assets_0.jpg' },
  { name: 'The Headliners',           art_url: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3059070/62f137f87bbbe03ff34fe64f79aec4059532e849/header.jpg' },
  { name: 'Gamble With Your Friends', art_url: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3892270/395e6d7972474333a698b26f8aa5597bf38109a1/header.jpg' },
  { name: 'LOCKDOWN Protocol',        art_url: 'https://cdn.cloudflare.steamstatic.com/steam/apps/2780980/header.jpg' },
  { name: 'Slay the Spire 2',         art_url: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2868840/b0958d387dc366211e0f353443710cfcf9fdb020/header.jpg' },
  // Added in v4 of the bootstrap seed — Clay's expanded community-night
  // rotation. MIMESIS was already in v1 so not duplicated here.
  // Fortnite is Epic-exclusive, no Steam header — art_url left null
  // (downstream renderers handle null cover gracefully).
  { name: 'Dead by Daylight',         art_url: 'https://cdn.cloudflare.steamstatic.com/steam/apps/381210/header.jpg' },
  { name: 'Fortnite',                 art_url: null },
  { name: 'Among Us',                 art_url: 'https://cdn.cloudflare.steamstatic.com/steam/apps/945360/header.jpg' },
  { name: 'Phasmophobia',             art_url: 'https://cdn.cloudflare.steamstatic.com/steam/apps/739630/header.jpg' }
];

// PNG render of the official Minecraft cube logo (Wikimedia Commons,
// CC-BY-SA). Discord doesn't render SVG embeds so we use the PNG thumb.
export const MINECRAFT_ART = 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d8/Minecraft_cube.svg/512px-Minecraft_cube.svg.png';

export async function getGuildId(env) {
  // /setup wizard's "Activate this server" button sets this; it takes
  // priority over any cached or env-derived value so a streamer can
  // re-point cron at a fresh server without redeploying.
  const active = await env.STATE.get('config:active_guild_id');
  if (active) return active;

  let gid = await env.STATE.get(KV_GUILD_ID);
  if (gid) return gid;
  if (!env.SCHEDULE_CHANNEL_ID) throw new Error('SCHEDULE_CHANNEL_ID not configured');
  // Bot must be in the guild for this to succeed (otherwise 404/403).
  const ch = await discordFetch(env, '/channels/' + encodeURIComponent(env.SCHEDULE_CHANNEL_ID));
  gid = ch?.guild_id;
  if (!gid) throw new Error('Could not resolve guild_id from SCHEDULE_CHANNEL_ID');
  await env.STATE.put(KV_GUILD_ID, gid);
  return gid;
}

// Idempotent: ensures the default games exist for this guild. Updates
// art_url only if currently NULL (preserves any user-edited art).
//
// Short-circuits on a KV flag after the first successful run so hot-path
// callers (vote/queue button clicks) only pay 2 KV reads instead of
// 13 D1 INSERTs each interaction.
//
// Bump this key whenever DEFAULT_GAMES grows so the new entries get
// inserted on next interaction (existing rows ON CONFLICT no-op).
const KV_BOOTSTRAPPED = 'bootstrapped:v4';

export async function ensureBootstrap(env) {
  const guildId = await getGuildId(env);
  const done = await env.STATE.get(KV_BOOTSTRAPPED);
  if (done) return guildId;
  for (const g of DEFAULT_GAMES) {
    await env.DB.prepare(
      `INSERT INTO games (guild_id, name, art_url)
       VALUES (?, ?, ?)
       ON CONFLICT (guild_id, name) DO UPDATE SET
         art_url = COALESCE(games.art_url, excluded.art_url)`
    ).bind(guildId, g.name, g.art_url).run();
  }
  await env.STATE.put(KV_BOOTSTRAPPED, '1');
  return guildId;
}

// Read parsed eligible-roles config (ordered by tier, first = highest).
// Returns array of role IDs.
export function getEligibleRoles(env) {
  if (!env.QUEUE_ELIGIBLE_ROLES_JSON) return [];
  try {
    const arr = JSON.parse(env.QUEUE_ELIGIBLE_ROLES_JSON);
    return Array.isArray(arr) ? arr.filter(r => typeof r === 'string') : [];
  } catch { return []; }
}
