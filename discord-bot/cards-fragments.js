// Boltbound — recycle → fragments → craft-pack loop.
//
// Soft currency separate from Bolts. Viewers recycle cards they own
// for Pack Fragments and spend fragments to craft new packs. Crafting
// is *always* more expensive than the Bolts price of the same pack
// (60% premium on the Bolt Pack) — Bolts is the faster path, fragments
// are the safety net for the slow grinder.
//
// See CARD-GAME-DESIGN.md §14 for the locked numbers + rationale.
//
// Storage:
//   cards:frag:<userId> = { frag, recycled, crafted, ts }
//
// Public API:
//   getFragments(env, userId)
//   recycleCards(env, guildId, userId, items)
//   craftPackFromFragments(env, guildId, userId, packType)
//
// Hooks: the slash command surface (cards.js) calls these directly.
// Web + Twitch-panel surfaces hit cards-web.js endpoints that proxy
// through the same module — no parallel logic on the client.

import { CARDS, RARITY_DECK_CAP } from './cards-content.js';
import {
  getCollection, putCollection,
  ensureCollection,
} from './cards-state.js';
import { creditPack } from './cards-packs.js';

const FRAG_KEY = (u) => `cards:frag:${u}`;

// Fragments yielded per recycled card (per copy). Champions + tokens
// aren't in collections so they can't end up here.
export const RECYCLE_YIELD = {
  common:    1,
  uncommon:  4,
  rare:      20,
  legendary: 100,
};

// Craft prices — designed to be MORE expensive than the bolts price
// of the same pack (60% premium on Bolt Pack). Common pack is
// craftable to give the grinder a use for tiny fragment piles, but
// it's pricier than the free-daily.
export const CRAFT_COST_FRAG = {
  common:  50,
  bolt:    400,
  voltaic: 1200,
};

// Premium-over-Bolts sanity check: keeps the design rule enforced.
// If anyone ever lowers a craft cost below the bolt-equivalent, the
// IIFE at the bottom of this file fails.
const BOLTS_PRICE_OF = {
  common:  null,
  bolt:    250,
  voltaic: null,    // no purchase, drop-only
};

// ── Storage ─────────────────────────────────────────────────────────

export async function getFragments(env, userId) {
  const raw = await env.LOADOUT_BOLTS.get(FRAG_KEY(userId), { type: 'json' });
  return raw || { frag: 0, recycled: 0, crafted: 0, ts: 0 };
}

async function putFragments(env, userId, rec) {
  rec.ts = Date.now();
  await env.LOADOUT_BOLTS.put(FRAG_KEY(userId), JSON.stringify(rec));
  return rec;
}

export async function bumpFragments(env, userId, delta) {
  const rec = await getFragments(env, userId);
  rec.frag = Math.max(0, (rec.frag || 0) + delta);
  await putFragments(env, userId, rec);
  return rec;
}

// ── Public: recycle ─────────────────────────────────────────────────
//
// items: [{ cardId, count }]   // count = copies to recycle per id
//
// Returns:
//   { ok, removed: [{cardId, count, fragYield, rarity}], fragTotal, balance }
// or
//   { ok: false, error: '...' }
//
// Notes:
//   - Champions and tokens cannot be recycled (they're never in
//     collections, but we reject them defensively).
//   - Recycling a card you don't own (or fewer copies than asked)
//     fails atomically — nothing is removed, no fragments awarded.
//   - The active deck is NOT consulted; you CAN recycle a card you're
//     actively using. The next /boltbound match will fail validation
//     and prompt a deck rebuild — that's the punishment for going too
//     deep into the grinder.

export async function recycleCards(env, guildId, userId, items) {
  if (!Array.isArray(items) || !items.length) {
    return { ok: false, error: 'no-items' };
  }
  await ensureCollection(env, guildId, userId);
  const col = await getCollection(env, guildId, userId);

  // Validate every item first — atomic semantics.
  const plan = [];
  for (const it of items) {
    const card = CARDS[it.cardId];
    if (!card) return { ok: false, error: 'unknown-card: ' + it.cardId };
    if (card.rarity === 'champion' || card.token) {
      return { ok: false, error: 'untradable: ' + it.cardId };
    }
    const count = Math.max(0, Math.floor(it.count || 0));
    if (!count) continue;
    const have = col.cards[it.cardId] || 0;
    if (count > have) {
      return { ok: false, error: `not-enough-copies: ${it.cardId} (have ${have}, asked ${count})` };
    }
    const yieldPer = RECYCLE_YIELD[card.rarity] || 0;
    plan.push({ cardId: it.cardId, count, rarity: card.rarity, fragYield: yieldPer * count });
  }
  if (!plan.length) return { ok: false, error: 'no-items' };

  // Apply.
  let fragTotal = 0;
  for (const p of plan) {
    col.cards[p.cardId] = (col.cards[p.cardId] || 0) - p.count;
    if (col.cards[p.cardId] <= 0) delete col.cards[p.cardId];
    fragTotal += p.fragYield;
  }
  await putCollection(env, guildId, userId, col);

  // Credit fragments.
  const rec = await getFragments(env, userId);
  rec.frag = (rec.frag || 0) + fragTotal;
  rec.recycled = (rec.recycled || 0) + plan.reduce((s, p) => s + p.count, 0);
  await putFragments(env, userId, rec);

  return { ok: true, removed: plan, fragTotal, balance: rec.frag };
}

// ── Public: craft a pack from fragments ─────────────────────────────
//
// Charges CRAFT_COST_FRAG[packType] from balance, then mints a
// pending pack via creditPack(... source:'crafted-frag'). The pack
// opens through the same path as any other pack — recycle/craft is
// purely a *source* of pending packs.

export async function craftPackFromFragments(env, guildId, userId, packType) {
  const cost = CRAFT_COST_FRAG[packType];
  if (cost == null) return { ok: false, error: 'cannot-craft-this-pack' };
  const rec = await getFragments(env, userId);
  if ((rec.frag || 0) < cost) {
    return { ok: false, error: 'insufficient-frag', need: cost, have: rec.frag || 0 };
  }
  // Debit first, then mint. If the mint fails the fragments stay
  // burnt — same posture as the Bolts buyPack path.
  rec.frag = rec.frag - cost;
  rec.crafted = (rec.crafted || 0) + 1;
  await putFragments(env, userId, rec);

  const credited = await creditPack(env, guildId, userId, packType, 'crafted-frag');
  if (!credited.ok) {
    // Refund — should be rare, but if creditPack rejected we return
    // the fragments. Pity counters and pack-opening flow are
    // untouched because no pending row was minted.
    rec.frag = rec.frag + cost;
    rec.crafted = Math.max(0, rec.crafted - 1);
    await putFragments(env, userId, rec);
    return { ok: false, error: credited.error || 'mint-failed' };
  }
  return { ok: true, pack: credited.pack, cost, balance: rec.frag };
}

// ── Convenience: "what would I get if I auto-recycled past-cap dups?"
//
// Used by the Discord "Recycle excess" button + the future web button
// to preview yield before committing.

export function previewAutoRecycle(collection) {
  const items = [];
  let frag = 0;
  for (const [cardId, count] of Object.entries(collection?.cards || {})) {
    const card = CARDS[cardId];
    if (!card) continue;
    if (card.rarity === 'champion' || card.token) continue;
    const cap = RARITY_DECK_CAP[card.rarity] || 1;
    const excess = Math.max(0, count - cap);
    if (excess > 0) {
      const yieldPer = RECYCLE_YIELD[card.rarity] || 0;
      items.push({ cardId, count: excess, rarity: card.rarity, fragYield: yieldPer * excess });
      frag += yieldPer * excess;
    }
  }
  return { items, fragTotal: frag };
}

// ── Sanity: craft must cost MORE than bolts for the same pack ───────
//
// CARD-GAME-DESIGN.md §14.3 locks "fragments cost MORE than bolts".
// 1 common recycled = 1 fragment, so a viewer recycling 250 commons
// produces 250 fragments. The Bolt Pack costs 400 fragments to craft
// vs. 250 bolts to buy — a 60% premium. If anyone edits CRAFT_COST_FRAG
// to a number that breaks this invariant, the IIFE here throws at
// module load.

(function craftCostInvariant() {
  for (const [pack, fragCost] of Object.entries(CRAFT_COST_FRAG)) {
    const boltPrice = BOLTS_PRICE_OF[pack];
    if (boltPrice == null) continue;
    // The fragment cost MUST be strictly greater than the bolts price
    // (using 1 common = 1 fragment as the unit conversion).
    if (fragCost <= boltPrice) {
      throw new Error(
        `cards-fragments.js: craft cost for ${pack} (${fragCost} frag) must be > bolts price (${boltPrice}). ` +
        `See CARD-GAME-DESIGN.md §14.3 — fragments are the slow path.`
      );
    }
  }
})();
