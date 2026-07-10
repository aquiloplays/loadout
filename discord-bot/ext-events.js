// Per-channel game-event bus + PowerDeck streamer queue for the extension.
//
// Two things live here, both keyed by the channel's Twitch id so they're
// multi-tenant:
//   • an EPHEMERAL event ring (`gameevt:<channelId>`) — notable game moments
//     (big casino win, tank-battle finish, scratch jackpot, PowerDeck open/
//     play) that a hosted OBS overlay polls and animates. No local
//     StreamFusion needed — the worker is the source.
//   • a PERSISTENT PowerDeck queue (`pdeckq:<channelId>`) — cards viewers
//     played, that the streamer accepts / completes / declines from the Dock.
//
// The game handlers only ever have the per-channel `guildId` namespace, so we
// derive the Twitch channel id from it (no new plumbing through every game):
//   guildId `ch:<id>`            → channelId `<id>`
//   guildId AQUILO_VAULT_GUILD_ID → Clay's CLAY_TWITCH_CHANNEL_ID

import { loginToId, vaultHelix } from './warden-twitch.js';

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    },
  });
}

// Resolve the Twitch channel id from a per-channel economy namespace.
export function channelIdFor(env, guildId) {
  const g = String(guildId || '');
  if (g.indexOf('ch:') === 0) return g.slice(3);
  if (env && env.AQUILO_VAULT_GUILD_ID && g === String(env.AQUILO_VAULT_GUILD_ID)) {
    return String(env.CLAY_TWITCH_CHANNEL_ID || '');
  }
  return '';
}

// Inverse: the economy namespace for a Twitch channel id (mirrors nsFor in
// ext.js). Clay keeps his Discord-guild namespace; everyone else is ch:<id>.
export function guildForChannel(env, channelId) {
  if (env && env.CLAY_TWITCH_CHANNEL_ID && String(channelId) === String(env.CLAY_TWITCH_CHANNEL_ID)) {
    return env.AQUILO_VAULT_GUILD_ID || ('ch:' + channelId);
  }
  return 'ch:' + channelId;
}

function fmtBolts(x) { return (Number(x) || 0).toLocaleString('en-US'); }

// Announce a big win in the channel's own Twitch chat as the broadcaster,
// via the per-channel vault (best-effort; needs user:write:chat). Gated on the
// streamer's `chatWins` config (default on). PowerDeck plays self-announce
// elsewhere, so they're excluded here.
async function announceWin(env, channelId, evt) {
  try {
    if (!channelId || !evt || evt.type === 'powerdeck-play') return;
    let cfg = null;
    try { cfg = await env.LOADOUT_BOLTS.get('extcfg:' + channelId, { type: 'json' }); } catch { /* default on */ }
    if (cfg && cfg.chatWins === false) return;
    const n = evt.name || 'A viewer';
    let msg = '';
    if (evt.type === 'casino-win') msg = '🎰 ' + n + ' just won ' + fmtBolts(evt.amount) + ' Bolts in the casino!';
    else if (evt.type === 'scratch-win') msg = '🎟️ ' + n + ' hit a ' + (evt.tier || 'big') + ' scratch-off — ' + fmtBolts(evt.amount) + ' Bolts!';
    else if (evt.type === 'tanks-win') msg = '💥 ' + n + ' won the tank battle and took ' + fmtBolts(evt.amount) + ' Bolts!';
    if (!msg) return;
    await vaultHelix(env, String(channelId), '/chat/messages', {
      method: 'POST',
      body: { broadcaster_id: String(channelId), sender_id: String(channelId), message: msg.slice(0, 400) },
    });
  } catch { /* best-effort — a chat hiccup must never break a game */ }
}

const EVT_KEY = (ch) => `gameevt:${ch}`;
const EVT_MAX = 24;        // ring size
const EVT_TTL = 300;       // seconds — overlays that reconnect see recent events
const PDQ_KEY = (ch) => `pdeckq:${ch}`;
const PDQ_MAX = 60;        // cap the queue

// ── event ring ─────────────────────────────────────────────────────────
// Fire-and-forget from game handlers. Low per-channel frequency, so a plain
// read-modify-write ring is fine (a rare lost event just means one missed
// overlay flourish). Never throws.
export async function pushGameEvent(env, guildId, evt) {
  try {
    const channelId = channelIdFor(env, guildId);
    if (!channelId || !evt) return;
    let state = null;
    try { state = await env.LOADOUT_BOLTS.get(EVT_KEY(channelId), { type: 'json' }); } catch { /* new */ }
    state = state && typeof state.seq === 'number' ? state : { seq: 0, events: [] };
    state.seq += 1;
    const record = Object.assign({ id: state.seq, ts: Date.now() }, evt);
    state.events.push(record);
    if (state.events.length > EVT_MAX) state.events = state.events.slice(state.events.length - EVT_MAX);
    await env.LOADOUT_BOLTS.put(EVT_KEY(channelId), JSON.stringify(state), { expirationTtl: EVT_TTL });
    // Also shout big wins in chat (config-gated; PowerDeck self-announces).
    await announceWin(env, channelId, evt);
  } catch { /* best-effort — an overlay flourish must never break a game */ }
}

export async function readGameEvents(env, channelId, after) {
  let state = null;
  try { state = await env.LOADOUT_BOLTS.get(EVT_KEY(channelId), { type: 'json' }); } catch { /* none */ }
  state = state && typeof state.seq === 'number' ? state : { seq: 0, events: [] };
  const a = Number(after) || 0;
  const events = state.events.filter((e) => e && e.id > a);
  return { ok: true, seq: state.seq, events };
}

// ── PowerDeck queue ──────────────────────────────────────────────────────
export async function enqueuePowerdeck(env, guildId, item) {
  try {
    const channelId = channelIdFor(env, guildId);
    if (!channelId || !item) return;
    let q = null;
    try { q = await env.LOADOUT_BOLTS.get(PDQ_KEY(channelId), { type: 'json' }); } catch { /* new */ }
    q = Array.isArray(q) ? q : [];
    q.push(item);
    if (q.length > PDQ_MAX) q = q.slice(q.length - PDQ_MAX);
    await env.LOADOUT_BOLTS.put(PDQ_KEY(channelId), JSON.stringify(q));
  } catch { /* best-effort */ }
}

export async function readPowerdeckQueue(env, channelId) {
  let q = null;
  try { q = await env.LOADOUT_BOLTS.get(PDQ_KEY(channelId), { type: 'json' }); } catch { /* none */ }
  return Array.isArray(q) ? q : [];
}

// Streamer action from the Dock: accept | complete | decline. accept flips
// status to 'active'; complete/decline remove the card. Returns the new queue.
export async function actPowerdeckQueue(env, channelId, id, action) {
  let q = await readPowerdeckQueue(env, channelId);
  const idx = q.findIndex((c) => c && String(c.id) === String(id));
  if (idx < 0) return q;
  if (action === 'accept') {
    q[idx] = Object.assign({}, q[idx], { status: 'active' });
  } else if (action === 'complete' || action === 'decline') {
    q.splice(idx, 1);
  }
  try { await env.LOADOUT_BOLTS.put(PDQ_KEY(channelId), JSON.stringify(q)); } catch { /* best-effort */ }
  return q;
}

// ── public overlay feed ──────────────────────────────────────────────────
// GET /ext/events?pair=<dockKey>&after=<seq>  (or ?ch=<login>)
// Read-only, unauthenticated (game moments aren't sensitive). The streamer's
// OBS overlay carries the pair token (dockKey) or channel login.
export async function handleGameEvents(req, env) {
  const url = new URL(req.url);
  const after = url.searchParams.get('after') || '0';
  let channelId = '';

  const pair = url.searchParams.get('pair') || '';
  const ch = (url.searchParams.get('ch') || '').toLowerCase().replace(/^@/, '');
  if (pair && /^[a-z0-9]{8,40}$/.test(pair)) {
    try {
      const { dockOwner } = await import('./aquilo-dock.js');
      const owner = await dockOwner(env, pair);
      if (owner && owner.twitchId) channelId = String(owner.twitchId);
    } catch { /* fall through */ }
  }
  if (!channelId && ch && /^[a-z0-9_]{2,30}$/.test(ch)) {
    try { channelId = String(await loginToId(env, ch) || ''); } catch { /* none */ }
  }
  if (!channelId) return json({ ok: false, error: 'unknown-channel', seq: 0, events: [] }, 404);

  return json(await readGameEvents(env, channelId, after));
}
