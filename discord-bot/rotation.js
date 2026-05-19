// Rotation song-request backend for the Twitch panel — /ext/rotation/*.
//
// Send path is HTTP poll/ingest: the Rotation widget's extension bridge
// (gated on streamer.extensionEnabled) polls /relay/pending?for=rotation,
// runs each trigger through its own engine, and POSTs results to
// /relay/ingest. The panel reads now-playing/queue from the relay's
// WebSocket room directly; this Worker only mediates the Bits-verified
// send path + viewer-state.
//
// Config (Worker secrets / vars): SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET
//   (search), TWITCH_EXT_SECRET (auth + Bits-receipt verify), RELAY_TOKEN
//   (/relay/* gate), CLAY_TWITCH_CHANNEL_ID (relay room-key derivation).
//
// Relay room key (also computed widget-side in extension-bridge.js):
//   roomKey = sha256hex("aquilo-extension|" + CLAY_TWITCH_CHANNEL_ID)
//
// KV (LOADOUT_BOLTS):
//   spotify:apptoken                 cached Spotify app token (~50m)
//   rot:relay:alive                  relay heartbeat (/relay/ingest)
//   rot:state                        { nowPlaying, queue } cache
//   rot:validated:<id>               dry-run result
//   rot:viewerstate:<id>             viewer-state result
//   rot:reqresult:<requestId>        accept/reject result
//   rot:cd:<guild>:<userId>          per-viewer request cooldown stamp
//   rot:freecredit:<guild>:<userId>  "next request free" make-good credit
//   relay:rotation-{validate,request,viewer-query}:<id>  queued triggers

import { verifyBitsReceipt } from './auth.js';
import { recordStat } from './recap.js';

import { json } from './ext-shared.js';

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

// Generic enqueue-trigger + poll-for-result roundtrip.
async function roundtrip(env, triggerKey, trigger, resultKeyPrefix, id) {
  await env.LOADOUT_BOLTS.put(triggerKey, JSON.stringify(trigger), {
    expirationTtl: 60,
  });
  for (let i = 0; i < POLL_TRIES; i++) {
    await sleep(POLL_INTERVAL_MS);
    const r = await env.LOADOUT_BOLTS.get(resultKeyPrefix + id, { type: 'json' });
    if (r) {
      await env.LOADOUT_BOLTS.delete(resultKeyPrefix + id);
      return r;
    }
  }
  return null;
}

async function runValidate(env, text, uri, paid) {
  const id = crypto.randomUUID();
  const r = await roundtrip(
    env,
    'relay:rotation-validate:' + id,
    { type: 'rotation-validate', id, text, uri, paid: !!paid },
    'rot:validated:',
    id,
  );
  return r ? { ok: !!r.ok, reason: r.reason || null } : { ok: false, reason: 'timeout' };
}

// Ask the widget for a viewer's request state. `status` is the panel's
// Twitch.ext.viewer snapshot; the widget maps it to its role model.
async function runViewerQuery(env, user, status) {
  const id = crypto.randomUUID();
  const r = await roundtrip(
    env,
    'relay:rotation-viewer-query:' + id,
    { type: 'rotation-viewer-query', id, user, status: status || {} },
    'rot:viewerstate:',
    id,
  );
  return r || null;
}

function deriveBitsRequired(vs) {
  if (!vs || !vs.allowedByStatus) return false;
  return (vs.freeRequestsLeft || 0) === 0 || (vs.cooldownMsRemaining || 0) > 0;
}

async function rotState(env, guildId, userId, body) {
  const cached = (await env.LOADOUT_BOLTS.get(STATE_KEY, { type: 'json' })) || {};
  const live = await relayAlive(env);
  let viewer = null;
  if (live) {
    const user = String(body.user || userId);
    const vs = await runViewerQuery(env, user, body.status);
    if (vs) {
      const hasFree = (await env.LOADOUT_BOLTS.get(`rot:freecredit:${guildId}:${userId}`)) === '1';
      viewer = {
        freeRequestsLeft: vs.freeRequestsLeft || 0,
        cooldownMsRemaining: vs.cooldownMsRemaining || 0,
        allowedByStatus: !!vs.allowedByStatus,
        statusReason: vs.statusReason || '',
        bitsRequired: !hasFree && deriveBitsRequired(vs),
      };
    }
  }
  return json({
    live,
    nowPlaying: cached.nowPlaying || null,
    queue: Array.isArray(cached.queue) ? cached.queue : [],
    viewer,
  });
}

async function rotValidate(env, body) {
  if (!(await relayAlive(env))) return json({ ok: false, reason: 'rotation-offline' });
  const text = String(body.text || '').slice(0, 300);
  const uri = String(body.uri || '').slice(0, 120);
  if (!text && !uri) return json({ ok: false, reason: 'empty' }, 400);
  return json(await runValidate(env, text, uri, !!body.paid));
}

async function rotRequest(env, guildId, userId, body) {
  if (!(await relayAlive(env))) return json({ ok: false, reason: 'rotation-offline' });

  const text = String(body.text || '').slice(0, 300);
  const uri = String(body.uri || '').slice(0, 120);
  const displayName = String(body.displayName || '').slice(0, 40) || 'Anonymous viewer';
  if (!text && !uri) return json({ ok: false, reason: 'empty' }, 400);

  const user = String(body.user || userId);
  const cdKey = `rot:cd:${guildId}:${userId}`;
  const freeKey = `rot:freecredit:${guildId}:${userId}`;
  const now = Date.now();
  const hasFree = (await env.LOADOUT_BOLTS.get(freeKey)) === '1';
  const last = parseInt((await env.LOADOUT_BOLTS.get(cdKey)) || '0', 10);

  // Authoritative viewer state from the widget decides bits vs free.
  const vs = await runViewerQuery(env, user, body.status);
  if (!vs) return json({ ok: false, reason: 'rotation-offline' });
  if (!vs.allowedByStatus) {
    return json({ ok: false, reason: 'status-locked', statusReason: vs.statusReason || '' });
  }
  const bitsRequired = !hasFree && deriveBitsRequired(vs);

  // Payment gate — Bits receipt only required when bitsRequired.
  if (bitsRequired) {
    const receipt = await verifyBitsReceipt(body.bits, env.TWITCH_EXT_SECRET);
    const product = receipt && receipt.data && receipt.data.product;
    if (
      !receipt ||
      receipt.topic !== 'bits_transaction_receipt' ||
      !product ||
      product.sku !== 'song_request'
    ) {
      return json({ ok: false, reason: 'bad-payment', bitsRequired: true }, 402);
    }
  } else if (!hasFree && last && now - last < COOLDOWN_MS) {
    // Free path still respects the per-viewer Worker cooldown.
    return json({ ok: false, reason: 'cooldown', cooldownMs: COOLDOWN_MS - (now - last) }, 429);
  }

  const paid = bitsRequired || hasFree;

  // D+c hybrid — re-validate now we hold the charge.
  const v = await runValidate(env, text, uri, paid);
  if (!v.ok) {
    if (bitsRequired) await env.LOADOUT_BOLTS.put(freeKey, '1');
    return json({
      ok: false,
      reason: v.reason || 'validate-failed',
      refundCredit: bitsRequired,
    });
  }
  if (hasFree) await env.LOADOUT_BOLTS.delete(freeKey);

  const requestId = crypto.randomUUID();
  const result = await roundtrip(
    env,
    'relay:rotation-request:' + requestId,
    {
      type: 'rotation-request',
      requestId,
      user,
      displayName,
      text,
      uri,
      paid,
    },
    'rot:reqresult:',
    requestId,
  );
  if (!result || !result.ok) {
    if (bitsRequired) await env.LOADOUT_BOLTS.put(freeKey, '1');
    return json({
      ok: false,
      reason: (result && result.reason) || 'rejected',
      refundCredit: bitsRequired,
    });
  }

  await env.LOADOUT_BOLTS.put(cdKey, String(now), {
    expirationTtl: Math.ceil(COOLDOWN_MS / 1000),
  });
  await recordStat(env, guildId, userId, { songs_requested: 1 });
  return json({ ok: true });
}

// Dispatched from ext.js handleExt for routes under /ext/rotation/.
export async function handleRotation(env, guildId, userId, sub, req) {
  if (req.method === 'GET' && sub === 'search') {
    const url = new URL(req.url);
    return rotSearch(env, url.searchParams.get('q'));
  }
  let body = {};
  if (req.method === 'POST') {
    try {
      body = await req.json();
    } catch {
      /* empty body tolerated */
    }
  }
  if (req.method === 'POST' && sub === 'state') {
    return rotState(env, guildId, userId, body);
  }
  if (req.method === 'POST' && sub === 'validate') return rotValidate(env, body);
  if (req.method === 'POST' && sub === 'request') {
    return rotRequest(env, guildId, userId, body);
  }
  return json({ error: 'not-found' }, 404);
}

// POST /relay/ingest — the widget extension bridge forwards results here.
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

  await env.LOADOUT_BOLTS.put(RELAY_ALIVE_KEY, '1', { expirationTtl: 60 });

  const kind = evt && evt.kind;
  const d = (evt && evt.data) || {};
  if (kind === 'rotation.song.validated' && d.id) {
    await env.LOADOUT_BOLTS.put(
      'rot:validated:' + d.id,
      JSON.stringify({ ok: !!d.ok, reason: d.reason || null }),
      { expirationTtl: 60 },
    );
  } else if (kind === 'rotation.viewer.state' && d.id) {
    await env.LOADOUT_BOLTS.put(
      'rot:viewerstate:' + d.id,
      JSON.stringify({
        freeRequestsLeft: d.freeRequestsLeft || 0,
        cooldownMsRemaining: d.cooldownMsRemaining || 0,
        allowedByStatus: !!d.allowedByStatus,
        statusReason: d.statusReason || '',
      }),
      { expirationTtl: 60 },
    );
  } else if (
    (kind === 'rotation.song.accepted' || kind === 'rotation.song.rejected') &&
    d.requestId
  ) {
    await env.LOADOUT_BOLTS.put(
      'rot:reqresult:' + d.requestId,
      JSON.stringify({ ok: kind === 'rotation.song.accepted', reason: d.reason || null }),
      { expirationTtl: 60 },
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
