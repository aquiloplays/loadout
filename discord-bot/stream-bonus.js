// Stream-bonus module, features that only activate while Clay is
// live on Twitch.
//
// 2026-05-29 sprint features (j, k, n):
//   j. Aether, new Clash resource that only generates while live.
//      Stored on the existing wallet record as wallet.aether.
//   k. Streamer Watchtower, virtual Clash building that lights up
//      while Clay is live + grants a passive bolts bonus. The
//      auto-grant is read-time (no town-state migration needed);
//      isWatchtowerActive(env) returns the live-flag the renderer
//      uses for the glow effect.
//
// Both hinge on isStreamLive(env), which reads the existing
// twitch:live:state:<broadcasterId> KV record set by
// twitch-eventsub.js.

const BROADCASTER_ID_ENV = 'TWITCH_BROADCASTER_USER_ID';
const AETHER_PER_MINUTE   = 5;                // base rate while live
const AETHER_VIEWER_BONUS = 0.5;              // +0.5 per concurrent viewer
const WATCHTOWER_BOLT_PER_MINUTE = 2;         // passive bolts/min while live

// Canonical "is the streamer live right now" probe. Reads
// twitch:live:state:<broadcasterId>; record presence = live.
// Returns { live: bool, viewerCount?, startedUtc?, broadcasterId? }.
export async function isStreamLive(env) {
  const broadcasterId = env[BROADCASTER_ID_ENV] || env.TWITCH_USER_ID || null;
  if (!broadcasterId) return { live: false, reason: 'no-broadcaster-env' };
  try {
    const rec = await env.LOADOUT_BOLTS.get(
      `twitch:live:state:${broadcasterId}`, { type: 'json' },
    );
    if (!rec) return { live: false, broadcasterId };
    // Lifecycle state may carry viewer count + start ts. Treat record
    // presence as live regardless of payload shape.
    return {
      live:          true,
      broadcasterId,
      viewerCount:   Number(rec.viewerCount || rec.viewer_count || 0),
      startedUtc:    rec.startedUtc || rec.started_at || null,
    };
  } catch {
    return { live: false, error: 'kv-read' };
  }
}

// ── Aether ────────────────────────────────────────────────────────
//
// Per-tick accrual called from the cron (every minute via the :17
// piggyback chain, or whichever cron runs). Walks every active wallet
// in the guild and adds the live-only amount. Cheap: KV list paginated.
// `liveAccrueAetherTick` is idempotent per minute via the `lastAetherTickUtc`
// stamp on the wallet record.

export async function liveAccrueAetherTick(env, guildId) {
  const live = await isStreamLive(env);
  if (!live.live) return { ok: true, skipped: 'not-live' };
  const ratePerMin = Math.max(1, AETHER_PER_MINUTE +
    Math.floor((live.viewerCount || 0) * AETHER_VIEWER_BONUS));
  let cursor, granted = 0, walkedUsers = 0;
  for (let i = 0; i < 6; i++) {
    const page = await env.LOADOUT_BOLTS.list({
      prefix: `wallet:${guildId}:`, cursor, limit: 1000,
    });
    for (const k of (page.keys || [])) {
      walkedUsers++;
      const userId = k.name.slice(`wallet:${guildId}:`.length);
      try {
        const w = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
        if (!w) continue;
        // Per-minute dedup, re-running within 50s adds nothing.
        const last = w.lastAetherTickUtc || 0;
        const now  = Date.now();
        if (now - last < 50_000) continue;
        w.aether = (w.aether || 0) + ratePerMin;
        w.lastAetherTickUtc = now;
        await env.LOADOUT_BOLTS.put(k.name, JSON.stringify(w));
        granted += ratePerMin;
      } catch { /* swallow per-user */ }
    }
    if (page.list_complete || !page.cursor) break;
    cursor = page.cursor;
  }
  return { ok: true, granted, ratePerMin, walkedUsers };
}

export async function getAether(env, guildId, userId) {
  const raw = await env.LOADOUT_BOLTS.get(`wallet:${guildId}:${userId}`, { type: 'json' });
  return raw?.aether || 0;
}

// ── Watchtower ───────────────────────────────────────────────────
//
// Virtual auto-on building, no town-state mutation, no per-user
// records. isWatchtowerActive returns the renderer flag; the passive
// bolts bonus is a separate per-tick walk that mirrors the Aether
// loop above.

export async function isWatchtowerActive(env) {
  return (await isStreamLive(env)).live;
}

// (Bolts economy sunset 2026-06: liveAccrueWatchtowerBoltsTick was
// removed — it imported wallet.js `earn` to pay passive bolts/min to
// every online viewer while live. The Watchtower live-flag
// (isWatchtowerActive) stays for the renderer glow.)

export const _consts = {
  AETHER_PER_MINUTE, AETHER_VIEWER_BONUS,
  WATCHTOWER_BOLT_PER_MINUTE,
};
