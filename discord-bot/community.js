// Community endpoints — username + gamertags + guild channels + members.
//
// HMAC-gated like the rest of /web/*. Aquilo-site's Pages Functions
// hit these to power the supporter wall, profile-edit form, board-
// game invite picker, and admin "bind a channel" dropdowns.
//
// All routes share the same auth helper (gateHmac) defined in
// progression/http.js — we re-implement a tiny version here so this
// module doesn't pull in the progression dependency graph on cold
// start of unrelated requests.

import { verifyHmac } from './auth.js';

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
      ...extra,
    },
  });
}

// HMAC verify against AQUILO_SITE_WEB_SECRET (same secret the rest of
// /web/* uses). Returns { ok, body } where body is the parsed JSON.
async function gateHmac(req, env) {
  if (!env.AQUILO_SITE_WEB_SECRET) {
    return { ok: false, status: 503, error: 'AQUILO_SITE_WEB_SECRET missing' };
  }
  const bodyText = req.method === 'POST' ? await req.text() : '';
  const ts = req.headers.get('x-aquilo-web-ts');
  const sig = req.headers.get('x-aquilo-web-sig');
  const ok = await verifyHmac(env.AQUILO_SITE_WEB_SECRET, ts || '', bodyText, sig || '');
  if (!ok) return { ok: false, status: 401, error: 'unauthorized' };
  let body = {};
  if (bodyText) {
    try { body = JSON.parse(bodyText); }
    catch { return { ok: false, status: 400, error: 'bad-json' }; }
  }
  return { ok: true, body };
}

// ── B1: Username ────────────────────────────────────────────────────
//
// The aquilo.gg display name. Set when a user links their Patreon, used
// on the supporter wall instead of the Patreon real-name. Stored on
// pprofile.username (separate field from .displayName which is the
// auto-generated "Player NNNN" fallback so we can show ownership of
// the chosen handle in the UI).
//
// Routes:
//   GET  /web/community/username/<userId>   public — returns { username }
//   POST /web/community/username            HMAC  — { userId, username } sets it
//
// Username rules: 3-24 chars, alphanumeric + underscore + dash, case-
// insensitive unique. The supporter-wall feeder reads pprofile.username
// when present, falls back to the linked Patreon display name when not.

export async function handleUsername(req, env, path) {
  const { getProfile, putProfile, reserveHandle } = await import('./progression/profile.js');
  const parts = path.split('/').filter(Boolean);   // ['web','community','username',userId?]
  const userIdFromPath = parts[3] || null;

  if (req.method === 'GET' && userIdFromPath) {
    const p = await getProfile(env, userIdFromPath);
    return json({ userId: userIdFromPath, username: p.username || null });
  }
  if (req.method === 'POST') {
    const gate = await gateHmac(req, env);
    if (!gate.ok) return json({ error: gate.error }, gate.status);
    const userId = String(gate.body.userId || '').trim();
    const username = String(gate.body.username || '').trim();
    if (!/^\d{5,25}$/.test(userId)) return json({ error: 'bad-user-id' }, 400);
    if (!/^[A-Za-z0-9_-]{3,24}$/.test(username)) {
      return json({ error: 'bad-username', message: '3-24 chars, alphanumeric + - or _' }, 400);
    }
    // Uniqueness via reserveHandle (writes pprofile:handle:<safe>).
    const reserve = await reserveHandle(env, userId, username);
    if (!reserve.ok) return json(reserve, reserve.error === 'taken' ? 409 : 400);
    const p = await getProfile(env, userId);
    p.username = username;
    await putProfile(env, userId, p);
    return json({ ok: true, username, userId });
  }
  return json({ error: 'method' }, 405);
}

// ── B2: Gamertags ───────────────────────────────────────────────────
//
// pgamertags:<userId>  { steam: {id, visible}, xbox: {id, visible},
//                        psn: {id, visible}, epic: {id, visible} }
//
// Per-platform manual ID + a visibility flag. Visible-only is returned
// from the public GET; the owner endpoint (HMAC) returns all.
//
// Sits alongside pprofile.linkedAccounts (which holds OAuth-verified
// accounts used for friending). Gamertags are user-controlled display
// IDs — the user types them and chooses what to show publicly. Some
// platforms (Steam, Epic) end up with both records; that's fine, they
// serve different needs.

const GAMERTAG_KEY = (userId) => `pgamertags:${userId}`;
const GAMERTAG_PLATFORMS = ['steam', 'xbox', 'psn', 'epic'];

function freshGamertags() {
  return {
    steam: { id: '', visible: false },
    xbox:  { id: '', visible: false },
    psn:   { id: '', visible: false },
    epic:  { id: '', visible: false },
  };
}

async function getGamertags(env, userId) {
  const raw = await env.LOADOUT_BOLTS.get(GAMERTAG_KEY(userId), { type: 'json' });
  if (!raw) return freshGamertags();
  return { ...freshGamertags(), ...raw };
}

export async function handleGamertags(req, env, path) {
  const parts = path.split('/').filter(Boolean);   // ['web','gamertags','<userId>'|'me']
  const tail = parts[2] || null;

  if (req.method === 'GET' && tail && tail !== 'me') {
    // Public view — visible-only fields.
    const rec = await getGamertags(env, tail);
    const out = {};
    for (const p of GAMERTAG_PLATFORMS) {
      if (rec[p]?.visible && rec[p].id) out[p] = rec[p].id;
    }
    return json({ userId: tail, gamertags: out });
  }
  if (req.method === 'GET' && tail === 'me') {
    // Owner view — all fields + visibility flags. Caller passes
    // ?userId=... since this endpoint is HMAC-gated on the website
    // side already.
    const gate = await gateHmac(req, env);
    if (!gate.ok) return json({ error: gate.error }, gate.status);
    const url = new URL(req.url);
    const userId = url.searchParams.get('userId') || gate.body.userId;
    if (!userId) return json({ error: 'userId required' }, 400);
    const rec = await getGamertags(env, userId);
    return json({ userId, gamertags: rec });
  }
  if (req.method === 'POST' && tail === 'me') {
    const gate = await gateHmac(req, env);
    if (!gate.ok) return json({ error: gate.error }, gate.status);
    const userId = String(gate.body.userId || '').trim();
    if (!/^\d{5,25}$/.test(userId)) return json({ error: 'bad-user-id' }, 400);
    const rec = await getGamertags(env, userId);
    // Patch the requested platforms only — caller can update one at a
    // time without clobbering the others.
    const patch = gate.body.gamertags || {};
    for (const platform of GAMERTAG_PLATFORMS) {
      if (!patch[platform]) continue;
      const id = String(patch[platform].id || '').trim().slice(0, 64);
      const visible = !!patch[platform].visible;
      rec[platform] = { id, visible };
    }
    await env.LOADOUT_BOLTS.put(GAMERTAG_KEY(userId), JSON.stringify(rec));
    return json({ ok: true, userId, gamertags: rec });
  }
  return json({ error: 'method' }, 405);
}

// ── B3: GET guild channels ─────────────────────────────────────────
//
// Returns the Discord guild's text channels for the admin "binding"
// dropdown on aquilo.gg. Requires a valid DISCORD_BOT_TOKEN — if the
// token is missing/invalid, returns { channels: [], warning: '...' }
// so the UI can show a "token's not set up yet" hint instead of
// breaking.
//
// Caches per-guild for 5 minutes — Discord rate-limits this endpoint
// at ~50 reqs/minute per bot, and the dropdown won't change every
// click.

const CHANNELS_CACHE_TTL = 5 * 60;

export async function handleGuildChannels(req, env, path) {
  // path: /web/guild/<guildId>/channels
  const m = path.match(/^\/web\/guild\/(\d+)\/channels\/?$/);
  if (!m) return json({ error: 'bad-path' }, 400);
  const guildId = m[1];

  const gate = await gateHmac(req, env);
  if (!gate.ok) return json({ error: gate.error }, gate.status);

  // Cache hit?
  const cacheKey = `cache:guildchannels:${guildId}`;
  try {
    const cached = await env.LOADOUT_BOLTS.get(cacheKey, { type: 'json' });
    if (cached) return json({ ...cached, cached: true });
  } catch { /* miss */ }

  if (!env.DISCORD_BOT_TOKEN) {
    return json({
      guildId, channels: [],
      warning: 'DISCORD_BOT_TOKEN not configured on the worker. Set it via `wrangler secret put DISCORD_BOT_TOKEN`.',
    });
  }
  // Discord REST.
  try {
    const r = await fetch(`https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/channels`, {
      headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}` },
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return json({
        guildId, channels: [],
        warning: `Discord rejected the request (${r.status}). The bot may not be in this guild, or DISCORD_BOT_TOKEN is invalid.`,
        detail: txt.slice(0, 200),
      });
    }
    const all = await r.json();
    // Discord channel types: 0=GUILD_TEXT, 4=GUILD_CATEGORY, 5=GUILD_ANNOUNCEMENT,
    // 15=FORUM. We return text + announcement + forum (anything writable for
    // bindings).
    const out = (Array.isArray(all) ? all : []).filter(c => [0, 5, 15].includes(c.type))
      .map(c => ({ id: c.id, name: c.name, type: c.type, position: c.position, parentId: c.parent_id || null }))
      .sort((a, b) => (a.position || 0) - (b.position || 0));
    const payload = { guildId, channels: out };
    try { await env.LOADOUT_BOLTS.put(cacheKey, JSON.stringify(payload), { expirationTtl: CHANNELS_CACHE_TTL }); }
    catch { /* cache failure non-fatal */ }
    return json(payload);
  } catch (e) {
    return json({
      guildId, channels: [],
      warning: 'Channel fetch failed: ' + String(e && e.message || e),
    });
  }
}

// ── B4: Members list ───────────────────────────────────────────────
//
// Walks pprofile:* to return community members (display name + userId
// + username + verified-account count) so the board-game invite UI on
// aquilo.gg can show a picker instead of a raw Discord-ID text field.
//
// Capped at 200 per page. Optional ?search= filter on displayName +
// username substring. ?since=<utcMs> for incremental refresh.

export async function handleMembers(req, env, path) {
  const gate = await gateHmac(req, env);
  if (!gate.ok) return json({ error: gate.error }, gate.status);
  const url = new URL(req.url);
  const search = (url.searchParams.get('search') || '').toLowerCase().trim();
  const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
  const limit = Math.min(200, parseInt(url.searchParams.get('limit') || '100', 10) || 100);
  const guildId = String(url.searchParams.get('guildId') || url.searchParams.get('guild_id') || '');
  if (!/^\d{5,25}$/.test(guildId)) {
    return json({ error: 'guildId required', message: 'pass ?guildId=<id> to scope members to a guild' }, 400);
  }

  // Multi-tenancy: only enumerate users who have a wallet in THIS
  // guild. `pprofile:*` is account-wide (Patreon is a cross-guild
  // user property), so without this filter a streamer-A admin would
  // see every linked user in any other guild served by the same
  // worker. Walk wallet:<guildId>:* first to derive the membership
  // set, then resolve each to a pprofile.
  const walletPrefix = `wallet:${guildId}:`;
  const guildUserIds = new Set();
  let wcursor;
  for (let i = 0; i < 5; i++) {
    const r = await env.LOADOUT_BOLTS.list({ prefix: walletPrefix, cursor: wcursor, limit: 1000 });
    for (const k of r.keys) guildUserIds.add(k.name.slice(walletPrefix.length));
    if (r.list_complete || !r.cursor) break;
    wcursor = r.cursor;
  }

  const out = [];
  let scanned = 0;
  for (const userId of guildUserIds) {
    scanned++;
    const p = await env.LOADOUT_BOLTS.get(`pprofile:${userId}`, { type: 'json' });
    if (!p) continue;
    if (since && (p.lastSeenUtc || 0) < since) continue;
    const display = p.displayName || `Player ${userId.slice(-4)}`;
    const username = p.username || null;
    if (search) {
      const hay = (display + ' ' + (username || '')).toLowerCase();
      if (!hay.includes(search)) continue;
    }
    const linkedCount = Object.keys(p.linkedAccounts || {})
      .filter(plat => p.linkedAccounts[plat]?.id).length;
    out.push({
      userId,
      displayName: display,
      username,
      linkedCount,
      lastSeenUtc: p.lastSeenUtc || 0,
    });
    if (out.length >= limit) break;
  }
  out.sort((a, b) => (b.lastSeenUtc || 0) - (a.lastSeenUtc || 0));
  return json({ guildId, members: out, scanned, returned: out.length });
}

// ── Supporter-wall feeder (B1 integration) ─────────────────────────
//
// Aquilo-site's supporter wall hits this for the patron roster.
// We walk patreon:tier:<userId> records, resolve each one to a
// pprofile, and return their chosen `username` instead of the raw
// Patreon display name. If no username was set, we fall back to the
// Patreon record's stored name (Clay's instruction: "set when a user
// links their Patreon" — but historic links may not have one yet).
//
// Public read, no HMAC.

export async function handleSupporterWall(req, env, _path) {
  if (req.method !== 'GET') return json({ error: 'method' }, 405);
  const out = [];
  let cursor;
  for (let i = 0; i < 5; i++) {
    const r = await env.LOADOUT_BOLTS.list({ prefix: 'patreon:tier:', cursor, limit: 1000 });
    for (const k of r.keys) {
      const rec = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
      if (!rec) continue;
      const userId = k.name.slice('patreon:tier:'.length);
      // Pull username from pprofile (preferred), fall back to the
      // Patreon-stored display name (the raw real-name we DON'T want
      // to show if a username was set).
      let username = null;
      try {
        const p = await env.LOADOUT_BOLTS.get(`pprofile:${userId}`, { type: 'json' });
        if (p?.username) username = p.username;
      } catch { /* ignore */ }
      const display = username || rec.displayName || rec.name || `Supporter ${userId.slice(-4)}`;
      out.push({
        userId,
        displayName: display,
        usernameWasSet: !!username,
        linkedUtc: rec.linkedUtc || rec.linked_at || 0,
      });
    }
    if (r.list_complete) break;
    cursor = r.cursor;
  }
  // Newest first.
  out.sort((a, b) => (b.linkedUtc || 0) - (a.linkedUtc || 0));
  return json({ supporters: out, count: out.length });
}
