// Progression — public profile + stats aggregator.
//
// PROGRESSION-SYSTEM-DESIGN.md §5 — owns pprofile:<userId> and the
// "render every feature's stats card" aggregator. Each feature module
// exports a getStatsFor(env, userId) the profile page calls in
// parallel; the order is deterministic (FEATURE_ORDER below) but
// missing/empty responses are skipped silently so a feature that
// hasn't shipped its stats hook yet doesn't break the page.

import { readXpDisplay } from './xp.js';
import { getRecentEvents } from './event-bus.js';

const PROFILE_KEY = (userId) => `pprofile:${userId}`;
const HANDLE_INDEX_KEY = (safe) => `pprofile:handle:${safe}`;

// Feature aggregation order. Each entry: { feature, importPath }.
// New features add one line here + an export of getStatsFor in their
// module. The progression layer is the only thing that knows about
// the union.
const FEATURE_ORDER = [
  { feature: 'clash',     importPath: '../clash-state.js' },
  { feature: 'boltbound', importPath: '../cards-state.js' },
  { feature: 'board',     importPath: '../boardgames-engine.js' },
  { feature: 'hero',      importPath: '../character.js' },
  { feature: 'quick',     importPath: '../games-quick.js' },
  { feature: 'stocks',    importPath: '../stocks.js' },
  { feature: 'bet',       importPath: '../bet.js' },
  { feature: 'pet',       importPath: '../pet.js' },
  { feature: 'wallet',    importPath: '../wallet.js' },
];

function freshProfile(userId) {
  return {
    userId,
    displayName: '',
    bio: '',
    badgesShowcase: [],
    privacy: 'public',        // public | friends | private
    createdUtc: Date.now(),
    lastSeenUtc: Date.now(),
    linkedAccounts: {
      discord: { id: userId },
    },
    friends: [],
    showLevelUpsToFriends: false,
  };
}

export async function getProfile(env, userId) {
  const raw = await env.LOADOUT_BOLTS.get(PROFILE_KEY(userId), { type: 'json' });
  if (!raw) return freshProfile(userId);
  return { ...freshProfile(userId), ...raw };
}

export async function putProfile(env, userId, p) {
  p.lastSeenUtc = Date.now();
  await env.LOADOUT_BOLTS.put(PROFILE_KEY(userId), JSON.stringify(p));
}

export async function setProfileBio(env, userId, bio, opts = {}) {
  const p = await getProfile(env, userId);
  const clean = (bio || '').toString().slice(0, 200);
  // Best-effort profanity filter; reuse ext.js's cleanMessage if available.
  let filtered = clean;
  try {
    const ext = await import('../ext.js');
    if (typeof ext.cleanMessage === 'function') filtered = ext.cleanMessage(clean);
  } catch { /* fall through */ }
  p.bio = filtered;
  if (opts.privacy && ['public', 'friends', 'private'].includes(opts.privacy)) {
    p.privacy = opts.privacy;
  }
  if (Array.isArray(opts.badgesShowcase)) {
    // Validate showcase against owned badges (lazy import — P4 wires it).
    let owned = new Set();
    try {
      const { getOwnedBadgeIds } = await import('./badges.js');
      if (getOwnedBadgeIds) owned = new Set(await getOwnedBadgeIds(env, userId));
    } catch { /* P4 module not yet present — accept all */ }
    p.badgesShowcase = opts.badgesShowcase
      .filter(id => typeof id === 'string')
      .slice(0, 3)
      .filter(id => owned.size === 0 || owned.has(id));
  }
  if (typeof opts.displayName === 'string') {
    p.displayName = opts.displayName.slice(0, 32);
  }
  if (typeof opts.showLevelUpsToFriends === 'boolean') {
    p.showLevelUpsToFriends = opts.showLevelUpsToFriends;
  }
  await putProfile(env, userId, p);
  return p;
}

// ── Aggregator ────────────────────────────────────────────────────
//
// Walks FEATURE_ORDER, calls getStatsFor on each feature module in
// parallel, returns the assembled stats array. Each card has the
// shape:
//   { feature, primary: { label, value, tier? }, secondary: [...], iconKind }
//
// Missing modules / errors return { feature, error: '...' } so the
// page can show a placeholder without breaking the layout.

export async function aggregateStats(env, userId, guildId = null) {
  const results = await Promise.all(FEATURE_ORDER.map(async ({ feature, importPath }) => {
    try {
      const mod = await import(importPath);
      const fn = mod.getStatsFor || mod.getStats;
      if (typeof fn !== 'function') return { feature, error: 'no-getStatsFor' };
      // Most existing stats are keyed by (guildId, userId). The profile
      // aggregator is account-wide, so we pass guildId=null and let the
      // feature handle "aggregate across guilds" itself (or return a
      // single-guild snapshot for the requested guild if passed in).
      const payload = await fn(env, userId, guildId);
      return { feature, ...payload };
    } catch (e) {
      return { feature, error: String(e && e.message || e) };
    }
  }));
  return results;
}

// ── Profile read for the website / panel ──────────────────────────
//
// Composes everything the profile page needs in one call: profile
// record + XP/level + stats cards + recent activity. The page renders
// from a single fetch.

export async function readFullProfile(env, userId, opts = {}) {
  const [profile, xp, stats, recent] = await Promise.all([
    getProfile(env, userId),
    readXpDisplay(env, userId),
    aggregateStats(env, userId, opts.guildId || null),
    getRecentEvents(env, userId, 10),
  ]);

  // Privacy resolution. Friends-only and private gate the stats body
  // for viewers who aren't the user themselves / in their friends list.
  const viewerUserId = opts.viewerUserId || null;
  const isSelf = viewerUserId === userId;
  const isFriend = Array.isArray(profile.friends) && profile.friends.includes(viewerUserId);
  let gated = false;
  let statsOut = stats;
  let recentOut = recent;
  if (profile.privacy === 'private' && !isSelf) {
    gated = true; statsOut = []; recentOut = [];
  } else if (profile.privacy === 'friends' && !isSelf && !isFriend) {
    gated = true; statsOut = []; recentOut = [];
  }

  return {
    profile: {
      userId: profile.userId,
      displayName: profile.displayName || `Player ${profile.userId.slice(-4)}`,
      bio: profile.bio || '',
      privacy: profile.privacy,
      createdUtc: profile.createdUtc,
      lastSeenUtc: profile.lastSeenUtc,
      badgesShowcase: profile.badgesShowcase || [],
      linkedAccounts: redactLinkedAccounts(profile.linkedAccounts || {}),
      friendCount: (profile.friends || []).length,
    },
    xp,
    stats: statsOut,
    recentActivity: recentOut,
    gated,
  };
}

// Strip OAuth bearer-token-like fields from the linked accounts before
// returning to the public web. Public profile shows handle/persona, not
// access tokens.
function redactLinkedAccounts(la) {
  const out = {};
  for (const platform of Object.keys(la || {})) {
    const acc = la[platform] || {};
    out[platform] = {
      id: acc.id || '',
      handle: acc.handle || acc.login || acc.persona || acc.displayName || acc.username || '',
      verifiedUtc: acc.verifiedUtc || 0,
      source: acc.source || 'oauth',
    };
  }
  return out;
}

// ── Lookup by handle (for /p/<handle> alias) ──────────────────────

export async function lookupByHandle(env, handle) {
  const safe = (handle || '').toString().toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32);
  if (!safe) return null;
  const userId = await env.LOADOUT_BOLTS.get(HANDLE_INDEX_KEY(safe), { type: 'text' });
  return userId || null;
}

export async function reserveHandle(env, userId, handle) {
  const safe = (handle || '').toString().toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32);
  if (!safe) return { ok: false, error: 'invalid-handle' };
  const existing = await env.LOADOUT_BOLTS.get(HANDLE_INDEX_KEY(safe), { type: 'text' });
  if (existing && existing !== userId) return { ok: false, error: 'taken' };
  await env.LOADOUT_BOLTS.put(HANDLE_INDEX_KEY(safe), userId);
  return { ok: true, handle: safe };
}
