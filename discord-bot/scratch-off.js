// Twitch panel scratch-off cards.
//
// Viewers spend Twitch bits via the panel to mint a scratch-off ticket.
// The card has a tactile pointer-drag scratch interaction (client-side,
// in aquilo-site). Most cards lose; ~HIT_RATE hit. The OUTCOME IS DECIDED
// SERVER-SIDE AT MINT TIME and withheld from the client until the viewer
// has physically scratched past REVEAL_THRESHOLD, so a viewer cannot read
// the result early off the wire. On a hit the outcome is either a
// chat-driven CHALLENGE (Clay performs it live) or a Streamer.bot TAMPER
// (invert mouse, swap WASD, mute mic, …) that fires through the Aquilo Bus
// to a Loadout-side relay (see SCRATCH-OFF-STREAMERBOT.md).
//
// The current game is detected from Clay's Twitch category (getChannelGame
// in twitch-helix.js, same lookup the death counter uses) and normalized
// to a slug; that drives both the themed outcome pool and the panel's
// per-game card art.
//
// Storage: D1 env.DB (scratch_ticket / scratch_outcome_pool /
// scratch_streamer_bot_action, see scratch-off-migration.sql). The schema
// is also self-applied lazily (ensureSchema) so a missed migration
// degrades gracefully. Live updates fan out on the Aquilo Bus via
// publishActivity() as scratch.* events.
//
// Conventions (match death-counter.js / vault-community.js / aether.js):
//   - db(env) guard, .prepare().bind().run()/all()/first()
//   - ms-epoch timestamps (Date.now()); ids bound as String()
//   - JSON columns parsed/stringified in JS
//   - public reads are CORS-open + short-cached; mutations are gated

import { publishActivity } from './activity-do.js';
import { getChannelGame, getStreamInfo } from './twitch-helix.js';
import { enqueueOverlay } from './ext-engage.js';
import { discordPostMessage } from './bolts-feed.js';
import { STREAMER_BOT_ACTIONS, LOSS_LINES, POOLS } from './scratch-challenges.js';

// ── Tunables ───────────────────────────────────────────────────────────

// Unified outcome rates. Every ticket can land a game challenge OR a workout
// challenge OR nothing. Both win bands are pacing-gated. Roughly 6% + 6% =>
// ~88% nothing. Tunable live via scratch:cfg (admin) without a redeploy.
const HIT_RATE = 0.08;            // legacy single-band rate (kept for cfg compat)
const GAME_HIT_RATE = 0.06;       // ~6% land a game-themed challenge/tamper
const WORKOUT_HIT_RATE = 0.06;    // ~6% land a universal workout challenge
const BIT_COST = 100;             // ticket price in bits (locked; cfg.bitCost overrides)
const REVEAL_THRESHOLD = 70;      // % scratched before the outcome reveals
const SCRATCH_SKUS = new Set([    // Twitch product SKUs that mint a card
  'scratch_card_100', 'scratch_card', 'aquilo_scratch_100',
]);

// ── Pacing guards (so a hot pool never overwhelms Clay) ─────────────────
// Hits are rate-limited PER STREAM SESSION (keyed on the live Twitch stream
// id). A roll that would win is downgraded to a loss when the cap is hit or
// the cooldown has not elapsed, outcome is still decided server-side at
// mint, just bounded. Tunable without a redeploy via the scratch:cfg KV
// (admin endpoint below); these are the defaults.
const MAX_HITS_PER_STREAM = 4;          // 3-5 hits/stream ceiling
const HIT_COOLDOWN_MS = 12 * 60 * 1000; // 12 min between consecutive hits
const CONSOLATION_MIN = 1;              // tiny loss reward floor (bolts)
const CONSOLATION_MAX = 5;              // tiny loss reward ceiling (bolts)
const STREAM_STATE_TTL = 8 * 60 * 60;   // per-stream counter lifetime (s)

// KV (LOADOUT_BOLTS) keys for the scratch pacing/economy state.
const K_STREAM = (sid) => `scratch:stream:${sid}`;       // { hits, lastHitAt }
const K_CONSOL = (uid) => `scratch:consol:${uid}`;       // running bolt tally
const K_PAUSED = 'scratch:paused';                       // '1' while paused
const K_CFG = 'scratch:cfg';                             // optional overrides
// Admin-editable content overlays (layered over the code seed; KV wins).
const K_GAMES = 'scratch:games';        // map slug -> {name,accent,accent2,icon,deep,tag,aliases}
const K_CHALLENGES = 'scratch:challenges'; // full editable challenge list (array); reseeds D1
const K_TAMPERS = 'scratch:tampers';    // map action_key -> {actionName,defaultDurationSec,description,pending}

// ── Game roster + slug resolution ──────────────────────────────────────
// Slugs are kept identical to the death-counter roster so a game resolves
// to the same slug everywhere. Self-contained here (death-counter.js is a
// shipped, do-not-touch subsystem) but reusing getChannelGame() per spec.

export const GAMES = {
  fallout4: 'Fallout 4', eldenring: 'Elden Ring', skyrim_se: 'Skyrim (Special Edition)',
  borderlands2: 'Borderlands 2', borderlands3: 'Borderlands 3', witcher3: 'The Witcher 3',
  cyberpunk2077: 'Cyberpunk 2077', re_series: 'Resident Evil (series)',
  mgs_delta: 'Metal Gear Solid DELTA', minecraft: 'Minecraft', baby_steps: 'Baby Steps',
  hades: 'HADES', hollow_knight: 'Hollow Knight', silksong: 'Hollow Knight: Silksong',
  kcd2: 'Kingdom Come: Deliverance 2', blue_prince: 'Blue Prince', bg3: "Baldur's Gate 3",
  dredge: 'DREDGE', stardew: 'Stardew Valley', celeste: 'Celeste', cult_lamb: 'Cult of the Lamb',
  rdr2: 'Red Dead Redemption 2', isaac: 'The Binding of Isaac',
  a_difficult_game_about_climbing: 'A Difficult Game About Climbing', ball_x_pit: 'BALL x PIT',
  megabonk: 'Megabonk', flip_master: 'Flip Master', sts2: 'Slay the Spire 2',
  clover_pit: 'CloverPit', balatro: 'Balatro', vampire_crawlers: 'Vampire Crawlers',
  among_us: 'Among Us', dbd: 'Dead by Daylight', fortnite: 'Fortnite',
  phasmophobia: 'Phasmophobia', peak: 'PEAK', repo: 'R.E.P.O.', lethal_company: 'Lethal Company',
  rv_there_yet: 'RV There Yet?', gwyf: 'Gamble With Your Friends', pratfall: 'Pratfall',
  content_warning: 'Content Warning',
  // Rotation-pool additions (Sun/Tue/Thu roster) not previously on the roster.
  ale_tale_tavern: 'Ale & Tale Tavern', waterpark_sim: 'Waterpark Simulator',
  retro_rewind: 'Retro Rewind', supermarket_sim: 'Supermarket Simulator',
  schedule_1: 'Schedule 1', rimworld: 'RimWorld',
  // Non-game category: scratch reveals a workout challenge for Clay.
  workout: 'Workout',
};

// ── Per-game card THEME (face palette + icon) ───────────────────────────
// Source of truth for the V1 lottery face. The panel fetches the merged map
// (this + KV `scratch:games` admin overlay) from /web/scratch/themes and
// renders the face; admin add/edit writes the KV overlay (KV wins). `icon`
// is a key the panel maps to a drawn SVG, OR a raw '<svg ...>' string for
// admin-pasted icons. Keep slugs in sync with GAMES.
export const GAME_THEMES = {
  generic: { accent: '#7c5cff', accent2: '#22d3ee', icon: 'star', title: 'AQUILO', tag: 'SCRATCH TO REVEAL' },
  fallout4: { accent: '#43d17a', accent2: '#0c7a3c', deep: '#06351c', icon: 'cog', title: 'VAULT-TEC', tag: 'PULL THE LEVER, DWELLER' },
  gwyf: { accent: '#5bff95', accent2: '#ffb454', deep: '#10331c', icon: 'dice', title: 'GAMBLE NIGHT', tag: 'TRUST NO ONE' },
  repo: { accent: '#2bd4d4', accent2: '#1c8f8f', deep: '#0c1a22', icon: 'coin', title: 'R.E.P.O.', tag: 'MEET THE HAUL' },
  peak: { accent: '#22d3ee', accent2: '#5bff95', deep: '#0c2230', icon: 'peak', title: 'PEAK', tag: 'REACH THE SUMMIT' },
  lethal_company: { accent: '#2bd4d4', accent2: '#1a2230', deep: '#0c1620', icon: 'coin', title: 'COMPANY SCRIP', tag: 'MEET THE QUOTA' },
  fortnite: { accent: '#22d3ee', accent2: '#ff6ab5', deep: '#10243a', icon: 'star', title: 'LOOT DROP', tag: 'DROP IN' },
  dbd: { accent: '#ff424d', accent2: '#1f2233', deep: '#2a0c10', icon: 'skull', title: 'BLOODWEB', tag: 'ESCAPE OR DIE' },
  phasmophobia: { accent: '#9a82ff', accent2: '#5b46c4', deep: '#0c0c18', icon: 'ghost', title: 'GHOST HUNT', tag: 'DO NOT LOOK AWAY' },
  bg3: { accent: '#7c5cff', accent2: '#ff424d', deep: '#1a1030', icon: 'gem', title: 'MIND FLAYER', tag: 'ROLL THE DICE' },
  ale_tale_tavern: { accent: '#e0a23c', accent2: '#6b3f1a', deep: '#2a1808', icon: 'flask', title: 'TAVERN', tag: 'LAST CALL' },
  baby_steps: { accent: '#9ad17a', accent2: '#6b4a2a', deep: '#1f2a14', icon: 'leaf', title: 'BABY STEPS', tag: 'ONE STEP AT A TIME' },
  cult_lamb: { accent: '#e23b6b', accent2: '#1a1024', deep: '#1a0a18', icon: 'skull', title: 'CULT', tag: 'PRAISE THE LAMB' },
  waterpark_sim: { accent: '#2bb6ff', accent2: '#5bff95', deep: '#0c2236', icon: 'fish', title: 'WATERPARK', tag: 'MAKE A SPLASH' },
  eldenring: { accent: '#ffd76a', accent2: '#7c5cff', deep: '#241a06', icon: 'sword', title: 'GOLDEN ORDER', tag: 'TOUCH GRACE' },
  skyrim_se: { accent: '#8fb6d9', accent2: '#2a3a4a', deep: '#10202c', icon: 'sword', title: 'DRAGONBORN', tag: 'FUS RO DAH' },
  hades: { accent: '#ff424d', accent2: '#ffb454', deep: '#240c10', icon: 'skull', title: 'BOON', tag: 'THERE IS NO ESCAPE' },
  hollow_knight: { accent: '#22d3ee', accent2: '#0a0b12', deep: '#0a1620', icon: 'gem', title: 'GEO HUNT', tag: 'MIND THE HUSKS' },
  kcd2: { accent: '#c8a24a', accent2: '#3a2e1a', deep: '#221a0c', icon: 'sword', title: 'BOHEMIA', tag: 'JESUS CHRIST BE PRAISED' },
  blue_prince: { accent: '#5b8fff', accent2: '#cdb46a', deep: '#0c1830', icon: 'crown', title: 'BLUE PRINCE', tag: 'DRAW THE ROOM' },
  retro_rewind: { accent: '#ff3ca6', accent2: '#21e6ff', deep: '#16122e', icon: 'star', title: 'RETRO REWIND', tag: 'PRESS START' },
  stardew: { accent: '#5bff95', accent2: '#ffb454', deep: '#123018', icon: 'leaf', title: 'HARVEST', tag: 'TEND THE FOIL' },
  supermarket_sim: { accent: '#ffb454', accent2: '#2bb6ff', deep: '#2a1c08', icon: 'dollar', title: 'CHECKOUT', tag: 'PRICE IT RIGHT' },
  witcher3: { accent: '#e0c060', accent2: '#1f2233', deep: '#241f0c', icon: 'sword', title: 'GWENT', tag: 'TOSS A COIN' },
  schedule_1: { accent: '#5bff95', accent2: '#1f6b3a', deep: '#0c2415', icon: 'leaf', title: 'SCHEDULE 1', tag: 'MOVE THE PRODUCT' },
  rdr2: { accent: '#c8553d', accent2: '#1f2233', deep: '#2a120c', icon: 'star', title: 'BOUNTY', tag: 'DRAW' },
  borderlands2: { accent: '#ff9e2c', accent2: '#b21f1f', deep: '#2a1604', icon: 'skull', title: 'VAULT HUNT', tag: 'OPEN THE VAULT' },
  borderlands3: { accent: '#ff5fa2', accent2: '#ff9e2c', deep: '#2a0c1a', icon: 'skull', title: 'VAULT HUNT', tag: 'OPEN THE VAULT' },
  dredge: { accent: '#2bd4d4', accent2: '#14333a', deep: '#0c2026', icon: 'fish', title: 'THE CATCH', tag: 'DO NOT PANIC' },
  cyberpunk2077: { accent: '#fcee0a', accent2: '#ff003c', deep: '#241f04', icon: 'bolt', title: 'NIGHT CITY', tag: 'WAKE UP, SAMURAI' },
  silksong: { accent: '#ff6ab5', accent2: '#22d3ee', deep: '#2a0c20', icon: 'gem', title: 'SILK', tag: 'SPIN THE THREAD' },
  rimworld: { accent: '#d98a4a', accent2: '#3a2a1a', deep: '#241608', icon: 'skull', title: 'THE RIM', tag: 'RANDY DECIDES' },
  sts2: { accent: '#ffb454', accent2: '#7c5cff', deep: '#1a1330', icon: 'gem', title: 'RELIC', tag: 'DRAW YOUR FATE' },
  balatro: { accent: '#ff424d', accent2: '#5bff95', deep: '#2a0c10', icon: 'dice', title: 'JOKER', tag: 'STACK THE DECK' },
  among_us: { accent: '#ff5fa2', accent2: '#1f9fc4', deep: '#14233a', icon: 'crewmate', title: 'CREWMATE', tag: 'IS IT SUS?' },
  content_warning: { accent: '#ff6ab5', accent2: '#7c5cff', deep: '#240c20', icon: 'ghost', title: 'SPOOKTUBE', tag: 'GET THE SHOT' },
  // Workout reveal frame palette (red/white gym). Not a live game face.
  workout: { accent: '#e23b3b', accent2: '#b21f1f', deep: '#3a0d0d', icon: 'dumbbell', title: 'SWEAT-OFF', tag: 'NO PAIN, NO PAYOUT' },
};

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const TWITCH_ALIASES = {
  eldenring: ['Elden Ring: Nightreign'], skyrim_se: ['The Elder Scrolls V: Skyrim', 'Skyrim'],
  witcher3: ['The Witcher 3: Wild Hunt'],
  re_series: ['Resident Evil', 'Resident Evil 2', 'Resident Evil 3', 'Resident Evil 4',
              'Resident Evil 7', 'Resident Evil Village'],
  mgs_delta: ['Metal Gear Solid Δ: Snake Eater', 'Metal Gear Solid Delta: Snake Eater'],
  hades: ['Hades', 'Hades II'], silksong: ['Hollow Knight: Silksong'],
  kcd2: ['Kingdom Come: Deliverance II'], bg3: ['Baldurs Gate 3'],
  rdr2: ['Red Dead Redemption II'],
  isaac: ['The Binding of Isaac: Repentance', 'The Binding of Isaac: Rebirth'],
  ball_x_pit: ['BALL X PIT'], clover_pit: ['Clover Pit'], repo: ['REPO'],
  rv_there_yet: ['RV There Yet'],
  ale_tale_tavern: ['Ale and Tale Tavern', 'Ale & Tale Tavern'],
  waterpark_sim: ['Waterpark Simulator', 'Water Park Simulator'],
  retro_rewind: ['Retro Rewind'], supermarket_sim: ['Supermarket Simulator'],
  schedule_1: ['Schedule I', 'Schedule One'], rimworld: ['Rimworld'],
};

const NAME_INDEX = (() => {
  const idx = {};
  for (const [slug, name] of Object.entries(GAMES)) idx[norm(name)] = slug;
  for (const [slug, names] of Object.entries(TWITCH_ALIASES)) {
    for (const n of names) idx[norm(n)] = slug;
  }
  return idx;
})();

export function slugForTwitchGame(gameName) {
  if (!gameName) return null;
  const key = norm(gameName);
  if (NAME_INDEX[key]) return NAME_INDEX[key];
  for (const [n, slug] of Object.entries(NAME_INDEX)) {
    if (key.startsWith(n) || n.startsWith(key)) return slug;
  }
  return null;
}

// Resolve { slug, gameName } for Clay's current Twitch category. Falls back
// to slug 'generic' (and gameName null) when offline or off-roster so a
// mint never fails just because the category is unrecognised.
async function resolveCurrentGame(env) {
  const broadcasterId = String(env.CLAY_TWITCH_CHANNEL_ID || '').trim();
  if (!broadcasterId) return { slug: 'generic', gameName: null };
  const ch = await getChannelGame(env, broadcasterId).catch(() => null);
  const gameName = ch?.gameName || null;
  const slug = await resolveSlugMerged(env, gameName);
  return { slug: slug || 'generic', gameName: slug ? gameName : (gameName || null) };
}

// Slug resolution that also consults admin-added games in KV (scratch:games),
// so a game added via the admin page resolves from its Twitch category too.
async function resolveSlugMerged(env, gameName) {
  const stat = slugForTwitchGame(gameName);
  if (stat) return stat;
  if (!gameName) return null;
  const key = norm(gameName);
  const overlay = (await kvGet(env, K_GAMES, true)) || {};
  for (const [slug, ov] of Object.entries(overlay)) {
    if (norm(ov.name || slug) === key) return slug;
    for (const a of (ov.aliases || [])) if (norm(a) === key) return slug;
  }
  for (const [slug, ov] of Object.entries(overlay)) {
    const n = norm(ov.name || slug);
    if (n && (key.startsWith(n) || n.startsWith(key))) return slug;
  }
  return null;
}

// ── Live + pacing state ─────────────────────────────────────────────────
// One round-trip resolves whether Clay is live, the current stream id (the
// per-session key for hit budgeting), the game, and the admin pause flag.
// Offline or paused => mints are blocked (and bits, if any, are refundable).
async function resolveLiveContext(env) {
  const game = await resolveCurrentGame(env);
  const broadcasterId = String(env.CLAY_TWITCH_CHANNEL_ID || '').trim();
  let live = false, streamId = null;
  if (broadcasterId) {
    const s = await getStreamInfo(env, broadcasterId).catch(() => null);
    if (s && s.id) { live = true; streamId = String(s.id); }
  }
  const paused = (await kvGet(env, K_PAUSED)) === '1';
  return { live, streamId, paused, slug: game.slug, gameName: game.gameName };
}

// KV helpers over LOADOUT_BOLTS (same binding the overlay relay uses). All
// degrade to no-ops when the binding is absent so the flow never 500s.
async function kvGet(env, key, asJson = false) {
  if (!env || !env.LOADOUT_BOLTS) return null;
  try { return await env.LOADOUT_BOLTS.get(key, asJson ? { type: 'json' } : undefined); }
  catch { return null; }
}
async function kvPut(env, key, val, ttl) {
  if (!env || !env.LOADOUT_BOLTS) return;
  try {
    await env.LOADOUT_BOLTS.put(key, typeof val === 'string' ? val : JSON.stringify(val),
      ttl ? { expirationTtl: ttl } : undefined);
  } catch { /* idle */ }
}

// Runtime-tunable overrides (set via the admin pause/config endpoint).
async function pacingCfg(env) {
  const c = (await kvGet(env, K_CFG, true)) || {};
  return {
    maxHits: Number.isFinite(c.maxHits) ? c.maxHits : MAX_HITS_PER_STREAM,
    cooldownMs: Number.isFinite(c.cooldownMs) ? c.cooldownMs : HIT_COOLDOWN_MS,
    hitRate: Number.isFinite(c.hitRate) ? c.hitRate : HIT_RATE,
    gameRate: Number.isFinite(c.gameRate) ? c.gameRate : GAME_HIT_RATE,
    workoutRate: Number.isFinite(c.workoutRate) ? c.workoutRate : WORKOUT_HIT_RATE,
    bitCost: Number.isFinite(c.bitCost) ? c.bitCost : BIT_COST,
  };
}

// Is a fresh hit allowed to fire right now for this stream session? Enforces
// the per-stream cap + cooldown. streamId null (offline/no session) => the
// game is unbounded test/loopback territory, allow (offline is gated earlier).
async function hitBudgetOk(env, streamId, cfg) {
  if (!streamId) return true;
  const st = (await kvGet(env, K_STREAM(streamId), true)) || { hits: 0, lastHitAt: 0 };
  if ((st.hits || 0) >= cfg.maxHits) return false;
  if (st.lastHitAt && (now() - st.lastHitAt) < cfg.cooldownMs) return false;
  return true;
}

// Record that a hit was minted for this stream session (bumps count + clock).
async function recordHit(env, streamId) {
  if (!streamId) return;
  const st = (await kvGet(env, K_STREAM(streamId), true)) || { hits: 0, lastHitAt: 0 };
  st.hits = (st.hits || 0) + 1;
  st.lastHitAt = now();
  await kvPut(env, K_STREAM(streamId), st, STREAM_STATE_TTL);
}

// ── D1 plumbing ────────────────────────────────────────────────────────

function db(env) {
  if (!env || !env.DB) throw new Error('scratch-off: env.DB (D1) not bound');
  return env.DB;
}

function now() { return Date.now(); }

function jparse(s, fallback) {
  if (s == null) return fallback;
  try { const v = JSON.parse(s); return v == null ? fallback : v; } catch { return fallback; }
}

function rid(prefix) {
  return prefix + '_' + now().toString(36) + '_' + Math.floor(Math.random() * 1e9).toString(36);
}

// Lazy schema apply, runs the migration statements once per isolate so a
// cold worker works even if `wrangler d1 execute` was never run. The flag
// is module-scoped (per V8 isolate); a fresh isolate re-runs the harmless
// IF NOT EXISTS statements.
let _schemaReady = false;
async function ensureSchema(env) {
  if (_schemaReady) return;
  const d = db(env);
  const stmts = [
    `CREATE TABLE IF NOT EXISTS scratch_ticket (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, user_name TEXT,
      game_slug TEXT NOT NULL, game_name TEXT, bits INTEGER NOT NULL DEFAULT 0,
      sku TEXT, txn_id TEXT, outcome TEXT NOT NULL DEFAULT 'lose',
      outcome_data TEXT NOT NULL DEFAULT '{}', scratch_pct INTEGER NOT NULL DEFAULT 0,
      revealed INTEGER NOT NULL DEFAULT 0, triggered INTEGER NOT NULL DEFAULT 0,
      purchased_at INTEGER NOT NULL DEFAULT 0, scratched_at INTEGER, triggered_at INTEGER)`,
    `CREATE INDEX IF NOT EXISTS idx_scratch_ticket_user ON scratch_ticket(user_id, purchased_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_scratch_ticket_txn ON scratch_ticket(txn_id)`,
    `CREATE INDEX IF NOT EXISTS idx_scratch_ticket_pending ON scratch_ticket(revealed, outcome, triggered)`,
    `CREATE TABLE IF NOT EXISTS scratch_outcome_pool (
      id TEXT PRIMARY KEY, game_slug TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL,
      action_key TEXT, weight INTEGER NOT NULL DEFAULT 10, duration_sec INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL DEFAULT 0)`,
    `CREATE INDEX IF NOT EXISTS idx_scratch_pool_game ON scratch_outcome_pool(game_slug, active, kind)`,
    `CREATE TABLE IF NOT EXISTS scratch_streamer_bot_action (
      action_key TEXT PRIMARY KEY, action_name TEXT NOT NULL,
      default_duration_sec INTEGER NOT NULL DEFAULT 30, cooldown_sec INTEGER NOT NULL DEFAULT 0,
      description TEXT, active INTEGER NOT NULL DEFAULT 1)`,
  ];
  for (const s of stmts) await d.prepare(s).run();
  _schemaReady = true;
}

// ── HTTP plumbing ──────────────────────────────────────────────────────

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-scratch-token, x-streamdeck-token, x-aquilo-web-ts, x-aquilo-web-sig, x-scratch-webhook-secret',
};

function jsonResp(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json', ...CORS, ...extraHeaders },
  });
}

// Admin/owner gate, reuses the Stream Deck token if no dedicated one is
// set, so the trigger + CRUD endpoints work out of the box tonight. The site
// admin page proxies through `postToBot`, which forwards the token as the
// `x-streamdeck-token` header (the same channel the death-counter admin uses),
// so accept that header too — no separate scratch secret to provision.
function tokenOk(req, env, url) {
  const want = String(env.SCRATCH_ADMIN_TOKEN || env.STREAMDECK_TOKEN || '').trim();
  if (!want) return false;
  const got = (req.headers.get('x-scratch-token') || req.headers.get('x-streamdeck-token') ||
    url.searchParams.get('token') || '').trim();
  return got.length > 0 && got === want;
}

function webhookOk(req, env) {
  const want = String(env.SCRATCH_WEBHOOK_SECRET || '').trim();
  if (!want) return null; // not configured → caller decides (503)
  const got = (req.headers.get('x-scratch-webhook-secret') || '').trim();
  return got.length > 0 && got === want;
}

async function readBody(req) {
  try { return await req.json(); } catch { return {}; }
}

// ── Twitch bits receipt verification ───────────────────────────────────
// Twitch's bits.onTransactionComplete hands the panel a `transactionReceipt`
// JWT (HS256) signed with the extension secret. When TWITCH_EXT_SECRET is
// configured we verify it; otherwise we decode-only (with a warning flag)
// so the flow works in the extension's test/loopback rig before the secret
// is wired. Returns { ok, verified, sku, bits, userId, txnId } or null.
function b64urlToBytes(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlToJson(s) {
  try { return JSON.parse(new TextDecoder().decode(b64urlToBytes(s))); } catch { return null; }
}

async function verifyTwitchReceipt(env, jwt) {
  if (!jwt || typeof jwt !== 'string' || jwt.split('.').length !== 3) return null;
  const [h, p, sig] = jwt.split('.');
  const payload = b64urlToJson(p);
  if (!payload) return null;
  let verified = false;
  const secretB64 = String(env.TWITCH_EXT_SECRET || '').trim();
  if (secretB64) {
    try {
      const key = await crypto.subtle.importKey(
        'raw', b64urlToBytes(secretB64.replace(/-/g, '+').replace(/_/g, '/')),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
      verified = await crypto.subtle.verify('HMAC', key, b64urlToBytes(sig),
        new TextEncoder().encode(`${h}.${p}`));
    } catch { verified = false; }
    if (!verified) return { ok: false, verified: false, reason: 'bad-signature' };
  }
  // Bits receipt shape: { topic, exp, data: { transactionId, userId, time,
  // product: { sku, displayName, cost: { amount, type } } } }
  const data = payload.data || payload;
  const product = data.product || {};
  return {
    ok: true, verified,
    sku: product.sku || data.sku || null,
    bits: (product.cost && Number(product.cost.amount)) || 0,
    userId: data.userId || payload.user_id || null,
    txnId: data.transactionId || data.transaction_id || null,
  };
}

// ── Outcome selection ──────────────────────────────────────────────────

function weightedPick(rows) {
  if (!rows.length) return null;
  const total = rows.reduce((s, r) => s + Math.max(1, r.weight || 1), 0);
  let roll = Math.random() * total;
  for (const r of rows) {
    roll -= Math.max(1, r.weight || 1);
    if (roll <= 0) return r;
  }
  return rows[rows.length - 1];
}

function consolationAmount() {
  return CONSOLATION_MIN + Math.floor(Math.random() * (CONSOLATION_MAX - CONSOLATION_MIN + 1));
}
function loseOutcome() {
  return { outcome: 'lose', outcomeData: { message: pickLoss(), consolationBolts: consolationAmount() } };
}

// Decide a ticket's outcome at mint. Returns { outcome, outcomeData }.
// UNIFIED POOL: a single ticket type. On a roll it lands one of three:
//   - workout challenge  (~opts.workoutRate, universal pool, outcomeData.workout)
//   - game challenge/tamper (~opts.gameRate, themed to the live game)
//   - nothing            (loss + consolation bolts, the rest)
// opts.allowHit gates BOTH win bands (per-stream cap/cooldown): when false the
// card always loses regardless of the roll.
export async function rollOutcome(env, gameSlug, opts = {}) {
  const allowHit = opts.allowHit !== false;
  const gameRate = Number.isFinite(opts.gameRate) ? opts.gameRate : GAME_HIT_RATE;
  const workoutRate = Number.isFinite(opts.workoutRate) ? opts.workoutRate : WORKOUT_HIT_RATE;
  if (!allowHit) return loseOutcome();
  const r = Math.random();
  if (r < workoutRate) return await pickFromPool(env, 'workout', { workout: true });
  if (r < workoutRate + gameRate) return await pickFromPool(env, gameSlug, {});
  return loseOutcome();
}

// Draw a winning outcome from a pool. Reads D1; falls back to the in-code
// POOLS (workout) or the generic pool so a hit never silently becomes a loss.
async function pickFromPool(env, gameSlug, extra = {}) {
  const d = db(env);
  let rows = (await d.prepare(
    `SELECT id, kind, body, action_key, weight, duration_sec FROM scratch_outcome_pool
     WHERE game_slug = ? AND active = 1`).bind(gameSlug).all()).results || [];
  // Workout uses the in-code POOLS.workout if D1 has no rows yet (so it works
  // before `scratch/seed` is re-run). It never falls back to game tampers.
  if (!rows.length && gameSlug === 'workout' && Array.isArray(POOLS.workout)) {
    rows = POOLS.workout.map((e, i) => ({
      id: `mem_workout_${i}`, kind: e.kind, body: e.body,
      action_key: e.actionKey || null, weight: e.weight || 10, duration_sec: e.durationSec || 0,
    }));
  }
  if (!rows.length && gameSlug !== 'generic' && gameSlug !== 'workout') {
    rows = (await d.prepare(
      `SELECT id, kind, body, action_key, weight, duration_sec FROM scratch_outcome_pool
       WHERE game_slug = 'generic' AND active = 1`).all()).results || [];
  }
  const pick = weightedPick(rows);
  if (!pick) {
    return extra.workout
      ? { outcome: 'challenge', outcomeData: { poolId: null, body: '20 pushups. Chat counts.', durationSec: 0, workout: true } }
      : { outcome: 'challenge', outcomeData: { poolId: null, body: 'Pose for the stream for 10 seconds.', durationSec: 10 } };
  }
  return {
    outcome: pick.kind, // 'challenge' | 'tamper'
    outcomeData: {
      poolId: pick.id, body: pick.body, durationSec: pick.duration_sec || 0,
      actionKey: pick.action_key || null,
      ...(extra.workout ? { workout: true } : {}),
    },
  };
}

function pickLoss() { return LOSS_LINES[Math.floor(Math.random() * LOSS_LINES.length)]; }

// ── Ticket helpers ─────────────────────────────────────────────────────

function ticketPublic(row, { includeOutcome }) {
  const od = jparse(row.outcome_data, {});
  const base = {
    ticketId: row.id, gameSlug: row.game_slug, gameName: row.game_name,
    bits: row.bits, scratchPct: row.scratch_pct, revealed: !!row.revealed,
    triggered: !!row.triggered, purchasedAt: row.purchased_at, scratchedAt: row.scratched_at,
  };
  if (includeOutcome && row.revealed) {
    base.outcome = row.outcome; // lose|challenge|tamper
    base.win = row.outcome !== 'lose';
    base.body = row.outcome === 'lose' ? (od.message || pickLoss()) : od.body;
    base.durationSec = od.durationSec || 0;
    base.actionKey = od.actionKey || null;
    base.workout = !!od.workout; // true when the win came from the workout pool
    if (row.outcome === 'lose') base.consolationBolts = od.consolationBolts || 0;
  }
  return base;
}

async function getTicket(env, id) {
  return await db(env).prepare(`SELECT * FROM scratch_ticket WHERE id = ?`).bind(String(id)).first();
}

// Mint a ticket. `liveCtx` (from resolveLiveContext) supplies the stream
// session id used for hit budgeting and the resolved game; when omitted
// (admin test-mint) the game is resolved standalone and hits are unbounded.
async function mintTicket(env, { userId, userName, bits, sku, txnId, liveCtx }) {
  await ensureSchema(env);
  const d = db(env);
  // Idempotency: a repeated Twitch transaction returns the existing ticket.
  if (txnId) {
    const existing = await d.prepare(`SELECT * FROM scratch_ticket WHERE txn_id = ?`)
      .bind(String(txnId)).first();
    if (existing) return { ticket: existing, reused: true };
  }
  // Single unified ticket type: the face themes to the live game; the reveal
  // (rollOutcome) decides game challenge vs workout challenge vs nothing.
  const game = liveCtx
    ? { slug: liveCtx.slug, gameName: liveCtx.gameName }
    : await resolveCurrentGame(env);
  const cfg = await pacingCfg(env);
  const allowHit = await hitBudgetOk(env, liveCtx?.streamId, cfg);
  const { outcome, outcomeData } = await rollOutcome(env, game.slug,
    { allowHit, gameRate: cfg.gameRate, workoutRate: cfg.workoutRate });
  // A minted hit consumes a slot for this stream session (cap + cooldown).
  if (outcome !== 'lose' && liveCtx?.streamId) await recordHit(env, liveCtx.streamId);
  const id = rid('st');
  const ts = now();
  await d.prepare(
    `INSERT INTO scratch_ticket
       (id, user_id, user_name, game_slug, game_name, bits, sku, txn_id,
        outcome, outcome_data, scratch_pct, revealed, triggered, purchased_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?)`)
    .bind(id, String(userId), userName || null, game.slug, game.gameName || GAMES[game.slug] || null,
          Math.max(0, parseInt(bits, 10) || 0), sku || null, txnId ? String(txnId) : null,
          outcome, JSON.stringify(outcomeData), ts).run();

  await publishActivity(env, {
    kind: 'scratch.purchased', ticketId: id, userId: String(userId),
    viewer: userName || null, gameSlug: game.slug, gameName: game.gameName, bits: bits || 0,
  }).catch(() => {});

  // scratch.start drives the activity overlay's mid-scratch card: a ticket
  // now exists for this viewer, paint it foil-covered until the reveal.
  // Distinct from scratch.purchased (which carries purchase accounting).
  await publishActivity(env, {
    kind: 'scratch.start', ticketId: id, userId: String(userId),
    viewer: userName || null, gameSlug: game.slug, gameName: game.gameName,
  }).catch(() => {});

  const ticket = await getTicket(env, id);
  return { ticket, reused: false };
}

// Mint behind the live/pause guard. When `enforce`, an offline or paused
// channel BLOCKS the mint (no ticket created) and the caller treats any bits
// as refundable, Clay should never get hit while away or mid-transition.
// The no-receipt loopback/test path passes enforce:false so localhost demos
// and the extension test rig keep working off-stream.
async function guardedMint(env, args, { enforce = true } = {}) {
  const liveCtx = await resolveLiveContext(env);
  if (enforce && liveCtx.paused) return { block: 'paused', liveCtx };
  if (enforce && !liveCtx.live) return { block: 'offline', liveCtx };
  const r = await mintTicket(env, { ...args, liveCtx });
  return { ...r, liveCtx };
}

// Grant a loss's tiny consolation bolts to the viewer's scratch tally
// (scratch-local, kept off the Discord-linked economy on purpose). Returns
// the new running total. Idempotent per ticket because it is only called on
// the single reveal-crossing transition.
async function grantConsolation(env, userId, amount) {
  const key = K_CONSOL(String(userId));
  const cur = parseInt(await kvGet(env, key), 10) || 0;
  const total = cur + Math.max(0, amount | 0);
  await kvPut(env, key, String(total));
  return total;
}

// Echo a non-losing reveal to a Discord channel. Best-effort: no-ops without
// a bot token or a configured channel. Aquilo voice (dry, no hype, no emoji
// spam). Channel resolves SCRATCH_ECHO_CHANNEL_ID -> live-now -> check-in.
async function echoHitToDiscord(env, row) {
  const channelId = String(
    env.SCRATCH_ECHO_CHANNEL_ID || env.COUNTDOWN_CHANNEL_ID || env.CHECKIN_CHANNEL_ID || '').trim();
  if (!channelId || !env.DISCORD_BOT_TOKEN) return;
  const od = jparse(row.outcome_data, {});
  const who = row.user_name || 'A viewer';
  const game = row.game_name || GAMES[row.game_slug] || 'the stream';
  const kind = row.outcome === 'tamper' ? 'control tamper' : 'challenge';
  const dur = od.durationSec ? ` (${od.durationSec}s)` : '';
  const content =
    `🎟️ **${who}** scratched a winner on **${game}**, ${kind}${dur}\n> ${od.body || ''}`;
  await discordPostMessage(env, channelId, {
    content, allowed_mentions: { parse: [] },
  }).catch(() => {});
}

// ── Router ─────────────────────────────────────────────────────────────

export async function handleScratch(req, env, path) {
  const url = new URL(req.url);
  const method = req.method;
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  try {
    // ---- Twitch bit-purchase webhook → mint a ticket -------------------
    // Receives a normalized purchase event. Real Twitch ext transactions
    // arrive as a signed JWT (documented in SCRATCH-OFF-STREAMERBOT.md);
    // for now we gate on a shared secret header. Shape:
    //   { userId, userName, sku, bits, transactionId }
    if (method === 'POST' && path === '/web/twitch/bit-purchase-webhook') {
      const ok = webhookOk(req, env);
      if (ok === null) return jsonResp({ ok: false, error: 'webhook-not-configured' }, 503);
      if (ok === false) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
      const b = await readBody(req);
      const sku = String(b.sku || b.product || '').trim();
      if (!SCRATCH_SKUS.has(sku)) return jsonResp({ ok: false, error: 'unknown-sku', sku }, 400);
      const userId = String(b.userId || b.user_id || '').trim();
      if (!userId) return jsonResp({ ok: false, error: 'missing-userId' }, 400);
      const res = await guardedMint(env, {
        userId, userName: b.userName || b.user_name || b.displayName || null,
        bits: b.bits || b.cost || 0, sku, txnId: b.transactionId || b.transaction_id || b.txnId || null,
        category: b.category === 'workout' ? 'workout' : null,
      }, { enforce: true });
      if (res.block) {
        await publishActivity(env, { kind: 'scratch.refund', userId, reason: res.block }).catch(() => {});
        return jsonResp({ ok: false, error: res.block, refundable: true });
      }
      return jsonResp({ ok: true, reused: res.reused, ticket: ticketPublic(res.ticket, { includeOutcome: false }) });
    }

    // ---- Panel-facing mint from a Twitch bits transaction receipt ------
    // The panel calls Twitch.ext.bits.useBits('scratch_card'); on
    // onTransactionComplete it POSTs the receipt here. We verify the JWT
    // when TWITCH_EXT_SECRET is set (decode-only otherwise so the test rig
    // works). Body: { userId, userName, transactionReceipt, sku }.
    if (method === 'POST' && (path === '/web/scratch/mint' || path === '/web/scratch/buy')) {
      const b = await readBody(req);
      let userId = String(b.userId || '').trim();
      let userName = b.userName || b.displayName || null;
      let sku = String(b.sku || b.product || '').trim();
      let bits = 0, txnId = null, verified = false;
      let hasReceipt = false;
      if (b.transactionReceipt) {
        const r = await verifyTwitchReceipt(env, b.transactionReceipt);
        if (!r || r.ok === false) return jsonResp({ ok: false, error: 'bad-receipt' }, 400);
        hasReceipt = true;
        verified = r.verified;
        sku = r.sku || sku;
        bits = r.bits || 0;
        txnId = r.txnId || null;
        userId = r.userId || userId;
      } else {
        // No receipt, only allowed in the extension test rig / loopback,
        // where Twitch does not always surface a receipt. Tag bits as 0.
        if (!SCRATCH_SKUS.has(sku)) sku = 'scratch_card_100';
      }
      if (!userId) return jsonResp({ ok: false, error: 'missing-userId',
        hint: 'share Twitch identity (requestIdShare) before buying' }, 400);
      if (sku && !SCRATCH_SKUS.has(sku)) return jsonResp({ ok: false, error: 'unknown-sku', sku }, 400);
      // Enforce the offline/pause guard only when real bits were charged (a
      // verified receipt). The receiptless loopback/test path is unguarded so
      // localhost demos work off-stream.
      const res = await guardedMint(env, {
        userId, userName, bits, sku: sku || 'scratch_card_100', txnId,
        category: b.category === 'workout' ? 'workout' : null,
      }, { enforce: hasReceipt });
      if (res.block) {
        await publishActivity(env, { kind: 'scratch.refund', userId, reason: res.block }).catch(() => {});
        return jsonResp({ ok: false, error: res.block, refundable: true,
          message: res.block === 'paused'
            ? 'Scratch-offs are paused for a moment. Your bits are safe.'
            : 'Clay is offline right now. Your bits are safe.' });
      }
      return jsonResp({ ok: true, reused: res.reused, verified,
        ticket: ticketPublic(res.ticket, { includeOutcome: false }) });
    }

    // ---- Admin: mint a ticket WITHOUT bits (end-to-end testing) --------
    if (method === 'POST' && path === '/web/admin/scratch/test-mint') {
      if (!tokenOk(req, env, url)) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
      const b = await readBody(req);
      const userId = String(b.userId || 'test-viewer').trim();
      const { ticket } = await mintTicket(env, {
        userId, userName: b.userName || 'Test Viewer', bits: 0, sku: 'scratch_card_100', txnId: null,
        category: b.category === 'workout' ? 'workout' : null,
      });
      return jsonResp({ ok: true, ticket: ticketPublic(ticket, { includeOutcome: false }) });
    }

    // ---- Scratch progress → reveal at threshold ------------------------
    // POST /web/scratch/scratch/:ticketId  body { userId, pct }
    const scratchM = path.match(/^\/web\/scratch\/scratch\/([^/]+)$/);
    if (method === 'POST' && scratchM) {
      await ensureSchema(env);
      const ticketId = decodeURIComponent(scratchM[1]);
      const b = await readBody(req);
      const userId = String(b.userId || '').trim();
      const pct = Math.max(0, Math.min(100, Math.round(Number(b.pct) || 0)));
      const row = await getTicket(env, ticketId);
      if (!row) return jsonResp({ ok: false, error: 'not-found' }, 404);
      if (userId && String(row.user_id) !== userId) {
        return jsonResp({ ok: false, error: 'not-your-ticket' }, 403);
      }
      const newPct = Math.max(row.scratch_pct, pct);
      const crossing = !row.revealed && newPct >= REVEAL_THRESHOLD;
      if (crossing) {
        const ts = now();
        await db(env).prepare(
          `UPDATE scratch_ticket SET scratch_pct = ?, revealed = 1, scratched_at = ? WHERE id = ?`)
          .bind(newPct, ts, ticketId).run();
        const fresh = await getTicket(env, ticketId);
        await fireRevealEvents(env, fresh);
        // Grant the loss consolation once, on this single reveal transition.
        const extra = {};
        if (fresh.outcome === 'lose') {
          const od = jparse(fresh.outcome_data, {});
          if (od.consolationBolts > 0) {
            extra.consolationTotal = await grantConsolation(env, fresh.user_id, od.consolationBolts);
          }
        }
        return jsonResp({ ok: true, ...ticketPublic(fresh, { includeOutcome: true }), ...extra });
      }
      if (newPct !== row.scratch_pct) {
        await db(env).prepare(`UPDATE scratch_ticket SET scratch_pct = ? WHERE id = ?`)
          .bind(newPct, ticketId).run();
      }
      return jsonResp({ ok: true, ticketId, scratchPct: newPct, revealed: !!row.revealed,
        ...(row.revealed ? ticketPublic({ ...row, scratch_pct: newPct }, { includeOutcome: true }) : {}) });
    }

    // ---- Viewer inventory ----------------------------------------------
    // GET /web/scratch/my-tickets?userId=...  (unrevealed first, then history)
    if (method === 'GET' && path === '/web/scratch/my-tickets') {
      await ensureSchema(env);
      const userId = String(url.searchParams.get('userId') || '').trim();
      if (!userId) return jsonResp({ ok: false, error: 'missing-userId' }, 400);
      const rows = (await db(env).prepare(
        `SELECT * FROM scratch_ticket WHERE user_id = ?
         ORDER BY revealed ASC, purchased_at DESC LIMIT 100`).bind(userId).all()).results || [];
      return jsonResp({ ok: true,
        tickets: rows.map((r) => ticketPublic(r, { includeOutcome: true })) },
        200, { 'cache-control': 'private, max-age=2' });
    }

    // ---- Single ticket (panel poll) ------------------------------------
    const ticketM = path.match(/^\/web\/scratch\/ticket\/([^/]+)$/);
    if (method === 'GET' && ticketM) {
      await ensureSchema(env);
      const row = await getTicket(env, decodeURIComponent(ticketM[1]));
      if (!row) return jsonResp({ ok: false, error: 'not-found' }, 404);
      return jsonResp({ ok: true, ticket: ticketPublic(row, { includeOutcome: true }) });
    }

    // ---- Current game (panel theme) + live/buy gate --------------------
    // The panel reads `canBuy` to enable/disable the Buy button so bits are
    // never spent while Clay is offline or paused (defense-in-depth with the
    // mint guard). Optionally pass ?userId= to also return the viewer's
    // running consolation-bolt tally for the panel footer.
    if (method === 'GET' && path === '/web/scratch/current-game') {
      const ctx = await resolveLiveContext(env);
      const uid = String(url.searchParams.get('userId') || '').trim();
      const consolationTotal = uid ? (parseInt(await kvGet(env, K_CONSOL(uid)), 10) || 0) : undefined;
      const cfg = await pacingCfg(env);
      const games = await mergedGames(env);
      const theme = themeForSlug(games, ctx.slug);
      return jsonResp({ ok: true, gameSlug: ctx.slug,
        gameName: ctx.gameName || (games[ctx.slug] && games[ctx.slug].name) || null,
        live: ctx.live, paused: ctx.paused, canBuy: ctx.live && !ctx.paused,
        bitCost: cfg.bitCost, theme,
        ...(consolationTotal !== undefined ? { consolationTotal } : {}) },
        200, { 'cache-control': 'public, max-age=10' });
    }

    // ---- Merged card themes (panel face source) ------------------------
    // code GAME_THEMES overlaid by the admin KV overlay (KV wins). The panel
    // fetches this so admin-added/edited games theme their lottery face.
    if (method === 'GET' && path === '/web/scratch/themes') {
      const games = await mergedGames(env);
      const themes = {};
      for (const g of Object.values(games)) themes[g.slug] = themeForSlug(games, g.slug);
      return jsonResp({ ok: true, bitCost: (await pacingCfg(env)).bitCost, themes },
        200, { 'cache-control': 'public, max-age=20' });
    }

    // ---- Pool preview (UI) ---------------------------------------------
    const poolM = path.match(/^\/web\/scratch\/pool\/([^/]+)$/);
    if (method === 'GET' && poolM) {
      await ensureSchema(env);
      const slug = decodeURIComponent(poolM[1]);
      const rows = (await db(env).prepare(
        `SELECT id, kind, body, action_key, weight, duration_sec FROM scratch_outcome_pool
         WHERE game_slug = ? AND active = 1 ORDER BY kind, weight DESC`).bind(slug).all()).results || [];
      return jsonResp({ ok: true, gameSlug: slug, gameName: GAMES[slug] || null,
        pool: rows.map((r) => ({ id: r.id, kind: r.kind, body: r.body,
          actionKey: r.action_key, weight: r.weight, durationSec: r.duration_sec })) },
        200, { 'cache-control': 'public, max-age=30' });
    }

    // ---- Admin: trigger / confirm a hit firing on stream ---------------
    const triggerM = path.match(/^\/web\/scratch\/trigger\/([^/]+)$/);
    if (method === 'POST' && triggerM) {
      if (!tokenOk(req, env, url)) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
      await ensureSchema(env);
      const row = await getTicket(env, decodeURIComponent(triggerM[1]));
      if (!row) return jsonResp({ ok: false, error: 'not-found' }, 404);
      if (row.outcome === 'lose') return jsonResp({ ok: false, error: 'losing-ticket' }, 400);
      const ts = now();
      await db(env).prepare(`UPDATE scratch_ticket SET triggered = 1, triggered_at = ? WHERE id = ?`)
        .bind(ts, row.id).run();
      await emitHitFire(env, { ...row, triggered: 1 }, /*forced*/ true);
      return jsonResp({ ok: true, ticketId: row.id, outcome: row.outcome, triggered: true });
    }

    // ---- Admin: pause toggle + live/pacing status ----------------------
    // GET  -> current live + pause + per-stream hit budget snapshot.
    // POST -> { paused?:bool, maxHits?:int, cooldownSec?:int, hitRate?:num,
    //           resetStream?:bool } to pause during a game transition or
    //           retune pacing live (no redeploy). Use to pause while you swap
    //           games so a hit can't land mid-transition.
    if (path === '/web/scratch/status' || path === '/web/admin/scratch/pause') {
      if (!tokenOk(req, env, url)) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
      const ctx = await resolveLiveContext(env);
      const cfg = await pacingCfg(env);
      if (method === 'POST') {
        const b = await readBody(req);
        if (typeof b.paused === 'boolean') {
          if (b.paused) await kvPut(env, K_PAUSED, '1', STREAM_STATE_TTL);
          else if (env.LOADOUT_BOLTS) { try { await env.LOADOUT_BOLTS.delete(K_PAUSED); } catch { /* idle */ } }
          ctx.paused = b.paused;
        }
        const over = {};
        if (Number.isFinite(b.maxHits)) over.maxHits = Math.max(0, Math.min(20, b.maxHits | 0));
        if (Number.isFinite(b.cooldownSec)) over.cooldownMs = Math.max(0, (b.cooldownSec | 0)) * 1000;
        if (Number.isFinite(b.hitRate)) over.hitRate = Math.max(0, Math.min(1, Number(b.hitRate)));
        if (Object.keys(over).length) await kvPut(env, K_CFG, { ...cfg, ...over, cooldownMs: over.cooldownMs ?? cfg.cooldownMs });
        if (b.resetStream && ctx.streamId && env.LOADOUT_BOLTS) {
          try { await env.LOADOUT_BOLTS.delete(K_STREAM(ctx.streamId)); } catch { /* idle */ }
        }
      }
      const st = ctx.streamId ? ((await kvGet(env, K_STREAM(ctx.streamId), true)) || { hits: 0, lastHitAt: 0 }) : null;
      return jsonResp({ ok: true, live: ctx.live, paused: ctx.paused, streamId: ctx.streamId,
        gameSlug: ctx.slug, gameName: ctx.gameName,
        cfg: { maxHits: cfg.maxHits, cooldownSec: Math.round(cfg.cooldownMs / 1000), hitRate: cfg.hitRate },
        stream: st ? { hits: st.hits || 0, lastHitAt: st.lastHitAt || 0,
          remaining: Math.max(0, cfg.maxHits - (st.hits || 0)) } : null });
    }

    // ---- Admin: outcome-pool CRUD --------------------------------------
    if (method === 'POST' && path === '/web/admin/scratch/outcome-pool') {
      if (!tokenOk(req, env, url)) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
      return await handlePoolCrud(env, await readBody(req));
    }

    // ---- Admin: Haiku-generate pools for games -------------------------
    // Body: { games: [slug,...] | "missing", perGame: 12 }. Caller chunks
    // the list (Workers wall/subrequest limits). Skips games that already
    // have rows unless "missing" excludes them (it does).
    if (method === 'POST' && path === '/web/admin/scratch/generate-pools') {
      if (!tokenOk(req, env, url)) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
      await ensureSchema(env);
      const b = await readBody(req);
      const perGame = Math.max(4, Math.min(24, parseInt(b.perGame, 10) || 12));
      let games = b.games;
      if (games === 'missing' || !Array.isArray(games)) {
        const d = db(env);
        games = [];
        for (const slug of Object.keys(GAMES)) {
          const have = await d.prepare(`SELECT COUNT(*) AS n FROM scratch_outcome_pool WHERE game_slug = ?`)
            .bind(slug).first();
          if (!have || !have.n) games.push(slug);
        }
      }
      games = games.filter((g) => GAMES[g]).slice(0, 8); // cap per call
      const results = [];
      for (const slug of games) {
        try { results.push(await generatePoolForGame(env, slug, perGame)); }
        catch (e) { results.push({ slug, inserted: 0, error: String(e?.message || e).slice(0, 120) }); }
      }
      return jsonResp({ ok: true, generated: results });
    }

    // ---- Admin: seed actions + pools -----------------------------------
    if (method === 'POST' && path === '/web/admin/scratch/seed') {
      if (!tokenOk(req, env, url)) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
      const res = await seedScratch(env, { force: url.searchParams.get('force') === '1' });
      return jsonResp({ ok: true, ...res });
    }

    // ---- Admin: content management (games + challenges + tampers) -------
    // Read-everything for the /admin/scratch-off-content page.
    if (method === 'GET' && path === '/web/admin/scratch/content') {
      if (!tokenOk(req, env, url)) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
      const [games, challenges, tampers, cfg] = await Promise.all([
        mergedGames(env), loadChallengeList(env), mergedTampers(env), pacingCfg(env),
      ]);
      const counts = {};
      for (const c of challenges) counts[c.gameSlug] = (counts[c.gameSlug] || 0) + 1;
      const gameList = Object.values(games).map((g) => ({ ...g, entryCount: counts[g.slug] || 0 }));
      return jsonResp({ ok: true,
        games: gameList, challenges, tampers: Object.values(tampers),
        cfg: { bitCost: cfg.bitCost, gameRate: cfg.gameRate, workoutRate: cfg.workoutRate,
          maxHits: cfg.maxHits, cooldownSec: Math.round(cfg.cooldownMs / 1000) } });
    }

    // Add / edit / delete a game theme (KV overlay; KV wins over code).
    if (method === 'POST' && path === '/web/admin/scratch/game') {
      if (!tokenOk(req, env, url)) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
      return await handleGameCrud(env, await readBody(req));
    }

    // Add / edit / delete a challenge (writes KV, reseeds D1; KV is the layer).
    if (method === 'POST' && path === '/web/admin/scratch/challenge') {
      if (!tokenOk(req, env, url)) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
      return await handleChallengeCrud(env, await readBody(req));
    }

    // Add / edit a tamper action (KV overlay + D1 upsert; new ones marked
    // pending until the C# Streamer.bot action is wired).
    if (method === 'POST' && path === '/web/admin/scratch/tamper') {
      if (!tokenOk(req, env, url)) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
      return await handleTamperCrud(env, await readBody(req));
    }

    // Set economy/pacing config (bit cost, rates, caps). Defaults locked at 100.
    if (method === 'POST' && path === '/web/admin/scratch/config') {
      if (!tokenOk(req, env, url)) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
      const b = await readBody(req);
      const cur = (await kvGet(env, K_CFG, true)) || {};
      const over = { ...cur };
      if (Number.isFinite(b.bitCost)) over.bitCost = Math.max(1, Math.min(10000, b.bitCost | 0));
      if (Number.isFinite(b.maxHits)) over.maxHits = Math.max(0, Math.min(20, b.maxHits | 0));
      if (Number.isFinite(b.cooldownSec)) over.cooldownMs = Math.max(0, (b.cooldownSec | 0)) * 1000;
      if (Number.isFinite(b.gameRate)) over.gameRate = Math.max(0, Math.min(1, Number(b.gameRate)));
      if (Number.isFinite(b.workoutRate)) over.workoutRate = Math.max(0, Math.min(1, Number(b.workoutRate)));
      await kvPut(env, K_CFG, over);
      return jsonResp({ ok: true, cfg: await pacingCfg(env) });
    }

    return jsonResp({ ok: false, error: 'not-found' }, 404);
  } catch (e) {
    return jsonResp({ ok: false, error: String(e?.message || e).slice(0, 200) }, 500);
  }
}

// Emit the reveal-time bus events for a freshly-revealed ticket. Tampers
// AUTO-FIRE (emit scratch.tamper + mark triggered); challenges announce
// (scratch.challenge) and wait for Clay's admin trigger to confirm.
async function fireRevealEvents(env, row) {
  const od = jparse(row.outcome_data, {});
  const win = row.outcome !== 'lose';
  await publishActivity(env, {
    kind: 'scratch.scratched', ticketId: row.id, userId: String(row.user_id),
    viewer: row.user_name || null, gameSlug: row.game_slug, gameName: row.game_name,
    outcome: row.outcome, win,
  }).catch(() => {});
  if (!win) return;
  await publishActivity(env, {
    kind: 'scratch.hit', ticketId: row.id, viewer: row.user_name || null,
    gameSlug: row.game_slug, kind2: row.outcome, body: od.body, durationSec: od.durationSec || 0,
  }).catch(() => {});
  // Echo the win to Discord (#live-now by default). Best-effort, no-ops
  // without a bot token / configured channel.
  await echoHitToDiscord(env, row).catch(() => {});
  if (row.outcome === 'tamper') {
    // Auto-fire the Streamer.bot tamper.
    const ts = now();
    await db(env).prepare(`UPDATE scratch_ticket SET triggered = 1, triggered_at = ? WHERE id = ?`)
      .bind(ts, row.id).run();
    await emitHitFire(env, { ...row, triggered: 1 }, false);
  } else {
    await emitHitFire(env, row, false);
  }
}

// Emit the specific firing event (scratch.tamper / scratch.challenge). This
// dual-publishes (like stream-checkin.js): publishActivity feeds the site +
// community activity SSE, while enqueueOverlay drops a relay:overlay-* KV
// trigger that Clay's EXISTING Streamer.bot/OBS poller consumes, that is
// the path that actually executes the tamper / shows the on-stream reveal.
// Map the action in Streamer.bot off `actionKey` (see SCRATCH-OFF-STREAMERBOT.md).
async function emitHitFire(env, row, forced) {
  const od = jparse(row.outcome_data, {});
  const ts = now();
  if (row.outcome === 'tamper') {
    const payload = {
      ticketId: row.id, viewer: row.user_name || null, gameSlug: row.game_slug,
      actionKey: od.actionKey || null, durationSec: od.durationSec || 0,
      body: od.body, forced: !!forced,
    };
    await publishActivity(env, { kind: 'scratch.tamper', ...payload }).catch(() => {});
    await enqueueOverlay(env, { type: 'scratch_tamper', bus_kind: 'scratch.tamper', ...payload, ts }).catch(() => {});
  } else if (row.outcome === 'challenge') {
    const payload = {
      ticketId: row.id, viewer: row.user_name || null, gameSlug: row.game_slug,
      body: od.body, durationSec: od.durationSec || 0, forced: !!forced,
    };
    await publishActivity(env, { kind: 'scratch.challenge', ...payload }).catch(() => {});
    await enqueueOverlay(env, { type: 'scratch_challenge', bus_kind: 'scratch.challenge', ...payload, ts }).catch(() => {});
  }
}

// ── Admin content layer: merge + CRUD (games / challenges / tampers) ────
// The code seed (GAMES, GAME_THEMES, POOLS, STREAMER_BOT_ACTIONS) is the base;
// KV overlays (scratch:games / scratch:challenges / scratch:tampers) are the
// live editable layer and WIN on conflicts. Challenge edits reseed D1 (the
// pool rollOutcome reads); games/tampers are read merged on demand.

const SLUG_RE = /^[a-z0-9_]{2,40}$/;

// Resolve the full theme object (face palette) for a slug from a merged map.
function themeForSlug(games, slug) {
  const g = games[slug] || games.generic || {};
  const base = GAME_THEMES.generic;
  return {
    accent: g.accent || base.accent, accent2: g.accent2 || base.accent2,
    icon: g.icon || base.icon, deep: g.deep || '#0a0b12',
    title: g.title || (g.name ? String(g.name).toUpperCase() : 'AQUILO'),
    tag: g.tag || base.tag, name: g.name || slug,
  };
}

// code GAMES + GAME_THEMES overlaid by the KV admin overlay (KV wins).
async function mergedGames(env) {
  const overlay = (await kvGet(env, K_GAMES, true)) || {};
  const out = {};
  for (const [slug, name] of Object.entries(GAMES)) {
    const th = GAME_THEMES[slug] || {};
    out[slug] = {
      slug, name, accent: th.accent || GAME_THEMES.generic.accent,
      accent2: th.accent2 || GAME_THEMES.generic.accent2, icon: th.icon || 'star',
      deep: th.deep || '#0a0b12', title: th.title || name.toUpperCase(),
      tag: th.tag || '', aliases: TWITCH_ALIASES[slug] || [], source: 'code',
    };
  }
  for (const [slug, ov] of Object.entries(overlay)) {
    if (!ov || typeof ov !== 'object') continue;
    const base = out[slug];
    out[slug] = {
      slug, name: ov.name || (base && base.name) || slug,
      accent: ov.accent || (base && base.accent) || GAME_THEMES.generic.accent,
      accent2: ov.accent2 || (base && base.accent2) || GAME_THEMES.generic.accent2,
      icon: ov.icon || (base && base.icon) || 'star',
      deep: ov.deep || (base && base.deep) || '#0a0b12',
      title: ov.title || (base && base.title) || String(ov.name || slug).toUpperCase(),
      tag: ov.tag != null ? ov.tag : (base && base.tag) || '',
      aliases: Array.isArray(ov.aliases) ? ov.aliases : (base && base.aliases) || [],
      source: base ? 'code+admin' : 'admin',
    };
  }
  return out;
}

// code STREAMER_BOT_ACTIONS overlaid by the KV tampers overlay.
async function mergedTampers(env) {
  const overlay = (await kvGet(env, K_TAMPERS, true)) || {};
  const out = {};
  for (const a of STREAMER_BOT_ACTIONS) {
    out[a.action_key] = { actionKey: a.action_key, actionName: a.action_name,
      defaultDurationSec: a.default_duration_sec, description: a.description, pending: false, source: 'code' };
  }
  for (const [k, ov] of Object.entries(overlay)) {
    if (!ov || typeof ov !== 'object') continue;
    const base = out[k];
    out[k] = { actionKey: k, actionName: ov.actionName || (base && base.actionName) || k,
      defaultDurationSec: Number.isFinite(ov.defaultDurationSec) ? ov.defaultDurationSec : (base ? base.defaultDurationSec : 30),
      description: ov.description != null ? ov.description : (base && base.description) || '',
      pending: ov.pending != null ? !!ov.pending : (base ? base.pending : true),
      source: base ? 'code+admin' : 'admin' };
  }
  return out;
}

// Effective challenge list for editing. KV when present, else the live D1 pool
// (so the first edit inherits whatever is currently seeded).
async function loadChallengeList(env) {
  const kv = await kvGet(env, K_CHALLENGES, true);
  if (Array.isArray(kv)) return kv;
  await ensureSchema(env);
  const rows = (await db(env).prepare(
    `SELECT id, game_slug, kind, body, action_key, weight, duration_sec, active
     FROM scratch_outcome_pool ORDER BY game_slug, kind`).all()).results || [];
  return rows.map((r) => ({ id: r.id, gameSlug: r.game_slug, kind: r.kind, body: r.body,
    actionKey: r.action_key, weight: r.weight, durationSec: r.duration_sec, active: r.active }));
}

// Persist the challenge list to KV and rebuild D1 from it (KV is authoritative).
async function saveChallengeList(env, list) {
  await kvPut(env, K_CHALLENGES, list);
  await ensureSchema(env);
  const d = db(env);
  const stmts = [d.prepare(`DELETE FROM scratch_outcome_pool`)];
  for (const e of list) {
    if (!e.gameSlug || !e.kind || !e.body) continue;
    stmts.push(d.prepare(
      `INSERT INTO scratch_outcome_pool (id, game_slug, kind, body, action_key, weight, duration_sec, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(String(e.id || rid('op')), String(e.gameSlug), String(e.kind), String(e.body).slice(0, 240),
        e.actionKey || null, parseInt(e.weight, 10) || 10, parseInt(e.durationSec, 10) || 0,
        e.active === 0 ? 0 : 1, now()));
  }
  await d.batch(stmts);
}

async function handleGameCrud(env, body) {
  const op = String(body.op || 'add');
  const overlay = (await kvGet(env, K_GAMES, true)) || {};
  const slug = String(body.slug || '').trim().toLowerCase();
  if (op === 'delete') {
    if (!slug) return jsonResp({ ok: false, error: 'missing-slug' }, 400);
    delete overlay[slug];
    await kvPut(env, K_GAMES, overlay);
    return jsonResp({ ok: true, deleted: slug, note: GAMES[slug] ? 'reverted-to-code-default' : 'removed' });
  }
  // add | update
  if (!SLUG_RE.test(slug)) return jsonResp({ ok: false, error: 'bad-slug', hint: 'a-z 0-9 _ only' }, 400);
  const prev = overlay[slug] || {};
  const entry = {
    name: body.name != null ? String(body.name).slice(0, 80) : prev.name,
    accent: body.accent != null ? String(body.accent).slice(0, 32) : prev.accent,
    accent2: body.accent2 != null ? String(body.accent2).slice(0, 32) : prev.accent2,
    icon: body.icon != null ? String(body.icon).slice(0, 4000) : prev.icon,
    deep: body.deep != null ? String(body.deep).slice(0, 32) : prev.deep,
    tag: body.tag != null ? String(body.tag).slice(0, 80) : prev.tag,
    title: body.title != null ? String(body.title).slice(0, 40) : prev.title,
    aliases: Array.isArray(body.aliases) ? body.aliases.map((a) => String(a).slice(0, 80)).slice(0, 12) : prev.aliases,
  };
  overlay[slug] = entry;
  await kvPut(env, K_GAMES, overlay);
  return jsonResp({ ok: true, slug, game: { slug, ...entry } });
}

async function handleChallengeCrud(env, body) {
  const op = String(body.op || 'add');
  const list = await loadChallengeList(env);
  if (op === 'delete') {
    if (!body.id) return jsonResp({ ok: false, error: 'missing-id' }, 400);
    const next = list.filter((e) => String(e.id) !== String(body.id));
    if (next.length === list.length) return jsonResp({ ok: false, error: 'not-found' }, 404);
    await saveChallengeList(env, next);
    return jsonResp({ ok: true, deleted: String(body.id), count: next.length });
  }
  if (op === 'update') {
    if (!body.id) return jsonResp({ ok: false, error: 'missing-id' }, 400);
    const idx = list.findIndex((e) => String(e.id) === String(body.id));
    if (idx < 0) return jsonResp({ ok: false, error: 'not-found' }, 404);
    const cur = list[idx];
    list[idx] = {
      ...cur,
      gameSlug: body.gameSlug != null ? String(body.gameSlug) : cur.gameSlug,
      kind: body.kind != null ? String(body.kind) : cur.kind,
      body: body.body != null ? String(body.body).slice(0, 240) : cur.body,
      actionKey: body.actionKey !== undefined ? (body.actionKey || null) : cur.actionKey,
      weight: body.weight != null ? (parseInt(body.weight, 10) || 10) : cur.weight,
      durationSec: body.durationSec != null ? (parseInt(body.durationSec, 10) || 0) : cur.durationSec,
      active: body.active != null ? (body.active ? 1 : 0) : cur.active,
    };
    await saveChallengeList(env, list);
    return jsonResp({ ok: true, updated: String(body.id) });
  }
  // add
  if (!body.gameSlug || !body.kind || !body.body) return jsonResp({ ok: false, error: 'missing-fields' }, 400);
  const entry = { id: rid('op'), gameSlug: String(body.gameSlug), kind: String(body.kind),
    body: String(body.body).slice(0, 240), actionKey: body.kind === 'tamper' ? (body.actionKey || 'random_keys') : null,
    weight: parseInt(body.weight, 10) || 10, durationSec: parseInt(body.durationSec, 10) || 0, active: 1 };
  list.push(entry);
  await saveChallengeList(env, list);
  return jsonResp({ ok: true, added: entry.id, count: list.length });
}

async function handleTamperCrud(env, body) {
  const op = String(body.op || 'add');
  const overlay = (await kvGet(env, K_TAMPERS, true)) || {};
  const key = String(body.actionKey || '').trim();
  if (!SLUG_RE.test(key)) return jsonResp({ ok: false, error: 'bad-action-key', hint: 'a-z 0-9 _ only' }, 400);
  if (op === 'delete') {
    delete overlay[key];
    await kvPut(env, K_TAMPERS, overlay);
    return jsonResp({ ok: true, deleted: key });
  }
  const isCode = STREAMER_BOT_ACTIONS.some((a) => a.action_key === key);
  const prev = overlay[key] || {};
  const entry = {
    actionName: body.actionName != null ? String(body.actionName).slice(0, 80) : (prev.actionName || key),
    defaultDurationSec: Number.isFinite(body.defaultDurationSec)
      ? Math.max(0, Math.min(120, body.defaultDurationSec | 0)) : (prev.defaultDurationSec ?? 30),
    description: body.description != null ? String(body.description).slice(0, 240) : (prev.description || ''),
    // A brand-new key (not in the code registry) needs the C# Streamer.bot
    // action wired before it actually fires, mark it pending.
    pending: isCode ? false : (body.pending != null ? !!body.pending : true),
  };
  overlay[key] = entry;
  await kvPut(env, K_TAMPERS, overlay);
  // Mirror into D1 so weightedPick/seed see it.
  await ensureSchema(env);
  await db(env).prepare(
    `INSERT INTO scratch_streamer_bot_action (action_key, action_name, default_duration_sec, cooldown_sec, description, active)
     VALUES (?, ?, ?, 0, ?, 1)
     ON CONFLICT(action_key) DO UPDATE SET action_name=excluded.action_name,
       default_duration_sec=excluded.default_duration_sec, description=excluded.description`)
    .bind(key, entry.actionName, entry.defaultDurationSec, entry.description).run();
  return jsonResp({ ok: true, actionKey: key, tamper: { actionKey: key, ...entry } });
}

// Owner-gated CRUD over scratch_outcome_pool. body.op: add|update|delete|list.
async function handlePoolCrud(env, body) {
  await ensureSchema(env);
  const d = db(env);
  const op = String(body.op || 'add');
  if (op === 'list') {
    const slug = body.gameSlug ? String(body.gameSlug) : null;
    const rows = (await (slug
      ? d.prepare(`SELECT * FROM scratch_outcome_pool WHERE game_slug = ? ORDER BY kind, weight DESC`).bind(slug)
      : d.prepare(`SELECT * FROM scratch_outcome_pool ORDER BY game_slug, kind, weight DESC`)).all()).results || [];
    return jsonResp({ ok: true, count: rows.length, pool: rows });
  }
  if (op === 'delete') {
    if (!body.id) return jsonResp({ ok: false, error: 'missing-id' }, 400);
    await d.prepare(`DELETE FROM scratch_outcome_pool WHERE id = ?`).bind(String(body.id)).run();
    return jsonResp({ ok: true, deleted: String(body.id) });
  }
  if (op === 'update') {
    if (!body.id) return jsonResp({ ok: false, error: 'missing-id' }, 400);
    const cur = await d.prepare(`SELECT * FROM scratch_outcome_pool WHERE id = ?`).bind(String(body.id)).first();
    if (!cur) return jsonResp({ ok: false, error: 'not-found' }, 404);
    const merged = {
      kind: body.kind ?? cur.kind, body: body.body ?? cur.body,
      action_key: body.actionKey ?? cur.action_key,
      weight: body.weight ?? cur.weight, duration_sec: body.durationSec ?? cur.duration_sec,
      active: body.active != null ? (body.active ? 1 : 0) : cur.active,
    };
    await d.prepare(
      `UPDATE scratch_outcome_pool SET kind=?, body=?, action_key=?, weight=?, duration_sec=?, active=? WHERE id=?`)
      .bind(merged.kind, merged.body, merged.action_key, merged.weight, merged.duration_sec, merged.active, String(body.id)).run();
    return jsonResp({ ok: true, updated: String(body.id) });
  }
  // add (single or batch via body.entries[])
  const entries = Array.isArray(body.entries) ? body.entries
    : [{ gameSlug: body.gameSlug, kind: body.kind, body: body.body,
         actionKey: body.actionKey, weight: body.weight, durationSec: body.durationSec }];
  let added = 0;
  for (const e of entries) {
    if (!e.gameSlug || !e.kind || !e.body) continue;
    const id = rid('op');
    await d.prepare(
      `INSERT INTO scratch_outcome_pool (id, game_slug, kind, body, action_key, weight, duration_sec, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`)
      .bind(id, String(e.gameSlug), String(e.kind), String(e.body),
            e.actionKey || null, parseInt(e.weight, 10) || 10, parseInt(e.durationSec, 10) || 0, now()).run();
    added++;
  }
  return jsonResp({ ok: true, added });
}

// ── Haiku pool generation ──────────────────────────────────────────────
// Bulk-generate per-game challenge/tamper entries via Claude Haiku using
// the worker's ANTHROPIC_API_KEY. Voice: no em dashes, no cringe,
// dry/dark-humored, mechanical TCG-style brevity. Tampers must reference an
// action_key from the registry. Caller chunks the games list (Workers
// subrequest/wall limits), token-gated.

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

async function callHaiku(env, prompt) {
  const key = String(env.ANTHROPIC_API_KEY || '').trim();
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!r.ok) throw new Error('anthropic ' + r.status + ' ' + (await r.text()).slice(0, 160));
  const j = await r.json();
  return (j.content || []).map((c) => c.text || '').join('');
}

function extractJsonArray(text) {
  const a = text.indexOf('[');
  const b = text.lastIndexOf(']');
  if (a < 0 || b < 0 || b < a) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}

async function generatePoolForGame(env, slug, perGame) {
  const name = GAMES[slug] || slug;
  const actions = STREAMER_BOT_ACTIONS.map((a) => a.action_key + ' (' + a.action_name + ')').join(', ');
  const prompt =
`You write outcomes for a Twitch scratch-off card mini-game on the channel "Aquilo".
Current game: ${name}.

Produce ${perGame} winning outcomes a viewer can roll. Mix two kinds:
- "challenge": something the streamer (Clay) performs live, ideally tied to ${name}'s mechanics.
- "tamper": a Streamer.bot control tamper. tamper outcomes MUST set actionKey to one of these exact keys: ${actions}. Set durationSec (10 to 90).

Voice rules, strict:
- No em dashes. No exclamation-mark spam. No cringe, no hype words, no emoji.
- Dry, dark-humored, mechanical TCG-card brevity. One sentence each, imperative.
- Reference ${name} specifically where it fits (its enemies, mechanics, items, lingo).

Return ONLY a JSON array, no prose. Each element:
{"kind":"challenge"|"tamper","body":string,"actionKey":string|null,"durationSec":number,"weight":number}
weight 5 to 12. challenge entries have actionKey null and durationSec 0 unless timed.`;
  const text = await callHaiku(env, prompt);
  const arr = extractJsonArray(text);
  if (!Array.isArray(arr)) return { slug, inserted: 0, error: 'parse-failed' };
  const d = db(env);
  const validKeys = new Set(STREAMER_BOT_ACTIONS.map((a) => a.action_key));
  let inserted = 0, i = 0;
  for (const e of arr) {
    if (!e || (e.kind !== 'challenge' && e.kind !== 'tamper') || !e.body) continue;
    let actionKey = e.kind === 'tamper' ? (e.actionKey || null) : null;
    if (e.kind === 'tamper' && (!actionKey || !validKeys.has(actionKey))) actionKey = 'random_keys';
    const id = `op_${slug}_g${i++}_${now().toString(36)}`;
    await d.prepare(
      `INSERT INTO scratch_outcome_pool (id, game_slug, kind, body, action_key, weight, duration_sec, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`)
      .bind(id, slug, e.kind, String(e.body).slice(0, 240), actionKey,
            Math.max(1, Math.min(20, parseInt(e.weight, 10) || 10)),
            Math.max(0, Math.min(120, parseInt(e.durationSec, 10) || 0)), now()).run();
    inserted++;
  }
  return { slug, inserted };
}

// Seed the action registry + outcome pools. Idempotent: by default skips
// pools that already have rows for a game. `force` re-inserts (does not
// dedupe), so only use force on a fresh table.
export async function seedScratch(env, { force = false } = {}) {
  await ensureSchema(env);
  const d = db(env);
  let actions = 0, pools = 0, skipped = 0;

  for (const a of STREAMER_BOT_ACTIONS) {
    await d.prepare(
      `INSERT INTO scratch_streamer_bot_action (action_key, action_name, default_duration_sec, cooldown_sec, description, active)
       VALUES (?, ?, ?, 0, ?, 1)
       ON CONFLICT(action_key) DO UPDATE SET action_name=excluded.action_name,
         default_duration_sec=excluded.default_duration_sec, description=excluded.description`)
      .bind(a.action_key, a.action_name, a.default_duration_sec, a.description).run();
    actions++;
  }

  for (const [slug, entries] of Object.entries(POOLS)) {
    if (!force) {
      const have = await d.prepare(`SELECT COUNT(*) AS n FROM scratch_outcome_pool WHERE game_slug = ?`)
        .bind(slug).first();
      if (have && have.n > 0) { skipped++; continue; }
    }
    let i = 0;
    for (const e of entries) {
      const id = `op_${slug}_${i++}_${now().toString(36)}`;
      await d.prepare(
        `INSERT INTO scratch_outcome_pool (id, game_slug, kind, body, action_key, weight, duration_sec, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`)
        .bind(id, slug, e.kind, e.body, e.actionKey || null, e.weight || 10, e.durationSec || 0, now()).run();
      pools++;
    }
  }
  return { actions, poolsInserted: pools, gamesSkipped: skipped };
}
