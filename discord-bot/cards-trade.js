// Boltbound card trading — player-to-player offers.
//
// Single module that owns every read/write against the trade KV keys.
// Pure business logic — the web/Discord glue lives in cards-web.js
// (notification side-effects are not part of the core flow).
//
// ── KV layout ────────────────────────────────────────────────────────
//   cards:trade:<guildId>:<tradeId>
//     canonical trade record. One per offer.
//   cards:trade-idx:from:<guildId>:<fromUserId>:<tradeId>
//     outgoing index pointer (empty value). Used to list a viewer's
//     OUTGOING pending offers without scanning every trade record.
//   cards:trade-idx:to:<guildId>:<toUserId>:<tradeId>
//     incoming index pointer (empty value).
//
// Index pointers are deleted as soon as a trade leaves `pending`
// (accepted/declined/cancelled/expired) so the index reflects only
// LIVE offers. The canonical record stays around with the resolution
// stamp.
//
// ── Atomicity ────────────────────────────────────────────────────────
// Cloudflare KV has no transactions. acceptTrade is structured as:
//   1. Load trade. If status !== 'pending', return idempotent state.
//   2. Re-validate (both sides still own every card + bolts).
//   3. Compute the FINAL state of both collections + both wallets
//      entirely in memory.
//   4. STAMP trade as accepted + persist (the "commit point").
//   5. Persist FINAL collection/wallet states (writes are absolute,
//      not increments — re-applying yields the same result).
//   6. Delete index pointers.
//
// On retry after step 4: step 1 short-circuits and returns the cached
// resolution. On retry between step 4 and 6: the writes in step 5
// are idempotent because they put the absolute final state, not a
// delta — re-running them produces the same KV value.

import { CARDS, RARITY_DECK_CAP } from './cards-content.js';
import { getCollection, putCollection } from './cards-state.js';
import { getWallet, putWallet } from './wallet.js';

// ── Limits ───────────────────────────────────────────────────────────

export const MAX_CARDS_PER_SIDE  = 12;
export const MAX_PENDING_PER_USER = 20;     // incoming + outgoing combined
export const MAX_BOLTS_PER_SIDE  = 1_000_000;
export const MAX_NOTE_LEN        = 200;
export const TRADE_TTL_MS        = 7 * 24 * 60 * 60 * 1000;  // 7 days

// ── Key builders ─────────────────────────────────────────────────────

const TRADE_KEY   = (g, tid)       => `cards:trade:${g}:${tid}`;
const FROM_IDX    = (g, u, tid)    => `cards:trade-idx:from:${g}:${u}:${tid}`;
const TO_IDX      = (g, u, tid)    => `cards:trade-idx:to:${g}:${u}:${tid}`;
const FROM_PREFIX = (g, u)         => `cards:trade-idx:from:${g}:${u}:`;
const TO_PREFIX   = (g, u)         => `cards:trade-idx:to:${g}:${u}:`;

// ── Helpers ──────────────────────────────────────────────────────────

function newTradeId() {
  // 16 random hex chars (~64 bits). Collision probability is
  // negligible at our scale and the key is namespaced by guild.
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function tallyCards(list) {
  const out = {};
  for (const cid of list) out[cid] = (out[cid] || 0) + 1;
  return out;
}

// Cards are tradable iff:
//   • they exist in the catalogue
//   • they aren't champions (untradable by design — class-bound)
//   • they aren't tokens (untradable — generated mid-match)
function isCardTradable(cardId) {
  const card = CARDS[cardId];
  if (!card) return false;
  if (card.rarity === 'champion') return false;
  if (card.token) return false;
  return true;
}

// Validate a list of card ids that one side is offering. Returns
// null if OK, else an { error, ... } shape ready to bubble up to the
// HTTP response.
function validateCardList(list, side) {
  if (!Array.isArray(list)) return { error: 'bad-cards', side, message: 'cards must be an array' };
  if (list.length > MAX_CARDS_PER_SIDE) {
    return { error: 'too-many-cards', side, max: MAX_CARDS_PER_SIDE };
  }
  for (const cid of list) {
    if (typeof cid !== 'string' || !cid) return { error: 'bad-cards', side, message: 'card id must be a non-empty string' };
    if (!isCardTradable(cid)) return { error: 'untradable-card', side, cardId: cid };
  }
  return null;
}

// Confirm the collection contains AT LEAST the asked quantity of
// every card in the list (de-duplicated by id with running counts).
function ownsAll(col, list) {
  const need = tallyCards(list);
  for (const [cid, n] of Object.entries(need)) {
    if ((col.cards?.[cid] || 0) < n) return { ok: false, cardId: cid, need: n, have: col.cards?.[cid] || 0 };
  }
  return { ok: true };
}

// Compute the new collection that results from removing `removeList`
// then adding `addList`. Returns a NEW object (does not mutate input).
// Removing is capped at 0 (defensive — we re-validate ownership
// before calling, but a CARD already at 0 won't go negative). Adding
// is capped at the rarity deck cap; any overflow surfaces as
// `cappedOverflow` so the caller can decide whether to convert to
// dupe-bolts or refuse the trade.
function applyCardDelta(col, removeList, addList) {
  const next = { ...col, cards: { ...(col.cards || {}) } };
  const rem = tallyCards(removeList);
  const add = tallyCards(addList);
  const cappedOverflow = []; // [{ cardId, attempted, capped }, ...]
  for (const [cid, n] of Object.entries(rem)) {
    next.cards[cid] = Math.max(0, (next.cards[cid] || 0) - n);
    if (next.cards[cid] === 0) delete next.cards[cid];
  }
  for (const [cid, n] of Object.entries(add)) {
    const card = CARDS[cid];
    const cap = (card && RARITY_DECK_CAP[card.rarity]) || 1;
    const have = next.cards[cid] || 0;
    const room = Math.max(0, cap - have);
    const take = Math.min(n, room);
    if (take > 0) next.cards[cid] = have + take;
    if (n > take) cappedOverflow.push({ cardId: cid, attempted: n, capped: n - take });
  }
  next.ts = Date.now();
  return { next, cappedOverflow };
}

// Count a user's currently-pending trades (incoming + outgoing) so
// we can enforce MAX_PENDING_PER_USER.
async function countPending(env, guildId, userId) {
  let n = 0;
  for (const prefix of [FROM_PREFIX(guildId, userId), TO_PREFIX(guildId, userId)]) {
    let cursor;
    for (let i = 0; i < 3; i++) {
      const r = await env.LOADOUT_BOLTS.list({ prefix, cursor, limit: 1000 });
      n += r.keys.length;
      if (r.list_complete || !r.cursor) break;
      cursor = r.cursor;
    }
  }
  return n;
}

// ── Read helpers (used by the web/list routes) ───────────────────────

export async function getTrade(env, guildId, tradeId) {
  const raw = await env.LOADOUT_BOLTS.get(TRADE_KEY(guildId, tradeId), { type: 'json' });
  if (!raw) return null;
  // Lazy expiry — if older than TRADE_TTL_MS and still pending, flip
  // to 'expired' on read. The KV record will get rewritten on the
  // next mutation; until then the read returns the expired view.
  if (raw.status === 'pending' && Date.now() - raw.proposedUtc > TRADE_TTL_MS) {
    raw.status = 'expired';
    raw.resolvedUtc = raw.proposedUtc + TRADE_TTL_MS;
    raw.resolvedBy  = null;
  }
  return raw;
}

// List trades by direction ('incoming' | 'outgoing' | 'both').
// Returns only LIVE (pending) trades — index pointers are deleted
// on resolve. Caller can supplement with historical lookups by
// tradeId if needed (we don't currently surface a "history" view).
export async function listTrades(env, guildId, userId, direction) {
  const dir = direction || 'both';
  const prefixes = [];
  if (dir === 'incoming' || dir === 'both') prefixes.push({ kind: 'incoming', prefix: TO_PREFIX(guildId, userId) });
  if (dir === 'outgoing' || dir === 'both') prefixes.push({ kind: 'outgoing', prefix: FROM_PREFIX(guildId, userId) });
  const tradeIds = [];
  for (const { kind, prefix } of prefixes) {
    let cursor;
    for (let i = 0; i < 5; i++) {
      const r = await env.LOADOUT_BOLTS.list({ prefix, cursor, limit: 1000 });
      for (const k of r.keys) {
        const tid = k.name.slice(prefix.length);
        tradeIds.push({ kind, tradeId: tid });
      }
      if (r.list_complete || !r.cursor) break;
      cursor = r.cursor;
    }
  }
  // Fetch records in parallel, drop any that no longer exist (race
  // between list + delete).
  const records = await Promise.all(tradeIds.map(async ({ kind, tradeId }) => {
    const t = await getTrade(env, guildId, tradeId);
    return t ? { ...t, direction: kind } : null;
  }));
  return records.filter(Boolean).sort((a, b) => b.proposedUtc - a.proposedUtc);
}

// ── propose ──────────────────────────────────────────────────────────

export async function proposeTrade(env, params) {
  const guildId    = String(params.guildId || '');
  const fromUserId = String(params.fromUserId || '');
  const toUserId   = String(params.toUserId || '');
  const fromCards  = Array.isArray(params.fromCards) ? params.fromCards.map(String) : [];
  const toCards    = Array.isArray(params.toCards)   ? params.toCards.map(String)   : [];
  const fromBolts  = Math.max(0, Math.floor(Number(params.fromBolts) || 0));
  const toBolts    = Math.max(0, Math.floor(Number(params.toBolts)   || 0));
  const note       = typeof params.note === 'string' ? params.note.slice(0, MAX_NOTE_LEN) : '';

  if (!/^\d{5,25}$/.test(guildId))    return { ok: false, error: 'bad-guild-id' };
  if (!/^\d{5,25}$/.test(fromUserId)) return { ok: false, error: 'bad-from-id' };
  if (!/^\d{5,25}$/.test(toUserId))   return { ok: false, error: 'bad-to-id' };
  if (fromUserId === toUserId)        return { ok: false, error: 'self-trade' };

  // Each side must offer something — empty trades are nonsensical.
  if (fromCards.length === 0 && fromBolts === 0) return { ok: false, error: 'empty-from-side' };
  if (toCards.length === 0   && toBolts === 0)   return { ok: false, error: 'empty-to-side' };

  if (fromBolts > MAX_BOLTS_PER_SIDE) return { ok: false, error: 'bolts-too-high', side: 'from', max: MAX_BOLTS_PER_SIDE };
  if (toBolts   > MAX_BOLTS_PER_SIDE) return { ok: false, error: 'bolts-too-high', side: 'to',   max: MAX_BOLTS_PER_SIDE };

  const fromCheck = validateCardList(fromCards, 'from');
  if (fromCheck) return { ok: false, ...fromCheck };
  const toCheck   = validateCardList(toCards,   'to');
  if (toCheck)   return { ok: false, ...toCheck };

  // Pending-offer cap (PER-SIDE — applies to both proposer and recipient
  // so a flood of incoming offers can't lock someone out of trading).
  const fromPending = await countPending(env, guildId, fromUserId);
  if (fromPending >= MAX_PENDING_PER_USER) {
    return { ok: false, error: 'too-many-pending', side: 'from', count: fromPending, max: MAX_PENDING_PER_USER };
  }
  const toPending = await countPending(env, guildId, toUserId);
  if (toPending >= MAX_PENDING_PER_USER) {
    return { ok: false, error: 'too-many-pending', side: 'to', count: toPending, max: MAX_PENDING_PER_USER };
  }

  // Validate ownership at PROPOSE time (also re-checked at ACCEPT).
  const fromCol = await getCollection(env, guildId, fromUserId);
  const ownFrom = ownsAll(fromCol, fromCards);
  if (!ownFrom.ok) return { ok: false, error: 'from-missing-cards', cardId: ownFrom.cardId, need: ownFrom.need, have: ownFrom.have };

  const toCol = await getCollection(env, guildId, toUserId);
  const ownTo = ownsAll(toCol, toCards);
  if (!ownTo.ok) return { ok: false, error: 'to-missing-cards', cardId: ownTo.cardId, need: ownTo.need, have: ownTo.have };

  if (fromBolts > 0) {
    const fromWal = await getWallet(env, guildId, fromUserId);
    if ((fromWal.balance || 0) < fromBolts) {
      return { ok: false, error: 'from-insufficient-bolts', have: fromWal.balance || 0, need: fromBolts };
    }
  }
  if (toBolts > 0) {
    const toWal = await getWallet(env, guildId, toUserId);
    if ((toWal.balance || 0) < toBolts) {
      return { ok: false, error: 'to-insufficient-bolts', have: toWal.balance || 0, need: toBolts };
    }
  }

  const tradeId = newTradeId();
  const trade = {
    tradeId, guildId, fromUserId, toUserId,
    fromCards, toCards, fromBolts, toBolts, note,
    status: 'pending',
    proposedUtc: Date.now(),
    resolvedUtc: 0,
    resolvedBy: null,
  };
  await env.LOADOUT_BOLTS.put(TRADE_KEY(guildId, tradeId), JSON.stringify(trade));
  await env.LOADOUT_BOLTS.put(FROM_IDX(guildId, fromUserId, tradeId), '1');
  await env.LOADOUT_BOLTS.put(TO_IDX(guildId, toUserId, tradeId),     '1');
  return { ok: true, trade };
}

// ── accept (atomic transfer + idempotent on retry) ───────────────────

export async function acceptTrade(env, guildId, tradeId, acceptorId) {
  const trade = await getTrade(env, guildId, tradeId);
  if (!trade) return { ok: false, error: 'not-found' };
  if (trade.guildId !== guildId) return { ok: false, error: 'wrong-guild' };
  if (String(trade.toUserId) !== String(acceptorId)) return { ok: false, error: 'not-recipient' };

  // Idempotent: re-accept of an already-accepted trade returns the
  // cached resolution (no double-transfer).
  if (trade.status === 'accepted') return { ok: true, trade, alreadyAccepted: true };
  if (trade.status !== 'pending')  return { ok: false, error: 'not-pending', status: trade.status };

  // ── Re-validate at ACCEPT time ───────────────────────────────────
  const fromCol = await getCollection(env, guildId, trade.fromUserId);
  const toCol   = await getCollection(env, guildId, trade.toUserId);

  const ownFrom = ownsAll(fromCol, trade.fromCards);
  if (!ownFrom.ok) return { ok: false, error: 'from-missing-cards', cardId: ownFrom.cardId, need: ownFrom.need, have: ownFrom.have };
  const ownTo = ownsAll(toCol, trade.toCards);
  if (!ownTo.ok) return { ok: false, error: 'to-missing-cards', cardId: ownTo.cardId, need: ownTo.need, have: ownTo.have };

  const fromWal = trade.fromBolts > 0 ? await getWallet(env, guildId, trade.fromUserId) : null;
  const toWal   = trade.toBolts   > 0 ? await getWallet(env, guildId, trade.toUserId)   : null;
  if (fromWal && (fromWal.balance || 0) < trade.fromBolts) {
    return { ok: false, error: 'from-insufficient-bolts', have: fromWal.balance || 0, need: trade.fromBolts };
  }
  if (toWal && (toWal.balance || 0) < trade.toBolts) {
    return { ok: false, error: 'to-insufficient-bolts', have: toWal.balance || 0, need: trade.toBolts };
  }

  // ── Compute final state in memory ─────────────────────────────────
  // fromUser: -fromCards, +toCards, -fromBolts, +toBolts
  // toUser:   -toCards,   +fromCards, -toBolts, +fromBolts
  const fromColApplied = applyCardDelta(fromCol, trade.fromCards, trade.toCards);
  const toColApplied   = applyCardDelta(toCol,   trade.toCards,   trade.fromCards);

  // Cards over the rarity cap on the receiving side become dupe
  // overflow — recorded on the trade record so the response can
  // surface "X copies were over your deck cap and silently dropped".
  // We do NOT auto-convert to bolts here (keeps the trade purely a
  // card+bolts swap with deterministic outcomes).
  const overflow = {
    from: fromColApplied.cappedOverflow,
    to:   toColApplied.cappedOverflow,
  };

  // Compute new wallet balances. We need to read BOTH wallets if any
  // bolts move (so a fromBolts-only trade still credits the recipient).
  const fromWalForWrite = (trade.fromBolts > 0 || trade.toBolts > 0)
    ? (fromWal || await getWallet(env, guildId, trade.fromUserId))
    : null;
  const toWalForWrite = (trade.fromBolts > 0 || trade.toBolts > 0)
    ? (toWal || await getWallet(env, guildId, trade.toUserId))
    : null;

  let fromWalNext = null, toWalNext = null;
  if (fromWalForWrite && toWalForWrite) {
    const now = Date.now();
    fromWalNext = { ...fromWalForWrite,
      balance: (fromWalForWrite.balance || 0) - trade.fromBolts + trade.toBolts,
      lifetimeSpent:  (fromWalForWrite.lifetimeSpent  || 0) + trade.fromBolts,
      lifetimeEarned: (fromWalForWrite.lifetimeEarned || 0) + trade.toBolts,
      lastSpendUtc:    trade.fromBolts > 0 ? now : fromWalForWrite.lastSpendUtc,
      lastSpendReason: trade.fromBolts > 0 ? `trade:${tradeId}` : fromWalForWrite.lastSpendReason,
      lastEarnUtc:     trade.toBolts   > 0 ? now : fromWalForWrite.lastEarnUtc,
      lastEarnReason:  trade.toBolts   > 0 ? `trade:${tradeId}` : fromWalForWrite.lastEarnReason,
    };
    toWalNext = { ...toWalForWrite,
      balance: (toWalForWrite.balance || 0) - trade.toBolts + trade.fromBolts,
      lifetimeSpent:  (toWalForWrite.lifetimeSpent  || 0) + trade.toBolts,
      lifetimeEarned: (toWalForWrite.lifetimeEarned || 0) + trade.fromBolts,
      lastSpendUtc:    trade.toBolts   > 0 ? now : toWalForWrite.lastSpendUtc,
      lastSpendReason: trade.toBolts   > 0 ? `trade:${tradeId}` : toWalForWrite.lastSpendReason,
      lastEarnUtc:     trade.fromBolts > 0 ? now : toWalForWrite.lastEarnUtc,
      lastEarnReason:  trade.fromBolts > 0 ? `trade:${tradeId}` : toWalForWrite.lastEarnReason,
    };
  }

  // ── COMMIT POINT ──────────────────────────────────────────────────
  // Stamp the trade as accepted BEFORE applying transfers. If we
  // crash between this write and the transfer writes, a retry will
  // see status='accepted' and short-circuit (returning the cached
  // resolution). The transfer writes below are absolute (not delta)
  // so re-applying them produces the same KV state.
  trade.status      = 'accepted';
  trade.resolvedUtc = Date.now();
  trade.resolvedBy  = acceptorId;
  trade.overflow    = overflow;
  await env.LOADOUT_BOLTS.put(TRADE_KEY(guildId, tradeId), JSON.stringify(trade));

  // ── Apply transfers (idempotent on replay) ────────────────────────
  await putCollection(env, guildId, trade.fromUserId, fromColApplied.next);
  await putCollection(env, guildId, trade.toUserId,   toColApplied.next);
  if (fromWalNext) await putWallet(env, guildId, trade.fromUserId, fromWalNext);
  if (toWalNext)   await putWallet(env, guildId, trade.toUserId,   toWalNext);

  // ── Remove index pointers (trade is no longer pending) ────────────
  await env.LOADOUT_BOLTS.delete(FROM_IDX(guildId, trade.fromUserId, tradeId));
  await env.LOADOUT_BOLTS.delete(TO_IDX(guildId, trade.toUserId,     tradeId));

  return { ok: true, trade };
}

// ── decline ──────────────────────────────────────────────────────────

export async function declineTrade(env, guildId, tradeId, declinerId) {
  const trade = await getTrade(env, guildId, tradeId);
  if (!trade) return { ok: false, error: 'not-found' };
  if (trade.guildId !== guildId) return { ok: false, error: 'wrong-guild' };
  if (String(trade.toUserId) !== String(declinerId)) return { ok: false, error: 'not-recipient' };
  if (trade.status !== 'pending') return { ok: false, error: 'not-pending', status: trade.status };

  trade.status      = 'declined';
  trade.resolvedUtc = Date.now();
  trade.resolvedBy  = declinerId;
  await env.LOADOUT_BOLTS.put(TRADE_KEY(guildId, tradeId), JSON.stringify(trade));
  await env.LOADOUT_BOLTS.delete(FROM_IDX(guildId, trade.fromUserId, tradeId));
  await env.LOADOUT_BOLTS.delete(TO_IDX(guildId, trade.toUserId,     tradeId));
  return { ok: true, trade };
}

// ── cancel (proposer-only) ───────────────────────────────────────────

export async function cancelTrade(env, guildId, tradeId, cancellerId) {
  const trade = await getTrade(env, guildId, tradeId);
  if (!trade) return { ok: false, error: 'not-found' };
  if (trade.guildId !== guildId) return { ok: false, error: 'wrong-guild' };
  if (String(trade.fromUserId) !== String(cancellerId)) return { ok: false, error: 'not-proposer' };
  if (trade.status !== 'pending') return { ok: false, error: 'not-pending', status: trade.status };

  trade.status      = 'cancelled';
  trade.resolvedUtc = Date.now();
  trade.resolvedBy  = cancellerId;
  await env.LOADOUT_BOLTS.put(TRADE_KEY(guildId, tradeId), JSON.stringify(trade));
  await env.LOADOUT_BOLTS.delete(FROM_IDX(guildId, trade.fromUserId, tradeId));
  await env.LOADOUT_BOLTS.delete(TO_IDX(guildId, trade.toUserId,     tradeId));
  return { ok: true, trade };
}

// ── tradeable-collection view (so the web UI can show what the other
// player owns) ──────────────────────────────────────────────────────

export async function tradeableCollection(env, guildId, ownerId) {
  const col = await getCollection(env, guildId, ownerId);
  // Return only TRADABLE entries (champions + tokens excluded).
  const items = [];
  for (const [cardId, count] of Object.entries(col.cards || {})) {
    if (!isCardTradable(cardId)) continue;
    if (!count || count <= 0) continue;
    const card = CARDS[cardId];
    if (!card) continue;
    items.push({
      cardId,
      count,
      name: card.name,
      rarity: card.rarity,
      type: card.type,
      mana: card.mana,
      atk: card.atk,
      hp: card.hp,
      spriteId: card.spriteId || null,
    });
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return { ownerId, items, count: items.length };
}
