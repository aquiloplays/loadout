// Unit tests for cards-global-art.js, the global default art layer.

import {
  isHostAllowed, getGlobalArt, setGlobalArt, clearGlobalArt,
  bulkSetGlobalArt, listAllGlobalArt,
} from '../cards-global-art.js';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✅', msg); }
  else      { fail++; console.log('  ❌', msg); }
}
function eq(a, b, msg) {
  if (a === b) { pass++; console.log('  ✅', msg); }
  else { fail++; console.log('  ❌', msg, '(expected:', b, 'got:', a, ')'); }
}

function makeKv() {
  const store = new Map();
  return {
    get: async (k, opts) => {
      const v = store.get(k);
      if (v == null) return null;
      if (opts?.type === 'json') return JSON.parse(v);
      return v;
    },
    put: async (k, v) => { store.set(k, String(v)); },
    delete: async (k) => { store.delete(k); },
    list: async ({ prefix, cursor } = {}) => {
      const keys = [...store.keys()].filter(k => !prefix || k.startsWith(prefix));
      return { keys: keys.map(name => ({ name })), list_complete: true };
    },
  };
}

console.log('- isHostAllowed');
{
  assert(isHostAllowed('https://media.giphy.com/foo.gif'),        'giphy https → ok');
  assert(isHostAllowed('https://media.tenor.com/x.gif'),          'tenor https → ok');
  assert(isHostAllowed('https://cdn.discordapp.com/y.gif'),       'discord cdn → ok');
  assert(!isHostAllowed('http://media.giphy.com/foo.gif'),        'http (not https) → reject');
  assert(!isHostAllowed('https://evil.example.com/foo.gif'),      'unknown host → reject');
  assert(!isHostAllowed(''),                                       'empty → reject');
  assert(!isHostAllowed('not-a-url'),                              'malformed → reject');
}

console.log('- setGlobalArt + getGlobalArt');
{
  const env = { LOADOUT_BOLTS: makeKv() };
  // Use a cardId that exists in the catalogue.
  const cid = 'champ.warrior';

  // Bad: missing cardId.
  const rEmpty = await setGlobalArt(env, '', { url: 'https://media.giphy.com/x.gif' });
  eq(rEmpty.ok, false, 'empty cardId → fail');

  // Bad: unknown card.
  const rUnknown = await setGlobalArt(env, 'totally.fake.card', { url: 'https://media.giphy.com/x.gif' });
  eq(rUnknown.ok, false, 'unknown card → fail');
  eq(rUnknown.error, 'unknown-card', 'unknown-card error name');

  // Bad: http url.
  const rHttp = await setGlobalArt(env, cid, { url: 'http://media.giphy.com/x.gif' });
  eq(rHttp.ok, false, 'http url → fail');

  // Bad: disallowed host.
  const rEvil = await setGlobalArt(env, cid, { url: 'https://evil.example.com/x.gif' });
  eq(rEvil.ok, false, 'disallowed host → fail');
  eq(rEvil.error, 'host-not-allowed', 'host-not-allowed error');

  // Bad: oversized.
  const rBig = await setGlobalArt(env, cid, {
    url: 'https://media.giphy.com/x.gif', contentLength: 9_000_000,
  });
  eq(rBig.ok, false, 'oversized → fail');

  // Good.
  const rOk = await setGlobalArt(env, cid, {
    url: 'https://media.giphy.com/champion.gif',
    searchTerm: 'warrior',
    contentLength: 1_234_567,
    source: 'giphy',
  });
  eq(rOk.ok, true, 'happy path → ok');

  const got = await getGlobalArt(env, cid);
  eq(got.memeGifUrl, 'https://media.giphy.com/champion.gif', 'gif url roundtrip');
  eq(got.searchTerm, 'warrior',                              'searchTerm roundtrip');
  eq(got.source, 'giphy',                                     'source roundtrip');
}

console.log('- clearGlobalArt');
{
  const env = { LOADOUT_BOLTS: makeKv() };
  const cid = 'champ.mage';
  await setGlobalArt(env, cid, { url: 'https://media.giphy.com/m.gif' });
  assert(await getGlobalArt(env, cid),  'pre-clear: present');
  await clearGlobalArt(env, cid);
  assert(!(await getGlobalArt(env, cid)), 'post-clear: absent');
}

console.log('- bulkSetGlobalArt');
{
  const env = { LOADOUT_BOLTS: makeKv() };
  const items = [
    { cardId: 'champ.warrior', url: 'https://media.giphy.com/w.gif' },
    { cardId: 'champ.mage',    url: 'https://media.giphy.com/m.gif' },
    { cardId: 'totally.fake',  url: 'https://media.giphy.com/x.gif' },  // unknown card
    { cardId: 'champ.rogue',   url: 'http://insecure.gif' },             // bad url
  ];
  const r = await bulkSetGlobalArt(env, items);
  eq(r.ok, true, 'bulk overall ok');
  eq(r.set, 2,  'two valid set');
  eq(r.skipped, 0, 'none skipped (none preexisting)');
  eq(r.failed.length, 2, 'two failed');

  // Re-run without force: existing entries skip.
  const r2 = await bulkSetGlobalArt(env, items.slice(0, 2));
  eq(r2.set, 0,       'second pass, none set');
  eq(r2.skipped, 2,   'second pass, both skipped');

  // Re-run with force: existing entries overwrite.
  const r3 = await bulkSetGlobalArt(env, items.slice(0, 2), { force: true });
  eq(r3.set, 2,       'force pass, both set');
  eq(r3.skipped, 0,   'force pass, none skipped');
}

console.log('- listAllGlobalArt');
{
  const env = { LOADOUT_BOLTS: makeKv() };
  await setGlobalArt(env, 'champ.warrior', { url: 'https://media.giphy.com/w.gif' });
  await setGlobalArt(env, 'champ.mage',    { url: 'https://media.giphy.com/m.gif' });
  const map = await listAllGlobalArt(env);
  eq(map['champ.warrior'], 'https://media.giphy.com/w.gif', 'warrior listed');
  eq(map['champ.mage'],    'https://media.giphy.com/m.gif', 'mage listed');
  eq(Object.keys(map).length, 2, 'only set entries listed');
}

console.log('');
console.log(`PASSED, ${pass} ok / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
