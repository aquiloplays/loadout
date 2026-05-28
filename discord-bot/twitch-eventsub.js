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
  hasTwitchUserAuth,
  createSubscription,
  listSubscriptions,
  getStreamInfo,
  getUserById,
} from './twitch-helix.js';
import {
  EVENT_TYPE_HANDLERS,
  handleStreamEndedSummary,
} from './twitch-events.js';

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
    // ACK fast — handlers run via waitUntil so slow Discord posts
    // can't push us past Twitch's 10-sec timeout.
    if (subType === 'stream.online' && broadcasterId) {
      // Single work unit: postLiveEmbed — twitch-live.js's edit-in-place
      // lifecycle card on the existing `live` binding. Clay handles the
      // "going live" announce via this same lifecycle card; the bigger
      // separate announce embed was removed to avoid double-firing.
      ctx.waitUntil(postLiveEmbed(env, broadcasterId).catch(e =>
        console.warn('[twitch-eventsub] postLiveEmbed', e?.message || e)));
    } else if (subType === 'stream.offline' && broadcasterId) {
      // markStreamOffline edits the lifecycle card AND clears state;
      // we capture the state BEFORE that so the summary embed can
      // surface peak viewers + duration even after cleanup.
      ctx.waitUntil((async () => {
        let lifecycleState = null;
        try {
          lifecycleState = await env.LOADOUT_BOLTS.get(`twitch:live:state:${broadcasterId}`, { type: 'json' });
        } catch { /* ignore */ }
        await markStreamOffline(env, broadcasterId).catch(e =>
          console.warn('[twitch-eventsub] markStreamOffline', e?.message || e));
        await handleStreamEndedSummary(env, payload, { getStreamInfo, getUserById }, lifecycleState)
          .catch(e => console.warn('[twitch-eventsub] handleStreamEndedSummary', e?.message || e));
      })());
    } else if (subType && EVENT_TYPE_HANDLERS[subType]) {
      // All other typed events route through the twitch-events.js
      // dispatch table. Each handler is itself defensive — null guild,
      // missing channel, toggle-off — and returns a shape the caller
      // can ignore. We log the result so a "no-channel" skip surfaces.
      ctx.waitUntil((async () => {
        try {
          const r = await EVENT_TYPE_HANDLERS[subType](env, payload);
          if (r && r.skipped) {
            console.log('[twitch-eventsub]', subType, 'skipped:', r.skipped);
          } else if (r && r.error) {
            console.warn('[twitch-eventsub]', subType, 'post error:', r.error);
          }
        } catch (e) {
          console.warn('[twitch-eventsub]', subType, 'handler threw:', e?.message || e);
        }
      })());
    } else if (subType) {
      // Unknown sub type — still ack so Twitch doesn't retry forever.
      console.log('[twitch-eventsub] unhandled subType:', subType);
    }
    return new Response(null, { status: 204 });
  }

  return new Response('unhandled-message-type', { status: 400 });
}

// ── Subscription catalogue ───────────────────────────────────────
//
// Per-type config: which API version, which condition shape, which
// token kind (app vs user) is required. Order matters for the
// `created` array readout — kept roughly user-facing-priority.
//
// Token-kind notes:
//   - app:  works with the app access token (CLIENT_ID/SECRET only).
//           stream.online, stream.offline, channel.raid.
//   - user: requires a USER access token from the broadcaster (env
//           TWITCH_USER_REFRESH_TOKEN must be set). The scopes
//           listed inline are what was authorized when minting the
//           refresh token; mismatching scopes will return 401 on
//           subscription create.
//
// Condition shape notes:
//   - Most types: { broadcaster_user_id }.
//   - channel.follow v2: also needs { moderator_user_id } (we use
//     the broadcaster id — the broadcaster is implicitly a moderator
//     in their own channel).
//   - channel.raid (incoming): { to_broadcaster_user_id }.
function buildWantTypes(broadcasterId) {
  return [
    // — Stream lifecycle (app token, no scope).
    { type: 'stream.online',  version: '1', condition: { broadcaster_user_id: broadcasterId }, userToken: false },
    { type: 'stream.offline', version: '1', condition: { broadcaster_user_id: broadcasterId }, userToken: false },
    // — Channel.follow v2 (USER token, moderator:read:followers).
    { type: 'channel.follow', version: '2',
      condition: { broadcaster_user_id: broadcasterId, moderator_user_id: broadcasterId },
      userToken: true },
    // — Subs / resubs / gifts (USER token, channel:read:subscriptions).
    { type: 'channel.subscribe',            version: '1', condition: { broadcaster_user_id: broadcasterId }, userToken: true },
    { type: 'channel.subscription.message', version: '1', condition: { broadcaster_user_id: broadcasterId }, userToken: true },
    { type: 'channel.subscription.gift',    version: '1', condition: { broadcaster_user_id: broadcasterId }, userToken: true },
    // — Cheers (USER token, bits:read).
    { type: 'channel.cheer',                version: '1', condition: { broadcaster_user_id: broadcasterId }, userToken: true },
    // — Incoming raid (app token, no scope; the TO field is the
    //   broadcaster, since we want to detect raids INTO Clay).
    { type: 'channel.raid', version: '1',
      condition: { to_broadcaster_user_id: broadcasterId },
      userToken: false },
    // — Channel-point redemptions (USER token, channel:read:redemptions).
    { type: 'channel.channel_points_custom_reward_redemption.add', version: '1',
      condition: { broadcaster_user_id: broadcasterId }, userToken: true },
    // — Hype train (USER token, channel:read:hype_train).
    { type: 'channel.hype_train.begin',    version: '1', condition: { broadcaster_user_id: broadcasterId }, userToken: true },
    { type: 'channel.hype_train.progress', version: '1', condition: { broadcaster_user_id: broadcasterId }, userToken: true },
    { type: 'channel.hype_train.end',      version: '1', condition: { broadcaster_user_id: broadcasterId }, userToken: true },
    // — Polls (USER token, channel:read:polls).
    { type: 'channel.poll.begin', version: '1', condition: { broadcaster_user_id: broadcasterId }, userToken: true },
    { type: 'channel.poll.end',   version: '1', condition: { broadcaster_user_id: broadcasterId }, userToken: true },
    // — Predictions (USER token, channel:read:predictions).
    { type: 'channel.prediction.begin', version: '1', condition: { broadcaster_user_id: broadcasterId }, userToken: true },
    { type: 'channel.prediction.end',   version: '1', condition: { broadcaster_user_id: broadcasterId }, userToken: true },
    // — Moderation (USER token, channel:moderate).
    { type: 'channel.ban',   version: '1', condition: { broadcaster_user_id: broadcasterId }, userToken: true },
    { type: 'channel.unban', version: '1', condition: { broadcaster_user_id: broadcasterId }, userToken: true },
  ];
}

// Two existing subs are "the same" when the (type, version, condition,
// callback) tuple matches. We only consider enabled or pending status
// as the "already" predicate — failed/auth-revoked subs should be
// recreated so the count repairs itself.
function conditionsMatch(a, b) {
  if (!a || !b) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (String(a[k] || '') !== String(b[k] || '')) return false;
  }
  return true;
}

// ── /admin/twitch-setup/<guildId> ────────────────────────────────
//
// Create (or refresh) the EventSub subscriptions for Clay's
// broadcaster id. Idempotent — checks existing subscriptions first
// and only creates ones that don't already exist + match our
// (callback, secret) pair. Caller hits this AFTER setting the three
// Twitch secrets so the webhook handshake has somewhere to verify
// against.
//
// User-token-requiring subs (follow / sub / cheer / hype train /
// poll / prediction / ban / channel point) are SKIPPED with a
// `skipped-no-user-auth` reason when TWITCH_USER_REFRESH_TOKEN is
// absent — caller sees the array and knows to set up OAuth before
// rerunning.
//
// `opts.only` — optional array of subscription types to set up
// (rest are skipped). Useful for replaying a failed type after
// fixing scopes.
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

  const hasUserAuth = hasTwitchUserAuth(env);
  const existing = await listSubscriptions(env);
  let wantTypes = buildWantTypes(broadcasterId);
  if (Array.isArray(opts.only) && opts.only.length) {
    const set = new Set(opts.only.map(String));
    wantTypes = wantTypes.filter(w => set.has(w.type));
  }
  const out = { created: [], existing: [], failed: [], skipped: [] };
  for (const spec of wantTypes) {
    if (spec.userToken && !hasUserAuth) {
      out.skipped.push({ type: spec.type, reason: 'no-user-auth' });
      continue;
    }
    const already = existing.find(s =>
      s.type === spec.type
      && String(s.version || '1') === String(spec.version || '1')
      && conditionsMatch(s.condition || {}, spec.condition)
      && s.transport?.callback === callbackUrl
      && (s.status === 'enabled' || s.status === 'webhook_callback_verification_pending'),
    );
    if (already) {
      out.existing.push({ type: spec.type, id: already.id, status: already.status });
      continue;
    }
    try {
      const created = await createSubscription(env, spec.type, spec.condition, callbackUrl,
        env.TWITCH_EVENTSUB_SECRET, { userToken: spec.userToken, version: spec.version });
      if (created && Array.isArray(created.data) && created.data[0]) {
        out.created.push({ type: spec.type, id: created.data[0].id, status: created.data[0].status });
      } else {
        out.failed.push({ type: spec.type, reason: 'create-returned-null' });
      }
    } catch (e) {
      out.failed.push({ type: spec.type, reason: String(e?.message || e) });
    }
  }
  return { ok: true, broadcasterId, callbackUrl, hasUserAuth, ...out };
}

// ── /admin/twitch-eventsub/list/<guildId> ────────────────────────
//
// Returns the current Twitch-side view of subscriptions. Useful as a
// diagnostic before/after setupTwitchSubscriptions so Clay can see
// exactly what's registered. No mutation.
export async function listTwitchSubscriptions(env) {
  if (!isTwitchConfigured(env)) return { ok: false, error: 'twitch-not-configured' };
  const data = await listSubscriptions(env);
  return {
    ok: true,
    count: data.length,
    subscriptions: data.map(s => ({
      id:       s.id,
      type:     s.type,
      version:  s.version,
      status:   s.status,
      cost:     s.cost,
      condition: s.condition,
      callback: s.transport?.callback,
      createdAt: s.created_at,
    })),
  };
}
