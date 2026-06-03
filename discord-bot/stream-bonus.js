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
//   n. Bolt rain, applyVaultDelta wraps all bolt grants with a
//      1.2x multiplier when live. Plus periodic random drops at a
//      configurable cadence (cron-driven).
//
// All three hinge on isStreamLive(env), which reads the existing
// twitch:live:state:<broadcasterId> KV record set by
// twitch-eventsub.js.

const BROADCASTER_ID_ENV = 'TWITCH_BROADCASTER_USER_ID';
const BOLT_RAIN_MULTIPLIER = 1.20;            // +20% while live
const AETHER_PER_MINUTE   = 5;                // base rate while live
const AETHER_VIEWER_BONUS = 0.5;              // +0.5 per concurrent viewer
const WATCHTOWER_BOLT_PER_MINUTE = 2;         // passive bolts/min while live
const RANDOM_DROP_MIN = 50, RANDOM_DROP_MAX = 500;

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

export async function liveAccrueWatchtowerBoltsTick(env, guildId) {
  const live = await isStreamLive(env);
  if (!live.live) return { ok: true, skipped: 'not-live' };
  const { earn } = await import('./wallet.js');
  let cursor, granted = 0;
  for (let i = 0; i < 6; i++) {
    const page = await env.LOADOUT_BOLTS.list({
      prefix: `wallet:${guildId}:`, cursor, limit: 1000,
    });
    for (const k of (page.keys || [])) {
      const userId = k.name.slice(`wallet:${guildId}:`.length);
      try {
        // Per-minute dedup via stamp on wallet record.
        const w = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
        if (!w) continue;
        const last = w.lastWatchtowerTickUtc || 0;
        const now  = Date.now();
        if (now - last < 50_000) continue;
        await earn(env, guildId, userId, WATCHTOWER_BOLT_PER_MINUTE,
                   'watchtower:live');
        w.lastWatchtowerTickUtc = now;
        await env.LOADOUT_BOLTS.put(k.name, JSON.stringify(w));
        granted += WATCHTOWER_BOLT_PER_MINUTE;
      } catch { /* swallow */ }
    }
    if (page.list_complete || !page.cursor) break;
    cursor = page.cursor;
  }
  return { ok: true, granted };
}

// ── Bolt rain ────────────────────────────────────────────────────
//
// applyBoltRainMultiplier wraps a bolts grant, caller pulls it in
// at any grant site to amplify by 1.2x while live. Best-effort: if
// the live-probe fails the caller still gets the base amount.
//
// boltRainTick is the periodic "random drop" pulse, fires N viewers
// chosen at random from the wallet prefix and gives them 50-500 bolts.

export async function applyBoltRainMultiplier(env, amount) {
  const a = Number(amount) || 0;
  if (a <= 0) return a;
  const live = await isStreamLive(env);
  if (!live.live) return a;
  return Math.round(a * BOLT_RAIN_MULTIPLIER);
}

export async function boltRainTick(env, guildId, opts = {}) {
  const live = await isStreamLive(env);
  if (!live.live) return { ok: true, skipped: 'not-live' };
  const { earn } = await import('./wallet.js');
  const count = Math.max(1, Math.min(50, parseInt(opts.count, 10) || 5));
  // Walk wallet keys + reservoir-sample.
  let cursor, all = [];
  for (let i = 0; i < 6; i++) {
    const page = await env.LOADOUT_BOLTS.list({
      prefix: `wallet:${guildId}:`, cursor, limit: 1000,
    });
    for (const k of (page.keys || [])) all.push(k.name);
    if (page.list_complete || !page.cursor) break;
    cursor = page.cursor;
  }
  if (!all.length) return { ok: true, skipped: 'no-wallets' };
  // Shuffle-then-take avoids per-iteration Math.random in the loop.
  const sampleSize = Math.min(count, all.length);
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  const winners = all.slice(0, sampleSize);
  const drops = [];
  for (const key of winners) {
    const userId = key.slice(`wallet:${guildId}:`.length);
    const amount = RANDOM_DROP_MIN + Math.floor(
      Math.random() * (RANDOM_DROP_MAX - RANDOM_DROP_MIN + 1));
    try {
      await earn(env, guildId, userId, amount, 'bolt-rain');
      drops.push({ userId, amount });
    } catch { /* swallow */ }
  }
  return { ok: true, drops, total: drops.reduce((s, d) => s + d.amount, 0) };
}

export const _consts = {
  BOLT_RAIN_MULTIPLIER, AETHER_PER_MINUTE, AETHER_VIEWER_BONUS,
  WATCHTOWER_BOLT_PER_MINUTE, RANDOM_DROP_MIN, RANDOM_DROP_MAX,
};
