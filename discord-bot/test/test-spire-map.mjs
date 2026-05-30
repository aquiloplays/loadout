// Unit tests for spire-map.js — covers map generation invariants,
// determinism, advance/resolve dispatch, and weighted-outcome
// resolution.

import {
  NODE_TYPES, generateMap, makeRng,
  getMapForRun, saveMap, advanceTo, resolveNode,
  __internals,
} from '../spire-map.js';

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } }
function eq(a, b, m)  { if (a === b) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m, '(want:', b, 'got:', a, ')'); } }

// ── In-memory D1 mock (just enough for spire_run_map ops) ────────
function makeMockDb() {
  const rows = new Map(); // run_id -> row obj
  function prepare(sql) {
    const s = String(sql).trim().toLowerCase();
    return {
      _sql: s,
      _binds: [],
      bind(...args) { this._binds = args; return this; },
      async first() {
        if (s.startsWith('select')) {
          const runId = String(this._binds[0]);
          return rows.get(runId) || null;
        }
        return null;
      },
      async run() {
        // crude UPSERT detect: presence of 'insert into spire_run_map'
        if (s.startsWith('insert')) {
          const [run_id, map_json, current_node, completed_nodes, updated_at] = this._binds;
          rows.set(String(run_id), {
            run_id: String(run_id), map_json, current_node, completed_nodes, updated_at,
          });
          return { meta: {} };
        }
        return { meta: {} };
      },
      async all() { return { results: Array.from(rows.values()) }; },
    };
  }
  return { prepare, __rows: rows };
}

function mockEnv() {
  return { DB: makeMockDb(), AQUILO_SITE_WEB_SECRET: 'test-secret' };
}

// ── Test suite ───────────────────────────────────────────────────

console.log('— NODE_TYPES frozen 7-type roster');
{
  eq(NODE_TYPES.length, 7, '7 node types');
  for (const t of ['combat','elite','rest','shop','treasure','event','boss']) {
    assert(NODE_TYPES.includes(t), `includes ${t}`);
  }
  assert(Object.isFrozen(NODE_TYPES), 'array is frozen');
}

console.log('— generateMap shape + invariants (ember-court / runA)');
{
  const m = generateMap('ember-court', 'runA');
  eq(m.totalFloors, 10, '10 floors total');
  assert(typeof m.width === 'number' && m.width > 0, 'width is a positive number');
  assert(m.nodes.length >= 20, `>=20 nodes (got ${m.nodes.length})`);

  // Floor 1 is 2-3 combat nodes.
  const f1 = m.nodes.filter(n => n.floor === 1);
  assert(f1.length >= 2 && f1.length <= 3, `floor 1 width 2-3 (got ${f1.length})`);
  for (const n of f1) eq(n.type, 'combat', `floor 1 node ${n.id} is combat`);

  // Floor 10 is exactly 1 boss.
  const f10 = m.nodes.filter(n => n.floor === 10);
  eq(f10.length, 1, 'floor 10 has exactly 1 node');
  eq(f10[0].type, 'boss', 'floor 10 is boss');

  // Middle floors are 3-5 wide.
  for (let f = 2; f <= 9; f++) {
    const widthF = m.nodes.filter(n => n.floor === f).length;
    assert(widthF >= 3 && widthF <= 5, `floor ${f} width 3-5 (got ${widthF})`);
  }
}

console.log('— generateMap constraint floors satisfied');
{
  // Run many seeds and verify the placement constraints hold every time.
  for (let i = 0; i < 30; i++) {
    const m = generateMap('aurora-spire', `seed-${i}`);
    const restF4_6  = m.nodes.filter(n => n.type === 'rest'  && n.floor >= 4 && n.floor <= 6).length;
    const eliteF3_6 = m.nodes.filter(n => n.type === 'elite' && n.floor >= 3 && n.floor <= 6).length;
    const shopAll   = m.nodes.filter(n => n.type === 'shop').length;
    const shopF5_6  = m.nodes.filter(n => n.type === 'shop' && (n.floor === 5 || n.floor === 6)).length;
    const treasure  = m.nodes.filter(n => n.type === 'treasure').length;
    const events    = m.nodes.filter(n => n.type === 'event').length;
    assert(restF4_6  >= 1, `seed ${i}: rest in floors 4-6`);
    assert(eliteF3_6 >= 1, `seed ${i}: elite in floors 3-6`);
    assert(shopAll   === 1, `seed ${i}: exactly 1 shop (got ${shopAll})`);
    assert(shopF5_6  === 1, `seed ${i}: shop on floor 5 or 6`);
    assert(treasure  >= 1, `seed ${i}: at least 1 treasure`);
    assert(events    >= 2 && events <= 3, `seed ${i}: 2-3 events (got ${events})`);
  }
}

console.log('— generateMap forms a DAG where every node reaches boss');
{
  const m = generateMap('sunken-vault', 'reach-test');
  const byId = new Map(m.nodes.map(n => [n.id, n]));

  // Build forward adjacency from parentIds.
  const children = new Map();
  for (const n of m.nodes) {
    for (const pid of n.parentIds) {
      if (!children.has(pid)) children.set(pid, []);
      children.get(pid).push(n.id);
    }
  }

  // BFS from each non-boss node forward; must hit the boss.
  const boss = m.nodes.find(n => n.type === 'boss');
  for (const start of m.nodes) {
    if (start.id === boss.id) continue;
    const seen = new Set([start.id]);
    const queue = [start.id];
    let reachedBoss = false;
    while (queue.length) {
      const cur = queue.shift();
      if (cur === boss.id) { reachedBoss = true; break; }
      for (const c of (children.get(cur) || [])) {
        if (!seen.has(c)) { seen.add(c); queue.push(c); }
      }
    }
    assert(reachedBoss, `node ${start.id} (floor ${start.floor}, ${start.type}) reaches boss`);
  }

  // No edge skips a floor: every parent->child crosses exactly 1 floor.
  for (const n of m.nodes) {
    for (const pid of n.parentIds) {
      const p = byId.get(pid);
      assert(p && p.floor === n.floor - 1, `edge ${pid}→${n.id} crosses exactly 1 floor`);
    }
  }
}

console.log('— generateMap is deterministic for same (theme, runId)');
{
  const a = generateMap('frost-citadel', 'same-run');
  const b = generateMap('frost-citadel', 'same-run');
  eq(JSON.stringify(a), JSON.stringify(b), 'identical map for identical seed');

  const c = generateMap('frost-citadel', 'different-run');
  assert(JSON.stringify(a) !== JSON.stringify(c), 'different runId → different map');

  const d = generateMap('ember-court', 'same-run');
  assert(JSON.stringify(a) !== JSON.stringify(d), 'different theme → different map');
}

console.log('— saveMap + getMapForRun round-trip');
{
  const env = mockEnv();
  const m = generateMap('verdant-hollow', 'rt-1');
  await saveMap(env, 'rt-1', m);
  const got = await getMapForRun(env, 'rt-1');
  assert(got && got.map, 'round-trip returns map');
  eq(got.map.nodes.length, m.nodes.length, 'node count matches');
  eq(got.currentNode, null, 'currentNode null on fresh save');
  eq(got.completedNodes.length, 0, 'completedNodes empty on fresh save');
}

console.log('— advanceTo: entry node accepted, non-entry rejected');
{
  const env = mockEnv();
  const m = generateMap('verdant-hollow', 'adv-1');
  await saveMap(env, 'adv-1', m);
  const f1 = m.nodes.find(n => n.floor === 1);
  const f2 = m.nodes.find(n => n.floor === 2);

  // Pre-entry: floor-2 node must be rejected as 'not-entry'.
  const bad = await advanceTo(env, 'adv-1', f2.id);
  assert(!bad.ok && bad.error === 'not-entry', 'pre-entry: non-floor-1 rejected');

  const ok = await advanceTo(env, 'adv-1', f1.id);
  assert(ok.ok, 'entry pick accepted');
  eq(ok.currentNode, f1.id, 'currentNode updated');
}

console.log('— advanceTo: rejects non-child of currentNode');
{
  const env = mockEnv();
  const m = generateMap('mirror-garden', 'adv-2');
  await saveMap(env, 'adv-2', m);
  const f1 = m.nodes.find(n => n.floor === 1);
  await advanceTo(env, 'adv-2', f1.id);

  // Find a floor-2 node that is NOT a child of f1.
  const f2nonChild = m.nodes.find(n => n.floor === 2 && !n.parentIds.includes(f1.id));
  if (f2nonChild) {
    const r = await advanceTo(env, 'adv-2', f2nonChild.id);
    assert(!r.ok && r.error === 'not-child', 'non-child floor-2 rejected');
  } else {
    // If all f2 nodes happen to be children, validate a floor-3 leap.
    const f3 = m.nodes.find(n => n.floor === 3);
    const r = await advanceTo(env, 'adv-2', f3.id);
    assert(!r.ok && r.error === 'not-child', 'floor-3 leap rejected as non-child');
  }

  // Valid child IS accepted.
  const f2Child = m.nodes.find(n => n.floor === 2 && n.parentIds.includes(f1.id));
  if (f2Child) {
    const ok = await advanceTo(env, 'adv-2', f2Child.id);
    assert(ok.ok, 'valid child accepted');
    assert(ok.completedNodes.includes(f1.id), 'previous node moved to completed');
  }
}

console.log('— resolveNode: combat dispatches with npcDeck');
{
  const env = mockEnv();
  const m = generateMap('clockwork-foundry', 'res-1');
  await saveMap(env, 'res-1', m);
  const f1Combat = m.nodes.find(n => n.floor === 1 && n.type === 'combat');
  await advanceTo(env, 'res-1', f1Combat.id);
  const r = await resolveNode(env, 'res-1', f1Combat.id);
  assert(r.ok, 'resolve combat ok');
  eq(r.type, 'combat-needed', 'type is combat-needed');
  assert(r.npcDeck && typeof r.npcDeck === 'object', 'npcDeck payload present');
}

console.log('— resolveNode: rest requires choice, heal vs upgrade');
{
  const env = mockEnv();
  const m = generateMap('cinder-apex', 'res-2');
  // Force a rest node onto current floor by walking until we hit one.
  await saveMap(env, 'res-2', m);
  // Use a synthetic minimal map with a rest node as floor 1 for
  // deterministic dispatch.
  const synthetic = {
    seasonTheme: 'cinder-apex', runId: 'res-2', width: 7, totalFloors: 10,
    nodes: [
      { id: 'r1', floor: 1, x: 3, type: 'rest', encounter: { healPercent: 50 }, parentIds: [] },
    ],
  };
  await saveMap(env, 'res-2', synthetic);
  await advanceTo(env, 'res-2', 'r1');

  const noChoice = await resolveNode(env, 'res-2', 'r1');
  assert(!noChoice.ok && noChoice.error === 'choice-required', 'rest with no choice → error');

  const heal = await resolveNode(env, 'res-2', 'r1', 'heal');
  assert(heal.ok && heal.type === 'rest-heal' && heal.healPercent === 50, 'heal returns 50%');

  const upgrade = await resolveNode(env, 'res-2', 'r1', 'upgrade');
  assert(upgrade.ok && upgrade.type === 'rest-upgrade-instruction', 'upgrade returns instruction');
}

console.log('— resolveNode: shop returns inventory');
{
  const env = mockEnv();
  const synthetic = {
    seasonTheme: 'sandstorm-bazaar', runId: 'res-shop', width: 7, totalFloors: 10,
    nodes: [
      { id: 's1', floor: 1, x: 3, type: 'shop', encounter: { inventorySeed: 'shop-seed-1' }, parentIds: [] },
    ],
  };
  await saveMap(env, 'res-shop', synthetic);
  await advanceTo(env, 'res-shop', 's1');
  const r = await resolveNode(env, 'res-shop', 's1');
  assert(r.ok && r.type === 'shop', 'shop dispatch ok');
  assert(Array.isArray(r.inventory) && r.inventory.length >= 3, `inventory has 3+ items (got ${r.inventory?.length})`);
  assert(r.inventory.every(it => typeof it.price === 'number' && it.price > 0), 'all items have price > 0');
}

console.log('— resolveNode: treasure offer then grant');
{
  const env = mockEnv();
  const synthetic = {
    seasonTheme: 'stargazer-court', runId: 'res-trz', width: 7, totalFloors: 10,
    nodes: [
      { id: 't1', floor: 1, x: 3, type: 'treasure', encounter: { rarityFloor: 'rare' }, parentIds: [] },
    ],
  };
  await saveMap(env, 'res-trz', synthetic);
  await advanceTo(env, 'res-trz', 't1');
  const offer = await resolveNode(env, 'res-trz', 't1');
  assert(offer.ok && offer.type === 'treasure-offer', 'treasure offers cards');
  assert(Array.isArray(offer.cards) && offer.cards.length === 3, '3 cards offered');

  const grant = await resolveNode(env, 'res-trz', 't1', offer.cards[0].cardId);
  assert(grant.ok && grant.type === 'treasure-grant', 'treasure grants picked card');
  eq(grant.cardId, offer.cards[0].cardId, 'granted cardId matches picked');

  const bad = await resolveNode(env, 'res-trz', 't1', 'not-an-id');
  assert(!bad.ok && bad.error === 'invalid-choice', 'invalid choice rejected');
}

console.log('— resolveNode: event honors weighted outcomes with mocked RNG');
{
  // Use pickOutcome directly with a controlled RNG.
  const { pickOutcome } = __internals;
  const outcomes = [
    { weight: 80, label: 'A' },
    { weight: 20, label: 'B' },
  ];
  // RNG that returns 0.5 → 0.5 * 100 = 50 → falls into the 80 bucket.
  const rng = () => 0.5;
  const r1 = pickOutcome(outcomes, rng);
  eq(r1.label, 'A', 'mid-roll picks high-weight outcome');

  // RNG that returns 0.9 → 0.9 * 100 = 90 → past 80, into 'B'.
  const rng2 = () => 0.9;
  const r2 = pickOutcome(outcomes, rng2);
  eq(r2.label, 'B', 'high-roll picks low-weight outcome');

  // Edge: empty outcomes returns null.
  eq(pickOutcome([], rng), null, 'empty outcomes → null');
}

console.log('— resolveNode: event resolves via fallback catalogue + weighted outcomes');
{
  const env = mockEnv();
  const synthetic = {
    seasonTheme: 'ember-court', runId: 'res-evt', width: 7, totalFloors: 10,
    nodes: [
      { id: 'e1', floor: 1, x: 3, type: 'event', encounter: { eventId: 'ember-court:event:42' }, parentIds: [] },
    ],
  };
  await saveMap(env, 'res-evt', synthetic);
  await advanceTo(env, 'res-evt', 'e1');

  const offer = await resolveNode(env, 'res-evt', 'e1');
  assert(offer.ok && offer.type === 'event', 'event dispatch returns event def');
  assert(offer.event && Array.isArray(offer.event.choices), 'event has choices');

  const chosen = offer.event.choices[0];
  const r = await resolveNode(env, 'res-evt', 'e1', chosen.id);
  assert(r.ok && r.type === 'event-resolved', 'event resolves with outcome');
  assert(r.outcome && r.outcome.effect, 'outcome has an effect payload');
}

console.log('— resolveNode: boss returns npcDeck reference');
{
  const env = mockEnv();
  const synthetic = {
    seasonTheme: 'bone-reliquary', runId: 'res-boss', width: 7, totalFloors: 10,
    nodes: [
      { id: 'b1', floor: 1, x: 3, type: 'boss', encounter: { npcId: 'bone-reliquary.boss', difficulty: 'boss' }, parentIds: [] },
    ],
  };
  await saveMap(env, 'res-boss', synthetic);
  await advanceTo(env, 'res-boss', 'b1');
  const r = await resolveNode(env, 'res-boss', 'b1');
  assert(r.ok && r.type === 'boss', 'boss dispatch ok');
  eq(r.npcDeck.npcId, 'bone-reliquary.boss', 'boss npcId references monthly boss');
}

console.log('');
console.log(`PASSED — ${pass} ok / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
