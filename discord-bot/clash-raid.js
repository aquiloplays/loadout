// Clash — server-side raid resolver.
//
// One pure function: simulate(attacker, defenderSnapshot, seed) -> RaidReceipt.
// Determinism is on purpose — the same (snapshot, army, hero, seed)
// always produces the same fight, so /clash log replays match what
// actually happened. Seed = raidId (a UUID is fine).
//
// Phase 1 fidelity: turn-based, abstracted positions. The replay log
// is compact event records, not a full ECS dump; enough to drive a
// readable "Wave 1 hit the East Wall, Wave 2 took down Cannon-3"
// summary. Visual fidelity arrives with the web layout editor in
// Phase 4.

import { BUILDINGS, TROOPS_PERSONAL, TROOPS_GARRISON, rollVoltaicDrop } from './clash-content.js';

// Seeded RNG so battles replay identically.
function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; };
}

// Snapshot shape (from clash-state.refreshDefenseSnapshot):
//   { guildId, thLevel, layoutVersion, buildings: [{ id, kind, level, x, y, hp }],
//     garrison: { troopId: count } }
//
// Attacker shape:
//   { userId, army: { troopId: count }, hero: { level, cls, atkBonus, defBonus, voltaicPieces } }

const MAX_TICKS = 240;        // ~4 in-game minutes at 1 tick/sec
const TICK_MS_REAL = 50;      // sim wall-clock; not the in-fiction tick rate

export function simulate(attacker, defenderSnapshot, raidId) {
  const r = rng(hashStr(raidId));
  const log = [];
  const t0 = Date.now();

  // ── Build live battle state ────────────────────────────────────────
  const buildings = (defenderSnapshot.buildings || []).map(b => ({
    ...b,
    maxHp: BUILDINGS[b.kind]?.hp?.[b.level] || b.hp || 100,
    hp: BUILDINGS[b.kind]?.hp?.[b.level] || b.hp || 100,
    alive: true,
  }));
  const th = buildings.find(b => b.kind === 'townhall');

  // Champion (the attacker's dungeon hero deployed as a single super-unit).
  const champion = attacker.hero ? {
    isHero: true,
    name: attacker.hero.cls || 'Champion',
    cls: attacker.hero.cls || 'warrior',
    hp:  120 + (attacker.hero.level || 1) * 12 + (attacker.hero.defBonus || 0) * 6,
    atk: 18  + (attacker.hero.level || 1) * 3 + (attacker.hero.atkBonus || 0) * 4,
    speed: 3,
    range: classRange(attacker.hero.cls),
    voltaicMult: (attacker.hero.voltaicPieces || 0) >= 3 ? 1.20 : 1.0,
    alive: true,
  } : null;

  // Personal troops the attacker brought.
  const army = [];
  for (const [troopId, count] of Object.entries(attacker.army || {})) {
    const def = TROOPS_PERSONAL[troopId];
    if (!def) continue;
    for (let i = 0; i < count; i++) {
      army.push({
        id: troopId + '#' + (army.length + 1),
        troopId, def,
        hp: def.hp, atk: def.atk, speed: def.speed, range: def.range || 1,
        target: def.target,
        aoe: def.aoe || 0,
        alive: true,
      });
    }
  }
  if (champion) army.push(champion);

  // Garrison: the defender's defending troops, sit inside the base.
  const garrison = [];
  for (const [troopId, count] of Object.entries(defenderSnapshot.garrison || {})) {
    const def = TROOPS_GARRISON[troopId] || TROOPS_PERSONAL[troopId];
    if (!def) continue;
    for (let i = 0; i < count; i++) {
      garrison.push({
        id: 'g:' + troopId + '#' + (garrison.length + 1),
        troopId, def,
        hp: def.hp, atk: def.atk, alive: true,
      });
    }
  }

  // Towers (cannons + archer towers) defending the base — extracted for
  // a tight inner loop.
  const towers = buildings.filter(b => b.kind === 'cannon' || b.kind === 'archerTower');
  const walls = buildings.filter(b => b.kind === 'wall');
  const traps = buildings.filter(b => b.kind === 'trap');

  // ── Sim loop ───────────────────────────────────────────────────────
  let tick = 0;
  for (; tick < MAX_TICKS; tick++) {
    if (!army.some(u => u.alive)) break;
    if (!buildings.some(b => b.alive)) break;

    // 1. Each attacker unit picks a target and attacks.
    for (const u of army) {
      if (!u.alive) continue;
      const target = pickTarget(u, buildings, garrison, walls, r);
      if (!target) continue;
      const dmg = Math.round(u.atk * (u.voltaicMult || 1) * (0.92 + r() * 0.16));
      target.hp -= dmg;
      log.push({ t: tick, who: u.id || (u.isHero ? 'hero' : 'unit'), to: target.id || target.troopId, dmg });
      if (target.hp <= 0) {
        target.alive = false;
        if (target.kind && target.kind === 'trap' && target.alive === false) {
          // Trap detonated — burst damage to nearest 3 attackers
          const burst = BUILDINGS.trap.burst[target.level] || 100;
          const victims = army.filter(a => a.alive).slice(0, 3);
          for (const v of victims) {
            v.hp -= burst;
            log.push({ t: tick, who: 'trap:' + target.id, to: v.id, dmg: burst });
            if (v.hp <= 0) v.alive = false;
          }
        }
      }
    }

    // 2. Towers shoot back.
    for (const tower of towers) {
      if (!tower.alive) continue;
      const targetable = army.filter(u => u.alive);
      if (!targetable.length) continue;
      const dps = BUILDINGS[tower.kind]?.dps?.[tower.level] || 5;
      const target = targetable[Math.floor(r() * targetable.length)];
      const dmg = Math.round(dps * (0.9 + r() * 0.2));
      target.hp -= dmg;
      log.push({ t: tick, who: tower.kind + ':' + tower.id, to: target.id, dmg });
      if (target.hp <= 0) target.alive = false;
    }

    // 3. Garrison defenders engage attackers.
    for (const g of garrison) {
      if (!g.alive) continue;
      const targetable = army.filter(u => u.alive);
      if (!targetable.length) continue;
      const target = targetable[Math.floor(r() * targetable.length)];
      const dmg = Math.round(g.atk * (0.9 + r() * 0.2));
      target.hp -= dmg;
      log.push({ t: tick, who: 'def:' + g.id, to: target.id, dmg });
      if (target.hp <= 0) target.alive = false;
    }
  }

  // ── Score ──────────────────────────────────────────────────────────
  const buildingsTotal = buildings.length;
  const buildingsDown = buildings.filter(b => !b.alive).length;
  const thDown = !!(th && !th.alive);
  const pctDestroyed = buildingsDown / Math.max(1, buildingsTotal);
  let stars = 0;
  if (pctDestroyed >= 0.5) stars = 1;
  if (pctDestroyed >= 0.8 || thDown) stars = 2;
  if (pctDestroyed >= 0.95 && thDown) stars = 3;

  return {
    raidId,
    startedUtc: t0,
    durationMs: Date.now() - t0,
    ticks: tick,
    stars,
    pctDestroyed,
    thDown,
    log: log.slice(0, 200),    // cap so the receipt stays under KV size
    buildingsTotal,
    buildingsDown,
    armyLost: army.filter(u => !u.alive && !u.isHero).length,
    heroSurvived: champion ? champion.alive : null,
  };
}

function pickTarget(unit, buildings, garrison, walls, r) {
  // Special-case targeting hints.
  if (unit.target === 'walls') {
    const w = walls.find(b => b.alive);
    if (w) return w;
  }
  if (unit.target === 'highValue') {
    const hv = buildings.find(b => b.alive && (b.kind === 'townhall' || b.kind === 'storage'));
    if (hv) return hv;
  }
  if (unit.target === 'support') {
    // Healers don't attack — return null and let the resolver skip them.
    return null;
  }
  // Default: nearest live building, but prefer towers since they kill us.
  const t = buildings.filter(b => b.alive && (b.kind === 'cannon' || b.kind === 'archerTower'));
  if (t.length) return t[Math.floor(r() * t.length)];
  const any = buildings.filter(b => b.alive);
  if (any.length) return any[Math.floor(r() * any.length)];
  // Last resort: hit a garrison troop.
  const g = garrison.filter(u => u.alive);
  return g[Math.floor(r() * g.length)] || null;
}

function classRange(cls) {
  return ({ ranger: 5, mage: 3, healer: 3 })[cls] || 1;
}

function hashStr(s) {
  // tiny string hash for seeding
  let h = 0;
  for (let i = 0; i < (s || '').length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

// ── Loot calculator ──────────────────────────────────────────────────
//
// Given a resolved sim + treasury state, compute Bolts/Scrap/Cores
// transferred AND any Voltaic drop. Cap loot at 20% of treasury per
// raid + hard ceiling so a sustained loss doesn't drain a town in one
// session.
const LOOT_CAP_PCT = 0.20;
const LOOT_CEILING_BOLTS = 25_000;
const LOOT_CEILING_SCRAP = 1_200;
const LOOT_CEILING_CORES = 4;

export function computeLoot(sim, defenderTreasury, defenderTier = 'bronze') {
  if (sim.stars === 0) {
    return { bolts: 0, scrap: 0, cores: 0, voltaic: null };
  }
  // The 20% cap is a hard ceiling — `factor` modulates *within* it,
  // never above. 1-star raids take ~30% of cap, 2-star ~65%, 3-star
  // up to 100% of cap (and even then, gated by pctDestroyed).
  const starShare = { 1: 0.30, 2: 0.65, 3: 1.00 }[sim.stars] || 0;
  const factor = starShare * Math.max(0.3, sim.pctDestroyed);
  const boltsCap = Math.max(0, defenderTreasury?.bolts || 0) * LOOT_CAP_PCT;
  const bolts = Math.min(LOOT_CEILING_BOLTS, Math.floor(boltsCap * factor));
  const scrapCap = Math.max(0, defenderTreasury?.scrap || 0) * LOOT_CAP_PCT;
  const scrap = Math.min(LOOT_CEILING_SCRAP, Math.floor(scrapCap * factor));
  const coreCap = Math.max(0, defenderTreasury?.cores || 0) * LOOT_CAP_PCT;
  const cores = Math.min(LOOT_CEILING_CORES, Math.floor(coreCap * (sim.stars === 3 ? 1 : 0.5)));
  const voltaic = rollVoltaicDrop(sim.stars, defenderTier);
  return { bolts, scrap, cores, voltaic };
}

// Trophy delta — fixed by star count + a small tier-mismatch swing
// (raiding above your weight = bonus on win, harder on loss).
export function computeTrophyDelta(sim, attackerTier, defenderTier) {
  const tiers = ['bronze', 'silver', 'gold', 'platinum', 'diamond'];
  const swing = (tiers.indexOf(defenderTier) - tiers.indexOf(attackerTier)) * 3;
  if (sim.stars === 0) return { attacker: -8 - Math.max(0, -swing), defender: +4 };
  if (sim.stars === 1) return { attacker: +6 + Math.max(0, swing), defender: -6 };
  if (sim.stars === 2) return { attacker: +14 + Math.max(0, swing * 1.5), defender: -14 };
  return { attacker: +24 + Math.max(0, swing * 2), defender: -22 };
}
