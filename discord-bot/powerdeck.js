// PowerDeck Pack Workshop backend: the community registry for custom
// challenge card packs. Streamers build packs in the browser at
// aquilo.gg/powerdeck/workshop/ and publish them for other streamers;
// overlays and customizers fetch packs by id and cache them locally,
// so this worker is a distribution layer, never a live dependency of
// a running stream.
//
//   POST /api/powerdeck/pack          create { pack } -> { id, editKey }
//                                     update { id, editKey, pack }
//   GET  /api/powerdeck/pack?id=      fetch one (public or unlisted)
//   POST /api/powerdeck/pack/delete   { id, editKey }
//   GET  /api/powerdeck/gallery?game=&q=&sort=   public packs
//   POST /api/powerdeck/use           { id }  popularity signal
//   POST /api/powerdeck/report        { id, reason }  5 distinct IPs -> auto-hide
//
// No accounts: capability model. A pack id is unguessable (w:<12 hex>)
// and the editKey (24 hex, returned once at create) is stored only as
// a SHA-256 hash. Same trust shape as the sfdock profile store.
//
// KV (LOADOUT_BOLTS), all keys prefixed pd:
//   pd:pack:<id>     pack JSON + editKeyHash + visibility + uses + reports
//   pd:gallery       public gallery index (summaries, cap 500)
//   pd:rl:<ip>:<op>  rate-limit markers (TTL)

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS },
  });
}
function jsonCached(obj, seconds) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${seconds}`, ...CORS },
  });
}

async function kvGet(env, key) {
  try { return await env.LOADOUT_BOLTS.get(key, { type: 'json' }); } catch { return null; }
}
async function kvPut(env, key, val, opts) {
  await env.LOADOUT_BOLTS.put(key, JSON.stringify(val), opts || {});
}

function genHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const KEY = {
  pack: (id) => `pd:pack:${id}`,
  gallery: () => 'pd:gallery',
  rl: (ip, op) => `pd:rl:${ip}:${op}`,
};

const RARITIES = ['common', 'rare', 'epic', 'legendary'];
const GALLERY_CAP = 500;
const REPORT_HIDE_AT = 5;

// ---------------------------------------------------------------------------
// Validation. Strict on shape and size: these packs render inside other
// people's overlays, so everything is length-capped plain text. The
// clients escape on render; stripping angle brackets here is defense in
// depth, not the only line.
function cleanText(s, max) {
  return String(s == null ? '' : s).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function cleanEmoji(s, fallback) {
  const v = String(s == null ? '' : s).trim().slice(0, 8);
  return v || fallback;
}
function sanitizePack(input) {
  if (!input || typeof input !== 'object') return { error: 'bad-pack' };
  const game = cleanText(input.game, 40);
  const name = cleanText(input.name, 60);
  const by = cleanText(input.by, 30) || 'anonymous';
  const desc = cleanText(input.desc, 200);
  if (game.length < 2) return { error: 'game-required' };
  if (name.length < 3) return { error: 'name-required' };
  const rawCards = Array.isArray(input.cards) ? input.cards : [];
  if (rawCards.length < 3) return { error: 'min-3-cards' };
  if (rawCards.length > 24) return { error: 'max-24-cards' };
  const cards = [];
  const seen = new Set();
  for (let i = 0; i < rawCards.length; i++) {
    const c = rawCards[i] || {};
    const cname = cleanText(c.name, 40);
    const text = cleanText(c.text, 120);
    if (cname.length < 2) return { error: `card-${i + 1}-name` };
    if (text.length < 8) return { error: `card-${i + 1}-text` };
    let id = String(c.id || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 16);
    if (!id || seen.has(id)) id = 'c' + (i + 1).toString(36) + genHex(2);
    seen.add(id);
    cards.push({
      id,
      name: cname,
      text,
      rarity: RARITIES.includes(c.rarity) ? c.rarity : 'common',
      emoji: cleanEmoji(c.emoji, '🃏'),
      timed: Math.max(0, Math.min(7200, Number(c.timed) || 0)),
    });
  }
  const pack = {
    game, name, by, desc,
    emoji: cleanEmoji(input.emoji, '🃏'),
    cards,
    ver: Math.max(1, Number(input.ver) || 1),
  };
  if (JSON.stringify(pack).length > 24 * 1024) return { error: 'pack-too-big' };
  return { pack };
}

// ---------------------------------------------------------------------------
// Rate limiting: small KV markers with TTLs. KV is eventually
// consistent, so treat these as speed bumps, not hard guarantees.
function clientIp(req) {
  return req.headers.get('cf-connecting-ip') || 'unknown';
}
async function rateLimit(env, req, op, max, windowSec) {
  const ip = clientIp(req);
  const key = KEY.rl(ip, op);
  const cur = (await kvGet(env, key)) || { n: 0 };
  if (cur.n >= max) return false;
  cur.n += 1;
  await kvPut(env, key, cur, { expirationTtl: windowSec });
  return true;
}

// ---------------------------------------------------------------------------
// Gallery index: one doc of public-pack summaries, newest first.
function summarize(id, rec) {
  return {
    id,
    game: rec.pack.game,
    name: rec.pack.name,
    by: rec.pack.by,
    desc: rec.pack.desc || '',
    emoji: rec.pack.emoji || '🃏',
    cards: rec.pack.cards.length,
    uses: rec.uses | 0,
    updated: rec.updated,
  };
}
async function galleryUpsert(env, id, rec) {
  const g = (await kvGet(env, KEY.gallery())) || { packs: [] };
  g.packs = g.packs.filter((p) => p.id !== id);
  if (rec && rec.visibility === 'public' && !rec.hidden) {
    g.packs.unshift(summarize(id, rec));
    if (g.packs.length > GALLERY_CAP) g.packs = g.packs.slice(0, GALLERY_CAP);
  }
  await kvPut(env, KEY.gallery(), g);
}

// ---------------------------------------------------------------------------
export async function handlePowerdeck(req, env, path) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const route = path.replace(/^\/api\/powerdeck/, '') || '/';

  // ---- GET /pack?id= -------------------------------------------------
  if (req.method === 'GET' && route === '/pack') {
    const id = String(url.searchParams.get('id') || '').trim();
    if (!/^w:[a-f0-9]{8,16}$/.test(id)) return json({ ok: false, error: 'bad-id' }, 400);
    const rec = await kvGet(env, KEY.pack(id));
    if (!rec || rec.hidden) return json({ ok: false, error: 'not-found' }, 404);
    return jsonCached({ ok: true, pack: { id, ...rec.pack }, uses: rec.uses | 0, visibility: rec.visibility }, 300);
  }

  // ---- GET /gallery --------------------------------------------------
  if (req.method === 'GET' && route === '/gallery') {
    const game = String(url.searchParams.get('game') || '').toLowerCase().trim();
    const q = String(url.searchParams.get('q') || '').toLowerCase().trim().slice(0, 60);
    const sort = url.searchParams.get('sort') === 'uses' ? 'uses' : 'new';
    const g = (await kvGet(env, KEY.gallery())) || { packs: [] };
    let packs = g.packs;
    if (game) packs = packs.filter((p) => p.game.toLowerCase().includes(game));
    if (q) packs = packs.filter((p) => (p.name + ' ' + p.game + ' ' + p.by + ' ' + p.desc).toLowerCase().includes(q));
    if (sort === 'uses') packs = [...packs].sort((a, b) => (b.uses | 0) - (a.uses | 0));
    return jsonCached({ ok: true, packs: packs.slice(0, 120) }, 120);
  }

  // ---- POST /pack (create or update) ----------------------------------
  if (req.method === 'POST' && route === '/pack') {
    let body;
    try { body = await req.json(); } catch { return json({ ok: false, error: 'bad-json' }, 400); }
    const { pack, error } = sanitizePack(body.pack);
    if (error) return json({ ok: false, error }, 400);
    const visibility = body.visibility === 'public' ? 'public' : 'unlisted';

    const id = String(body.id || '').trim();
    if (id) {
      // Update: prove ownership with the edit key.
      if (!/^w:[a-f0-9]{8,16}$/.test(id)) return json({ ok: false, error: 'bad-id' }, 400);
      const rec = await kvGet(env, KEY.pack(id));
      if (!rec) return json({ ok: false, error: 'not-found' }, 404);
      const keyHash = await sha256Hex(String(body.editKey || ''));
      if (keyHash !== rec.editKeyHash) return json({ ok: false, error: 'bad-edit-key' }, 403);
      if (!(await rateLimit(env, req, 'update', 60, 3600))) return json({ ok: false, error: 'rate' }, 429);
      pack.ver = (rec.pack.ver | 0) + 1;
      const next = { ...rec, pack, visibility, updated: Date.now() };
      await kvPut(env, KEY.pack(id), next);
      await galleryUpsert(env, id, next);
      return json({ ok: true, id, ver: pack.ver });
    }

    // Create.
    if (!(await rateLimit(env, req, 'create', 10, 86400))) return json({ ok: false, error: 'rate' }, 429);
    const newId = 'w:' + genHex(6);
    const editKey = genHex(12);
    const rec = {
      pack,
      visibility,
      editKeyHash: await sha256Hex(editKey),
      uses: 0,
      reports: [],
      hidden: false,
      created: Date.now(),
      updated: Date.now(),
    };
    await kvPut(env, KEY.pack(newId), rec);
    await galleryUpsert(env, newId, rec);
    return json({ ok: true, id: newId, editKey });
  }

  // ---- POST /pack/delete ----------------------------------------------
  if (req.method === 'POST' && route === '/pack/delete') {
    let body;
    try { body = await req.json(); } catch { return json({ ok: false, error: 'bad-json' }, 400); }
    const id = String(body.id || '').trim();
    if (!/^w:[a-f0-9]{8,16}$/.test(id)) return json({ ok: false, error: 'bad-id' }, 400);
    const rec = await kvGet(env, KEY.pack(id));
    if (!rec) return json({ ok: true });   // idempotent
    const keyHash = await sha256Hex(String(body.editKey || ''));
    if (keyHash !== rec.editKeyHash) return json({ ok: false, error: 'bad-edit-key' }, 403);
    await env.LOADOUT_BOLTS.delete(KEY.pack(id)).catch(() => {});
    await galleryUpsert(env, id, null);
    return json({ ok: true });
  }

  // ---- POST /use -------------------------------------------------------
  if (req.method === 'POST' && route === '/use') {
    let body;
    try { body = await req.json(); } catch { return json({ ok: false, error: 'bad-json' }, 400); }
    const id = String(body.id || '').trim();
    if (!/^w:[a-f0-9]{8,16}$/.test(id)) return json({ ok: false, error: 'bad-id' }, 400);
    if (!(await rateLimit(env, req, 'use', 60, 3600))) return json({ ok: true });
    const rec = await kvGet(env, KEY.pack(id));
    if (!rec || rec.hidden) return json({ ok: true });
    rec.uses = (rec.uses | 0) + 1;
    await kvPut(env, KEY.pack(id), rec);
    if (rec.visibility === 'public') await galleryUpsert(env, id, rec);
    return json({ ok: true });
  }

  // ---- POST /report ----------------------------------------------------
  if (req.method === 'POST' && route === '/report') {
    let body;
    try { body = await req.json(); } catch { return json({ ok: false, error: 'bad-json' }, 400); }
    const id = String(body.id || '').trim();
    if (!/^w:[a-f0-9]{8,16}$/.test(id)) return json({ ok: false, error: 'bad-id' }, 400);
    if (!(await rateLimit(env, req, 'report', 20, 86400))) return json({ ok: false, error: 'rate' }, 429);
    const rec = await kvGet(env, KEY.pack(id));
    if (!rec) return json({ ok: true });
    const ipHash = (await sha256Hex(clientIp(req))).slice(0, 16);
    rec.reports = rec.reports || [];
    if (!rec.reports.some((r) => r.ip === ipHash)) {
      rec.reports.push({ ip: ipHash, reason: cleanText(body.reason, 140), ts: Date.now() });
      // Distinct-IP threshold pulls the pack from circulation until a
      // human looks at it (unhide = flip `hidden` in KV).
      if (rec.reports.length >= REPORT_HIDE_AT) rec.hidden = true;
      await kvPut(env, KEY.pack(id), rec);
      await galleryUpsert(env, id, rec);
    }
    return json({ ok: true });
  }

  return json({ ok: false, error: 'not-found' }, 404);
}
