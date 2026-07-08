// Aquilo Dock — the per-streamer OBS control panel (widget.aquilo.gg/dock).
//
// Pairing: the streamer signs in with their Aquilo account (Twitch) on the
// dock page in a normal browser; POST /api/dock/mint returns a permanent
// dock key bound to their login. The OBS custom browser dock loads
// /dock/?key=<key> and calls GET /api/aqdock/state — no cookies or sign-in
// inside OBS, same model as the Jukebox dock.
//
//   POST /api/aqdock/mint    (Authorization: Bearer <aquilo account token>)
//        → { ok, key, login }        one stable key per login (re-mint safe)
//   GET  /api/aqdock/state?key=<key>
//        → { ok, login, connections:{twitch,kick,youtube,spotify},
//            rotationDockKey, multigoalRev, punchcardClaimed }
//
// The key doubles as the overlay-test pair token: overlay URLs the dock
// hands out carry `pair=<key>`, so its Test buttons can ping live sources
// through the existing /api/overlay-test relay.

import { loginToId } from './warden-twitch.js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
  });
}

const KEY = {
  byKey: (k) => 'aqdock:key:' + k,
  // Twitch logins keep the original un-namespaced key (back-compat);
  // Kick/YouTube-anchored docks namespace by provider so a Kick "foo"
  // can't collide with a Twitch "foo".
  byLogin: (l, provider) =>
    'aqdock:login:' + (provider && provider !== 'twitch' ? provider + ':' : '') + l,
};

function randKey() {
  const b = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(b).map((x) => (x % 36).toString(36)).join('') + 'dk';
}

// ── Stream info: one title + category, applied across platforms ──────
// Tokens come from the auth broker's vault endpoints (it holds every
// platform's client secret and refreshes in place): Twitch via
// /twitch/vault/token, Kick + YouTube via /<platform>/vault/token.
// Never cached here; the broker caches refreshes itself.
const BROKER = 'https://auth.aquilo.gg';

async function vaultTwitchToken(env, twitchId) {
  if (!env.VAULT_SERVICE_SECRET) return null;
  try {
    const r = await fetch(BROKER + '/twitch/vault/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ service: env.VAULT_SERVICE_SECRET, twitchId: String(twitchId), role: 'broadcaster' }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return (j && j.access_token) ? { token: j.access_token, clientId: j.client_id } : null;
  } catch { return null; }
}

// Fresh Kick/YouTube broadcaster token for a dock owner. Platform-
// anchored owners (paired via Kick/YT sign-in) resolve by their own
// platform id; Twitch-anchored owners resolve via the tw2<platform>
// pointer the broker wrote at connect time.
async function vaultPlatformToken(env, platform, owner) {
  if (!env.VAULT_SERVICE_SECRET) return null;
  const body = { service: env.VAULT_SERVICE_SECRET, role: 'broadcaster' };
  if (owner && typeof owner === 'object') {
    if (owner.provider === platform && owner.platformId) body.id = String(owner.platformId);
    else if (owner.twitchId) body.twitchId = String(owner.twitchId);
    else return null;
  } else {
    // Legacy call shape: a bare twitchId.
    body.twitchId = String(owner);
  }
  try {
    const r = await fetch(BROKER + '/' + platform + '/vault/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return (j && j.access_token) ? j.access_token : null;
  } catch { return null; }
}

// Resolve a dock key to { login, provider, platformId, twitchId } or
// null. provider defaults to twitch (legacy recs); ONLY twitch logins
// go through loginToId — resolving a Kick/YT login as a Twitch name
// could silently pick up an unrelated Twitch user.
async function dockOwner(env, k) {
  if (!/^[a-z0-9]{8,40}$/.test(String(k || ''))) return null;
  let rec = null;
  try { rec = await env.LOADOUT_BOLTS.get(KEY.byKey(k), { type: 'json' }); } catch { /* miss */ }
  if (!rec || !rec.login) return null;
  const provider = rec.provider || 'twitch';
  let twitchId = null;
  if (provider === 'twitch') {
    const who = await loginToId(env, rec.login);
    twitchId = (who && who.id) || null;
  }
  return { login: rec.login, provider, platformId: rec.platformId || null, twitchId };
}

// Current per-platform stream info, best-effort each.
async function readStreamInfo(env, owner) {
  const out = {
    twitch: { connected: false, title: null, game: null, gameId: null },
    kick: { connected: false, title: null, category: null, categoryId: null },
    youtube: { connected: false, title: null, broadcastId: null, lifeCycle: null },
  };
  const [tw, kickTok, ytTok] = await Promise.all([
    (async () => {
      if (!owner.twitchId) return null;
      try {
        const { getChannelGame } = await import('./twitch-helix.js');
        return await getChannelGame(env, owner.twitchId);
      } catch { return null; }
    })(),
    vaultPlatformToken(env, 'kick', owner),
    vaultPlatformToken(env, 'youtube', owner),
  ]);
  if (tw) {
    out.twitch = { connected: true, title: tw.title || '', game: tw.gameName || '', gameId: tw.gameId || null };
  }
  if (kickTok) {
    try {
      const r = await fetch('https://api.kick.com/public/v1/channels', {
        headers: { Authorization: 'Bearer ' + kickTok, Accept: 'application/json' },
      });
      if (r.ok) {
        const j = await r.json();
        const c = j && Array.isArray(j.data) && j.data[0];
        if (c) {
          out.kick = {
            connected: true,
            title: c.stream_title || '',
            category: (c.category && c.category.name) || null,
            categoryId: (c.category && c.category.id) || null,
          };
        } else out.kick.connected = true;
      }
    } catch { /* kick unreachable */ }
  }
  if (ytTok) {
    out.youtube.connected = true;
    try {
      const r = await fetch('https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet,status&mine=true&maxResults=10', {
        headers: { Authorization: 'Bearer ' + ytTok },
      });
      if (r.ok) {
        const j = await r.json();
        const items = (j && j.items) || [];
        // Prefer the live broadcast, else the next upcoming/ready one.
        const rank = (s) => (s === 'live' ? 0 : s === 'liveStarting' ? 1 : s === 'ready' ? 2 : s === 'created' ? 3 : 9);
        items.sort((a, b) => rank(a.status && a.status.lifeCycleStatus) - rank(b.status && b.status.lifeCycleStatus));
        const b = items[0];
        if (b && rank(b.status && b.status.lifeCycleStatus) < 9) {
          out.youtube.title = (b.snippet && b.snippet.title) || '';
          out.youtube.broadcastId = b.id;
          out.youtube.lifeCycle = b.status && b.status.lifeCycleStatus;
        }
      }
    } catch { /* yt unreachable */ }
  }
  return out;
}

async function applyTwitch(env, owner, title, gameId) {
  const twitchId = owner.twitchId;
  if (!twitchId) return { ok: false, error: 'not-connected' };
  const auth = await vaultTwitchToken(env, twitchId);
  if (!auth) return { ok: false, error: 'not-connected' };
  const body = {};
  if (title != null) body.title = String(title).slice(0, 140);
  if (gameId) body.game_id = String(gameId);
  if (!Object.keys(body).length) return { ok: true, skipped: true };
  try {
    const r = await fetch('https://api.twitch.tv/helix/channels?broadcaster_id=' + encodeURIComponent(twitchId), {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + auth.token, 'Client-Id': auth.clientId, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.status === 204) return { ok: true };
    const j = await r.json().catch(() => null);
    return { ok: false, error: (j && j.message) || ('twitch-' + r.status) };
  } catch { return { ok: false, error: 'twitch-unreachable' }; }
}

async function applyKick(env, owner, title, categoryId) {
  const tok = await vaultPlatformToken(env, 'kick', owner);
  if (!tok) return { ok: false, error: 'not-connected' };
  const body = {};
  if (title != null) body.stream_title = String(title).slice(0, 140);
  if (categoryId) body.category_id = Number(categoryId);
  if (!Object.keys(body).length) return { ok: true, skipped: true };
  try {
    const r = await fetch('https://api.kick.com/public/v1/channels', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.ok || r.status === 204) return { ok: true };
    const j = await r.json().catch(() => null);
    return { ok: false, error: (j && (j.message || j.error)) || ('kick-' + r.status) };
  } catch { return { ok: false, error: 'kick-unreachable' }; }
}

async function applyYouTube(env, owner, title) {
  if (title == null) return { ok: true, skipped: true };
  const tok = await vaultPlatformToken(env, 'youtube', owner);
  if (!tok) return { ok: false, error: 'not-connected' };
  try {
    // Find the live (or next upcoming) broadcast, then update its snippet.
    const lr = await fetch('https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet,status&mine=true&maxResults=10', {
      headers: { Authorization: 'Bearer ' + tok },
    });
    if (!lr.ok) {
      const ej = await lr.json().catch(() => null);
      const reason = ej && ej.error && ((ej.error.errors && ej.error.errors[0] && ej.error.errors[0].reason) || ej.error.message);
      return { ok: false, error: reason ? String(reason).slice(0, 80) : 'youtube-' + lr.status };
    }
    const lj = await lr.json();
    const items = (lj && lj.items) || [];
    const rank = (s) => (s === 'live' ? 0 : s === 'liveStarting' ? 1 : s === 'ready' ? 2 : s === 'created' ? 3 : 9);
    items.sort((a, b) => rank(a.status && a.status.lifeCycleStatus) - rank(b.status && b.status.lifeCycleStatus));
    const b = items[0];
    if (!b || rank(b.status && b.status.lifeCycleStatus) === 9) return { ok: false, error: 'no-broadcast' };
    // YouTube requires the snippet's scheduledStartTime to survive the
    // update; send the existing snippet back with only the title changed.
    const snippet = b.snippet || {};
    snippet.title = String(title).slice(0, 100);
    const ur = await fetch('https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet', {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: b.id, snippet }),
    });
    if (ur.ok) return { ok: true };
    const uj = await ur.json().catch(() => null);
    const msg = uj && uj.error && uj.error.message;
    return { ok: false, error: msg ? String(msg).slice(0, 80) : 'youtube-' + ur.status };
  } catch { return { ok: false, error: 'youtube-unreachable' }; }
}

// Send a chat line to the streamer's own Twitch chat as themselves
// (vault broadcaster token carries user:write:chat).
async function twitchChatSay(env, owner, text) {
  const twitchId = owner.twitchId;
  if (!twitchId) return { ok: false, error: 'not-connected' };
  const auth = await vaultTwitchToken(env, twitchId);
  if (!auth) return { ok: false, error: 'not-connected' };
  try {
    const r = await fetch('https://api.twitch.tv/helix/chat/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + auth.token, 'Client-Id': auth.clientId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ broadcaster_id: String(twitchId), sender_id: String(twitchId), message: String(text).slice(0, 480) }),
    });
    if (r.ok) return { ok: true };
    const j = await r.json().catch(() => null);
    return { ok: false, error: (j && j.message) || ('twitch-' + r.status) };
  } catch { return { ok: false, error: 'twitch-unreachable' }; }
}

// Send a chat line to the streamer's own Kick chat as themselves.
async function kickChatSay(env, owner, text) {
  const tok = await vaultPlatformToken(env, 'kick', owner);
  if (!tok) return { ok: false, error: 'not-connected' };
  try {
    const cr = await fetch('https://api.kick.com/public/v1/channels', {
      headers: { Authorization: 'Bearer ' + tok, Accept: 'application/json' },
    });
    if (!cr.ok) return { ok: false, error: 'kick-' + cr.status };
    const cj = await cr.json();
    const c = cj && Array.isArray(cj.data) && cj.data[0];
    if (!c || !c.broadcaster_user_id) return { ok: false, error: 'kick-no-channel' };
    const r = await fetch('https://api.kick.com/public/v1/chat', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ broadcaster_user_id: c.broadcaster_user_id, content: String(text).slice(0, 480), type: 'user' }),
    });
    if (r.ok) return { ok: true };
    const j = await r.json().catch(() => null);
    return { ok: false, error: (j && (j.message || j.error)) || ('kick-' + r.status) };
  } catch { return { ok: false, error: 'kick-unreachable' }; }
}

// Send a chat line to the streamer's own YouTube live chat as themselves.
// Resolves the active broadcast's liveChatId the same way applyYouTube finds
// the broadcast, then inserts a text message. Needs the youtube.force-ssl
// scope on the vault token (the same scope liveBroadcasts writes use).
async function youtubeChatSay(env, owner, text) {
  const tok = await vaultPlatformToken(env, 'youtube', owner);
  if (!tok) return { ok: false, error: 'not-connected' };
  try {
    const lr = await fetch('https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet,status&mine=true&maxResults=10', {
      headers: { Authorization: 'Bearer ' + tok },
    });
    if (!lr.ok) {
      const ej = await lr.json().catch(() => null);
      const reason = ej && ej.error && ((ej.error.errors && ej.error.errors[0] && ej.error.errors[0].reason) || ej.error.message);
      return { ok: false, error: reason ? String(reason).slice(0, 80) : 'youtube-' + lr.status };
    }
    const lj = await lr.json();
    const items = (lj && lj.items) || [];
    const rank = (s) => (s === 'live' ? 0 : s === 'liveStarting' ? 1 : s === 'ready' ? 2 : s === 'created' ? 3 : 9);
    items.sort((a, b) => rank(a.status && a.status.lifeCycleStatus) - rank(b.status && b.status.lifeCycleStatus));
    const b = items[0];
    const liveChatId = b && b.snippet && b.snippet.liveChatId;
    if (!liveChatId || rank(b.status && b.status.lifeCycleStatus) === 9) return { ok: false, error: 'no-broadcast' };
    const r = await fetch('https://www.googleapis.com/youtube/v3/liveChatMessages?part=snippet', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: JSON.stringify({ snippet: { liveChatId, type: 'textMessageEvent', textMessageDetails: { messageText: String(text).slice(0, 200) } } }),
    });
    if (r.ok) return { ok: true };
    const j = await r.json().catch(() => null);
    const msg = j && j.error && j.error.message;
    return { ok: false, error: msg ? String(msg).slice(0, 80) : 'youtube-' + r.status };
  } catch { return { ok: false, error: 'youtube-unreachable' }; }
}

export async function handleAquiloDock(req, env, path) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  // Kick/YouTube pairing: the dock page opened the broker's PKCE
  // desktop-login popup; it polls HERE (not the broker — no CORS there,
  // and this way tokens never touch the page). On success we write the
  // platform vault record (so /kick|youtube/vault/token can refresh it
  // forever) and mint a platform-anchored dock key.
  if (path === '/api/aqdock/pair-poll' && req.method === 'GET') {
    const url = new URL(req.url);
    const platform = String(url.searchParams.get('platform') || '');
    const session = String(url.searchParams.get('session') || '');
    const verifier = String(url.searchParams.get('verifier') || '');
    if (platform !== 'kick' && platform !== 'youtube') return json({ ok: false, error: 'bad-platform' }, 400);
    if (!/^[A-Za-z0-9_-]{16,80}$/.test(session) || !/^[A-Za-z0-9_-]{20,128}$/.test(verifier)) {
      return json({ ok: false, error: 'bad-params' }, 400);
    }
    let tok = null;
    try {
      const r = await fetch(BROKER + '/desktop/token?session=' + encodeURIComponent(session) + '&verifier=' + encodeURIComponent(verifier));
      tok = await r.json();
    } catch { return json({ ok: false, error: 'broker-unreachable' }, 502); }
    if (!tok) return json({ ok: false, error: 'broker-unreachable' }, 502);
    if (tok.pending) return json({ ok: true, pending: true });
    if (tok.error) return json({ ok: false, error: String(tok.error) });
    if (!tok.ok || !tok.access_token) return json({ ok: false, error: 'no-token' });
    const who = tok.identity;
    if (!who || !who.id) return json({ ok: false, error: 'no-identity' });
    const pid = String(who.id);
    const login = String(who.login || pid).toLowerCase();

    // Persist/refresh the vault record (merge — never clobber a bot leg).
    const vkey = (platform === 'kick' ? 'vault:kick:' : 'vault:yt:') + pid;
    let vault = null;
    try { vault = await env.LOADOUT_BOLTS.get(vkey, { type: 'json' }); } catch { /* fresh */ }
    vault = vault && typeof vault === 'object' ? vault : {};
    vault.platform = platform;
    vault.broadcaster = {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token || (vault.broadcaster && vault.broadcaster.refresh_token) || '',
      expires_at: tok.expires_at || (Date.now() + 3600_000),
      scope: tok.scope || '',
      login,
      user_id: pid,
      display_name: who.display_name || login,
      updatedAt: Date.now(),
    };
    vault.connectedAt = vault.connectedAt || Date.now();
    vault.updatedAt = Date.now();
    await env.LOADOUT_BOLTS.put(vkey, JSON.stringify(vault));

    // Mint (or reuse) the platform-anchored dock key.
    let key = null;
    try { key = await env.LOADOUT_BOLTS.get(KEY.byLogin(login, platform)); } catch { /* fresh */ }
    if (!key) {
      key = randKey();
      await env.LOADOUT_BOLTS.put(KEY.byLogin(login, platform), key);
      await env.LOADOUT_BOLTS.put(KEY.byKey(key), JSON.stringify({
        login, provider: platform, platformId: pid,
        display: who.display_name || login, createdAt: Date.now(),
      }));
    }
    return json({ ok: true, key, login, provider: platform });
  }

  // ── Channel ops (absorbed from StreamFusion's Stream Control pane;
  // SF is chat-focused, the dock owns channel management): ads, polls,
  // predictions, VOD markers, redemption queue. All Twitch-anchored,
  // all under the vault broadcaster token (scopes already granted).
  const opsHelix = async (owner, method, pathq, body) => {
    const auth = await vaultTwitchToken(env, owner.twitchId);
    if (!auth) return { status: 0, body: null };
    try {
      const r = await fetch('https://api.twitch.tv/helix/' + pathq, {
        method,
        headers: {
          Authorization: 'Bearer ' + auth.token,
          'Client-Id': auth.clientId,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const j = r.status === 204 ? null : await r.json().catch(() => null);
      return { status: r.status, body: j };
    } catch { return { status: 0, body: null }; }
  };
  const opsErr = (r, fallback) =>
    (r.body && r.body.message) || (r.status ? 'twitch-' + r.status : fallback || 'unreachable');

  if (path.startsWith('/api/aqdock/ops/')) {
    const url = new URL(req.url);
    let body = null;
    if (req.method === 'POST') {
      try { body = await req.json(); } catch { /* bad json */ }
      if (!body) return json({ ok: false, error: 'bad-json' }, 400);
    }
    const owner = await dockOwner(env, req.method === 'GET' ? url.searchParams.get('key') : body.key);
    if (!owner) return json({ ok: false, error: 'unknown-key' }, 404);
    if (!owner.twitchId) return json({ ok: false, error: 'twitch-only' }, 400);
    const op = path.slice('/api/aqdock/ops/'.length);

    // Snapshot for the cards: ad schedule + active poll + active prediction.
    if (op === 'state' && req.method === 'GET') {
      const [ads, polls, preds] = await Promise.all([
        opsHelix(owner, 'GET', 'channels/ads?broadcaster_id=' + owner.twitchId),
        opsHelix(owner, 'GET', 'polls?broadcaster_id=' + owner.twitchId + '&first=1'),
        opsHelix(owner, 'GET', 'predictions?broadcaster_id=' + owner.twitchId + '&first=1'),
      ]);
      const ad = ads.body && ads.body.data && ads.body.data[0];
      const poll = polls.body && polls.body.data && polls.body.data[0];
      const pred = preds.body && preds.body.data && preds.body.data[0];
      return json({
        ok: true,
        ads: ad ? { nextAdAt: ad.next_ad_at || null, snoozeCount: Number(ad.snooze_count) || 0, prerollFreeTime: Number(ad.preroll_free_time) || 0 } : null,
        poll: poll && poll.status === 'ACTIVE' ? { id: poll.id, title: poll.title, choices: (poll.choices || []).map((c) => ({ id: c.id, title: c.title, votes: Number(c.votes) || 0 })), endsAt: poll.ended_at || null } : null,
        prediction: pred && (pred.status === 'ACTIVE' || pred.status === 'LOCKED') ? { id: pred.id, title: pred.title, status: pred.status, outcomes: (pred.outcomes || []).map((o) => ({ id: o.id, title: o.title, points: Number(o.channel_points) || 0 })) } : null,
      });
    }

    // Create a clip of the last ~90s (Twitch picks the window). Returns
    // the public URL; the edit URL expires in 24h so it rides along too.
    if (op === 'clip' && req.method === 'POST') {
      const r = await opsHelix(owner, 'POST', 'clips?broadcaster_id=' + owner.twitchId);
      if (r.status === 202) {
        const c = r.body && r.body.data && r.body.data[0];
        return json({
          ok: true,
          id: c ? c.id : null,
          url: c ? 'https://clips.twitch.tv/' + c.id : null,
          editUrl: c ? c.edit_url : null,
        });
      }
      return json({ ok: false, error: opsErr(r) });
    }

    if (op === 'marker' && req.method === 'POST') {
      const desc = String(body.description || '').slice(0, 140);
      const r = await opsHelix(owner, 'POST', 'streams/markers', { user_id: String(owner.twitchId), ...(desc ? { description: desc } : {}) });
      if (r.status === 200) {
        const m = r.body && r.body.data && r.body.data[0];
        return json({ ok: true, positionSeconds: m ? Number(m.position_seconds) || 0 : null });
      }
      return json({ ok: false, error: opsErr(r) });
    }

    if (op === 'ad' && req.method === 'POST') {
      const len = [30, 60, 90, 120, 150, 180].includes(Number(body.length)) ? Number(body.length) : 30;
      const r = await opsHelix(owner, 'POST', 'channels/commercial', { broadcaster_id: String(owner.twitchId), length: len });
      if (r.status === 200) {
        const d = r.body && r.body.data && r.body.data[0];
        return json({ ok: true, retryAfter: d ? Number(d.retry_after) || 0 : 0, message: d && d.message || '' });
      }
      return json({ ok: false, error: opsErr(r) });
    }

    if (op === 'ad-snooze' && req.method === 'POST') {
      const r = await opsHelix(owner, 'POST', 'channels/ads/schedule/snooze?broadcaster_id=' + owner.twitchId);
      if (r.status === 200) {
        const d = r.body && r.body.data && r.body.data[0];
        return json({ ok: true, snoozeCount: d ? Number(d.snooze_count) || 0 : 0, nextAdAt: d && d.next_ad_at || null });
      }
      return json({ ok: false, error: opsErr(r) });
    }

    if (op === 'poll' && req.method === 'POST') {
      const title = String(body.title || '').trim().slice(0, 60);
      const choices = (Array.isArray(body.choices) ? body.choices : [])
        .map((c) => String(c).trim().slice(0, 25)).filter(Boolean).slice(0, 5);
      const duration = Math.max(15, Math.min(1800, Number(body.duration) || 120));
      if (!title || choices.length < 2) return json({ ok: false, error: 'need-title-and-2-choices' }, 400);
      const r = await opsHelix(owner, 'POST', 'polls', {
        broadcaster_id: String(owner.twitchId), title,
        choices: choices.map((t) => ({ title: t })), duration,
      });
      if (r.status === 200) return json({ ok: true });
      return json({ ok: false, error: opsErr(r) });
    }

    if (op === 'poll-end' && req.method === 'POST') {
      const r = await opsHelix(owner, 'PATCH', 'polls', {
        broadcaster_id: String(owner.twitchId), id: String(body.id || ''), status: 'TERMINATED',
      });
      if (r.status === 200) return json({ ok: true });
      return json({ ok: false, error: opsErr(r) });
    }

    if (op === 'prediction' && req.method === 'POST') {
      const title = String(body.title || '').trim().slice(0, 45);
      const outcomes = (Array.isArray(body.outcomes) ? body.outcomes : [])
        .map((c) => String(c).trim().slice(0, 25)).filter(Boolean).slice(0, 10);
      const window = Math.max(30, Math.min(1800, Number(body.window) || 120));
      if (!title || outcomes.length < 2) return json({ ok: false, error: 'need-title-and-2-outcomes' }, 400);
      const r = await opsHelix(owner, 'POST', 'predictions', {
        broadcaster_id: String(owner.twitchId), title,
        outcomes: outcomes.map((t) => ({ title: t })), prediction_window: window,
      });
      if (r.status === 200) return json({ ok: true });
      return json({ ok: false, error: opsErr(r) });
    }

    if (op === 'prediction-end' && req.method === 'POST') {
      const status = body.winnerId ? 'RESOLVED' : (body.status === 'LOCKED' ? 'LOCKED' : 'CANCELED');
      const payload = {
        broadcaster_id: String(owner.twitchId), id: String(body.id || ''), status,
        ...(body.winnerId ? { winning_outcome_id: String(body.winnerId) } : {}),
      };
      const r = await opsHelix(owner, 'PATCH', 'predictions', payload);
      if (r.status === 200) return json({ ok: true });
      return json({ ok: false, error: opsErr(r) });
    }

    if (op === 'redemptions' && req.method === 'GET') {
      const rewardId = String(url.searchParams.get('reward') || '');
      const rw = await opsHelix(owner, 'GET', 'channel_points/custom_rewards?broadcaster_id=' + owner.twitchId);
      if (rw.status !== 200) return json({ ok: false, error: opsErr(rw) });
      const rewards = ((rw.body && rw.body.data) || []).map((x) => ({ id: x.id, title: x.title, cost: Number(x.cost) || 0 }));
      let items = [];
      if (rewardId) {
        const rd = await opsHelix(owner, 'GET', 'channel_points/custom_rewards/redemptions?broadcaster_id=' + owner.twitchId +
          '&reward_id=' + encodeURIComponent(rewardId) + '&status=UNFULFILLED&first=20&sort=OLDEST');
        if (rd.status === 200) {
          items = ((rd.body && rd.body.data) || []).map((x) => ({
            id: x.id, user: x.user_name, input: x.user_input || '', redeemedAt: x.redeemed_at || null,
          }));
        }
      }
      return json({ ok: true, rewards, rewardId: rewardId || null, items });
    }

    if (op === 'redemption' && req.method === 'POST') {
      const status = body.status === 'CANCELED' ? 'CANCELED' : 'FULFILLED';
      const r = await opsHelix(owner, 'PATCH', 'channel_points/custom_rewards/redemptions?broadcaster_id=' + owner.twitchId +
        '&reward_id=' + encodeURIComponent(String(body.rewardId || '')) + '&id=' + encodeURIComponent(String(body.id || '')), { status });
      if (r.status === 200) return json({ ok: true });
      return json({ ok: false, error: opsErr(r) });
    }

    return json({ ok: false, error: 'not-found' }, 404);
  }

  // Raid Finder: category search → smallest live channels first, then
  // start/cancel the raid with the vault token (channel:manage:raids is
  // in the standard broadcaster grant). Twitch-anchored docks only.
  if (path === '/api/aqdock/raid/find' && req.method === 'GET') {
    const url = new URL(req.url);
    const owner = await dockOwner(env, url.searchParams.get('key'));
    if (!owner) return json({ ok: false, error: 'unknown-key' }, 404);
    if (!owner.twitchId) return json({ ok: false, error: 'twitch-only' }, 400);
    const q = String(url.searchParams.get('q') || '').trim().slice(0, 80);
    if (q.length < 2) return json({ ok: false, error: 'short-query' }, 400);
    let cap = parseInt(url.searchParams.get('cap') || '0', 10);
    if (!Number.isFinite(cap) || cap < 0) cap = 0;
    try {
      const { helixFetch } = await import('./twitch-helix.js');
      const gj = await helixFetch(env, '/search/categories', { query: q, first: 1 });
      const game = gj && gj.data && gj.data[0];
      if (!game) return json({ ok: true, game: null, list: [] });
      const sj = await helixFetch(env, '/streams', { game_id: game.id, first: 100 });
      const streams = (sj && sj.data) || [];
      const list = streams
        .filter((s) => String(s.user_id) !== String(owner.twitchId))
        .filter((s) => !cap || (Number(s.viewer_count) || 0) <= cap)
        .sort((a, b) => (Number(a.viewer_count) || 0) - (Number(b.viewer_count) || 0))
        .slice(0, 15)
        .map((s) => ({
          id: s.user_id,
          login: s.user_login,
          display: s.user_name,
          title: s.title || '',
          viewers: Number(s.viewer_count) || 0,
          startedAt: s.started_at || null,
          thumb: (s.thumbnail_url || '').replace('{width}', '160').replace('{height}', '90'),
        }));
      return json({ ok: true, game: { id: game.id, name: game.name }, list });
    } catch { return json({ ok: false, error: 'search-failed' }, 502); }
  }

  if (path === '/api/aqdock/raid/start' && req.method === 'POST') {
    let body = null;
    try { body = await req.json(); } catch { /* bad json */ }
    if (!body) return json({ ok: false, error: 'bad-json' }, 400);
    const owner = await dockOwner(env, body.key);
    if (!owner) return json({ ok: false, error: 'unknown-key' }, 404);
    if (!owner.twitchId) return json({ ok: false, error: 'twitch-only' }, 400);
    const toId = String(body.toId || '').trim();
    if (!/^\d{1,20}$/.test(toId)) return json({ ok: false, error: 'bad-target' }, 400);
    const auth = await vaultTwitchToken(env, owner.twitchId);
    if (!auth) return json({ ok: false, error: 'not-connected' });
    try {
      const r = await fetch('https://api.twitch.tv/helix/raids?from_broadcaster_id=' +
        encodeURIComponent(owner.twitchId) + '&to_broadcaster_id=' + encodeURIComponent(toId), {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + auth.token, 'Client-Id': auth.clientId },
      });
      if (r.ok) return json({ ok: true });
      const j = await r.json().catch(() => null);
      return json({ ok: false, error: (j && j.message) || ('twitch-' + r.status) });
    } catch { return json({ ok: false, error: 'twitch-unreachable' }); }
  }

  if (path === '/api/aqdock/raid/cancel' && req.method === 'POST') {
    let body = null;
    try { body = await req.json(); } catch { /* bad json */ }
    if (!body) return json({ ok: false, error: 'bad-json' }, 400);
    const owner = await dockOwner(env, body.key);
    if (!owner) return json({ ok: false, error: 'unknown-key' }, 404);
    if (!owner.twitchId) return json({ ok: false, error: 'twitch-only' }, 400);
    const auth = await vaultTwitchToken(env, owner.twitchId);
    if (!auth) return json({ ok: false, error: 'not-connected' });
    try {
      const r = await fetch('https://api.twitch.tv/helix/raids?broadcaster_id=' + encodeURIComponent(owner.twitchId), {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + auth.token, 'Client-Id': auth.clientId },
      });
      if (r.status === 204) return json({ ok: true });
      const j = await r.json().catch(() => null);
      return json({ ok: false, error: (j && j.message) || ('twitch-' + r.status) });
    } catch { return json({ ok: false, error: 'twitch-unreachable' }); }
  }

  // Go-live blast: one click posts the announce line to the streamer's
  // Twitch chat + Kick chat (as themselves, vault tokens) and to their
  // Discord webhook (reuses PunchCard's per-channel webhook config so
  // there's ONE webhook setting, not two). 20s per-key cooldown.
  if (path === '/api/aqdock/golive' && req.method === 'POST') {
    let body = null;
    try { body = await req.json(); } catch { /* bad json */ }
    if (!body) return json({ ok: false, error: 'bad-json' }, 400);
    const owner = await dockOwner(env, body.key);
    if (!owner) return json({ ok: false, error: 'unknown-key' }, 404);
    const cdKey = 'aqdock:golive-cd:' + body.key;
    try {
      if (await env.LOADOUT_BOLTS.get(cdKey)) return json({ ok: false, error: 'cooldown' }, 429);
      await env.LOADOUT_BOLTS.put(cdKey, '1', { expirationTtl: 60 });
    } catch { /* best effort */ }
    const message = String(body.message || '').trim().slice(0, 400);
    if (!message) return json({ ok: false, error: 'empty-message' }, 400);
    const t = body.targets || { twitch: true, kick: true, youtube: true, discord: true };
    const jobs = {};
    if (t.twitch) jobs.twitch = twitchChatSay(env, owner, message);
    if (t.kick) jobs.kick = kickChatSay(env, owner, message);
    if (t.youtube) jobs.youtube = youtubeChatSay(env, owner, message);
    if (t.discord) jobs.discord = (async () => {
      try {
        const chan = await env.LOADOUT_BOLTS.get('pc:chan:' + owner.login, { type: 'json' });
        const hook = chan && chan.cfg && chan.cfg.discordWebhook;
        if (!hook || !/^https:\/\/discord\.com\/api\/webhooks\//.test(hook)) return { ok: false, error: 'no-webhook' };
        const r = await fetch(hook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: message.slice(0, 1900), allowed_mentions: { parse: [] } }),
        });
        return r.ok ? { ok: true } : { ok: false, error: 'discord-' + r.status };
      } catch { return { ok: false, error: 'discord-unreachable' }; }
    })();
    const names = Object.keys(jobs);
    if (!names.length) return json({ ok: false, error: 'no-targets' }, 400);
    const settled = await Promise.all(names.map((n) => jobs[n]));
    const results = {};
    names.forEach((n, i) => { results[n] = settled[i]; });
    return json({ ok: names.some((n) => results[n].ok), results });
  }

  // Per-platform live viewer counts for the dock's LIVE strip. Cheap to
  // poll (~60s from the dock); each platform is best-effort.
  if (path === '/api/aqdock/viewers' && req.method === 'GET') {
    const url = new URL(req.url);
    const owner = await dockOwner(env, url.searchParams.get('key'));
    if (!owner) return json({ ok: false, error: 'unknown-key' }, 404);
    const out = {
      twitch: { live: false, viewers: null },
      kick: { live: false, viewers: null },
      youtube: { live: false, viewers: null },
    };
    await Promise.all([
      (async () => {
        if (!owner.twitchId) return;
        try {
          const { getStreamInfo } = await import('./twitch-helix.js');
          const st = await getStreamInfo(env, owner.twitchId);
          if (st) out.twitch = { live: true, viewers: Number(st.viewer_count) || 0, title: st.title || '', game: st.game_name || '' };
        } catch { /* offline */ }
      })(),
      (async () => {
        try {
          const tok = await vaultPlatformToken(env, 'kick', owner);
          if (!tok) return;
          // channels (token-scoped = OWN channel) carries the live stream
          // object; the bare livestreams endpoint lists GLOBAL streams.
          const r = await fetch('https://api.kick.com/public/v1/channels', {
            headers: { Authorization: 'Bearer ' + tok, Accept: 'application/json' },
          });
          if (!r.ok) return;
          const j = await r.json();
          const c = j && Array.isArray(j.data) && j.data[0];
          const s = c && c.stream;
          if (s && s.is_live) out.kick = { live: true, viewers: Number(s.viewer_count) || 0 };
        } catch { /* offline */ }
      })(),
      (async () => {
        try {
          const tok = await vaultPlatformToken(env, 'youtube', owner);
          if (!tok) return;
          const lr = await fetch('https://www.googleapis.com/youtube/v3/liveBroadcasts?part=status&broadcastStatus=active&maxResults=1', {
            headers: { Authorization: 'Bearer ' + tok },
          });
          if (!lr.ok) return;
          const lj = await lr.json();
          const b = lj && lj.items && lj.items[0];
          if (!b) return;
          const vr = await fetch('https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=' + encodeURIComponent(b.id), {
            headers: { Authorization: 'Bearer ' + tok },
          });
          if (!vr.ok) { out.youtube = { live: true, viewers: null }; return; }
          const vj = await vr.json();
          const d = vj && vj.items && vj.items[0] && vj.items[0].liveStreamingDetails;
          out.youtube = { live: true, viewers: d ? Number(d.concurrentViewers) || 0 : null };
        } catch { /* offline */ }
      })(),
    ]);
    return json({ ok: true, ...out });
  }

  // Current title/category on every connected platform.
  if (path === '/api/aqdock/streaminfo' && req.method === 'GET') {
    const url = new URL(req.url);
    const owner = await dockOwner(env, url.searchParams.get('key'));
    if (!owner) return json({ ok: false, error: 'unknown-key' }, 404);
    const info = await readStreamInfo(env, owner);
    return json({ ok: true, login: owner.login, ...info });
  }

  // Category type-ahead: Twitch (Helix search) + Kick, merged client-side.
  if (path === '/api/aqdock/categories' && req.method === 'GET') {
    const url = new URL(req.url);
    const owner = await dockOwner(env, url.searchParams.get('key'));
    if (!owner) return json({ ok: false, error: 'unknown-key' }, 404);
    const q = String(url.searchParams.get('q') || '').trim().slice(0, 60);
    if (q.length < 2) return json({ ok: true, twitch: [], kick: [] });
    const [tw, kick] = await Promise.all([
      (async () => {
        try {
          const { helixFetch } = await import('./twitch-helix.js');
          const j = await helixFetch(env, '/search/categories', { query: q, first: 8 });
          return ((j && j.data) || []).map((c) => ({
            id: c.id, name: c.name,
            art: c.box_art_url ? c.box_art_url.replace('52x72', '40x56') : null,
          }));
        } catch { return []; }
      })(),
      (async () => {
        try {
          const tok = await vaultPlatformToken(env, 'kick', owner);
          if (!tok) return [];
          const r = await fetch('https://api.kick.com/public/v1/categories?q=' + encodeURIComponent(q), {
            headers: { Authorization: 'Bearer ' + tok, Accept: 'application/json' },
          });
          if (!r.ok) return [];
          const j = await r.json();
          return ((j && j.data) || []).slice(0, 8).map((c) => ({ id: c.id, name: c.name, art: c.thumbnail || null }));
        } catch { return []; }
      })(),
    ]);
    return json({ ok: true, twitch: tw, kick });
  }

  // Apply title + category to the selected platforms in one shot.
  if (path === '/api/aqdock/streaminfo' && req.method === 'POST') {
    let body = null;
    try { body = await req.json(); } catch { /* bad json */ }
    if (!body) return json({ ok: false, error: 'bad-json' }, 400);
    const owner = await dockOwner(env, body.key);
    if (!owner) return json({ ok: false, error: 'unknown-key' }, 404);
    const title = body.title != null ? String(body.title).trim().slice(0, 200) : null;
    if (title != null && !title.length) return json({ ok: false, error: 'empty-title' }, 400);
    const t = body.targets || {};
    const jobs = {};
    if (t.twitch) jobs.twitch = applyTwitch(env, owner, title, body.twitchGameId);
    if (t.kick) jobs.kick = applyKick(env, owner, title, body.kickCategoryId);
    if (t.youtube) jobs.youtube = applyYouTube(env, owner, title);
    const names = Object.keys(jobs);
    if (!names.length) return json({ ok: false, error: 'no-targets' }, 400);
    const settled = await Promise.all(names.map((n) => jobs[n]));
    const results = {};
    names.forEach((n, i) => { results[n] = settled[i]; });
    const allOk = names.every((n) => results[n].ok);
    return json({ ok: allOk, results });
  }

  if (path === '/api/aqdock/mint' && req.method === 'POST') {
    const { accountSessionFrom } = await import('./account.js');
    const sess = await accountSessionFrom(req, env);
    if (!sess || sess.provider !== 'twitch' || !sess.login) return json({ ok: false, error: 'signin-twitch' }, 401);
    const login = String(sess.login).toLowerCase();
    let key = null;
    try { key = await env.LOADOUT_BOLTS.get(KEY.byLogin(login)); } catch { /* fresh */ }
    if (!key) {
      key = randKey();
      await env.LOADOUT_BOLTS.put(KEY.byLogin(login), key);
      await env.LOADOUT_BOLTS.put(KEY.byKey(key), JSON.stringify({ login, uid: sess.uid, createdAt: Date.now() }));
    }
    return json({ ok: true, key, login });
  }

  if (path === '/api/aqdock/state' && req.method === 'GET') {
    const url = new URL(req.url);
    const k = String(url.searchParams.get('key') || '');
    if (!/^[a-z0-9]{8,40}$/.test(k)) return json({ ok: false, error: 'bad-key' }, 400);
    let rec = null;
    try { rec = await env.LOADOUT_BOLTS.get(KEY.byKey(k), { type: 'json' }); } catch { /* miss */ }
    if (!rec || !rec.login) return json({ ok: false, error: 'unknown-key' }, 404);
    const login = rec.login;
    const provider = rec.provider || 'twitch';

    // Only Twitch-anchored docks resolve a Twitch id — a Kick/YT login
    // must never be looked up as if it were a Twitch name.
    const who = provider === 'twitch' ? await loginToId(env, login) : null;
    const twitchId = who && who.id;

    // Connection pills + product presence, all best-effort.
    const out = {
      ok: true,
      login,
      provider,
      display: (who && who.display) || rec.display || login,
      connections: { twitch: false, kick: false, youtube: false, spotify: false },
      rotationDockKey: null,
      multigoalRev: 0,
      punchcardClaimed: false,
    };
    // Platform-anchored docks: their own platform is connected by
    // construction (the vault record was written at pairing).
    if (provider !== 'twitch' && rec.platformId) {
      const vkey = (provider === 'kick' ? 'vault:kick:' : 'vault:yt:') + rec.platformId;
      try {
        const conn = !!(await env.LOADOUT_BOLTS.get(vkey));
        if (provider === 'kick') out.connections.kick = conn;
        else out.connections.youtube = conn;
      } catch { /* no */ }
    }
    if (twitchId) {
      try { out.connections.twitch = !!(await env.LOADOUT_BOLTS.get('vault:tw:' + twitchId)); } catch { /* no */ }
      try { out.connections.youtube = !!(await env.LOADOUT_BOLTS.get('link:tw2youtube:' + twitchId)); } catch { /* no */ }
      try {
        const s = env.ROTATION_KV ? await env.ROTATION_KV.get('streamer:' + twitchId, { type: 'json' }) : null;
        if (s) {
          out.connections.kick = !!s.kickUserId;
          out.connections.spotify = !!s.spotifyRefresh;
          out.rotationDockKey = s.dockKey || null;
        }
      } catch { /* no */ }
    }
    try {
      const cfg = await env.LOADOUT_BOLTS.get('goals:cfg:' + login, { type: 'json' });
      if (cfg && cfg.rev) out.multigoalRev = cfg.rev;
    } catch { /* no */ }
    try { out.punchcardClaimed = !!(await env.LOADOUT_BOLTS.get('pc:chan:' + login)); } catch { /* no */ }
    // Live-now strip: app-token Helix stream lookup (null when offline).
    out.live = null;
    if (twitchId) {
      try {
        const { getStreamInfo } = await import('./twitch-helix.js');
        const st = await getStreamInfo(env, twitchId);
        if (st) out.live = { title: st.title || '', game: st.game_name || '', viewers: Number(st.viewer_count) || 0, startedAt: st.started_at || null };
      } catch { /* offline-or-unavailable */ }
    }
    return json(out);
  }

  return json({ ok: false, error: 'not-found' }, 404);
}
