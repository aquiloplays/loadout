// Top Sub Gifter / Top TikTok Gifter / Top Cheerer rolling roles.
//
// Three Discord roles, each held by the current TOP 3 in that
// category over the last 30 days. Driven by Streamer.bot HTTP
// actions posting to /streamerbot/event, payload schema documented
// at the top of handleStreamerbotEvent below.
//
// Rolling-window math:
//   • Per-user-per-day cumulative amount → `gifter:<cat>:<g>:<uid>:<YYYY-MM-DD>`
//   • Daily rebuild walks the last 30 days of buckets per user,
//     sums, picks top 3, diffs against current role-holders, grants
//     newcomers + revokes anyone who fell out.
//   • Re-runs are safe: role grants are PUT (idempotent), revokes
//     are tracked by reading the LIVE role membership via Discord
//     REST + revoking from the set difference.
//
// Per-guild config:
//   gifter-roles:<guildId>  → { sub: '<roleId>', tiktok: '<roleId>',
//                               cheer: '<roleId>' }
//
// Per-event identity buckets (for the slash command + report, keep
// the username even for unlinked contributors so they still appear
// in the leaderboard):
//   gifter-identity:<cat>:<g>:<key>  → { platform, login, lastSeenUtc }
//     `key` is "twitch:<login>" or "tiktok:<username>"
//
// Daily-cron-once-per-UTC-day marker:
//   gifter-roles:last-cron-day:<g>  → YYYY-MM-DD
//
// Public leaderboard snapshots (written by the daily tick, served by
// GET /community/top-supporters — see handleTopSupporters):
//   gifter-top:<g>:<cat>  → [{ name, total, platform }] (top 50)

import { verifyHmac } from './auth.js';

export const GIFTER_CATEGORIES = Object.freeze({
  sub:    { name: 'Top Sub Gifter',    color: 0x9146FF, eventType: 'sub-gift' },
  tiktok: { name: 'Top TikTok Gifter', color: 0xFF0050, eventType: 'tip' },
  cheer:  { name: 'Top Cheerer',       color: 0x5A3AFF, eventType: 'cheer' },
  // 2026-07-09 (community roadmap item 13): Kick supporters. Fed by
  // the sf-community.js event tap (Clay's own SF install relays Kick
  // gift subs as /sf/community-event eventType 'gift'; tips are NOT
  // counted — the bucket is a gift-sub count). Role is minted the
  // next time /admin/gifter-roles/ensure runs; until then the daily
  // reconcile safely skips the category ('no-role-id-for-kick').
  kick:   { name: 'Top Kick Gifter',   color: 0x53FC18, eventType: 'gift' },
});

const ROLE_MAP_KEY    = (g) => `gifter-roles:${g}`;
const BUCKET_KEY      = (cat, g, uid, day) => `gifter:${cat}:${g}:${uid}:${day}`;
const IDENTITY_KEY    = (cat, g, key) => `gifter-identity:${cat}:${g}:${key}`;
const LAST_CRON_KEY   = (g) => `gifter-roles:last-cron-day:${g}`;
// Precomputed public leaderboard snapshot, written once per UTC day by
// gifterRolesDailyTick and served by GET /community/top-supporters so
// the unauthenticated route never triggers an O(roster) KV scan.
//   gifter-top:<guildId>:<cat> → [{ name, total, platform }] (top 50)
const SNAPSHOT_KEY    = (g, cat) => `gifter-top:${g}:${cat}`;
const HMAC_SKEW_S = 300;
const ROLLING_WINDOW_DAYS = 30;
const TRIM_OLDER_THAN_DAYS = 32;

// ── Date helpers ──────────────────────────────────────────────────

function utcDay(date = new Date()) {
  const d = new Date(date);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function lastNDays(n, anchor = new Date()) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(anchor);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(utcDay(d));
  }
  return out;
}

// ── Event-type → category ────────────────────────────────────────

function categoryFor(eventType, platform) {
  const t = String(eventType || '').toLowerCase();
  const p = String(platform || '').toLowerCase();
  if (t === 'sub-gift' && p === 'twitch') return 'sub';
  if (t === 'tip'      && p === 'tiktok') return 'tiktok';
  if (t === 'cheer'    && p === 'twitch') return 'cheer';
  // Kick leg (2026-07-09): SF relays Kick gift subs as eventType
  // 'gift'. Gift subs ONLY — Kick tips ('tip') are dollar amounts and
  // must never mix into a gift-sub COUNT bucket (the wall's "gifted"
  // unit label and the 'Top Kick Gifter' role name both mean gift
  // subs). sf-community.js gates ingest to 'gift' too; this is the
  // belt-and-braces so a stray tip can't enter via any other path.
  if (t === 'gift' && p === 'kick') return 'kick';
  return null;
}

// ── Identity helpers (for unlinked contributors) ─────────────────

function identityKeyOf(platform, login) {
  const p = String(platform || '').toLowerCase();
  const l = String(login || '').toLowerCase();
  if (!p || !l) return null;
  return `${p}:${l}`;
}

async function loadLinksReverseIndex(env, guildId) {
  // Twitch login (lowercase) → Discord user id. Scans wallet:<g>:*
  // entries' `links: [{ platform, username }]` arrays. Bounded ≤
  // 5 pages × 1000 keys; aquilo's roster is small (hundreds).
  const idx = new Map();
  let cursor;
  for (let page = 0; page < 5; page++) {
    const r = await env.LOADOUT_BOLTS.list({
      prefix: `wallet:${guildId}:`, cursor, limit: 1000,
    });
    for (const k of r.keys) {
      const w = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
      const discordUserId = k.name.split(':').pop();
      const links = (w?.links || []).filter(l => l?.platform && l?.username);
      for (const l of links) {
        idx.set(`${String(l.platform).toLowerCase()}:${String(l.username).toLowerCase()}`, discordUserId);
      }
    }
    if (r.list_complete) break;
    cursor = r.cursor;
  }
  return idx;
}

// Resolve a single event's contributor to a Discord user id (or
// null if not linked). Used in the webhook hot path; takes the
// reverse-index map as an arg so we don't re-walk wallet:* per event.
function resolveDiscordId(event, linkIdx) {
  if (event.platform === 'twitch') {
    if (event.twitchUserId) {
      for (const [k, v] of linkIdx) {
        // Twitch ids aren't tracked in the link records (only the
        // login is), so this branch is unused today; here for when
        // we add id-based links.
      }
    }
    if (event.twitchLogin) {
      return linkIdx.get(`twitch:${String(event.twitchLogin).toLowerCase()}`) || null;
    }
  }
  if (event.platform === 'tiktok') {
    if (event.tiktokUsername) {
      return linkIdx.get(`tiktok:${String(event.tiktokUsername).toLowerCase()}`) || null;
    }
  }
  return null;
}

// ── Webhook: /streamerbot/event ──────────────────────────────────
//
// HMAC scheme (mirrors /sync HMAC):
//   Headers:
//     x-aquilo-sb-ts   unix-seconds timestamp (rejected if skew > 5min)
//     x-aquilo-sb-sig  hex(SHA-256(STREAMERBOT_WEBHOOK_SECRET, ts + "\n" + body))
//   Body (JSON):
//     {
//       type: "sub-gift" | "tip" | "cheer",
//       platform: "twitch" | "tiktok",
//       twitchUserId?: string,     // optional, future-proofing
//       twitchLogin?: string,      // required for twitch events
//       tiktokUsername?: string,   // required for tiktok events
//       amount: number,            // count of subs gifted, tip $, or cheer bits
//       ts?: number                // ms-epoch; defaults to receipt time
//     }
//
// Returns: { ok: true, category, contributorKey, day, totalToday,
//            discordUserId: <id> | null }

export async function handleStreamerbotEvent(req, env) {
  if (!env.STREAMERBOT_WEBHOOK_SECRET) {
    return jsonResp({ ok: false, error: 'webhook-secret-not-configured' }, 503);
  }
  const ts  = req.headers.get('x-aquilo-sb-ts');
  const sig = req.headers.get('x-aquilo-sb-sig');
  const body = await req.text();
  const ok = await verifyHmac(env.STREAMERBOT_WEBHOOK_SECRET, ts || '', body, sig || '');
  if (!ok) return jsonResp({ ok: false, error: 'bad-signature' }, 401);

  let event;
  try { event = JSON.parse(body); }
  catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  if (!event || typeof event !== 'object') {
    return jsonResp({ ok: false, error: 'bad-event' }, 400);
  }
  const guildId = String(env.AQUILO_VAULT_GUILD_ID || '').trim();
  if (!guildId) return jsonResp({ ok: false, error: 'no-guild-id' }, 503);
  const login = event.platform === 'twitch' ? event.twitchLogin : event.tiktokUsername;

  const r = await recordGifterEvent(env, guildId, event.type, event.platform, login, event.amount, event.ts);
  if (!r.ok) {
    return jsonResp(r, r.error === 'no-guild-id' ? 503 : 400);
  }
  return jsonResp(r, 200);
}

// Aggregator-side helper, callable from any HTTP handler that has
// already authenticated its caller (Streamer.bot webhook, TikFinity
// webhook, etc). Validates the event shape + bumps the per-day
// bucket + persists the identity record. Returns the same shape
// the webhook used to return so both endpoints look identical to
// the leaderboard reader.
export async function recordGifterEvent(env, guildId, eventType, platform, login, amount, tsMs) {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    return { ok: false, error: 'bad-amount' };
  }
  const category = categoryFor(eventType, platform);
  if (!category) return { ok: false, error: 'unhandled-event-type', type: eventType, platform };
  if (!guildId) return { ok: false, error: 'no-guild-id' };
  const identityKey = identityKeyOf(platform, login);
  if (!identityKey) return { ok: false, error: 'no-contributor-login' };
  const day = utcDay(new Date(Number(tsMs) || Date.now()));

  const bucketKeyByLogin = BUCKET_KEY(category, guildId, identityKey, day);
  const prior = parseInt((await env.LOADOUT_BOLTS.get(bucketKeyByLogin)) || '0', 10) || 0;
  const total = prior + amt;
  await env.LOADOUT_BOLTS.put(bucketKeyByLogin, String(total));
  await env.LOADOUT_BOLTS.put(
    IDENTITY_KEY(category, guildId, identityKey),
    JSON.stringify({ platform, login, lastSeenUtc: Date.now() }),
    { expirationTtl: (TRIM_OLDER_THAN_DAYS + 7) * 86400 },
  );
  return {
    ok: true,
    category,
    contributorKey: identityKey,
    day,
    totalToday: total,
  };
}

// ── Read-side: rolling-window leaderboard ────────────────────────
//
// Walks the last 30 days of buckets for the given category. Returns
// [{ key, total, platform, login, discordUserId? }, ...] sorted
// desc by total. Bounded scan: at most (categories × 30) KV list
// calls per cron tick.

export async function rolling30dLeaderboard(env, category, guildId, limit = 50) {
  if (!guildId || !GIFTER_CATEGORIES[category]) return [];
  const totals = new Map();   // identityKey → number
  const days = lastNDays(ROLLING_WINDOW_DAYS);
  // Per day: list `gifter:<cat>:<g>:` and filter by suffix `:<day>`.
  // Cheaper alternative would be one list call + filtering everything
  //, for a 30-day window with hundreds of contributors that's a few
  // KB of keys. Doing it per-day keeps the list smaller per call.
  let cursor;
  // Single list call across the whole category, KV list returns
  // names only (no values), then we GET per key. Fewer round trips
  // than 30 per-day lists.
  const prefix = `gifter:${category}:${guildId}:`;
  for (let page = 0; page < 10; page++) {
    const r = await env.LOADOUT_BOLTS.list({ prefix, cursor, limit: 1000 });
    for (const k of r.keys) {
      // Key shape: gifter:<cat>:<g>:<identityKey>:<YYYY-MM-DD>
      const tail = k.name.slice(prefix.length);
      const m = tail.match(/^(.+):(\d{4}-\d{2}-\d{2})$/);
      if (!m) continue;
      const identityKey = m[1];
      const day = m[2];
      if (!days.includes(day)) continue;
      const v = await env.LOADOUT_BOLTS.get(k.name);
      const n = parseInt(v || '0', 10) || 0;
      if (n <= 0) continue;
      totals.set(identityKey, (totals.get(identityKey) || 0) + n);
    }
    if (r.list_complete) break;
    cursor = r.cursor;
  }
  // Resolve identities + Discord links.
  const linkIdx = await loadLinksReverseIndex(env, guildId);
  const rows = [];
  for (const [key, total] of totals) {
    const ident = await env.LOADOUT_BOLTS.get(IDENTITY_KEY(category, guildId, key), { type: 'json' });
    rows.push({
      key,
      total,
      platform: ident?.platform || key.split(':')[0],
      login:    ident?.login    || key.split(':').slice(1).join(':'),
      discordUserId: linkIdx.get(key) || null,
    });
  }
  rows.sort((a, b) => b.total - a.total);
  return rows.slice(0, limit);
}

// ── Daily cron: rebuild top-3 role membership + trim old buckets ──
//
// Idempotent per UTC day via gifter-roles:last-cron-day:<g>. Fires
// on the :23 hourly tick, gated to once per UTC day so we don't
// thrash Discord role REST calls 24× per day.

export async function gifterRolesDailyTick(env) {
  const guildId = String(env.AQUILO_VAULT_GUILD_ID || '').trim();
  if (!guildId) return { skipped: 'no-guild-id' };
  const today = utcDay(new Date());
  const last = await env.LOADOUT_BOLTS.get(LAST_CRON_KEY(guildId));
  if (last === today) return { skipped: 'already-ran-today', day: today };

  // Precompute the public top-supporters snapshots FIRST, and for
  // EVERY category — before the role-map early-return below — so
  // /community/top-supporters works even for categories whose role
  // hasn't been minted yet (kick pre-mint) and even before Clay runs
  // /admin/gifter-roles/ensure. The boards double as the reconcile
  // input so the 30d walk runs once per category per day, not twice.
  const boards = {};
  for (const cat of Object.keys(GIFTER_CATEGORIES)) {
    try {
      const board = await rolling30dLeaderboard(env, cat, guildId, 50);
      boards[cat] = board;
      await env.LOADOUT_BOLTS.put(SNAPSHOT_KEY(guildId, cat), JSON.stringify(
        board.map(r => ({ name: r.login || r.key, total: r.total, platform: r.platform })),
      ));
    } catch (e) {
      console.warn('[gifter-roles] snapshot', cat, 'failed:', e?.message || e);
    }
  }

  const map = await env.LOADOUT_BOLTS.get(ROLE_MAP_KEY(guildId), { type: 'json' });
  if (!map || !map.sub || !map.tiktok || !map.cheer) {
    // Stamp anyway so we don't re-scan all day. Re-run after
    // ensure populates the map.
    await env.LOADOUT_BOLTS.put(LAST_CRON_KEY(guildId), today);
    return { skipped: 'no-role-map', day: today, snapshots: Object.keys(boards) };
  }

  const summary = {};
  for (const cat of Object.keys(GIFTER_CATEGORIES)) {
    summary[cat] = await reconcileCategory(env, guildId, cat, map[cat], boards[cat]);
  }
  await trimOldBuckets(env, guildId);
  await env.LOADOUT_BOLTS.put(LAST_CRON_KEY(guildId), today);
  return { ok: true, day: today, summary };
}

async function reconcileCategory(env, guildId, category, roleId, precomputedBoard) {
  if (!roleId) return { skipped: 'no-role-id-for-' + category };
  const board = precomputedBoard || await rolling30dLeaderboard(env, category, guildId, 50);
  // Top 3 with a Discord link, unlinked contributors can lead the
  // leaderboard but can't hold the role (no member to grant to).
  const top3Ids = board.filter(r => r.discordUserId).slice(0, 3).map(r => r.discordUserId);
  // Who currently holds the role on the Discord side?
  const holders = await listRoleHolders(env, guildId, roleId);
  const toAdd    = top3Ids.filter(id => !holders.has(id));
  const toRemove = [...holders].filter(id => !top3Ids.includes(id));
  for (const id of toAdd)    await putRoleOnUser(env, guildId, id, roleId, `gifter top-3 (${category})`);
  for (const id of toRemove) await removeRoleFromUser(env, guildId, id, roleId, `gifter no-longer-top-3 (${category})`);
  return {
    category,
    top3Ids,
    toAdd,
    toRemove,
    boardSize: board.length,
  };
}

// Discord REST: list every member that currently holds a given
// role id. /guilds/{g}/members?limit=1000 pages over the whole
// roster, fine for aquilo's size (hundreds), would need
// pagination loop if we grow past ~1000.
async function listRoleHolders(env, guildId, roleId) {
  const holders = new Set();
  let after = '0';
  for (let page = 0; page < 10; page++) {
    const r = await fetch(
      `https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/members?limit=1000&after=${after}`,
      {
        headers: {
          Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
          'User-Agent':  'loadout-discord gifter-roles',
        },
      },
    );
    if (!r.ok) return holders;
    const arr = await r.json();
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const m of arr) {
      if (Array.isArray(m.roles) && m.roles.includes(roleId)) {
        holders.add(String(m.user?.id || ''));
      }
    }
    if (arr.length < 1000) break;
    after = String(arr[arr.length - 1].user?.id || '0');
  }
  return holders;
}

async function putRoleOnUser(env, guildId, userId, roleId, reason) {
  const r = await fetch(
    `https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`,
    {
      method: 'PUT',
      headers: {
        Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
        'User-Agent':  'loadout-discord gifter-roles',
        'X-Audit-Log-Reason': reason || 'gifter role grant',
      },
    },
  );
  return r.ok || r.status === 204;
}

async function removeRoleFromUser(env, guildId, userId, roleId, reason) {
  const r = await fetch(
    `https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
        'User-Agent':  'loadout-discord gifter-roles',
        'X-Audit-Log-Reason': reason || 'gifter role revoke',
      },
    },
  );
  return r.ok || r.status === 204;
}

// Trim buckets older than the window + cushion so an abandoned
// guild grooms itself.
async function trimOldBuckets(env, guildId) {
  const keepDays = new Set(lastNDays(TRIM_OLDER_THAN_DAYS));
  let cursor;
  let deleted = 0;
  for (const cat of Object.keys(GIFTER_CATEGORIES)) {
    const prefix = `gifter:${cat}:${guildId}:`;
    for (let page = 0; page < 5; page++) {
      const r = await env.LOADOUT_BOLTS.list({ prefix, cursor, limit: 1000 });
      for (const k of r.keys) {
        const m = k.name.match(/:(\d{4}-\d{2}-\d{2})$/);
        if (!m) continue;
        if (keepDays.has(m[1])) continue;
        await env.LOADOUT_BOLTS.delete(k.name);
        deleted += 1;
      }
      if (r.list_complete) break;
      cursor = r.cursor;
    }
  }
  return { deleted };
}

// ── Admin: ensure the three gifter roles exist ───────────────────

export async function ensureGifterRoles(env, guildId) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  const listRes = await fetch(
    `https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/roles`,
    {
      headers: {
        Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
        'User-Agent':  'loadout-discord gifter-roles',
      },
    },
  );
  if (!listRes.ok) {
    const t = await listRes.text();
    return { ok: false, error: 'roles-fetch-failed', status: listRes.status, body: t.slice(0, 200) };
  }
  const existing = await listRes.json();
  const map = (await env.LOADOUT_BOLTS.get(ROLE_MAP_KEY(guildId), { type: 'json' })) || {};
  const created = [];
  const reused = [];
  const failed = [];
  for (const [key, spec] of Object.entries(GIFTER_CATEGORIES)) {
    const mapped = map[key];
    const mappedRow = mapped && existing.find(r =>
      r && String(r.id) === String(mapped)
      && String(r.id) !== String(guildId) && !r.managed);
    if (mappedRow) {
      reused.push({ key, id: String(mappedRow.id), name: mappedRow.name, source: 'kv-map' });
      continue;
    }
    const byName = existing.find(r =>
      r && r.name && r.id
      && String(r.id) !== String(guildId) && !r.managed
      && String(r.name).toLowerCase() === spec.name.toLowerCase());
    if (byName) {
      map[key] = String(byName.id);
      reused.push({ key, id: String(byName.id), name: byName.name, source: 'name-match' });
      continue;
    }
    const createRes = await fetch(
      `https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/roles`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
          'Content-Type': 'application/json',
          'User-Agent':  'loadout-discord gifter-roles',
          'X-Audit-Log-Reason': `aquilo gifter role (${key})`,
        },
        body: JSON.stringify({
          name:        spec.name,
          permissions: '0',
          color:       spec.color,
          hoist:       false,
          mentionable: false,
        }),
      },
    );
    if (!createRes.ok) {
      const t = await createRes.text();
      failed.push({ key, status: createRes.status, body: t.slice(0, 200) });
      continue;
    }
    const j = await createRes.json();
    map[key] = String(j.id);
    created.push({ key, id: String(j.id), name: spec.name, color: spec.color });
  }
  await env.LOADOUT_BOLTS.put(ROLE_MAP_KEY(guildId), JSON.stringify(map));
  return { ok: true, map, created, reused, failed };
}

// ── /topgifters slash command ─────────────────────────────────────

const RESP_CHAT = 4;
const FLAG_EPHEMERAL = 64;

export async function handleTopGiftersCommand(env, data) {
  const guildId = data.guild_id || env.AQUILO_VAULT_GUILD_ID;
  if (!guildId) {
    return { type: RESP_CHAT, data: { content: 'Run this in a server.', flags: FLAG_EPHEMERAL } };
  }
  const fields = [];
  for (const [cat, spec] of Object.entries(GIFTER_CATEGORIES)) {
    const board = await rolling30dLeaderboard(env, cat, guildId, 5);
    if (board.length === 0) {
      fields.push({ name: spec.name, value: '_no contributions yet (last 30d)_', inline: false });
      continue;
    }
    const lines = board.map((r, i) => {
      const who = r.discordUserId
        ? `<@${r.discordUserId}>`
        : (r.login || r.key);
      return `${i + 1}. **${r.total.toLocaleString()}**, ${who}` +
             (r.discordUserId ? ` _(${r.platform}: ${r.login})_` : '');
    });
    fields.push({ name: spec.name, value: lines.join('\n'), inline: false });
  }
  return {
    type: RESP_CHAT,
    data: {
      embeds: [{
        title: '🎁  Top Gifters · last 30 days',
        description: 'Top 5 per category. Top 3 get the matching Discord role (rolling).',
        color: 0x9146FF,
        fields,
        timestamp: new Date().toISOString(),
      }],
      flags: FLAG_EPHEMERAL,
    },
  };
}

// ── GET /community/top-supporters ────────────────────────────────
//
// Public read powering the site's SupporterWall (community roadmap
// item 13). The site proxy (aquilo-site functions/api/community/
// top-supporters.js) calls:
//   GET /community/top-supporters?platforms=tiktok,kick&limit=12
// and expects:
//   { ok: true, categories: { tiktok: [Row], kick: [Row] } }
//   Row = { rank, name, total, platform }
// where `name` is the supporter's PLATFORM handle (the wall links it
// to tiktok.com/@name / kick.com/name) and `total` is the rolling-30d
// sum from the gifter buckets. Unknown platforms return empty arrays
// so the wall degrades to its "warming up" card, never an error.
//
// Served from the precomputed gifter-top:<g>:<cat> snapshots that
// gifterRolesDailyTick writes once per UTC day — this route is
// unauthenticated, so it must NEVER trigger the O(wallet-roster)
// rolling30dLeaderboard scan per request (read amplification against
// the shared KV namespace). One KV GET per (deduped) platform, plus a
// caches.default layer (300s TTL on a normalized key) so repeat hits
// don't even touch KV. Freshness is daily — fine for a 30d rolling
// wall. Empty until the first daily tick after deploy.

const TOP_SUPPORTERS_PLATFORM_CATEGORY = Object.freeze({
  tiktok: 'tiktok',
  kick:   'kick',
  twitch: 'sub',
});

export async function handleTopSupporters(req, env) {
  if (req.method !== 'GET') return jsonResp({ ok: false, error: 'method' }, 405);
  const guildId = String(env.AQUILO_VAULT_GUILD_ID || '').trim();
  const url = new URL(req.url);
  const platforms = [...new Set(
    String(url.searchParams.get('platforms') || 'tiktok,kick')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  )].slice(0, 5);
  const limit = Math.max(1, Math.min(50, parseInt(url.searchParams.get('limit') || '12', 10) || 12));

  // Edge-cache layer. The key is a NORMALIZED synthetic URL (sorted
  // deduped platforms + clamped limit only) so query-string noise
  // can't fan out into distinct cache entries. Guarded: caches is
  // undefined under the Node test harness — serve direct then.
  let cache = null, cacheKey = null;
  try {
    cache = caches.default;
    const norm = new URL('https://loadout-internal/community/top-supporters');
    norm.searchParams.set('platforms', [...platforms].sort().join(','));
    norm.searchParams.set('limit', String(limit));
    cacheKey = new Request(norm.toString(), { method: 'GET' });
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  } catch { cache = null; cacheKey = null; }

  const categories = {};
  for (const p of platforms) {
    const cat = TOP_SUPPORTERS_PLATFORM_CATEGORY[p];
    if (!cat || !guildId) { categories[p] = []; continue; }
    try {
      const snap = await env.LOADOUT_BOLTS.get(SNAPSHOT_KEY(guildId, cat), { type: 'json' });
      categories[p] = (Array.isArray(snap) ? snap : []).slice(0, limit).map((r, i) => ({
        rank: i + 1,
        name: r.name,
        total: r.total,
        platform: p,
      }));
    } catch (e) {
      console.warn('[top-supporters]', p, 'snapshot read failed:', e?.message || e);
      categories[p] = [];
    }
  }
  const res = new Response(JSON.stringify({ ok: true, fetchedAt: Date.now(), categories }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      // s-maxage drives both the caches.default TTL and the site
      // proxy's edge cache.
      'cache-control': 'public, max-age=0, s-maxage=300',
    },
  });
  if (cache && cacheKey) {
    try { await cache.put(cacheKey, res.clone()); } catch { /* best-effort */ }
  }
  return res;
}

// ── helpers ──────────────────────────────────────────────────────

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Exposed for the test harness.
export {
  utcDay         as _utcDayForTest,
  categoryFor    as _categoryForTest,
  identityKeyOf  as _identityKeyForTest,
};
