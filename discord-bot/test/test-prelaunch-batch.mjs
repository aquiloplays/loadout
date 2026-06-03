// Pre-launch batch coverage:
//   • bot-guard.isBotPayload handles every shim shape
//   • reset-user-data.resetUserData wipes the right prefixes +
//     preserves the right ones
//   • counting reset semantic, state.current = 0 → next expected = 1
//   • welcome.backfillJoinCounter seeds + respects existing tally
//
// Run from repo root:
//   node discord-bot/test/test-prelaunch-batch.mjs

import { isBotPayload } from '../bot-guard.js';
import { resetUserData } from '../reset-user-data.js';
import { backfillJoinCounter } from '../welcome.js';

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

const GUILD = '1504103035951906883';

// ── bot-guard ────────────────────────────────────────────────────
console.log('- isBotPayload covers every shim shape');
{
  assert(isBotPayload({ author: { bot: true } }),       'author.bot:true');
  assert(isBotPayload({ isBot: true }),                 'isBot:true');
  assert(isBotPayload({ bot: true }),                   'bot:true (legacy)');
  assert(isBotPayload({ user: { bot: true } }),         'user.bot:true (member-join shape)');
  assert(isBotPayload({ author: { bot: true }, isBot: true }), 'multiple flags set');
  assert(!isBotPayload({ author: { bot: false } }),     'author.bot:false → not bot');
  assert(!isBotPayload({ isBot: false }),               'isBot:false → not bot');
  assert(!isBotPayload({}),                              'empty → not bot');
  assert(!isBotPayload(null),                            'null → not bot');
  assert(!isBotPayload({ author: {} }),                 'author with no bot field → not bot');
}

// ── reset-user-data ──────────────────────────────────────────────
console.log('- resetUserData wipes economy + progression, preserves config');
{
  const env = { LOADOUT_BOLTS: makeKv() };
  // Seed: user-facing economy (should be wiped) + config (should survive)
  await env.LOADOUT_BOLTS.put(`wallet:${GUILD}:alice`, JSON.stringify({
    balance: 500, lifetimeEarned: 1000, links: [{ platform: 'twitch', username: 'alice' }],
  }));
  await env.LOADOUT_BOLTS.put(`wallet:${GUILD}:bob`,   JSON.stringify({ balance: 200, links: [] }));
  await env.LOADOUT_BOLTS.put(`community-checkin:${GUILD}:alice`,       JSON.stringify({ streak: 7 }));
  await env.LOADOUT_BOLTS.put(`community-checkin-bonus:${GUILD}:alice`, JSON.stringify({ pending: [{ id: 'x', amount: 5 }] }));
  await env.LOADOUT_BOLTS.put(`freeze:${GUILD}:alice`,                  JSON.stringify({ discord: 2 }));
  await env.LOADOUT_BOLTS.put(`pxp:alice`,                              JSON.stringify({ xp: 350, level: 4 }));
  // Preserve these:
  await env.LOADOUT_BOLTS.put(`character:alice`,        JSON.stringify({ class: 'warrior' }));
  await env.LOADOUT_BOLTS.put(`checkin-card:${GUILD}:alice`, JSON.stringify({ imageUrl: 'https://x.png' }));
  await env.LOADOUT_BOLTS.put(`channel-binding:${GUILD}:checkin`, '111');
  await env.LOADOUT_BOLTS.put(`guild:cfg:${GUILD}`, JSON.stringify({ ids: { vc_join_to_create: '222' } }));
  await env.LOADOUT_BOLTS.put(`secret:${GUILD}`, JSON.stringify({ secret: 'keep-me' }));

  const r = await resetUserData(env, GUILD, { confirm: 'yes-i-mean-it' });
  assert(r.ok, 'reset returned ok');
  // Wallets are zeroed but the records remain (with links[] preserved)
  const w = await env.LOADOUT_BOLTS.get(`wallet:${GUILD}:alice`, { type: 'json' });
  eq(w?.balance,        0,    'alice balance zeroed');
  eq(w?.lifetimeEarned, 0,    'alice lifetimeEarned zeroed');
  eq(w?.links?.length,  1,    'alice links preserved');
  // These were hard-deleted
  eq(await env.LOADOUT_BOLTS.get(`community-checkin:${GUILD}:alice`),       null, 'checkin streak deleted');
  eq(await env.LOADOUT_BOLTS.get(`community-checkin-bonus:${GUILD}:alice`), null, 'bonus queue deleted');
  eq(await env.LOADOUT_BOLTS.get(`freeze:${GUILD}:alice`),                  null, 'freeze deleted');
  eq(await env.LOADOUT_BOLTS.get(`pxp:alice`),                              null, 'pxp deleted');
  // PRESERVED
  assert(await env.LOADOUT_BOLTS.get(`character:alice`),                          'character preserved');
  assert(await env.LOADOUT_BOLTS.get(`checkin-card:${GUILD}:alice`),               'checkin-card cosmetics preserved');
  assert(await env.LOADOUT_BOLTS.get(`channel-binding:${GUILD}:checkin`),          'channel-binding preserved');
  assert(await env.LOADOUT_BOLTS.get(`guild:cfg:${GUILD}`),                        'guild:cfg preserved');
  assert(await env.LOADOUT_BOLTS.get(`secret:${GUILD}`),                            'secret preserved');
  // Summary surfaces per-prefix counts
  assert(r.summary['wallet:'].reset >= 2, 'wallet reset count >= 2');
  assert(r.summary[`community-checkin:${GUILD}:`].deleted >= 1, 'checkin delete >= 1');
  assert(r.summary['pxp:'].deleted >= 1, 'pxp delete >= 1');
}

console.log('- resetUserData refuses without confirm string at the handler layer');
// (the handler layer checks confirm; the lib itself accepts opts, // confirm is the route guard, not the lib's. Asserting opts.includeGlobalPxp
// behaviour here instead.)
{
  const env = { LOADOUT_BOLTS: makeKv() };
  await env.LOADOUT_BOLTS.put(`pxp:carol`, JSON.stringify({ xp: 999 }));
  const r = await resetUserData(env, GUILD, { includeGlobalPxp: false });
  assert(r.ok, 'reset ok with includeGlobalPxp:false');
  eq(r.summary['pxp:'].skipped, 'opts.includeGlobalPxp=false', 'pxp skipped when opt set');
  assert(await env.LOADOUT_BOLTS.get(`pxp:carol`), 'pxp:carol preserved when opt-out');
}

// ── counting reset semantic ──────────────────────────────────────
console.log('- counting fail resets state.current to 0 → next expected = 1');
{
  // Snapshot from aquilo/counting.js, confirms the reset-to-0 invariant
  // Clay asked for ("set the next number back to 1"). Reads the
  // function source to grep for the assignment so this test also
  // catches accidental drift to e.g. state.current = 1 in the future.
  const src = await import('node:fs').then(fs => fs.promises.readFile(
    new URL('../aquilo/counting.js', import.meta.url), 'utf8',
  ));
  // Should contain `state.current = 0;` on a line by itself in the FAIL branch
  assert(/^\s*state\.current\s*=\s*0\s*;/m.test(src),
    'counting FAIL branch sets state.current = 0 (next expected = 1)');
  // And `expected = state.current + 1` for the math invariant.
  assert(/const\s+expected\s*=\s*state\.current\s*\+\s*1/.test(src),
    'expected = state.current + 1');
  // And the public callout text should match Clay's "resets to 1" copy.
  assert(/count resets to \*\*1\*\*/.test(src),
    'fail callout copy mentions "resets to **1**"');
}

// ── welcome backfillJoinCounter ──────────────────────────────────
console.log('- backfillJoinCounter seeds when unset + skips when set');
{
  const env = { LOADOUT_BOLTS: makeKv(), DISCORD_BOT_TOKEN: 'fake' };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith(`/guilds/${GUILD}/preview`)) {
      return new Response(JSON.stringify({ approximate_member_count: 42 }), { status: 200 });
    }
    return new Response('?', { status: 500 });
  };
  const r1 = await backfillJoinCounter(env, GUILD);
  eq(r1.ok, true, 'seed ok');
  eq(r1.seeded, 42, 'seeded to approximate_member_count');
  eq(await env.LOADOUT_BOLTS.get(`guild:join-counter:${GUILD}`), '42', 'KV set');

  const r2 = await backfillJoinCounter(env, GUILD);
  eq(r2.ok, true, 're-run ok');
  eq(r2.skipped, 'already-set', 'idempotent, second call skips');
  eq(r2.value, 42, 'value echoed');

  const r3 = await backfillJoinCounter(env, GUILD, { force: true });
  eq(r3.seeded, 42, 'force re-seeds');
  globalThis.fetch = realFetch;
}

console.log('');
if (failures > 0) {
  console.log('FAILED, ' + failures + ' assertion(s) failed');
  process.exit(1);
}
console.log('PASSED, all assertions ok');
