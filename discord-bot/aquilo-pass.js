// Aquilo Pass, Boltbound-focused seasonal battle pass.
//
// 2026-05-29. 50 tiers per season (one per Spire monthly theme).
// XP accumulates from Boltbound + mini-game activity that emits a
// progression event, Boltbound match wins, pack opens, Spire clears,
// pet evolutions, daily check-in. Free track always claimable. Premium track gated
// on paid Patreon, caller can buy the premium pass mid-season for
// retroactive premium-tier claim eligibility (future hook; MVP just
// gates on userHasPaidPatreon).
//
// KV layout (LOADOUT_BOLTS):
//   aquilo-pass:season:<seasonId>  -> SeasonDef (currently mostly
//                                      derived from Spire seasons,
//                                      cached for fast reads)
//   aquilo-pass:user:<userId>:<seasonId> -> { xp, level,
//                                             claimedFree: [tier...],
//                                             claimedPremium: [tier...],
//                                             updatedUtc }
//
// XP curve: 100 + (tier * 25) per tier, tier 1 = 100 XP, tier 50 =
// 1325 XP. Total across the season = (50 * (100 + 50*25/2)) ≈
// 36 250 XP. Roughly 4-6 weeks of moderate activity for free, faster
// for active players.
//
// Rewards live in REWARDS_BY_TIER per track. Caller-facing endpoint
// returns shaped JSON the site renders into the tier ladder. Claim
// helpers grant via the existing wallet / cosmetic systems.

import { userHasPaidPatreon } from './patreon-link.js';
import { earn as walletEarn } from './wallet.js';

const TIERS_PER_SEASON = 50;

// XP needed to clear tier N (one-indexed). Cumulative XP to reach
// tier N = sum(xpForTier(i) for i in 1..N).
function xpForTier(tier) {
  return 100 + Math.max(0, tier - 1) * 25;
}

function cumulativeXpForTier(tier) {
  let sum = 0;
  for (let i = 1; i <= tier; i++) sum += xpForTier(i);
  return sum;
}

function tierForXp(xp) {
  let cum = 0;
  for (let t = 1; t <= TIERS_PER_SEASON; t++) {
    cum += xpForTier(t);
    if (xp < cum) return t - 1;
  }
  return TIERS_PER_SEASON;
}

// XP yields per event kind. Anything not listed defaults to 5. The
// kinds align with what progression/event-bus.js emits today.
export const XP_BY_KIND = Object.freeze({
  'boltbound.match.won':       50,
  'boltbound.match.played':    10,
  'boltbound.pack.opened':     15,
  'cards.crafted':             20,
  'cards.disenchanted':         5,
  'spire.floor.cleared':       30,
  'spire.boss.defeated':      150,
  'spire.run.completed':      100,
  'pet.evolved':               75,
  'pet.fed':                    3,
  'checkin.claimed':            5,
});

// Rewards per (tier, track). Hand-tuned MVP, first season uses a
// generic catalog. Later seasons can override via the season def in
// KV (aquilo-pass:season:<seasonId>.rewardsOverride).
const TIER_REWARDS_DEFAULT = (() => {
  const arr = [];
  for (let t = 1; t <= TIERS_PER_SEASON; t++) {
    const milestone = t % 10 === 0;
    const big       = t === TIERS_PER_SEASON;
    arr.push({
      tier: t,
      free: big ? { kind: 'pack',     packType: 'legendary' }
           : milestone ? { kind: 'pack', packType: 'rare' }
           : t % 5 === 0 ? { kind: 'bolts', amount: 250 }
           : { kind: 'bolts', amount: 100 },
      premium: big ? { kind: 'cosmetic',  cosmeticId: 'pass-season-finisher-frame' }
              : milestone ? { kind: 'pack', packType: 'epic' }
              : t % 5 === 0 ? { kind: 'bolts', amount: 500 }
              : { kind: 'pack', packType: 'common' },
    });
  }
  return arr;
})();

// Season id derived from current month-of-year. Aligns with Spire
// rotation so the pass theme matches the active boss.
function currentSeasonId() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const KEY = {
  season: (sid)      => `aquilo-pass:season:${sid}`,
  user:   (uid, sid) => `aquilo-pass:user:${uid}:${sid}`,
};

// Read/write helpers.
async function readUserPass(env, userId, seasonId) {
  const raw = await env.LOADOUT_BOLTS.get(KEY.user(userId, seasonId), { type: 'json' });
  return raw || {
    xp: 0, level: 0,
    claimedFree: [], claimedPremium: [],
    updatedUtc: null,
  };
}
async function writeUserPass(env, userId, seasonId, rec) {
  rec.updatedUtc = new Date().toISOString();
  await env.LOADOUT_BOLTS.put(KEY.user(userId, seasonId), JSON.stringify(rec));
}

// ── Public API ──────────────────────────────────────────────────

// Grant XP for one event. Idempotent on (kind, eventId) when eventId
// is provided, caller passes a stable id to dedupe retries.
export async function grantPassXp(env, userId, kind, opts = {}) {
  if (!userId || !kind) return { ok: false, error: 'bad-args' };
  const xp = opts.overrideXp != null
    ? Math.max(0, parseInt(opts.overrideXp, 10) || 0)
    : (XP_BY_KIND[kind] != null ? XP_BY_KIND[kind] : 5);
  if (xp <= 0) return { ok: true, granted: 0 };

  const sid = currentSeasonId();
  // Dedup gate when eventId is supplied.
  if (opts.eventId) {
    const dedupKey = `aquilo-pass:dedup:${userId}:${sid}:${opts.eventId}`;
    const seen = await env.LOADOUT_BOLTS.get(dedupKey);
    if (seen) return { ok: true, granted: 0, deduped: true };
    await env.LOADOUT_BOLTS.put(dedupKey, '1', { expirationTtl: 60 * 60 * 24 * 35 });
  }

  const rec = await readUserPass(env, userId, sid);
  rec.xp = (rec.xp || 0) + xp;
  rec.level = tierForXp(rec.xp);
  await writeUserPass(env, userId, sid, rec);
  return { ok: true, granted: xp, xp: rec.xp, level: rec.level, seasonId: sid };
}

// Site-facing read. Returns full ladder shape so the renderer can
// build the tier list without follow-up calls.
export async function getPassState(env, userId) {
  const sid = currentSeasonId();
  const rec = await readUserPass(env, userId, sid);
  const isPatron = await userHasPaidPatreon(env, userId).catch(() => false);
  const tiers = TIER_REWARDS_DEFAULT.map(r => ({
    ...r,
    unlocked:        rec.level >= r.tier,
    claimedFree:     rec.claimedFree.includes(r.tier),
    claimedPremium:  rec.claimedPremium.includes(r.tier),
    premiumLocked:   !isPatron,
  }));
  const nextTier  = rec.level + 1;
  const cumNext   = nextTier <= TIERS_PER_SEASON ? cumulativeXpForTier(nextTier) : null;
  const xpInTier  = nextTier <= TIERS_PER_SEASON
    ? rec.xp - (cumNext - xpForTier(nextTier))
    : 0;
  return {
    ok: true,
    seasonId:        sid,
    tiersPerSeason:  TIERS_PER_SEASON,
    xp:              rec.xp,
    level:           rec.level,
    xpInCurrentTier: Math.max(0, xpInTier),
    xpToNextTier:    nextTier <= TIERS_PER_SEASON ? xpForTier(nextTier) : 0,
    isPatron,
    tiers,
  };
}

// Claim a tier (free or premium). Idempotent, re-claim is a no-op
// returning the existing reward record.
export async function claimPassTier(env, guildId, userId, opts = {}) {
  const tier  = Math.max(1, Math.min(TIERS_PER_SEASON, parseInt(opts.tier, 10) || 0));
  const track = opts.track === 'premium' ? 'premium' : 'free';
  if (!tier) return { ok: false, error: 'bad-tier' };

  const sid = currentSeasonId();
  const rec = await readUserPass(env, userId, sid);
  if (rec.level < tier) {
    return { ok: false, error: 'tier-locked', message: `Reach tier ${tier} first.` };
  }
  if (track === 'premium') {
    const isPatron = await userHasPaidPatreon(env, userId).catch(() => false);
    if (!isPatron) {
      return { ok: false, error: 'patreon-required',
               message: 'Premium track is Patreon-only.',
               unlockUrl: 'https://www.patreon.com/cw/aquilo/membership' };
    }
  }
  const list = track === 'premium' ? rec.claimedPremium : rec.claimedFree;
  if (list.includes(tier)) {
    return { ok: true, alreadyClaimed: true, tier, track };
  }
  const reward = TIER_REWARDS_DEFAULT[tier - 1]?.[track];
  if (!reward) return { ok: false, error: 'no-reward' };

  // Grant reward, bolts use wallet.earn, packs use creditPack,
  // cosmetics use the cosmetics module (or skip if not wired yet).
  let granted = { kind: reward.kind };
  try {
    if (reward.kind === 'bolts') {
      await walletEarn(env, guildId, userId, reward.amount, `aquilo-pass:${sid}:t${tier}:${track}`);
      granted.amount = reward.amount;
    } else if (reward.kind === 'pack') {
      const { creditPack } = await import('./cards-packs.js');
      const r = await creditPack(env, guildId, userId, reward.packType, `aquilo-pass:${sid}:t${tier}:${track}`);
      granted.packId   = r?.pack?.id || null;
      granted.packType = reward.packType;
    } else if (reward.kind === 'cosmetic') {
      // Best-effort cosmetics grant, module may not be wired in MVP.
      try {
        const cos = await import('./cosmetics.js').catch(() => null);
        if (cos?.grantCosmetic) await cos.grantCosmetic(env, userId, reward.cosmeticId);
      } catch { /* non-fatal */ }
      granted.cosmeticId = reward.cosmeticId;
    }
  } catch (e) {
    return { ok: false, error: 'grant-failed', detail: String(e?.message || e) };
  }
  list.push(tier);
  await writeUserPass(env, userId, sid, rec);
  return { ok: true, tier, track, granted, xp: rec.xp, level: rec.level };
}
