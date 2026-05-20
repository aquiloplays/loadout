// Schedule + games-catalog Discord write surface.
//
// Mirrors aquilo-site's /api/admin/schedule and /api/admin/games. Both
// surfaces write the same LOADOUT_BOLTS KV keys so either is usable in
// isolation:
//
//   schedule:v1:<guildId>  — { version, tz, updatedAt, updatedBy, days[7] }
//   games:v1:<guildId>     — { version, updatedAt, updatedBy, items[] }
//
// Both records carry an `updatedBy` of "web" or "discord" so it's clear
// which surface made the last edit. See aquilo-site/SCHEDULE-SYSTEM-DESIGN.md
// for the full data model.
//
// MANAGE_GUILD is enforced by Discord via the slash commands'
// default_member_permissions in commands-spec.js — no extra in-handler
// gate needed.

const FLAG_EPHEMERAL = 64;
const RESP_CHAT = 4;

const DOW_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SCHEDULE_KINDS = ['fixed', 'variety', 'community'];
const POOL_KINDS = ['community', 'variety'];
const HH_MM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const SCHEDULE_KEY = (g) => `schedule:v1:${g}`;
const GAMES_KEY    = (g) => `games:v1:${g}`;

const DEFAULT_SCHEDULE = {
  version: 1,
  tz: 'America/New_York',
  updatedAt: 0,
  updatedBy: null,
  days: [
    { dow: 0, label: 'Aquilo & Schnozz Sunday Streams', kind: 'fixed',     startLocal: '22:30', endLocal: '00:30' },
    { dow: 1, label: 'Minecraft',                       kind: 'fixed',     startLocal: '22:30', endLocal: '00:30' },
    { dow: 2, label: 'Minecraft',                       kind: 'fixed',     startLocal: '22:30', endLocal: '00:30' },
    { dow: 3, label: 'Variety Night',                   kind: 'variety',   startLocal: '22:30', endLocal: '00:30' },
    { dow: 4, label: 'Minecraft',                       kind: 'fixed',     startLocal: '22:30', endLocal: '00:30' },
    { dow: 5, label: 'Community Night',                 kind: 'community', startLocal: '22:30', endLocal: '00:30' },
    { dow: 6, label: 'Community Night',                 kind: 'community', startLocal: '22:30', endLocal: '00:30' },
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

function steamArtUrls(appId) {
  const id = String(appId);
  return {
    headerUrl:  `https://cdn.akamai.steamstatic.com/steam/apps/${id}/header.jpg`,
    capsuleUrl: `https://cdn.akamai.steamstatic.com/steam/apps/${id}/capsule_616x353.jpg`,
    storeUrl:   `https://store.steampowered.com/app/${id}/`,
  };
}

function poolsFromChoice(raw) {
  switch ((raw || '').toLowerCase()) {
    case 'community': return ['community'];
    case 'variety':   return ['variety'];
    case 'both':      return ['community', 'variety'];
    default:          return ['community', 'variety'];
  }
}

async function readSchedule(env, guildId) {
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
      ? (d.endLocal ? `${d.startLocal}–${d.endLocal}` : d.startLocal)
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
    return reply('Pick a day (0–6, Sun–Sat).');
  }
  const sch = await readSchedule(env, guildId);
  const days = sch.days.map((d) => ({ ...d }));
  const day = days.find((d) => d.dow === dow);
  if (!day) return reply('Schedule corruption — day not found. Reset via aquilo.gg /admin.');

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
    ? (day.endLocal ? `${day.startLocal}–${day.endLocal}` : day.startLocal)
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
    const pools = g.pools.join('+') || '—';
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

  let name = String(map.name || '').trim();
  if (!name) {
    // Try to resolve the name from Steam's appdetails.
    name = (await fetchSteamName(appId)) || `App ${appId}`;
  }
  const id = gameSlug(name);
  const art = steamArtUrls(appId);
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
  return reply(`✅ Added **${item.name}** (\`${item.id}\`, appid ${appId}) — pools: ${pools.join('+')}.`);
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

// ── Steam appdetails name resolution ──────────────────────────────────
async function fetchSteamName(appId) {
  try {
    const res = await fetch(
      `https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(appId)}&filters=basic&cc=us`,
      { headers: { 'User-Agent': 'aquilo.gg/1.0' } },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const entry = data && data[String(appId)];
    if (entry && entry.success && entry.data && entry.data.name) return String(entry.data.name);
  } catch { /* ignore */ }
  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────
function optionsToMap(opts) {
  const out = {};
  for (const o of opts || []) {
    if (o && typeof o.name === 'string') out[o.name] = o.value;
  }
  return out;
}
