// Unit tests for anniversary.js — the join-anniversary celebrations
// backend (premium feature #4). Covers firstSeen min-wins tracking,
// the backfill proxy, the UTC-calendar anniversary math, and the
// idempotent reward claim.
//
// Run with:   node test/test-anniversary.mjs

import {
  recordFirstSeen,
  getFirstSeen,
  backfillFirstSeen,
  isMilestoneYear,
  anniversaryReward,
  computeAnniversary,
  checkAnniversary,
  celebrateAnniversary,
} from '../anniversary.js';

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } }
function eq(a, b, m)  { if (a === b) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m, '(want:', b, 'got:', a, ')'); } }

// ── In-memory KV mock (LOADOUT_BOLTS surface) ─────────────────────
function makeKV() {
  const store = new Map();
  return {
    _store: store,
    async get(key, opts) {
      if (!store.has(key)) return null;
      const v = store.get(key);
      if (opts && opts.type === 'json') {
        try { return JSON.parse(v); } catch { return null; }
      }
      return v;
    },
    async put(key, value) { store.set(key, String(value)); },
    async delete(key) { store.delete(key); },
    async list({ prefix, cursor, limit } = {}) {
      const keys = [...store.keys()]
        .filter(k => !prefix || k.startsWith(prefix))
        .sort();
      const start = cursor ? Number(cursor) : 0;
      const lim = limit || 1000;
      const slice = keys.slice(start, start + lim);
      const next = start + lim;
      const complete = next >= keys.length;
      return {
        keys: slice.map(name => ({ name })),
        list_complete: complete,
        cursor: complete ? undefined : String(next),
      };
    },
  };
}

function makeEnv(extra = {}) {
  return { LOADOUT_BOLTS: makeKV(), AQUILO_VAULT_GUILD_ID: 'g1', ...extra };
}

const G = 'g1', U = 'user-1';
// A fixed reference "now": 2026-05-30 (UTC).
const NOW_2026_05_30 = Date.UTC(2026, 4, 30, 12, 0, 0);

// ── firstSeen tracking ────────────────────────────────────────────

console.log('— recordFirstSeen is min-wins + idempotent');
{
  const env = makeEnv();
  const t2024 = Date.UTC(2024, 0, 15);
  const t2025 = Date.UTC(2025, 0, 15);

  const r1 = await recordFirstSeen(env, G, U, t2025);
  assert(r1.changed, 'first stamp writes');
  eq(await getFirstSeen(env, G, U), t2025, 'stored 2025');

  // Later timestamp does NOT override.
  const r2 = await recordFirstSeen(env, G, U, NOW_2026_05_30);
  assert(!r2.changed, 'later timestamp is a no-op');
  eq(await getFirstSeen(env, G, U), t2025, 'still 2025');

  // Earlier timestamp DOES override (min-wins).
  const r3 = await recordFirstSeen(env, G, U, t2024);
  assert(r3.changed, 'earlier timestamp overrides');
  eq(await getFirstSeen(env, G, U), t2024, 'now 2024');
}

console.log('— getFirstSeen returns null when absent / bad args');
{
  const env = makeEnv();
  eq(await getFirstSeen(env, G, 'nobody'), null, 'absent → null');
  eq(await getFirstSeen(env, null, U), null, 'no guild → null');
}

// ── backfill ──────────────────────────────────────────────────────

console.log('— backfillFirstSeen uses earliest wallet activity, skips stamped');
{
  const env = makeEnv();
  const kv = env.LOADOUT_BOLTS;
  // Two wallets: one with timestamps, one bare.
  await kv.put(`wallet:${G}:wA`, JSON.stringify({
    balance: 5, lastEarnUtc: Date.UTC(2025, 5, 1), lastDailyUtc: Date.UTC(2025, 3, 1),
  }));
  await kv.put(`wallet:${G}:wB`, JSON.stringify({ balance: 0 }));
  // wC already has a firstSeen — must be skipped.
  await kv.put(`wallet:${G}:wC`, JSON.stringify({ balance: 1, lastEarnUtc: Date.UTC(2025, 0, 1) }));
  await kv.put(`anniv:seen:${G}:wC`, String(Date.UTC(2020, 0, 1)));

  const r = await backfillFirstSeen(env, G, { nowUtc: NOW_2026_05_30 });
  assert(r.ok, 'backfill ok');
  eq(r.stamped, 2, 'stamped wA + wB');
  eq(r.skipped, 1, 'skipped wC');
  // wA → min(lastEarn 2025-06, lastDaily 2025-04) = 2025-04
  eq(await getFirstSeen(env, G, 'wA'), Date.UTC(2025, 3, 1), 'wA → earliest activity (Apr)');
  // wB → no timestamps → nowUtc
  eq(await getFirstSeen(env, G, 'wB'), NOW_2026_05_30, 'wB → now fallback');
  // wC untouched (earlier 2020 stamp preserved)
  eq(await getFirstSeen(env, G, 'wC'), Date.UTC(2020, 0, 1), 'wC preserved');
}

// ── anniversary math ──────────────────────────────────────────────

console.log('— isMilestoneYear: 1 + multiples of 5');
{
  assert(isMilestoneYear(1), 'year 1 is milestone');
  assert(isMilestoneYear(5), 'year 5 is milestone');
  assert(isMilestoneYear(10), 'year 10 is milestone');
  assert(!isMilestoneYear(2), 'year 2 is not');
  assert(!isMilestoneYear(7), 'year 7 is not');
}

console.log('— anniversaryReward scales + doubles on milestone + caps');
{
  eq(anniversaryReward(1).bolts, 200, 'y1: 100 base ×2 milestone = 200');
  eq(anniversaryReward(2).bolts, 200, 'y2: 200 base, no milestone');
  eq(anniversaryReward(3).bolts, 300, 'y3: 300');
  eq(anniversaryReward(5).bolts, 1000, 'y5: 500 base ×2 = 1000');
  eq(anniversaryReward(20).bolts, 2000, 'y20: capped base 1000 ×2 = 2000');
  eq(anniversaryReward(2).badgeId, 'anniversary-y2', 'badge id stable per year');
}

console.log('— computeAnniversary: anniversary today');
{
  // Joined exactly 2 years ago today (2024-05-30).
  const first = Date.UTC(2024, 4, 30);
  const a = computeAnniversary(first, NOW_2026_05_30);
  eq(a.years, 2, '2 years today');
  eq(a.daysUntil, 0, 'daysUntil 0');
  assert(a.anniversaryToday, 'anniversaryToday true');
  assert(!a.milestone, 'year 2 not milestone');
}

console.log('— computeAnniversary: upcoming anniversary later this year');
{
  // Joined 2024-08-15 → next anniversary 2026-08-15, ~77 days out.
  const first = Date.UTC(2024, 7, 15);
  const a = computeAnniversary(first, NOW_2026_05_30);
  eq(a.years, 2, 'upcoming is the 2-year mark');
  assert(a.daysUntil > 0, 'daysUntil positive');
  assert(!a.anniversaryToday, 'not today');
}

console.log('— computeAnniversary: anniversary already passed → next year');
{
  // Joined 2023-01-10 → 2026-01-10 already passed → next is 2027-01-10 (4yr).
  const first = Date.UTC(2023, 0, 10);
  const a = computeAnniversary(first, NOW_2026_05_30);
  eq(a.years, 4, 'next anniversary is the 4-year mark');
  assert(a.daysUntil > 0, 'daysUntil positive');
}

console.log('— computeAnniversary: brand-new user (joined today) → no year-0');
{
  const a = computeAnniversary(NOW_2026_05_30, NOW_2026_05_30 + 1000);
  eq(a.years, 1, 'first anniversary is year 1');
  assert(!a.anniversaryToday, 'not today for a brand-new user');
  assert(a.daysUntil > 300, 'roughly a year out');
}

console.log('— computeAnniversary: invalid input → null');
{
  eq(computeAnniversary(0, NOW_2026_05_30), null, 'zero → null');
  eq(computeAnniversary(NaN, NOW_2026_05_30), null, 'NaN → null');
}

// ── checkAnniversary ──────────────────────────────────────────────

console.log('— checkAnniversary: null when no firstSeen');
{
  const env = makeEnv();
  const r = await checkAnniversary(env, G, 'ghost', { nowUtc: NOW_2026_05_30 });
  assert(r.ok, 'ok');
  eq(r.anniversary, null, 'anniversary null');
}

console.log('— checkAnniversary: surfaces reward + claimed flag');
{
  const env = makeEnv();
  await recordFirstSeen(env, G, U, Date.UTC(2024, 4, 30));   // 2 yrs ago today
  const r = await checkAnniversary(env, G, U, { nowUtc: NOW_2026_05_30 });
  eq(r.anniversary.years, 2, 'years 2');
  assert(r.anniversary.anniversaryToday, 'today');
  assert(!r.anniversary.claimed, 'not yet claimed');
  eq(r.anniversary.reward.bolts, 200, 'reward 200 bolts');
}

// ── celebrateAnniversary ──────────────────────────────────────────

console.log('— celebrateAnniversary: not today → no grant');
{
  const env = makeEnv();
  await recordFirstSeen(env, G, U, Date.UTC(2024, 7, 15));   // Aug, not today
  const r = await celebrateAnniversary(env, G, U, { nowUtc: NOW_2026_05_30 });
  assert(r.ok, 'ok');
  assert(!r.granted, 'not granted');
  eq(r.reason, 'not-today', 'reason not-today');
}

console.log('— celebrateAnniversary: grants once, idempotent second call');
{
  const env = makeEnv();
  await recordFirstSeen(env, G, U, Date.UTC(2024, 4, 30));   // 2 yrs ago today
  const r1 = await celebrateAnniversary(env, G, U, { nowUtc: NOW_2026_05_30 });
  assert(r1.granted, 'first claim grants');
  eq(r1.years, 2, 'year 2');
  eq(r1.reward.bolts, 200, '200 bolts');
  assert(r1.reward.badgeGranted, 'badge granted');

  // Wallet credited.
  const w = await env.LOADOUT_BOLTS.get(`wallet:${G}:${U}`, { type: 'json' });
  eq(w.balance, 200, 'wallet balance = 200');
  // Badge in pbadge store.
  const pb = await env.LOADOUT_BOLTS.get(`pbadge:${U}`, { type: 'json' });
  assert(pb.owned.includes('anniversary-y2'), 'pbadge has anniversary-y2');

  // Second call is a no-op.
  const r2 = await celebrateAnniversary(env, G, U, { nowUtc: NOW_2026_05_30 });
  assert(!r2.granted, 'second claim does not grant');
  eq(r2.reason, 'already-claimed', 'reason already-claimed');
  const w2 = await env.LOADOUT_BOLTS.get(`wallet:${G}:${U}`, { type: 'json' });
  eq(w2.balance, 200, 'wallet not double-credited');
}

console.log('— celebrateAnniversary: no firstSeen → error');
{
  const env = makeEnv();
  const r = await celebrateAnniversary(env, G, 'ghost', { nowUtc: NOW_2026_05_30 });
  assert(!r.ok, 'not ok');
  eq(r.error, 'no-first-seen', 'error no-first-seen');
}

console.log('');
console.log(`PASSED — ${pass} ok / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
