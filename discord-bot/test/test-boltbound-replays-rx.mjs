// Unit tests for boltbound-replays-rx — reactions (idempotent toggle)
// + comments (length + per-user cap).
//
// Run from discord-bot/:
//   node test/test-boltbound-replays-rx.mjs

import {
  REACTION_TYPES,
  addReaction,
  removeReaction,
  getReactions,
  addComment,
  listComments,
  __internals,
} from '../boltbound-replays-rx.js';

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } }
function eq(a, b, m)  { if (a === b) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m, '(want:', b, 'got:', a, ')'); } }

// ── Mock D1 ───────────────────────────────────────────────────────
//
// Supports the exact subset of SQL the module uses:
//   - SELECT 1 AS hit FROM replay_reaction WHERE replay_id = ? AND user_id = ? AND type = ?
//   - INSERT OR IGNORE INTO replay_reaction (...) VALUES (?,?,?,?)
//   - DELETE FROM replay_reaction WHERE replay_id = ? AND user_id = ? AND type = ?
//   - SELECT type, COUNT(*) AS n FROM replay_reaction WHERE replay_id = ? GROUP BY type
//   - SELECT type FROM replay_reaction WHERE replay_id = ? AND user_id = ?
//   - SELECT COUNT(*) AS n FROM replay_comment WHERE replay_id = ? AND user_id = ?
//   - INSERT INTO replay_comment (...) VALUES (?,?,?,?,?)
//   - SELECT id, replay_id, user_id, text, turn_index, created_at FROM replay_comment WHERE replay_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?

function makeMockDb() {
  const reactions = []; // {replay_id,user_id,type,created_at}
  const comments  = []; // {id, replay_id, user_id, text, turn_index, created_at}
  let nextId = 1;

  function prepare(sql) {
    return {
      _sql: sql,
      _binds: [],
      bind(...args) { this._binds = args; return this; },
      async first() {
        const rows = runSelect(sql, this._binds, reactions, comments);
        return rows[0] || null;
      },
      async all() {
        return { results: runSelect(sql, this._binds, reactions, comments) };
      },
      async run() {
        return runMutation(sql, this._binds, reactions, comments, () => nextId++);
      },
    };
  }

  return { prepare, _reactions: reactions, _comments: comments };
}

function runSelect(sql, b, reactions, comments) {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (s.startsWith('SELECT 1 AS hit FROM replay_reaction')) {
    const [replayId, userId, type] = b;
    return reactions.filter(r =>
      r.replay_id === replayId && r.user_id === userId && r.type === type
    ).slice(0, 1).map(() => ({ hit: 1 }));
  }
  if (s.startsWith('SELECT type, COUNT(*) AS n FROM replay_reaction')) {
    const [replayId] = b;
    const byType = new Map();
    for (const r of reactions) {
      if (r.replay_id !== replayId) continue;
      byType.set(r.type, (byType.get(r.type) || 0) + 1);
    }
    return Array.from(byType.entries()).map(([type, n]) => ({ type, n }));
  }
  if (s.startsWith('SELECT type FROM replay_reaction')) {
    const [replayId, userId] = b;
    return reactions
      .filter(r => r.replay_id === replayId && r.user_id === userId)
      .map(r => ({ type: r.type }));
  }
  if (s.startsWith('SELECT COUNT(*) AS n FROM replay_comment')) {
    const [replayId, userId] = b;
    const n = comments.filter(c => c.replay_id === replayId && c.user_id === userId).length;
    return [{ n }];
  }
  if (s.startsWith('SELECT id, replay_id, user_id, text, turn_index, created_at FROM replay_comment')) {
    const [replayId, limit, offset] = b;
    const rows = comments
      .filter(c => c.replay_id === replayId)
      .sort((a, b) => (b.created_at - a.created_at) || (b.id - a.id))
      .slice(offset, offset + limit);
    return rows.map(r => ({
      id: r.id,
      replay_id: r.replay_id,
      user_id: r.user_id,
      text: r.text,
      turn_index: r.turn_index,
      created_at: r.created_at,
    }));
  }
  throw new Error('mock-db: unhandled SELECT ' + s);
}

function runMutation(sql, b, reactions, comments, nextIdFn) {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (s.startsWith('INSERT OR IGNORE INTO replay_reaction')) {
    const [replay_id, user_id, type, created_at] = b;
    const dup = reactions.find(r =>
      r.replay_id === replay_id && r.user_id === user_id && r.type === type
    );
    if (dup) return { meta: { changes: 0 } };
    reactions.push({ replay_id, user_id, type, created_at });
    return { meta: { changes: 1 } };
  }
  if (s.startsWith('DELETE FROM replay_reaction')) {
    const [replay_id, user_id, type] = b;
    let removed = 0;
    for (let i = reactions.length - 1; i >= 0; i--) {
      const r = reactions[i];
      if (r.replay_id === replay_id && r.user_id === user_id && r.type === type) {
        reactions.splice(i, 1);
        removed++;
      }
    }
    return { meta: { changes: removed } };
  }
  if (s.startsWith('INSERT INTO replay_comment')) {
    const [replay_id, user_id, text, turn_index, created_at] = b;
    const id = nextIdFn();
    comments.push({ id, replay_id, user_id, text, turn_index, created_at });
    return { meta: { changes: 1, last_row_id: id } };
  }
  throw new Error('mock-db: unhandled MUTATION ' + s);
}

// ── Tests ─────────────────────────────────────────────────────────

console.log('— REACTION_TYPES + helpers');
{
  assert(Object.isFrozen(REACTION_TYPES), 'REACTION_TYPES is frozen');
  assert(REACTION_TYPES.includes('like'), 'has like');
  assert(REACTION_TYPES.includes('gg'),   'has gg');
  assert(__internals.isValidType('like'), 'isValidType passes known type');
  assert(!__internals.isValidType('fire'), 'isValidType rejects unknown type');
  const zero = __internals.zeroCounts();
  for (const t of REACTION_TYPES) eq(zero[t], 0, `zeroCounts[${t}]=0`);
}

console.log('— addReaction is idempotent');
{
  const env = { DB: makeMockDb() };
  const r1 = await addReaction(env, 'rep-1', 'user-a', 'like');
  eq(r1.ok, true, '1st react ok');
  eq(r1.alreadyReacted, false, '1st react NOT alreadyReacted');
  const r2 = await addReaction(env, 'rep-1', 'user-a', 'like');
  eq(r2.ok, true, '2nd react ok');
  eq(r2.alreadyReacted, true, '2nd react alreadyReacted:true');
  eq(env.DB._reactions.length, 1, 'still only 1 row in D1');

  // Different type from same user → distinct row, not "already".
  const r3 = await addReaction(env, 'rep-1', 'user-a', 'gg');
  eq(r3.alreadyReacted, false, 'different type is fresh');
  eq(env.DB._reactions.length, 2, 'now 2 rows');
}

console.log('— addReaction rejects bad type');
{
  const env = { DB: makeMockDb() };
  const r = await addReaction(env, 'rep-1', 'user-a', 'fire');
  eq(r.ok, false, 'bad type → ok:false');
  eq(r.error, 'bad-type', 'reason = bad-type');
  assert(Array.isArray(r.allowed) && r.allowed.includes('like'),
    'error response surfaces the allowed list');
}

console.log('— removeReaction is forgiving');
{
  const env = { DB: makeMockDb() };
  // Remove without ever adding — still ok:true (toggle UI semantics).
  const r1 = await removeReaction(env, 'rep-x', 'user-a', 'like');
  eq(r1.ok, true, 'remove-without-add → ok:true');
  // Add then remove.
  await addReaction(env, 'rep-x', 'user-a', 'wow');
  eq(env.DB._reactions.length, 1, 'added one');
  const r2 = await removeReaction(env, 'rep-x', 'user-a', 'wow');
  eq(r2.ok, true, 'remove ok');
  eq(env.DB._reactions.length, 0, 'row deleted');
}

console.log('— getReactions aggregates counts + viewer set');
{
  const env = { DB: makeMockDb() };
  await addReaction(env, 'rep-2', 'u1', 'like');
  await addReaction(env, 'rep-2', 'u2', 'like');
  await addReaction(env, 'rep-2', 'u2', 'gg');
  await addReaction(env, 'rep-2', 'u3', 'clutch');
  // Decoy on another replay — must not leak in.
  await addReaction(env, 'rep-other', 'u1', 'like');

  const all = await getReactions(env, 'rep-2');
  eq(all.counts.like,   2, 'like count = 2');
  eq(all.counts.gg,     1, 'gg count = 1');
  eq(all.counts.clutch, 1, 'clutch count = 1');
  eq(all.counts.wow,    0, 'wow count defaults to 0');
  eq(all.viewerReactions.length, 0, 'no viewer → empty viewerReactions');

  const fromU2 = await getReactions(env, 'rep-2', 'u2');
  assert(fromU2.viewerReactions.includes('like'), 'u2 sees their like');
  assert(fromU2.viewerReactions.includes('gg'),   'u2 sees their gg');
  eq(fromU2.viewerReactions.length, 2, 'u2 has 2 reactions');

  const fromU3 = await getReactions(env, 'rep-2', 'u3');
  eq(fromU3.viewerReactions.length, 1, 'u3 has 1 reaction');
  eq(fromU3.viewerReactions[0], 'clutch', 'u3 reacted clutch');
}

console.log('— addComment length validation');
{
  const env = { DB: makeMockDb() };
  // Empty body
  const r1 = await addComment(env, 'rep-3', 'u1', '   ');
  eq(r1.ok, false, 'empty (whitespace only) → ok:false');
  eq(r1.reason, 'empty', 'reason = empty');

  // OK body
  const r2 = await addComment(env, 'rep-3', 'u1', 'gg wp');
  eq(r2.ok, true, 'normal comment ok');
  assert(typeof r2.commentId === 'number' && r2.commentId > 0, 'returns numeric commentId');

  // Over the limit
  const tooLong = 'x'.repeat(__internals.MAX_COMMENT_CHARS + 1);
  const r3 = await addComment(env, 'rep-3', 'u1', tooLong);
  eq(r3.ok, false, 'over-cap → ok:false');
  eq(r3.reason, 'too-long', 'reason = too-long');
  eq(r3.max, __internals.MAX_COMMENT_CHARS, 'max surfaced');

  // Exactly at cap → ok
  const exact = 'y'.repeat(__internals.MAX_COMMENT_CHARS);
  const r4 = await addComment(env, 'rep-3', 'u1', exact);
  eq(r4.ok, true, 'exactly-cap → ok');

  // turnIndex coerced + accepted
  const r5 = await addComment(env, 'rep-3', 'u1', 'turn anchor', 3);
  eq(r5.ok, true, 'turnIndex=3 ok');
  // Bad turnIndex
  const r6 = await addComment(env, 'rep-3', 'u1', 'bad anchor', -1);
  eq(r6.ok, false, 'negative turnIndex rejected');
  eq(r6.reason, 'bad-turn-index', 'reason = bad-turn-index');
}

console.log('— addComment enforces 50-per-user cap');
{
  const env = { DB: makeMockDb() };
  for (let i = 0; i < __internals.MAX_COMMENTS_PER_USER; i++) {
    const r = await addComment(env, 'rep-4', 'spammer', `msg ${i}`);
    if (!r.ok) {
      fail++;
      console.log('  FAIL', `comment #${i} unexpectedly failed: ${r.reason}`);
      break;
    }
  }
  // Decoy: another user on the same replay must not share the cap.
  const otherOk = await addComment(env, 'rep-4', 'other-user', 'hi');
  eq(otherOk.ok, true, 'second user not affected by first user cap');

  // Next one for spammer must be rejected.
  const blocked = await addComment(env, 'rep-4', 'spammer', 'one more');
  eq(blocked.ok, false, 'cap-reached returns ok:false');
  eq(blocked.reason, 'cap-reached', 'reason = cap-reached');
  eq(blocked.max, __internals.MAX_COMMENTS_PER_USER, 'max surfaced');

  // And cap is per-replay — a different replay starts fresh.
  const onOther = await addComment(env, 'rep-different', 'spammer', 'fresh slate');
  eq(onOther.ok, true, 'cap is per-replay, not global');
}

console.log('— listComments newest-first + paging');
{
  const env = { DB: makeMockDb() };
  // Manually seed comments with strictly increasing createdAt so the
  // ordering check is unambiguous.
  const D = env.DB;
  for (let i = 0; i < 5; i++) {
    const id = D._comments.length + 1;
    D._comments.push({
      id,
      replay_id: 'rep-5',
      user_id: 'u',
      text: `c${i}`,
      turn_index: null,
      created_at: 1_000_000 + i * 1000,
    });
  }
  const page = await listComments(env, 'rep-5', { limit: 3, offset: 0 });
  eq(page.length, 3, 'limit honored');
  eq(page[0].text, 'c4', 'newest first');
  eq(page[1].text, 'c3', 'then c3');
  eq(page[2].text, 'c2', 'then c2');
  const page2 = await listComments(env, 'rep-5', { limit: 3, offset: 3 });
  eq(page2.length, 2, '2 remaining at offset 3');
  eq(page2[0].text, 'c1', 'page2[0] = c1');
  eq(page2[1].text, 'c0', 'page2[1] = c0');
}

console.log('');
console.log(`PASSED — ${pass} ok / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
