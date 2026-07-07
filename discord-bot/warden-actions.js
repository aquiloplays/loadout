// Warden — moderation action dispatch.
//
// performAction() is the single entry point every action path funnels
// through (REST /action route, WardenRoom WS command, and auto-term
// hits). It:
//   1. rate-limits per acting mod (sliding window, mirrors chat-relay),
//   2. dispatches by platform (only Twitch is active in v1),
//   3. maps the abstract `kind` onto the Twitch Helix op (warden-twitch),
//   4. writes an audit row (warden-audit),
//   5. optionally fans out to linked platforms (syncAll → warden_identity).
//
// Non-Twitch platforms return a structured "unavailable" result so the
// UI + ban-sync can still enumerate them. Nothing here throws to the top.

import {
  twitchBan, twitchUnban, twitchDelete, twitchClear,
  twitchSetModes, twitchGetModes,
} from './warden-twitch.js';
import { addAudit } from './warden-audit.js';
import { getIdentity } from './warden-notes.js';

// ── Per-actor rate limit (sliding window, mirrors chat-relay.js) ─────────
// Kept in the LOADOUT_BOLTS KV so it survives across isolates. Mod
// actions are lower-volume than chat, so caps are generous; the point
// is a floor against a runaway loop or a compromised session, not to
// throttle normal moderating.
const BURST_WINDOW_MS = 10_000;
const BURST_CAP = 30;
const MIN_WINDOW_MS = 60 * 1000;
const MIN_CAP = 120;
const RATE_KEY = (actorId) => `warden:rate:${actorId}`;

async function checkAndTouchRate(env, actorId) {
  // Degrade open if KV is unavailable — never block a legit mod action
  // on a rate-store hiccup.
  if (!env.LOADOUT_BOLTS || !actorId) return { ok: true };
  const now = Date.now();
  let raw;
  try {
    raw = (await env.LOADOUT_BOLTS.get(RATE_KEY(actorId), { type: 'json' })) || {};
  } catch {
    return { ok: true };
  }
  const recent = (raw.recent || []).filter((ts) => now - ts < BURST_WINDOW_MS);
  if (recent.length >= BURST_CAP) {
    return { ok: false, reason: 'burst' };
  }
  let minStart = raw.minStart || 0;
  let minCount = raw.minCount || 0;
  if (now - minStart > MIN_WINDOW_MS) {
    minStart = now;
    minCount = 0;
  }
  if (minCount >= MIN_CAP) {
    return { ok: false, reason: 'minute' };
  }
  recent.push(now);
  minCount += 1;
  try {
    await env.LOADOUT_BOLTS.put(RATE_KEY(actorId), JSON.stringify({ recent, minStart, minCount }),
      { expirationTtl: 300 });
  } catch { /* non-fatal */ }
  return { ok: true };
}

// Kinds that map to a Twitch ban/unban/delete/clear (mode changes go
// through setModes/getModes, not performAction).
const ACTION_KINDS = new Set(['timeout', 'ban', 'unban', 'delete', 'clear']);

// OBS command rate limit — separate KV key from mod actions, generous
// enough for scene flips but stops a runaway loop. Degrades open on KV
// error like the action limiter.
export async function checkObsRate(env, actorId) {
  if (!env.LOADOUT_BOLTS || !actorId) return { ok: true };
  const now = Date.now();
  const key = 'warden:obsrate:' + actorId;
  let raw;
  try { raw = (await env.LOADOUT_BOLTS.get(key, { type: 'json' })) || {}; }
  catch { return { ok: true }; }
  const recent = (raw.recent || []).filter((ts) => now - ts < 10_000);
  if (recent.length >= 8) return { ok: false, reason: 'burst' };
  recent.push(now);
  try { await env.LOADOUT_BOLTS.put(key, JSON.stringify({ recent }), { expirationTtl: 60 }); }
  catch { /* non-fatal */ }
  return { ok: true };
}

// Dispatch one Twitch action. Returns the warden-twitch result shape.
async function runTwitch(env, { streamerId, actorId, kind, targetId, targetLogin, seconds, reason, messageId }) {
  switch (kind) {
    case 'timeout':
      return twitchBan(env, streamerId, actorId, { targetId, targetLogin, seconds, reason });
    case 'ban':
      return twitchBan(env, streamerId, actorId, { targetId, targetLogin, reason });
    case 'unban':
      return twitchUnban(env, streamerId, actorId, { targetId, targetLogin });
    case 'delete':
      return twitchDelete(env, streamerId, actorId, { messageId });
    case 'clear':
      return twitchClear(env, streamerId, actorId);
    default:
      return { ok: false, error: 'unknown-kind' };
  }
}

// Dispatch one Kick action (Phase 2: live). Kick's public API covers
// ban/timeout/unban; delete/clear have no endpoint yet.
async function runKick(env, { streamerId, kind, targetId, targetLogin, seconds, reason }) {
  const { kickBan, kickUnban } = await import('./warden-kick.js');
  switch (kind) {
    case 'timeout':
      return kickBan(env, streamerId, { targetId, targetLogin, seconds, reason });
    case 'ban':
      return kickBan(env, streamerId, { targetId, targetLogin, reason });
    case 'unban':
      return kickUnban(env, streamerId, { targetId, targetLogin });
    default:
      return { ok: false, error: 'platform-unavailable', platform: 'kick', kind };
  }
}

// Non-Twitch platforms: scaffolded but inert in v1.
function unavailablePlatform(platform) {
  if (platform === 'tiktok') return { ok: false, error: 'no-mod-api', platform };
  return { ok: false, error: 'platform-unavailable', platform };
}

// ── Main entry ───────────────────────────────────────────────────────────
export async function performAction(env, {
  streamerId, actorId, actorLogin, platform, kind,
  targetLogin, targetId, seconds, reason, messageId, syncAll,
} = {}) {
  const plat = String(platform || 'twitch').toLowerCase();

  if (!streamerId) return { ok: false, error: 'no-streamer' };
  if (!ACTION_KINDS.has(kind)) return { ok: false, error: 'unknown-kind', kind };

  // Rate limit per acting mod.
  const rate = await checkAndTouchRate(env, actorId);
  if (!rate.ok) return { ok: false, error: 'rate-limited', reason: rate.reason };

  // Perform the origin-platform action.
  let result;
  if (plat === 'twitch') {
    result = await runTwitch(env, { streamerId, actorId, kind, targetId, targetLogin, seconds, reason, messageId });
  } else if (plat === 'kick') {
    result = await runKick(env, { streamerId, kind, targetId, targetLogin, seconds, reason });
  } else {
    result = unavailablePlatform(plat);
  }

  // Cross-platform ban-sync: attempt the same kind on each linked
  // login. v1: only Twitch is active, everything else records as a
  // pending/unavailable attempt in the audit detail. Only meaningful
  // for user-scoped kinds (not delete/clear, which are message/room
  // scoped and can't be replayed cross-platform).
  const syncResults = [];
  if (syncAll && targetLogin && (kind === 'timeout' || kind === 'ban' || kind === 'unban')) {
    let identity = null;
    try {
      // subjectKey for the origin target on the origin platform.
      const { subjectKey } = await import('./warden-db.js');
      const sk = subjectKey(plat, targetLogin);
      identity = await getIdentity(env, streamerId, sk);
    } catch { /* identity lookup best-effort */ }
    const others = [
      { platform: 'youtube', login: identity?.youtube_id },
      { platform: 'kick', login: identity?.kick_login },
      { platform: 'trovo', login: null },
      { platform: 'tiktok', login: identity?.tiktok_login },
    ];
    for (const o of others) {
      if (o.platform === plat) continue;
      let r;
      if (o.platform === 'kick' && o.login) {
        // Kick is live: replay the user-scoped kind on the linked login.
        r = await runKick(env, { streamerId, kind, targetLogin: o.login, seconds, reason });
      } else {
        r = unavailablePlatform(o.platform);
      }
      syncResults.push({ platform: o.platform, login: o.login || null, ...r });
    }
  }

  // Audit — best-effort, never breaks the action.
  const detail = {
    kind,
    seconds: seconds != null ? Number(seconds) : undefined,
    reason: reason || undefined,
    messageId: messageId || undefined,
    ok: !!(result && result.ok),
    error: result && result.error ? result.error : undefined,
    needsReconnect: result && result.needsReconnect ? true : undefined,
    sync: syncResults.length ? syncResults : undefined,
  };
  let auditRow = null;
  try {
    auditRow = await addAudit(env, {
      streamerId, actorId, actorLogin,
      action: kind, platform: plat,
      targetLogin, targetId,
      detail,
    });
  } catch { /* non-fatal */ }

  return {
    ok: !!(result && result.ok),
    result: result || null,
    error: result && result.error ? result.error : undefined,
    needsReconnect: result && result.needsReconnect ? true : undefined,
    sync: syncResults.length ? syncResults : undefined,
    audit: auditRow,
  };
}

// ── Chat modes ─────────────────────────────────────────────────────────
// setModes/getModes are separate from performAction (they're room-scoped
// settings, not per-user actions) but share the same platform dispatch +
// audit pattern.

export async function setModes(env, {
  streamerId, actorId, actorLogin, platform, settings,
} = {}) {
  const plat = String(platform || 'twitch').toLowerCase();
  if (!streamerId) return { ok: false, error: 'no-streamer' };

  const rate = await checkAndTouchRate(env, actorId);
  if (!rate.ok) return { ok: false, error: 'rate-limited', reason: rate.reason };

  let result;
  if (plat === 'twitch') {
    result = await twitchSetModes(env, streamerId, actorId, settings || {});
  } else {
    result = unavailablePlatform(plat);
  }

  try {
    await addAudit(env, {
      streamerId, actorId, actorLogin,
      action: 'modes', platform: plat,
      targetLogin: null, targetId: null,
      detail: { settings: settings || {}, ok: !!(result && result.ok), error: result && result.error },
    });
  } catch { /* non-fatal */ }

  return {
    ok: !!(result && result.ok),
    settings: result && result.settings ? result.settings : undefined,
    error: result && result.error ? result.error : undefined,
    needsReconnect: result && result.needsReconnect ? true : undefined,
  };
}

export async function getModes(env, { streamerId, actorId, platform } = {}) {
  const plat = String(platform || 'twitch').toLowerCase();
  if (!streamerId) return { ok: false, error: 'no-streamer' };
  if (plat === 'twitch') {
    return twitchGetModes(env, streamerId, actorId);
  }
  return unavailablePlatform(plat);
}
