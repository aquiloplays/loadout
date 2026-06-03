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

const HIT_RATE = 0.08;            // ~8% of cards win
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
  const slug = slugForTwitchGame(gameName);
  return { slug: slug || 'generic', gameName: slug ? gameName : (gameName || null) };
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
  'access-control-allow-headers': 'content-type, x-scratch-token, x-scratch-webhook-secret',
};

function jsonResp(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json', ...CORS, ...extraHeaders },
  });
}

// Admin/owner gate, reuses the Stream Deck token if no dedicated one is
// set, so the trigger + CRUD endpoints work out of the box tonight.
function tokenOk(req, env, url) {
  const want = String(env.SCRATCH_ADMIN_TOKEN || env.STREAMDECK_TOKEN || '').trim();
  if (!want) return false;
  const got = (req.headers.get('x-scratch-token') || url.searchParams.get('token') || '').trim();
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
// opts.allowHit gates wins (per-stream cap/cooldown): when false the card
// always loses, regardless of the roll. opts.hitRate overrides the default.
async function rollOutcome(env, gameSlug, opts = {}) {
  const allowHit = opts.allowHit !== false;
  const hitRate = Number.isFinite(opts.hitRate) ? opts.hitRate : HIT_RATE;
  if (!allowHit || Math.random() >= hitRate) {
    return loseOutcome();
  }
  const d = db(env);
  // Prefer the game's own pool; fall back to generic if it has none.
  let rows = (await d.prepare(
    `SELECT id, kind, body, action_key, weight, duration_sec FROM scratch_outcome_pool
     WHERE game_slug = ? AND active = 1`).bind(gameSlug).all()).results || [];
  if (!rows.length && gameSlug !== 'generic') {
    rows = (await d.prepare(
      `SELECT id, kind, body, action_key, weight, duration_sec FROM scratch_outcome_pool
       WHERE game_slug = 'generic' AND active = 1`).all()).results || [];
  }
  const pick = weightedPick(rows);
  if (!pick) {
    // No pool seeded at all, degrade to a generic challenge so a "hit"
    // still feels like a win rather than silently becoming a loss.
    return { outcome: 'challenge', outcomeData: {
      poolId: null, body: 'Pose for the stream for 10 seconds.', durationSec: 10 } };
  }
  return {
    outcome: pick.kind, // 'challenge' | 'tamper'
    outcomeData: {
      poolId: pick.id, body: pick.body, durationSec: pick.duration_sec || 0,
      actionKey: pick.action_key || null,
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
  const game = liveCtx
    ? { slug: liveCtx.slug, gameName: liveCtx.gameName }
    : await resolveCurrentGame(env);
  const cfg = await pacingCfg(env);
  const allowHit = await hitBudgetOk(env, liveCtx?.streamId, cfg);
  const { outcome, outcomeData } = await rollOutcome(env, game.slug, { allowHit, hitRate: cfg.hitRate });
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
      return jsonResp({ ok: true, gameSlug: ctx.slug,
        gameName: ctx.gameName || GAMES[ctx.slug] || null,
        live: ctx.live, paused: ctx.paused, canBuy: ctx.live && !ctx.paused,
        ...(consolationTotal !== undefined ? { consolationTotal } : {}) },
        200, { 'cache-control': 'public, max-age=10' });
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
