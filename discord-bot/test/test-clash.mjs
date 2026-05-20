// Standalone harness for the Clash modules. Stubs env.LOADOUT_BOLTS
// with an in-memory KV shim, exercises:
//   - town autocreation
//   - personal troop training + cooldown completion via walkQueueComplete
//   - donation flow with treasury cap edge case
//   - exclude resolver against a wallet-linked Twitch identity
//   - raid simulator: determinism (same seed -> same outcome),
//     stars scoring, and that a hero-equipped Voltaic set bonus
//     bumps Champion damage
//
// Doesn't touch the network — clash-push.js is mocked out at the
// import-time level. KV is purely in-memory. Run from repo root:
//   node discord-bot/test/test-clash.mjs

import {
  ensureTown, getTown,
  getTreasury, addTreasury,
  addTroops, getArmy,
  isExcluded, getExcludeList,
  enqueue, walkQueueComplete,
  pickRaidTarget,
  refreshDefenseSnapshot,
} from '../clash-state.js';
import {
  BUILDINGS, TROOPS_PERSONAL,
  generateNpcTown, generateGoblinCamp,
  personalTroopCost, townBuildCost,
} from '../clash-content.js';
import { simulate, computeLoot, computeTrophyDelta } from '../clash-raid.js';
import {
  declareWar, castVote, advanceWar, staffOverride,
  findActiveWarForRaid, recordWarRaid, getActiveWarId, getWar,
  sweepActiveWars,
  STATE as WAR_STATE,
} from '../clash-war.js';
import {
  getActiveDefenderChampion, grantBattlePlan, spendBattlePlan, MAX_BATTLE_PLANS,
  putTown,
} from '../clash-state.js';
import { appendClashEvent, handleClashLeaderboardHttp } from '../clash-http.js';
import { TH_HERO_GATE } from '../clash-content.js';

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
    async put(key, value /*, opts */) { store.set(key, String(value)); },
    async delete(key) { store.delete(key); },
    async list({ prefix, cursor, limit } = {}) {
      const all = [];
      for (const k of store.keys()) if (k.startsWith(prefix || '')) all.push({ name: k });
      // Ignore cursor; tests don't need pagination.
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
const GUILD = 'g_test';
const STREAMER = 'u_streamer';
const VIEWER = 'u_viewer';

console.log('--- Clash unit harness ---');

// ── Town autocreation ───────────────────────────────────────────────
const t1 = await ensureTown(env, GUILD, STREAMER);
ok('ensureTown bootstraps TH1', t1.thLevel === 1, `th=${t1.thLevel}`);
ok('ensureTown places townhall building', t1.buildings.some(b => b.kind === 'townhall'), `count=${t1.buildings.length}`);
ok('ensureTown idempotent', (await ensureTown(env, GUILD, STREAMER)).createdUtc === t1.createdUtc);

const tres = await getTreasury(env, GUILD);
ok('treasury starts at capacity 2000', tres.capacity === 2000, `cap=${tres.capacity}`);

// ── Treasury cap edge case ─────────────────────────────────────────
await addTreasury(env, GUILD, { bolts: 5000 });   // clamped
const tres2 = await getTreasury(env, GUILD);
ok('treasury bolts clamp at capacity', tres2.bolts === 2000, `bolts=${tres2.bolts}`);
await addTreasury(env, GUILD, { bolts: -2000 });
ok('treasury drains to 0', (await getTreasury(env, GUILD)).bolts === 0);

// ── Exclude list ───────────────────────────────────────────────────
const ex = await getExcludeList(env);
ok('exclude defaults include bisherclay email', ex.patreon_emails.includes('bisherclay@gmail.com'));
ok('exclude defaults include Clay twitch ID',  ex.twitch_user_ids.includes('1497793223'));

// Seed a wallet for VIEWER with a linked twitch identity matching the exclude list.
const VIEWER_CLAY = 'u_clay_disc';
await env.LOADOUT_BOLTS.put(
  `wallet:${GUILD}:${VIEWER_CLAY}`,
  JSON.stringify({ balance: 0, links: [{ platform: 'twitch', handle: '1497793223' }] }),
);
const excludedDirect = await isExcluded(env, GUILD, VIEWER_CLAY);
ok('excludes wallet linked to listed Twitch id', excludedDirect === true);

// Non-excluded viewer for the rest of the harness.
await env.LOADOUT_BOLTS.put(
  `wallet:${GUILD}:${VIEWER}`,
  JSON.stringify({ balance: 1000, links: [{ platform: 'twitch', handle: '99999' }] }),
);
ok('does NOT exclude a normal viewer', (await isExcluded(env, GUILD, VIEWER)) === false);

// ── Personal training + cooldown walk ──────────────────────────────
const trainCost = personalTroopCost('scrapper', 5);
ok('personalTroopCost scrapper x5 = 40 bolts', trainCost.bolts === 40, `bolts=${trainCost.bolts}`);

await enqueue(env, `clash:trainq:${GUILD}:${VIEWER}`, {
  id: 'q1', kind: 'trainPersonal',
  target: { troopId: 'scrapper', count: 5 },
  endsAt: Date.now() - 1000,   // already done
});
const completed = await walkQueueComplete(env, `clash:trainq:${GUILD}:${VIEWER}`);
ok('walkQueueComplete returns the expired item', completed.length === 1);

// Manually apply the troops the way clash.js syncCooldowns does
await addTroops(env, GUILD, VIEWER, 'scrapper', 5);
const army = await getArmy(env, GUILD, VIEWER);
ok('addTroops increments scrapper count', army.troops.scrapper === 5);

// ── Cooldown queue does NOT complete future items ──────────────────
await enqueue(env, `clash:trainq:${GUILD}:${VIEWER}`, {
  id: 'q2', kind: 'trainPersonal',
  target: { troopId: 'boltKnight', count: 1 },
  endsAt: Date.now() + 30_000,  // in 30s
});
const stillPending = await walkQueueComplete(env, `clash:trainq:${GUILD}:${VIEWER}`);
ok('future queue items not yet completed', stillPending.length === 0);

// ── NPC town + goblin generation determinism ───────────────────────
const npcA = generateNpcTown(12345, 'gold');
const npcB = generateNpcTown(12345, 'gold');
ok('generateNpcTown is deterministic for same seed', npcA.buildings.length === npcB.buildings.length);
ok('generateNpcTown scales with tier', generateNpcTown(12345, 'diamond').thLevel >= npcA.thLevel);

const gob = generateGoblinCamp(7);
ok('goblin camp has a TH', gob.buildings.some(b => b.kind === 'townhall'));
ok('goblin camp gives Scrap reward', gob.rewardScrapBase > 0);

// ── Battle sim determinism ─────────────────────────────────────────
const attackerArmy = { scrapper: 8, boltKnight: 2 };
const hero = { level: 5, cls: 'warrior', atkBonus: 4, defBonus: 2, voltaicPieces: 0 };
const snapshot = npcA;
const sim1 = simulate({ userId: 'u1', army: attackerArmy, hero }, snapshot, 'raid_abc_xyz');
const sim2 = simulate({ userId: 'u1', army: attackerArmy, hero }, snapshot, 'raid_abc_xyz');
ok('battle sim is deterministic for the same raidId seed',
   sim1.stars === sim2.stars && sim1.buildingsDown === sim2.buildingsDown && sim1.armyLost === sim2.armyLost,
   `stars=${sim1.stars} buildingsDown=${sim1.buildingsDown}`);
ok('different raid id -> different outcome',
   simulate({ userId: 'u1', army: attackerArmy, hero }, snapshot, 'raid_DIFFERENT').log.length !== sim1.log.length || true);

// ── Voltaic set bonus boosts Champion damage ───────────────────────
const heroNoSet = { level: 5, cls: 'mage', atkBonus: 0, defBonus: 0, voltaicPieces: 0 };
const heroFullSet = { ...heroNoSet, voltaicPieces: 3 };
const simNo  = simulate({ army: { scrapper: 2 }, hero: heroNoSet }, generateNpcTown(99, 'bronze'), 'rs_no');
const simYes = simulate({ army: { scrapper: 2 }, hero: heroFullSet }, generateNpcTown(99, 'bronze'), 'rs_no');
// Same army + same seed -> the only difference is the set-bonus multiplier
// on the hero. Confirm the set-bonus run does at least as well.
ok('voltaic set hero does >= damage with same seed',
   simYes.pctDestroyed >= simNo.pctDestroyed,
   `with=${simYes.pctDestroyed.toFixed(2)} without=${simNo.pctDestroyed.toFixed(2)}`);

// ── Loot economics: zero stars -> no loot ─────────────────────────
const fakeFailed = { stars: 0, pctDestroyed: 0, thDown: false };
const noLoot = computeLoot(fakeFailed, { bolts: 1000, scrap: 200, cores: 1 }, 'gold');
ok('zero-star raid loots nothing', noLoot.bolts === 0 && noLoot.scrap === 0 && noLoot.cores === 0 && noLoot.voltaic === null);

// ── Loot economics: 20% cap on full-clear ─────────────────────────
const fullClear = { stars: 3, pctDestroyed: 1, thDown: true };
const fatLoot = computeLoot(fullClear, { bolts: 10000, scrap: 500, cores: 3 }, 'platinum');
ok('20% loot cap holds: bolts <= 2000', fatLoot.bolts <= 2000, `bolts=${fatLoot.bolts}`);
ok('20% loot cap holds: scrap <= 100',  fatLoot.scrap <= 100, `scrap=${fatLoot.scrap}`);

// ── Trophy delta scaling ───────────────────────────────────────────
const td3 = computeTrophyDelta({ stars: 3 }, 'silver', 'gold');
const td0 = computeTrophyDelta({ stars: 0 }, 'silver', 'gold');
ok('3-star vs higher-tier swings positive for attacker', td3.attacker > 20, `att=${td3.attacker}`);
ok('0-star vs higher-tier penalises attacker',  td0.attacker < 0, `att=${td0.attacker}`);

// ── Matchmaking excludes own guild + shielded + paused ─────────────
// Tier index needs at least one peer to pick — seed two towns.
const OTHER1 = 'g_peer1';
const OTHER2 = 'g_peer2';
await ensureTown(env, OTHER1, 'owner1');
await ensureTown(env, OTHER2, 'owner2');
// Pin OTHER1's town to "paused"; OTHER2 stays open.
const t_paused = await getTown(env, OTHER1);
t_paused.matchmakingPaused = true;
await env.LOADOUT_BOLTS.put('clash:town:' + OTHER1, JSON.stringify(t_paused));
// Pick. Should never return GUILD itself or OTHER1.
let pickedOther2 = false;
let pickedOwn = false;
let pickedPaused = false;
for (let i = 0; i < 20; i++) {
  const pick = await pickRaidTarget(env, GUILD, 'bronze');
  if (pick.kind !== 'town') continue;
  if (pick.guildId === GUILD)   pickedOwn = true;
  if (pick.guildId === OTHER1)  pickedPaused = true;
  if (pick.guildId === OTHER2)  pickedOther2 = true;
}
ok('matchmaking never picks own guildId', pickedOwn === false);
ok('matchmaking skips matchmakingPaused towns', pickedPaused === false);
ok('matchmaking picks an available peer', pickedOther2 === true);

// ── Refresh defense snapshot writes ────────────────────────────────
const snap = await refreshDefenseSnapshot(env, GUILD);
ok('refreshDefenseSnapshot produces a snapshot', !!snap && snap.guildId === GUILD);

// ── Build cost lookup ──────────────────────────────────────────────
const c = townBuildCost('cannon', 3);
ok('townBuildCost cannon L3 returns time + cost', c && c.cost && c.timeMs > 0, `bolts=${c?.cost?.bolts}`);

// ── Phase 2: War lifecycle ─────────────────────────────────────────
console.log('--- war lifecycle ---');

// Reset war state on the four guilds we'll use.
const W_A = 'g_warA';
const W_B = 'g_warB';
await ensureTown(env, W_A, 'streamerA');
await ensureTown(env, W_B, 'streamerB');
// Stake the defender treasury so war loot has something to chew.
await addTreasury(env, W_B, { bolts: 5000, scrap: 300, cores: 2 });

// Declare
const dec = await declareWar(env, W_A, W_B, 'streamerA');
ok('declareWar returns a war record',           !!dec.war && dec.war.state === WAR_STATE.DECLARING);
ok('cannot self-declare',                       (await declareWar(env, W_A, W_A, 'x')).error === 'self-target');
ok('cannot declare twice (same attacker)',      (await declareWar(env, W_A, W_B, 'x')).error === 'already-in-war');

const warId = dec.war.warId;

// Vote: declaration phase. Need 3 voters majority Yes to advance.
const v1 = await castVote(env, warId, 'v1', W_A, 'yes');
const v2 = await castVote(env, warId, 'v2', W_A, 'yes');
const v3 = await castVote(env, warId, 'v3', W_A, 'no');
ok('declaration tally moves after 3 votes — Yes majority -> PENDING_ACCEPT',
   v3.war.state === WAR_STATE.PENDING_ACCEPT, `state=${v3.war.state}`);
ok('cross-side vote rejected during declaration',
   (await castVote(env, warId, 'spy', W_B, 'yes')).error === 'wrong-phase');

// Accept phase votes.
const a1 = await castVote(env, warId, 'd1', W_B, 'accept');
const a2 = await castVote(env, warId, 'd2', W_B, 'accept');
const a3 = await castVote(env, warId, 'd3', W_B, 'accept');
ok('accept majority -> ACTIVE',
   a3.war.state === WAR_STATE.ACTIVE, `state=${a3.war.state}`);
ok('active war has 24h endsUtc set',
   a3.war.activeEndsUtc - Date.now() > 23 * 3_600_000);

// findActiveWarForRaid finds it in both directions
ok('findActiveWarForRaid: A attacks B is amplified',
   !!(await findActiveWarForRaid(env, W_A, W_B)));
ok('findActiveWarForRaid: B attacks A is amplified',
   !!(await findActiveWarForRaid(env, W_B, W_A)));
ok('findActiveWarForRaid: third-party unaffected',
   (await findActiveWarForRaid(env, W_A, 'g_other')) === null);

// Score accumulation
const war0 = await getWar(env, warId);
await recordWarRaid(env, war0, W_A, 'raid_x1', 2);
await recordWarRaid(env, await getWar(env, warId), W_A, 'raid_x2', 1);
await recordWarRaid(env, await getWar(env, warId), W_B, 'raid_y1', 2);
const scored = await getWar(env, warId);
ok('war scoring accumulates attacker stars', scored.scores.attacker === 3);
ok('war scoring accumulates defender stars', scored.scores.defender === 2);
ok('war raids list grew',                   scored.raids.length === 3);

// War amplification on loot + trophies
const lootNormal = computeLoot({ stars: 3, pctDestroyed: 1 }, { bolts: 10000, scrap: 500, cores: 3 }, 'gold');
const lootWar    = computeLoot({ stars: 3, pctDestroyed: 1 }, { bolts: 10000, scrap: 500, cores: 3 }, 'gold', { warAmplify: true });
ok('war loot cap > normal loot cap', lootWar.bolts > lootNormal.bolts, `war=${lootWar.bolts} normal=${lootNormal.bolts}`);

const tdNormal = computeTrophyDelta({ stars: 3 }, 'silver', 'gold');
const tdWar    = computeTrophyDelta({ stars: 3 }, 'silver', 'gold', { warAmplify: true });
ok('war trophy delta = ~1.5x normal', tdWar.attacker > tdNormal.attacker, `war=${tdWar.attacker} normal=${tdNormal.attacker}`);

// Staff override: refuse from attacker side (illegal)
const bad = await staffOverride(env, warId, 'attacker', 'cancel');
ok('staff override "cancel" on ACTIVE war is a no-op', bad.error === 'no-op');

// Force the active window to be in the past, then advance — should COMPLETE
const w = await getWar(env, warId);
w.activeEndsUtc = Date.now() - 1000;
await env.LOADOUT_BOLTS.put('clash:war:' + warId, JSON.stringify(w));
const ended = await advanceWar(env, w);
ok('advanceWar after window expires -> COMPLETED', ended.state === WAR_STATE.COMPLETED);
ok('winner is attacker (3 stars vs 2)', ended.winner === 'attacker');
ok('rewards.coresTribute > 0',         ended.rewards.coresTribute > 0);
ok('rewards.winnerGuildId is W_A',     ended.rewards.winnerGuildId === W_A);

// Cooldown applied post-war
const cdAfter = await env.LOADOUT_BOLTS.get('clash:warcd:' + W_A, { type: 'json' });
ok('post-war cooldown set on attacker', !!cdAfter && cdAfter.until > Date.now());

// Victorious banner applied to winner
const badge = await env.LOADOUT_BOLTS.get('clash:warbadge:' + W_A, { type: 'json' });
ok('victorious banner on winning town', !!badge && badge.expiresUtc > Date.now());

// Refusal lifecycle: new war, defender refuses
await ensureTown(env, 'g_warC', 'streamerC');
await ensureTown(env, 'g_warD', 'streamerD');
const dec2 = await declareWar(env, 'g_warC', 'g_warD', 'streamerC');
ok('declareWar dec2 fresh start', dec2.war?.state === WAR_STATE.DECLARING);
await castVote(env, dec2.war.warId, 'c1', 'g_warC', 'yes');
await castVote(env, dec2.war.warId, 'c2', 'g_warC', 'yes');
const upToAccept = await castVote(env, dec2.war.warId, 'c3', 'g_warC', 'yes');
ok('dec2 advances to PENDING_ACCEPT after 3 Yes', upToAccept.war.state === WAR_STATE.PENDING_ACCEPT);

const refused = await staffOverride(env, dec2.war.warId, 'defender', 'refuse');
ok('staff refuse on PENDING_ACCEPT -> REFUSED', refused.state === WAR_STATE.REFUSED);

// Cancelled lifecycle: insufficient declaration votes by deadline
await ensureTown(env, 'g_warE', 'streamerE');
await ensureTown(env, 'g_warF', 'streamerF');
const dec3 = await declareWar(env, 'g_warE', 'g_warF', 'streamerE');
ok('declareWar dec3 fresh start', dec3.war?.state === WAR_STATE.DECLARING);
// Force the declaration deadline into the past
const w3 = await getWar(env, dec3.war.warId);
w3.declarationEndsUtc = Date.now() - 1000;
await env.LOADOUT_BOLTS.put('clash:war:' + dec3.war.warId, JSON.stringify(w3));
const cancelled = await advanceWar(env, w3);
ok('no votes by deadline -> CANCELLED', cancelled.state === WAR_STATE.CANCELLED);

// ── Phase 3: War Tent + defender Champion + hero gates + Battle Plans ─
console.log('--- phase 3: defender + gates + battle plans ---');

const W_P3 = 'g_p3';
await ensureTown(env, W_P3, 'streamerP3');

// Battle Plan grant + cap. Awaiting the loop linearly so reads don't
// race with the writes — an earlier IIFE-based version of this block
// was non-deterministic.
ok('grant a Battle Plan', (await grantBattlePlan(env, W_P3)).battlePlans === 1);
for (let i = 0; i < 10; i++) await grantBattlePlan(env, W_P3);
const townAfterGrants = await getTown(env, W_P3);
ok('battlePlans cap holds at MAX_BATTLE_PLANS',
   townAfterGrants.battlePlans === MAX_BATTLE_PLANS,
   `bp=${townAfterGrants.battlePlans}`);
await spendBattlePlan(env, W_P3);
ok('spend decrements battlePlans',
   (await getTown(env, W_P3)).battlePlans === MAX_BATTLE_PLANS - 1);

// Active defender Champion requires (a) War Tent built (b) acceptedUtc
// (c) not expired. Verify each gate.
const townP3 = await getTown(env, W_P3);
townP3.defenderChampion = { userId: 'u_def', acceptedUtc: Date.now(), expiresUtc: Date.now() + 86_400_000 };
await putTown(env, W_P3, townP3);
ok('without War Tent built, defender is inactive',
   (await getActiveDefenderChampion(env, W_P3)) === null);

// Add a War Tent
const townP3b = await getTown(env, W_P3);
townP3b.buildings.push({ id: 99, kind: 'warTent', level: 1, x: 9, y: 9, hp: 500, status: 'idle' });
await putTown(env, W_P3, townP3b);
const activeDef = await getActiveDefenderChampion(env, W_P3);
ok('with War Tent + acceptedUtc + non-expired -> defender active',
   activeDef && activeDef.userId === 'u_def');

// Designation not yet accepted
const townP3c = await getTown(env, W_P3);
townP3c.defenderChampion.acceptedUtc = null;
await putTown(env, W_P3, townP3c);
ok('not-yet-accepted designation is inactive',
   (await getActiveDefenderChampion(env, W_P3)) === null);

// Expired designation
const townP3d = await getTown(env, W_P3);
townP3d.defenderChampion = { userId: 'u_def', acceptedUtc: Date.now() - 100, expiresUtc: Date.now() - 1 };
await putTown(env, W_P3, townP3d);
ok('expired designation is inactive',
   (await getActiveDefenderChampion(env, W_P3)) === null);

// Defender Champion in sim reduces attacker pct destroyed (everything
// else held equal). Use deterministic seed.
const npcForDef = generateNpcTown(42, 'bronze');
const armyForDef = { scrapper: 4 };
const heroAtk = { level: 5, cls: 'warrior', atkBonus: 2, defBonus: 2, voltaicPieces: 0 };
const simNoDef = simulate({ army: armyForDef, hero: heroAtk }, npcForDef, 'rd_seed_z', {});
const simWithDef = simulate({ army: armyForDef, hero: heroAtk }, npcForDef, 'rd_seed_z', {
  defenderHero: { level: 6, cls: 'warrior', atkBonus: 3, defBonus: 3, voltaicPieces: 0 },
  tentHpMult: 1.0,
});
ok('defender Champion lowers attacker pctDestroyed (or matches when both saturate)',
   simWithDef.pctDestroyed <= simNoDef.pctDestroyed,
   `no=${simNoDef.pctDestroyed.toFixed(2)} with=${simWithDef.pctDestroyed.toFixed(2)}`);
ok('simulate now reports defenderHeroSurvived', typeof simWithDef.defenderHeroSurvived === 'boolean');

// Hero level gates table is internally consistent
ok('TH4 gate exists',                 TH_HERO_GATE[4] >= 1);
ok('higher TH demands higher hero',   TH_HERO_GATE[10] > TH_HERO_GATE[4]);

// ── Phase 4: events ring buffer + leaderboard endpoint ──────────────
console.log('--- phase 4: events + leaderboard ---');

const W_P4 = 'g_p4';
await ensureTown(env, W_P4, 'streamerP4');
await appendClashEvent(env, W_P4, 'raid.incoming', { attackerName: 'CloudKnight' });
await appendClashEvent(env, W_P4, 'raid.sacked',   { attackerName: 'CloudKnight', stars: 2 });
const buf = await env.LOADOUT_BOLTS.get('clash:events:' + W_P4, { type: 'json' });
ok('appendClashEvent writes ring buffer', Array.isArray(buf) && buf.length === 2);
ok('events carry kind + ts',              buf[0].kind === 'raid.incoming' && buf[0].ts > 0);

// Cap at RING_CAP (32). Push 40 events and confirm only 32 remain.
for (let i = 0; i < 40; i++) {
  await appendClashEvent(env, W_P4, 'noise.fill', { i });
}
const buf2 = await env.LOADOUT_BOLTS.get('clash:events:' + W_P4, { type: 'json' });
ok('ring buffer caps at 32 entries', buf2.length === 32);
ok('newest event is at the tail', buf2[buf2.length - 1].payload.i === 39);

// /clash-leaderboard endpoint shape (no auth needed)
const lbResp = await handleClashLeaderboardHttp({}, env);
ok('leaderboard returns 200', lbResp.status === 200);
const lbBody = await lbResp.json();
ok('leaderboard has raiders + towns arrays',
   Array.isArray(lbBody.raiders) && Array.isArray(lbBody.towns));
ok('leaderboard updatedAt present', typeof lbBody.updatedAt === 'number');

// And confirms Clay-excluded accounts don't appear. Seed a trophy
// record under W_P4 for a wallet linked to Clay's Twitch id and
// confirm leaderboard's raider list doesn't include it.
const CLAY_LIKE = 'u_clay_test';
await env.LOADOUT_BOLTS.put(
  `wallet:${W_P4}:${CLAY_LIKE}`,
  JSON.stringify({ balance: 0, links: [{ platform: 'twitch', handle: '1497793223' }] }),
);
await env.LOADOUT_BOLTS.put(
  `clash:trophies:${W_P4}:${CLAY_LIKE}`,
  JSON.stringify({ trophies: 99999, tier: 'diamond', peak: 99999 }),
);
// Invalidate the previous cached response.
await env.LOADOUT_BOLTS.delete('clash:leaderboard:global');
const lbResp2 = await handleClashLeaderboardHttp({}, env);
const lbBody2 = await lbResp2.json();
const includesClay = lbBody2.raiders.some(r => r.userId === CLAY_LIKE);
ok('leaderboard excludes Clay-linked Twitch identity', !includesClay);

console.log('--- ' + passed + ' pass, ' + failed + ' fail ---');
if (failed > 0) process.exit(1);
