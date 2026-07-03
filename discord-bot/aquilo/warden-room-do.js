// Durable Object: per-streamer Warden moderation room.
//
// One DO instance per streamer (idFromName(streamerId)). Every mod
// browser watching that channel opens a hibernating WebSocket here and
// receives a merged live feed (chat + moderation audit + mode changes).
// Mods can also SEND inbound commands over the same socket to perform
// mod actions without a REST round-trip — the DO runs in the same
// isolate as the worker, so it imports the action layer directly.
//
// Modeled on aquilo/overlay-do.js (hibernation WebSocket fan-out) with:
//   - a ticket-gated /ws open (verifyRoomTicket, streamer-scoped, 60s)
//   - a per-socket serialized attachment carrying actor identity
//   - inbound {t:'action'|'ping'} commands (re-authorized server-side)
//   - an in-memory recent-ring so a reconnecting socket gets a snapshot
//
// Wire-up (worker.js, orchestrator owns):
//   GET  /web/warden/room/ws?ticket=... → DO /ws (WebSocket upgrade)
//   internal broadcastToWardenRoom(env, streamerId, frame) → DO /ingest
//
// Graceful-degrade: never throws to the caller. A missing/expired
// ticket closes the socket with a friendly code; the REST fallbacks
// (chat/recent, audit/list) cover a cold or evicted DO.

const RING_MAX = 200;

export class WardenRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Set();
    // Best-effort in-memory ring of recent frames. Lost on hibernation
    // eviction — the client falls back to chat/recent + audit/list on a
    // cold reconnect, so this is purely a nice-to-have snapshot.
    this.ring = [];
    // Re-adopt any sockets that survived hibernation.
    for (const ws of this.state.getWebSockets()) {
      this.sessions.add(ws);
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    // ── WS open (ticket-gated) ──────────────────────────────────
    if (url.pathname === '/ws') {
      const upgrade = request.headers.get('Upgrade');
      if (upgrade !== 'websocket') return new Response('expected websocket', { status: 426 });

      const ticket = url.searchParams.get('ticket') || '';
      let claim = null;
      try {
        const { verifyRoomTicket } = await import('../warden-db.js');
        claim = await verifyRoomTicket(this.env, ticket);
      } catch (e) {
        console.warn('[warden-room] ticket verify threw', e?.message || e);
        claim = null;
      }
      // The ticket must be valid AND scoped to THIS room's streamer.
      const streamerId = String(url.searchParams.get('streamerId') || claim?.streamerId || '');
      if (!claim || !claim.streamerId || (streamerId && String(claim.streamerId) !== streamerId)) {
        return new Response('bad-ticket', { status: 403 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      // Hibernation accept so the DO can sleep between events.
      this.state.acceptWebSocket(server, [String(claim.streamerId)]);
      // Stamp the verified actor identity onto the socket. Inbound
      // commands read this back — we NEVER trust an actor id the
      // browser sends in a command body.
      try {
        server.serializeAttachment({
          actorId: String(claim.actorId || ''),
          actorLogin: String(claim.actorLogin || ''),
          streamerId: String(claim.streamerId),
          role: String(claim.role || 'mod'),
        });
      } catch { /* attachment best-effort */ }
      this.sessions.add(server);

      // Send a snapshot of the recent ring so the newly-connected mod
      // sees context immediately.
      try {
        server.send(JSON.stringify({ t: 'snapshot', frames: this.ring.slice(-RING_MAX) }));
      } catch { /* socket already gone */ }

      return new Response(null, { status: 101, webSocket: client });
    }

    // ── Ingest (from EventSub + REST action broadcasts) ─────────
    if (url.pathname === '/ingest' && request.method === 'POST') {
      let frame = null;
      try { frame = await request.text(); } catch { frame = null; }
      if (frame) this.broadcast(frame);
      return new Response(JSON.stringify({ ok: true, sessions: this.sessions.size }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.pathname === '/count') {
      return new Response(JSON.stringify({ ok: true, sessions: this.sessions.size }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response('not found', { status: 404 });
  }

  // ── Hibernation handlers ──────────────────────────────────────

  async webSocketMessage(ws, message) {
    let cmd = null;
    try { cmd = JSON.parse(typeof message === 'string' ? message : ''); }
    catch { cmd = null; }
    if (!cmd || typeof cmd !== 'object') return;

    if (cmd.t === 'ping') {
      try { ws.send(JSON.stringify({ t: 'pong', ts: Date.now() })); } catch { /* gone */ }
      return;
    }

    if (cmd.t === 'action') {
      await this.handleAction(ws, cmd);
      return;
    }
    // Unknown command — ignore silently.
  }

  webSocketClose(ws) { this.sessions.delete(ws); }
  webSocketError(ws) { this.sessions.delete(ws); }

  // Perform a mod action requested over the socket. Identity comes from
  // the socket attachment (server-stamped at open), NOT from the command
  // body. Authorization is re-checked against warden_mods on every call.
  async handleAction(ws, cmd) {
    let actor = null;
    try { actor = ws.deserializeAttachment(); } catch { actor = null; }
    if (!actor || !actor.actorId || !actor.streamerId) {
      try { ws.send(JSON.stringify({ t: 'sys', message: 'unauthorized' })); } catch { /* gone */ }
      return;
    }

    try {
      // Re-validate the actor still moderates this streamer.
      const { isAuthorized } = await import('../warden-mods.js');
      const auth = await isAuthorized(this.env, actor.actorId, actor.streamerId);
      if (!auth || !auth.ok) {
        try { ws.send(JSON.stringify({ t: 'sys', message: 'unauthorized' })); } catch { /* gone */ }
        return;
      }

      const { performAction } = await import('../warden-actions.js');
      const result = await performAction(this.env, {
        streamerId: actor.streamerId,
        actorId: actor.actorId,
        actorLogin: actor.actorLogin,
        platform: cmd.platform || 'twitch',
        kind: cmd.kind,
        targetLogin: cmd.targetLogin,
        targetId: cmd.targetId,
        seconds: cmd.seconds,
        reason: cmd.reason,
        messageId: cmd.messageId,
        syncAll: cmd.syncAll === true,
      });

      // Ack directly to the requester so its UI can settle even when the
      // action produced no broadcastable audit frame. performAction is
      // responsible for the audit write + room broadcast on success.
      try {
        ws.send(JSON.stringify({ t: 'ack', ref: cmd.ref || null, result }));
      } catch { /* gone */ }
    } catch (e) {
      console.warn('[warden-room] action threw', e?.message || e);
      try {
        ws.send(JSON.stringify({ t: 'ack', ref: cmd.ref || null, result: { ok: false, error: 'action-failed' } }));
      } catch { /* gone */ }
    }
  }

  // Fan a frame out to every connected socket and append to the ring.
  broadcast(data) {
    // Keep a parsed copy in the ring; store the raw string for resend.
    try {
      const parsed = JSON.parse(data);
      this.ring.push(parsed);
      if (this.ring.length > RING_MAX) this.ring.splice(0, this.ring.length - RING_MAX);
    } catch { /* non-JSON frame — still fan out, just don't ring it */ }

    for (const ws of [...this.sessions]) {
      try { ws.send(data); }
      catch { this.sessions.delete(ws); }
    }
  }
}

// Producer helper — mirrors broadcastOverlayUpdate. Fire-and-forget;
// no-ops when the WARDEN_DO binding is absent (local/test). Never throws.
export async function broadcastToWardenRoom(env, streamerId, frame) {
  if (!env || !env.WARDEN_DO || !streamerId || !frame) return { ok: false, skipped: true };
  const body = typeof frame === 'string' ? frame : JSON.stringify(frame);
  try {
    const id = env.WARDEN_DO.idFromName(String(streamerId));
    const stub = env.WARDEN_DO.get(id);
    await stub.fetch('https://do/ingest', { method: 'POST', body });
    return { ok: true };
  } catch (e) {
    console.warn('[warden-room] broadcast', e?.message || e);
    return { ok: false, error: String(e?.message || e).slice(0, 80) };
  }
}
