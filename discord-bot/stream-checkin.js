// Stream check-in cards, the on-stream "I'm here" moment.
//
// A viewer hits Check In (Twitch panel or aquilo.gg) → the worker resolves
// their saved card customization + earned badges, validates everything
// against their REAL entitlements (no faking), and enqueues a
// `streamcheckin.shown` Aquilo Bus event that the OBS stream-checkin overlay
// animates for ~3-5s. Separate from the daily community check-in
// (community-checkin.js), that one tracks streaks + bolts.
//
// Public API:
//   getCardConfig(env, userId)                     -> saved config (defaults if none)
//   saveCardConfig(env, guildId, userId, patch)    -> validate vs entitlements, upsert
//   resolveEntitlements(env, guildId, userId)      -> normalized viewerStatus
//   computeBadges(viewerStatus)                    -> earned badge ids
//   cardMe(env, guildId, userId)                   -> config + badges + filtered catalogs
//   badgesFor(env, guildId, userId)                -> earned badges (with labels)
//   showOnStream(env, guildId, userId, body)       -> rate-limited publish of the card
//
// Entitlement counters this module READS (written on the Twitch EventSub hot
// path by twitch-rewards.js via the record* helpers below, durable, keyed by
// Discord id, accumulate going forward):
//   twitch:sub:<g>:<u>    -> { tier, sinceUtc, lastUtc }
//   twitch:cheer:<g>:<u>  -> cumulative bits (integer)
//   twitch:gift:<g>:<u>   -> cumulative gift-sub count (integer)
//   twitch:follow:<g>:<u> -> followedAtUtc (ms epoch)

import { enqueueOverlay } from './ext-engage.js';

// ── D1 ──────────────────────────────────────────────────────────────
function db(env) {
  if (!env || !env.DB) throw new Error('stream-checkin: no D1 binding (env.DB missing)');
  return env.DB;
}
function jparse(s, fallback) {
  if (s == null) return fallback;
  try { const v = JSON.parse(s); return v == null ? fallback : v; } catch { return fallback; }
}

// ── Cosmetic catalogs ───────────────────────────────────────────────
// Each frame/anim declares an entitlement requirement as a predicate over the
// resolved viewerStatus. `req: null` = always available. Tier accents mirror
// twitch-rewards.js ROLE_TIER_COLOR (T1 violet / T2 pink / T3 green / gold).

export const FRAMES = Object.freeze([
  { id: 'supporter', label: 'Supporter',  accent: '#5b8def', req: null },
  { id: 'sub-t1',    label: 'Sub Tier 1', accent: '#7c5cff', req: (v) => v.subTier >= 1 },
  { id: 'sub-t2',    label: 'Sub Tier 2', accent: '#ff6ab5', req: (v) => v.subTier >= 2 },
  { id: 'sub-t3',    label: 'Sub Tier 3', accent: '#5bff95', req: (v) => v.subTier >= 3 },
  { id: 'patron',    label: 'Patron',     accent: '#f0b232', req: (v) => v.patronPaid },
]);

export const ANIMATIONS = Object.freeze([
  { id: 'slide-sparkle', label: 'Slide-in Sparkle', req: null },
  { id: 'fade-confetti', label: 'Fade + Confetti',  req: null },
  { id: 'burst-badges',  label: 'Badge Burst',      req: (v) => earnedCount(v) >= 1 },
  { id: 'aurora-rise',   label: 'Aurora Rise',      req: (v) => v.subTier >= 1 || v.patronPaid || v.giftCount >= 1 },
]);

// Badge definitions, `id` is the wire value, `test` decides "earned".
export const BADGES = Object.freeze([
  { id: 'sub-t1',     label: 'Tier 1 Sub',   test: (v) => v.subTier >= 1 },
  { id: 'sub-t2',     label: 'Tier 2 Sub',   test: (v) => v.subTier >= 2 },
  { id: 'sub-t3',     label: 'Tier 3 Sub',   test: (v) => v.subTier >= 3 },
  { id: 'cheer-100',  label: 'Cheered 100',  test: (v) => v.cheerTotal >= 100 },
  { id: 'cheer-500',  label: 'Cheered 500',  test: (v) => v.cheerTotal >= 500 },
  { id: 'cheer-1000', label: 'Cheered 1K+',  test: (v) => v.cheerTotal >= 1000 },
  { id: 'gift-1',     label: 'Gifter',       test: (v) => v.giftCount >= 1 },
  { id: 'gift-5',     label: 'Gifted 5+',    test: (v) => v.giftCount >= 5 },
  { id: 'gift-25',    label: 'Gifted 25+',   test: (v) => v.giftCount >= 25 },
  { id: 'patron',     label: 'Patron',       test: (v) => v.patronPaid },
  { id: 'anniv-1',    label: '1-Year',       test: (v) => v.anniversaryYears >= 1 },
  { id: 'anniv-5',    label: '5-Year',       test: (v) => v.anniversaryYears >= 5 },
  { id: 'follow',     label: 'Follower',     test: (v) => v.followedAt > 0 },
]);

const MAX_BADGES = 3;
const TAGLINE_MAX = 60;
const SLUG_RE = /^[a-z0-9_-]{1,60}$/;
const DEFAULT_FRAME = 'supporter';
const DEFAULT_ANIM = 'slide-sparkle';

function earnedCount(v) { return BADGES.filter((b) => b.test(v)).length; }

// ── Entitlement counter writes (called from twitch-rewards.js) ──────
const K_SUB    = (g, u) => `twitch:sub:${g}:${u}`;
const K_CHEER  = (g, u) => `twitch:cheer:${g}:${u}`;
const K_GIFT   = (g, u) => `twitch:gift:${g}:${u}`;
const K_FOLLOW = (g, u) => `twitch:follow:${g}:${u}`;

export async function recordSubEntitlement(env, guildId, userId, tier) {
  if (!guildId || !userId) return;
  const t = tier === '3000' ? 3 : tier === '2000' ? 2 : 1; // Prime → 1
  const now = Date.now();
  const prev = await env.LOADOUT_BOLTS.get(K_SUB(guildId, userId), { type: 'json' }).catch(() => null);
  const rec = {
    tier: Math.max(t, prev?.tier || 0),   // keep highest tier ever held
    sinceUtc: prev?.sinceUtc || now,
    lastUtc: now,
  };
  await env.LOADOUT_BOLTS.put(K_SUB(guildId, userId), JSON.stringify(rec)).catch(() => {});
}

export async function addCheerEntitlement(env, guildId, userId, bits) {
  const b = Math.max(0, Number(bits) || 0);
  if (!guildId || !userId || b <= 0) return;
  const cur = Number(await env.LOADOUT_BOLTS.get(K_CHEER(guildId, userId)).catch(() => 0)) || 0;
  await env.LOADOUT_BOLTS.put(K_CHEER(guildId, userId), String(cur + b)).catch(() => {});
}

export async function addGiftEntitlement(env, guildId, userId, count) {
  const c = Math.max(0, Number(count) || 0);
  if (!guildId || !userId || c <= 0) return;
  const cur = Number(await env.LOADOUT_BOLTS.get(K_GIFT(guildId, userId)).catch(() => 0)) || 0;
  await env.LOADOUT_BOLTS.put(K_GIFT(guildId, userId), String(cur + c)).catch(() => {});
}

export async function recordFollowEntitlement(env, guildId, userId, followedAtUtc) {
  if (!guildId || !userId) return;
  const existing = await env.LOADOUT_BOLTS.get(K_FOLLOW(guildId, userId)).catch(() => null);
  if (existing) return; // first follow only
  await env.LOADOUT_BOLTS.put(K_FOLLOW(guildId, userId), String(followedAtUtc || Date.now())).catch(() => {});
}

// ── Entitlement resolution ──────────────────────────────────────────
export async function resolveEntitlements(env, guildId, userId) {
  const g = guildId || env.AQUILO_VAULT_GUILD_ID;
  const v = {
    subTier: 0,           // 0=none, 1/2/3
    cheerTotal: 0,        // cumulative bits
    cheerTier: 0,         // 0 / 100 / 500 / 1000 (highest crossed)
    giftCount: 0,         // cumulative gift-subs
    patronTier: null,     // raw Patreon tier name or null
    patronPaid: false,
    anniversaryYears: 0,
    followedAt: 0,
  };

  const sub = await env.LOADOUT_BOLTS.get(K_SUB(g, userId), { type: 'json' }).catch(() => null);
  if (sub && sub.tier) v.subTier = Math.min(3, Math.max(0, Number(sub.tier) || 0));

  v.cheerTotal = Number(await env.LOADOUT_BOLTS.get(K_CHEER(g, userId)).catch(() => 0)) || 0;
  v.cheerTier = v.cheerTotal >= 1000 ? 1000 : v.cheerTotal >= 500 ? 500 : v.cheerTotal >= 100 ? 100 : 0;

  v.giftCount = Number(await env.LOADOUT_BOLTS.get(K_GIFT(g, userId)).catch(() => 0)) || 0;
  v.followedAt = Number(await env.LOADOUT_BOLTS.get(K_FOLLOW(g, userId)).catch(() => 0)) || 0;

  // Patreon (durably readable today), patreon-link.js, keyed by Discord id.
  try {
    const { getPatreonTier } = await import('./patreon-link.js');
    const p = await getPatreonTier(env, userId);
    if (p && p.linked) { v.patronTier = p.tier || (p.paid ? 'patron' : 'free'); v.patronPaid = !!p.paid; }
  } catch { /* patreon optional */ }

  return v;
}

export function computeBadges(viewerStatus) {
  return BADGES.filter((b) => b.test(viewerStatus)).map((b) => b.id);
}

// ── Config storage (D1) ─────────────────────────────────────────────
function rowToConfig(row) {
  return {
    userId:      row.user_id,
    frame:       row.frame || DEFAULT_FRAME,
    bg:          row.bg || null,
    anim:        row.anim || DEFAULT_ANIM,
    badges:      jparse(row.badges, []),
    tagline:     row.tagline || '',
    lastUpdated: row.last_updated || 0,
  };
}
function defaultConfig(userId) {
  return { userId: String(userId || ''), frame: DEFAULT_FRAME, bg: null,
           anim: DEFAULT_ANIM, badges: [], tagline: '', lastUpdated: 0 };
}

export async function getCardConfig(env, userId) {
  if (!userId) return defaultConfig('');
  const row = await db(env).prepare(
    `SELECT user_id, frame, bg, anim, badges, tagline, last_updated
       FROM user_checkin_card_config WHERE user_id = ? LIMIT 1`
  ).bind(String(userId)).first();
  return row ? rowToConfig(row) : defaultConfig(userId);
}

// Validate a requested config against the user's real entitlements. Returns
// { ok, config } on success or { ok:false, error, message } on a violation.
export function validateConfig(patch, viewerStatus, earnedBadgeIds) {
  const frameId = patch.frame == null ? DEFAULT_FRAME : String(patch.frame);
  const frame = FRAMES.find((f) => f.id === frameId);
  if (!frame) return { ok: false, error: 'bad-frame', message: `Unknown frame "${frameId}".` };
  if (frame.req && !frame.req(viewerStatus))
    return { ok: false, error: 'frame-locked', message: `You haven't earned the "${frame.label}" frame.` };

  const animId = patch.anim == null ? DEFAULT_ANIM : String(patch.anim);
  const anim = ANIMATIONS.find((a) => a.id === animId);
  if (!anim) return { ok: false, error: 'bad-anim', message: `Unknown animation "${animId}".` };
  if (anim.req && !anim.req(viewerStatus))
    return { ok: false, error: 'anim-locked', message: `You haven't unlocked the "${anim.label}" animation.` };

  let bg = null;
  if (patch.bg != null && patch.bg !== '') {
    bg = String(patch.bg).trim().toLowerCase();
    if (!SLUG_RE.test(bg)) return { ok: false, error: 'bad-bg', message: 'Background id must match /^[a-z0-9_-]{1,60}$/.' };
  }

  const requested = Array.isArray(patch.badges) ? patch.badges.map(String) : [];
  if (requested.length > MAX_BADGES)
    return { ok: false, error: 'too-many-badges', message: `Pick at most ${MAX_BADGES} badges.` };
  for (const b of requested) {
    if (!BADGES.some((d) => d.id === b)) return { ok: false, error: 'bad-badge', message: `Unknown badge "${b}".` };
    if (!earnedBadgeIds.includes(b)) return { ok: false, error: 'badge-locked', message: `You haven't earned the "${b}" badge.` };
  }
  // De-dupe preserving order.
  const badges = [...new Set(requested)].slice(0, MAX_BADGES);

  let tagline = '';
  // Strip angle brackets so a tagline can never inject markup into the OBS
  // check-in overlay (defense-in-depth; the overlay should also escape).
  if (patch.tagline != null) tagline = String(patch.tagline).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, TAGLINE_MAX);

  return { ok: true, config: { frame: frame.id, bg, anim: anim.id, badges, tagline } };
}

export async function saveCardConfig(env, guildId, userId, patch = {}) {
  if (!userId) return { ok: false, error: 'bad-args' };
  const viewer = await resolveEntitlements(env, guildId, userId);
  const earned = computeBadges(viewer);
  const v = validateConfig(patch, viewer, earned);
  if (!v.ok) return v;

  const now = Date.now();
  await db(env).prepare(
    `INSERT INTO user_checkin_card_config
       (user_id, frame, bg, anim, badges, tagline, last_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       frame = excluded.frame, bg = excluded.bg, anim = excluded.anim,
       badges = excluded.badges, tagline = excluded.tagline,
       last_updated = excluded.last_updated`
  ).bind(
    String(userId), v.config.frame, v.config.bg, v.config.anim,
    JSON.stringify(v.config.badges), v.config.tagline || null, now,
  ).run();

  return { ok: true, config: { userId: String(userId), ...v.config, lastUpdated: now } };
}

// ── /web/checkin/card/me, config + entitlements + filtered catalogs ─
export async function cardMe(env, guildId, userId) {
  const [config, viewer] = await Promise.all([
    getCardConfig(env, userId),
    resolveEntitlements(env, guildId, userId),
  ]);
  const earned = computeBadges(viewer);
  return {
    ok: true,
    config,
    viewerStatus: viewer,
    earnedBadges: BADGES.filter((b) => earned.includes(b.id)).map((b) => ({ id: b.id, label: b.label })),
    frames: FRAMES.map((f) => ({ id: f.id, label: f.label, accent: f.accent, unlocked: !f.req || f.req(viewer) })),
    animations: ANIMATIONS.map((a) => ({ id: a.id, label: a.label, unlocked: !a.req || a.req(viewer) })),
  };
}

export async function badgesFor(env, guildId, userId) {
  const viewer = await resolveEntitlements(env, guildId, userId);
  const earned = computeBadges(viewer);
  return {
    ok: true,
    userId: String(userId),
    badges: BADGES.map((b) => ({ id: b.id, label: b.label, earned: earned.includes(b.id) })),
    earned,
    viewerStatus: viewer,
  };
}

// ── Profile resolution (display name + avatar) ──────────────────────
function isHttps(u) { try { return new URL(u).protocol === 'https:'; } catch { return false; } }

async function resolveProfile(env, guildId, userId, body) {
  let displayName = String(body?.displayName || '').trim().slice(0, 40);
  let profilePic = isHttps(body?.profilePic) ? String(body.profilePic) : '';
  if (displayName && profilePic) return { displayName, profilePic };

  // Fall back to the Discord guild member (nick + avatar).
  if (env.DISCORD_BOT_TOKEN) {
    try {
      const r = await fetch(
        `https://discord.com/api/v10/guilds/${guildId}/members/${userId}`,
        { headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'User-Agent': 'loadout-discord stream-checkin' } });
      if (r.ok) {
        const m = await r.json();
        const u = m.user || {};
        if (!displayName) displayName = m.nick || u.global_name || u.username || 'Viewer';
        if (!profilePic) {
          if (u.avatar) profilePic = `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=128`;
          else {
            const idx = (BigInt(u.id || '0') >> 22n) % 6n;
            profilePic = `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
          }
        }
      }
    } catch { /* fall through to defaults */ }
  }
  return { displayName: displayName || 'Viewer', profilePic };
}

// ── /web/checkin/show, rate-limited publish to the OBS overlay ─────
const SHOW_COOLDOWN_MS = 3 * 60 * 1000; // 1 per 3 minutes per viewer
const K_SHOW_RATE = (u) => `streamcheckin:rate:${u}`;

export async function showOnStream(env, guildId, userId, body = {}) {
  if (!userId) return { ok: false, error: 'bad-args' };

  // Rate limit (min-gap).
  const last = Number(await env.LOADOUT_BOLTS.get(K_SHOW_RATE(userId)).catch(() => 0)) || 0;
  const now = Date.now();
  const since = now - last;
  if (last && since < SHOW_COOLDOWN_MS) {
    return { ok: false, error: 'rate-limited', reason: 'cooldown', retryAfterMs: SHOW_COOLDOWN_MS - since };
  }

  // Resolve current config + entitlements, then RE-VALIDATE the stored config
  // against live entitlements (defense in depth, entitlements can lapse).
  const config = await getCardConfig(env, userId);
  const viewer = await resolveEntitlements(env, guildId, userId);
  const earned = computeBadges(viewer);
  const v = validateConfig(config, viewer, earned);
  const safe = v.ok ? v.config : validateConfig({}, viewer, earned).config; // fall back to defaults

  const { displayName, profilePic } = await resolveProfile(env, guildId, userId, body);

  const payload = {
    userId: String(userId),
    displayName,
    profilePic,
    frame: safe.frame,
    bg: safe.bg,
    anim: safe.anim,
    badges: safe.badges,
    tagline: safe.tagline || '',
    viewerStatus: {
      subTier: viewer.subTier,
      cheerTier: viewer.cheerTier,
      giftCount: viewer.giftCount,
      patronTier: viewer.patronTier,
    },
    ts: now,
  };

  // Publish to the OBS overlay via the relay (System B / 7470 WS bus). The
  // unified Aquilo Relay action drains relay:overlay-* and republishes the
  // trigger as { v:1, kind:'streamcheckin.shown', data:<trigger> }.
  await enqueueOverlay(env, { type: 'streamcheckin', bus_kind: 'streamcheckin.shown', ...payload });

  // Also surface in the website/Discord community activity feed (non-fatal).
  try {
    const { publishActivity } = await import('./activity-do.js');
    await publishActivity(env, { kind: 'streamcheckin.shown', ...payload });
  } catch { /* community feed optional */ }

  await env.LOADOUT_BOLTS.put(K_SHOW_RATE(userId), String(now), { expirationTtl: 600 }).catch(() => {});

  return { ok: true, shown: payload, cooldownMs: SHOW_COOLDOWN_MS };
}
