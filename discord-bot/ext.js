// Twitch extension backend, /ext/* routes.
//
// Serves the aquilo.gg Twitch Panel extension's Loadout UI. Every route
// is authenticated by the Twitch extension JWT (Authorization: Bearer)
// and channel-gated to Clay's Twitch channel, other channels get 403,
// so other Loadout streamers keep the OBS-overlay experience untouched.
//
// Config (Worker vars / secrets):
//   TWITCH_EXT_SECRET       secret, base64 extension secret (JWT key)
//   CLAY_TWITCH_CHANNEL_ID  var, Clay's numeric Twitch channel id
//   AQUILO_VAULT_GUILD_ID   var, Clay's Discord guild, reused as the
//                                    Loadout guild for his channel
//   RELAY_TOKEN             secret, shared token for the /relay/pending poll
// Until TWITCH_EXT_SECRET / CLAY_TWITCH_CHANNEL_ID are set every route
// returns 401/403, safe to deploy ahead of the Twitch app existing.
//
// Identity bridge: a Twitch viewer's Loadout records live under a `tw:`
// keyspace, wallet:<guild>:tw:<id>, d:hero:<guild>:tw:<id>, separate
// from Discord users (bare numeric ids) in the same guild, so the two
// never collide. FUTURE merge phase: a `link:tw:<twId>` -> discordId
// record will let resolveLoadoutUserId() resolve to the shared Discord
// id so one character drives both surfaces. B1 ships no merge UI, so
// this resolver is the single chokepoint the merge will hook into.

import { verifyTwitchExtJwt } from './auth.js';
import { handleRotation, ingestRotation } from './rotation.js';
import { recordStat, getRecap, isStreamLive } from './recap.js';
import { handleTier1 } from './ext-tier1.js';
import { handleEngage } from './ext-engage.js';
import { startPanelPatreonLink } from './ext-patreon-link.js';
import { handleExtMod } from './ext-mod.js';
// (Bolts economy sunset 2026-06: the Twitch-panel economy surfaces were
// unwired here — wallet/hero/daily/leaderboard (wallet.js, games.js,
// hero-state.js), the dungeon/minigame/duel DLL panel-bridge
// (ext-panelbridge.js), loot boxes (ext-lootbox.js), quick games
// (ext-quick.js), sports bets (ext-bets.js) and Boltbound (cards-web.js).
// The non-currency panel — check-in, recap, schedule, queues, VODs/goals/
// patron-corner, cheer emotes, mod tools, rotation, Patreon link — stays.)

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

export async function handleExt(req, env, ctx) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/ext\//, '').replace(/\/+$/, '');

  // --- auth: Twitch extension JWT ---
  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const payload = await verifyTwitchExtJwt(token, env.TWITCH_EXT_SECRET);
  if (!payload) return json({ error: 'unauthorized' }, 401);

  // --- per-streamer config (multi-tenant, BEFORE the Clay gate) ---
  // Every channel that installs the extension can configure its own panel
  // (which tabs show, whether song requests cost Bits). Read is open to any
  // authenticated viewer (the panel needs it to render); write is
  // broadcaster-only. Keyed by the JWT's channel_id, so it's per-streamer.
  if (route === 'config') {
    return await handleExtConfig(env, payload, req);
  }

  // --- channel gate: Clay's channel only (economy / games / rotation) ---
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
    // (Bolts economy sunset: the hero / wallet / daily / leaderboard /
    // dungeon / minigame / duel / lootbox / quick / bets / boltbound
    // panel routes were removed.)
    if (req.method === 'POST' && route === 'checkin') {
      return await extCheckin(env, guildId, userId, req);
    }
    if (req.method === 'GET' && route === 'checkin/card') {
      return await extCheckinCard(env, guildId, twId);
    }
    if (req.method === 'GET' && route === 'recap') return await extRecap(env, guildId, userId);
    if (req.method === 'GET' && route === 'schedule') {
      const { handleExtSchedule } = await import('./schedule.js');
      const payload2 = await handleExtSchedule(env, guildId);
      return json(payload2);
    }
    if (req.method === 'GET' && route === 'queues') {
      const { snapshotQueue } = await import('./queue.js');
      const date = url.searchParams.get('date') || null;
      const snap = await snapshotQueue(env, guildId, date);
      return json({ ok: true, ...snap });
    }
    if (route === 'vods' || route === 'goals' || route === 'patron-corner') {
      return await handleTier1(env, guildId, userId, route, req);
    }
    if (route === 'cheer') {
      return await handleEngage(env, guildId, userId, route, req);
    }
    if (req.method === 'GET' && route === 'patreon/link-start') {
      return await startPanelPatreonLink(env, payload, req);
    }
    if (route.indexOf('mod/') === 0) {
      return await handleExtMod(env, guildId, payload, req, ctx, route.slice(4));
    }
    if (route.indexOf('rotation/') === 0) {
      // The streamer's config decides whether song requests cost Bits.
      const cfg = await readExtConfig(env, String(payload.channel_id || ''));
      return await handleRotation(env, guildId, userId, route.slice(9), req, {
        forceBits: !!(cfg.songBits && cfg.songBits.enabled),
      });
    }
    // Shared cross-platform chat: mint a READ-ONLY viewer ticket for the
    // channel's WardenRoom (the same DO that merges Twitch/Kick/YouTube/
    // TikTok chat for the mod console). Gated on the streamer having
    // Aquilo's cross-platform chat ingestion on (warden:on) — off → the
    // panel shows a "not enabled yet" state, no ticket minted.
    if (req.method === 'GET' && route === 'chat/ticket') {
      return await handleChatTicket(env, payload, twId);
    }
    return json({ error: 'not-found' }, 404);
  } catch (e) {
    return json({ error: 'server', message: String((e && e.message) || e) }, 500);
  }
}

// ---- Relay queue --------------------------------------------------------
// GET /relay/pending, polled by a Streamer.bot action on Clay's PC, which
// republishes each trigger as a `checkin.shown` event on the local Aquilo
// Bus so the OBS check-in overlay plays. Gated by the RELAY_TOKEN shared
// secret (Streamer.bot is not a Twitch viewer, so no JWT). Returns and
// deletes the pending triggers, at-most-once delivery, single poller.
export async function handleRelay(req, env) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  if (path === '/relay/ingest') return ingestRotation(req, env);
  // (Bolts economy sunset: the /relay/dll-ingest + /relay/dll-pending
  // DLL panel-bridge relay routes were removed — ext-panelbridge.js
  // drove the dungeon/minigame game state.)
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
          : forParam === 'rotation-chat'
            ? 'relay:rotchat-'
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

// (Bolts economy sunset: extHero / extWallet / extDaily / extLeaderboard
// were removed — they exercised the deleted hero-state.js / wallet.js /
// games.js modules.)

// ── Per-streamer extension config (extcfg:<channelId>) ───────────────
// Keyed by the panel's channel id so every streamer configures their own.
// songBits.enabled → song requests always cost Bits (see rotation.js);
// tabs.<name>=0 hides that tab in the panel.
const EXTCFG_KEY = (ch) => 'extcfg:' + ch;
const EXTCFG_TABS = ['hangman', 'casino', 'blackjack', 'tanks', 'streaks', 'chat', 'mycard', 'doodle', 'songs', 'links'];
const DEFAULT_EXTCFG_TABS = EXTCFG_TABS.reduce((o, t) => { o[t] = 1; return o; }, {});

async function readExtConfig(env, channelId) {
  let saved = null;
  try { saved = await env.LOADOUT_BOLTS.get(EXTCFG_KEY(channelId), { type: 'json' }); } catch { /* default */ }
  const tabs = Object.assign({}, DEFAULT_EXTCFG_TABS);
  if (saved && saved.tabs && typeof saved.tabs === 'object') {
    EXTCFG_TABS.forEach((t) => { if (saved.tabs[t] === 0 || saved.tabs[t] === false) tabs[t] = 0; });
  }
  return {
    // Default: song requests cost Bits (the panel's requested behavior).
    songBits: { enabled: saved && saved.songBits ? saved.songBits.enabled !== false : true },
    tabs,
    updatedAt: (saved && saved.updatedAt) || 0,
  };
}

async function handleExtConfig(env, payload, req) {
  const channelId = String(payload.channel_id || '');
  if (!channelId) return json({ error: 'no-channel' }, 400);
  if (req.method === 'GET') {
    return json({ ok: true, config: await readExtConfig(env, channelId), canEdit: payload.role === 'broadcaster' });
  }
  if (req.method === 'POST') {
    if (payload.role !== 'broadcaster') return json({ ok: false, error: 'broadcaster-only' }, 403);
    let body = {};
    try { body = await req.json(); } catch { /* empty tolerated */ }
    const cur = await readExtConfig(env, channelId);
    const next = {
      songBits: { enabled: body.songBits && typeof body.songBits.enabled === 'boolean' ? body.songBits.enabled : cur.songBits.enabled },
      tabs: {},
      updatedAt: Date.now(),
    };
    const inTabs = (body.tabs && typeof body.tabs === 'object') ? body.tabs : cur.tabs;
    EXTCFG_TABS.forEach((t) => { next.tabs[t] = (inTabs[t] === 0 || inTabs[t] === false) ? 0 : 1; });
    try { await env.LOADOUT_BOLTS.put(EXTCFG_KEY(channelId), JSON.stringify(next)); } catch { return json({ ok: false, error: 'kv' }, 500); }
    return json({ ok: true, config: next });
  }
  return json({ ok: false, error: 'method' }, 405);
}

// GET /ext/chat/ticket — mint a read-only viewer ticket for the shared
// cross-platform chat feed (the channel's WardenRoom DO). The panel opens
// a WebSocket to /web/warden/room/ws with this ticket and receives only
// {t:'chat'} frames — never mod actions/audit. Returns { enabled:false }
// (no ticket) when the channel hasn't turned on Aquilo's chat ingestion,
// so the panel can show a graceful "not available yet" state.
async function handleChatTicket(env, payload, twId) {
  const streamerId = String(payload.channel_id || '');
  if (!streamerId) return json({ ok: false, error: 'no-channel' }, 400);
  let on = null;
  try { on = await env.LOADOUT_BOLTS.get('warden:on:' + streamerId); } catch { /* treat as off */ }
  if (!on) return json({ ok: true, enabled: false });
  const { mintRoomTicket } = await import('./warden-db.js');
  const ticket = await mintRoomTicket(env, streamerId, twId || 'viewer', '', 'viewer');
  if (!ticket) return json({ ok: true, enabled: false, reason: 'no-secret' });
  return json({
    ok: true,
    enabled: true,
    ticket,
    wsUrl: 'wss://loadout-discord.aquiloplays.workers.dev/web/warden/room/ws',
  });
}

// GET /ext/recap, rolling-window recap stats for the "Your last
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

// ---- Daily check-in -----------------------------------------------------
// Records a cloud check-in (count + streak + cooldown) and enqueues a relay
// trigger so the OBS overlay plays. Separate from the bolts `daily` claim, // check-in is the presence action; it does not award bolts here.

const CHECKIN_COOLDOWN_MS = 20 * 60 * 60 * 1000; // 20h
const CHECKIN_STREAK_WINDOW_MS = 48 * 60 * 60 * 1000;
const CHECKIN_KEY = (g, u) => `checkin:${g}:${u}`;

// GET /ext/checkin/card, the panel's mini preview of the viewer's saved
// STREAM check-in card (frame / badges / tagline + tier accent). The panel
// identity is tw:<twId>; the card config is Discord-keyed, so we resolve the
// Twitch→Discord link (plink:twitch:<twId>). Unlinked viewers get a prompt to
// link rather than a card. Read-only; entitlement-gated cosmetics resolved
// server-side so the preview reflects what would actually appear on stream.
async function extCheckinCard(env, guildId, twId) {
  let discordId = null;
  try { discordId = await env.LOADOUT_BOLTS.get(`plink:twitch:${twId}`); } catch { /* unlinked */ }
  if (!discordId) return json({ ok: true, linked: false, config: null });

  const { getCardConfig, resolveEntitlements, computeBadges, FRAMES, BADGES } =
    await import('./stream-checkin.js');
  const [config, viewer] = await Promise.all([
    getCardConfig(env, discordId),
    resolveEntitlements(env, guildId, discordId),
  ]);
  const earned = computeBadges(viewer);
  const frame = FRAMES.find((f) => f.id === config.frame) || FRAMES[0];
  const tierChip = (config.frame === 'patron' || viewer.patronTier)
    ? 'Patron'
    : (viewer.subTier >= 1 ? 'Tier ' + viewer.subTier : '');
  return json({
    ok: true,
    linked: true,
    accent: frame.accent,
    tierChip,
    config: {
      frame: config.frame,
      bg: config.bg,
      anim: config.anim,
      tagline: config.tagline || '',
      badges: (config.badges || []).map((id) => ({
        id, label: (BADGES.find((b) => b.id === id) || {}).label || id,
      })),
    },
    earnedCount: earned.length,
  });
}

// ASCII control characters (range 0x00-0x1f plus DEL 0x7f), stripped
// from viewer-supplied text so nothing can break the overlay markup.
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

// Small starter profanity list, matched whole-word, case-insensitive, and
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
    /* empty body is fine, a check-in with no message */
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

  // Streak-resolve. Default behavior: if since >= 48h the streak resets
  // to 1; otherwise it increments. Streak Freeze inserts itself BETWEEN
  // "miss detected" and "reset" -- if the user holds a stream freeze,
  // consume one and preserve the streak as if no miss occurred (still
  // increment by 1 for this check-in).
  let freezeConsumed = false;
  let freezeRemaining = 0;
  const wouldBreak = rec.lastCheckinUtc && since >= CHECKIN_STREAK_WINDOW_MS;
  if (wouldBreak) {
    try {
      const { consumeFreeze, getFreezes } = await import('./streak-freeze.js');
      const r = await consumeFreeze(env, guildId, userId, 'stream');
      if (r.consumed) {
        freezeConsumed = true;
        freezeRemaining = r.remaining;
        // Treat this as a continuous day: increment the existing streak.
        rec.streak = (rec.streak || 0) + 1;
      } else {
        const f = await getFreezes(env, guildId, userId);
        freezeRemaining = f.stream;
        rec.streak = 1;
      }
    } catch {
      // If the freeze module fails for any reason, fall back to the
      // pre-freeze behavior so a check-in never errors on the user.
      rec.streak = 1;
    }
  } else if (rec.lastCheckinUtc) {
    rec.streak = (rec.streak || 0) + 1;
  } else {
    rec.streak = 1;
  }
  rec.count = (rec.count || 0) + 1;
  rec.lastCheckinUtc = now;
  rec.name = name;
  await env.LOADOUT_BOLTS.put(key, JSON.stringify(rec));

  // PROGRESSION (P1), stream check-in XP. Dedup keyed by the UTC date
  // so multiple check-ins in the same window grant once.
  try {
    const { emitProgressionEvent } = await import('./progression/event-bus.js');
    const ymd = new Date(now).toISOString().slice(0, 10);
    await emitProgressionEvent(env, {
      kind: 'stream.checkin', userId, guildId,
      meta: { ymd, streak: rec.streak }, stableKeys: ['ymd'],
    });
  } catch { /* non-fatal */ }

  // Read freeze counts (if we didn't already during a miss) so the
  // panel can show "Stream Freeze: 2" alongside the streak number.
  if (!wouldBreak) {
    try {
      const { getFreezes } = await import('./streak-freeze.js');
      const f = await getFreezes(env, guildId, userId);
      freezeRemaining = f.stream;
    } catch { /* idle */ }
  }

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
    streakFreeze: {
      consumed: freezeConsumed,
      remaining: freezeRemaining,
    },
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
  // Drop Clay's accounts from the public board (excluded.js handles
  // the "is this Clay?" check uniformly across surfaces).
  const { isExcludedUserId } = await import('./excluded.js');
  const visible = all.filter((e) => !isExcludedUserId(env, e.userId));
  visible.sort((a, b) => (b.rec.count || 0) - (a.rec.count || 0));

  const top = visible.slice(0, 10).map((e) => ({
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
