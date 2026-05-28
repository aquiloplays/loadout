// Smoke test for card-art-remix.js — verifies slash + select dispatch.

import { handleCardArtRemixCommand, handleCardArtRemixSelect } from '../card-art-remix.js';

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } }
function eq(a, b, m)  { if (a === b) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m, '(want:', b, 'got:', a, ')'); } }

function makeKv() {
  const store = new Map();
  return {
    get: async (k, opts) => { const v = store.get(k); if (v == null) return null; return opts?.type === 'json' ? JSON.parse(v) : v; },
    put: async (k, v) => { store.set(k, String(v)); },
    delete: async (k) => { store.delete(k); },
  };
}

function stubGiphy(urls) {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('https://api.giphy.com/v1/gifs/search')) {
      calls++;
      const term = new URL(String(url)).searchParams.get('q');
      return new Response(JSON.stringify({
        data: urls.map((u, i) => ({
          title: `Result ${i+1} for ${term}`,
          images: { original: { url: u, size: '200000', width: '300', height: '200' } },
        })),
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return real(url);
  };
  return { restore: () => { globalThis.fetch = real; }, calls: () => calls };
}

console.log('— slash: no GIPHY_API_KEY → ephemeral message');
{
  const env = { LOADOUT_BOLTS: makeKv() };
  const r = await handleCardArtRemixCommand(env, {
    member: { user: { id: 'u-1' } },
    data: { options: [{ name: 'card-art', type: 2,
      options: [{ name: 'remix', type: 1, options: [
        { name: 'card-id', value: 'champ.warrior' },
      ]}]}],
    },
  });
  eq(r.type, 4, 'reply type=4');
  assert(r.data.content.includes('GIPHY_API_KEY'), 'mentions GIPHY_API_KEY');
}

console.log('— slash: unknown card → ephemeral error');
{
  const env = { LOADOUT_BOLTS: makeKv(), GIPHY_API_KEY: 'k' };
  const r = await handleCardArtRemixCommand(env, {
    member: { user: { id: 'u-1' } },
    data: { options: [{ name: 'card-art', type: 2,
      options: [{ name: 'remix', type: 1, options: [
        { name: 'card-id', value: 'no.such.card' },
      ]}]}],
    },
  });
  assert(r.data.content.includes('Unknown cardId'), 'unknown card error');
}

console.log('— slash: happy path returns 5 embeds + select menu');
{
  const stub = stubGiphy([
    'https://media.giphy.com/c1.gif',
    'https://media.giphy.com/c2.gif',
    'https://media.giphy.com/c3.gif',
    'https://media.giphy.com/c4.gif',
    'https://media.giphy.com/c5.gif',
  ]);
  try {
    const env = { LOADOUT_BOLTS: makeKv(), GIPHY_API_KEY: 'k' };
    const r = await handleCardArtRemixCommand(env, {
      member: { user: { id: 'u-77' } },
      data: { options: [{ name: 'card-art', type: 2,
        options: [{ name: 'remix', type: 1, options: [
          { name: 'card-id', value: 'champ.warrior' },
        ]}]}],
      },
    });
    eq(r.type, 4, 'reply type=4');
    assert(r.data.embeds.length >= 5,         '>=5 embeds');
    eq(r.data.components[0].type, 1,          'action row wrapper');
    const select = r.data.components[0].components[0];
    eq(select.type, 3,                         'select menu');
    assert(select.custom_id.startsWith('ca:rmx:pick:champ.warrior'), 'custom_id encodes cardId');
    eq(select.options.length, 5,              'select has 5 options');

    // Picker stash landed in KV.
    const stash = await env.LOADOUT_BOLTS.get(`card-art-remix:u-77:champ.warrior`, { type: 'json' });
    eq(stash.candidates.length, 5,             'KV picker stash holds 5 candidates');
  } finally { stub.restore(); }
}

console.log('— select: persists chosen candidate to global-card-art');
{
  const env = { LOADOUT_BOLTS: makeKv(), GIPHY_API_KEY: 'k' };
  // Seed a picker stash.
  await env.LOADOUT_BOLTS.put('card-art-remix:u-77:champ.warrior', JSON.stringify({
    candidates: [
      { url: 'https://media.giphy.com/a.gif', searchTerm: 'champion steel', contentLength: 100000 },
      { url: 'https://media.giphy.com/b.gif', searchTerm: 'steel',           contentLength: 100000 },
      { url: 'https://media.giphy.com/c.gif', searchTerm: 'champion',        contentLength: 100000 },
    ],
    cardName: 'Champion of Steel',
  }));
  const r = await handleCardArtRemixSelect(env, {
    member: { user: { id: 'u-77' } },
    data: { custom_id: 'ca:rmx:pick:champ.warrior', values: ['1'] },
  });
  eq(r.type, 7, 'UPDATE_MESSAGE response');
  assert(r.data.content.includes('Updated global art'), 'confirmation copy');

  // KV global-art landed.
  const rec = await env.LOADOUT_BOLTS.get('global-card-art:champ.warrior', { type: 'json' });
  eq(rec.memeGifUrl,  'https://media.giphy.com/b.gif', 'chose index=1');
  eq(rec.searchTerm,  'steel',                          'searchTerm from candidate');
  eq(rec.source,      'manual-remix',                   'source marker');

  // Picker consumed.
  const stillThere = await env.LOADOUT_BOLTS.get('card-art-remix:u-77:champ.warrior');
  eq(stillThere, null, 'picker cleared after pick');
}

console.log('— select: expired picker → friendly error');
{
  const env = { LOADOUT_BOLTS: makeKv() };
  const r = await handleCardArtRemixSelect(env, {
    member: { user: { id: 'u-99' } },
    data: { custom_id: 'ca:rmx:pick:champ.warrior', values: ['0'] },
  });
  assert(r.data.content.includes('expired'), 'expired-picker copy');
}

console.log('');
console.log(`PASSED — ${pass} ok / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
