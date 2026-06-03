// Unit tests for aquilo-pass-d1.js, the D1 battle pass (30 tiers,
// free+premium). Covers seeding, XP→tier, state shape, claim
// eligibility (tier-gate, premium-lock, idempotency), and premium.
//
// Run with:   node test/test-aquilo-pass-d1.mjs

import {
  tierForXp,
  seedSeasonOne,
  getActiveSeason,
  getPassState,
  grantPassXp,
  setPremium,
  claimTier,
} from '../aquilo-pass-d1.js';

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } }
function eq(a, b, m)  { if (a === b) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m, '(want:', b, 'got:', a, ')'); } }

// ── In-memory D1 mock ─────────────────────────────────────────────
function makeMockDB() {
  const seasons = [], rewards = [], progress = [];
  function H(sql, args) {
    const S = sql.replace(/\s+/g, ' ').trim();
    return {
      async first() {
        if (/FROM aquilo_pass_season WHERE active = 1/i.test(S)) {
          return seasons.filter(s => s.active === 1).sort((a, b) => b.started_at - a.started_at)[0] || null;
        }
        if (/FROM aquilo_pass_season WHERE id = \?/i.test(S)) {
          return seasons.find(s => s.id === args[0]) || null;
        }
        if (/FROM user_pass_progress WHERE season_id = \? AND user_id = \?/i.test(S)) {
          return progress.find(p => p.season_id === args[0] && p.user_id === args[1]) || null;
        }
        if (/FROM aquilo_pass_reward WHERE season_id = \? AND tier = \? AND track = \?/i.test(S)) {
          return rewards.find(r => r.season_id === args[0] && r.tier === args[1] && r.track === args[2]) || null;
        }
        return null;
      },
      async all() {
        if (/FROM aquilo_pass_reward WHERE season_id = \? ORDER BY tier ASC/i.test(S)) {
          return { results: rewards.filter(r => r.season_id === args[0]).sort((a, b) => a.tier - b.tier) };
        }
        return { results: [] };
      },
      async run() {
        if (/^INSERT OR IGNORE INTO aquilo_pass_season/i.test(S)) {
          const [id, name, started, tiers] = args;
          if (!seasons.find(s => s.id === id)) seasons.push({ id, name, started_at: started, ends_at: null, tiers, active: 1 });
          return { meta: { changes: 1 } };
        }
        if (/^INSERT OR IGNORE INTO aquilo_pass_reward/i.test(S)) {
          const [season_id, tier, track, kind, payload] = args;
          if (!rewards.find(r => r.season_id === season_id && r.tier === tier && r.track === track)) {
            rewards.push({ season_id, tier, track, kind, payload });
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }
        if (/^INSERT OR IGNORE INTO user_pass_progress/i.test(S)) {
          const [season_id, user_id, ts] = args;
          if (!progress.find(p => p.season_id === season_id && p.user_id === user_id)) {
            progress.push({ season_id, user_id, xp: 0, tier: 0, premium: 0, claimed_free: '', claimed_premium: '', updated_at: ts });
          }
          return { meta: { changes: 1 } };
        }
        if (/^UPDATE user_pass_progress SET xp = \?/i.test(S)) {
          const [xp, tier, ts, season_id, user_id] = args;
          const p = progress.find(x => x.season_id === season_id && x.user_id === user_id);
          if (p) { p.xp = xp; p.tier = tier; p.updated_at = ts; }
          return { meta: { changes: p ? 1 : 0 } };
        }
        if (/^UPDATE user_pass_progress SET premium = \?/i.test(S)) {
          const [prem, ts, season_id, user_id] = args;
          const p = progress.find(x => x.season_id === season_id && x.user_id === user_id);
          if (p) { p.premium = prem; p.updated_at = ts; }
          return { meta: { changes: p ? 1 : 0 } };
        }
        if (/^UPDATE user_pass_progress SET claimed_premium = \?/i.test(S)) {
          const [csv, ts, season_id, user_id] = args;
          const p = progress.find(x => x.season_id === season_id && x.user_id === user_id);
          if (p) { p.claimed_premium = csv; p.updated_at = ts; }
          return { meta: { changes: p ? 1 : 0 } };
        }
        if (/^UPDATE user_pass_progress SET claimed_free = \?/i.test(S)) {
          const [csv, ts, season_id, user_id] = args;
          const p = progress.find(x => x.season_id === season_id && x.user_id === user_id);
          if (p) { p.claimed_free = csv; p.updated_at = ts; }
          return { meta: { changes: p ? 1 : 0 } };
        }
        return { meta: { changes: 0 } };
      },
    };
  }
  return { _seasons: seasons, _rewards: rewards, _progress: progress,
           prepare(sql) { return { bind: (...a) => H(sql, a), ...H(sql, []) }; } };
}

function makeKV() {
  const store = new Map();
  return {
    async get(k, opts) { if (!store.has(k)) return null; const v = store.get(k); return opts && opts.type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { store.set(k, String(v)); },
  };
}
function makeEnv() { return { DB: makeMockDB(), LOADOUT_BOLTS: makeKV() }; }
const U = 'u1', G = 'g1';

console.log('- tierForXp');
{
  eq(tierForXp(0), 0, '0 xp → tier 0');
  eq(tierForXp(99), 0, '99 xp → tier 0');
  eq(tierForXp(100), 1, '100 xp → tier 1');
  eq(tierForXp(550), 5, '550 xp → tier 5');
  eq(tierForXp(99999), 30, 'capped at 30');
}

console.log('- seedSeasonOne creates season + 60 rewards (idempotent)');
{
  const env = makeEnv();
  const r = await seedSeasonOne(env);
  assert(r.ok, 'seeded');
  eq(r.rewardsInserted, 60, '60 reward rows (30 tiers × 2 tracks)');
  const again = await seedSeasonOne(env);
  eq(again.rewardsInserted, 0, 're-seed inserts nothing');
  const s = await getActiveSeason(env);
  eq(s.id, 'season-1', 'active season is season-1');
}

console.log('- getPassState shape + claimability gating');
{
  const env = makeEnv();
  await seedSeasonOne(env);
  await grantPassXp(env, U, 250, 'test');   // tier 2
  const st = await getPassState(env, U);
  assert(st.ok, 'state ok');
  eq(st.progress.tier, 2, 'tier 2');
  eq(st.progress.xp, 250, 'xp 250');
  eq(st.tiers.length, 30, '30 tiers');
  const t1 = st.tiers.find(t => t.tier === 1);
  assert(t1.freeClaimable, 'tier1 free claimable at tier 2');
  assert(!t1.premiumClaimable, 'tier1 premium NOT claimable (no premium)');
  const t5 = st.tiers.find(t => t.tier === 5);
  assert(!t5.freeClaimable, 'tier5 not claimable at tier 2');
  eq(t5.free.kind, 'pack', 'tier5 free is a pack');
}

console.log('- claimTier: free track, tier-gate + idempotency');
{
  const env = makeEnv();
  await seedSeasonOne(env);
  await grantPassXp(env, U, 300, 'test');   // tier 3

  const tooHigh = await claimTier(env, G, U, 10, 'free');
  assert(!tooHigh.ok, 'tier 10 refused at tier 3');
  eq(tooHigh.error, 'tier-not-reached', 'tier-not-reached');

  const c = await claimTier(env, G, U, 2, 'free');
  assert(c.ok && c.reward, 'tier 2 free claimed');
  eq(c.reward.kind, 'bolts', 'reward kind bolts');

  const again = await claimTier(env, G, U, 2, 'free');
  assert(again.ok && again.alreadyClaimed, 'second claim idempotent');

  const st = await getPassState(env, U);
  assert(st.tiers.find(t => t.tier === 2).freeClaimed, 'tier2 free marked claimed');
}

console.log('- claimTier: premium locked until owned');
{
  const env = makeEnv();
  await seedSeasonOne(env);
  await grantPassXp(env, U, 1200, 'test');  // tier 12

  const locked = await claimTier(env, G, U, 10, 'premium');
  assert(!locked.ok, 'premium claim refused without premium');
  eq(locked.error, 'premium-locked', 'premium-locked');

  await setPremium(env, U, true);
  const c = await claimTier(env, G, U, 10, 'premium');
  assert(c.ok, 'premium claim ok after unlock');
  eq(c.reward.kind, 'cosmetic', 'tier10 premium is cosmetic');
  // cosmetic landed in pbadge
  const pb = await env.LOADOUT_BOLTS.get(`pbadge:${U}`, { type: 'json' });
  assert(pb.owned.includes('pass-s1-emote-spark'), 'pbadge got the cosmetic');
}

console.log('- grantPassXp reports tiersGained');
{
  const env = makeEnv();
  await seedSeasonOne(env);
  const a = await grantPassXp(env, U, 250, 'x');   // tier 0→2
  eq(a.tiersGained, 2, 'gained 2 tiers');
  const b = await grantPassXp(env, U, 50, 'x');    // 250→300, tier 2→3
  eq(b.tiersGained, 1, 'gained 1 more tier');
}

console.log('');
console.log(`PASSED, ${pass} ok / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
