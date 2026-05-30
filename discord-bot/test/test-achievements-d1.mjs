// Unit tests for achievements-d1.js — the new D1-backed achievement
// engine. Distinct from progression/achievements.js (KV+XP+event-bus,
// already serving /web/achievements/*) and aquilo/achievements.js
// (legacy CATALOG bump-and-announce). This module is namespaced
// behind /web/achievements/d1/* so all three coexist.
//
// Run with:   node test/test-achievements-d1.mjs

import {
  listAchievements,
  getUserAchievements,
  tryUnlock,
  checkAndUnlock,
} from '../achievements-d1.js';

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } }
function eq(a, b, m)  { if (a === b) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m, '(want:', b, 'got:', a, ')'); } }

// ── In-memory D1 mock ─────────────────────────────────────────────
//
// Stores two arrays (achievement_def, user_achievement) and pattern-
// matches the SQL strings the module emits. Not a SQL engine — just
// enough surface for these tests. If the module's queries change,
// the mock must change in lockstep.

function makeMockDB() {
  const defs = [];          // { id, name, description, icon, tier, points, trigger_type, trigger_threshold, active }
  const userAch = [];       // { user_id, achievement_id, unlocked_at }

  function execHandlers(sql, args) {
    return {
      async first() {
        // achievement_def lookup by id
        if (/FROM achievement_def\s+WHERE id = \?/i.test(sql)) {
          const [id] = args;
          return defs.find(d => d.id === id && d.active === 1) || null;
        }
        // user_achievement existence check
        if (/FROM user_achievement WHERE user_id = \? AND achievement_id = \?/i.test(sql)) {
          const [uid, aid] = args;
          return userAch.find(r => r.user_id === uid && r.achievement_id === aid) || null;
        }
        return null;
      },
      async all() {
        // listAchievements (no bind — fully unparameterized)
        if (/FROM achievement_def\s+WHERE active = 1\s+ORDER BY tier, id/i.test(sql)) {
          return { results: defs.filter(d => d.active === 1) };
        }
        // listAchievements filtered by trigger type
        if (/FROM achievement_def\s+WHERE active = 1 AND trigger_type = \?/i.test(sql)) {
          const [t] = args;
          return { results: defs.filter(d => d.active === 1 && d.trigger_type === t) };
        }
        // getUserAchievements (joined)
        if (/FROM user_achievement u\s+JOIN achievement_def a/i.test(sql)) {
          const [uid] = args;
          const rows = userAch
            .filter(r => r.user_id === uid)
            .map(r => {
              const d = defs.find(x => x.id === r.achievement_id);
              if (!d) return null;
              return {
                id: d.id, name: d.name, description: d.description,
                icon: d.icon, tier: d.tier, points: d.points,
                unlocked_at: r.unlocked_at,
              };
            })
            .filter(Boolean)
            .sort((a, b) => b.unlocked_at - a.unlocked_at);
          return { results: rows };
        }
        // owned-set lookup inside checkAndUnlock
        if (/SELECT achievement_id FROM user_achievement WHERE user_id = \?/i.test(sql)) {
          const [uid] = args;
          return { results: userAch.filter(r => r.user_id === uid).map(r => ({ achievement_id: r.achievement_id })) };
        }
        return { results: [] };
      },
      async run() {
        // INSERT OR IGNORE into user_achievement
        if (/INSERT OR IGNORE INTO user_achievement/i.test(sql)) {
          const [uid, aid, ts] = args;
          const exists = userAch.find(r => r.user_id === uid && r.achievement_id === aid);
          if (!exists) userAch.push({ user_id: uid, achievement_id: aid, unlocked_at: ts });
          return { meta: { changes: exists ? 0 : 1 } };
        }
        return { meta: { changes: 0 } };
      },
    };
  }

  function preparedFor(sql) {
    // D1's PreparedStatement supports calling .first()/.all()/.run()
    // directly when there are no bind params, OR after .bind(...). The
    // mock mirrors both shapes.
    const direct = execHandlers(sql, []);
    return {
      ...direct,
      bind(...args) { return execHandlers(sql, args); },
    };
  }

  return {
    _defs: defs,
    _userAch: userAch,
    prepare(sql) { return preparedFor(sql); },
  };
}

// Seed matches the migration's 15 starter achievements.
function seedDefs(db) {
  const rows = [
    ['first-checkin',         'First Check-In',          'Check in to your first stream.',                'sun',     'bronze',   10, 'checkin',           1],
    ['checkin-10',            'Regular Viewer',          'Check in 10 times.',                            'sun',     'silver',   25, 'checkin',          10],
    ['checkin-50',            'Loyal Viewer',            'Check in 50 times.',                            'sun',     'gold',     50, 'checkin',          50],
    ['checkin-200',           'Pillar of the Community', 'Check in 200 times.',                           'sun',     'platinum',100, 'checkin',         200],
    ['first-boltbound-win',   'First Bolt',              'Win your first Boltbound match.',               'bolt',    'bronze',   10, 'boltbound-win',     1],
    ['boltbound-win-25',      'Storm Caller',            'Win 25 Boltbound matches.',                     'bolt',    'silver',   25, 'boltbound-win',    25],
    ['boltbound-win-100',     'Bolt Lord',               'Win 100 Boltbound matches.',                    'bolt',    'gold',     50, 'boltbound-win',   100],
    ['first-count',           'First Count',             'Count at least once in the counting channel.',  'abacus',  'bronze',   10, 'count',             1],
    ['bolts-counted-50',      'Tally Keeper',            'Count to 50 in the counting channel.',          'abacus',  'silver',   25, 'count',            50],
    ['bolts-counted-500',     'Master of Numbers',       'Count to 500 in the counting channel.',         'abacus',  'gold',     50, 'count',           500],
    ['first-spire-clear',     'Spire Climber',           'Clear the Boltbound Spire once.',               'tower',   'silver',   25, 'spire-clear',       1],
    ['spire-boss-3',          'Spire Champion',          'Clear the Spire boss 3 times.',                 'crown',   'gold',     50, 'spire-clear',       3],
    ['first-clash-raid',      'First Raid',              'Run your first Clash raid.',                    'shield',  'bronze',   10, 'clash-raid',        1],
    ['clash-three-star',      'Three-Star Raider',       'Land a 3-star Clash raid.',                     'star',    'silver',   25, 'clash-three-star',  1],
    ['first-pet-tamed',       'First Friend',            'Tame your first pet.',                          'paw',     'bronze',   10, 'pet-tamed',         1],
  ];
  for (const r of rows) {
    db._defs.push({
      id: r[0], name: r[1], description: r[2], icon: r[3], tier: r[4], points: r[5],
      trigger_type: r[6], trigger_threshold: r[7], active: 1,
    });
  }
}

function makeEnv() {
  const DB = makeMockDB();
  seedDefs(DB);
  return { DB };
}

// ── Tests ─────────────────────────────────────────────────────────

console.log('— listAchievements returns seeded rows');
{
  const env = makeEnv();
  const all = await listAchievements(env);
  eq(all.length, 15, '15 seed rows surfaced');
  const ids = all.map(a => a.id);
  assert(ids.includes('first-checkin'), 'first-checkin present');
  assert(ids.includes('boltbound-win-100'), 'boltbound-win-100 present');
  assert(ids.includes('first-pet-tamed'), 'first-pet-tamed present');
  const def = all.find(a => a.id === 'checkin-10');
  eq(def.trigger.type, 'checkin', 'trigger.type populated');
  eq(def.trigger.threshold, 10, 'trigger.threshold populated');
  eq(def.tier, 'silver', 'tier populated');
}

console.log('— tryUnlock is idempotent');
{
  const env = makeEnv();
  const uid = 'user-A';
  const r1 = await tryUnlock(env, uid, 'first-checkin');
  assert(r1.newlyUnlocked, 'first call → newly unlocked');
  eq(r1.achievement.id, 'first-checkin', 'returned achievement matches');
  assert(typeof r1.achievement.unlockedAt === 'number', 'unlockedAt is a number');

  const r2 = await tryUnlock(env, uid, 'first-checkin');
  assert(!r2.newlyUnlocked, 'second call → not newly unlocked');
  eq(r2.achievement.id, 'first-checkin', 'still returns achievement payload');
  eq(env.DB._userAch.length, 1, 'only one row written to user_achievement');
}

console.log('— tryUnlock with unknown id is a soft no-op');
{
  const env = makeEnv();
  const r = await tryUnlock(env, 'user-B', 'no-such-thing');
  assert(!r.newlyUnlocked, 'unknown id → newlyUnlocked false');
  eq(r.achievement, null, 'unknown id → no payload');
}

console.log('— getUserAchievements returns unlocked rows newest first');
{
  const env = makeEnv();
  const uid = 'user-C';
  await tryUnlock(env, uid, 'first-checkin');
  // Force a later timestamp on the second unlock by advancing the clock.
  const origNow = Date.now;
  let t = Date.now() + 1000;
  Date.now = () => t;
  try { await tryUnlock(env, uid, 'first-boltbound-win'); }
  finally { Date.now = origNow; }

  const list = await getUserAchievements(env, uid);
  eq(list.length, 2, 'two unlocks visible');
  eq(list[0].id, 'first-boltbound-win', 'newest first (boltbound)');
  eq(list[1].id, 'first-checkin', 'older second (checkin)');
}

console.log('— checkAndUnlock: one-shot trigger fires on matching type');
{
  const env = makeEnv();
  const fired = await checkAndUnlock(env, 'user-D', { type: 'pet-tamed' });
  eq(fired.length, 1, 'one achievement fires');
  eq(fired[0].id, 'first-pet-tamed', 'first-pet-tamed unlocked');
  // Second call is idempotent — no double-fire.
  const fired2 = await checkAndUnlock(env, 'user-D', { type: 'pet-tamed' });
  eq(fired2.length, 0, 'second matching event → 0 new unlocks');
}

console.log('— checkAndUnlock: cumulative trigger respects threshold');
{
  const env = makeEnv();
  const uid = 'user-E';
  // count=1 → only the one-shot 'first-checkin' fires
  const a = await checkAndUnlock(env, uid, { type: 'checkin', count: 1 });
  const aIds = a.map(x => x.id).sort();
  assert(aIds.includes('first-checkin'), 'first-checkin fires at count=1');
  assert(!aIds.includes('checkin-10'), 'checkin-10 does NOT fire at count=1');

  // count=10 → checkin-10 satisfies its threshold and fires
  const b = await checkAndUnlock(env, uid, { type: 'checkin', count: 10 });
  const bIds = b.map(x => x.id);
  assert(bIds.includes('checkin-10'), 'checkin-10 fires at count=10');
  assert(!bIds.includes('first-checkin'), 'first-checkin not re-fired (already owned)');

  // count=50 → checkin-50 fires; checkin-200 still gated
  const c = await checkAndUnlock(env, uid, { type: 'checkin', count: 50 });
  const cIds = c.map(x => x.id);
  assert(cIds.includes('checkin-50'), 'checkin-50 fires at count=50');
  assert(!cIds.includes('checkin-200'), 'checkin-200 not fired at count=50');
}

console.log('— checkAndUnlock: value-based trigger fallback when count absent');
{
  const env = makeEnv();
  const uid = 'user-F';
  // value bridge: pass `value` instead of `count` for sum-style events
  const a = await checkAndUnlock(env, uid, { type: 'count', value: 50 });
  const aIds = a.map(x => x.id);
  assert(aIds.includes('first-count'), 'first-count fires on any value');
  assert(aIds.includes('bolts-counted-50'), 'bolts-counted-50 fires on value=50');
  assert(!aIds.includes('bolts-counted-500'), 'bolts-counted-500 gated');
}

console.log('— checkAndUnlock: unknown event type returns []');
{
  const env = makeEnv();
  const r = await checkAndUnlock(env, 'user-G', { type: 'does-not-exist' });
  eq(r.length, 0, 'no defs match → empty array');
}

console.log('— checkAndUnlock: missing user/event returns []');
{
  const env = makeEnv();
  eq((await checkAndUnlock(env, null, { type: 'checkin', count: 1 })).length, 0, 'null userId → []');
  eq((await checkAndUnlock(env, 'user-H', null)).length, 0, 'null event → []');
  eq((await checkAndUnlock(env, 'user-H', {})).length, 0, 'missing event.type → []');
}

console.log('');
console.log(`PASSED — ${pass} ok / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
