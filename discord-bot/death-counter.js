// Per-game persistent death counter.
//
// 2026-06. One OBS overlay + one Stream Deck button: the button POSTs
// /web/admin/death-count/increment, the worker resolves Clay's current
// Twitch category, bumps that game's counter, and publishes a
// `death.recorded` Aquilo-Bus event so the overlay updates live.
//
// Auth model (this subsystem is its own thing, not the site HMAC):
//   • Writes (increment, set) + the bulk read (all) are gated by a
//     static token in env.STREAMDECK_TOKEN, supplied as the
//     `x-streamdeck-token` header OR a `?token=` query param. This is
//     the simplest thing that works for a single local Stream Deck
//     button (no HMAC signing on the device).
//   • Per-game + current reads are public (CORS-open), overlays need
//     them with no secret baked into the browser source.
//
// KV:  death-count:<gameSlug> = { count, lastUpdated, name }
//
// Routes (all intercepted at the worker top level, before the generic
// POST-only /web HMAC router):
//   POST /web/admin/death-count/increment          token  → bump current game
//   POST /web/admin/death-count/set/:slug/:count    token  → set a count
//   GET  /web/death-count/:slug                     public → one game's count
//   GET  /web/death-count/current                   public → current game's count
//   GET  /web/death-count/all                       token  → every game + count

import { getChannelGame } from './twitch-helix.js';
import { publishActivity } from './activity-do.js';

const KEY = (slug) => `death-count:${slug}`;

// The seedable roster, slug → display name. Mirrors the 2026-06
// schedule pools (Triple-C 23 + Variety 8 + Community 11 = 42).
export const DEATH_GAMES = {
  // Triple-C pool
  fallout4: 'Fallout 4',
  eldenring: 'Elden Ring',
  skyrim_se: 'Skyrim (Special Edition)',
  borderlands2: 'Borderlands 2',
  borderlands3: 'Borderlands 3',
  witcher3: 'The Witcher 3',
  cyberpunk2077: 'Cyberpunk 2077',
  re_series: 'Resident Evil (series)',
  mgs_delta: 'Metal Gear Solid DELTA',
  minecraft: 'Minecraft',
  baby_steps: 'Baby Steps',
  hades: 'HADES',
  hollow_knight: 'Hollow Knight',
  silksong: 'Hollow Knight: Silksong',
  kcd2: 'Kingdom Come: Deliverance 2',
  blue_prince: 'Blue Prince',
  bg3: "Baldur's Gate 3",
  dredge: 'DREDGE',
  stardew: 'Stardew Valley',
  celeste: 'Celeste',
  cult_lamb: 'Cult of the Lamb',
  rdr2: 'Red Dead Redemption 2',
  isaac: 'The Binding of Isaac',
  // Variety pool
  a_difficult_game_about_climbing: 'A Difficult Game About Climbing',
  ball_x_pit: 'BALL x PIT',
  megabonk: 'Megabonk',
  flip_master: 'Flip Master',
  sts2: 'Slay the Spire 2',
  clover_pit: 'CloverPit',
  balatro: 'Balatro',
  vampire_crawlers: 'Vampire Crawlers',
  // Community pool
  among_us: 'Among Us',
  dbd: 'Dead by Daylight',
  fortnite: 'Fortnite',
  phasmophobia: 'Phasmophobia',
  peak: 'PEAK',
  repo: 'R.E.P.O.',
  lethal_company: 'Lethal Company',
  rv_there_yet: 'RV There Yet?',
  gwyf: 'Gamble With Your Friends',
  pratfall: 'Pratfall',
  content_warning: 'Content Warning',
};

// Twitch category names → slug. Twitch's `game_name` rarely matches a
// slug verbatim, so we normalize both sides and keep an alias list for
// the titles whose Twitch category differs from our display name.
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const TWITCH_ALIASES = {
  fallout4: ['Fallout 4'],
  eldenring: ['Elden Ring', 'ELDEN RING', 'Elden Ring: Nightreign'],
  skyrim_se: ['The Elder Scrolls V: Skyrim', 'The Elder Scrolls V: Skyrim Special Edition', 'Skyrim'],
  borderlands2: ['Borderlands 2'],
  borderlands3: ['Borderlands 3'],
  witcher3: ['The Witcher 3: Wild Hunt', 'The Witcher 3'],
  cyberpunk2077: ['Cyberpunk 2077'],
  re_series: ['Resident Evil', 'Resident Evil 2', 'Resident Evil 3', 'Resident Evil 4',
              'Resident Evil 5', 'Resident Evil 6', 'Resident Evil 7', 'Resident Evil Village'],
  mgs_delta: ['Metal Gear Solid Δ: Snake Eater', 'Metal Gear Solid Delta: Snake Eater',
              'Metal Gear Solid DELTA'],
  minecraft: ['Minecraft'],
  baby_steps: ['Baby Steps'],
  hades: ['Hades', 'Hades II'],
  hollow_knight: ['Hollow Knight'],
  silksong: ['Hollow Knight: Silksong'],
  kcd2: ['Kingdom Come: Deliverance II', 'Kingdom Come: Deliverance 2'],
  blue_prince: ['Blue Prince'],
  bg3: ["Baldur's Gate 3", 'Baldurs Gate 3'],
  dredge: ['DREDGE', 'Dredge'],
  stardew: ['Stardew Valley'],
  celeste: ['Celeste'],
  cult_lamb: ['Cult of the Lamb'],
  rdr2: ['Red Dead Redemption 2', 'Red Dead Redemption II'],
  isaac: ['The Binding of Isaac: Repentance', 'The Binding of Isaac', 'The Binding of Isaac: Rebirth'],
  a_difficult_game_about_climbing: ['A Difficult Game About Climbing'],
  ball_x_pit: ['BALL x PIT', 'BALL X PIT'],
  megabonk: ['Megabonk'],
  flip_master: ['Flip Master'],
  sts2: ['Slay the Spire 2'],
  clover_pit: ['CloverPit', 'Clover Pit'],
  balatro: ['Balatro'],
  vampire_crawlers: ['Vampire Crawlers'],
  among_us: ['Among Us'],
  dbd: ['Dead by Daylight'],
  fortnite: ['Fortnite'],
  phasmophobia: ['Phasmophobia'],
  peak: ['PEAK'],
  repo: ['R.E.P.O.', 'REPO'],
  lethal_company: ['Lethal Company'],
  rv_there_yet: ['RV There Yet?', 'RV There Yet'],
  gwyf: ['Gamble With Your Friends'],
  pratfall: ['Pratfall'],
  content_warning: ['Content Warning'],
};

// Reverse index: normalized twitch/display name → slug. Built once.
const NAME_INDEX = (() => {
  const idx = {};
  for (const [slug, name] of Object.entries(DEATH_GAMES)) idx[norm(name)] = slug;
  for (const [slug, names] of Object.entries(TWITCH_ALIASES)) {
    for (const n of names) idx[norm(n)] = slug;
  }
  return idx;
})();

function slugForTwitchGame(gameName) {
  if (!gameName) return null;
  const key = norm(gameName);
  if (NAME_INDEX[key]) return NAME_INDEX[key];
  // Prefix fallback (e.g. "Resident Evil 4 Remake" → re_series).
  for (const [n, slug] of Object.entries(NAME_INDEX)) {
    if (key.startsWith(n) || n.startsWith(key)) return slug;
  }
  return null;
}

// ── KV helpers ──────────────────────────────────────────────────

async function readCount(env, slug) {
  const rec = await env.LOADOUT_BOLTS.get(KEY(slug), { type: 'json' }).catch(() => null);
  if (rec && Number.isFinite(rec.count)) return rec;
  // Lazy default for any known game not yet seeded.
  return { count: 0, lastUpdated: 0, name: DEATH_GAMES[slug] || slug };
}

async function writeCount(env, slug, count) {
  const rec = { count: Math.max(0, Math.floor(count)), lastUpdated: Date.now(), name: DEATH_GAMES[slug] || slug };
  await env.LOADOUT_BOLTS.put(KEY(slug), JSON.stringify(rec));
  return rec;
}

// Seed every roster game at 0 if it has no record yet. Idempotent, // existing counts are never overwritten.
export async function seedDeathCounts(env) {
  let seeded = 0, existing = 0;
  for (const [slug, name] of Object.entries(DEATH_GAMES)) {
    const cur = await env.LOADOUT_BOLTS.get(KEY(slug), { type: 'json' }).catch(() => null);
    if (cur && Number.isFinite(cur.count)) { existing++; continue; }
    await env.LOADOUT_BOLTS.put(KEY(slug), JSON.stringify({ count: 0, lastUpdated: 0, name }));
    seeded++;
  }
  return { ok: true, seeded, existing, total: Object.keys(DEATH_GAMES).length };
}

// ── HTTP plumbing ───────────────────────────────────────────────

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS',
               'access-control-allow-headers': 'content-type, x-streamdeck-token' };

function jsonResp(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...CORS, ...extraHeaders },
  });
}

function tokenOk(req, env, url) {
  const want = String(env.STREAMDECK_TOKEN || '').trim();
  if (!want) return false; // not configured → deny all writes
  const got = (req.headers.get('x-streamdeck-token') || url.searchParams.get('token') || '').trim();
  return got.length > 0 && got === want;
}

// ── Router (top-level intercept) ────────────────────────────────

export async function handleDeathCount(req, env, path) {
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  // ---- Writes (token-gated) ----
  if (req.method === 'POST' && path === '/web/admin/death-count/increment') {
    if (!tokenOk(req, env, url)) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
    return await incrementCurrent(env, url);
  }
  const setMatch = path.match(/^\/web\/admin\/death-count\/set\/([^/]+)\/(-?\d+)$/);
  if (req.method === 'POST' && setMatch) {
    if (!tokenOk(req, env, url)) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
    const slug = decodeURIComponent(setMatch[1]);
    if (!DEATH_GAMES[slug]) return jsonResp({ ok: false, error: 'unknown-game', slug }, 404);
    const rec = await writeCount(env, slug, parseInt(setMatch[2], 10));
    return jsonResp({ ok: true, gameSlug: slug, newCount: rec.count, name: rec.name });
  }

  // ---- Reads ----
  if (req.method === 'GET' && path === '/web/death-count/all') {
    if (!tokenOk(req, env, url)) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
    const games = [];
    for (const slug of Object.keys(DEATH_GAMES)) {
      const rec = await readCount(env, slug);
      games.push({ gameSlug: slug, name: rec.name, count: rec.count, lastUpdated: rec.lastUpdated });
    }
    return jsonResp({ ok: true, games, total: games.length });
  }
  if (req.method === 'GET' && path === '/web/death-count/current') {
    const resolved = await resolveCurrentSlug(env);
    if (!resolved.slug) {
      return jsonResp({ ok: true, gameSlug: null, count: null, matched: false,
                        twitchGame: resolved.gameName || null }, 200,
                       { 'cache-control': 'public, max-age=15' });
    }
    const rec = await readCount(env, resolved.slug);
    return jsonResp({ ok: true, gameSlug: resolved.slug, name: rec.name, count: rec.count,
                      matched: true, twitchGame: resolved.gameName || null }, 200,
                     { 'cache-control': 'public, max-age=15' });
  }
  const getMatch = req.method === 'GET' && path.match(/^\/web\/death-count\/([^/]+)$/);
  if (getMatch) {
    const slug = decodeURIComponent(getMatch[1]);
    if (!DEATH_GAMES[slug]) return jsonResp({ ok: false, error: 'unknown-game', slug }, 404);
    const rec = await readCount(env, slug);
    return jsonResp({ ok: true, gameSlug: slug, name: rec.name, count: rec.count,
                      lastUpdated: rec.lastUpdated }, 200,
                     { 'cache-control': 'public, max-age=10' });
  }

  return jsonResp({ ok: false, error: 'not-found' }, 404);
}

// Resolve { slug, gameName } for Clay's current Twitch category.
async function resolveCurrentSlug(env) {
  const broadcasterId = String(env.CLAY_TWITCH_CHANNEL_ID || '').trim();
  if (!broadcasterId) return { slug: null, gameName: null, error: 'no-channel-id' };
  const ch = await getChannelGame(env, broadcasterId).catch(() => null);
  if (!ch || !ch.gameName) return { slug: null, gameName: ch?.gameName || null, error: 'no-category' };
  return { slug: slugForTwitchGame(ch.gameName), gameName: ch.gameName };
}

async function incrementCurrent(env, url) {
  // Optional explicit override (?gameSlug=), lets Stream Deck target a
  // specific game, and makes the endpoint testable while offline.
  let slug = (url.searchParams.get('gameSlug') || '').trim() || null;
  let gameName = slug ? DEATH_GAMES[slug] : null;
  if (!slug) {
    const resolved = await resolveCurrentSlug(env);
    slug = resolved.slug;
    gameName = resolved.gameName;
    if (!slug) {
      return jsonResp({ ok: false, error: 'no-matching-game', twitchGame: gameName || null,
                        hint: 'Set the Twitch category to a rostered game, or pass ?gameSlug=' }, 409);
    }
  }
  if (!DEATH_GAMES[slug]) return jsonResp({ ok: false, error: 'unknown-game', slug }, 404);

  const cur = await readCount(env, slug);
  const rec = await writeCount(env, slug, cur.count + 1);

  // Aquilo Bus, overlay updates live, no polling.
  await publishActivity(env, {
    kind: 'death.recorded',
    gameSlug: slug,
    gameName: rec.name,
    newCount: rec.count,
    timestamp: rec.lastUpdated,
  }).catch(() => {});

  return jsonResp({ ok: true, gameSlug: slug, newCount: rec.count, name: rec.name });
}
