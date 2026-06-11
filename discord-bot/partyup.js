// PartyUp room sync backend: powers the community night queue's two
// cross-device features, the public viewer live page and remote dock
// control. The overlay (aquilo.gg/partyup/overlay/) pushes sanitized
// snapshots; the live page reads them by room id; the dock pushes
// commands the overlay polls for. A running stream never depends on
// this worker: no room configured = fully local product.
//
//   POST /api/partyup/snapshot  { room, key, state }   claim or verify, store public subset
//   GET  /api/partyup/room?room=                        public sanitized state
//   POST /api/partyup/cmd       { room, key, cmd }      push a dock command (kind whitelist)
//   GET  /api/partyup/cmds?room=&key=&after=            overlay polls commands (key-gated)
//
// No accounts: capability model. The customizer generates the room id
// (base36) + key (hex); the first snapshot claims the room and stores
// only the SHA-256 of the key. Same trust shape as the PowerDeck
// workshop and the sfdock profile store.
//
// KV (LOADOUT_BOLTS), all keys prefixed pu:
//   pu:room:<id>     keyHash + public snapshot (TTL 7d, renewed on write)
//   pu:cmd:<id>      pending dock commands (TTL 10 min, cap 30)
//   pu:rl:<ip>:<op>  rate-limit markers (TTL)

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
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const KEY = {
  room: (id) => `pu:room:${id}`,
  cmd: (id) => `pu:cmd:${id}`,
  rl: (ip, op) => `pu:rl:${ip}:${op}`,
};

const ROOM_RE = /^[a-z0-9]{6,16}$/;
const KEY_RE = /^[a-f0-9]{16,64}$/;
const ROOM_TTL_S = 7 * 24 * 3600;
const CMD_TTL_S = 600;
const CMD_CAP = 30;
const PHASES = ['idle', 'ready', 'playing'];
const MODES = ['fifo', 'raffle', 'fair', 'random'];
const PLATS = ['tw', 'yt', 'kk', 'tt', 'xx'];
const CMD_KINDS = [
  'open', 'close', 'pick', 'start', 'reroll', 'requeue', 'ready',
  'skip', 'punt', 'ban', 'unban', 'add', 'size', 'mode', 'clear', 'resetNight',
  'recap', 'mini',
];
// avatar URLs must come off a known platform CDN
const AVATAR_RE = /^https:\/\/[a-z0-9.-]+\.(jtvnw\.net|ggpht\.com|googleusercontent\.com|tiktokcdn[a-z0-9.-]*\.com|kick\.com)\//;

// ---------------------------------------------------------------------------
// Sanitization. Snapshots render inside other people's browsers (the
// live page), so everything is length-capped plain text; clients also
// escape on render.
function cleanText(s, max) {
  return String(s == null ? '' : s).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function cleanKey(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9:_.\-]/g, '').slice(0, 48);
}
function int(v, min, max, dflt) {
  const n = Math.round(Number(v));
  if (!isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}
function pick(v, list, dflt) {
  return list.includes(v) ? v : dflt;
}
function sanitizeEntry(e, withReady) {
  if (!e || typeof e !== 'object') return null;
  const out = {
    key: cleanKey(e.key),
    name: cleanText(e.name, 40) || 'viewer',
    plat: pick(e.plat, PLATS, 'xx'),
    sub: !!e.sub,
    boost: e.boost ? 1 : 0,
    played: int(e.played, 0, 99, 0),
  };
  if (e.tag) out.tag = cleanText(e.tag, 40);
  if (e.avatar && AVATAR_RE.test(String(e.avatar)) && String(e.avatar).length <= 300) {
    out.avatar = String(e.avatar);
  }
  if (e.ids && typeof e.ids === 'object') {
    const ids = {};
    let n = 0;
    for (const k of Object.keys(e.ids)) {
      const kk = String(k).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
      const v = cleanText(e.ids[k], 60);
      if (kk.length < 2 || !v) continue;
      ids[kk] = v;
      if (++n >= 8) break;
    }
    if (n) out.ids = ids;
  }
  if (e.pos !== undefined) out.pos = int(e.pos, 1, 999, 1);
  if (withReady) {
    out.ready = pick(e.ready, ['pending', 'ok', 'miss'], 'ok');
    if (e.deadline) out.deadline = int(e.deadline, 0, Date.now() + 15 * 60 * 1000, 0);
  }
  return out;
}
function sanitizeState(input) {
  if (!input || typeof input !== 'object') return { error: 'bad-state' };
  const party = (Array.isArray(input.party) ? input.party : []).slice(0, 16)
    .map((e) => sanitizeEntry(e, true)).filter(Boolean);
  const queue = (Array.isArray(input.queue) ? input.queue : []).slice(0, 100)
    .map((e) => sanitizeEntry(e, false)).filter(Boolean);
  const join = input.join && typeof input.join === 'object' ? input.join : {};
  const pub = {
    v: 1,
    open: !!input.open,
    mini: !!input.mini,
    tagsPublic: !!input.tagsPublic,
    phase: pick(input.phase, PHASES, 'idle'),
    title: cleanText(input.title, 60) || 'COMMUNITY NIGHT',
    game: cleanText(input.game, 50),
    mode: pick(input.mode, MODES, 'fifo'),
    partySize: int(input.partySize, 1, 15, 3),
    count: int(input.count, 0, 999, queue.length),
    games: int(input.games, 0, 9999, 0),
    avgGameMin: Math.round(Math.max(0, Math.min(999, Number(input.avgGameMin) || 0)) * 10) / 10,
    join: {
      chat: cleanText(join.chat, 24),
      reward: cleanText(join.reward, 60),
      here: cleanText(join.here, 24),
      tagLabel: cleanText(join.tagLabel, 24),
    },
    party,
    queue,
  };
  if (JSON.stringify(pub).length > 48 * 1024) return { error: 'state-too-big' };
  return { pub };
}
function sanitizeCmd(input) {
  if (!input || typeof input !== 'object') return { error: 'bad-cmd' };
  const kind = String(input.kind || '');
  if (!CMD_KINDS.includes(kind)) return { error: 'bad-kind' };
  const p = input.payload && typeof input.payload === 'object' ? input.payload : {};
  const payload = {};
  if (p.key !== undefined) payload.key = cleanKey(p.key);
  if (p.name !== undefined) payload.name = cleanText(p.name, 40);
  if (p.tag !== undefined) payload.tag = cleanText(p.tag, 40);
  if (p.n !== undefined) payload.n = int(p.n, 1, 15, 3);
  if (p.m !== undefined) payload.m = pick(p.m, MODES, 'fifo');
  if (p.on !== undefined) payload.on = !!p.on;
  return { cmd: { kind, payload } };
}

// ---------------------------------------------------------------------------
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
export async function handlePartyup(req, env, path) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const route = path.replace(/^\/api\/partyup/, '') || '/';

  // ---- GET /room?room=[&key=] (live page + remote dock) ---------------
  // Public read strips platform ids (and tags unless the streamer shows
  // them); the room key unlocks the full snapshot for the remote dock.
  if (req.method === 'GET' && route === '/room') {
    const id = String(url.searchParams.get('room') || '').toLowerCase().trim();
    if (!ROOM_RE.test(id)) return json({ ok: false, error: 'bad-room' }, 400);
    const rec = await kvGet(env, KEY.room(id));
    if (!rec || !rec.pub) return json({ ok: false, error: 'not-found' }, 404);
    const key = String(url.searchParams.get('key') || '').toLowerCase().trim();
    if (key && KEY_RE.test(key) && rec.keyHash === (await sha256Hex(key))) {
      return json({ ok: true, room: rec.pub, updatedAt: rec.updatedAt || 0 });
    }
    const pub = JSON.parse(JSON.stringify(rec.pub));
    for (const e of [...(pub.party || []), ...(pub.queue || [])]) {
      delete e.ids;
      if (!pub.tagsPublic) delete e.tag;
    }
    return jsonCached({ ok: true, room: pub, updatedAt: rec.updatedAt || 0 }, 3);
  }

  // ---- POST /snapshot (overlay pushes state) --------------------------
  if (req.method === 'POST' && route === '/snapshot') {
    let body;
    try { body = await req.json(); } catch { return json({ ok: false, error: 'bad-json' }, 400); }
    const id = String(body.room || '').toLowerCase().trim();
    const key = String(body.key || '').toLowerCase().trim();
    if (!ROOM_RE.test(id)) return json({ ok: false, error: 'bad-room' }, 400);
    if (!KEY_RE.test(key)) return json({ ok: false, error: 'bad-key' }, 400);
    if (!(await rateLimit(env, req, 'snap', 60, 60))) return json({ ok: false, error: 'rate' }, 429);

    const { pub, error } = sanitizeState(body.state);
    if (error) return json({ ok: false, error }, 400);

    const keyHash = await sha256Hex(key);
    const rec = await kvGet(env, KEY.room(id));
    if (rec && rec.keyHash && rec.keyHash !== keyHash) {
      return json({ ok: false, error: 'bad-room-key' }, 403);
    }
    await kvPut(env, KEY.room(id), {
      keyHash,
      pub,
      updatedAt: Date.now(),
      created: (rec && rec.created) || Date.now(),
    }, { expirationTtl: ROOM_TTL_S });
    return json({ ok: true });
  }

  // ---- POST /cmd (dock pushes a command) -------------------------------
  if (req.method === 'POST' && route === '/cmd') {
    let body;
    try { body = await req.json(); } catch { return json({ ok: false, error: 'bad-json' }, 400); }
    const id = String(body.room || '').toLowerCase().trim();
    const key = String(body.key || '').toLowerCase().trim();
    if (!ROOM_RE.test(id)) return json({ ok: false, error: 'bad-room' }, 400);
    if (!KEY_RE.test(key)) return json({ ok: false, error: 'bad-key' }, 400);
    if (!(await rateLimit(env, req, 'cmd', 40, 60))) return json({ ok: false, error: 'rate' }, 429);

    const rec = await kvGet(env, KEY.room(id));
    if (!rec) return json({ ok: false, error: 'not-found' }, 404);
    if (rec.keyHash !== (await sha256Hex(key))) return json({ ok: false, error: 'bad-room-key' }, 403);

    const { cmd, error } = sanitizeCmd(body.cmd);
    if (error) return json({ ok: false, error }, 400);

    const doc = (await kvGet(env, KEY.cmd(id))) || { n: 0, list: [] };
    doc.n += 1;
    doc.list.push({ n: doc.n, kind: cmd.kind, payload: cmd.payload, at: Date.now() });
    if (doc.list.length > CMD_CAP) doc.list = doc.list.slice(-CMD_CAP);
    await kvPut(env, KEY.cmd(id), doc, { expirationTtl: CMD_TTL_S });
    return json({ ok: true, n: doc.n });
  }

  // ---- GET /cmds?room=&key=&after= (overlay polls) ---------------------
  if (req.method === 'GET' && route === '/cmds') {
    const id = String(url.searchParams.get('room') || '').toLowerCase().trim();
    const key = String(url.searchParams.get('key') || '').toLowerCase().trim();
    const after = int(url.searchParams.get('after'), 0, Number.MAX_SAFE_INTEGER, 0);
    if (!ROOM_RE.test(id)) return json({ ok: false, error: 'bad-room' }, 400);
    if (!KEY_RE.test(key)) return json({ ok: false, error: 'bad-key' }, 400);
    const rec = await kvGet(env, KEY.room(id));
    if (!rec) return json({ ok: false, error: 'not-found' }, 404);
    if (rec.keyHash !== (await sha256Hex(key))) return json({ ok: false, error: 'bad-room-key' }, 403);
    const doc = (await kvGet(env, KEY.cmd(id))) || { n: 0, list: [] };
    return json({ ok: true, n: doc.n, list: doc.list.filter((c) => c.n > after) });
  }

  return json({ ok: false, error: 'not-found' }, 404);
}
