// community-checkin streak rollover harness.
//
// Diagnosis (May 2026): Clay reported the PWA showing streak=0 the
// day after a check-in. Root cause was the broken checkin-hub
// button (imported a removed export, crashed → no state ever
// written). The button is fixed in this batch; this test exists to
// pin down that the underlying recordCheckin streak math is correct
// — if Clay sees streak=0 AFTER the button fix lands and he checks
// in successfully, that's a different bug than what's covered here.
//
// Coverage:
//   • fresh user — first check-in → streak = 1
//   • same-day duplicate → alreadyToday, no streak bump
//   • next-day check-in (delta=1) → streak rolls from 1 → 2
//   • two-day gap (delta=2) without freeze → streak resets to 1
//   • two-day gap (delta=2) with freeze → streak preserved + 1
//
// Run from repo root:
//   node discord-bot/test/test-checkin-streak.mjs

import { recordCheckin, getStatus, todayET } from '../community-checkin.js';

let failures = 0;
function assert(cond, label) {
  if (cond) console.log('  ✅ ' + label);
  else { failures++; console.log('  ❌ ' + label); }
}
function eq(a, b, label) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) console.log('    expected', JSON.stringify(b), '\n    got     ', JSON.stringify(a));
  assert(ok, label);
}

function makeKv() {
  const store = new Map();
  return {
    async put(key, value)     { store.set(key, value); },
    async get(key, opts) {
      const v = store.get(key);
      if (v === undefined) return null;
      if (opts && opts.type === 'json') { try { return JSON.parse(v); } catch { return null; } }
      return v;
    },
    async delete(key)         { store.delete(key); },
    async list({ prefix = '' } = {}) {
      const keys = [];
      for (const k of store.keys()) if (k.startsWith(prefix)) keys.push({ name: k });
      return { keys, list_complete: true };
    },
    _store: store,
  };
}

// Minimal env stub: only LOADOUT_BOLTS is required for the streak
// math itself. postCheckinEmbed will skip when getCheckinChannel
// returns null (no checkin-channel KV record), so the test focuses
// on the streak math.
function makeEnv() {
  return { LOADOUT_BOLTS: makeKv() };
}

// Helper: ET-day shift. Returns a YYYY-MM-DD string for `delta`
// days ago relative to today-ET.
function etDaysAgo(delta) {
  const d = new Date(Date.now() - delta * 86_400_000);
  return todayET(d);
}

const GUILD = '1504103035951906883';
const USER  = '209640265063006208';

console.log('— fresh user → streak = 1');
{
  const env = makeEnv();
  const r = await recordCheckin(env, GUILD, USER, 'test');
  assert(r.ok, 'ok');
  eq(r.alreadyToday, false, 'not already-today');
  eq(r.streak, 1, 'streak=1');
  eq(r.longest, 1, 'longest=1');
  // KV state persisted.
  const st = await env.LOADOUT_BOLTS.get(`community-checkin:${GUILD}:${USER}`, { type: 'json' });
  eq(st.streak, 1, 'state.streak=1');
  eq(st.lastDayEt, todayET(), 'state.lastDayEt = today');
  // getStatus returns it.
  const s = await getStatus(env, GUILD, USER);
  eq(s.streak, 1, 'getStatus.streak = 1');
  eq(s.checkedInToday, true, 'getStatus.checkedInToday');
}

console.log('— same-day duplicate → idempotent, no bump');
{
  const env = makeEnv();
  await recordCheckin(env, GUILD, USER, 'test');
  const r = await recordCheckin(env, GUILD, USER, 'test');
  eq(r.alreadyToday, true, 'alreadyToday');
  eq(r.streak, 1, 'streak unchanged');
  const st = await env.LOADOUT_BOLTS.get(`community-checkin:${GUILD}:${USER}`, { type: 'json' });
  eq(st.streak, 1, 'state.streak unchanged');
  eq(st.total, 1, 'total unchanged');
}

console.log('— next-day check-in → streak rolls 1 → 2');
{
  const env = makeEnv();
  // Seed yesterday's state directly (simulating the situation
  // Clay reports — checked in yesterday, PWA reads today).
  await env.LOADOUT_BOLTS.put(`community-checkin:${GUILD}:${USER}`, JSON.stringify({
    streak: 1, longest: 1, lastDayEt: etDaysAgo(1), total: 1, lastUtc: Date.now() - 86_400_000,
    lastSurface: 'test',
  }));
  // Critically — getStatus called BEFORE recording today's check-in
  // should already return streak=1 (the saved value). If Clay's PWA
  // shows 0 here, it's a site-side bug, not the worker's.
  const beforeToday = await getStatus(env, GUILD, USER);
  eq(beforeToday.streak, 1, 'getStatus pre-check-in returns yesterday\'s streak');
  eq(beforeToday.checkedInToday, false, 'pre-check-in: not yet checked in today');

  // Now today's check-in rolls 1 → 2.
  const r = await recordCheckin(env, GUILD, USER, 'test');
  eq(r.streak, 2, 'streak=2 after today\'s check-in');
  eq(r.longest, 2, 'longest=2');
  // After check-in, status reflects new streak.
  const after = await getStatus(env, GUILD, USER);
  eq(after.streak, 2, 'getStatus.streak = 2');
  eq(after.checkedInToday, true, 'checkedInToday true');
}

console.log('— two-day gap (no freeze) → streak resets to 1');
{
  const env = makeEnv();
  await env.LOADOUT_BOLTS.put(`community-checkin:${GUILD}:${USER}`, JSON.stringify({
    streak: 7, longest: 7, lastDayEt: etDaysAgo(3), total: 7, lastUtc: Date.now() - 3 * 86_400_000,
    lastSurface: 'test',
  }));
  const r = await recordCheckin(env, GUILD, USER, 'test');
  eq(r.streak, 1, 'reset to 1 after 3-day gap');
  eq(r.freezeUsed, false, 'no freeze used');
  eq(r.longest, 7, 'longest preserved');
}

console.log('— two-day gap WITH freeze → streak preserved + 1');
{
  const env = makeEnv();
  await env.LOADOUT_BOLTS.put(`community-checkin:${GUILD}:${USER}`, JSON.stringify({
    streak: 7, longest: 7, lastDayEt: etDaysAgo(3), total: 7, lastUtc: Date.now() - 3 * 86_400_000,
    lastSurface: 'test',
  }));
  // Seed a discord-type freeze on the user (streak-freeze module).
  await env.LOADOUT_BOLTS.put(`freeze:${GUILD}:${USER}`, JSON.stringify({
    stream: 0, discord: 1, lifetimeBought: 1, lastBoughtUtc: 0,
  }));
  const r = await recordCheckin(env, GUILD, USER, 'test');
  eq(r.streak, 8, 'protected: streak rolls 7 → 8 via freeze');
  eq(r.freezeUsed, true, 'freezeUsed=true');
  // Freeze consumed.
  const fz = await env.LOADOUT_BOLTS.get(`freeze:${GUILD}:${USER}`, { type: 'json' });
  eq(fz?.discord, 0, 'discord freeze count decremented');
}

console.log('');
if (failures > 0) {
  console.log('FAILED — ' + failures + ' assertion(s) failed');
  process.exit(1);
}
console.log('PASSED — all assertions ok');
