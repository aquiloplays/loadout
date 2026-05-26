// Twitch EventSub webhook handler.
//
// POST /twitch/eventsub — Twitch posts here for three message types
// (header `Twitch-Eventsub-Message-Type`):
//
//   webhook_callback_verification
//     The challenge handshake when a subscription is first created.
//     Respond 200 with the `challenge` field as plain text.
//
//   notification
//     A real event (stream.online / stream.offline). Dispatch by
//     `subscription.type` to the right handler in twitch-live.js,
//     return 200 immediately (notification handlers do their work
//     fire-and-forget via ctx.waitUntil).
//
//   revocation
//     Twitch told us the subscription is gone (auth revoked, user
//     deleted, etc.). Log + ack 200.
//
// Signature verification is REQUIRED for every request — Twitch
// signs as
//   HMAC-SHA256(secret, messageId + messageTimestamp + rawBody)
// hex-encoded, sent in the `Twitch-Eventsub-Message-Signature`
// header prefixed with "sha256=". An attacker who forges a notify
// without the secret can't reach our handlers. Bail with 403 on a
// bad sig — Twitch will retry, and we don't want to act on it.
//
// Also a 10-min message-id replay window: re-deliveries are
// idempotently swallowed (returns 200 without re-processing the
// event). Twitch DOES retry, sometimes multiple times for the same
// event id; without dedupe a stream.online retry would re-post the
// embed.

import { postLiveEmbed, markStreamOffline } from './twitch-live.js';
import {
  isTwitchConfigured,
  createSubscription,
  listSubscriptions,
} from './twitch-helix.js';

const REPLAY_KEY = (id) => `twitch:eventsub:seen:${id}`;
const REPLAY_TTL_S = 10 * 60;

// ── Signature verification ───────────────────────────────────────

// Constant-time comparison so a timing attack can't probe the secret
// one byte at a time. Both inputs are hex strings of the SAME length
// — caller has already enforced length equality.
function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyEventSubSignature(secret, messageId, timestamp, body, headerSig) {
  if (!secret || !messageId || !timestamp || !headerSig) return false;
  if (!headerSig.startsWith('sha256=')) return false;
  const provided = headerSig.slice('sha256='.length).toLowerCase();
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sigBytes = await crypto.subtle.sign('HMAC', key,
    new TextEncoder().encode(messageId + timestamp + body));
  const computed = Array.from(new Uint8Array(sigBytes))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  return timingSafeEqualHex(provided, computed);
}

// ── Webhook handler ──────────────────────────────────────────────

export async function handleEventSubWebhook(req, env, ctx) {
  if (!env.TWITCH_EVENTSUB_SECRET) {
    return new Response('twitch-eventsub-secret-not-configured', { status: 503 });
  }
  const messageId   = req.headers.get('twitch-eventsub-message-id');
  const messageType = req.headers.get('twitch-eventsub-message-type');
  const timestamp   = req.headers.get('twitch-eventsub-message-timestamp');
  const headerSig   = req.headers.get('twitch-eventsub-message-signature');
  // Read the body ONCE as raw text — signature verification + JSON
  // parsing both consume the same bytes.
  const body = await req.text();

  const ok = await verifyEventSubSignature(env.TWITCH_EVENTSUB_SECRET,
    messageId, timestamp, body, headerSig);
  if (!ok) return new Response('bad-signature', { status: 403 });

  // Replay-protect — once we've seen a message_id, swallow re-deliveries.
  if (messageId) {
    const seen = await env.LOADOUT_BOLTS.get(REPLAY_KEY(messageId));
    if (seen) return new Response(null, { status: 200 });
  }

  let payload;
  try { payload = JSON.parse(body); }
  catch { return new Response('bad-json', { status: 400 }); }

  // ── Verification handshake ────────────────────────────────────
  if (messageType === 'webhook_callback_verification') {
    if (messageId) {
      await env.LOADOUT_BOLTS.put(REPLAY_KEY(messageId), '1', { expirationTtl: REPLAY_TTL_S });
    }
    return new Response(String(payload.challenge || ''), {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
  }

  // ── Revocation notice ─────────────────────────────────────────
  if (messageType === 'revocation') {
    console.warn('[twitch-eventsub] subscription revoked', JSON.stringify(payload?.subscription || {}));
    return new Response(null, { status: 200 });
  }

  // ── Notification ──────────────────────────────────────────────
  if (messageType === 'notification') {
    if (messageId) {
      await env.LOADOUT_BOLTS.put(REPLAY_KEY(messageId), '1', { expirationTtl: REPLAY_TTL_S });
    }
    const subType = payload?.subscription?.type;
    const broadcasterId = payload?.event?.broadcaster_user_id
      || payload?.event?.broadcaster_id
      || payload?.subscription?.condition?.broadcaster_user_id;
    // ACK fast — the handler runs via waitUntil so a slow Discord
    // post can't push us past Twitch's 10-sec timeout.
    if (subType === 'stream.online' && broadcasterId) {
      ctx.waitUntil(postLiveEmbed(env, broadcasterId).catch(e =>
        console.warn('[twitch-eventsub] postLiveEmbed', e?.message || e)));
    } else if (subType === 'stream.offline' && broadcasterId) {
      ctx.waitUntil(markStreamOffline(env, broadcasterId).catch(e =>
        console.warn('[twitch-eventsub] markStreamOffline', e?.message || e)));
    }
    return new Response(null, { status: 204 });
  }

  return new Response('unhandled-message-type', { status: 400 });
}

// ── /admin/twitch-setup/<guildId> ────────────────────────────────
//
// Create (or refresh) the EventSub subscriptions for Clay's
// broadcaster id. Idempotent — checks existing subscriptions first
// and only creates ones that don't already exist + match our
// (callback, secret) pair. Caller hits this AFTER setting the three
// Twitch secrets so the webhook handshake has somewhere to verify
// against.
export async function setupTwitchSubscriptions(env, opts = {}) {
  if (!isTwitchConfigured(env)) return { ok: false, error: 'twitch-not-configured' };
  if (!env.TWITCH_EVENTSUB_SECRET) return { ok: false, error: 'eventsub-secret-not-set' };

  const broadcasterId = String(opts.broadcasterId || env.CLAY_TWITCH_CHANNEL_ID || '').trim();
  if (!broadcasterId) return { ok: false, error: 'no-broadcaster-id' };

  const callbackUrl = String(opts.callbackUrl
    || (env.PUBLIC_WORKER_URL || 'https://loadout-discord.aquiloplays.workers.dev') + '/twitch/eventsub'
    || '').trim();
  if (!/^https:\/\//.test(callbackUrl)) {
    return { ok: false, error: 'bad-callback-url', callbackUrl };
  }

  const existing = await listSubscriptions(env);
  const wantTypes = ['stream.online', 'stream.offline'];
  const out = { created: [], existing: [], failed: [] };
  for (const type of wantTypes) {
    const already = existing.find(s =>
      s.type === type
      && s.condition?.broadcaster_user_id === broadcasterId
      && s.transport?.callback === callbackUrl
      && (s.status === 'enabled' || s.status === 'webhook_callback_verification_pending'),
    );
    if (already) {
      out.existing.push({ type, id: already.id, status: already.status });
      continue;
    }
    const created = await createSubscription(env, type,
      { broadcaster_user_id: broadcasterId },
      callbackUrl,
      env.TWITCH_EVENTSUB_SECRET,
    );
    if (created && Array.isArray(created.data) && created.data[0]) {
      out.created.push({ type, id: created.data[0].id, status: created.data[0].status });
    } else {
      out.failed.push({ type, reason: 'create-returned-null' });
    }
  }
  return { ok: true, broadcasterId, callbackUrl, ...out };
}
