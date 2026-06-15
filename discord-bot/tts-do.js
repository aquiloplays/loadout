// Durable Object: per-broadcaster TTS event fan-out. One DO instance
// per broadcaster (idFromName(broadcasterId)), so each streamer's OBS
// browser source subscribes to a stream that only contains their own
// queued lines. Modeled on activity-do.js, see that file for why we
// chose SSE over WebSocket.
//
// Wire-up (worker.js):
//   GET  /api/tts/events/:broadcaster   → DO /sse
//   internal publishTts(env, bc, evt)   → DO /publish (best-effort)

const ENCODER = new TextEncoder();
const HEARTBEAT_MS = 20_000;

export class TtsBroadcaster {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.clients = new Set();
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
      writer.write(ENCODER.encode(`: connected\n\n`)).catch(() => this.drop(client));
      writer.write(ENCODER.encode(
        `event: hello\ndata: ${JSON.stringify({ ok: true, ts: Date.now() })}\n\n`
      )).catch(() => this.drop(client));
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
      const n = this.broadcast(body);
      return new Response(JSON.stringify({ ok: true, clients: n }), {
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

  broadcast(jsonData) {
    const frame = ENCODER.encode(`event: tts\ndata: ${jsonData}\n\n`);
    let n = 0;
    for (const c of [...this.clients]) {
      try { c.writer.write(frame).catch(() => this.drop(c)); n++; }
      catch { this.drop(c); }
    }
    return n;
  }
}

// Producer helper called by the TTS generate / preview handler.
// Fire-and-forget; no-ops when TTS_DO binding is absent (local/test).
export async function publishTts(env, broadcasterId, event) {
  if (!env || !env.TTS_DO || !broadcasterId || !event) return { ok: false, skipped: true };
  const payload = { ts: Date.now(), ...event };
  try {
    const id = env.TTS_DO.idFromName(String(broadcasterId));
    const stub = env.TTS_DO.get(id);
    await stub.fetch('https://do/publish', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return { ok: true };
  } catch (e) {
    console.warn('[tts-do] publish', e?.message || e);
    return { ok: false, error: String(e?.message || e).slice(0, 80) };
  }
}
