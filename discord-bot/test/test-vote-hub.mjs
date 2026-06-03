// vote-hub state-machine harness.
//
// Coverage:
//   • PHASE constants are stable
//   • daysUntilWeekday math
//   • config defaults + setConfig validation
//   • state default = closed
//   • voteMenu / ballot accumulation logic via the component
//     handler (vh:cast)
//   • Patreon-CTA intercept when phase=closed
//   • retireOldCnVoteHub clears KV (no Discord delete in test)
//
// Run from repo root:
//   node discord-bot/test/test-vote-hub.mjs

import {
  PHASE,
  getConfig,
  setConfig,
  getState,
  handleVoteHubComponent,
  retireOldCnVoteHub,
  _daysUntilWeekdayForTest,
} from '../vote-hub.js';

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

let fetchHandler = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (fetchHandler) return fetchHandler(String(input), init || {});
  return new Response('?', { status: 599 });
};

const GUILD = '1504103035951906883';
const USER  = '209640265063006208';

console.log('- PHASE constants');
{
  eq(PHASE.CLOSED,        'closed',         'closed');
  eq(PHASE.VARIETY_OPEN,  'variety-open',   'variety-open');
  eq(PHASE.VARIETY_CLOSED,'variety-closed', 'variety-closed');
  eq(PHASE.CN_OPEN,       'cn-open',        'cn-open');
  eq(PHASE.CN_CLOSED,     'cn-closed',      'cn-closed');
  eq(PHASE.CN_QUEUE,      'cn-queue',       'cn-queue');
}

console.log('- daysUntilWeekday');
{
  eq(_daysUntilWeekdayForTest('tuesday', 'saturday'), 4, 'Tue → Sat');
  eq(_daysUntilWeekdayForTest('saturday', 'saturday'), 0, 'Sat → Sat same day');
  eq(_daysUntilWeekdayForTest('sunday', 'monday'), 1, 'Sun → Mon');
  eq(_daysUntilWeekdayForTest('friday', 'thursday'), 6, 'Fri → Thu wraps');
  eq(_daysUntilWeekdayForTest('bogus', 'saturday'), null, 'bad input → null');
}

console.log('- config defaults + setConfig');
{
  const env = { LOADOUT_BOLTS: makeKv() };
  const def = await getConfig(env, GUILD);
  eq(def.varietyWeekday, null, 'variety unset by default');
  eq(def.cnWeekday, 'saturday', 'cn = saturday by default');
  eq(def.openHourEt, 18, 'openHourEt 18');
  eq(def.closeHourEt, 21, 'closeHourEt 21');
  // Set + read back.
  const r1 = await setConfig(env, GUILD, { varietyWeekday: 'wednesday' });
  assert(r1.ok, 'set variety ok');
  const c1 = await getConfig(env, GUILD);
  eq(c1.varietyWeekday, 'wednesday', 'persisted');
  // Bad weekday.
  const r2 = await setConfig(env, GUILD, { varietyWeekday: 'caturday' });
  eq(r2.ok, false, 'bad day refused');
  eq(r2.error, 'bad-varietyWeekday', 'error code');
  // Clear variety.
  const r3 = await setConfig(env, GUILD, { varietyWeekday: null });
  assert(r3.ok, 'clear ok');
  eq((await getConfig(env, GUILD)).varietyWeekday, null, 'cleared');
}

console.log('- state default');
{
  const env = { LOADOUT_BOLTS: makeKv() };
  const s = await getState(env, GUILD);
  eq(s.phase, PHASE.CLOSED, 'closed by default');
  eq(s.varietyPollId, null, 'no variety poll');
  eq(s.cnPollId, null, 'no cn poll');
}

console.log('- component dispatch: vh:status (always allowed)');
{
  const env = { LOADOUT_BOLTS: makeKv(), STATE: makeKv() };
  const data = { guild_id: GUILD, member: { user: { id: USER } }, data: { custom_id: 'vh:status' } };
  const r = await handleVoteHubComponent(env, data);
  assert(r.type === 4 && r.data.embeds, 'status returns ephemeral embed');
  assert(/Your voting status/.test(r.data.embeds[0].title), 'title');
}

console.log('- component dispatch: closed-phase intercept on vote action');
{
  const env = { LOADOUT_BOLTS: makeKv(), STATE: makeKv() };
  // Default state = closed.
  const data = { guild_id: GUILD, member: { user: { id: USER } }, data: { custom_id: 'vh:vote:cn' } };
  const r = await handleVoteHubComponent(env, data);
  assert(r.type === 4 && r.data.embeds, 'returns ephemeral');
  assert(/Voting is closed/.test(r.data.embeds[0].title), 'closed CTA shown');
  // Patreon link present.
  const labels = (r.data.components[0]?.components || []).map(c => c.label);
  assert(labels.some(l => /Patron/.test(l)), 'Patreon CTA button');
}

console.log('- vh:cast persists the ballot');
{
  // Force phase = cn-open + minimal DB stub via env.DB so
  // getEligibleGames returns one game.
  const env = {
    LOADOUT_BOLTS: makeKv(),
    DB: {
      prepare: (sql) => ({
        bind: () => ({
          all:   async () => ({ results: [{ id: 'g1', name: 'Cult of the Lamb', art_url: null }] }),
          first: async () => ({ id: 'g1', name: 'Cult of the Lamb', art_url: null }),
        }),
      }),
    },
  };
  // Pre-seed state to cn-open.
  await env.LOADOUT_BOLTS.put(`vote-hub:state:${GUILD}`, JSON.stringify({ phase: PHASE.CN_OPEN }));
  const data = { guild_id: GUILD, member: { user: { id: USER } }, data: { custom_id: 'vh:cast:cn:g1' } };
  const r = await handleVoteHubComponent(env, data);
  assert(r.type === 4 && r.data.embeds, 'cast returns vote-menu render');
  // Check ballot persisted.
  const keys = [...env.LOADOUT_BOLTS._store.keys()].filter(k => k.startsWith(`vote-hub:votes:${GUILD}:cn:`));
  assert(keys.length === 1, '1 ballot key written');
  const ballots = JSON.parse(env.LOADOUT_BOLTS._store.get(keys[0]));
  eq(ballots[USER], 'g1', 'user vote recorded');
}

console.log('- retireOldCnVoteHub clears KV');
{
  const env = { LOADOUT_BOLTS: makeKv(), DISCORD_BOT_TOKEN: 'fake' };
  await env.LOADOUT_BOLTS.put(`cn-vote:hub-msg:${GUILD}`,
    JSON.stringify({ channelId: '111', messageId: '999', postedAt: 1 }));
  fetchHandler = async () => new Response(null, { status: 204 });
  const r = await retireOldCnVoteHub(env, GUILD);
  fetchHandler = null;
  assert(r.ok, 'ok:true');
  eq(r.priorMessageId, '999', 'prior msg captured');
  assert(r.deleted, 'deleted reported true');
  // KV pointer cleared.
  eq(await env.LOADOUT_BOLTS.get(`cn-vote:hub-msg:${GUILD}`), null, 'KV pointer dropped');
}

console.log('');
globalThis.fetch = realFetch;
if (failures > 0) {
  console.log('FAILED, ' + failures + ' assertion(s) failed');
  process.exit(1);
}
console.log('PASSED, all assertions ok');
