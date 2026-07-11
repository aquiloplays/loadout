// Schedule + games-catalog Discord write surface.
//
// Mirrors aquilo-site's /api/admin/schedule and /api/admin/games. Both
// surfaces write the same LOADOUT_BOLTS KV keys so either is usable in
// isolation:
//
//   schedule:v1:<guildId>, { version, tz, updatedAt, updatedBy, days[7] }
//   games:v1:<guildId>, { version, updatedAt, updatedBy, items[] }
//
// Both records carry an `updatedBy` of "web" or "discord" so it's clear
// which surface made the last edit. See aquilo-site/SCHEDULE-SYSTEM-DESIGN.md
// for the full data model.
//
// MANAGE_GUILD is enforced by Discord via the slash commands'
// default_member_permissions in commands-spec.js, no extra in-handler
// gate needed.

const FLAG_EPHEMERAL = 64;
const RESP_CHAT = 4;

const DOW_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SCHEDULE_KINDS = ['fixed', 'variety', 'community', 'dad-sunday', 'fo4cc', 'rotation'];
const POOL_KINDS = ['community', 'variety'];
const HH_MM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const SCHEDULE_KEY      = (g) => `schedule:v1:${g}`;
const GAMES_KEY         = (g) => `games:v1:${g}`;
const VOTE_CHANNEL_KEY  = (g) => `channel:vote:guild:${g}`;

const DEFAULT_SCHEDULE = {
  version: 1,
  tz: 'America/New_York',
  updatedAt: 0,
  updatedBy: null,
  // Schedule v8 (2026-07-11, matches aquilo/aq-schedule.js WEEKLY):
  // solo Crowd Control Sun/Mon/Wed/Fri, Tue/Thu OFF (rest days,
  // startLocal:null so every consumer — Discord scheduled events,
  // pre-stream pings, the site schedule/countdown — skips them), and
  // Saturday = COMMUNITY NIGHT: the game is auto-picked weekly from the
  // games:v1 community pool (weeklyCommunityPick), NO vote — the v4
  // vote-night model and the Rotation slot stay retired; a KV wipe or
  // unsaved guild must resurrect the auto-pick Saturday, not a vote.
  days: [
    { dow: 0, label: 'Crowd Control',        kind: 'fo4cc',     startLocal: '22:30', endLocal: '00:30' },
    { dow: 1, label: 'Crowd Control',        kind: 'fo4cc',     startLocal: '22:30', endLocal: '00:30' },
    { dow: 2, label: 'No stream (rest day)', kind: 'fo4cc',     startLocal: null,    endLocal: null },
    { dow: 3, label: 'Crowd Control',        kind: 'fo4cc',     startLocal: '22:30', endLocal: '00:30' },
    { dow: 4, label: 'No stream (rest day)', kind: 'fo4cc',     startLocal: null,    endLocal: null },
    { dow: 5, label: 'Crowd Control',        kind: 'fo4cc',     startLocal: '22:30', endLocal: '00:30' },
    { dow: 6, label: 'Community Night',      kind: 'community', startLocal: '22:30', endLocal: '00:30' },
  ],
};

const DEFAULT_GAMES = { version: 1, updatedAt: 0, updatedBy: null, items: [] };

function reply(content, ephemeral = true) {
  const data = { content };
  if (ephemeral) data.flags = FLAG_EPHEMERAL;
  return { type: RESP_CHAT, data };
}

function gameSlug(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'game';
}

// Legacy deterministic URL guess, only correct for some pre-2024
// titles. Used as a last-resort fallback when Steam's appdetails API
// is unavailable. New adds always prefer fetchSteamArt() which returns
// the real, possibly-hashed URLs (header_alt_assets_<n>.jpg variants
// included) the way the games admin UI on aquilo.gg does.
function steamArtUrls(appId) {
  const id = String(appId);
  return {
    headerUrl:  `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/header.jpg`,
    capsuleUrl: `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/capsule_616x353.jpg`,
    storeUrl:   `https://store.steampowered.com/app/${id}/`,
  };
}

async function fetchSteamArt(appId) {
  const id = Number(appId);
  if (!Number.isInteger(id) || id <= 0) return null;
  try {
    const res = await fetch(
      `https://store.steampowered.com/api/appdetails?appids=${id}&filters=basic&cc=us`,
      { headers: { 'User-Agent': 'aquilo.gg/1.0', Accept: 'application/json' } },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const entry = data && data[String(id)];
    if (!entry || !entry.success || !entry.data) return null;
    const dd = entry.data;
    return {
      name: typeof dd.name === 'string' ? dd.name : null,
      headerUrl: typeof dd.header_image === 'string' ? dd.header_image : null,
      capsuleUrl: typeof dd.capsule_image === 'string' ? dd.capsule_image : null,
      storeUrl: `https://store.steampowered.com/app/${id}/`,
    };
  } catch {
    return null;
  }
}

function poolsFromChoice(raw) {
  switch ((raw || '').toLowerCase()) {
    case 'community': return ['community'];
    case 'variety':   return ['variety'];
    case 'both':      return ['community', 'variety'];
    default:          return ['community', 'variety'];
  }
}

export async function readSchedule(env, guildId) {
  try {
    const raw = await env.LOADOUT_BOLTS.get(SCHEDULE_KEY(guildId), { type: 'json' });
    if (raw && Array.isArray(raw.days) && raw.days.length === 7) return raw;
  } catch { /* fall through */ }
  return DEFAULT_SCHEDULE;
}

async function readGames(env, guildId) {
  try {
    const raw = await env.LOADOUT_BOLTS.get(GAMES_KEY(guildId), { type: 'json' });
    if (raw && Array.isArray(raw.items)) return raw;
  } catch { /* fall through */ }
  return DEFAULT_GAMES;
}

async function writeSchedule(env, guildId, schedule) {
  schedule.version = 1;
  schedule.updatedAt = Date.now();
  schedule.updatedBy = 'discord';
  await env.LOADOUT_BOLTS.put(SCHEDULE_KEY(guildId), JSON.stringify(schedule));
}

async function writeGames(env, guildId, catalog) {
  catalog.version = 1;
  catalog.updatedAt = Date.now();
  catalog.updatedBy = 'discord';
  await env.LOADOUT_BOLTS.put(GAMES_KEY(guildId), JSON.stringify(catalog));
}

// ── TZ math (kept in sync with aquilo-site's functions/_lib/schedule.js)
//
// Both the bot and the site compute nextStream + voteActive against the
// SAME KV records using the SAME algorithm, so they can never disagree
// about "when is the next stream" or "is the vote open right now".

function zonedTimeToEpoch(y, mo, d, h, mi, tz) {
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  });
  const parts = fmt.formatToParts(new Date(naive));
  const o = {};
  for (const p of parts) if (p.type !== 'literal') o[p.type] = parseInt(p.value, 10);
  const wallClock = Date.UTC(o.year, o.month - 1, o.day, o.hour, o.minute, o.second);
  return naive - (wallClock - naive);
}

export function nowInZone(tz, now = Date.now()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    weekday: 'short', year: 'numeric', month: 'numeric',
    day: 'numeric', hour: 'numeric', minute: 'numeric',
  });
  const parts = fmt.formatToParts(new Date(now));
  const o = {};
  for (const p of parts) if (p.type !== 'literal') o[p.type] = p.value;
  const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    y: parseInt(o.year, 10), m: parseInt(o.month, 10), d: parseInt(o.day, 10),
    hour: parseInt(o.hour, 10), minute: parseInt(o.minute, 10),
    dow: DOW[o.weekday] ?? 0,
  };
}

function addDaysInZone(y, m, d, days) {
  const utc = new Date(Date.UTC(y, m - 1, d, 12) + days * 86400000);
  return { y: utc.getUTCFullYear(), m: utc.getUTCMonth() + 1, d: utc.getUTCDate() };
}

function startKeyOf(s) {
  if (!s) return null;
  const [h, mi] = s.split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(mi) ? h * 100 + mi : null;
}

function dayEndEpoch(day, target, tz) {
  if (!day.endLocal) return null;
  const [h, mi] = day.endLocal.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(mi)) return null;
  const startKey = startKeyOf(day.startLocal);
  const endKey = h * 100 + mi;
  const date = (startKey != null && endKey < startKey)
    ? addDaysInZone(target.y, target.m, target.d, 1)
    : target;
  return zonedTimeToEpoch(date.y, date.m, date.d, h, mi, tz);
}

function nextStreamFrom(schedule, now = Date.now()) {
  if (!schedule || !Array.isArray(schedule.days)) return null;
  const tz = schedule.tz || 'America/New_York';
  const today = nowInZone(tz, now);
  for (let offset = 0; offset <= 7; offset++) {
    const dayIdx = (today.dow + offset) % 7;
    const day = schedule.days.find((dd) => dd.dow === dayIdx);
    if (!day || !day.startLocal) continue;
    const [h, mi] = day.startLocal.split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(mi)) continue;
    const target = addDaysInZone(today.y, today.m, today.d, offset);
    const startsAt = zonedTimeToEpoch(target.y, target.m, target.d, h, mi, tz);
    if (startsAt > now) {
      return {
        startsAt,
        endsAt: dayEndEpoch(day, target, tz),
        label: day.label,
        kind: day.kind,
        dow: day.dow,
      };
    }
  }
  return null;
}

// Every scheduled stream that starts within the next `horizonDays`
// days (ET-aware). Used by stream-events.js to mirror the schedule
// into Discord guild scheduled events. Returns soonest-first.
export function upcomingStreams(schedule, horizonDays = 7, now = Date.now()) {
  if (!schedule || !Array.isArray(schedule.days)) return [];
  const tz = schedule.tz || 'America/New_York';
  const today = nowInZone(tz, now);
  const out = [];
  for (let offset = 0; offset <= horizonDays; offset++) {
    const dayIdx = (today.dow + offset) % 7;
    const day = schedule.days.find((dd) => dd.dow === dayIdx);
    if (!day || !day.startLocal) continue;
    const [h, mi] = day.startLocal.split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(mi)) continue;
    const target = addDaysInZone(today.y, today.m, today.d, offset);
    const startsAt = zonedTimeToEpoch(target.y, target.m, target.d, h, mi, tz);
    if (startsAt <= now) continue;
    out.push({
      startsAt,
      endsAt: dayEndEpoch(day, target, tz),
      label: day.label,
      kind: day.kind,
      dow: day.dow,
      startLocal: day.startLocal,
      dateKey: `${target.y}-${String(target.m).padStart(2, '0')}-${String(target.d).padStart(2, '0')}`,
    });
  }
  return out.sort((a, b) => a.startsAt - b.startsAt);
}

function voteActiveAt(schedule, now = Date.now()) {
  if (!schedule || !Array.isArray(schedule.days)) return { active: false };
  const tz = schedule.tz || 'America/New_York';
  const t = nowInZone(tz, now);
  const day = schedule.days.find((dd) => dd.dow === t.dow);
  if (!day) return { active: false };
  // Off day (startLocal:null): no stream means no vote window, even
  // when the day's kind is community/variety.
  if (!day.startLocal) return { active: false, kind: day.kind, dow: day.dow };
  if (day.kind !== 'variety' && day.kind !== 'community') {
    return { active: false, kind: day.kind, dow: day.dow };
  }
  // v8: 'community' never opens a vote window — Saturday's game is
  // auto-picked weekly (weeklyCommunityPick); the 6-9 PM vote model is
  // retired, so the public payload (site /schedule/public, Twitch-ext
  // /ext/schedule) must not advertise a vote that never opens.
  if (day.kind === 'community') {
    return { active: false, kind: day.kind, dow: day.dow };
  }
  const minutes = t.hour * 60 + t.minute;
  const OPEN = 18 * 60;
  const CLOSE = 21 * 60;
  return {
    active: minutes >= OPEN && minutes < CLOSE,
    kind: day.kind,
    dow: day.dow,
    opensAt: zonedTimeToEpoch(t.y, t.m, t.d, 18, 0, tz),
    closesAt: zonedTimeToEpoch(t.y, t.m, t.d, 21, 0, tz),
  };
}

async function readVoteChannel(env, guildId) {
  try {
    const raw = await env.LOADOUT_BOLTS.get(VOTE_CHANNEL_KEY(guildId), { type: 'json' });
    if (raw && typeof raw.channelId === 'string') return raw;
  } catch { /* ignore */ }
  return null;
}

// ── HTTP read routes (public + extension) ─────────────────────────────
//
// /schedule/public, /games/public, unauth, used by aquilo-site
// /ext/schedule, /ext/games, wired separately in ext.js (JWT-gated)
//
// Identical payload between public + ext, minus any viewer-specific
// data. Phase 3 will add the queue layers on top of this.

const PUBLIC_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET',
  'access-control-allow-headers': 'content-type',
};

function publicJson(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=0, s-maxage=15',
      ...PUBLIC_CORS,
    },
  });
}

export async function handlePublicScheduleHttp(env) {
  const guildId = env.AQUILO_VAULT_GUILD_ID;
  if (!env.LOADOUT_BOLTS || !guildId) {
    return publicJson({ error: 'not-configured' });
  }
  const [schedule, games, voteChannel] = await Promise.all([
    readSchedule(env, guildId),
    readGames(env, guildId),
    readVoteChannel(env, guildId),
  ]);
  const now = Date.now();
  return publicJson({
    schedule,
    games,
    nextStream: nextStreamFrom(schedule, now),
    vote: voteActiveAt(schedule, now),
    voteChannel: voteChannel ? { channelId: voteChannel.channelId, guildId } : null,
    now,
  });
}

export async function handlePublicGamesHttp(env) {
  const guildId = env.AQUILO_VAULT_GUILD_ID;
  if (!env.LOADOUT_BOLTS || !guildId) return publicJson({ error: 'not-configured' });
  const games = await readGames(env, guildId);
  return publicJson({ games });
}

// Called from ext.js when the panel hits /ext/schedule (already
// JWT-gated and channel-locked there, we just need the same payload).
export async function handleExtSchedule(env, guildId) {
  const [schedule, games, voteChannel] = await Promise.all([
    readSchedule(env, guildId),
    readGames(env, guildId),
    readVoteChannel(env, guildId),
  ]);
  const now = Date.now();
  return {
    schedule,
    games,
    nextStream: nextStreamFrom(schedule, now),
    vote: voteActiveAt(schedule, now),
    voteChannel: voteChannel ? { channelId: voteChannel.channelId, guildId } : null,
    now,
  };
}

// ── /schedule ─────────────────────────────────────────────────────────

export async function handleSchedule(env, guildId, options) {
  const sub = options[0] || {};
  const subName = sub.name || '';

  if (subName === 'view') return await scheduleView(env, guildId);
  if (subName === 'set')  return await scheduleSet(env, guildId, sub.options || []);
  if (subName === 'set-tz') return await scheduleSetTz(env, guildId, sub.options || []);
  return reply('Unknown /schedule subcommand.');
}

async function scheduleView(env, guildId) {
  const sch = await readSchedule(env, guildId);
  const lines = sch.days.map((d) => {
    const time = d.startLocal
      ? (d.endLocal ? `${d.startLocal}-${d.endLocal}` : d.startLocal)
      : 'off';
    return `**${DOW_LABELS[d.dow]}** · ${d.label} · ${time} · _${d.kind}_`;
  });
  const stamp = sch.updatedAt
    ? `\n\n_Last edit: <t:${Math.floor(sch.updatedAt / 1000)}:R> via ${sch.updatedBy || '?'}_`
    : '\n\n_Defaults (no edits yet)_';
  return reply(`**Stream schedule** · TZ: \`${sch.tz}\`\n\n${lines.join('\n')}${stamp}`);
}

async function scheduleSet(env, guildId, opts) {
  const map = optionsToMap(opts);
  const dowRaw = map.day;
  const dow = Number(dowRaw);
  if (!Number.isInteger(dow) || dow < 0 || dow > 6) {
    return reply('Pick a day (0-6, Sun-Sat).');
  }
  const sch = await readSchedule(env, guildId);
  const days = sch.days.map((d) => ({ ...d }));
  const day = days.find((d) => d.dow === dow);
  if (!day) return reply('Schedule corruption, day not found. Reset via aquilo.gg /admin.');

  if (typeof map.label === 'string' && map.label.trim()) {
    day.label = map.label.slice(0, 80).trim();
  }
  if (Object.prototype.hasOwnProperty.call(map, 'start')) {
    const v = String(map.start || '').trim();
    if (v === '') {
      day.startLocal = null;
      day.endLocal = null;
    } else if (HH_MM_RE.test(v)) {
      day.startLocal = v;
    } else {
      return reply(`Start time must be HH:MM (got \`${v}\`).`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(map, 'end')) {
    const v = String(map.end || '').trim();
    if (v === '') {
      day.endLocal = null;
    } else if (HH_MM_RE.test(v)) {
      day.endLocal = v;
    } else {
      return reply(`End time must be HH:MM (got \`${v}\`).`);
    }
  }
  if (typeof map.kind === 'string') {
    const k = map.kind.toLowerCase();
    if (SCHEDULE_KINDS.indexOf(k) < 0) {
      return reply(`Kind must be one of: ${SCHEDULE_KINDS.join(', ')}.`);
    }
    day.kind = k;
  }

  await writeSchedule(env, guildId, { ...sch, days });
  const time = day.startLocal
    ? (day.endLocal ? `${day.startLocal}-${day.endLocal}` : day.startLocal)
    : 'off';
  return reply(`✅ ${DOW_LABELS[dow]}: **${day.label}** · ${time} · _${day.kind}_`);
}

async function scheduleSetTz(env, guildId, opts) {
  const tz = String(optionsToMap(opts).tz || '').trim();
  if (!tz || tz.length > 48) return reply('TZ name required (e.g. America/New_York).');
  // Quick validity check via Intl.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    return reply(`Unknown timezone: \`${tz}\`. Use an IANA name like America/New_York.`);
  }
  const sch = await readSchedule(env, guildId);
  await writeSchedule(env, guildId, { ...sch, tz });
  return reply(`✅ Schedule timezone set to \`${tz}\`.`);
}

// ── /games ────────────────────────────────────────────────────────────

export async function handleGames(env, guildId, options) {
  const sub = options[0] || {};
  const subName = sub.name || '';

  if (subName === 'view')      return await gamesView(env, guildId);
  if (subName === 'add')       return await gamesAdd(env, guildId, sub.options || []);
  if (subName === 'remove')    return await gamesRemove(env, guildId, sub.options || []);
  if (subName === 'set-pools') return await gamesSetPools(env, guildId, sub.options || []);
  return reply('Unknown /games subcommand.');
}

async function gamesView(env, guildId) {
  const cat = await readGames(env, guildId);
  if (cat.items.length === 0) return reply('No games in the catalog. Add one with `/games add steam:<appid>`.');
  const lines = cat.items.map((g) => {
    const pools = g.pools.join('+') || '-';
    const steam = g.steamAppId ? `Steam ${g.steamAppId}` : 'custom';
    return `• **${g.name}** · \`${g.id}\` · ${steam} · pools: ${pools}`;
  });
  const stamp = cat.updatedAt
    ? `\n\n_Last edit: <t:${Math.floor(cat.updatedAt / 1000)}:R> via ${cat.updatedBy || '?'}_`
    : '';
  return reply(`**Game catalog** (${cat.items.length})\n\n${lines.join('\n')}${stamp}`);
}

async function gamesAdd(env, guildId, opts) {
  const map = optionsToMap(opts);
  const appId = Number(map.steam);
  if (!Number.isInteger(appId) || appId <= 0) {
    return reply('Need a positive Steam appid.');
  }

  // One Steam call gives us the real name AND the real header/capsule URLs
  // (the deterministic guess fails for newer titles served from hashed
  // paths). Fall back to the legacy guess only when Steam is unreachable.
  const real = await fetchSteamArt(appId);
  let name = String(map.name || '').trim();
  if (!name) name = (real && real.name) || `App ${appId}`;
  const art = real && real.headerUrl
    ? {
        headerUrl: real.headerUrl,
        capsuleUrl: real.capsuleUrl || '',
        storeUrl: real.storeUrl,
      }
    : steamArtUrls(appId);

  const id = gameSlug(name);
  const pools = poolsFromChoice(map.pools);

  const cat = await readGames(env, guildId);
  if (cat.items.some((g) => g.steamAppId === appId)) {
    return reply(`Already in the catalog: **${name}** (appid ${appId}).`);
  }
  let finalId = id;
  while (cat.items.some((g) => g.id === finalId)) finalId += '-x';

  const item = {
    id: finalId,
    name: name.slice(0, 80),
    steamAppId: appId,
    storeUrl: art.storeUrl,
    headerUrl: art.headerUrl,
    capsuleUrl: art.capsuleUrl,
    accent: '#7c5cff',
    pools,
    addedAt: Date.now(),
    addedBy: 'discord',
  };
  cat.items.push(item);
  await writeGames(env, guildId, cat);
  return reply(`✅ Added **${item.name}** (\`${item.id}\`, appid ${appId}), pools: ${pools.join('+')}.`);
}

async function gamesRemove(env, guildId, opts) {
  const id = String(optionsToMap(opts).id || '').trim();
  if (!id) return reply('Need an id (slug). Run `/games view` for the list.');
  const cat = await readGames(env, guildId);
  const before = cat.items.length;
  cat.items = cat.items.filter((g) => g.id !== id);
  if (cat.items.length === before) return reply(`No game with id \`${id}\`.`);
  await writeGames(env, guildId, cat);
  return reply(`🗑 Removed \`${id}\`.`);
}

async function gamesSetPools(env, guildId, opts) {
  const map = optionsToMap(opts);
  const id = String(map.id || '').trim();
  if (!id) return reply('Need an id (slug). Run `/games view` for the list.');
  const pools = poolsFromChoice(map.pools);
  const cat = await readGames(env, guildId);
  const item = cat.items.find((g) => g.id === id);
  if (!item) return reply(`No game with id \`${id}\`.`);
  item.pools = pools;
  await writeGames(env, guildId, cat);
  return reply(`✅ **${item.name}** pools: ${pools.join('+')}.`);
}

// ── Helpers ───────────────────────────────────────────────────────────
function optionsToMap(opts) {
  const out = {};
  for (const o of opts || []) {
    if (o && typeof o.name === 'string') out[o.name] = o.value;
  }
  return out;
}
