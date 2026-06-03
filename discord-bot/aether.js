// Aether economy, D1-backed tracked ledger with milestone grants.
//
// 2026-05-31 sprint. Distinct from the passive live-accrual counter in
// stream-bonus.js (wallet.aether, which fuels Clash while Clay is
// live). THIS is the spendable Aether economy: a per-(guild,user)
// balance plus an append-only aether_transaction ledger, seeded from
// stream-content.js migration. Milestone events (anniversary, pass
// tier unlock, drop claim, squad activity) grant Aether through here.
//
// Lazy seed: the first time a user's ledger is touched, their legacy
// wallet.aether is folded in as the opening balance (one-time, flagged
// by user_aether.seeded) so the two stores don't fragment.
//
// Public API:
//   getAetherBalance(env, g, u)            -> { balance, lifetimeEarned, lifetimeSpent }
//   grantAether(env, g, u, amount, reason) -> { ok, balance, tx }
//   spendAether(env, g, u, amount, reason) -> { ok, balance } | { ok:false, error:'insufficient-aether' }
//   getAetherHistory(env, g, u, limit)     -> { ok, transactions }
//   grantAetherForMilestone(env, g, u, kind, opts) -> grant by milestone kind

const AETHER_TABLE = 'user_aether';

// Milestone → Aether grant table. Stable; tweak values here.
export const MILESTONE_AETHER = Object.freeze({
  'anniversary':      50,   // base; multiplied by years at call site
  'pass-tier':        10,
  'squad-join':        5,
  'first-game':       20,
});

function db(env) {
  if (!env || !env.DB) throw new Error('aether: no D1 binding (env.DB missing)');
  return env.DB;
}

function newId() { return crypto.randomUUID(); }

// ── Lazy seed + row read ──────────────────────────────────────────

async function readRow(D, guildId, userId) {
  return D.prepare(
    `SELECT guild_id, user_id, balance, lifetime_earned, lifetime_spent, seeded, updated_at
       FROM user_aether WHERE guild_id = ? AND user_id = ? LIMIT 1`
  ).bind(guildId, String(userId)).first();
}

// Ensure a row exists, folding in the legacy wallet.aether balance the
// first time. Returns the row (post-seed).
async function ensureRow(env, guildId, userId) {
  const D = db(env);
  let row = await readRow(D, guildId, userId);
  if (row) return row;
  // First touch, seed from legacy wallet.aether (best-effort).
  let opening = 0;
  try {
    const w = await env.LOADOUT_BOLTS.get(`wallet:${guildId}:${userId}`, { type: 'json' });
    opening = Math.max(0, Math.floor(Number(w?.aether) || 0));
  } catch { /* no legacy balance */ }
  const now = Date.now();
  await D.prepare(
    `INSERT OR IGNORE INTO user_aether
       (guild_id, user_id, balance, lifetime_earned, lifetime_spent, seeded, updated_at)
     VALUES (?, ?, ?, ?, 0, 1, ?)`
  ).bind(guildId, String(userId), opening, opening, now).run();
  if (opening > 0) {
    await D.prepare(
      `INSERT INTO aether_transaction (id, guild_id, user_id, delta, reason, balance_after, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(newId(), guildId, String(userId), opening, 'seed:legacy-wallet-aether', opening, now).run();
  }
  row = await readRow(D, guildId, userId);
  return row;
}

function shape(row) {
  return {
    balance: Number(row?.balance || 0),
    lifetimeEarned: Number(row?.lifetime_earned || 0),
    lifetimeSpent: Number(row?.lifetime_spent || 0),
  };
}

// ── Read ──────────────────────────────────────────────────────────

export async function getAetherBalance(env, guildId, userId) {
  if (!guildId || !userId) return { ok: false, error: 'bad-args' };
  const row = await ensureRow(env, guildId, userId);
  return { ok: true, ...shape(row) };
}

export async function getAetherHistory(env, guildId, userId, limit) {
  if (!guildId || !userId) return { ok: false, error: 'bad-args' };
  const D = db(env);
  const lim = Math.max(1, Math.min(100, Number(limit) || 25));
  const { results } = await D.prepare(
    // rowid DESC tiebreaks same-millisecond transactions so the ledger
    // is deterministically newest-first even under burst writes.
    `SELECT id, delta, reason, balance_after, created_at
       FROM aether_transaction
      WHERE guild_id = ? AND user_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?`
  ).bind(guildId, String(userId), lim).all();
  return {
    ok: true,
    transactions: (results || []).map(r => ({
      id: r.id, delta: r.delta, reason: r.reason,
      balanceAfter: r.balance_after, createdAt: r.created_at,
    })),
  };
}

// ── Mutate ────────────────────────────────────────────────────────

// Internal apply: signed delta, writes the row + ledger atomically-ish
// (D1 has no multi-statement txn in the Workers binding, but a crash
// between the two writes is recoverable, the ledger is the audit, the
// row is the source of truth).
async function applyDelta(env, guildId, userId, delta, reason) {
  const D = db(env);
  const row = await ensureRow(env, guildId, userId);
  const cur = Number(row.balance || 0);
  const next = cur + delta;
  if (next < 0) return { ok: false, error: 'insufficient-aether', balance: cur };
  const now = Date.now();
  const earnedInc = delta > 0 ? delta : 0;
  const spentInc  = delta < 0 ? -delta : 0;
  await D.prepare(
    `UPDATE user_aether
        SET balance = ?, lifetime_earned = lifetime_earned + ?,
            lifetime_spent = lifetime_spent + ?, updated_at = ?
      WHERE guild_id = ? AND user_id = ?`
  ).bind(next, earnedInc, spentInc, now, guildId, String(userId)).run();
  const txId = newId();
  await D.prepare(
    `INSERT INTO aether_transaction (id, guild_id, user_id, delta, reason, balance_after, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(txId, guildId, String(userId), delta, String(reason || '').slice(0, 64), next, now).run();
  return { ok: true, balance: next, tx: { id: txId, delta, balanceAfter: next, createdAt: now } };
}

export async function grantAether(env, guildId, userId, amount, reason) {
  const amt = Math.floor(Number(amount) || 0);
  if (!guildId || !userId) return { ok: false, error: 'bad-args' };
  if (amt <= 0) return { ok: false, error: 'bad-amount' };
  return applyDelta(env, guildId, userId, amt, reason || 'grant');
}

export async function spendAether(env, guildId, userId, amount, reason) {
  const amt = Math.floor(Number(amount) || 0);
  if (!guildId || !userId) return { ok: false, error: 'bad-args' };
  if (amt <= 0) return { ok: false, error: 'bad-amount' };
  return applyDelta(env, guildId, userId, -amt, reason || 'spend');
}

// Milestone hook, single entry point gameplay code calls when a
// milestone fires. `kind` keys into MILESTONE_AETHER. `opts.multiplier`
// scales the base (e.g. anniversary years). Unknown kinds no-op.
export async function grantAetherForMilestone(env, guildId, userId, kind, opts = {}) {
  const base = MILESTONE_AETHER[kind];
  if (!base) return { ok: false, error: 'unknown-milestone', kind };
  const mult = Math.max(1, Math.floor(Number(opts.multiplier) || 1));
  return grantAether(env, guildId, userId, base * mult, `milestone:${kind}`);
}
