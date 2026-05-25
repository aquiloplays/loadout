// Idempotency harness for the bet-cron settle path.
//
// Motivated by audit finding [BUG-MED] "parlay settlement double-credit
// on cron retry": the old code earned BEFORE writing parlay.status, so
// a thrown earn() (or anything below it) left the parlay in 'open' state
// and the next cron tick replayed the payout.
//
// Scenarios:
//   1) Parlay win + injected one-shot earn failure → status='won' is
//      persisted to KV BEFORE the earn fires, so the L279 guard skips
//      the next tick. Player is shortchanged (operator-recoverable)
//      but the economy is not inflated.
//   2) Single-bet happy path → settled exactly once, even though the
//      cron is run twice. Verifies the "clear-then-settle" reordering.
//
// We bypass the place-bet RPC and seed KV directly so the test doesn't
// need to wrangle the spread/total/moneyline placement path, the
// MAX_STAKE_PCT cap, or the games-cache refresh against ESPN.

import { betCronTick } from '../bet.js';
import { earn, getWallet } from '../wallet.js';

// Stub global fetch so refreshGamesCache hits its catch path on every
// inner fetchLeague — refresh then writes [] for games. We block that
// write (see kv.blockPutTo below) to force the betCronTick catch
// branch to fall back to readGamesCache, which returns the games we
// seeded directly into KV.
globalThis.fetch = async () => ({ ok: false, status: 503, async json() { return {}; } });

const GAMES_CACHE_KEY    = 'sports:games:cache';
const PARLAY_KEY         = (id) => 'bets:parlay:' + id;
const PARLAY_ACTIVE_KEY  = 'bets:parlay:active';
const OPEN_BETS_KEY      = (gid) => 'bets:open:' + gid;

function makeKvShim() {
  const store = new Map();
  const oneShotBlocks = [];      // [{ predicate, error, fired:false }]
  const alwaysBlocks  = [];      // [{ predicate, error }]
  const kv = {
    async get(key, opts) {
      const v = store.get(key);
      if (v === undefined) return null;
      if (opts && opts.type === 'json') {
        try { return JSON.parse(v); } catch { return null; }
      }
      return v;
    },
    async put(key, value) {
      for (const b of alwaysBlocks) {
        if (b.predicate(key, value)) throw b.error;
      }
      for (const b of oneShotBlocks) {
        if (!b.fired && b.predicate(key, value)) { b.fired = true; throw b.error; }
      }
      store.set(key, String(value));
    },
    async delete(key) { store.delete(key); },
    async list({ prefix } = {}) {
      const keys = [];
      for (const k of store.keys()) if (k.startsWith(prefix || '')) keys.push({ name: k });
      return { keys, list_complete: true };
    },
    // Test helpers — these bypass the throw guards.
    _seedRaw(key, obj) { store.set(key, JSON.stringify(obj)); },
    _blockOnce(predicate, error) { oneShotBlocks.push({ predicate, error, fired: false }); },
    _blockAlways(predicate, error) { alwaysBlocks.push({ predicate, error }); },
    _dump() { return Object.fromEntries(store); },
  };
  return kv;
}

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + label + (detail ? ' (' + detail + ')' : '')); }
  else      { failed++; console.log('  FAIL  ' + label + (detail ? ' -- ' + detail : '')); }
}

const GUILD = '111111111111111111';
const PUNTER = '222222222222222222';

console.log('--- bet/parlay settle idempotency ---');

// ── Scenario 1: parlay win, injected wallet PUT failure on earn. ──
{
  const kv = makeKvShim();
  const env = { LOADOUT_BOLTS: kv };

  // Seed punter's wallet so we can assert against the balance later.
  // (Stake-debit on placement is simulated by setting balance = 1000 - 100 = 900.)
  await earn(env, GUILD, PUNTER, 900, 'seed-after-stake-debit');

  // Two completed games, both with the home team winning.
  const games = [
    { id: 'g1', label: 'NFL', state: 'post', completed: true,
      home: { abbr: 'AAA', score: 24, odds: -110 }, away: { abbr: 'BBB', score: 17, odds: -110 } },
    { id: 'g2', label: 'NFL', state: 'post', completed: true,
      home: { abbr: 'CCC', score: 14, odds: -110 }, away: { abbr: 'DDD', score: 31, odds: -110 } },
  ];
  kv._seedRaw(GAMES_CACHE_KEY, { games, asOf: Date.now() });

  // Seed a 2-leg moneyline parlay, both legs pre-set to map to a 'win'
  // outcome of settleSoloBet. Home for g1 (home won), away for g2
  // (away won).
  const betId = 'p_test_1';
  const parlay = {
    betId,
    userId: PUNTER,
    guildId: GUILD,
    stake: 100,
    legs: [
      { gameId: 'g1', sport: 'NFL', kind: 'moneyline', side: 'home', lockedOdds: -110 },
      { gameId: 'g2', sport: 'NFL', kind: 'moneyline', side: 'away', lockedOdds: -110 },
    ],
    status: 'open',
    placedAt: Date.now(),
  };
  kv._seedRaw(PARLAY_KEY(betId), parlay);
  kv._seedRaw(PARLAY_ACTIVE_KEY, [betId]);

  // Force refreshGamesCache to throw so betCronTick falls back to
  // readGamesCache (which returns the games we seeded above).
  kv._blockAlways((k) => k === GAMES_CACHE_KEY, new Error('test: refresh blocked'));

  // Inject ONE-SHOT failure on the punter's wallet PUT — fires on the
  // earn() inside parlay settlement, then subsequent puts succeed.
  // If the old code path were still in place, tick2 would re-fire
  // earn() and (with the wallet now writable) double-credit.
  kv._blockOnce((k) => k === `wallet:${GUILD}:${PUNTER}`, new Error('synthetic KV failure on payout'));

  // Tick 1 — parlay decides as 'won', writes status='won' (the fix),
  // then earn() throws and is caught.
  const tick1 = await betCronTick(env);
  ok('tick1 ran without throwing',
     tick1 && typeof tick1.parlaysSettled === 'number',
     `tick1=${JSON.stringify(tick1)}`);

  const after1 = await kv.get(PARLAY_KEY(betId), { type: 'json' });
  ok('parlay marked won in KV after tick1 (status-first fix)',
     after1 && after1.status === 'won',
     `parlay.status=${after1?.status} payout=${after1?.payout}`);

  const wallet1 = await getWallet(env, GUILD, PUNTER);
  ok('payout did NOT land on tick1 (earn threw, was caught)',
     wallet1.balance === 900, `bal=${wallet1.balance}`);

  // Tick 2 — the L279 guard sees status !== 'open' and skips. Even
  // though the wallet PUT is now writable, NO second earn() fires.
  const tick2 = await betCronTick(env);
  ok('tick2 ran without throwing', tick2 && typeof tick2.parlaysSettled === 'number',
     `tick2=${JSON.stringify(tick2)}`);

  const wallet2 = await getWallet(env, GUILD, PUNTER);
  ok('NO double-credit on cron retry (the whole point of the fix)',
     wallet2.balance === 900, `bal=${wallet2.balance}`);

  // The L279 guard should also have removed the open-id index entry.
  const openIds = (await kv.get(PARLAY_ACTIVE_KEY, { type: 'json' })) || [];
  ok('open-parlay-id removed on tick2 (self-healing index)',
     !openIds.includes(betId), `openIds=${JSON.stringify(openIds)}`);
}

// ── Scenario 2: single bet, two cron ticks. Verify no double-credit. ──
{
  const kv = makeKvShim();
  const env = { LOADOUT_BOLTS: kv };

  // Seed wallet = 900 (1000 starting - 100 stake debited at place time).
  await earn(env, GUILD, PUNTER, 900, 'seed-after-stake-debit');

  const games = [{
    id: 'g3', label: 'NFL', state: 'post', completed: true,
    home: { abbr: 'AAA', score: 24, odds: -110 },
    away: { abbr: 'BBB', score: 17, odds: -110 },
  }];
  kv._seedRaw(GAMES_CACHE_KEY, { games, asOf: Date.now() });

  const bet = {
    betId: 'b_test_1',
    gameId: 'g3', sport: 'NFL', kind: 'moneyline',
    side: 'home',  // home won 24-17 → win
    stake: 100,
    lockedOdds: -110,
    lockedLine: null,
    placedAt: Date.now(),
    guildId: GUILD, userId: PUNTER,
  };
  kv._seedRaw(OPEN_BETS_KEY('g3'), [bet]);

  kv._blockAlways((k) => k === GAMES_CACHE_KEY, new Error('test: refresh blocked'));

  // Tick 1 — settle, pay out.
  const tick1 = await betCronTick(env);
  ok('single-bet tick1 reports settled=1',
     tick1.settled === 1, `tick1=${JSON.stringify(tick1)}`);

  const w1 = await getWallet(env, GUILD, PUNTER);
  // -110 odds, stake 100, with the 2.5% HOUSE_EDGE in computeWinPayout:
  // floor(100 * (1 + 100/110) * 0.975) = floor(186.13) = 186 → 900 + 186 = 1086.
  ok('single bet payout landed', w1.balance === 1086, `bal=${w1.balance}`);

  // Tick 2 — the clear-then-settle fix means open list is now empty,
  // so this must be a no-op (no double-credit).
  const tick2 = await betCronTick(env);
  ok('single-bet tick2 is a no-op',
     tick2.settled === 0, `tick2=${JSON.stringify(tick2)}`);

  const w2 = await getWallet(env, GUILD, PUNTER);
  ok('no double-credit on cron replay', w2.balance === 1086, `bal=${w2.balance}`);
}

console.log('--- ' + passed + ' pass, ' + failed + ' fail ---');
if (failed > 0) process.exit(1);
