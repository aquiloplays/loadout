// Scheduled-messages harness.
//
// Coverage:
//   • validateCreate: future scheduledUtc enforced; content OR embeds
//     required; channelId must be a snowflake; content length cap
//   • createScheduled: writes the item record + due index + status index
//   • listScheduled: separates pending / sent / cancelled / failed,
//     returns pending sorted ASC by scheduledUtc, terminal DESC
//   • cancelScheduled: pending → cancelled flips state, removes due
//     index, idempotent on re-cancel, refuses sent items
//   • editScheduled: only allowed while pending; rejects past
//     scheduledUtc; preserves status; re-keys due index on time change
//   • processDueMessages: fires due records, marks 'sent' with
//     sentMsgId; failures retry once then move to 'failed'; index is
//     swept on success
//
// Run from repo root:
//   node discord-bot/test/test-scheduled-messages.mjs

import {
  validateCreate,
  createScheduled,
  listScheduled,
  getScheduled,
  cancelScheduled,
  editScheduled,
  processDueMessages,
  _padDueForTest,
} from '../scheduled-messages.js';

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
      keys.sort((a, b) => a.name.localeCompare(b.name));
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
const CH    = '1500000000000000001';

console.log('- validateCreate');
{
  const future = Date.now() + 60_000;
  // Valid.
  eq(validateCreate({ channelId: CH, scheduledUtc: future, content: 'hi' }).ok, true, 'valid: content');
  eq(validateCreate({ channelId: CH, scheduledUtc: future, embeds: [{ title: 'x' }] }).ok, true, 'valid: embeds');
  // Bad channel.
  eq(validateCreate({ channelId: 'foo', scheduledUtc: future, content: 'hi' }).errors[0], 'bad-channel-id', 'bad channel');
  // Past.
  const past = Date.now() - 60_000;
  eq(validateCreate({ channelId: CH, scheduledUtc: past, content: 'hi' }).errors[0],
    'scheduledUtc-must-be-in-future', 'past scheduledUtc');
  // No content + no embeds.
  eq(validateCreate({ channelId: CH, scheduledUtc: future }).errors[0],
    'content-or-embeds-required', 'no content or embeds');
  eq(validateCreate({ channelId: CH, scheduledUtc: future, content: '   ' }).errors[0],
    'content-or-embeds-required', 'whitespace content + no embeds');
  // Too long.
  eq(validateCreate({ channelId: CH, scheduledUtc: future, content: 'x'.repeat(2001) }).errors[0],
    'content-too-long', 'content > 2000');
  // Bad scheduledUtc type.
  eq(validateCreate({ channelId: CH, scheduledUtc: 'soon', content: 'hi' }).errors[0],
    'bad-scheduledUtc', 'non-numeric scheduledUtc');
}

console.log('- padDue: lex-sort matches numeric');
{
  eq(_padDueForTest(0).length,             16, 'pads to 16');
  eq(_padDueForTest(123).length,           16, 'pads number');
  // Lex compare.
  const a = _padDueForTest(1_000);
  const b = _padDueForTest(10_000);
  assert(a < b, '1k lex-sorts before 10k');
}

console.log('- createScheduled + listScheduled');
{
  const env = { LOADOUT_BOLTS: makeKv() };
  const future1 = Date.now() + 10_000;
  const future2 = Date.now() + 20_000;
  const r1 = await createScheduled(env, GUILD,
    { channelId: CH, scheduledUtc: future1, content: 'first' }, 'site:admin');
  assert(r1.ok, 'first created');
  assert(typeof r1.id === 'string' && r1.id.length === 16, 'id is 16-char hex');
  const r2 = await createScheduled(env, GUILD,
    { channelId: CH, scheduledUtc: future2, content: 'second' }, 'site:admin');
  assert(r2.ok, 'second created');

  const list = await listScheduled(env, GUILD);
  eq(list.pending.length, 2, '2 pending');
  // Sorted ASC by scheduledUtc.
  assert(list.pending[0].scheduledUtc < list.pending[1].scheduledUtc, 'pending sorted ASC');
  eq(list.sent.length, 0, '0 sent');
  eq(list.failed.length, 0, '0 failed');
  eq(list.cancelled.length, 0, '0 cancelled');

  // Validation rejection bubbles up.
  const r3 = await createScheduled(env, GUILD, { channelId: 'bad', scheduledUtc: future1, content: 'no' });
  eq(r3.ok, false, 'rejected');
  eq(r3.error, 'validation', 'validation error code');
  assert(r3.errors.includes('bad-channel-id'), 'errors detail');
}

console.log('- cancelScheduled');
{
  const env = { LOADOUT_BOLTS: makeKv() };
  const r = await createScheduled(env, GUILD,
    { channelId: CH, scheduledUtc: Date.now() + 60_000, content: 'will cancel' });
  const c1 = await cancelScheduled(env, GUILD, r.id);
  assert(c1.ok, 'cancelled');
  eq(c1.item.status, 'cancelled', 'status flipped');
  // Idempotent re-cancel.
  const c2 = await cancelScheduled(env, GUILD, r.id);
  assert(c2.ok && c2.alreadyCancelled, 'already-cancelled is ok');
  // Cancel non-existent.
  const c3 = await cancelScheduled(env, GUILD, 'nonexistent');
  eq(c3.error, 'not-found', 'not-found');
  // Due index removed.
  const due = await env.LOADOUT_BOLTS.list({ prefix: `sched-msg:due:${GUILD}:` });
  eq(due.keys.length, 0, 'due index swept after cancel');
  // listScheduled now shows it under cancelled, not pending.
  const list = await listScheduled(env, GUILD);
  eq(list.pending.length, 0, '0 pending');
  eq(list.cancelled.length, 1, '1 cancelled');
}

console.log('- editScheduled');
{
  const env = { LOADOUT_BOLTS: makeKv() };
  const future1 = Date.now() + 60_000;
  const r = await createScheduled(env, GUILD,
    { channelId: CH, scheduledUtc: future1, content: 'orig' });
  // Edit content.
  const e1 = await editScheduled(env, GUILD, r.id, { content: 'updated' });
  assert(e1.ok, 'content edit ok');
  eq(e1.item.content, 'updated', 'content updated');
  // Edit scheduledUtc, re-keys due index.
  const future2 = Date.now() + 120_000;
  const e2 = await editScheduled(env, GUILD, r.id, { scheduledUtc: future2 });
  assert(e2.ok, 'scheduledUtc edit ok');
  eq(e2.item.scheduledUtc, future2, 'time updated');
  const dueKeys = (await env.LOADOUT_BOLTS.list({ prefix: `sched-msg:due:${GUILD}:` })).keys.map(k => k.name);
  eq(dueKeys.length, 1, 'one due-index entry');
  assert(dueKeys[0].includes(_padDueForTest(future2)), 'due-index key carries new time');
  // Bad scheduledUtc (past).
  const e3 = await editScheduled(env, GUILD, r.id, { scheduledUtc: Date.now() - 1000 });
  eq(e3.error, 'bad-scheduledUtc', 'past time rejected');
  // Cancel then try to edit, refused.
  await cancelScheduled(env, GUILD, r.id);
  const e4 = await editScheduled(env, GUILD, r.id, { content: 'should not' });
  eq(e4.error, 'not-pending', 'cant edit cancelled');
  // Non-existent.
  const e5 = await editScheduled(env, GUILD, 'nope', { content: 'x' });
  eq(e5.error, 'not-found', 'not-found');
}

console.log('- processDueMessages: send + sweep');
{
  const env = { LOADOUT_BOLTS: makeKv(), DISCORD_BOT_TOKEN: 'fake' };
  // Two due records, one future.
  const past1 = Date.now() - 60_000;
  const past2 = Date.now() - 30_000;
  const future = Date.now() + 60_000;
  // createScheduled refuses past times (validation), so write the
  // records directly with PAST scheduledUtc to simulate "we got here
  // and they\'re overdue".
  const fakeIds = ['aaaa000000000001', 'aaaa000000000002', 'aaaa000000000003'];
  for (const [id, sched] of [[fakeIds[0], past1], [fakeIds[1], past2], [fakeIds[2], future]]) {
    const rec = {
      id, channelId: CH, scheduledUtc: sched, content: 'msg-' + id,
      status: 'pending', createdAt: Date.now() - 1000, createdBy: null,
      sentMsgId: null, sentAt: null, error: null, attempts: 0,
    };
    await env.LOADOUT_BOLTS.put(`sched-msg:item:${GUILD}:${id}`, JSON.stringify(rec));
    await env.LOADOUT_BOLTS.put(`sched-msg:due:${GUILD}:${_padDueForTest(sched)}:${id}`, id);
    await env.LOADOUT_BOLTS.put(`sched-msg:status:${GUILD}:pending:${_padDueForTest(sched)}:${id}`, id);
  }
  const calls = [];
  fetchHandler = async (url, init) => {
    if (init.method === 'POST' && url.endsWith(`/channels/${CH}/messages`)) {
      calls.push({ body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ id: '9999' + calls.length.toString().padStart(4, '0') }),
        { status: 200 });
    }
    return new Response('?', { status: 500 });
  };
  const r = await processDueMessages(env, GUILD);
  fetchHandler = null;
  eq(r.processed, 2, '2 processed (future not touched)');
  eq(r.sent, 2,      '2 sent');
  eq(r.failed, 0,    '0 failed');
  // Future record still pending.
  const futureRec = await getScheduled(env, GUILD, fakeIds[2]);
  eq(futureRec.status, 'pending', 'future record still pending');
  // Past records moved to sent.
  const r1 = await getScheduled(env, GUILD, fakeIds[0]);
  const r2 = await getScheduled(env, GUILD, fakeIds[1]);
  eq(r1.status, 'sent', 'past1 sent');
  eq(r2.status, 'sent', 'past2 sent');
  assert(r1.sentMsgId && r2.sentMsgId, 'sentMsgId set on both');
  // Due index swept for sent items.
  const dueLeft = (await env.LOADOUT_BOLTS.list({ prefix: `sched-msg:due:${GUILD}:` })).keys;
  eq(dueLeft.length, 1, 'only future record remains in due index');
  // Status index reflects.
  const sentIdx = (await env.LOADOUT_BOLTS.list({ prefix: `sched-msg:status:${GUILD}:sent:` })).keys;
  eq(sentIdx.length, 2, '2 in sent index');
}

console.log('- processDueMessages: retry on first failure, then move to failed');
{
  const env = { LOADOUT_BOLTS: makeKv(), DISCORD_BOT_TOKEN: 'fake' };
  const past = Date.now() - 30_000;
  const id = 'bbbb000000000001';
  const rec = {
    id, channelId: CH, scheduledUtc: past, content: 'will fail',
    status: 'pending', createdAt: Date.now() - 1000, createdBy: null,
    sentMsgId: null, sentAt: null, error: null, attempts: 0,
  };
  await env.LOADOUT_BOLTS.put(`sched-msg:item:${GUILD}:${id}`, JSON.stringify(rec));
  await env.LOADOUT_BOLTS.put(`sched-msg:due:${GUILD}:${_padDueForTest(past)}:${id}`, id);
  await env.LOADOUT_BOLTS.put(`sched-msg:status:${GUILD}:pending:${_padDueForTest(past)}:${id}`, id);

  fetchHandler = async () => new Response('forbidden', { status: 403 });
  // First tick, attempt 1 fails → stays pending with attempts=1.
  const r1 = await processDueMessages(env, GUILD);
  eq(r1.processed, 1, 'tick1: 1 processed');
  eq(r1.failed, 1,    'tick1: counted as failure');
  const after1 = await getScheduled(env, GUILD, id);
  eq(after1.status, 'pending', 'still pending after tick1');
  eq(after1.attempts, 1, 'attempts=1');
  // Second tick, attempt 2 fails → moves to status:failed.
  const r2 = await processDueMessages(env, GUILD);
  fetchHandler = null;
  eq(r2.processed, 1, 'tick2: 1 processed');
  const after2 = await getScheduled(env, GUILD, id);
  eq(after2.status, 'failed', 'failed after tick2');
  eq(after2.attempts, 2, 'attempts=2');
  assert((after2.error || '').includes('http-403'), 'error captured');
  // Due index swept.
  const dueLeft = (await env.LOADOUT_BOLTS.list({ prefix: `sched-msg:due:${GUILD}:` })).keys;
  eq(dueLeft.length, 0, 'due index swept after fail');
  // Now shows in failed bucket of list.
  const list = await listScheduled(env, GUILD);
  eq(list.failed.length, 1, '1 in failed');
  eq(list.pending.length, 0, '0 in pending');
}

console.log('');
globalThis.fetch = realFetch;
if (failures > 0) {
  console.log('FAILED, ' + failures + ' assertion(s) failed');
  process.exit(1);
}
console.log('PASSED, all assertions ok');
