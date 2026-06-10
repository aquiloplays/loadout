// PunchCard backend: daily check-in cards with streaks for Twitch
// channel point redeems. Multi-tenant: any streamer claims their channel
// by completing the Twitch OAuth flow; viewers customize their card at
// aquilo.gg/punchcard/card/ behind a scope-free Twitch login.
//
//   GET  /api/punchcard/oauth/start?mode=streamer|viewer&ch=&rotate=
//   POST /api/punchcard/oauth/finish   { code }
//   GET  /api/punchcard/meta?ch=
//   POST /api/punchcard/checkin        { ch,k,viewer,display,msg,... }
//   GET  /api/punchcard/token?ch=&k=
//   GET  /api/punchcard/rewards?ch=&k=
//   POST /api/punchcard/reward         { ch,k,title,cost,prompt }
//   POST /api/punchcard/cfg            { ch,k,cfg,reward }
//   GET  /api/punchcard/recent?ch=&k=
//   POST /api/punchcard/mod            { ch,k,action,viewer }
//   GET  /api/punchcard/me?ch=         (Bearer session)
//   POST /api/punchcard/card           { ch,card } (Bearer session)
//   GET  /api/punchcard/gif?q=
//   GET  /api/punchcard/leaderboard?ch=
//
// OAuth reuses the Twitch app's already-registered redirect URI
// (/admin/twitch-oauth/callback). PunchCard states carry the 'pc1.'
// prefix and worker.js routes those callback hits here BEFORE the admin
// handler, so Clay's broadcaster flow is untouched and no Twitch console
// change is needed. See PUNCHCARD-SPEC.md.
//
// KV (LOADOUT_BOLTS), all keys prefixed pc:
//   pc:chan:<ch>   channel claim: key, cfg, refresh token, reward
//   pc:u:<ch>:<v>  per-viewer streak state + card
//   pc:days:<ch>   channel active-day list (streak mode 'active')
//   pc:lb:<ch>     leaderboard cache  ·  pc:recent:<ch> mod feed
//   pc:sess:<tok>  viewer session     ·  pc:code:<code> one-time finish
//   pc:oauth:<st>  CSRF state         ·  pc:av:<login>  avatar cache
//   pc:gif:<sha>   Giphy search cache

import {
  dayIdx, prevActiveDay, withToday, advance, ringFor,
} from './punchcard-streak.js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
};
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS },
  });
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

const STATE_PREFIX = 'pc1.';
const SESS_TTL = 30 * 24 * 3600;
const CODE_TTL = 300;
const STATE_TTL = 600;
const RECENT_CAP = 30;
const LB_CAP = 50;
const BLOCK_CAP = 500;
const MIN_CHECKIN_GAP_MS = 5000;

const KEY = {
  chan: (ch) => `pc:chan:${ch}`,
  user: (ch, v) => `pc:u:${ch}:${v}`,
  days: (ch) => `pc:days:${ch}`,
  lb: (ch) => `pc:lb:${ch}`,
  recent: (ch) => `pc:recent:${ch}`,
  sess: (t) => `pc:sess:${t}`,
  code: (c) => `pc:code:${c}`,
  oauth: (s) => `pc:oauth:${s}`,
  av: (l) => `pc:av:${l}`,
  gif: (h) => `pc:gif:${h}`,
};

const DEFAULT_CFG = { tz: 'America/New_York', rollover: 4, mode: 'active', allowCustomImg: false };
const FONTS = ['inter', 'bangers', 'pressstart', 'pacifico', 'oswald', 'caveat'];
const BG_PRESETS = ['ember', 'tide', 'violet', 'meadow', 'sunset', 'mono', 'candy', 'midnight'];
const IMG_HOSTS = /^(media\d*\.giphy\.com|i\.giphy\.com|media\.tenor\.com|c\.tenor\.com|i\.imgur\.com)$/i;

function siteOrigin(env) {
  return (env.PUBLIC_SITE_URL || 'https://aquilo.gg').replace(/\/$/, '');
}
function workerOrigin(env) {
  return (env.PUBLIC_WORKER_URL || 'https://loadout-discord.aquiloplays.workers.dev').replace(/\/$/, '');
}
// Must byte-match the Twitch app's registered redirect (the admin OAuth
// flow already uses exactly this URL).
function callbackUrl(env) {
  return workerOrigin(env) + '/admin/twitch-oauth/callback';
}

// ── sanitizers ────────────────────────────────────────────────────────
function chanName(s) {
  const v = String(s || '').trim().toLowerCase();
  return /^[a-z0-9_]{2,25}$/.test(v) ? v : null;
}
// Viewer keys: bare Twitch login, or platform-prefixed for SB-relayed
// YouTube/Kick chat command check-ins.
function viewerKey(login, platform) {
  const plat = String(platform || 'twitch').toLowerCase();
  let v = String(login || '').trim().toLowerCase().replace(/[^a-z0-9_\-]/g, '').slice(0, 40);
  if (!v) return null;
  if (plat === 'youtube') return 'yt:' + v;
  if (plat === 'kick') return 'kk:' + v;
  return /^[a-z0-9_]{2,25}$/.test(v) ? v : null;
}
function cleanDisplay(s) {
  return String(s || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 40);
}
function cleanMsg(s) {
  return String(s || '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}
function hexColor(s, fallback) {
  const v = String(s || '').trim();
  return /^#[0-9a-fA-F]{3,8}$/.test(v) ? v : fallback;
}
function imgUrlOk(raw, allowCustom) {
  let u;
  try { u = new URL(String(raw || '')); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  if (IMG_HOSTS.test(u.hostname)) return true;
  return !!allowCustom;
}
function sanitizeCard(raw, allowCustom) {
  if (!raw || typeof raw !== 'object') return null;
  const bg = raw.bg && typeof raw.bg === 'object' ? raw.bg : {};
  const kind = ['preset', 'solid', 'gradient', 'gif', 'img'].includes(bg.kind) ? bg.kind : 'preset';
  const out = {
    bg: { kind },
    accent: hexColor(raw.accent, '#ff6ab5'),
    font: FONTS.includes(raw.font) ? raw.font : 'inter',
    emoji: String(raw.emoji || '').slice(0, 4),
  };
  if (kind === 'preset') {
    out.bg.preset = BG_PRESETS.includes(bg.preset) ? bg.preset : 'midnight';
  } else if (kind === 'solid') {
    out.bg.c1 = hexColor(bg.c1, '#16182b');
  } else if (kind === 'gradient') {
    out.bg.c1 = hexColor(bg.c1, '#16182b');
    out.bg.c2 = hexColor(bg.c2, '#341b4d');
  } else {
    if (!imgUrlOk(bg.url, allowCustom)) return { error: 'bad-image-url' };
    out.bg.url = String(bg.url).slice(0, 500);
  }
  return out;
}

// ── KV helpers ────────────────────────────────────────────────────────
async function kvGet(env, key) {
  try { return await env.LOADOUT_BOLTS.get(key, { type: 'json' }); } catch { return null; }
}
async function kvPut(env, key, val, opts) {
  await env.LOADOUT_BOLTS.put(key, JSON.stringify(val), opts || {});
}

async function loadChan(env, ch) {
  if (!ch) return null;
  return kvGet(env, KEY.chan(ch));
}
async function authedChan(env, ch, k) {
  const chan = await loadChan(env, ch);
  if (!chan || !k || chan.k !== k) return null;
  return chan;
}

// ── per-channel Twitch token ──────────────────────────────────────────
// Each claimed channel stores its own rotated refresh token. Cached
// access token lives in the same record; refresh when < 5 min left.
async function channelAccessToken(env, ch, chan, force) {
  const rec = chan || await loadChan(env, ch);
  if (!rec || !rec.tw || !rec.tw.rt) return null;
  if (!force && rec.tw.at && rec.tw.atExp > Date.now() + 300000) {
    return { token: rec.tw.at, expiresIn: Math.floor((rec.tw.atExp - Date.now()) / 1000), chan: rec };
  }
  const params = new URLSearchParams({
    client_id: env.TWITCH_CLIENT_ID,
    client_secret: env.TWITCH_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: rec.tw.rt,
  });
  const resp = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!resp.ok) {
    console.warn('[punchcard] token refresh failed', ch, resp.status);
    return null;
  }
  const j = await resp.json();
  if (!j.access_token) return null;
  rec.tw.at = j.access_token;
  rec.tw.atExp = Date.now() + Math.max(60, Number(j.expires_in || 0) - 120) * 1000;
  if (j.refresh_token) rec.tw.rt = j.refresh_token;   // Twitch rotates per exchange
  await kvPut(env, KEY.chan(ch), rec);
  return { token: rec.tw.at, expiresIn: Math.floor((rec.tw.atExp - Date.now()) / 1000), chan: rec };
}

// Helix call under the CHANNEL's user token, one retry on 401.
async function chanHelix(env, ch, chan, path, params, opts = {}) {
  let tok = await channelAccessToken(env, ch, chan);
  if (!tok) return { _error: true, status: 0, message: 'no-channel-token' };
  for (let attempt = 0; attempt < 2; attempt++) {
    const u = new URL('https://api.twitch.tv/helix' + path);
    for (const [k, v] of Object.entries(params || {})) {
      if (v != null) u.searchParams.set(k, String(v));
    }
    const resp = await fetch(u.toString(), {
      method: opts.method || 'GET',
      headers: {
        'Authorization': 'Bearer ' + tok.token,
        'Client-Id': env.TWITCH_CLIENT_ID,
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    });
    if (resp.status === 401 && attempt === 0) {
      tok = await channelAccessToken(env, ch, null, true);
      if (!tok) break;
      continue;
    }
    let body = null;
    try { body = await resp.json(); } catch { /* not JSON */ }
    if (!resp.ok) {
      return { _error: true, status: resp.status, message: (body && (body.message || body.error)) || resp.statusText };
    }
    return body || { ok: true };
  }
  return { _error: true, status: 401, message: 'channel-token-expired' };
}

// Twitch avatar via the channel's token, KV-cached a day. Best effort.
async function avatarFor(env, ch, chan, login) {
  if (!login || !/^[a-z0-9_]{2,25}$/.test(login)) return null;
  const cached = await kvGet(env, KEY.av(login));
  if (cached && cached.url !== undefined) return cached.url;
  const j = await chanHelix(env, ch, chan, '/users', { login });
  const url = (!j._error && j.data && j.data[0] && j.data[0].profile_image_url) || null;
  try { await kvPut(env, KEY.av(login), { url }, { expirationTtl: 24 * 3600 }); } catch { /* best effort */ }
  return url;
}

// ── OAuth ─────────────────────────────────────────────────────────────
const STREAMER_SCOPES = 'channel:read:redemptions channel:manage:redemptions';

async function handleOauthStart(env, url) {
  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) {
    return json({ ok: false, error: 'twitch-not-configured' }, 500);
  }
  const mode = url.searchParams.get('mode') === 'viewer' ? 'viewer' : 'streamer';
  const ch = chanName(url.searchParams.get('ch')) || '';
  const rotate = url.searchParams.get('rotate') === '1';
  const state = STATE_PREFIX + genHex(16);
  await kvPut(env, KEY.oauth(state), { mode, ch, rotate }, { expirationTtl: STATE_TTL });

  const a = new URL('https://id.twitch.tv/oauth2/authorize');
  a.searchParams.set('client_id', env.TWITCH_CLIENT_ID);
  a.searchParams.set('redirect_uri', callbackUrl(env));
  a.searchParams.set('response_type', 'code');
  a.searchParams.set('scope', mode === 'streamer' ? STREAMER_SCOPES : '');
  a.searchParams.set('state', state);
  // Streamers must pick the right (broadcaster) account; viewers should
  // not be nagged with a consent screen on every login.
  if (mode === 'streamer') a.searchParams.set('force_verify', 'true');
  return new Response(null, { status: 302, headers: { Location: a.toString(), ...CORS } });
}

// Routed from worker.js when the callback state starts with 'pc1.'.
export async function handlePunchcardOauthCallback(req, env) {
  const u = new URL(req.url);
  const code = u.searchParams.get('code');
  const state = u.searchParams.get('state') || '';
  const err = u.searchParams.get('error');
  const back = siteOrigin(env) + '/punchcard/';

  const rec = await kvGet(env, KEY.oauth(state));
  if (rec) await env.LOADOUT_BOLTS.delete(KEY.oauth(state)).catch(() => {});
  const retBase = rec && rec.mode === 'viewer'
    ? siteOrigin(env) + '/punchcard/card/' + (rec.ch ? '?ch=' + rec.ch : '')
    : siteOrigin(env) + '/punchcard/customize/';

  function bounce(frag) {
    const sep = frag.startsWith('#') ? '' : '#';
    return new Response(null, { status: 302, headers: { Location: retBase + sep + frag } });
  }
  if (err) return bounce('#pcerr=' + encodeURIComponent(err));
  if (!rec || !code) return bounce('#pcerr=expired');

  const tokenResp = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: callbackUrl(env),
    }).toString(),
  });
  if (!tokenResp.ok) return bounce('#pcerr=exchange');
  const tok = await tokenResp.json();
  if (!tok.access_token) return bounce('#pcerr=exchange');

  // Who just authorized? /users with no params returns the token's user.
  const meResp = await fetch('https://api.twitch.tv/helix/users', {
    headers: { 'Authorization': 'Bearer ' + tok.access_token, 'Client-Id': env.TWITCH_CLIENT_ID },
  });
  const meJson = meResp.ok ? await meResp.json() : null;
  const me = meJson && meJson.data && meJson.data[0];
  if (!me || !me.login) return bounce('#pcerr=identity');

  const login = String(me.login).toLowerCase();
  const display = cleanDisplay(me.display_name || me.login);
  const avatar = me.profile_image_url || null;

  if (rec.mode === 'streamer') {
    if (!tok.refresh_token) return bounce('#pcerr=no-refresh');
    const existing = await loadChan(env, login);
    const chan = {
      v: 1,
      login,
      display,
      userId: String(me.id),
      k: existing && existing.k && !rec.rotate ? existing.k : genHex(16),
      createdAt: existing ? existing.createdAt : Date.now(),
      cfg: { ...DEFAULT_CFG, ...(existing ? existing.cfg : null) },
      rewardId: existing ? existing.rewardId : '',
      rewardTitle: existing ? existing.rewardTitle : 'Daily Check-In',
      blocked: existing && Array.isArray(existing.blocked) ? existing.blocked : [],
      tw: {
        rt: tok.refresh_token,
        at: tok.access_token,
        atExp: Date.now() + Math.max(60, Number(tok.expires_in || 0) - 120) * 1000,
      },
    };
    await kvPut(env, KEY.chan(login), chan);
    const oneTime = genHex(20);
    await kvPut(env, KEY.code(oneTime), {
      kind: 'streamer',
      payload: { login, display, k: chan.k, rewardTitle: chan.rewardTitle, rewardId: chan.rewardId, cfg: chan.cfg },
    }, { expirationTtl: CODE_TTL });
    return new Response(null, {
      status: 302,
      headers: { Location: siteOrigin(env) + '/punchcard/customize/#pc=' + oneTime },
    });
  }

  // Viewer login: mint a session, hand it over via one-time code.
  const sessTok = genHex(24);
  await kvPut(env, KEY.sess(sessTok), { login, display, avatar, iat: Date.now() }, { expirationTtl: SESS_TTL });
  const oneTime = genHex(20);
  await kvPut(env, KEY.code(oneTime), {
    kind: 'viewer',
    payload: { token: sessTok, login, display, avatar },
  }, { expirationTtl: CODE_TTL });
  return new Response(null, { status: 302, headers: { Location: retBase + '#pc=' + oneTime } });
}

async function handleOauthFinish(env, body) {
  const code = String(body.code || '');
  if (!/^[a-f0-9]{20,64}$/.test(code)) return json({ ok: false, error: 'bad-code' }, 400);
  const rec = await kvGet(env, KEY.code(code));
  if (!rec) return json({ ok: false, error: 'expired' }, 404);
  await env.LOADOUT_BOLTS.delete(KEY.code(code)).catch(() => {});
  return json({ ok: true, kind: rec.kind, ...rec.payload });
}

async function sessionFrom(req, env) {
  const h = req.headers.get('authorization') || '';
  const m = /^Bearer\s+([a-f0-9]{24,64})$/i.exec(h.trim());
  if (!m) return null;
  return kvGet(env, KEY.sess(m[1]));
}

// ── check-in ──────────────────────────────────────────────────────────
async function handleCheckin(env, body) {
  const ch = chanName(body.ch);
  const chan = await authedChan(env, ch, String(body.k || ''));
  if (!chan) return json({ ok: false, error: 'unauthorized' }, 403);

  const vk = viewerKey(body.viewer, body.platform);
  if (!vk) return json({ ok: false, error: 'bad-viewer' }, 400);
  if ((chan.blocked || []).includes(vk)) return json({ ok: false, error: 'blocked' });

  const display = cleanDisplay(body.display) || vk;
  const msg = cleanMsg(body.msg);
  const cfg = { ...DEFAULT_CFG, ...chan.cfg };
  const now = Date.now();
  const today = dayIdx(now, cfg.tz, cfg.rollover);

  const user = (await kvGet(env, KEY.user(ch, vk))) || {};
  if (user.lastTs && now - user.lastTs < MIN_CHECKIN_GAP_MS) {
    return json({ ok: false, error: 'rate' }, 429);
  }

  const dayList = (await kvGet(env, KEY.days(ch))) || [];
  const { days, changed } = withToday(dayList, today);
  if (changed) await kvPut(env, KEY.days(ch), days);
  const prevActive = prevActiveDay(days, today);

  const next = advance(user, today, prevActive, cfg.mode);
  const stored = {
    t: next.t, s: next.s, b: next.b, l: next.l, d: next.d,
    display, card: user.card || null, lastTs: now,
  };
  await kvPut(env, KEY.user(ch, vk), stored);

  // Mod feed ring.
  const recent = (await kvGet(env, KEY.recent(ch))) || [];
  recent.unshift({ v: vk, display, msg, day: today, ts: now, s: next.s, dup: next.dup });
  await kvPut(env, KEY.recent(ch), recent.slice(0, RECENT_CAP));

  // Leaderboard upsert (current streak, total tiebreak).
  if (!next.dup) {
    const lb = (await kvGet(env, KEY.lb(ch))) || { top: [] };
    const top = (lb.top || []).filter((e) => e && e.v !== vk);
    top.push({ v: vk, display, s: next.s, t: next.t });
    top.sort((a, b2) => (b2.s - a.s) || (b2.t - a.t));
    await kvPut(env, KEY.lb(ch), { updated: now, top: top.slice(0, LB_CAP) });
  }

  const avatar = vk.includes(':') ? null : await avatarFor(env, ch, chan, vk);
  return json({
    ok: true,
    viewer: vk, display, msg,
    streak: next.s, total: next.t, best: next.b,
    dup: next.dup, milestone: next.milestone, ring: ringFor(next.b),
    card: stored.card, avatar, day: today, activeDays: days.length,
  });
}

// ── streamer routes ───────────────────────────────────────────────────
async function handleToken(env, url) {
  const ch = chanName(url.searchParams.get('ch'));
  const chan = await authedChan(env, ch, String(url.searchParams.get('k') || ''));
  if (!chan) return json({ ok: false, error: 'unauthorized' }, 403);
  const tok = await channelAccessToken(env, ch, chan);
  if (!tok) return json({ ok: false, error: 'reauth-needed' }, 409);
  return json({
    ok: true,
    accessToken: tok.token,
    clientId: env.TWITCH_CLIENT_ID,
    broadcasterId: chan.userId,
    login: chan.login,
    expiresIn: tok.expiresIn,
  });
}

async function handleRewards(env, url) {
  const ch = chanName(url.searchParams.get('ch'));
  const chan = await authedChan(env, ch, String(url.searchParams.get('k') || ''));
  if (!chan) return json({ ok: false, error: 'unauthorized' }, 403);
  const j = await chanHelix(env, ch, chan, '/channel_points/custom_rewards', { broadcaster_id: chan.userId });
  if (j._error) return json({ ok: false, error: j.message || 'helix', status: j.status }, 502);
  const rewards = (j.data || []).map((r) => ({
    id: r.id, title: r.title, cost: r.cost, enabled: !!r.is_enabled, userInput: !!r.is_user_input_required,
  }));
  return json({ ok: true, rewards });
}

async function handleRewardCreate(env, body) {
  const ch = chanName(body.ch);
  const chan = await authedChan(env, ch, String(body.k || ''));
  if (!chan) return json({ ok: false, error: 'unauthorized' }, 403);
  const title = cleanDisplay(body.title) || 'Daily Check-In';
  const cost = Math.min(1000000, Math.max(1, Number(body.cost) || 100));
  const prompt = cleanMsg(body.prompt) || 'Check in for today! Your message shows on your card.';
  const j = await chanHelix(env, ch, chan, '/channel_points/custom_rewards',
    { broadcaster_id: chan.userId },
    { method: 'POST', body: {
      title, cost, prompt,
      is_user_input_required: true,
      background_color: '#FF6AB5',
      is_global_cooldown_enabled: false,
    } });
  if (j._error) {
    // Surface Twitch's reason: duplicate title, not affiliate, etc.
    return json({ ok: false, error: j.message || 'helix', status: j.status }, 502);
  }
  const r = j.data && j.data[0];
  if (!r) return json({ ok: false, error: 'no-reward' }, 502);
  chan.rewardId = r.id;
  chan.rewardTitle = r.title;
  await kvPut(env, KEY.chan(ch), chan);
  return json({ ok: true, reward: { id: r.id, title: r.title, cost: r.cost } });
}

function validTz(tz) {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(0);
    return true;
  } catch { return false; }
}

async function handleCfg(env, body) {
  const ch = chanName(body.ch);
  const chan = await authedChan(env, ch, String(body.k || ''));
  if (!chan) return json({ ok: false, error: 'unauthorized' }, 403);
  const cfg = body.cfg && typeof body.cfg === 'object' ? body.cfg : {};
  const next = { ...DEFAULT_CFG, ...chan.cfg };
  if (typeof cfg.tz === 'string' && cfg.tz.length <= 60 && validTz(cfg.tz)) next.tz = cfg.tz;
  if (cfg.rollover != null) next.rollover = Math.min(12, Math.max(0, Math.floor(Number(cfg.rollover) || 0)));
  if (cfg.mode === 'active' || cfg.mode === 'calendar') next.mode = cfg.mode;
  if (typeof cfg.allowCustomImg === 'boolean') next.allowCustomImg = cfg.allowCustomImg;
  chan.cfg = next;
  if (body.reward && typeof body.reward === 'object') {
    chan.rewardId = String(body.reward.id || '').slice(0, 64);
    chan.rewardTitle = cleanDisplay(body.reward.title) || chan.rewardTitle;
  }
  await kvPut(env, KEY.chan(ch), chan);
  return json({ ok: true, cfg: chan.cfg, rewardId: chan.rewardId, rewardTitle: chan.rewardTitle });
}

async function handleRecent(env, url) {
  const ch = chanName(url.searchParams.get('ch'));
  const chan = await authedChan(env, ch, String(url.searchParams.get('k') || ''));
  if (!chan) return json({ ok: false, error: 'unauthorized' }, 403);
  const recent = (await kvGet(env, KEY.recent(ch))) || [];
  return json({ ok: true, recent, blocked: chan.blocked || [] });
}

// Mod targets arrive as stored viewer keys (possibly yt:/kk: prefixed,
// straight from the recent feed) or as a bare Twitch login typed by the
// streamer. Accept both shapes verbatim after a strict pattern check.
function modViewerKey(raw) {
  const v = String(raw || '').trim().toLowerCase();
  return /^(yt:|kk:)?[a-z0-9_\-]{2,40}$/.test(v) ? v : null;
}

async function handleMod(env, body) {
  const ch = chanName(body.ch);
  const chan = await authedChan(env, ch, String(body.k || ''));
  if (!chan) return json({ ok: false, error: 'unauthorized' }, 403);
  const vk = modViewerKey(body.viewer);
  if (!vk) return json({ ok: false, error: 'bad-viewer' }, 400);
  const action = String(body.action || '');
  const blocked = new Set(chan.blocked || []);

  if (action === 'block') {
    blocked.add(vk);
    chan.blocked = [...blocked].slice(0, BLOCK_CAP);
    await kvPut(env, KEY.chan(ch), chan);
  } else if (action === 'unblock') {
    blocked.delete(vk);
    chan.blocked = [...blocked];
    await kvPut(env, KEY.chan(ch), chan);
  } else if (action === 'resetStreak' || action === 'resetCard') {
    const user = await kvGet(env, KEY.user(ch, vk));
    if (user) {
      if (action === 'resetStreak') { user.s = 0; user.l = null; }
      else user.card = null;
      await kvPut(env, KEY.user(ch, vk), user);
    }
  } else {
    return json({ ok: false, error: 'bad-action' }, 400);
  }

  if (action === 'block' || action === 'resetStreak') {
    const lb = (await kvGet(env, KEY.lb(ch))) || { top: [] };
    lb.top = (lb.top || []).filter((e) => e && e.v !== vk);
    await kvPut(env, KEY.lb(ch), lb);
  }
  return json({ ok: true, blocked: chan.blocked || [] });
}

// ── viewer routes ─────────────────────────────────────────────────────
async function handleMe(req, env, url) {
  const sess = await sessionFrom(req, env);
  if (!sess) return json({ ok: false, error: 'login-required' }, 401);
  const ch = chanName(url.searchParams.get('ch'));
  if (!ch) return json({ ok: false, error: 'bad-channel' }, 400);
  const chan = await loadChan(env, ch);
  const user = (await kvGet(env, KEY.user(ch, sess.login))) || {};
  return json({
    ok: true,
    login: sess.login, display: sess.display, avatar: sess.avatar,
    streak: user.s || 0, total: user.t || 0, best: user.b || 0,
    last: user.l || null, dates: user.d || [], card: user.card || null,
    ring: ringFor(user.b || 0),
    channel: chan ? {
      claimed: true, display: chan.display, rewardTitle: chan.rewardTitle,
      allowCustomImg: !!(chan.cfg && chan.cfg.allowCustomImg),
    } : { claimed: false },
  });
}

async function handleCardSave(req, env, body) {
  const sess = await sessionFrom(req, env);
  if (!sess) return json({ ok: false, error: 'login-required' }, 401);
  const ch = chanName(body.ch);
  if (!ch) return json({ ok: false, error: 'bad-channel' }, 400);
  const chan = await loadChan(env, ch);
  if (!chan) return json({ ok: false, error: 'channel-not-claimed' }, 404);
  if ((chan.blocked || []).includes(sess.login)) return json({ ok: false, error: 'blocked' }, 403);
  const card = sanitizeCard(body.card, !!(chan.cfg && chan.cfg.allowCustomImg));
  if (!card) return json({ ok: false, error: 'bad-card' }, 400);
  if (card.error) return json({ ok: false, error: card.error }, 400);
  // First-time viewers may customize before their first check-in.
  const user = (await kvGet(env, KEY.user(ch, sess.login))) || { t: 0, s: 0, b: 0, l: null, d: [] };
  user.card = card;
  user.display = sess.display || user.display;
  await kvPut(env, KEY.user(ch, sess.login), user);
  return json({ ok: true, card });
}

// ── public reads ──────────────────────────────────────────────────────
async function handleMeta(env, url) {
  const ch = chanName(url.searchParams.get('ch'));
  const chan = ch ? await loadChan(env, ch) : null;
  const cfg = chan ? { ...DEFAULT_CFG, ...chan.cfg } : null;
  return json({
    ok: true,
    claimed: !!chan,
    login: chan ? chan.login : ch,
    display: chan ? chan.display : null,
    rewardTitle: chan ? chan.rewardTitle : null,
    rewardId: chan ? chan.rewardId : null,
    allowCustomImg: !!(cfg && cfg.allowCustomImg),
    // Streak rules are public-by-design: the customizer restores its
    // panel from here after a reload, and the viewer editor shows the
    // channel's day-rollover rule.
    cfg: cfg ? { tz: cfg.tz, rollover: cfg.rollover, mode: cfg.mode, allowCustomImg: !!cfg.allowCustomImg } : null,
    giphy: !!env.GIPHY_API_KEY,
  });
}

async function handleLeaderboard(env, url) {
  const ch = chanName(url.searchParams.get('ch'));
  if (!ch) return json({ ok: false, error: 'bad-channel' }, 400);
  const lb = (await kvGet(env, KEY.lb(ch))) || { top: [] };
  const days = (await kvGet(env, KEY.days(ch))) || [];
  return json({
    ok: true,
    top: (lb.top || []).map((e) => ({ login: e.v, display: e.display, streak: e.s, total: e.t })),
    activeDays: days.length,
    updated: lb.updated || 0,
  });
}

async function handleGif(env, url) {
  if (!env.GIPHY_API_KEY) return json({ ok: false, error: 'no-giphy' }, 501);
  const q = String(url.searchParams.get('q') || '').slice(0, 60).trim();
  if (!q) return json({ ok: false, error: 'empty' }, 400);
  const cacheKey = KEY.gif((await sha256Hex(q.toLowerCase())).slice(0, 40));
  const hit = await kvGet(env, cacheKey);
  if (hit) return json({ ok: true, gifs: hit, cached: true });
  const g = new URL('https://api.giphy.com/v1/gifs/search');
  g.searchParams.set('api_key', env.GIPHY_API_KEY);
  g.searchParams.set('q', q);
  g.searchParams.set('limit', '24');
  g.searchParams.set('rating', 'pg-13');
  g.searchParams.set('lang', 'en');
  const resp = await fetch(g.toString());
  if (!resp.ok) return json({ ok: false, error: 'giphy-' + resp.status }, 502);
  const j = await resp.json();
  const gifs = (j.data || []).map((d) => ({
    id: d.id,
    preview: d.images && d.images.fixed_width && d.images.fixed_width.url,
    url: (d.images && ((d.images.downsized && d.images.downsized.url) ||
          (d.images.original && d.images.original.url))) || null,
  })).filter((d) => d.preview && d.url);
  await kvPut(env, cacheKey, gifs, { expirationTtl: 1800 });
  return json({ ok: true, gifs });
}

// ── dispatcher ────────────────────────────────────────────────────────
export async function handlePunchcard(req, env, path) {
  try {
    return await dispatch(req, env, path);
  } catch (e) {
    console.warn('[punchcard]', path, String(e && e.message || e).slice(0, 200));
    return json({ ok: false, error: 'internal' }, 500);
  }
}

async function dispatch(req, env, path) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const route = path.replace(/^\/api\/punchcard\//, '').replace(/\/+$/, '');

  if (req.method === 'GET') {
    if (route === 'oauth/start') return handleOauthStart(env, url);
    if (route === 'meta') return handleMeta(env, url);
    if (route === 'token') return handleToken(env, url);
    if (route === 'rewards') return handleRewards(env, url);
    if (route === 'recent') return handleRecent(env, url);
    if (route === 'me') return handleMe(req, env, url);
    if (route === 'gif') return handleGif(env, url);
    if (route === 'leaderboard') return handleLeaderboard(env, url);
    return json({ ok: false, error: 'not-found' }, 404);
  }

  if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405);
  let body = {};
  try {
    const text = await req.text();
    if (text.length > 16384) return json({ ok: false, error: 'too-large' }, 413);
    body = text ? JSON.parse(text) : {};
  } catch { return json({ ok: false, error: 'bad-json' }, 400); }

  if (route === 'oauth/finish') return handleOauthFinish(env, body);
  if (route === 'checkin') return handleCheckin(env, body);
  if (route === 'reward') return handleRewardCreate(env, body);
  if (route === 'cfg') return handleCfg(env, body);
  if (route === 'mod') return handleMod(env, body);
  if (route === 'card') return handleCardSave(req, env, body);
  return json({ ok: false, error: 'not-found' }, 404);
}
