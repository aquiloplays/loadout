// Standalone harness for the two admin onboarding endpoints in
// onboarding.js (matchInterestRoles, pickWelcomeChannel,
// postWelcomeEmbedForGuild, matchAndSetupGuildRoles).
//
// Coverage:
//   • role matcher: hits + misses for each interest key
//   • role matcher: art-trap (must NOT match "party"/"smart"/"depart")
//   • role matcher: skips @everyone + managed roles
//   • role matcher: first-match-wins when multiple roles fit
//   • channel pick: explicit channelId path (no lookup needed)
//   • channel pick: channelName substring (case-insensitive)
//   • channel pick: default-hint order start-here → welcome →
//                    introductions → 👋
//   • channel pick: ignores non-text-channel (type ≠ 0)
//   • channel pick: returns null when no candidate found
//   • matchAndSetupGuildRoles: persists flat {key: roleId} map to KV;
//     reloadable via loadRoleMap()
//   • postWelcomeEmbedForGuild: explicit channelId path bypasses
//     /guilds/{g}/channels REST call; idempotent (deletes prior)
//
// Run from repo root:
//   node discord-bot/test/test-onboarding-admin.mjs

import {
  matchesInterest,
  matchInterestRoles,
  pickWelcomeChannel,
  postWelcomeEmbedForGuild,
  matchAndSetupGuildRoles,
  loadRoleMap,
  DEFAULT_WELCOME_CHANNEL_HINTS,
  ensureBaselineRoles,
  normaliseRoleSpecs,
  BASELINE_ROLE_SPECS,
} from '../onboarding.js';

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
    _store: store,
  };
}

// fetch stub — settable per test.
let fetchHandler = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (fetchHandler) return fetchHandler(String(input), init || {});
  return new Response('no fetchHandler set', { status: 599 });
};

const GUILD = '1504103035951906883';

// ─────────────────────────────────────────────────────────────────
console.log('— matchesInterest: hits per key');
{
  // gamenight — token-pair + the "gamenight" / "game-night" forms
  assert(matchesInterest('gamenight',   '🎮 Game Night'),       'gamenight: Game Night');
  assert(matchesInterest('gamenight',   'game-night ping'),     'gamenight: game-night ping');
  assert(matchesInterest('gamenight',   'GAMENIGHT'),           'gamenight: GAMENIGHT');
  assert(!matchesInterest('gamenight',  'night owl'),           'gamenight: NOT night owl');
  assert(!matchesInterest('gamenight',  'gamers'),              'gamenight: NOT gamers');

  // boltbound
  assert(matchesInterest('boltbound',   'Boltbound players'),   'boltbound: Boltbound players');
  assert(matchesInterest('boltbound',   'bolt-bound'),          'boltbound: bolt-bound');
  assert(!matchesInterest('boltbound',  'bolts'),               'boltbound: NOT bolts');
  assert(!matchesInterest('boltbound',  'bound'),               'boltbound: NOT bound');

  // boardgames
  assert(matchesInterest('boardgames',  '♟ Board Games'),       'boardgames: Board Games');
  assert(matchesInterest('boardgames',  'boardgames'),          'boardgames: boardgames');
  assert(!matchesInterest('boardgames', 'cardboard'),           'boardgames: NOT cardboard');

  // watching
  assert(matchesInterest('watching',    'Just Watching'),       'watching: Just Watching');
  assert(matchesInterest('watching',    'Lurkers'),             'watching: Lurkers');
  assert(matchesInterest('watching',    'Viewer'),              'watching: Viewer');
  assert(!matchesInterest('watching',   'viewport'),            'watching: NOT viewport');

  // art
  assert(matchesInterest('art',         'Art channel pings'),   'art: Art channel pings');
  assert(matchesInterest('art',         'Artist'),              'art: Artist');
  assert(matchesInterest('art',         '🎨 art'),              'art: 🎨 art');
  // The art trap — must NOT match.
  assert(!matchesInterest('art',        'Party People'),        'art: NOT Party People');
  assert(!matchesInterest('art',        'Smart Mod'),           'art: NOT Smart Mod');
  assert(!matchesInterest('art',        'Departed'),            'art: NOT Departed');
  assert(!matchesInterest('art',        'Cartoon Fans'),        'art: NOT Cartoon Fans');
}

console.log('— matchInterestRoles: full pass');
{
  const roles = [
    { id: GUILD,                 name: '@everyone' },                     // skip — id == guildId
    { id: '900000000000000001',  name: '🎮 Game Night Ping' },
    { id: '900000000000000003',  name: 'Boltbound TCG' },
    { id: '900000000000000004',  name: 'Board Games' },
    { id: '900000000000000005',  name: 'Just Watching' },
    { id: '900000000000000006',  name: '🎨 Artists' },
    { id: '900000000000000007',  name: 'Party People',  managed: false }, // art trap — no match
    { id: '900000000000000008',  name: 'Loadout Bot',   managed: true  }, // skip — managed
    { id: '900000000000000009',  name: '' },                              // skip — empty name
    // Second potential match — first wins for art.
    { id: '900000000000000010',  name: 'Art Drops' },
  ];
  const r = matchInterestRoles(roles, GUILD);
  eq(r.mapped.gamenight,  { id: '900000000000000001', name: '🎮 Game Night Ping' }, 'gamenight matched');
  eq(r.mapped.boltbound,  { id: '900000000000000003', name: 'Boltbound TCG' },      'boltbound matched');
  eq(r.mapped.boardgames, { id: '900000000000000004', name: 'Board Games' },        'boardgames matched');
  eq(r.mapped.watching,   { id: '900000000000000005', name: 'Just Watching' },      'watching matched');
  eq(r.mapped.art,        { id: '900000000000000006', name: '🎨 Artists' },         'art matched (first wins, NOT Art Drops)');
  eq(r.unmapped, [], 'all five mapped');
}

console.log('— matchInterestRoles: gaps');
{
  const roles = [
    { id: GUILD,                 name: '@everyone' },
    { id: '900000000000000001',  name: 'Members' },
    { id: '900000000000000002',  name: 'Mods' },
    { id: '900000000000000003',  name: 'Boltbound TCG' },
  ];
  const r = matchInterestRoles(roles, GUILD);
  eq(Object.keys(r.mapped), ['boltbound'], 'only boltbound mapped');
  eq(r.unmapped.sort(), ['art', 'boardgames', 'gamenight', 'watching'].sort(), 'four unmapped');
}

console.log('— pickWelcomeChannel: explicit channelId');
{
  const chs = [
    { id: '1', name: 'general',   type: 0 },
    { id: '2', name: 'welcome',   type: 0 },
  ];
  const r = pickWelcomeChannel(chs, { channelId: '2' });
  eq(r, { id: '2', name: 'welcome' }, 'explicit channelId honored');
  // Bad id → null (caller can decide whether to fall through; the
  // admin route shortcuts past the lookup when channelId is supplied
  // anyway, so an invalid id surfaces as a Discord POST error).
  const r2 = pickWelcomeChannel(chs, { channelId: '999' });
  eq(r2, null, 'unknown channelId returns null');
}

console.log('— pickWelcomeChannel: channelName substring');
{
  const chs = [
    { id: '1', name: 'general',           type: 0 },
    { id: '2', name: '👋│introductions',  type: 0 },
    { id: '3', name: 'welcome-here',      type: 0 },
  ];
  // Lowercased substring match — picks first.
  const r = pickWelcomeChannel(chs, { channelName: 'WELCOME' });
  eq(r, { id: '3', name: 'welcome-here' }, 'case-insensitive substring');
  const r2 = pickWelcomeChannel(chs, { channelName: 'intro' });
  eq(r2, { id: '2', name: '👋│introductions' }, 'partial substring');
  const r3 = pickWelcomeChannel(chs, { channelName: 'nope' });
  eq(r3, null, 'no match returns null');
}

console.log('— pickWelcomeChannel: default-hint order');
{
  eq(DEFAULT_WELCOME_CHANNEL_HINTS, ['start-here', 'welcome', 'introductions', '👋'], 'hint order pinned');
  // welcome present but start-here also present — start-here wins.
  const chs = [
    { id: '1', name: 'random',          type: 0 },
    { id: '2', name: 'welcome-back',    type: 0 },
    { id: '3', name: 'start-here-now',  type: 0 },
  ];
  const r = pickWelcomeChannel(chs, {});
  eq(r.id, '3', 'start-here hint wins over welcome');
  // No start-here, just welcome.
  const chs2 = [
    { id: '1', name: 'random',          type: 0 },
    { id: '2', name: 'welcome-back',    type: 0 },
  ];
  const r2 = pickWelcomeChannel(chs2, {});
  eq(r2.id, '2', 'welcome hint matches when start-here absent');
  // Falls through to 👋 emoji match.
  const chs3 = [
    { id: '1', name: 'general',         type: 0 },
    { id: '2', name: '👋│hi',           type: 0 },
  ];
  const r3 = pickWelcomeChannel(chs3, {});
  eq(r3.id, '2', '👋 emoji hint matches as last resort');
  // No candidates at all.
  const chs4 = [{ id: '1', name: 'random', type: 0 }];
  eq(pickWelcomeChannel(chs4, {}), null, 'nothing matches → null');
}

console.log('— pickWelcomeChannel: ignores non-text channels');
{
  const chs = [
    { id: '1', name: 'Welcome VC',      type: 2 },   // voice
    { id: '2', name: 'welcome stage',   type: 13 },  // stage
    { id: '3', name: 'welcome-text',    type: 0 },
  ];
  const r = pickWelcomeChannel(chs, {});
  eq(r, { id: '3', name: 'welcome-text' }, 'only GUILD_TEXT (type 0) considered');
}

console.log('— matchAndSetupGuildRoles: persists flat map, loadRoleMap reads it back');
{
  const env = { LOADOUT_BOLTS: makeKv(), DISCORD_BOT_TOKEN: 'fake' };
  fetchHandler = async (url) => {
    if (url.endsWith(`/guilds/${GUILD}/roles`)) {
      return new Response(JSON.stringify([
        { id: GUILD,                name: '@everyone' },
        { id: '900000000000000001', name: '🎮 Game Night' },
        { id: '900000000000000002', name: 'Boltbound' },
      ]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('?', { status: 500 });
  };
  const r = await matchAndSetupGuildRoles(env, GUILD);
  fetchHandler = null;
  assert(r.ok, 'ok:true');
  eq(r.mapped.gamenight.id, '900000000000000001', 'gamenight id');
  eq(r.mapped.boltbound.id, '900000000000000002', 'boltbound id');
  eq(r.unmapped.sort(), ['art', 'boardgames', 'watching'].sort(), 'three unmapped');
  // loadRoleMap reads back the flat form.
  const m = await loadRoleMap(env, GUILD);
  eq(m, { gamenight: '900000000000000001', boltbound: '900000000000000002' }, 'persisted map round-trips');
}

console.log('— matchAndSetupGuildRoles: REST failure surfaces');
{
  const env = { LOADOUT_BOLTS: makeKv(), DISCORD_BOT_TOKEN: 'fake' };
  fetchHandler = async () => new Response('forbidden', { status: 403 });
  const r = await matchAndSetupGuildRoles(env, GUILD);
  fetchHandler = null;
  eq(r.ok, false, 'ok:false');
  eq(r.error, 'roles-fetch-failed', 'error code');
  eq(r.status, 403, 'status echoed');
}

console.log('— postWelcomeEmbedForGuild: explicit channelId path');
{
  const env = { LOADOUT_BOLTS: makeKv(), DISCORD_BOT_TOKEN: 'fake' };
  const calls = [];
  fetchHandler = async (url, init) => {
    calls.push({ url, method: init.method });
    if (init.method === 'POST' && /\/channels\/\d+\/messages$/.test(url)) {
      return new Response(JSON.stringify({ id: '950000000000000123' }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  const r = await postWelcomeEmbedForGuild(env, GUILD, { channelId: '1500000000000000099' });
  fetchHandler = null;
  assert(r.ok, 'ok:true');
  eq(r.channelId, '1500000000000000099', 'channelId echoed');
  eq(r.messageId, '950000000000000123', 'messageId returned');
  // No /guilds/{g}/channels call since channelId was explicit.
  assert(!calls.some(c => c.url.includes('/guilds/')), 'NO /guilds/ REST call when channelId given');
}

console.log('— postWelcomeEmbedForGuild: looks up channel by name + deletes prior');
{
  const env = { LOADOUT_BOLTS: makeKv(), DISCORD_BOT_TOKEN: 'fake' };
  // Pre-seed a prior welcome message — should get DELETEd first.
  await env.LOADOUT_BOLTS.put(`onboard:welcome-msg:${GUILD}`,
    JSON.stringify({ channelId: '9999', messageId: '8888', postedAt: 1 }));

  const seen = [];
  fetchHandler = async (url, init) => {
    seen.push({ url, method: init.method });
    if (init.method === 'DELETE' && url.endsWith('/channels/9999/messages/8888')) {
      return new Response(null, { status: 204 });
    }
    if (url.endsWith(`/guilds/${GUILD}/channels`)) {
      return new Response(JSON.stringify([
        { id: '1', name: 'general',            type: 0 },
        { id: '2', name: '👋│welcome-friends', type: 0 },
      ]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (init.method === 'POST' && url.endsWith('/channels/2/messages')) {
      return new Response(JSON.stringify({ id: '950000000000000777' }), { status: 200 });
    }
    return new Response('?', { status: 500 });
  };
  const r = await postWelcomeEmbedForGuild(env, GUILD, {});   // default hints
  fetchHandler = null;

  assert(r.ok, 'ok:true');
  eq(r.channelId, '2', 'picked welcome channel');
  eq(r.channelName, '👋│welcome-friends', 'channel name echoed');
  eq(r.messageId, '950000000000000777', 'fresh message id');
  assert(r.deletedPrior, 'deletedPrior:true');
  assert(seen.some(c => c.method === 'DELETE' && c.url.endsWith('/channels/9999/messages/8888')),
         'prior welcome was DELETEd');
  // KV pointer updated to the new message.
  const meta = await env.LOADOUT_BOLTS.get(`onboard:welcome-msg:${GUILD}`, { type: 'json' });
  eq(meta.messageId, '950000000000000777', 'KV welcome-msg id rewritten');
}

console.log('— postWelcomeEmbedForGuild: no channel candidate → 404-style error');
{
  const env = { LOADOUT_BOLTS: makeKv(), DISCORD_BOT_TOKEN: 'fake' };
  fetchHandler = async (url) => {
    if (url.endsWith(`/guilds/${GUILD}/channels`)) {
      return new Response(JSON.stringify([{ id: '1', name: 'random', type: 0 }]),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('?', { status: 500 });
  };
  const r = await postWelcomeEmbedForGuild(env, GUILD, {});
  fetchHandler = null;
  eq(r.ok, false, 'ok:false');
  eq(r.error, 'no-channel-match', 'error code');
  assert(Array.isArray(r.tried), 'returns tried list');
}

console.log('— BASELINE_ROLE_SPECS sanity');
{
  eq(BASELINE_ROLE_SPECS.map(s => s.key),
     ['boltbound', 'boardgames', 'watching', 'art'],
     'baseline keys in spec order');
  // Each one matches its own heuristic — important, otherwise a freshly
  // created role wouldn't get re-picked up by matchAndSetupGuildRoles.
  for (const s of BASELINE_ROLE_SPECS) {
    assert(matchesInterest(s.key, s.name), `${s.key}: name "${s.name}" matches its own heuristic`);
  }
}

console.log('— normaliseRoleSpecs');
{
  const cleaned = normaliseRoleSpecs([
    { key: 'boltbound', name: '  Boltbound  ', color: 0x123456 },
    { key: 'NOT_A_KEY', name: 'whatever' },                  // dropped
    { key: 'art', name: '' },                                // dropped — empty name
    { key: 'art', name: 'Artists', color: 'bad', hoist: true },
    { key: 'watching', name: 'Just Watching' },              // no color → 0
  ]);
  eq(cleaned.length, 3, '3 valid out of 5 input');
  eq(cleaned[0].name, 'Boltbound', 'name trimmed');
  eq(cleaned[0].color, 0x123456, 'color preserved');
  eq(cleaned[0].mentionable, true, 'mentionable default true');
  eq(cleaned[0].hoist, false, 'hoist default false');
  eq(cleaned[0].permissions, '0', 'permissions default "0"');
  eq(cleaned[1].color, 0, 'non-integer color → 0');
  eq(cleaned[1].hoist, true, 'hoist:true honored when explicit');
  // Defaults applied when missing.
  eq(cleaned[2].color, 0, 'missing color → 0');
}

console.log('— ensureBaselineRoles: defaults + creates missing');
{
  const env = { LOADOUT_BOLTS: makeKv(), DISCORD_BOT_TOKEN: 'fake' };
  const created = [];
  fetchHandler = async (url, init) => {
    if (init.method === 'GET' || !init.method) {
      // /guilds/{g}/roles list — pretend only "Game Night" exists.
      if (url.endsWith(`/guilds/${GUILD}/roles`)) {
        return new Response(JSON.stringify([
          { id: GUILD,                name: '@everyone' },
          { id: '900000000000000001', name: 'Game Night' },
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }
    if (init.method === 'POST' && url.endsWith(`/guilds/${GUILD}/roles`)) {
      const body = JSON.parse(init.body);
      const id = '950000000000000' + (100 + created.length);
      created.push({ id, body, auditReason: init.headers['X-Audit-Log-Reason'] });
      return new Response(JSON.stringify({ id, name: body.name, color: body.color }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('?', { status: 500 });
  };
  const r = await ensureBaselineRoles(env, GUILD);   // default specs
  fetchHandler = null;

  assert(r.ok, 'ok:true');
  // 4 baseline keys minus already-present 0 = 4 creates (Game Night
  // covers gamenight which ISN\'T in BASELINE_ROLE_SPECS, so no overlap).
  eq(r.created.length, 4, 'created 4 roles');
  eq(r.created.map(c => c.key).sort(), ['art', 'boardgames', 'boltbound', 'watching'].sort(),
     'all 4 baseline keys created');
  // Each create POST'd with permissions:"0", mentionable:true, hoist:false.
  for (const c of created) {
    eq(c.body.permissions, '0',   `${c.body.name}: permissions "0"`);
    eq(c.body.mentionable, true,  `${c.body.name}: mentionable true`);
    eq(c.body.hoist,       false, `${c.body.name}: hoist false`);
  }
  // Audit-log reason set per create (handy for guild owners scanning audit log).
  assert(created.every(c => /aquilo onboarding/.test(c.auditReason || '')),
         'X-Audit-Log-Reason set on every create');
  eq(r.skipped, [], 'no skips');
}

console.log('— ensureBaselineRoles: skips already-existing matches (no dupes)');
{
  const env = { LOADOUT_BOLTS: makeKv(), DISCORD_BOT_TOKEN: 'fake' };
  let createCount = 0;
  fetchHandler = async (url, init) => {
    if (!init.method || init.method === 'GET') {
      if (url.endsWith(`/guilds/${GUILD}/roles`)) {
        // Pre-existing: Boltbound + Just Watching already manually made.
        return new Response(JSON.stringify([
          { id: GUILD,                name: '@everyone' },
          { id: '900000000000000010', name: 'Boltbound' },
          { id: '900000000000000011', name: 'Just Watching' },
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }
    if (init.method === 'POST' && url.endsWith(`/guilds/${GUILD}/roles`)) {
      createCount++;
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: '950000999999999' + createCount, name: body.name }),
        { status: 200 });
    }
    return new Response('?', { status: 500 });
  };
  const r = await ensureBaselineRoles(env, GUILD);
  fetchHandler = null;
  assert(r.ok, 'ok:true');
  // 2 created (boardgames, art), 2 skipped (boltbound, watching).
  eq(createCount, 2, 'only 2 POSTs made');
  eq(r.created.map(c => c.key).sort(), ['art', 'boardgames'].sort(), 'created keys');
  eq(r.skipped.length, 2, 'two skipped');
  const skipMap = Object.fromEntries(r.skipped.map(s => [s.key, s]));
  eq(skipMap.boltbound.reason, 'already-exists', 'boltbound skip reason');
  eq(skipMap.boltbound.existing.id, '900000000000000010', 'boltbound existing id');
  eq(skipMap.watching.reason, 'already-exists', 'watching skip reason');
}

console.log('— ensureBaselineRoles: skips managed + @everyone correctly');
{
  const env = { LOADOUT_BOLTS: makeKv(), DISCORD_BOT_TOKEN: 'fake' };
  fetchHandler = async (url, init) => {
    if (!init.method || init.method === 'GET') {
      if (url.endsWith(`/guilds/${GUILD}/roles`)) {
        return new Response(JSON.stringify([
          { id: GUILD,                name: '@everyone' },
          // A managed role NAMED "Boltbound" (e.g. some bot's integration role).
          // matchesInterest would normally hit this, but we want to skip
          // it because users can't be assigned managed roles.
          { id: '900000000000000020', name: 'Boltbound', managed: true },
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }
    if (init.method === 'POST' && url.endsWith(`/guilds/${GUILD}/roles`)) {
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: '950100000000000001', name: body.name }), { status: 200 });
    }
    return new Response('?', { status: 500 });
  };
  const r = await ensureBaselineRoles(env, GUILD, [{ key: 'boltbound', name: 'Boltbound', color: 0x3a82ff }]);
  fetchHandler = null;
  assert(r.ok, 'ok:true');
  // The managed role doesn\'t count as a pre-existing match, so we
  // proceed to create our own opt-in version.
  eq(r.created.length, 1, 'created 1 (managed role ignored)');
  eq(r.created[0].key, 'boltbound', 'boltbound created');
}

console.log('— ensureBaselineRoles: surfaces Discord create failures per-key');
{
  const env = { LOADOUT_BOLTS: makeKv(), DISCORD_BOT_TOKEN: 'fake' };
  fetchHandler = async (url, init) => {
    if (!init.method || init.method === 'GET') {
      if (url.endsWith(`/guilds/${GUILD}/roles`)) {
        return new Response(JSON.stringify([{ id: GUILD, name: '@everyone' }]),
          { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }
    if (init.method === 'POST' && url.endsWith(`/guilds/${GUILD}/roles`)) {
      const body = JSON.parse(init.body);
      // Fail the "Art" create with 403 (e.g. role-count limit hit);
      // succeed the others. Flow continues per-key.
      if (body.name === 'Art') return new Response('forbidden', { status: 403 });
      return new Response(JSON.stringify({ id: '95010000000000' + body.name.length, name: body.name }),
        { status: 200 });
    }
    return new Response('?', { status: 500 });
  };
  const r = await ensureBaselineRoles(env, GUILD);
  fetchHandler = null;
  assert(r.ok, 'overall ok:true even with per-key failure');
  eq(r.created.length, 3, '3 successes');
  eq(r.skipped.length, 1, '1 failure surfaced as skip');
  eq(r.skipped[0].key, 'art', 'art is the failure');
  eq(r.skipped[0].reason, 'create-failed', 'reason create-failed');
  eq(r.skipped[0].status, 403, 'status echoed');
}

console.log('— ensureBaselineRoles: full idempotent re-run is all-skips');
{
  // First pass creates everything; second pass against the same
  // (now-populated) guild should be all-skip with reason
  // already-exists for every baseline key.
  const guildRoles = [{ id: GUILD, name: '@everyone' }];
  const env = { LOADOUT_BOLTS: makeKv(), DISCORD_BOT_TOKEN: 'fake' };
  fetchHandler = async (url, init) => {
    if ((!init.method || init.method === 'GET') && url.endsWith(`/guilds/${GUILD}/roles`)) {
      return new Response(JSON.stringify(guildRoles), { status: 200 });
    }
    if (init.method === 'POST' && url.endsWith(`/guilds/${GUILD}/roles`)) {
      const body = JSON.parse(init.body);
      const id = '950110' + (guildRoles.length).toString().padStart(13, '0');
      guildRoles.push({ id, name: body.name });
      return new Response(JSON.stringify({ id, name: body.name }), { status: 200 });
    }
    return new Response('?', { status: 500 });
  };
  const r1 = await ensureBaselineRoles(env, GUILD);
  eq(r1.created.length, 4, 'first pass creates 4');
  const r2 = await ensureBaselineRoles(env, GUILD);
  fetchHandler = null;
  eq(r2.created.length, 0, 'second pass creates 0');
  eq(r2.skipped.length, 4, 'second pass skips 4');
  assert(r2.skipped.every(s => s.reason === 'already-exists'), 'all skips are already-exists');
}

console.log('');
globalThis.fetch = realFetch;
if (failures > 0) {
  console.log('FAILED — ' + failures + ' assertion(s) failed');
  process.exit(1);
}
console.log('PASSED — all assertions ok');
