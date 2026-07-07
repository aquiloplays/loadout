// ── Warden: local-bridge chat ingest ─────────────────────────────────────
// Platforms with no cloud API surface (today: TikTok, which only exists as
// TikFinity's local WebSocket on the streamer's machine) reach Warden's
// unified feed through StreamFusion: SF taps its normalized TikTok chat and
// relays frames here. View-only by design — there is no TikTok mod API
// anywhere, so the console renders these rows without action buttons.
//
//   POST /api/warden-ingest
//   headers: x-aquilo-print-key = KV printflair:postkey (the streamer-
//            machine shared key SF already holds for the receipt gallery)
//   body: { streamerId, platform:'tiktok', user, text, id?, avatar? }
//
// Gated on KV warden:on:<streamerId> like the EventSub ingest, so relays
// from non-Warden streamers are dropped cheaply.

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }
  });
}

export async function handleWardenIngest(req, env) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type, x-aquilo-print-key'
    } });
  }
  if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405);

  const key = await env.LOADOUT_BOLTS.get('printflair:postkey').catch(() => null);
  if (!key || req.headers.get('x-aquilo-print-key') !== key) return json({ ok: false, error: 'bad-key' }, 403);

  let body = {};
  try { body = await req.json(); } catch (e) {}
  const streamerId = String(body.streamerId || '').trim();
  const platform = String(body.platform || '').toLowerCase();
  const user = String(body.user || '').trim().slice(0, 60);
  const text = String(body.text || '').slice(0, 500);
  if (!/^\d{1,20}$/.test(streamerId)) return json({ ok: false, error: 'bad-streamer' }, 400);
  if (platform !== 'tiktok') return json({ ok: false, error: 'bad-platform' }, 400);
  if (!user || !text) return json({ ok: false, error: 'empty' }, 400);

  const on = await env.LOADOUT_BOLTS.get('warden:on:' + streamerId).catch(() => null);
  if (!on) return json({ ok: false, error: 'warden-off' }, 200);

  const frame = {
    t: 'chat',
    platform: 'tiktok',
    id: String(body.id || ('tt-' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36))),
    login: user.toLowerCase(),
    display: user,
    color: '',
    text,
    badges: [],
    ts: Date.now(),
  };
  try {
    const { broadcastToWardenRoom } = await import('./aquilo/warden-room-do.js');
    await broadcastToWardenRoom(env, streamerId, frame);
  } catch (e) {
    return json({ ok: false, error: 'room-unreachable' }, 502);
  }
  return json({ ok: true });
}
