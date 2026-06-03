// Bolt Rain, interactive, Patreon-T2+-triggered community bolt drop.
//
// 2026-05-31 sprint. Distinct from stream-bonus.js's passive boltRainTick
// (a cron pulse that silently gives N random viewers bolts). THIS is a
// triggered event: a Tier-2+ Patreon supporter opens a 60-second window
// during which the whole community races to claim bolts on a
// first-click-claims basis. Each claim + the open/close is fanned out
// over the community-activity SSE feed so the site/overlay can rain
// bolts on screen in real time.
//
// KV state (auto-expiring):
//   boltrain:event:<guildId> -> {
//     id, triggeredBy, startedUtc, expiresUtc,
//     perClaim, maxClaims, claimsUsed, claimedBy: { userId: amount }
//   }
//
// Concurrency note: KV is eventually-consistent, so under a thundering
// herd the maxClaims cap + per-user dedup are best-effort (a few extra
// claims may slip through at the boundary). Acceptable for a 60s hype
// moment, the pool is intentionally generous, not a ledger.

import { earn } from './wallet.js';

const KEY = (g) => `boltrain:event:${g}`;
const WINDOW_MS = 60_000;          // 60-second claim window
const DEFAULT_PER_CLAIM = 25;
const DEFAULT_MAX_CLAIMS = 50;     // pool = perClaim * maxClaims = 1250 bolts
const T2_MIN_CENTS = 500;          // ~$5 = Tier 2

// Patreon Tier-2+ gate. Reuses the paid check, then requires either a
// pledge >= $5 or a tier label that looks like tier 2+.
export async function isPatreonT2Plus(env, userId) {
  if (!env?.LOADOUT_BOLTS || !userId) return false;
  try {
    const rec = await env.LOADOUT_BOLTS.get(`patreon:tier:${userId}`, { type: 'json' });
    if (!rec) return false;
    const tier = String(rec.tier || rec.tierName || '').trim().toLowerCase();
    if (!tier || tier === 'free') return false;
    if (rec.paid === false) return false;
    const cents = Number(rec.amount_cents || rec.pledge_cents
      || (rec.amount || rec.pledge ? (rec.amount || rec.pledge) * 100 : 0)) || 0;
    if (cents >= T2_MIN_CENTS) return true;
    // No usable amount field, fall back to the tier label (tier 2-9,
    // or a premium-sounding name).
    if (/tier\s*([2-9]|1\d)/.test(tier)) return true;
    if (/\b(gold|platinum|vip|founder|legend|champion|mythic)\b/.test(tier)) return true;
    return false;
  } catch {
    return false;
  }
}

async function readEvent(env, guildId) {
  return env.LOADOUT_BOLTS.get(KEY(guildId), { type: 'json' });
}

function isActive(ev, now) {
  return !!ev && ev.expiresUtc > now;
}

// Public state for the UI. Includes whether THIS user already claimed.
export async function getBoltRainState(env, guildId, userId) {
  const now = Date.now();
  const ev = await readEvent(env, guildId);
  if (!isActive(ev, now)) return { ok: true, active: false };
  return {
    ok: true,
    active: true,
    id: ev.id,
    triggeredBy: ev.triggeredBy,
    expiresUtc: ev.expiresUtc,
    msRemaining: Math.max(0, ev.expiresUtc - now),
    perClaim: ev.perClaim,
    claimsRemaining: Math.max(0, ev.maxClaims - ev.claimsUsed),
    youClaimed: userId ? !!(ev.claimedBy && ev.claimedBy[userId]) : undefined,
  };
}

// Trigger a bolt-rain. Patreon-T2+-gated. Refuses if one is already
// active (won't stack). Broadcasts a start event over the SSE feed.
export async function triggerBoltRain(env, guildId, userId, opts = {}) {
  if (!guildId || !userId) return { ok: false, error: 'bad-args' };
  if (!(await isPatreonT2Plus(env, userId))) {
    return { ok: false, error: 'not-tier-2' };
  }
  const now = Date.now();
  const existing = await readEvent(env, guildId);
  if (isActive(existing, now)) {
    return { ok: false, error: 'already-active', expiresUtc: existing.expiresUtc };
  }
  const perClaim = Math.max(1, Math.floor(Number(opts.perClaim) || DEFAULT_PER_CLAIM));
  const maxClaims = Math.max(1, Math.floor(Number(opts.maxClaims) || DEFAULT_MAX_CLAIMS));
  const ev = {
    id: crypto.randomUUID(),
    triggeredBy: String(userId),
    startedUtc: now,
    expiresUtc: now + WINDOW_MS,
    perClaim, maxClaims, claimsUsed: 0, claimedBy: {},
  };
  await env.LOADOUT_BOLTS.put(KEY(guildId), JSON.stringify(ev), { expirationTtl: 120 });

  try {
    const { publishActivity } = await import('./activity-do.js');
    await publishActivity(env, {
      kind: 'bolt-rain-start', guildId, triggeredBy: String(userId),
      expiresUtc: ev.expiresUtc, perClaim, pool: perClaim * maxClaims,
    });
  } catch { /* sse optional */ }

  return { ok: true, id: ev.id, expiresUtc: ev.expiresUtc, perClaim,
           pool: perClaim * maxClaims, claimsRemaining: maxClaims };
}

// First-click claim. One claim per user per event. Grants perClaim
// bolts, decrements the pool, broadcasts a claim event.
export async function claimBoltRain(env, guildId, userId) {
  if (!guildId || !userId) return { ok: false, error: 'bad-args' };
  const now = Date.now();
  const ev = await readEvent(env, guildId);
  if (!isActive(ev, now)) return { ok: false, error: 'not-active' };
  ev.claimedBy = ev.claimedBy || {};
  if (ev.claimedBy[userId]) {
    return { ok: false, error: 'already-claimed', amount: ev.claimedBy[userId] };
  }
  if (ev.claimsUsed >= ev.maxClaims) return { ok: false, error: 'depleted' };

  // Reserve the slot first (write-before-grant) so a retry can't
  // double-pay this user even if the grant below is interrupted.
  ev.claimedBy[userId] = ev.perClaim;
  ev.claimsUsed += 1;
  await env.LOADOUT_BOLTS.put(KEY(guildId), JSON.stringify(ev), {
    expirationTtl: Math.max(1, Math.ceil((ev.expiresUtc - now) / 1000) + 60),
  });

  await earn(env, guildId, userId, ev.perClaim, `bolt-rain:${ev.id}`);

  const claimsRemaining = Math.max(0, ev.maxClaims - ev.claimsUsed);
  try {
    const { publishActivity } = await import('./activity-do.js');
    await publishActivity(env, {
      kind: 'bolt-rain-claim', guildId, userId: String(userId),
      amount: ev.perClaim, claimsRemaining,
    });
  } catch { /* sse optional */ }

  return { ok: true, amount: ev.perClaim, claimsRemaining };
}
