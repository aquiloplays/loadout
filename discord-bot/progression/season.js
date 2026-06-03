// Progression, seasons + battle pass.
//
// PROGRESSION-SYSTEM-DESIGN.md §8. 90-day seasons, 50 tiers, free +
// Patreon-gated premium track (single tier, patron/non-patron, see
// linking.isPatron). Each tier costs 1,000 XP linearly (XP feeds
// the pass automatically, the bus calls recordSeasonProgress on
// every event, which is wired below).
//
// Season templates live in season-templates.js, lock-in advance, hot-
// swappable from the season:active KV singleton at rollover.
//
// Storage:
//   season:active                 { seasonId, theme, startUtc, endUtc, rewardsTable }
//   season:archive:<seasonId>     same shape
//   pseason:<userId>              { seasonId, xp, tier, claimedFree[],
//                                   claimedPrem[], premium,
//                                   premiumEarnedTiers[] }
//
// SEASON-END EXPIRY (2026-05, Clay):
//   Unclaimed rewards die when the season rolls over. claimTier
//   explicitly rejects past endUtc with `season-ended`. The display
//   payload surfaces endUtc + expired + msRemaining so the website
//   can show a "claim before <date>" state.
//
// PATREON-CANCEL BEHAVIOR (2026-05, Clay):
//   Premium tiers EARNED while a patron stay claimable after cancel
//, until the season expires. The user simply stops accruing NEW
//   premium-eligible tiers the moment they cancel. Tracking lives on
//   `premiumEarnedTiers[]`, recordSeasonProgress pushes a tier
//   number into the array only when the user is currently isPatron
//   at the moment of crossing. claimTier for premium passes if the
//   tier is in that list (current Patreon state irrelevant).
//
//   Backwards compat: pre-this-change pseason records have no
//   premiumEarnedTiers field. On first encounter we backfill, if
//   the user is currently a patron, treat all tiers up to rec.tier
//   as earned-while-patron; otherwise empty. New tier crossings
//   accumulate normally from there.

import { SEASON_TEMPLATES, REWARD_BASE_TABLE, SEASON_LENGTH_MS, TIER_XP_COST, TIER_COUNT, CATCH_UP_DAYS, CATCH_UP_MULT } from './season-templates.js';
import { isPatron } from './linking.js';

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

// Idempotent, call from the cron tick. If no active season, mint
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
    premium: false,            // sticky, set true the first time the user redeems any premium reward
    premiumEarnedTiers: [],    // tiers crossed while the user was an active patron
  };
}

// Backfill the premiumEarnedTiers field on a record loaded from KV
// that pre-dates the 2026-05 patron-cancel change. Stamps the field
// in-place once so subsequent reads skip the backfill cost. Idempotent.
function backfillPremiumEarnedTiers(rec, isPatronNow) {
  if (Array.isArray(rec.premiumEarnedTiers)) return;
  // If the user is currently a patron we conservatively assume every
  // tier they reached so far was reached while patron. If they're
  // not currently patron, we assume none, they can re-subscribe
  // if they want to retroactively claim, matching pre-change
  // behaviour. Future tier crossings track precisely per recordSeasonProgress.
  rec.premiumEarnedTiers = isPatronNow
    ? Array.from({ length: rec.tier }, (_, i) => i + 1)
    : [];
}

export async function getUserSeason(env, userId) {
  const raw = await env.LOADOUT_BOLTS.get(PUSER_KEY(userId), { type: 'json' });
  return raw || null;
}

export async function putUserSeason(env, userId, rec) {
  await env.LOADOUT_BOLTS.put(PUSER_KEY(userId), JSON.stringify(rec));
}

// Bus consumer #3, called by event-bus.js right after the XP grant.
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
  // Catch-up multiplier, last N days of season, all XP counts at 1.5×.
  let credit = xpResult.granted;
  if (event.utc >= active.catchUpStartsUtc) {
    credit = Math.round(credit * active.catchUpMult);
  }
  rec.xp += credit;
  const newTier = Math.min(active.tierCount, Math.floor(rec.xp / active.tierXpCost));
  const previousTier = rec.tier;
  const tierJumped = newTier > previousTier;
  rec.tier = newTier;

  // Patron-cancel tracking, stamp each newly-crossed tier as
  // "earned while patron" IFF the user is currently isPatron. If
  // they cancel mid-season the freeze is immediate: subsequent tier
  // crossings won't be stamped, so they can't claim those tiers'
  // premium reward later. Tiers already in premiumEarnedTiers stay
  // claimable through to season-end expiry.
  if (tierJumped) {
    if (!Array.isArray(rec.premiumEarnedTiers)) {
      // Backfill on first encounter with the new field.
      const patronNow = await isPatron(env, event.userId);
      backfillPremiumEarnedTiers(rec, patronNow);
      // If the user is currently a patron, mark the newly-crossed
      // tiers too, backfill above only covers up to previousTier.
      if (patronNow) {
        for (let t = previousTier + 1; t <= newTier; t++) rec.premiumEarnedTiers.push(t);
      }
    } else {
      // Normal path, extra read only when a tier was actually crossed.
      const patronNow = await isPatron(env, event.userId);
      if (patronNow) {
        for (let t = previousTier + 1; t <= newTier; t++) {
          if (!rec.premiumEarnedTiers.includes(t)) rec.premiumEarnedTiers.push(t);
        }
      }
    }
  }

  await putUserSeason(env, event.userId, rec);
  return { credit, tier: rec.tier, tierJumped };
}

// ── Claim ─────────────────────────────────────────────────────────
//
// Viewer hits a tier → claim reward. Free track is always claimable;
// premium track is gated on Patreon membership (patron / non-patron,
// no tiers, see linking.isPatron).
//
// Idempotent, re-claim returns alreadyClaimed:true.

export async function claimTier(env, userId, tier, track) {
  if (track !== 'free' && track !== 'premium') return { ok: false, error: 'bad-track' };
  const active = await getActiveSeason(env);
  if (!active) return { ok: false, error: 'no-active-season' };
  if (tier < 1 || tier > active.tierCount) return { ok: false, error: 'bad-tier' };
  // SEASON-END EXPIRY, unclaimed rewards die when the season
  // rolls over. The ensureCurrentSeason path also wipes the user's
  // rec on rollover, but we reject explicitly here so the website
  // gets a clean error code it can render as "season ended; rewards
  // were not claimed in time."
  if (Date.now() > active.endUtc) {
    return { ok: false, error: 'season-ended', endedUtc: active.endUtc };
  }
  let rec = await getUserSeason(env, userId);
  if (!rec || rec.seasonId !== active.seasonId) {
    rec = freshUser(active.seasonId);
  }
  if (rec.tier < tier) return { ok: false, error: 'tier-not-reached', earnedTier: rec.tier };

  const claimedList = track === 'free' ? rec.claimedFree : rec.claimedPrem;
  if (claimedList.includes(tier)) return { ok: false, error: 'already-claimed' };

  // Premium gate, claimable IFF the user earned this tier while
  // they were a patron (premiumEarnedTiers tracks that precisely).
  // A cancelled-mid-season patron keeps access to tiers they
  // already earned; new accruals stop the moment they cancel.
  if (track === 'premium') {
    const patronNow = await isPatron(env, userId);
    backfillPremiumEarnedTiers(rec, patronNow);
    if (!rec.premiumEarnedTiers.includes(tier)) {
      return {
        ok: false,
        error: 'premium-locked',
        reason: patronNow
          ? 'tier-not-earned-while-patron'   // shouldn't happen for current patrons, every cross is stamped
          : 'cancelled-after-tier-earned',   // user cancelled before crossing this tier
      };
    }
    rec.premium = true;   // sticky, record that this user redeemed premium
  }

  // Look up the reward for this tier+track. Pad with empty if the
  // template doesn't define the tier exactly (treat as no reward).
  // Rewards are granted verbatim, no per-tier multipliers anymore.
  const baseList = active.rewardsTable[tier - 1] || { free: {}, premium: {} };
  const base = baseList[track] || {};
  const reward = {
    bolts:     base.bolts     || 0,
    fragments: base.fragments || 0,
    lootboxes: base.lootboxes || 0,
    badgeId:   base.badgeId   || null,
    title:     base.title     || null,
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
  return { ok: true, tier, track, reward, claimedFree: rec.claimedFree, claimedPrem: rec.claimedPrem };
}

// ── Display payload for the profile page + dedicated season page ─

export async function readSeasonDisplay(env, userId) {
  const active = await ensureCurrentSeason(env);
  if (!active) return { active: null };
  let rec = await getUserSeason(env, userId);
  if (!rec || rec.seasonId !== active.seasonId) {
    rec = freshUser(active.seasonId);
  }
  // Patron presence check, single-tier, all-or-nothing.
  const patron = await isPatron(env, userId);
  // Make sure premiumEarnedTiers is populated so the per-tier claim
  // state below is correct for pre-change records.
  backfillPremiumEarnedTiers(rec, patron);
  const now = Date.now();
  const expired = now > active.endUtc;
  const msRemaining = Math.max(0, active.endUtc - now);
  const claimedFreeSet = new Set(rec.claimedFree);
  const claimedPremSet = new Set(rec.claimedPrem);
  const earnedPremSet  = new Set(rec.premiumEarnedTiers);
  return {
    active: {
      seasonId: active.seasonId, theme: active.theme, accent: active.accent,
      startUtc: active.startUtc, endUtc: active.endUtc,
      catchUpStartsUtc: active.catchUpStartsUtc, catchUpMult: active.catchUpMult,
      tierCount: active.tierCount, tierXpCost: active.tierXpCost,
      // SEASON-END EXPIRY surfaced for the website's "claim before X" UI.
      expired,
      msRemaining,
      expiresInDays: Math.floor(msRemaining / 86_400_000),
    },
    user: {
      xp: rec.xp,
      tier: rec.tier,
      xpToNext: (rec.tier < active.tierCount) ? Math.max(0, (rec.tier + 1) * active.tierXpCost - rec.xp) : 0,
      claimedFree: rec.claimedFree,
      claimedPrem: rec.claimedPrem,
      premiumEarnedTiers: rec.premiumEarnedTiers,
      premiumUnlocked: patron,         // can NEW premium tiers be earned right now
      isPatron: patron,
    },
    // Per-tier claim-state matrix so the website can render the
    // "Claim" / "Claimed" / "Locked" / "Expired" badge per tile
    // without re-deriving the rules client-side. Driven entirely
    // by server-side state, single source of truth.
    tiers: active.rewardsTable.map((row, i) => {
      const tier = i + 1;
      const reached = rec.tier >= tier;
      const freeClaimed  = claimedFreeSet.has(tier);
      const premClaimed  = claimedPremSet.has(tier);
      const earnedPrem   = earnedPremSet.has(tier);
      return {
        tier,
        free: row.free || {},
        premium: row.premium || {},
        state: {
          reached,
          // free track, anyone who reached the tier can claim, until expiry
          freeClaimState:    !reached ? 'locked'
                            : freeClaimed ? 'claimed'
                            : expired ? 'expired'
                            : 'claimable',
          // premium track, must have earned the tier WHILE patron
          premiumClaimState: !reached ? 'locked'
                            : premClaimed ? 'claimed'
                            : !earnedPrem ? 'patron-locked'
                            : expired ? 'expired'
                            : 'claimable',
        },
      };
    }),
  };
}
