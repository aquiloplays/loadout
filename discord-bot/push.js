// PWA push notifications, shared fan-out helper.
//
// The Loadout Worker fires events to the aquilo.gg push pipeline over a
// single HMAC-signed POST. The aquilo-site `/api/push/external` endpoint
// receives the call, verifies the HMAC against AQUILO_SITE_WEB_SECRET,
// and fans out via the existing pushToAll() helper in
// aquilo-site/functions/_lib/push.js.
//
// Contract aligned with aquilo-site's functions/api/push/external.js:
//   secret env name:  AQUILO_SITE_WEB_SECRET   (same secret that gates
//                     /api/push/queue-open and other site<->bot
//                     callbacks, one secret to rotate, not one per
//                     route)
//   request headers:  x-aquilo-web-ts  (unix seconds)
//                     x-aquilo-web-sig (hex sha256("${ts}\n${rawBody}"))
//   skew window:      ±5 min
//
// `audience.userIds` (Discord user IDs) is honoured by aquilo-site:
// the push fan-out filters to identity-linked subscriptions whose
// stored Discord ID is in the list. Subscriptions without a linked
// Discord ID are NEVER included in a filtered audience, that's the
// correct privacy default. When `audience.userIds` is empty/absent
// the fan-out goes to every subscriber, matching the stream.online
// "live now" broadcast.
const PUSH_URL_FALLBACK = 'https://aquilo.gg/api/push/external';

// HMAC-sign + POST. Header names match aquilo-site's
// functions/api/push/external.js (x-aquilo-web-ts / x-aquilo-web-sig).
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

// Fire an event push. `title` and `body` are the notification text;
// `url` is the deep link. Returns { ok, sent? }, failures are logged
// but never throw, because a push outage shouldn't break a slash
// command response.
export async function firePush(env, event) {
  // The shared site<->bot HMAC secret. Same secret that gates the
  // queue-open and other aquilo-site callbacks, one rotation point.
  const secret = env.AQUILO_SITE_WEB_SECRET || env.CLASH_PUSH_SECRET;
  if (!secret) {
    // Push not configured (likely a dev deploy). Skip silently.
    return { ok: false, reason: 'no-secret' };
  }
  const url = env.AQUILO_PUSH_URL || PUSH_URL_FALLBACK;
  const payload = {
    kind: event.kind,
    title: event.title || 'aquilo.gg',
    body: event.body || '',
    url: event.url || 'https://aquilo.gg/',
    // Optional audience hints, the receiver MAY use these later when
    // the push:sub:* records get identity-linked. Today the endpoint
    // just calls pushToAll() (filtered by audience.userIds when set).
    audience: event.audience || { kind: 'all' },
    guildId: event.guildId || null,
    // Push-subscription tag, e.g. "stocksAlert" for the price-alert
    // path. The site's /api/push/external endpoint reads body.tag and
    // passes it to pushToAll, which drops subscriptions where
    // tags[<tag>] === false.
    tag: event.tag || null,
    ts: Date.now(),
  };
  try {
    const res = await signedPost(secret, url, payload);
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.warn('[push] non-2xx:', res.status, txt.slice(0, 200));
      return { ok: false, status: res.status };
    }
    const data = await res.json().catch(() => ({}));
    return { ok: true, sent: data?.sent ?? null };
  } catch (e) {
    console.warn('[push] fetch failed:', e && e.message);
    return { ok: false, reason: 'fetch-failed' };
  }
}

export const pushAchievementUnlocked = (env, { userId, achTitle, achDescription, rarity }) =>
  firePush(env, {
    kind: 'achievement.unlocked',
    title: 'Achievement unlocked',
    body: achDescription
      ? `${achTitle}, ${achDescription}`
      : (achTitle || 'You earned a new achievement.'),
    url: 'https://aquilo.gg/profile/',
    // Must be { userIds: [...] } — the site's /api/push/external only honors
    // an explicit userIds allow-list; a bare { kind:'user', userId } has no
    // userIds array, so pushToAll falls through to a broadcast-to-everyone.
    audience: userId ? { kind: 'users', userIds: [String(userId)] } : { kind: 'all' },
    rarity: rarity || null,
  });
