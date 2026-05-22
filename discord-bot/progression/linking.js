// Progression — external-account linking.
//
// PROGRESSION-SYSTEM-DESIGN.md §5.4. Lets viewers link Steam, Epic,
// Xbox, Battle.net, YouTube, TikTok, Patreon (read-only) for friend-
// discovery + verification flair. Each linked account is recorded on
// pprofile:<userId>.linkedAccounts.<platform> + a reverse index at
// plink:<platform>:<externalId> so we can block duplicate links.
//
// Auth flow varies per platform:
//   - Steam       OpenID 2.0 (no API key needed for sign-in; Web API
//                 key only required to fetch the persona name)
//   - Twitch      OAuth implicit grant (existing app credentials)
//   - Epic / Xbox / Battle.net / YouTube / TikTok    standard OAuth 2.0
//   - PSN / Manual entry  no public OAuth — text field + unverified flag
//
// Each link returns a result the redirect target can render in JSON
// or plain text. Removal is always allowed (rate-limited to 1/day
// per platform to defuse "swap to abuse rewards" patterns).

import { getProfile, putProfile } from './profile.js';
import { emitProgressionEvent } from './event-bus.js';

const LINK_INDEX = (platform, externalId) => `plink:${platform}:${externalId}`;
const RELINK_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// Platforms we support. `auth` is the high-level kind so the worker
// can dispatch correctly. Manual platforms require a handle string.
export const PLATFORMS = {
  twitch:    { auth: 'oauth',   manual: false },
  steam:     { auth: 'openid',  manual: false },
  epic:      { auth: 'oauth',   manual: false },
  xbox:      { auth: 'oauth',   manual: false },
  battlenet: { auth: 'oauth',   manual: false },
  youtube:   { auth: 'oauth',   manual: false },
  tiktok:    { auth: 'oauth',   manual: false },
  playstation: { auth: 'manual', manual: true },
  origin:    { auth: 'manual',  manual: true },
  riot:      { auth: 'manual',  manual: true },
  ubisoft:   { auth: 'manual',  manual: true },
};

// ── Apply a verified link ─────────────────────────────────────────
//
// Writes the link to pprofile:<userId>.linkedAccounts.<platform>,
// updates the reverse index, and fires a progressionEvent so the
// achievement engine can award the Linked Up + Verified Trio + sub /
// patron badges.

export async function applyLink(env, userId, platform, payload, opts = {}) {
  const p = PLATFORMS[platform];
  if (!p) return { ok: false, error: 'unknown-platform' };
  if (!payload?.externalId) return { ok: false, error: 'no-external-id' };
  const profile = await getProfile(env, userId);
  const idxKey = LINK_INDEX(platform, payload.externalId);
  // Dedup: only block if the externalId is linked to a DIFFERENT user.
  const existing = await env.LOADOUT_BOLTS.get(idxKey, { type: 'text' });
  if (existing && existing !== userId) {
    return { ok: false, error: 'already-linked', toUserId: existing };
  }
  // 24h relink cooldown — the same user removing + re-adding the same
  // external id is allowed, but the cooldown defuses sock-puppet swap
  // patterns (see §11.4).
  const existingLink = profile.linkedAccounts?.[platform];
  if (existingLink?.removedUtc && (Date.now() - existingLink.removedUtc) < RELINK_COOLDOWN_MS) {
    return {
      ok: false,
      error: 'relink-cooldown',
      retryAfterMs: RELINK_COOLDOWN_MS - (Date.now() - existingLink.removedUtc),
    };
  }
  profile.linkedAccounts = profile.linkedAccounts || {};
  profile.linkedAccounts[platform] = {
    id: payload.externalId,
    handle: payload.handle || payload.persona || payload.username || '',
    displayName: payload.displayName || '',
    verifiedUtc: Date.now(),
    source: p.manual ? 'manual' : (opts.source || 'oauth'),
    extra: payload.extra || {},
  };
  await putProfile(env, userId, profile);
  // Reverse index (no TTL — durable).
  await env.LOADOUT_BOLTS.put(idxKey, userId);

  // Achievement event. Stable key = externalId so re-linking after
  // removal doesn't double-fire.
  try {
    await emitProgressionEvent(env, {
      kind: 'profile.linked',
      userId,
      meta: { platform, externalId: payload.externalId, sub: !!payload.sub },
      stableKeys: ['platform', 'externalId'],
    });
  } catch { /* non-fatal */ }
  return { ok: true, platform, handle: profile.linkedAccounts[platform].handle };
}

// ── Remove a link ─────────────────────────────────────────────────
//
// Soft-remove: we keep `removedUtc` on the link record so the 24h
// relink cooldown can enforce. The reverse index IS deleted so a
// different user can pick up the same externalId after the cooldown.

export async function removeLink(env, userId, platform) {
  if (!PLATFORMS[platform]) return { ok: false, error: 'unknown-platform' };
  const profile = await getProfile(env, userId);
  const link = profile.linkedAccounts?.[platform];
  if (!link) return { ok: false, error: 'not-linked' };
  // Mark removed in the profile (kept for cooldown).
  profile.linkedAccounts[platform] = {
    ...link,
    removedUtc: Date.now(),
    id: null,
    handle: '',
  };
  await putProfile(env, userId, profile);
  // Drop the reverse index so the externalId can be re-claimed.
  try { await env.LOADOUT_BOLTS.delete(LINK_INDEX(platform, link.id)); }
  catch { /* non-fatal */ }
  return { ok: true };
}

// ── Manual entry (PSN / unsupported) ──────────────────────────────
//
// No OAuth round trip — viewer types the handle into a form. We mark
// `source: 'manual'` so the profile UI can show an "unverified" badge
// and disable tournament-eligibility checks until the platform adds
// a verification path.

export async function applyManualLink(env, userId, platform, handle) {
  if (!PLATFORMS[platform]?.manual) return { ok: false, error: 'platform-not-manual' };
  const cleanHandle = String(handle || '').trim().slice(0, 64);
  if (!cleanHandle) return { ok: false, error: 'empty-handle' };
  return applyLink(env, userId, platform, {
    externalId: 'manual:' + cleanHandle.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    handle: cleanHandle,
  }, { source: 'manual' });
}

// ── OAuth/OpenID flow helpers ────────────────────────────────────
//
// The actual platform-specific HTTP exchanges live in oauth-<plat>.js
// modules (under progression/oauth/). This module dispatches the
// /link/start and /link/callback routes — they delegate to the
// per-platform handlers.

export async function startLinkFlow(env, platform, userId, returnUrl) {
  const { oauth_start } = await loadHandler(platform);
  if (!oauth_start) return { ok: false, error: 'no-handler-for-platform' };
  return oauth_start(env, userId, returnUrl);
}

export async function completeLinkFlow(env, platform, query) {
  const { oauth_callback } = await loadHandler(platform);
  if (!oauth_callback) return { ok: false, error: 'no-handler-for-platform' };
  return oauth_callback(env, query);
}

async function loadHandler(platform) {
  try {
    const mod = await import(`./oauth/${platform}.js`);
    return mod;
  } catch {
    return {};
  }
}

// ── Patreon-tier read for §13 / §7 premium pass multiplier ──────
//
// Reads the existing patreon:tier:<userId> record (set by the
// existing Patreon link flow in ext-patreon-link.js). Returns the
// tier slug ('spark' | 'bolt' | 'voltaic' | 'eagle' | null).

export async function readPatreonTier(env, userId) {
  try {
    const raw = await env.LOADOUT_BOLTS.get(`patreon:tier:${userId}`, { type: 'json' });
    return raw?.tier || null;
  } catch { return null; }
}

export function patreonRewardMultiplier(tier) {
  switch (tier) {
    case 'eagle':   return 2.0;
    case 'voltaic': return 1.5;
    case 'bolt':    return 1.25;
    case 'spark':   return 1.0;
    default:        return 0;     // no patreon — premium track locked
  }
}
