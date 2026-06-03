// Standalone harness for the bot-driven onboarding flow.
//
// Coverage (from the issue):
//   • starting fresh           → /onboard with no state → welcome view
//   • resume partway           → pre-seed state at step:'pwa',
//                                 /onboard renders the pwa view
//   • idempotent re-run after
//     completion               → complete the flow once; second call
//                                 returns the "already onboarded" recap
//                                 and the bonus does NOT fire again
//   • role-assign-skipped when
//     a configured role is
//     missing                  → empty role-map → no-mapping skips;
//                                 mapped-but-404 role → role-not-found skip;
//                                 mapped-but-403 → forbidden skip; flow
//                                 still advances cleanly in all cases
//   • bonus-only-fires-once    → completeOnboarding twice → wallet
//                                 balance bumped exactly once
//
// Plus housekeeping:
//   • interest catalog stable, step order stable
//   • funnel counters bump with per-user dedupe
//   • status subcommand renders without crash
//   • post-embed subcommand requires admin perms
//
// Run from repo root:
//   node discord-bot/test/test-onboarding.mjs

import {
  getState,
  getFunnel,
  loadRoleMap,
  grantRolesForInterests,
  completeOnboarding,
  handleOnboardCommand,
  handleOnboardComponent,
  buildWelcomeEmbed,
  INTERESTS,
  STEP_ORDER,
  ONBOARD_BONUS_BOLTS,
  ONBOARD_BONUS_PACK,
} from '../onboarding.js';
import { getWallet } from '../wallet.js';

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

// ── KV stub ───────────────────────────────────────────────────────
function makeKv() {
  const store = new Map();
  return {
    async put(key, value, opts) { store.set(key, value); },
    async get(key, opts) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      if (opts && opts.type === 'json') {
        try { return JSON.parse(raw); } catch { return null; }
      }
      return raw;
    },
    async getWithMetadata(key) {
      const raw = store.get(key);
      return { value: raw === undefined ? null : raw, metadata: null };
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

// ── Discord REST fetch stub ───────────────────────────────────────
// Replaces globalThis.fetch with a configurable router. Each test
// sets `fetchHandler` to a function (urlString, init) -> Response.
let fetchHandler = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (fetchHandler) return fetchHandler(String(input), init || {});
  return new Response('no fetchHandler set', { status: 599 });
};

// ── Fixtures ──────────────────────────────────────────────────────
const GUILD = '1504103035951906883';
const USER  = '209640265063006208';

function envFor(kv, extras = {}) {
  return {
    LOADOUT_BOLTS: kv,
    DISCORD_BOT_TOKEN: 'fake',
    ...extras,
  };
}

function slashData(sub) {
  return {
    guild_id: GUILD,
    member: { user: { id: USER, global_name: 'tester' }, permissions: '0' },
    data: sub ? { name: 'onboard', options: [{ name: sub }] } : { name: 'onboard' },
  };
}

function adminSlashData(sub) {
  const d = slashData(sub);
  d.member.permissions = '8';   // ADMIN
  d.channel_id = '1500000000000000001';
  return d;
}

function componentData(customId, values) {
  return {
    guild_id: GUILD,
    member: { user: { id: USER, global_name: 'tester' }, permissions: '0' },
    data: { custom_id: customId, values },
  };
}

// ── Tests ─────────────────────────────────────────────────────────

console.log('- catalog stability');
{
  eq(STEP_ORDER, ['welcome', 'interests', 'links', 'pwa', 'age18', 'tour', 'complete'], 'STEP_ORDER');
  const keys = INTERESTS.map(i => i.key);
  eq(keys, ['gamenight', 'boltbound', 'boardgames', 'watching', 'art'], 'INTERESTS keys');
  eq(ONBOARD_BONUS_BOLTS, 100, 'bonus bolts');
  eq(ONBOARD_BONUS_PACK,  'bolt', 'bonus pack');
}

console.log('- starting fresh');
{
  const env = envFor(makeKv());
  const r = await handleOnboardCommand(env, slashData());
  eq(r.type, 4, 'returns CHAT response');
  assert(r.data.flags === 64, 'ephemeral');
  assert(Array.isArray(r.data.embeds) && r.data.embeds[0].title.includes('Welcome'), 'welcome embed shown');
  // No KV state should exist yet, viewWelcome doesn\'t persist.
  const s = await getState(env, GUILD, USER);
  eq(s.step, 'welcome', 'state defaults to welcome');
  eq(s.bonusGranted, false, 'no bonus yet');
  eq(s.completedSteps, [], 'no steps marked');
}

console.log('- resume partway (state at pwa)');
{
  const env = envFor(makeKv());
  await env.LOADOUT_BOLTS.put(`onboard:state:${GUILD}:${USER}`, JSON.stringify({
    step: 'pwa',
    choices: { interests: ['boltbound'] },
    completedSteps: ['welcome', 'interests', 'links'],
    bonusGranted: false,
    startedAt: 1700000000000,
  }));
  const r = await handleOnboardCommand(env, slashData());
  assert(r.data.embeds[0].title.includes('Install Aquilo'), 'pwa view shown');
  // Funnel untouched on resume render, render is read-only.
  eq(await getFunnel(env, GUILD), { started: 0, completed: 0, perStep: {} }, 'funnel unchanged on resume');
}

console.log('- role-grant skipped when role missing');
{
  const env = envFor(makeKv());
  // No role map at all → every interest skipped with no-mapping.
  const r1 = await grantRolesForInterests(env, GUILD, USER, ['art', 'boltbound']);
  eq(r1.granted, [], 'no roles granted with empty map');
  eq(r1.skipped.length, 2, 'two skips');
  eq(r1.skipped[0].reason, 'no-mapping', 'reason no-mapping');

  // Now configure the map but make the bot REST return 404 (role
  // deleted in the guild) for one and 200 for the other.
  await env.LOADOUT_BOLTS.put(`onboard:role-map:${GUILD}`, JSON.stringify({
    art:       '900000000000000111',
    boltbound: '900000000000000222',
    gamenight: '900000000000000333',
  }));
  const calls = [];
  fetchHandler = async (url, init) => {
    calls.push({ url, method: init.method });
    if (url.endsWith('/roles/900000000000000111')) return new Response(null, { status: 204 });
    if (url.endsWith('/roles/900000000000000222')) return new Response('not found', { status: 404 });
    if (url.endsWith('/roles/900000000000000333')) return new Response('forbidden', { status: 403 });
    return new Response('?', { status: 500 });
  };
  const r2 = await grantRolesForInterests(env, GUILD, USER, ['art', 'boltbound', 'gamenight']);
  fetchHandler = null;
  eq(r2.granted, ['art'], 'only the 204 role granted');
  eq(r2.skipped.length, 2, 'two skipped');
  const reasons = r2.skipped.map(s => s.reason).sort();
  eq(reasons, ['forbidden', 'role-not-found'], 'reason codes');
  eq(calls.length, 3, 'one REST call per interest');
}

console.log('- env-var ONBOARD_ROLE_MAP fallback');
{
  const env = envFor(makeKv(), {
    ONBOARD_ROLE_MAP: JSON.stringify({ gamenight: '900000000000099999', notvalid: 'nope' }),
  });
  const m = await loadRoleMap(env, GUILD);
  eq(m.gamenight, '900000000000099999', 'env-var map honored');
  assert(!('notvalid' in m), 'unknown interest key dropped');
  // KV wins over env if present.
  await env.LOADOUT_BOLTS.put(`onboard:role-map:${GUILD}`, JSON.stringify({ gamenight: '888888888888888888' }));
  const m2 = await loadRoleMap(env, GUILD);
  eq(m2.gamenight, '888888888888888888', 'KV overrides env');
}

console.log('- bonus only fires once');
{
  const env = envFor(makeKv());
  // Stub DM channel + message endpoints + REST role fetches as 204
  // so completion's incidental fetches don\'t blow up.
  fetchHandler = async () => new Response(null, { status: 204 });
  // First completion.
  const state1 = await getState(env, GUILD, USER);
  const r1 = await completeOnboarding(env, GUILD, USER, state1);
  eq(r1.alreadyGranted, false, 'first call NOT alreadyGranted');
  eq(r1.bolts, ONBOARD_BONUS_BOLTS, 'bolts granted on first call');
  const w1 = await getWallet(env, GUILD, USER);
  eq(w1.balance, ONBOARD_BONUS_BOLTS, 'wallet balance is exactly the bonus');
  // Second completion, reload state, call again.
  const state2 = await getState(env, GUILD, USER);
  eq(state2.bonusGranted, true, 'state persists bonusGranted');
  const r2 = await completeOnboarding(env, GUILD, USER, state2);
  eq(r2.alreadyGranted, true, 'second call IS alreadyGranted');
  eq(r2.bolts, 0, 'no bolts granted on second call');
  const w2 = await getWallet(env, GUILD, USER);
  eq(w2.balance, ONBOARD_BONUS_BOLTS, 'wallet balance unchanged on second call');
  // Funnel, only one `completed` despite two completion calls.
  const f = await getFunnel(env, GUILD);
  eq(f.completed, 1, 'funnel.completed exactly 1');
  fetchHandler = null;
}

console.log('- idempotent re-run after completion via /onboard');
{
  const env = envFor(makeKv());
  // Pre-seed completed state directly.
  await env.LOADOUT_BOLTS.put(`onboard:state:${GUILD}:${USER}`, JSON.stringify({
    step: 'complete',
    choices: { interests: ['boltbound'] },
    completedSteps: ['welcome', 'interests', 'links', 'pwa', 'age18', 'tour', 'complete'],
    bonusGranted: true,
    startedAt: 1700000000000,
    completedAt: 1700000099999,
  }));
  // Also seed a wallet so it doesn\'t come back null.
  await env.LOADOUT_BOLTS.put(`wallet:${GUILD}:${USER}`, JSON.stringify({
    balance: 100, lifetimeEarned: 100, lifetimeSpent: 0, links: [],
  }));
  const r = await handleOnboardCommand(env, slashData());
  assert(r.data.embeds[0].title.includes('Already onboarded'), 'shows already-onboarded recap');
  // Wallet untouched.
  const w = await getWallet(env, GUILD, USER);
  eq(w.balance, 100, 'wallet unchanged after re-run');
}

console.log('- full flow walkthrough (advance buttons)');
{
  const env = envFor(makeKv());
  await env.LOADOUT_BOLTS.put(`onboard:role-map:${GUILD}`, JSON.stringify({
    gamenight: '999999999999999001',
  }));
  fetchHandler = async (url) => {
    // Role-grant goes to 204; everything else (DM channel, pack mint)
    // returns innocuous 200/204 so completion doesn\'t crash.
    if (url.includes('/roles/')) return new Response(null, { status: 204 });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  // Click the persistent welcome embed\'s "Begin" button.
  let r = await handleOnboardComponent(env, componentData('onb:begin'));
  assert(r.data.embeds[0].title.includes('What brings you here'), 'after begin → interests view');

  // Pick interests via the select.
  r = await handleOnboardComponent(env, componentData('onb:pick:interests', ['gamenight', 'boltbound']));
  assert(r.data.embeds[0].title.includes('What brings you here'), 'pick stays on interests view');
  const sAfterPick = await getState(env, GUILD, USER);
  eq(sAfterPick.choices.interests, ['gamenight', 'boltbound'], 'choices persisted');

  // Advance: interests → links → pwa → age18 → tour → complete.
  r = await handleOnboardComponent(env, componentData('onb:advance:interests'));
  assert(r.data.embeds[0].title.includes('Link your accounts'), 'interests → links');
  r = await handleOnboardComponent(env, componentData('onb:advance:links'));
  assert(r.data.embeds[0].title.includes('Install Aquilo'), 'links → pwa');
  r = await handleOnboardComponent(env, componentData('onb:advance:pwa'));
  assert(r.data.embeds[0].title.includes('18'), 'pwa → age18');
  // age18 has its own yes/no handler, emulate the "no" path to advance to tour.
  r = await handleOnboardComponent(env, componentData('onb:age18:no'));
  assert(r.data.embeds[0].title.includes('quick tour'), 'age18:no → tour');
  r = await handleOnboardComponent(env, componentData('onb:advance:tour'));
  assert(r.data.embeds[0].title.includes("You're onboarded"), 'tour → complete');

  // Wallet got the bonus exactly once.
  const w = await getWallet(env, GUILD, USER);
  eq(w.balance, ONBOARD_BONUS_BOLTS, 'final wallet balance = bonus');

  // Funnel: started=1, completed=1, perStep dedup-correct.
  const f = await getFunnel(env, GUILD);
  eq(f.started, 1, 'funnel started = 1');
  eq(f.completed, 1, 'funnel completed = 1');
  for (const step of ['welcome', 'interests', 'links', 'pwa', 'age18', 'tour', 'complete']) {
    eq(f.perStep[step], 1, `funnel.perStep[${step}] = 1`);
  }

  fetchHandler = null;
}

console.log('- skip-button flow (skips don\'t complete the skipped step)');
{
  const env = envFor(makeKv());
  fetchHandler = async () => new Response('{}', { status: 200 });
  // Begin then immediately skip interests.
  await handleOnboardComponent(env, componentData('onb:begin'));
  const r = await handleOnboardComponent(env, componentData('onb:step:links'));
  assert(r.data.embeds[0].title.includes('Link your accounts'), 'skip jumps to links');
  const s = await getState(env, GUILD, USER);
  eq(s.step, 'links', 'state.step = links');
  // funnelMarked should NOT include `interests` (we skipped it).
  assert(!(s.funnelMarked || []).includes('interests'), 'interests NOT marked as completed by skip');
  fetchHandler = null;
}

console.log('- /onboard status admin-gated');
{
  const env = envFor(makeKv());
  // Non-admin should get the 🔒 message.
  const r1 = await handleOnboardCommand(env, slashData('status'));
  assert(/Admins only/.test(r1.data.content), 'non-admin refused');
  // Admin should see funnel snapshot.
  const r2 = await handleOnboardCommand(env, adminSlashData('status'));
  assert(/Onboarding funnel/.test(r2.data.content), 'admin sees funnel header');
}

console.log('- /onboard post-embed admin-gated');
{
  const env = envFor(makeKv());
  const r1 = await handleOnboardCommand(env, slashData('post-embed'));
  assert(/Admins only/.test(r1.data.content), 'non-admin refused');
  // Stub the Discord POST.
  fetchHandler = async (url, init) => {
    if (init.method === 'POST' && /\/channels\/.+\/messages$/.test(url)) {
      return new Response(JSON.stringify({ id: '900100200300400500' }), { status: 200 });
    }
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    return new Response('{}', { status: 200 });
  };
  const r2 = await handleOnboardCommand(env, adminSlashData('post-embed'));
  fetchHandler = null;
  assert(/Welcome embed posted/.test(r2.data.content), 'admin post-embed succeeds');
  // KV welcome-msg record written.
  const rec = await env.LOADOUT_BOLTS.get(`onboard:welcome-msg:${GUILD}`, { type: 'json' });
  eq(rec.messageId, '900100200300400500', 'welcome-msg id recorded');
}

console.log('- buildWelcomeEmbed exposes the begin button id');
{
  const env = envFor(makeKv());
  const { embed, components } = await buildWelcomeEmbed(env, GUILD);
  assert(/Welcome/.test(embed.title), 'welcome title');
  const btn = components[0].components[0];
  eq(btn.custom_id, 'onb:begin', 'button id is onb:begin');
  eq(btn.label, 'Begin Welcome Checklist', 'button label');
}

console.log('');
// Restore real fetch so the harness exits cleanly.
globalThis.fetch = realFetch;
if (failures > 0) {
  console.log('FAILED, ' + failures + ' assertion(s) failed');
  process.exit(1);
}
console.log('PASSED, all assertions ok');
