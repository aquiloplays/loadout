// Daily Quests — per-day rotating quest set across the Aquilo game
// surface (check-in, Boltbound, Clash, counting, pet, spire).
//
// Storage layout:
//   D1 daily_quest_def         — quest catalogue (seeded by migration)
//   D1 user_daily_quest        — per-(user, quest, day) progress + claim flag
//   KV daily-quests:rotation:<YYYY-MM-DD> — today's rotation snapshot (8 IDs)
//
// The rotation snapshot is what fixes the user-visible "today" set in
// place — without it, two calls to listTodaysQuests at different
// minutes could see different active defs if an admin edited the
// catalogue mid-day. We pick once (weighted random, deterministic per
// day via seed), cache to KV, and reuse for the rest of the day.
//
// dailyResetCron is intentionally a no-op data-wise: rolling the day
// is just changing the `day` key. The cron exists so we (a) pre-warm
// tomorrow's rotation snapshot at 00:00 UTC and (b) have a hook for
// future "daily reset" notifications.
//
// All quest grants flow through wallet.earn() (or the wallet module's
// XP grant) so the ECONOMY_PACE multipliers + booster multipliers
// apply uniformly with the rest of the economy.

const QUESTS_PER_DAY = 5;             // visible quest count per user per day
const ROTATION_KV_TTL_SECONDS = 60 * 60 * 36; // 36h (covers DST + clock skew)

// ── D1 helpers ─────────────────────────────────────────────────────

async function db(env) {
  if (!env.DB) throw new Error('daily-quests: no D1 binding (env.DB missing)');
  return env.DB;
}

// UTC YYYY-MM-DD for the rotation key. Day rollover = 00:00 UTC.
export function todayUtcKey(nowMs) {
  const d = new Date(nowMs || Date.now());
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// xmur3 string→u32 seeder + mulberry32 PRNG. We seed off the day key
// so the rotation is the same for every user on a given UTC day, and
// stable across cold-starts (no need to persist a per-day seed).
function makeRng(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let s = (h >>> 0) || 1;
  return function rng() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Weighted-random selection without replacement. Picks `k` distinct
// defs from `defs`, biased by def.weight. Used to materialise the
// daily rotation snapshot.
function pickWeighted(defs, k, rng) {
  const pool = defs.slice();
  const out = [];
  while (out.length < k && pool.length) {
    const total = pool.reduce((s, d) => s + Math.max(1, d.weight || 1), 0);
    let pick = rng() * total;
    let idx = 0;
    for (; idx < pool.length; idx++) {
      pick -= Math.max(1, pool[idx].weight || 1);
      if (pick <= 0) break;
    }
    if (idx >= pool.length) idx = pool.length - 1;
    out.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return out;
}

// ── Catalogue loaders ─────────────────────────────────────────────

async function loadActiveDefs(env, game) {
  const D = await db(env);
  let rows;
  if (game) {
    rows = await D.prepare(
      'SELECT * FROM daily_quest_def WHERE active = 1 AND game = ?'
    ).bind(game).all();
  } else {
    rows = await D.prepare(
      'SELECT * FROM daily_quest_def WHERE active = 1'
    ).all();
  }
  return (rows?.results || []).map(parseDef);
}

async function loadDef(env, questId) {
  const D = await db(env);
  const r = await D.prepare(
    'SELECT * FROM daily_quest_def WHERE id = ? LIMIT 1'
  ).bind(questId).first();
  return r ? parseDef(r) : null;
}

function parseDef(row) {
  let reward = {};
  try { reward = JSON.parse(row.reward_json || '{}'); } catch { reward = {}; }
  return {
    id:          row.id,
    game:        row.game,
    type:        row.type,
    threshold:   Number(row.threshold) || 1,
    reward,
    weight:      Number(row.weight) || 1,
    active:      Number(row.active) === 1,
    title:       row.title || row.id,
    description: row.description || '',
  };
}

// ── Rotation snapshot ─────────────────────────────────────────────

// Returns the list of def IDs that make up today's rotation. Reads
// from KV if cached; otherwise picks + writes once. Caller passes the
// optional `game` filter — game-filtered rotations are cached under a
// distinct KV key so callers can ask for "just my Boltbound quests".
async function getRotation(env, dayKey, game) {
  const kvKey = `daily-quests:rotation:${dayKey}` + (game ? `:${game}` : '');
  try {
    const cached = await env.LOADOUT_BOLTS.get(kvKey, { type: 'json' });
    if (cached && Array.isArray(cached.questIds) && cached.questIds.length) {
      return cached.questIds;
    }
  } catch { /* fall through to recompute */ }

  const defs = await loadActiveDefs(env, game);
  if (!defs.length) return [];
  const rng = makeRng(dayKey + (game ? ':' + game : ''));
  const picked = pickWeighted(defs, Math.min(QUESTS_PER_DAY, defs.length), rng);
  const questIds = picked.map(d => d.id);
  try {
    await env.LOADOUT_BOLTS.put(
      kvKey,
      JSON.stringify({ questIds, pickedAt: Date.now() }),
      { expirationTtl: ROTATION_KV_TTL_SECONDS },
    );
  } catch { /* best-effort cache */ }
  return questIds;
}

// ── Public API ────────────────────────────────────────────────────

// Today's quests for a user. Each entry is { def, progress, claimed }.
// New users (no rows in user_daily_quest yet) get virtual zero rows so
// the embed renderer doesn't have to handle the missing-row case.
export async function listTodaysQuests(env, userId, game, nowMs) {
  if (!userId) return [];
  const dayKey = todayUtcKey(nowMs);
  const questIds = await getRotation(env, dayKey, game);
  if (!questIds.length) return [];

  const D = await db(env);
  // Pull progress rows in one query (IN ?,?,?). D1 doesn't support
  // array-binding so we expand placeholders.
  const placeholders = questIds.map(() => '?').join(',');
  const progRows = await D.prepare(
    `SELECT quest_id, progress, claimed
       FROM user_daily_quest
      WHERE user_id = ? AND day = ? AND quest_id IN (${placeholders})`
  ).bind(userId, dayKey, ...questIds).all();
  const byId = new Map();
  for (const r of (progRows?.results || [])) {
    byId.set(r.quest_id, { progress: Number(r.progress) || 0, claimed: Number(r.claimed) === 1 });
  }

  // Load defs (also one IN-query). Filter to the visible rotation;
  // skips any quest whose def was retired between snapshot + read.
  const defRows = await D.prepare(
    `SELECT * FROM daily_quest_def WHERE id IN (${placeholders})`
  ).bind(...questIds).all();
  const defById = new Map();
  for (const r of (defRows?.results || [])) {
    defById.set(r.id, parseDef(r));
  }

  // Preserve rotation order (questIds order = display order in embed).
  const out = [];
  for (const qid of questIds) {
    const def = defById.get(qid);
    if (!def) continue;
    const state = byId.get(qid) || { progress: 0, claimed: false };
    out.push({ def, progress: state.progress, claimed: state.claimed });
  }
  return out;
}

// Bump progress for a quest. `delta` defaults to 1; caps at threshold
// so the embed never shows 7/3. Returns { newProgress, completed,
// alreadyClaimed }. Idempotent past completion: re-calling on a
// completed quest is a no-op (progress already at threshold).
export async function incrementQuest(env, userId, questId, delta = 1, nowMs) {
  if (!userId || !questId) return { newProgress: 0, completed: false };
  const d = Number(delta);
  if (!Number.isFinite(d) || d <= 0) return { newProgress: 0, completed: false };
  const def = await loadDef(env, questId);
  if (!def || !def.active) return { newProgress: 0, completed: false, error: 'unknown-quest' };
  const dayKey = todayUtcKey(nowMs);
  const D = await db(env);

  // Upsert the row, capping at threshold. SQLite's INSERT ... ON
  // CONFLICT … UPDATE keeps the read+write in one statement; the
  // MIN() cap handles "do 5 more" not overshooting.
  await D.prepare(
    `INSERT INTO user_daily_quest (user_id, quest_id, day, progress, claimed)
     VALUES (?, ?, ?, MIN(?, ?), 0)
     ON CONFLICT (user_id, quest_id, day) DO UPDATE SET
       progress = MIN(?, progress + ?)`
  ).bind(
    userId, questId, dayKey,
    Math.floor(d), def.threshold,
    def.threshold, Math.floor(d),
  ).run();

  // Read back the canonical value (covers the "already at threshold"
  // case + lets callers branch on first-completion).
  const row = await D.prepare(
    `SELECT progress, claimed FROM user_daily_quest
      WHERE user_id = ? AND quest_id = ? AND day = ?`
  ).bind(userId, questId, dayKey).first();
  const newProgress = Number(row?.progress) || 0;
  const claimed = Number(row?.claimed) === 1;
  return {
    newProgress,
    completed:      newProgress >= def.threshold,
    alreadyClaimed: claimed,
  };
}

// Claim the reward for a quest. Gate: must be completed AND not
// already claimed. Sets claimed=1 BEFORE granting the wallet to make
// the double-claim race tight (a concurrent /claim that beats the
// UPDATE would also be told ok:false). Returns the granted reward
// shape so the embed can render the chime.
export async function claimQuest(env, userId, questId, opts = {}) {
  if (!userId || !questId) return { ok: false, reason: 'bad-args' };
  const def = await loadDef(env, questId);
  if (!def) return { ok: false, reason: 'unknown-quest' };
  const dayKey = todayUtcKey(opts.nowMs);
  const D = await db(env);

  const row = await D.prepare(
    `SELECT progress, claimed FROM user_daily_quest
      WHERE user_id = ? AND quest_id = ? AND day = ?`
  ).bind(userId, questId, dayKey).first();
  if (!row) return { ok: false, reason: 'not-started' };
  if (Number(row.claimed) === 1) return { ok: false, reason: 'already-claimed' };
  if (Number(row.progress) < def.threshold) {
    return { ok: false, reason: 'not-complete', progress: Number(row.progress), threshold: def.threshold };
  }

  // Atomic-ish claim flag — UPDATE … WHERE claimed = 0 means a
  // concurrent claim loses (changes = 0).
  const upd = await D.prepare(
    `UPDATE user_daily_quest
        SET claimed = 1, claimed_at = datetime('now')
      WHERE user_id = ? AND quest_id = ? AND day = ? AND claimed = 0`
  ).bind(userId, questId, dayKey).run();
  const changed = upd?.meta?.changes ?? upd?.changes ?? 0;
  if (changed === 0) return { ok: false, reason: 'already-claimed' };

  // Grant via wallet.earn() so booster multipliers + lifetime stats
  // flow through the existing pipeline. guildId comes from opts (web
  // route knows it) or env.AQUILO_VAULT_GUILD_ID as a fallback.
  const guildId = opts.guildId || env.AQUILO_VAULT_GUILD_ID;
  const granted = { ...def.reward };
  if (def.reward.bolts && guildId) {
    try {
      const wallet = opts.walletModule || (await import('./wallet.js'));
      await wallet.earn(env, guildId, userId, def.reward.bolts, `daily-quest:${def.id}`);
    } catch (e) {
      // Don't unwind the claim — the wallet write failure is logged
      // but the user keeps the "claimed" mark so they can re-attempt
      // via admin if needed. Mirrors how spire.js handles grant
      // failures (logs, surfaces in return shape).
      granted.walletError = e?.message || String(e);
    }
  }
  // XP is best-effort the same way. progression/xp uses earnXp().
  if (def.reward.xp && guildId) {
    try {
      const xp = opts.xpModule || (await import('./progression/xp.js'));
      if (xp.earnXp) await xp.earnXp(env, guildId, userId, def.reward.xp, `daily-quest:${def.id}`);
    } catch (e) {
      granted.xpError = e?.message || String(e);
    }
  }
  return { ok: true, granted, questId: def.id };
}

// Daily-reset cron — runs at 00:00 UTC. Doesn't mutate any user data
// (today's rows are still valid, yesterday's are history). Pre-warms
// the rotation snapshot for the new day so the first lookup of the
// morning doesn't pay the pick+write cost. Returns the rotation it
// just warmed so the cron logs are useful.
export async function dailyResetCron(env, nowMs) {
  const dayKey = todayUtcKey(nowMs);
  try {
    const questIds = await getRotation(env, dayKey);
    return { ok: true, dayKey, questIds, warmed: questIds.length };
  } catch (e) {
    return { ok: false, dayKey, error: e?.message || String(e) };
  }
}

// ── HTTP route handler ────────────────────────────────────────────
// Mirrors the friends.js pattern: GET unauthenticated for the user's
// view of today's rotation; POST routes (claim, increment) HMAC-gated
// via x-aquilo-web-ts + x-aquilo-web-sig signed with
// AQUILO_SITE_WEB_SECRET. The site's Pages Functions sign on the
// caller's behalf — see web.js for the verifier.

function _json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });
}

async function _gateHmac(req, env) {
  const { verifyHmac } = await import('./auth.js');
  if (!env.AQUILO_SITE_WEB_SECRET) {
    return { ok: false, status: 503, error: 'AQUILO_SITE_WEB_SECRET missing' };
  }
  const bodyText = req.method === 'POST' ? await req.text() : '';
  const ts  = req.headers.get('x-aquilo-web-ts');
  const sig = req.headers.get('x-aquilo-web-sig');
  const ok  = await verifyHmac(env.AQUILO_SITE_WEB_SECRET, ts || '', bodyText, sig || '');
  if (!ok) return { ok: false, status: 401, error: 'unauthorized' };
  let body = {};
  if (bodyText) {
    try { body = JSON.parse(bodyText); } catch { return { ok: false, status: 400, error: 'bad-json' }; }
  }
  return { ok: true, body };
}

export async function handleQuestsRoute(req, env, path) {
  // GET /web/quests/today/<userId>[?game=<game>]
  if (req.method === 'GET' && path.startsWith('/web/quests/today/')) {
    const userId = path.slice('/web/quests/today/'.length).split('/')[0];
    if (!userId) return _json({ error: 'userId required' }, 400);
    const url = new URL(req.url);
    const game = url.searchParams.get('game') || undefined;
    const quests = await listTodaysQuests(env, userId, game);
    return _json({ userId, dayKey: todayUtcKey(), quests });
  }
  // All writes require HMAC.
  const gate = await _gateHmac(req, env);
  if (!gate.ok) return _json({ error: gate.error }, gate.status);
  const b = gate.body || {};
  const userId = String(b.userId || '').trim();
  if (!userId) return _json({ error: 'userId required' }, 400);

  if (req.method === 'POST' && path === '/web/quests/claim') {
    const questId = String(b.questId || '').trim();
    if (!questId) return _json({ error: 'questId required' }, 400);
    const r = await claimQuest(env, userId, questId);
    return _json(r, r.ok ? 200 : 400);
  }
  if (req.method === 'POST' && path === '/web/quests/increment') {
    const questId = String(b.questId || '').trim();
    const delta   = Number(b.delta) || 1;
    if (!questId) return _json({ error: 'questId required' }, 400);
    const r = await incrementQuest(env, userId, questId, delta);
    return _json(r);
  }
  return _json({ error: 'unknown-op' }, 404);
}

// ── Test-only helpers ─────────────────────────────────────────────
// Exported for the test harness to short-circuit the KV cache between
// scenarios. Not part of the public API.
export const __internals = { makeRng, pickWeighted, getRotation, loadActiveDefs };
