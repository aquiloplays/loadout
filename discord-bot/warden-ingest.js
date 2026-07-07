// ── Warden: local-bridge chat ingest ─────────────────────────────────────
// StreamFusion already normalizes chat from every platform on the
// streamer's machine. For the non-Twitch platforms it relays those frames
// here so Warden's unified feed shows Kick / YouTube / TikTok chat
// alongside native Twitch. Kick rows are actionable (Warden has a live Kick
// mod API); YouTube/TikTok rows are view-only (no usable mod API for the
// feed). Twitch never comes through here — it has authoritative native
// EventSub ingest with full mod actions.
//
//   POST /api/warden-ingest
//   headers: x-aquilo-print-key = KV printflair:postkey (the streamer-
//            machine shared key SF already holds for the receipt gallery)
//   body: { streamerId, platform:'kick'|'youtube'|'tiktok', user, text,
//           id?, color? }
//
// Gated on KV warden:on:<streamerId> like the EventSub ingest, so relays
// from non-Warden streamers are dropped cheaply.

const RELAY_PLATFORMS = new Set(['kick', 'youtube', 'tiktok']);

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }
  });
}

async function keyOk(req, env) {
  const key = await env.LOADOUT_BOLTS.get('printflair:postkey').catch(() => null);
  return key && req.headers.get('x-aquilo-print-key') === key;
}

// The SF machine agent joins the WardenRoom to receive obs-cmd frames and
// relay chat. It authenticates with the shared machine key (not a mod
// session), so it gets its own key-authed ticket mint.
//   POST /api/warden-agent-ticket { streamerId }
export async function handleWardenAgentTicket(req, env) {
  if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405);
  if (!(await keyOk(req, env))) return json({ ok: false, error: 'bad-key' }, 403);
  let body = {};
  try { body = await req.json(); } catch (e) {}
  const streamerId = String(body.streamerId || '').trim();
  if (!/^\d{1,20}$/.test(streamerId)) return json({ ok: false, error: 'bad-streamer' }, 400);
  const { mintRoomTicket } = await import('./warden-db.js');
  const ticket = await mintRoomTicket(env, streamerId, streamerId, 'sf-agent', 'agent');
  if (!ticket) return json({ ok: false, error: 'not-configured' }, 503);
  const origin = (env.PUBLIC_WORKER_URL || 'https://loadout-discord.aquiloplays.workers.dev')
    .replace(/\/$/, '').replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
  return json({ ok: true, wsUrl: origin + '/web/warden/room/ws?ticket=' + encodeURIComponent(ticket) });
}

// StreamFusion pushes the broadcaster's OBS capability allowlist here so
// the router can validate mod commands against it.
//   POST /api/warden-obscaps { streamerId, caps }
export async function handleWardenObsCaps(req, env) {
  if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405);
  if (!(await keyOk(req, env))) return json({ ok: false, error: 'bad-key' }, 403);
  let body = {};
  try { body = await req.json(); } catch (e) {}
  const streamerId = String(body.streamerId || '').trim();
  if (!/^\d{1,20}$/.test(streamerId)) return json({ ok: false, error: 'bad-streamer' }, 400);
  const c = body.caps && typeof body.caps === 'object' ? body.caps : {};
  const clean = {
    enabled: !!c.enabled,
    brbPanic: !!c.brbPanic,
    scenes: Array.isArray(c.scenes) ? c.scenes.slice(0, 20).map((s) => String(s).slice(0, 60)) : [],
    sources: Array.isArray(c.sources) ? c.sources.slice(0, 20).map((s) => String(s).slice(0, 60)) : [],
    mics: Array.isArray(c.mics) ? c.mics.slice(0, 10).map((s) => String(s).slice(0, 60)) : [],
    brbScene: String(c.brbScene || '').slice(0, 60),
    updatedAt: Date.now(),
  };
  await env.LOADOUT_BOLTS.put('warden:obscaps:' + streamerId, JSON.stringify(clean));
  return json({ ok: true });
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

  if (!(await keyOk(req, env))) return json({ ok: false, error: 'bad-key' }, 403);

  let body = {};
  try { body = await req.json(); } catch (e) {}
  const streamerId = String(body.streamerId || '').trim();
  const platform = String(body.platform || '').toLowerCase();
  const user = String(body.user || '').trim().slice(0, 60);
  const text = String(body.text || '').slice(0, 500);
  if (!/^\d{1,20}$/.test(streamerId)) return json({ ok: false, error: 'bad-streamer' }, 400);
  if (!RELAY_PLATFORMS.has(platform)) return json({ ok: false, error: 'bad-platform' }, 400);
  if (!user || !text) return json({ ok: false, error: 'empty' }, 400);

  const on = await env.LOADOUT_BOLTS.get('warden:on:' + streamerId).catch(() => null);
  if (!on) return json({ ok: false, error: 'warden-off' }, 200);

  const frame = {
    t: 'chat',
    platform,
    id: String(body.id || (platform.slice(0, 2) + '-' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36))),
    login: user.toLowerCase(),
    display: user,
    color: String(body.color || ''),
    text,
    badges: [],
    // Relayed rows: Kick is actionable via Warden's Kick API; YouTube and
    // TikTok are view-only (no usable mod API for feed-driven actions).
    relayed: true,
    viewOnly: platform !== 'kick',
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
