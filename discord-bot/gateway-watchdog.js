// Gateway dead-man switch (community roadmap item 12, 2026-07).
//
// The aquilo-presence gateway shim (Railway, Loadout/aquilo-gateway/
// aquilo_gateway.py) is the single point of failure for every "the
// community feels alive" feature: starboard, counting, welcome embeds,
// temp-VCs, the site chat ringbuffer and the community feed all ride
// its forwarded events. When it dies, everything fails SILENTLY — the
// worker just stops receiving posts.
//
// This module converts that silent failure into one loud, actionable
// alert Clay can fix without Claude:
//
//   stampGatewaySeen(env)      called on every AUTHENTICATED gateway-
//                              forwarded event (auth.js verifyGatewaySig
//                              success path) ONLY. Writes KV
//                              `gateway:last-seen` = Date.now(),
//                              throttled to one write per 5 min per
//                              isolate so KV write volume stays tiny.
//
//   stampGatewayPollSeen(env)  called on the shim's 5-minute GET
//                              /forward-channels poll (aquilo/worker.js)
//                              — the poll is the heartbeat that keeps
//                              quiet overnight hours from reading as an
//                              outage. Writes the SEPARATE key
//                              `gateway:poll-seen` (same throttle). The
//                              split matters: /forward-channels is a
//                              public route, so a third party could keep
//                              the poll stamp fresh — but never the
//                              authenticated last-seen stamp, which is
//                              exclusive to verified events. Without the
//                              split, "events rejected (secret rotated),
//                              shim alive" — the exact failure this
//                              watchdog was built for — stays silent
//                              forever.
//
//   checkGatewayHeartbeat(env) called from the per-minute cron (worker.js,
//                              gated to every 10th minute). Alarms when
//                              EITHER poll-seen is stale > 6h (shim
//                              process/HTTP loop dead — quiet-overnight
//                              suppression preserved) OR authenticated
//                              last-seen is stale > 30h (shim polling but
//                              events not landing — secret parity /
//                              forward-loop-dead; 30h comfortably exceeds
//                              any organic quiet gap in a community with
//                              a nightly stream), with distinct reason
//                              lines per signal. Respects a 24h alert
//                              cooldown (KV, TTL-expired), posts ONE
//                              embed to ⚙️│bot-admin
//                              (AQUILO_ADMIN_HUB_CHANNEL_ID) and DMs Clay
//                              (same sendDm util push-dm.js delivers
//                              through) with the Railway restart steps
//                              inline. Never throws — every failure path
//                              is swallowed so it can't break the cron.
//
// KV:
//   gateway:last-seen        epoch-ms string, AUTHENTICATED events only
//   gateway:poll-seen        epoch-ms string, /forward-channels poll only
//   gateway:alert-cooldown   epoch-ms string, 24h TTL; presence = muted
//   gateway:health-fails     consecutive failed /health probes (see below)
//
// SECOND SIGNAL (added after the 2026-07-10 outage postmortem): the
// deployed forwarder is the Node `aquilo-presence` Railway service, and
// its failure mode is NASTY — on a fatal Discord close code (4004
// invalid token, 4010-4014) it permanently stops reconnecting while its
// /health endpoint keeps answering ok:true, so Railway healthchecks
// pass and the staleness signal above needs 6 quiet hours to notice.
// checkGatewayHeartbeat therefore ALSO probes /health directly and
// inspects bots[].connected — two consecutive probes (≈20 min at the
// every-10th-minute cadence) with any bot disconnected fire the same
// alert path. That exact mode ran silent for ~6 days (07-04 → 07-10).

const LAST_SEEN_KEY = 'gateway:last-seen';   // authenticated events ONLY
const POLL_SEEN_KEY = 'gateway:poll-seen';   // /forward-channels heartbeat poll
const COOLDOWN_KEY  = 'gateway:alert-cooldown';
const HEALTH_FAILS_KEY = 'gateway:health-fails';
const PRESENCE_HEALTH_URL = 'https://aquilo-presence-production.up.railway.app/health';
const POLL_STALE_MS = 6 * 60 * 60 * 1000;    // no poll > 6h = shim presumed down
const AUTH_STALE_MS = 30 * 60 * 60 * 1000;   // no authenticated event > 30h = events not landing
const FRESH_VETO_MS = 15 * 60 * 1000;        // stamp this fresh contradicts 'unreachable'
const COOLDOWN_TTL_S = 24 * 60 * 60;         // re-alert at most once per 24h
const STAMP_THROTTLE_MS = 5 * 60 * 1000;     // per-isolate write throttle

// Clay's Discord id — same constant kitchen.js/dock.js use for
// owner-gating. The dead-man DM is owner-only by design.
const CLAY_DISCORD_ID = '1107161695262085210';

// Per-isolate memos so a burst of forwarded messages/polls costs one
// KV write per 5 minutes per key, not one per message. Isolate
// recycling just means an occasional extra write — harmless.
let lastStampMs = 0;
let lastPollStampMs = 0;

export async function stampGatewaySeen(env) {
  try {
    if (!env || !env.LOADOUT_BOLTS) return;
    const now = Date.now();
    if (now - lastStampMs < STAMP_THROTTLE_MS) return;
    lastStampMs = now;
    await env.LOADOUT_BOLTS.put(LAST_SEEN_KEY, String(now));
  } catch { /* never let bookkeeping break an event route */ }
}

// The /forward-channels heartbeat poll stamps its OWN key — it's a
// public, unauthenticated route, so it must never refresh the
// authenticated last-seen stamp (see module header).
export async function stampGatewayPollSeen(env) {
  try {
    if (!env || !env.LOADOUT_BOLTS) return;
    const now = Date.now();
    if (now - lastPollStampMs < STAMP_THROTTLE_MS) return;
    lastPollStampMs = now;
    await env.LOADOUT_BOLTS.put(POLL_SEEN_KEY, String(now));
  } catch { /* never let bookkeeping break the poll route */ }
}

function alertEmbed(reasonLine) {
  return {
    title: '🚨 aquilo-presence gateway is down',
    color: 0xED4245,
    description: [
      reasonLine,
      '',
      '**Down until it\'s back:** starboard, counting, welcome embeds, ' +
      'temp-VCs, site chat + the aquilo.gg community feed.',
      '',
      '**Fix steps (≈1 minute):**',
      '1. railway.com → project → **aquilo-presence** service',
      '2. **Deployments** → View **Logs**. If they show `closed: 4004`, ' +
      'the bot token was invalidated. Reset it in the Discord Dev ' +
      'Portal (Bot → Reset Token) and paste the new token into the ' +
      'service\'s `BOTS` env JSON (Variables tab) BEFORE restarting.',
      '3. Otherwise: latest deploy → ⋮ menu → **Restart**.',
      '4. Verify: /health should show `"connected":true` on every bot. ' +
      'Recovery is self-confirming: events resume, this alert stays quiet.',
      '',
      '_Re-alerts are muted for 24h. Do NOT decommission this Railway ' +
      'service. It is the community\'s event spine._',
    ].join('\n'),
    footer: { text: 'gateway dead-man switch · loadout-discord cron' },
    timestamp: new Date().toISOString(),
  };
}

// Probe aquilo-presence /health and report whether every configured bot
// has a live Discord connection. The endpoint's top-level ok:true is
// UNCONDITIONAL (it lies) — bots[].connected is the real signal. Returns
// 'up' | 'degraded' | 'unreachable'.
async function probePresenceHealth() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    let res;
    try { res = await fetch(PRESENCE_HEALTH_URL, { signal: ctl.signal }); }
    finally { clearTimeout(t); }
    if (!res.ok) return 'unreachable';
    const j = await res.json();
    const bots = Array.isArray(j && j.bots) ? j.bots : [];
    if (bots.length === 0) return 'degraded';
    return bots.every((b) => b && b.connected === true) ? 'up' : 'degraded';
  } catch {
    // Network failure probing Railway is treated as unreachable — the
    // consecutive-probe requirement below absorbs one-off blips.
    return 'unreachable';
  }
}

// Cron hook. Returns a small result object for cron logs; never throws.
export async function checkGatewayHeartbeat(env) {
  try {
    if (!env || !env.LOADOUT_BOLTS) return { ok: false, skipped: 'no-kv' };

    // Signal 2 first (fast detector): direct /health probe. Two
    // consecutive degraded/unreachable probes (~20 min) trip the alert
    // even while the 6h staleness window hasn't elapsed.
    let healthReason = null;
    const health = await probePresenceHealth();
    if (health === 'up') {
      try { await env.LOADOUT_BOLTS.delete(HEALTH_FAILS_KEY); } catch { /* ignore */ }
    } else {
      const fails = (parseInt(await env.LOADOUT_BOLTS.get(HEALTH_FAILS_KEY), 10) || 0) + 1;
      await env.LOADOUT_BOLTS.put(HEALTH_FAILS_KEY, String(fails), { expirationTtl: 24 * 60 * 60 });
      if (fails >= 2) {
        healthReason = health === 'degraded'
          ? 'aquilo-presence is running but its **Discord connection is dead** ' +
            '(`bots[].connected: false` on consecutive /health probes, and the ' +
            'top-level ok:true is unconditional and lies).'
          : 'aquilo-presence /health is **unreachable** on consecutive probes. ' +
            'The Railway service looks down entirely.';
      }
    }

    // Staleness signals, split keys (2026-07-10): poll-seen is the
    // shim's /forward-channels heartbeat (publicly stampable, weaker
    // signal), last-seen is authenticated events only (auth.js
    // gatewayOk). Alarm on EITHER going stale, with distinct reasons.
    const now = Date.now();
    const pollRaw = await env.LOADOUT_BOLTS.get(POLL_SEEN_KEY);
    const authRaw = await env.LOADOUT_BOLTS.get(LAST_SEEN_KEY);
    if (!pollRaw || !authRaw) {
      // First run after deploy (or first run since the key split):
      // seed the missing clock(s) instead of alerting on stamps that
      // never existed. The staleness windows start now.
      if (!pollRaw) await env.LOADOUT_BOLTS.put(POLL_SEEN_KEY, String(now));
      if (!authRaw) await env.LOADOUT_BOLTS.put(LAST_SEEN_KEY, String(now));
      if (!healthReason) return { ok: true, seeded: true };
    }
    const pollAge = pollRaw ? now - (parseInt(pollRaw, 10) || 0) : 0;
    const authAge = authRaw ? now - (parseInt(authRaw, 10) || 0) : 0;
    const pollStale = pollRaw ? pollAge >= POLL_STALE_MS : false;
    const authStale = authRaw ? authAge >= AUTH_STALE_MS : false;
    const stale = pollStale || authStale;

    // Fresh-stamp veto, 'unreachable' probes ONLY: a stamp landed in
    // the last 15 min, so the Node process is alive and reaching this
    // worker — that contradicts "the Railway service looks down
    // entirely" (the probe failures are network noise between
    // Cloudflare and Railway). 'degraded' is NEVER vetoed: it is
    // authoritative (bots[].connected straight from the service), and
    // a fresh stamp can't clear it — the 5-min poll keeps stamping
    // even while the Discord WebSocket is dead.
    const freshestAgeMs = Math.min(
      pollRaw ? pollAge : Infinity,
      authRaw ? authAge : Infinity,
    );
    if (healthReason && health === 'unreachable' && !stale && freshestAgeMs < FRESH_VETO_MS) {
      return { ok: true, vetoed: 'fresh-stamp-contradicts-unreachable',
               health, pollAgeMs: pollAge, authAgeMs: authAge };
    }

    if (!stale && !healthReason) {
      return { ok: true, pollAgeMs: pollAge, authAgeMs: authAge, health };
    }

    // Down by one signal or more. Respect the 24h mute before anything loud.
    const muted = await env.LOADOUT_BOLTS.get(COOLDOWN_KEY);
    if (muted) {
      return { ok: false, stale, pollStale, authStale, health,
               pollAgeMs: pollAge, authAgeMs: authAge, mutedSince: muted };
    }

    // Arm the mute BEFORE posting: the cron is at-least-once and the
    // two sends below are network calls — a partial failure must not
    // machine-gun the admin channel.
    await env.LOADOUT_BOLTS.put(COOLDOWN_KEY, String(Date.now()), {
      expirationTtl: COOLDOWN_TTL_S,
    });

    // Reason line, most-specific signal wins:
    //   1. healthReason (2 consecutive degraded/unreachable probes)
    //   2. poll stale + /health up → NOT "gateway is down": the shim
    //      is healthy but its heartbeat isn't reaching us — actionable
    //      causes inline (missing poll env var / zombie socket).
    //   3. poll stale             → Railway service silent.
    //   4. auth stale only        → shim polling but events rejected —
    //      secret parity.
    const pollHours = Math.max(1, Math.floor(pollAge / 3_600_000));
    const authHours = Math.max(1, Math.floor(authAge / 3_600_000));
    let reasonLine;
    if (healthReason) {
      reasonLine = healthReason;
    } else if (pollStale && health === 'up') {
      reasonLine =
        `Forwarded events + heartbeat polls are **~${pollHours}h** stale while ` +
        '/health reports every bot connected. Two likely causes: (1) the 5-minute ' +
        '/forward-channels heartbeat poll isn\'t running: check that ' +
        '`AQUILO_BOT_FORWARD_CHANNELS_URL` is set on the **aquilo-presence** Railway ' +
        'service (when unset, index.js falls back to a static channel list and ' +
        'never polls); or (2) the Discord gateway socket is a **zombie**: the ' +
        'service never checks heartbeat ACKs, so a dead connection still reads ' +
        'OPEN. Either way: restart the service.';
    } else if (pollStale) {
      reasonLine =
        `No /forward-channels heartbeat poll for **~${pollHours}h** (expected one ` +
        'every 5 minutes). The Railway service is silent.';
    } else {
      reasonLine =
        'The shim is polling /forward-channels normally, but **no authenticated ' +
        `events have landed for ~${authHours}h**. Events are likely being ` +
        'REJECTED. Check `AQUILO_GATEWAY_SECRET` parity between this worker and ' +
        'the Railway service\'s env (a one-sided secret rotation causes exactly ' +
        'this), then check the forward loop in the service logs.';
    }
    const embed = alertEmbed(reasonLine);
    const result = { ok: false, stale, pollStale, authStale, health,
                     pollAgeMs: pollAge, authAgeMs: authAge,
                     alerted: true, channel: false, dm: false };

    // 1) ⚙️│bot-admin embed. Best-effort.
    try {
      const channelId = String(env.AQUILO_ADMIN_HUB_CHANNEL_ID || '').trim();
      if (channelId && env.DISCORD_BOT_TOKEN) {
        const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
          method: 'POST',
          headers: {
            Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
        });
        result.channel = r.ok;
      }
    } catch { /* best-effort */ }

    // 2) DM Clay. Same delivery util push-dm.js uses; failures (closed
    // DMs, 50007) are swallowed — the channel embed is the backstop.
    try {
      const { sendDm } = await import('./aquilo/util.js');
      await sendDm(env, CLAY_DISCORD_ID, { embeds: [embed] });
      result.dm = true;
    } catch { /* best-effort */ }

    return result;
  } catch (e) {
    // Absolute backstop: the watchdog must never take the cron down.
    try { console.warn('[gateway-watchdog]', e && e.message || e); } catch { /* ignore */ }
    return { ok: false, error: String(e && e.message || e) };
  }
}
