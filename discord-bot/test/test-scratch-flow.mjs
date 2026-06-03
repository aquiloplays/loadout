// Integration test for scratch-off.js, exercises mint → scratch → reveal
// with the NEW pacing guards (offline block + refund, per-stream hit cap,
// hit cooldown, loss consolation bolts, Discord echo) against a real SQL
// engine (node:sqlite) and the real KV logic. The only network edges (Twitch
// Helix, Discord REST) are mocked through globalThis.fetch; the activity DO
// degrades to a no-op exactly as in prod when its binding is absent.
//
// Run with:   node test/test-scratch-flow.mjs

import { DatabaseSync } from 'node:sqlite';
import { webcrypto as nodeCrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { handleScratch } from '../scratch-off.js';

if (!globalThis.crypto) globalThis.crypto = nodeCrypto;

// scratch-off.js's ensureSchema is isolate-flagged (one DB per isolate in
// prod). Our per-block fresh DBs would be skipped after the first, so apply
// the real migration directly on every fresh DB.
const MIGRATION = readFileSync(fileURLToPath(new URL('../scratch-off-migration.sql', import.meta.url)), 'utf8');

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } }
function eq(a, b, m) { if (a === b) { pass++; } else { fail++; console.log('  FAIL:', m, '(want', JSON.stringify(b), 'got', JSON.stringify(a), ')'); } }

// ── KV mock (supports {type:'json'} + list/delete) ──────────────────────
function makeKV(initial = {}) {
  const store = new Map(Object.entries(initial).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return {
    _store: store,
    async get(k, opts) { if (!store.has(k)) return null; const v = store.get(k); return opts && opts.type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { store.set(k, String(v)); },
    async delete(k) { store.delete(k); },
    async list({ prefix } = {}) { return { keys: [...store.keys()].filter(k => !prefix || k.startsWith(prefix)).map(name => ({ name })) }; },
  };
}

// ── D1 shim over node:sqlite ────────────────────────────────────────────
function makeD1() {
  const sdb = new DatabaseSync(':memory:');
  sdb.exec(MIGRATION);
  const wrap = (stmt) => ({
    bind(...args) {
      const params = args.map(a => a === undefined ? null : a);
      return {
        async run() { stmt.run(...params); return { success: true }; },
        async first() { const r = stmt.get(...params); return r === undefined ? null : r; },
        async all() { return { results: stmt.all(...params) }; },
      };
    },
    async run() { stmt.run(); return { success: true }; },
    async first() { const r = stmt.get(); return r === undefined ? null : r; },
    async all() { return { results: stmt.all() }; },
  });
  return { prepare(sql) { return wrap(sdb.prepare(sql)); }, _raw: sdb };
}

// ── Twitch/Discord network mock ─────────────────────────────────────────
const net = { live: false, gameName: 'Fallout 4', discordPosts: [] };
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const J = (obj, status = 200) => ({ ok: status < 300, status, async json() { return obj; }, async text() { return JSON.stringify(obj); } });
  if (u.includes('oauth2/token')) return J({ access_token: 'tok', expires_in: 3600 });
  if (u.includes('/helix/streams')) return J({ data: net.live ? [{ id: 'stream_test_1', game_name: net.gameName }] : [] });
  if (u.includes('/helix/channels')) return J({ data: [{ game_id: '1', game_name: net.gameName, title: 't' }] });
  if (u.includes('discord.com/api')) { net.discordPosts.push(JSON.parse(opts.body)); return J({ id: 'msg_1' }, 200); }
  throw new Error('unexpected fetch: ' + u);
};

// ── env ─────────────────────────────────────────────────────────────────
function makeEnv() {
  return {
    DB: makeD1(),
    LOADOUT_BOLTS: makeKV(),
    CLAY_TWITCH_CHANNEL_ID: '991099623',
    TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 'csec',
    SCRATCH_ADMIN_TOKEN: 'admintok',
    DISCORD_BOT_TOKEN: 'bottok', SCRATCH_ECHO_CHANNEL_ID: '999',
    // no TWITCH_EXT_SECRET -> receipts decode-only (verified:false), still ok
  };
}

// ── request helpers ─────────────────────────────────────────────────────
const HOST = 'https://w.dev';
function req(method, path, { body, token, query } = {}) {
  const url = HOST + path + (query ? '?' + query : '');
  const headers = { 'content-type': 'application/json' };
  if (token) headers['x-scratch-token'] = token;
  return new Request(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
}
async function call(env, method, path, opts = {}) {
  const r = await handleScratch(req(method, path, opts), env, path);
  return { status: r.status, body: await r.json() };
}
function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function receipt({ userId, sku = 'scratch_card', bits = 100, txnId }) {
  const payload = { topic: 'bits_transaction_send', data: { transactionId: txnId, userId, time: '', product: { sku, displayName: 'Scratch', cost: { amount: bits, type: 'bits' } } } };
  return 'eyJ4IjoxfQ' + '.' + b64url(payload) + '.' + 'sig';
}

// Mint+scratch a card to reveal; returns the reveal payload.
async function buyAndScratch(env, { userId, txnId, withReceipt = true }) {
  const body = withReceipt
    ? { userId, userName: 'Tester', transactionReceipt: receipt({ userId, txnId }) }
    : { userId, userName: 'Tester' };
  const mint = await call(env, 'POST', '/web/scratch/mint', { body });
  if (!mint.body.ok) return { mint };
  const id = mint.body.ticket.ticketId;
  const rev = await call(env, 'POST', '/web/scratch/scratch/' + id, { body: { userId, pct: 100 } });
  return { mint, rev, id };
}

// ── Tests ─────────────────────────────────────────────────────────────
async function main() {
  const env = makeEnv();
  // Seed pools + actions so hits resolve to a real outcome.
  await call(env, 'POST', '/web/admin/scratch/seed', { token: 'admintok' });

  console.log('1. OFFLINE: real-bits mint is blocked + refundable');
  net.live = false;
  {
    const { mint } = await buyAndScratch(env, { userId: 'u1', txnId: 't1' });
    eq(mint.body.ok, false, 'offline mint blocked');
    eq(mint.body.error, 'offline', 'reason offline');
    eq(mint.body.refundable, true, 'marked refundable');
  }

  console.log('2. OFFLINE: receiptless loopback/test mint still works');
  {
    const { mint, rev } = await buyAndScratch(env, { userId: 'u2', withReceipt: false });
    eq(mint.body.ok, true, 'loopback mint ok offline');
    ok(rev && rev.body.ok, 'loopback reveal ok');
  }

  console.log('3. current-game exposes live/canBuy gate');
  {
    net.live = false;
    let cg = await call(env, 'GET', '/web/scratch/current-game');
    eq(cg.body.canBuy, false, 'canBuy false offline');
    net.live = true;
    cg = await call(env, 'GET', '/web/scratch/current-game');
    eq(cg.body.live, true, 'live true');
    eq(cg.body.canBuy, true, 'canBuy true when live + not paused');
    eq(cg.body.gameSlug, 'fallout4', 'game slug resolved');
  }

  console.log('4. LIVE + forced hit: win reveals, tamper/challenge, Discord echo');
  net.live = true;
  await call(env, 'POST', '/web/scratch/status', { token: 'admintok', body: { hitRate: 1, maxHits: 10, cooldownSec: 0 } });
  net.discordPosts.length = 0;
  {
    const { mint, rev } = await buyAndScratch(env, { userId: 'u4', txnId: 't4' });
    eq(mint.body.ok, true, 'live mint ok');
    ok(rev.body.win === true, 'forced hit is a win');
    ok(['tamper', 'challenge'].includes(rev.body.outcome), 'outcome is tamper|challenge');
    eq(net.discordPosts.length, 1, 'one Discord echo posted on win');
    ok(/scratched a winner/.test(net.discordPosts[0]?.content || ''), 'echo content shaped');
  }

  console.log('5. HIT CAP: maxHits=1 exhausts the stream, further cards lose');
  {
    const env2 = makeEnv();
    await call(env2, 'POST', '/web/admin/scratch/seed', { token: 'admintok' });
    net.live = true;
    await call(env2, 'POST', '/web/scratch/status', { token: 'admintok', body: { hitRate: 1, maxHits: 1, cooldownSec: 0 } });
    const a = await buyAndScratch(env2, { userId: 'c1', txnId: 'ca' });
    ok(a.rev.body.win === true, 'first card wins (under cap)');
    const b = await buyAndScratch(env2, { userId: 'c2', txnId: 'cb' });
    ok(b.rev.body.win === false, 'second card forced to lose (cap hit)');
    const st = await call(env2, 'GET', '/web/scratch/status', { token: 'admintok' });
    eq(st.body.stream.remaining, 0, 'stream budget remaining 0');
  }

  console.log('6. COOLDOWN: a recent hit blocks the next even under cap');
  {
    const env3 = makeEnv();
    await call(env3, 'POST', '/web/admin/scratch/seed', { token: 'admintok' });
    net.live = true;
    await call(env3, 'POST', '/web/scratch/status', { token: 'admintok', body: { hitRate: 1, maxHits: 9, cooldownSec: 600 } });
    const a = await buyAndScratch(env3, { userId: 'd1', txnId: 'da' });
    ok(a.rev.body.win === true, 'first hit wins');
    const b = await buyAndScratch(env3, { userId: 'd2', txnId: 'db' });
    ok(b.rev.body.win === false, 'second within cooldown forced lose');
  }

  console.log('7. CONSOLATION: a loss grants 1-5 bolts + running total');
  {
    const env4 = makeEnv();
    await call(env4, 'POST', '/web/admin/scratch/seed', { token: 'admintok' });
    net.live = true;
    await call(env4, 'POST', '/web/scratch/status', { token: 'admintok', body: { hitRate: 0 } });
    const a = await buyAndScratch(env4, { userId: 'e1', txnId: 'ea' });
    eq(a.rev.body.win, false, 'forced loss');
    ok(a.rev.body.consolationBolts >= 1 && a.rev.body.consolationBolts <= 5, 'consolation 1-5 bolts');
    ok(a.rev.body.consolationTotal >= a.rev.body.consolationBolts, 'consolation total granted');
    const cg = await call(env4, 'GET', '/web/scratch/current-game', { query: 'userId=e1' });
    ok(cg.body.consolationTotal >= 1, 'current-game returns viewer tally');
  }

  console.log('8. PAUSE: paused channel blocks real-bits mint (refundable)');
  {
    net.live = true;
    await call(env, 'POST', '/web/scratch/status', { token: 'admintok', body: { paused: true } });
    const { mint } = await buyAndScratch(env, { userId: 'p1', txnId: 'pp' });
    eq(mint.body.ok, false, 'paused mint blocked');
    eq(mint.body.error, 'paused', 'reason paused');
    await call(env, 'POST', '/web/scratch/status', { token: 'admintok', body: { paused: false } });
    const cg = await call(env, 'GET', '/web/scratch/current-game');
    eq(cg.body.paused, false, 'unpause clears flag');
  }

  console.log('9. IDEMPOTENT: same txnId returns the same ticket');
  {
    net.live = true;
    await call(env, 'POST', '/web/scratch/status', { token: 'admintok', body: { hitRate: 0.08, maxHits: 10, cooldownSec: 0 } });
    const r1 = await call(env, 'POST', '/web/scratch/mint', { body: { userId: 'i1', userName: 'I', transactionReceipt: receipt({ userId: 'i1', txnId: 'dup' }) } });
    const r2 = await call(env, 'POST', '/web/scratch/mint', { body: { userId: 'i1', userName: 'I', transactionReceipt: receipt({ userId: 'i1', txnId: 'dup' }) } });
    eq(r1.body.ticket.ticketId, r2.body.ticket.ticketId, 'same ticket id reused');
    eq(r2.body.reused, true, 'second flagged reused');
  }

  console.log('10. /web/scratch/buy is an alias of /mint');
  {
    net.live = true;
    const r = await call(env, 'POST', '/web/scratch/buy', { body: { userId: 'b1', userName: 'B', transactionReceipt: receipt({ userId: 'b1', txnId: 'buyalias' }) } });
    eq(r.body.ok, true, 'buy alias mints');
  }

  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + `  pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
