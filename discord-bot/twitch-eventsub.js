// Twitch EventSub webhook handler.
//
// POST /twitch/eventsub, Twitch posts here for three message types
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
// Signature verification is REQUIRED for every request, Twitch
// signs as
//   HMAC-SHA256(secret, messageId + messageTimestamp + rawBody)
// hex-encoded, sent in the `Twitch-Eventsub-Message-Signature`
// header prefixed with "sha256=". An attacker who forges a notify
// without the secret can't reach our handlers. Bail with 403 on a
// bad sig, Twitch will retry, and we don't want to act on it.
//
// Also a 10-min message-id replay window: re-deliveries are
// idempotently swallowed (returns 200 without re-processing the
// event). Twitch DOES retry, sometimes multiple times for the same
// event id; without dedupe a stream.online retry would re-post the
// embed.

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
import { publishActivity } from './activity-do.js';

const REPLAY_KEY = (id) => `twitch:eventsub:seen:${id}`;
const REPLAY_TTL_S = 10 * 60;

// ── Signature verification ───────────────────────────────────────

// Constant-time comparison so a timing attack can't probe the secret
// one byte at a time. Both inputs are hex strings of the SAME length
//, caller has already enforced length equality.
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
  // Read the body ONCE as raw text, signature verification + JSON
  // parsing both consume the same bytes.
  const body = await req.text();

  const ok = await verifyEventSubSignature(env.TWITCH_EVENTSUB_SECRET,
    messageId, timestamp, body, headerSig);
  if (!ok) return new Response('bad-signature', { status: 403 });

  // Replay-protect, once we've seen a message_id, swallow re-deliveries.
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
    // ACK fast, handlers run via waitUntil so slow Discord posts
    // can't push us past Twitch's 10-sec timeout.
    if (subType === 'stream.online' && broadcasterId) {
      // The live-now dashboard post (live-status-embed, defaults to
      // 1507973917350957067) IS the "going live" announcement: it
      // @-mentions the Stream Pings role once, then refreshes viewer
      // count per-minute. The older edit-in-place lifecycle card
      // (twitch-live.js postLiveEmbed) targeted the SAME channel and
      // was retired to stop the double-post, all going-live behaviour
      // lives in the dashboard now.
      ctx.waitUntil((async () => {
        try {
          const { handleStreamOnline } = await import('./live-status-embed.js');
          await handleStreamOnline(env, broadcasterId);
        } catch (e) { console.warn('[twitch-eventsub] live-status online', e?.message || e); }
      })());
    } else if (subType === 'stream.offline' && broadcasterId) {
      // The dashboard post is DELETED on offline + the latest VOD is
      // dropped in the videos channel (handleStreamOffline). The
      // separate "stream ended" summary still fires for the
      // stream-notifications binding if one is bound (no-ops otherwise).
      // lifecycleState is best-effort, only present if the retired
      // twitch-live.js card happens to have left state behind.
      ctx.waitUntil((async () => {
        let lifecycleState = null;
        try {
          lifecycleState = await env.LOADOUT_BOLTS.get(`twitch:live:state:${broadcasterId}`, { type: 'json' });
        } catch { /* ignore */ }
        await handleStreamEndedSummary(env, payload, { getStreamInfo, getUserById }, lifecycleState)
          .catch(e => console.warn('[twitch-eventsub] handleStreamEndedSummary', e?.message || e));
        // Delete the live dashboard post + drop the VOD.
        try {
          const { handleStreamOffline } = await import('./live-status-embed.js');
          await handleStreamOffline(env, broadcasterId);
        } catch (e) { console.warn('[twitch-eventsub] live-status offline', e?.message || e); }
      })());
    } else if (subType === "channel.update" && broadcasterId) {
      // Scene Themer reacts to category changes: persist the new category
      // for /api/scene-themer/active polling, and push to the optional
      // webhook so SB swaps are instant rather than up-to-10s. Best-effort,
      // never blocks ack.
      ctx.waitUntil((async () => {
        try {
          const { handleChannelUpdate } = await import("./scene-themer.js");
          const r = await handleChannelUpdate(env, payload);
          if (r && !r.ok) console.warn("[twitch-eventsub] scene-themer channel.update", r);
        } catch (e) {
          console.warn("[twitch-eventsub] scene-themer channel.update threw:", e?.message || e);
        }
      })());
    } else if (subType && EVENT_TYPE_HANDLERS[subType]) {
      // All other typed events route through the twitch-events.js
      // dispatch table. Each handler is itself defensive, null guild,
      // missing channel, toggle-off, and returns a shape the caller
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
      // 2026-05-29 sprint, side-effect for the dashboard embed.
      // Hype-train events flow into the live-status-embed's hype-train
      // field. Independent waitUntil so a failure here doesn't break
      // the primary handler above.
      if (subType === 'channel.hype_train.begin'
          || subType === 'channel.hype_train.progress'
          || subType === 'channel.hype_train.end') {
        ctx.waitUntil((async () => {
          try {
            const ls = await import('./live-status-embed.js');
            const fn = subType === 'channel.hype_train.begin'    ? ls.handleHypeTrainBegin
                    : subType === 'channel.hype_train.progress' ? ls.handleHypeTrainProgress
                    :                                              ls.handleHypeTrainEnd;
            await fn(env, payload);
          } catch (e) { console.warn('[twitch-eventsub] live-status hype', e?.message || e); }
        })());
      }
    } else if (subType) {
      // Unknown sub type, still ack so Twitch doesn't retry forever.
      console.log('[twitch-eventsub] unhandled subType:', subType);
    }

    // 2026-07-01: accumulate community stats Helix can't provide — all-time
    // + 30-day sub GIFTERS and per-subscriber tenure (months). Independent
    // side-effect, runs alongside whatever the main dispatch did.
    if (subType === 'channel.subscription.gift' || subType === 'channel.subscription.message') {
      ctx.waitUntil((async () => {
        try {
          const ev = payload?.event || {};
          const store = await import('./twitch-stats-store.js');
          if (subType === 'channel.subscription.gift') {
            await store.recordGift(env, {
              login: ev.is_anonymous ? '' : (ev.user_login || ''),
              name:  ev.is_anonymous ? 'Anonymous' : (ev.user_name || ev.user_login || ''),
              count: Number(ev.total) || 1,
            });
          } else {
            await store.recordSubTenure(env, {
              login:  ev.user_login || '',
              months: Number(ev.cumulative_months) || 0,
            });
          }
        } catch (e) { console.warn('[twitch-eventsub] stats accumulate', e?.message || e); }
      })());
    }
    // 2026-07-03: Warden moderator-suite ingestion. Independent side-effect
    // so it can't disturb the primary dispatch above. Chat messages feed the
    // unified live console + banned-terms auto-actions; moderation events
    // (incl. the pre-existing channel.ban/unban subs) reconcile external mod
    // actions into the audit feed. Dynamic import keeps the cost off the hot
    // path for non-moderation events. No-ops for streamers without Warden on.
    if (subType === 'channel.chat.message') {
      ctx.waitUntil((async () => {
        try {
          const w = await import('./warden-eventsub.js');
          await w.onChatMessage(env, payload);
        } catch (e) { console.warn('[twitch-eventsub] warden chat', e?.message || e); }
      })());
    } else if (subType === 'channel.moderate' || subType === 'channel.ban' || subType === 'channel.unban') {
      ctx.waitUntil((async () => {
        try {
          const w = await import('./warden-eventsub.js');
          await w.onModerationEvent(env, payload);
        } catch (e) { console.warn('[twitch-eventsub] warden moderate', e?.message || e); }
      })());
    }

    // Cloud / OAuth overlays (games running WITHOUT Streamer.bot) read the
    // streamer's events off the Aquilo activity bus via the overlay SSE
    // (/api/overlay-canvas/events/<login>). Mirror the game-relevant events
    // onto it, keyed by broadcaster login, using the kind names the overlay
    // runtime already listens for. Best-effort; Streamer.bot installs are
    // unaffected (they still read their own local WS).
    ctx.waitUntil(publishGameBusEvent(env, subType, payload).catch((e) =>
      console.warn('[twitch-eventsub] game-bus', e?.message || e)));

    return new Response(null, { status: 204 });
  }

  return new Response('unhandled-message-type', { status: 400 });
}

// Games/overlays that run cloud-side (no Streamer.bot) read the streamer's
// events off the Aquilo activity bus via the overlay SSE. Map the
// game-relevant EventSub notifications onto that bus, keyed by the
// broadcaster's login, using the same `kind` names the overlay runtime
// (public/overlays/**) already listens for. Returns early for types no
// overlay consumes. Best-effort — never throws into the webhook ack path.
async function publishGameBusEvent(env, subType, payload) {
  const ev = (payload && payload.event) || {};
  const broadcaster = String(ev.broadcaster_user_login || ev.to_broadcaster_user_login || '').toLowerCase();
  if (!broadcaster) return;
  let kind = '';
  let data = {};
  switch (subType) {
    case 'channel.channel_points_custom_reward_redemption.add':
      kind = 'channel-point-redeem';
      data = {
        user: ev.user_name || ev.user_login || 'viewer',
        userId: String(ev.user_id || ''),
        userLogin: ev.user_login || '',
        rewardId: (ev.reward && ev.reward.id) || '',
        rewardTitle: (ev.reward && ev.reward.title) || '',
        cost: Number(ev.reward && ev.reward.cost) || 0,
        input: String(ev.user_input || ''),
      };
      break;
    case 'channel.cheer':
      kind = 'bits';
      data = {
        user: ev.is_anonymous ? 'Anonymous' : (ev.user_name || 'viewer'),
        userId: ev.is_anonymous ? '' : String(ev.user_id || ''),
        bits: Number(ev.bits) || 0,
        message: String(ev.message || ''),
      };
      break;
    case 'channel.subscribe':
      kind = 'sub';
      data = {
        user: ev.user_name || 'viewer', userId: String(ev.user_id || ''),
        tier: String(ev.tier || '1000'), isGift: !!ev.is_gift,
      };
      break;
    case 'channel.subscription.message':
      kind = 'sub';
      data = {
        user: ev.user_name || 'viewer', userId: String(ev.user_id || ''),
        tier: String(ev.tier || '1000'), months: Number(ev.cumulative_months) || 0,
        streak: Number(ev.streak_months) || 0,
        message: String((ev.message && ev.message.text) || ''),
      };
      break;
    case 'channel.subscription.gift':
      kind = 'gift-sub';
      data = {
        user: ev.is_anonymous ? 'Anonymous' : (ev.user_name || 'viewer'),
        userId: ev.is_anonymous ? '' : String(ev.user_id || ''),
        count: Number(ev.total) || 1, tier: String(ev.tier || '1000'),
      };
      break;
    case 'channel.follow':
      kind = 'follow';
      data = { user: ev.user_name || ev.user_login || 'viewer', userId: String(ev.user_id || '') };
      break;
    case 'channel.raid':
      kind = 'raid';
      data = { user: ev.from_broadcaster_user_name || 'a raider', viewers: Number(ev.viewers) || 0 };
      break;
    case 'channel.hype_train.begin':
    case 'channel.hype_train.progress':
    case 'channel.hype_train.end':
      kind = subType === 'channel.hype_train.begin' ? 'hype-train-begin'
        : subType === 'channel.hype_train.progress' ? 'hype-train-progress'
          : 'hype-train-end';
      data = {
        level: Number(ev.level) || 0, total: Number(ev.total) || 0,
        progress: Number(ev.progress) || 0, goal: Number(ev.goal) || 0,
      };
      break;
    default:
      return; // no overlay consumes this type
  }
  await publishActivity(env, { kind, broadcaster, ...data });
}

// ── Subscription catalogue ───────────────────────────────────────
//
// Per-type config: which API version, which condition shape, which
// token kind (app vs user) is required. Order matters for the
// `created` array readout, kept roughly user-facing-priority.
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
//     the broadcaster id, the broadcaster is implicitly a moderator
//     in their own channel).
//   - channel.raid (incoming): { to_broadcaster_user_id }.
function buildWantTypes(broadcasterId) {
  return [
    //, Stream lifecycle (app token, no scope).
    { type: 'stream.online',  version: '1', condition: { broadcaster_user_id: broadcasterId }, userToken: false },
    { type: 'stream.offline', version: '1', condition: { broadcaster_user_id: broadcasterId }, userToken: false },
    //, Channel update v2 (app token, no scope). Powers Scene Themer:
    //   every time the streamer changes their category from the Twitch
    //   dashboard, this fires and scene-themer.js swaps the active source
    //   group via the configured webhook (and updates the cached state
    //   for the SB poll fallback). v1 was retired in 2023; v2 returns
    //   category_id + category_name in event payload.
    { type: 'channel.update', version: '2', condition: { broadcaster_user_id: broadcasterId }, userToken: false },
    //, Channel.follow v2 (USER token, moderator:read:followers).
    { type: 'channel.follow', version: '2',
      condition: { broadcaster_user_id: broadcasterId, moderator_user_id: broadcasterId },
      userToken: true },
    //, Subs / resubs / gifts (USER token, channel:read:subscriptions).
    { type: 'channel.subscribe',            version: '1', condition: { broadcaster_user_id: broadcasterId }, userToken: true },
    { type: 'channel.subscription.message', version: '1', condition: { broadcaster_user_id: broadcasterId }, userToken: true },
    { type: 'channel.subscription.gift',    version: '1', condition: { broadcaster_user_id: broadcasterId }, userToken: true },
    //, Cheers (USER token, bits:read).
    { type: 'channel.cheer',                version: '1', condition: { broadcaster_user_id: broadcasterId }, userToken: true },
    //, Incoming raid (app token, no scope; the TO field is the
    //   broadcaster, since we want to detect raids INTO Clay).
    { type: 'channel.raid', version: '1',
      condition: { to_broadcaster_user_id: broadcasterId },
      userToken: false },
    //, Channel-point redemptions (USER token, channel:read:redemptions).
    { type: 'channel.channel_points_custom_reward_redemption.add', version: '1',
      condition: { broadcaster_user_id: broadcasterId }, userToken: true },
    //, Hype train (channel:read:hype_train). v1 was retired late 2025;
    //   v2 is the current shape. Twitch returns "invalid subscription
    //   type and version" if v1 is requested today.
    { type: 'channel.hype_train.begin',    version: '2', condition: { broadcaster_user_id: broadcasterId }, userToken: true },
    { type: 'channel.hype_train.progress', version: '2', condition: { broadcaster_user_id: broadcasterId }, userToken: true },
    { type: 'channel.hype_train.end',      version: '2', condition: { broadcaster_user_id: broadcasterId }, userToken: true },
    //, Polls (USER token, channel:read:polls).
    { type: 'channel.poll.begin', version: '1', condition: { broadcaster_user_id: broadcasterId }, userToken: true },
    { type: 'channel.poll.end',   version: '1', condition: { broadcaster_user_id: broadcasterId }, userToken: true },
    //, Predictions (USER token, channel:read:predictions).
    { type: 'channel.prediction.begin', version: '1', condition: { broadcaster_user_id: broadcasterId }, userToken: true },
    { type: 'channel.prediction.end',   version: '1', condition: { broadcaster_user_id: broadcasterId }, userToken: true },
    //, Moderation (USER token, channel:moderate).
    { type: 'channel.ban',   version: '1', condition: { broadcaster_user_id: broadcasterId }, userToken: true },
    { type: 'channel.unban', version: '1', condition: { broadcaster_user_id: broadcasterId }, userToken: true },
  ];
}

// Warden additive want-types. Returns [] unless the streamer has Warden
// enabled (KV flag `warden:on:<id>`), so the moderator-suite subscriptions
// are only created for opted-in channels and everyone else is unaffected.
// Both require the broadcaster USER grant (user:read:chat for chat.message,
// the moderate read scopes + channel:moderate for channel.moderate).
async function wardenWantTypes(env, broadcasterId) {
  try {
    const on = await env.LOADOUT_BOLTS.get(`warden:on:${broadcasterId}`);
    if (!on) return [];
  } catch { return []; }
  return [
    { type: 'channel.chat.message', version: '1',
      condition: { broadcaster_user_id: broadcasterId, user_id: broadcasterId }, userToken: true },
    { type: 'channel.moderate', version: '2',
      condition: { broadcaster_user_id: broadcasterId, moderator_user_id: broadcasterId }, userToken: true },
  ];
}

// Two existing subs are "the same" when the (type, version, condition,
// callback) tuple matches. We only consider enabled or pending status
// as the "already" predicate, failed/auth-revoked subs should be
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
// broadcaster id. Idempotent, checks existing subscriptions first
// and only creates ones that don't already exist + match our
// (callback, secret) pair. Caller hits this AFTER setting the three
// Twitch secrets so the webhook handshake has somewhere to verify
// against.
//
// User-token-requiring subs (follow / sub / cheer / hype train /
// poll / prediction / ban / channel point) are SKIPPED with a
// `skipped-no-user-auth` reason when TWITCH_USER_REFRESH_TOKEN is
// absent, caller sees the array and knows to set up OAuth before
// rerunning.
//
// `opts.only`, optional array of subscription types to set up
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

  const hasUserAuth = await hasTwitchUserAuth(env);
  const existing = await listSubscriptions(env);
  let wantTypes = buildWantTypes(broadcasterId);
  // Warden (moderator suite) subscriptions are ADDITIVE and gated on the
  // per-streamer `warden:on:<id>` KV flag so non-Warden streamers are
  // completely unaffected. When the flag is set, append channel.chat.message
  // (v1) + channel.moderate (v2) to the wanted set for this broadcaster.
  wantTypes = wantTypes.concat(await wardenWantTypes(env, broadcasterId));
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
      } else if (created && created._error) {
        // 2026-05-29, surface the actual Twitch error so scope/version/
        // condition mismatches can be diagnosed without a wrangler tail.
        out.failed.push({
          type: spec.type,
          reason: 'twitch-error',
          status: created.status,
          message: created.message,
          twitchBody: created.body,
        });
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
