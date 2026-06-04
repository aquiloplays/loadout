// Schedule Rotation slot + Fallout 4 CC + per-night overrides
// (2026-06-03 v3 final). NOTE: distinct from rotation.js, which is the
// Twitch song-request backend. This module owns the weekly stream
// Rotation pick, the per-night override layers, and the Fallout 4 CC
// thumbnail. It replaces triple-c.js / dad-sunday.js.
//
// Schedule v3 final structure:
//   Sun / Tue / Thu -> Rotation slot (admin-picked, one game for all three)
//   Mon / Wed / Fri -> Fallout 4 CC: Chaos Workout Challenge (fixed)
//   Sat             -> Community Night (7-game pool)
//
// KV:
//   rotation:current:<g>        { gameSlug, name, artUrl, setUtc, setBy }
//   rotation:override:<g>:<dow> { gameSlug, name, artUrl }  (dow 0..6)
//   schedule:override:<g>:<ISO> { gameSlug, name, artUrl }  (one-shot date)
//   fo4cc:thumbnail:<g>         "<url>"  (custom thumbnail, else FO4 header)
//
// Endpoints (wired in worker/web):
//   GET  /rotation/current            public  current rotation game
//   GET  /rotation/pool               public  the 23-game pool (admin dropdown)
//   POST /web/admin/rotation/set      owner   { gameSlug } -> lock + announce
//   POST /web/admin/rotation/override owner   { dow, gameSlug|null } per-weekday
//   POST /web/admin/schedule/override owner   { date, gameSlug|null } one-shot
//   POST /web/admin/fo4cc/thumbnail   owner   { url|null } set/clear thumbnail

const CUR_KEY  = (g) => `rotation:current:${g}`;
const DOW_KEY  = (g, dow) => `rotation:override:${g}:${dow}`;
const DATE_KEY = (g, iso) => `schedule:override:${g}:${iso}`;
const THUMB_KEY = (g) => `fo4cc:thumbnail:${g}`;

const FO4_APPID = 377160;
export const FO4CC_SHOW_NAME = 'Fallout 4 CC: Chaos Workout Challenge';
const steamHeader = (appId) => `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`;

// The 23-game rotation pool (Hollow Knight de-duped). appId drives the
// header art; null appId games render a gradient fallback until art is
// added.
const ROTATION_POOL = [
  { gameSlug: 'bg3',                   name: "Baldur's Gate 3",             appId: 1086940 },
  { gameSlug: 'ale_tale_tavern',       name: 'Ale & Tale Tavern',           appId: 2683150 },
  { gameSlug: 'baby_steps',            name: 'Baby Steps',                  appId: 2917180 },
  { gameSlug: 'cult_lamb',             name: 'Cult of the Lamb',            appId: 1313140 },
  { gameSlug: 'waterpark_simulator',   name: 'Waterpark Simulator',         appId: 3215740 },
  { gameSlug: 'eldenring',             name: 'Elden Ring',                  appId: 1245620 },
  { gameSlug: 'skyrim_se',             name: 'The Elder Scrolls V: Skyrim', appId: 489830 },
  { gameSlug: 'hades',                 name: 'Hades',                       appId: 1145360 },
  { gameSlug: 'hollow_knight',         name: 'Hollow Knight',               appId: 367520 },
  { gameSlug: 'kcd2',                  name: 'Kingdom Come: Deliverance II', appId: 1771300 },
  { gameSlug: 'blue_prince',           name: 'Blue Prince',                 appId: 1569580 },
  { gameSlug: 'retro_rewind',          name: 'Retro Rewind',                appId: null },
  { gameSlug: 'stardew',               name: 'Stardew Valley',              appId: 413150 },
  { gameSlug: 'supermarket_simulator', name: 'Supermarket Simulator',       appId: 2670630 },
  { gameSlug: 'witcher3',              name: 'The Witcher 3: Wild Hunt',    appId: 292030 },
  { gameSlug: 'schedule_1',            name: 'Schedule 1',                  appId: 3164500 },
  { gameSlug: 'rdr2',                  name: 'Red Dead Redemption 2',       appId: 1174180 },
  { gameSlug: 'borderlands2',          name: 'Borderlands 2',               appId: 49520 },
  { gameSlug: 'borderlands3',          name: 'Borderlands 3',               appId: 397540 },
  { gameSlug: 'dredge',                name: 'Dredge',                      appId: 1562430 },
  { gameSlug: 'cyberpunk2077',         name: 'Cyberpunk 2077',              appId: 1091500 },
  { gameSlug: 'silksong',              name: 'Hollow Knight: Silksong',     appId: 1030300 },
  { gameSlug: 'rimworld',              name: 'RimWorld',                    appId: 294100 },
];

function entryFor(slug) {
  const o = ROTATION_POOL.find((x) => x.gameSlug === slug);
  if (!o) return null;
  return { gameSlug: o.gameSlug, name: o.name, artUrl: o.appId ? steamHeader(o.appId) : null };
}

export function getRotationPool() {
  return ROTATION_POOL.map((o) => ({
    gameSlug: o.gameSlug, name: o.name, artUrl: o.appId ? steamHeader(o.appId) : null,
  }));
}

function gid(env, guildId) {
  return guildId || String(env.AQUILO_VAULT_GUILD_ID || '').trim();
}

// ── Rotation current + per-weekday override ─────────────────────

// The rotation game for a given day-of-week: per-weekday override first,
// then the week's rotation pick, else null.
export async function getCurrentRotation(env, guildId, dow) {
  const g = gid(env, guildId);
  if (dow !== undefined && dow !== null) {
    try {
      const ov = await env.LOADOUT_BOLTS.get(DOW_KEY(g, dow), { type: 'json' });
      if (ov && ov.gameSlug && ov.name) return { ...ov, override: 'dow' };
    } catch { /* ignore */ }
  }
  try {
    const cur = await env.LOADOUT_BOLTS.get(CUR_KEY(g), { type: 'json' });
    if (cur && cur.gameSlug && cur.name) return cur;
  } catch { /* ignore */ }
  return null;
}

export async function setCurrentRotation(env, guildId, gameSlug, setBy) {
  const g = gid(env, guildId);
  const entry = entryFor(String(gameSlug || '').trim());
  if (!entry) return { ok: false, error: 'unknown-game', allowed: ROTATION_POOL.map((o) => o.gameSlug) };
  const rec = { ...entry, setUtc: Date.now(), setBy: setBy || null };
  await env.LOADOUT_BOLTS.put(CUR_KEY(g), JSON.stringify(rec));
  return { ok: true, current: rec };
}

// Per-weekday rotation override. dow 0..6; gameSlug='' or null clears it.
export async function setRotationOverride(env, guildId, dow, gameSlug) {
  const g = gid(env, guildId);
  const d = Number(dow);
  if (!Number.isInteger(d) || d < 0 || d > 6) return { ok: false, error: 'bad-dow' };
  const slug = String(gameSlug || '').trim();
  if (!slug) { await env.LOADOUT_BOLTS.delete(DOW_KEY(g, d)); return { ok: true, cleared: true, dow: d }; }
  const entry = entryFor(slug);
  if (!entry) return { ok: false, error: 'unknown-game' };
  await env.LOADOUT_BOLTS.put(DOW_KEY(g, d), JSON.stringify(entry));
  return { ok: true, dow: d, override: entry };
}

// ── General one-shot per-date override (any night, incl. M/W/F) ──

export async function getDateOverride(env, guildId, iso) {
  const g = gid(env, guildId);
  if (!iso) return null;
  try {
    const ov = await env.LOADOUT_BOLTS.get(DATE_KEY(g, iso), { type: 'json' });
    if (ov && ov.gameSlug && ov.name) return ov;
  } catch { /* ignore */ }
  return null;
}

// date = YYYY-MM-DD; gameSlug='' or null clears. 8-day TTL so a one-shot
// override self-destructs after the night passes.
export async function setDateOverride(env, guildId, date, gameSlug) {
  const g = gid(env, guildId);
  const iso = String(date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return { ok: false, error: 'bad-date' };
  const slug = String(gameSlug || '').trim();
  if (!slug) { await env.LOADOUT_BOLTS.delete(DATE_KEY(g, iso)); return { ok: true, cleared: true, date: iso }; }
  const entry = entryFor(slug);
  if (!entry) return { ok: false, error: 'unknown-game' };
  await env.LOADOUT_BOLTS.put(DATE_KEY(g, iso), JSON.stringify(entry), { expirationTtl: 8 * 86400 });
  return { ok: true, date: iso, override: entry };
}

// ── Fallout 4 CC ────────────────────────────────────────────────

// The fixed M/W/F show. artUrl = custom uploaded thumbnail, else the FO4
// Steam header placeholder. The game name carries the show branding so
// both the embed and the site read "Fallout 4 CC: Chaos Workout Challenge".
export async function getFo4cc(env, guildId) {
  const g = gid(env, guildId);
  let thumb = null;
  try { thumb = await env.LOADOUT_BOLTS.get(THUMB_KEY(g)); } catch { /* ignore */ }
  return {
    gameSlug: 'fallout4-cc',
    name: FO4CC_SHOW_NAME,
    artUrl: (thumb && thumb.trim()) || steamHeader(FO4_APPID),
    store: `https://store.steampowered.com/app/${FO4_APPID}/`,
  };
}

export async function setFo4ccThumbnail(env, guildId, url) {
  const g = gid(env, guildId);
  const u = String(url || '').trim();
  if (!u) { await env.LOADOUT_BOLTS.delete(THUMB_KEY(g)); return { ok: true, cleared: true }; }
  if (!/^https?:\/\//i.test(u)) return { ok: false, error: 'bad-url' };
  await env.LOADOUT_BOLTS.put(THUMB_KEY(g), u);
  return { ok: true, url: u };
}

// ── Discord announce (best-effort) ──────────────────────────────

export async function announceRotation(env, current) {
  if (!env.DISCORD_BOT_TOKEN || !current) return { ok: false, error: 'no-bot-token' };
  const channelId = String(env.SCHEDULE_CHANNEL_ID || '1507973920282640485').trim();
  if (!channelId) return { ok: false, error: 'no-channel' };
  const embed = {
    title: `🔁 Rotation is now: ${current.name}`,
    description: `This week's rotation game is locked in.\nPlays **Sun · Tue · Thu** at **10:30 PM ET**.`,
    color: 0x5ad1ff,
    image: current.artUrl ? { url: current.artUrl } : undefined,
    footer: { text: 'Rotation slot' },
  };
  const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] }),
  });
  return { ok: r.ok, status: r.status };
}
