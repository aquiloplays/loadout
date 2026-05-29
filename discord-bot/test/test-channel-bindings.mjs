// channel-bindings + lfg-hub harness.
//
// Coverage:
//   • getChannelBinding KV precedence over env fallback
//   • getChannelBinding falls through to env when KV empty / bad
//   • getChannelBinding returns null for unknown binding key
//   • getChannelBinding validates KV value is a snowflake
//   • setChannelBinding writes string snowflake; rejects bad ids;
//     rejects unknown binding keys; clear path deletes the override
//   • listChannelBindings returns all 5 keys with KV / env / resolved
//   • lfg-hub.pickLfgChannel: explicit id / name substring / default
//     hints / non-text filter / returns null when nothing
//   • lfg-hub.buildHubEmbed has the three buttons w/ correct custom_ids
//
// Run from repo root:
//   node discord-bot/test/test-channel-bindings.mjs

import {
  getChannelBinding,
  setChannelBinding,
  listChannelBindings,
  isValidBinding,
  _BINDING_KEYS_FOR_TEST,
  _BINDING_ENV_FALLBACK_FOR_TEST,
} from '../channel-bindings.js';
import {
  pickLfgChannel,
  buildHubEmbed,
  _DEFAULT_LFG_CHANNEL_HINTS_FOR_TEST,
} from '../lfg-hub.js';

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
    async put(key, value, _opts) { store.set(key, value); },
    async get(key, opts) {
      const v = store.get(key);
      if (v === undefined) return null;
      if (opts && opts.type === 'json') { try { return JSON.parse(v); } catch { return null; } }
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

console.log('— catalog sanity');
{
  eq(_BINDING_KEYS_FOR_TEST,
    ['queue', 'live', 'recap', 'clips', 'lfg', 'schedule', 'poll',
     'welcome',
     'games-list', 'checkin', 'checkin-results',
     'character', 'bolts', 'play', 'achievements', 'vote',
     'vault-events', 'vault-actions',
     'stream-notifications', 'live-now', 'redemptions-feed',
     'twitch-rewards-feed', 'spire-clears'],
    'binding keys (now includes spire-clears + welcome + twitch-event routing keys)');
  // Every binding has an env-fallback ENTRY in the table (value
  // may be null for hub-channel bindings that are KV-only).
  for (const k of _BINDING_KEYS_FOR_TEST) {
    assert(
      Object.prototype.hasOwnProperty.call(_BINDING_ENV_FALLBACK_FOR_TEST, k),
      `env-fallback entry exists for ${k}`,
    );
  }
  // The original 7 still carry env-var names.
  for (const k of ['queue', 'live', 'recap', 'clips', 'lfg', 'schedule', 'poll']) {
    assert(_BINDING_ENV_FALLBACK_FOR_TEST[k], `${k} has env var: ${_BINDING_ENV_FALLBACK_FOR_TEST[k]}`);
  }
  // checkin has CHECKIN_CHANNEL_ID env fallback; the rest are KV-only.
  eq(_BINDING_ENV_FALLBACK_FOR_TEST.checkin, 'CHECKIN_CHANNEL_ID', 'checkin → CHECKIN_CHANNEL_ID');
  for (const k of ['games-list', 'character', 'bolts', 'play', 'achievements', 'vote',
                   'checkin-results', 'vault-events', 'vault-actions']) {
    eq(_BINDING_ENV_FALLBACK_FOR_TEST[k], null, `${k} env fallback is null (KV-only)`);
  }
  // Pin the env-var names so a rename doesn't silently break the
  // legacy wrangler.toml fallback path.
  eq(_BINDING_ENV_FALLBACK_FOR_TEST.schedule, 'SCHEDULE_CHANNEL_ID', 'schedule → SCHEDULE_CHANNEL_ID');
  eq(_BINDING_ENV_FALLBACK_FOR_TEST.poll,     'POLL_CHANNEL_ID',     'poll → POLL_CHANNEL_ID');
  assert(isValidBinding('queue'),    'isValidBinding(queue)');
  assert(isValidBinding('schedule'), 'isValidBinding(schedule)');
  assert(isValidBinding('poll'),     'isValidBinding(poll)');
  assert(!isValidBinding('garbage'), '!isValidBinding(garbage)');
}

console.log('— schedule + poll: KV wins, env falls back');
{
  const env = {
    LOADOUT_BOLTS: makeKv(),
    SCHEDULE_CHANNEL_ID: '1500000000000000777',
    POLL_CHANNEL_ID:     '1500000000000000888',
  };
  // env-only.
  eq(await getChannelBinding(env, GUILD, 'schedule'), '1500000000000000777', 'schedule env');
  eq(await getChannelBinding(env, GUILD, 'poll'),     '1500000000000000888', 'poll env');
  // Set KV override → wins.
  await setChannelBinding(env, GUILD, 'schedule', '1500000000000000999');
  await setChannelBinding(env, GUILD, 'poll',     '1500000000000000888');
  eq(await getChannelBinding(env, GUILD, 'schedule'), '1500000000000000999', 'schedule KV override');
  eq(await getChannelBinding(env, GUILD, 'poll'),     '1500000000000000888', 'poll KV override');
  // Clear both — env back in play.
  await setChannelBinding(env, GUILD, 'schedule', '');
  eq(await getChannelBinding(env, GUILD, 'schedule'), '1500000000000000777', 'schedule env after clear');
}

console.log('— getChannelBinding precedence');
{
  const env = {
    LOADOUT_BOLTS: makeKv(),
    QUEUE_CHANNEL_ID: '1500000000000000111',   // env fallback
  };
  // No KV override → falls back to env.
  eq(await getChannelBinding(env, GUILD, 'queue'), '1500000000000000111', 'env fallback');
  // KV override wins.
  await env.LOADOUT_BOLTS.put(`channel-binding:${GUILD}:queue`, '1500000000000000222');
  eq(await getChannelBinding(env, GUILD, 'queue'), '1500000000000000222', 'KV wins');
  // KV bad value (not a snowflake) → falls back to env.
  await env.LOADOUT_BOLTS.put(`channel-binding:${GUILD}:queue`, 'not-a-snowflake');
  eq(await getChannelBinding(env, GUILD, 'queue'), '1500000000000000111', 'bad KV → env');
  // env bad too → null.
  const env2 = { LOADOUT_BOLTS: makeKv(), QUEUE_CHANNEL_ID: 'foo' };
  eq(await getChannelBinding(env2, GUILD, 'queue'), null, 'all bad → null');
  // No guildId at all → straight to env.
  eq(await getChannelBinding(env, null, 'queue'), '1500000000000000111', 'no guildId → env');
  // Unknown binding key → null.
  eq(await getChannelBinding(env, GUILD, 'whatever'), null, 'unknown key → null');
}

console.log('— setChannelBinding');
{
  const env = { LOADOUT_BOLTS: makeKv(), QUEUE_CHANNEL_ID: '1500000000000000111' };
  // Set good.
  const r1 = await setChannelBinding(env, GUILD, 'queue', '1500000000000000222');
  eq(r1.ok, true, 'set ok');
  eq(r1.channelId, '1500000000000000222', 'returns the id');
  eq(await getChannelBinding(env, GUILD, 'queue'), '1500000000000000222', 'persisted');
  // Bad channel id.
  const r2 = await setChannelBinding(env, GUILD, 'queue', 'oops');
  eq(r2.ok, false, 'bad-channel-id refused');
  eq(r2.error, 'bad-channel-id', 'error code');
  // Unknown binding.
  const r3 = await setChannelBinding(env, GUILD, 'garbage', '1500000000000000222');
  eq(r3.ok, false, 'unknown binding refused');
  eq(r3.error, 'unknown-binding', 'error code');
  assert(Array.isArray(r3.allowed) && r3.allowed.length === 23, 'lists allowed (23 keys)');
  // No guild.
  const r4 = await setChannelBinding(env, '', 'queue', '1500000000000000222');
  eq(r4.error, 'no-guild-id', 'no-guild-id');
  // Clear path — empty string deletes the KV entry, fallback re-engages.
  const r5 = await setChannelBinding(env, GUILD, 'queue', '');
  eq(r5.ok, true, 'clear ok');
  eq(r5.channelId, null, 'clear returns null channelId');
  eq(r5.fallback, '1500000000000000111', 'fallback resolved');
  eq(await getChannelBinding(env, GUILD, 'queue'), '1500000000000000111', 'env back in play');
}

console.log('— listChannelBindings');
{
  const env = {
    LOADOUT_BOLTS: makeKv(),
    QUEUE_CHANNEL_ID: '1500000000000000111',
    CLIPS_CHANNEL_ID: '1500000000000000333',
  };
  await env.LOADOUT_BOLTS.put(`channel-binding:${GUILD}:queue`, '1500000000000000222');
  const list = await listChannelBindings(env, GUILD);
  eq(Object.keys(list).sort(),
    ['achievements', 'bolts', 'character', 'checkin', 'checkin-results',
     'clips', 'games-list', 'lfg', 'live', 'live-now', 'play', 'poll',
     'queue', 'recap', 'redemptions-feed', 'schedule', 'spire-clears',
     'stream-notifications', 'twitch-rewards-feed',
     'vault-actions', 'vault-events', 'vote', 'welcome'].sort(),
    '23 keys');
  // queue: KV override; resolved = KV.
  eq(list.queue.kv, '1500000000000000222', 'queue kv');
  eq(list.queue.env, '1500000000000000111', 'queue env');
  eq(list.queue.resolved, '1500000000000000222', 'queue resolved = KV');
  // clips: env only; resolved = env.
  eq(list.clips.kv, null, 'clips no kv');
  eq(list.clips.resolved, '1500000000000000333', 'clips resolved = env');
  // recap: neither; resolved null.
  eq(list.recap.kv, null, 'recap no kv');
  eq(list.recap.env, null, 'recap no env');
  eq(list.recap.resolved, null, 'recap null');
}

console.log('— pickLfgChannel: explicit id / name / hints / non-text / null');
{
  const chs = [
    { id: '1', name: 'general',              type: 0 },
    { id: '2', name: '🧩│looking-for-game',  type: 0 },
    { id: '3', name: 'voice-lobby',          type: 2 },   // voice
    { id: '4', name: 'lfg-voice',            type: 2 },
    { id: '5', name: 'looking-for',          type: 0 },
  ];
  // Explicit id.
  eq(pickLfgChannel(chs, { channelId: '2' }), { id: '2', name: '🧩│looking-for-game' }, 'explicit id');
  eq(pickLfgChannel(chs, { channelId: '999' }), null, 'unknown id → null');
  // Name substring.
  eq(pickLfgChannel(chs, { channelName: 'looking' })?.id, '2', 'name substring picks first');
  eq(pickLfgChannel(chs, { channelName: 'NOPE' }), null, 'no match → null');
  // Default hints — order = ['looking-for-game', 'lfg', 'looking-for', '🧩'].
  // Channel #2 contains "looking-for-game", so wins.
  eq(pickLfgChannel(chs, {})?.id, '2', 'default-hint match');
  // Voice channels ignored.
  const onlyVoice = [{ id: '4', name: 'lfg-voice', type: 2 }];
  eq(pickLfgChannel(onlyVoice, {}), null, 'voice-only → null');
  // Hint catalog stable.
  eq(_DEFAULT_LFG_CHANNEL_HINTS_FOR_TEST,
    ['looking-for-game', 'lfg', 'looking-for', '🧩'], 'hint catalog pinned');
}

console.log('— buildHubEmbed exposes the three buttons w/ correct custom_ids');
{
  const env = { LOADOUT_BOLTS: makeKv() };
  const { embed, components } = await buildHubEmbed(env, GUILD);
  assert(/Looking for Game/.test(embed.title), 'title');
  eq(components.length, 1, 'one action row');
  const row = components[0];
  eq(row.components.length, 3, 'three buttons');
  eq(row.components[0].custom_id, 'lfg:create', 'create button');
  eq(row.components[1].custom_id, 'lfg:browse', 'browse button');
  eq(row.components[2].custom_id, 'lfg:close',  'close button');
  eq(row.components[0].label, 'Create LFG post',  'create label');
  eq(row.components[1].label, 'Browse open posts','browse label');
  eq(row.components[2].label, 'Close my post',    'close label');
}

console.log('');
if (failures > 0) {
  console.log('FAILED — ' + failures + ' assertion(s) failed');
  process.exit(1);
}
console.log('PASSED — all assertions ok');
