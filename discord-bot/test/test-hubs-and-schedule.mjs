// Hubs + schedule-public-read harness.
//
// Coverage:
//   • channel-hubs.HUB_KEYS pinned to the 2 post-economy-sunset entries
//     (checkin + achievements; character/bolts/play removed 2026-06)
//   • buildHubEmbed returns a valid embed + at least one button
//     row for each hub key
//   • pickHubChannel: explicit id / name substring / hub hints
//   • postHub refuses unknown hub key
//   • cn-vote-hub.buildHubEmbed has the 4 buttons w/ the right cnv:* ids
//   • cn-games-list-hub.pickGamesListChannel hint order
//   • aq-schedule.getPublicSchedule, schedule v8 (2026-07-11):
//     Sun/Mon/Wed/Fri = slot 'fo4cc' Crowd Control 22:30-00:30,
//     Sat = slot 'cn' Community Night (weekly pick from games:v1 pool),
//     Tue/Thu = slot 'off' with game/times null + status 'off';
//     retired cn_winners ignored; triple-c:current swap reflected
//     with store='steam' derived from a steam art URL
//   • schedule.js DEFAULT_SCHEDULE v8 fallback shape (rest days have
//     startLocal/endLocal null, Saturday kind 'community') +
//     upcomingStreams skips off days
//   • voteActiveAt guards via handleExtSchedule: off-day guard
//     (startLocal:null → active:false even inside the vote window) AND
//     the v8 community exclusion (community NEVER opens a vote window —
//     the game is the weekly auto-pick; 'variety' still exercises the
//     window logic itself)
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
import {
  readSchedule,
  upcomingStreams,
  handleExtSchedule,
} from '../schedule.js';

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

console.log('- channel-hubs: catalogue + builders');
{
  eq(HUB_KEYS, ['checkin', 'achievements'], 'HUB_KEYS pinned (post-economy-sunset)');
  // _HUBS_FOR_TEST contract.
  for (const k of HUB_KEYS) {
    assert(typeof _HUBS_FOR_TEST[k]?.title === 'string',  `${k}: title`);
    assert(typeof _HUBS_FOR_TEST[k]?.description === 'string', `${k}: description`);
    assert(Array.isArray(_HUBS_FOR_TEST[k]?.channelHints), `${k}: channelHints[]`);
  }
}

console.log('- buildHubEmbed per key');
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

console.log('- pickHubChannel: explicit / name / hint / null');
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

console.log('- postHub: refuses unknown key');
{
  const env = { LOADOUT_BOLTS: makeKv(), DISCORD_BOT_TOKEN: 'fake' };
  const r = await postHub(env, GUILD, 'whatever', '1500000000000000001');
  eq(r.ok, false, 'ok:false');
  eq(r.error, 'unknown-hub-key', 'error code');
  assert(Array.isArray(r.allowed) && r.allowed.length === 2, 'returns allowed list');
}

console.log('- cn-vote-hub: button catalogue');
{
  const env = { LOADOUT_BOLTS: makeKv() };
  const { embed, components } = await buildCnVoteEmbed(env, GUILD);
  assert(/Community Night/.test(embed.title), 'title');
  eq(components.length, 1, 'one action row');
  const ids = components[0].components.map(b => b.custom_id);
  eq(ids, ['cnv:vote', 'cnv:standings', 'cnv:queue-join', 'cnv:status'], 'four buttons w/ cnv:* ids');
}

console.log('- cn-games-list-hub: hint order + steam URL extractor');
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

console.log('- getPublicSchedule: schedule v8 (4x Crowd Control + Sat Community Night + Tue/Thu off)');
{
  const env = {
    LOADOUT_BOLTS: makeKv(),
    STATE: makeKv(),
    SCHEDULE_CHANNEL_ID: '1507973920282640485',
    POLL_CHANNEL_ID:     '1508318930845044786',
  };
  // No saved sched, so load returns defaults. Schedule v8 (2026-07-11):
  // Sun/Mon/Wed/Fri = solo Crowd Control (kind fo4cc, campaign game
  // defaults to Fallout 4), Sat = Community Night (weekly pick from the
  // games:v1 community pool), Tue/Thu = OFF rest days.
  const r1 = await getPublicSchedule(env, GUILD);
  assert(r1.ok, 'ok:true');
  eq(r1.guildId, GUILD, 'guildId echoed');
  eq(r1.days.length, 7, '7 days');
  // The four Crowd Control nights.
  for (const wd of ['sunday', 'monday', 'wednesday', 'friday']) {
    const d = r1.days.find(x => x.weekday === wd);
    eq(d.slot, 'fo4cc', `${wd} slot=fo4cc`);
    eq(d.status, 'scheduled', `${wd} status=scheduled`);
    eq(d.times, { startEt: '22:30', endEt: '00:30' }, `${wd} times 22:30-00:30 ET`);
    eq(d.game?.name, 'Fallout 4', `${wd} game = Fallout 4 (CC default)`);
  }
  const mon = r1.days.find(d => d.weekday === 'monday');
  assert(/steam\/apps\/377160\/header\.jpg/.test(mon.game?.artUrl || ''), 'CC default art = FO4 steam header');
  eq(mon.game?.store, 'https://store.steampowered.com/app/377160/', 'CC default store url');
  // Saturday is Community Night: slot 'cn', scheduled, and with an EMPTY
  // games:v1 pool the weekly pick degrades to game:null (embed shows
  // "Game picked weekly.").
  const sat1 = r1.days.find(d => d.weekday === 'saturday');
  eq(sat1.slot, 'cn', 'saturday slot=cn');
  eq(sat1.status, 'scheduled', 'saturday status=scheduled');
  eq(sat1.times, { startEt: '22:30', endEt: '00:30' }, 'saturday times 22:30-00:30 ET');
  eq(sat1.game, null, 'saturday game=null with an empty community pool');
  // Tue/Thu are OFF: slot 'off', no game, no times, status 'off'.
  for (const wd of ['tuesday', 'thursday']) {
    const d = r1.days.find(x => x.weekday === wd);
    eq(d.slot, 'off', `${wd} slot=off`);
    eq(d.game, null, `${wd} game=null`);
    eq(d.status, 'off', `${wd} status=off`);
    eq(d.times, null, `${wd} times=null`);
  }

  // Seed a single-game community pool: the weekly pick MUST resolve it
  // (single item → seed-independent, so the assertion is deterministic).
  await env.LOADOUT_BOLTS.put(`games:v1:${GUILD}`, JSON.stringify({
    version: 1, updatedAt: 1, updatedBy: 'test',
    items: [{
      id: 'peak', name: 'PEAK', pools: ['community'],
      headerUrl: 'https://cdn.akamai.steamstatic.com/steam/apps/3527290/header.jpg',
      storeUrl: 'https://store.steampowered.com/app/3527290/',
    }],
  }));
  const r1b = await getPublicSchedule(env, GUILD);
  const sat1b = r1b.days.find(d => d.weekday === 'saturday');
  eq(sat1b.game?.name, 'PEAK', 'saturday game = weekly community pick');
  assert(/steam\/apps\/3527290/.test(sat1b.game?.artUrl || ''), 'community pick art from pool headerUrl');

  // The retired vote model's cn_winners cache is IGNORED by v8 — a
  // stale winner must not displace the weekly auto-pick.
  await env.STATE.put(`schedule:${GUILD}`, JSON.stringify({
    channel_id: '1507973920282640485',
    message_id: '999',
    cn_winners: { saturday: { name: 'Cult of the Lamb', art_url: 'https://cdn.akamai.steamstatic.com/steam/apps/1313140/header.jpg' } },
  }));
  const r2 = await getPublicSchedule(env, GUILD);
  const sat2 = r2.days.find(d => d.weekday === 'saturday');
  eq(sat2.slot, 'cn', 'stale cn_winner: saturday stays cn');
  eq(sat2.status, 'scheduled', 'stale cn_winner: status stays scheduled');
  eq(sat2.game?.name, 'PEAK', 'stale cn_winner: game stays the weekly auto-pick');

  // Admin swaps the Crowd Control campaign game (triple-c:current:<g>).
  // No store given + steam art URL → store derived as 'steam'. Asserted
  // on MONDAY (a fo4cc night) — Saturday no longer resolves triple-c.
  await env.LOADOUT_BOLTS.put(`triple-c:current:${GUILD}`, JSON.stringify({
    name: 'Cult of the Lamb',
    artUrl: 'https://cdn.akamai.steamstatic.com/steam/apps/1313140/header.jpg',
  }));
  const r3 = await getPublicSchedule(env, GUILD);
  const mon3 = r3.days.find(d => d.weekday === 'monday');
  eq(mon3.game?.name, 'Cult of the Lamb', 'triple-c swap: name reflected');
  eq(mon3.game?.store, 'steam', 'triple-c swap: steam art URL → store=steam');
  assert(/steam\/apps\/1313140/.test(mon3.game?.artUrl || ''), 'triple-c swap: art url echoed');
  const sat3 = r3.days.find(d => d.weekday === 'saturday');
  eq(sat3.game?.name, 'PEAK', 'triple-c swap: saturday keeps the community pick');
  const tue3 = r3.days.find(d => d.weekday === 'tuesday');
  eq(tue3.slot, 'off', 'triple-c swap: tuesday still off');
  eq(tue3.game, null, 'triple-c swap: off day still has no game');
}

// Fixed clock for the DEFAULT_SCHEDULE/upcomingStreams/voteActiveAt
// checks: Tuesday 2026-07-14 19:30 ET (23:30 UTC) — a v8 rest day,
// INSIDE the 18:00-21:00 ET vote window so the off-day guard (not the
// clock) is what must flip voteActiveAt to inactive.
const TUE_1930_ET = Date.UTC(2026, 6, 14, 23, 30);

console.log('- DEFAULT_SCHEDULE v8 + upcomingStreams: off days produce no entries');
{
  const env = { LOADOUT_BOLTS: makeKv() };
  // Empty KV → readSchedule falls back to DEFAULT_SCHEDULE (v8).
  const sched = await readSchedule(env, GUILD);
  eq(sched.days.length, 7, 'default schedule has 7 days');
  for (const dow of [0, 1, 3, 5]) {
    const d = sched.days.find(x => x.dow === dow);
    eq(d.kind, 'fo4cc', `dow ${dow} kind=fo4cc`);
    eq(d.label, 'Crowd Control', `dow ${dow} label`);
    eq(d.startLocal, '22:30', `dow ${dow} start 22:30`);
    eq(d.endLocal, '00:30', `dow ${dow} end 00:30`);
  }
  {
    const d = sched.days.find(x => x.dow === 6);
    eq(d.kind, 'community', 'dow 6 kind=community');
    eq(d.label, 'Community Night', 'dow 6 label');
    eq(d.startLocal, '22:30', 'dow 6 start 22:30');
    eq(d.endLocal, '00:30', 'dow 6 end 00:30');
  }
  for (const dow of [2, 4]) {
    const d = sched.days.find(x => x.dow === dow);
    eq(d.label, 'No stream (rest day)', `dow ${dow} rest-day label`);
    eq(d.startLocal, null, `dow ${dow} startLocal=null`);
    eq(d.endLocal, null, `dow ${dow} endLocal=null`);
  }

  // From Tue 19:30 ET, a 7-day horizon scans Tue..next-Tue: the five
  // stream nights appear once each, Tue/Thu appear NOT AT ALL.
  const streams = upcomingStreams(sched, 7, TUE_1930_ET);
  eq(streams.length, 5, '5 upcoming streams in 7-day horizon');
  eq(streams.map(s => s.dow), [3, 5, 6, 0, 1], 'soonest-first, Wed→Mon, no dow 2/4');
  assert(streams.every(s => s.dow !== 2 && s.dow !== 4), 'no rest-day entries');
  assert(streams.every(s => s.startLocal === '22:30'), 'all entries start 22:30');
  eq(streams.map(s => s.kind), ['fo4cc', 'fo4cc', 'community', 'fo4cc', 'fo4cc'], 'CC nights + Saturday community');
  assert(streams.every(s => s.startsAt > TUE_1930_ET && s.endsAt > s.startsAt), 'sane start/end epochs (end crosses midnight)');
  eq(streams[0].dateKey, '2026-07-15', 'first entry dated Wed Jul 15');
}

console.log('- voteActiveAt: off-day guard (via handleExtSchedule)');
{
  // voteActiveAt is exercised through handleExtSchedule, which stamps
  // the payload with Date.now() — pin the clock to Tue 19:30 ET.
  const realNow = Date.now;
  Date.now = () => TUE_1930_ET;
  try {
    // Tuesday as an OFF community day: inside the vote window, but
    // startLocal:null must force active:false.
    const offDay = (dow, kind) => ({ dow, label: 'x', kind, startLocal: null, endLocal: null });
    const onDay  = (dow, kind) => ({ dow, label: 'x', kind, startLocal: '22:30', endLocal: '00:30' });
    const mkEnv = (days) => {
      const kv = makeKv();
      kv._store.set(`schedule:v1:${GUILD}`, JSON.stringify({ version: 1, tz: 'America/New_York', updatedAt: 1, updatedBy: 'web', days }));
      return { LOADOUT_BOLTS: kv };
    };

    const days1 = [onDay(0, 'fo4cc'), onDay(1, 'fo4cc'), offDay(2, 'community'), onDay(3, 'fo4cc'), offDay(4, 'community'), onDay(5, 'fo4cc'), onDay(6, 'fo4cc')];
    const p1 = await handleExtSchedule(mkEnv(days1), GUILD);
    eq(p1.vote.active, false, 'off community day → vote inactive');
    eq(p1.vote.kind, 'community', 'off-day guard still reports kind');
    eq(p1.vote.dow, 2, 'off-day guard still reports dow');
    eq(p1.nextStream?.dow, 3, 'nextStream skips the rest day → Wednesday');

    // Same Tuesday, same kind, but WITH a start time: v8 excludes
    // 'community' from the vote window entirely (the game is the weekly
    // auto-pick, no vote exists to advertise).
    const days2 = days1.map(d => (d.dow === 2 ? onDay(2, 'community') : d));
    const p2 = await handleExtSchedule(mkEnv(days2), GUILD);
    eq(p2.vote.active, false, 'community day with startLocal → vote STILL inactive (v8)');

    // 'variety' (dormant kind) keeps the window logic itself honest:
    // same day + startLocal, inside 18:00-21:00 ET → active.
    const days2b = days1.map(d => (d.dow === 2 ? onDay(2, 'variety') : d));
    const p2b = await handleExtSchedule(mkEnv(days2b), GUILD);
    eq(p2b.vote.active, true, 'variety day with startLocal → vote active (window logic intact)');

    // v8 default (empty KV): Tuesday is a rest day of kind fo4cc →
    // inactive regardless of the window.
    const p3 = await handleExtSchedule({ LOADOUT_BOLTS: makeKv() }, GUILD);
    eq(p3.vote.active, false, 'v8 default Tuesday → vote inactive');
    eq(p3.nextStream?.dow, 3, 'v8 default nextStream → Wednesday');
  } finally {
    Date.now = realNow;
  }
}

console.log('');
if (failures > 0) {
  console.log('FAILED, ' + failures + ' assertion(s) failed');
  process.exit(1);
}
console.log('PASSED, all assertions ok');
