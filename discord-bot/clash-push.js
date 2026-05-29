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

// Contract aligned with aquilo-site's functions/api/push/external.js:
//   secret env name:  AQUILO_SITE_WEB_SECRET   (same secret that gates
//                     /api/push/queue-open and other site<->bot
//                     callbacks — one secret to rotate, not one per
//                     route)
//   request headers:  x-aquilo-web-ts  (unix seconds)
//                     x-aquilo-web-sig (hex sha256("${ts}\n${rawBody}"))
//   skew window:      ±5 min
//
// `audience.userIds` (Discord user IDs) is honoured by aquilo-site:
// the push fan-out filters to identity-linked subscriptions whose
// stored Discord ID is in the list. Subscriptions without a linked
// Discord ID are NEVER included in a filtered audience — that's the
// correct privacy default. When `audience.userIds` is empty/absent
// the fan-out goes to every subscriber, matching the stream.online
// "live now" broadcast.
const PUSH_URL_FALLBACK = 'https://aquilo.gg/api/push/external';

// Map kind -> bit index in the clash:notify mask. Must match the
// NOTIFY_KINDS array order in clash-state.js.
const KIND_BIT = {
  'clash.raid.incoming':  0,
  'clash.raid.lost':      1,
  'clash.raid.won':       2,
  'clash.raid.result':    3,
  'clash.build.complete': 4,
  'clash.war.declared':   5,
  'clash.war.ended':      6,
  'clash.shield.expiring':7,
};

// Resolve the list of opted-in Discord userIds for a given (guildId,
// kind). The default mask is "all bits on" (NOTIFY_DEFAULT_MASK in
// clash-state.js), so any viewer who hasn't called /clash notify
// counts as subscribed. The aquilo-site side doesn't filter by
// userId yet — current `push:sub:*` records aren't linked to Discord
// identities — but we send the list in the `audience.userIds` field
// so the other session's plumbing change can adopt it immediately.
async function resolveOptedInUserIds(env, guildId, kind) {
  const bit = KIND_BIT[kind];
  if (bit === undefined) return [];
  const out = [];
  let cursor;
  for (let i = 0; i < 3; i++) {
    const r = await env.LOADOUT_BOLTS.list({
      prefix: `clash:notify:${guildId}:`, cursor, limit: 1000,
    });
    for (const k of r.keys) {
      const userId = k.name.split(':')[3];
      const rec = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
      const mask = rec?.mask ?? 0b11111111;
      if ((mask >> bit) & 1) out.push(userId);
    }
    if (r.list_complete) break;
    cursor = r.cursor;
  }
  return out;
}

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

// Fire a Clash event push. event.kind ∈ NOTIFY_KINDS in clash-state.js.
// `title` and `body` are the notification text; `url` is the deep link
// (usually back to a Clash UI surface).
//
// Returns { ok, sent? } — failures are logged but never throw, because
// a push outage shouldn't break a slash command response.
export async function firePush(env, event) {
  // The shared site<->bot HMAC secret. Same secret that gates the
  // queue-open and other aquilo-site callbacks — one rotation point.
  // CLASH_PUSH_SECRET is honoured as a fallback so we don't break
  // deploys that set the earlier name; the value should match what
  // aquilo-site has stored in AQUILO_SITE_WEB_SECRET.
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
    url: event.url || 'https://aquilo.gg/clash/',
    // Optional audience hints — the receiver MAY use these later when
    // the push:sub:* records get identity-linked. For Phase 1 the
    // endpoint just calls pushToAll().
    audience: event.audience || { kind: 'all' },
    guildId: event.guildId || null,
    raidId: event.raidId || null,
    // Push-subscription tag, e.g. "clashRaids" (default at the
    // receiver) or "stocksAlert" for the price-alert path. The site's
    // /api/push/external endpoint reads body.tag and passes it to
    // pushToAll, which drops subscriptions where tags[<tag>] === false.
    tag: event.tag || null,
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

export const pushRaidIncoming = async (env, { guildId, attackerName, townName }) =>
  firePush(env, {
    kind: 'clash.raid.incoming',
    title: `${townName || 'Your town'} is being raided`,
    body: `${attackerName || 'A raider'} just hit your town.`,
    url: `https://aquilo.gg/clash/town/${guildId}/`,
    audience: { kind: 'town', guildId, userIds: await resolveOptedInUserIds(env, guildId, 'clash.raid.incoming') },
    guildId,
  });

export const pushRaidDefended = async (env, { guildId, attackerName, stars, townName }) =>
  firePush(env, {
    kind: 'clash.raid.lost',
    title: `${townName || 'Your town'} held the line`,
    body: `${attackerName || 'A raider'} only managed ${stars}★.`,
    url: `https://aquilo.gg/clash/town/${guildId}/`,
    audience: { kind: 'town', guildId, userIds: await resolveOptedInUserIds(env, guildId, 'clash.raid.lost') },
    guildId,
  });

export const pushRaidSacked = async (env, { guildId, attackerName, stars, townName }) =>
  firePush(env, {
    kind: 'clash.raid.won',
    title: `${townName || 'Your town'} was raided!`,
    body: `${attackerName || 'A raider'} hit you for ${stars}★. Loot was taken from the treasury.`,
    url: `https://aquilo.gg/clash/town/${guildId}/`,
    audience: { kind: 'town', guildId, userIds: await resolveOptedInUserIds(env, guildId, 'clash.raid.won') },
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

// Personal troop training finished — distinct from a town build so the
// PWA can route to the right surface and render the right title/body.
// 2026-05-29 fix: previously this routed through pushBuildComplete,
// which sends kind='clash.build.complete' and a generic body. The site
// couldn't discriminate, so its title classifier was falling back to
// the wrong header.
export const pushTroopTrained = (env, { guildId, userId, count, troopName }) =>
  firePush(env, {
    kind: 'clash.troops-trained',
    title: 'Training complete',
    body: count && troopName
      ? `Your ${count}× ${troopName} finished training.`
      : 'Your troops finished training.',
    url: 'https://aquilo.gg/clash/town/' + (guildId || '') + '/',
    audience: userId ? { kind: 'user', userId } : { kind: 'town', guildId },
    guildId,
  });

// Gather task finished — also distinct so the PWA can show a resource
// icon instead of a building icon. Previously also misrouted through
// pushBuildComplete with kind='personal'.
export const pushGatherComplete = (env, { guildId, userId, resource, yield: amount, tier }) =>
  firePush(env, {
    kind: 'clash.gather.complete',
    title: 'Gather complete',
    body: resource && amount
      ? `Gathered ${amount} ${resource}${tier ? ` (${tier})` : ''}.`
      : 'A gather task finished.',
    url: 'https://aquilo.gg/clash/town/' + (guildId || '') + '/',
    audience: userId ? { kind: 'user', userId } : { kind: 'town', guildId },
    guildId,
  });

// Achievement unlocked — distinct kind so the site renders its own
// "Achievement unlocked" header + trophy icon instead of falling
// through whatever generic notification template it lands on.
// 2026-05-29 fix: previously this routed through pushBuildComplete,
// which (a) sent the wrong kind and (b) the body landed on the
// non-town else branch — "Your troop training finished." — when an
// achievement unlocked. Both symptoms in Clay's bug report.
export const pushAchievementUnlocked = (env, { userId, achTitle, achDescription, rarity }) =>
  firePush(env, {
    kind: 'achievement.unlocked',
    title: 'Achievement unlocked',
    body: achDescription
      ? `${achTitle} — ${achDescription}`
      : (achTitle || 'You earned a new achievement.'),
    url: 'https://aquilo.gg/profile/',
    audience: { kind: 'user', userId },
    rarity: rarity || null,
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

// ── Goblin raid pushes (E2) ──────────────────────────────────────────
//
// Goblin raids land asynchronously throughout the day; the push is
// the viewer's signal that something happened. Routes through the
// existing clash.raid.lost / clash.raid.won notify kinds — re-using
// the bitmask keeps notify config simple. Warband raids escalate to
// a stronger title so streamers know to log in.

export const pushGoblinRaidResult = async (env, { guildId, stars, label, isWarband, stolen }) => {
  const stolenText = stolen && Object.keys(stolen).length
    ? Object.entries(stolen).map(([k, v]) => `${v} ${k}`).join(', ')
    : null;
  const lost = stars > 0;
  return firePush(env, {
    kind: lost ? 'clash.raid.won' : 'clash.raid.lost',
    title: lost
      ? `${isWarband ? '👑 Warband' : 'Goblins'} sacked your town — ${stars}★`
      : `${isWarband ? '👑 Warband repelled' : 'Goblin raid repelled'}`,
    body: lost
      ? (stolenText ? `Stolen: ${stolenText}. Repair damage with /clash repair.` : 'Repair damage with /clash repair.')
      : 'Your defenses held. No loot lost.',
    url: `https://aquilo.gg/clash/town/${guildId}/`,
    audience: { kind: 'town', guildId, userIds: await resolveOptedInUserIds(env, guildId, lost ? 'clash.raid.won' : 'clash.raid.lost') },
    guildId,
  });
};

// ── War push helpers (Phase 2) ───────────────────────────────────────
//
// All war pushes route through the existing clash.war.declared /
// clash.war.ended notify kinds — the bitmask in clash-state.js doesn't
// need a new slot for accept/refuse/cancel since those all happen
// inside the same "declared war" lifecycle the viewer already opted
// into.

export const pushWarDeclared = (env, { attackerGuildId, defenderGuildId }) =>
  firePush(env, {
    kind: 'clash.war.declared',
    title: `War declared against your town`,
    body: 'Another community wants to raid your town. Vote to accept or refuse — open /clash war view.',
    url: `https://aquilo.gg/clash/town/${defenderGuildId}/`,
    audience: { kind: 'town', guildId: defenderGuildId },
    guildId: defenderGuildId,
    attackerGuildId,
  });

export const pushWarAccepted = (env, { attackerGuildId, defenderGuildId, endsUtc }) =>
  firePush(env, {
    kind: 'clash.war.declared',
    title: `Your war was accepted`,
    body: 'The 24h war window is open — raid for amplified rewards.',
    url: `https://aquilo.gg/clash/town/${attackerGuildId}/`,
    audience: { kind: 'town', guildId: attackerGuildId },
    guildId: attackerGuildId,
    defenderGuildId,
    endsUtc,
  });

export const pushWarRefused = (env, { attackerGuildId, defenderGuildId }) =>
  firePush(env, {
    kind: 'clash.war.declared',
    title: `Your war was refused`,
    body: 'The target community voted to refuse the war. Cooldown applies before you can declare again.',
    url: `https://aquilo.gg/clash/town/${attackerGuildId}/`,
    audience: { kind: 'town', guildId: attackerGuildId },
    guildId: attackerGuildId,
    defenderGuildId,
  });

export const pushWarCancelled = (env, { attackerGuildId, reason }) =>
  firePush(env, {
    kind: 'clash.war.declared',
    title: `Your war declaration was cancelled`,
    body: reason || 'Not enough community votes to declare.',
    url: `https://aquilo.gg/clash/town/${attackerGuildId}/`,
    audience: { kind: 'town', guildId: attackerGuildId },
    guildId: attackerGuildId,
  });

export const pushWarEnded = (env, { winnerGuildId, loserGuildId, scores, coresTribute }) =>
  firePush(env, {
    kind: 'clash.war.ended',
    title: `War ended — ${scores.attacker}★ vs ${scores.defender}★`,
    body: `Winner: <#${winnerGuildId}>. Tribute: +${coresTribute}⚙ to treasury, Victorious banner for 7 days.`,
    url: `https://aquilo.gg/clash/town/${winnerGuildId}/`,
    // Both communities should see this — broadcast to all subscribers.
    audience: { kind: 'all' },
    winnerGuildId,
    loserGuildId,
  });
