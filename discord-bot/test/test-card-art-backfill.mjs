// Smoke test for card-art-backfill.runCardArtBackfillSlice, stubs
// Giphy + verifies the slice writes KV, surfaces samples + done flag.

import { runCardArtBackfillSlice } from '../card-art-backfill.js';

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; console.log('  ✅', msg); } else { fail++; console.log('  ❌', msg); } }
function eq(a, b, msg)     { if (a === b) { pass++; console.log('  ✅', msg); } else { fail++; console.log('  ❌', msg, '(expected:', b, 'got:', a, ')'); } }

function makeKv() {
  const store = new Map();
  return {
    get: async (k, opts) => {
      const v = store.get(k);
      if (v == null) return null;
      if (opts?.type === 'json') return JSON.parse(v);
      return v;
    },
    put:    async (k, v) => { store.set(k, String(v)); },
    delete: async (k) => { store.delete(k); },
    list:   async ({ prefix } = {}) => ({
      keys: [...store.keys()].filter(k => !prefix || k.startsWith(prefix)).map(name => ({ name })),
      list_complete: true,
    }),
  };
}

function stubGiphyOk(seedUrl) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('https://api.giphy.com/v1/gifs/search')) {
      return new Response(JSON.stringify({
        data: [{
          title: 'sample',
          images: { original: {
            url:    seedUrl,
            size:   '420000',
            width:  '400',
            height: '300',
          }},
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url);
  };
  return () => { globalThis.fetch = realFetch; };
}

console.log('- bail when GIPHY_API_KEY missing');
{
  const env = { LOADOUT_BOLTS: makeKv() };
  const r = await runCardArtBackfillSlice(env, { offset: 0, limit: 1 });
  eq(r.ok, false, 'no API key → not ok');
  eq(r.error, 'no-giphy-api-key', 'error name');
}

console.log('- happy slice: 3 cards, all hit');
{
  const restore = stubGiphyOk('https://media.giphy.com/foo.gif');
  try {
    const env = { LOADOUT_BOLTS: makeKv(), GIPHY_API_KEY: 'gk-fake' };
    const r = await runCardArtBackfillSlice(env, { offset: 0, limit: 3 });
    eq(r.ok, true, 'slice ok');
    eq(r.processed, 3, 'processed=3');
    eq(r.hits, 3,      'hits=3');
    eq(r.misses, 0,    'misses=0');
    eq(r.skipped, 0,   'skipped=0');
    assert(r.samples.length > 0, 'samples non-empty');
    assert(typeof r.total === 'number' && r.total > 0, 'total set');
    eq(r.nextOffset, 3, 'nextOffset advances');
    assert(!r.done, 'not done after first slice');
    // Confirm KV writes landed at the global-card-art prefix.
    const kvList = await env.LOADOUT_BOLTS.list({ prefix: 'global-card-art:' });
    eq(kvList.keys.length, 3, 'three KV keys written');
  } finally { restore(); }
}

console.log('- skipped: already-set cards don\'t re-hit Giphy');
{
  let giphyCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('https://api.giphy.com/v1/gifs/search')) {
      giphyCalls++;
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url);
  };
  try {
    const env = { LOADOUT_BOLTS: makeKv(), GIPHY_API_KEY: 'gk-fake' };
    // Pre-populate the first card.
    const firstCard = (await import('../cards-content.js')).CARDS;
    const firstId = Object.keys(firstCard)[0];
    await env.LOADOUT_BOLTS.put(`global-card-art:${firstId}`, JSON.stringify({ memeGifUrl: 'https://media.giphy.com/x.gif' }));
    const r = await runCardArtBackfillSlice(env, { offset: 0, limit: 1 });
    eq(r.skipped, 1, 'pre-existing → skipped');
    eq(giphyCalls, 0, 'Giphy not called for skipped card');
  } finally { globalThis.fetch = realFetch; }
}

console.log('- rate-limit rewinds nextOffset (no card-skip burn)');
{
  // Stub: first card returns 429, no other Giphy calls succeed.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('https://api.giphy.com/v1/gifs/search')) {
      return new Response('rate limited', { status: 429 });
    }
    return realFetch(url);
  };
  try {
    const env = { LOADOUT_BOLTS: makeKv(), GIPHY_API_KEY: 'gk-fake' };
    const r = await runCardArtBackfillSlice(env, { offset: 100, limit: 10, pacingMs: 0 });
    eq(r.ok, true,         'slice still returns ok=true');
    eq(r.rateLimited, true, 'rateLimited flag set');
    eq(r.nextOffset, 100,   'nextOffset rewound to the rate-limited card');
    eq(r.hits, 0,           'no hits');
    eq(r.misses, 0,         'rate-limited card NOT counted as miss');
    eq(r.processed, 0,      'processed reset to attempted count (0)');
  } finally { globalThis.fetch = realFetch; }
}

console.log('- force=true overwrites');
{
  const restore = stubGiphyOk('https://media.giphy.com/forced.gif');
  try {
    const env = { LOADOUT_BOLTS: makeKv(), GIPHY_API_KEY: 'gk-fake' };
    const firstCard = (await import('../cards-content.js')).CARDS;
    const firstId = Object.keys(firstCard)[0];
    await env.LOADOUT_BOLTS.put(`global-card-art:${firstId}`, JSON.stringify({ memeGifUrl: 'https://media.giphy.com/stale.gif' }));
    const r = await runCardArtBackfillSlice(env, { offset: 0, limit: 1, force: true });
    eq(r.hits, 1, 'force → hit');
    eq(r.skipped, 0, 'force → no skip');
    const after = await env.LOADOUT_BOLTS.get(`global-card-art:${firstId}`, { type: 'json' });
    eq(after.memeGifUrl, 'https://media.giphy.com/forced.gif', 'KV overwritten');
  } finally { restore(); }
}

console.log('');
console.log(`PASSED, ${pass} ok / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
