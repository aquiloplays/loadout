// Anniversary celebrations, cross-cutting premium feature.
//
// 2026-05-30 sprint. Tracks each linked user's "firstSeen" date and,
// on the yearly anniversary of that date, lets them claim a one-time
// reward (scaling bolts + a cosmetic anniversary badge for year N) and
// fires a celebratory Discord post in the games-hub channel.
//
// Namespaced under `anniv:*` KV keys so nothing here collides with the
// existing engagement / referral / quest code. The cosmetic badge is
// granted into the shared `pbadge:<userId>` inventory (same store the
// monthly-cosmetic-grant uses) with a stable `anniversary-yN` id so
// re-grants are idempotent and the site's /web/play/cosmetics/me
// surface picks them up for free.
//
// KV layout (all on LOADOUT_BOLTS):
//   anniv:seen:<g>:<u>            -> firstSeenUtc (number, ms epoch)
//   anniv:claimed:<g>:<u>:<year>  -> { claimedUtc, bolts, badgeId } (per-year idempotency)
//   anniv:cron:last-sweep         -> 'YYYY-MM-DD' (once-per-UTC-day cron marker)
//
// firstSeen is the authority on when a user joined the community.
// recordFirstSeen() is called from activity hooks going forward and
// keeps the *earliest* timestamp ever observed (min-wins). Legacy
// users with no record get backfilled by backfillFirstSeen(), which
// walks the wallet keyspace and uses the earliest activity timestamp
// stamped on the wallet as a conservative lower-bound proxy (a user
// who earned/claimed at time T was, by definition, "seen" no later
// than T). Where the wallet carries no timestamp at all, the backfill
// stamps the run moment, anniversaries for those users start counting
// from the backfill, which is the best we can recover.

import { earn } from './wallet.js';

const KEY_SEEN    = (g, u)    => `anniv:seen:${g}:${u}`;
const KEY_CLAIMED = (g, u, y) => `anniv:claimed:${g}:${u}:${y}`;
const CRON_MARKER = 'anniv:cron:last-sweep';

// Cosmetic badge granted per year. Stored in the shared pbadge store.
const KEY_USER_BADGES = (u) => `pbadge:${u}`;

// Default games-hub channel for the celebratory post. Overridable via
// the `anniversary` channel-binding (KV-only, see channel-bindings.js).
const GAMES_HUB_CHANNEL_ID = '1507973935973531808';

// Day in ms, anniversary math is all UTC-calendar-day based.
const DAY_MS = 24 * 60 * 60 * 1000;

// ── firstSeen tracking ────────────────────────────────────────────

export async function getFirstSeen(env, guildId, userId) {
  if (!guildId || !userId) return null;
  const raw = await env.LOADOUT_BOLTS.get(KEY_SEEN(guildId, userId));
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Idempotent, min-wins. Records `whenUtc` (defaults to now) as the
// user's firstSeen unless an earlier value is already stored. Safe to
// call on every activity event, it only writes when it actually
// moves the timestamp earlier (or sets it the first time).
export async function recordFirstSeen(env, guildId, userId, whenUtc) {
  if (!guildId || !userId) return { ok: false, error: 'bad-args' };
  const when = Number.isFinite(whenUtc) && whenUtc > 0 ? Math.floor(whenUtc) : Date.now();
  const existing = await getFirstSeen(env, guildId, userId);
  if (existing != null && existing <= when) {
    return { ok: true, firstSeenUtc: existing, changed: false };
  }
  await env.LOADOUT_BOLTS.put(KEY_SEEN(guildId, userId), String(when));
  return { ok: true, firstSeenUtc: when, changed: true };
}

// Backfill legacy users. Walks wallet:<g>: keys; for any user without
// an anniv:seen record, derives the earliest known activity timestamp
// from the wallet and stamps it. Bounded to `maxPages` KV-list pages
// (1000 keys each) per call so a huge guild doesn't blow the 10ms CPU
// budget, re-run to continue (idempotent: already-stamped users are
// skipped). Returns counts.
export async function backfillFirstSeen(env, guildId, opts = {}) {
  if (!guildId) return { ok: false, error: 'no-guild' };
  const maxPages = Math.max(1, Math.min(20, opts.maxPages || 6));
  const nowUtc = Number.isFinite(opts.nowUtc) ? opts.nowUtc : Date.now();
  const prefix = `wallet:${guildId}:`;
  let cursor = opts.cursor || undefined, walked = 0, stamped = 0, skipped = 0;
  for (let i = 0; i < maxPages; i++) {
    const page = await env.LOADOUT_BOLTS.list({ prefix, cursor, limit: 1000 });
    for (const k of (page.keys || [])) {
      const userId = k.name.slice(prefix.length);
      if (!userId) continue;
      walked++;
      const existing = await getFirstSeen(env, guildId, userId);
      if (existing != null) { skipped++; continue; }
      const w = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' }).catch(() => null);
      const when = earliestWalletActivity(w, nowUtc);
      await env.LOADOUT_BOLTS.put(KEY_SEEN(guildId, userId), String(when));
      stamped++;
    }
    if (page.list_complete || !page.cursor) { cursor = null; break; }
    cursor = page.cursor;
  }
  return { ok: true, walked, stamped, skipped, more: !!cursor, cursor: cursor || null };
}

// Earliest activity timestamp we can read off a wallet record. These
// are all "last X" fields, so each is an upper bound on first-seen;
// the min across them is the tightest lower-bound proxy available.
// Falls back to `nowUtc` when the wallet carries no timestamp.
function earliestWalletActivity(w, nowUtc) {
  if (!w) return nowUtc;
  const candidates = [w.registeredUtc, w.lastDailyUtc, w.lastEarnUtc, w.lastSpendUtc]
    .map(Number)
    .filter(n => Number.isFinite(n) && n > 0);
  return candidates.length ? Math.min(...candidates) : nowUtc;
}

// ── Anniversary math ──────────────────────────────────────────────

// Milestone years get the celebratory treatment (2× bolts, "milestone"
// flag the UI can render bigger). Year 1 + every 5th year.
export function isMilestoneYear(years) {
  return years === 1 || (years > 0 && years % 5 === 0);
}

// Reward scales with the year. Base 100 bolts/year, doubled on a
// milestone year, capped so a decade-old account doesn't mint a
// fortune. The badge id is stable per year.
export function anniversaryReward(years) {
  const base = Math.min(100 * years, 1000);
  const bolts = isMilestoneYear(years) ? base * 2 : base;
  return { bolts, badgeId: `anniversary-y${years}`, milestone: isMilestoneYear(years) };
}

// Given a firstSeen timestamp and "now", compute the anniversary
// state: how many years the account has existed at the *next* (or
// today's) anniversary, and how many whole UTC days until it lands.
// Returns null only when firstSeen is missing/invalid.
//
//   { years, daysUntil, milestone, anniversaryToday }
//
// `years` is the year-count the upcoming anniversary represents (so on
// the day itself, years = completed years; the day before a 2-year
// mark, years = 2, daysUntil = 1).
export function computeAnniversary(firstSeenUtc, nowUtc) {
  if (!Number.isFinite(firstSeenUtc) || firstSeenUtc <= 0) return null;
  const now = Number.isFinite(nowUtc) ? nowUtc : Date.now();
  const first = new Date(firstSeenUtc);
  const today = new Date(now);

  const fY = first.getUTCFullYear(), fM = first.getUTCMonth(), fD = first.getUTCDate();
  const tY = today.getUTCFullYear(), tM = today.getUTCMonth(), tD = today.getUTCDate();

  // Anniversary in the current calendar year (UTC midnight).
  // Feb-29 birthdays fold onto Mar-1 in non-leap years via Date's
  // natural overflow (new Date(2025, 1, 29) -> Mar 1 2025).
  let annivThisYear = Date.UTC(tY, fM, fD);
  const todayMidnight = Date.UTC(tY, tM, tD);

  let anniversaryToday = false;
  let targetYear;
  if (todayMidnight === annivThisYear) {
    anniversaryToday = true;
    targetYear = tY;
  } else if (todayMidnight < annivThisYear) {
    targetYear = tY;          // anniversary still ahead this calendar year
  } else {
    targetYear = tY + 1;      // already passed, next one is next year
  }

  const targetMidnight = Date.UTC(targetYear, fM, fD);
  const years = targetYear - fY;
  const daysUntil = anniversaryToday
    ? 0
    : Math.round((targetMidnight - todayMidnight) / DAY_MS);

  // A "0th anniversary" (signed up earlier today, same calendar year)
  // is not an anniversary, guard so brand-new users don't see year 0.
  if (years <= 0) {
    // Their first anniversary is next year.
    const nextMidnight = Date.UTC(fY + 1, fM, fD);
    return {
      years: 1,
      daysUntil: Math.max(0, Math.round((nextMidnight - todayMidnight) / DAY_MS)),
      milestone: isMilestoneYear(1),
      anniversaryToday: false,
    };
  }

  return {
    years,
    daysUntil,
    milestone: isMilestoneYear(years),
    anniversaryToday,
  };
}

// ── Read API ──────────────────────────────────────────────────────

// Backs GET/POST /web/anniversary/check. Returns the anniversary state
// for a user, plus whether the current year's reward has already been
// claimed. `null` (wrapped) when the user has no firstSeen yet.
export async function checkAnniversary(env, guildId, userId, opts = {}) {
  const firstSeenUtc = await getFirstSeen(env, guildId, userId);
  if (firstSeenUtc == null) {
    return { ok: true, anniversary: null, firstSeenUtc: null };
  }
  const now = Number.isFinite(opts.nowUtc) ? opts.nowUtc : Date.now();
  const a = computeAnniversary(firstSeenUtc, now);
  if (!a) return { ok: true, anniversary: null, firstSeenUtc };

  let claimed = false;
  if (a.anniversaryToday) {
    const rec = await env.LOADOUT_BOLTS.get(KEY_CLAIMED(guildId, userId, a.years));
    claimed = !!rec;
  }
  return {
    ok: true,
    firstSeenUtc,
    anniversary: {
      years: a.years,
      daysUntil: a.daysUntil,
      milestone: a.milestone,
      anniversaryToday: a.anniversaryToday,
      claimed,
      reward: anniversaryReward(a.years),
    },
  };
}

// ── Write API ─────────────────────────────────────────────────────

async function grantAnniversaryBadge(env, userId, badgeId) {
  const key = KEY_USER_BADGES(userId);
  const rec = (await env.LOADOUT_BOLTS.get(key, { type: 'json' })) || {
    owned: [], firstEarnedUtc: {}, showcase: [],
  };
  if (rec.owned.includes(badgeId)) return { granted: false, alreadyOwned: true };
  rec.owned.push(badgeId);
  rec.firstEarnedUtc[badgeId] = Date.now();
  await env.LOADOUT_BOLTS.put(key, JSON.stringify(rec));
  return { granted: true };
}

// Backs POST /web/anniversary/celebrate. Idempotent per (user, year):
// grants the scaling bolts + cosmetic badge only if today actually is
// the user's anniversary AND that year hasn't been claimed yet.
//
// Returns:
//   { ok: true, granted: true,  years, reward }            first claim today
//   { ok: true, granted: false, reason: 'already-claimed', years }
//   { ok: true, granted: false, reason: 'not-today', anniversary }
//   { ok: false, error: 'no-first-seen' }
export async function celebrateAnniversary(env, guildId, userId, opts = {}) {
  const firstSeenUtc = await getFirstSeen(env, guildId, userId);
  if (firstSeenUtc == null) return { ok: false, error: 'no-first-seen' };
  const now = Number.isFinite(opts.nowUtc) ? opts.nowUtc : Date.now();
  const a = computeAnniversary(firstSeenUtc, now);
  if (!a || !a.anniversaryToday) {
    return { ok: true, granted: false, reason: 'not-today', anniversary: a };
  }

  const claimKey = KEY_CLAIMED(guildId, userId, a.years);
  const prior = await env.LOADOUT_BOLTS.get(claimKey);
  if (prior) {
    return { ok: true, granted: false, reason: 'already-claimed', years: a.years };
  }

  const reward = anniversaryReward(a.years);
  // Stamp the claim BEFORE granting so a retry after a partial failure
  // can't double-pay. (Worst case on a crash mid-grant is a missed
  // reward, which is recoverable; a double-pay is not.)
  await env.LOADOUT_BOLTS.put(claimKey, JSON.stringify({
    claimedUtc: now, bolts: reward.bolts, badgeId: reward.badgeId,
  }));

  await earn(env, guildId, userId, reward.bolts, `anniversary:y${a.years}`);
  const badge = await grantAnniversaryBadge(env, userId, reward.badgeId);

  // Aether economy grant, scales with the anniversary year. Best-effort
  // (no D1 binding in some test envs); never blocks the bolt+badge grant.
  let aether = 0;
  try {
    const { grantAetherForMilestone } = await import('./aether.js');
    const r = await grantAetherForMilestone(env, guildId, userId, 'anniversary',
      { multiplier: a.years });
    if (r.ok) aether = r.balance;
  } catch { /* aether ledger optional */ }

  return {
    ok: true,
    granted: true,
    years: a.years,
    reward: { ...reward, badgeGranted: !!badge.granted, aetherBalance: aether },
  };
}

// ── Discord celebratory post ──────────────────────────────────────

async function targetChannelId(env, guildId) {
  try {
    const { getChannelBinding } = await import('./channel-bindings.js');
    const bound = await getChannelBinding(env, guildId, 'anniversary');
    if (bound) return bound;
  } catch { /* swallow */ }
  return GAMES_HUB_CHANNEL_ID;
}

function buildAnniversaryEmbed(userId, years, milestone) {
  const yearWord = years === 1 ? 'year' : 'years';
  const title = milestone
    ? `🎉 ${years} ${yearWord}, a milestone anniversary!`
    : `🎂 Happy ${years}-${yearWord === 'year' ? 'year' : 'year'} anniversary!`;
  return {
    embeds: [{
      title: title.slice(0, 256),
      description:
        `<@${userId}> has been part of the community for **${years} ${yearWord}** today! 🎈\n\n` +
        `Head to your dashboard to claim your anniversary reward, ` +
        `**bolts${milestone ? ' (doubled for the milestone!)' : ''}** plus an exclusive ` +
        `**Year ${years}** cosmetic badge.`,
      color: milestone ? 0xFFD24A : 0xFF7AC6,
      footer: { text: 'Anniversary celebrations · Aquilo' },
    }],
  };
}

async function discordPost(env, channelId, payload) {
  const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    return { ok: false, status: r.status, detail: txt.slice(0, 200) };
  }
  return { ok: true };
}

// Post the celebratory embed for one user. Best-effort, no-ops when
// the bot token is missing.
export async function announceAnniversary(env, guildId, userId, years, milestone) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  const channelId = await targetChannelId(env, guildId);
  if (!channelId) return { ok: false, error: 'no-channel' };
  return discordPost(env, channelId, buildAnniversaryEmbed(userId, years, milestone));
}

// ── Daily cron sweep ──────────────────────────────────────────────

// Once-per-UTC-day sweep. Walks the anniv:seen keyspace, finds users
// whose anniversary is today, and posts the celebratory embed (once
// per user per year via the anniv:claimed-style announce marker). The
// reward itself is pull-based (the user claims via /celebrate), the
// cron only handles the announcement so the games-hub channel lights
// up even for users who don't open the dashboard.
//
// KV-marker gated so the hourly :23 cron only fires it once per day.
// Bounded to `maxPages` list pages per run.
export async function anniversaryDailyCron(env, opts = {}) {
  const guildId = String(env.AQUILO_VAULT_GUILD_ID || '').trim();
  if (!guildId) return { ok: true, skipped: 'no-guild' };
  const now = Number.isFinite(opts.nowUtc) ? opts.nowUtc : Date.now();
  const today = new Date(now).toISOString().slice(0, 10);

  if (!opts.force) {
    const marker = await env.LOADOUT_BOLTS.get(CRON_MARKER).catch(() => null);
    if (marker === today) return { ok: true, skipped: 'already-ran-today', today };
  }

  const maxPages = Math.max(1, Math.min(20, opts.maxPages || 8));
  const prefix = `anniv:seen:${guildId}:`;
  let cursor, walked = 0, announced = 0;
  const celebrants = [];
  for (let i = 0; i < maxPages; i++) {
    const page = await env.LOADOUT_BOLTS.list({ prefix, cursor, limit: 1000 });
    for (const k of (page.keys || [])) {
      walked++;
      const userId = k.name.slice(prefix.length);
      const firstSeenUtc = await getFirstSeen(env, guildId, userId);
      if (firstSeenUtc == null) continue;
      const a = computeAnniversary(firstSeenUtc, now);
      if (!a || !a.anniversaryToday) continue;
      // Announce-once marker (distinct from the reward claim marker so
      // a user who hasn't claimed still only gets one ping).
      const announceKey = `anniv:announced:${guildId}:${userId}:${a.years}`;
      const already = await env.LOADOUT_BOLTS.get(announceKey).catch(() => null);
      if (already) continue;
      const r = await announceAnniversary(env, guildId, userId, a.years, a.milestone);
      if (r.ok) {
        await env.LOADOUT_BOLTS.put(announceKey, today, { expirationTtl: 60 * 60 * 24 * 7 });
        announced++;
        celebrants.push({ userId, years: a.years, milestone: a.milestone });
        // Fan out to the community-activity SSE feed (best-effort).
        try {
          const { publishActivity } = await import('./activity-do.js');
          await publishActivity(env, { kind: 'anniversary', userId, years: a.years, milestone: a.milestone });
        } catch { /* sse optional */ }
      }
    }
    if (page.list_complete || !page.cursor) { cursor = null; break; }
    cursor = page.cursor;
  }

  // Only stamp the day-marker when we completed the full walk, a
  // truncated run (more pages pending) should re-enter next tick.
  if (!cursor) {
    await env.LOADOUT_BOLTS.put(CRON_MARKER, today);
  }
  return { ok: true, today, walked, announced, more: !!cursor, celebrants };
}


// ── HTTP route handler ────────────────────────────────────────────
// 2026-05-31, exposes celebrateAnniversary + getFirstSeen via HMAC
// HTTP for the site to call. Pattern matches daily-quests/twitch-drops/
// pet-leveling: GET is public for the read path, POST is HMAC-gated.

function _ajson(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });
}

async function _agateHmac(req, env) {
  const { verifyHmac } = await import('./auth.js');
  if (!env.AQUILO_SITE_WEB_SECRET) {
    return { ok: false, status: 503, error: 'AQUILO_SITE_WEB_SECRET missing' };
  }
  const bodyText = req.method === 'POST' ? await req.text() : '';
  const ts  = req.headers.get('x-aquilo-web-ts');
  const sig = req.headers.get('x-aquilo-web-sig');
  const ok  = await verifyHmac(env.AQUILO_SITE_WEB_SECRET, ts || '', bodyText, sig || '');
  if (!ok) return { ok: false, status: 401, error: 'unauthorized' };
  let body = {};
  if (bodyText) {
    try { body = JSON.parse(bodyText); } catch { return { ok: false, status: 400, error: 'bad-json' }; }
  }
  return { ok: true, body };
}

export async function handleAnniversaryRoute(req, env, path) {
  // GET /web/anniversary/me/<guildId>/<userId>, public, returns the
  // current firstSeen + computed anniversary state.
  if (req.method === 'GET' && path.startsWith('/web/anniversary/me/')) {
    const parts = path.slice('/web/anniversary/me/'.length).split('/');
    const guildId = parts[0];
    const userId  = parts[1];
    if (!guildId || !userId) return _ajson({ error: 'guildId+userId required' }, 400);
    const firstSeenUtc = await getFirstSeen(env, guildId, userId);
    if (firstSeenUtc == null) return _ajson({ ok: true, firstSeenUtc: null, anniversary: null });
    const a = computeAnniversary(firstSeenUtc, Date.now());
    return _ajson({ ok: true, firstSeenUtc, anniversary: a });
  }
  // POST /web/anniversary/celebrate, HMAC-gated. Body: { guildId, userId }.
  const gate = await _agateHmac(req, env);
  if (!gate.ok) return _ajson({ error: gate.error }, gate.status);
  const b = gate.body || {};
  const guildId = String(b.guildId || '').trim();
  const userId  = String(b.userId || '').trim();
  if (!guildId || !userId) return _ajson({ error: 'guildId+userId required' }, 400);

  if (req.method === 'POST' && path === '/web/anniversary/celebrate') {
    const r = await celebrateAnniversary(env, guildId, userId);
    return _ajson(r, r.ok ? 200 : 400);
  }
  return _ajson({ error: 'unknown-op' }, 404);
}
