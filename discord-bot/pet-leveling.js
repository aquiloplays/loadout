// Pet Leveling + Abilities + Evolutions — progression layer on top of
// the cosmetic pet system (pet.js).
//
// Storage layout (HYBRID, mirrors daily-quests.js):
//   D1 pet_ability_def        — ability catalogue (static, seeded by migration)
//   D1 pet_evolution_chain    — species → species evolution rules (static)
//   KV pet:<guildId>:<userId> — per-pet state, soft-extended with:
//                                 level (default 1)
//                                 xp (default 0)
//                                 abilities (default [])
//                                 evolvedFrom (default null)
//                                 evolutionHistory (default [])
//
// The pet record already lives in KV under pet.js's putPet() — we
// extend it in place rather than mirror to D1, because (a) the
// cosmetic state and progression state always travel together and
// (b) the read path in pet.js already loads the whole blob. A D1
// shadow would double-read on every render.
//
// XP curve: quadratic, base 50. xpToNext(L) = 50 * L^2. So L1→L2 = 50,
// L2→L3 = 200, L3→L4 = 450, etc. Caps at MAX_LEVEL = 20. Curve is
// intentionally steep — pets are slow-burn companions, not a grind.
//
// Ability unlock: on every level-up, any ability_def whose min_level
// is newly crossed AND whose species_pool matches the pet's species
// (or is NULL = any) is auto-added to pet.abilities[]. We don't make
// the player "choose" an ability at level-up — the design doc calls
// out simplicity.
//
// Evolution: tryEvolvePet checks pet_evolution_chain for any row
// whose base_pet_id matches pet.species AND evolves_at_level <=
// pet.level AND condition_json is satisfied. If multiple rows match,
// we pick the one with the highest evolves_at_level (so chain-stages
// resolve in order). On evolution, pet.species is mutated to the new
// species id and the prior id is pushed onto pet.evolutionHistory.

import { getPet } from './pet.js';

// ── Tuning constants ────────────────────────────────────────────────
const MAX_LEVEL = 20;
const XP_CURVE_BASE = 50;   // xpToNext(L) = BASE * L^2
const ABILITY_XP_BONUS = 2; // big-appetite ability sets this per-pet

// ── D1 helpers ──────────────────────────────────────────────────────
async function db(env) {
  if (!env.DB) throw new Error('pet-leveling: no D1 binding (env.DB missing)');
  return env.DB;
}

// ── KV pet read/write (matches pet.js conventions) ──────────────────
function petKey(guildId, userId) { return `pet:${guildId}:${userId}`; }

async function loadPetWithDefaults(env, guildId, userId) {
  const pet = await getPet(env, guildId, userId);
  if (!pet) return null;
  // Soft-extend: existing pets backfill on read so we never need to
  // run a migration over the KV namespace.
  if (typeof pet.level !== 'number') pet.level = 1;
  if (typeof pet.xp !== 'number') pet.xp = 0;
  if (!Array.isArray(pet.abilities)) pet.abilities = [];
  if (!Array.isArray(pet.evolutionHistory)) pet.evolutionHistory = [];
  return pet;
}

async function savePet(env, guildId, userId, pet) {
  pet.lastUpdatedUtc = Date.now();
  await env.LOADOUT_BOLTS.put(petKey(guildId, userId), JSON.stringify(pet));
}

// ── XP curve ────────────────────────────────────────────────────────
// xpToNext(L) returns the XP threshold to advance from level L to L+1.
// Quadratic for a noticeable late-game stretch without being a wall.
export function xpToNext(level) {
  const L = Math.max(1, Math.floor(level));
  return XP_CURVE_BASE * L * L;
}

// ── Ability catalogue helpers ───────────────────────────────────────
function parseAbilityRow(row) {
  let payload = {};
  try { payload = JSON.parse(row.trigger_payload_json || '{}'); } catch { /* {} */ }
  return {
    id:             row.id,
    name:           row.name,
    description:    row.description,
    icon:           row.icon,
    triggerType:    row.trigger_type,
    triggerPayload: payload,
    minLevel:       Number(row.min_level) || 1,
    speciesPool:    row.species_pool
      ? String(row.species_pool).split(',').map(s => s.trim()).filter(Boolean)
      : null,
    active:         Number(row.active) === 1,
  };
}

// All abilities that exist for a given species (regardless of level).
// Used by listPetAbilities to surface "available at higher levels".
async function loadAbilityDefsForSpecies(env, species) {
  const D = await db(env);
  const rows = await D.prepare(
    'SELECT * FROM pet_ability_def WHERE active = 1'
  ).all();
  const out = [];
  for (const row of (rows?.results || [])) {
    const def = parseAbilityRow(row);
    if (!def.speciesPool || def.speciesPool.includes(species)) {
      out.push(def);
    }
  }
  return out;
}

// Resolve a single ability id back to the def (for ability-trigger
// callers in dungeon.js / expedition.js).
export async function getAbilityDef(env, abilityId) {
  if (!abilityId) return null;
  const D = await db(env);
  const row = await D.prepare(
    'SELECT * FROM pet_ability_def WHERE id = ? LIMIT 1'
  ).bind(abilityId).first();
  return row ? parseAbilityRow(row) : null;
}

// ── Evolution catalogue helpers ─────────────────────────────────────
function parseEvolutionRow(row) {
  let cond = {};
  try { cond = JSON.parse(row.condition_json || '{}'); } catch { /* {} */ }
  return {
    id:              row.id,
    baseSpecies:     row.base_pet_id,
    evolvesAtLevel:  Number(row.evolves_at_level) || 1,
    evolvesTo:       row.evolves_to_pet_id,
    condition:       cond,
    active:          Number(row.active) === 1,
  };
}

async function loadEvolutionsFor(env, species) {
  const D = await db(env);
  const rows = await D.prepare(
    'SELECT * FROM pet_evolution_chain WHERE base_pet_id = ? AND active = 1 ORDER BY evolves_at_level DESC'
  ).bind(species).all();
  return (rows?.results || []).map(parseEvolutionRow);
}

// ── Level-up + ability unlock ───────────────────────────────────────
//
// Walks XP forward until xp < xpToNext(level) or level == MAX_LEVEL.
// Returns the number of levels crossed and any newly-unlocked
// abilities (so the caller can render the "Your pet learned X!" chime).
async function applyXpAndLevelUps(env, pet) {
  const startingLevel = pet.level;
  const unlockedThisCall = [];
  // Crossing N levels in one call (e.g. big XP grant) — keep looping
  // until we run out of XP or hit the cap.
  while (pet.level < MAX_LEVEL && pet.xp >= xpToNext(pet.level)) {
    pet.xp -= xpToNext(pet.level);
    pet.level += 1;
  }
  if (pet.level > startingLevel) {
    // Check ability unlocks. We load defs once and filter — cheaper
    // than one query per crossed level.
    const defs = await loadAbilityDefsForSpecies(env, pet.species);
    for (const def of defs) {
      if (
        def.minLevel > startingLevel &&
        def.minLevel <= pet.level &&
        !pet.abilities.includes(def.id)
      ) {
        pet.abilities.push(def.id);
        unlockedThisCall.push(def);
      }
    }
  }
  return {
    levelsCrossed: pet.level - startingLevel,
    unlocked:      unlockedThisCall,
  };
}

// ── Public API ──────────────────────────────────────────────────────

// addPetXp — bumps the pet's XP, fires level-up + ability-unlock
// checks. Source is a free-form tag for analytics (e.g. 'dungeon.win',
// 'expedition.complete', 'feed').
//
// Returns { ok, level, xp, xpToNext, levelsCrossed, unlocked }.
export async function addPetXp(env, userId, petId, amount, source) {
  const guildId = petId; // current pet schema is one-pet-per-(guild,user); petId == guildId
  if (!guildId || !userId) return { ok: false, error: 'bad-args' };
  const xp = Math.max(0, Math.floor(Number(amount) || 0));
  if (xp === 0) return { ok: false, error: 'zero-xp' };
  const pet = await loadPetWithDefaults(env, guildId, userId);
  if (!pet) return { ok: false, error: 'no-pet' };

  // big-appetite ability bonus — applied here when source === 'feed'
  // so the on-feed trigger has a one-line implementation.
  let appliedXp = xp;
  if (source === 'feed' && pet.abilities.includes('big-appetite')) {
    appliedXp += ABILITY_XP_BONUS;
  }
  pet.xp += appliedXp;

  const { levelsCrossed, unlocked } = await applyXpAndLevelUps(env, pet);
  await savePet(env, guildId, userId, pet);

  return {
    ok: true,
    level:          pet.level,
    xp:             pet.xp,
    xpToNext:       pet.level >= MAX_LEVEL ? 0 : xpToNext(pet.level),
    appliedXp,
    levelsCrossed,
    unlocked:       unlocked.map(a => ({ id: a.id, name: a.name, icon: a.icon })),
    source:         source || null,
  };
}

// getPetLevel — light read for embed renderers. Returns null if no pet.
export async function getPetLevel(env, userId, petId) {
  const guildId = petId;
  const pet = await loadPetWithDefaults(env, guildId, userId);
  if (!pet) return null;
  return {
    level:    pet.level,
    xp:       pet.xp,
    xpToNext: pet.level >= MAX_LEVEL ? 0 : xpToNext(pet.level),
    species:  pet.species,
    maxLevel: MAX_LEVEL,
  };
}

// listPetAbilities — returns { unlocked, upcoming }. `unlocked` is the
// abilities the pet currently has (full def objects). `upcoming` is
// species-matching defs the pet HASN'T unlocked yet, sorted by
// min_level so the UI can render a "next at level X" hint.
//
// Signature: (env, petId) where petId is guildId — but we also accept
// (env, guildId, userId) when the caller has both. Tests prefer the
// 3-arg form.
export async function listPetAbilities(env, guildIdOrPetId, userIdOptional) {
  // Two-arg legacy: petId carries guildId, and the caller must lookup
  // the pet record some other way. We support both call styles so
  // route handlers can use the petId-only form.
  const guildId = guildIdOrPetId;
  const userId = userIdOptional;
  let pet = null;
  if (userId) {
    pet = await loadPetWithDefaults(env, guildId, userId);
  }
  // Without a pet record we still return the species-agnostic list.
  const species = pet?.species || null;
  const allDefs = species
    ? await loadAbilityDefsForSpecies(env, species)
    : await loadAbilityDefsForSpecies(env, '__none__');
  // ^ '__none__' deliberately matches nothing in species_pool so only
  //   the "any species" rows (species_pool IS NULL) survive.
  const ownedIds = new Set(pet?.abilities || []);
  const unlocked = [];
  const upcoming = [];
  for (const def of allDefs) {
    if (ownedIds.has(def.id)) {
      unlocked.push(def);
    } else if (!pet || def.minLevel > pet.level) {
      upcoming.push(def);
    } else {
      // Eligible but somehow not in pet.abilities (e.g. species_pool
      // changed after the pet leveled past it). Treat as upcoming for
      // surfacing in the UI but flag for the renderer.
      upcoming.push({ ...def, eligibleNow: true });
    }
  }
  upcoming.sort((a, b) => a.minLevel - b.minLevel);
  return {
    petLevel: pet?.level || null,
    species,
    unlocked,
    upcoming,
  };
}

// ── Evolution ──────────────────────────────────────────────────────
//
// Check evolution rules against a single pet. Returns:
//   { evolved: false, reason: 'no-matching-rule'|'level'|'condition'|'no-pet' }
//   { evolved: true,  newSpecies, fromSpecies, ruleId }
//
// Conditions currently supported (extensible):
//   require_companion_active — checks pet.companionActive (set by
//     /pet companion command, not yet implemented — we read the flag
//     and default to false; the eventual companion command will write
//     it).
//   location                 — 'spire' | 'dungeon' | 'home'. Pet's
//     last location is tracked in pet.lastLocation, set by the
//     dungeon/spire hooks when they call addPetXp.
//   min_happiness            — minimum current happiness value
//     (computed via pet.js's stat-decay math at check time).
export async function tryEvolvePet(env, userId, petId, opts = {}) {
  const guildId = petId;
  const pet = await loadPetWithDefaults(env, guildId, userId);
  if (!pet) return { evolved: false, reason: 'no-pet' };
  const rules = await loadEvolutionsFor(env, pet.species);
  if (!rules.length) return { evolved: false, reason: 'no-matching-rule' };

  // Rules are pre-sorted DESC by evolves_at_level. First level-pass
  // also wins, so a pet that crossed level 10 + 12 in one call evolves
  // to the level-12 form directly.
  for (const rule of rules) {
    if (pet.level < rule.evolvesAtLevel) continue;
    if (!checkCondition(pet, rule.condition, opts)) continue;
    const fromSpecies = pet.species;
    pet.evolutionHistory.push({
      fromSpecies,
      toSpecies: rule.evolvesTo,
      ruleId: rule.id,
      at: Date.now(),
    });
    pet.species = rule.evolvesTo;
    pet.evolvedFrom = fromSpecies;
    await savePet(env, guildId, userId, pet);
    return {
      evolved: true,
      newSpecies: rule.evolvesTo,
      fromSpecies,
      ruleId: rule.id,
    };
  }
  return { evolved: false, reason: 'level-or-condition' };
}

function checkCondition(pet, cond, opts) {
  if (!cond || typeof cond !== 'object') return true;
  if (cond.require_companion_active === true && !pet.companionActive) {
    return false;
  }
  if (cond.location && pet.lastLocation !== cond.location && opts.location !== cond.location) {
    return false;
  }
  if (typeof cond.min_happiness === 'number') {
    const happiness = currentHappinessValue(pet);
    if (happiness < cond.min_happiness) return false;
  }
  return true;
}

// Inline copy of pet.js's decay math for happiness — we don't want a
// circular dependency, and the rate is stable (1/h per the design doc).
function currentHappinessValue(pet) {
  const stat = pet.happiness;
  if (!stat) return 0;
  const hoursSince = (Date.now() - (stat.lastSetUtc || 0)) / 3_600_000;
  const decayed = (stat.value || 0) - 1 * hoursSince;
  return Math.max(0, Math.min(100, decayed));
}

// ── Cron: auto-evolve sweep ─────────────────────────────────────────
//
// Daily sweep over the pet:<g>:<u> namespace. For each pet that is
// AT or PAST an evolution threshold AND meets the condition, runs
// tryEvolvePet. Bounded to PET_SCAN_PAGES pages of 1000 keys per
// call (5k pets) — if we ever cross that we'll page across calls
// with a cursor KV marker.
const PET_SCAN_PAGES = 5;
const PET_SCAN_PAGE_LIMIT = 1000;

export async function autoEvolveCron(env) {
  let scanned = 0;
  let evolved = 0;
  const errors = [];
  let cursor;
  for (let page = 0; page < PET_SCAN_PAGES; page++) {
    let list;
    try {
      list = await env.LOADOUT_BOLTS.list({
        prefix: 'pet:',
        cursor,
        limit: PET_SCAN_PAGE_LIMIT,
      });
    } catch (e) {
      errors.push({ stage: 'list', error: e?.message || String(e) });
      break;
    }
    for (const k of (list.keys || [])) {
      // Skip the release-cooldown markers — same filter pet.js uses.
      if (k.name.startsWith('pet:released:')) continue;
      // Key shape: pet:<guildId>:<userId>
      const parts = k.name.split(':');
      if (parts.length !== 3) continue;
      const guildId = parts[1];
      const userId  = parts[2];
      scanned++;
      try {
        const res = await tryEvolvePet(env, userId, guildId);
        if (res.evolved) evolved++;
      } catch (e) {
        errors.push({ key: k.name, error: e?.message || String(e) });
      }
    }
    if (list.list_complete) break;
    cursor = list.cursor;
  }
  return { ok: true, scanned, evolved, errors };
}

// ── HTTP route handler ──────────────────────────────────────────────
// Mirrors daily-quests.js's pattern: GET unauthenticated for read-only
// views, POST routes HMAC-gated via the AQUILO_SITE_WEB_SECRET shared
// signing key.

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

export async function handlePetLevelingRoute(req, env, path) {
  // GET /web/pet/level/<petId>?userId=<userId>
  // petId is the guildId in current single-pet-per-user model.
  if (req.method === 'GET' && path.startsWith('/web/pet/level/')) {
    const petId = path.slice('/web/pet/level/'.length).split('/')[0];
    if (!petId) return _json({ error: 'petId required' }, 400);
    const url = new URL(req.url);
    const userId = url.searchParams.get('userId');
    if (!userId) return _json({ error: 'userId required' }, 400);
    const res = await getPetLevel(env, userId, petId);
    if (!res) return _json({ error: 'no-pet' }, 404);
    return _json(res);
  }
  // GET /web/pet/abilities/<petId>?userId=<userId>
  if (req.method === 'GET' && path.startsWith('/web/pet/abilities/')) {
    const petId = path.slice('/web/pet/abilities/'.length).split('/')[0];
    if (!petId) return _json({ error: 'petId required' }, 400);
    const url = new URL(req.url);
    const userId = url.searchParams.get('userId');
    const res = await listPetAbilities(env, petId, userId || undefined);
    return _json(res);
  }
  // POST /web/pet/evolve  body: { userId, petId, location? }
  if (req.method === 'POST' && path === '/web/pet/evolve') {
    const gate = await _gateHmac(req, env);
    if (!gate.ok) return _json({ error: gate.error }, gate.status);
    const { userId, petId, location } = gate.body || {};
    if (!userId || !petId) return _json({ error: 'userId + petId required' }, 400);
    const res = await tryEvolvePet(env, userId, petId, { location });
    return _json(res);
  }
  // POST /web/pet/xp  body: { userId, petId, amount, source }
  // HMAC-gated because XP grants flow value into the pet's evolution
  // path — same pattern as daily-quests claim.
  if (req.method === 'POST' && path === '/web/pet/xp') {
    const gate = await _gateHmac(req, env);
    if (!gate.ok) return _json({ error: gate.error }, gate.status);
    const { userId, petId, amount, source } = gate.body || {};
    if (!userId || !petId) return _json({ error: 'userId + petId required' }, 400);
    const res = await addPetXp(env, userId, petId, amount, source);
    return _json(res);
  }
  return _json({ error: 'not-found' }, 404);
}

// ── Test seam ───────────────────────────────────────────────────────
// Re-exported so the test harness can stub a known XP curve without
// touching the file's internal constants.
export const __TEST__ = {
  MAX_LEVEL,
  XP_CURVE_BASE,
  ABILITY_XP_BONUS,
  applyXpAndLevelUps,   // for direct unit testing
  parseAbilityRow,
  parseEvolutionRow,
};
