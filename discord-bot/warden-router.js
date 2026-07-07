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

// Routes that only the BROADCASTER of streamerId may call.
const BROADCASTER_ONLY = new Set([
  'mods/add', 'mods/remove', 'terms/add', 'terms/remove',
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
      const { whoami } = await import('./warden-mods.js');
      const res = await whoami(env, actorId, actorLogin);
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
        const { listMods } = await import('./warden-mods.js');
        return json(await listMods(env, streamerId));
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
