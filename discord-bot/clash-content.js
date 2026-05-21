// Clash — content catalogues + procedural generators.
//
// Static data only — no KV I/O. Imported by clash-state.js,
// clash-raid.js, and clash.js for cost lookups, troop stats, and
// fallback target generation.
//
// Cost calibration matches CLASH-FEATURE-DESIGN.md §4 (~700 Bolts/day
// at 7-day streak baseline; one mid-tier action per day for a single
// viewer, faster for a community pooling Bolts).

// ── Buildings (town surface) ─────────────────────────────────────────
//
// `cost` arrays are indexed by the level being *built into* (so to get
// to level 2 you pay BUILDINGS.townhall.cost[2]). cost[0] is a no-op
// sentinel. Same for `time` (wall-clock ms to finish the build).
//
// `hp` is the HP a building has *at* a given level (used by the raid
// resolver). Levelling restores HP and increments cap.

export const BUILDINGS = {
  townhall: {
    glyph: '🏰', name: 'Town Hall',
    cost: [null,
      { bolts: 0,      scrap: 0 },
      { bolts: 1200,   scrap: 60,    cores: 0 },
      { bolts: 3500,   scrap: 200,   cores: 0 },
      { bolts: 7000,   scrap: 450,   cores: 1 },
      { bolts: 14000,  scrap: 900,   cores: 2 },
      { bolts: 28000,  scrap: 1800,  cores: 4 },
      { bolts: 45000,  scrap: 3200,  cores: 7 },
      { bolts: 80000,  scrap: 5400,  cores: 12 },
      { bolts: 140000, scrap: 9000,  cores: 20 },
      { bolts: 220000, scrap: 14000, cores: 32 },
    ],
    time: [null, 0, 30*60_000, 2*3_600_000, 6*3_600_000, 12*3_600_000,
                 18*3_600_000, 24*3_600_000, 36*3_600_000, 72*3_600_000, 120*3_600_000],
    hp:   [null, 800, 1200, 1800, 2600, 3600, 4900, 6500, 8500, 11000, 14000],
    grantsBuildSlots: [null, 1, 1, 1, 2, 2, 2, 3, 3, 3, 3],
    grantsBarracksCap: [null, 6, 10, 16, 24, 36, 50, 70, 95, 130, 180],
  },
  wall: {
    glyph: '🧱', name: 'Wall',
    cost: [null,
      { bolts: 0 },
      { bolts: 200,   scrap: 20 },
      { bolts: 500,   scrap: 60 },
      { bolts: 1200,  scrap: 140 },
      { bolts: 2600,  scrap: 320 },
      { bolts: 5400,  scrap: 700 },
      { bolts: 11000, scrap: 1500, cores: 1 },
      { bolts: 22000, scrap: 3000, cores: 2 },
    ],
    time: [null, 0, 10*60_000, 30*60_000, 90*60_000, 4*3_600_000,
                 8*3_600_000, 12*3_600_000, 24*3_600_000],
    hp:   [null, 200, 320, 500, 760, 1100, 1500, 2000, 2700],
  },
  cannon: {
    glyph: '💣', name: 'Cannon',
    cost: [null,
      { bolts: 0 },
      { bolts: 500,   scrap: 40 },
      { bolts: 1400,  scrap: 120 },
      { bolts: 3200,  scrap: 280, cores: 1 },
      { bolts: 7500,  scrap: 700, cores: 2 },
      { bolts: 16000, scrap: 1500, cores: 4 },
      { bolts: 32000, scrap: 3200, cores: 8 },
    ],
    time: [null, 0, 30*60_000, 2*3_600_000, 6*3_600_000, 14*3_600_000,
                 24*3_600_000, 48*3_600_000],
    hp:   [null, 300, 460, 680, 980, 1380, 1900, 2600],
    dps:  [null,  8,   13,  20,   30,   45,   65,   90],
  },
  archerTower: {
    glyph: '🏹', name: 'Archer Tower',
    cost: [null,
      { bolts: 0 },
      { bolts: 600,   scrap: 50 },
      { bolts: 1700,  scrap: 150 },
      { bolts: 3800,  scrap: 350, cores: 1 },
      { bolts: 9000,  scrap: 800, cores: 2 },
      { bolts: 19000, scrap: 1700, cores: 4 },
      { bolts: 36000, scrap: 3400, cores: 8 },
    ],
    time: [null, 0, 30*60_000, 2*3_600_000, 6*3_600_000, 14*3_600_000,
                 24*3_600_000, 48*3_600_000],
    hp:   [null, 240, 360, 540, 800, 1180, 1700, 2400],
    dps:  [null,  6,   10,  15,  22,  33,   48,   68],
    range: 6,   // tiles; ranged units pick this off easier
  },
  trap: {
    glyph: '💢', name: 'Trap',
    cost: [null, { bolts: 0 }, { bolts: 400, scrap: 30 }, { bolts: 1100, scrap: 90 } ],
    time: [null, 0, 20*60_000, 90*60_000],
    hp:   [null, 1, 1, 1],   // traps detonate on first hit
    burst:[null, 120, 220, 380],   // burst damage on detonation
  },
  storage: {
    glyph: '🏛️', name: 'Storage',
    cost: [null, { bolts: 0 }, { bolts: 800, scrap: 60 }, { bolts: 2200, scrap: 180 },
                 { bolts: 5500, scrap: 450, cores: 1 }],
    time: [null, 0, 45*60_000, 3*3_600_000, 9*3_600_000],
    hp:   [null, 400, 600, 900, 1300],
    capacityBonus: [null, 2000, 5000, 12000, 28000],
  },
  barracks: {
    glyph: '⛺', name: 'Barracks',
    cost: [null, { bolts: 0 }, { bolts: 1000, scrap: 80 }, { bolts: 2800, scrap: 220 },
                 { bolts: 6500, scrap: 550, cores: 1 }],
    time: [null, 0, 1*3_600_000, 4*3_600_000, 12*3_600_000],
    hp:   [null, 360, 540, 820, 1200],
    // Garrison cap bonus stacks with TH base cap.
    garrisonCapBonus: [null, 0, 4, 10, 20],
  },
  // ── War Tent (Phase 3) ──────────────────────────────────────────
  //
  // Gates the "defending Champion" mechanic. When a town has a built
  // War Tent AND the streamer has designated a community member's
  // hero (and that user has accepted), that hero deploys as a
  // defending Champion during raids — same model as the attacker's
  // Champion, on the other side. Without a War Tent, the town
  // defends with garrison only.
  warTent: {
    glyph: '⛺', name: 'War Tent',
    cost: [null, { bolts: 0 }, { bolts: 4000, scrap: 200, cores: 1 }, { bolts: 12000, scrap: 600, cores: 3 }],
    time: [null, 0, 6*3_600_000, 24*3_600_000],
    hp:   [null, 500, 800, 1200],
    // Champion HP multiplier — a higher-level tent makes the
    // defending Champion sturdier (matches the upgrade investment).
    championHpMult: [null, 1.0, 1.15, 1.3],
    // How often a designated defender's opt-in expires — the streamer
    // has to re-designate (or the same defender re-accepts) after
    // this. Forces a refresh so a stale designation doesn't shield
    // a town indefinitely with an inactive defender.
    designationTtlMs: [null, 7*86_400_000, 14*86_400_000, 30*86_400_000],
  },
};

// ── Hero-level gates on Town Hall tiers (Phase 3) ────────────────────
//
// A community needs to keep growing its dungeon heroes to keep
// growing its town. Each TH level above 3 demands that at least one
// community member has a hero at the listed level — forces the
// community to engage with the dungeon side, which is the whole
// point of Clash plugging into Loadout instead of being a parallel
// universe.

export const TH_HERO_GATE = {
  4:  5,    // TH 4 needs at least one hero L5+
  5:  8,
  6:  12,
  7:  18,
  8:  24,
  9:  30,
  10: 40,
};

// ── Troops ───────────────────────────────────────────────────────────
//
// Personal troops are trained by an individual viewer (their Bolts ->
// their personal army). Garrison troops are trained from the town
// treasury and defend the town when raided.

export const TROOPS_PERSONAL = {
  scrapper: {
    glyph: '🤺', name: 'Scrapper', rarity: 'common',
    bolts: 8, time: 30_000,
    hp: 60, atk: 8, speed: 3, target: 'closest',
  },
  boltKnight: {
    glyph: '⚔️', name: 'Bolt Knight', rarity: 'rare',
    bolts: 220, time: 12*60_000,
    hp: 180, atk: 22, speed: 2, target: 'closest',
  },
  archerLite: {
    glyph: '🏹', name: 'Archer', rarity: 'common',
    bolts: 14, time: 45_000,
    hp: 40, atk: 10, speed: 3, target: 'closest', range: 4,
  },
  voltaicMage: {
    glyph: '🪄', name: 'Voltaic Mage', rarity: 'epic',
    bolts: 950, time: 90*60_000,
    hp: 140, atk: 60, speed: 2, target: 'highValue', range: 3, aoe: 2,
  },
  sapperRogue: {
    glyph: '💥', name: 'Sapper Rogue', rarity: 'rare',
    bolts: 320, time: 25*60_000,
    hp: 80, atk: 90, speed: 4, target: 'walls',
  },
  healerCleric: {
    glyph: '✨', name: 'Healer Cleric', rarity: 'rare',
    bolts: 380, time: 30*60_000,
    hp: 90, atk: 4, speed: 2, target: 'support', healPerTick: 12, range: 3,
  },
};

export const TROOPS_GARRISON = {
  scrapper: { ...TROOPS_PERSONAL.scrapper, bolts: 80, time: 2*60_000 },
  boltKnight: { ...TROOPS_PERSONAL.boltKnight, bolts: 700, time: 25*60_000 },
  voltaicMage: { ...TROOPS_PERSONAL.voltaicMage, bolts: 4000, time: 2*3_600_000 },
  archerLite: { ...TROOPS_PERSONAL.archerLite, bolts: 120, time: 4*60_000 },
};

// ── Voltaic loot set ─────────────────────────────────────────────────
//
// Pieces drop from successful Clash raids (PvE and PvP). They fit
// into the existing dungeon hero gear slots — see dungeon.js SHOP_POOL
// for the canonical inventory shape. Set bonus: +20% Champion damage
// during Clash raids when ≥3 Voltaic pieces equipped.

export const VOLTAIC_LOOT = [
  // slot, rarity, name, glyph, atk, def, gold (price), setName, weaponType, preferredClass, ability
  ['weapon',  'epic',    'Voltaic Bolt-Blade', '⚡', 6, 0, 2400, 'voltaic', 'sword',  'warrior', 'voltaic'],
  ['head',    'epic',    'Voltaic Crown',      '👑', 1, 4, 2000, 'voltaic', '',       '',        ''],
  ['chest',   'epic',    'Voltaic Mantle',     '🥋', 1, 5, 2200, 'voltaic', '',       '',        ''],
  ['legs',    'rare',    'Voltaic Greaves',    '🦿', 1, 3,  800, 'voltaic', '',       '',        ''],
  ['boots',   'rare',    'Voltaic Striders',   '👟', 1, 3,  800, 'voltaic', '',       '',        ''],
  ['trinket', 'epic',    'Voltaic Sigil',      '🌀', 3, 1, 2000, 'voltaic', '',       '',        'voltaic'],
];

// Roll a Voltaic drop. stars = raid star count (0..3), targetTier = the
// defender's tier ('bronze'..'diamond'). Returns one of VOLTAIC_LOOT
// or null. Designed so a 3-star raid on a diamond town is exciting but
// a 0-star goblin tap basically never drops.
export function rollVoltaicDrop(stars, targetTier) {
  if (stars < 1) return null;
  const tierWeight = { bronze: 0.02, silver: 0.05, gold: 0.10, platinum: 0.18, diamond: 0.28 }[targetTier] || 0.02;
  const starMult = stars / 3;
  const p = tierWeight * (0.4 + 0.6 * starMult);
  if (Math.random() > p) return null;
  return VOLTAIC_LOOT[Math.floor(Math.random() * VOLTAIC_LOOT.length)];
}

// ── Deterministic NPC town generator ─────────────────────────────────
//
// Same seed always returns the same town — saves us from storing a
// row per fallback opponent. Difficulty scales with the attacker's
// trophy tier so the NPC fight isn't a free 3-star at endgame.

function rngFromSeed(seed) {
  // xorshift32 — deterministic, fine for content
  let s = (seed | 0) || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) % 10000) / 10000;
  };
}

export function generateNpcTown(seed, attackerTier = 'bronze') {
  const rng = rngFromSeed(seed);
  const tierIndex = ['bronze', 'silver', 'gold', 'platinum', 'diamond'].indexOf(attackerTier);
  const baseLevel = Math.max(1, Math.min(8, 1 + tierIndex * 2 + Math.floor(rng() * 2)));

  const buildings = [
    { id: 1, kind: 'townhall', level: baseLevel, x: 8, y: 8, hp: BUILDINGS.townhall.hp[baseLevel] || 800, status: 'idle' },
  ];
  let nextId = 2;
  const wallLevel = Math.max(1, baseLevel - 1);
  const numWalls = 4 + Math.floor(rng() * 4);
  for (let i = 0; i < numWalls; i++) {
    const x = 3 + Math.floor(rng() * 11);
    const y = 3 + Math.floor(rng() * 11);
    buildings.push({ id: nextId++, kind: 'wall', level: wallLevel, x, y, hp: BUILDINGS.wall.hp[wallLevel], status: 'idle' });
  }
  const numCannons = Math.min(baseLevel, 4);
  for (let i = 0; i < numCannons; i++) {
    const x = 3 + Math.floor(rng() * 11);
    const y = 3 + Math.floor(rng() * 11);
    buildings.push({ id: nextId++, kind: 'cannon', level: wallLevel, x, y, hp: BUILDINGS.cannon.hp[wallLevel], status: 'idle' });
  }
  const numArchers = Math.min(baseLevel - 1, 3);
  for (let i = 0; i < numArchers && i < numArchers; i++) {
    const x = 3 + Math.floor(rng() * 11);
    const y = 3 + Math.floor(rng() * 11);
    buildings.push({ id: nextId++, kind: 'archerTower', level: wallLevel, x, y, hp: BUILDINGS.archerTower.hp[wallLevel], status: 'idle' });
  }

  return {
    guildId: 'npc:' + seed,
    isNpc: true,
    thLevel: baseLevel,
    prestige: { score: tierIndex * 500, tier: attackerTier, peak: tierIndex * 500 },
    buildings,
    garrison: { scrapper: 6 + baseLevel * 3, archerLite: baseLevel },
    layoutVersion: 1,
    customisation: {},
  };
}

// ── Goblin camp (lightweight PvE) ────────────────────────────────────

export function generateGoblinCamp(seed) {
  const rng = rngFromSeed(seed);
  const wave = 4 + Math.floor(rng() * 5);
  return {
    kind: 'goblin',
    seed,
    buildings: [
      { id: 1, kind: 'townhall', level: 1, x: 8, y: 8, hp: 250, status: 'idle' },
      { id: 2, kind: 'wall', level: 1, x: 6, y: 6, hp: 80, status: 'idle' },
      { id: 3, kind: 'wall', level: 1, x: 10, y: 10, hp: 80, status: 'idle' },
    ],
    garrison: { scrapper: wave },
    rewardScrapBase: 40,
    rewardCoresChance: 0.08,
  };
}

// ── Default cost table for personal troop training (re-exported
// without the wall-clock time so /clash train can show prices). ─────

export function personalTroopCost(troopId, count) {
  const t = TROOPS_PERSONAL[troopId];
  if (!t) return null;
  return { bolts: t.bolts * count, timeMs: t.time * count };
}

export function townBuildCost(kind, targetLevel) {
  const b = BUILDINGS[kind];
  if (!b) return null;
  const c = b.cost?.[targetLevel];
  const t = b.time?.[targetLevel];
  if (!c || t == null) return null;
  return { cost: c, timeMs: t };
}

export function townGarrisonCost(troopId, count) {
  const t = TROOPS_GARRISON[troopId];
  if (!t) return null;
  return { bolts: t.bolts * count, timeMs: t.time * count };
}

// ── Sprite IDs ───────────────────────────────────────────────────────
//
// In-house pixel-art sprites for buildings + troops live at
// `aquilo-gg/sprites/clash/...` (served from widget.aquilo.gg/sprites/).
// Both the public web renderer and the OBS overlay read these paths;
// the bot just emits the canonical relative path so consumers don't
// have to know the layout.
//
// Building sprites scale with level — every level renders distinctly
// up to the max. Troop sprites are one-per-troopId (rarity drives
// the in-sprite palette).
//
// Naming convention:
//   clash/buildings/<kind>-L<level>.png   32×32 PNG, bottom-centre anchored
//   clash/troops/<troopId>.png            24×24 PNG, bottom-centre anchored
//
// Web/OBS team can fetch them at:
//   https://widget.aquilo.gg/sprites/clash/buildings/townhall-L7.png
//   https://widget.aquilo.gg/sprites/clash/troops/voltaicMage.png

export function spriteIdForBuilding(kind, level) {
  const b = BUILDINGS[kind];
  if (!b) return null;
  const maxLevel = (b.hp?.length || 2) - 1;
  const lv = Math.max(1, Math.min(maxLevel, Number(level) || 1));
  return `clash/buildings/${kind}-L${lv}.png`;
}

export function spriteIdForTroop(troopId) {
  if (!TROOPS_PERSONAL[troopId] && !TROOPS_GARRISON[troopId]) return null;
  return `clash/troops/${troopId}.png`;
}

// Enrich a raw town `buildings[]` array with spriteId per entry —
// used by the public /clash/town endpoint and the editor-side
// /sync/:g/clash GET so consumers don't have to derive the path.
export function withBuildingSprites(buildings) {
  if (!Array.isArray(buildings)) return buildings;
  return buildings.map(b => ({
    ...b,
    spriteId: spriteIdForBuilding(b.kind, b.level),
  }));
}

// Enrich a raw garrison `{ troopId: count }` map with spriteIds —
// returns `{ counts: { troopId: count }, sprites: { troopId: path } }`
// so consumers can render either shape easily without bouncing back.
export function withGarrisonSprites(garrison) {
  if (!garrison || typeof garrison !== 'object') return { counts: {}, sprites: {} };
  const sprites = {};
  for (const k of Object.keys(garrison)) {
    const sid = spriteIdForTroop(k);
    if (sid) sprites[k] = sid;
  }
  return { counts: garrison, sprites };
}
