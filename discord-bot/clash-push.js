// Clash — PWA push notifications.
//
// The Loadout Worker fires Clash events to the aquilo.gg push pipeline
// over a single HMAC-signed POST. The aquilo-site `/api/push/external`
// endpoint receives the call, verifies the HMAC against
// CLASH_PUSH_SECRET, and fans out via the existing pushToAll() helper
// in aquilo-site/functions/_lib/push.js.
//
// Per-viewer opt-in (clash:notify:<guildId>:<userId>) is recorded today
// but not yet enforced at fan-out — the existing push:sub:* keys in
// aquilo-site aren't linked to a Discord/Twitch identity, so we can't
// filter by Discord user yet. Plumbing the link is Phase 2+ work.
// Phase 1 ships with the broader "all subscribers see Clash pushes"
// behaviour, matching how stream.online notifications already work.

const PUSH_URL_FALLBACK = 'https://aquilo.gg/api/push/external';

// HMAC-sign + POST. ts:body envelope matches the auth.js verifyHmac
// pattern the wallet sync calls already use (worker.js:13).
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
      'content-type': 'application/json',
      'x-aquilo-ts':  ts,
      'x-aquilo-sig': sigHex,
    },
    body,
  });
}

// Fire a Clash event push. event.kind ∈ NOTIFY_KINDS in clash-state.js.
// `title` and `body` are the notification text; `url` is the deep link
// (usually back to a Clash UI surface).
//
// Returns { ok, sent? } — failures are logged but never throw, because
// a push outage shouldn't break a slash command response.
export async function firePush(env, event) {
  const secret = env.CLASH_PUSH_SECRET;
  if (!secret) {
    // Push not configured (likely a dev deploy). Skip silently.
    return { ok: false, reason: 'no-secret' };
  }
  const url = env.AQUILO_PUSH_URL || PUSH_URL_FALLBACK;
  const payload = {
    kind: event.kind,
    title: event.title || 'aquilo.gg',
    body: event.body || '',
    url: event.url || 'https://aquilo.gg/clash/',
    // Optional audience hints — the receiver MAY use these later when
    // the push:sub:* records get identity-linked. For Phase 1 the
    // endpoint just calls pushToAll().
    audience: event.audience || { kind: 'all' },
    guildId: event.guildId || null,
    raidId: event.raidId || null,
    ts: Date.now(),
  };
  try {
    const res = await signedPost(secret, url, payload);
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.warn('[clash-push] non-2xx:', res.status, txt.slice(0, 200));
      return { ok: false, status: res.status };
    }
    const data = await res.json().catch(() => ({}));
    return { ok: true, sent: data?.sent ?? null };
  } catch (e) {
    console.warn('[clash-push] fetch failed:', e && e.message);
    return { ok: false, reason: 'fetch-failed' };
  }
}

// Convenience helpers — one per event kind. Centralised here so the
// title/body templates live in one file instead of scattered through
// the raid resolver, the queue completer, etc.

export const pushRaidIncoming = (env, { guildId, attackerName, townName }) =>
  firePush(env, {
    kind: 'clash.raid.incoming',
    title: `${townName || 'Your town'} is being raided`,
    body: `${attackerName || 'A raider'} just hit your town.`,
    url: `https://aquilo.gg/clash/town/${guildId}/`,
    audience: { kind: 'town', guildId },
    guildId,
  });

export const pushRaidDefended = (env, { guildId, attackerName, stars, townName }) =>
  firePush(env, {
    kind: 'clash.raid.lost',     // "raid against you was lost (by attacker)" -> town defended
    title: `${townName || 'Your town'} held the line`,
    body: `${attackerName || 'A raider'} only managed ${stars}★.`,
    url: `https://aquilo.gg/clash/town/${guildId}/`,
    audience: { kind: 'town', guildId },
    guildId,
  });

export const pushRaidSacked = (env, { guildId, attackerName, stars, townName }) =>
  firePush(env, {
    kind: 'clash.raid.won',      // "raid against you was won (by attacker)" -> town sacked
    title: `${townName || 'Your town'} was raided!`,
    body: `${attackerName || 'A raider'} hit you for ${stars}★. Loot was taken from the treasury.`,
    url: `https://aquilo.gg/clash/town/${guildId}/`,
    audience: { kind: 'town', guildId },
    guildId,
  });

export const pushRaidResult = (env, { userId, stars, targetName, voltaic }) =>
  firePush(env, {
    kind: 'clash.raid.result',
    title: stars > 0 ? `Raid on ${targetName || 'target'} succeeded — ${stars}★` : `Raid on ${targetName || 'target'} failed`,
    body: voltaic ? `You picked up a Voltaic drop: ${voltaic[2]}` : (stars > 0 ? 'Loot was added to your wallet.' : 'No loot this time.'),
    url: 'https://aquilo.gg/clash/',
    audience: { kind: 'user', userId },
  });

export const pushBuildComplete = (env, { guildId, userId, kind, name }) =>
  firePush(env, {
    kind: 'clash.build.complete',
    title: `${name || 'Build'} ready`,
    body: kind === 'town' ? 'Your town finished a build.' : 'Your troop training finished.',
    url: 'https://aquilo.gg/clash/',
    audience: userId ? { kind: 'user', userId } : { kind: 'town', guildId },
    guildId,
  });

export const pushShieldExpiring = (env, { guildId, townName, minutesLeft }) =>
  firePush(env, {
    kind: 'clash.shield.expiring',
    title: `${townName || 'Your town'}'s shield ends in ${minutesLeft} min`,
    body: 'Prep your defenses — raids will be allowed again soon.',
    url: `https://aquilo.gg/clash/town/${guildId}/`,
    audience: { kind: 'town', guildId },
    guildId,
  });
