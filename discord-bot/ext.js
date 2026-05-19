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
//   RELAY_TOKEN             secret — shared token for the /relay/pending poll
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
import { handleRotation, ingestRotation } from './rotation.js';
import { handleLoadout } from './ext-loadout.js';
import { recordStat, getRecap, isStreamLive } from './recap.js';
import { handleTier1 } from './ext-tier1.js';
import { handleEngage } from './ext-engage.js';
import {
  ingestDllState,
  panelBridgeState,
  enqueuePanelCmd,
  drainDllCommands,
} from './ext-panelbridge.js';

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
    if (req.method === 'POST' && route === 'checkin') {
      return await extCheckin(env, guildId, userId, req);
    }
    if (req.method === 'GET' && route === 'leaderboard') {
      return await extLeaderboard(env, guildId, userId, url.searchParams.get('type'));
    }
    if (req.method === 'GET' && route === 'recap') return await extRecap(env, guildId, userId);
    if (route === 'vods' || route === 'goals' || route === 'patron-corner') {
      return await handleTier1(env, guildId, userId, route, req);
    }
    if (route === 'cheer') {
      return await handleEngage(env, guildId, userId, route, req);
    }
    if (route === 'dungeon/state') return await panelBridgeState(env, 'dungeon');
    if (route === 'minigame/state') return await panelBridgeState(env, 'minigame');
    if (req.method === 'POST' && route === 'dungeon/cmd') {
      return await enqueuePanelCmd(env, 'dungeon', payload, req);
    }
    if (req.method === 'POST' && route === 'minigame/cmd') {
      return await enqueuePanelCmd(env, 'minigame', payload, req);
    }
    if (route.indexOf('rotation/') === 0) {
      return await handleRotation(env, guildId, userId, route.slice(9), req);
    }
    if (route.indexOf('loadout/') === 0) {
      return await handleLoadout(env, guildId, userId, route.slice(8), req);
    }
    return json({ error: 'not-found' }, 404);
  } catch (e) {
    return json({ error: 'server', message: String((e && e.message) || e) }, 500);
  }
}

// ---- Relay queue --------------------------------------------------------
// GET /relay/pending — polled by a Streamer.bot action on Clay's PC, which
// republishes each trigger as a `checkin.shown` event on the local Aquilo
// Bus so the OBS check-in overlay plays. Gated by the RELAY_TOKEN shared
// secret (Streamer.bot is not a Twitch viewer, so no JWT). Returns and
// deletes the pending triggers — at-most-once delivery, single poller.
export async function handleRelay(req, env) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  if (path === '/relay/ingest') return ingestRotation(req, env);
  if (path === '/relay/dll-ingest') return ingestDllState(req, env);
  if (path === '/relay/dll-pending') return drainDllCommands(req, env);
  if (path !== '/relay/pending') {
    return json({ error: 'not-found' }, 404);
  }
  if (req.method !== 'GET') return json({ error: 'method' }, 405);
  const token = req.headers.get('X-Relay-Token') || '';
  if (!env.RELAY_TOKEN || token !== env.RELAY_TOKEN) {
    return json({ error: 'unauthorized' }, 401);
  }
  // ?for= scopes the drain so the check-in Streamer.bot poller and the
  // Rotation widget poller never race for each other's triggers.
  // Absent / unknown -> drain nothing (safe default).
  const forParam = url.searchParams.get('for');
  const prefix =
    forParam === 'checkin'
      ? 'relay:checkin:'
      : forParam === 'overlay'
        ? 'relay:overlay-'
        : forParam === 'rotation'
          ? 'relay:rotation-'
          : null;
  if (!prefix) return json({ triggers: [] });
  const list = await env.LOADOUT_BOLTS.list({ prefix });
  const triggers = [];
  for (const k of list.keys) {
    const v = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
    if (v) triggers.push(v);
    await env.LOADOUT_BOLTS.delete(k.name);
  }
  return json({ triggers });
}

async function extHero(env, guildId, userId) {
  const hero = await loadHero(env, guildId, userId);
  const cls = CLASSES[hero.className] || null;

  // Resolve equipped slot -> item id into display name + glyph via the bag.
  const bagById = {};
  for (const it of hero.bag || []) bagById[it.id] = it;
  const equipped = [];
  for (const [slot, id] of Object.entries(hero.equipped || {})) {
    const it = bagById[id];
    equipped.push({ slot, name: it ? it.name : String(id), glyph: it ? it.glyph || '' : '' });
  }

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
      equipped,
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
  if (result && result.won) {
    await recordStat(env, guildId, userId, { bolts_earned: result.payout || 0 });
  }
  const w = await getWallet(env, guildId, userId);
  return json({ result, balance: w.balance || 0 });
}

// GET /ext/recap — rolling-window recap stats for the "Your last
// session" panel card. isLiveNow gates the card (hidden while live).
async function extRecap(env, guildId, userId) {
  const recap = await getRecap(env, guildId, userId);
  const live = await isStreamLive(env);
  let streak = 0;
  try {
    const ci = await env.LOADOUT_BOLTS.get(`checkin:${guildId}:${userId}`, { type: 'json' });
    if (ci) streak = ci.streak || 0;
  } catch {
    /* streak is best-effort */
  }
  return json({
    isLiveNow: live,
    windowStart: recap.windowStart,
    streak,
    stats: recap.stats,
  });
}

async function extLeaderboard(env, guildId, userId, type) {
  if (type === 'checkin') return extCheckinLeaderboard(env, guildId, userId);

  // type=bolts (default) — rank by wallet balance.
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
  return json({ type: 'bolts', top, you: { rank: youRank, balance: youBalance } });
}

// ---- Daily check-in -----------------------------------------------------
// Records a cloud check-in (count + streak + cooldown) and enqueues a relay
// trigger so the OBS overlay plays. Separate from the bolts `daily` claim —
// check-in is the presence action; it does not award bolts here.

const CHECKIN_COOLDOWN_MS = 20 * 60 * 60 * 1000; // 20h
const CHECKIN_STREAK_WINDOW_MS = 48 * 60 * 60 * 1000;
const CHECKIN_KEY = (g, u) => `checkin:${g}:${u}`;

// ASCII control characters (range 0x00-0x1f plus DEL 0x7f) — stripped
// from viewer-supplied text so nothing can break the overlay markup.
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

// Small starter profanity list — matched whole-word, case-insensitive, and
// masked (not rejected) so the viewer still gets their check-in. Clay's
// mods are the real backstop.
const PROFANITY = [
  'fuck', 'shit', 'bitch', 'cunt', 'asshole', 'dick', 'piss', 'bastard',
  'slut', 'whore', 'nigger', 'nigga', 'faggot', 'retard', 'rape',
];

function maskProfanity(text) {
  let out = text;
  for (const w of PROFANITY) {
    out = out.replace(new RegExp('\\b' + w + 's?\\b', 'gi'), (m) => '*'.repeat(m.length));
  }
  return out;
}

function cleanMessage(raw) {
  let m = String(raw || '');
  m = m.replace(/[<>]/g, '');
  m = m.replace(CONTROL_CHARS, ' ');
  m = m.replace(/\s+/g, ' ').trim().slice(0, 120);
  return maskProfanity(m);
}

function cleanName(raw) {
  return String(raw || '')
    .replace(/[<>]/g, '')
    .replace(CONTROL_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

async function extCheckin(env, guildId, userId, req) {
  let body = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine — a check-in with no message */
  }

  const key = CHECKIN_KEY(guildId, userId);
  const rec = (await env.LOADOUT_BOLTS.get(key, { type: 'json' })) || {
    count: 0,
    streak: 0,
    lastCheckinUtc: 0,
    name: '',
  };
  const now = Date.now();
  const since = now - (rec.lastCheckinUtc || 0);
  if (rec.lastCheckinUtc && since < CHECKIN_COOLDOWN_MS) {
    return json({ error: 'cooldown', cooldownMs: CHECKIN_COOLDOWN_MS - since }, 429);
  }

  const name = cleanName(body.displayName) || 'Anonymous viewer';
  const message = cleanMessage(body.message);

  rec.count = (rec.count || 0) + 1;
  rec.streak =
    rec.lastCheckinUtc && since < CHECKIN_STREAK_WINDOW_MS ? (rec.streak || 0) + 1 : 1;
  rec.lastCheckinUtc = now;
  rec.name = name;
  await env.LOADOUT_BOLTS.put(key, JSON.stringify(rec));

  // Enqueue the overlay trigger. A Streamer.bot action polls /relay/pending
  // and republishes this as a `checkin.shown` bus event; `source:"extension"`
  // is what the DLL's BoltsModule guard keys off to skip a double credit.
  await env.LOADOUT_BOLTS.put(
    `relay:overlay-${crypto.randomUUID()}`,
    JSON.stringify({
      type: 'checkin',
      bus_kind: 'checkin.shown',
      user: name,
      message,
      source: 'extension',
      role: 'viewer',
      platform: 'twitch',
      ts: now,
    }),
    { expirationTtl: 300 },
  );

  await recordStat(env, guildId, userId, { checkins: 1 });
  return json({
    ok: true,
    count: rec.count,
    streak: rec.streak,
    cooldownMs: CHECKIN_COOLDOWN_MS,
  });
}

async function extCheckinLeaderboard(env, guildId, userId) {
  const prefix = `checkin:${guildId}:`;
  const list = await env.LOADOUT_BOLTS.list({ prefix });
  const all = [];
  for (const k of list.keys) {
    const rec = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
    if (rec) all.push({ userId: k.name.slice(prefix.length), rec });
  }
  all.sort((a, b) => (b.rec.count || 0) - (a.rec.count || 0));

  const top = all.slice(0, 10).map((e) => ({
    name: e.rec.name || 'Anonymous viewer',
    count: e.rec.count || 0,
    streak: e.rec.streak || 0,
  }));

  let you = { rank: 0, count: 0, streak: 0 };
  const idx = all.findIndex((e) => e.userId === userId);
  if (idx >= 0) {
    you = {
      rank: idx + 1,
      count: all[idx].rec.count || 0,
      streak: all[idx].rec.streak || 0,
    };
  }
  return json({ type: 'checkin', top, you });
}
