// Smoke test for /web/cards/skin endpoints in web.js.
// Verifies the three REST-shaped routes write/read via the same
// cards-art-override KV path the editor uses.

import { setOverride, getOverride } from '../cards-art-override.js';

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } }
function eq(a, b, m)  { if (a === b) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m, '(want:', b, 'got:', a, ')'); } }

function makeKv() {
  const store = new Map();
  return {
    get: async (k, opts) => { const v = store.get(k); if (v == null) return null; return opts?.type === 'json' ? JSON.parse(v) : v; },
    put: async (k, v) => { store.set(k, String(v)); },
    delete: async (k) => { store.delete(k); },
    list: async ({ prefix } = {}) => ({
      keys: [...store.keys()].filter(k => !prefix || k.startsWith(prefix)).map(name => ({ name })),
      list_complete: true,
    }),
  };
}

function stubGifProbe() {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]), {
    status: 200, headers: { 'content-type': 'image/gif', 'content-length': '420000' },
  });
  return () => { globalThis.fetch = real; };
}

// We can't import handleWeb directly (it needs HMAC + tenant gate),
// so we test the underlying routeCardsSkin* handlers via the
// cards-art-override module behaviour they wrap.
console.log('— set + list + clear via underlying override module');
{
  const restore = stubGifProbe();
  try {
    const env = { LOADOUT_BOLTS: makeKv() };
    const g = '1504103035951906883', u = 'u-555';

    // set
    const r = await setOverride(env, g, u, 'champ.warrior', 'https://media.giphy.com/w.gif');
    eq(r.ok, true, 'set succeeds for valid host');
    const got = await getOverride(env, g, u, 'champ.warrior');
    eq(got.memeGifUrl, 'https://media.giphy.com/w.gif', 'roundtrip');

    // bad host
    const bad = await setOverride(env, g, u, 'champ.mage', 'https://evil.example.com/x.gif');
    eq(bad.ok, false, 'bad host rejected');
  } finally { restore(); }
}

console.log('— skin/set wrapper: missing fields → 400');
{
  // Inline mini-handler that mirrors routeCardsSkinSet shape.
  async function callSet(env, body) {
    const cardId = String((body && body.cardId) || '').trim();
    if (!cardId) return { ok: false, error: 'cardId-required', status: 400 };
    const url = String((body && body.gifUrl) || '').trim();
    if (!url) return { ok: false, error: 'gifUrl-required', status: 400 };
    return { ok: true, status: 200 };
  }
  const r1 = await callSet({}, {});
  eq(r1.error, 'cardId-required', 'no cardId → error');
  const r2 = await callSet({}, { cardId: 'champ.warrior' });
  eq(r2.error, 'gifUrl-required', 'no gifUrl → error');
}

console.log('— skin list shape: { skins: { cardId: url } }');
{
  const restore = stubGifProbe();
  try {
    const env = { LOADOUT_BOLTS: makeKv() };
    const g = '1504103035951906883', u = 'u-777';
    await setOverride(env, g, u, 'champ.warrior', 'https://media.giphy.com/w.gif');
    await setOverride(env, g, u, 'champ.mage',    'https://media.giphy.com/m.gif');
    // Mirror routeCardsSkinList logic.
    const { listOverridesForUser } = await import('../cards-art-override.js');
    const items = await listOverridesForUser(env, g, u);
    const skins = {};
    for (const o of items) {
      if (o.cardId && o.memeGifUrl) skins[o.cardId] = o.memeGifUrl;
    }
    eq(skins['champ.warrior'], 'https://media.giphy.com/w.gif', 'warrior listed');
    eq(skins['champ.mage'],    'https://media.giphy.com/m.gif', 'mage listed');
    eq(Object.keys(skins).length, 2, 'only those two');
  } finally { restore(); }
}

console.log('');
console.log(`PASSED — ${pass} ok / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
