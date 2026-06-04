// Rotation song-request backend for the Twitch panel, /ext/rotation/*.
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

// ---- Per-channel config (cooldowns + chat templates) -------------------
// KV `rot:config` overrides these. Admin writes via POST /admin/rotation/config.
const CONFIG_KEY = 'rot:config';
const DEFAULT_CONFIG = {
  cooldownMs: COOLDOWN_MS,            // free-path per-viewer cooldown
  tierCooldownMs: {                   // overrides by role/tier, longest-wins removed
    mod: 1 * 60 * 1000,
    t3: 2 * 60 * 1000,
    t2: 3 * 60 * 1000,
  },
  chatEnabled: true,
  chatTemplates: {
    accepted: '✓ @{user} added {track} to the queue. eta ~{eta} min.',
    cooldown: '@{user} hold up, {mins} min before your next request.',
    failed: '@{user} request failed: {reason}.',
    playing: '▶ now playing: {track}{by}',
  },
};

export async function getRotationConfig(env) {
  let cfg = {};
  try { cfg = (await env.LOADOUT_BOLTS.get(CONFIG_KEY, { type: 'json' })) || {}; }
  catch { /* defaults */ }
  return {
    cooldownMs: Number.isFinite(cfg.cooldownMs) ? cfg.cooldownMs : DEFAULT_CONFIG.cooldownMs,
    tierCooldownMs: { ...DEFAULT_CONFIG.tierCooldownMs, ...(cfg.tierCooldownMs || {}) },
    chatEnabled: cfg.chatEnabled !== false,
    chatTemplates: { ...DEFAULT_CONFIG.chatTemplates, ...(cfg.chatTemplates || {}) },
  };
}

// Effective per-viewer cooldown. Mods/broadcaster get the shortest; paid
// Patreon tiers shave it down; everyone else gets the channel default.
// `status` is the panel's Twitch.ext.viewer snapshot (role + subscription).
async function effectiveCooldownMs(env, userId, status, cfg) {
  const role = String((status && (status.role || status.broadcaster)) || '').toLowerCase();
  if (role === 'broadcaster' || role === 'moderator' || (status && status.mod)) {
    return cfg.tierCooldownMs.mod;
  }
  try {
    const rec = await env.LOADOUT_BOLTS.get(`patreon:tier:${userId}`, { type: 'json' });
    const tier = String((rec && (rec.tier || rec.tierName)) || '').toLowerCase();
    if (tier.includes('3') || tier.includes('t3') || tier === 'tier3') return cfg.tierCooldownMs.t3;
    if (tier.includes('2') || tier.includes('t2') || tier === 'tier2') return cfg.tierCooldownMs.t2;
  } catch { /* no patreon record */ }
  return cfg.cooldownMs;
}

// ---- Streamer.bot chat notifications -----------------------------------
// Mirrors the overlay relay (enqueueOverlay -> relay:overlay-*): we drop a
// trigger on `relay:rotchat-*` that a Streamer.bot action polls via
// GET /relay/pending?for=rotation-chat and posts to Twitch chat. The prefix
// deliberately differs from `relay:rotation-` so the widget bridge poller
// never drains these. See ROTATION-STREAMERBOT.md.
function renderTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
}

const REASON_COPY = {
  'not-found': "couldn't find that track",
  'empty': 'nothing to search',
  'banned': 'that track is blocked',
  'banned-word': 'that title has a blocked word',
  'queue-full': 'the queue is full',
  'duplicate': "that's already in the queue",
  'too-long': 'that track is too long',
  'explicit': 'explicit is off and no clean version exists',
  'explicit-no-clean': 'explicit is off and no clean version exists',
  'rotation-offline': 'rotation is offline',
  'timeout': 'timed out, try again',
  'status-locked': 'you cannot request right now',
};

async function enqueueRotationChat(env, type, vars, cfg) {
  try {
    const conf = cfg || (await getRotationConfig(env));
    if (!conf.chatEnabled) return;
    const tpl = conf.chatTemplates[type];
    if (!tpl) return;
    const message = renderTemplate(tpl, vars).slice(0, 480).trim();
    if (!message) return;
    await env.LOADOUT_BOLTS.put(
      `relay:rotchat-${crypto.randomUUID()}`,
      JSON.stringify({ type: 'chat', notifType: type, message }),
      { expirationTtl: 60 },
    );
  } catch { /* chat is best-effort, never blocks a request */ }
}

// Render a chat-notification template WITHOUT enqueueing it, so the panel
// test harness can dry-run what a given notification would post.
export async function renderChatPreview(env, type, vars) {
  const cfg = await getRotationConfig(env);
  const tpl = cfg.chatTemplates[type] || '';
  return { type, template: tpl, message: renderTemplate(tpl, vars || {}), enabled: cfg.chatEnabled };
}

// Rough queue ETA in whole minutes from the cached queue (sum of track
// durations when present, else ~3.5 min each). Floor of 1.
function queueEtaMin(state) {
  const q = (state && Array.isArray(state.queue)) ? state.queue : [];
  let ms = 0;
  for (const t of q) ms += Number(t && (t.durationMs || t.duration_ms)) || 210000;
  return Math.max(1, Math.round(ms / 60000));
}

// ---- YouTube URL detection + oEmbed title lookup -----------------------
const YT_HOST_RE = /(?:^|\/\/|\.)(?:youtube\.com|youtu\.be|music\.youtube\.com)\b/i;
function looksLikeYouTube(s) { return YT_HOST_RE.test(String(s || '')); }

function youtubeIdOf(s) {
  const str = String(s || '');
  const pats = [
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/embed\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/live\/([A-Za-z0-9_-]{11})/,
  ];
  for (const p of pats) { const m = str.match(p); if (m) return m[1]; }
  return null;
}

async function youtubeTitle(url) {
  try {
    const res = await fetch(
      'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(url),
      { headers: { 'User-Agent': 'aquilo-rotation/1.0' } },
    );
    if (!res.ok) return null;
    const d = await res.json();
    return d && d.title ? String(d.title) : null;
  } catch { return null; }
}

// Strip the usual YouTube-title cruft so the leftover is close to
// "Artist - Song" before it hits Spotify search.
function cleanTrackTitle(raw) {
  let s = String(raw || '');
  // Drop bracketed qualifiers that carry video/quality/version cruft.
  s = s.replace(
    /[([{][^)\]}]*(official|video|lyric|lyrics|audio|hd|hq|4k|mv|m\/v|visuali[sz]er|live|remaster\w*|explicit|clean|extended|edit|color\s*coded|sub\w*|tradu\w*)[^)\]}]*[)\]}]/gi,
    ' ',
  );
  s = s.replace(/\s*-\s*topic\s*$/i, '');
  s = s.replace(
    /\b(official\s+music\s+video|official\s+video|official\s+audio|music\s+video|lyric\s+video|lyrics?|visuali[sz]er|hd|hq|4k|mv)\b/gi,
    ' ',
  );
  s = s.replace(/["“”]/g, '');
  s = s.replace(/\s{2,}/g, ' ').replace(/\s*[-|:]\s*$/, '').trim();
  return s;
}

// Split "Artist - Song" into a structured query when a clear separator
// exists, so Spotify can field-match instead of fuzzing the whole string.
function splitArtistTitle(s) {
  const m = String(s || '').split(/\s+[-\u2013\u2014]\s+/);
  if (m.length === 2 && m[0].trim() && m[1].trim()) {
    return { artist: m[0].trim(), song: m[1].trim() };
  }
  return null;
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

// ---- Spotify search + ranking ------------------------------------------
// Keywords that mark a result as a cover/karaoke/instrumental knockoff. We
// push these to the bottom so the real recording wins.
const JUNK_RE = /\b(karaoke|tribute|made famous by|in the style of|as made famous|instrumental|backing track|originally performed|8[\s-]?bit|lullaby|piano version|workout mix|nightcore|cover version|guitar backing|metal cover|remix tribute)\b/i;

function mapTrack(t) {
  const imgs = (t.album && t.album.images) || [];
  return {
    id: t.id,
    uri: t.uri,
    name: t.name,
    artist: (t.artists || []).map((a) => a.name).join(', '),
    album: (t.album && t.album.name) || '',
    durationMs: t.duration_ms || 0,
    explicit: !!t.explicit,
    popularity: typeof t.popularity === 'number' ? t.popularity : 0,
    coverUrl: imgs.length ? imgs[imgs.length - 1].url : '',
  };
}

// Raw Spotify track search -> mapped tracks (carries explicit + popularity).
async function spotifyTracks(env, q, limit = 12) {
  const token = await getSpotifyToken(env);
  if (!token) return { configured: false, tracks: [] };
  try {
    const res = await fetch(
      'https://api.spotify.com/v1/search?type=track&limit=' + limit + '&q=' + encodeURIComponent(q),
      { headers: { Authorization: 'Bearer ' + token } },
    );
    if (!res.ok) return { configured: true, error: 'spotify', tracks: [] };
    const data = await res.json();
    const items = (data && data.tracks && data.tracks.items) || [];
    return { configured: true, tracks: items.map(mapTrack) };
  } catch {
    return { configured: true, error: 'spotify', tracks: [] };
  }
}

// Rank: popularity-led, hard-deprioritize covers/karaoke/instrumental, small
// bonus when the artist the query named is the one on the track (helps the
// original beat a same-titled remix). Stable for ties.
function rankTracks(tracks, opts = {}) {
  const wantArtist = String(opts.artist || '').toLowerCase();
  return tracks
    .map((t, i) => {
      let score = t.popularity || 0;
      const hay = (t.name + ' ' + t.artist).toLowerCase();
      if (JUNK_RE.test(hay)) score -= 1000;
      if (wantArtist && t.artist.toLowerCase().includes(wantArtist)) score += 40;
      return { t, score, i };
    })
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.t);
}

// Find a clean (non-explicit) version of the same song. Returns a track or null.
export async function findCleanVersion(env, artist, song) {
  if (!song) return null;
  const q = (artist ? 'artist:"' + artist + '" ' : '') + 'track:"' + song + '"';
  const r = await spotifyTracks(env, q, 12);
  const clean = rankTracks((r.tracks || []).filter((t) => !t.explicit), { artist });
  if (clean.length) return clean[0];
  const r2 = await spotifyTracks(env, [artist, song, 'clean'].filter(Boolean).join(' '), 12);
  const clean2 = rankTracks((r2.tracks || []).filter((t) => !t.explicit), { artist });
  return clean2[0] || null;
}

// Resolve any user input (free text OR a YouTube URL) to ranked Spotify
// tracks. YouTube URLs are converted to a search string via oEmbed title.
export async function resolveQuery(env, rawQuery) {
  let query = String(rawQuery || '').trim();
  let artist = null;
  let viaYouTube = false;
  if (looksLikeYouTube(query) && youtubeIdOf(query)) {
    const title = await youtubeTitle(query);
    if (!title) return { configured: true, tracks: [], error: 'youtube-title' };
    viaYouTube = true;
    query = cleanTrackTitle(title);
  }
  const split = splitArtistTitle(query);
  let searchQ = query;
  if (split) {
    artist = split.artist;
    searchQ = 'track:"' + split.song + '" artist:"' + split.artist + '"';
  }
  let r = await spotifyTracks(env, searchQ, 12);
  // A field-filtered search can come back empty on a loose title; retry raw.
  if (r.configured && (!r.tracks || !r.tracks.length) && split) {
    r = await spotifyTracks(env, query, 12);
  }
  if (!r.configured) return { configured: false, tracks: [] };
  return { configured: true, tracks: rankTracks(r.tracks || [], { artist }), viaYouTube, error: r.error };
}

async function rotSearch(env, q) {
  const query = String(q || '').trim();
  if (query.length < 2) return json({ configured: true, tracks: [] });
  const r = await resolveQuery(env, query);
  if (!r.configured) return json({ configured: false, tracks: [] }, 503);
  if (r.error === 'spotify') return json({ configured: true, error: 'spotify', tracks: [] }, 502);
  return json({ configured: true, tracks: (r.tracks || []).slice(0, 8), viaYouTube: !!r.viaYouTube });
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
  const chatUser = String(body.displayName || body.user || userId).slice(0, 40);
  const cdKey = `rot:cd:${guildId}:${userId}`;
  const freeKey = `rot:freecredit:${guildId}:${userId}`;
  const now = Date.now();
  const hasFree = (await env.LOADOUT_BOLTS.get(freeKey)) === '1';
  const last = parseInt((await env.LOADOUT_BOLTS.get(cdKey)) || '0', 10);

  const cfg = await getRotationConfig(env);
  const cdMs = await effectiveCooldownMs(env, userId, body.status, cfg);

  // Authoritative viewer state from the widget decides bits vs free.
  const vs = await runViewerQuery(env, user, body.status);
  if (!vs) return json({ ok: false, reason: 'rotation-offline' });
  if (!vs.allowedByStatus) {
    return json({ ok: false, reason: 'status-locked', statusReason: vs.statusReason || '' });
  }
  const bitsRequired = !hasFree && deriveBitsRequired(vs);

  // Payment gate, Bits receipt only required when bitsRequired. A Bits-paid
  // request bypasses the per-viewer cooldown (the bits ARE the skip).
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
  } else if (!hasFree && last && now - last < cdMs) {
    // Free path respects the per-viewer cooldown (tier-adjusted).
    const remainingMs = cdMs - (now - last);
    await enqueueRotationChat(env, 'cooldown',
      { user: chatUser, mins: Math.max(1, Math.ceil(remainingMs / 60000)) }, cfg);
    return json({ ok: false, reason: 'cooldown', cooldownMs: remainingMs }, 429);
  }

  const paid = bitsRequired || hasFree;

  // D+c hybrid, re-validate now we hold the charge. If the widget rejects an
  // explicit track and explicit is off, try a clean version of the same song
  // before giving up.
  let reqText = text;
  let reqUri = uri;
  let v = await runValidate(env, reqText, reqUri, paid);
  if (!v.ok && /explicit/i.test(String(v.reason || ''))) {
    const split = splitArtistTitle(text);
    const song = split ? split.song : cleanTrackTitle(text);
    const clean = await findCleanVersion(env, split ? split.artist : null, song);
    if (clean) {
      const v2 = await runValidate(env, clean.name, clean.uri, paid);
      if (v2.ok) { v = v2; reqText = clean.name; reqUri = clean.uri; }
      else v = { ok: false, reason: 'explicit-no-clean' };
    } else {
      v = { ok: false, reason: 'explicit-no-clean' };
    }
  }
  if (!v.ok) {
    if (bitsRequired) await env.LOADOUT_BOLTS.put(freeKey, '1');
    await enqueueRotationChat(env, 'failed',
      { user: chatUser, reason: REASON_COPY[v.reason] || v.reason || 'rejected' }, cfg);
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
      text: reqText,
      uri: reqUri,
      paid,
    },
    'rot:reqresult:',
    requestId,
  );
  if (!result || !result.ok) {
    if (bitsRequired) await env.LOADOUT_BOLTS.put(freeKey, '1');
    const reason = (result && result.reason) || 'rejected';
    await enqueueRotationChat(env, 'failed',
      { user: chatUser, reason: REASON_COPY[reason] || reason }, cfg);
    return json({ ok: false, reason, refundCredit: bitsRequired });
  }

  await env.LOADOUT_BOLTS.put(cdKey, String(now), {
    expirationTtl: Math.ceil(cdMs / 1000),
  });
  await recordStat(env, guildId, userId, { songs_requested: 1 });

  const state = (await env.LOADOUT_BOLTS.get(STATE_KEY, { type: 'json' })) || {};
  await enqueueRotationChat(env, 'accepted',
    { user: chatUser, track: reqText || 'your track', eta: queueEtaMin(state) }, cfg);

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

// GET/POST /admin/rotation/config, gated by RELAY_TOKEN (the same shared
// secret Streamer.bot + Clay's admin tooling already hold). GET returns the
// merged effective config; POST shallow-merges { cooldownMs?, tierCooldownMs?,
// chatEnabled?, chatTemplates? } into KV `rot:config`. All values are clamped.
export async function handleRotationConfig(req, env) {
  const token = req.headers.get('X-Relay-Token') || '';
  if (!env.RELAY_TOKEN || token !== env.RELAY_TOKEN) {
    return json({ error: 'unauthorized' }, 401);
  }
  if (req.method === 'GET') {
    return json({ ok: true, config: await getRotationConfig(env) });
  }
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  let body = {};
  try { body = await req.json(); } catch { return json({ error: 'bad-json' }, 400); }
  const cur = (await env.LOADOUT_BOLTS.get(CONFIG_KEY, { type: 'json' })) || {};
  const next = { ...cur };
  const clampMs = (n) => Math.max(0, Math.min(3600000, Math.floor(n)));
  if (Number.isFinite(body.cooldownMs)) next.cooldownMs = clampMs(body.cooldownMs);
  if (typeof body.chatEnabled === 'boolean') next.chatEnabled = body.chatEnabled;
  if (body.tierCooldownMs && typeof body.tierCooldownMs === 'object') {
    next.tierCooldownMs = { ...(cur.tierCooldownMs || {}) };
    for (const k of ['mod', 't2', 't3']) {
      if (Number.isFinite(body.tierCooldownMs[k])) next.tierCooldownMs[k] = clampMs(body.tierCooldownMs[k]);
    }
  }
  if (body.chatTemplates && typeof body.chatTemplates === 'object') {
    next.chatTemplates = { ...(cur.chatTemplates || {}) };
    for (const k of ['accepted', 'cooldown', 'failed', 'playing']) {
      if (typeof body.chatTemplates[k] === 'string') {
        next.chatTemplates[k] = body.chatTemplates[k].slice(0, 480);
      }
    }
  }
  await env.LOADOUT_BOLTS.put(CONFIG_KEY, JSON.stringify(next));
  return json({ ok: true, config: await getRotationConfig(env) });
}

// POST /relay/ingest, the widget extension bridge forwards results here.
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
    // Announce the track change in chat (best-effort, fires once per song).
    const track =
      d.name || d.title || d.track ||
      (d.artist && d.song ? d.artist + ' - ' + d.song : '') || 'a track';
    const who = d.requestedBy || d.requester || d.user || d.displayName || '';
    const by = who ? ' (requested by @' + String(who).slice(0, 40) + ')' : '';
    await enqueueRotationChat(env, 'playing', { track, by });
  } else if (kind === 'rotation.queue.snapshot') {
    const s = (await env.LOADOUT_BOLTS.get(STATE_KEY, { type: 'json' })) || {};
    s.queue = Array.isArray(d.queue) ? d.queue.slice(0, 20) : [];
    await env.LOADOUT_BOLTS.put(STATE_KEY, JSON.stringify(s), { expirationTtl: 3600 });
  }
  return json({ ok: true });
}
