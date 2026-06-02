// Twitch panel scratch-off cards.
//
// Viewers spend Twitch bits via the panel to mint a scratch-off ticket.
// The card has a tactile pointer-drag scratch interaction (client-side,
// in aquilo-site). Most cards lose; ~HIT_RATE hit. The OUTCOME IS DECIDED
// SERVER-SIDE AT MINT TIME and withheld from the client until the viewer
// has physically scratched past REVEAL_THRESHOLD — so a viewer cannot read
// the result early off the wire. On a hit the outcome is either a
// chat-driven CHALLENGE (Clay performs it live) or a Streamer.bot TAMPER
// (invert mouse, swap WASD, mute mic, …) that fires through the Aquilo Bus
// to a Loadout-side relay (see SCRATCH-OFF-STREAMERBOT.md).
//
// The current game is detected from Clay's Twitch category (getChannelGame
// in twitch-helix.js — same lookup the death counter uses) and normalized
// to a slug; that drives both the themed outcome pool and the panel's
// per-game card art.
//
// Storage: D1 env.DB (scratch_ticket / scratch_outcome_pool /
// scratch_streamer_bot_action — see scratch-off-migration.sql). The schema
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
import { getChannelGame } from './twitch-helix.js';

// ── Tunables ───────────────────────────────────────────────────────────

const HIT_RATE = 0.08;            // ~8% of cards win
const REVEAL_THRESHOLD = 70;      // % scratched before the outcome reveals
const SCRATCH_SKUS = new Set([    // Twitch product SKUs that mint a card
  'scratch_card_100', 'scratch_card', 'aquilo_scratch_100',
]);

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

// Lazy schema apply — runs the migration statements once per isolate so a
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

// Admin/owner gate — reuses the Stream Deck token if no dedicated one is
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

// Decide a ticket's outcome at mint. Returns { outcome, outcomeData }.
async function rollOutcome(env, gameSlug) {
  if (Math.random() >= HIT_RATE) {
    return { outcome: 'lose', outcomeData: { message: pickLoss() } };
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
    // No pool seeded at all — degrade to a generic challenge so a "hit"
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

const LOSS_LINES = [
  'No win this time.', 'Not this one. Try again.', 'Empty. Better luck next card.',
  'Nothing here. The vault stays sealed.', 'Dud. Buy another.', 'So close. (Not really.)',
  'House keeps this one.',
];
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
  }
  return base;
}

async function getTicket(env, id) {
  return await db(env).prepare(`SELECT * FROM scratch_ticket WHERE id = ?`).bind(String(id)).first();
}

async function mintTicket(env, { userId, userName, bits, sku, txnId }) {
  await ensureSchema(env);
  const d = db(env);
  // Idempotency: a repeated Twitch transaction returns the existing ticket.
  if (txnId) {
    const existing = await d.prepare(`SELECT * FROM scratch_ticket WHERE txn_id = ?`)
      .bind(String(txnId)).first();
    if (existing) return { ticket: existing, reused: true };
  }
  const game = await resolveCurrentGame(env);
  const { outcome, outcomeData } = await rollOutcome(env, game.slug);
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
      const { ticket, reused } = await mintTicket(env, {
        userId, userName: b.userName || b.user_name || b.displayName || null,
        bits: b.bits || b.cost || 0, sku, txnId: b.transactionId || b.transaction_id || b.txnId || null,
      });
      return jsonResp({ ok: true, reused, ticket: ticketPublic(ticket, { includeOutcome: false }) });
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
        return jsonResp({ ok: true, ...ticketPublic(fresh, { includeOutcome: true }) });
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

    // ---- Current game (panel theme) ------------------------------------
    if (method === 'GET' && path === '/web/scratch/current-game') {
      const game = await resolveCurrentGame(env);
      return jsonResp({ ok: true, gameSlug: game.slug,
        gameName: game.gameName || GAMES[game.slug] || null },
        200, { 'cache-control': 'public, max-age=15' });
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

    // ---- Admin: outcome-pool CRUD --------------------------------------
    if (method === 'POST' && path === '/web/admin/scratch/outcome-pool') {
      if (!tokenOk(req, env, url)) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
      return await handlePoolCrud(env, await readBody(req));
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

// Emit the specific firing event (scratch.tamper / scratch.challenge). For
// tampers this is the signal the Loadout-side relay listens for to POST to
// Streamer.bot's local WebSocket.
async function emitHitFire(env, row, forced) {
  const od = jparse(row.outcome_data, {});
  if (row.outcome === 'tamper') {
    await publishActivity(env, {
      kind: 'scratch.tamper', ticketId: row.id, viewer: row.user_name || null,
      gameSlug: row.game_slug, actionKey: od.actionKey || null,
      durationSec: od.durationSec || 0, body: od.body, forced: !!forced,
    }).catch(() => {});
  } else if (row.outcome === 'challenge') {
    await publishActivity(env, {
      kind: 'scratch.challenge', ticketId: row.id, viewer: row.user_name || null,
      gameSlug: row.game_slug, body: od.body, durationSec: od.durationSec || 0, forced: !!forced,
    }).catch(() => {});
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

// ── Seed data ──────────────────────────────────────────────────────────
// Voice: no em dashes, no cringe, dry/dark-humored, mechanical TCG-style
// brevity. Tampers reference a Streamer.bot action_key from the registry.

const STREAMER_BOT_ACTIONS = [
  { action_key: 'invert_mouse',  action_name: 'Invert Mouse',   default_duration_sec: 30, description: 'Invert mouse Y (and X) axis for the duration.' },
  { action_key: 'swap_wasd',     action_name: 'Swap WASD',      default_duration_sec: 60, description: 'Remap movement keys so W/S and A/D are swapped.' },
  { action_key: 'lock_crouch',   action_name: 'Lock Crouch',    default_duration_sec: 90, description: 'Force-hold the crouch key.' },
  { action_key: 'force_jump',    action_name: 'Force Jump',     default_duration_sec: 30, description: 'Inject periodic jump key presses.' },
  { action_key: 'mute_mic',      action_name: 'Mute Mic',       default_duration_sec: 10, description: 'Mute the streamer mic input.' },
  { action_key: 'random_keys',   action_name: 'Random Keys',    default_duration_sec: 30, description: 'Inject random key presses.' },
  { action_key: 'mouse_drift',   action_name: 'Mouse Drift',    default_duration_sec: 30, description: 'Apply a constant cursor drift in one direction.' },
  { action_key: 'force_walk',    action_name: 'Force Walk',     default_duration_sec: 60, description: 'Hold the walk modifier so movement is slow.' },
  { action_key: 'sensitivity_max', action_name: 'Max Sensitivity', default_duration_sec: 45, description: 'Spike look sensitivity to max.' },
  { action_key: 'flip_screen',   action_name: 'Flip Screen',    default_duration_sec: 20, description: 'Flip the game capture upside down (display filter).' },
  { action_key: 'deafen',        action_name: 'Deafen Game',    default_duration_sec: 30, description: 'Mute game audio output.' },
  { action_key: 'spam_emote',    action_name: 'Force Emote',    default_duration_sec: 15, description: 'Trigger an in-game emote/taunt repeatedly.' },
];

const T = (body, actionKey, durationSec, weight = 10) => ({ kind: 'tamper', body, actionKey, durationSec, weight });
const C = (body, durationSec = 0, weight = 10) => ({ kind: 'challenge', body, durationSec, weight });

const POOLS = {
  generic: [
    C('Pose for the stream. Hold it 10 seconds.', 10),
    C('Do 5 push-ups off camera. Chat counts.', 0),
    C('Pick the worst dialogue option at the next prompt.', 0),
    C('Read the next chat message in a villain voice.', 0),
    C('Whisper everything you say for the next 2 minutes.', 120),
    C('No coffee/drink for 5 minutes.', 300),
    C('Name your next save file whatever chat picks.', 0),
    C('Give a 20-second TED talk on your current objective.', 20),
    C('Compliment the last person who followed.', 0),
    C('Narrate the next 60 seconds like a nature documentary.', 60),
    C('Switch to your worst posture for 3 minutes.', 180),
    C('Do the next section one-handed.', 0, 6),
    C('Sit in silence for 30 seconds. No talking.', 30),
    C('Speak only in questions for 90 seconds.', 90),
    T('Mouse inverted for 30 seconds.', 'invert_mouse', 30, 12),
    T('WASD swapped for 60 seconds.', 'swap_wasd', 60, 10),
    T('Mic muted for 10 seconds. Mid-sentence.', 'mute_mic', 10, 10),
    T('Random key presses for 30 seconds.', 'random_keys', 30, 8),
    T('Cursor drifts left for 30 seconds.', 'mouse_drift', 30, 8),
    T('Look sensitivity maxed for 45 seconds.', 'sensitivity_max', 45, 6),
    T('Forced to walk, no running, for 60 seconds.', 'force_walk', 60, 8),
    T('Screen flips upside down for 20 seconds.', 'flip_screen', 20, 5),
  ],
  fallout4: [
    C('Lone survivor. Dismiss your companion for the next quest.', 0, 8),
    C('Pacifist mode. No kills for 5 minutes.', 300, 8),
    C('Sell your best weapon to the next vendor.', 0, 6),
    C('Talk to the next NPC entirely in character.', 0),
    C('Drop all your stimpaks. Right now.', 0, 5),
    C('Build something ugly in the next settlement. Chat names it.', 0),
    C('Only V.A.T.S. for the next 5 minutes. No free aim.', 300, 7),
    C('Wear the worst armor in your inventory until the next loading screen.', 0),
    T('Mouse inverted for 60 seconds. Good luck in the wasteland.', 'invert_mouse', 60, 12),
    T('Crouch locked for 90 seconds. Sneak whether you like it or not.', 'lock_crouch', 90, 9),
    T('WASD swapped for 60 seconds.', 'swap_wasd', 60, 9),
    T('Forced V.A.T.S. spam: random key presses for 30 seconds.', 'random_keys', 30, 7),
    T('Pip-Boy posture: forced walk for 60 seconds.', 'force_walk', 60, 7),
    T('Rad-vision: screen flips for 20 seconds.', 'flip_screen', 20, 5),
  ],
  among_us: [
    C('Vote yourself out next round.', 0, 9),
    C('Do not talk during the next meeting. At all.', 0, 9),
    C('Accuse the first person who speaks next meeting.', 0, 7),
    C('Self-report the next body you find.', 0, 6),
    C('Follow one crewmate the entire next round. Say nothing.', 0),
    C('Defend the most sus player like your life depends on it.', 0),
    T('Random key presses for 30 seconds. Good luck doing tasks.', 'random_keys', 30, 10),
    T('Mouse drift for 30 seconds.', 'mouse_drift', 30, 8),
    T('Mic muted for 10 seconds next meeting.', 'mute_mic', 10, 8),
  ],
  sts2: [
    C('Take the worst card option at the next 3 rewards.', 0, 9),
    C('Skip the next relic. No exceptions.', 0, 7),
    C('Open the next chest. Whatever it is, keep it.', 0, 6),
    C('Play your hand left to right, no thinking, next combat.', 0, 7),
    C('Purge your best card at the next merchant.', 0, 5),
    C('Take the elite path at the next fork.', 0, 6),
    T('Mouse drifts left for 2 turns worth of time (20 seconds).', 'mouse_drift', 20, 9),
    T('Cursor sensitivity maxed for 45 seconds.', 'sensitivity_max', 45, 6),
    T('Random key presses for 20 seconds mid-deckbuild.', 'random_keys', 20, 6),
  ],
  minecraft: [
    C('Sleep is banned for the next night cycle.', 0, 7),
    C('Drop your best tool into lava. Chat picks which.', 0, 6),
    C('Only punch trees, no axe, for 3 minutes.', 180, 7),
    C('Name the next tamed mob whatever chat says.', 0),
    C('Build the next structure with no blocks but dirt.', 0, 6),
    T('Mouse inverted for 45 seconds.', 'invert_mouse', 45, 11),
    T('Crouch locked for 90 seconds. Sneak everywhere.', 'lock_crouch', 90, 9),
    T('Forced jump presses for 30 seconds.', 'force_jump', 30, 8),
    T('Forced walk for 60 seconds.', 'force_walk', 60, 7),
  ],
  lethal_company: [
    C('Lead the way into the next building. No backing out.', 0, 8),
    C('Drop your most valuable scrap and leave it for 60 seconds.', 60, 7),
    C('No flashlight for the next 2 minutes.', 120, 7),
    C('Narrate everything you see until you die or leave.', 0),
    T('Mic muted for 10 seconds. Pick a bad moment.', 'mute_mic', 10, 10),
    T('Mouse inverted for 30 seconds inside the facility.', 'invert_mouse', 30, 10),
    T('Random key presses for 30 seconds.', 'random_keys', 30, 7),
    T('Forced walk for 60 seconds. The monsters are not slow.', 'force_walk', 60, 7),
  ],
  peak: [
    C('Take the worst climbing route at the next fork.', 0, 8),
    C('Carry the heaviest item for the next 3 minutes.', 180, 7),
    C('No stamina items for the next climb.', 0, 6),
    T('Mouse inverted for 30 seconds mid-climb.', 'invert_mouse', 30, 11),
    T('WASD swapped for 45 seconds.', 'swap_wasd', 45, 9),
    T('Forced jump for 20 seconds. On a cliff. Sorry.', 'force_jump', 20, 7),
  ],
  content_warning: [
    C('Film the next monster up close. No running.', 0, 8),
    C('Do a 15-second piece to camera before the next room.', 15, 7),
    C('Be the cameraperson the whole next dive.', 0),
    T('Mic muted for 10 seconds while filming.', 'mute_mic', 10, 10),
    T('Camera drift: mouse drift for 30 seconds.', 'mouse_drift', 30, 9),
    T('Random key presses for 30 seconds.', 'random_keys', 30, 7),
  ],
  phasmophobia: [
    C('Go in alone. Solo the next room.', 0, 9),
    C('No flashlight in the next room. Total dark.', 0, 8),
    C('Say the ghost type out loud and commit. No changing.', 0, 6),
    T('Mic muted for 10 seconds during the hunt.', 'mute_mic', 10, 10),
    T('Mouse inverted for 30 seconds.', 'invert_mouse', 30, 9),
    T('Flashlight flicker: random key presses for 20 seconds.', 'random_keys', 20, 7),
  ],
  dbd: [
    C('No looping. Hold W only at the next chase.', 0, 7),
    C('Cleanse/bless the next totem even if it is a trap.', 0, 6),
    C('Go for the save even if it is a bad idea.', 0, 7),
    T('Mouse inverted for 30 seconds.', 'invert_mouse', 30, 10),
    T('Look sensitivity maxed for 45 seconds.', 'sensitivity_max', 45, 7),
    T('Forced walk for 30 seconds. In a chase. Brutal.', 'force_walk', 30, 6),
  ],
  eldenring: [
    C('No blocking for the next 2 minutes.', 120, 8),
    C('Two-hand your worst weapon until the next grace.', 0, 6),
    C('No healing for the next 90 seconds.', 90, 7),
    C('Bow to the next enemy before you fight it.', 0),
    T('Mouse inverted for 45 seconds. Maidenless.', 'invert_mouse', 45, 11),
    T('Lock crouch for 60 seconds.', 'lock_crouch', 60, 7),
    T('Random key presses for 20 seconds.', 'random_keys', 20, 7),
  ],
};

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
