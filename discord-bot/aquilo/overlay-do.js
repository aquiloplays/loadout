// Durable Object: WebSocket broadcaster for the stream overlay.
//
// Why a DO: Cloudflare Workers are stateless, they can't hold a
// persistent socket across requests. A DO gives us a single in-memory
// instance with a connection list. When a CN poll closes and the
// schedule's cn_winners updates, schedule.js broadcasts the new
// "today's game" payload here, and the DO fans it out to every
// connected overlay client.
//
// Cost note: DOs require the Workers Paid plan ($5/mo). For a single
// streamer with 1-2 OBS browser sources connected during streams, the
// usage is well within the included quota.
//
// Wire-up:
//   - wrangler.toml declares the binding `OVERLAY_DO` and a migration
//     creating the `OverlayBroadcaster` class.
//   - worker.js routes  GET /overlay/ws  → DO (WebSocket upgrade)
//   - worker.js routes  POST /overlay/broadcast (auth-gated) → DO
//   - schedule.js calls broadcastOverlayUpdate(env, payload) after
//     updating cn_winners.
//
// Client side (the overlay JS):
//   const ws = new WebSocket('wss://aquilo-bot.aquiloplays.workers.dev/overlay/ws');
//   ws.addEventListener('message', e => applyTheme(JSON.parse(e.data).slug));
//   ws.addEventListener('close',   () => setTimeout(reconnect, 2000));
//   // initial theme via existing GET /today-game

export class OverlayBroadcaster {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Set();
    // Restore any sockets that survived hibernation.
    for (const ws of this.state.getWebSockets()) {
      this.sessions.add(ws);
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      // Discord/browsers upgrade via the special 101 status + webSocket pair.
      const upgrade = request.headers.get('Upgrade');
      if (upgrade !== 'websocket') return new Response('expected websocket', { status: 426 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      // Accept via hibernation API so the DO can sleep between events
      // and not pay for idle wall-time.
      this.state.acceptWebSocket(server);
      this.sessions.add(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/broadcast' && request.method === 'POST') {
      const body = await request.text();
      this.broadcast(body);
      return new Response(JSON.stringify({ ok: true, sessions: this.sessions.size }), {
        headers: { 'content-type': 'application/json' }
      });
    }

    return new Response('not found', { status: 404 });
  }

  // Hibernation handlers, DO wakes up when these fire.
  webSocketMessage(ws, _message) { /* no-op: clients only listen */ }
  webSocketClose(ws)              { this.sessions.delete(ws); }
  webSocketError(ws, _err)        { this.sessions.delete(ws); }

  broadcast(data) {
    for (const ws of this.sessions) {
      try { ws.send(data); }
      catch { this.sessions.delete(ws); }
    }
  }
}

// Helper used by schedule.js (and anyone else who wants to push). Skips
// silently if the OVERLAY_DO binding isn't configured (free tier fallback).
export async function broadcastOverlayUpdate(env, payload) {
  if (!env.OVERLAY_DO) return;
  const id = env.OVERLAY_DO.idFromName('global');
  const stub = env.OVERLAY_DO.get(id);
  try {
    await stub.fetch('https://do/broadcast', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  } catch (e) { console.warn('[overlay-do] broadcast', e?.message || e); }
}
