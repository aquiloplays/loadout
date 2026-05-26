// TikFinity → worker bridge.
//
// TikFinity (zerody.one/tiktok) is Clay's TikTok-Live event source. Its
// "Trigger WebHook" action posts a customisable JSON body to an HTTP
// endpoint whenever a viewer gifts, follows, likes, subs, etc. We
// expose POST /tikfinity/event here and route gift events into the
// same recordGifterEvent pipeline the Streamer.bot path uses, so the
// rolling-30-day Top TikTok Gifter role updates from a single source
// of truth.
//
// Auth: TikFinity can attach custom headers but can't sign HMAC, so we
// use a bearer-style shared secret in X-TikFinity-Secret instead. The
// secret is set via `wrangler secret put TIKFINITY_WEBHOOK_SECRET`;
// Clay pastes the same value into TikFinity's HTTP-action headers
// dialog.
//
// Body schema — TikFinity action payloads are user-templated, but
// we accept the conventional TikTok-Live field names. Minimum:
//
//   {
//     "event":        "gift",       // also accepted: type
//     "uniqueId":     "viewerHandle", // TikTok @, primary leaderboard key
//     "nickname":     "Display Name", // optional, audit-only
//     "diamondCount": 1,            // per-gift diamond value
//     "repeatCount":  10,           // combo size; total = diamond * repeat
//     "timestamp":    1717340000000 // optional ms-epoch
//   }
//
// Non-gift events (follow / like / share / sub) ack 200 with
// `skipped: 'unhandled-event'` — TikFinity doesn't have a way to
// filter on its side without a custom action per event type, so we
// take everything and discard what we don't aggregate.

import { recordGifterEvent } from './gifter-roles.js';

const SECRET_HEADER = 'x-tikfinity-secret';

export async function handleTikFinityEvent(req, env) {
  if (!env.TIKFINITY_WEBHOOK_SECRET) {
    return jsonResp({ ok: false, error: 'webhook-secret-not-configured' }, 503);
  }
  const got = req.headers.get(SECRET_HEADER) || '';
  if (!got || got !== env.TIKFINITY_WEBHOOK_SECRET) {
    return jsonResp({ ok: false, error: 'bad-secret' }, 401);
  }

  let payload;
  try { payload = await req.json(); }
  catch { return jsonResp({ ok: false, error: 'bad-json' }, 400); }
  if (!payload || typeof payload !== 'object') {
    return jsonResp({ ok: false, error: 'bad-payload' }, 400);
  }

  const event = String(payload.event || payload.type || 'gift').toLowerCase();
  if (event !== 'gift') {
    return jsonResp({ ok: true, skipped: 'unhandled-event', event }, 200);
  }

  const uniqueId = String(
    payload.uniqueId || payload.username || payload.user || payload.nickname || ''
  ).trim().toLowerCase();
  if (!uniqueId) {
    return jsonResp({ ok: false, error: 'no-uniqueId' }, 400);
  }
  // Diamond value × combo size = total diamonds attributed to this
  // event. Both fields can be strings in TikFinity's variable
  // substitution — `Number()` handles either.
  const diamondCount = Number(payload.diamondCount ?? payload.diamonds ?? 0);
  const repeatCount  = Number(payload.repeatCount  ?? payload.giftCount ?? 1);
  const amount = Math.trunc(diamondCount * (repeatCount > 0 ? repeatCount : 1));
  if (!Number.isFinite(amount) || amount <= 0) {
    return jsonResp({ ok: false, error: 'bad-amount', diamondCount, repeatCount }, 400);
  }

  const guildId = String(env.AQUILO_VAULT_GUILD_ID || '').trim();
  if (!guildId) return jsonResp({ ok: false, error: 'no-guild-id' }, 503);

  const tsMs = Number(payload.timestamp || payload.ts || Date.now());
  const r = await recordGifterEvent(env, guildId, 'tip', 'tiktok', uniqueId, amount, tsMs);
  const status = r.ok ? 200 : (r.error === 'no-guild-id' ? 503 : 400);
  return jsonResp({ source: 'tikfinity', ...r }, status);
}

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
