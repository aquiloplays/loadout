// Standalone harness for the Twitch wiring (twitch-eventsub.js +
// twitch-clips.js + weekly-recap.js).
//
// Coverage:
//   • EventSub HMAC signature verification — matching, mismatching,
//     malformed, missing prefix, wrong-length-but-same-prefix.
//   • EventSub replay protection — second delivery with same
//     message-id swallowed (returns 200 without re-processing).
//   • EventSub challenge handshake responds 200 with the challenge
//     verbatim, plain text.
//   • EventSub revocation acks 200.
//   • EventSub bad-signature returns 403 (no work done).
//   • twitch-helix isTwitchConfigured guard.
//   • twitch-clips ISO-week helper round-trips.
//   • weekly-recap ISO-week idempotency + isoWeek correctness across
//     ISO year-boundary.
//
// Run from repo root:
//   node discord-bot/test/test-twitch.mjs

import {
  verifyEventSubSignature,
  handleEventSubWebhook,
  setupTwitchSubscriptions,
  listTwitchSubscriptions,
} from '../twitch-eventsub.js';
import { isTwitchConfigured, hasTwitchUserAuth } from '../twitch-helix.js';
import {
  EVENT_COLORS, EVENT_TYPES, isValidEventType,
  followEmbed, subEmbed, resubEmbed, giftSubEmbed, cheerEmbed,
  raidEmbed, redemptionEmbed, hypeTrainBeginEmbed, pollEndEmbed,
  predictionEndEmbed, banEmbed, unbanEmbed,
  resolveEventChannel, eventTypeEnabled,
  setEventChannel, setEventToggle, listEventRoutes,
} from '../twitch-events.js';
import { _isoWeekForTest as clipIsoWeek } from '../twitch-clips.js';
import { _isoWeekForTest as recapIsoWeek, postWeeklyRecap } from '../weekly-recap.js';

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
    async put(key, value, opts) { store.set(key, value); },
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

// Compute the Twitch signature for a synthetic message — used both
// to feed valid inputs to the verifier and to construct a realistic
// webhook request.
async function sign(secret, messageId, timestamp, body) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key,
    new TextEncoder().encode(messageId + timestamp + body));
  return 'sha256=' + Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

const SECRET = 'super-secret-test-value-not-the-real-one';

// ─────────────────────────────────────────────────────────────────
console.log('— verifyEventSubSignature: happy + sad paths');
{
  const id   = 'msg-12345';
  const ts   = '2026-05-26T00:00:00Z';
  const body = JSON.stringify({ subscription: { type: 'stream.online' } });
  const sig  = await sign(SECRET, id, ts, body);
  assert(await verifyEventSubSignature(SECRET, id, ts, body, sig),         'matching signature accepted');
  assert(!await verifyEventSubSignature('wrong-secret', id, ts, body, sig), 'wrong secret rejected');
  assert(!await verifyEventSubSignature(SECRET, 'wrong-id', ts, body, sig), 'tampered message-id rejected');
  assert(!await verifyEventSubSignature(SECRET, id, 'wrong-ts', body, sig), 'tampered timestamp rejected');
  assert(!await verifyEventSubSignature(SECRET, id, ts, body + 'x', sig),   'tampered body rejected');
  assert(!await verifyEventSubSignature(SECRET, id, ts, body, ''),          'empty header rejected');
  assert(!await verifyEventSubSignature(SECRET, id, ts, body, 'md5=' + sig.slice(7)),
         'wrong algorithm prefix rejected');
  // Same-prefix-different-bytes — must still reject.
  const tampered = 'sha256=' + 'a'.repeat(sig.length - 'sha256='.length);
  assert(!await verifyEventSubSignature(SECRET, id, ts, body, tampered),    'mismatched signature bytes rejected');
  // Null / missing inputs.
  assert(!await verifyEventSubSignature('', id, ts, body, sig),             'empty secret rejected');
  assert(!await verifyEventSubSignature(SECRET, '', ts, body, sig),         'empty messageId rejected');
}

console.log('— EventSub webhook: challenge handshake');
{
  const env = { LOADOUT_BOLTS: makeKv(), TWITCH_EVENTSUB_SECRET: SECRET };
  const body = JSON.stringify({ challenge: 'ping-1234', subscription: { id: 's1' } });
  const id   = 'challenge-1';
  const ts   = '2026-05-26T01:00:00Z';
  const sig  = await sign(SECRET, id, ts, body);
  const req  = new Request('https://w/twitch/eventsub', {
    method: 'POST',
    headers: {
      'twitch-eventsub-message-id': id,
      'twitch-eventsub-message-type': 'webhook_callback_verification',
      'twitch-eventsub-message-timestamp': ts,
      'twitch-eventsub-message-signature': sig,
      'content-type': 'application/json',
    },
    body,
  });
  const ctx = { waitUntil: () => {} };
  const resp = await handleEventSubWebhook(req, env, ctx);
  eq(resp.status, 200, 'challenge → 200');
  eq(await resp.text(), 'ping-1234', 'challenge echoed verbatim');
  eq(resp.headers.get('content-type'), 'text/plain', 'plain-text content-type');
}

console.log('— EventSub webhook: bad signature → 403, no handler run');
{
  const env = { LOADOUT_BOLTS: makeKv(), TWITCH_EVENTSUB_SECRET: SECRET };
  const calls = [];
  const ctx = { waitUntil: (p) => calls.push(p) };
  const body = JSON.stringify({
    subscription: { type: 'stream.online' },
    event: { broadcaster_user_id: '1497793223' },
  });
  const req = new Request('https://w/twitch/eventsub', {
    method: 'POST',
    headers: {
      'twitch-eventsub-message-id': 'bad-1',
      'twitch-eventsub-message-type': 'notification',
      'twitch-eventsub-message-timestamp': '2026-05-26T01:00:00Z',
      'twitch-eventsub-message-signature': 'sha256=' + 'f'.repeat(64),
      'content-type': 'application/json',
    },
    body,
  });
  const resp = await handleEventSubWebhook(req, env, ctx);
  eq(resp.status, 403, 'bad sig → 403');
  eq(calls.length, 0, 'no waitUntil scheduled (handler never ran)');
}

console.log('— EventSub webhook: notification + replay swallow');
{
  const env = { LOADOUT_BOLTS: makeKv(), TWITCH_EVENTSUB_SECRET: SECRET };
  const calls = [];
  const ctx = { waitUntil: (p) => calls.push(p) };
  const id = 'notify-1';
  const ts = '2026-05-26T02:00:00Z';
  const body = JSON.stringify({
    subscription: { type: 'stream.online' },
    event: { broadcaster_user_id: '1497793223' },
  });
  const sig = await sign(SECRET, id, ts, body);
  const make = () => new Request('https://w/twitch/eventsub', {
    method: 'POST',
    headers: {
      'twitch-eventsub-message-id': id,
      'twitch-eventsub-message-type': 'notification',
      'twitch-eventsub-message-timestamp': ts,
      'twitch-eventsub-message-signature': sig,
      'content-type': 'application/json',
    },
    body,
  });
  const r1 = await handleEventSubWebhook(make(), env, ctx);
  eq(r1.status, 204, 'first delivery → 204');
  // stream.online schedules TWO work units:
  //   1. twitch-live.js edit-in-place lifecycle card (postLiveEmbed)
  //   2. live-status-embed.js dashboard handler (per-minute refresh)
  // The bigger announce embed was removed — Clay's lifecycle card IS
  // the going-live notif; the dashboard is a separate refreshing
  // surface in 1507973917350957067.
  eq(calls.length, 2, 'two waitUntil queued (lifecycle + dashboard)');
  // Replay — same message-id. Should be swallowed without scheduling.
  const r2 = await handleEventSubWebhook(make(), env, ctx);
  eq(r2.status, 200, 'replay → 200');
  eq(calls.length, 2, 'no extra waitUntil on replay');
}

console.log('— EventSub webhook: revocation acks 200');
{
  const env = { LOADOUT_BOLTS: makeKv(), TWITCH_EVENTSUB_SECRET: SECRET };
  const ctx = { waitUntil: () => {} };
  const body = JSON.stringify({ subscription: { id: 'sub-x', type: 'stream.online', status: 'authorization_revoked' } });
  const id = 'revoke-1';
  const ts = '2026-05-26T03:00:00Z';
  const sig = await sign(SECRET, id, ts, body);
  const req = new Request('https://w/twitch/eventsub', {
    method: 'POST',
    headers: {
      'twitch-eventsub-message-id': id,
      'twitch-eventsub-message-type': 'revocation',
      'twitch-eventsub-message-timestamp': ts,
      'twitch-eventsub-message-signature': sig,
      'content-type': 'application/json',
    },
    body,
  });
  const resp = await handleEventSubWebhook(req, env, ctx);
  eq(resp.status, 200, 'revocation → 200');
}

console.log('— EventSub webhook: no secret configured → 503');
{
  const env = { LOADOUT_BOLTS: makeKv() /* no TWITCH_EVENTSUB_SECRET */ };
  const req = new Request('https://w/twitch/eventsub', { method: 'POST', body: '{}' });
  const resp = await handleEventSubWebhook(req, env, { waitUntil: () => {} });
  eq(resp.status, 503, 'unconfigured → 503');
}

console.log('— twitch-helix: isTwitchConfigured guard');
{
  assert(!isTwitchConfigured(null),                                  'null env → false');
  assert(!isTwitchConfigured({}),                                    'empty env → false');
  assert(!isTwitchConfigured({ TWITCH_CLIENT_ID: 'x' }),             'only id → false');
  assert(!isTwitchConfigured({ TWITCH_CLIENT_SECRET: 'y' }),         'only secret → false');
  assert(isTwitchConfigured({ TWITCH_CLIENT_ID: 'x', TWITCH_CLIENT_SECRET: 'y' }), 'both → true');
}

console.log('— ISO week helper');
{
  // 2026-05-26 is a Tuesday → ISO week 22 of 2026.
  eq(clipIsoWeek(new Date('2026-05-26T12:00:00Z')),  '2026-W22', 'Tue mid-week 2026');
  eq(recapIsoWeek(new Date('2026-05-26T12:00:00Z')), '2026-W22', 'recap helper matches clip helper');
  // ISO week year-boundary: Jan 1 2027 is a Friday → ISO 2026-W53.
  eq(clipIsoWeek(new Date('2027-01-01T12:00:00Z')),  '2026-W53', 'Jan 1 2027 → 2026-W53');
  // Jan 4 is always in week 1 of its ISO year.
  eq(clipIsoWeek(new Date('2026-01-04T12:00:00Z')),  '2026-W01', 'Jan 4 2026 → 2026-W01');
  // Sunday at end of week — should belong to the same ISO week as
  // the preceding Mon-Sat (not yet rolled over).
  eq(clipIsoWeek(new Date('2026-05-31T23:00:00Z')),  '2026-W22', 'Sun end of W22 still W22');
}

console.log('— weekly-recap: ISO-week idempotency');
{
  const env = {
    LOADOUT_BOLTS: makeKv(),
    DISCORD_BOT_TOKEN: 'fake',
    RECAP_CHANNEL_ID: '999000000000000001',
    AQUILO_VAULT_GUILD_ID: '1504103035951906883',
  };
  // Stub Discord POST so postWeeklyRecap doesn\'t actually fetch.
  const realFetch = globalThis.fetch;
  let postCount = 0;
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST' && /\/channels\/.+\/messages$/.test(String(url))) {
      postCount += 1;
      return new Response(JSON.stringify({ id: '950000' + postCount }), { status: 200 });
    }
    return new Response('?', { status: 500 });
  };
  const r1 = await postWeeklyRecap(env);
  globalThis.fetch = realFetch;
  assert(r1.ok, 'first call posts');
  assert(r1.week, 'returns week');
  // KV marker now stamped — re-running same week is a skip.
  globalThis.fetch = async () => new Response('SHOULD NOT FETCH', { status: 500 });
  const r2 = await postWeeklyRecap(env);
  globalThis.fetch = realFetch;
  eq(r2.skipped, 'already-posted-this-week', 'second call skipped');
  eq(r2.week, r1.week, 'same week value');
  eq(postCount, 1, 'exactly one POST');
}

console.log('— weekly-recap: skips cleanly when no channel');
{
  // With the channel-binding refactor the recap now needs (bot token,
  // guild id, recap channel) — any missing → skip with the matching
  // reason code. Test all three skip paths.
  eq((await postWeeklyRecap({ LOADOUT_BOLTS: makeKv() })).skipped,
    'no-bot-token', 'no token → no-bot-token');
  eq((await postWeeklyRecap({ LOADOUT_BOLTS: makeKv(), DISCORD_BOT_TOKEN: 'x' })).skipped,
    'no-guild-id', 'no guild → no-guild-id');
  eq((await postWeeklyRecap({
    LOADOUT_BOLTS: makeKv(),
    DISCORD_BOT_TOKEN: 'x',
    AQUILO_VAULT_GUILD_ID: '1504103035951906883',
  })).skipped, 'no-recap-channel', 'no channel binding → no-recap-channel');
}

// ─────────────────────────────────────────────────────────────────
// twitch-events.js — embed builders + routing
// ─────────────────────────────────────────────────────────────────

console.log('— twitch-events: brand palette + event catalogue');
{
  // Per Clay's 2026-05 spec — aquilo trio only (violet/pink/green/grey),
  // no more gold/orange/bright-red. Gradients live on the banner image.
  const VIOLET = 0x7c5cff, PINK = 0xff6ab5, GREEN = 0x5bff95, GREY = 0x6e7588;
  eq(EVENT_COLORS.follow,           VIOLET, 'follow violet');
  eq(EVENT_COLORS.sub,              PINK,   'sub pink');
  eq(EVENT_COLORS.gift,             GREEN,  'gift green');
  eq(EVENT_COLORS.cheer,            PINK,   'cheer now pink (not gold)');
  eq(EVENT_COLORS.raid,             PINK,   'raid now pink (not orange)');
  eq(EVENT_COLORS.ended,            GREY,   'stream end subdued grey');
  eq(EVENT_COLORS.ban,              GREY,   'ban subdued grey');
  eq(EVENT_COLORS.unban,            GREEN,  'unban green');
  // Catalogue contains the documented event types.
  for (const t of ['follow','sub','gift','resub','cheer','raid','ended',
                   'redemption','hypeTrainBegin','hypeTrainProgress','hypeTrainEnd',
                   'pollBegin','pollEnd','predictionBegin','predictionEnd','ban','unban']) {
    assert(EVENT_TYPES.includes(t),       `EVENT_TYPES contains ${t}`);
    assert(isValidEventType(t),           `${t} validates`);
  }
  assert(!isValidEventType('garbage-event'), 'unknown event-type rejected');
}

console.log('— embed builders: smoke-test each renders something sensible');
{
  const fe = followEmbed({ userName: 'Alice', followedAt: '2026-05-27T10:00:00Z' }, 42);
  eq(fe.color, EVENT_COLORS.follow,  'follow embed colour');
  assert(/Alice/.test(JSON.stringify(fe)), 'follow embed names user');
  assert(/42/.test(fe.footer?.text || ''), 'follow embed footer shows counter');
  // New: every embed carries a gradient banner via image.url.
  assert(/twitch-banner\/follow/.test(fe.image?.url || ''), 'follow embed has follow banner');

  // Tier-specific sub banner: t1, t2, t3.
  const sT1 = subEmbed({ userName: 'X', tier: '1000' }, 1);
  const sT2 = subEmbed({ userName: 'X', tier: '2000' }, 1);
  const sT3 = subEmbed({ userName: 'X', tier: '3000' }, 1);
  assert(/sub-t1/.test(sT1.image?.url || ''), 'sub T1 → sub-t1 banner');
  assert(/sub-t2/.test(sT2.image?.url || ''), 'sub T2 → sub-t2 banner');
  assert(/sub-t3/.test(sT3.image?.url || ''), 'sub T3 → sub-t3 banner');
  // Prime falls back to T1 banner.
  const sPrime = subEmbed({ userName: 'X', tier: 'Prime' }, 1);
  assert(/sub-t1/.test(sPrime.image?.url || ''), 'Prime sub → sub-t1 banner');

  const se = subEmbed({ userName: 'Bob', tier: '2000' }, 7);
  assert(/Tier 2/.test(JSON.stringify(se)), 'sub embed shows tier label');
  assert(/Bob/.test(JSON.stringify(se)),    'sub embed names user');

  const re = resubEmbed({ userName: 'Cara', tier: '1000', cumulativeMonths: 12, streakMonths: 6, message: 'love the show' }, 99);
  assert(/Cara/.test(JSON.stringify(re)),   'resub embed names user');
  assert(/12.*months/i.test(JSON.stringify(re)),  'resub embed surfaces cumulative months');
  assert(/streak/i.test(JSON.stringify(re)), 'resub embed mentions streak');
  assert(/love the show/.test(JSON.stringify(re)), 'resub embed includes message');

  // Event-type label now lives on the banner image, NOT in embed.title.
  // Builder assertions check the description copy + banner URL instead.
  const ge = giftSubEmbed({ gifterName: 'Dan', tier: '1000', total: 5, cumulativeTotal: 20, isAnon: false });
  assert(/Dan/.test(JSON.stringify(ge)),         'gift embed names gifter');
  assert(/5/.test(ge.description),               'community gift surfaces count in description');
  assert(/twitch-banner\/gift/.test(ge.image?.url || ''), 'gift embed has gift banner');

  const gA = giftSubEmbed({ tier: '1000', total: 1, isAnon: true });
  assert(/anonymous/i.test(JSON.stringify(gA)),  'anon gifter rendered as anonymous');

  const ch = cheerEmbed({ userName: 'Eve', bits: 5000, message: 'hyped' });
  assert(/HUGE CHEER/i.test(ch.description),     '5k bits → HUGE CHEER label in description');
  assert(/hyped/.test(JSON.stringify(ch)),       'cheer message included');
  assert(/twitch-banner\/cheer/.test(ch.image?.url || ''), 'cheer embed has cheer banner');

  const chSmall = cheerEmbed({ userName: 'Felix', bits: 50 });
  assert(/Cheer/.test(chSmall.description),      '50 bits → small Cheer label in description');

  const ra = raidEmbed({ fromBroadcasterName: 'Greta', fromBroadcasterLogin: 'greta', viewers: 432 });
  assert(/432/.test(JSON.stringify(ra)),         'raid embed surfaces viewer count');
  assert(/twitch-banner\/raid/.test(ra.image?.url || ''), 'raid embed has raid banner');

  const rd = redemptionEmbed({ userName: 'Hank', rewardTitle: 'Hydrate Reminder', rewardCost: 500 });
  assert(/Hydrate Reminder/.test(JSON.stringify(rd)), 'redemption embed shows reward title');
  assert(/500/.test(JSON.stringify(rd)),         'redemption embed shows cost');
  assert(/twitch-banner\/redemption/.test(rd.image?.url || ''), 'redemption embed has redemption banner');

  const ht = hypeTrainBeginEmbed({ level: 2, total: 1200, goal: 2000, expiresAt: '2026-05-27T11:00:00Z' });
  assert(/Level\s*2/.test(ht.description),       'hype train shows level');
  assert(/twitch-banner\/hype/.test(ht.image?.url || ''), 'hype train uses hype banner');

  const pe = pollEndEmbed({ title: 'Choose game', choices: [
    { id: '1', title: 'A', votes: 10 },
    { id: '2', title: 'B', votes: 25 },
  ]});
  assert(/Choose game/.test(pe.description),     'poll-end embeds title in description');
  // The higher-vote option should be tagged with the trophy emoji.
  assert(/🏆 B/.test(pe.description),            'poll-end marks winning choice');
  assert(/twitch-banner\/poll/.test(pe.image?.url || ''), 'poll embed has poll banner');

  const pre = predictionEndEmbed({ title: 'Will we win?', outcomes: [
    { id: 'a', title: 'Yes', channel_points: 1000, users: 12 },
    { id: 'b', title: 'No',  channel_points: 500,  users: 4 },
  ], winningOutcomeId: 'a' });
  assert(/🏆.*Yes/.test(pre.description),        'prediction-end marks winning outcome');
  assert(/twitch-banner\/prediction/.test(pre.image?.url || ''), 'prediction embed has prediction banner');

  const ban = banEmbed({ userName: 'Trolly', modName: 'Mod1', reason: 'spam', isPermanent: true });
  assert(/banned/i.test(ban.description),        'ban embed describes ban');
  assert(/spam/.test(JSON.stringify(ban)),       'ban embed surfaces reason');
  assert(/twitch-banner\/ban/.test(ban.image?.url || ''), 'ban embed has ban banner');

  const to = banEmbed({ userName: 'NoisyOne', modName: 'Mod1', isPermanent: false, endsAt: '2026-05-27T12:00:00Z' });
  assert(/timed out/i.test(to.description),      'timeout embed describes timeout');

  const ub = unbanEmbed({ userName: 'Trolly', modName: 'Mod1' });
  assert(/unbanned/i.test(ub.description),       'unban embed describes unban');
  assert(/twitch-banner\/unban/.test(ub.image?.url || ''), 'unban embed has unban banner');
}

console.log('— twitch-events: routing precedence + toggle');
{
  const kv = makeKv();
  const env = { LOADOUT_BOLTS: kv };
  // No bindings yet — resolveEventChannel returns null.
  eq(await resolveEventChannel(env, 'gid-1', 'follow'), null, 'unbound → null');
  // Set the default 'stream-notifications' binding.
  await kv.put('channel-binding:gid-1:stream-notifications', '111111111111111111');
  eq(await resolveEventChannel(env, 'gid-1', 'follow'),  '111111111111111111', 'default catches all');
  eq(await resolveEventChannel(env, 'gid-1', 'cheer'),   '111111111111111111', 'default catches cheer');
  // Per-event override beats the default.
  await kv.put('twitch-event-channel:follow', '222222222222222222');
  eq(await resolveEventChannel(env, 'gid-1', 'follow'),  '222222222222222222', 'override beats default');
  eq(await resolveEventChannel(env, 'gid-1', 'cheer'),   '111111111111111111', 'override is per-type');
  // Ended (stream-wrap) falls back to live-now THEN live THEN default.
  await kv.put('channel-binding:gid-1:live-now', '333333333333333333');
  eq(await resolveEventChannel(env, 'gid-1', 'ended'),   '333333333333333333', 'ended → live-now binding');
  await kv.delete('channel-binding:gid-1:live-now');
  await kv.put('channel-binding:gid-1:live',     '444444444444444444');
  eq(await resolveEventChannel(env, 'gid-1', 'ended'),   '444444444444444444', 'ended falls back to live binding');
  // Redemption falls back to redemptions-feed.
  await kv.put('channel-binding:gid-1:redemptions-feed', '555555555555555555');
  eq(await resolveEventChannel(env, 'gid-1', 'redemption'), '555555555555555555', 'redemption → redemptions-feed');

  // Toggle defaults to on.
  eq(await eventTypeEnabled(env, 'follow'), true, 'enabled when no toggle KV');
  await setEventToggle(env, 'follow', false);
  eq(await eventTypeEnabled(env, 'follow'), false, 'enabled false after toggle off');
  await setEventToggle(env, 'follow', true);
  eq(await eventTypeEnabled(env, 'follow'), true,  'enabled true after toggle on (KV cleared)');

  // setEventChannel validation.
  eq((await setEventChannel(env, 'bogus-type', '12345')).error, 'unknown-event-type', 'invalid type rejected');
  eq((await setEventChannel(env, 'follow', 'not-a-snowflake')).error, 'bad-channel-id', 'bad snowflake rejected');
  const setOk = await setEventChannel(env, 'sub', '666666666666666666');
  eq(setOk.override, '666666666666666666', 'set returns override');
  const setClr = await setEventChannel(env, 'sub', '');
  eq(setClr.cleared, true, 'empty channel clears override');

  // listEventRoutes returns one row per catalogue event.
  const routes = await listEventRoutes(env, 'gid-1');
  eq(routes.length, EVENT_TYPES.length, 'listEventRoutes returns one per type');
  const followRow = routes.find(r => r.eventType === 'follow');
  eq(followRow.override, '222222222222222222', 'follow override surfaces in list');
}

console.log('— hasTwitchUserAuth guard');
{
  assert(!(await hasTwitchUserAuth(null)),                                                 'null env → false');
  assert(!(await hasTwitchUserAuth({ TWITCH_CLIENT_ID: 'a', TWITCH_CLIENT_SECRET: 'b', LOADOUT_BOLTS: makeKv() })), 'no refresh token → false');
  assert(await hasTwitchUserAuth({
    TWITCH_CLIENT_ID: 'a', TWITCH_CLIENT_SECRET: 'b',
    TWITCH_USER_REFRESH_TOKEN: 'rt-xyz',
    LOADOUT_BOLTS: makeKv(),
  }), 'env refresh token → true');
  // KV-only refresh (OAuth self-serve path) also counts.
  {
    const kv = makeKv();
    await kv.put('twitch:user-refresh-helix', 'rt-from-kv');
    assert(await hasTwitchUserAuth({
      TWITCH_CLIENT_ID: 'a', TWITCH_CLIENT_SECRET: 'b',
      LOADOUT_BOLTS: kv,
    }), 'KV-only refresh token → true');
  }
}

console.log('— setupTwitchSubscriptions: misconfig + user-auth skipping');
{
  // Missing twitch config returns guard.
  const r1 = await setupTwitchSubscriptions({ LOADOUT_BOLTS: makeKv() });
  eq(r1.ok, false, 'no twitch config → not ok');
  // App-only setup: missing user token → skips user-token-required subs.
  const env = {
    LOADOUT_BOLTS: makeKv(),
    TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 'sec',
    TWITCH_EVENTSUB_SECRET: 'es-sec',
    CLAY_TWITCH_CHANNEL_ID: '1497793223',
  };
  // Stub fetch so listSubscriptions returns [] and createSubscription
  // 'creates' deterministic ids without going to twitch.
  const realFetch = globalThis.fetch;
  const created = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://id.twitch.tv/oauth2/token')) {
      // Return a fake app access token, expires in 1h.
      return new Response(JSON.stringify({ access_token: 'fake', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.startsWith('https://api.twitch.tv/helix/eventsub/subscriptions') && (!init || init.method === 'GET')) {
      return new Response(JSON.stringify({ data: [], pagination: {} }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.startsWith('https://api.twitch.tv/helix/eventsub/subscriptions') && init?.method === 'POST') {
      const body = JSON.parse(init.body);
      created.push(body.type);
      return new Response(JSON.stringify({
        data: [{ id: 'sub-' + created.length, status: 'webhook_callback_verification_pending' }],
      }), { status: 202, headers: { 'content-type': 'application/json' } });
    }
    return new Response('?', { status: 500 });
  };
  const r2 = await setupTwitchSubscriptions(env);
  globalThis.fetch = realFetch;
  assert(r2.ok, 'setup ok with app-only auth');
  // App-token-creatable types: stream.online, stream.offline, channel.raid.
  const createdSet = new Set(r2.created.map(c => c.type));
  assert(createdSet.has('stream.online'),  'creates stream.online (app token)');
  assert(createdSet.has('stream.offline'), 'creates stream.offline (app token)');
  assert(createdSet.has('channel.raid'),   'creates channel.raid (app token)');
  // User-token types must be skipped.
  const skippedTypes = new Set(r2.skipped.map(s => s.type));
  for (const t of ['channel.follow','channel.subscribe','channel.cheer',
                   'channel.hype_train.begin','channel.poll.begin','channel.ban']) {
    assert(skippedTypes.has(t), `skips ${t} without user auth`);
  }
  for (const s of r2.skipped) {
    eq(s.reason, 'no-user-auth', `${s.type} skip reason`);
  }
  eq(r2.hasUserAuth, false, 'hasUserAuth flag echoed in response');
}

console.log('— EventSub webhook: dispatch routes to twitch-events handlers');
{
  const env = {
    LOADOUT_BOLTS: makeKv(),
    TWITCH_EVENTSUB_SECRET: SECRET,
    DISCORD_BOT_TOKEN: 'fake',
    AQUILO_VAULT_GUILD_ID: 'g1',
  };
  // Bind a default channel so handlers don't skip with no-channel.
  await env.LOADOUT_BOLTS.put('channel-binding:g1:stream-notifications', '888888888888888888');
  const calls = [];
  const ctx = { waitUntil: (p) => calls.push(p) };
  // Stub Discord POST so the embed post returns ok.
  const realFetch = globalThis.fetch;
  let postedEmbeds = [];
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST' && /\/channels\/.+\/messages$/.test(String(url))) {
      const body = JSON.parse(init.body);
      postedEmbeds.push(body);
      return new Response(JSON.stringify({ id: 'm1' }), { status: 200 });
    }
    return new Response('?', { status: 500 });
  };
  const id = 'follow-msg-1';
  const ts = '2026-05-27T00:00:00Z';
  const body = JSON.stringify({
    subscription: { type: 'channel.follow', version: '2' },
    event: { user_name: 'TestUser', user_login: 'testuser', followed_at: '2026-05-27T00:00:00Z' },
  });
  const sig = await sign(SECRET, id, ts, body);
  const req = new Request('https://w/twitch/eventsub', {
    method: 'POST',
    headers: {
      'twitch-eventsub-message-id': id,
      'twitch-eventsub-message-type': 'notification',
      'twitch-eventsub-message-timestamp': ts,
      'twitch-eventsub-message-signature': sig,
      'content-type': 'application/json',
    },
    body,
  });
  const resp = await handleEventSubWebhook(req, env, ctx);
  eq(resp.status, 204, 'channel.follow → 204');
  // The dispatch schedules work via ctx.waitUntil; await all queued.
  await Promise.all(calls);
  globalThis.fetch = realFetch;
  eq(postedEmbeds.length, 1, 'one follow embed posted');
  const embed = postedEmbeds[0].embeds[0];
  eq(embed.color, EVENT_COLORS.follow, 'posted embed is the follow embed');
  assert(/TestUser/.test(JSON.stringify(embed)), 'embed includes the follower name');
}

console.log('');
if (failures > 0) {
  console.log('FAILED — ' + failures + ' assertion(s) failed');
  process.exit(1);
}
console.log('PASSED — all assertions ok');
