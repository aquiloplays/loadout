// Unit tests for daily-quests, list / increment / claim flow, error
// gates (claim-before-complete + double-claim), rotation determinism.
//
// Run from discord-bot/:
//   node test/test-daily-quests.mjs

import {
  listTodaysQuests,
  incrementQuest,
  claimQuest,
  dailyResetCron,
  todayUtcKey,
  __internals,
} from '../daily-quests.js';

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } }
function eq(a, b, m)  { if (a === b) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m, '(want:', b, 'got:', a, ')'); } }

// ── Mock env (in-memory KV + D1) ──────────────────────────────────
//
// D1 mock supports the exact subset of SQL the module uses:
//   - INSERT INTO daily_quest_def ...
//   - SELECT * FROM daily_quest_def WHERE active = 1 [AND game = ?]
//   - SELECT * FROM daily_quest_def WHERE id = ?
//   - SELECT * FROM daily_quest_def WHERE id IN (?,?,?…)
//   - SELECT quest_id, progress, claimed FROM user_daily_quest WHERE …
//   - INSERT INTO user_daily_quest … ON CONFLICT … UPDATE
//   - UPDATE user_daily_quest SET claimed = 1 …
//   - SELECT progress, claimed FROM user_daily_quest WHERE user_id = ? AND quest_id = ? AND day = ?
//
// We don't run a real sqlite engine, these tests only need to verify
// module logic, not D1's SQL parser. So the mock stores rows as JS
// arrays and dispatches per-statement.

function makeMockDb() {
  const defs = [];            // daily_quest_def
  const userRows = [];        // user_daily_quest
  function prepare(sql) {
    return {
      _sql: sql,
      _binds: [],
      bind(...args) { this._binds = args; return this; },
      async first() {
        const rows = runSelect(sql, this._binds, defs, userRows);
        return rows[0] || null;
      },
      async all() {
        return { results: runSelect(sql, this._binds, defs, userRows) };
      },
      async run() {
        return runMutation(sql, this._binds, defs, userRows);
      },
    };
  }
  return { prepare, _defs: defs, _userRows: userRows };
}

function runSelect(sql, b, defs, userRows) {
  const s = sql.replace(/\s+/g, ' ').trim();
  // daily_quest_def WHERE active = 1 AND game = ?
  if (s.startsWith('SELECT * FROM daily_quest_def WHERE active = 1 AND game =')) {
    return defs.filter(d => d.active === 1 && d.game === b[0]);
  }
  // daily_quest_def WHERE active = 1
  if (s.startsWith('SELECT * FROM daily_quest_def WHERE active = 1')) {
    return defs.filter(d => d.active === 1);
  }
  // daily_quest_def WHERE id = ?
  if (s.startsWith('SELECT * FROM daily_quest_def WHERE id = ?')) {
    return defs.filter(d => d.id === b[0]).slice(0, 1);
  }
  // daily_quest_def WHERE id IN (...)
  if (/^SELECT \* FROM daily_quest_def WHERE id IN \(/.test(s)) {
    const set = new Set(b);
    return defs.filter(d => set.has(d.id));
  }
  // user_daily_quest IN-query for progress
  if (/^SELECT quest_id, progress, claimed FROM user_daily_quest WHERE user_id = \? AND day = \? AND quest_id IN/.test(s)) {
    const [userId, day, ...qids] = b;
    const set = new Set(qids);
    return userRows
      .filter(r => r.user_id === userId && r.day === day && set.has(r.quest_id))
      .map(r => ({ quest_id: r.quest_id, progress: r.progress, claimed: r.claimed }));
  }
  // user_daily_quest single-quest read
  if (/^SELECT progress, claimed FROM user_daily_quest WHERE user_id = \? AND quest_id = \? AND day = \?/.test(s)) {
    const [userId, qid, day] = b;
    return userRows
      .filter(r => r.user_id === userId && r.quest_id === qid && r.day === day)
      .map(r => ({ progress: r.progress, claimed: r.claimed }));
  }
  throw new Error('mock-db: unhandled SELECT ' + s);
}

function runMutation(sql, b, defs, userRows) {
  const s = sql.replace(/\s+/g, ' ').trim();
  // Seed: INSERT INTO daily_quest_def (id, game, type, threshold, reward_json, weight, active, title, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  if (/^INSERT (OR IGNORE )?INTO daily_quest_def/.test(s)) {
    const [id, game, type, threshold, reward_json, weight, active, title, description] = b;
    if (defs.find(d => d.id === id) && /OR IGNORE/.test(s)) return { meta: { changes: 0 } };
    defs.push({ id, game, type, threshold, reward_json, weight, active, title, description });
    return { meta: { changes: 1 } };
  }
  // INSERT … ON CONFLICT … UPDATE for user_daily_quest
  if (/^INSERT INTO user_daily_quest .* ON CONFLICT/.test(s)) {
    // binds: userId, questId, dayKey, delta, threshold, threshold, delta
    const [userId, questId, day, delta, threshold, threshold2, delta2] = b;
    const existing = userRows.find(r =>
      r.user_id === userId && r.quest_id === questId && r.day === day);
    if (existing) {
      existing.progress = Math.min(threshold2, existing.progress + delta2);
      return { meta: { changes: 1 } };
    }
    userRows.push({
      user_id: userId, quest_id: questId, day,
      progress: Math.min(delta, threshold), claimed: 0, claimed_at: null,
    });
    return { meta: { changes: 1 } };
  }
  // UPDATE user_daily_quest SET claimed = 1 … WHERE … AND claimed = 0
  if (/^UPDATE user_daily_quest SET claimed = 1/.test(s)) {
    const [userId, questId, day] = b;
    const row = userRows.find(r =>
      r.user_id === userId && r.quest_id === questId && r.day === day && r.claimed === 0);
    if (!row) return { meta: { changes: 0 } };
    row.claimed = 1;
    row.claimed_at = new Date().toISOString();
    return { meta: { changes: 1 } };
  }
  throw new Error('mock-db: unhandled MUTATION ' + s);
}

function makeMockKv() {
  const store = new Map();
  return {
    async get(key, opts) {
      const v = store.get(key);
      if (v === undefined) return null;
      if (opts?.type === 'json') return JSON.parse(v);
      return v;
    },
    async put(key, val) { store.set(key, val); },
    async delete(key) { store.delete(key); },
    _store: store,
  };
}

function makeMockWallet() {
  const grants = [];
  return {
    grants,
    async earn(env, gid, uid, amount, reason) {
      grants.push({ gid, uid, amount, reason });
      return { balance: amount, lifetimeEarned: amount };
    },
  };
}

function seedDefs(env, defs) {
  for (const d of defs) {
    env.DB._defs.push({
      id: d.id, game: d.game, type: d.type, threshold: d.threshold,
      reward_json: JSON.stringify(d.reward || {}),
      weight: d.weight || 1, active: d.active ?? 1,
      title: d.title || d.id, description: d.description || '',
    });
  }
}

// ── Tests ─────────────────────────────────────────────────────────

console.log('- todayUtcKey shape');
{
  const k = todayUtcKey(Date.UTC(2026, 5, 15, 12, 30)); // June 15 2026
  eq(k, '2026-06-15', 'mid-day UTC → YYYY-MM-DD');
  const k2 = todayUtcKey(Date.UTC(2026, 0, 1, 0, 0));
  eq(k2, '2026-01-01', 'Jan 1 00:00 UTC');
}

console.log('- makeRng is deterministic');
{
  const a = __internals.makeRng('seed');
  const b = __internals.makeRng('seed');
  eq(a(), b(), 'same seed → same first draw');
  eq(a(), b(), 'same seed → same second draw');
  const c = __internals.makeRng('other');
  assert(__internals.makeRng('seed')() !== c(), 'different seed → different draws');
}

console.log('- pickWeighted respects k + uniqueness');
{
  const defs = [
    { id: 'a', weight: 1 },
    { id: 'b', weight: 1 },
    { id: 'c', weight: 1 },
  ];
  const rng = __internals.makeRng('test');
  const picked = __internals.pickWeighted(defs, 2, rng);
  eq(picked.length, 2, 'picks exactly k');
  assert(picked[0].id !== picked[1].id, 'no duplicates');
  // k > pool size clamps to pool size
  const all = __internals.pickWeighted(defs, 99, __internals.makeRng('x'));
  eq(all.length, 3, 'k > pool clamps to pool size');
}

console.log('- listTodaysQuests for new user returns rotation with zero progress');
{
  const env = { DB: makeMockDb(), LOADOUT_BOLTS: makeMockKv() };
  seedDefs(env, [
    { id: 'q1', game: 'general', type: 'oneshot', threshold: 1, reward: { bolts: 10 } },
    { id: 'q2', game: 'general', type: 'count',   threshold: 3, reward: { bolts: 12 } },
    { id: 'q3', game: 'general', type: 'count',   threshold: 5, reward: { bolts: 5  } },
  ]);
  const list = await listTodaysQuests(env, 'user-new', null, Date.UTC(2026, 5, 1));
  assert(list.length >= 1 && list.length <= 3, `new user gets up to QUESTS_PER_DAY entries (got ${list.length})`);
  for (const item of list) {
    eq(item.progress, 0, `${item.def.id} progress = 0`);
    eq(item.claimed, false, `${item.def.id} claimed = false`);
    assert(item.def.threshold > 0, `${item.def.id} has threshold`);
  }
}

console.log('- increment + claim flow grants wallet');
{
  const env = { DB: makeMockDb(), LOADOUT_BOLTS: makeMockKv(), AQUILO_VAULT_GUILD_ID: 'g1' };
  seedDefs(env, [
    { id: 'win3', game: 'boltbound', type: 'count', threshold: 3, reward: { bolts: 40 } },
  ]);
  const wallet = makeMockWallet();
  const now = Date.UTC(2026, 5, 2);

  // Below threshold: still incomplete.
  const r1 = await incrementQuest(env, 'user-a', 'win3', 1, now);
  eq(r1.newProgress, 1, '1st increment → progress=1');
  eq(r1.completed, false, 'not yet complete');

  // Try claim early → ok:false
  const earlyClaim = await claimQuest(env, 'user-a', 'win3',
    { guildId: 'g1', walletModule: wallet, nowMs: now });
  eq(earlyClaim.ok, false, 'claim before complete → ok:false');
  eq(earlyClaim.reason, 'not-complete', 'reason = not-complete');
  eq(wallet.grants.length, 0, 'no wallet grant fired');

  // Push to threshold (cap at 3 even if we send 10).
  const r2 = await incrementQuest(env, 'user-a', 'win3', 10, now);
  eq(r2.newProgress, 3, 'capped at threshold');
  eq(r2.completed, true, 'completed');

  // Claim → ok:true, wallet earn fired.
  const claim = await claimQuest(env, 'user-a', 'win3',
    { guildId: 'g1', walletModule: wallet, nowMs: now });
  eq(claim.ok, true, 'claim after complete → ok:true');
  eq(claim.granted.bolts, 40, 'granted bolts = 40');
  eq(wallet.grants.length, 1, 'wallet.earn() called once');
  eq(wallet.grants[0].amount, 40, 'wallet got 40 bolts');
  eq(wallet.grants[0].reason, 'daily-quest:win3', 'wallet reason tagged');

  // Double-claim → ok:false
  const doubleClaim = await claimQuest(env, 'user-a', 'win3',
    { guildId: 'g1', walletModule: wallet, nowMs: now });
  eq(doubleClaim.ok, false, 'second claim → ok:false');
  eq(doubleClaim.reason, 'already-claimed', 'reason = already-claimed');
  eq(wallet.grants.length, 1, 'no extra wallet grant on double-claim');
}

console.log('- listTodaysQuests reflects in-progress + claimed state');
{
  const env = { DB: makeMockDb(), LOADOUT_BOLTS: makeMockKv(), AQUILO_VAULT_GUILD_ID: 'g1' };
  seedDefs(env, [
    { id: 'q1', game: 'general', type: 'count', threshold: 2, reward: { bolts: 5 } },
  ]);
  const wallet = makeMockWallet();
  const now = Date.UTC(2026, 5, 3);
  await incrementQuest(env, 'user-b', 'q1', 1, now);
  let list = await listTodaysQuests(env, 'user-b', null, now);
  const e1 = list.find(x => x.def.id === 'q1');
  eq(e1.progress, 1, 'mid-progress reflected');
  eq(e1.claimed, false, 'not yet claimed');

  await incrementQuest(env, 'user-b', 'q1', 1, now);
  await claimQuest(env, 'user-b', 'q1', { guildId: 'g1', walletModule: wallet, nowMs: now });
  list = await listTodaysQuests(env, 'user-b', null, now);
  const e2 = list.find(x => x.def.id === 'q1');
  eq(e2.progress, 2, 'completed progress = threshold');
  eq(e2.claimed, true, 'claimed flag set');
}

console.log('- unknown quest → safe no-op');
{
  const env = { DB: makeMockDb(), LOADOUT_BOLTS: makeMockKv() };
  const r = await incrementQuest(env, 'u', 'does-not-exist', 1, Date.UTC(2026, 5, 4));
  eq(r.completed, false, 'unknown quest increment → completed:false');
  eq(r.error, 'unknown-quest', 'error tagged');
  const c = await claimQuest(env, 'u', 'does-not-exist', { guildId: 'g1', nowMs: Date.UTC(2026, 5, 4) });
  eq(c.ok, false, 'unknown quest claim → ok:false');
  eq(c.reason, 'unknown-quest', 'reason = unknown-quest');
}

console.log('- dailyResetCron warms rotation snapshot in KV');
{
  const env = { DB: makeMockDb(), LOADOUT_BOLTS: makeMockKv() };
  seedDefs(env, [
    { id: 'q1', game: 'general', type: 'count', threshold: 1, reward: { bolts: 1 } },
    { id: 'q2', game: 'general', type: 'count', threshold: 1, reward: { bolts: 1 } },
  ]);
  const now = Date.UTC(2026, 5, 5);
  const r = await dailyResetCron(env, now);
  eq(r.ok, true, 'cron ok:true');
  eq(r.dayKey, '2026-06-05', 'dayKey set');
  assert(r.warmed >= 1, `warmed ${r.warmed} quest(s)`);
  // The KV cache key should now exist.
  const cached = await env.LOADOUT_BOLTS.get(`daily-quests:rotation:2026-06-05`, { type: 'json' });
  assert(cached && Array.isArray(cached.questIds), 'KV snapshot persisted');
}

console.log('');
console.log(`PASSED, ${pass} ok / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
