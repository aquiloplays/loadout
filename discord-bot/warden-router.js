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
        const allow =
          (action === 'brbPanic' && caps.brbPanic) ||
          (action === 'sceneSwitch' && Array.isArray(caps.scenes) && caps.scenes.indexOf(arg) !== -1) ||
          (action === 'sourceToggle' && Array.isArray(caps.sources) && caps.sources.indexOf(arg) !== -1) ||
          (action === 'muteMic' && Array.isArray(caps.mics) && caps.mics.indexOf(arg) !== -1);
        if (!allow) return json({ ok: false, error: 'action-not-allowed' }, 403);
        const { checkObsRate } = await import('./warden-actions.js');
        const rl = await checkObsRate(env, actorId);
        if (!rl.ok) return json({ ok: false, error: 'rate-limited' }, 429);
        const cmdId = 'obs-' + Date.now().toString(36) + Math.floor(Math.random() * 1e5).toString(36);
        try {
          const { broadcastToWardenRoom } = await import('./aquilo/warden-room-do.js');
          await broadcastToWardenRoom(env, streamerId, JSON.stringify({
            t: 'obs-cmd', cmdId, action, arg,
            by: actorLogin || actorId, ts: Date.now(),
          }));
        } catch { return json({ ok: false, error: 'room-unreachable' }, 502); }
        try {
          const { addAudit } = await import('./warden-audit.js');
          await addAudit(env, {
            streamerId, actorId, actorLogin,
            action: 'obs-' + action, platform: 'obs',
            targetLogin: arg || null, detail: { cmdId },
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
