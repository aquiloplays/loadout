// Aquilo Pass v2 — D1-backed seasonal battle pass.
//
// 2026-05-31 sprint. 30 tiers per season, free + premium tracks. The
// reward catalogue lives in D1 (aquilo_pass_reward, seeded per season);
// per-user progress in user_pass_progress. Namespaced behind
// /web/pass2/* so it coexists with the legacy KV pass (aquilo-pass.js).
//
// XP model: flat XP_PER_TIER per tier, tier = min(TIERS, xp/per-tier).
// XP is granted by gameplay hooks via grantPassXp(). Claiming a tier's
// reward requires (a) the user has reached that tier, (b) for premium
// rewards, the user owns the premium track, (c) it isn't already
// claimed. Reward grants fan out to bolts (wallet), aether (ledger),
// cosmetics (pbadge), or packs.
//
// Public API:
//   seedSeasonOne(env)                       -> ensure season-1 + 60 rewards
//   getActiveSeason(env)                     -> season row | null
//   getPassState(env, userId)                -> full state for the UI
//   grantPassXp(env, userId, amount, reason) -> bump xp + tier
//   claimTier(env, userId, tier, track)      -> grant if eligible (idempotent)
//   setPremium(env, userId, on)              -> own/disown the premium track

const TIERS = 30;
const XP_PER_TIER = 100;          // flat — 3000 XP for a full pass
const SEASON_ONE_ID = 'season-1';

function db(env) {
  if (!env || !env.DB) throw new Error('aquilo-pass-d1: no D1 binding (env.DB missing)');
  return env.DB;
}

export function tierForXp(xp) {
  return Math.max(0, Math.min(TIERS, Math.floor((Number(xp) || 0) / XP_PER_TIER)));
}

// ── Season + reward catalogue ─────────────────────────────────────

export async function getActiveSeason(env) {
  const D = db(env);
  const row = await D.prepare(
    `SELECT id, name, started_at, ends_at, tiers, active
       FROM aquilo_pass_season WHERE active = 1
      ORDER BY started_at DESC LIMIT 1`
  ).first();
  return row || null;
}

// Season-1 reward design (hand-tuned MVP). Free track: scaling bolts
// every tier + a pack at the quarter marks. Premium: aether every tier,
// a cosmetic at tiers 10/20, and a finisher cosmetic at 30.
function seasonOneRewards() {
  const rows = [];
  for (let t = 1; t <= TIERS; t++) {
    // Free track.
    if (t % 5 === 0) {
      rows.push([t, 'free', 'pack', JSON.stringify({ packId: 'bolt' })]);
    } else {
      rows.push([t, 'free', 'bolts', JSON.stringify({ amount: 25 + t * 5 })]);
    }
    // Premium track.
    if (t === TIERS) {
      rows.push([t, 'premium', 'cosmetic', JSON.stringify({ cosmeticId: 'pass-s1-finisher-frame' })]);
    } else if (t === 10) {
      rows.push([t, 'premium', 'cosmetic', JSON.stringify({ cosmeticId: 'pass-s1-emote-spark' })]);
    } else if (t === 20) {
      rows.push([t, 'premium', 'cosmetic', JSON.stringify({ cosmeticId: 'pass-s1-banner-aurora' })]);
    } else {
      rows.push([t, 'premium', 'aether', JSON.stringify({ amount: 10 + t })]);
    }
  }
  return rows;
}

// Idempotent: create season-1 + its 60 reward rows if absent.
export async function seedSeasonOne(env, opts = {}) {
  const D = db(env);
  const now = Number.isFinite(opts.nowUtc) ? opts.nowUtc : Date.now();
  const existing = await D.prepare(
    `SELECT id FROM aquilo_pass_season WHERE id = ? LIMIT 1`
  ).bind(SEASON_ONE_ID).first();
  if (!existing) {
    await D.prepare(
      `INSERT OR IGNORE INTO aquilo_pass_season (id, name, started_at, ends_at, tiers, active)
       VALUES (?, ?, ?, NULL, ?, 1)`
    ).bind(SEASON_ONE_ID, 'Season 1 — Stormrise', now, TIERS).run();
  }
  let inserted = 0;
  for (const [tier, track, kind, payload] of seasonOneRewards()) {
    const r = await D.prepare(
      `INSERT OR IGNORE INTO aquilo_pass_reward (season_id, tier, track, kind, payload)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(SEASON_ONE_ID, tier, track, kind, payload).run();
    if (r?.meta?.changes) inserted++;
  }
  return { ok: true, seasonId: SEASON_ONE_ID, tiers: TIERS, rewardsInserted: inserted };
}

async function rewardsForSeason(D, seasonId) {
  const { results } = await D.prepare(
    `SELECT tier, track, kind, payload FROM aquilo_pass_reward
      WHERE season_id = ? ORDER BY tier ASC`
  ).bind(seasonId).all();
  return results || [];
}

// ── Per-user progress ─────────────────────────────────────────────

function parseClaimed(csv) {
  if (!csv) return new Set();
  return new Set(String(csv).split(',').filter(Boolean).map(Number));
}
function serializeClaimed(set) {
  return [...set].sort((a, b) => a - b).join(',');
}

async function readProgress(D, seasonId, userId) {
  return D.prepare(
    `SELECT season_id, user_id, xp, tier, premium, claimed_free, claimed_premium, updated_at
       FROM user_pass_progress WHERE season_id = ? AND user_id = ? LIMIT 1`
  ).bind(seasonId, String(userId)).first();
}

async function ensureProgress(D, seasonId, userId) {
  let row = await readProgress(D, seasonId, userId);
  if (row) return row;
  await D.prepare(
    `INSERT OR IGNORE INTO user_pass_progress
       (season_id, user_id, xp, tier, premium, claimed_free, claimed_premium, updated_at)
     VALUES (?, ?, 0, 0, 0, '', '', ?)`
  ).bind(seasonId, String(userId), Date.now()).run();
  row = await readProgress(D, seasonId, userId);
  return row;
}

// Full state payload for the UI: season meta + the user's xp/tier/
// premium + every tier's rewards with claim eligibility.
export async function getPassState(env, userId) {
  const D = db(env);
  const season = await getActiveSeason(env);
  if (!season) return { ok: false, error: 'no-active-season' };
  const prog = await ensureProgress(D, season.id, userId);
  const claimedFree = parseClaimed(prog.claimed_free);
  const claimedPremium = parseClaimed(prog.claimed_premium);
  const rewards = await rewardsForSeason(D, season.id);

  const byTier = new Map();
  for (const r of rewards) {
    if (!byTier.has(r.tier)) byTier.set(r.tier, { tier: r.tier, free: null, premium: null });
    let payload = null;
    try { payload = r.payload ? JSON.parse(r.payload) : null; } catch { payload = null; }
    byTier.get(r.tier)[r.track] = { kind: r.kind, payload };
  }
  const tier = Number(prog.tier || 0);
  const premium = !!prog.premium;
  const tiers = [...byTier.values()].sort((a, b) => a.tier - b.tier).map(t => ({
    ...t,
    freeClaimed: claimedFree.has(t.tier),
    premiumClaimed: claimedPremium.has(t.tier),
    freeClaimable: t.free && tier >= t.tier && !claimedFree.has(t.tier),
    premiumClaimable: t.premium && premium && tier >= t.tier && !claimedPremium.has(t.tier),
  }));

  return {
    ok: true,
    season: { id: season.id, name: season.name, tiers: season.tiers,
              startedAt: season.started_at, endsAt: season.ends_at },
    progress: {
      xp: Number(prog.xp || 0), tier, premium,
      xpPerTier: XP_PER_TIER, maxTier: TIERS,
      xpIntoTier: Number(prog.xp || 0) % XP_PER_TIER,
    },
    tiers,
  };
}

// Grant XP, recompute tier. Returns the new xp/tier + how many tiers
// were gained (for "tier up!" UI).
export async function grantPassXp(env, userId, amount, reason) {
  const amt = Math.floor(Number(amount) || 0);
  if (!userId) return { ok: false, error: 'bad-args' };
  if (amt <= 0) return { ok: false, error: 'bad-amount' };
  const D = db(env);
  const season = await getActiveSeason(env);
  if (!season) return { ok: false, error: 'no-active-season' };
  const prog = await ensureProgress(D, season.id, userId);
  const prevTier = Number(prog.tier || 0);
  const newXp = Number(prog.xp || 0) + amt;
  const newTier = tierForXp(newXp);
  await D.prepare(
    `UPDATE user_pass_progress SET xp = ?, tier = ?, updated_at = ?
      WHERE season_id = ? AND user_id = ?`
  ).bind(newXp, newTier, Date.now(), season.id, String(userId)).run();
  return { ok: true, xp: newXp, tier: newTier, tiersGained: Math.max(0, newTier - prevTier),
           reason: reason || 'xp' };
}

export async function setPremium(env, userId, on) {
  if (!userId) return { ok: false, error: 'bad-args' };
  const D = db(env);
  const season = await getActiveSeason(env);
  if (!season) return { ok: false, error: 'no-active-season' };
  await ensureProgress(D, season.id, userId);
  await D.prepare(
    `UPDATE user_pass_progress SET premium = ?, updated_at = ?
      WHERE season_id = ? AND user_id = ?`
  ).bind(on ? 1 : 0, Date.now(), season.id, String(userId)).run();
  return { ok: true, premium: !!on };
}

// ── Claim ─────────────────────────────────────────────────────────

async function grantReward(env, guildId, userId, kind, payload) {
  try {
    if (kind === 'bolts') {
      const { earn } = await import('./wallet.js');
      await earn(env, guildId, userId, Number(payload?.amount) || 0, 'pass2:reward');
      return { kind, amount: payload?.amount };
    }
    if (kind === 'aether') {
      const { grantAether } = await import('./aether.js');
      await grantAether(env, guildId, userId, Number(payload?.amount) || 0, 'pass2:reward');
      return { kind, amount: payload?.amount };
    }
    if (kind === 'cosmetic') {
      const key = `pbadge:${userId}`;
      const rec = (await env.LOADOUT_BOLTS.get(key, { type: 'json' })) || { owned: [], firstEarnedUtc: {}, showcase: [] };
      if (!rec.owned.includes(payload.cosmeticId)) {
        rec.owned.push(payload.cosmeticId);
        rec.firstEarnedUtc[payload.cosmeticId] = Date.now();
        await env.LOADOUT_BOLTS.put(key, JSON.stringify(rec));
      }
      return { kind, cosmeticId: payload?.cosmeticId };
    }
    if (kind === 'pack') {
      const { creditPack } = await import('./cards-packs.js');
      await creditPack(env, guildId, userId, payload?.packId || 'bolt', 'pass2:reward');
      return { kind, packId: payload?.packId };
    }
  } catch (e) {
    return { kind, error: String(e?.message || e).slice(0, 80) };
  }
  return { kind, error: 'unknown-kind' };
}

// Claim one tier's reward on one track. Idempotent per (tier, track).
// `guildId` is needed to credit bolts/packs into the right wallet.
export async function claimTier(env, guildId, userId, tier, track) {
  const t = Math.floor(Number(tier) || 0);
  track = track === 'premium' ? 'premium' : 'free';
  if (!guildId || !userId || t < 1) return { ok: false, error: 'bad-args' };
  const D = db(env);
  const season = await getActiveSeason(env);
  if (!season) return { ok: false, error: 'no-active-season' };
  const prog = await ensureProgress(D, season.id, userId);

  if (Number(prog.tier || 0) < t) return { ok: false, error: 'tier-not-reached' };
  if (track === 'premium' && !prog.premium) return { ok: false, error: 'premium-locked' };

  const claimed = parseClaimed(track === 'premium' ? prog.claimed_premium : prog.claimed_free);
  if (claimed.has(t)) return { ok: true, alreadyClaimed: true, tier: t, track };

  const rewardRow = await D.prepare(
    `SELECT kind, payload FROM aquilo_pass_reward
      WHERE season_id = ? AND tier = ? AND track = ? LIMIT 1`
  ).bind(season.id, t, track).first();
  if (!rewardRow) return { ok: false, error: 'no-reward-at-tier' };

  let payload = null;
  try { payload = rewardRow.payload ? JSON.parse(rewardRow.payload) : null; } catch { payload = null; }

  // Stamp claimed BEFORE granting so a retry can't double-grant.
  claimed.add(t);
  const col = track === 'premium' ? 'claimed_premium' : 'claimed_free';
  await D.prepare(
    `UPDATE user_pass_progress SET ${col} = ?, updated_at = ?
      WHERE season_id = ? AND user_id = ?`
  ).bind(serializeClaimed(claimed), Date.now(), season.id, String(userId)).run();

  const granted = await grantReward(env, guildId, userId, rewardRow.kind, payload);
  // Fan out tier-unlock to the community-activity SSE feed (best-effort).
  try {
    const { publishActivity } = await import('./activity-do.js');
    await publishActivity(env, { kind: 'pass-tier', userId, tier: t, track,
      reward: { kind: rewardRow.kind } });
  } catch { /* sse optional */ }
  return { ok: true, tier: t, track, reward: granted };
}
