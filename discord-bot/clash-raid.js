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

import { BUILDINGS, TROOPS_PERSONAL, TROOPS_GARRISON, TROOPS_GOBLIN, rollVoltaicDrop } from './clash-content.js';

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

export function simulate(attacker, defenderSnapshot, raidId, opts = {}) {
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

  // Defending Champion (Phase 3) — only present when the defender
  // has a built War Tent AND a designated, opted-in defender hero.
  // Same stat math as the attacker's Champion but tent level bumps
  // its HP multiplier.
  const defenderChampion = opts.defenderHero ? {
    isHero: true,
    isDefender: true,
    name: 'Defender ' + (opts.defenderHero.cls || 'warrior'),
    cls: opts.defenderHero.cls || 'warrior',
    hp:  Math.round((120 + (opts.defenderHero.level || 1) * 12 + (opts.defenderHero.defBonus || 0) * 6) * (opts.tentHpMult || 1.0)),
    atk: 18  + (opts.defenderHero.level || 1) * 3 + (opts.defenderHero.atkBonus || 0) * 4,
    voltaicMult: (opts.defenderHero.voltaicPieces || 0) >= 3 ? 1.20 : 1.0,
    alive: true,
  } : null;

  // Personal troops the attacker brought. Goblin raids reuse the same
  // attacker slot — fall back to TROOPS_GOBLIN when a troopId isn't a
  // player troop. This keeps simulate() agnostic to who's raiding.
  const army = [];
  for (const [troopId, count] of Object.entries(attacker.army || {})) {
    const def = TROOPS_PERSONAL[troopId] || TROOPS_GOBLIN[troopId];
    if (!def) continue;
    for (let i = 0; i < count; i++) {
      army.push({
        id: troopId + '#' + (army.length + 1),
        troopId, def,
        hp: def.hp, atk: def.atk, speed: def.speed, range: def.range || 1,
        target: def.target,
        aoe: def.aoe || 0,
        // E3: air/wall/debuff flags propagate from the catalog to the
        // sim unit so pickTarget + tower-shoot can filter on them.
        isAir: !!def.isAir,
        ignoresWalls: !!def.ignoresWalls,
        bonusVsWalls: def.bonusVsWalls || 1,
        debuffDpsMult: def.debuffDpsMult || 0,
        debuffTicks: def.debuffTicks || 0,
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

  // Towers (cannons + archer towers + all new E3 defenses) defending
  // the base. A kind counts as a tower if its catalog entry declares a
  // dps array. Each tower carries the `targets` field — the sim filters
  // attackers by that field before picking a target each tick.
  const towers = buildings.filter(b => Array.isArray(BUILDINGS[b.kind]?.dps));
  const walls = buildings.filter(b => b.kind === 'wall');
  const traps = buildings.filter(b => BUILDINGS[b.kind]?.isTrap);

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
      // Battering Ram + Lightning Sapper get a wall damage bonus —
      // catalog field `bonusVsWalls` multiplies attack against walls.
      const wallMult = (target.kind === 'wall' && u.bonusVsWalls > 1) ? u.bonusVsWalls : 1;
      const dmg = Math.round(u.atk * (u.voltaicMult || 1) * wallMult * (0.92 + r() * 0.16));
      target.hp -= dmg;
      log.push({ t: tick, who: u.id || (u.isHero ? 'hero' : 'unit'), to: target.id || target.troopId, dmg });
      if (target.hp <= 0) {
        target.alive = false;
        // Trap detonation. Dispatch on trapKind so spring/inferno/sky
        // mine all run their own burst rules. Bomb traps + the legacy
        // 'trap' kind use the default burst path.
        const tdef = target.kind && BUILDINGS[target.kind];
        if (tdef && tdef.isTrap) {
          const kind = tdef.trapKind || 'bomb';
          const burst = tdef.burst?.[target.level] || 100;
          // Sky mines only target air; if there are no fliers, the
          // burst is wasted but the trap still triggers.
          const victims = kind === 'skyMine'
            ? army.filter(a => a.alive && a.isAir).slice(0, 2)
            : army.filter(a => a.alive).slice(0, 3);
          for (const v of victims) {
            v.hp -= burst;
            log.push({ t: tick, who: kind + ':' + target.id, to: v.id, dmg: burst });
            if (v.hp <= 0) v.alive = false;
          }
          // Bomb Tower explodes on death — additional burst beyond
          // the trap branch.
          if (tdef.explodesOnDeath) {
            const xb = tdef.explodesOnDeath[target.level] || 0;
            if (xb > 0) {
              const xvictims = army.filter(a => a.alive).slice(0, 4);
              for (const v of xvictims) {
                v.hp -= xb;
                log.push({ t: tick, who: 'bombTower:' + target.id, to: v.id, dmg: xb });
                if (v.hp <= 0) v.alive = false;
              }
            }
          }
        }
      }
    }

    // 2. Towers shoot back. Each tower respects its own targets filter
    //    (ground / air / both) so anti-air can ignore ground troops and
    //    vice versa. Air-only towers shoot nothing if no air units are
    //    in the field; ground towers can't touch a stormCaller until
    //    the defender builds anti-air.
    for (const tower of towers) {
      if (!tower.alive) continue;
      const tdef = BUILDINGS[tower.kind] || {};
      const targets = tdef.targets || 'ground';
      const targetable = army.filter(u => {
        if (!u.alive) return false;
        if (u.isAir && targets === 'ground') return false;
        if (!u.isAir && targets === 'air') return false;
        return true;
      });
      if (!targetable.length) continue;
      const baseDps = tdef.dps?.[tower.level] || 5;
      const target = targetable[Math.floor(r() * targetable.length)];
      const dmg = Math.round(baseDps * (0.9 + r() * 0.2));
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

    // 4. Defending Champion (Phase 3) — single high-impact defender
    //    that prioritises the attacker's Champion if present, else
    //    drops into the standard "pick whoever's alive" loop.
    if (defenderChampion && defenderChampion.alive) {
      const live = army.filter(u => u.alive);
      if (live.length) {
        const heroTarget = live.find(u => u.isHero) || live[Math.floor(r() * live.length)];
        const dmg = Math.round(defenderChampion.atk * defenderChampion.voltaicMult * (0.92 + r() * 0.16));
        heroTarget.hp -= dmg;
        log.push({ t: tick, who: 'defChampion', to: heroTarget.id || 'hero', dmg });
        if (heroTarget.hp <= 0) heroTarget.alive = false;
      }
      // Attackers also hit back at the defending Champion — count it
      // among the attacker targets so a Sapper or Voltaic Mage can
      // burst it down. Treated as a high-priority building-like
      // target with no x/y coords.
      const attackersStillAlive = army.filter(u => u.alive);
      // Only one attacker per tick swings at the def Champion — picked
      // probabilistically so the AI doesn't go "everyone ignore the
      // hero." Higher chance when the Champion is hurt.
      if (attackersStillAlive.length && r() < 0.35) {
        const attacker = attackersStillAlive[Math.floor(r() * attackersStillAlive.length)];
        const dmg = Math.round(attacker.atk * (attacker.voltaicMult || 1) * (0.9 + r() * 0.2));
        defenderChampion.hp -= dmg;
        log.push({ t: tick, who: attacker.id || 'unit', to: 'defChampion', dmg });
        if (defenderChampion.hp <= 0) defenderChampion.alive = false;
      }
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
    defenderHeroSurvived: defenderChampion ? defenderChampion.alive : null,
    // E2 damage persistence: slim per-building final state so
    // applyDamageWriteback can sync live town HP without replaying
    // the log. Each entry: {id, hp, maxHp, alive}.
    finalBuildings: buildings.map(b => ({
      id: b.id, hp: Math.max(0, Math.round(b.hp)),
      maxHp: b.maxHp, alive: !!b.alive,
    })),
  };
}

function pickTarget(unit, buildings, garrison, walls, r) {
  // Air + wall-ignoring units skip the wall layer entirely; "walls"
  // targeting hint is a no-op for them so they don't waste a tick.
  const skipsWalls = !!(unit.isAir || unit.ignoresWalls);

  // Special-case targeting hints.
  if (unit.target === 'walls') {
    if (skipsWalls) {
      // Sappers that ignore walls fall through to the default branch.
    } else {
      const w = walls.find(b => b.alive);
      if (w) return w;
    }
  }
  if (unit.target === 'highValue') {
    const hv = buildings.find(b => b.alive && (b.kind === 'townhall' || b.kind === 'storage' || b.kind === 'mint' || b.kind === 'goldVault'));
    if (hv) return hv;
  }
  if (unit.target === 'support') {
    // Healers + plague doctors don't attack directly — return null.
    return null;
  }
  // Default: prefer towers (any kind with dps), but skip walls if the
  // unit can't be bothered with them.
  const t = buildings.filter(b => b.alive && Array.isArray(BUILDINGS[b.kind]?.dps));
  if (t.length) return t[Math.floor(r() * t.length)];
  const any = buildings.filter(b => b.alive && (!skipsWalls || b.kind !== 'wall'));
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
//
// `opts.warAmplify` (Phase 2): when the raid happens inside an active
// community-vs-community war pairing, the loot cap lifts to 30% and
// the Voltaic drop chance gets a flat bonus. Trophy amplification
// handled separately in computeTrophyDelta.
const LOOT_CAP_PCT = 0.20;
const LOOT_CAP_PCT_WAR = 0.30;
const LOOT_CEILING_BOLTS = 25_000;
const LOOT_CEILING_SCRAP = 1_200;
const LOOT_CEILING_CORES = 4;
const VOLTAIC_BONUS_WAR = 0.15;

export function computeLoot(sim, defenderTreasury, defenderTier = 'bronze', opts = {}) {
  if (sim.stars === 0) {
    return { bolts: 0, scrap: 0, cores: 0, voltaic: null };
  }
  const cap = opts.warAmplify ? LOOT_CAP_PCT_WAR : LOOT_CAP_PCT;
  const starShare = { 1: 0.30, 2: 0.65, 3: 1.00 }[sim.stars] || 0;
  const factor = starShare * Math.max(0.3, sim.pctDestroyed);
  const boltsCap = Math.max(0, defenderTreasury?.bolts || 0) * cap;
  const bolts = Math.min(LOOT_CEILING_BOLTS, Math.floor(boltsCap * factor));
  const scrapCap = Math.max(0, defenderTreasury?.scrap || 0) * cap;
  const scrap = Math.min(LOOT_CEILING_SCRAP, Math.floor(scrapCap * factor));
  const coreCap = Math.max(0, defenderTreasury?.cores || 0) * cap;
  const cores = Math.min(LOOT_CEILING_CORES, Math.floor(coreCap * (sim.stars === 3 ? 1 : 0.5)));
  // Voltaic drop: war pairing bumps chance via a roll-twice-take-best.
  let voltaic = rollVoltaicDrop(sim.stars, defenderTier);
  if (!voltaic && opts.warAmplify && Math.random() < VOLTAIC_BONUS_WAR) {
    voltaic = rollVoltaicDrop(sim.stars, defenderTier);
  }
  return { bolts, scrap, cores, voltaic };
}

// Trophy delta — fixed by star count + a small tier-mismatch swing
// (raiding above your weight = bonus on win, harder on loss). War
// pairing multiplies both attacker and defender deltas by 1.5x.
export function computeTrophyDelta(sim, attackerTier, defenderTier, opts = {}) {
  const tiers = ['bronze', 'silver', 'gold', 'platinum', 'diamond'];
  const swing = (tiers.indexOf(defenderTier) - tiers.indexOf(attackerTier)) * 3;
  let raw;
  if (sim.stars === 0) raw = { attacker: -8 - Math.max(0, -swing), defender: +4 };
  else if (sim.stars === 1) raw = { attacker: +6 + Math.max(0, swing), defender: -6 };
  else if (sim.stars === 2) raw = { attacker: +14 + Math.max(0, swing * 1.5), defender: -14 };
  else raw = { attacker: +24 + Math.max(0, swing * 2), defender: -22 };
  if (opts.warAmplify) {
    raw.attacker = Math.round(raw.attacker * 1.5);
    raw.defender = Math.round(raw.defender * 1.5);
  }
  return raw;
}
