// Random Drops — rarity-weighted community chest spawns.
//
// 2026-05-31 sprint. Every 2 hours a chest spawns for the community to
// claim (first-click-claims, limited slots). The rarity is weighted; the
// reward scales with rarity (bolts / aether / pack / cosmetic). Spawns
// and claims fan out over the community-activity SSE feed so the site/
// overlay can pop a chest on screen.
//
// Cron: the spec asks for `0 */2 * * *`, but this account's Worker is at
// the 4-cron ceiling, so randomDropCron() piggybacks the every-minute
// trigger and self-gates to even-hour:00 via a KV 2-hour-bucket marker
// (same pattern as the other piggybacked daily jobs).
//
// KV state (auto-expiring):
//   randomdrop:event:<guildId>     -> active drop (see shape below)
//   randomdrop:cron:last-bucket    -> '<YYYY-MM-DD-HH>' 2h bucket marker

import { earn } from './wallet.js';

const KEY      = (g) => `randomdrop:event:${g}`;
const CRON_KEY = 'randomdrop:cron:last-bucket';
const WINDOW_MS = 15 * 60_000;     // 15-minute claim window per spawn

// Rarity weights (sum 100) + per-rarity reward + claim-slot count.
// Rarer = fewer slots + bigger reward.
const RARITIES = [
  { rarity: 'common',    weight: 50, maxClaims: 25, reward: { bolts: 50 } },
  { rarity: 'uncommon',  weight: 28, maxClaims: 20, reward: { bolts: 100 } },
  { rarity: 'rare',      weight: 15, maxClaims: 15, reward: { bolts: 150, aether: 15 } },
  { rarity: 'epic',      weight:  6, maxClaims: 10, reward: { bolts: 250, aether: 40, pack: 'bolt' } },
  { rarity: 'legendary', weight:  1, maxClaims:  5, reward: { bolts: 500, aether: 100, cosmetic: 'drop-legendary-aura' } },
];

export function pickRarity(rand) {
  const r = (typeof rand === 'number' ? rand : Math.random()) * 100;
  let acc = 0;
  for (const def of RARITIES) {
    acc += def.weight;
    if (r < acc) return def;
  }
  return RARITIES[0];
}

async function readEvent(env, guildId) {
  return env.LOADOUT_BOLTS.get(KEY(guildId), { type: 'json' });
}
function isActive(ev, now) { return !!ev && ev.expiresUtc > now; }

// Spawn a drop. Won't stack on an already-active one (returns it). Opts
// let tests pin the rarity (opts.rand) + time (opts.nowUtc).
export async function spawnRandomDrop(env, guildId, opts = {}) {
  if (!guildId) return { ok: false, error: 'no-guild' };
  const now = Number.isFinite(opts.nowUtc) ? opts.nowUtc : Date.now();
  const existing = await readEvent(env, guildId);
  if (isActive(existing, now)) {
    return { ok: true, alreadyActive: true, id: existing.id, rarity: existing.rarity };
  }
  const def = opts.rarityDef || pickRarity(opts.rand);
  const ev = {
    id: crypto.randomUUID(),
    rarity: def.rarity,
    reward: def.reward,
    maxClaims: def.maxClaims,
    claimsUsed: 0,
    claimedBy: {},
    startedUtc: now,
    expiresUtc: now + WINDOW_MS,
  };
  await env.LOADOUT_BOLTS.put(KEY(guildId), JSON.stringify(ev),
    { expirationTtl: Math.ceil(WINDOW_MS / 1000) + 60 });

  try {
    const { publishActivity } = await import('./activity-do.js');
    await publishActivity(env, {
      kind: 'drop-spawn', guildId, dropId: ev.id, rarity: ev.rarity,
      expiresUtc: ev.expiresUtc, maxClaims: ev.maxClaims,
    });
  } catch { /* sse optional */ }

  return { ok: true, id: ev.id, rarity: ev.rarity, reward: ev.reward,
           maxClaims: ev.maxClaims, expiresUtc: ev.expiresUtc };
}

// First-click claim. One per user. Grants the rarity reward (bolts +
// optional aether/pack/cosmetic) + broadcasts a drop-claim event.
export async function claimRandomDrop(env, guildId, userId) {
  if (!guildId || !userId) return { ok: false, error: 'bad-args' };
  const now = Date.now();
  const ev = await readEvent(env, guildId);
  if (!isActive(ev, now)) return { ok: false, error: 'not-active' };
  ev.claimedBy = ev.claimedBy || {};
  if (ev.claimedBy[userId]) return { ok: false, error: 'already-claimed', rarity: ev.rarity };
  if (ev.claimsUsed >= ev.maxClaims) return { ok: false, error: 'depleted' };

  // Reserve before granting (retry-safe).
  ev.claimedBy[userId] = true;
  ev.claimsUsed += 1;
  await env.LOADOUT_BOLTS.put(KEY(guildId), JSON.stringify(ev),
    { expirationTtl: Math.max(1, Math.ceil((ev.expiresUtc - now) / 1000) + 60) });

  const granted = await grantDropReward(env, guildId, userId, ev.reward, ev.id);
  const claimsRemaining = Math.max(0, ev.maxClaims - ev.claimsUsed);

  try {
    const { publishActivity } = await import('./activity-do.js');
    await publishActivity(env, {
      kind: 'drop-claim', guildId, userId: String(userId),
      rarity: ev.rarity, claimsRemaining,
    });
  } catch { /* sse optional */ }

  return { ok: true, rarity: ev.rarity, reward: granted, claimsRemaining };
}

async function grantDropReward(env, guildId, userId, reward, dropId) {
  const out = {};
  try {
    if (reward.bolts) { await earn(env, guildId, userId, reward.bolts, `random-drop:${dropId}`); out.bolts = reward.bolts; }
    if (reward.aether) {
      const { grantAether } = await import('./aether.js');
      await grantAether(env, guildId, userId, reward.aether, `random-drop:${dropId}`);
      out.aether = reward.aether;
    }
    if (reward.cosmetic) {
      const key = `pbadge:${userId}`;
      const rec = (await env.LOADOUT_BOLTS.get(key, { type: 'json' })) || { owned: [], firstEarnedUtc: {}, showcase: [] };
      if (!rec.owned.includes(reward.cosmetic)) {
        rec.owned.push(reward.cosmetic);
        rec.firstEarnedUtc[reward.cosmetic] = Date.now();
        await env.LOADOUT_BOLTS.put(key, JSON.stringify(rec));
      }
      out.cosmetic = reward.cosmetic;
    }
    if (reward.pack) {
      const { creditPack } = await import('./cards-packs.js');
      await creditPack(env, guildId, userId, reward.pack, `random-drop:${dropId}`);
      out.pack = reward.pack;
    }
  } catch (e) {
    out.error = String(e?.message || e).slice(0, 80);
  }
  return out;
}

export async function getRandomDropState(env, guildId, userId) {
  const now = Date.now();
  const ev = await readEvent(env, guildId);
  if (!isActive(ev, now)) return { ok: true, active: false };
  return {
    ok: true, active: true, id: ev.id, rarity: ev.rarity,
    expiresUtc: ev.expiresUtc, msRemaining: Math.max(0, ev.expiresUtc - now),
    claimsRemaining: Math.max(0, ev.maxClaims - ev.claimsUsed),
    reward: ev.reward,
    youClaimed: userId ? !!(ev.claimedBy && ev.claimedBy[userId]) : undefined,
  };
}

// Cron entry — fires from the every-minute trigger. Self-gates to
// even-hour:00 (the `0 */2 * * *` cadence) via a 2-hour-bucket KV
// marker so it spawns at most once per 2-hour window. No-op otherwise.
export async function randomDropCron(env, opts = {}) {
  const guildId = String(env.AQUILO_VAULT_GUILD_ID || '').trim();
  if (!guildId) return { ok: true, skipped: 'no-guild' };
  const now = Number.isFinite(opts.nowUtc) ? opts.nowUtc : Date.now();
  const d = new Date(now);
  const hour = d.getUTCHours();
  const minute = d.getUTCMinutes();
  if (!opts.force && !(minute === 0 && hour % 2 === 0)) {
    return { ok: true, skipped: 'off-cadence' };
  }
  const bucket = `${d.toISOString().slice(0, 10)}-${String(hour).padStart(2, '0')}`;
  if (!opts.force) {
    const last = await env.LOADOUT_BOLTS.get(CRON_KEY).catch(() => null);
    if (last === bucket) return { ok: true, skipped: 'already-spawned-this-bucket', bucket };
  }
  const r = await spawnRandomDrop(env, guildId, { nowUtc: now });
  await env.LOADOUT_BOLTS.put(CRON_KEY, bucket).catch(() => {});
  return { ok: true, bucket, spawned: r };
}
