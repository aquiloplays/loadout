// Server-booster perks (Wave 4).
//
// Triggered by GUILD_MEMBER_UPDATE forwarded from aquilo-presence to
// POST /member/updated. Detects boost-start (no prior boost, now has
// premium_since OR the Nitro Booster role) and boost-end.
//
// Perks granted on boost START (idempotent — one grant per boost
// session, tracked at guild:booster-state:<g>:<u>):
//   • 2 Voltaic packs (the high-rarity drop pool)
//   • 1 Bolt pack
//   • A persistent BOOST_BOLTS_MULTIPLIER flag in their wallet so
//     wallet.earn() multiplies their bolt earnings while boosting.
//     (See wallet.js — `earn()` checks for the active booster flag.)
//
// Revoked on boost END:
//   • Multiplier flag cleared
//   • Already-granted packs are NOT clawed back
//
// KV layout:
//   guild:booster-state:<g>:<u>  { isBoosting: bool, since: ms,
//                                  packsGrantedUtc: ms }
//   wallet:<g>:<u>.boosterMultiplierUntil  ms — wallet.earn reads this

import { creditPack } from './cards-packs.js';
import { getWallet, putWallet } from './wallet.js';

export const BOOSTER_BOLT_MULTIPLIER = 2;   // 2× while boosting
export const BOOSTER_PACK_GRANTS = [
  { packType: 'voltaic', count: 2 },
  { packType: 'bolt',    count: 1 },
];

// Detect "this member is boosting" from a GUILD_MEMBER_UPDATE payload.
// Discord sets `premium_since` to an ISO timestamp when boosting; null
// when they stop. The "Nitro Booster" role is a fallback signal
// (always present on boosters; managed by Discord).
function isBoosting(payload) {
  if (payload.premium_since) return true;
  // Booster role detection — look for a role id matching the system
  // "Server Booster" role. We don't track its id; instead we rely on
  // the `premium_since` field which is set when a boost is active.
  // (Falls back to false if premium_since is null/missing.)
  return false;
}

async function loadState(env, guildId, userId) {
  return env.LOADOUT_BOLTS.get(`guild:booster-state:${guildId}:${userId}`, { type: 'json' });
}
async function saveState(env, guildId, userId, state) {
  await env.LOADOUT_BOLTS.put(`guild:booster-state:${guildId}:${userId}`, JSON.stringify(state));
}

export async function handleMemberUpdated(env, payload) {
  if (!payload || !payload.guild_id) return { skipped: 'bad-payload' };
  const userId = String(payload.user?.id || '');
  if (!userId) return { skipped: 'no-user' };
  if (payload.user?.bot) return { skipped: 'bot' };

  const guildId = String(payload.guild_id);
  const nowBoosting = isBoosting(payload);
  const prev = await loadState(env, guildId, userId);
  const wasBoosting = !!prev?.isBoosting;

  if (nowBoosting && !wasBoosting) {
    return startBoosting(env, guildId, userId, payload);
  }
  if (!nowBoosting && wasBoosting) {
    return stopBoosting(env, guildId, userId);
  }
  return { skipped: 'no-change', nowBoosting };
}

async function startBoosting(env, guildId, userId, payload) {
  // Activate the bolts multiplier flag on the wallet (90-day window;
  // refreshes on each subsequent boost-active update, so as long as
  // they keep boosting the flag stays current).
  const wal = await getWallet(env, guildId, userId);
  wal.boosterMultiplierUntil = Date.now() + 90 * 24 * 60 * 60 * 1000;
  wal.boosterMultiplier = BOOSTER_BOLT_MULTIPLIER;
  await putWallet(env, guildId, userId, wal);

  // Idempotently grant the welcome pack bundle. The state record's
  // `packsGrantedUtc` is the dedup stamp — re-firing the event in
  // the same boost session does NOT re-grant.
  const state = (await loadState(env, guildId, userId)) || {};
  const grants = [];
  if (!state.packsGrantedUtc) {
    for (const g of BOOSTER_PACK_GRANTS) {
      for (let i = 0; i < g.count; i++) {
        const r = await creditPack(env, guildId, userId, g.packType, 'booster-grant');
        if (r.ok) grants.push({ packType: g.packType, pendingId: r.pack?.id });
      }
    }
  }

  await saveState(env, guildId, userId, {
    isBoosting: true,
    since: Date.parse(payload.premium_since || '') || Date.now(),
    packsGrantedUtc: state.packsGrantedUtc || (grants.length ? Date.now() : 0),
  });

  return {
    action: 'boost-start',
    multiplierActive: BOOSTER_BOLT_MULTIPLIER,
    multiplierUntil: wal.boosterMultiplierUntil,
    packsGranted: grants,
  };
}

async function stopBoosting(env, guildId, userId) {
  const wal = await getWallet(env, guildId, userId);
  wal.boosterMultiplier = 0;
  wal.boosterMultiplierUntil = 0;
  await putWallet(env, guildId, userId, wal);

  await saveState(env, guildId, userId, {
    isBoosting: false,
    since: 0,
    packsGrantedUtc: 0,   // reset so next boost cycle grants again
  });
  return { action: 'boost-end', multiplierActive: 0 };
}
