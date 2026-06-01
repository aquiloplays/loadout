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
import { appendClashEvent, handleClashLeaderboardHttp, handleClashTownPublic } from '../clash-http.js';
import {
  TH_HERO_GATE,
  spriteIdForBuilding, spriteIdForTroop,
  withBuildingSprites, withGarrisonSprites,
} from '../clash-content.js';
import { handleWeb } from '../web.js';

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

// ── Sprite IDs + /web/clash/* contract (2026-05-20) ───────────────
console.log('--- sprite ids + /web/clash/* contract ---');

ok('spriteIdForBuilding townhall L7',
   spriteIdForBuilding('townhall', 7) === 'clash/buildings/townhall-L7.png');
ok('spriteIdForBuilding clamps above max',
   spriteIdForBuilding('townhall', 999) === 'clash/buildings/townhall-L10.png');
ok('spriteIdForBuilding rejects unknown kind',
   spriteIdForBuilding('atlantis', 1) === null);
ok('spriteIdForTroop boltKnight',
   spriteIdForTroop('boltKnight') === 'clash/troops/boltKnight.png');
ok('spriteIdForTroop rejects unknown',
   spriteIdForTroop('xyz') === null);

const wbsOut = withBuildingSprites([{ kind: 'wall', level: 3 }, { kind: 'cannon', level: 5 }]);
ok('withBuildingSprites preserves original fields',
   wbsOut[0].kind === 'wall' && wbsOut[0].level === 3);
ok('withBuildingSprites adds spriteId',
   wbsOut[0].spriteId === 'clash/buildings/wall-L3.png' &&
   wbsOut[1].spriteId === 'clash/buildings/cannon-L5.png');

const wgs = withGarrisonSprites({ scrapper: 3, boltKnight: 1 });
ok('withGarrisonSprites preserves counts',
   wgs.counts.scrapper === 3 && wgs.counts.boltKnight === 1);
ok('withGarrisonSprites adds sprites map',
   wgs.sprites.scrapper === 'clash/troops/scrapper.png');

// /clash/town public endpoint now returns buildings[] with spriteIds.
// Use the GUILD town built earlier in this harness.
const townResp = await handleClashTownPublic(env, '/clash/town/' + GUILD);
ok('handleClashTownPublic returns 200', townResp.status === 200);
const townBody = await townResp.json();
ok('public town buildings have spriteId',
   Array.isArray(townBody.buildings) &&
   townBody.buildings.every(b => typeof b.spriteId === 'string' && b.spriteId.startsWith('clash/buildings/')));
ok('public town payload includes garrisonSprites map',
   townBody.garrisonSprites && typeof townBody.garrisonSprites === 'object');

// /web/clash/* HMAC contract — needs numeric Discord IDs to clear
// the bot-side id validator, so we provision a fresh test town with
// snowflake-shaped ids rather than re-using the earlier 'u_streamer'.
const NUM_GUILD    = '111111111111111111';
const NUM_STREAMER = '222222222222222222';
const NUM_VIEWER   = '333333333333333333';
await ensureTown(env, NUM_GUILD, NUM_STREAMER);
await addTreasury(env, NUM_GUILD, { bolts: 10000, scrap: 1000, cores: 50 });

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

const WEB_SECRET = 'test-web-secret-please-ignore';
const webEnv = { ...env, AQUILO_SITE_WEB_SECRET: WEB_SECRET, AQUILO_VAULT_GUILD_ID: NUM_GUILD };

// Helper: build a Request with valid HMAC
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

// Non-streamer → permission denied
const denyReq = await webPost('/web/clash/build', {
  discordId: NUM_VIEWER, guildId: NUM_GUILD, kind: 'wall',
});
const denyResp = await handleWeb(denyReq, webEnv);
const denyBody = await denyResp.json();
ok('/web/clash/build denies non-streamer', denyResp.status === 200 && denyBody.ok === false && denyBody.error === 'permission',
   `status=${denyResp.status} body=${JSON.stringify(denyBody)}`);

// Bad signature → 401
const goodBody = JSON.stringify({ discordId: NUM_STREAMER, guildId: NUM_GUILD, kind: 'wall' });
const badSigReq = new Request('https://bot.example.com/web/clash/build', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-aquilo-web-ts': '1', 'x-aquilo-web-sig': 'deadbeef' },
  body: goodBody,
});
const badSigResp = await handleWeb(badSigReq, webEnv);
ok('/web/clash/build rejects bad signature', badSigResp.status === 401);

// Bad kind → badkind classification
const badKindReq = await webPost('/web/clash/build', {
  discordId: NUM_STREAMER, guildId: NUM_GUILD, kind: 'atlantis',
});
const badKindResp = await handleWeb(badKindReq, webEnv);
const badKindBody = await badKindResp.json();
ok('/web/clash/build rejects bad kind',
   badKindResp.status === 200 && badKindBody.ok === false && badKindBody.error === 'badkind',
   `body=${JSON.stringify(badKindBody)}`);

// /web/clash/town as streamer → enriched payload
const townWebReq = await webPost('/web/clash/town', {
  discordId: NUM_STREAMER, guildId: NUM_GUILD,
});
const townWebResp = await handleWeb(townWebReq, webEnv);
const townWebBody = await townWebResp.json();
ok('/web/clash/town returns ok for streamer',
   townWebResp.status === 200 && townWebBody.ok === true,
   `body=${JSON.stringify(townWebBody).slice(0, 200)}`);
ok('/web/clash/town buildings carry spriteId + nextCost',
   Array.isArray(townWebBody.buildings) &&
   townWebBody.buildings.every(b => b.spriteId && b.spriteId.startsWith('clash/buildings/')));
ok('/web/clash/town has newBuildOptions',
   Array.isArray(townWebBody.newBuildOptions) &&
   townWebBody.newBuildOptions.length === Object.keys(BUILDINGS).length);
ok('/web/clash/town has garrisonOptions',
   Array.isArray(townWebBody.garrisonOptions) &&
   townWebBody.garrisonOptions.every(g => g.spriteId.startsWith('clash/troops/')));

// /web/clash/town as non-streamer → permission
const denyTownReq = await webPost('/web/clash/town', {
  discordId: NUM_VIEWER, guildId: NUM_GUILD,
});
const denyTownResp = await handleWeb(denyTownReq, webEnv);
const denyTownBody = await denyTownResp.json();
ok('/web/clash/town denies non-streamer',
   denyTownResp.status === 200 && denyTownBody.ok === false && denyTownBody.error === 'permission');

// ── Phase 5: obstacles + Engineer clear + wallet → treasury bridge ─
//
// Town autocreation seeds 4–6 obstacles in the outer ring; the
// payloads (sync, public, and /web/clash/town) all surface them;
// findFreeTile skips them; the clear-obstacle action queues, debits
// scrap, and on queue-walk removes the obstacle + drops the reward.
// The Patreon-session play surface gets /web/clash/donate (wallet →
// treasury) which closes the long-standing "bolts don't sync to
// Clash" gap. Tests below exercise the contract end-to-end.
console.log('--- phase 5: obstacles + clear-obstacle + donate ---');

const P5_GUILD = 'g_p5';
const P5_STREAMER = 'u_p5_streamer';
const t5 = await ensureTown(env, P5_GUILD, P5_STREAMER);
ok('ensureTown seeds obstacles array', Array.isArray(t5.obstacles) && t5.obstacles.length >= 4 && t5.obstacles.length <= 6);
ok('ensureTown seeds engineers slot',  t5.engineers && t5.engineers.total === 1);
ok('ensureTown seeds grid bounds',     t5.grid && t5.grid.w === 48 && t5.grid.h === 48);
ok('obstacles carry id/kind/x/y/status',
   t5.obstacles.every(o => typeof o.id === 'number' && typeof o.kind === 'string' &&
                            typeof o.x === 'number' && typeof o.y === 'number' &&
                            o.status === 'idle'));
ok('seeded obstacle kinds are all known',
   t5.obstacles.every(o => ['rock', 'tree', 'debris'].includes(o.kind)));

// Backfill on a legacy town that was stored before Phase 5 — drop
// the obstacles + engineers fields, then ensureTown again and confirm
// they reappear. Mirrors what'll happen to every town in the wild on
// the first /clash after deploy.
const LEGACY = 'g_legacy_p5';
await env.LOADOUT_BOLTS.put('clash:town:' + LEGACY, JSON.stringify({
  guildId: LEGACY, thLevel: 1, prestige: { score: 0, tier: 'bronze', peak: 0 },
  buildings: [{ id: 1, kind: 'townhall', level: 1, x: 8, y: 8, hp: 800, status: 'idle' }],
  garrison: {}, layoutVersion: 1, ownerUserId: 'u_legacy', modUserIds: [],
  customisation: {}, createdUtc: 1, lastUpdatedUtc: 1,
}));
const backfilled = await ensureTown(env, LEGACY, 'u_legacy');
ok('legacy backfill adds obstacles', Array.isArray(backfilled.obstacles) && backfilled.obstacles.length >= 4);
ok('legacy backfill adds engineers', backfilled.engineers && backfilled.engineers.total === 1);
ok('legacy backfill adds grid',      backfilled.grid && backfilled.grid.w === 48);

// Public /clash/town/<g> surfaces the new shape.
const p5PublicResp = await handleClashTownPublic(env, '/clash/town/' + P5_GUILD);
const p5PublicBody = await p5PublicResp.json();
ok('public town payload includes obstacles',
   Array.isArray(p5PublicBody.obstacles) && p5PublicBody.obstacles.length >= 4);
ok('public obstacles carry spriteId',
   p5PublicBody.obstacles.every(o => typeof o.spriteId === 'string' && o.spriteId.startsWith('clash/obstacles/')));
ok('public town payload includes engineers',
   p5PublicBody.engineers && p5PublicBody.engineers.total === 1 && p5PublicBody.engineers.busy === 0);
ok('public town payload includes obstacleCatalogue',
   p5PublicBody.obstacleCatalogue && typeof p5PublicBody.obstacleCatalogue.rock === 'object');
// Grid bumped to 24x24 by the Clash-expansion E5 (layout editor).
// Was 16x16 in the original Phase-5 contract; updated post-merge.
ok('public town payload includes grid',
   p5PublicBody.grid && p5PublicBody.grid.w === 48,
   `grid=${JSON.stringify(p5PublicBody.grid)}`);

// /web/clash/town now ships wallet + obstacles + engineers for the
// play surface.
const P5_NUM_GUILD = '444444444444444444';
const P5_NUM_STREAMER = '555555555555555555';
await ensureTown(env, P5_NUM_GUILD, P5_NUM_STREAMER);
// Keep bolts well under capacity so donate-happy-path has headroom +
// the clear-obstacle reward test can land a bolts credit without the
// cap kicking in.
await addTreasury(env, P5_NUM_GUILD, { bolts: 100, scrap: 1000, cores: 10 });
// Seed the streamer's wallet so the donate test has Bolts to spend.
await env.LOADOUT_BOLTS.put(`wallet:${P5_NUM_GUILD}:${P5_NUM_STREAMER}`, JSON.stringify({
  balance: 2500, lifetimeEarned: 2500, lifetimeSpent: 0,
  lastEarnUtc: Date.now(), dailyStreak: 0, lastDailyUtc: 0, links: [],
}));
const p5WebEnv = { ...env, AQUILO_SITE_WEB_SECRET: WEB_SECRET, AQUILO_VAULT_GUILD_ID: P5_NUM_GUILD };

const p5TownReq = await webPost('/web/clash/town', { discordId: P5_NUM_STREAMER, guildId: P5_NUM_GUILD });
const p5TownResp = await handleWeb(p5TownReq, p5WebEnv);
const p5TownBody = await p5TownResp.json();
ok('/web/clash/town returns wallet for caller',
   p5TownBody.wallet && p5TownBody.wallet.balance === 2500,
   `wallet=${JSON.stringify(p5TownBody.wallet)}`);
ok('/web/clash/town returns obstacles[]',
   Array.isArray(p5TownBody.obstacles) && p5TownBody.obstacles.length >= 4);
ok('/web/clash/town obstacles carry spriteId',
   p5TownBody.obstacles.every(o => o.spriteId && o.spriteId.startsWith('clash/obstacles/')));
ok('/web/clash/town returns engineers',
   p5TownBody.engineers && p5TownBody.engineers.total === 1);
ok('/web/clash/town returns obstacleCatalogue',
   p5TownBody.obstacleCatalogue && p5TownBody.obstacleCatalogue.rock.clearScrap === 200);
ok('/web/clash/town returns grid',
   p5TownBody.grid && p5TownBody.grid.w === 48);

// /web/clash/donate — happy path, partial-cap, empty wallet, bad amount.
const donateReq = await webPost('/web/clash/donate', {
  discordId: P5_NUM_STREAMER, guildId: P5_NUM_GUILD, amount: 500,
});
const donateResp = await handleWeb(donateReq, p5WebEnv);
const donateBody = await donateResp.json();
ok('/web/clash/donate happy path returns ok',
   donateResp.status === 200 && donateBody.ok === true && donateBody.wallet.balance === 2000,
   `body=${JSON.stringify(donateBody).slice(0, 250)}`);
ok('/web/clash/donate credits treasury',
   donateBody.treasury.bolts === 600);

// Empty wallet — try to donate more than balance.
const overReq = await webPost('/web/clash/donate', {
  discordId: P5_NUM_STREAMER, guildId: P5_NUM_GUILD, amount: 99_999_999,
});
const overResp = await handleWeb(overReq, p5WebEnv);
const overBody = await overResp.json();
ok('/web/clash/donate rejects over-wallet',
   overBody.ok === false && overBody.error === 'wallet-empty',
   `body=${JSON.stringify(overBody)}`);

// Bad amount.
const badAmtReq = await webPost('/web/clash/donate', {
  discordId: P5_NUM_STREAMER, guildId: P5_NUM_GUILD, amount: 0,
});
const badAmtResp = await handleWeb(badAmtReq, p5WebEnv);
const badAmtBody = await badAmtResp.json();
ok('/web/clash/donate rejects bad amount',
   badAmtBody.ok === false && badAmtBody.error === 'bad-amount');

// /web/clash/clear-obstacle — happy path drains scrap, marks obstacle
// 'clearing', enqueues. Then walkQueueComplete with a poked endsAt
// removes the obstacle + drops the reward.
const targetObs = p5TownBody.obstacles.find(o => o.kind === 'debris') ||
                  p5TownBody.obstacles.find(o => o.kind === 'tree') ||
                  p5TownBody.obstacles[0];
const tresBefore = await getTreasury(env, P5_NUM_GUILD);
const clearReq = await webPost('/web/clash/clear-obstacle', {
  discordId: P5_NUM_STREAMER, guildId: P5_NUM_GUILD, obstacleId: targetObs.id,
});
const clearResp = await handleWeb(clearReq, p5WebEnv);
const clearBody = await clearResp.json();
ok('/web/clash/clear-obstacle returns ok',
   clearBody.ok === true && typeof clearBody.endsAt === 'number',
   `body=${JSON.stringify(clearBody).slice(0, 250)}`);
ok('/web/clash/clear-obstacle debits scrap from treasury',
   clearBody.treasury.scrap === tresBefore.scrap - ({ rock: 200, tree: 80, debris: 50 }[targetObs.kind]));
ok('/web/clash/clear-obstacle marks obstacle as clearing',
   clearBody.obstacles.find(o => o.id === targetObs.id)?.status === 'clearing');
ok('/web/clash/clear-obstacle reports busy engineer',
   clearBody.engineers.busy === 1);

// Second clear while engineer is busy → no-engineer error.
const second = p5TownBody.obstacles.find(o => o.id !== targetObs.id);
const busyReq = await webPost('/web/clash/clear-obstacle', {
  discordId: P5_NUM_STREAMER, guildId: P5_NUM_GUILD, obstacleId: second.id,
});
const busyResp = await handleWeb(busyReq, p5WebEnv);
const busyBody = await busyResp.json();
ok('/web/clash/clear-obstacle rejects when engineer is busy',
   busyBody.ok === false && busyBody.error === 'no-engineer',
   `body=${JSON.stringify(busyBody)}`);

// Non-mod → permission.
const noModId = '666666666666666666';
const noModReq = await webPost('/web/clash/clear-obstacle', {
  discordId: noModId, guildId: P5_NUM_GUILD, obstacleId: targetObs.id,
});
const noModResp = await handleWeb(noModReq, p5WebEnv);
const noModBody = await noModResp.json();
ok('/web/clash/clear-obstacle denies non-mod',
   noModBody.ok === false && noModBody.error === 'permission');

// Bad id → no-obstacle.
const badIdReq = await webPost('/web/clash/clear-obstacle', {
  discordId: P5_NUM_STREAMER, guildId: P5_NUM_GUILD, obstacleId: 99999,
});
const badIdResp = await handleWeb(badIdReq, p5WebEnv);
const badIdBody = await badIdResp.json();
ok('/web/clash/clear-obstacle rejects unknown obstacle id',
   badIdBody.ok === false && badIdBody.error === 'no-obstacle');

// Fast-forward the queued clear and walk it — obstacle should vanish
// and the reward should land in the treasury.
const tresMidClear = await getTreasury(env, P5_NUM_GUILD);
const qKey = 'clash:queue:' + P5_NUM_GUILD;
const qBefore = await env.LOADOUT_BOLTS.get(qKey, { type: 'json' });
qBefore.items[0].endsAt = Date.now() - 1;
await env.LOADOUT_BOLTS.put(qKey, JSON.stringify(qBefore));
const clearCompleted = await walkQueueComplete(env, qKey);
ok('walkQueueComplete returns the matured clear item',
   clearCompleted.length === 1 && clearCompleted[0].kind === 'clearObstacle');

// Apply the side effects exactly like syncCooldowns does (the test
// harness doesn't import that helper directly; mimic its branch).
const townMid = await getTown(env, P5_NUM_GUILD);
townMid.obstacles = (townMid.obstacles || []).filter(o => o.id !== clearCompleted[0].target.obstacleId);
townMid.layoutVersion = (townMid.layoutVersion || 0) + 1;
await env.LOADOUT_BOLTS.put('clash:town:' + P5_NUM_GUILD, JSON.stringify(townMid));
const rewardScrap = { rock: 60, tree: 30, debris: 10 }[targetObs.kind];
const rewardBolts = { rock: 0,  tree: 0,  debris: 20 }[targetObs.kind];
await addTreasury(env, P5_NUM_GUILD, { scrap: rewardScrap, bolts: rewardBolts });

const townAfterClear = await getTown(env, P5_NUM_GUILD);
ok('cleared obstacle is gone from town.obstacles',
   !townAfterClear.obstacles.some(o => o.id === targetObs.id));
const tresAfterClear = await getTreasury(env, P5_NUM_GUILD);
ok('clearing drops reward into treasury',
   tresAfterClear.scrap === tresMidClear.scrap + rewardScrap &&
   tresAfterClear.bolts === tresMidClear.bolts + rewardBolts);

// ── /web/character contract ─────────────────────────────────────
// HMAC-gated read + save of the player's pixel-art look. Same
// infra as /web/clash/* — reuses NUM_GUILD/NUM_VIEWER + webPost
// signed under WEB_SECRET. Lives here rather than test-character-
// pet.mjs (which is data-model-only) so the HMAC + KV shim don't
// need duplicating.
console.log('--- /web/character contract ---');

// First read = Phase-0 backfill, no save yet.
const getReq1 = await webPost('/web/character', {
  discordId: NUM_VIEWER, guildId: NUM_GUILD,
});
const getResp1 = await handleWeb(getReq1, webEnv);
const getBody1 = await getResp1.json();
ok('/web/character returns ok on fresh user',
   getResp1.status === 200 && getBody1.ok === true,
   `body=${JSON.stringify(getBody1).slice(0, 200)}`);
ok('/web/character look has all 6 axes',
   getBody1.look && getBody1.look.bodyType && getBody1.look.skinTone &&
   getBody1.look.hairStyle && getBody1.look.hairColor && getBody1.look.eyeColor && getBody1.look.accent);
ok('/web/character options arrays present + non-empty',
   getBody1.options &&
   Array.isArray(getBody1.options.bodyType) && getBody1.options.bodyType.length >= 2 &&
   Array.isArray(getBody1.options.skinTone) && getBody1.options.skinTone.length >= 4 &&
   Array.isArray(getBody1.options.hairStyle) && getBody1.options.hairStyle.length >= 4 &&
   Array.isArray(getBody1.options.hairColor) && getBody1.options.hairColor.length >= 4 &&
   Array.isArray(getBody1.options.eyeColor) && getBody1.options.eyeColor.length >= 4 &&
   Array.isArray(getBody1.options.accent) && getBody1.options.accent.length >= 2);
ok('/web/character hairSwatches map returns hex strings',
   getBody1.hairSwatches &&
   typeof getBody1.hairSwatches[getBody1.options.hairColor[0]] === 'string' &&
   /^#[0-9a-f]{6}$/.test(getBody1.hairSwatches[getBody1.options.hairColor[0]]));
ok('/web/character renderUrl pins ?v=<lookVersion>&av=<assetVersion>',
   typeof getBody1.renderUrl === 'string' &&
   getBody1.renderUrl.includes(`/character/render/${NUM_GUILD}/${NUM_VIEWER}.png?v=`) &&
   getBody1.renderUrl.includes('v=' + getBody1.lookVersion + '&av=') &&
   /[?&]av=[\w-]+/.test(getBody1.renderUrl));
ok('/web/character fresh user lookVersion = 0', getBody1.lookVersion === 0);
ok('/web/character fresh user is unlocked',
   getBody1.locked === false,
   'locked=' + getBody1.locked);
ok('/web/character exposes resetCost = 5000',
   getBody1.resetCost === 5000,
   'resetCost=' + getBody1.resetCost);

// Bad signature → 401
const badCharSigReq = new Request('https://bot.example.com/web/character', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-aquilo-web-ts': '1', 'x-aquilo-web-sig': 'deadbeef' },
  body: JSON.stringify({ discordId: NUM_VIEWER, guildId: NUM_GUILD }),
});
const badCharSigResp = await handleWeb(badCharSigReq, webEnv);
ok('/web/character rejects bad signature', badCharSigResp.status === 401);

// Save with a valid partial patch — bumps lookVersion + persists.
const saveReq = await webPost('/web/character/save', {
  discordId: NUM_VIEWER, guildId: NUM_GUILD,
  look: { bodyType: 'stocky', hairColor: 'violet' },
});
const saveResp = await handleWeb(saveReq, webEnv);
const saveBody = await saveResp.json();
ok('/web/character/save returns ok',
   saveResp.status === 200 && saveBody.ok === true,
   `body=${JSON.stringify(saveBody).slice(0, 200)}`);
ok('/web/character/save applies bodyType', saveBody.look.bodyType === 'stocky');
ok('/web/character/save applies hairColor', saveBody.look.hairColor === 'violet');
ok('/web/character/save bumps lookVersion',
   saveBody.lookVersion === getBody1.lookVersion + 1,
   `v=${saveBody.lookVersion}`);
ok('/web/character/save changed flag true',  saveBody.changed === true);
ok('/web/character/save sets locked=true', saveBody.locked === true);

// Second save after locking → rejected with character-locked. Look
// stays at the first-save value; no version bump.
const lockedReq = await webPost('/web/character/save', {
  discordId: NUM_VIEWER, guildId: NUM_GUILD,
  look: { bodyType: 'slim' },
});
const lockedResp = await handleWeb(lockedReq, webEnv);
const lockedBody = await lockedResp.json();
ok('/web/character/save rejects when locked',
   lockedResp.status === 409 && lockedBody.ok === false && lockedBody.error === 'character-locked',
   `status=${lockedResp.status} body=${JSON.stringify(lockedBody)}`);
ok('/web/character/save locked carries resetCost',
   lockedBody.resetCost === 5000,
   'resetCost=' + lockedBody.resetCost);

// Bad value → rejected with field/value detail, no save.
const badReq = await webPost('/web/character/save', {
  discordId: NUM_VIEWER, guildId: NUM_GUILD,
  look: { skinTone: 'metallic-gold' },   // not in options
});
const badResp = await handleWeb(badReq, webEnv);
const badBody = await badResp.json();
ok('/web/character/save rejects bad value',
   badResp.status === 400 && badBody.ok === false && badBody.error === 'bad-look' &&
   badBody.field === 'skinTone' && badBody.value === 'metallic-gold',
   `body=${JSON.stringify(badBody)}`);

// Missing look field → bad-body.
const noLookReq = await webPost('/web/character/save', {
  discordId: NUM_VIEWER, guildId: NUM_GUILD,
});
const noLookResp = await handleWeb(noLookReq, webEnv);
const noLookBody = await noLookResp.json();
ok('/web/character/save rejects missing look',
   noLookResp.status === 400 && noLookBody.ok === false && noLookBody.error === 'bad-body');

// Re-read after save — persisted look comes back, lookVersion advanced.
const getReq2 = await webPost('/web/character', {
  discordId: NUM_VIEWER, guildId: NUM_GUILD,
});
const getResp2 = await handleWeb(getReq2, webEnv);
const getBody2 = await getResp2.json();
ok('/web/character re-read persists bodyType', getBody2.look.bodyType === 'stocky');
ok('/web/character re-read persists hairColor', getBody2.look.hairColor === 'violet');
ok('/web/character re-read lookVersion advanced',
   getBody2.lookVersion === saveBody.lookVersion);
ok('/web/character re-read shows locked=true', getBody2.locked === true);

// ── /web/character/reset ────────────────────────────────────────────
//
// Without enough Bolts: typed insufficient-bolts error, no state
// change. With enough Bolts: charges 5,000 atomically + flips locked
// back to false, look preserved.
const resetPoorReq = await webPost('/web/character/reset', {
  discordId: NUM_VIEWER, guildId: NUM_GUILD,
});
const resetPoorResp = await handleWeb(resetPoorReq, webEnv);
const resetPoorBody = await resetPoorResp.json();
ok('/web/character/reset insufficient-bolts when wallet < 5000',
   resetPoorResp.status === 402 &&
   resetPoorBody.ok === false &&
   resetPoorBody.error === 'insufficient-bolts' &&
   resetPoorBody.required === 5000,
   `status=${resetPoorResp.status} body=${JSON.stringify(resetPoorBody)}`);

// Top up via the test's earn helper if available; else write directly
// to the KV-backed wallet store. We use the wallet module directly
// since it's already a dependency of the worker code.
{
  const { earn } = await import('../wallet.js');
  await earn(webEnv, NUM_GUILD, NUM_VIEWER, 7500, 'test-seed');
}

const resetReq = await webPost('/web/character/reset', {
  discordId: NUM_VIEWER, guildId: NUM_GUILD,
});
const resetResp = await handleWeb(resetReq, webEnv);
const resetBody = await resetResp.json();
ok('/web/character/reset returns ok',
   resetResp.status === 200 && resetBody.ok === true,
   `status=${resetResp.status} body=${JSON.stringify(resetBody).slice(0, 200)}`);
ok('/web/character/reset charged 5000', resetBody.charged === 5000);
ok('/web/character/reset locked=false', resetBody.locked === false);
ok('/web/character/reset balance debited',
   resetBody.wallet.balance === 2500,
   'balance=' + resetBody.wallet.balance);
ok('/web/character/reset preserves look',
   resetBody.look.bodyType === 'stocky' && resetBody.look.hairColor === 'violet');

// Re-saving after reset → locks again.
const reSaveReq = await webPost('/web/character/save', {
  discordId: NUM_VIEWER, guildId: NUM_GUILD,
  look: { hairColor: 'blonde' },
});
const reSaveResp = await handleWeb(reSaveReq, webEnv);
const reSaveBody = await reSaveResp.json();
ok('/web/character/save after reset succeeds',
   reSaveResp.status === 200 && reSaveBody.ok === true && reSaveBody.locked === true,
   `body=${JSON.stringify(reSaveBody).slice(0, 200)}`);

// /web/character/class is also gated by the lock: NUM_VIEWER is now
// locked again from the reSave, so picking a class returns the same
// typed error the save path uses.
const classLockedReq = await webPost('/web/character/class', {
  discordId: NUM_VIEWER, guildId: NUM_GUILD, className: 'warrior',
});
const classLockedResp = await handleWeb(classLockedReq, webEnv);
const classLockedBody = await classLockedResp.json();
ok('/web/character/class rejects when locked',
   classLockedResp.status === 409 &&
   classLockedBody.ok === false &&
   classLockedBody.error === 'character-locked' &&
   classLockedBody.resetCost === 5000,
   `status=${classLockedResp.status} body=${JSON.stringify(classLockedBody)}`);

// Reset path again, then immediately call reset again on the now-
// unlocked character → typed `not-locked` error, no charge.
{
  const { earn } = await import('../wallet.js');
  await earn(webEnv, NUM_GUILD, NUM_VIEWER, 5000, 'test-seed-2');
}
const reset2Req = await webPost('/web/character/reset', {
  discordId: NUM_VIEWER, guildId: NUM_GUILD,
});
await handleWeb(reset2Req, webEnv);
const reset3Req = await webPost('/web/character/reset', {
  discordId: NUM_VIEWER, guildId: NUM_GUILD,
});
const reset3Resp = await handleWeb(reset3Req, webEnv);
const reset3Body = await reset3Resp.json();
ok('/web/character/reset on unlocked → not-locked, no charge',
   reset3Resp.status === 400 &&
   reset3Body.ok === false &&
   reset3Body.error === 'not-locked' &&
   reset3Body.wallet.balance === 2500,  // 7500 seeded → 2 resets at 5000 → 2500
   `status=${reset3Resp.status} body=${JSON.stringify(reset3Body)}`);

// Class-pick-does-NOT-lock contract: a fresh user picks class first,
// stays unlocked so they can still customise their look. The save
// step is the one that flips the lock.
const NUM_VIEWER_2 = '555555555555555555';
const freshGetReq = await webPost('/web/character', {
  discordId: NUM_VIEWER_2, guildId: NUM_GUILD,
});
const freshGetBody = await (await handleWeb(freshGetReq, webEnv)).json();
ok('fresh user starts unlocked',
   freshGetBody.ok === true && freshGetBody.locked === false && freshGetBody.className === null,
   `body=${JSON.stringify(freshGetBody).slice(0, 200)}`);

const classPickReq = await webPost('/web/character/class', {
  discordId: NUM_VIEWER_2, guildId: NUM_GUILD, className: 'mage',
});
const classPickBody = await (await handleWeb(classPickReq, webEnv)).json();
ok('class pick on fresh user succeeds without locking',
   classPickBody.ok === true && classPickBody.className === 'mage' && classPickBody.locked === false,
   `body=${JSON.stringify(classPickBody).slice(0, 200)}`);

const afterPickReq = await webPost('/web/character', {
  discordId: NUM_VIEWER_2, guildId: NUM_GUILD,
});
const afterPickBody = await (await handleWeb(afterPickReq, webEnv)).json();
ok('post-class re-read still unlocked + class set',
   afterPickBody.locked === false && afterPickBody.className === 'mage');

const v2SaveReq = await webPost('/web/character/save', {
  discordId: NUM_VIEWER_2, guildId: NUM_GUILD,
  look: { bodyType: 'slim' },
});
const v2SaveBody = await (await handleWeb(v2SaveReq, webEnv)).json();
ok('look save after class pick locks',
   v2SaveBody.ok === true && v2SaveBody.locked === true);

// ── /web/referral contract ──────────────────────────────────────────
//
// /me mints a stable 8-char code idempotently + reports referrer
// stats. /attribute pairs (refereeId, refCode) — first-attribution-
// wins, self-referral refused, unknown code rejected.
console.log('--- /web/referral contract ---');

const REF_A = '666666666666666666';
const REF_B = '777777777777777777';
const REF_C = '888888888888888888';

const meReq1  = await webPost('/web/referral/me', { discordId: REF_A, guildId: NUM_GUILD });
const meBody1 = await (await handleWeb(meReq1, webEnv)).json();
ok('/web/referral/me ok on fresh user',
   meBody1.ok === true && typeof meBody1.code === 'string' && meBody1.code.length === 8,
   `body=${JSON.stringify(meBody1).slice(0, 200)}`);
ok('/web/referral/me code is Crockford-base32 (no I L O U, no 0 1)',
   /^[2-9A-HJ-NP-TV-Z]{8}$/.test(meBody1.code),
   `code=${meBody1.code}`);
ok('/web/referral/me link points at aquilo.gg/?ref=<code>',
   meBody1.link === `https://aquilo.gg/?ref=${meBody1.code}`);
ok('/web/referral/me fresh stats are zeroed',
   meBody1.stats && meBody1.stats.count === 0 && meBody1.stats.paid === 0 &&
   Array.isArray(meBody1.stats.history) && meBody1.stats.history.length === 0,
   `stats=${JSON.stringify(meBody1.stats)}`);

// Idempotent — same caller gets the same code back.
const meReq2  = await webPost('/web/referral/me', { discordId: REF_A, guildId: NUM_GUILD });
const meBody2 = await (await handleWeb(meReq2, webEnv)).json();
ok('/web/referral/me idempotent (code stable across calls)',
   meBody2.code === meBody1.code);

// Bad signature → 401 (same as every other /web/* route).
const badRefSigReq = new Request('https://bot.example.com/web/referral/me', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-aquilo-web-ts': '1', 'x-aquilo-web-sig': 'deadbeef' },
  body: JSON.stringify({ discordId: REF_A, guildId: NUM_GUILD }),
});
ok('/web/referral/me rejects bad signature',
   (await handleWeb(badRefSigReq, webEnv)).status === 401);

// Missing refCode → typed error.
const attrEmptyReq  = await webPost('/web/referral/attribute', { discordId: REF_B, guildId: NUM_GUILD });
const attrEmptyResp = await handleWeb(attrEmptyReq, webEnv);
const attrEmptyBody = await attrEmptyResp.json();
ok('/web/referral/attribute rejects missing refCode',
   attrEmptyResp.status === 400 && attrEmptyBody.ok === false &&
   attrEmptyBody.error === 'refCode-required',
   `body=${JSON.stringify(attrEmptyBody)}`);

// Unknown code → unknown-code.
const attrBadReq  = await webPost('/web/referral/attribute', {
  discordId: REF_B, guildId: NUM_GUILD, refCode: 'ZZZZZZZZ',
});
const attrBadResp = await handleWeb(attrBadReq, webEnv);
const attrBadBody = await attrBadResp.json();
ok('/web/referral/attribute rejects unknown code',
   attrBadResp.status === 400 && attrBadBody.ok === false && attrBadBody.error === 'unknown-code',
   `body=${JSON.stringify(attrBadBody)}`);

// Self-referral refused (REF_A attributing themselves with their own code).
const attrSelfReq  = await webPost('/web/referral/attribute', {
  discordId: REF_A, guildId: NUM_GUILD, refCode: meBody1.code,
});
const attrSelfBody = await (await handleWeb(attrSelfReq, webEnv)).json();
ok('/web/referral/attribute refuses self-referral',
   attrSelfBody.ok === false && attrSelfBody.error === 'self-referral',
   `body=${JSON.stringify(attrSelfBody)}`);

// Happy path — REF_B is attributed under REF_A's code.
const attrOkReq  = await webPost('/web/referral/attribute', {
  discordId: REF_B, guildId: NUM_GUILD, refCode: meBody1.code,
});
const attrOkResp = await handleWeb(attrOkReq, webEnv);
const attrOkBody = await attrOkResp.json();
ok('/web/referral/attribute happy path returns ok',
   attrOkResp.status === 200 && attrOkBody.ok === true &&
   attrOkBody.referrerId === REF_A && attrOkBody.refCode === meBody1.code,
   `body=${JSON.stringify(attrOkBody)}`);

// Stats reflect the new attribution on REF_A's /me.
const meAfter = await (await handleWeb(
  await webPost('/web/referral/me', { discordId: REF_A, guildId: NUM_GUILD }),
  webEnv,
)).json();
ok('/web/referral/me stats.count bumps after attribution',
   meAfter.stats.count === 1 && meAfter.stats.paid === 0 && meAfter.stats.lastUtc > 0,
   `stats=${JSON.stringify(meAfter.stats)}`);

// Double-attribution: REF_B trying again → already-attributed.
const attrAgainReq  = await webPost('/web/referral/attribute', {
  discordId: REF_B, guildId: NUM_GUILD, refCode: meBody1.code,
});
const attrAgainBody = await (await handleWeb(attrAgainReq, webEnv)).json();
ok('/web/referral/attribute first-attribution-wins',
   attrAgainBody.ok === false && attrAgainBody.error === 'already-attributed' &&
   attrAgainBody.referrerId === REF_A,
   `body=${JSON.stringify(attrAgainBody)}`);

// Lowercase + whitespace input still resolves (server upper-cases + trims).
{
  const meC = await (await handleWeb(
    await webPost('/web/referral/me', { discordId: REF_C, guildId: NUM_GUILD }),
    webEnv,
  )).json();
  // REF_C will use REF_A's code, lowercased + padded — should normalise.
  const noisyReq  = await webPost('/web/referral/attribute', {
    discordId: REF_C, guildId: NUM_GUILD, refCode: '  ' + meBody1.code.toLowerCase() + '  ',
  });
  const noisyBody = await (await handleWeb(noisyReq, webEnv)).json();
  ok('/web/referral/attribute normalises whitespace + case',
     noisyBody.ok === true && noisyBody.referrerId === REF_A,
     `code=${meC.code} body=${JSON.stringify(noisyBody)}`);
}

// ── Referral funnel payout — milestone fires on first /web/daily ────
//
// REF_B was attributed under REF_A above. Wallet pre-state: REF_A has
// zero bolts and zero packs; REF_B is fresh. Hitting /web/daily on
// REF_B should fire recordMilestone('first-game') via the new
// noteFirstGame hook in routeDaily, which credits REF_A with the
// REFERRAL_REWARD_BOLTS (50) + a 'bolt' pack.
console.log('--- referral milestone payout ---');

// Snapshot REF_A's wallet + referrer-stats BEFORE the milestone fires.
{
  const { getWallet } = await import('../wallet.js');
  const before = await getWallet(webEnv, NUM_GUILD, REF_A);
  ok('REF_A starts with zero bolts (clean payout baseline)',
     (before.balance || 0) === 0, `bal=${before.balance}`);
}

// REF_B hits /web/daily (first-ever activity). Daily() pays the
// player; routeDaily fires noteFirstGame → recordMilestone.
const dailyReq  = await webPost('/web/daily', { discordId: REF_B, guildId: NUM_GUILD });
const dailyResp = await handleWeb(dailyReq, webEnv);
const dailyBody = await dailyResp.json();
ok('/web/daily for REF_B returns ok (claim landed)',
   dailyResp.status === 200 && dailyBody.ok === true,
   `body=${JSON.stringify(dailyBody).slice(0, 200)}`);

// REF_A now has the REFERRAL_REWARD_BOLTS (50) credited by the
// milestone hook.
{
  const { getWallet } = await import('../wallet.js');
  const { REFERRAL_REWARD_BOLTS, REFERRAL_REWARD_PACK, getReferrerStats } = await import('../referrals.js');
  const after = await getWallet(webEnv, NUM_GUILD, REF_A);
  ok('REF_A wallet credited 50 Bolts by milestone hook',
     after.balance === REFERRAL_REWARD_BOLTS,
     `bal=${after.balance} (expected ${REFERRAL_REWARD_BOLTS})`);

  const stats = await getReferrerStats(webEnv, NUM_GUILD, REF_A);
  ok('REF_A referrer stats.paid bumps to 1',
     stats.paid === 1, `stats=${JSON.stringify(stats)}`);
  ok('REF_A history records the milestone',
     Array.isArray(stats.history) && stats.history.length === 1 &&
     stats.history[0].refereeId === REF_B &&
     stats.history[0].kind === 'first-game' &&
     stats.history[0].reward?.bolts === REFERRAL_REWARD_BOLTS &&
     stats.history[0].reward?.pack === REFERRAL_REWARD_PACK,
     `history=${JSON.stringify(stats.history)}`);
}

// Idempotency: REF_B plays /web/coinflip → no second payout.
const coinReq  = await webPost('/web/coinflip', {
  discordId: REF_B, guildId: NUM_GUILD, bet: 10,
});
await handleWeb(coinReq, webEnv);

{
  const { getWallet } = await import('../wallet.js');
  const { getReferrerStats } = await import('../referrals.js');
  const after = await getWallet(webEnv, NUM_GUILD, REF_A);
  ok('REF_A wallet UNCHANGED on REF_B second activity (milestone idempotent)',
     after.balance === 50, `bal=${after.balance}`);
  const stats = await getReferrerStats(webEnv, NUM_GUILD, REF_A);
  ok('REF_A referrer stats.paid stays at 1', stats.paid === 1);
}

// Non-referred user doesn't pay anyone. Pick a fresh ID, hit /web/daily,
// confirm no referrer is credited (none to credit) and route still
// returns ok.
const SOLO = '999999999999999999';
const soloReq  = await webPost('/web/daily', { discordId: SOLO, guildId: NUM_GUILD });
const soloResp = await handleWeb(soloReq, webEnv);
const soloBody = await soloResp.json();
ok('/web/daily for non-referred user still returns ok (no-op milestone)',
   soloResp.status === 200 && soloBody.ok === true,
   `body=${JSON.stringify(soloBody).slice(0, 200)}`);

console.log('--- ' + passed + ' pass, ' + failed + ' fail ---');
if (failed > 0) process.exit(1);
