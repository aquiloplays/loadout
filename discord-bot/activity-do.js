// Durable Object: community-activity SSE fan-out.
//
// 2026-05-31 sprint. A single global instance holds every connected
// Server-Sent-Events client (the site's community feed, an OBS ticker
// overlay, etc.) and broadcasts real-time events to all of them: bolt
// drops, anniversaries, squad joins, drop claims, pass-tier unlocks.
//
// Why SSE (not WebSocket like OverlayBroadcaster): the activity feed is
// strictly one-way server→client, so SSE is simpler on the client
// (EventSource auto-reconnects) and needs no upgrade handshake. The
// trade-off is no hibernation — the DO stays warm while a stream is
// connected (billed wall-time), which is fine for the during-stream
// usage window.
//
// Wire-up (see worker.js):
//   GET  /activity/sse      → DO /sse      (CORS-open EventSource stream)
//   POST /activity/publish  → DO /publish  (internal; via publishActivity)
//   producers call publishActivity(env, { kind, ... }).

const ENCODER = new TextEncoder();
const HEARTBEAT_MS = 20_000;   // ":ping" comment to keep proxies from idling the stream

export class ActivityBroadcaster {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.clients = new Set();   // { writer }
    this.heartbeat = null;
  }

  startHeartbeat() {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      const ping = ENCODER.encode(`: ping ${Date.now()}\n\n`);
      for (const c of this.clients) {
        c.writer.write(ping).catch(() => this.drop(c));
      }
      if (this.clients.size === 0) this.stopHeartbeat();
    }, HEARTBEAT_MS);
  }

  stopHeartbeat() {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
  }

  drop(c) {
    if (this.clients.delete(c)) {
      try { c.writer.close(); } catch { /* already closed */ }
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/sse') {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const client = { writer };
      this.clients.add(client);
      this.startHeartbeat();
      // Opening comment + a hello event so the client knows it's live.
      writer.write(ENCODER.encode(`: connected\n\n`)).catch(() => this.drop(client));
      writer.write(ENCODER.encode(
        `event: hello\ndata: ${JSON.stringify({ ok: true, ts: Date.now() })}\n\n`
      )).catch(() => this.drop(client));
      // Prune when the client disconnects.
      request.signal?.addEventListener('abort', () => this.drop(client));
      return new Response(readable, {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          'connection': 'keep-alive',
          'access-control-allow-origin': '*',
        },
      });
    }

    if (url.pathname === '/publish' && request.method === 'POST') {
      const body = await request.text();
      const sent = this.broadcast(body);
      return new Response(JSON.stringify({ ok: true, clients: sent }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.pathname === '/count') {
      return new Response(JSON.stringify({ ok: true, clients: this.clients.size }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response('not found', { status: 404 });
  }

  // `body` is the already-serialized SSE frame's data (a JSON string).
  // We wrap it as an `event: activity` message so clients can listen by
  // type while still receiving the raw payload.
  broadcast(jsonData) {
    const frame = ENCODER.encode(`event: activity\ndata: ${jsonData}\n\n`);
    let n = 0;
    for (const c of [...this.clients]) {
      try { c.writer.write(frame).catch(() => this.drop(c)); n++; }
      catch { this.drop(c); }
    }
    return n;
  }
}

// ── Producer helper ───────────────────────────────────────────────
//
// Fire-and-forget broadcast of a community-activity event. Best-effort:
// no-ops when the ACTIVITY_DO binding is absent (e.g. local/test). Stamps
// `ts` if the caller didn't. Never throws into the caller.
export async function publishActivity(env, event) {
  if (!env || !env.ACTIVITY_DO || !event || !event.kind) return { ok: false, skipped: true };
  const payload = { ts: Date.now(), ...event };
  try {
    const id = env.ACTIVITY_DO.idFromName('global');
    const stub = env.ACTIVITY_DO.get(id);
    await stub.fetch('https://do/publish', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return { ok: true };
  } catch (e) {
    console.warn('[activity-do] publish', e?.message || e);
    return { ok: false, error: String(e?.message || e).slice(0, 80) };
  }
}
