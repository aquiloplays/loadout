// Progression — badges runtime.
//
// PROGRESSION-SYSTEM-DESIGN.md §7. Owns pbadge:<userId> (the per-user
// owned-badges list + 3-slot showcase) and exposes read/write helpers
// the profile page + achievement engine use.
//
// Badges are awarded by achievements (P3 already writes to
// pbadge:<userId>.owned), season tiers (P6), tournament placements
// (P7), and admin grants. This module is the "everything badge"
// surface.

import { BADGES_BY_ID, BADGE_CATALOG } from './badges-catalog.js';

const KEY = (uid) => `pbadge:${uid}`;

function freshRecord() {
  return { owned: [], firstEarnedUtc: {}, showcase: [] };
}

export async function getBadges(env, userId) {
  const raw = await env.LOADOUT_BOLTS.get(KEY(userId), { type: 'json' });
  if (!raw) return freshRecord();
  return { ...freshRecord(), ...raw };
}

export async function putBadges(env, userId, rec) {
  await env.LOADOUT_BOLTS.put(KEY(userId), JSON.stringify(rec));
}

// Used by P3's achievement engine. Awards a badge to a user — no-op
// if already owned.
export async function awardBadge(env, userId, badgeId, source) {
  if (!BADGES_BY_ID[badgeId]) return { ok: false, error: 'unknown-badge' };
  const rec = await getBadges(env, userId);
  if (rec.owned.includes(badgeId)) return { ok: true, alreadyOwned: true };
  rec.owned.push(badgeId);
  rec.firstEarnedUtc[badgeId] = Date.now();
  rec.lastEarnedId = badgeId;
  rec.lastEarnedUtc = Date.now();
  rec.lastEarnedSource = source || null;
  await putBadges(env, userId, rec);
  return { ok: true, badgeId };
}

// Used by P5's profile-bio update path. Caller passes the desired
// showcase; we validate against owned-list and cap at 3.
export async function setShowcase(env, userId, badgeIds) {
  const rec = await getBadges(env, userId);
  const owned = new Set(rec.owned);
  const cleaned = (badgeIds || [])
    .filter(id => typeof id === 'string')
    .filter(id => owned.has(id))
    .slice(0, 3);
  rec.showcase = cleaned;
  await putBadges(env, userId, rec);
  return { ok: true, showcase: cleaned };
}

// Exported for profile.js — used to validate the showcase array passed
// in via setProfileBio.
export async function getOwnedBadgeIds(env, userId) {
  const rec = await getBadges(env, userId);
  return rec.owned || [];
}

// Profile-page display payload — full catalog joined with ownership
// state, sorted by rarity then category. Owned + showcased come first.
export async function readBadgesDisplay(env, userId) {
  const rec = await getBadges(env, userId);
  const ownedSet = new Set(rec.owned);
  const showcaseSet = new Set(rec.showcase || []);
  const items = BADGE_CATALOG.map(b => ({
    id: b.id,
    name: b.name,
    description: b.description,
    rarity: b.rarity,
    category: b.category,
    spritePath: b.spritePath,
    shape: b.shape,
    accent: b.accent,
    source: b.source,
    owned: ownedSet.has(b.id),
    inShowcase: showcaseSet.has(b.id),
    firstEarnedUtc: rec.firstEarnedUtc[b.id] || 0,
  }));
  // Showcase first (in user's chosen order), then owned-unshowcased,
  // then locked.
  const showcasedFirst = (rec.showcase || []).map(id => items.find(i => i.id === id)).filter(Boolean);
  const showcasedSet = new Set(showcasedFirst.map(i => i.id));
  const ownedRest = items.filter(i => i.owned && !showcasedSet.has(i.id)).sort((a, b) => b.firstEarnedUtc - a.firstEarnedUtc);
  const locked = items.filter(i => !i.owned);
  const ordered = [...showcasedFirst, ...ownedRest, ...locked];
  return {
    earned: rec.owned.length,
    total: BADGE_CATALOG.length,
    showcase: rec.showcase || [],
    items: ordered,
  };
}
