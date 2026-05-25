// Boltbound — pack opening, pull rates, integration hooks.
//
// Three pack SKUs: common (1/day free, lootbox + Clash 1★ drop), bolt
// (250 Bolts purchase, Clash 2-3★ drop, lootbox), voltaic (drop-only —
// Clash 3★ upgrade, lootbox premium, Patreon).
//
// Pull mechanics — see CARD-GAME-DESIGN.md §4 for the locked design:
//   • Per-slot rarity weighting from PACKS[id].weights.
//   • Uniform pick within a rarity's pool.
//   • Bad-luck pity: every 30 Bolt/Voltaic packs without a legendary
//     forces the next pack's legendary slot. Per-user counter.
//   • Duplicate refund: pulls past your deck cap convert to Bolts.
//     Common = 5, Uncommon = 20, Rare = 100, Legendary = 500.
//
// `creditPack(env, guildId, userId, packType, source)` is THE hook
// that ext-lootbox.js and clash.js call to grant a pack. It mints a
// pending-pack record under cards:pending:<g>:<u>:<id> — the actual
// roll happens at openPack() time, so the website/Discord reveal can
// be driven by pre-rolled cards stored in the record.

import {
  PACKS, RARITY_POOLS, CARDS, DUPE_BOLTS,
} from './cards-content.js';
import {
  mintPendingPack, getPendingPack, freezePendingPack, deletePendingPack,
  addCardsToCollection,
  bumpPity, resetPity, getPity,
  hasClaimedFreePackToday, markFreePackClaimed,
  ensureCollection,
} from './cards-state.js';
import { applyVaultDelta } from './wallet.js';

// ── Seeded RNG (xorshift32) ─────────────────────────────────────────
//
// Same deterministic generator clash-raid.js uses, so the roll-the-pack
// path is replayable.

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < (s || '').length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; };
}

// ── Pull algorithm ───────────────────────────────────────────────────
//
// pullPack(packType, rng, opts={ forceOneLegendary?: bool }) -> [cardId,...]
//
// - 5 slots per pack (PACKS[packType].cards).
// - For each slot, pick a rarity using PACKS[packType].weights, then
//   a uniform card within that rarity's pool.
// - If `forceOneLegendary` is set and no legendary was rolled in any
//   slot, retroactively replace the lowest-rarity slot's pull with a
//   legendary roll. This is the pity-system mechanic — the random walk
//   is preserved up to the swap so the same seed still produces a
//   visually-coherent pull, just with one slot bumped.

export function pullPack(packType, rngFn, opts = {}) {
  const pack = PACKS[packType];
  if (!pack) throw new Error('unknown pack type: ' + packType);

  const slots = [];
  for (let i = 0; i < (pack.cards || 5); i++) {
    const rarity = rollRarity(pack.weights, rngFn);
    const pool = RARITY_POOLS[rarity] || [];
    if (!pool.length) {
      // Fall back to common if the configured pool is empty — shouldn't
      // happen with the locked catalogue but defensive against future
      // edits.
      slots.push({ rarity: 'common', cardId: pickFrom(RARITY_POOLS.common, rngFn) });
      continue;
    }
    slots.push({ rarity, cardId: pickFrom(pool, rngFn) });
  }

  if (opts.forceOneLegendary && !slots.some(s => s.rarity === 'legendary')) {
    // Find the lowest-rarity slot and overwrite it with a legendary.
    const order = { common: 0, uncommon: 1, rare: 2, legendary: 3 };
    let lowestIdx = 0;
    for (let i = 1; i < slots.length; i++) {
      if ((order[slots[i].rarity] ?? 0) < (order[slots[lowestIdx].rarity] ?? 0)) lowestIdx = i;
    }
    const legendaryPool = RARITY_POOLS.legendary;
    if (legendaryPool.length) {
      slots[lowestIdx] = { rarity: 'legendary', cardId: pickFrom(legendaryPool, rngFn) };
    }
  }

  return slots.map(s => s.cardId);
}

function rollRarity(weights, rngFn) {
  const tiers = Object.keys(weights).filter(k => (weights[k] || 0) > 0);
  if (!tiers.length) return 'common';
  const total = tiers.reduce((s, k) => s + (weights[k] || 0), 0);
  let pick = rngFn() * total;
  for (const k of tiers) {
    pick -= weights[k] || 0;
    if (pick <= 0) return k;
  }
  return tiers[tiers.length - 1];
}

function pickFrom(pool, rngFn) {
  if (!pool.length) return null;
  return pool[Math.floor(rngFn() * pool.length)].id;
}

// ── Public: creditPack (THE hook) ────────────────────────────────────
//
// Called by:
//   - ext-lootbox.js when a community/free loot-box rolls a pack-slot entry
//   - clash.js handleRaid after a successful raid, via rollClashPackDrop
//   - cards.js when a viewer buys a pack with Bolts
//   - cards.js when the daily free Common Pack is claimed
//   - admin scripts when granting a pack manually
//
// Returns the freshly-minted pending-pack record so callers can show
// "you got a <packname>" in their response.

export async function creditPack(env, guildId, userId, packType, source) {
  if (!PACKS[packType]) {
    return { ok: false, error: 'unknown-pack-type' };
  }
  // Make sure the collection row exists so the viewer can open the
  // pack later without a "you haven't played Boltbound yet" 404. No-op
  // when the row already exists.
  await ensureCollection(env, guildId, userId);
  const rec = await mintPendingPack(env, guildId, userId, packType, source);

  // ✨ Lucky-drop hook (rolls only on FREE creditPack calls — i.e.
  // every pack source EXCEPT the explicit 'purchase:bolt' / 'purchase:voltaic'
  // paths). A very-rare bonus Voltaic pack drops alongside the
  // requested pack. Reroll-resistant: we use the freshly-minted
  // pack id as the seed source so a streamer can't farm by repeatedly
  // calling creditPack with the same args.
  //
  // Probability target: feels "lottery rare" — a daily check-in user
  // should hit roughly one drop every several months on average. A
  // viewer with multiple daily touchpoints (check-in + a daily +
  // booster claim) sees about one per quarter.
  const bonus = await maybeRollVoltaicLuckyDrop(env, guildId, userId, packType, source, rec);
  return { ok: true, pack: rec, bonusPack: bonus };
}

// Free-drop chance per eligible creditPack call. 1/600 ≈ 0.167%.
// Tuned to "very rare but real" — a player with three daily-grant
// touchpoints averages one drop per ~6.5 months. Tweakable here in
// isolation if it feels off after live play.
const LUCKY_VOLTAIC_DENOMINATOR = 600;

// Sources that DO NOT eligible for the free drop. Paid pack purchases
// already pay the user their voltaic + the lottery would be double-dipping.
// Direct 'admin' / 'starter' grants also skip — those are intentional
// hand-outs that shouldn't carry a hidden lottery payout.
const LUCKY_VOLTAIC_INELIGIBLE_SOURCES = new Set([
  'admin', 'starter',
  'purchase:bolt', 'purchase:voltaic', 'purchase:common',
]);

async function maybeRollVoltaicLuckyDrop(env, guildId, userId, packType, source, mintedRec) {
  // Never compound: if we just credited a voltaic, don't roll another.
  if (packType === 'voltaic') return null;
  if (LUCKY_VOLTAIC_INELIGIBLE_SOURCES.has(String(source))) return null;
  // The new pack's id is fresh and unguessable — seed the roll with it
  // so the chance is bound to THIS specific credit event (not the
  // user's identity, which would let them re-roll by retrying).
  const seedSalt = `pack:${packType}:${mintedRec?.id || crypto.randomUUID()}`;
  return rollVoltaicLuckyDrop(env, guildId, userId, source, seedSalt);
}

// PUBLIC lucky-drop helper for non-pack-credit call sites (check-in,
// /play game routes, etc.). Roll once per event; on a win, mint a
// pending Voltaic pack and return it. Returns null on miss.
//
// `seedSalt` MUST be unique per eligible event (e.g. the ET-day
// string for daily check-ins, or the pack id for pack opens) so the
// roll can't be repeated by retrying.
export async function rollVoltaicLuckyDrop(env, guildId, userId, source, seedSalt) {
  const seed = `lucky:${guildId}:${userId}:${seedSalt}`;
  const r = rng(hashStr(seed));
  const win = Math.floor(r() * LUCKY_VOLTAIC_DENOMINATOR) === 0;
  if (!win) return null;
  await ensureCollection(env, guildId, userId);
  return mintPendingPack(env, guildId, userId, 'voltaic',
                         'lucky-drop:' + String(source || 'unknown'));
}

// ── Public: openPack ─────────────────────────────────────────────────
//
// Roll the pack contents (if not already rolled), credit them to the
// viewer's collection, and delete the pending row. Returns the
// open-pack receipt so the slash command can render the reveal.
//
// On a dup → Bolts conversion, the caller will see `dupeBolts > 0` on
// the per-card row; this function also batches the total dupe-Bolts
// credit into a single applyVaultDelta call.

export async function openPack(env, guildId, userId, packId) {
  const rec = await getPendingPack(env, guildId, userId, packId);
  if (!rec) return { ok: false, error: 'no-such-pack' };

  let rolled = rec.rolled;
  if (!rolled) {
    // First open — roll the pulls deterministically from the pack id.
    const seedStr = `${guildId}:${userId}:${packId}`;
    const r = rng(hashStr(seedStr));
    const isPaid = rec.packType === 'bolt' || rec.packType === 'voltaic';
    let pity = null;
    let forceOneLegendary = false;
    if (isPaid) {
      pity = await getPity(env, userId);
      forceOneLegendary = (pity.packs || 0) >= 29;   // this pack will be the 30th, force.
    }
    rolled = pullPack(rec.packType, r, { forceOneLegendary });
    await freezePendingPack(env, guildId, userId, packId, rolled);
    // Pity bookkeeping happens AFTER the roll so failed dispatches
    // don't burn the counter.
    if (isPaid) {
      if (rolled.some(id => CARDS[id]?.rarity === 'legendary')) {
        await resetPity(env, userId);
      } else {
        await bumpPity(env, userId, 1);
      }
    }
  }

  // Credit the pulls. Duplicates past deck cap convert to Bolts.
  const results = await addCardsToCollection(env, guildId, userId, rolled);
  let totalDupeBolts = 0;
  for (const r of results) {
    if (!r.credited && r.dupeBolts) totalDupeBolts += r.dupeBolts;
  }
  let boltsRefund = null;
  if (totalDupeBolts > 0) {
    boltsRefund = await applyVaultDelta(env, guildId, userId, totalDupeBolts, 'boltbound:dupe-refund');
  }

  // Remove the pending-pack record. The collection now has the cards;
  // the receipt the caller renders is from the in-memory `results`.
  await deletePendingPack(env, guildId, userId, packId);

  // PROGRESSION (P1) — pack-open XP. Dedup keyed by packId so retries
  // grant once. Legendary pulls fire a meta flag for the achievement
  // engine to read in P3.
  try {
    const { emitProgressionEvent } = await import('./progression/event-bus.js');
    const hadLegendary = rolled.some(id => CARDS[id]?.rarity === 'legendary');
    await emitProgressionEvent(env, {
      kind: 'cards.pack.opened', userId, guildId,
      meta: { packId, packType: rec.packType, hadLegendary }, stableKeys: ['packId'],
    });
  } catch { /* non-fatal */ }

  return {
    ok: true,
    packType: rec.packType,
    source: rec.source,
    rolled,
    results,
    totalDupeBolts,
    boltsRefund: boltsRefund ? boltsRefund.wallet : null,
  };
}

// ── Public: buyPack ──────────────────────────────────────────────────
//
// Bolts purchase path. Validates the pack is purchasable, debits the
// wallet, mints a pending pack. Returns the pending pack so the
// caller's response can offer "open now?".

export async function buyPack(env, guildId, userId, packType) {
  const pack = PACKS[packType];
  if (!pack) return { ok: false, error: 'unknown-pack-type' };
  if (pack.priceBolts == null) return { ok: false, error: 'not-purchasable' };
  const { getWallet } = await import('./wallet.js');
  const wallet = await getWallet(env, guildId, userId);
  if ((wallet.balance || 0) < pack.priceBolts) {
    return { ok: false, error: 'insufficient-bolts', need: pack.priceBolts, have: wallet.balance || 0 };
  }
  await applyVaultDelta(env, guildId, userId, -pack.priceBolts, 'boltbound:buy:' + packType);
  const credited = await creditPack(env, guildId, userId, packType, 'purchase');
  return credited;
}

// ── Public: claimDailyFreePack ───────────────────────────────────────
//
// Daily Common Pack. Claim once per UTC day. Returns the pending pack.

export async function claimDailyFreePack(env, guildId, userId) {
  if (await hasClaimedFreePackToday(env, guildId, userId)) {
    return { ok: false, error: 'already-claimed-today' };
  }
  await markFreePackClaimed(env, guildId, userId);
  return await creditPack(env, guildId, userId, 'common', 'free-daily');
}

// ── Clash-raid drop hook ─────────────────────────────────────────────
//
// Roll table is fixed (see design doc §4.2). Seed = raidId so a raid's
// pack drop is part of the replay determinism.
//
// Returns one of 'common' | 'bolt' | 'voltaic' | null.

export function rollClashPackDrop(stars, raidId) {
  if (!stars || stars < 1) return null;
  const r = rng(hashStr('clash-pack:' + raidId));
  if (stars === 1) {
    return r() < 0.30 ? 'common' : null;
  }
  if (stars === 2) {
    return r() < 0.50 ? 'bolt' : null;
  }
  // 3 stars: always at least a Bolt Pack, with an independent 10% upgrade to Voltaic.
  return r() < 0.10 ? 'voltaic' : 'bolt';
}

// ── Loot-box drop hook ───────────────────────────────────────────────
//
// Called by ext-lootbox.js when a roll lands on a pack-slot entry. The
// loot-box catalogue uses pack-slot entries shaped like:
//   { slot: 'pack', rarity: 'common'|'rare'|'epic', packType: 'common'|'bolt'|'voltaic' }
//
// Returns the pending-pack record on success.

export async function lootboxPackDrop(env, guildId, userId, packType) {
  return await creditPack(env, guildId, userId, packType, 'lootbox');
}
