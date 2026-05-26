// Hubs + schedule-public-read harness.
//
// Coverage:
//   • channel-hubs.HUB_KEYS pinned to the 5 phase-1 entries
//   • buildHubEmbed returns a valid embed + at least one button
//     row for each hub key
//   • pickHubChannel: explicit id / name substring / hub hints
//   • postHub refuses unknown hub key
//   • cn-vote-hub.buildHubEmbed has the 4 buttons w/ the right cnv:* ids
//   • cn-games-list-hub.pickGamesListChannel hint order
//   • aq-schedule.getPublicSchedule shape — 7 days, slot/status,
//     CN winner reflected, store='steam' when art is a steam URL
//
// Run from repo root:
//   node discord-bot/test/test-hubs-and-schedule.mjs

import {
  HUB_KEYS,
  buildHubEmbed,
  pickHubChannel,
  postHub,
  _HUBS_FOR_TEST,
} from '../channel-hubs.js';
import {
  buildHubEmbed as buildCnVoteEmbed,
} from '../cn-vote-hub.js';
import {
  pickGamesListChannel,
  _DEFAULT_GAMES_LIST_HINTS_FOR_TEST,
  _storeUrlForGameForTest,
} from '../cn-games-list-hub.js';
import {
  getPublicSchedule,
} from '../aquilo/aq-schedule.js';

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

const GUILD = '1504103035951906883';

console.log('— channel-hubs: catalogue + builders');
{
  eq(HUB_KEYS, ['checkin', 'character', 'bolts', 'play', 'achievements'], 'HUB_KEYS pinned');
  // _HUBS_FOR_TEST contract.
  for (const k of HUB_KEYS) {
    assert(typeof _HUBS_FOR_TEST[k]?.title === 'string',  `${k}: title`);
    assert(typeof _HUBS_FOR_TEST[k]?.description === 'string', `${k}: description`);
    assert(Array.isArray(_HUBS_FOR_TEST[k]?.channelHints), `${k}: channelHints[]`);
  }
}

console.log('— buildHubEmbed per key');
{
  for (const k of HUB_KEYS) {
    const env = { LOADOUT_BOLTS: makeKv() };
    const built = await buildHubEmbed(env, GUILD, k);
    assert(built && built.embed && typeof built.embed.title === 'string', `${k}: embed shape`);
    assert(Array.isArray(built.components) && built.components.length >= 1, `${k}: components row`);
    assert(built.components[0].components.length >= 1, `${k}: at least one button`);
  }
  // Unknown key.
  const bad = await buildHubEmbed({ LOADOUT_BOLTS: makeKv() }, GUILD, 'zzz');
  eq(bad, null, 'unknown hub key → null');
}

console.log('— pickHubChannel: explicit / name / hint / null');
{
  const hub = _HUBS_FOR_TEST.checkin;   // hints: ['check-in', 'checkin', 'daily']
  const chs = [
    { id: '1', name: 'general',            type: 0 },
    { id: '2', name: '💬│daily-check-in',  type: 0 },
    { id: '3', name: 'voice-lobby',        type: 2 },   // voice
    { id: '4', name: 'random',             type: 0 },
  ];
  eq(pickHubChannel(chs, hub, { channelId: '2' }), { id: '2', name: '💬│daily-check-in' }, 'explicit id');
  eq(pickHubChannel(chs, hub, { channelId: '999' }), null, 'unknown id → null');
  eq(pickHubChannel(chs, hub, { channelName: 'daily' })?.id, '2', 'name substring');
  eq(pickHubChannel(chs, hub, {})?.id, '2', 'hint match (check-in hits #daily-check-in)');
  // No candidates.
  eq(pickHubChannel([{ id: '1', name: 'random', type: 0 }], hub, {}), null, 'no candidates → null');
  // Voice channels ignored.
  eq(pickHubChannel([{ id: '3', name: 'check-in-voice', type: 2 }], hub, {}), null, 'voice-only → null');
}

console.log('— postHub: refuses unknown key');
{
  const env = { LOADOUT_BOLTS: makeKv(), DISCORD_BOT_TOKEN: 'fake' };
  const r = await postHub(env, GUILD, 'whatever', '1500000000000000001');
  eq(r.ok, false, 'ok:false');
  eq(r.error, 'unknown-hub-key', 'error code');
  assert(Array.isArray(r.allowed) && r.allowed.length === 5, 'returns allowed list');
}

console.log('— cn-vote-hub: button catalogue');
{
  const env = { LOADOUT_BOLTS: makeKv() };
  const { embed, components } = await buildCnVoteEmbed(env, GUILD);
  assert(/Community Night/.test(embed.title), 'title');
  eq(components.length, 1, 'one action row');
  const ids = components[0].components.map(b => b.custom_id);
  eq(ids, ['cnv:vote', 'cnv:standings', 'cnv:queue-join', 'cnv:status'], 'four buttons w/ cnv:* ids');
}

console.log('— cn-games-list-hub: hint order + steam URL extractor');
{
  eq(_DEFAULT_GAMES_LIST_HINTS_FOR_TEST,
    ['cn-games', 'community-night-games', 'game-options', 'cn-game'],
    'hint order pinned');
  // Steam URL extractor.
  eq(_storeUrlForGameForTest({ art_url: 'https://cdn.akamai.steamstatic.com/steam/apps/1313140/header.jpg' }),
    'https://store.steampowered.com/app/1313140/', 'steam app 1313140');
  eq(_storeUrlForGameForTest({ art_url: 'https://upload.wikimedia.org/foo.png' }),
    null, 'wikimedia → null');
  eq(_storeUrlForGameForTest({ art_url: null }), null, 'null art → null');
  // pickGamesListChannel hint-order behaviour.
  const chs = [
    { id: '1', name: 'random',           type: 0 },
    { id: '2', name: 'cn-games-list',    type: 0 },
    { id: '3', name: 'game-options-old', type: 0 },
  ];
  eq(pickGamesListChannel(chs, {})?.id, '2', 'cn-games hint wins over game-options');
  eq(pickGamesListChannel(chs, { channelName: 'options' })?.id, '3', 'name substring overrides hint order');
}

console.log('— getPublicSchedule: shape + CN winner');
{
  const env = {
    LOADOUT_BOLTS: makeKv(),
    STATE: makeKv(),
    SCHEDULE_CHANNEL_ID: '1507973920282640485',
    POLL_CHANNEL_ID:     '1508318930845044786',
  };
  // No saved sched → load returns defaults; CN slot has no winner →
  // status = 'vote-open'.
  const r1 = await getPublicSchedule(env, GUILD);
  assert(r1.ok, 'ok:true');
  eq(r1.guildId, GUILD, 'guildId echoed');
  eq(r1.days.length, 7, '7 days');
  // Saturday is the CN day per WEEKLY.
  const sat1 = r1.days.find(d => d.weekday === 'saturday');
  eq(sat1.slot, 'cn', 'saturday slot=cn');
  eq(sat1.status, 'vote-open', 'no winner → vote-open');
  eq(sat1.game, null, 'no game yet');
  // Minecraft days carry Minecraft game info.
  const sun = r1.days.find(d => d.weekday === 'sunday');
  eq(sun.slot, 'stream', 'sunday=stream');
  eq(sun.game?.name, 'Minecraft', 'sunday game = Minecraft');
  assert(/wikimedia/.test(sun.game.artUrl || ''), 'sunday art = wikimedia');
  eq(sun.game.store, 'mojang', 'sunday store=mojang');
  eq(sun.status, 'scheduled', 'sunday status=scheduled');
  // Off days.
  const tue = r1.days.find(d => d.weekday === 'tuesday');
  eq(tue.slot, 'off', 'tuesday off');
  eq(tue.game, null, 'tuesday no game');
  eq(tue.status, 'off', 'tuesday status=off');

  // Now seed a CN winner + read again. Winner has a Steam URL →
  // store='steam'.
  await env.STATE.put(`schedule:${GUILD}`, JSON.stringify({
    channel_id: '1507973920282640485',
    message_id: '999',
    cn_winners: { saturday: { name: 'Cult of the Lamb', art_url: 'https://cdn.akamai.steamstatic.com/steam/apps/1313140/header.jpg' } },
  }));
  const r2 = await getPublicSchedule(env, GUILD);
  const sat2 = r2.days.find(d => d.weekday === 'saturday');
  eq(sat2.status, 'vote-completed', 'winner present → vote-completed');
  eq(sat2.game?.name, 'Cult of the Lamb', 'winner name');
  eq(sat2.game?.store, 'steam', 'steam URL → store=steam');
  assert(/steam\/apps\/1313140/.test(sat2.game?.artUrl || ''), 'winner art url echoed');
}

console.log('');
if (failures > 0) {
  console.log('FAILED — ' + failures + ' assertion(s) failed');
  process.exit(1);
}
console.log('PASSED — all assertions ok');
