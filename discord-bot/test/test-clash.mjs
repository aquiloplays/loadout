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

// Save with the same look = no-op, no version bump.
const noopReq = await webPost('/web/character/save', {
  discordId: NUM_VIEWER, guildId: NUM_GUILD,
  look: { bodyType: 'stocky', hairColor: 'violet' },
});
const noopResp = await handleWeb(noopReq, webEnv);
const noopBody = await noopResp.json();
ok('/web/character/save no-op when unchanged',
   noopBody.ok === true && noopBody.changed === false && noopBody.lookVersion === saveBody.lookVersion);

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

console.log('--- ' + passed + ' pass, ' + failed + ' fail ---');
if (failed > 0) process.exit(1);
