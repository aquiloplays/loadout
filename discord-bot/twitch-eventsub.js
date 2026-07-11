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
  getRecentClips,
} from './twitch-helix.js';
import {
  EVENT_TYPE_HANDLERS,
  handleStreamEndedSummary,
} from './twitch-events.js';

const REPLAY_KEY = (id) => `twitch:eventsub:seen:${id}`;
const REPLAY_TTL_S = 10 * 60;

// ── Auto "what you missed last night" recap (roadmap item 14) ─────
//
// On stream.offline we snapshot the session into KV `recap:latest`
// with EXACTLY the shape the site's StreamRecapCard consumes via
// GET /community/recap-latest:
//   { endedAt, startedAt, durationMin, game, title, peakViewers,
//     topClip: null | { url, title, thumbnail } }
//
// Session facts come from the live-status dashboard's KV record
// (live-status-embed.js stamps game/title/peakViewers on the
// per-minute refresh); legacy twitch:live:state:* is the fallback.
// The top clip is the highest-viewed Helix clip of the last 24h.
//
// Called from live-status-embed.js handleStreamOffline (which passes
// the KV rec it read BEFORE deleting it) — the authoritative writer.
// Both the EventSub stream.offline branch and the per-minute cron's
// missed-offline detection route through handleStreamOffline, so
// every data-bearing path is covered by that single call site.
// A caller with no session facts never overwrites an existing recap;
// the rec-bearing caller is authoritative.
const RECAP_LATEST_KEY = 'recap:latest';

export async function persistLatestRecap(env, broadcasterId, preRec = null) {
  try {
    const guildId = String(env.AQUILO_VAULT_GUILD_ID || '').trim();
    const endedAt = Date.now();

    let rec = preRec || null;
    if (!rec && guildId) {
      try { rec = await env.LOADOUT_BOLTS.get(`live-status-embed:${guildId}`, { type: 'json' }); }
      catch { /* fall through */ }
    }
    let legacy = null;
    if (!rec) {
      try { legacy = await env.LOADOUT_BOLTS.get(`twitch:live:state:${broadcasterId}`, { type: 'json' }); }
      catch { /* ignore */ }
      // Legacy hardening: only trust a twitch:live:state record whose
      // startedAt is fresh (within 24h). A months-old leftover record
      // must never seed lastGame/lastTitle/startedAt into a recap (an
      // absurd durationMin and stale facts would clobber real data).
      if (legacy) {
        const startedMs = Date.parse(legacy.startedAt || '') || 0;
        if (!startedMs || (endedAt - startedMs) > 24 * 60 * 60 * 1000) legacy = null;
      }
    }
    // No-facts guard: when BOTH fact sources are missing, never
    // overwrite an existing recap regardless of age — the topClip
    // alone doesn't justify clobbering real session data with a
    // fact-free husk. Only write the factless shape when no recap
    // exists at all (first-ever run).
    if (!rec && !legacy) {
      try {
        const existing = await env.LOADOUT_BOLTS.get(RECAP_LATEST_KEY, { type: 'json' });
        if (existing) {
          return { ok: true, skipped: 'no-session-facts' };
        }
      } catch { /* write anyway */ }
    }

    const startedAtIso = rec?.startedAtIso || legacy?.startedAt || null;
    const startedAtMs  = startedAtIso ? (Date.parse(startedAtIso) || null) : null;
    const startedAt    = Number.isFinite(startedAtMs) && startedAtMs > 0 ? startedAtMs : null;
    const durationMin  = startedAt ? Math.max(0, Math.round((endedAt - startedAt) / 60_000)) : null;
    const peakRaw      = Number(rec?.peakViewers ?? legacy?.lastPeakViewers);
    const peakViewers  = Number.isFinite(peakRaw) && peakRaw > 0 ? peakRaw : null;

    // Top clip of the session: last-24h window, highest view count.
    // Best-effort — a Helix failure just means topClip: null.
    let topClip = null;
    try {
      const sinceIso = new Date(endedAt - 24 * 60 * 60 * 1000).toISOString();
      const clips = await getRecentClips(env, broadcasterId, sinceIso);
      const best = (Array.isArray(clips) ? clips : [])
        .filter(c => c && c.url)
        .sort((a, b) => (Number(b.view_count) || 0) - (Number(a.view_count) || 0))[0];
      if (best) {
        topClip = {
          url:       String(best.url),
          title:     String(best.title || ''),
          thumbnail: String(best.thumbnail_url || ''),
        };
      }
    } catch (e) {
      console.warn('[recap-latest] top-clip lookup failed:', e?.message || e);
    }

    const recap = {
      endedAt,
      startedAt,
      durationMin,
      game:  String(rec?.game || legacy?.lastGame || ''),
      title: String(rec?.title || legacy?.lastTitle || ''),
      peakViewers,
      topClip,
    };
    await env.LOADOUT_BOLTS.put(RECAP_LATEST_KEY, JSON.stringify(recap));
    await appendRecapArchive(env, recap);
    return { ok: true, recap };
  } catch (e) {
    console.warn('[recap-latest] persist failed:', e?.message || e);
    return { ok: false, error: String(e?.message || e) };
  }
}

// Rolling per-stream recap history (added 2026-07-11 for the site's
// /recaps archive page). ONE key holding a newest-first array of the
// same objects persistLatestRecap writes, so the site reads history
// with a single get. Capped so the value stays far under KV's 25 MB.
//   recap:archive = [ recap, recap, ... ]  (newest first, max 60)
// Guards: factless husks (no game AND no startedAt) are never archived,
// and a re-fire for the same session (missed-offline detection double
// tap) REPLACES the newest entry instead of duplicating it (matched by
// startedAt, falling back to a 30-min endedAt window when startedAt is
// null on both).
const RECAP_ARCHIVE_KEY = 'recap:archive';
const RECAP_ARCHIVE_MAX = 60;

async function appendRecapArchive(env, recap) {
  try {
    if (!recap || (!recap.game && !recap.startedAt)) return;
    let arr = [];
    try {
      const raw = await env.LOADOUT_BOLTS.get(RECAP_ARCHIVE_KEY, { type: 'json' });
      if (Array.isArray(raw)) arr = raw;
      // Missing key or non-array value -> genuinely fresh start.
    } catch (e) {
      // A TRANSIENT read failure must not wipe history: proceeding with
      // arr=[] here would truncate up to 60 recaps to 1 on the next put.
      // Skip the append instead - this entry stays recoverable from
      // recap:latest, and the next stream's append picks history back up.
      console.warn('[recap-archive] read failed, skipping append:', e?.message || e);
      return;
    }
    const head = arr[0];
    const sameSession = head && (
      (head.startedAt && recap.startedAt && head.startedAt === recap.startedAt) ||
      (!head.startedAt && !recap.startedAt &&
        Math.abs((head.endedAt || 0) - (recap.endedAt || 0)) < 30 * 60 * 1000)
    );
    if (sameSession) arr[0] = recap;
    else arr.unshift(recap);
    await env.LOADOUT_BOLTS.put(RECAP_ARCHIVE_KEY, JSON.stringify(arr.slice(0, RECAP_ARCHIVE_MAX)));
  } catch (e) {
    console.warn('[recap-archive] append failed:', e?.message || e);
  }
}

// GET /community/recap-archive — public read for the site's /recaps
// page (proxied by functions/api/community/recaps.js). Always
// { ok, recaps: [...] } newest first; empty array until the first
// stream.offline after this deploy.
export async function handleRecapArchive(req, env) {
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ ok: false, error: 'method' }), {
      status: 405, headers: { 'content-type': 'application/json' },
    });
  }
  let recaps = [];
  try {
    const raw = await env.LOADOUT_BOLTS.get(RECAP_ARCHIVE_KEY, { type: 'json' });
    if (Array.isArray(raw)) recaps = raw;
  } catch { /* recaps stays empty */ }
  return new Response(JSON.stringify({ ok: true, recaps }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=60',
      'access-control-allow-origin': '*',
    },
  });
}

// GET /community/recap-latest — public read for the site proxy
// (functions/api/community/recap-latest.js). Always { ok, recap };
// recap is null until the first stream.offline after deploy.
export async function handleRecapLatest(req, env) {
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ ok: false, error: 'method' }), {
      status: 405, headers: { 'content-type': 'application/json' },
    });
  }
  let recap = null;
  try {
    const raw = await env.LOADOUT_BOLTS.get(RECAP_LATEST_KEY, { type: 'json' });
    if (raw && typeof raw === 'object') recap = raw;
  } catch { /* recap stays null */ }
  return new Response(JSON.stringify({ ok: true, recap }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=0, s-maxage=60',
    },
  });
}

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
        // The "what you missed last night" recap (roadmap item 14) is
        // persisted inside handleStreamOffline below, which reads the
        // live-status KV rec BEFORE deleting it and passes it to
        // persistLatestRecap. Every data-bearing path (EventSub +
        // the cron's missed-offline detection) routes through it, so
        // no direct persist call is needed here.
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
    // 2026-07-09 (community roadmap item 10): site activity-feed
    // producers. Independent side-effect so a feed hiccup can never
    // disturb the primary dispatch. Kinds + meta match the contract
    // documented in activity-feed.js appendFeedEvent: subs, resubs,
    // gift subs, cheers >= 100 bits, raids, hype-train completions.
    {
      const FEED_SUBTYPES = new Set([
        'channel.subscribe', 'channel.subscription.message',
        'channel.subscription.gift', 'channel.cheer',
        'channel.raid', 'channel.hype_train.end',
      ]);
      if (subType && FEED_SUBTYPES.has(subType)) {
        ctx.waitUntil((async () => {
          try {
            const ev = payload?.event || {};
            const gid = env.AQUILO_VAULT_GUILD_ID || null;
            const { appendFeedEvent } = await import('./activity-feed.js');
            if (subType === 'channel.subscribe') {
              if (ev.is_gift) return; // recipients ride the gift event
              await appendFeedEvent(env, {
                kind: 'twitch.sub', guildId: gid,
                username: ev.user_name || ev.user_login || 'Someone',
                meta: { tier: ev.tier || '1000' },
              });
            } else if (subType === 'channel.subscription.message') {
              await appendFeedEvent(env, {
                kind: 'twitch.resub', guildId: gid,
                username: ev.user_name || ev.user_login || 'Someone',
                meta: { tier: ev.tier || '1000', months: Number(ev.cumulative_months) || null },
              });
            } else if (subType === 'channel.subscription.gift') {
              await appendFeedEvent(env, {
                kind: 'twitch.gift', guildId: gid,
                username: ev.is_anonymous ? 'An anonymous gifter' : (ev.user_name || ev.user_login || 'Someone'),
                meta: { total: Number(ev.total) || 1, tier: ev.tier || '1000' },
              });
            } else if (subType === 'channel.cheer') {
              const bits = Number(ev.bits) || 0;
              if (bits < 100) return; // notable cheers only
              await appendFeedEvent(env, {
                kind: 'twitch.cheer', guildId: gid,
                username: ev.is_anonymous ? 'An anonymous cheerer' : (ev.user_name || ev.user_login || 'Someone'),
                meta: { bits },
              });
            } else if (subType === 'channel.raid') {
              await appendFeedEvent(env, {
                kind: 'twitch.raid', guildId: gid,
                username: ev.from_broadcaster_user_name || ev.from_broadcaster_user_login || 'A streamer',
                meta: { viewers: Number(ev.viewers) || 0 },
              });
            } else if (subType === 'channel.hype_train.end') {
              await appendFeedEvent(env, {
                kind: 'twitch.hypetrain', guildId: gid,
                username: 'The community',
                meta: { level: Number(ev.level) || 1, total: Number(ev.total) || 0 },
              });
            }
          } catch (e) {
            console.warn('[twitch-eventsub] feed producer', e?.message || e);
          }
        })());
      }
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

    return new Response(null, { status: 204 });
  }

  return new Response('unhandled-message-type', { status: 400 });
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
