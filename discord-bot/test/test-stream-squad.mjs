// Unit tests for stream-squad.js — the D1-backed co-watch sessions +
// shared activity feed (premium feature #5).
//
// Uses an in-memory D1 mock that models the three tables and pattern-
// matches the SQL the module emits. If the module's queries change,
// the mock must change in lockstep (same contract as
// test-achievements-d1.mjs).
//
// Run with:   node test/test-stream-squad.mjs

import {
  createSquad,
  ensureSquadForChannel,
  endSquad,
  getSquad,
  listActiveSquads,
  joinSquad,
  leaveSquad,
  postSquadEvent,
  getSquadFeed,
  handleSquadComponent,
} from '../stream-squad.js';

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } }
function eq(a, b, m)  { if (a === b) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m, '(want:', b, 'got:', a, ')'); } }

// ── In-memory D1 mock ─────────────────────────────────────────────
function makeMockDB() {
  const sessions = [];   // {id, owner_user_id, twitch_channel, started_at, ended_at, member_count}
  const members  = [];   // {squad_id, user_id, joined_at, left_at}
  const events   = [];   // {id, squad_id, user_id, kind, payload, created_at}

  function handlers(sql, args) {
    const S = sql.replace(/\s+/g, ' ').trim();
    return {
      async first() {
        if (/^SELECT id, owner_user_id, twitch_channel, started_at, ended_at, member_count FROM stream_squad_session WHERE id = \?/i.test(S)) {
          return sessions.find(s => s.id === args[0]) || null;
        }
        if (/^SELECT COUNT\(\*\) AS n FROM stream_squad_member WHERE squad_id = \? AND left_at IS NULL/i.test(S)) {
          return { n: members.filter(m => m.squad_id === args[0] && m.left_at == null).length };
        }
        if (/^SELECT squad_id, user_id, joined_at, left_at FROM stream_squad_member WHERE squad_id = \? AND user_id = \?/i.test(S)) {
          return members.find(m => m.squad_id === args[0] && m.user_id === args[1]) || null;
        }
        if (/FROM stream_squad_session WHERE twitch_channel = \? AND ended_at IS NULL/i.test(S)) {
          return sessions
            .filter(s => s.twitch_channel === args[0] && s.ended_at == null)
            .sort((a, b) => b.started_at - a.started_at)[0] || null;
        }
        return null;
      },
      async all() {
        if (/FROM stream_squad_member WHERE squad_id = \? AND left_at IS NULL ORDER BY joined_at ASC/i.test(S)) {
          return { results: members
            .filter(m => m.squad_id === args[0] && m.left_at == null)
            .sort((a, b) => a.joined_at - b.joined_at)
            .map(m => ({ user_id: m.user_id, joined_at: m.joined_at })) };
        }
        if (/FROM stream_squad_session WHERE ended_at IS NULL AND twitch_channel = \?/i.test(S)) {
          const lim = args[1];
          return { results: sessions
            .filter(s => s.ended_at == null && s.twitch_channel === args[0])
            .sort((a, b) => b.started_at - a.started_at).slice(0, lim) };
        }
        if (/FROM stream_squad_session WHERE ended_at IS NULL ORDER BY started_at DESC/i.test(S)) {
          const lim = args[0];
          return { results: sessions
            .filter(s => s.ended_at == null)
            .sort((a, b) => b.started_at - a.started_at).slice(0, lim) };
        }
        if (/FROM stream_squad_event WHERE squad_id = \? AND created_at < \?/i.test(S)) {
          const [sid, before, lim] = args;
          return { results: events
            .filter(e => e.squad_id === sid && e.created_at < before)
            .sort((a, b) => b.created_at - a.created_at).slice(0, lim) };
        }
        if (/FROM stream_squad_event WHERE squad_id = \? ORDER BY created_at DESC/i.test(S)) {
          const [sid, lim] = args;
          return { results: events
            .filter(e => e.squad_id === sid)
            .sort((a, b) => b.created_at - a.created_at).slice(0, lim) };
        }
        return { results: [] };
      },
      async run() {
        if (/^INSERT INTO stream_squad_session/i.test(S)) {
          const [id, owner, ch, started] = args;
          sessions.push({ id, owner_user_id: owner, twitch_channel: ch, started_at: started, ended_at: null, member_count: 1 });
          return { meta: { changes: 1 } };
        }
        if (/^INSERT INTO stream_squad_member/i.test(S)) {
          const [squad_id, user_id, joined_at] = args;
          members.push({ squad_id, user_id, joined_at, left_at: null });
          return { meta: { changes: 1 } };
        }
        if (/^INSERT INTO stream_squad_event/i.test(S)) {
          const [id, squad_id, user_id, kind, payload, created_at] = args;
          events.push({ id, squad_id, user_id, kind, payload, created_at });
          return { meta: { changes: 1 } };
        }
        if (/^UPDATE stream_squad_member SET left_at = NULL, joined_at = \?/i.test(S)) {
          const [joined_at, squad_id, user_id] = args;
          const m = members.find(x => x.squad_id === squad_id && x.user_id === user_id);
          if (m) { m.left_at = null; m.joined_at = joined_at; }
          return { meta: { changes: m ? 1 : 0 } };
        }
        if (/^UPDATE stream_squad_member SET left_at = \? WHERE squad_id = \? AND user_id = \? AND left_at IS NULL/i.test(S)) {
          const [left_at, squad_id, user_id] = args;
          const m = members.find(x => x.squad_id === squad_id && x.user_id === user_id && x.left_at == null);
          if (m) m.left_at = left_at;
          return { meta: { changes: m ? 1 : 0 } };
        }
        if (/^UPDATE stream_squad_session SET member_count = \? WHERE id = \?/i.test(S)) {
          const [count, id] = args;
          const s = sessions.find(x => x.id === id);
          if (s) s.member_count = count;
          return { meta: { changes: s ? 1 : 0 } };
        }
        if (/^UPDATE stream_squad_session SET ended_at = \? WHERE id = \? AND ended_at IS NULL/i.test(S)) {
          const [ended_at, id] = args;
          const s = sessions.find(x => x.id === id && x.ended_at == null);
          if (s) s.ended_at = ended_at;
          return { meta: { changes: s ? 1 : 0 } };
        }
        return { meta: { changes: 0 } };
      },
    };
  }

  return {
    _sessions: sessions, _members: members, _events: events,
    prepare(sql) {
      return { bind: (...args) => handlers(sql, args), ...handlers(sql, []) };
    },
  };
}

function makeEnv() { return { DB: makeMockDB() }; }

const OWNER = 'owner-1', CH = 'prodigalttv';

// ── lifecycle ─────────────────────────────────────────────────────

console.log('— createSquad: owner auto-joins, count 1');
{
  const env = makeEnv();
  const r = await createSquad(env, { ownerUserId: OWNER, twitchChannel: CH });
  assert(r.ok, 'created');
  eq(r.squad.ownerUserId, OWNER, 'owner set');
  eq(r.squad.twitchChannel, CH, 'channel set');
  eq(r.squad.memberCount, 1, 'count 1');
  assert(r.squad.active, 'active');
  eq(env.DB._members.length, 1, 'one member row (owner)');
}

console.log('— createSquad: bad args');
{
  const env = makeEnv();
  const r = await createSquad(env, { ownerUserId: '', twitchChannel: '' });
  assert(!r.ok, 'refused');
  eq(r.error, 'bad-args', 'bad-args');
}

console.log('— ensureSquadForChannel: reuses active, then creates');
{
  const env = makeEnv();
  const a = await ensureSquadForChannel(env, { ownerUserId: 'system', twitchChannel: CH });
  assert(a.ok && a.created, 'first ensure creates');
  const b = await ensureSquadForChannel(env, { ownerUserId: 'system', twitchChannel: CH });
  assert(b.ok && !b.created, 'second ensure reuses');
  eq(a.squad.id, b.squad.id, 'same squad id');
  eq(env.DB._sessions.length, 1, 'only one session created');
}

// ── membership ────────────────────────────────────────────────────

console.log('— joinSquad: new member bumps count + posts join event');
{
  const env = makeEnv();
  const { squad } = await createSquad(env, { ownerUserId: OWNER, twitchChannel: CH });
  const r = await joinSquad(env, squad.id, 'viewer-A');
  assert(r.ok, 'joined');
  assert(!r.alreadyIn, 'not alreadyIn');
  eq(r.memberCount, 2, 'count now 2');
  eq(env.DB._events.filter(e => e.kind === 'join').length, 1, 'one join event');

  // Re-join same active member = no-op.
  const r2 = await joinSquad(env, squad.id, 'viewer-A');
  assert(r2.alreadyIn, 'already in');
  eq(r2.memberCount, 2, 'count still 2');
  eq(env.DB._events.filter(e => e.kind === 'join').length, 1, 'no duplicate join event');
}

console.log('— leaveSquad then re-join reuses the row');
{
  const env = makeEnv();
  const { squad } = await createSquad(env, { ownerUserId: OWNER, twitchChannel: CH });
  await joinSquad(env, squad.id, 'viewer-B');
  const lv = await leaveSquad(env, squad.id, 'viewer-B');
  assert(lv.ok && lv.wasMember, 'left');
  eq(lv.memberCount, 1, 'count back to 1 (just owner)');
  eq(env.DB._members.filter(m => m.user_id === 'viewer-B').length, 1, 'still one member row');

  const rj = await joinSquad(env, squad.id, 'viewer-B');
  assert(rj.ok && !rj.alreadyIn, 're-joined');
  eq(rj.memberCount, 2, 'count 2 again');
  eq(env.DB._members.filter(m => m.user_id === 'viewer-B').length, 1, 'row reused, not duplicated');
}

console.log('— leaveSquad: non-member is a soft no-op');
{
  const env = makeEnv();
  const { squad } = await createSquad(env, { ownerUserId: OWNER, twitchChannel: CH });
  const r = await leaveSquad(env, squad.id, 'never-here');
  assert(r.ok && !r.wasMember, 'soft no-op');
}

console.log('— join refused on ended squad');
{
  const env = makeEnv();
  const { squad } = await createSquad(env, { ownerUserId: OWNER, twitchChannel: CH });
  await endSquad(env, squad.id, OWNER);
  const r = await joinSquad(env, squad.id, 'late-comer');
  assert(!r.ok, 'refused');
  eq(r.error, 'ended', 'ended');
}

// ── endSquad ──────────────────────────────────────────────────────

console.log('— endSquad: owner only, idempotent');
{
  const env = makeEnv();
  const { squad } = await createSquad(env, { ownerUserId: OWNER, twitchChannel: CH });
  const wrong = await endSquad(env, squad.id, 'not-owner');
  assert(!wrong.ok, 'non-owner refused');
  eq(wrong.error, 'not-owner', 'not-owner error');

  const r = await endSquad(env, squad.id, OWNER);
  assert(r.ok, 'owner ends');
  assert(!r.squad.active, 'no longer active');

  const again = await endSquad(env, squad.id, OWNER);
  assert(again.ok && again.alreadyEnded, 'second end is alreadyEnded');
}

// ── activity feed ─────────────────────────────────────────────────

console.log('— postSquadEvent: member only, feed newest-first');
{
  const env = makeEnv();
  const { squad } = await createSquad(env, { ownerUserId: OWNER, twitchChannel: CH });
  await joinSquad(env, squad.id, 'viewer-C');

  // Non-member can't post.
  const denied = await postSquadEvent(env, squad.id, 'stranger', 'reaction', { emoji: '🔥' });
  assert(!denied.ok, 'non-member denied');
  eq(denied.error, 'not-a-member', 'not-a-member');

  const e1 = await postSquadEvent(env, squad.id, 'viewer-C', 'reaction', { emoji: '🔥' });
  assert(e1.ok, 'member posts reaction');
  const e2 = await postSquadEvent(env, squad.id, OWNER, 'hype', { level: 3 });
  assert(e2.ok, 'owner posts hype');

  const feed = await getSquadFeed(env, squad.id, { limit: 10 });
  assert(feed.ok, 'feed ok');
  // join(viewer-C) + reaction + hype = 3 events. (Ordering among
  // same-millisecond events is ambiguous, so assert by kind, not index;
  // the pagination test below covers strict newest-first ordering.)
  eq(feed.events.length, 3, 'three events in feed');
  const hype = feed.events.find(e => e.kind === 'hype');
  assert(hype, 'hype present');
  eq(hype.payload.level, 3, 'payload parsed back to object');
  assert(feed.events.some(e => e.kind === 'reaction'), 'reaction present');
  assert(feed.events.some(e => e.kind === 'join'), 'join event present');
}

console.log('— getSquadFeed: pagination via before cursor');
{
  const env = makeEnv();
  const { squad } = await createSquad(env, { ownerUserId: OWNER, twitchChannel: CH });
  // Three events with controlled timestamps.
  const D = env.DB;
  D._events.push({ id: 'x1', squad_id: squad.id, user_id: OWNER, kind: 'a', payload: null, created_at: 100 });
  D._events.push({ id: 'x2', squad_id: squad.id, user_id: OWNER, kind: 'b', payload: null, created_at: 200 });
  D._events.push({ id: 'x3', squad_id: squad.id, user_id: OWNER, kind: 'c', payload: null, created_at: 300 });

  const page1 = await getSquadFeed(env, squad.id, { limit: 2 });
  eq(page1.events.length, 2, 'page1 has 2');
  eq(page1.events[0].kind, 'c', 'newest first');
  eq(page1.nextBefore, 200, 'nextBefore = oldest in page');

  const page2 = await getSquadFeed(env, squad.id, { limit: 2, before: page1.nextBefore });
  assert(page2.events.every(e => e.createdAt < 200), 'page2 strictly older');
  eq(page2.events[0].kind, 'a', 'page2 has the oldest');
}

// ── listActiveSquads ──────────────────────────────────────────────

console.log('— listActiveSquads: only active, channel filter');
{
  const env = makeEnv();
  const a = await createSquad(env, { ownerUserId: OWNER, twitchChannel: 'chan-1' });
  await createSquad(env, { ownerUserId: 'o2', twitchChannel: 'chan-2' });
  await endSquad(env, a.squad.id, OWNER);   // chan-1 squad ended

  const all = await listActiveSquads(env, {});
  eq(all.squads.length, 1, 'only the active one');
  eq(all.squads[0].twitchChannel, 'chan-2', 'chan-2 active');

  const filtered = await listActiveSquads(env, { twitchChannel: 'chan-1' });
  eq(filtered.squads.length, 0, 'chan-1 has no active squad');
}

// ── getSquad roster ───────────────────────────────────────────────

console.log('— getSquad: returns session + active roster');
{
  const env = makeEnv();
  const { squad } = await createSquad(env, { ownerUserId: OWNER, twitchChannel: CH });
  await joinSquad(env, squad.id, 'viewer-D');
  await joinSquad(env, squad.id, 'viewer-E');
  await leaveSquad(env, squad.id, 'viewer-D');

  const r = await getSquad(env, squad.id);
  assert(r.ok, 'ok');
  eq(r.members.length, 2, 'owner + viewer-E active (viewer-D left)');
  const ids = r.members.map(m => m.userId);
  assert(ids.includes(OWNER) && ids.includes('viewer-E'), 'right roster');
  assert(!ids.includes('viewer-D'), 'left member excluded');
}

console.log('— getSquad: not-found');
{
  const env = makeEnv();
  const r = await getSquad(env, 'no-such-squad');
  assert(!r.ok, 'not ok');
  eq(r.error, 'not-found', 'not-found');
}

// ── handleSquadComponent (join button) ────────────────────────────

console.log('— handleSquadComponent: join button acks ephemerally');
{
  const env = makeEnv();
  const { squad } = await createSquad(env, { ownerUserId: OWNER, twitchChannel: CH });
  const interaction = {
    data: { custom_id: `squad:join:${squad.id}` },
    member: { user: { id: 'clicker-1' } },
  };
  const resp = await handleSquadComponent(env, interaction);
  eq(resp.type, 4, 'type 4 channel-message');
  eq(resp.data.flags, 64, 'ephemeral');
  assert(/watching together/i.test(resp.data.content), 'mentions watching together');
  // The clicker is now an active member.
  const r = await getSquad(env, squad.id);
  assert(r.members.some(m => m.userId === 'clicker-1'), 'clicker joined');
}

console.log('— handleSquadComponent: unknown action');
{
  const env = makeEnv();
  const resp = await handleSquadComponent(env, {
    data: { custom_id: 'squad:bogus:xyz' },
    member: { user: { id: 'u' } },
  });
  eq(resp.type, 4, 'still acks');
  assert(/unknown squad action/i.test(resp.data.content), 'unknown action message');
}

console.log('');
console.log(`PASSED — ${pass} ok / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
