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
  emotes: (l) => `pc:emotes:${l}`,
  sub: (ch, v) => `pc:sub:${ch}:${v}`,
};

const DEFAULT_CFG = {
  tz: 'America/New_York', rollover: 4, mode: 'active', allowCustomImg: false,
  // Redemption lifecycle (only effective for the reward PunchCard
  // created, Twitch forbids touching others): fulfill on success,
  // cancel (= refund the points) on duplicate same-day redeems.
  autoFulfill: true, refundDup: true,
  // Post "X hit a N day streak!" to chat as the broadcaster on
  // milestones. Off by default: speaking as the streamer is opt-in.
  announceMilestones: false,
  // Welcome a viewer's FIRST-ever check-in with the card editor link,
  // the moment they are most likely to go customize. Same opt-in rule.
  announceWelcome: false,
};
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
  let v = String(login || '').trim().toLowerCase().replace(/[^a-z0-9_\-.]/g, '').slice(0, 40);
  if (!v) return null;
  if (plat === 'youtube') return 'yt:' + v;
  if (plat === 'kick') return 'kk:' + v;
  if (plat === 'tiktok') return 'tt:' + v;
  return /^[a-z0-9_]{2,25}$/.test(v.replace(/\./g, '')) ? v.replace(/\./g, '') : null;
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
function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// Exported for pc-selftest.mjs: image-host allowlisting and placement
// clamping are the security/abuse edges of card saves.
export function sanitizeCard(raw, allowCustom) {
  if (!raw || typeof raw !== 'object') return null;
  const bg = raw.bg && typeof raw.bg === 'object' ? raw.bg : {};
  const kind = ['preset', 'solid', 'gradient', 'gif', 'img'].includes(bg.kind) ? bg.kind : 'preset';
  const out = {
    bg: { kind },
    accent: hexColor(raw.accent, '#ff6ab5'),
    font: FONTS.includes(raw.font) ? raw.font : 'inter',
    emoji: String(raw.emoji || '').slice(0, 4),
  };
  // Twitch emote badge from the viewer's own emote set (picked in the
  // editor). Render-side builds the CDN URL from the id; ids are plain
  // tokens so a strict pattern is enough.
  if (raw.emote && typeof raw.emote === 'object' && /^[a-zA-Z0-9_\-]{1,100}$/.test(String(raw.emote.i || ''))) {
    out.emote = {
      i: String(raw.emote.i),
      n: cleanDisplay(raw.emote.n).slice(0, 30),
      a: raw.emote.a ? 1 : 0,
    };
  }
  // Cosmetics. Everything whitelisted; junk falls back to defaults.
  out.punch = ['classic', 'stamp', 'fist', 'laser', 'none'].includes(raw.punch) ? raw.punch : 'classic';
  // Check-in sound: keys of the synthesized bank in pc-sounds.js. The
  // overlay's audio settings (enabled/volume/viewerSounds) always win.
  out.sound = ['chime', 'airhorn', 'sadtrombone', 'boom', 'bonk', 'tada', 'powerup',
    'coin', 'boing', 'scratch', 'drumroll', 'laser', 'honk', 'none'].includes(raw.sound)
    ? raw.sound : 'chime';
  // Earned-badge selection (cap 3). Keys are whitelisted only; whether
  // a badge actually RENDERS is decided at display time against the
  // viewer's server-side stats, so selections can never fake a badge.
  if (Array.isArray(raw.badges)) {
    const known = ['gifter', 'cheer', 'coins', 'biggift', 'likes'];
    out.badges = [...new Set(raw.badges.filter((b) => known.includes(b)))].slice(0, 3);
  }
  out.nameFx = ['none', 'accent', 'gradient', 'rainbow'].includes(raw.nameFx) ? raw.nameFx : 'none';
  out.texture = ['none', 'dots', 'scan', 'sparkle'].includes(raw.texture) ? raw.texture : 'none';
  out.anim = ['slide', 'pop', 'flip', 'drop'].includes(raw.anim) ? raw.anim : 'slide';
  out.avatarShape = ['circle', 'squircle', 'hex'].includes(raw.avatarShape) ? raw.avatarShape : 'circle';
  out.flame = String(raw.flame || '').slice(0, 4);
  // Holo is a PREFERENCE; the renderer only shows it once the viewer's
  // best streak has earned the gold ring, so saving it early is fine.
  out.holo = !!raw.holo;
  // Voice (TTS): opt-in spoken check-in, only persisted when ON so a
  // disabled card simply carries no tts and the overlay stays silent.
  // Voice keys mirror PCTTS.STYLES in pc-tts.js; the optional custom
  // line is length-capped here and re-sanitized (links + profanity) at
  // speak time by the overlay, exactly like the on-card message.
  if (raw.tts && typeof raw.tts === 'object' && raw.tts.on) {
    const ttsVoices = ['default', 'deep', 'bright', 'announcer', 'robot', 'chipmunk'];
    out.tts = {
      on: true,
      voice: ttsVoices.includes(raw.tts.voice) ? raw.tts.voice : 'default',
      say: String(raw.tts.say || '').slice(0, 120),
    };
  }
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
    // GIF/image placement, viewer-tuned in the card editor and applied
    // verbatim by pc-card.js: focal point, zoom, scrim darkness, layout.
    out.bg.posX = clampInt(bg.posX, 0, 100, 50);
    out.bg.posY = clampInt(bg.posY, 0, 100, 50);
    out.bg.zoom = clampInt(bg.zoom, 100, 220, 100);
    out.bg.dim = clampInt(bg.dim, 0, 100, 75);
    out.bg.layout = (bg.layout === 'left' || bg.layout === 'right') ? bg.layout : 'full';
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

// Twitch avatar + numeric id via the channel's token, KV-cached a day.
// Best effort: null fields just mean the card uses the initials avatar
// and tier effects are skipped.
async function userInfoFor(env, ch, chan, login) {
  if (!login || !/^[a-z0-9_]{2,25}$/.test(login)) return { url: null, id: null };
  const cached = await kvGet(env, KEY.av(login));
  if (cached && cached.url !== undefined && 'id' in cached) return cached;
  const j = await chanHelix(env, ch, chan, '/users', { login });
  const u = (!j._error && j.data && j.data[0]) || null;
  const info = { url: (u && u.profile_image_url) || null, id: (u && u.id) || null };
  try { await kvPut(env, KEY.av(login), info, { expirationTtl: 24 * 3600 }); } catch { /* best effort */ }
  return info;
}

// Sub tier (0..3) of a viewer on the channel, via the channel's token.
// Cached 8h. Returns 0 when not subbed; ALSO 0 (uncached) when the claim
// predates the channel:read:subscriptions scope, so old claims degrade
// to no tier effects instead of erroring.
async function subTierFor(env, ch, chan, vk, viewerId) {
  if (!vk || vk.includes(':')) return 0;
  const cached = await kvGet(env, KEY.sub(ch, vk));
  if (cached && cached.t !== undefined) return cached.t;
  let id = viewerId && /^\d{1,20}$/.test(String(viewerId)) ? String(viewerId) : null;
  if (!id) {
    const info = await userInfoFor(env, ch, chan, vk);
    id = info.id;
  }
  if (!id) return 0;
  const j = await chanHelix(env, ch, chan, '/subscriptions', { broadcaster_id: chan.userId, user_id: id });
  if (j && j._error) {
    if (j.status === 401 || j.status === 403) return 0;   // missing scope: skip cache
    return 0;
  }
  const d = j && j.data && j.data[0];
  const t = d ? Math.max(1, Math.min(3, Math.round(Number(d.tier) / 1000) || 1)) : 0;
  try { await kvPut(env, KEY.sub(ch, vk), { t }, { expirationTtl: 8 * 3600 }); } catch { /* best effort */ }
  return t;
}

// Settle a redemption on Twitch: FULFILLED clears the queue, CANCELED
// refunds the points. Only legal for the reward PunchCard created
// (Twitch rejects PATCHes on rewards from other apps); silently false
// on any mismatch or API error.
async function settleRedemption(env, ch, chan, rewardId, redemptionId, status) {
  if (!rewardId || !redemptionId || !chan.rewardId || rewardId !== chan.rewardId) return false;
  if (!/^[a-zA-Z0-9\-]{8,64}$/.test(String(redemptionId))) return false;
  const j = await chanHelix(env, ch, chan, '/channel_points/custom_rewards/redemptions',
    { broadcaster_id: chan.userId, reward_id: rewardId, id: redemptionId },
    { method: 'PATCH', body: { status } });
  return !(j && j._error);
}

// Post to the channel's chat as the broadcaster (user:write:chat).
// Claims that predate the scope just fail quietly.
async function sendChat(env, ch, chan, message) {
  const j = await chanHelix(env, ch, chan, '/chat/messages', null, {
    method: 'POST',
    body: { broadcaster_id: chan.userId, sender_id: chan.userId, message: String(message).slice(0, 400) },
  });
  return !(j && j._error);
}

// Every emote the viewer can use, snapshotted at login with their fresh
// access token (we never store the token itself). Helix pages with a
// cursor; cap generously, power users sub to a LOT of channels.
async function fetchUserEmotes(env, accessToken, userId) {
  const out = [];
  let cursor = '';
  for (let page = 0; page < 12 && out.length < 900; page++) {
    const u = new URL('https://api.twitch.tv/helix/chat/emotes/user');
    u.searchParams.set('user_id', userId);
    if (cursor) u.searchParams.set('after', cursor);
    let r;
    try {
      r = await fetch(u.toString(), {
        headers: { 'Authorization': 'Bearer ' + accessToken, 'Client-Id': env.TWITCH_CLIENT_ID },
      });
    } catch { break; }
    if (!r.ok) break;     // 401 = pre-scope login; editor offers a re-login
    const j = await r.json();
    for (const e of (j.data || [])) {
      if (e && e.id && e.name) out.push({ i: e.id, n: e.name, a: (e.format || []).includes('animated') ? 1 : 0 });
    }
    cursor = (j.pagination && j.pagination.cursor) || '';
    if (!cursor) break;
  }
  return out;
}

// ── OAuth ─────────────────────────────────────────────────────────────
// read:subscriptions powers per-viewer sub-tier card effects. Claims
// made before it was added simply skip tier lookups (the Helix call
// 401s and we treat the viewer as tier 0) until the streamer reconnects.
const STREAMER_SCOPES = 'channel:read:redemptions channel:manage:redemptions channel:read:subscriptions user:write:chat bits:read';
// Lets the card editor list every emote the viewer can use (subs across
// channels, hype train unlocks, follower emotes). Read-only.
const VIEWER_SCOPES = 'user:read:emotes';

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
  a.searchParams.set('scope', mode === 'streamer' ? STREAMER_SCOPES : VIEWER_SCOPES);
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

    // Zero-click onboarding: if no reward is bound yet, create the
    // Daily Check-In reward right now with the token we just minted
    // (or adopt an existing same-title reward). Non-affiliates and
    // API hiccups degrade to the customizer's manual button.
    let rewardAuto = chan.rewardId ? 'kept' : 'failed';
    if (!chan.rewardId) {
      try {
        const res = await createCheckinReward(env, login, chan, {});
        rewardAuto = res.status;
      } catch { /* customizer button remains */ }
    }
    const oneTime = genHex(20);
    await kvPut(env, KEY.code(oneTime), {
      kind: 'streamer',
      payload: {
        login, display, k: chan.k,
        rewardTitle: chan.rewardTitle, rewardId: chan.rewardId,
        rewardAuto, cfg: chan.cfg,
      },
    }, { expirationTtl: CODE_TTL });
    return new Response(null, {
      status: 302,
      headers: { Location: siteOrigin(env) + '/punchcard/customize/#pc=' + oneTime },
    });
  }

  // Viewer login: snapshot their usable emotes with the fresh token
  // (the token itself is never stored), then mint a session and hand it
  // over via one-time code.
  try {
    const emotes = await fetchUserEmotes(env, tok.access_token, String(me.id));
    if (emotes.length) {
      await kvPut(env, KEY.emotes(login), { ts: Date.now(), list: emotes }, { expirationTtl: 30 * 24 * 3600 });
    }
  } catch { /* editor offers re-login when absent */ }
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
  const sess = await kvGet(env, KEY.sess(m[1]));
  if (sess) sess._tok = m[1];
  return sess;
}

// ── cross-platform identity linking ───────────────────────────────────
// TikTok/YouTube/Kick viewers have no OAuth, so they prove their handle
// by CHATTING: the editor mints an anonymous session + a short code,
// the viewer types `!link CODE` in the streamer's chat while the
// overlay is running, and the overlay (k-authed) reports who said it.
// Only the real account can speak as that handle, so the binding is
// honest. Twitch viewers keep using OAuth.
const LINK_CODE_TTL = 600;

async function handleAnonSession(env) {
  const tok = genHex(24);
  await kvPut(env, KEY.sess(tok), { anon: true, iat: Date.now() }, { expirationTtl: 7 * 24 * 3600 });
  return json({ ok: true, token: tok });
}

async function handleLinkCode(req, env, url) {
  const sess = await sessionFrom(req, env);
  if (!sess) return json({ ok: false, error: 'login-required' }, 401);
  if (sess.login) return json({ ok: false, error: 'already-linked', login: sess.login }, 409);
  const ch = chanName(url.searchParams.get('ch'));
  if (!ch) return json({ ok: false, error: 'bad-channel' }, 400);
  // Unambiguous alphabet (no 0/O/1/I), 5 chars.
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  const rnd = new Uint8Array(5);
  crypto.getRandomValues(rnd);
  for (const b of rnd) code += alphabet[b % alphabet.length];
  await kvPut(env, `pc:linkcode:${code}`, { tok: sess._tok, ch }, { expirationTtl: LINK_CODE_TTL });
  return json({ ok: true, code, expiresIn: LINK_CODE_TTL });
}

async function handleLink(env, body) {
  const ch = chanName(body.ch);
  const chan = await authedChan(env, ch, String(body.k || ''));
  if (!chan) return json({ ok: false, error: 'unauthorized' }, 403);
  const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (code.length < 4) return json({ ok: false, error: 'bad-code' }, 400);
  const plat = String(body.platform || '').toLowerCase();
  if (plat === 'twitch' || !['youtube', 'kick', 'tiktok'].includes(plat)) {
    return json({ ok: false, error: 'platform' }, 400);
  }
  const vk = viewerKey(body.viewer, plat);
  if (!vk) return json({ ok: false, error: 'bad-viewer' }, 400);
  const rec = await kvGet(env, `pc:linkcode:${code}`);
  if (!rec || rec.ch !== ch) return json({ ok: false, error: 'expired' }, 404);
  const sess = await kvGet(env, KEY.sess(rec.tok));
  if (!sess) return json({ ok: false, error: 'expired' }, 404);
  sess.login = vk;
  sess.display = cleanDisplay(body.display) || vk.replace(/^(yt|kk|tt):/, '');
  sess.platform = plat;
  delete sess.anon;
  await kvPut(env, KEY.sess(rec.tok), sess, { expirationTtl: SESS_TTL });
  await env.LOADOUT_BOLTS.delete(`pc:linkcode:${code}`).catch(() => {});
  return json({ ok: true, viewer: vk });
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
  const prev2Active = prevActive ? prevActiveDay(days, prevActive) : null;

  const next = advance(user, today, prevActive, cfg.mode, prev2Active);
  const stored = {
    t: next.t, s: next.s, b: next.b, l: next.l, d: next.d, f: next.f,
    display, card: user.card || null, stats: user.stats || undefined, lastTs: now,
  };
  await kvPut(env, KEY.user(ch, vk), stored);

  // Redemption lifecycle: fulfill the queue entry on success, refund
  // the points on a duplicate. Only fires for points-sourced check-ins
  // carrying a redemption id, and only on PunchCard's own reward.
  let refunded = false;
  if (body.source === 'points' && body.redemptionId) {
    if (next.dup && cfg.refundDup !== false) {
      refunded = await settleRedemption(env, ch, chan, String(body.rewardId || ''), String(body.redemptionId), 'CANCELED');
    } else if (!next.dup && cfg.autoFulfill !== false) {
      await settleRedemption(env, ch, chan, String(body.rewardId || ''), String(body.redemptionId), 'FULFILLED');
    }
  }

  // Chat shouts as the broadcaster, when opted in: first-ever check-in
  // gets the editor link (peak curiosity moment), milestones get hype.
  try {
    if (!next.dup && next.t === 1 && cfg.announceWelcome) {
      await sendChat(env, ch, chan,
        `👊 Welcome to the punch club, ${display}! Make your check-in card yours: aquilo.gg/punchcard/card/?ch=${ch}`);
    } else if (next.milestone && cfg.announceMilestones) {
      const flair = next.milestone >= 100 ? ' 🏆' : '';
      await sendChat(env, ch, chan,
        `🔥 ${display} just hit a ${next.milestone} day check-in streak!${flair} Customize your card: aquilo.gg/punchcard/card/?ch=${ch}`);
    }
  } catch { /* best effort */ }

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

  // Twitch-only enrichment: avatar, sub tier (card effects), and the
  // viewer's own emotes matched against their message words so the card
  // renders them inline. Non-Twitch platforms carry their avatar in the
  // event itself; the overlay merges it client-side.
  let avatar = null;
  let subTier = 0;
  let msgEmotes = [];
  if (!vk.includes(':')) {
    const info = await userInfoFor(env, ch, chan, vk);
    avatar = info.url;
    subTier = await subTierFor(env, ch, chan, vk, body.viewerId || info.id);
    if (msg) {
      const rec = await kvGet(env, KEY.emotes(vk));
      if (rec && Array.isArray(rec.list) && rec.list.length) {
        const byName = new Map(rec.list.map((e) => [e.n, e]));
        const seen = new Set();
        for (const w of msg.split(/\s+/)) {
          const e = byName.get(w);
          if (e && !seen.has(w)) {
            seen.add(w);
            msgEmotes.push(e);
            if (msgEmotes.length >= 12) break;
          }
        }
      }
    }
  }
  return json({
    ok: true,
    viewer: vk, display, msg,
    streak: next.s, total: next.t, best: next.b,
    dup: next.dup, milestone: next.milestone, ring: ringFor(next.b),
    freezeUsed: next.freezeUsed, freezes: next.f, refunded,
    firstOfDay: changed,
    // First check-in EVER for this viewer on this channel. Driven by
    // the persisted total, so it fires exactly once in a lifetime
    // (a reset streak is 1 again, but the total never goes back).
    firstEver: !next.dup && next.t === 1,
    card: stored.card, stats: stored.stats || null, avatar, subTier, msgEmotes,
    day: today, activeDays: days.length,
  });
}

// ── badge stats ───────────────────────────────────────────────────────
// Real support events, reported by the overlay as they happen: gift
// subs, bits, TikTok gift coins (+ biggest single gift), and the
// viewer's best like total in one stream. Accumulates on the user
// record; badges derive from these at render time.
async function handleStat(env, body) {
  const ch = chanName(body.ch);
  const chan = await authedChan(env, ch, String(body.k || ''));
  if (!chan) return json({ ok: false, error: 'unauthorized' }, 403);
  const vk = viewerKey(body.viewer, body.platform);
  if (!vk) return json({ ok: false, error: 'bad-viewer' }, 400);
  const kind = String(body.kind || '');
  const value = Math.max(0, Math.min(10000000, Math.floor(Number(body.value) || 0)));
  if (!value) return json({ ok: false, error: 'bad-value' }, 400);

  const user = (await kvGet(env, KEY.user(ch, vk))) || { t: 0, s: 0, b: 0, l: null, d: [] };
  const st = user.stats || {};
  if (kind === 'giftsub') {
    const cumulative = Math.max(0, Math.floor(Number(body.meta && body.meta.cumulative) || 0));
    // EventSub's cumulative_total is authoritative when present.
    st.gifted = Math.max((Number(st.gifted) || 0) + value, cumulative);
  } else if (kind === 'bits') {
    st.bits = (Number(st.bits) || 0) + value;
  } else if (kind === 'ttgift') {
    st.coins = (Number(st.coins) || 0) + value;
    const name = cleanDisplay(body.meta && body.meta.giftName) || 'Gift';
    if (!st.bigGift || value > (Number(st.bigGift.c) || 0)) st.bigGift = { n: name.slice(0, 30), c: value };
  } else if (kind === 'ttlike') {
    st.likesBest = Math.max(Number(st.likesBest) || 0, value);
  } else {
    return json({ ok: false, error: 'bad-kind' }, 400);
  }
  user.stats = st;
  if (!user.display) user.display = cleanDisplay(body.display) || vk;
  await kvPut(env, KEY.user(ch, vk), user);
  return json({ ok: true, stats: st });
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

// Create (or adopt) the check-in reward on Twitch and bind it to the
// channel. Shared by the customizer's Create button and the automatic
// path inside the OAuth callback. Returns:
//   { ok: true,  status: 'created'|'linked', reward }
//   { ok: false, status: 'unavailable'|'failed', error }
// 'linked' = a reward with the same title already existed (made by the
// streamer or an earlier claim); we bind by id so matching and renames
// keep working (refunds only work when the reward is ours, as before).
async function createCheckinReward(env, ch, chan, opts = {}) {
  const title = cleanDisplay(opts.title) || 'Daily Check-In';
  const cost = Math.min(1000000, Math.max(1, Number(opts.cost) || 100));
  const prompt = cleanMsg(opts.prompt) ||
    'Check in for today! Your message shows on your card. Customize it at aquilo.gg/punchcard/card/?ch=' + ch;
  const j = await chanHelix(env, ch, chan, '/channel_points/custom_rewards',
    { broadcaster_id: chan.userId },
    { method: 'POST', body: {
      title, cost, prompt,
      is_user_input_required: true,
      background_color: '#FF6AB5',
      is_global_cooldown_enabled: false,
      // Twitch itself blocks a second redeem while live; the worker's
      // dup-refund stays as the backstop for offline redeems and
      // stream restarts.
      is_max_per_user_per_stream_enabled: true,
      max_per_user_per_stream: 1,
    } });
  if (!j._error) {
    const r = j.data && j.data[0];
    if (!r) return { ok: false, status: 'failed', error: 'no-reward' };
    chan.rewardId = r.id;
    chan.rewardTitle = r.title;
    await kvPut(env, KEY.chan(ch), chan);
    return { ok: true, status: 'created', reward: { id: r.id, title: r.title, cost: r.cost } };
  }
  if (j.status === 400 && /DUPLICATE_REWARD|duplicate/i.test(j.message || '')) {
    const list = await chanHelix(env, ch, chan, '/channel_points/custom_rewards', { broadcaster_id: chan.userId });
    const found = !list._error && (list.data || []).find(
      (r) => String(r.title).trim().toLowerCase() === title.trim().toLowerCase());
    if (found) {
      chan.rewardId = found.id;
      chan.rewardTitle = found.title;
      await kvPut(env, KEY.chan(ch), chan);
      return { ok: true, status: 'linked', reward: { id: found.id, title: found.title, cost: found.cost } };
    }
  }
  if (j.status === 403) return { ok: false, status: 'unavailable', error: 'affiliate-required' };
  return { ok: false, status: 'failed', error: j.message || 'helix' };
}

async function handleRewardCreate(env, body) {
  const ch = chanName(body.ch);
  const chan = await authedChan(env, ch, String(body.k || ''));
  if (!chan) return json({ ok: false, error: 'unauthorized' }, 403);
  const res = await createCheckinReward(env, ch, chan, {
    title: body.title, cost: body.cost, prompt: body.prompt,
  });
  if (!res.ok) {
    // The customizer keys its "needs Affiliate" hint off status 403.
    return json({ ok: false, error: res.error, status: res.status === 'unavailable' ? 403 : 502 }, 502);
  }
  return json({ ok: true, reward: res.reward, linked: res.status === 'linked' });
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
  if (typeof cfg.autoFulfill === 'boolean') next.autoFulfill = cfg.autoFulfill;
  if (typeof cfg.refundDup === 'boolean') next.refundDup = cfg.refundDup;
  if (typeof cfg.announceMilestones === 'boolean') next.announceMilestones = cfg.announceMilestones;
  if (typeof cfg.announceWelcome === 'boolean') next.announceWelcome = cfg.announceWelcome;
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
  return /^(yt:|kk:|tt:)?[a-z0-9_\-.]{2,40}$/.test(v) ? v : null;
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
  // Anonymous (pre-link) session: the editor polls this until the
  // viewer's chat `!link CODE` binds an identity.
  if (!sess.login) {
    return json({
      ok: true, anon: true,
      channel: chan ? { claimed: true, display: chan.display, rewardTitle: chan.rewardTitle } : { claimed: false },
    });
  }
  const user = (await kvGet(env, KEY.user(ch, sess.login))) || {};
  const emoteRec = await kvGet(env, KEY.emotes(sess.login));
  const subTier = chan ? await subTierFor(env, ch, chan, sess.login, null) : 0;
  return json({
    ok: true,
    login: sess.login, display: sess.display, avatar: sess.avatar,
    streak: user.s || 0, total: user.t || 0, best: user.b || 0,
    last: user.l || null, dates: user.d || [], card: user.card || null,
    ring: ringFor(user.b || 0),
    freezes: Math.max(0, Number(user.f) || 0),
    stats: user.stats || null,
    subTier,
    hasEmotes: !!(emoteRec && emoteRec.list && emoteRec.list.length),
    channel: chan ? {
      claimed: true, display: chan.display, rewardTitle: chan.rewardTitle,
      allowCustomImg: !!(chan.cfg && chan.cfg.allowCustomImg),
    } : { claimed: false },
  });
}

// The viewer's snapshotted emote set for the editor's badge picker.
async function handleEmotes(req, env) {
  const sess = await sessionFrom(req, env);
  if (!sess) return json({ ok: false, error: 'login-required' }, 401);
  const rec = await kvGet(env, KEY.emotes(sess.login));
  if (!rec || !Array.isArray(rec.list) || !rec.list.length) {
    // Logged in before the emotes scope existed (or fetch failed):
    // a fresh login re-snapshots.
    return json({ ok: true, emotes: [], needsRelogin: true });
  }
  return json({ ok: true, emotes: rec.list, ts: rec.ts });
}

async function handleCardSave(req, env, body) {
  const sess = await sessionFrom(req, env);
  if (!sess || !sess.login) return json({ ok: false, error: 'login-required' }, 401);
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
    cfg: cfg ? {
      tz: cfg.tz, rollover: cfg.rollover, mode: cfg.mode,
      allowCustomImg: !!cfg.allowCustomImg,
      autoFulfill: cfg.autoFulfill !== false,
      refundDup: cfg.refundDup !== false,
      announceMilestones: !!cfg.announceMilestones,
      announceWelcome: !!cfg.announceWelcome,
    } : null,
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
    if (route === 'emotes') return handleEmotes(req, env);
    if (route === 'linkcode') return handleLinkCode(req, env, url);
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
  if (route === 'anon') return handleAnonSession(env);
  if (route === 'link') return handleLink(env, body);
  if (route === 'stat') return handleStat(env, body);
  if (route === 'checkin') return handleCheckin(env, body);
  if (route === 'reward') return handleRewardCreate(env, body);
  if (route === 'cfg') return handleCfg(env, body);
  if (route === 'mod') return handleMod(env, body);
  if (route === 'card') return handleCardSave(req, env, body);
  return json({ ok: false, error: 'not-found' }, 404);
}
