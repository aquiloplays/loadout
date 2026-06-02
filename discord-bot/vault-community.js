// Aquilo's Vault — community cross-section engine (worker-native).
//
// A single shared Fallout-Shelter-style vault per guild that the whole
// community builds and defends together: members opt in as dwellers,
// get assigned to a starter room by their RPG class, contribute to
// expand the vault, and rally to resolve crises (raiders/fire/radstorm/
// infestation/power-failure).
//
// This is ADDITIVE and independent of the legacy per-user FS-Bot RPG
// (Railway `vault.db`). See memory/vault-rebuild-scope-decision.md.
//
// Storage: D1 `env.DB` (vault_state / vault_dweller / vault_crisis,
// see vault-community-migration.sql). Live updates fan out on the
// Aquilo Bus via publishActivity() as vault.* events; the site viewer
// subscribes through the community SSE stream.
//
// Conventions (match achievements-d1.js / aether.js):
//   - db(env) guard, .prepare().bind().run()/all()/first()
//   - ms-epoch timestamps (Date.now()); ids bound as String()
//   - JSON columns parsed/stringified in JS

import { publishActivity } from './activity-do.js';

// ── Room catalog ──────────────────────────────────────────────────────
// Each room type produces a resource and may have a class affinity. The
// `art` key maps to the KV pixel-art asset served at /asset/vault/<art>.png
// (pixel-art-vault:<art>). Cross-section layout packs ROOMS_PER_FLOOR
// rooms per floor below the vault door.

export const ROOMS_PER_FLOOR = 3;

export const ROOM_TYPES = {
  'living-quarters':  { name: 'Living Quarters',     produces: 'population', rate: 4, art: 'room-living-quarters' },
  'diner':            { name: 'Diner',               produces: 'food',       rate: 5, art: 'room-diner' },
  'water-works':      { name: 'Water Purification',  produces: 'water',      rate: 5, art: 'room-water-works' },
  'power-generator':  { name: 'Power Generator',     produces: 'power',      rate: 5, art: 'room-power-generator' },
  'medical-bay':      { name: 'Medical Bay',         produces: 'happiness',  rate: 3, art: 'room-medical-bay',   affinity: 'healer' },
  'security-office':  { name: 'Security Office',     produces: 'threat',     rate: -4, art: 'room-security-office', affinity: 'warrior' },
  'reactor-lab':      { name: 'Reactor Lab',         produces: 'power',      rate: 7, art: 'room-reactor-lab',    affinity: 'mage' },
  'stealth-bay':      { name: 'Stealth Bay',         produces: 'threat',     rate: -3, art: 'room-stealth-bay',  affinity: 'rogue' },
  'watchtower':       { name: 'Watchtower',          produces: 'threat',     rate: -5, art: 'room-watchtower',   affinity: 'ranger' },
  'training-room':    { name: 'Training Room',       produces: 'happiness',  rate: 2, art: 'room-training-room' },
  'weapons-workshop': { name: 'Weapons Workshop',    produces: 'threat',     rate: -3, art: 'room-weapons-workshop' },
  'science-lab':      { name: 'Science Lab',         produces: 'power',      rate: 4, art: 'room-science-lab' },
  'garden':           { name: 'Garden / Hydroponics', produces: 'food',      rate: 6, art: 'room-garden' },
  'radio-room':       { name: 'Radio Room',          produces: 'population', rate: 3, art: 'room-radio-room' },
  'armory':           { name: 'Armory',              produces: 'threat',     rate: -4, art: 'room-armory' },
  'storage-vault':    { name: 'Storage Vault',       produces: 'happiness',  rate: 1, art: 'room-storage-vault' },
};

// RPG class -> starter room (Clay's directive). All starter rooms exist
// in the seeded vault so class assignment always has a target.
export const CLASS_STARTER_ROOM = {
  warrior: 'security-office',
  mage:    'reactor-lab',
  rogue:   'stealth-bay',
  ranger:  'watchtower',
  healer:  'medical-bay',
};

// Rooms present from day one (3 floors of 3). Order = cross-section
// placement, top floor first.
const SEED_ROOM_TYPES = [
  'living-quarters', 'diner', 'water-works',
  'power-generator', 'medical-bay', 'security-office',
  'reactor-lab', 'stealth-bay', 'watchtower',
];

// Expansion unlock order — each /expand threshold crossing builds the
// next one and unlocks its type.
const EXPANSION_ORDER = [
  'garden', 'training-room', 'weapons-workshop',
  'science-lab', 'radio-room', 'armory', 'storage-vault',
];

export const CRISIS_KINDS = {
  raiders:        { name: 'Raider Assault',     threshold: 60, durationMs: 90 * 60_000,  threatHit: 25, fx: 'crisis-raiders' },
  fire:           { name: 'Reactor Fire',       threshold: 45, durationMs: 60 * 60_000,  threatHit: 15, fx: 'crisis-fire' },
  radstorm:       { name: 'Radstorm',           threshold: 50, durationMs: 75 * 60_000,  threatHit: 18, fx: 'crisis-radstorm' },
  infestation:    { name: 'Ant Infestation',    threshold: 40, durationMs: 60 * 60_000,  threatHit: 12, fx: 'crisis-infestation' },
  'power-failure':{ name: 'Power Failure',      threshold: 55, durationMs: 80 * 60_000,  threatHit: 20, fx: 'crisis-power-failure' },
};

const RESOURCE_KEYS = ['population', 'water', 'food', 'power', 'happiness', 'threat'];

// ── helpers ───────────────────────────────────────────────────────────

function db(env) {
  if (!env || !env.DB) throw new Error('vault-community: env.DB (D1) not bound');
  return env.DB;
}

function now() { return Date.now(); }

function jparse(s, fallback) {
  if (s == null) return fallback;
  try { const v = JSON.parse(s); return v == null ? fallback : v; } catch { return fallback; }
}

function newRoomId() {
  return 'rm_' + now().toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36);
}

function newCrisisId() {
  return 'cr_' + now().toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36);
}

function defaultGuild(env, guildId) {
  return String(guildId || env.AQUILO_VAULT_GUILD_ID || '').trim();
}

function fire(env, kind, payload) {
  // Fire-and-forget Aquilo Bus publish. Never throws into the caller.
  return publishActivity(env, { kind, ts: now(), ...payload }).catch(() => {});
}

// Fire-and-forget Discord side-effect (announce embeds, DMs, role
// grants). Dynamic import keeps vault-discord.js -> vault-community.js
// the only static edge (no cycle). Never throws into the caller.
function discord(env, fnName, ...args) {
  return import('./vault-discord.js')
    .then(m => (typeof m[fnName] === 'function' ? m[fnName](env, ...args) : null))
    .catch(() => {});
}

// ── seed + state I/O ──────────────────────────────────────────────────

function seedState(guildId) {
  const t = now();
  const rooms = SEED_ROOM_TYPES.map((type, i) => ({
    id: newRoomId(),
    type,
    tier: 1,
    x: i % ROOMS_PER_FLOOR,
    y: Math.floor(i / ROOMS_PER_FLOOR), // floor 0 = first room floor (vault door is above, drawn by the viewer)
    builtAt: t,
  }));
  return {
    id: String(guildId),
    guildId: String(guildId),
    rooms,
    assignments: {},
    threats: [],
    unlockedRoomTypes: [...SEED_ROOM_TYPES],
    resources: { population: 10, water: 100, food: 100, power: 100, happiness: 80, threat: 0 },
    expandProgress: 0,
    expandThreshold: 100,
    createdAt: t,
    updatedAt: t,
  };
}

function rowToState(row) {
  return {
    id: row.id,
    guildId: row.guild_id,
    rooms: jparse(row.current_rooms, []),
    assignments: jparse(row.dweller_assignments, {}),
    threats: jparse(row.threats, []),
    unlockedRoomTypes: jparse(row.unlocked_room_types, []),
    resources: jparse(row.resources, {}),
    expandProgress: row.expand_progress || 0,
    expandThreshold: row.expand_threshold || 100,
    createdAt: row.created_at || 0,
    updatedAt: row.updated_at || 0,
  };
}

export async function getState(env, guildId) {
  const g = defaultGuild(env, guildId);
  if (!g) throw new Error('vault-community: no guildId / AQUILO_VAULT_GUILD_ID');
  const D = db(env);
  const row = await D.prepare('SELECT * FROM vault_state WHERE id=?').bind(String(g)).first();
  if (row) return rowToState(row);
  // Lazy-create the seeded vault on first touch.
  const st = seedState(g);
  await putState(env, st, { insert: true });
  return st;
}

export async function putState(env, st, opts = {}) {
  const D = db(env);
  st.updatedAt = now();
  if (opts.insert) {
    await D.prepare(
      `INSERT OR IGNORE INTO vault_state
       (id, guild_id, current_rooms, dweller_assignments, threats, unlocked_room_types,
        resources, expand_progress, expand_threshold, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      String(st.id), String(st.guildId),
      JSON.stringify(st.rooms), JSON.stringify(st.assignments),
      JSON.stringify(st.threats), JSON.stringify(st.unlockedRoomTypes),
      JSON.stringify(st.resources), st.expandProgress, st.expandThreshold,
      st.createdAt || st.updatedAt, st.updatedAt,
    ).run();
    return;
  }
  await D.prepare(
    `UPDATE vault_state SET
       current_rooms=?, dweller_assignments=?, threats=?, unlocked_room_types=?,
       resources=?, expand_progress=?, expand_threshold=?, updated_at=?
     WHERE id=?`
  ).bind(
    JSON.stringify(st.rooms), JSON.stringify(st.assignments),
    JSON.stringify(st.threats), JSON.stringify(st.unlockedRoomTypes),
    JSON.stringify(st.resources), st.expandProgress, st.expandThreshold,
    st.updatedAt, String(st.id),
  ).run();
}

// ── dwellers ──────────────────────────────────────────────────────────

export async function getDweller(env, userId) {
  const D = db(env);
  return await D.prepare('SELECT * FROM vault_dweller WHERE user_id=?').bind(String(userId)).first();
}

export async function listDwellers(env, guildId) {
  const g = defaultGuild(env, guildId);
  const D = db(env);
  const { results } = await D.prepare('SELECT * FROM vault_dweller WHERE guild_id=?').bind(String(g)).all();
  return results || [];
}

// Opt a user into the vault (idempotent). Assigns the class starter room
// when the class is known and the room exists. Emits vault.dweller.move.
export async function enlistDweller(env, guildId, userId, { username = null, klass = null } = {}) {
  const g = defaultGuild(env, guildId);
  const D = db(env);
  const t = now();
  const existing = await getDweller(env, userId);
  const st = await getState(env, g);

  let assignedRoom = existing?.assigned_room || null;
  const cls = klass || existing?.class || null;
  if (!assignedRoom && cls && CLASS_STARTER_ROOM[cls]) {
    const target = st.rooms.find(r => r.type === CLASS_STARTER_ROOM[cls]);
    if (target) assignedRoom = target.id;
  }

  if (existing) {
    await D.prepare(
      `UPDATE vault_dweller SET guild_id=?, username=COALESCE(?,username),
         class=COALESCE(?,class), assigned_room=COALESCE(?,assigned_room),
         last_seen_in_vault=? WHERE user_id=?`
    ).bind(String(g), username, cls, assignedRoom, t, String(userId)).run();
  } else {
    await D.prepare(
      `INSERT INTO vault_dweller
        (user_id, guild_id, username, class, assigned_room, contribution_total, joined_at, last_seen_in_vault)
       VALUES (?,?,?,?,?,0,?,?)`
    ).bind(String(userId), String(g), username, cls, assignedRoom, t, t).run();
  }

  if (assignedRoom) {
    st.assignments[String(userId)] = assignedRoom;
    await putState(env, st);
    fire(env, 'vault.dweller.move', { guildId: g, userId: String(userId), roomId: assignedRoom, class: cls });
  }
  return { ok: true, assignedRoom, class: cls, isNew: !existing };
}

// Move a dweller to a specific room (must exist). Emits vault.dweller.move.
export async function assignDweller(env, guildId, userId, roomId) {
  const g = defaultGuild(env, guildId);
  const st = await getState(env, g);
  const room = st.rooms.find(r => r.id === roomId);
  if (!room) return { ok: false, error: 'bad-room' };
  const D = db(env);
  const existing = await getDweller(env, userId);
  if (!existing) {
    // Auto-enlist then assign.
    await enlistDweller(env, g, userId);
  }
  await D.prepare('UPDATE vault_dweller SET assigned_room=?, last_seen_in_vault=? WHERE user_id=?')
    .bind(String(roomId), now(), String(userId)).run();
  st.assignments[String(userId)] = String(roomId);
  await putState(env, st);
  fire(env, 'vault.dweller.move', { guildId: g, userId: String(userId), roomId: String(roomId), roomType: room.type });
  return { ok: true, roomId: String(roomId), roomType: room.type, roomName: ROOM_TYPES[room.type]?.name };
}

async function bumpContribution(env, userId, amount) {
  const D = db(env);
  await D.prepare('UPDATE vault_dweller SET contribution_total=contribution_total+?, last_seen_in_vault=? WHERE user_id=?')
    .bind(amount, now(), String(userId)).run();
}

// ── resources ─────────────────────────────────────────────────────────

export function recomputeResources(st, dwellers) {
  const res = { population: 0, water: 0, food: 0, power: 0, happiness: 0, threat: 0 };
  // Base capacities scale with vault size.
  const base = { population: 5, water: 40, food: 40, power: 40, happiness: 50, threat: 0 };
  for (const k of RESOURCE_KEYS) res[k] = base[k];

  const occupancy = {};
  for (const roomId of Object.values(st.assignments)) {
    occupancy[roomId] = (occupancy[roomId] || 0) + 1;
  }
  for (const room of st.rooms) {
    const def = ROOM_TYPES[room.type];
    if (!def) continue;
    const staffed = occupancy[room.id] || 0;
    // A staffed room produces at full rate; idle rooms produce at 40%.
    const mult = staffed > 0 ? (1 + 0.25 * Math.min(staffed - 1, 3)) : 0.4;
    const out = Math.round((def.rate || 0) * room.tier * mult);
    if (def.produces && res[def.produces] != null) res[def.produces] += out;
  }
  // Active crises raise the threat bar.
  res.threat += (st.threats?.length || 0) * 10;
  // Clamp the percentage-style bars.
  for (const k of ['water', 'food', 'power', 'happiness', 'threat']) {
    res[k] = Math.max(0, Math.min(100, res[k]));
  }
  res.population = Math.max(0, res.population + (dwellers?.length || 0));
  return res;
}

// ── expansion ─────────────────────────────────────────────────────────

function nextExpansionType(st) {
  for (const type of EXPANSION_ORDER) {
    if (!st.rooms.some(r => r.type === type)) return type;
  }
  return null; // fully built out
}

// Contribute toward the next room. When progress crosses the threshold,
// build the next room + unlock its type. Emits vault.room.unlocked.
export async function contributeToExpansion(env, guildId, userId, amount = 1) {
  const g = defaultGuild(env, guildId);
  const st = await getState(env, g);
  const nextType = nextExpansionType(st);
  if (!nextType) return { ok: false, error: 'fully-built', message: 'The vault is fully built out.' };

  st.expandProgress += amount;
  if (userId) await bumpContribution(env, userId, amount).catch(() => {});

  let unlocked = null;
  if (st.expandProgress >= st.expandThreshold) {
    const idx = st.rooms.length;
    const room = {
      id: newRoomId(), type: nextType, tier: 1,
      x: idx % ROOMS_PER_FLOOR, y: Math.floor(idx / ROOMS_PER_FLOOR), builtAt: now(),
    };
    st.rooms.push(room);
    if (!st.unlockedRoomTypes.includes(nextType)) st.unlockedRoomTypes.push(nextType);
    st.expandProgress -= st.expandThreshold;
    st.expandThreshold = Math.round(st.expandThreshold * 1.4); // each room costs more
    unlocked = { roomId: room.id, type: nextType, name: ROOM_TYPES[nextType]?.name };
  }

  st.resources = recomputeResources(st, await listDwellers(env, g));
  await putState(env, st);
  if (unlocked) {
    fire(env, 'vault.room.unlocked', { guildId: g, ...unlocked, byUser: userId ? String(userId) : null });
    discord(env, 'postVaultStatus', g, `🔓 New room online: **${unlocked.name}**. The vault grows!`);
  }
  return {
    ok: true,
    contributed: amount,
    expandProgress: st.expandProgress,
    expandThreshold: st.expandThreshold,
    unlocked,
  };
}

// ── crises ────────────────────────────────────────────────────────────

function rowToCrisis(row) {
  return {
    id: row.id, kind: row.kind, roomId: row.room_id, severity: row.severity,
    threshold: row.threshold, progress: row.progress,
    contributions: jparse(row.contributions, {}),
    startedAt: row.started_at, endsAt: row.ends_at, endedAt: row.ended_at,
    resolution: row.resolution,
    name: CRISIS_KINDS[row.kind]?.name || row.kind,
    fx: CRISIS_KINDS[row.kind]?.fx || null,
  };
}

export async function getActiveCrises(env, guildId) {
  const g = defaultGuild(env, guildId);
  const D = db(env);
  const { results } = await D.prepare(
    'SELECT * FROM vault_crisis WHERE guild_id=? AND ended_at IS NULL ORDER BY started_at DESC'
  ).bind(String(g)).all();
  return (results || []).map(rowToCrisis);
}

export async function startCrisis(env, guildId, { kind, roomId = null, severity = 1 } = {}) {
  const g = defaultGuild(env, guildId);
  const def = CRISIS_KINDS[kind];
  if (!def) return { ok: false, error: 'bad-kind' };
  const D = db(env);
  const t = now();
  const id = newCrisisId();
  const threshold = def.threshold + (severity - 1) * 15;
  const endsAt = t + def.durationMs;
  await D.prepare(
    `INSERT INTO vault_crisis
      (id, guild_id, kind, room_id, severity, threshold, progress, contributions, started_at, ends_at, ended_at, resolution)
     VALUES (?,?,?,?,?,?,0,'{}',?,?,NULL,NULL)`
  ).bind(String(id), String(g), kind, roomId, severity, threshold, t, endsAt).run();

  const st = await getState(env, g);
  if (!st.threats.includes(id)) st.threats.push(id);
  st.resources = recomputeResources(st, await listDwellers(env, g));
  await putState(env, st);

  fire(env, 'vault.crisis.start', {
    guildId: g, crisisId: id, kind, name: def.name, roomId, severity, threshold, endsAt, fx: def.fx,
  });
  discord(env, 'announceCrisisStart', g,
    { crisisId: id, kind, roomId, threshold }, st.rooms);
  return { ok: true, crisisId: id, kind, name: def.name, roomId, threshold, endsAt };
}

export async function contributeToCrisis(env, guildId, userId, crisisId, amount = 5) {
  const g = defaultGuild(env, guildId);
  const D = db(env);
  const row = await D.prepare('SELECT * FROM vault_crisis WHERE id=? AND guild_id=?')
    .bind(String(crisisId), String(g)).first();
  if (!row) return { ok: false, error: 'no-crisis' };
  if (row.ended_at) return { ok: false, error: 'already-ended', resolution: row.resolution };

  const contributions = jparse(row.contributions, {});
  contributions[String(userId)] = (contributions[String(userId)] || 0) + amount;
  const progress = (row.progress || 0) + amount;
  if (userId) await bumpContribution(env, userId, amount).catch(() => {});

  const resolved = progress >= row.threshold;
  const t = now();
  await D.prepare(
    `UPDATE vault_crisis SET progress=?, contributions=?, ended_at=?, resolution=? WHERE id=?`
  ).bind(
    progress, JSON.stringify(contributions),
    resolved ? t : null, resolved ? 'resolved' : null, String(crisisId),
  ).run();

  if (resolved) {
    const st = await getState(env, g);
    st.threats = st.threats.filter(x => x !== String(crisisId));
    st.resources = recomputeResources(st, await listDwellers(env, g));
    await putState(env, st);
    fire(env, 'vault.crisis.resolved', {
      guildId: g, crisisId: String(crisisId), kind: row.kind,
      resolution: 'resolved', contributors: Object.keys(contributions).length,
    });
    discord(env, 'announceCrisisResolved', g, { crisisId: String(crisisId), kind: row.kind }, 'resolved');
  }
  // Contributing to a live crisis makes you a Crisis Responder.
  if (userId) discord(env, 'grantCrisisResponder', g, String(userId));
  return {
    ok: true, crisisId: String(crisisId), contributed: amount,
    progress, threshold: row.threshold, resolved,
  };
}

// Sweep crises past their deadline → mark failed. Idempotent.
export async function expireCrises(env, guildId) {
  const g = defaultGuild(env, guildId);
  const D = db(env);
  const t = now();
  const { results } = await D.prepare(
    'SELECT * FROM vault_crisis WHERE guild_id=? AND ended_at IS NULL AND ends_at IS NOT NULL AND ends_at < ?'
  ).bind(String(g), t).all();
  const expired = [];
  for (const row of (results || [])) {
    await D.prepare('UPDATE vault_crisis SET ended_at=?, resolution=? WHERE id=?')
      .bind(t, 'failed', row.id).run();
    expired.push(row.id);
    fire(env, 'vault.crisis.resolved', { guildId: g, crisisId: row.id, kind: row.kind, resolution: 'failed' });
    discord(env, 'announceCrisisResolved', g, { crisisId: row.id, kind: row.kind }, 'failed');
  }
  if (expired.length) {
    const st = await getState(env, g);
    st.threats = st.threats.filter(x => !expired.includes(x));
    // A failed crisis dents happiness and bumps lingering threat.
    st.resources = recomputeResources(st, await listDwellers(env, g));
    st.resources.happiness = Math.max(0, (st.resources.happiness || 0) - 8 * expired.length);
    await putState(env, st);
  }
  return { expired };
}

// Low-probability crisis spawn for the cron tick. Picks a kind weighted
// toward the current threat level and (usually) targets an occupied room.
export async function maybeSpawnCrisis(env, guildId, { chance = 0.12 } = {}) {
  const g = defaultGuild(env, guildId);
  const active = await getActiveCrises(env, g);
  if (active.length >= 2) return { spawned: null, reason: 'cap' };       // never pile on
  if (Math.random() > chance) return { spawned: null, reason: 'no-roll' };

  const kinds = Object.keys(CRISIS_KINDS);
  const kind = kinds[Math.floor(Math.random() * kinds.length)];
  const st = await getState(env, g);
  const occupied = [...new Set(Object.values(st.assignments))].filter(rid => st.rooms.some(r => r.id === rid));
  const roomId = occupied.length && Math.random() < 0.8
    ? occupied[Math.floor(Math.random() * occupied.length)]
    : null;
  const severity = 1 + (Math.random() < 0.25 ? 1 : 0);
  const r = await startCrisis(env, g, { kind, roomId, severity });
  return { spawned: r.ok ? r : null };
}

// ── cron tick (rides the every-minute trigger at mm % 5 === 0) ─────────

export async function tickVault(env, guildId) {
  const g = defaultGuild(env, guildId);
  if (!g) return { ok: false, error: 'no-guild' };
  const out = { ok: true };
  try { out.expired = (await expireCrises(env, g)).expired; } catch (e) { out.expireErr = String(e?.message || e); }
  try { out.spawn = (await maybeSpawnCrisis(env, g)).spawned; } catch (e) { out.spawnErr = String(e?.message || e); }
  try {
    const st = await getState(env, g);
    st.resources = recomputeResources(st, await listDwellers(env, g));
    await putState(env, st);
  } catch (e) { out.recomputeErr = String(e?.message || e); }
  return out;
}

// ── snapshot (public viewer payload) ──────────────────────────────────

export async function snapshot(env, guildId) {
  const g = defaultGuild(env, guildId);
  if (!g) return { ok: false, error: 'no-guild' };
  const [st, dwellers, crises] = await Promise.all([
    getState(env, g),
    listDwellers(env, g),
    getActiveCrises(env, g),
  ]);
  // Decorate rooms with catalog metadata + occupancy for the renderer.
  const occupancy = {};
  for (const rid of Object.values(st.assignments)) occupancy[rid] = (occupancy[rid] || 0) + 1;
  const rooms = st.rooms.map(r => ({
    ...r,
    name: ROOM_TYPES[r.type]?.name || r.type,
    produces: ROOM_TYPES[r.type]?.produces || null,
    affinity: ROOM_TYPES[r.type]?.affinity || null,
    art: ROOM_TYPES[r.type]?.art || null,
    occupants: occupancy[r.id] || 0,
  }));
  return {
    ok: true,
    now: now(),
    guildId: g,
    rooms,
    roomsPerFloor: ROOMS_PER_FLOOR,
    dwellers: dwellers.map(d => ({
      userId: d.user_id, username: d.username, class: d.class,
      room: d.assigned_room, contribution: d.contribution_total,
    })),
    assignments: st.assignments,
    resources: st.resources,
    crises: crises.map(c => ({
      id: c.id, kind: c.kind, name: c.name, roomId: c.roomId, severity: c.severity,
      progress: c.progress, threshold: c.threshold, endsAt: c.endsAt, fx: c.fx,
      contributors: Object.keys(c.contributions || {}).length,
    })),
    unlockedRoomTypes: st.unlockedRoomTypes,
    nextExpansion: (() => {
      const nt = nextExpansionType(st);
      return nt ? { type: nt, name: ROOM_TYPES[nt]?.name } : null;
    })(),
    expand: { progress: st.expandProgress, threshold: st.expandThreshold },
    roomTypes: ROOM_TYPES,
    classStarterRoom: CLASS_STARTER_ROOM,
  };
}

// ── /web/vault/* route handlers (POST, HMAC-gated via web.js) ──────────
// Signature matches the other web.js routes: (env, guildId, discordId, body).
// json() is imported from web.js's helper via the caller; we return a
// plain Response built here to keep this module self-contained.

function jres(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export async function routeVaultStatePost(env, guildId, discordId, _body) {
  // Authenticated snapshot (same data as the public GET; lets the site
  // fetch through the signed /web proxy when it prefers).
  const snap = await snapshot(env, guildId);
  return jres(snap, snap.ok ? 200 : 400);
}

export async function routeVaultAssign(env, guildId, discordId, body) {
  const room = String(body?.room || '').trim();
  // Owner can assign another user; otherwise self-assign.
  const target = (body?._owner === true && body?.targetUserId)
    ? String(body.targetUserId) : discordId;
  if (!room) return jres({ ok: false, error: 'missing-room' }, 400);
  const r = await assignDweller(env, guildId, target, room);
  return jres(r, r.ok ? 200 : 400);
}

export async function routeVaultExpand(env, guildId, discordId, body) {
  const amount = Math.max(1, Math.min(50, Number(body?.amount) || 1));
  const r = await contributeToExpansion(env, guildId, discordId, amount);
  return jres(r, r.ok ? 200 : 400);
}

export async function routeVaultContributeCrisis(env, guildId, discordId, body) {
  const crisisId = String(body?.crisisId || '').trim();
  const amount = Math.max(1, Math.min(50, Number(body?.amount) || 5));
  if (!crisisId) return jres({ ok: false, error: 'missing-crisisId' }, 400);
  const r = await contributeToCrisis(env, guildId, discordId, crisisId, amount);
  return jres(r, r.ok ? 200 : 400);
}

// Admin/dev: force a crisis (owner-gated in web.js).
export async function routeVaultStartCrisis(env, guildId, discordId, body) {
  const kind = String(body?.kind || '').trim();
  const roomId = body?.roomId ? String(body.roomId) : null;
  const r = await startCrisis(env, guildId, { kind, roomId, severity: Number(body?.severity) || 1 });
  return jres(r, r.ok ? 200 : 400);
}
