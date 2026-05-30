// Unit tests for twitch-drops — state init, tick accrual + milestone
// crossing, claim flow (success + already-claimed), locked-claim
// gate, and HMAC route shape.
//
// Run from discord-bot/:
//   node test/test-twitch-drops.mjs

import {
  MILESTONES,
  getDropsState,
  watchTimeTickCron,
  claimDropMilestone,
  handleDropsRoute,
  __internals,
} from '../twitch-drops.js';

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  ok ', m); } else { fail++; console.log('  FAIL', m); } }
function eq(a, b, m)  { if (a === b) { pass++; console.log('  ok ', m); } else { fail++; console.log('  FAIL', m, '(want:', JSON.stringify(b), 'got:', JSON.stringify(a), ')'); } }
function deepEq(a, b, m) {
  if (JSON.stringify(a) === JSON.stringify(b)) { pass++; console.log('  ok ', m); }
  else { fail++; console.log('  FAIL', m, '(want:', JSON.stringify(b), 'got:', JSON.stringify(a), ')'); }
}

// ── Mock KV ───────────────────────────────────────────────────────
//
// Supports get(key, {type:'json'|'text'}), put(key, val), and
// list({prefix, limit, cursor}). The list mock returns ALL matching
// keys in one page (list_complete:true) so we don't have to simulate
// pagination in the test.

function makeMockKv(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    async get(key, opts) {
      const v = store.get(key);
      if (v === undefined || v === null) return null;
      if (opts?.type === 'json') {
        try { return typeof v === 'string' ? JSON.parse(v) : v; }
        catch { return null; }
      }
      return v;
    },
    async put(key, val) { store.set(key, val); },
    async delete(key) { store.delete(key); },
    async list({ prefix = '', limit = 1000, cursor } = {}) {
      const keys = [];
      for (const k of store.keys()) {
        if (k.startsWith(prefix)) keys.push({ name: k });
        if (keys.length >= limit) break;
      }
      return { keys, list_complete: true, cursor: null };
    },
    _store: store,
  };
}

// Stream-bonus.isStreamLive reads twitch:live:state:<broadcasterId>.
// Setting the broadcaster env + that KV record makes isStreamLive
// return live:true.

function liveEnv(kv, extra = {}) {
  return {
    TWITCH_BROADCASTER_USER_ID: 'bid-1',
    AQUILO_VAULT_GUILD_ID: 'g1',
    LOADOUT_BOLTS: kv,
    ...extra,
  };
}

async function setLive(kv, viewerCount = 0) {
  await kv.put('twitch:live:state:bid-1', JSON.stringify({
    viewerCount, startedUtc: Date.now(),
  }));
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

function makeMockPacks() {
  const credits = [];
  return {
    credits,
    async creditPack(env, gid, uid, packType, source) {
      credits.push({ gid, uid, packType, source });
      return { ok: true, pack: { id: 'pk-' + credits.length, packType } };
    },
  };
}

// Helper — seed N twitch links so listLinkedAquiloIds returns N
// aquilo user IDs.
async function seedLinks(kv, pairs /* [[twitchId, aquiloId], ...] */) {
  for (const [tid, aid] of pairs) {
    await kv.put(`plink:twitch:${tid}`, aid);
  }
}

// ── Tests ─────────────────────────────────────────────────────────

console.log('-- MILESTONES shape');
{
  eq(MILESTONES.length, 4, 'four milestones');
  eq(MILESTONES[0].minutes, 15, '15-min first');
  eq(MILESTONES[3].minutes, 120, '120-min last');
  eq(MILESTONES[0].reward.bolts, 50, '15-min reward = 50 bolts');
  eq(MILESTONES[1].reward.packId, 'pack-bronze', '30-min reward = pack-bronze');
  eq(MILESTONES[3].reward.packId, 'pack-gold', '120-min reward = pack-gold');
  // Frozen — mutation should throw in strict mode (ES modules are strict).
  let threw = false;
  try { MILESTONES.push({ minutes: 999 }); } catch { threw = true; }
  assert(threw, 'MILESTONES is frozen');
}

console.log('-- newlyCrossedMilestones detection');
{
  const c1 = __internals.newlyCrossedMilestones(0, 10);
  deepEq(c1, [], 'no crossings under 15');
  const c2 = __internals.newlyCrossedMilestones(10, 16);
  deepEq(c2, [15], '10 to 16 crosses 15');
  const c3 = __internals.newlyCrossedMilestones(0, 130);
  deepEq(c3, [15, 30, 60, 120], '0 to 130 crosses all four');
  const c4 = __internals.newlyCrossedMilestones(60, 65);
  deepEq(c4, [], '60 to 65 — no new milestone');
}

console.log('-- getDropsState init for new user');
{
  const kv = makeMockKv();
  const env = liveEnv(kv);
  const s = await getDropsState(env, 'aq-new');
  eq(s.watchMinutes, 0, 'fresh watchMinutes = 0');
  deepEq(s.milestonesUnlocked, [], 'no unlocked');
  deepEq(s.milestonesClaimed, [], 'no claimed');
}

console.log('-- getDropsState normalizes legacy / corrupt KV record');
{
  const kv = makeMockKv();
  await kv.put('twitch-drops:aq-corrupt', JSON.stringify({
    watchMinutes: '42',
    unlocked: ['15', 'not-a-number', 30],
    claimed: null,
  }));
  const env = liveEnv(kv);
  const s = await getDropsState(env, 'aq-corrupt');
  eq(s.watchMinutes, 42, 'string watchMinutes coerced');
  deepEq(s.milestonesUnlocked, [15, 30], 'NaN filtered, sorted');
  deepEq(s.milestonesClaimed, [], 'null claimed defaulted');
}

console.log('-- watchTimeTickCron no-ops when not live');
{
  const kv = makeMockKv();
  const env = liveEnv(kv);
  await seedLinks(kv, [['t-1', 'aq-1']]);
  const r = await watchTimeTickCron(env);
  eq(r.skipped, 'not-live', 'skipped not-live when no live KV');
}

console.log('-- watchTimeTickCron credits all linked viewers');
{
  const kv = makeMockKv();
  const env = liveEnv(kv);
  await setLive(kv, 100);
  await seedLinks(kv, [
    ['t-1', 'aq-1'],
    ['t-2', 'aq-2'],
    ['t-3', 'aq-3'],
  ]);
  const r = await watchTimeTickCron(env);
  eq(r.ok, true, 'tick ok');
  eq(r.walkedUsers, 3, 'walked 3 linked viewers');
  eq(r.credited, 15, '3 viewers x 5 minutes = 15 total minutes');
  const s1 = await getDropsState(env, 'aq-1');
  eq(s1.watchMinutes, 5, 'aq-1 got 5 min');
}

console.log('-- watchTimeTickCron crosses 15-min milestone, marks unlocked');
{
  const kv = makeMockKv();
  const env = liveEnv(kv);
  await setLive(kv);
  await seedLinks(kv, [['t-1', 'aq-1']]);

  // Tick 3 times (5+5+5=15) — third tick should cross the 15-min milestone.
  // Each tick uses a different nowMs so dedup doesn't bite.
  const t0 = Date.UTC(2026, 5, 1, 12, 0);
  await watchTimeTickCron(env, { nowMs: t0 });
  await watchTimeTickCron(env, { nowMs: t0 + 5*60_000 });
  const r3 = await watchTimeTickCron(env, { nowMs: t0 + 10*60_000 });
  eq(r3.crossings, 1, 'third tick records 1 crossing');
  const s = await getDropsState(env, 'aq-1');
  eq(s.watchMinutes, 15, 'cumulative = 15');
  deepEq(s.milestonesUnlocked, [15], '15-min unlocked');
  deepEq(s.milestonesClaimed, [], 'not yet claimed');
}

console.log('-- watchTimeTickCron is dedup-safe within window');
{
  const kv = makeMockKv();
  const env = liveEnv(kv);
  await setLive(kv);
  await seedLinks(kv, [['t-1', 'aq-1']]);
  const t0 = Date.UTC(2026, 5, 1, 12, 0);
  await watchTimeTickCron(env, { nowMs: t0 });
  // Re-fire immediately (cron retry) — should NOT double-credit.
  const r2 = await watchTimeTickCron(env, { nowMs: t0 + 1000 });
  eq(r2.skippedDedup, 1, 'second back-to-back tick skipped per-user');
  const s = await getDropsState(env, 'aq-1');
  eq(s.watchMinutes, 5, 'still 5 min (not 10) — dedup held');
}

console.log('-- claimDropMilestone success grants bolts');
{
  const kv = makeMockKv();
  const env = liveEnv(kv);
  await setLive(kv);
  await seedLinks(kv, [['t-1', 'aq-1']]);
  // Push to 20 minutes (crosses 15).
  await watchTimeTickCron(env, { nowMs: 1_000_000 });
  await watchTimeTickCron(env, { nowMs: 1_000_000 + 5*60_000 });
  await watchTimeTickCron(env, { nowMs: 1_000_000 + 10*60_000 });
  await watchTimeTickCron(env, { nowMs: 1_000_000 + 15*60_000 });
  const s0 = await getDropsState(env, 'aq-1');
  assert(s0.watchMinutes >= 15, 'pre-claim watch >= 15');

  const wallet = makeMockWallet();
  const claim = await claimDropMilestone(env, 'aq-1', 15,
    { guildId: 'g1', walletModule: wallet });
  eq(claim.ok, true, 'claim 15 → ok:true');
  eq(claim.milestone, 15, 'milestone = 15');
  eq(claim.granted.bolts, 50, 'granted 50 bolts');
  eq(wallet.grants.length, 1, 'wallet.earn called once');
  eq(wallet.grants[0].amount, 50, 'wallet got 50 bolts');
  eq(wallet.grants[0].reason, 'twitch-drops:15m', 'wallet reason tagged');

  const s1 = await getDropsState(env, 'aq-1');
  deepEq(s1.milestonesUnlocked, [], 'unlocked drained after claim');
  deepEq(s1.milestonesClaimed, [15], 'claimed records 15');
}

console.log('-- claimDropMilestone success grants pack via creditPack');
{
  const kv = makeMockKv();
  const env = liveEnv(kv);
  // Seed the user already past 30 min by writing the state directly.
  await kv.put('twitch-drops:aq-2', JSON.stringify({
    watchMinutes: 35, unlocked: [15, 30], claimed: [], lastTickUtc: 0,
  }));
  const packs = makeMockPacks();
  const wallet = makeMockWallet();
  const claim = await claimDropMilestone(env, 'aq-2', 30,
    { guildId: 'g1', walletModule: wallet, packsModule: packs });
  eq(claim.ok, true, 'claim 30 → ok:true');
  eq(claim.granted.packId, 'pack-bronze', 'granted carries packId');
  eq(packs.credits.length, 1, 'creditPack called once');
  eq(packs.credits[0].packType, 'common', 'pack-bronze mapped to common');
  eq(packs.credits[0].source, 'twitch-drops:30m', 'pack source tagged');
  eq(wallet.grants.length, 0, '30-min reward has no bolts → wallet untouched');
}

console.log('-- claim already-claimed → ok:false');
{
  const kv = makeMockKv();
  const env = liveEnv(kv);
  await kv.put('twitch-drops:aq-3', JSON.stringify({
    watchMinutes: 20, unlocked: [], claimed: [15], lastTickUtc: 0,
  }));
  const wallet = makeMockWallet();
  const r = await claimDropMilestone(env, 'aq-3', 15,
    { guildId: 'g1', walletModule: wallet });
  eq(r.ok, false, 'already-claimed → ok:false');
  eq(r.reason, 'already-claimed', 'reason = already-claimed');
  eq(wallet.grants.length, 0, 'no wallet grant on double-claim');
}

console.log('-- claim locked milestone (under threshold) → ok:false');
{
  const kv = makeMockKv();
  const env = liveEnv(kv);
  await kv.put('twitch-drops:aq-4', JSON.stringify({
    watchMinutes: 10, unlocked: [], claimed: [], lastTickUtc: 0,
  }));
  const r = await claimDropMilestone(env, 'aq-4', 15, { guildId: 'g1' });
  eq(r.ok, false, 'locked → ok:false');
  eq(r.reason, 'locked', 'reason = locked');
}

console.log('-- claim unknown milestone → ok:false');
{
  const kv = makeMockKv();
  const env = liveEnv(kv);
  const r = await claimDropMilestone(env, 'aq-x', 999);
  eq(r.ok, false, 'unknown minutes → ok:false');
  eq(r.reason, 'unknown-milestone', 'reason = unknown-milestone');
  const r2 = await claimDropMilestone(env, '', 15);
  eq(r2.ok, false, 'missing userId → ok:false');
  eq(r2.reason, 'bad-args', 'reason = bad-args');
}

console.log('-- handleDropsRoute GET /me returns state + ladder');
{
  const kv = makeMockKv();
  const env = liveEnv(kv);
  await kv.put('twitch-drops:aq-r', JSON.stringify({
    watchMinutes: 22, unlocked: [15], claimed: [], lastTickUtc: 0,
  }));
  const req = new Request('https://w.dev/web/twitch-drops/me?userId=aq-r', { method: 'GET' });
  const res = await handleDropsRoute(req, env, '/web/twitch-drops/me');
  eq(res.status, 200, 'GET /me → 200');
  const body = await res.json();
  eq(body.userId, 'aq-r', 'userId echoed');
  eq(body.watchMinutes, 22, 'watch returned');
  deepEq(body.milestonesUnlocked, [15], 'unlocked returned');
  assert(Array.isArray(body.milestones) && body.milestones.length === 4,
         'ladder returned (4 tiers)');
}

console.log('-- handleDropsRoute GET /me requires userId');
{
  const kv = makeMockKv();
  const env = liveEnv(kv);
  const req = new Request('https://w.dev/web/twitch-drops/me', { method: 'GET' });
  const res = await handleDropsRoute(req, env, '/web/twitch-drops/me');
  eq(res.status, 400, 'no userId → 400');
}

console.log('-- handleDropsRoute POST /claim requires HMAC');
{
  const kv = makeMockKv();
  const env = liveEnv(kv);  // no AQUILO_SITE_WEB_SECRET
  const req = new Request('https://w.dev/web/twitch-drops/claim', {
    method: 'POST', body: JSON.stringify({ userId: 'x', minutes: 15 }),
  });
  const res = await handleDropsRoute(req, env, '/web/twitch-drops/claim');
  eq(res.status, 503, 'missing site-web-secret → 503');
}

console.log('-- handleDropsRoute unknown path → 404');
{
  const kv = makeMockKv();
  const env = liveEnv(kv);
  const req = new Request('https://w.dev/web/twitch-drops/nope', { method: 'GET' });
  const res = await handleDropsRoute(req, env, '/web/twitch-drops/nope');
  eq(res.status, 404, 'unknown path → 404');
}

console.log('');
console.log(`PASSED — ${pass} ok / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
