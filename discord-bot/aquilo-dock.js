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
  byLogin: (l) => 'aqdock:login:' + l,
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

async function vaultPlatformToken(env, platform, twitchId) {
  if (!env.VAULT_SERVICE_SECRET) return null;
  try {
    const r = await fetch(BROKER + '/' + platform + '/vault/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ service: env.VAULT_SERVICE_SECRET, twitchId: String(twitchId), role: 'broadcaster' }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return (j && j.access_token) ? j.access_token : null;
  } catch { return null; }
}

// Resolve a dock key to { login, twitchId } or null.
async function dockOwner(env, k) {
  if (!/^[a-z0-9]{8,40}$/.test(String(k || ''))) return null;
  let rec = null;
  try { rec = await env.LOADOUT_BOLTS.get(KEY.byKey(k), { type: 'json' }); } catch { /* miss */ }
  if (!rec || !rec.login) return null;
  const who = await loginToId(env, rec.login);
  return { login: rec.login, twitchId: (who && who.id) || null };
}

// Current per-platform stream info, best-effort each.
async function readStreamInfo(env, twitchId) {
  const out = {
    twitch: { connected: false, title: null, game: null, gameId: null },
    kick: { connected: false, title: null, category: null, categoryId: null },
    youtube: { connected: false, title: null, broadcastId: null, lifeCycle: null },
  };
  const [tw, kickTok, ytTok] = await Promise.all([
    (async () => {
      try {
        const { getChannelGame } = await import('./twitch-helix.js');
        return await getChannelGame(env, twitchId);
      } catch { return null; }
    })(),
    vaultPlatformToken(env, 'kick', twitchId),
    vaultPlatformToken(env, 'youtube', twitchId),
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

async function applyTwitch(env, twitchId, title, gameId) {
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

async function applyKick(env, twitchId, title, categoryId) {
  const tok = await vaultPlatformToken(env, 'kick', twitchId);
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

async function applyYouTube(env, twitchId, title) {
  if (title == null) return { ok: true, skipped: true };
  const tok = await vaultPlatformToken(env, 'youtube', twitchId);
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
async function twitchChatSay(env, twitchId, text) {
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
async function kickChatSay(env, twitchId, text) {
  const tok = await vaultPlatformToken(env, 'kick', twitchId);
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

export async function handleAquiloDock(req, env, path) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

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
    if (!owner.twitchId) return json({ ok: false, error: 'no-twitch-id' }, 500);
    const cdKey = 'aqdock:golive-cd:' + body.key;
    try {
      if (await env.LOADOUT_BOLTS.get(cdKey)) return json({ ok: false, error: 'cooldown' }, 429);
      await env.LOADOUT_BOLTS.put(cdKey, '1', { expirationTtl: 60 });
    } catch { /* best effort */ }
    const message = String(body.message || '').trim().slice(0, 400);
    if (!message) return json({ ok: false, error: 'empty-message' }, 400);
    const t = body.targets || { twitch: true, kick: true, discord: true };
    const jobs = {};
    if (t.twitch) jobs.twitch = twitchChatSay(env, owner.twitchId, message);
    if (t.kick) jobs.kick = kickChatSay(env, owner.twitchId, message);
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
    if (!owner.twitchId) return json({ ok: false, error: 'no-twitch-id' }, 500);
    const out = {
      twitch: { live: false, viewers: null },
      kick: { live: false, viewers: null },
      youtube: { live: false, viewers: null },
    };
    await Promise.all([
      (async () => {
        try {
          const { getStreamInfo } = await import('./twitch-helix.js');
          const st = await getStreamInfo(env, owner.twitchId);
          if (st) out.twitch = { live: true, viewers: Number(st.viewer_count) || 0, title: st.title || '', game: st.game_name || '' };
        } catch { /* offline */ }
      })(),
      (async () => {
        try {
          const tok = await vaultPlatformToken(env, 'kick', owner.twitchId);
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
          const tok = await vaultPlatformToken(env, 'youtube', owner.twitchId);
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
    if (!owner.twitchId) return json({ ok: false, error: 'no-twitch-id' }, 500);
    const info = await readStreamInfo(env, owner.twitchId);
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
          const tok = owner.twitchId ? await vaultPlatformToken(env, 'kick', owner.twitchId) : null;
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
    if (!owner.twitchId) return json({ ok: false, error: 'no-twitch-id' }, 500);
    const title = body.title != null ? String(body.title).trim().slice(0, 200) : null;
    if (title != null && !title.length) return json({ ok: false, error: 'empty-title' }, 400);
    const t = body.targets || {};
    const jobs = {};
    if (t.twitch) jobs.twitch = applyTwitch(env, owner.twitchId, title, body.twitchGameId);
    if (t.kick) jobs.kick = applyKick(env, owner.twitchId, title, body.kickCategoryId);
    if (t.youtube) jobs.youtube = applyYouTube(env, owner.twitchId, title);
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

    const who = await loginToId(env, login);
    const twitchId = who && who.id;

    // Connection pills + product presence, all best-effort.
    const out = {
      ok: true,
      login,
      display: (who && who.display) || login,
      connections: { twitch: false, kick: false, youtube: false, spotify: false },
      rotationDockKey: null,
      multigoalRev: 0,
      punchcardClaimed: false,
    };
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
