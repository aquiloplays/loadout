// Spire Map, Slay-the-Spire-style branching path per run.
//
// Generates a 10-floor DAG of nodes (combat, elite, rest, shop,
// treasure, event, boss) deterministically from (seasonTheme, runId)
// so the same run always renders the same map. Players advance one
// node at a time; each node type dispatches differently when
// resolved (combat starts a Boltbound NPC fight, rest heals or
// upgrades, etc.).
//
// FOG-OF-WAR CONTRACT
// -------------------
// The worker returns the FULL map JSON. The site renderer is
// responsible for masking floors > currentFloor+1 so the player
// only sees the next floor of choices. Future floors are present
// in the payload but should be visually obscured by the client.
// This keeps map state authoritative on the worker (cheat-resistant
// for the connectivity graph) while letting the renderer animate
// the "next floor reveal" without a round-trip.
//
// EVENT CATALOGUE
// ---------------
// Event nodes reference per-theme event definitions in
// spire/events/<theme>.js. We import that catalogue dynamically
// (not statically) so cold-start doesn't pay for 12 theme files
// when a run only ever touches one. The lookup falls back to a
// generic "wanderer" event if the theme module isn't shipped yet.
//
// STORAGE
// -------
// spire_run_map (D1):
//   run_id         TEXT PRIMARY KEY
//   map_json       TEXT
//   current_node   TEXT
//   completed_nodes TEXT  (JSON array of node ids)
//   updated_at     INTEGER (ms epoch, for cleanup queries)

import { CARDS } from './cards-content.js';

// ── Constants ────────────────────────────────────────────────────

export const NODE_TYPES = Object.freeze([
  'combat', 'elite', 'rest', 'shop', 'treasure', 'event', 'boss',
]);

const TOTAL_FLOORS  = 10;
const ENTRY_MIN     = 2;   // floor 1 width range
const ENTRY_MAX     = 3;
const MID_MIN       = 3;   // floors 2-9 width range
const MID_MAX       = 5;
const MAP_WIDTH     = 7;   // logical slot count (0..MAP_WIDTH-1) for renderer x

// ── PRNG (mulberry32, copied from daily-quests.js pattern) ──────

export function makeRng(seedStr) {
  let h = 1779033703 ^ String(seedStr || '').length;
  const s0 = String(seedStr || '');
  for (let i = 0; i < s0.length; i++) {
    h = Math.imul(h ^ s0.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let s = (h >>> 0) || 1;
  return function rng() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rngInt(rng, min, max) {
  // inclusive on both ends
  return Math.floor(rng() * (max - min + 1)) + min;
}

function rngPick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

// ── Map generation ───────────────────────────────────────────────

// Pick floor widths under the constraint that every floor has at
// least 2 nodes and no more than MID_MAX. Floor 1 uses entry width,
// floor 10 is always 1 (boss).
function floorWidths(rng) {
  const widths = new Array(TOTAL_FLOORS).fill(0);
  widths[0] = rngInt(rng, ENTRY_MIN, ENTRY_MAX);
  for (let f = 1; f < TOTAL_FLOORS - 1; f++) {
    widths[f] = rngInt(rng, MID_MIN, MID_MAX);
  }
  widths[TOTAL_FLOORS - 1] = 1;
  return widths;
}

// Choose a slot index (0..MAP_WIDTH-1) for each node on a floor.
// Spread evenly: divide the width into `count` buckets and pick a
// jittered point within each. Guarantees unique x per node.
function slotsForCount(rng, count) {
  if (count <= 1) return [Math.floor(MAP_WIDTH / 2)];
  const out = [];
  const bucketSize = MAP_WIDTH / count;
  for (let i = 0; i < count; i++) {
    const lo = Math.floor(i * bucketSize);
    const hi = Math.max(lo, Math.floor((i + 1) * bucketSize) - 1);
    out.push(rngInt(rng, lo, hi));
  }
  return out;
}

// Assign node types to non-entry, non-boss floors. Honors the
// constraints in the spec:
//   ≥1 rest between floors 4-6
//   ≥1 elite between floors 3-6
//   1 shop on floor 5 OR 6
//   1 treasure guaranteed somewhere
//   2-3 event nodes scattered
// Everything else defaults to 'combat'.
function assignTypes(rng, widths) {
  // Build a flat list of placeholder slots [{floor, idxInFloor}].
  const slots = [];
  for (let f = 0; f < TOTAL_FLOORS; f++) {
    for (let i = 0; i < widths[f]; i++) slots.push({ floor: f + 1, i, type: 'combat' });
  }

  // Floor 1 is always combat, already defaulted.
  // Floor 10 is the boss.
  for (const s of slots) {
    if (s.floor === TOTAL_FLOORS) s.type = 'boss';
  }

  // Helper: pool of slots filtered by floor range, type=='combat'.
  const pool = (lo, hi) => slots.filter(s =>
    s.floor >= lo && s.floor <= hi && s.type === 'combat'
  );
  // Helper: shuffle small arrays (Fisher-Yates with seeded rng).
  const shuffle = (arr) => {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };

  // ≥1 elite between floors 3-6 (place 1-2)
  const eliteCount = rngInt(rng, 1, 2);
  const eliteCandidates = shuffle(pool(3, 6));
  for (let i = 0; i < eliteCount && i < eliteCandidates.length; i++) {
    eliteCandidates[i].type = 'elite';
  }

  // ≥1 rest between floors 4-6 (place 1-2)
  const restCount = rngInt(rng, 1, 2);
  const restCandidates = shuffle(pool(4, 6));
  for (let i = 0; i < restCount && i < restCandidates.length; i++) {
    restCandidates[i].type = 'rest';
  }

  // 1 shop on floor 5 or 6
  const shopFloor = rng() < 0.5 ? 5 : 6;
  const shopCandidates = shuffle(pool(shopFloor, shopFloor));
  if (shopCandidates.length) shopCandidates[0].type = 'shop';
  else {
    // Floor was fully consumed by elites/rests, try the other.
    const fallback = shuffle(pool(shopFloor === 5 ? 6 : 5, shopFloor === 5 ? 6 : 5));
    if (fallback.length) fallback[0].type = 'shop';
  }

  // 1 treasure guaranteed (place anywhere in floors 2-9)
  const treasureCandidates = shuffle(pool(2, 9));
  if (treasureCandidates.length) treasureCandidates[0].type = 'treasure';

  // 2-3 event nodes scattered in floors 2-9
  const eventCount = rngInt(rng, 2, 3);
  const eventCandidates = shuffle(pool(2, 9));
  for (let i = 0; i < eventCount && i < eventCandidates.length; i++) {
    eventCandidates[i].type = 'event';
  }

  return slots;
}

// Connect each node to 1-3 children on the next floor. Algorithm:
//   - For each parent, pick 1-3 children on next floor at random.
//   - Then sweep next floor: any child with zero parents gets one
//     assigned from the nearest parent.
// This guarantees the graph is a DAG where every node is reachable
// from at least one entry and every node has a path forward
// (children) until the boss.
function connectFloors(rng, nodesById, widths) {
  // Group nodes by floor for fast adjacency.
  const byFloor = new Array(TOTAL_FLOORS + 1).fill(null).map(() => []);
  for (const n of Object.values(nodesById)) byFloor[n.floor].push(n);

  for (let f = 1; f < TOTAL_FLOORS; f++) {
    const parents  = byFloor[f];
    const children = byFloor[f + 1];
    if (!parents.length || !children.length) continue;

    // Each parent picks 1-min(3, childrenCount) children.
    for (const p of parents) {
      const wantCount = rngInt(rng, 1, Math.min(3, children.length));
      // Prefer children whose x is near the parent's x.
      const sorted = children
        .slice()
        .sort((a, b) => Math.abs(a.x - p.x) - Math.abs(b.x - p.x));
      // Take the nearest `wantCount`, but with a little randomness
      // so multiple parents don't collapse onto one child.
      const taken = new Set();
      while (taken.size < wantCount) {
        // Top-3 candidate pool, weighted toward nearest.
        const pickFrom = sorted.slice(0, Math.min(sorted.length, 3));
        const pick = pickFrom[Math.floor(rng() * pickFrom.length)];
        taken.add(pick.id);
        // Remove picked from `sorted` so we don't re-pick.
        const idx = sorted.findIndex(s => s.id === pick.id);
        if (idx >= 0) sorted.splice(idx, 1);
        if (!sorted.length) break;
      }
      for (const childId of taken) {
        const child = nodesById[childId];
        if (!child.parentIds.includes(p.id)) child.parentIds.push(p.id);
      }
    }

    // Orphan sweep, any child with no parents gets the nearest one.
    for (const c of children) {
      if (c.parentIds.length) continue;
      const nearest = parents.slice()
        .sort((a, b) => Math.abs(a.x - c.x) - Math.abs(b.x - c.x))[0];
      if (nearest) c.parentIds.push(nearest.id);
    }
  }
}

// Verify every node has a forward path to the boss. Done by reverse
// BFS from the boss, any node not reached gets a synthesised edge
// from itself to a nearest reachable next-floor node. Defensive; with
// the orphan sweep above this is rarely needed.
function ensureBossReachable(nodesById) {
  const boss = Object.values(nodesById).find(n => n.type === 'boss');
  if (!boss) return;
  // Build child→parent reverse adjacency from the parent edges.
  const reachable = new Set([boss.id]);
  // BFS backwards through parentIds.
  const frontier = [boss];
  while (frontier.length) {
    const n = frontier.shift();
    for (const pid of n.parentIds) {
      if (!reachable.has(pid)) {
        reachable.add(pid);
        frontier.push(nodesById[pid]);
      }
    }
  }
  // Any non-reachable node: add an edge to a reachable next-floor
  // node. We do this by appending the orphan as a parent of the
  // nearest reachable child.
  const allIds = Object.keys(nodesById);
  for (const id of allIds) {
    if (reachable.has(id)) continue;
    const n = nodesById[id];
    const nextFloor = Object.values(nodesById)
      .filter(x => x.floor === n.floor + 1 && reachable.has(x.id))
      .sort((a, b) => Math.abs(a.x - n.x) - Math.abs(b.x - n.x));
    if (nextFloor.length) {
      nextFloor[0].parentIds.push(n.id);
      reachable.add(n.id);
    }
  }
}

// Build an encounter payload per node. The payload is opaque to the
// generator, resolveNode reads it back at resolution time. Combat /
// elite / boss encode an NPC seed; event encodes the eventId.
function encounterFor(node, theme, rng) {
  switch (node.type) {
    case 'combat':
    case 'elite':
      return {
        npcSeed: `${theme}:${node.id}:${node.type}`,
        difficulty: node.type === 'elite' ? 'hard' : 'medium',
      };
    case 'boss':
      // npcId references the existing monthly Spire boss; the deck
      // generator resolves it via spire_npcs by themeId.
      return { npcId: `${theme}.boss`, difficulty: 'boss' };
    case 'event':
      // eventId selected at generation time, actual outcomes are
      // looked up at resolve time from the event catalogue.
      return { eventId: `${theme}:event:${Math.floor(rng() * 1_000_000)}` };
    case 'treasure':
      return { rarityFloor: 'rare' };
    case 'shop':
      return { inventorySeed: `${theme}:${node.id}` };
    case 'rest':
      return { healPercent: 50 };
    default:
      return {};
  }
}

export function generateMap(seasonTheme, runId, opts = {}) {
  const seed = `spire-map:${seasonTheme}:${runId}`;
  const rng = opts.rng || makeRng(seed);
  const widths = floorWidths(rng);

  // Pre-assign types using the placeholder slot list.
  const placeholders = assignTypes(rng, widths);

  // Build the canonical nodes (with x slots + ids).
  const nodesById = Object.create(null);
  let idCounter = 0;
  for (let f = 1; f <= TOTAL_FLOORS; f++) {
    const onFloor = placeholders.filter(s => s.floor === f);
    const xs = slotsForCount(rng, onFloor.length);
    for (let i = 0; i < onFloor.length; i++) {
      const slot = onFloor[i];
      const id = `n${++idCounter}`;
      const node = {
        id,
        floor: f,
        x: xs[i],
        type: slot.type,
        encounter: null,
        parentIds: [],
      };
      node.encounter = encounterFor(node, seasonTheme, rng);
      nodesById[id] = node;
    }
  }

  connectFloors(rng, nodesById, widths);
  ensureBossReachable(nodesById);

  return {
    seasonTheme,
    runId,
    width: MAP_WIDTH,
    totalFloors: TOTAL_FLOORS,
    nodes: Object.values(nodesById),
  };
}

// ── D1 helpers ───────────────────────────────────────────────────

async function db(env) {
  if (!env.DB) throw new Error('spire-map: no D1 binding (env.DB missing)');
  return env.DB;
}

async function loadMapRow(env, runId) {
  const D = await db(env);
  const row = await D.prepare(
    `SELECT run_id, map_json, current_node, completed_nodes, updated_at
       FROM spire_run_map WHERE run_id = ? LIMIT 1`
  ).bind(String(runId)).first();
  return row || null;
}

async function writeMapRow(env, runId, mapJson, currentNode, completed) {
  const D = await db(env);
  const now = Date.now();
  await D.prepare(
    `INSERT INTO spire_run_map (run_id, map_json, current_node, completed_nodes, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET
       map_json = excluded.map_json,
       current_node = excluded.current_node,
       completed_nodes = excluded.completed_nodes,
       updated_at = excluded.updated_at`
  ).bind(
    String(runId), mapJson, currentNode || null,
    JSON.stringify(completed || []), now,
  ).run();
}

function parseRow(row) {
  if (!row) return null;
  let map = null, completed = [];
  try { map = JSON.parse(row.map_json); } catch { map = null; }
  try { completed = JSON.parse(row.completed_nodes || '[]'); } catch { completed = []; }
  return { map, currentNode: row.current_node || null, completedNodes: completed };
}

// ── Public storage API ──────────────────────────────────────────

export async function getMapForRun(env, runId) {
  const row = await loadMapRow(env, runId);
  return parseRow(row);
}

// Persists a freshly-generated map. currentNode is null until the
// player picks an entry node via advanceTo (or callers can seed it
// to the first entry node themselves).
export async function saveMap(env, runId, map, currentNode = null) {
  await writeMapRow(env, runId, JSON.stringify(map), currentNode, []);
}

// Validates that nodeId is either an entry node (currentNode==null,
// nodeId.floor==1) or a direct child of currentNode. Updates the
// row + appends to completedNodes.
export async function advanceTo(env, runId, nodeId) {
  const row = await loadMapRow(env, runId);
  if (!row) return { ok: false, error: 'no-map' };
  const parsed = parseRow(row);
  if (!parsed?.map) return { ok: false, error: 'corrupt-map' };
  const target = parsed.map.nodes.find(n => n.id === nodeId);
  if (!target) return { ok: false, error: 'unknown-node' };
  // Entry pick (no current node yet), must be floor 1.
  if (!parsed.currentNode) {
    if (target.floor !== 1) return { ok: false, error: 'not-entry' };
  } else {
    // Must be a child of currentNode (i.e. currentNode in parentIds).
    if (!target.parentIds.includes(parsed.currentNode)) {
      return { ok: false, error: 'not-child', currentNode: parsed.currentNode };
    }
  }
  const completed = parsed.completedNodes.slice();
  if (parsed.currentNode && !completed.includes(parsed.currentNode)) {
    completed.push(parsed.currentNode);
  }
  await writeMapRow(env, runId, JSON.stringify(parsed.map), nodeId, completed);
  return { ok: true, currentNode: nodeId, completedNodes: completed };
}

// ── Event catalogue lookup ──────────────────────────────────────

let _eventCatalogueP = null;
async function loadEventCatalogue() {
  if (_eventCatalogueP) return _eventCatalogueP;
  _eventCatalogueP = (async () => {
    try {
      const mod = await import('./spire/events/index.js');
      return mod.EVENTS_BY_THEME || {};
    } catch {
      // The theme files aren't shipped yet, return an empty
      // catalogue. resolveNode falls back to a generic "wanderer"
      // event so the resolver still returns a sensible payload.
      return {};
    }
  })();
  return _eventCatalogueP;
}

const FALLBACK_EVENT = Object.freeze({
  id: 'fallback-wanderer',
  name: 'A Wandering Stranger',
  description: 'A figure offers an exchange, coin for a small risk.',
  choices: [
    {
      id: 'accept',
      label: 'Accept the trade',
      outcomes: [
        { weight: 70, effect: { type: 'bolts_gain', amount: 25 }, text: 'You pocket some bolts.' },
        { weight: 30, effect: { type: 'hp_loss',    amount: 3  }, text: 'The deal cost you.' },
      ],
    },
    {
      id: 'decline',
      label: 'Walk past',
      outcomes: [{ weight: 100, effect: { type: 'none' }, text: 'You move on.' }],
    },
  ],
});

async function lookupEvent(themeId, eventId) {
  const cat = await loadEventCatalogue();
  const themed = cat[themeId];
  if (!Array.isArray(themed) || !themed.length) return FALLBACK_EVENT;
  // eventId may not match a real catalogue entry, use it as a seed
  // to pick one deterministically.
  const rng = makeRng(`${themeId}:${eventId}`);
  return themed[Math.floor(rng() * themed.length)] || FALLBACK_EVENT;
}

// Pick a weighted outcome from a list. Outcomes are { weight, ... }.
// Total weight is not assumed to sum to 100, we normalise.
function pickOutcome(outcomes, rng) {
  if (!Array.isArray(outcomes) || !outcomes.length) return null;
  const total = outcomes.reduce((s, o) => s + Math.max(1, o.weight || 1), 0);
  let pick = rng() * total;
  for (const o of outcomes) {
    pick -= Math.max(1, o.weight || 1);
    if (pick <= 0) return o;
  }
  return outcomes[outcomes.length - 1];
}

// ── Per-node resolvers ──────────────────────────────────────────

function rarityRank(r) {
  return ({ common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 })[r] ?? -1;
}

function rarePlusCards() {
  // Built lazily, the catalogue can be large. Module-level cache.
  if (rarePlusCards._cache) return rarePlusCards._cache;
  const out = Object.values(CARDS || {})
    .filter(c => !c?.token && c?.type !== 'champion')
    .filter(c => rarityRank(c?.rarity) >= 2);
  rarePlusCards._cache = out;
  return out;
}

function buildShopInventory(seed) {
  const rng = makeRng(seed);
  const pool = rarePlusCards();
  const count = rngInt(rng, 3, 5);
  const out = [];
  const seen = new Set();
  let safety = 0;
  while (out.length < count && pool.length && safety++ < 200) {
    const c = rngPick(rng, pool);
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    // Price: rare=120, epic=220, legendary=400 (rough Spire economy).
    const price = c.rarity === 'legendary' ? 400
                : c.rarity === 'epic'      ? 220 : 120;
    out.push({ kind: 'card', cardId: c.id, name: c.name, rarity: c.rarity, price });
  }
  // Throw in a single consumable.
  out.push({ kind: 'consumable', id: 'potion.heal-30', name: 'Healing Draught', price: 80 });
  return out;
}

function pickTreasureCards(seed) {
  const rng = makeRng(seed);
  const pool = rarePlusCards();
  const out = [];
  const seen = new Set();
  let safety = 0;
  while (out.length < 3 && pool.length && safety++ < 200) {
    const c = rngPick(rng, pool);
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push({ cardId: c.id, name: c.name, rarity: c.rarity });
  }
  return out;
}

// Dispatch by node type. Caller (worker route) is responsible for
// actually triggering the Boltbound NPC fight (combat/elite/boss),
// crediting bolts, applying card grants, etc., this function just
// computes the resolution payload.
export async function resolveNode(env, runId, nodeId, choice = null, opts = {}) {
  const parsed = await getMapForRun(env, runId);
  if (!parsed?.map) return { ok: false, error: 'no-map' };
  const node = parsed.map.nodes.find(n => n.id === nodeId);
  if (!node) return { ok: false, error: 'unknown-node' };
  // The node must be the player's current node (or an entry node
  // they're about to commit to).
  if (parsed.currentNode && parsed.currentNode !== nodeId) {
    return { ok: false, error: 'not-current-node', currentNode: parsed.currentNode };
  }
  if (!parsed.currentNode && node.floor !== 1) {
    return { ok: false, error: 'not-entry' };
  }
  const seed = `spire-resolve:${parsed.map.seasonTheme}:${runId}:${nodeId}`;
  const rng = opts.rng || makeRng(seed);

  switch (node.type) {
    case 'combat':
    case 'elite': {
      // Caller triggers the Boltbound NPC fight. The npcDeck shape
      // is just the encounter payload, the worker's combat route
      // will pass it to generateSpireNpcDeck.
      return {
        ok: true, type: 'combat-needed',
        node, npcDeck: node.encounter,
      };
    }
    case 'rest': {
      const c = String(choice || '').toLowerCase();
      if (c !== 'heal' && c !== 'upgrade') {
        return { ok: false, error: 'choice-required', choices: ['heal', 'upgrade'] };
      }
      if (c === 'heal') {
        return { ok: true, type: 'rest-heal', healPercent: node.encounter?.healPercent || 50 };
      }
      // 'upgrade', returns an instruction the caller hands off to
      // the deck-upgrade flow. cardId TBD by the site picker.
      return { ok: true, type: 'rest-upgrade-instruction' };
    }
    case 'shop': {
      const inventory = buildShopInventory(node.encounter?.inventorySeed || seed);
      return { ok: true, type: 'shop', inventory };
    }
    case 'treasure': {
      const offered = pickTreasureCards(seed);
      if (!choice) {
        // First call, show the 3 cards.
        return { ok: true, type: 'treasure-offer', cards: offered };
      }
      const picked = offered.find(c => c.cardId === choice);
      if (!picked) return { ok: false, error: 'invalid-choice', offered };
      return { ok: true, type: 'treasure-grant', cardId: picked.cardId };
    }
    case 'event': {
      const themeId = parsed.map.seasonTheme;
      const eventDef = await lookupEvent(themeId, node.encounter?.eventId || node.id);
      if (!choice) {
        return { ok: true, type: 'event', event: eventDef };
      }
      const chosen = (eventDef.choices || []).find(c => c.id === choice);
      if (!chosen) return { ok: false, error: 'invalid-choice', choices: eventDef.choices };
      const outcome = pickOutcome(chosen.outcomes, rng);
      return {
        ok: true, type: 'event-resolved',
        event: { id: eventDef.id, name: eventDef.name },
        choiceId: chosen.id,
        outcome,
      };
    }
    case 'boss': {
      return {
        ok: true, type: 'boss', node,
        npcDeck: node.encounter,
      };
    }
    default:
      return { ok: false, error: 'unknown-node-type', nodeType: node.type };
  }
}

// ── HTTP route handler ──────────────────────────────────────────

function _json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });
}

// Shared HMAC gate (mirrors daily-quests.js _gateHmac).
async function _gateHmac(req, env) {
  const { verifyHmac } = await import('./auth.js');
  if (!env.AQUILO_SITE_WEB_SECRET) {
    return { ok: false, status: 503, error: 'AQUILO_SITE_WEB_SECRET missing' };
  }
  const bodyText = req.method === 'POST' ? await req.text() : '';
  const ts  = req.headers.get('x-aquilo-web-ts');
  const sig = req.headers.get('x-aquilo-web-sig');
  const ok  = await verifyHmac(env.AQUILO_SITE_WEB_SECRET, ts || '', bodyText, sig || '');
  if (!ok) return { ok: false, status: 401, error: 'unauthorized' };
  let body = {};
  if (bodyText) {
    try { body = JSON.parse(bodyText); } catch { return { ok: false, status: 400, error: 'bad-json' }; }
  }
  return { ok: true, body };
}

// Routes:
//   POST /web/spire-map/generate  { runId, seasonTheme }      → HMAC
//   GET  /web/spire-map/me/:runId                              → public
//   POST /web/spire-map/advance   { runId, nodeId }            → HMAC
//   POST /web/spire-map/resolve   { runId, nodeId, choice? }   → HMAC
export async function handleSpireMapRoute(req, env, path) {
  // Public GET, site renders the map on first paint.
  if (req.method === 'GET' && path.startsWith('/web/spire-map/me/')) {
    const runId = path.slice('/web/spire-map/me/'.length).split('/')[0];
    if (!runId) return _json({ error: 'runId required' }, 400);
    const state = await getMapForRun(env, runId);
    if (!state) return _json({ error: 'not-found' }, 404);
    return _json({ runId, ...state });
  }

  // Writes need HMAC.
  if (req.method !== 'POST') return _json({ error: 'method-not-allowed' }, 405);
  const gate = await _gateHmac(req, env);
  if (!gate.ok) return _json({ error: gate.error }, gate.status);
  const b = gate.body || {};

  if (path === '/web/spire-map/generate') {
    const runId = String(b.runId || '').trim();
    const seasonTheme = String(b.seasonTheme || '').trim();
    if (!runId || !seasonTheme) return _json({ error: 'runId + seasonTheme required' }, 400);
    const map = generateMap(seasonTheme, runId);
    await saveMap(env, runId, map);
    return _json({ ok: true, runId, map });
  }

  if (path === '/web/spire-map/advance') {
    const runId = String(b.runId || '').trim();
    const nodeId = String(b.nodeId || '').trim();
    if (!runId || !nodeId) return _json({ error: 'runId + nodeId required' }, 400);
    const r = await advanceTo(env, runId, nodeId);
    return _json(r, r.ok ? 200 : 400);
  }

  if (path === '/web/spire-map/resolve') {
    const runId = String(b.runId || '').trim();
    const nodeId = String(b.nodeId || '').trim();
    if (!runId || !nodeId) return _json({ error: 'runId + nodeId required' }, 400);
    const choice = b.choice != null ? String(b.choice) : null;
    const r = await resolveNode(env, runId, nodeId, choice);
    return _json(r, r.ok ? 200 : 400);
  }

  return _json({ error: 'unknown-op' }, 404);
}

// ── Test-only helpers ───────────────────────────────────────────

export const __internals = {
  makeRng, floorWidths, assignTypes, connectFloors,
  ensureBossReachable, pickOutcome, FALLBACK_EVENT,
};
