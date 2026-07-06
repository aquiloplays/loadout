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

export async function handleAquiloDock(req, env, path) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

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
    return json(out);
  }

  return json({ ok: false, error: 'not-found' }, 404);
}
