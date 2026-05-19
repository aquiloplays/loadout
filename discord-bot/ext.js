// Twitch extension backend — /ext/* routes.
//
// Serves the aquilo.gg Twitch Panel extension's Loadout UI. Every route
// is authenticated by the Twitch extension JWT (Authorization: Bearer)
// and channel-gated to Clay's Twitch channel — other channels get 403,
// so other Loadout streamers keep the OBS-overlay experience untouched.
//
// Config (Worker vars / secrets):
//   TWITCH_EXT_SECRET       secret — base64 extension secret (JWT key)
//   CLAY_TWITCH_CHANNEL_ID  var    — Clay's numeric Twitch channel id
//   AQUILO_VAULT_GUILD_ID   var    — Clay's Discord guild, reused as the
//                                    Loadout guild for his channel
// Until TWITCH_EXT_SECRET / CLAY_TWITCH_CHANNEL_ID are set every route
// returns 401/403 — safe to deploy ahead of the Twitch app existing.
//
// Identity bridge: a Twitch viewer's Loadout records live under a `tw:`
// keyspace — wallet:<guild>:tw:<id>, d:hero:<guild>:tw:<id> — separate
// from Discord users (bare numeric ids) in the same guild, so the two
// never collide. FUTURE merge phase: a `link:tw:<twId>` -> discordId
// record will let resolveLoadoutUserId() resolve to the shared Discord
// id so one character drives both surfaces. B1 ships no merge UI, so
// this resolver is the single chokepoint the merge will hook into.

import { verifyTwitchExtJwt } from './auth.js';
import { getWallet, leaderboard } from './wallet.js';
import { daily } from './games.js';
import { loadHero, attackOf, defenseOf, CLASSES } from './dungeon.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS },
  });
}

function resolveLoadoutUserId(twId) {
  return 'tw:' + twId;
}

export async function handleExt(req, env) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/ext\//, '').replace(/\/+$/, '');

  // --- auth: Twitch extension JWT ---
  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const payload = await verifyTwitchExtJwt(token, env.TWITCH_EXT_SECRET);
  if (!payload) return json({ error: 'unauthorized' }, 401);

  // --- channel gate: Clay's channel only ---
  const clayChannel = env.CLAY_TWITCH_CHANNEL_ID;
  if (!clayChannel || String(payload.channel_id) !== String(clayChannel)) {
    return json({ error: 'forbidden' }, 403);
  }

  const guildId = env.AQUILO_VAULT_GUILD_ID;
  if (!guildId) return json({ error: 'not-configured' }, 503);
  const twId = String(payload.user_id || payload.opaque_user_id || '');
  if (!twId) return json({ error: 'no-identity' }, 400);
  const userId = resolveLoadoutUserId(twId);

  try {
    if (req.method === 'GET' && route === 'hero') return await extHero(env, guildId, userId);
    if (req.method === 'GET' && route === 'wallet') return await extWallet(env, guildId, userId);
    if (req.method === 'POST' && route === 'daily') return await extDaily(env, guildId, userId);
    if (req.method === 'GET' && route === 'leaderboard') {
      return await extLeaderboard(env, guildId, userId);
    }
    return json({ error: 'not-found' }, 404);
  } catch (e) {
    return json({ error: 'server', message: String((e && e.message) || e) }, 500);
  }
}

async function extHero(env, guildId, userId) {
  const hero = await loadHero(env, guildId, userId);
  const cls = CLASSES[hero.className] || null;
  return json({
    hero: {
      className: hero.className || '',
      classMeta: cls ? { name: cls.name, glyph: cls.glyph } : null,
      level: hero.level || 1,
      xp: hero.xp || 0,
      hpMax: hero.hpMax || 0,
      hpCurrent: hero.hpCurrent || 0,
      atk: attackOf(hero),
      def: defenseOf(hero),
      equipped: hero.equipped || {},
      bagCount: (hero.bag || []).length,
      dungeonsSurvived: hero.dungeonsSurvived || 0,
      bossesSlain: hero.bossesSlain || 0,
    },
  });
}

async function extWallet(env, guildId, userId) {
  const w = await getWallet(env, guildId, userId);
  return json({
    wallet: {
      balance: w.balance || 0,
      lifetimeEarned: w.lifetimeEarned || 0,
      dailyStreak: w.dailyStreak || 0,
      lastDailyUtc: w.lastDailyUtc || 0,
    },
  });
}

async function extDaily(env, guildId, userId) {
  const result = await daily(env, guildId, userId);
  const w = await getWallet(env, guildId, userId);
  return json({ result, balance: w.balance || 0 });
}

async function extLeaderboard(env, guildId, userId) {
  // Big limit: leaderboard() lists every wallet key regardless, so the
  // limit only sizes the returned slice — 5000 makes the caller's rank
  // accurate without extra KV reads.
  const all = await leaderboard(env, guildId, 5000);

  // Public top list: only entries with a linked public handle — mirrors
  // the privacy rule of the existing /leaderboard/:guildId route.
  const top = [];
  for (const e of all) {
    if (top.length >= 10) break;
    const handle = ((e.w.links || [])[0] || {}).username;
    if (handle) top.push({ name: handle, balance: e.w.balance || 0 });
  }

  let youRank = 0;
  let youBalance = 0;
  const idx = all.findIndex((e) => e.userId === userId);
  if (idx >= 0) {
    youRank = idx + 1;
    youBalance = all[idx].w.balance || 0;
  }
  return json({ top, you: { rank: youRank, balance: youBalance } });
}
