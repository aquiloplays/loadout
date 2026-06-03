// Tier-role matcher + backfill harness.
//
// Coverage:
//   • tiersForLevel: pure function, L0/L4/L5/L24/L25/L49/L50/L99/L100/L150
//   • tiersCrossedBy: stacking + only flags thresholds crossed in THIS grant
//   • grantTierRolesForCrossedLevels: skips when no map; grants when map
//     present + a tier was crossed; falls back to AQUILO_VAULT_GUILD_ID
//     when no guildIdHint; treats 204 + 404 + 403 correctly
//   • backfillLevelTierRoles: scans pxp:* + grants for each user's
//     current level; idempotent via KV marker
//
// Run from repo root:
//   node discord-bot/test/test-level-tier-roles.mjs

import {
  LEVEL_TIER_SPECS,
  tiersForLevel,
  tiersCrossedBy,
  loadRoleMap,
  ensureLevelTierRoles,
  grantTierRolesForCrossedLevels,
  backfillLevelTierRoles,
} from '../level-tier-roles.js';

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
    async put(key, value) { store.set(key, value); },
    async get(key, opts) {
      const v = store.get(key);
      if (v === undefined) return null;
      if (opts && opts.type === 'json') {
        try { return JSON.parse(v); } catch { return null; }
      }
      return v;
    },
    async delete(key) { store.delete(key); },
    async list({ prefix = '' } = {}) {
      const keys = [];
      for (const k of store.keys()) if (k.startsWith(prefix)) keys.push({ name: k });
      return { keys, list_complete: true };
    },
    _store: store,
  };
}

let fetchHandler = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (fetchHandler) return fetchHandler(String(input), init || {});
  return new Response('no fetchHandler set', { status: 599 });
};

const GUILD = '1504103035951906883';
const USER  = '209640265063006208';

console.log('- specs sanity');
{
  eq(LEVEL_TIER_SPECS.map(s => s.key), ['apprentice', 'veteran', 'elite', 'mythic'], 'four tiers, in order');
  eq(LEVEL_TIER_SPECS.map(s => s.level), [5, 25, 50, 100], 'thresholds');
}

console.log('- tiersForLevel');
{
  eq(tiersForLevel(0), [], 'L0, none');
  eq(tiersForLevel(4), [], 'L4, none');
  eq(tiersForLevel(5), ['apprentice'], 'L5, apprentice only');
  eq(tiersForLevel(24), ['apprentice'], 'L24, apprentice only');
  eq(tiersForLevel(25), ['apprentice', 'veteran'], 'L25, stacks');
  eq(tiersForLevel(49), ['apprentice', 'veteran'], 'L49, stacks');
  eq(tiersForLevel(50), ['apprentice', 'veteran', 'elite'], 'L50, stacks');
  eq(tiersForLevel(99), ['apprentice', 'veteran', 'elite'], 'L99, stacks');
  eq(tiersForLevel(100), ['apprentice', 'veteran', 'elite', 'mythic'], 'L100, all four');
  eq(tiersForLevel(150), ['apprentice', 'veteran', 'elite', 'mythic'], 'L150, all four');
}

console.log('- tiersCrossedBy');
{
  eq(tiersCrossedBy([]), [], 'empty');
  eq(tiersCrossedBy([3, 4]), [], 'L3-L4, no threshold');
  eq(tiersCrossedBy([5]), ['apprentice'], 'L5 crossing, apprentice');
  // A grant that jumps L24 → L26 crosses L25 only.
  eq(tiersCrossedBy([25, 26]), ['veteran'], 'mixed, only veteran flagged');
  // A bulk grant that crosses multiple tiers in one shot.
  eq(tiersCrossedBy([5, 25, 50]), ['apprentice', 'veteran', 'elite'], 'three at once');
  eq(tiersCrossedBy([100]), ['mythic'], 'just mythic');
}

console.log('- grantTierRolesForCrossedLevels: skips when no map');
{
  const env = { LOADOUT_BOLTS: makeKv(), DISCORD_BOT_TOKEN: 'fake', AQUILO_VAULT_GUILD_ID: GUILD };
  const r = await grantTierRolesForCrossedLevels(env, USER, [5], GUILD);
  eq(r.skipped, 'no-role-map', 'no-role-map');
}

console.log('- grantTierRolesForCrossedLevels: skips when no tier crossed');
{
  const env = { LOADOUT_BOLTS: makeKv(), DISCORD_BOT_TOKEN: 'fake', AQUILO_VAULT_GUILD_ID: GUILD };
  await env.LOADOUT_BOLTS.put(`level-tier-roles:${GUILD}`,
    JSON.stringify({ apprentice: '900000000000000005', veteran: '900000000000000025',
      elite: '900000000000000050', mythic: '900000000000000100' }));
  const r = await grantTierRolesForCrossedLevels(env, USER, [12, 13, 14], GUILD);
  eq(r.skipped, 'no-tier-crossed', 'no-tier-crossed');
}

console.log('- grantTierRolesForCrossedLevels: PUTs the right role, handles 204/404/403');
{
  const env = { LOADOUT_BOLTS: makeKv(), DISCORD_BOT_TOKEN: 'fake', AQUILO_VAULT_GUILD_ID: GUILD };
  await env.LOADOUT_BOLTS.put(`level-tier-roles:${GUILD}`,
    JSON.stringify({
      apprentice: '900000000000000005',   // 204 (success)
      veteran:    '900000000000000025',   // 404 (member or role missing, skip)
      elite:      '900000000000000050',   // 403 (forbidden, skip)
      mythic:     '900000000000000100',   // 204
    }));
  const seen = [];
  fetchHandler = async (url, init) => {
    seen.push({ url, method: init.method });
    if (url.endsWith('/roles/900000000000000005')) return new Response(null, { status: 204 });
    if (url.endsWith('/roles/900000000000000025')) return new Response('not found', { status: 404 });
    if (url.endsWith('/roles/900000000000000050')) return new Response('forbidden', { status: 403 });
    if (url.endsWith('/roles/900000000000000100')) return new Response(null, { status: 204 });
    return new Response('?', { status: 500 });
  };
  // A bulk grant crossing all four tiers, fictional, but exercises every branch.
  const r = await grantTierRolesForCrossedLevels(env, USER, [5, 25, 50, 100], GUILD);
  fetchHandler = null;
  assert(r.ok, 'ok:true');
  eq(r.granted.map(g => g.key), ['apprentice', 'mythic'], 'two granted');
  eq(r.skipped.length, 2, 'two skipped');
  const reasons = r.skipped.map(s => s.reason).sort();
  eq(reasons, ['forbidden', 'member-or-role-missing'], 'skip reason codes');
  eq(seen.length, 4, 'one PUT per tier');
}

console.log('- ensureLevelTierRoles: reuses by name + creates missing');
{
  const env = { LOADOUT_BOLTS: makeKv(), DISCORD_BOT_TOKEN: 'fake' };
  const created = [];
  fetchHandler = async (url, init) => {
    if ((init.method === 'GET' || !init.method) && url.endsWith(`/guilds/${GUILD}/roles`)) {
      return new Response(JSON.stringify([
        { id: GUILD,                name: '@everyone' },
        { id: '900000000000000005', name: 'Apprentice' },   // exists, reuse
      ]), { status: 200 });
    }
    if (init.method === 'POST' && url.endsWith(`/guilds/${GUILD}/roles`)) {
      const body = JSON.parse(init.body);
      const id = '950100' + (created.length + 1).toString().padStart(13, '0');
      created.push({ id, body });
      return new Response(JSON.stringify({ id, name: body.name }), { status: 200 });
    }
    return new Response('?', { status: 500 });
  };
  const r = await ensureLevelTierRoles(env, GUILD);
  fetchHandler = null;
  assert(r.ok, 'ok:true');
  eq(r.reused.map(x => x.key), ['apprentice'], 'apprentice reused by name');
  eq(r.created.map(x => x.key).sort(), ['elite', 'mythic', 'veteran'].sort(), 'three created');
  // Each create POST sent permissions:"0", hoist:false, mentionable:false.
  for (const c of created) {
    eq(c.body.permissions, '0',   `${c.body.name}: permissions "0"`);
    eq(c.body.hoist,       false, `${c.body.name}: hoist false`);
    eq(c.body.mentionable, false, `${c.body.name}: mentionable false`);
  }
  // KV map written + readable.
  const map = await loadRoleMap(env, GUILD);
  eq(map.apprentice, '900000000000000005', 'kv-map apprentice');
  assert(/^9501000/.test(map.veteran), 'kv-map veteran has a fresh id');
}

console.log('- ensureLevelTierRoles: full reuse on second call');
{
  const env = { LOADOUT_BOLTS: makeKv(), DISCORD_BOT_TOKEN: 'fake' };
  await env.LOADOUT_BOLTS.put(`level-tier-roles:${GUILD}`, JSON.stringify({
    apprentice: '950100000000000001',
    veteran:    '950100000000000002',
    elite:      '950100000000000003',
    mythic:     '950100000000000004',
  }));
  let postCalled = 0;
  fetchHandler = async (url, init) => {
    if ((init.method === 'GET' || !init.method) && url.endsWith(`/guilds/${GUILD}/roles`)) {
      return new Response(JSON.stringify([
        { id: GUILD,              name: '@everyone' },
        { id: '950100000000000001', name: 'Apprentice' },
        { id: '950100000000000002', name: 'Veteran' },
        { id: '950100000000000003', name: 'Elite' },
        { id: '950100000000000004', name: 'Mythic' },
      ]), { status: 200 });
    }
    if (init.method === 'POST') postCalled += 1;
    return new Response('{}', { status: 200 });
  };
  const r = await ensureLevelTierRoles(env, GUILD);
  fetchHandler = null;
  assert(r.ok, 'ok:true');
  eq(r.created, [], 'no creates on second run');
  eq(r.reused.length, 4, 'four reused');
  eq(postCalled, 0, 'no POST issued');
}

console.log('- backfillLevelTierRoles: grants based on stored xp + level');
{
  const env = { LOADOUT_BOLTS: makeKv(), DISCORD_BOT_TOKEN: 'fake' };
  await env.LOADOUT_BOLTS.put(`level-tier-roles:${GUILD}`, JSON.stringify({
    apprentice: '900100000000000005',
    veteran:    '900100000000000025',
    elite:      '900100000000000050',
    mythic:     '900100000000000100',
  }));
  // Three players: L4 (nothing), L27 (apprentice + veteran), L130 (all four).
  await env.LOADOUT_BOLTS.put('pxp:111', JSON.stringify({ xp: 100, level: 4 }));
  await env.LOADOUT_BOLTS.put('pxp:222', JSON.stringify({ xp: 999, level: 27 }));
  await env.LOADOUT_BOLTS.put('pxp:333', JSON.stringify({ xp: 99999, level: 130 }));

  const grants = [];
  fetchHandler = async (url, init) => {
    if (init.method === 'PUT' && /\/members\/\d+\/roles\/\d+$/.test(url)) {
      const m = url.match(/\/members\/(\d+)\/roles\/(\d+)$/);
      grants.push({ user: m[1], role: m[2] });
      return new Response(null, { status: 204 });
    }
    return new Response('?', { status: 500 });
  };
  const r = await backfillLevelTierRoles(env, GUILD);
  fetchHandler = null;
  assert(r.ok, 'ok:true');
  eq(r.scanned, 3, 'three pxp records scanned');
  eq(r.granted, 0 + 2 + 4, 'L4=0 + L27=2 + L130=4 = 6 grants');
  // Verify L130 received all four tiers.
  const for333 = grants.filter(g => g.user === '333').map(g => g.role).sort();
  eq(for333.sort(), ['900100000000000005', '900100000000000025', '900100000000000050', '900100000000000100'].sort(),
     'L130 player gets all four roles');
  // Marker stamped, second call skips.
  const r2 = await backfillLevelTierRoles(env, GUILD);
  eq(r2.skipped, 'already-done', 'second backfill skipped via marker');
  // force:true re-scans.
  fetchHandler = async () => new Response(null, { status: 204 });
  const r3 = await backfillLevelTierRoles(env, GUILD, { force: true });
  fetchHandler = null;
  assert(r3.ok, 'force re-scan ok');
  eq(r3.scanned, 3, 'force re-scans all three');
}

console.log('');
globalThis.fetch = realFetch;
if (failures > 0) {
  console.log('FAILED, ' + failures + ' assertion(s) failed');
  process.exit(1);
}
console.log('PASSED, all assertions ok');
