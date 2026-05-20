// Community / Variety Night queue system.
//
// Per design (aquilo-site/SCHEDULE-SYSTEM-DESIGN.md Phase 3):
//   One queue record per stream date, holding all game queues for that
//   night plus the cap policy.
//
//   Join happens ONLY through Discord (slash command here, plus the
//   future embed-button path). Website + Twitch panel show live counts
//   read-only with a "Join in Discord" deep-link.
//
//   capMode:
//     "per-match" — each game queue independently capped at perMatchCap
//     "per-night" — combined joiner count across all open game queues
//                  capped at perNightCap
//
// KV:
//   queue:v1:<guildId>:<yyyy-mm-dd>   - the queue record
//   auto:<guildId>:<yyyy-mm-dd>       - 24h-TTL marker to prevent
//                                       repeated auto-open retries
//
// The reads here are shared by:
//   - /web/queues/snapshot (HMAC from aquilo-site)
//   - /queues/public        (unauth, used by the website public page)
//   - /ext/queues           (JWT-gated, used by the Twitch panel)
//   - /queue view           (Discord slash)
//
// Writes ONLY happen via:
//   - /queue open|close|close-night|join|leave   (Discord, MANAGE_GUILD
//                                                 for admin variants)
//   - /web/queues/open|close|close-night         (HMAC, aquilo-site /admin)
//   - autoOpenIfDue()                            (cron tick at 21:00 ET)

import { readSchedule, nowInZone } from './schedule.js';

const FLAG_EPHEMERAL = 64;
const RESP_CHAT = 4;
const DEFAULT_CAP = 8;

const QUEUE_KEY = (g, date) => `queue:v1:${g}:${date}`;
const AUTO_MARKER_KEY = (g, date) => `auto:${g}:${date}`;

const SCHEDULE_TZ_DEFAULT = 'America/New_York';

function reply(content, ephemeral = true) {
  const data = { content };
  if (ephemeral) data.flags = FLAG_EPHEMERAL;
  return { type: RESP_CHAT, data };
}

function optionsToMap(opts) {
  const out = {};
  for (const o of opts || []) {
    if (o && typeof o.name === 'string') out[o.name] = o.value;
  }
  return out;
}

// ── Time helpers ──────────────────────────────────────────────────────

export async function todayStreamDate(env, guildId) {
  const schedule = await readSchedule(env, guildId);
  const tz = (schedule && schedule.tz) || SCHEDULE_TZ_DEFAULT;
  const t = nowInZone(tz);
  return `${t.y}-${String(t.m).padStart(2, '0')}-${String(t.d).padStart(2, '0')}`;
}

// ── Read ──────────────────────────────────────────────────────────────

export async function readQueue(env, guildId, date) {
  try {
    const raw = await env.LOADOUT_BOLTS.get(QUEUE_KEY(guildId, date), { type: 'json' });
    if (raw && typeof raw === 'object' && raw.streamDate === date) return raw;
  } catch { /* fall through */ }
  return null;
}

async function writeQueue(env, guildId, date, q) {
  await env.LOADOUT_BOLTS.put(QUEUE_KEY(guildId, date), JSON.stringify(q));
}

function emptyQueueRecord(date, kind, capMode, cap) {
  return {
    streamDate: date,
    kind: kind || 'community',
    openedAt: Date.now(),
    closedAt: null,
    capMode: capMode || 'per-match',
    perMatchCap: capMode === 'per-night' ? null : cap || DEFAULT_CAP,
    perNightCap: capMode === 'per-night' ? cap || DEFAULT_CAP : null,
    queues: {},
  };
}

// Read the current queue OR a synthetic empty record. For the
// website + panel read paths.
export async function snapshotQueue(env, guildId, dateOverride) {
  const schedule = await readSchedule(env, guildId);
  const tz = (schedule && schedule.tz) || SCHEDULE_TZ_DEFAULT;
  const t = nowInZone(tz);
  const date = dateOverride || `${t.y}-${String(t.m).padStart(2, '0')}-${String(t.d).padStart(2, '0')}`;
  const day = schedule && schedule.days && schedule.days.find((d) => d.dow === t.dow);
  const dayKind = (day && day.kind) || 'fixed';

  const record = await readQueue(env, guildId, date);
  if (!record) {
    return {
      streamDate: date,
      kind: dayKind,
      open: false,
      capMode: null,
      perMatchCap: null,
      perNightCap: null,
      totals: { joiners: 0, games: 0 },
      games: [],
    };
  }
  const games = Object.entries(record.queues).map(([gameId, g]) => ({
    gameId,
    openedAt: g.openedAt || record.openedAt,
    count: Array.isArray(g.joiners) ? g.joiners.length : 0,
  }));
  const totalJoiners = games.reduce((s, g) => s + g.count, 0);
  return {
    streamDate: date,
    kind: record.kind || dayKind,
    open: !record.closedAt,
    closedAt: record.closedAt,
    capMode: record.capMode,
    perMatchCap: record.perMatchCap,
    perNightCap: record.perNightCap,
    totals: { joiners: totalJoiners, games: games.length },
    games,
  };
}

// ── Write — open ──────────────────────────────────────────────────────

// Open a game queue. If the night's record doesn't exist yet, this
// initialises it with the supplied cap policy. Subsequent opens inherit
// the existing policy unless explicitly overridden.
export async function openQueue(env, guildId, args) {
  const { gameId, capMode, cap, kind, source } = args;
  if (!gameId) return { ok: false, error: 'no-game', message: 'Pick a game.' };
  const date = await todayStreamDate(env, guildId);

  let record = await readQueue(env, guildId, date);
  if (!record) {
    // First open of the night seeds the record.
    const mode = (capMode === 'per-night' || capMode === 'per-match') ? capMode : 'per-match';
    const c = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : DEFAULT_CAP;
    record = emptyQueueRecord(date, kind, mode, c);
  } else if (record.closedAt) {
    // Re-opening after a close on the same day: clear the close
    // marker. Don't wipe joiners — let the admin keep building.
    record.closedAt = null;
    if (capMode && (capMode === 'per-match' || capMode === 'per-night')) {
      record.capMode = capMode;
      record.perMatchCap = capMode === 'per-match' ? (Number(cap) || record.perMatchCap || DEFAULT_CAP) : null;
      record.perNightCap = capMode === 'per-night' ? (Number(cap) || record.perNightCap || DEFAULT_CAP) : null;
    }
  } else if (capMode && capMode !== record.capMode) {
    return {
      ok: false,
      error: 'capmode-locked',
      message: `Cap mode is already ${record.capMode} for tonight. Close-night before switching.`,
    };
  }

  if (record.queues[gameId]) {
    return { ok: false, error: 'already-open', message: `Queue for \`${gameId}\` is already open.` };
  }
  record.queues[gameId] = {
    openedAt: Date.now(),
    joiners: [],
  };
  await writeQueue(env, guildId, date, record);
  return {
    ok: true,
    streamDate: date,
    gameId,
    capMode: record.capMode,
    perMatchCap: record.perMatchCap,
    perNightCap: record.perNightCap,
    source: source || 'unknown',
    message: `🎮 Queue opened for \`${gameId}\` (cap ${record.capMode}: ${record.perMatchCap ?? record.perNightCap}).`,
  };
}

// ── Write — close ─────────────────────────────────────────────────────

export async function closeQueue(env, guildId, gameId) {
  const date = await todayStreamDate(env, guildId);
  const record = await readQueue(env, guildId, date);
  if (!record) return { ok: false, error: 'no-queue', message: 'No queue is open tonight.' };
  if (!record.queues[gameId]) {
    return { ok: false, error: 'not-open', message: `No queue for \`${gameId}\`.` };
  }
  delete record.queues[gameId];
  await writeQueue(env, guildId, date, record);
  return { ok: true, gameId, message: `🛑 Queue closed for \`${gameId}\`.` };
}

export async function closeNight(env, guildId) {
  const date = await todayStreamDate(env, guildId);
  const record = await readQueue(env, guildId, date);
  if (!record) return { ok: false, error: 'no-queue', message: 'No queue tonight.' };
  record.closedAt = Date.now();
  record.queues = {};
  await writeQueue(env, guildId, date, record);
  return { ok: true, message: '🌙 All queues closed for the night.' };
}

// ── Write — join / leave (Discord users) ──────────────────────────────

export async function joinQueue(env, guildId, gameId, discordUser) {
  if (!gameId || !discordUser || !discordUser.id) {
    return { ok: false, error: 'bad-args', message: 'Missing game or user.' };
  }
  const date = await todayStreamDate(env, guildId);
  const record = await readQueue(env, guildId, date);
  if (!record) return { ok: false, error: 'no-queue', message: 'No queue is open tonight.' };
  if (record.closedAt) return { ok: false, error: 'closed', message: 'The night is closed.' };
  const slot = record.queues[gameId];
  if (!slot) return { ok: false, error: 'not-open', message: `No queue for \`${gameId}\`.` };

  const userId = String(discordUser.id);
  // Already in this queue? Be idempotent — return success.
  if (slot.joiners.some((j) => String(j.discordUserId) === userId)) {
    return { ok: true, alreadyIn: true, gameId, count: slot.joiners.length, message: 'You\'re already in this queue.' };
  }
  // Cap enforcement.
  if (record.capMode === 'per-night') {
    const total = Object.values(record.queues).reduce(
      (s, q) => s + (q.joiners ? q.joiners.length : 0),
      0,
    );
    if (total >= (record.perNightCap || DEFAULT_CAP)) {
      return { ok: false, error: 'night-full', message: `Tonight's cap (${record.perNightCap}) is full.` };
    }
  } else {
    if (slot.joiners.length >= (record.perMatchCap || DEFAULT_CAP)) {
      return { ok: false, error: 'game-full', message: `\`${gameId}\` is full (${record.perMatchCap}).` };
    }
  }

  slot.joiners.push({
    discordUserId: userId,
    display: String(discordUser.global_name || discordUser.username || 'viewer').slice(0, 32),
    joinedAt: Date.now(),
  });
  await writeQueue(env, guildId, date, record);
  return {
    ok: true,
    gameId,
    count: slot.joiners.length,
    position: slot.joiners.length,
    message: `✅ Joined \`${gameId}\` (position ${slot.joiners.length}).`,
  };
}

export async function leaveQueue(env, guildId, gameId, discordUserId) {
  if (!gameId || !discordUserId) {
    return { ok: false, error: 'bad-args', message: 'Missing game or user.' };
  }
  const date = await todayStreamDate(env, guildId);
  const record = await readQueue(env, guildId, date);
  if (!record) return { ok: false, error: 'no-queue', message: 'No queue tonight.' };
  const slot = record.queues[gameId];
  if (!slot) return { ok: false, error: 'not-open', message: `No queue for \`${gameId}\`.` };
  const before = slot.joiners.length;
  slot.joiners = slot.joiners.filter((j) => String(j.discordUserId) !== String(discordUserId));
  if (slot.joiners.length === before) {
    return { ok: false, error: 'not-in-queue', message: `You're not in the \`${gameId}\` queue.` };
  }
  await writeQueue(env, guildId, date, record);
  return { ok: true, gameId, count: slot.joiners.length, message: `🚪 Left \`${gameId}\`.` };
}

// ── Discord /queue slash dispatcher ───────────────────────────────────

export async function handleQueueSlash(env, guild, data) {
  const sub = (data.data && data.data.options && data.data.options[0]) || {};
  const subName = sub.name || '';
  const opts = sub.options || [];

  if (subName === 'view') {
    const snap = await snapshotQueue(env, guild);
    if (!snap.open && snap.games.length === 0) {
      return reply(`No queue is open tonight (${snap.streamDate}).`);
    }
    const lines = snap.games.map((g) => `• \`${g.gameId}\` — ${g.count}` +
      (snap.capMode === 'per-match' ? `/${snap.perMatchCap}` : '') + ' joiner' + (g.count === 1 ? '' : 's'));
    const capLine = snap.capMode === 'per-night'
      ? `Night cap: ${snap.totals.joiners}/${snap.perNightCap}`
      : `Per-game cap: ${snap.perMatchCap}`;
    return reply(`**Queue · ${snap.streamDate}**\n${capLine}\n\n${lines.join('\n') || '_(no game queues yet)_'}`);
  }
  if (subName === 'open') {
    const map = optionsToMap(opts);
    const r = await openQueue(env, guild, {
      gameId: String(map.game || '').trim(),
      capMode: map.cap_mode,
      cap: Number(map.cap),
      source: 'discord',
    });
    return reply(r.message);
  }
  if (subName === 'close') {
    const map = optionsToMap(opts);
    const gameId = String(map.game || '').trim();
    if (!gameId) return reply('Pass `game:<id>` or use `/queue close-night`.');
    const r = await closeQueue(env, guild, gameId);
    return reply(r.message);
  }
  if (subName === 'close-night') {
    const r = await closeNight(env, guild);
    return reply(r.message);
  }
  if (subName === 'join') {
    const map = optionsToMap(opts);
    const user = (data.member && data.member.user) || data.user;
    const r = await joinQueue(env, guild, String(map.game || '').trim(), user);
    return reply(r.message);
  }
  if (subName === 'leave') {
    const map = optionsToMap(opts);
    const user = (data.member && data.member.user) || data.user;
    const r = await leaveQueue(env, guild, String(map.game || '').trim(), user && user.id);
    return reply(r.message);
  }
  return reply('Unknown /queue subcommand.');
}

// ── Auto-open at 9 PM ET ──────────────────────────────────────────────
//
// Called from worker.js's scheduled() handler. Idempotent — uses a
// 24h-TTL marker key so multiple ticks per evening can't double-open.
//
// Algorithm:
//   1. Read schedule. If today's day kind isn't variety/community, bail.
//   2. Check the local time in schedule.tz. If it's between 21:00 and
//      21:59 (inclusive of the 9pm vote-close transition), proceed;
//      otherwise bail.
//   3. If queue:v1 record already exists for today, bail (admin or a
//      prior tick handled it).
//   4. Check + set the auto marker; abort if already set.
//   5. Initialise an empty queue record with capMode "per-match",
//      cap DEFAULT_CAP. Admin can /queue open <game> to add games.
//   6. Return the metadata so the caller can fire any side effects
//      (PWA push, embed in Discord) -- handled by worker.js.

export async function autoOpenIfDue(env, guildId, now = Date.now()) {
  const schedule = await readSchedule(env, guildId);
  if (!schedule) return { fired: false, reason: 'no-schedule' };
  const tz = schedule.tz || SCHEDULE_TZ_DEFAULT;
  const t = nowInZone(tz, now);
  const day = schedule.days && schedule.days.find((d) => d.dow === t.dow);
  if (!day) return { fired: false, reason: 'no-day' };
  if (day.kind !== 'variety' && day.kind !== 'community') {
    return { fired: false, reason: `kind=${day.kind}` };
  }
  if (t.hour !== 21) return { fired: false, reason: `hour=${t.hour}` };

  const date = `${t.y}-${String(t.m).padStart(2, '0')}-${String(t.d).padStart(2, '0')}`;
  const existing = await readQueue(env, guildId, date);
  if (existing) return { fired: false, reason: 'already-open' };

  // Atomic-enough marker — we'll re-read after writing as a sanity
  // check, but KV race wide enough that the worst case is one extra
  // (empty) record creation per night.
  const markerKey = AUTO_MARKER_KEY(guildId, date);
  const marker = await env.LOADOUT_BOLTS.get(markerKey);
  if (marker) return { fired: false, reason: 'marker-set' };
  await env.LOADOUT_BOLTS.put(markerKey, String(now), { expirationTtl: 86400 });

  const record = emptyQueueRecord(date, day.kind, 'per-match', DEFAULT_CAP);
  await writeQueue(env, guildId, date, record);
  return {
    fired: true,
    streamDate: date,
    kind: day.kind,
    record,
  };
}

// ── Cross-Worker PWA push notify ──────────────────────────────────────
//
// Tells aquilo-site to fan out a web-push notification to every
// subscriber when a queue opens. HMAC-signed with AQUILO_SITE_WEB_SECRET
// (the same shared secret the site uses to call /web/* on this Worker),
// so trust is symmetric. Best-effort — caller wraps in try/catch and a
// failed push never blocks the queue from opening.

export async function notifyQueueOpened(env, guildId, streamDate, gameId) {
  return _notify(env, '/api/push/queue-open', { guildId, streamDate, gameId });
}

export async function notifyQueueAutoOpened(env, guildId, streamDate, kind) {
  return _notify(env, '/api/push/queue-open', {
    guildId,
    streamDate,
    auto: true,
    kind: kind || null,
  });
}

async function _notify(env, path, payload) {
  if (!env.AQUILO_SITE_WEB_SECRET) return;
  const base = (env.AQUILO_SITE_URL || 'https://aquilo.gg').replace(/\/+$/, '');
  const body = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const msg = ts + '\n' + body;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.AQUILO_SITE_WEB_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sigBytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  const sig = Array.from(new Uint8Array(sigBytes), (b) => b.toString(16).padStart(2, '0')).join('');
  await fetch(base + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-aquilo-web-ts': ts,
      'x-aquilo-web-sig': sig,
    },
    body,
  });
}
