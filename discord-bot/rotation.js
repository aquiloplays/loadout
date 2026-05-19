// Rotation song-request backend for the Twitch panel — /ext/rotation/*.
//
// R1 ships the cloud half: Spotify search + the validate/request/state
// plumbing. The validate/request roundtrip needs the R2 Streamer.bot
// relay + Rotation widget; until the relay reports in (rot:relay:alive,
// refreshed by /relay/ingest), validate/request fast-fail with reason
// "rotation-offline" so R1 degrades gracefully on its own.
//
// Config (Worker secrets): SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET
//   (client-credentials flow for search — until set, /search returns 503).
//   TWITCH_EXT_SECRET is reused to verify Bits transaction receipts.
//
// KV (LOADOUT_BOLTS):
//   spotify:apptoken                 cached Spotify app token (~50m TTL)
//   rot:relay:alive                  relay heartbeat (R2 /relay/ingest)
//   rot:state                        { nowPlaying, queue } (R2)
//   rot:validated:<id>               validate result (R2 ingest)
//   rot:reqresult:<requestId>        accept/reject result (R2 ingest)
//   rot:cd:<guild>:<userId>          per-viewer request cooldown stamp
//   rot:freecredit:<guild>:<userId>  "next request free" make-good credit
//   relay:rotation-validate:<id>     queued trigger drained by /relay/pending
//   relay:rotation-request:<id>      queued trigger drained by /relay/pending

import { verifyBitsReceipt } from './auth.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS },
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const SPOTIFY_TOKEN_KEY = 'spotify:apptoken';
const STATE_KEY = 'rot:state';
const RELAY_ALIVE_KEY = 'rot:relay:alive';
const COOLDOWN_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 500;
const POLL_TRIES = 14; // ~7s roundtrip budget

async function relayAlive(env) {
  return !!(await env.LOADOUT_BOLTS.get(RELAY_ALIVE_KEY));
}

// ---- Spotify app token (client-credentials, cached) --------------------
async function getSpotifyToken(env) {
  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) return null;
  const cached = await env.LOADOUT_BOLTS.get(SPOTIFY_TOKEN_KEY);
  if (cached) return cached;
  try {
    const basic = btoa(env.SPOTIFY_CLIENT_ID + ':' + env.SPOTIFY_CLIENT_SECRET);
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + basic,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.access_token) return null;
    // Tokens last 3600s; cache 3000s so we always refresh before expiry.
    await env.LOADOUT_BOLTS.put(SPOTIFY_TOKEN_KEY, data.access_token, {
      expirationTtl: 3000,
    });
    return data.access_token;
  } catch {
    return null;
  }
}

async function rotSearch(env, q) {
  const query = String(q || '').trim();
  if (query.length < 2) return json({ configured: true, tracks: [] });
  const token = await getSpotifyToken(env);
  if (!token) return json({ configured: false, tracks: [] }, 503);
  try {
    const res = await fetch(
      'https://api.spotify.com/v1/search?type=track&limit=8&q=' +
        encodeURIComponent(query),
      { headers: { Authorization: 'Bearer ' + token } },
    );
    if (!res.ok) return json({ configured: true, error: 'spotify', tracks: [] }, 502);
    const data = await res.json();
    const items = (data && data.tracks && data.tracks.items) || [];
    const tracks = items.map((t) => {
      const imgs = (t.album && t.album.images) || [];
      return {
        id: t.id,
        uri: t.uri,
        name: t.name,
        artist: (t.artists || []).map((a) => a.name).join(', '),
        album: (t.album && t.album.name) || '',
        durationMs: t.duration_ms || 0,
        coverUrl: imgs.length ? imgs[imgs.length - 1].url : '',
      };
    });
    return json({ configured: true, tracks });
  } catch {
    return json({ configured: true, error: 'spotify', tracks: [] }, 502);
  }
}

async function rotStateResponse(env) {
  const s = await env.LOADOUT_BOLTS.get(STATE_KEY, { type: 'json' });
  return json({
    live: await relayAlive(env),
    nowPlaying: (s && s.nowPlaying) || null,
    queue: s && Array.isArray(s.queue) ? s.queue : [],
  });
}

// Enqueue a validate trigger and poll for the widget's answer.
async function runValidate(env, text, uri) {
  const id = crypto.randomUUID();
  await env.LOADOUT_BOLTS.put(
    'relay:rotation-validate:' + id,
    JSON.stringify({ type: 'rotation-validate', id, text, uri }),
    { expirationTtl: 60 },
  );
  for (let i = 0; i < POLL_TRIES; i++) {
    await sleep(POLL_INTERVAL_MS);
    const r = await env.LOADOUT_BOLTS.get('rot:validated:' + id, { type: 'json' });
    if (r) {
      await env.LOADOUT_BOLTS.delete('rot:validated:' + id);
      return { ok: !!r.ok, reason: r.reason || null };
    }
  }
  return { ok: false, reason: 'timeout' };
}

async function rotValidate(env, body) {
  if (!(await relayAlive(env))) return json({ ok: false, reason: 'rotation-offline' });
  const text = String(body.text || '').slice(0, 300);
  const uri = String(body.uri || '').slice(0, 120);
  if (!text && !uri) return json({ ok: false, reason: 'empty' }, 400);
  const r = await runValidate(env, text, uri);
  return json(r);
}

async function rotRequest(env, guildId, userId, body) {
  if (!(await relayAlive(env))) return json({ ok: false, reason: 'rotation-offline' });

  const text = String(body.text || '').slice(0, 300);
  const uri = String(body.uri || '').slice(0, 120);
  const displayName = String(body.displayName || '').slice(0, 40) || 'Anonymous viewer';
  if (!text && !uri) return json({ ok: false, reason: 'empty' }, 400);

  const cdKey = 'rot:cd:' + guildId + ':' + userId;
  const freeKey = 'rot:freecredit:' + guildId + ':' + userId;
  const now = Date.now();
  const hasFree = (await env.LOADOUT_BOLTS.get(freeKey)) === '1';
  const last = parseInt((await env.LOADOUT_BOLTS.get(cdKey)) || '0', 10);
  if (!hasFree && last && now - last < COOLDOWN_MS) {
    return json({ ok: false, reason: 'cooldown', cooldownMs: COOLDOWN_MS - (now - last) }, 429);
  }

  // Payment — a redeemable free credit, else a verified Bits receipt.
  let paidVia = 'bits';
  if (hasFree) {
    paidVia = 'free-credit';
  } else {
    const receipt = await verifyBitsReceipt(body.bits, env.TWITCH_EXT_SECRET);
    const product = receipt && receipt.data && receipt.data.product;
    if (
      !receipt ||
      receipt.topic !== 'bits_transaction_receipt' ||
      !product ||
      product.sku !== 'song_request'
    ) {
      return json({ ok: false, reason: 'bad-payment' }, 402);
    }
  }

  // D+c hybrid: re-validate now that we hold the charge. If it fails the
  // Bits are already spent client-side, so leave a "next request free"
  // make-good credit.
  const v = await runValidate(env, text, uri);
  if (!v.ok) {
    if (paidVia === 'bits') await env.LOADOUT_BOLTS.put(freeKey, '1');
    return json({
      ok: false,
      reason: v.reason || 'validate-failed',
      refundCredit: paidVia === 'bits',
    });
  }

  // Committed — consume the free credit (if that's how this was paid).
  if (paidVia === 'free-credit') await env.LOADOUT_BOLTS.delete(freeKey);

  const requestId = crypto.randomUUID();
  await env.LOADOUT_BOLTS.put(
    'relay:rotation-request:' + requestId,
    JSON.stringify({
      type: 'rotation-request',
      requestId,
      user: userId,
      displayName,
      text,
      uri,
      paid: true,
    }),
    { expirationTtl: 60 },
  );

  let result = { ok: false, reason: 'timeout' };
  for (let i = 0; i < POLL_TRIES; i++) {
    await sleep(POLL_INTERVAL_MS);
    const r = await env.LOADOUT_BOLTS.get('rot:reqresult:' + requestId, { type: 'json' });
    if (r) {
      await env.LOADOUT_BOLTS.delete('rot:reqresult:' + requestId);
      result = { ok: !!r.ok, reason: r.reason || null };
      break;
    }
  }

  if (!result.ok) {
    if (paidVia === 'bits') await env.LOADOUT_BOLTS.put(freeKey, '1');
    return json({
      ok: false,
      reason: result.reason || 'rejected',
      refundCredit: paidVia === 'bits',
    });
  }

  await env.LOADOUT_BOLTS.put(cdKey, String(now), {
    expirationTtl: Math.ceil(COOLDOWN_MS / 1000),
  });
  return json({ ok: true, cooldownMs: COOLDOWN_MS });
}

// Dispatched from ext.js handleExt for routes under /ext/rotation/.
// `sub` is the path after "rotation/" (search | validate | request | state).
export async function handleRotation(env, guildId, userId, sub, req) {
  if (req.method === 'GET' && sub === 'search') {
    const url = new URL(req.url);
    return rotSearch(env, url.searchParams.get('q'));
  }
  if (req.method === 'GET' && sub === 'state') {
    return rotStateResponse(env);
  }
  let body = {};
  if (req.method === 'POST') {
    try {
      body = await req.json();
    } catch {
      /* empty body tolerated */
    }
  }
  if (req.method === 'POST' && sub === 'validate') return rotValidate(env, body);
  if (req.method === 'POST' && sub === 'request') {
    return rotRequest(env, guildId, userId, body);
  }
  return json({ error: 'not-found' }, 404);
}

// POST /relay/ingest — the R2 Streamer.bot relay forwards bus events here.
// RELAY_TOKEN-gated. Refreshes the relay heartbeat on every call.
export async function ingestRotation(req, env) {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const token = req.headers.get('X-Relay-Token') || '';
  if (!env.RELAY_TOKEN || token !== env.RELAY_TOKEN) {
    return json({ error: 'unauthorized' }, 401);
  }
  let evt;
  try {
    evt = await req.json();
  } catch {
    return json({ error: 'bad-json' }, 400);
  }

  await env.LOADOUT_BOLTS.put(RELAY_ALIVE_KEY, '1', { expirationTtl: 45 });

  const kind = evt && evt.kind;
  const d = (evt && evt.data) || {};
  if (kind === 'rotation.song.validated' && d.id) {
    await env.LOADOUT_BOLTS.put(
      'rot:validated:' + d.id,
      JSON.stringify({ ok: !!d.ok, reason: d.reason || null }),
      { expirationTtl: 30 },
    );
  } else if (
    (kind === 'rotation.song.accepted' || kind === 'rotation.song.rejected') &&
    d.requestId
  ) {
    await env.LOADOUT_BOLTS.put(
      'rot:reqresult:' + d.requestId,
      JSON.stringify({ ok: kind === 'rotation.song.accepted', reason: d.reason || null }),
      { expirationTtl: 30 },
    );
  } else if (kind === 'rotation.song.playing') {
    const s = (await env.LOADOUT_BOLTS.get(STATE_KEY, { type: 'json' })) || {};
    s.nowPlaying = d;
    await env.LOADOUT_BOLTS.put(STATE_KEY, JSON.stringify(s), { expirationTtl: 3600 });
  } else if (kind === 'rotation.queue.snapshot') {
    const s = (await env.LOADOUT_BOLTS.get(STATE_KEY, { type: 'json' })) || {};
    s.queue = Array.isArray(d.queue) ? d.queue.slice(0, 20) : [];
    await env.LOADOUT_BOLTS.put(STATE_KEY, JSON.stringify(s), { expirationTtl: 3600 });
  }
  return json({ ok: true });
}
