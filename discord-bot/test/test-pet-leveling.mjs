// Standalone harness for the pet-leveling module.
//
//   node discord-bot/test/test-pet-leveling.mjs
//
// Mocks env.LOADOUT_BOLTS (KV) + env.DB (D1) so this runs without
// wrangler. Covers:
//   - xpToNext curve sanity
//   - addPetXp single-level + multi-level rollover
//   - addPetXp triggers ability unlock at min_level threshold
//   - listPetAbilities partitions owned vs upcoming
//   - tryEvolvePet at threshold mutates species
//   - tryEvolvePet blocked by unmet condition (min_happiness)
//   - autoEvolveCron sweep finds + evolves eligible pets
//   - big-appetite ability adds +2 XP on feed source

import {
  addPetXp, getPetLevel, listPetAbilities, tryEvolvePet,
  autoEvolveCron, xpToNext, __TEST__,
} from '../pet-leveling.js';

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + label + (detail ? ' (' + detail + ')' : '')); }
  else      { failed++; console.log('  FAIL  ' + label + (detail ? ' -- ' + detail : '')); }
}

// ── KV mock ─────────────────────────────────────────────────────────
function makeKv() {
  const store = new Map();
  return {
    _store: store,
    async get(key, opts) {
      const v = store.get(key);
      if (v == null) return null;
      if (opts && opts.type === 'json') {
        try { return JSON.parse(v); } catch { return null; }
      }
      return v;
    },
    async put(key, val) { store.set(key, typeof val === 'string' ? val : JSON.stringify(val)); },
    async delete(key) { store.delete(key); },
    async list({ prefix = '', cursor, limit = 1000 } = {}) {
      const all = [...store.keys()].filter(k => k.startsWith(prefix)).sort();
      const startIdx = cursor ? Number(cursor) : 0;
      const slice = all.slice(startIdx, startIdx + limit);
      const nextIdx = startIdx + slice.length;
      return {
        keys: slice.map(name => ({ name })),
        list_complete: nextIdx >= all.length,
        cursor: nextIdx >= all.length ? null : String(nextIdx),
      };
    },
  };
}

// ── D1 mock ─────────────────────────────────────────────────────────
// In-memory ability + evolution catalogues. We seed the same rows the
// SQL migration seeds, with one extra "test-ability" at min_level 2
// for tight threshold tests.
const ABILITY_ROWS = [
  // Tight unlock-on-level threshold for the test:
  { id: 'test-aura', name: 'Test Aura', description: 'Test only.', icon: 'star',
    trigger_type: 'passive', trigger_payload_json: '{}', min_level: 2,
    species_pool: 'dragonling', active: 1 },
  { id: 'big-appetite', name: 'Big Appetite', description: 'Feed +2 XP.', icon: 'fork',
    trigger_type: 'on-feed', trigger_payload_json: '{"xpBonus":2}', min_level: 1,
    species_pool: 'dragonling,dog', active: 1 },
  { id: 'fire-breath', name: 'Fire Breath', description: '+6 dmg.', icon: 'flame',
    trigger_type: 'on-battle-start', trigger_payload_json: '{"damageBonus":6}', min_level: 5,
    species_pool: 'dragonling', active: 1 },
  { id: 'starlight-blessing', name: 'Starlight Blessing', description: '+1 save.', icon: 'star',
    trigger_type: 'passive', trigger_payload_json: '{"saveBonus":1}', min_level: 8,
    species_pool: 'bunny', active: 1 },
  { id: 'vault-sniffer', name: 'Vault Sniffer', description: '+5 bolts.', icon: 'paw',
    trigger_type: 'passive', trigger_payload_json: '{"checkinBonus":5}', min_level: 1,
    species_pool: null, active: 1 },
];
const EVOLUTION_ROWS = [
  { id: 'dragonling->voltaic_drake', base_pet_id: 'dragonling',
    evolves_at_level: 3, evolves_to_pet_id: 'voltaic_drake',
    condition_json: '{"min_happiness":50}', active: 1 },
  { id: 'dragonling->ember_drake_low', base_pet_id: 'dragonling',
    evolves_at_level: 2, evolves_to_pet_id: 'ember_drake',
    condition_json: '{}', active: 1 },
];

function makeDb() {
  return {
    prepare(sql) {
      const params = [];
      const stmt = {
        bind(...args) { params.push(...args); return stmt; },
        async all() {
          if (/FROM pet_ability_def WHERE active = 1\s*$/m.test(sql) ||
              sql.includes('FROM pet_ability_def WHERE active = 1')) {
            return { results: ABILITY_ROWS.filter(r => r.active === 1) };
          }
          if (sql.includes('FROM pet_evolution_chain WHERE base_pet_id = ?')) {
            const sp = params[0];
            const rows = EVOLUTION_ROWS
              .filter(r => r.base_pet_id === sp && r.active === 1)
              .sort((a, b) => b.evolves_at_level - a.evolves_at_level);
            return { results: rows };
          }
          return { results: [] };
        },
        async first() {
          if (sql.includes('FROM pet_ability_def WHERE id = ?')) {
            return ABILITY_ROWS.find(r => r.id === params[0]) || null;
          }
          return null;
        },
        async run() { return { meta: { changes: 0 } }; },
      };
      return stmt;
    },
  };
}

function makeEnv() {
  return { LOADOUT_BOLTS: makeKv(), DB: makeDb() };
}

// Seed a fresh pet directly into the KV mock (bypasses pet.js adopt
// gating which requires a wallet + patreon link).
function seedPet(env, guildId, userId, overrides = {}) {
  const now = Date.now();
  const pet = {
    species: 'dragonling',
    colour: 'voltaic',
    name: 'Sparky',
    adoptedUtc: now,
    hunger:      { value: 100, lastSetUtc: now },
    happiness:   { value: 100, lastSetUtc: now },
    cleanliness: { value: 100, lastSetUtc: now },
    lastFedUtc: 0, lastPlayedUtc: 0, lastCleanedUtc: 0,
    ...overrides,
  };
  env.LOADOUT_BOLTS._store.set(`pet:${guildId}:${userId}`, JSON.stringify(pet));
  return pet;
}

console.log('--- pet-leveling ---');

// ── xpToNext curve ──────────────────────────────────────────────────
ok('xpToNext(1) = 50',  xpToNext(1) === 50);
ok('xpToNext(2) = 200', xpToNext(2) === 200);
ok('xpToNext(3) = 450', xpToNext(3) === 450);
ok('MAX_LEVEL = 20',    __TEST__.MAX_LEVEL === 20);

// ── addPetXp: single level-up + ability unlock ──────────────────────
{
  const env = makeEnv();
  const guildId = 'g1', userId = 'u1';
  seedPet(env, guildId, userId);

  const r1 = await addPetXp(env, userId, guildId, 30, 'feed');
  ok('30 XP keeps L1',          r1.level === 1, `level=${r1.level} xp=${r1.xp}`);
  // big-appetite is owned at L1 (its min_level = 1, species_pool
  // includes dragonling, and the level-up loop runs even for 0-cross
  // because applyXpAndLevelUps only checks unlocks when levelsCrossed
  // > 0. So big-appetite isn't applied on this first feed grant -
  // the unlock check fires on the *next* level. Adjust expectation:
  // big-appetite ability adds +2 XP only if pet.abilities includes it.)
  // Trigger level-up to L2, adds 'test-aura' (min_level=2) AND
  // backfills the L1 abilities we missed. Make XP grant comfortable.
  const r2 = await addPetXp(env, userId, guildId, 30, 'feed');
  ok('60 XP rolls L1→L2',
     r2.level === 2 && r2.levelsCrossed === 1,
     `level=${r2.level} crossed=${r2.levelsCrossed} xp=${r2.xp}`);
  const unlockedIds = (r2.unlocked || []).map(a => a.id);
  ok('level-up unlocks test-aura (min_level=2)',
     unlockedIds.includes('test-aura'),
     `unlocked=${unlockedIds.join(',')}`);
}

// ── addPetXp: multi-level rollover crosses multiple unlocks ────────
{
  const env = makeEnv();
  const guildId = 'g1', userId = 'u_big';
  seedPet(env, guildId, userId);
  // Total XP = 50 + 200 + 450 + 800 + 1250 = 2750 to reach L6.
  // Grant 3000 in one shot.
  const r = await addPetXp(env, userId, guildId, 3000, 'dungeon.win');
  ok('big grant crosses multiple levels',
     r.levelsCrossed >= 4, `crossed=${r.levelsCrossed} level=${r.level}`);
  const unlockedIds = (r.unlocked || []).map(a => a.id);
  ok('multi-level unlocks fire-breath (min_level=5)',
     unlockedIds.includes('fire-breath'),
     `unlocked=${unlockedIds.join(',')}`);
  ok('multi-level unlocks test-aura (min_level=2)',
     unlockedIds.includes('test-aura'));
}

// ── getPetLevel read ───────────────────────────────────────────────
{
  const env = makeEnv();
  const guildId = 'g1', userId = 'u_read';
  seedPet(env, guildId, userId, { level: 4, xp: 100 });
  const r = await getPetLevel(env, userId, guildId);
  ok('getPetLevel returns level',   r.level === 4);
  ok('getPetLevel returns xp',      r.xp === 100);
  ok('getPetLevel returns xpToNext', r.xpToNext === xpToNext(4));
  const none = await getPetLevel(env, userId, 'unknown-guild');
  ok('getPetLevel returns null for no-pet', none === null);
}

// ── listPetAbilities partitions ────────────────────────────────────
{
  const env = makeEnv();
  const guildId = 'g1', userId = 'u_list';
  seedPet(env, guildId, userId, {
    level: 3,
    abilities: ['big-appetite', 'test-aura'],
  });
  const r = await listPetAbilities(env, guildId, userId);
  const ownedIds = r.unlocked.map(a => a.id).sort();
  ok('owned abilities surfaced',
     ownedIds.includes('big-appetite') && ownedIds.includes('test-aura'),
     `owned=${ownedIds.join(',')}`);
  const upcomingIds = r.upcoming.map(a => a.id);
  ok('upcoming includes fire-breath (min_level=5)',
     upcomingIds.includes('fire-breath'),
     `upcoming=${upcomingIds.join(',')}`);
  ok('upcoming does not include owned',
     !upcomingIds.includes('big-appetite'));
  ok('upcoming sorted by min_level ascending',
     r.upcoming.every((a, i, arr) => i === 0 || arr[i-1].minLevel <= a.minLevel));
}

// ── tryEvolvePet at threshold ───────────────────────────────────────
{
  const env = makeEnv();
  const guildId = 'g1', userId = 'u_evo';
  // Level 3, qualifies for voltaic_drake (level 3, min_happiness=50).
  // Happiness is fresh 100 so condition passes.
  seedPet(env, guildId, userId, { level: 3 });
  const r = await tryEvolvePet(env, userId, guildId);
  ok('evolves at threshold', r.evolved === true,
     `evolved=${r.evolved} reason=${r.reason} new=${r.newSpecies}`);
  ok('new species = voltaic_drake',
     r.newSpecies === 'voltaic_drake', `new=${r.newSpecies}`);
  ok('fromSpecies recorded', r.fromSpecies === 'dragonling');
}

// ── tryEvolvePet falls back to lower-level rule when top blocked ───
{
  const env = makeEnv();
  const guildId = 'g1', userId = 'u_evo2';
  // Level 3 but happiness too low, voltaic_drake (min_happiness=50)
  // blocked, but ember_drake (level 2, no condition) qualifies.
  seedPet(env, guildId, userId, {
    level: 3,
    happiness: { value: 10, lastSetUtc: Date.now() },
  });
  const r = await tryEvolvePet(env, userId, guildId);
  ok('falls back to lower-level rule when condition blocks',
     r.evolved === true && r.newSpecies === 'ember_drake',
     `new=${r.newSpecies} reason=${r.reason}`);
}

// ── tryEvolvePet below threshold ───────────────────────────────────
{
  const env = makeEnv();
  const guildId = 'g1', userId = 'u_evo_low';
  seedPet(env, guildId, userId, { level: 1 });
  const r = await tryEvolvePet(env, userId, guildId);
  ok('does not evolve below threshold',
     r.evolved === false, `reason=${r.reason}`);
}

// ── autoEvolveCron sweep ───────────────────────────────────────────
{
  const env = makeEnv();
  seedPet(env, 'g1', 'cron_a', { level: 3 });                 // eligible
  seedPet(env, 'g1', 'cron_b', { level: 1 });                 // not eligible
  seedPet(env, 'g2', 'cron_c', { level: 5 });                 // eligible
  // Pre-existing released marker, should be skipped.
  env.LOADOUT_BOLTS._store.set('pet:released:g1:cron_d',
    JSON.stringify({ until: Date.now() + 1000 }));
  const r = await autoEvolveCron(env);
  ok('cron scanned all live pet records (released skipped)',
     r.scanned === 3, `scanned=${r.scanned}`);
  ok('cron evolved the eligible pets', r.evolved === 2, `evolved=${r.evolved}`);
  // After cron, eligible ones should have new species.
  const a = JSON.parse(env.LOADOUT_BOLTS._store.get('pet:g1:cron_a'));
  ok('cron-evolved pet has new species', a.species === 'voltaic_drake');
  const b = JSON.parse(env.LOADOUT_BOLTS._store.get('pet:g1:cron_b'));
  ok('low-level pet unchanged', b.species === 'dragonling');
}

// ── big-appetite XP bonus on feed source ───────────────────────────
{
  const env = makeEnv();
  const guildId = 'g1', userId = 'u_appetite';
  // Pre-grant the ability so the bonus applies immediately.
  seedPet(env, guildId, userId, { level: 1, xp: 0, abilities: ['big-appetite'] });
  const r = await addPetXp(env, userId, guildId, 10, 'feed');
  ok('big-appetite adds +2 XP on feed',
     r.appliedXp === 12, `appliedXp=${r.appliedXp}`);
}

// ── big-appetite ignored on non-feed source ───────────────────────
{
  const env = makeEnv();
  const guildId = 'g1', userId = 'u_no_bonus';
  seedPet(env, guildId, userId, { level: 1, xp: 0, abilities: ['big-appetite'] });
  const r = await addPetXp(env, userId, guildId, 10, 'dungeon.win');
  ok('big-appetite NOT applied on dungeon source',
     r.appliedXp === 10, `appliedXp=${r.appliedXp}`);
}

// ── addPetXp on no-pet returns error ──────────────────────────────
{
  const env = makeEnv();
  const r = await addPetXp(env, 'no-user', 'no-guild', 100, 'test');
  ok('no-pet path returns ok=false', r.ok === false && r.error === 'no-pet');
}

console.log('--- ' + passed + ' pass, ' + failed + ' fail ---');
if (failed > 0) process.exit(1);
