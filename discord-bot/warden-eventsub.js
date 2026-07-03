// Warden EventSub wiring — Twitch chat + moderation ingestion.
//
// Thin wrappers over the existing createSubscription / deleteSubscription
// (twitch-helix.js) that gate on a per-streamer KV flag so we only ever
// subscribe channel.chat.message + channel.moderate for streamers who
// have Warden turned on. twitch-eventsub.js's buildWantTypes reads the
// same flag before adding these two types.
//
// Notification flow (called from twitch-eventsub.js dispatch):
//   channel.chat.message → onChatMessage → normalize → terms.evaluate
//                          (auto-actions) → broadcastToWardenRoom({t:'chat'})
//   channel.moderate / channel.ban / channel.unban → onModerationEvent
//                          → addAudit + broadcastToWardenRoom({t:'audit'})
//
// Graceful-degrade: every export catches its own errors and returns a
// result shape rather than throwing. A streamer without Warden enabled
// is completely unaffected (the flag gates subscription creation).

import { createSubscription, listSubscriptions, deleteSubscription } from './twitch-helix.js';
import { broadcastToWardenRoom } from './aquilo/warden-room-do.js';

// KV flag: set when the first mod opens a streamer's room, cleared on
// teardown / idle. buildWantTypes + ensureWardenSubs both read it.
export const WARDEN_ON_KEY = (streamerId) => `warden:on:${streamerId}`;

// The two extra subscription types Warden needs, resolved against a
// streamer id. Kept in sync with the additions in twitch-eventsub.js's
// buildWantTypes so ensure/teardown target exactly the same tuples.
function wardenSubSpecs(streamerId) {
  return [
    // channel.chat.message v1 — the live chat feed. Condition wants both
    // broadcaster_user_id and user_id; we read AS the broadcaster, so
    // user_id === broadcaster_user_id (scope user:read:chat).
    { type: 'channel.chat.message', version: '1',
      condition: { broadcaster_user_id: String(streamerId), user_id: String(streamerId) } },
    // channel.moderate v2 — reconcile external mod actions (bans, deletes,
    // timeouts, mode changes performed elsewhere) into the audit feed.
    // Condition wants broadcaster_user_id + moderator_user_id; broadcaster
    // is implicitly a moderator of their own channel (scope channel:moderate
    // + the read:* moderate scopes).
    { type: 'channel.moderate', version: '2',
      condition: { broadcaster_user_id: String(streamerId), moderator_user_id: String(streamerId) } },
  ];
}

function callbackUrl(env) {
  return String((env.PUBLIC_WORKER_URL || 'https://loadout-discord.aquiloplays.workers.dev') + '/twitch/eventsub');
}

// Turn Warden on for a streamer and create the chat + moderate subs.
// Idempotent: skips any sub that already exists (matching type+version).
export async function ensureWardenSubs(env, streamerId) {
  streamerId = String(streamerId || '').trim();
  if (!streamerId) return { ok: false, error: 'no-streamer-id' };
  if (!env.TWITCH_EVENTSUB_SECRET) return { ok: false, error: 'eventsub-secret-not-set' };

  // Flip the flag first so buildWantTypes (any concurrent setup run) and
  // the notification dispatch both see Warden as enabled for this id.
  try { await env.LOADOUT_BOLTS.put(WARDEN_ON_KEY(streamerId), '1'); }
  catch (e) { console.warn('[warden-eventsub] flag set', e?.message || e); }

  const cb = callbackUrl(env);
  let existing = [];
  try { existing = await listSubscriptions(env); }
  catch (e) { console.warn('[warden-eventsub] list', e?.message || e); existing = []; }

  const out = { ok: true, streamerId, created: [], existing: [], failed: [] };
  for (const spec of wardenSubSpecs(streamerId)) {
    const already = existing.find(s =>
      s.type === spec.type
      && String(s.version || '1') === String(spec.version)
      && String(s.condition?.broadcaster_user_id || '') === streamerId
      && s.transport?.callback === cb
      && (s.status === 'enabled' || s.status === 'webhook_callback_verification_pending'));
    if (already) { out.existing.push({ type: spec.type, id: already.id, status: already.status }); continue; }
    try {
      const created = await createSubscription(env, spec.type, spec.condition, cb,
        env.TWITCH_EVENTSUB_SECRET, { userToken: true, version: spec.version });
      if (created && Array.isArray(created.data) && created.data[0]) {
        out.created.push({ type: spec.type, id: created.data[0].id, status: created.data[0].status });
      } else if (created && created._error) {
        out.failed.push({ type: spec.type, status: created.status, message: created.message, body: created.body });
      } else {
        out.failed.push({ type: spec.type, reason: 'create-returned-null' });
      }
    } catch (e) {
      out.failed.push({ type: spec.type, reason: String(e?.message || e) });
    }
  }
  return out;
}

// Turn Warden off for a streamer: clear the flag + delete the two subs.
export async function teardownWardenSubs(env, streamerId) {
  streamerId = String(streamerId || '').trim();
  if (!streamerId) return { ok: false, error: 'no-streamer-id' };

  try { await env.LOADOUT_BOLTS.delete(WARDEN_ON_KEY(streamerId)); }
  catch (e) { console.warn('[warden-eventsub] flag clear', e?.message || e); }

  const wanted = new Set(wardenSubSpecs(streamerId).map(s => s.type));
  const out = { ok: true, streamerId, deleted: [], failed: [] };
  let existing = [];
  try { existing = await listSubscriptions(env); }
  catch (e) { console.warn('[warden-eventsub] list', e?.message || e); return { ok: false, error: 'list-failed' }; }

  for (const s of existing) {
    if (!wanted.has(s.type)) continue;
    if (String(s.condition?.broadcaster_user_id || '') !== streamerId) continue;
    try { await deleteSubscription(env, s.id); out.deleted.push({ type: s.type, id: s.id }); }
    catch (e) { out.failed.push({ type: s.type, id: s.id, reason: String(e?.message || e) }); }
  }
  return out;
}

// ── Notification handlers ────────────────────────────────────────

// Normalize a channel.chat.message EventSub notification → the wire
// {t:'chat',...} frame shape. Twitch's documented payload (event):
//   { broadcaster_user_id, chatter_user_id, chatter_user_login,
//     chatter_user_name, color, message_id, message: { text, fragments:[...] },
//     badges:[{set_id,id,info}], message_type, ... }
// Assumption noted in the report: we read chatter_* for the sender and
// message.text for the body; color may be '' (Twitch omits for users who
// never set one).
export async function onChatMessage(env, notification) {
  try {
    const ev = notification?.event || {};
    const streamerId = String(ev.broadcaster_user_id || notification?.subscription?.condition?.broadcaster_user_id || '');
    if (!streamerId) return { ok: false, error: 'no-broadcaster' };

    const badges = Array.isArray(ev.badges) ? ev.badges : [];
    const badgeSet = new Set(badges.map(b => String(b?.set_id || '')));
    const isBroadcaster = badgeSet.has('broadcaster')
      || String(ev.chatter_user_id || '') === streamerId;
    const isMod = badgeSet.has('moderator') || isBroadcaster;

    const login = String(ev.chatter_user_login || '').toLowerCase();
    const msg = {
      platform: 'twitch',
      id: String(ev.message_id || ''),
      login,
      display: String(ev.chatter_user_name || ev.chatter_user_login || ''),
      color: String(ev.color || ''),
      text: String(ev.message?.text || ''),
      badges: badges.map(b => ({ set: String(b?.set_id || ''), id: String(b?.id || '') })),
      ts: Date.now(),
    };

    // Auto-actions: evaluate banned terms. Never runs on mod/broadcaster
    // messages (evaluate enforces that too, but pass the flags through).
    let auto = null;
    try {
      const { evaluate } = await import('./warden-terms.js');
      auto = await evaluate(env, streamerId, {
        login: msg.login,
        id: msg.id,
        text: msg.text,
        isMod,
        isBroadcaster,
        platform: 'twitch',
      });
    } catch (e) {
      console.warn('[warden-eventsub] terms.evaluate', e?.message || e);
    }

    const frame = { t: 'chat', ...msg };
    if (auto && auto.hit) frame.autoAction = { action: auto.action, term: auto.term };
    await broadcastToWardenRoom(env, streamerId, frame);
    return { ok: true };
  } catch (e) {
    console.warn('[warden-eventsub] onChatMessage', e?.message || e);
    return { ok: false, error: 'chat-handler-failed' };
  }
}

// Reconcile a moderation event (channel.moderate / channel.ban /
// channel.unban) into the audit feed + push a {t:'audit'} frame so mod
// browsers see actions taken outside Warden (or by Twitch directly).
export async function onModerationEvent(env, notification) {
  try {
    const ev = notification?.event || {};
    const subType = String(notification?.subscription?.type || '');
    const streamerId = String(ev.broadcaster_user_id || notification?.subscription?.condition?.broadcaster_user_id || '');
    if (!streamerId) return { ok: false, error: 'no-broadcaster' };

    // channel.moderate v2 nests the action + per-action sub-object; the
    // legacy channel.ban/unban carry ban fields at the top level.
    const action = String(ev.action || (subType === 'channel.ban' ? 'ban' : subType === 'channel.unban' ? 'unban' : 'moderate'));

    // Actor = the moderator who performed it (may be Twitch AutoMod / a
    // mod acting outside Warden).
    const actorId = String(ev.moderator_user_id || '');
    const actorLogin = String(ev.moderator_user_login || ev.moderator_user_name || '');

    // Target resolution: channel.moderate puts target under a per-action
    // key (ban/timeout/delete/unban_request/...); the fallbacks cover the
    // legacy channel.ban shape.
    const sub = ev[action] || {};
    const targetLogin = String(
      sub.user_login || sub.target_user_login || ev.user_login || ev.target_user_login || '').toLowerCase();
    const targetId = String(sub.user_id || sub.target_user_id || ev.user_id || ev.target_user_id || '');

    // Detail: capture reason/duration where present so the feed is useful.
    const detailBits = {};
    if (sub.reason || ev.reason) detailBits.reason = String(sub.reason || ev.reason);
    if (sub.expires_at || ev.expires_at) detailBits.expiresAt = String(sub.expires_at || ev.expires_at);
    if (sub.duration != null) detailBits.duration = sub.duration;
    detailBits.source = 'external';

    let row = null;
    try {
      const { addAudit } = await import('./warden-audit.js');
      row = await addAudit(env, {
        streamerId,
        actorId,
        actorLogin,
        action,
        platform: 'twitch',
        targetLogin,
        targetId,
        detail: JSON.stringify(detailBits),
      });
    } catch (e) {
      console.warn('[warden-eventsub] addAudit', e?.message || e);
    }

    await broadcastToWardenRoom(env, streamerId, { t: 'audit', ...(row || {
      streamerId, actorId, actorLogin, action, platform: 'twitch',
      targetLogin, targetId, detail: JSON.stringify(detailBits), ts: Date.now(),
    }) });
    return { ok: true };
  } catch (e) {
    console.warn('[warden-eventsub] onModerationEvent', e?.message || e);
    return { ok: false, error: 'moderation-handler-failed' };
  }
}
