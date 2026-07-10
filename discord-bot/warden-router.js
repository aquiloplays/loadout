// warden-router.js — /web/warden/* dispatcher (BE-1)
//
// worker.js routes `path.startsWith('/web/warden/')` here BEFORE the
// generic /web/* dispatcher. This module owns:
//   • the site HMAC verify (x-aquilo-web-{ts,sig} over AQUILO_SITE_WEB_SECRET
//     — the same envelope web.js uses),
//   • reading the SERVER-STAMPED { actorId, actorLogin } the site
//     dispatcher injected (we trust it BECAUSE the HMAC verified; the raw
//     browser body never carries the ACL),
//   • per-route isAuthorized re-checks (broadcaster-only where required),
//   • dispatch into the warden-* modules (BE-1 mods/twitch, BE-3
//     actions/terms/audit/notes).
//
// The room/ws WebSocket UPGRADE is handled in worker.js (routes straight
// to the WardenRoom DO); this router only mints the ticket for room/ticket.
//
// Every handler graceful-degrades to a typed { ok:false, error } JSON
// body; nothing throws to the top.

import { verifyHmac } from './auth.js';
import {
  ensureSchema, mintRoomTicket,
} from './warden-db.js';
import { isAuthorized } from './warden-mods.js';

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

// wss URL the browser opens directly (WS can't traverse Pages Functions).
function wsUrlFor(env, ticket) {
  const origin = (env.PUBLIC_WORKER_URL || 'https://loadout-discord.aquiloplays.workers.dev')
    .replace(/\/$/, '').replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
  return `${origin}/web/warden/room/ws?ticket=${encodeURIComponent(ticket)}`;
}

// Jukebox Spotify-queue proxy. The song-request queue lives on the jukebox
// worker keyed by the streamer's dockKey; we resolve that key server-side
// from ROTATION_KV so a mod never handles it, then GET the snapshot or POST
// a control action to the jukebox's /api/dock/queue bridge.
const JUKEBOX_BASE = 'https://jukebox.aquilo.gg';
async function jukeboxQueue(env, streamerId, action /* null = read */) {
  let rec = null;
  try {
    rec = env.ROTATION_KV ? await env.ROTATION_KV.get('streamer:' + streamerId, { type: 'json' }) : null;
  } catch { /* treat as not-set-up */ }
  if (!rec || !rec.dockKey) {
    // Jukebox never connected for this streamer — a soft "not set up" state
    // the panel renders as an empty prompt rather than an error.
    return { ok: true, connected: false, setup: false, nowPlaying: null, queue: [] };
  }
  const url = JUKEBOX_BASE + '/api/dock/queue?key=' + encodeURIComponent(rec.dockKey);
  try {
    const resp = action
      ? await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) })
      : await fetch(url, { method: 'GET' });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return { ok: false, error: data.error || ('jukebox-' + resp.status) };
    return { setup: true, ...data };
  } catch (e) {
    return { ok: false, error: 'jukebox-unreachable', message: String(e?.message || e).slice(0, 80) };
  }
}

// Counters (rotation-bot) proxy — same server-side-dockKey pattern as the
// Spotify queue: mods bump the streamer's stream counters without ever
// handling the capability key. `bump` = {c, op} applies a +/- delta and
// returns the fresh value; null reads the list (id/label/value only — the
// dockKey-bearing URL bases the dock bridge returns are stripped out).
async function wardenCounters(env, streamerId, bump) {
  let rec = null;
  try {
    rec = env.ROTATION_KV ? await env.ROTATION_KV.get('streamer:' + streamerId, { type: 'json' }) : null;
  } catch { /* treat as not-set-up */ }
  if (!rec || !rec.dockKey) {
    // Aquilo Bot never connected for this streamer — a soft "not set up"
    // state the panel renders as an empty prompt rather than an error.
    return { ok: true, connected: false, setup: false, counters: [] };
  }
  const key = encodeURIComponent(rec.dockKey);
  try {
    if (bump) {
      const url = JUKEBOX_BASE + '/api/counter/bump?key=' + key +
        '&c=' + encodeURIComponent(bump.c) + '&op=' + encodeURIComponent(bump.op);
      const resp = await fetch(url, { method: 'GET' });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data.error) return { ok: false, error: data.error || ('counter-' + resp.status) };
      return { ok: true, id: data.id, label: data.label, value: data.value, total: data.total ?? null, game: data.game ?? null };
    }
    const resp = await fetch(JUKEBOX_BASE + '/api/dock/bot?key=' + key, { method: 'GET' });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.ok === false) return { ok: false, error: data.error || ('counter-' + resp.status) };
    const vals = data.counterValues || {};
    const counters = (data.counters || []).map((c) => ({
      id: c.id, name: c.name, label: c.label || c.name, perGame: !!c.perGame,
      value: Number(vals[c.id] || 0),
    }));
    return { ok: true, connected: true, setup: true, game: data.game || null, counters };
  } catch (e) {
    return { ok: false, error: 'counter-unreachable', message: String(e?.message || e).slice(0, 80) };
  }
}

// Save the full counters array (add/edit/delete/rename/perGame/links/style) —
// mods configure the streamer's counters from the console. Proxies the bot's
// dock bridge (POST /api/dock/bot {counters}); the bot validates + preserves
// existing tallies by id.
async function wardenCountersSave(env, streamerId, counters) {
  let rec = null;
  try { rec = env.ROTATION_KV ? await env.ROTATION_KV.get('streamer:' + streamerId, { type: 'json' }) : null; }
  catch { /* not set up */ }
  if (!rec || !rec.dockKey) return { ok: false, connected: false, setup: false, error: 'not-setup' };
  try {
    const resp = await fetch(JUKEBOX_BASE + '/api/dock/bot?key=' + encodeURIComponent(rec.dockKey), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ counters }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.ok === false) return { ok: false, error: data.error || ('counter-' + resp.status) };
    const vals = data.counterValues || {};
    const list = (data.counters || []).map((c) => ({
      id: c.id, name: c.name, label: c.label || c.name, perGame: !!c.perGame,
      value: Number(vals[c.id] || 0),
    }));
    return { ok: true, counters: list };
  } catch (e) {
    return { ok: false, error: 'counter-unreachable', message: String(e?.message || e).slice(0, 80) };
  }
}

// Generic dock-action proxy (announce / giveaway / shoutout) — same
// server-side-dockKey resolution as the counters/queue proxies. `action` is
// the jukebox dock body ({kind, ...}); a mod never touches the key.
async function dockAct(env, streamerId, action) {
  let rec = null;
  try {
    rec = env.ROTATION_KV ? await env.ROTATION_KV.get('streamer:' + streamerId, { type: 'json' }) : null;
  } catch { /* not set up */ }
  if (!rec || !rec.dockKey) return { ok: false, connected: false, setup: false, error: 'not-setup' };
  try {
    const resp = await fetch(JUKEBOX_BASE + '/api/dock/action?key=' + encodeURIComponent(rec.dockKey), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.ok === false) return { ok: false, error: data.error || data.reason || ('bot-' + resp.status) };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'bot-unreachable', message: String(e?.message || e).slice(0, 80) };
  }
}

// Trim Twitch's poll / prediction payloads to what the console needs.
function shapePoll(p) {
  const started = p.started_at ? Date.parse(p.started_at) : 0;
  return {
    id: String(p.id || ''), title: String(p.title || ''), status: String(p.status || ''),
    endsAt: started && p.duration ? started + Number(p.duration) * 1000 : 0,
    choices: (Array.isArray(p.choices) ? p.choices : []).map((c) => ({
      id: String(c.id || ''), title: String(c.title || ''),
      votes: Number(c.votes || 0),
    })),
  };
}
function shapePrediction(p) {
  return {
    id: String(p.id || ''), title: String(p.title || ''), status: String(p.status || ''),
    endsAt: p.created_at && p.prediction_window ? Date.parse(p.created_at) + Number(p.prediction_window) * 1000 : 0,
    winningOutcomeId: p.winning_outcome_id ? String(p.winning_outcome_id) : null,
    outcomes: (Array.isArray(p.outcomes) ? p.outcomes : []).map((o) => ({
      id: String(o.id || ''), title: String(o.title || ''), color: String(o.color || ''),
      users: Number(o.users || 0), points: Number(o.channel_points || 0),
    })),
  };
}

// Fire-and-forget audit row; audit is never allowed to fail an action.
async function auditSafe(env, entry) {
  try {
    const { addAudit } = await import('./warden-audit.js');
    await addAudit(env, entry);
  } catch { /* non-fatal */ }
}

// Routes that only the BROADCASTER of streamerId may call.
const BROADCASTER_ONLY = new Set([
  'mods/add', 'mods/remove', 'mods/sync', 'terms/add', 'terms/remove',
]);

// Routes that require NO streamerId authorization (identity-only).
const NO_STREAMER = new Set(['whoami']);

export async function handleWardenRoute(req, env, path, ctx) {
  if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405);
  if (!env.AQUILO_SITE_WEB_SECRET) {
    return json({ ok: false, error: 'not-configured' }, 503);
  }

  const sub = String(path || '').replace(/^\/web\/warden\//, '').replace(/\/+$/, '');
  if (!sub) return json({ ok: false, error: 'not-found' }, 404);

  // Read raw body ONCE, verify HMAC over the raw bytes, then parse.
  const bodyText = await req.text();
  const ts = req.headers.get('x-aquilo-web-ts');
  const sig = req.headers.get('x-aquilo-web-sig');
  const ok = await verifyHmac(env.AQUILO_SITE_WEB_SECRET, ts || '', bodyText, sig || '');
  if (!ok) return json({ ok: false, error: 'unauthorized' }, 401);

  let body;
  try { body = bodyText ? JSON.parse(bodyText) : {}; } catch { return json({ ok: false, error: 'bad-json' }, 400); }
  if (!body || typeof body !== 'object') body = {};

  // Server-stamped identity (injected by the site dispatcher, trusted via
  // HMAC). NEVER read an ACL streamerId as identity.
  const actorId = String(body.actorId || '').trim();
  const actorLogin = String(body.actorLogin || '').trim().toLowerCase();
  if (!/^\d{1,20}$/.test(actorId)) return json({ ok: false, error: 'bad-actor' }, 400);

  const streamerId = String(body.streamerId || '').trim();

  await ensureSchema(env);

  try {
    // whoami needs no streamer authorization.
    if (sub === 'whoami') {
      const { whoami, syncTwitchMods } = await import('./warden-mods.js');
      const res = await whoami(env, actorId, actorLogin);
      // Auto-detect: when the actor broadcasts (connected own channel),
      // refresh their Twitch mod list in the background so mods gain
      // Warden access without a manual add. Throttled inside (KV, 10
      // min) and off the response path — whoami latency is untouched.
      if (res.streamers.some((c) => c.streamerId === actorId && c.role === 'broadcaster')) {
        const p = syncTwitchMods(env, actorId).catch(() => {});
        try { ctx && ctx.waitUntil && ctx.waitUntil(p); } catch { /* best-effort */ }
      }
      return json({ ok: true, ...res });
    }

    // Everything else is streamer-scoped: validate + authorize.
    if (!NO_STREAMER.has(sub)) {
      if (!/^\d{1,20}$/.test(streamerId)) return json({ ok: false, error: 'bad-streamer' }, 400);
      const authz = await isAuthorized(env, actorId, streamerId);
      if (!authz) return json({ ok: false, error: 'forbidden' }, 403);
      if (BROADCASTER_ONLY.has(sub) && authz.role !== 'broadcaster') {
        return json({ ok: false, error: 'broadcaster-only' }, 403);
      }
      // Stash for handlers that want the role.
      body._role = authz.role;
    }

    switch (sub) {
      // ── mod team (BE-1) ─────────────────────────────────────────────
      case 'mods/list': {
        const { listMods, syncTwitchMods } = await import('./warden-mods.js');
        // Broadcaster opening the Team tab: pull the Twitch mod list
        // first (KV-throttled) so the roster reflects reality without a
        // manual sync. Mods listing the team skip this — their token
        // can't enumerate the broadcaster's mods anyway.
        if (body._role === 'broadcaster') {
          await syncTwitchMods(env, streamerId).catch(() => {});
        }
        return json(await listMods(env, streamerId));
      }
      case 'mods/sync': {
        const { listMods, syncTwitchMods } = await import('./warden-mods.js');
        const sync = await syncTwitchMods(env, streamerId, { force: true });
        const list = await listMods(env, streamerId);
        return json({ ...list, sync });
      }
      case 'mods/add': {
        const { addMod } = await import('./warden-mods.js');
        return json(await addMod(env, streamerId, body.login, actorId));
      }
      case 'mods/remove': {
        const { removeMod } = await import('./warden-mods.js');
        return json(await removeMod(env, streamerId, String(body.modId || '')));
      }

      // ── printer doodle moderation (printflair) ─────────────────────
      // The receipt printer's viewer-doodle queue, moderatable by the
      // whole mod team. Doodles are account-global (keyed by viewer
      // login); reaching them still requires being authorized for THIS
      // streamer, which gates access to the mod team.
      case 'doodles/list': {
        const { listDoodleQueue } = await import('./printflair.js');
        return json({ ok: true, items: await listDoodleQueue(env) });
      }
      case 'doodles/review': {
        const { reviewDoodle } = await import('./printflair.js');
        const res = await reviewDoodle(env, body.login, body.approve === true);
        return json(res, res.ok ? 200 : 400);
      }

      // ── OBS control (mod-triggered, broadcaster-allowlisted) ───────
      // The streamer configures a capability allowlist in StreamFusion
      // (mirrored to KV warden:obscaps:<streamerId>). Mods can only fire
      // actions on that list; StreamFusion's room agent executes them
      // against local OBS. Feature is dark until caps exist.
      case 'obs/caps-get': {
        const raw = await env.LOADOUT_BOLTS.get('warden:obscaps:' + streamerId, 'json').catch(() => null);
        return json({ ok: true, caps: raw || null });
      }
      case 'obs/command': {
        const caps = await env.LOADOUT_BOLTS.get('warden:obscaps:' + streamerId, 'json').catch(() => null);
        if (!caps || !caps.enabled) return json({ ok: false, error: 'obs-not-enabled' }, 403);
        const action = String(body.action || '');
        const arg = String(body.arg || '');
        // arg2 = the action's second parameter (filter name, dB level, media
        // verb, or move-target). Kept as one field so every action shares a
        // uniform { action, arg, arg2 } envelope through the room frame.
        const arg2 = String(body.arg2 || '');
        const { isObsCommandAllowed } = await import('./warden-obs.js');
        if (!isObsCommandAllowed(caps, action, arg, arg2)) {
          return json({ ok: false, error: 'action-not-allowed' }, 403);
        }
        const { checkObsRate } = await import('./warden-actions.js');
        const rl = await checkObsRate(env, actorId);
        if (!rl.ok) return json({ ok: false, error: 'rate-limited' }, 429);
        const cmdId = 'obs-' + Date.now().toString(36) + Math.floor(Math.random() * 1e5).toString(36);
        try {
          const { broadcastToWardenRoom } = await import('./aquilo/warden-room-do.js');
          await broadcastToWardenRoom(env, streamerId, JSON.stringify({
            t: 'obs-cmd', cmdId, action, arg, arg2,
            by: actorLogin || actorId, ts: Date.now(),
          }));
        } catch { return json({ ok: false, error: 'room-unreachable' }, 502); }
        try {
          const { addAudit } = await import('./warden-audit.js');
          await addAudit(env, {
            streamerId, actorId, actorLogin,
            action: 'obs-' + action, platform: 'obs',
            targetLogin: (arg2 ? arg + ' ' + arg2 : arg) || null, detail: { cmdId },
          });
        } catch { /* non-fatal */ }
        return json({ ok: true, cmdId });
      }

      // ── Spotify song-request queue (Jukebox) ───────────────────────
      // The mod team's view of the streamer's Spotify queue + controls.
      // Read is open to the whole team; actions (skip/pause/play/like/ban)
      // are moderator work by nature, so they stay mod/broadcaster too
      // (not broadcaster-only). Ban/skip get an audit row.
      case 'queue/list': {
        return json(await jukeboxQueue(env, streamerId, null));
      }
      case 'queue/act': {
        const kind = String(body.kind || '');
        if (['skip', 'pause', 'play', 'like', 'ban'].indexOf(kind) === -1) {
          return json({ ok: false, error: 'bad-kind' }, 400);
        }
        const { checkObsRate } = await import('./warden-actions.js');
        const rl = await checkObsRate(env, actorId);   // shared mod-action rate limiter
        if (!rl.ok) return json({ ok: false, error: 'rate-limited' }, 429);
        const action = { kind };
        if (kind === 'ban') {
          if (body.trackId) action.id = String(body.trackId).slice(0, 40);
          if (body.title) action.title = String(body.title).slice(0, 120);
        }
        const res = await jukeboxQueue(env, streamerId, action);
        // Audit the destructive/visible controls (skip + ban), mirroring
        // obs/command's pattern; play/pause/like are low-stakes toggles.
        if (res.ok !== false && (kind === 'skip' || kind === 'ban')) {
          try {
            const { addAudit } = await import('./warden-audit.js');
            await addAudit(env, {
              streamerId, actorId, actorLogin,
              action: 'queue-' + kind, platform: 'spotify',
              targetLogin: null,
              detail: kind === 'ban' ? { title: res.title || body.title || null } : null,
            });
          } catch { /* non-fatal */ }
        }
        return json(res);
      }

      // ── stream counters (Aquilo Bot) ───────────────────────────────
      // The mod team can read and bump the streamer's stream counters
      // (deaths, wins, …). Read is open to the whole team; bumps apply a
      // +/- delta only — set/reset stay with the broadcaster (dock/dash).
      // Same rate limiter + audit as the other mod actions.
      case 'counters/list': {
        return json(await wardenCounters(env, streamerId, null));
      }
      case 'counters/bump': {
        const c = String(body.c || '');
        const op = String(body.op || '+').trim();
        if (!c) return json({ ok: false, error: 'bad-counter' }, 400);
        // Mods apply +/- deltas only (e.g. "+", "-", "+5"); the destructive
        // set/reset ops are broadcaster-only, done from the dock/dashboard.
        if (!/^[+-]\d{0,7}$/.test(op)) return json({ ok: false, error: 'bad-op' }, 400);
        const { checkObsRate } = await import('./warden-actions.js');
        const rl = await checkObsRate(env, actorId);   // shared mod-action rate limiter
        if (!rl.ok) return json({ ok: false, error: 'rate-limited' }, 429);
        const res = await wardenCounters(env, streamerId, { c, op });
        if (res.ok !== false) {
          try {
            const { addAudit } = await import('./warden-audit.js');
            await addAudit(env, {
              streamerId, actorId, actorLogin,
              action: 'counter-bump', platform: 'counter',
              targetLogin: null,
              detail: { counter: res.label || c, op, value: res.value ?? null },
            });
          } catch { /* non-fatal */ }
        }
        return json(res, res.ok === false ? 400 : 200);
      }
      case 'counters/save': {
        if (!Array.isArray(body.counters)) return json({ ok: false, error: 'bad-counters' }, 400);
        const { checkObsRate } = await import('./warden-actions.js');
        const rl = await checkObsRate(env, actorId);
        if (!rl.ok) return json({ ok: false, error: 'rate-limited' }, 429);
        const res = await wardenCountersSave(env, streamerId, body.counters.slice(0, 20));
        if (res.ok !== false) {
          await auditSafe(env, { streamerId, actorId, actorLogin, action: 'counters-save', platform: 'counter', detail: { count: body.counters.length } });
        }
        return json(res, res.ok === false ? 400 : 200);
      }

      // ── Show control (Aquilo Bot, via the dock proxy) ──────────────
      // Mods run the show without the streamer's dock key: post an
      // announcement to every connected chat, fire a shoutout, or drive the
      // Bolts giveaway. Rate-limited + audited like every other mod action.
      case 'show/announce': {
        const message = String(body.message || '').trim().slice(0, 400);
        if (!message) return json({ ok: false, error: 'empty' }, 400);
        const { checkObsRate } = await import('./warden-actions.js');
        const rl = await checkObsRate(env, actorId);
        if (!rl.ok) return json({ ok: false, error: 'rate-limited' }, 429);
        const res = await dockAct(env, streamerId, { kind: 'say', text: message });
        if (res.ok) await auditSafe(env, { streamerId, actorId, actorLogin, action: 'show-announce', platform: 'chat', detail: { message: message.slice(0, 120) } });
        return json(res, res.ok ? 200 : 400);
      }
      case 'show/shoutout': {
        const login = String(body.login || '').trim().toLowerCase().replace(/^@/, '');
        if (!/^[a-z0-9_]{2,25}$/.test(login)) return json({ ok: false, error: 'bad-login' }, 400);
        const { checkObsRate } = await import('./warden-actions.js');
        const rl = await checkObsRate(env, actorId);
        if (!rl.ok) return json({ ok: false, error: 'rate-limited' }, 429);
        const res = await dockAct(env, streamerId, { kind: 'say', text: `📢 Go show @${login} some love: twitch.tv/${login}` });
        if (res.ok) await auditSafe(env, { streamerId, actorId, actorLogin, action: 'show-shoutout', platform: 'chat', targetLogin: login });
        return json(res, res.ok ? 200 : 400);
      }
      case 'show/giveaway': {
        const op = ['start', 'draw', 'end'].indexOf(String(body.op || '')) !== -1 ? String(body.op) : null;
        if (!op) return json({ ok: false, error: 'bad-op' }, 400);
        const { checkObsRate } = await import('./warden-actions.js');
        const rl = await checkObsRate(env, actorId);
        if (!rl.ok) return json({ ok: false, error: 'rate-limited' }, 429);
        const res = await dockAct(env, streamerId, { kind: 'giveaway', op });
        if (res.ok) await auditSafe(env, { streamerId, actorId, actorLogin, action: 'show-giveaway-' + op, platform: 'chat' });
        return json(res, res.ok ? 200 : 400);
      }

      // ── Safety: Shield Mode + active punishments ────────────────────
      // Shield Mode = Twitch's one-switch raid lockdown (needs the
      // broadcaster token to carry moderator:manage:shield_mode; degrades to
      // "reconnect to arm" until it does). Punishments = the live ban/timeout
      // list (moderation:read, already granted) with a one-click revoke.
      case 'shield/get': {
        const { vaultHelix } = await import('./warden-twitch.js');
        const r = await vaultHelix(env, streamerId, '/moderation/shield_mode', { params: { broadcaster_id: streamerId, moderator_id: streamerId } });
        if (r.status === 0) return json({ ok: true, available: false, needsSetup: true });
        if (r.status === 401 || r.status === 403) return json({ ok: true, available: false, scopeMissing: true });
        if (!r.ok) return json({ ok: false, error: 'helix-' + (r.status || 0) });
        const d = (r.data && r.data.data && r.data.data[0]) || {};
        return json({ ok: true, available: true, active: !!d.is_active, since: d.last_activated_at || null });
      }
      case 'shield/set': {
        const active = body.active === true;
        const { checkObsRate } = await import('./warden-actions.js');
        const rl = await checkObsRate(env, actorId);
        if (!rl.ok) return json({ ok: false, error: 'rate-limited' }, 429);
        const { vaultHelix } = await import('./warden-twitch.js');
        const r = await vaultHelix(env, streamerId, '/moderation/shield_mode', {
          method: 'PUT', params: { broadcaster_id: streamerId, moderator_id: streamerId }, body: { is_active: active },
        });
        if (r.status === 0) return json({ ok: false, error: 'not-connected' }, 400);
        if (r.status === 401 || r.status === 403) return json({ ok: false, error: 'scope-missing', needsReconnect: true }, 403);
        if (!r.ok) return json({ ok: false, error: 'helix-' + (r.status || 0) }, 400);
        const d = (r.data && r.data.data && r.data.data[0]) || {};
        await auditSafe(env, { streamerId, actorId, actorLogin, action: active ? 'shield-on' : 'shield-off', platform: 'twitch' });
        return json({ ok: true, active: !!d.is_active });
      }
      case 'punishments/list': {
        const { vaultHelix } = await import('./warden-twitch.js');
        const r = await vaultHelix(env, streamerId, '/moderation/banned_users', { params: { broadcaster_id: streamerId, first: 100 } });
        if (r.status === 0) return json({ ok: true, needsSetup: true, punishments: [] });
        if (r.status === 401 || r.status === 403) return json({ ok: true, scopeMissing: true, punishments: [] });
        if (!r.ok) return json({ ok: false, error: 'helix-' + (r.status || 0), punishments: [] });
        const rows = (r.data && r.data.data) || [];
        const nowMs = Date.now();
        const punishments = rows.map((u) => ({
          userId: String(u.user_id || ''),
          login: String(u.user_login || ''),
          display: String(u.user_name || u.user_login || ''),
          expiresAt: u.expires_at || null,          // '' / null = permanent ban
          permanent: !u.expires_at,
          reason: String(u.reason || ''),
          byLogin: String(u.moderator_login || ''),
        })).filter((p) => p.permanent || (p.expiresAt && Date.parse(p.expiresAt) > nowMs));
        // Timeouts first (soonest-expiring), permabans after.
        punishments.sort((a, b) =>
          a.permanent !== b.permanent ? (a.permanent ? 1 : -1)
            : Date.parse(a.expiresAt || 0) - Date.parse(b.expiresAt || 0));
        return json({ ok: true, punishments });
      }
      case 'punishments/revoke': {
        const { performAction } = await import('./warden-actions.js');
        const res = await performAction(env, {
          streamerId, actorId, actorLogin, platform: 'twitch', kind: 'unban',
          targetLogin: body.targetLogin, targetId: body.targetId,
        });
        return json(res);
      }

      // ── Mod-activity analytics (aggregates the existing audit log) ──
      case 'audit/stats': {
        const { listAudit } = await import('./warden-audit.js');
        const rows = (await listAudit(env, streamerId, { limit: 500 })) || [];
        const sinceMs = Date.now() - 7 * 24 * 3600 * 1000;
        const byMod = new Map();
        let total = 0;
        for (const r of rows) {
          const ts = Number(r.ts || 0);
          if (ts && ts < sinceMs) continue;
          total++;
          const who = String(r.actor_login || r.actor_id || 'unknown');
          const m = byMod.get(who) || { login: who, total: 0, actions: {} };
          m.total++;
          const act = String(r.action || 'other');
          m.actions[act] = (m.actions[act] || 0) + 1;
          byMod.set(who, m);
        }
        const mods = [...byMod.values()].sort((a, b) => b.total - a.total).slice(0, 20);
        return json({ ok: true, total, windowDays: 7, mods });
      }

      // ── Unified viewer profile ──────────────────────────────────────
      // One card per viewer: the shared note, watchlist status, and recent
      // mod actions taken against them — so a mod sees the whole history
      // before acting. Aggregates existing notes/watchlist/audit; no new
      // scope. (subject_key convention is "<platform>:<login>".)
      case 'profile/get': {
        const login = String(body.login || '').trim().toLowerCase().replace(/^@/, '');
        if (!/^[a-z0-9_]{1,25}$/.test(login)) return json({ ok: false, error: 'bad-login' }, 400);
        const subjectKey = 'twitch:' + login;
        const [{ getNote, listWatch }, { listAudit }] = await Promise.all([
          import('./warden-notes.js'), import('./warden-audit.js'),
        ]);
        const [note, watch, auditRows] = await Promise.all([
          getNote(env, streamerId, subjectKey).catch(() => null),
          listWatch(env, streamerId).catch(() => []),
          listAudit(env, streamerId, { limit: 300 }).catch(() => []),
        ]);
        const w = (watch || []).find((x) => String(x.subject_key || '') === subjectKey) || null;
        const actions = (auditRows || [])
          .filter((r) => String(r.target_login || '').toLowerCase() === login)
          .slice(0, 25)
          .map((r) => ({ action: String(r.action || ''), actor: String(r.actor_login || ''), platform: String(r.platform || ''), at: Number(r.ts || 0) }));
        return json({
          ok: true, login,
          note: note ? { text: String(note.note || ''), by: String(note.author_login || ''), at: Number(note.updated_at || 0) } : null,
          onWatch: w ? { reason: String(w.reason || ''), at: Number(w.ts || 0) } : null,
          actions,
        });
      }

      // ── Mod backchannel ─────────────────────────────────────────────
      // A private mod-only coordination chat ("watching user X", "handled")
      // kept in KV (last 100 lines), so the team can talk without pinging
      // the streamer or leaking into public chat. Read + post are both
      // mod/broadcaster; posts are rate-limited. Not the WardenRoom DO — a
      // simple KV log the panel polls (a backchannel doesn't need <1s).
      case 'modchat/list': {
        const raw = await env.LOADOUT_BOLTS.get('warden:modchat:' + streamerId, 'json').catch(() => null);
        return json({ ok: true, messages: Array.isArray(raw) ? raw.slice(-80) : [] });
      }
      case 'modchat/post': {
        const text = String(body.message || '').trim().slice(0, 500);
        if (!text) return json({ ok: false, error: 'empty' }, 400);
        const { checkObsRate } = await import('./warden-actions.js');
        const rl = await checkObsRate(env, actorId);
        if (!rl.ok) return json({ ok: false, error: 'rate-limited' }, 429);
        const key = 'warden:modchat:' + streamerId;
        const cur = (await env.LOADOUT_BOLTS.get(key, 'json').catch(() => null)) || [];
        const list = Array.isArray(cur) ? cur : [];
        list.push({
          id: Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
          by: actorLogin || actorId, text, at: Date.now(),
        });
        if (list.length > 100) list.splice(0, list.length - 100);
        // Backchannel lines expire after 24h idle so a channel's KV doesn't
        // grow forever; every post refreshes the window.
        await env.LOADOUT_BOLTS.put(key, JSON.stringify(list), { expirationTtl: 86400 });
        return json({ ok: true, messages: list.slice(-80) });
      }

      // ── Polls & Predictions (Twitch REST via the broadcaster token) ─
      // Mods run the interactive show. Pure Helix — no EventSub, no DO —
      // so it's low blast radius; it degrades to needsReconnect until the
      // broadcaster token carries channel:manage:polls / :predictions
      // (broker scope + reconnect), exactly like Shield Mode. Reads return
      // {available:false} on scope-missing; writes return needsReconnect.
      case 'polls/get': {
        const { vaultHelix } = await import('./warden-twitch.js');
        const r = await vaultHelix(env, streamerId, '/polls', { params: { broadcaster_id: streamerId, first: 1 } });
        if (r.status === 0) return json({ ok: true, available: false, needsSetup: true, poll: null });
        if (r.status === 401 || r.status === 403) return json({ ok: true, available: false, scopeMissing: true, poll: null });
        if (!r.ok) return json({ ok: false, error: 'helix-' + (r.status || 0), poll: null });
        const p = (r.data && r.data.data && r.data.data[0]) || null;
        return json({ ok: true, available: true, poll: p && p.status === 'ACTIVE' ? shapePoll(p) : null });
      }
      case 'polls/create': {
        const title = String(body.title || '').trim().slice(0, 60);
        const choices = (Array.isArray(body.choices) ? body.choices : [])
          .map((c) => String(c || '').trim().slice(0, 25)).filter(Boolean).slice(0, 5);
        const duration = Math.max(15, Math.min(1800, Number(body.duration) || 120));
        if (!title || choices.length < 2) return json({ ok: false, error: 'bad-poll' }, 400);
        const { checkObsRate } = await import('./warden-actions.js');
        if (!(await checkObsRate(env, actorId)).ok) return json({ ok: false, error: 'rate-limited' }, 429);
        const { vaultHelix } = await import('./warden-twitch.js');
        const r = await vaultHelix(env, streamerId, '/polls', { method: 'POST', body: { broadcaster_id: streamerId, title, choices: choices.map((t) => ({ title: t })), duration } });
        if (r.status === 401 || r.status === 403) return json({ ok: false, error: 'scope-missing', needsReconnect: true }, 403);
        if (!r.ok) return json({ ok: false, error: (r.data && r.data.message) || ('helix-' + (r.status || 0)) }, 400);
        await auditSafe(env, { streamerId, actorId, actorLogin, action: 'poll-start', platform: 'twitch', detail: { title } });
        return json({ ok: true, poll: shapePoll((r.data && r.data.data && r.data.data[0]) || {}) });
      }
      case 'polls/end': {
        const id = String(body.pollId || '');
        const status = body.status === 'ARCHIVED' ? 'ARCHIVED' : 'TERMINATED';
        if (!id) return json({ ok: false, error: 'bad-id' }, 400);
        const { vaultHelix } = await import('./warden-twitch.js');
        const r = await vaultHelix(env, streamerId, '/polls', { method: 'PATCH', body: { broadcaster_id: streamerId, id, status } });
        if (r.status === 401 || r.status === 403) return json({ ok: false, error: 'scope-missing', needsReconnect: true }, 403);
        if (!r.ok) return json({ ok: false, error: 'helix-' + (r.status || 0) }, 400);
        await auditSafe(env, { streamerId, actorId, actorLogin, action: 'poll-end', platform: 'twitch' });
        return json({ ok: true });
      }
      case 'predictions/get': {
        const { vaultHelix } = await import('./warden-twitch.js');
        const r = await vaultHelix(env, streamerId, '/predictions', { params: { broadcaster_id: streamerId, first: 1 } });
        if (r.status === 0) return json({ ok: true, available: false, needsSetup: true, prediction: null });
        if (r.status === 401 || r.status === 403) return json({ ok: true, available: false, scopeMissing: true, prediction: null });
        if (!r.ok) return json({ ok: false, error: 'helix-' + (r.status || 0), prediction: null });
        const p = (r.data && r.data.data && r.data.data[0]) || null;
        return json({ ok: true, available: true, prediction: p && (p.status === 'ACTIVE' || p.status === 'LOCKED') ? shapePrediction(p) : null });
      }
      case 'predictions/create': {
        const title = String(body.title || '').trim().slice(0, 45);
        const outcomes = (Array.isArray(body.outcomes) ? body.outcomes : [])
          .map((c) => String(c || '').trim().slice(0, 25)).filter(Boolean).slice(0, 10);
        const window = Math.max(30, Math.min(1800, Number(body.window) || 120));
        if (!title || outcomes.length < 2) return json({ ok: false, error: 'bad-prediction' }, 400);
        const { checkObsRate } = await import('./warden-actions.js');
        if (!(await checkObsRate(env, actorId)).ok) return json({ ok: false, error: 'rate-limited' }, 429);
        const { vaultHelix } = await import('./warden-twitch.js');
        const r = await vaultHelix(env, streamerId, '/predictions', { method: 'POST', body: { broadcaster_id: streamerId, title, outcomes: outcomes.map((t) => ({ title: t })), prediction_window: window } });
        if (r.status === 401 || r.status === 403) return json({ ok: false, error: 'scope-missing', needsReconnect: true }, 403);
        if (!r.ok) return json({ ok: false, error: (r.data && r.data.message) || ('helix-' + (r.status || 0)) }, 400);
        await auditSafe(env, { streamerId, actorId, actorLogin, action: 'prediction-start', platform: 'twitch', detail: { title } });
        return json({ ok: true, prediction: shapePrediction((r.data && r.data.data && r.data.data[0]) || {}) });
      }
      case 'predictions/resolve': {
        const id = String(body.predictionId || '');
        if (!id) return json({ ok: false, error: 'bad-id' }, 400);
        // status: LOCKED (close betting), RESOLVED (+winningOutcomeId), CANCELED (refund).
        const status = ['LOCKED', 'RESOLVED', 'CANCELED'].indexOf(String(body.status)) !== -1 ? String(body.status) : null;
        if (!status) return json({ ok: false, error: 'bad-status' }, 400);
        const patch = { broadcaster_id: streamerId, id, status };
        if (status === 'RESOLVED') {
          if (!body.winningOutcomeId) return json({ ok: false, error: 'need-outcome' }, 400);
          patch.winning_outcome_id = String(body.winningOutcomeId);
        }
        const { checkObsRate } = await import('./warden-actions.js');
        if (!(await checkObsRate(env, actorId)).ok) return json({ ok: false, error: 'rate-limited' }, 429);
        const { vaultHelix } = await import('./warden-twitch.js');
        const r = await vaultHelix(env, streamerId, '/predictions', { method: 'PATCH', body: patch });
        if (r.status === 401 || r.status === 403) return json({ ok: false, error: 'scope-missing', needsReconnect: true }, 403);
        if (!r.ok) return json({ ok: false, error: 'helix-' + (r.status || 0) }, 400);
        await auditSafe(env, { streamerId, actorId, actorLogin, action: 'prediction-' + status.toLowerCase(), platform: 'twitch' });
        return json({ ok: true, prediction: shapePrediction((r.data && r.data.data && r.data.data[0]) || {}) });
      }

      // ── room ticket (BE-1) ──────────────────────────────────────────
      case 'room/ticket': {
        const ticket = await mintRoomTicket(env, streamerId, actorId, actorLogin, body._role || 'mod');
        if (!ticket) return json({ ok: false, error: 'not-configured' }, 503);
        return json({ ok: true, ticket, wsUrl: wsUrlFor(env, ticket) });
      }

      // ── actions / modes (BE-3) ──────────────────────────────────────
      case 'action': {
        const { performAction } = await import('./warden-actions.js');
        const res = await performAction(env, {
          streamerId, actorId, actorLogin,
          platform: body.platform, kind: body.kind,
          targetLogin: body.targetLogin, targetId: body.targetId,
          seconds: body.seconds, reason: body.reason, messageId: body.messageId,
          syncAll: !!body.syncAll,
        });
        return json(res);
      }
      case 'modes/set': {
        const { setModes } = await import('./warden-actions.js');
        return json(await setModes(env, {
          streamerId, actorId, actorLogin,
          platform: body.platform, mode: body.mode, value: body.value,
          settings: body.settings,
        }));
      }
      case 'modes/get': {
        const { getModes } = await import('./warden-actions.js');
        return json(await getModes(env, { streamerId, actorId, actorLogin, platform: body.platform }));
      }

      // ── chat recent (BE-2 room/ring; fall back gracefully) ──────────
      case 'chat/recent': {
        try {
          const mod = await import('./warden-room-do.js');
          if (typeof mod.recentMessages === 'function') {
            return json({ ok: true, messages: await mod.recentMessages(env, streamerId, Number(body.limit) || 100) });
          }
        } catch { /* room helper not present yet — empty is a valid cold-start */ }
        return json({ ok: true, messages: [] });
      }

      // ── audit (BE-3) ────────────────────────────────────────────────
      case 'audit/list': {
        const { listAudit } = await import('./warden-audit.js');
        const rows = await listAudit(env, streamerId, { limit: Number(body.limit) || 50, before: body.before });
        return json({ ok: true, audit: rows || [] });
      }

      // ── terms (BE-3) ────────────────────────────────────────────────
      case 'terms/list': {
        const { listTerms } = await import('./warden-terms.js');
        return json({ ok: true, terms: await listTerms(env, streamerId) || [] });
      }
      case 'terms/add': {
        const { addTerm } = await import('./warden-terms.js');
        return json(await addTerm(env, streamerId, { term: body.term, mode: body.mode, action: body.action, seconds: body.seconds, addedBy: actorId }));
      }
      case 'terms/remove': {
        const { removeTerm } = await import('./warden-terms.js');
        return json(await removeTerm(env, streamerId, String(body.term || '')));
      }

      // ── notes / watchlist (BE-3) ────────────────────────────────────
      case 'notes/get': {
        const { getNote } = await import('./warden-notes.js');
        return json({ ok: true, note: await getNote(env, streamerId, String(body.subjectKey || '')) });
      }
      case 'notes/set': {
        const { setNote } = await import('./warden-notes.js');
        return json(await setNote(env, streamerId, String(body.subjectKey || ''), { note: body.note, authorId: actorId, authorLogin: actorLogin }));
      }
      case 'watchlist/list': {
        const { listWatch } = await import('./warden-notes.js');
        return json({ ok: true, watchlist: await listWatch(env, streamerId) || [] });
      }
      case 'watchlist/add': {
        const { addWatch } = await import('./warden-notes.js');
        return json(await addWatch(env, streamerId, { subjectKey: body.subjectKey, reason: body.reason, flaggedBy: actorId }));
      }
      case 'watchlist/remove': {
        const { removeWatch } = await import('./warden-notes.js');
        return json(await removeWatch(env, streamerId, String(body.subjectKey || '')));
      }

      default:
        return json({ ok: false, error: 'not-found' }, 404);
    }
  } catch (e) {
    console.warn('[warden] route', sub, e?.message || e);
    return json({ ok: false, error: 'internal', message: String(e && e.message || e).slice(0, 200) }, 500);
  }
}
