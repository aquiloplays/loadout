// Bingo card scaffold for the CrowdPlay engagement loop.
//
// Each viewer buys a 5x5 bingo card per stream. Each square is a CrowdPlay
// effect ID drawn from the live manifest, weighted toward votable effects.
// As effects fire on stream (any source: votes, bits, gifts, scratch, CC),
// the engine posts to /web/bingo/effect-fired -> marks the square for
// every viewer holding that effect -> first to bingo wins.
//
// Storage (KV):
//   bingo:stream:<streamerId>            -> { startedAt, manifestPool: [effectId,...] }
//   bingo:card:<streamerId>:<userId>     -> { effects[5][5], marked[5][5], won, viewer }
//   bingo:winners:<streamerId>           -> [{ userId, viewer, kind, at }]

const CARD_SIZE = 5;
const FREE_SPACE = true;

function jsonResp(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'Authorization, Content-Type, x-crowdplay-token',
      'access-control-allow-methods': 'GET,POST,OPTIONS', ...extra,
    },
  });
}

async function kvGet(env, key, asJson = false) {
  if (!env || !env.LOADOUT_BOLTS) return null;
  try { return await env.LOADOUT_BOLTS.get(key, asJson ? { type: 'json' } : undefined); }
  catch { return null; }
}
async function kvPut(env, key, val, ttl) {
  if (!env || !env.LOADOUT_BOLTS) return;
  try {
    await env.LOADOUT_BOLTS.put(key,
      typeof val === 'string' ? val : JSON.stringify(val),
      ttl ? { expirationTtl: ttl } : undefined);
  } catch {}
}

function tokenOk(req, env) {
  const want = String(env.CROWDPLAY_TOKEN || '').trim();
  if (!want) return false;
  const got = req.headers.get('x-crowdplay-token') || '';
  return got === want;
}

function makeCard(pool) {
  if (!Array.isArray(pool) || pool.length === 0) return null;
  const needed = FREE_SPACE ? CARD_SIZE * CARD_SIZE - 1 : CARD_SIZE * CARD_SIZE;
  const shuffled = pool.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  while (shuffled.length < needed) shuffled.push(shuffled[shuffled.length % pool.length]);
  const flat = shuffled.slice(0, needed);
  const effects = [];
  let k = 0;
  for (let r = 0; r < CARD_SIZE; r++) {
    const row = [];
    for (let c = 0; c < CARD_SIZE; c++) {
      if (FREE_SPACE && r === 2 && c === 2) row.push(null);
      else row.push(flat[k++]);
    }
    effects.push(row);
  }
  const marked = Array.from({ length: CARD_SIZE }, () =>
    Array.from({ length: CARD_SIZE }, () => 0));
  if (FREE_SPACE) marked[2][2] = 1;
  return { effects, marked, won: false, createdAt: Date.now() };
}

function checkBingo(marked) {
  const N = CARD_SIZE;
  for (let i = 0; i < N; i++) {
    if (marked[i].every((v) => v)) return 'row-' + i;
    let col = true;
    for (let j = 0; j < N; j++) if (!marked[j][i]) { col = false; break; }
    if (col) return 'col-' + i;
  }
  let d1 = true, d2 = true;
  for (let i = 0; i < N; i++) {
    if (!marked[i][i]) d1 = false;
    if (!marked[i][N - 1 - i]) d2 = false;
  }
  if (d1) return 'diag-1';
  if (d2) return 'diag-2';
  let all = true;
  for (let i = 0; i < N && all; i++)
    for (let j = 0; j < N && all; j++) if (!marked[i][j]) all = false;
  if (all) return 'full-house';
  return null;
}

export async function handleBingo(req, env, path) {
  const url = new URL(req.url);
  const method = req.method.toUpperCase();
  if (method === 'OPTIONS') return jsonResp({ ok: true });

  // POST /web/bingo/start - streamer initialises a stream-wide round
  if (method === 'POST' && path === '/web/bingo/start') {
    if (!tokenOk(req, env)) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
    let body; try { body = await req.json(); } catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
    const streamerId = String(body.streamerId || '').trim();
    const pool = Array.isArray(body.manifestPool) ? body.manifestPool.filter(Boolean) : [];
    if (!streamerId) return jsonResp({ ok: false, error: 'missing-streamerId' }, 400);
    if (pool.length < CARD_SIZE * CARD_SIZE - 1) {
      return jsonResp({ ok: false, error: 'pool-too-small', need: CARD_SIZE * CARD_SIZE - 1 }, 400);
    }
    await kvPut(env, `bingo:stream:${streamerId}`,
      { startedAt: Date.now(), manifestPool: pool }, 86400);
    return jsonResp({ ok: true, streamerId, pool: pool.length });
  }

  // POST /web/bingo/buy - viewer mints a fresh card (paid in Bolts upstream)
  if (method === 'POST' && path === '/web/bingo/buy') {
    let body; try { body = await req.json(); } catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
    const { streamerId, userId, viewer } = body || {};
    if (!streamerId || !userId) return jsonResp({ ok: false, error: 'missing-fields' }, 400);
    const stream = await kvGet(env, `bingo:stream:${streamerId}`, true);
    if (!stream) return jsonResp({ ok: false, error: 'no-stream' }, 404);
    const card = makeCard(stream.manifestPool);
    if (!card) return jsonResp({ ok: false, error: 'pool-empty' }, 500);
    card.viewer = String(viewer || userId);
    await kvPut(env, `bingo:card:${streamerId}:${userId}`, card, 86400);
    return jsonResp({ ok: true, card });
  }

  // POST /web/bingo/effect-fired - engine pings on every public fire
  if (method === 'POST' && path === '/web/bingo/effect-fired') {
    if (!tokenOk(req, env)) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
    let body; try { body = await req.json(); } catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
    const { streamerId, effectId } = body || {};
    if (!streamerId || !effectId) return jsonResp({ ok: false, error: 'missing-fields' }, 400);
    const list = await env.LOADOUT_BOLTS.list({ prefix: `bingo:card:${streamerId}:` });
    const newWins = [];
    for (const k of list.keys) {
      const card = await kvGet(env, k.name, true);
      if (!card || card.won) continue;
      let changed = false;
      for (let r = 0; r < CARD_SIZE; r++) {
        for (let c = 0; c < CARD_SIZE; c++) {
          if (card.effects[r][c] === effectId && !card.marked[r][c]) {
            card.marked[r][c] = 1; changed = true;
          }
        }
      }
      if (!changed) continue;
      const win = checkBingo(card.marked);
      if (win) {
        card.won = true; card.winKind = win; card.wonAt = Date.now();
        newWins.push({ userId: k.name.split(':').pop(),
          viewer: card.viewer || null, kind: win, at: card.wonAt });
      }
      await kvPut(env, k.name, card, 86400);
    }
    if (newWins.length) {
      const winners = (await kvGet(env, `bingo:winners:${streamerId}`, true)) || [];
      winners.push(...newWins);
      await kvPut(env, `bingo:winners:${streamerId}`, winners, 86400);
    }
    return jsonResp({ ok: true, marked: list.keys.length, newWins });
  }

  if (method === 'GET' && path === '/web/bingo/card') {
    const streamerId = url.searchParams.get('streamerId');
    const userId = url.searchParams.get('userId');
    if (!streamerId || !userId) return jsonResp({ ok: false, error: 'missing-fields' }, 400);
    const card = await kvGet(env, `bingo:card:${streamerId}:${userId}`, true);
    return jsonResp({ ok: true, card });
  }

  if (method === 'GET' && path === '/web/bingo/winners') {
    const streamerId = url.searchParams.get('streamerId');
    if (!streamerId) return jsonResp({ ok: false, error: 'missing-fields' }, 400);
    const winners = (await kvGet(env, `bingo:winners:${streamerId}`, true)) || [];
    return jsonResp({ ok: true, winners });
  }

  return jsonResp({ ok: false, error: 'not-found' }, 404);
}
