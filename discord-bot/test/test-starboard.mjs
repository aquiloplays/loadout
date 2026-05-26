// Standalone harness for the starboard ringbuffer in guild-features.js.
// Stubs env.LOADOUT_BOLTS with an in-memory KV shim, exercises append +
// read + dedup-by-messageId + cap behaviour + newest-first ordering +
// missing-guild graceful fallback.
//
// Run from repo root:
//   node discord-bot/test/test-starboard.mjs

import {
  appendStarboardRecent,
  readStarboardRecent,
} from '../guild-features.js';

let failures = 0;
function assert(cond, label) {
  if (cond) {
    console.log('  ✅ ' + label);
  } else {
    failures++;
    console.log('  ❌ ' + label);
  }
}
function eq(a, b, label) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) console.log('    expected', JSON.stringify(b), 'got', JSON.stringify(a));
  assert(ok, label);
}

function makeKv() {
  const store = new Map();
  return {
    async get(key, opts) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      if (opts && opts.type === 'json') return JSON.parse(raw);
      return raw;
    },
    async put(key, value, _opts) {
      store.set(key, value);
    },
    _store: store,
  };
}

function makeItem(i, overrides = {}) {
  return {
    messageId: String(1000 + i),
    authorName: 'user' + i,
    authorAvatarUrl: 'https://cdn/u' + i + '.png',
    content: 'msg #' + i,
    attachments: [],
    starCount: 5 + i,
    originalUrl: 'https://discord.com/channels/G/C/' + (1000 + i),
    ts: 1700000000000 + i * 1000,
    ...overrides,
  };
}

const GUILD = '1504103035951906883';

console.log('— append + read basic');
{
  const env = { LOADOUT_BOLTS: makeKv() };
  const r1 = await appendStarboardRecent(env, GUILD, makeItem(1));
  eq(r1, { stored: true, count: 1 }, 'append returns stored:true');
  const r2 = await appendStarboardRecent(env, GUILD, makeItem(2));
  eq(r2, { stored: true, count: 2 }, 'append bumps count');

  const read = await readStarboardRecent(env, GUILD, 25);
  assert(read.ok, 'read returns ok');
  eq(read.items.map(i => i.messageId), ['1002', '1001'], 'newest-first ordering');
  eq(read.items[0].starCount, 7, 'starCount survives roundtrip');
}

console.log('— dedup by messageId on re-append');
{
  const env = { LOADOUT_BOLTS: makeKv() };
  await appendStarboardRecent(env, GUILD, makeItem(1, { starCount: 5 }));
  await appendStarboardRecent(env, GUILD, makeItem(2));
  await appendStarboardRecent(env, GUILD, makeItem(1, { starCount: 9, content: 'updated' }));

  const read = await readStarboardRecent(env, GUILD, 25);
  eq(read.items.length, 2, 'two entries total (no double)');
  // Re-appended item moves to the end (newest), so it should be first newest-first.
  eq(read.items[0].messageId, '1001', 're-append moves to newest slot');
  eq(read.items[0].starCount, 9, 're-append overwrites starCount');
  eq(read.items[0].content, 'updated', 're-append overwrites content');
}

console.log('— cap at STARBOARD_RECENT_CAP (50)');
{
  const env = { LOADOUT_BOLTS: makeKv() };
  // Add 55 distinct items
  for (let i = 1; i <= 55; i++) {
    await appendStarboardRecent(env, GUILD, makeItem(i));
  }
  const read = await readStarboardRecent(env, GUILD, 60);
  eq(read.items.length, 50, 'list capped at 50');
  // Oldest 5 (messageIds 1001..1005) should be trimmed; newest is 1055.
  eq(read.items[0].messageId, '1055', 'newest item present after trim');
  assert(
    !read.items.some(i => Number(i.messageId) <= 1005),
    'oldest five items trimmed',
  );
}

console.log('— limit clamping');
{
  const env = { LOADOUT_BOLTS: makeKv() };
  for (let i = 1; i <= 30; i++) {
    await appendStarboardRecent(env, GUILD, makeItem(i));
  }
  const r5  = await readStarboardRecent(env, GUILD, 5);
  eq(r5.items.length, 5, 'limit=5 honoured');
  const r0  = await readStarboardRecent(env, GUILD, 0);
  // 0 → falls back to 25 via `Number(limit) || 25`
  eq(r0.items.length, 25, 'limit=0 falls back to 25');
  const rNeg = await readStarboardRecent(env, GUILD, -3);
  // Math.max(1, ...) floors to 1
  eq(rNeg.items.length, 1, 'negative limit clamps to 1');
  const rBig = await readStarboardRecent(env, GUILD, 9999);
  eq(rBig.items.length, 30, 'huge limit clamps to the cap (only 30 stored)');
}

console.log('— missing env / missing guild');
{
  const r = await readStarboardRecent({}, GUILD, 5);
  eq(r, { ok: false, items: [] }, 'no LOADOUT_BOLTS → ok:false');
  const env = { LOADOUT_BOLTS: makeKv() };
  const r2 = await readStarboardRecent(env, '', 5);
  eq(r2, { ok: false, items: [] }, 'no guildId → ok:false');
  const r3 = await readStarboardRecent(env, GUILD, 5);
  eq(r3, { ok: true, items: [] }, 'empty ringbuffer → ok:true, items:[]');
}

console.log('— append refuses bad input');
{
  const env = { LOADOUT_BOLTS: makeKv() };
  eq(await appendStarboardRecent(env, GUILD, null), { stored: false }, 'null item refused');
  eq(await appendStarboardRecent(env, GUILD, {}), { stored: false }, 'no messageId refused');
  eq(await appendStarboardRecent({}, GUILD, makeItem(1)), { stored: false }, 'no env refused');
  eq(await appendStarboardRecent(env, '', makeItem(1)), { stored: false }, 'no guildId refused');
}

console.log('');
if (failures > 0) {
  console.log('FAILED — ' + failures + ' assertion(s) failed');
  process.exit(1);
}
console.log('PASSED — all assertions ok');
