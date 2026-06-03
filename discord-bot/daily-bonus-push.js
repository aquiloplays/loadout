// Consolidated daily-bonus push.
//
// Fires ONE PWA push per UTC day (~8 AM EST / 5 AM PST) reminding
// subscribers that the day's bonuses are claimable again:
//   - Loadout daily reward
//   - Boltbound free pack
//   - Daily check-in
//   - Daily missions
//
// Wiring: piggybacks on the hourly `:23` cron in worker.js. The
// once-per-day fire is gated by a KV marker (`daily-bonus-push:YYYYMMDD`),
// so as long as ONE :23 tick lands during the eligibility window each
// day, the push goes out exactly once. The eligibility window is "any
// :23 tick at UTC hour 13 or later, up to 23", this gives us many
// chances to fire even if the cron skips a tick, while still being
// late enough that all the daily resets we summarise have actually
// happened (boltbound resets at 00:00 UTC, loadout daily resets at
// midnight ET = 04:00-05:00 UTC, so 13:00 UTC is the safe floor).
//
// The push reaches subscribers via aquilo-site /api/push/external,
// gated by AQUILO_SITE_WEB_SECRET (the same shared HMAC secret
// clash-push.js uses). Subscribers can opt out of the "dailyBonus"
// tag in NotificationPrefs, fan-out drops opt-outs server-side.

const PUSH_URL_FALLBACK = 'https://aquilo.gg/api/push/external';
const KV_MARKER_PREFIX = 'daily-bonus-push:';
// Earliest UTC hour at which the daily push is eligible to fire.
// Boltbound daily pack resets at 00:00 UTC, loadout daily resets at
// midnight ET (04-05 UTC). 13:00 UTC ≈ 8 AM EST / 5 AM PST, early
// enough to catch a US morning routine, late enough that everyone's
// resets are in the past.
const FIRE_HOUR_UTC = 13;

function utcDateKey(now) {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

async function signedPost(secret, url, payloadObj) {
  const body = JSON.stringify(payloadObj);
  const ts = String(Math.floor(Date.now() / 1000));
  const message = ts + '\n' + body;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  const sigHex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type':    'application/json',
      'x-aquilo-web-ts':  ts,
      'x-aquilo-web-sig': sigHex,
    },
    body,
  });
}

/**
 * Cron tick: idempotent. Call from the :23 hourly handler. Bails
 * silently if it's too early in the UTC day, if the push already
 * fired today, or if no shared HMAC secret is configured.
 */
export async function dailyBonusCronTick(env) {
  const now = Date.now();
  const hour = new Date(now).getUTCHours();
  if (hour < FIRE_HOUR_UTC) return { fired: false, reason: 'early' };

  const marker = KV_MARKER_PREFIX + utcDateKey(now);
  const kv = env.LOADOUT_BOLTS;
  if (!kv) return { fired: false, reason: 'no-kv' };

  // Idempotence: first :23 tick at or after 13 UTC wins; later ticks
  // see the marker and bail.
  try {
    const existing = await kv.get(marker);
    if (existing) return { fired: false, reason: 'already-fired' };
  } catch {
    /* keep going, failing closed means we never push */
  }

  const secret = env.AQUILO_SITE_WEB_SECRET || env.CLASH_PUSH_SECRET;
  if (!secret) return { fired: false, reason: 'no-secret' };

  const url = env.AQUILO_PUSH_URL || PUSH_URL_FALLBACK;
  const payload = {
    kind: 'daily.bonus.ready',
    title: 'Daily bonuses are ready',
    body: 'Free Boltbound pack, Loadout daily, check-in, and missions all reset, claim them before they reset again.',
    url: 'https://aquilo.gg/play/',
    audience: { kind: 'all' },
    tag: 'dailyBonus',
    ts: now,
  };

  try {
    const res = await signedPost(secret, url, payload);
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.warn('[daily-bonus-push] non-2xx:', res.status, txt.slice(0, 200));
      // Do NOT write the marker on failure, let the next :23 tick retry.
      return { fired: false, reason: 'http-' + res.status };
    }
    // Mark fired AFTER the push succeeded so a transient failure
    // doesn't suppress today's only attempt. TTL = 36h so the marker
    // is gone before the next firing window opens (tomorrow's
    // marker has a different key anyway, but a TTL keeps KV from
    // accumulating dead markers).
    try {
      await kv.put(marker, String(now), { expirationTtl: 36 * 60 * 60 });
    } catch { /* non-fatal */ }
    const data = await res.json().catch(() => ({}));
    return { fired: true, sent: data?.sent ?? null };
  } catch (e) {
    console.warn('[daily-bonus-push] fetch failed:', e && e.message);
    return { fired: false, reason: 'fetch-failed' };
  }
}
