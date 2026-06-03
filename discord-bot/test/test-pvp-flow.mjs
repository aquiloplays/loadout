// Integration test for pvp.js, exercises the whole module (router → HMAC →
// D1 → wallet escrow → resolve → spectator picks/bets → settlement → champion)
// against a REAL SQL engine (node:sqlite) and the real wallet KV logic, with
// properly HMAC-signed requests. Only the network edges (Discord DM, activity
// DO) are absent and degrade to no-ops, exactly as in production when a
// binding is missing.
//
// Run with:   node test/test-pvp-flow.mjs

import { DatabaseSync } from 'node:sqlite';
import { webcrypto as nodeCrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { handlePvpRoute } from '../pvp.js';

if (!globalThis.crypto) globalThis.crypto = nodeCrypto;

// pvp.js's ensureSchema uses a module-scoped isolate flag, correct in prod
// (one DB per isolate) but it means our per-block fresh in-memory DBs would be
// skipped after the first. So we exec the real migration on every fresh DB.
const MIGRATION = readFileSync(fileURLToPath(new URL('../pvp-migration.sql', import.meta.url)), 'utf8');

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; } else { fail++; console.log('  ❌', m); } }
function eq(a, b, m) { if (a === b) { pass++; } else { fail++; console.log('  ❌', m, '(want:', b, 'got:', a, ')'); } }

const SECRET = 'test-secret-key';
const G = '1504103035951906883';

// ── KV mock (matches test-bolt-rain pattern; supports {type:'json'}) ────────
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

// ── D1 shim over node:sqlite ────────────────────────────────────────────────
function makeD1() {
  const sdb = new DatabaseSync(':memory:');
  sdb.exec(MIGRATION);
  return {
    prepare(sql) {
      // node:sqlite uses ?NNN / ? positional params, same as D1.
      const stmt = sdb.prepare(sql);
      return {
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
      };
    },
    async batch(prepared) { for (const p of prepared) await p.run(); return []; },
    _raw: sdb,
  };
}

// ── env ──────────────────────────────────────────────────────────────────────
function makeEnv() {
  const kv = makeKV();
  return {
    AQUILO_SITE_WEB_SECRET: SECRET,
    AQUILO_VAULT_GUILD_ID: G,
    LOADOUT_BOLTS: kv,
    DB: makeD1(),
  };
}

// Seed a wallet directly into KV.
function seedWallet(env, userId, balance) {
  env.LOADOUT_BOLTS._store.set(`wallet:${G}:${userId}`, JSON.stringify({ balance, lifetimeEarned: balance, lifetimeSpent: 0, links: [] }));
}
async function balanceOf(env, userId) {
  const raw = env.LOADOUT_BOLTS._store.get(`wallet:${G}:${userId}`);
  return raw ? (JSON.parse(raw).balance || 0) : 0;
}

// ── HMAC signing (mirror postToBot: hex(HMAC-SHA256(secret, ts+"\n"+body))) ──
async function sign(ts, body) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ts + '\n' + body));
  return [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
}
// worker.js passes url.pathname (no query) as the routing `path`; mirror that.
async function POST(env, path, bodyObj) {
  const body = JSON.stringify(bodyObj || {});
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = await sign(ts, body);
  const req = new Request('https://w' + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-aquilo-web-ts': ts, 'x-aquilo-web-sig': sig }, body });
  const res = await handlePvpRoute(req, env, new URL(req.url).pathname);
  return { status: res.status, data: await res.json() };
}
async function GET(env, path) {
  const req = new Request('https://w' + path, { method: 'GET' });
  const res = await handlePvpRoute(req, env, new URL(req.url).pathname);
  return { status: res.status, data: await res.json() };
}

// ════════════════════════════════════════════════════════════════════════════
console.log('- direct challenge → accept → settle (wager escrow + payout)');
{
  const env = makeEnv();
  const CH = '111111111111111111', OPP = '222222222222222222';
  const P_CORRECT = '333333333333333333', B_A = '444444444444444444', B_B = '555555555555555555';
  seedWallet(env, CH, 1000); seedWallet(env, OPP, 1000);
  seedWallet(env, P_CORRECT, 0); seedWallet(env, B_A, 500); seedWallet(env, B_B, 500);

  // 1) challenge
  const ch = await POST(env, '/web/pvp/challenge', { discordId: CH, guildId: G, target: OPP, wager: 100, userName: 'Challenger' });
  eq(ch.status, 200, 'challenge 200');
  assert(ch.data.ok && ch.data.battleId, 'challenge returns battleId');
  eq(await balanceOf(env, CH), 900, 'challenger wager escrowed (1000→900)');
  const bid = ch.data.battleId;

  // bad accept (challenger self-accept)
  const selfAcc = await POST(env, '/web/pvp/accept/' + bid, { discordId: CH, guildId: G });
  eq(selfAcc.data.error, 'self-accept', 'challenger cannot accept own challenge');

  // wrong user accept
  const wrongAcc = await POST(env, '/web/pvp/accept/' + bid, { discordId: '999999999999999999', guildId: G });
  eq(wrongAcc.status, 403, 'non-opponent cannot accept');

  // 2) accept
  const acc = await POST(env, '/web/pvp/accept/' + bid, { discordId: OPP, guildId: G });
  eq(acc.status, 200, 'accept 200');
  eq(acc.data.status, 'active', 'battle active after accept');
  eq(await balanceOf(env, OPP), 900, 'opponent wager escrowed (1000→900)');

  // 3) during window: GET battle must NOT reveal winner
  const peek = await GET(env, '/web/pvp/battle/' + bid);
  eq(peek.data.battle.status, 'prefight', 'status is prefight during window');
  assert(peek.data.battle.winnerId === undefined, 'winnerId withheld during window');
  assert(!peek.data.battle.turns, 'turns withheld during window');
  assert(peek.data.battle.fighters && peek.data.battle.fighters.a, 'fighters shown during window');

  // 4) spectator picks + bets (picker picks side a, bettors split)
  const pk = await POST(env, '/web/pvp/spectator-pick/' + bid + '/a', { discordId: P_CORRECT, guildId: G, userName: 'Picker' });
  eq(pk.data.ok, true, 'spectator pick accepted');
  const fighterPick = await POST(env, '/web/pvp/spectator-pick/' + bid + '/a', { discordId: CH, guildId: G });
  eq(fighterPick.status, 403, 'fighter cannot pick');
  const betA = await POST(env, '/web/pvp/bet/' + bid + '/a/100', { discordId: B_A, guildId: G, userName: 'BetA' });
  eq(betA.data.ok, true, 'bet on a accepted'); eq(await balanceOf(env, B_A), 400, 'bettor A debited');
  const betB = await POST(env, '/web/pvp/bet/' + bid + '/b/100', { discordId: B_B, guildId: G, userName: 'BetB' });
  eq(betB.data.ok, true, 'bet on b accepted'); eq(await balanceOf(env, B_B), 400, 'bettor B debited');
  const dblBet = await POST(env, '/web/pvp/bet/' + bid + '/a/50', { discordId: B_A, guildId: G });
  eq(dblBet.data.error, 'already-bet', 'one bet per spectator');

  // 5) force the window closed, then settle via GET
  env.DB._raw.prepare(`UPDATE pvp_battle SET started_at = ? WHERE id = ?`).run(Date.now() - 21000, bid);
  const done = await GET(env, '/web/pvp/battle/' + bid);
  eq(done.data.battle.status, 'resolved', 'battle resolved after window');
  assert(Array.isArray(done.data.battle.turns) && done.data.battle.turns.length > 0, 'turns revealed after settle');
  const winnerId = done.data.battle.winnerId;
  const winSide = done.data.battle.winnerSide;
  assert(winnerId === CH || winnerId === OPP, 'winner is one of the fighters');

  // 6) wager pot (200) paid to winner; loser stays at 900
  const loserId = winnerId === CH ? OPP : CH;
  eq(await balanceOf(env, winnerId), 1100, 'winner paid the 200 pot (900→1100)');
  eq(await balanceOf(env, loserId), 900, 'loser stays escrowed-out at 900');

  // 7) spectator pick: correct (a) → +10, else 0
  const expectPicker = winSide === 'a' ? 10 : 0;
  eq(await balanceOf(env, P_CORRECT), expectPicker, 'correct picker rewarded iff side a won');

  // 8) parimutuel bets: pot 200, single backer on each side → winner gets full pot
  const expectBetA = winSide === 'a' ? 200 : 0;   // started 500, -100 stake, +payout
  const expectBetB = winSide === 'b' ? 200 : 0;
  eq(await balanceOf(env, B_A), 400 + expectBetA, 'bettor A parimutuel payout');
  eq(await balanceOf(env, B_B), 400 + expectBetB, 'bettor B parimutuel payout');

  // 9) settle is idempotent, second GET doesn't double-pay
  await GET(env, '/web/pvp/battle/' + bid);
  eq(await balanceOf(env, winnerId), 1100, 'no double payout on re-read');

  // 10) champion set to winner; history + record reflect the result
  const q = await GET(env, '/web/pvp/queue?guild=' + G);
  eq(q.data.champion.userId, winnerId, 'winner is champion');
  eq(q.data.champion.streak, 1, 'champion streak 1');
  const hist = await GET(env, '/web/pvp/history?userId=' + winnerId);
  eq(hist.data.history.length, 1, 'winner has 1 history row');
  eq(hist.data.history[0].result, 'won', 'history marks a win');
  const snap = await GET(env, '/web/pvp/snapshot?userId=' + winnerId + '&guildId=' + G);
  eq(snap.data.record.won, 1, 'winner record won=1');
}

console.log('- decline refunds the challenger');
{
  const env = makeEnv();
  const CH = '111111111111111111', OPP = '222222222222222222';
  seedWallet(env, CH, 500); seedWallet(env, OPP, 500);
  const ch = await POST(env, '/web/pvp/challenge', { discordId: CH, guildId: G, target: OPP, wager: 100 });
  eq(await balanceOf(env, CH), 400, 'wager escrowed on challenge');
  const dec = await POST(env, '/web/pvp/decline/' + ch.data.battleId, { discordId: OPP, guildId: G });
  eq(dec.data.status, 'declined', 'declined');
  eq(await balanceOf(env, CH), 500, 'challenger refunded on decline');
}

console.log('- insufficient bolts rejects the challenge');
{
  const env = makeEnv();
  const CH = '111111111111111111';
  seedWallet(env, CH, 30);
  const ch = await POST(env, '/web/pvp/challenge', { discordId: CH, guildId: G, target: '222222222222222222', wager: 100 });
  eq(ch.data.error, 'insufficient', 'rejects when wager exceeds balance');
  eq(await balanceOf(env, CH), 30, 'balance untouched on rejected challenge');
}

console.log('- queue challenge auto-fights the sitting champion');
{
  const env = makeEnv();
  const CHAMP = '222222222222222222', NEW = '111111111111111111';
  seedWallet(env, CHAMP, 100); seedWallet(env, NEW, 100);
  // Install a champion directly.
  env.LOADOUT_BOLTS._store.set(`pvp:champion:${G}`, JSON.stringify({ userId: CHAMP, name: 'Champ', streak: 2, sinceUtc: Date.now() }));
  const ch = await POST(env, '/web/pvp/challenge', { discordId: NEW, guildId: G, target: 'any', wager: 0 });
  eq(ch.status, 200, 'queue challenge ok');
  eq(ch.data.status, 'active', 'champion auto-accepts → active immediately');
  eq(ch.data.mode, undefined, 'mode not echoed on start path');
  // settle and check the throne resolved one way
  env.DB._raw.prepare(`UPDATE pvp_battle SET started_at = ? WHERE id = ?`).run(Date.now() - 21000, ch.data.battleId);
  const done = await GET(env, '/web/pvp/battle/' + ch.data.battleId);
  eq(done.data.battle.status, 'resolved', 'champion fight resolves');
  const champ = (await GET(env, '/web/pvp/queue?guild=' + G)).data.champion;
  assert(champ.userId === CHAMP || champ.userId === NEW, 'a champion still holds the throne');
}

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAIL'}, ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
