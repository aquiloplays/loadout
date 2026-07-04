// Standalone harness for the Boltbound card-trading module.
// In-memory KV; exercises propose/accept/decline/cancel + atomicity
// (re-validate on accept; idempotent retry; over-cap overflow).
// Run from repo root:
//   node discord-bot/test/test-cards-trade.mjs

import {
  proposeTrade, acceptTrade, declineTrade, cancelTrade,
  getTrade, listTrades, tradeableCollection,
  MAX_CARDS_PER_SIDE, MAX_PENDING_PER_USER,
} from '../cards-trade.js';
import { getCollection, putCollection } from '../cards-state.js';
import { getWallet, putWallet } from '../wallet.js';
import { CARDS } from '../cards-content.js';

function makeKvShim() {
  const store = new Map();
  return {
    async get(key, opts) {
      const v = store.get(key);
      if (v === undefined) return null;
      if (opts && opts.type === 'json') {
        try { return JSON.parse(v); } catch { return null; }
      }
      return v;
    },
    async put(key, value) { store.set(key, String(value)); },
    async delete(key) { store.delete(key); },
    async list({ prefix, cursor, limit } = {}) {
      const all = [];
      for (const k of store.keys()) if (k.startsWith(prefix || '')) all.push({ name: k });
      return { keys: all.slice(0, limit || 1000), list_complete: true };
    },
    _dump() { return Object.fromEntries(store); },
  };
}

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + label + (detail ? ' (' + detail + ')' : '')); }
  else      { failed++; console.log('  FAIL  ' + label + (detail ? ' -- ' + detail : '')); }
}

const env = { LOADOUT_BOLTS: makeKvShim() };
const G = '1504103035951906883';
const A = '111111111111111111';   // Alice, proposer
const B = '222222222222222222';   // Bob, recipient
const C = '333333333333333333';   // Carl, spectator

// Pick two known tradable cards from the catalogue.
const tradableIds = Object.values(CARDS)
  .filter(c => c.rarity !== 'champion' && !c.token)
  .map(c => c.id);
if (tradableIds.length < 4) throw new Error('catalogue too small for trade test');
const CARD1 = tradableIds[0];
const CARD2 = tradableIds[1];
const CARD3 = tradableIds[2];
const CARD4 = tradableIds[3];

// Seed Alice's and Bob's collections + wallets.
await putCollection(env, G, A, { cards: { [CARD1]: 2, [CARD2]: 1 }, ts: 0 });
await putCollection(env, G, B, { cards: { [CARD3]: 2, [CARD4]: 1 }, ts: 0 });
await putWallet(env, G, A, { balance: 500, lifetimeEarned: 500, lifetimeSpent: 0, lastEarnUtc: 0, dailyStreak: 0, lastDailyUtc: 0, links: [] });
await putWallet(env, G, B, { balance: 200, lifetimeEarned: 200, lifetimeSpent: 0, lastEarnUtc: 0, dailyStreak: 0, lastDailyUtc: 0, links: [] });

console.log('--- cards-trade unit harness ---');

// ── propose ─────────────────────────────────────────────────────────
const p1 = await proposeTrade(env, {
  guildId: G, fromUserId: A, toUserId: B,
  fromCards: [CARD1, CARD2], toCards: [CARD3],
  fromBolts: 100, toBolts: 0,
  note: 'swap?',
});
ok('proposeTrade succeeds', p1.ok && p1.trade?.tradeId, p1.error || p1.trade?.tradeId);
ok('trade status pending', p1.trade?.status === 'pending');
ok('trade stamps proposer + recipient', p1.trade?.fromUserId === A && p1.trade?.toUserId === B);
ok('note truncated/preserved', p1.trade?.note === 'swap?');

const TID = p1.trade.tradeId;

// ── re-fetch via getTrade ────────────────────────────────────────────
const fetched = await getTrade(env, G, TID);
ok('getTrade returns the trade', fetched && fetched.tradeId === TID);

// ── listTrades (incoming for Bob, outgoing for Alice) ────────────────
const aOut = await listTrades(env, G, A, 'outgoing');
ok('Alice has 1 outgoing', aOut.length === 1 && aOut[0].tradeId === TID, `count=${aOut.length}`);
const bIn = await listTrades(env, G, B, 'incoming');
ok('Bob has 1 incoming', bIn.length === 1 && bIn[0].tradeId === TID, `count=${bIn.length}`);
const cBoth = await listTrades(env, G, C, 'both');
ok('Carl sees no trades', cBoth.length === 0);

// ── reject: cancel by non-proposer ───────────────────────────────────
const badCancel = await cancelTrade(env, G, TID, B);
ok('cancel by recipient rejected', !badCancel.ok && badCancel.error === 'not-proposer', badCancel.error);

// ── reject: accept by non-recipient ──────────────────────────────────
const badAccept = await acceptTrade(env, G, TID, A);
ok('accept by proposer rejected', !badAccept.ok && badAccept.error === 'not-recipient', badAccept.error);

// ── reject: empty trade ──────────────────────────────────────────────
const empty = await proposeTrade(env, { guildId: G, fromUserId: A, toUserId: B, fromCards: [], toCards: [CARD3] });
ok('empty FROM side rejected', !empty.ok && empty.error === 'empty-from-side', empty.error);

// ── reject: self-trade ───────────────────────────────────────────────
const self = await proposeTrade(env, { guildId: G, fromUserId: A, toUserId: A, fromCards: [CARD1], toCards: [CARD1] });
ok('self-trade rejected', !self.ok && self.error === 'self-trade', self.error);

// ── reject: untradable card (champion) ───────────────────────────────
const champId = Object.values(CARDS).find(c => c.rarity === 'champion')?.id;
if (champId) {
  const champ = await proposeTrade(env, { guildId: G, fromUserId: A, toUserId: B, fromCards: [champId], toCards: [CARD3] });
  ok('champion rejected', !champ.ok && champ.error === 'untradable-card', champ.error);
}

// ── reject: offering cards you don't own ─────────────────────────────
const missing = await proposeTrade(env, { guildId: G, fromUserId: A, toUserId: B, fromCards: [CARD3], toCards: [CARD1] });
ok('proposing unowned card rejected', !missing.ok && missing.error === 'from-missing-cards', missing.error);

// ── reject: too many bolts ───────────────────────────────────────────
const richTrade = await proposeTrade(env, { guildId: G, fromUserId: A, toUserId: B, fromCards: [CARD1], toCards: [CARD3], fromBolts: 99_999_999 });
ok('bolts cap enforced', !richTrade.ok && richTrade.error === 'bolts-too-high', richTrade.error);

// ── reject: insufficient bolts ───────────────────────────────────────
const broke = await proposeTrade(env, { guildId: G, fromUserId: B, toUserId: A, fromCards: [CARD3], toCards: [CARD1], fromBolts: 9999 });
ok('insufficient bolts rejected', !broke.ok && broke.error === 'from-insufficient-bolts', broke.error);

// ── note truncation ─────────────────────────────────────────────────
const longNote = await proposeTrade(env, {
  guildId: G, fromUserId: A, toUserId: B,
  fromCards: [CARD1], toCards: [CARD3],
  note: 'x'.repeat(500),
});
ok('note truncated to MAX_NOTE_LEN', longNote.ok && longNote.trade.note.length === 200, `len=${longNote.trade.note.length}`);
// Clean up: cancel the long-note trade so it doesn't pollute later state.
await cancelTrade(env, G, longNote.trade.tradeId, A);

// ── accept the original trade (atomic transfer) ─────────────────────
const accept = await acceptTrade(env, G, TID, B);
ok('accept succeeds', accept.ok && accept.trade?.status === 'accepted', accept.error);

const aColAfter = await getCollection(env, G, A);
const bColAfter = await getCollection(env, G, B);
ok('Alice lost CARD1 (2→1)', (aColAfter.cards[CARD1] || 0) === 1, `count=${aColAfter.cards[CARD1]}`);
ok('Alice lost CARD2 (1→0/missing)', !(aColAfter.cards[CARD2]), `key=${JSON.stringify(aColAfter.cards[CARD2])}`);
ok('Alice gained CARD3', (aColAfter.cards[CARD3] || 0) === 1, `count=${aColAfter.cards[CARD3]}`);
ok('Bob lost CARD3 (2→1)', (bColAfter.cards[CARD3] || 0) === 1, `count=${bColAfter.cards[CARD3]}`);
ok('Bob gained CARD1', (bColAfter.cards[CARD1] || 0) === 1, `count=${bColAfter.cards[CARD1]}`);
ok('Bob gained CARD2', (bColAfter.cards[CARD2] || 0) === 1, `count=${bColAfter.cards[CARD2]}`);

const aWalAfter = await getWallet(env, G, A);
const bWalAfter = await getWallet(env, G, B);
ok('Alice paid 100 bolts (500→400)', aWalAfter.balance === 400, `bal=${aWalAfter.balance}`);
ok('Bob received 100 bolts (200→300)', bWalAfter.balance === 300, `bal=${bWalAfter.balance}`);
ok('Alice lifetimeSpent updated', aWalAfter.lifetimeSpent === 100, `lifetimeSpent=${aWalAfter.lifetimeSpent}`);
ok('Bob lifetimeEarned updated', bWalAfter.lifetimeEarned === 300, `lifetimeEarned=${bWalAfter.lifetimeEarned}`);

// ── idempotent re-accept ────────────────────────────────────────────
const reAccept = await acceptTrade(env, G, TID, B);
ok('re-accept idempotent', reAccept.ok && reAccept.alreadyAccepted, `error=${reAccept.error} already=${reAccept.alreadyAccepted}`);
const aColRepeat = await getCollection(env, G, A);
const bWalRepeat = await getWallet(env, G, B);
ok('re-accept does NOT double-transfer cards', (aColRepeat.cards[CARD1] || 0) === 1, `count=${aColRepeat.cards[CARD1]}`);
ok('re-accept does NOT double-credit bolts', bWalRepeat.balance === 300, `bal=${bWalRepeat.balance}`);

// ── index keys cleared on accept ────────────────────────────────────
const liveAfter = await listTrades(env, G, A, 'outgoing');
ok('index cleared after accept', liveAfter.length === 0, `count=${liveAfter.length}`);

// ── decline flow ────────────────────────────────────────────────────
const p2 = await proposeTrade(env, {
  guildId: G, fromUserId: A, toUserId: B,
  fromCards: [CARD3], toCards: [CARD2],  // post-accept: A has CARD3, B has CARD2
});
ok('second trade proposed', p2.ok, p2.error);
const dec = await declineTrade(env, G, p2.trade.tradeId, B);
ok('decline succeeds', dec.ok && dec.trade?.status === 'declined', dec.error);
const decAgain = await declineTrade(env, G, p2.trade.tradeId, B);
ok('decline of already-declined rejected', !decAgain.ok && decAgain.error === 'not-pending', decAgain.error);

// ── cancel flow ─────────────────────────────────────────────────────
const p3 = await proposeTrade(env, {
  guildId: G, fromUserId: A, toUserId: B,
  fromCards: [CARD3], toCards: [CARD4],
});
ok('third trade proposed', p3.ok, p3.error);
const cancel = await cancelTrade(env, G, p3.trade.tradeId, A);
ok('proposer cancel succeeds', cancel.ok && cancel.trade?.status === 'cancelled', cancel.error);

// ── re-validate at ACCEPT time when collection changed ──────────────
// Propose CARD1 from Bob, then secretly remove CARD1 from his
// collection before accept, accept must reject.
const p4 = await proposeTrade(env, {
  guildId: G, fromUserId: B, toUserId: A,
  fromCards: [CARD1], toCards: [CARD3],
});
ok('fourth trade proposed (B→A)', p4.ok, p4.error);
// Mutate Bob's collection out from under the trade.
const bCol = await getCollection(env, G, B);
delete bCol.cards[CARD1];
await putCollection(env, G, B, bCol);
const acceptStale = await acceptTrade(env, G, p4.trade.tradeId, A);
ok('accept re-validates ownership', !acceptStale.ok && acceptStale.error === 'from-missing-cards', acceptStale.error);

// ── pending-cap enforcement ─────────────────────────────────────────
// Restore Bob's CARD1 (we yanked it above)
const bColRestore = await getCollection(env, G, B);
bColRestore.cards[CARD1] = 1;
await putCollection(env, G, B, bColRestore);
// Cancel the stuck p4 so we have a clean slate.
await cancelTrade(env, G, p4.trade.tradeId, B);

// Spam pending trades from A to B until cap hits.
const beforeCount = (await listTrades(env, G, A, 'outgoing')).length;
let capHitAt = null;
// Need ample cards on each side; reset both with a big stash.
await putCollection(env, G, A, {
  cards: Object.fromEntries(tradableIds.slice(0, 10).map(c => [c, 4])), ts: 0,
});
await putCollection(env, G, B, {
  cards: Object.fromEntries(tradableIds.slice(0, 10).map(c => [c, 4])), ts: 0,
});
for (let i = 0; i < MAX_PENDING_PER_USER + 2; i++) {
  const offer = await proposeTrade(env, {
    guildId: G, fromUserId: A, toUserId: B,
    fromCards: [tradableIds[i % 10]],
    toCards:   [tradableIds[(i + 1) % 10]],
  });
  if (!offer.ok && offer.error === 'too-many-pending') { capHitAt = i; break; }
}
ok('pending-cap kicks in', capHitAt !== null && capHitAt >= 1, `capHitAt=${capHitAt} (max=${MAX_PENDING_PER_USER})`);

// ── tradeableCollection view excludes champions ─────────────────────
await putCollection(env, G, C, { cards: { [CARD1]: 1, [CARD2]: 1 }, ts: 0 });
const view = await tradeableCollection(env, G, C);
ok('tradeableCollection lists 2 items', view.items.length === 2 && view.count === 2, `count=${view.count}`);
ok('tradeableCollection includes name + rarity', view.items[0].name && view.items[0].rarity, JSON.stringify(view.items[0]).slice(0, 100));

// ── HTTP integration through HMAC web layer ─────────────────────────
//
// Verifies the full path: signed POST → handleWeb dispatch →
// routeBoltbound → routeTrade*. The propose handler fires a Discord
// DM; without DISCORD_BOT_TOKEN it's silently skipped, which is the
// path tests exercise.

const { handleBoltboundWeb } = await import('../cards-web.js');

const WEB_SECRET = 'test-web-secret-please-ignore';
const webEnv = { ...env, AQUILO_SITE_WEB_SECRET: WEB_SECRET, AQUILO_VAULT_GUILD_ID: G };

async function signWebReq(secret, body) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sigBytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ts + '\n' + body)));
  let hex = '';
  for (const b of sigBytes) hex += b.toString(16).padStart(2, '0');
  return { ts, sig: hex };
}
async function webPost(path, body) {
  const bodyStr = JSON.stringify(body);
  const { ts, sig } = await signWebReq(WEB_SECRET, bodyStr);
  return new Request('https://bot.example.com' + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-aquilo-web-ts': ts,
      'x-aquilo-web-sig': sig,
    },
    body: bodyStr,
  });
}

// Reseed Alice + Bob for HTTP path (previous tests mutated their state).
await putCollection(env, G, A, { cards: { [CARD1]: 3, [CARD2]: 2 }, ts: 0 });
await putCollection(env, G, B, { cards: { [CARD3]: 3, [CARD4]: 2 }, ts: 0 });
await putWallet(env, G, A, { balance: 1000, lifetimeEarned: 1000, lifetimeSpent: 0, lastEarnUtc: 0, dailyStreak: 0, lastDailyUtc: 0, links: [] });
await putWallet(env, G, B, { balance: 1000, lifetimeEarned: 1000, lifetimeSpent: 0, lastEarnUtc: 0, dailyStreak: 0, lastDailyUtc: 0, links: [] });

// Clear stale index pointers from the unit-test section so listTrades
// doesn't bleed across phases.
const dump = env.LOADOUT_BOLTS._dump();
for (const k of Object.keys(dump)) {
  if (k.startsWith('cards:trade-idx:') || k.startsWith('cards:trade:')) {
    await env.LOADOUT_BOLTS.delete(k);
  }
}

// PROPOSE via HTTP
const proposeReq = await webPost('/web/boltbound/trade/propose', {
  discordId: A, guildId: G,
  toUserId: B,
  fromCards: [CARD1], toCards: [CARD3],
  fromBolts: 50,
});
const proposeResp = await handleBoltboundWeb(proposeReq, webEnv);
const proposeBody = await proposeResp.json();
ok('HTTP propose returns 200', proposeResp.status === 200, `status=${proposeResp.status} body=${JSON.stringify(proposeBody).slice(0, 200)}`);
ok('HTTP propose ok=true', proposeBody.ok === true, JSON.stringify(proposeBody).slice(0, 200));
const HTTP_TID = proposeBody.trade?.tradeId;
ok('HTTP propose returns tradeId', !!HTTP_TID);

// LIST incoming for Bob
const listReq = await webPost('/web/boltbound/trade/list', {
  discordId: B, guildId: G, direction: 'incoming',
});
const listResp = await handleBoltboundWeb(listReq, webEnv);
const listBody = await listResp.json();
ok('HTTP list returns trades', listBody.ok && Array.isArray(listBody.trades) && listBody.trades.length === 1, JSON.stringify(listBody).slice(0, 200));

// GET specific trade by recipient
const getReq = await webPost('/web/boltbound/trade/get', {
  discordId: B, guildId: G, tradeId: HTTP_TID,
});
const getResp = await handleBoltboundWeb(getReq, webEnv);
const getBody = await getResp.json();
ok('HTTP get returns trade', getBody.ok && getBody.trade?.tradeId === HTTP_TID);

// GET by third-party Carl → forbidden
const carlGetReq = await webPost('/web/boltbound/trade/get', {
  discordId: C, guildId: G, tradeId: HTTP_TID,
});
const carlGetResp = await handleBoltboundWeb(carlGetReq, webEnv);
const carlGetBody = await carlGetResp.json();
ok('HTTP get by third party forbidden', carlGetResp.status === 403 && carlGetBody.error === 'forbidden');

// COLLECTION view of Bob's tradeable cards
const colReq = await webPost('/web/boltbound/trade/collection', {
  discordId: A, guildId: G, ownerId: B,
});
const colResp = await handleBoltboundWeb(colReq, webEnv);
const colBody = await colResp.json();
ok('HTTP collection returns items', colBody.ok && Array.isArray(colBody.items) && colBody.items.length >= 2, `items=${colBody.items?.length}`);

// ACCEPT via HTTP
const acceptReq = await webPost('/web/boltbound/trade/accept', {
  discordId: B, guildId: G, tradeId: HTTP_TID,
});
const acceptResp = await handleBoltboundWeb(acceptReq, webEnv);
const acceptBody = await acceptResp.json();
ok('HTTP accept succeeds', acceptResp.status === 200 && acceptBody.ok && acceptBody.trade?.status === 'accepted', JSON.stringify(acceptBody).slice(0, 200));

// Bad signature → 401
const badSigReq = new Request('https://bot.example.com/web/boltbound/trade/list', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-aquilo-web-ts': '1', 'x-aquilo-web-sig': 'deadbeef' },
  body: JSON.stringify({ discordId: A, guildId: G }),
});
const badSigResp = await handleBoltboundWeb(badSigReq, webEnv);
ok('HTTP bad signature rejected', badSigResp.status === 401);

console.log('--- ' + passed + ' pass, ' + failed + ' fail ---');
if (failed > 0) process.exit(1);
