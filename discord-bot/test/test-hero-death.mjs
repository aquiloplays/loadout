// Standalone harness for hero-death.js — the soft-death + revive
// system layered onto the dungeon hero record. Stubs LOADOUT_BOLTS
// with the same in-memory KV pattern other tests use.
//
// Coverage:
//   - reviveCost scales with hero level (base 500, +25/level, cap 2500)
//   - isDead is a pure helper on hero.status
//   - killHero flips status → dead, sets diedAt + deathReason
//   - killHero destroys equipped gear AND removes those items from the bag
//     (so revive can't free-restore them via re-equip)
//   - killHero is idempotent on an already-dead hero
//   - reviveHero flips status → alive + restores hpCurrent to hpMax
//   - reviveHero rejects with not-dead on an alive hero
//   - useReviveElixir consumes one elixir + revives, atomically
//   - useReviveElixir rejects with no-elixir when bag is empty
//
// Run from repo root:
//   node discord-bot/test/test-hero-death.mjs

import {
  killHero, reviveHero, useReviveElixir, isDead, reviveCost,
  REVIVE_ITEM_ID, REVIVE_ITEM,
} from '../hero-death.js';

let failures = 0;
function assert(cond, label) {
  if (cond) console.log('  PASS: ' + label);
  else { failures++; console.log('  FAIL: ' + label); }
}
function eq(a, b, label) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) console.log('    expected', JSON.stringify(b), '\n    got     ', JSON.stringify(a));
  assert(ok, label);
}

// In-memory KV stub. hero-death only uses get/put with json type.
function makeKv() {
  const store = new Map();
  return {
    async put(key, value /*, opts */) {
      store.set(key, value);
    },
    async get(key, opts) {
      const v = store.get(key);
      if (v == null) return null;
      if (opts && opts.type === 'json') {
        try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; }
      }
      return v;
    },
    async delete(key) { store.delete(key); },
    _dump() { return store; },
  };
}

function mkHero(over = {}) {
  return Object.assign({
    avatar: '', className: 'warrior', custom: { name: 'Ironclad' },
    lookVersion: 1, locked: true, level: 5, xp: 100,
    hpMax: 30, hpCurrent: 12,
    status: 'alive', diedAt: null, deathReason: null,
    bag: [
      { id: 'iron-sword',  slot: 'weapon', name: 'Iron Sword',  goldValue: 60 },
      { id: 'steel-helm',  slot: 'head',   name: 'Steel Helm',  goldValue: 80 },
      { id: 'mystery-pot', slot: 'consumable', name: 'Mystery Potion', goldValue: 10 },
    ],
    equipped: { weapon: 'iron-sword', head: 'steel-helm' },
    duelsWon: 2, duelsLost: 1, dungeonsSurvived: 0, bossesSlain: 0,
    legendariesFound: 0, mythicsFound: 0,
    achievements: [], dungeonsVisited: [],
    createdUtc: '2026-01-01T00:00:00.000Z',
    lastUpdatedUtc: '2026-01-01T00:00:00.000Z',
  }, over);
}

const GUILD = 'g1', USER = 'u1';
const KEY = `d:hero:${GUILD}:${USER}`;

// ─── reviveCost ────────────────────────────────────────────────
console.log('reviveCost — scaling:');
eq(reviveCost({ level: 1 }),   500,  'L1  = 500 (base)');
eq(reviveCost({ level: 10 }),  725,  'L10 = 500 + 9*25');
eq(reviveCost({ level: 30 }), 1225,  'L30 = 500 + 29*25');
eq(reviveCost({ level: 99 }), 2500,  'L99 capped at 2500');
eq(reviveCost({}),             500,  'no level → base');
eq(reviveCost(null),           500,  'null hero → base (safe)');

// ─── isDead ────────────────────────────────────────────────────
console.log('isDead — pure helper:');
assert(isDead({ status: 'dead' })  === true,  '"dead" → true');
assert(isDead({ status: 'alive' }) === false, '"alive" → false');
assert(isDead({})                  === false, 'missing status → false');
assert(isDead(null)                === false, 'null → false');

// ─── REVIVE_ITEM catalogue entry ───────────────────────────────
console.log('REVIVE_ITEM catalogue:');
eq(REVIVE_ITEM.id,        REVIVE_ITEM_ID, 'id matches');
eq(REVIVE_ITEM.slot,      'consumable',   'slot is consumable');
eq(REVIVE_ITEM.goldValue, 500,            'base price 500');
assert(REVIVE_ITEM.consumable === true,   'consumable: true');

// ─── killHero ──────────────────────────────────────────────────
console.log('killHero — happy path:');
{
  const env = { LOADOUT_BOLTS: makeKv() };
  await env.LOADOUT_BOLTS.put(KEY, JSON.stringify(mkHero()));
  const res = await killHero(env, GUILD, USER, { reason: 'expedition' });
  assert(res.ok === true, 'ok=true');
  assert(!res.alreadyDead,  'not already-dead on first kill');
  eq(res.lostEquipped, { weapon: 'iron-sword', head: 'steel-helm' }, 'returns lost gear IDs');
  eq(res.reviveCost, 600, 'reviveCost for L5 = 500 + 4*25');

  const stored = JSON.parse(await env.LOADOUT_BOLTS.get(KEY));
  eq(stored.status, 'dead', 'status flipped to dead');
  assert(stored.diedAt && typeof stored.diedAt === 'string', 'diedAt stamped');
  eq(stored.deathReason, 'expedition', 'deathReason set');
  eq(stored.hpCurrent, 0, 'hpCurrent = 0');
  eq(stored.equipped, {},   'equipped cleared');
  // The two equipped items dropped from the bag; the unrelated mystery
  // potion stays.
  const bagIds = stored.bag.map(it => it.id);
  eq(bagIds, ['mystery-pot'], 'equipped items removed from bag, other items preserved');
}

console.log('killHero — idempotent on already-dead:');
{
  const env = { LOADOUT_BOLTS: makeKv() };
  await env.LOADOUT_BOLTS.put(KEY, JSON.stringify(mkHero({ status: 'dead' })));
  const res = await killHero(env, GUILD, USER);
  assert(res.ok === true, 'still ok');
  assert(res.alreadyDead === true, 'alreadyDead flag set');
}

// (no "missing hero" case — dungeon.loadHero always synthesizes a fresh
// hero, so the if(!hero) branch in killHero is defensive belt-and-braces.)

// ─── reviveHero ────────────────────────────────────────────────
console.log('reviveHero — happy path:');
{
  const env = { LOADOUT_BOLTS: makeKv() };
  const dead = mkHero({ status: 'dead', hpCurrent: 0, diedAt: '2026-05-29T00:00:00.000Z', deathReason: 'expedition', equipped: {} });
  await env.LOADOUT_BOLTS.put(KEY, JSON.stringify(dead));
  const res = await reviveHero(env, GUILD, USER);
  assert(res.ok === true, 'ok=true');
  eq(res.hero, { status: 'alive', hpCurrent: 30, hpMax: 30 }, 'returns alive @ full HP');

  const stored = JSON.parse(await env.LOADOUT_BOLTS.get(KEY));
  eq(stored.status, 'alive', 'persisted alive');
  eq(stored.diedAt, null,    'diedAt cleared');
  eq(stored.deathReason, null, 'deathReason cleared');
  eq(stored.hpCurrent, 30,    'hpCurrent = hpMax');
  eq(stored.equipped, {},     'equipped stays empty (lost gear stays lost)');
}

console.log('reviveHero — rejects an alive hero:');
{
  const env = { LOADOUT_BOLTS: makeKv() };
  await env.LOADOUT_BOLTS.put(KEY, JSON.stringify(mkHero()));
  const res = await reviveHero(env, GUILD, USER);
  assert(res.ok === false && res.error === 'not-dead', 'reports not-dead');
}

// ─── useReviveElixir ───────────────────────────────────────────
console.log('useReviveElixir — happy path: consume + revive atomically:');
{
  const env = { LOADOUT_BOLTS: makeKv() };
  const dead = mkHero({
    status: 'dead', hpCurrent: 0,
    bag: [
      { id: REVIVE_ITEM_ID, slot: 'consumable', name: 'Revive Elixir', goldValue: 500, consumable: true },
      { id: 'mystery-pot',  slot: 'consumable', name: 'Mystery Potion', goldValue: 10 },
    ],
    equipped: {},
  });
  await env.LOADOUT_BOLTS.put(KEY, JSON.stringify(dead));
  const res = await useReviveElixir(env, GUILD, USER);
  assert(res.ok === true, 'ok=true');
  eq(res.hero, { status: 'alive', hpCurrent: 30, hpMax: 30 }, 'returns alive @ full HP');

  const stored = JSON.parse(await env.LOADOUT_BOLTS.get(KEY));
  eq(stored.status, 'alive', 'persisted alive');
  const bagIds = stored.bag.map(it => it.id);
  eq(bagIds, ['mystery-pot'], 'one elixir consumed, other bag items preserved');
}

console.log('useReviveElixir — no elixir in bag:');
{
  const env = { LOADOUT_BOLTS: makeKv() };
  const dead = mkHero({
    status: 'dead', hpCurrent: 0, equipped: {},
    bag: [{ id: 'mystery-pot', slot: 'consumable', name: 'Mystery Potion', goldValue: 10 }],
  });
  await env.LOADOUT_BOLTS.put(KEY, JSON.stringify(dead));
  const res = await useReviveElixir(env, GUILD, USER);
  assert(res.ok === false && res.error === 'no-elixir', 'reports no-elixir');
  eq(res.reviveCost, 600, 'includes reviveCost (L5) to drive buy CTA');
}

console.log('useReviveElixir — rejects an alive hero:');
{
  const env = { LOADOUT_BOLTS: makeKv() };
  const alive = mkHero({
    bag: [{ id: REVIVE_ITEM_ID, slot: 'consumable', name: 'Revive Elixir', goldValue: 500, consumable: true }],
  });
  await env.LOADOUT_BOLTS.put(KEY, JSON.stringify(alive));
  const res = await useReviveElixir(env, GUILD, USER);
  assert(res.ok === false && res.error === 'not-dead', 'reports not-dead');
  // Bag should NOT have been mutated.
  const stored = JSON.parse(await env.LOADOUT_BOLTS.get(KEY));
  const bagIds = stored.bag.map(it => it.id);
  eq(bagIds, [REVIVE_ITEM_ID], 'elixir NOT consumed when reject');
}

console.log('');
if (failures) {
  console.log(`FAIL — ${failures} assertion(s) failed`);
  process.exit(1);
} else {
  console.log('OK — all hero-death assertions passed');
}
