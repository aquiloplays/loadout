// Progression — seasons + battle pass.
//
// PROGRESSION-SYSTEM-DESIGN.md §8. 90-day seasons, 50 tiers, free +
// Patreon-tier-scaled premium tracks. Each tier costs 1,000 XP
// linearly (XP feeds the pass automatically — the bus calls
// recordSeasonProgress on every event, which is wired below).
//
// Season templates live in season-templates.js — lock-in advance, hot-
// swappable from the season:active KV singleton at rollover.
//
// Storage:
//   season:active                 { seasonId, theme, startUtc, endUtc, rewardsTable }
//   season:archive:<seasonId>     same shape
//   pseason:<userId>              { seasonId, xp, tier, claimedFree[], claimedPrem[], premium }

import { SEASON_TEMPLATES, REWARD_BASE_TABLE, SEASON_LENGTH_MS, TIER_XP_COST, TIER_COUNT, CATCH_UP_DAYS, CATCH_UP_MULT } from './season-templates.js';
import { readPatreonTier, patreonRewardMultiplier } from './linking.js';

const ACTIVE_KEY = 'season:active';
const ARCHIVE_KEY = (id) => `season:archive:${id}`;
const PUSER_KEY = (uid) => `pseason:${uid}`;

// ── Active-season config ──────────────────────────────────────────

export async function getActiveSeason(env) {
  const raw = await env.LOADOUT_BOLTS.get(ACTIVE_KEY, { type: 'json' });
  return raw || null;
}

export async function putActiveSeason(env, season) {
  await env.LOADOUT_BOLTS.put(ACTIVE_KEY, JSON.stringify(season));
}

// Build a season config from a template + a start timestamp. The
// template carries theme + reward overrides; we materialise the full
// reward table here.
function materialiseSeason(template, startUtc) {
  const endUtc = startUtc + SEASON_LENGTH_MS;
  return {
    seasonId: template.seasonId,
    theme:    template.theme,
    accent:   template.accent,
    startUtc,
    endUtc,
    catchUpStartsUtc: endUtc - CATCH_UP_DAYS * 86400_000,
    catchUpMult: CATCH_UP_MULT,
    tierCount: TIER_COUNT,
    tierXpCost: TIER_XP_COST,
    rewardsTable: REWARD_BASE_TABLE,
    seasonChallenges: template.seasonChallenges || [],
    midBadge:  template.midBadge  || null,
    maxBadge:  template.maxBadge  || null,
  };
}

// Picks the active template based on the season counter (0-based).
function templateForCounter(counter) {
  const t = SEASON_TEMPLATES[counter % SEASON_TEMPLATES.length];
  return t;
}

// Idempotent — call from the cron tick. If no active season, mint
// the first one. If active.endUtc is in the past, roll over.
export async function ensureCurrentSeason(env, nowUtc = Date.now()) {
  const active = await getActiveSeason(env);
  if (active && active.endUtc > nowUtc) return active;
  // Need a new one. Counter = (number of past archives).
  let counter = 0;
  try {
    const idx = await env.LOADOUT_BOLTS.list({ prefix: 'season:archive:', limit: 1000 });
    counter = idx.keys.length;
  } catch { /* fallback to counter 0 */ }
  // Archive the outgoing season.
  if (active) {
    try {
      await env.LOADOUT_BOLTS.put(ARCHIVE_KEY(active.seasonId), JSON.stringify(active));
    } catch { /* non-fatal */ }
  }
  // Mint the next one.
  const template = templateForCounter(counter);
  const startUtc = active ? active.endUtc : nowUtc;
  const next = materialiseSeason(template, startUtc);
  await putActiveSeason(env, next);
  return next;
}

// ── Per-user progress ────────────────────────────────────────────

function freshUser(seasonId) {
  return {
    seasonId,
    xp: 0,
    tier: 0,
    claimedFree: [],
    claimedPrem: [],
    premium: false,    // recomputed at claim time from current Patreon tier
  };
}

export async function getUserSeason(env, userId) {
  const raw = await env.LOADOUT_BOLTS.get(PUSER_KEY(userId), { type: 'json' });
  return raw || null;
}

export async function putUserSeason(env, userId, rec) {
  await env.LOADOUT_BOLTS.put(PUSER_KEY(userId), JSON.stringify(rec));
}

// Bus consumer #3 — called by event-bus.js right after the XP grant.
// xpResult carries the amount that was actually granted (post-cap).
// We mirror that into the user's seasonal progress + recompute tier.
export async function recordSeasonProgress(env, event, xpResult) {
  if (!xpResult?.granted) return null;
  const active = await ensureCurrentSeason(env, event.utc);
  if (!active) return null;
  let rec = await getUserSeason(env, event.userId);
  if (!rec || rec.seasonId !== active.seasonId) {
    rec = freshUser(active.seasonId);
  }
  // Catch-up multiplier — last N days of season, all XP counts at 1.5×.
  let credit = xpResult.granted;
  if (event.utc >= active.catchUpStartsUtc) {
    credit = Math.round(credit * active.catchUpMult);
  }
  rec.xp += credit;
  const newTier = Math.min(active.tierCount, Math.floor(rec.xp / active.tierXpCost));
  const tierJumped = newTier > rec.tier;
  rec.tier = newTier;
  await putUserSeason(env, event.userId, rec);
  return { credit, tier: rec.tier, tierJumped };
}

// ── Claim ─────────────────────────────────────────────────────────
//
// Viewer hits a tier → claim reward. Free track is always claimable;
// premium track is gated on the viewer's current Patreon tier (any
// tier unlocks; higher tiers scale rewards via patreonRewardMultiplier).
//
// Idempotent — re-claim returns alreadyClaimed:true.

export async function claimTier(env, userId, tier, track) {
  if (track !== 'free' && track !== 'premium') return { ok: false, error: 'bad-track' };
  const active = await getActiveSeason(env);
  if (!active) return { ok: false, error: 'no-active-season' };
  if (tier < 1 || tier > active.tierCount) return { ok: false, error: 'bad-tier' };
  let rec = await getUserSeason(env, userId);
  if (!rec || rec.seasonId !== active.seasonId) {
    rec = freshUser(active.seasonId);
  }
  if (rec.tier < tier) return { ok: false, error: 'tier-not-reached', earnedTier: rec.tier };

  const claimedList = track === 'free' ? rec.claimedFree : rec.claimedPrem;
  if (claimedList.includes(tier)) return { ok: false, error: 'already-claimed' };

  // Premium gate.
  let mult = 1.0;
  if (track === 'premium') {
    const patTier = await readPatreonTier(env, userId);
    mult = patreonRewardMultiplier(patTier);
    if (mult === 0) return { ok: false, error: 'premium-locked' };
    rec.premium = true;   // sticky — record that this user has redeemed any premium tier
  }

  // Look up the base reward for this tier+track. Pad with empty if
  // template doesn't define the tier exactly (treat as no reward).
  const baseList = active.rewardsTable[tier - 1] || { free: {}, premium: {} };
  const base = baseList[track] || {};

  // Compute the resolved reward — numeric fields scale by mult,
  // badge/title/frame fields are flat.
  const reward = {
    bolts: Math.round((base.bolts || 0) * mult),
    fragments: Math.round((base.fragments || 0) * mult),
    lootboxes: Math.round((base.lootboxes || 0) * mult),
    badgeId: base.badgeId || null,
    title: base.title || null,
    flairFrame: base.flairFrame || null,
  };

  // Apply rewards. Bolts → wallet (the user's home guild is the one
  // their pprofile records; for simplicity we credit `null` guildId
  // and the wallet helper handles cross-guild aggregation in a
  // follow-up). For now we just hold the credit on a season-wallet
  // record. P6 ships with this stub; P7 wires the real wallet
  // bridging.
  try {
    if (reward.bolts > 0) {
      // Stub: record on a per-user season-bolts ledger. A future
      // pass aggregates via the wallet module.
      const ledKey = `pseason:bolts:${userId}`;
      const cur = (await env.LOADOUT_BOLTS.get(ledKey, { type: 'json' })) || { bolts: 0 };
      cur.bolts += reward.bolts;
      await env.LOADOUT_BOLTS.put(ledKey, JSON.stringify(cur));
    }
    if (reward.fragments > 0) {
      const { addFragments } = await import('../cards-fragments.js');
      if (addFragments) await addFragments(env, userId, reward.fragments, 'season:claim');
    }
    if (reward.lootboxes > 0) {
      // Stub: defer to the existing lootbox grant flow. Hold on a
      // per-user season ledger for now.
      const ledKey = `pseason:lbgrants:${userId}`;
      const cur = (await env.LOADOUT_BOLTS.get(ledKey, { type: 'json' })) || { count: 0 };
      cur.count += reward.lootboxes;
      await env.LOADOUT_BOLTS.put(ledKey, JSON.stringify(cur));
    }
    if (reward.badgeId) {
      const { awardBadge } = await import('./badges.js');
      if (awardBadge) await awardBadge(env, userId, reward.badgeId, `season:${active.seasonId}:tier${tier}`);
    }
  } catch (e) {
    console.warn('[season] grant side-effect failed:', e && e.message);
  }

  claimedList.push(tier);
  await putUserSeason(env, userId, rec);
  return { ok: true, tier, track, mult, reward, claimedFree: rec.claimedFree, claimedPrem: rec.claimedPrem };
}

// ── Display payload for the profile page + dedicated season page ─

export async function readSeasonDisplay(env, userId) {
  const active = await ensureCurrentSeason(env);
  if (!active) return { active: null };
  let rec = await getUserSeason(env, userId);
  if (!rec || rec.seasonId !== active.seasonId) {
    rec = freshUser(active.seasonId);
  }
  // Resolve the Patreon multiplier once for premium-track display.
  const patTier = await readPatreonTier(env, userId);
  const premiumMult = patreonRewardMultiplier(patTier);
  return {
    active: {
      seasonId: active.seasonId, theme: active.theme, accent: active.accent,
      startUtc: active.startUtc, endUtc: active.endUtc,
      catchUpStartsUtc: active.catchUpStartsUtc, catchUpMult: active.catchUpMult,
      tierCount: active.tierCount, tierXpCost: active.tierXpCost,
    },
    user: {
      xp: rec.xp,
      tier: rec.tier,
      xpToNext: (rec.tier < active.tierCount) ? Math.max(0, (rec.tier + 1) * active.tierXpCost - rec.xp) : 0,
      claimedFree: rec.claimedFree,
      claimedPrem: rec.claimedPrem,
      premiumUnlocked: premiumMult > 0,
      premiumMult,
      patreonTier: patTier,
    },
    tiers: active.rewardsTable.map((row, i) => ({
      tier: i + 1,
      free: row.free || {},
      premium: row.premium || {},
    })),
  };
}
