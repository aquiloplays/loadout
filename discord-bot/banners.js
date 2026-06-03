// Banners, 5-25 player banded community alliances. The unit of
// participation in Banner Wars (see banner-wars.js).
//
// 2026-05-29 MVP. Site UI is already scaffolded with greyed-out
// buttons waiting on these endpoints. This module emits the data
// model + the core lifecycle (create, join, leave, browse, me) so
// the scaffold can light up. Bracketed weekly wars + per-banner
// Discord channel auto-provisioning are separate (banner-wars.js
// and an admin route).
//
// KV layout (LOADOUT_BOLTS namespace, shared with wallet):
//   banner:<guildId>:<bannerId>            -> Banner JSON
//   banner-member:<guildId>:<userId>       -> { bannerId, joinedUtc, role }
//   banner-list:<guildId>                  -> index { bannerIds: [...], updatedUtc }
//
// Banner shape:
//   { id, guildId, name, tag (3-5 char uppercase), ownerId,
//     members: [userId], maxMembers, motto, color (#rrggbb),
//     bannerCoinsTreasury, warsWon, warsLost, createdUtc, updatedUtc }
//
// Currency: Banner Coins (`bc`) live as a sibling on wallet.js, // added under `wallet.bannerCoins`. Earned by raid contributions
// and war wins, spent on banner-only cosmetics + war boosts.

import { getWallet, putWallet } from './wallet.js';

const MIN_MEMBERS = 5;
const MAX_MEMBERS = 25;
const TAG_RE      = /^[A-Z0-9]{3,5}$/;
const NAME_RE     = /^[A-Za-z0-9 '-]{3,30}$/;

// Founding cost, 500 bolts. High enough that banners aren't churned;
// low enough that an active viewer can spin one up in a week.
const FOUND_COST_BOLTS = 500;

const KEY = {
  banner:   (g, bid) => `banner:${g}:${bid}`,
  member:   (g, u)   => `banner-member:${g}:${u}`,
  list:     (g)      => `banner-list:${g}`,
};

// ── Helpers ─────────────────────────────────────────────────────

function nowIso() { return new Date().toISOString(); }
function nowMs()  { return Date.now(); }

function newBannerId() {
  // ban_<base36-time><4r>. 14-16 chars, alphanumeric, comfortable URL.
  return 'ban_' + nowMs().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

async function readIndex(env, guildId) {
  const raw = await env.LOADOUT_BOLTS.get(KEY.list(guildId), { type: 'json' });
  return raw || { bannerIds: [], updatedUtc: null };
}

async function writeIndex(env, guildId, idx) {
  idx.updatedUtc = nowIso();
  await env.LOADOUT_BOLTS.put(KEY.list(guildId), JSON.stringify(idx));
}

async function readBanner(env, guildId, bannerId) {
  if (!bannerId) return null;
  return await env.LOADOUT_BOLTS.get(KEY.banner(guildId, bannerId), { type: 'json' });
}

async function writeBanner(env, banner) {
  banner.updatedUtc = nowIso();
  await env.LOADOUT_BOLTS.put(KEY.banner(banner.guildId, banner.id),
                              JSON.stringify(banner));
}

async function readMember(env, guildId, userId) {
  return await env.LOADOUT_BOLTS.get(KEY.member(guildId, userId), { type: 'json' });
}

async function writeMember(env, guildId, userId, rec) {
  await env.LOADOUT_BOLTS.put(KEY.member(guildId, userId), JSON.stringify(rec));
}

async function clearMember(env, guildId, userId) {
  await env.LOADOUT_BOLTS.delete(KEY.member(guildId, userId));
}

// ── Banner Coins on wallet ──────────────────────────────────────

export async function getBannerCoins(env, guildId, userId) {
  const w = await getWallet(env, guildId, userId);
  return w.bannerCoins || 0;
}

export async function adjustBannerCoins(env, guildId, userId, delta /*, reason*/) {
  const w = await getWallet(env, guildId, userId);
  w.bannerCoins = Math.max(0, (w.bannerCoins || 0) + delta);
  await putWallet(env, guildId, userId, w);
  return w.bannerCoins;
}

// ── Public lifecycle ────────────────────────────────────────────

export async function getMyBanner(env, guildId, userId) {
  const m = await readMember(env, guildId, userId);
  if (!m?.bannerId) return { ok: true, banner: null, membership: null };
  const banner = await readBanner(env, guildId, m.bannerId);
  return {
    ok: true,
    banner,
    membership: m,
    bannerCoins: await getBannerCoins(env, guildId, userId),
  };
}

// Cap responses at TOP_BROWSE so the bootstrap response stays small;
// browse paginates via a cursor when callers need more.
const TOP_BROWSE = 50;

export async function browseBanners(env, guildId, opts = {}) {
  const limit = Math.min(TOP_BROWSE, Math.max(1, parseInt(opts.limit, 10) || TOP_BROWSE));
  const idx = await readIndex(env, guildId);
  const ids = (idx.bannerIds || []).slice(0, limit);
  const banners = [];
  for (const bid of ids) {
    const b = await readBanner(env, guildId, bid);
    if (b) banners.push({
      id: b.id, name: b.name, tag: b.tag, motto: b.motto, color: b.color,
      memberCount: (b.members || []).length, maxMembers: b.maxMembers,
      warsWon: b.warsWon || 0, warsLost: b.warsLost || 0,
      createdUtc: b.createdUtc,
    });
  }
  return { ok: true, banners };
}

export async function createBanner(env, guildId, userId, opts = {}) {
  const name  = String(opts.name  || '').trim();
  const tag   = String(opts.tag   || '').trim().toUpperCase();
  const motto = String(opts.motto || '').trim().slice(0, 140);
  const color = String(opts.color || '#a855f7').trim().slice(0, 7);

  if (!NAME_RE.test(name)) {
    return { ok: false, error: 'bad-name', message: 'Name must be 3-30 chars, letters/digits/hyphen/apostrophe.' };
  }
  if (!TAG_RE.test(tag)) {
    return { ok: false, error: 'bad-tag', message: 'Tag must be 3-5 uppercase letters/digits.' };
  }
  if (!/^#[0-9A-Fa-f]{6}$/.test(color)) {
    return { ok: false, error: 'bad-color', message: 'Color must be #RRGGBB.' };
  }

  // Founder must not already be in a banner.
  const existing = await readMember(env, guildId, userId);
  if (existing?.bannerId) {
    return { ok: false, error: 'already-in-banner', message: 'Leave your current banner first.' };
  }

  // Charge the founder's bolts.
  const wallet = await getWallet(env, guildId, userId);
  if ((wallet.balance || 0) < FOUND_COST_BOLTS) {
    return { ok: false, error: 'insufficient-bolts',
             need: FOUND_COST_BOLTS, have: wallet.balance || 0,
             message: `Need ${FOUND_COST_BOLTS} bolts to found a banner.` };
  }
  // Tag uniqueness, index scan. Cheap; index is short.
  const idx = await readIndex(env, guildId);
  for (const bid of (idx.bannerIds || [])) {
    const b = await readBanner(env, guildId, bid);
    if (b?.tag === tag) {
      return { ok: false, error: 'tag-taken', message: 'That tag is in use.' };
    }
    if (b?.name?.toLowerCase() === name.toLowerCase()) {
      return { ok: false, error: 'name-taken', message: 'That name is in use.' };
    }
  }

  // Debit + create. Order: debit first, mint after, so a debit
  // failure aborts the create.
  wallet.balance = (wallet.balance || 0) - FOUND_COST_BOLTS;
  wallet.lifetimeSpent = (wallet.lifetimeSpent || 0) + FOUND_COST_BOLTS;
  await putWallet(env, guildId, userId, wallet);

  const banner = {
    id: newBannerId(), guildId,
    name, tag, motto, color,
    ownerId: userId,
    members: [userId],
    maxMembers: MAX_MEMBERS,
    bannerCoinsTreasury: 0,
    warsWon: 0, warsLost: 0,
    createdUtc: nowIso(), updatedUtc: nowIso(),
  };
  await writeBanner(env, banner);
  await writeMember(env, guildId, userId, {
    bannerId: banner.id, joinedUtc: banner.createdUtc, role: 'owner',
  });
  idx.bannerIds = [banner.id, ...(idx.bannerIds || [])];
  await writeIndex(env, guildId, idx);

  return { ok: true, banner, debited: FOUND_COST_BOLTS, balance: wallet.balance };
}

export async function joinBanner(env, guildId, userId, opts = {}) {
  const bannerId = String(opts.bannerId || '').trim();
  if (!bannerId) return { ok: false, error: 'bad-args' };

  const existing = await readMember(env, guildId, userId);
  if (existing?.bannerId) {
    return { ok: false, error: 'already-in-banner', message: 'Leave your current banner first.' };
  }
  const banner = await readBanner(env, guildId, bannerId);
  if (!banner) return { ok: false, error: 'no-such-banner' };
  if ((banner.members || []).length >= (banner.maxMembers || MAX_MEMBERS)) {
    return { ok: false, error: 'banner-full', message: 'This banner is at capacity.' };
  }
  if (!banner.members.includes(userId)) banner.members.push(userId);
  await writeBanner(env, banner);
  await writeMember(env, guildId, userId, {
    bannerId, joinedUtc: nowIso(), role: 'member',
  });
  return { ok: true, banner };
}

export async function leaveBanner(env, guildId, userId) {
  const m = await readMember(env, guildId, userId);
  if (!m?.bannerId) return { ok: false, error: 'not-in-banner' };
  const banner = await readBanner(env, guildId, m.bannerId);
  if (!banner) {
    // Stale membership, clear and return ok.
    await clearMember(env, guildId, userId);
    return { ok: true, deleted: 'stale' };
  }
  banner.members = (banner.members || []).filter(u => u !== userId);

  // Owner left, promote longest-tenured remaining, or dissolve the
  // banner if no one else.
  let dissolved = false;
  if (banner.ownerId === userId) {
    if (banner.members.length === 0) {
      await env.LOADOUT_BOLTS.delete(KEY.banner(guildId, banner.id));
      const idx = await readIndex(env, guildId);
      idx.bannerIds = (idx.bannerIds || []).filter(b => b !== banner.id);
      await writeIndex(env, guildId, idx);
      dissolved = true;
    } else {
      banner.ownerId = banner.members[0];
      await writeBanner(env, banner);
    }
  } else {
    await writeBanner(env, banner);
  }
  await clearMember(env, guildId, userId);
  return { ok: true, dissolved };
}

// Kick, owner-only. Idempotent.
export async function kickFromBanner(env, guildId, callerId, opts = {}) {
  const targetId = String(opts.userId || '').trim();
  if (!targetId) return { ok: false, error: 'bad-args' };
  const m = await readMember(env, guildId, callerId);
  if (!m?.bannerId) return { ok: false, error: 'not-in-banner' };
  const banner = await readBanner(env, guildId, m.bannerId);
  if (!banner) return { ok: false, error: 'no-banner' };
  if (banner.ownerId !== callerId) {
    return { ok: false, error: 'forbidden', message: 'Only the owner can kick.' };
  }
  if (targetId === callerId) return { ok: false, error: 'cant-kick-self' };
  banner.members = (banner.members || []).filter(u => u !== targetId);
  await writeBanner(env, banner);
  const target = await readMember(env, guildId, targetId);
  if (target?.bannerId === banner.id) await clearMember(env, guildId, targetId);
  return { ok: true };
}

export const _internal = {
  KEY, readBanner, readMember, writeBanner, writeMember,
  readIndex, writeIndex, FOUND_COST_BOLTS,
};
