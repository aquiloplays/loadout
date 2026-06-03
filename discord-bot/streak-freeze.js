// Streak Freeze items, Duolingo-style streak protection.
//
// Two types, deliberately separate because the two streaks are independent:
//   - "stream"  protects the Twitch stream check-in streak in
//                checkin:<guild>:<userId> where userId is `tw:<twitchId>`
//                for panel viewers (see ext.js resolveLoadoutUserId).
//   - "discord" protects the unified daily community check-in streak in
//                community-checkin:<g>:<u>, keyed by Discord user id.
//                Consumed by community-checkin.js's recordCheckin() when
//                delta > 1 ET-day. (Previously protected the retired
//                aquilo-bot pic/gif check-in's D1 table, the freeze
//                stockpile carries over since the KV identity is the same
//                bare Discord user id.)
//
// Storage: ONE KV entry per identity holds both counts.
//   freeze:<guildId>:<userId>  ->  { stream: N, discord: M, lastBoughtUtc: T }
//
//   Where <userId> is whatever identity owns the wallet that paid for the
//   freeze. For panel viewers that's `tw:<twId>`; for Discord users that's
//   the bare Discord user id. The consume call uses the same identity that
//   the streak itself is keyed under, so namespaces stay aligned without
//   needing a tw<->discord link (which we don't have yet).
//
// Auto-consume model:
//   - Stream streak: at next Twitch check-in attempt, if since >= 48h AND
//     the user holds >= 1 stream freeze, we consume one and preserve the
//     existing streak instead of resetting to 1.
//   - Discord streak: at next /checkin (slash command) or POST /web/checkin,
//     if delta-days > 1 AND the user holds >= 1 discord freeze,
//     community-checkin.js consumes one in-process and preserves the streak.
//
// Stockpile cap: 3 per type. Once at cap, buying another fails with a
// clear message. Prevents one big buy from making streaks meaningless.

const FREEZE_KEY = (g, u) => 'freeze:' + g + ':' + u;

export const FREEZE_TYPES = ['stream', 'discord'];
export const MAX_FREEZES_PER_TYPE = 3;

// Price tuning: rotation shop items typically run 30-500 bolts. A freeze
// protects significant invested effort (a 30-day streak earns ~150 bolts
// just on milestones, plus the underlying daily payout) so this should
// hurt enough to feel like a deliberate purchase but be affordable to a
// regular check-in-er. 250 bolts puts max stockpile cost at 750/type.
export const FREEZE_PRICE = 250;

export async function getFreezes(env, guildId, userId) {
  const raw = await env.LOADOUT_BOLTS.get(FREEZE_KEY(guildId, userId), { type: 'json' });
  return {
    stream:  Math.max(0, Number((raw && raw.stream)  || 0)),
    discord: Math.max(0, Number((raw && raw.discord) || 0)),
    lastBoughtUtc: (raw && raw.lastBoughtUtc) || 0,
  };
}

async function putFreezes(env, guildId, userId, f) {
  await env.LOADOUT_BOLTS.put(FREEZE_KEY(guildId, userId), JSON.stringify({
    stream:  f.stream,
    discord: f.discord,
    lastBoughtUtc: f.lastBoughtUtc || 0,
  }));
}

// Add a freeze. Returns { ok, count, reason? }.
// Cap-enforced -- caller is responsible for the bolts debit.
export async function addFreeze(env, guildId, userId, type) {
  if (!FREEZE_TYPES.includes(type)) return { ok: false, reason: 'bad-type' };
  const f = await getFreezes(env, guildId, userId);
  if ((f[type] || 0) >= MAX_FREEZES_PER_TYPE) {
    return { ok: false, reason: 'cap', count: f[type] };
  }
  f[type] = (f[type] || 0) + 1;
  f.lastBoughtUtc = Date.now();
  await putFreezes(env, guildId, userId, f);
  return { ok: true, count: f[type] };
}

// Consume one freeze of the given type. Returns { consumed, remaining }.
// Never throws; the streak-resolve path treats missing/insufficient as
// "no protection -- streak resets normally."
export async function consumeFreeze(env, guildId, userId, type) {
  if (!FREEZE_TYPES.includes(type)) return { consumed: false, remaining: 0 };
  const f = await getFreezes(env, guildId, userId);
  if ((f[type] || 0) <= 0) return { consumed: false, remaining: 0 };
  f[type] -= 1;
  await putFreezes(env, guildId, userId, f);
  return { consumed: true, remaining: f[type] };
}

// HMAC-gated cross-Worker endpoint. aquilo-bot calls this when its
// Discord check-in handler detects a streak-break and needs to know
// whether to protect.
//
// Reuses the LOADOUT_BOLT_API_SECRET shared secret (same one
// counting.js already uses via X-Counting-Secret) so no new key
// management.
//
// Request body: { guildId, userId, type }
// Response: { ok, consumed, remaining } on success;
//            HTTP 401/400/500 on auth/shape/error.
export async function handleStreakFreezeConsume(req, env) {
  const expected = env.LOADOUT_BOLT_API_SECRET;
  if (!expected) return new Response('endpoint not provisioned', { status: 503 });
  const got = req.headers.get('x-counting-secret');
  if (got !== expected) return new Response('bad secret', { status: 401 });

  let body;
  try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }
  const guildId = String(body.guildId || body.guild_id || '');
  const userId  = String(body.userId  || body.user_id  || '');
  const type    = String(body.type    || 'discord');
  if (!guildId || !userId) {
    return new Response('guildId, userId required', { status: 400 });
  }
  if (!FREEZE_TYPES.includes(type)) {
    return new Response('bad type', { status: 400 });
  }
  const r = await consumeFreeze(env, guildId, userId, type);
  return new Response(JSON.stringify({ ok: true, ...r }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// Read-only inspector for the dashboard / hub. HMAC-gated identically.
export async function handleStreakFreezeRead(req, env) {
  const expected = env.LOADOUT_BOLT_API_SECRET;
  if (!expected) return new Response('endpoint not provisioned', { status: 503 });
  const got = req.headers.get('x-counting-secret');
  if (got !== expected) return new Response('bad secret', { status: 401 });
  const url = new URL(req.url);
  const guildId = String(url.searchParams.get('guildId') || url.searchParams.get('guild_id') || '');
  const userId  = String(url.searchParams.get('userId')  || url.searchParams.get('user_id')  || '');
  if (!guildId || !userId) return new Response('guildId, userId required', { status: 400 });
  const f = await getFreezes(env, guildId, userId);
  return new Response(JSON.stringify({ ok: true, stream: f.stream, discord: f.discord }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
