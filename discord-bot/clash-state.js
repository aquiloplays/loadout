// Clash — KV state module.
//
// Owns every read/write against the `clash:*` family of keys in the
// shared LOADOUT_BOLTS namespace. Other Clash modules (clash.js,
// clash-raid.js, clash-push.js) go through here so the schema lives in
// exactly one place. Phase 1 scope; see CLASH-FEATURE-DESIGN.md §3.
//
// Cooldowns are pure timestamps (endsAt ISO UTC). Workers can't
// background-tick; we walk-and-complete on every read. Same pattern as
// the wallet's 23-h daily payout in games.js.
//
// All write helpers return the post-write object so callers can react
// (e.g. "your build is done" push notification) without a second read.

import { getWallet } from './wallet.js';
import { generateInitialObstacles } from './clash-content.js';

// ── Excluded accounts (leaderboard-only filter) ──────────────────────
//
// Identifiers Clay's testing account flows under. Stored in KV at
// `clash:exclude` so it's editable without a redeploy — these defaults
// only seed the KV on first cold start. To flip exclusion off (when
// Clay is done testing) remove the identifiers from the KV doc OR set
// CLASH_EXCLUDE_DISABLED=1 in env. Gameplay is unaffected; this only
// hides the listed accounts from ranked leaderboards.
const DEFAULT_EXCLUDE = {
  _comment: 'Excluded from every Clash leaderboard. Easy to flip off when testing is done.',
  patreon_emails:  ['bisherclay@gmail.com'],
  twitch_user_ids: ['1497793223'],
  // Clay's Discord ID resolves at runtime via the wallet `links: []`
  // array (see resolveExcludedDiscordIds below). Leave empty here; the
  // resolver walks every wallet and pins any Discord ID whose `links`
  // array has a matching twitch_user_id or patreon_email.
  discord_user_ids: [],
};

export async function getExcludeList(env) {
  if (env.CLASH_EXCLUDE_DISABLED === '1') {
    return { patreon_emails: [], twitch_user_ids: [], discord_user_ids: [] };
  }
  const raw = await env.LOADOUT_BOLTS.get('clash:exclude', { type: 'json' });
  if (raw) return raw;
  // Seed on first read.
  await env.LOADOUT_BOLTS.put('clash:exclude', JSON.stringify(DEFAULT_EXCLUDE));
  return DEFAULT_EXCLUDE;
}

// Given a (guildId, discordUserId), walk the wallet's links[] array and
// return true if any linked identity matches the exclude list. Cached
// in-memory per request because leaderboard queries hit this in a tight
// loop; CF Workers reuse the module-scope across the same invocation.
const _excludeCache = new Map();   // key: guildId:userId -> boolean
export async function isExcluded(env, guildId, userId) {
  const cacheKey = guildId + ':' + userId;
  if (_excludeCache.has(cacheKey)) return _excludeCache.get(cacheKey);

  const exclude = await getExcludeList(env);
  if (exclude.discord_user_ids?.includes(userId)) {
    _excludeCache.set(cacheKey, true);
    return true;
  }
  // Walk the wallet's linked identities. The links array is populated
  // by /link in the existing wallet flow — { platform, handle } pairs
  // (see wallet.js:217–236). A linked Twitch ID or Patreon email
  // matching the exclude list pins this user.
  const w = await getWallet(env, guildId, userId);
  const links = Array.isArray(w?.links) ? w.links : [];
  for (const link of links) {
    if (!link || typeof link !== 'object') continue;
    const platform = String(link.platform || '').toLowerCase();
    const handle = String(link.handle || link.id || link.username || '').toLowerCase();
    if (!platform || !handle) continue;
    if (platform === 'twitch' && exclude.twitch_user_ids?.some(id => String(id).toLowerCase() === handle)) {
      _excludeCache.set(cacheKey, true);
      return true;
    }
    if (platform === 'patreon' && exclude.patreon_emails?.some(e => String(e).toLowerCase() === handle)) {
      _excludeCache.set(cacheKey, true);
      return true;
    }
  }
  _excludeCache.set(cacheKey, false);
  return false;
}

// Same idea for a guild's *town* — a town is excluded from the global
// town-power leaderboard if its owner (the streamer who claimed the
// guild) is on the exclude list.
export async function isTownExcluded(env, guildId) {
  const owner = await env.LOADOUT_BOLTS.get('guildowner:' + guildId, { type: 'json' });
  if (!owner?.discordUserId) return false;
  return isExcluded(env, guildId, owner.discordUserId);
}

// ── Town ─────────────────────────────────────────────────────────────

const TH_TIERS = [
  // [thLevel, prestigeFloor, tierName]
  [1, 0, 'bronze'], [2, 50, 'bronze'], [3, 150, 'silver'],
  [4, 400, 'silver'], [5, 900, 'gold'], [6, 1800, 'gold'],
  [7, 3500, 'platinum'], [8, 6000, 'platinum'],
  [9, 10000, 'diamond'], [10, 16000, 'diamond'],
];

export function tierForPrestige(prestige) {
  let tier = 'bronze';
  for (const [, floor, name] of TH_TIERS) {
    if (prestige >= floor) tier = name;
  }
  return tier;
}

export async function getTown(env, guildId) {
  const raw = await env.LOADOUT_BOLTS.get('clash:town:' + guildId, { type: 'json' });
  return raw || null;
}

// Create a town for a guild on first interaction. Idempotent — returns
// existing town if one is already present.
export async function ensureTown(env, guildId, ownerDiscordUserId) {
  const existing = await getTown(env, guildId);
  if (existing) {
    // Backfill new Phase 3 fields on legacy records.
    let mutated = false;
    if (!('defenderChampion' in existing)) { existing.defenderChampion = null; mutated = true; }
    if (!('battlePlans' in existing))      { existing.battlePlans = 0;        mutated = true; }
    // Phase 5 backfill: obstacles + engineer slot. Existing towns
    // generated before May 2026 won't have either field; we seed
    // them once so the buildable-cell highlighter and the clear
    // action have something to work with.
    if (!Array.isArray(existing.obstacles)) { existing.obstacles = generateInitialObstacles(); mutated = true; }
    if (!existing.engineers || typeof existing.engineers !== 'object') { existing.engineers = { total: 1 }; mutated = true; }
    if (!existing.grid) { existing.grid = { w: 16, h: 16 }; mutated = true; }
    if (mutated) await putTown(env, guildId, existing);
    return existing;
  }
  const now = Date.now();
  const town = {
    guildId,
    thLevel: 1,
    prestige: { score: 0, tier: 'bronze', peak: 0 },
    buildings: [
      // TH always at building id 1 — the resolver assumes id 1 = town hall.
      { id: 1, kind: 'townhall', level: 1, x: 8, y: 8, hp: 800, status: 'idle' },
      { id: 2, kind: 'wall', level: 1, x: 5, y: 5, hp: 200, status: 'idle' },
      { id: 3, kind: 'wall', level: 1, x: 11, y: 5, hp: 200, status: 'idle' },
      { id: 4, kind: 'wall', level: 1, x: 5, y: 11, hp: 200, status: 'idle' },
      { id: 5, kind: 'wall', level: 1, x: 11, y: 11, hp: 200, status: 'idle' },
      { id: 6, kind: 'cannon', level: 1, x: 4, y: 8, hp: 300, status: 'idle' },
    ],
    garrison: { scrapper: 6 },
    layoutVersion: 1,
    ownerUserId: ownerDiscordUserId || '',
    modUserIds: [],
    topContributors: [],
    customisation: { wallSkin: 'default', towerSkin: 'default', bannerEmoji: '⚡' },
    // Phase 3: defending-Champion slot (set via /clash town tent
    // designate, opt-in via /clash defender accept). null when no
    // active defender; { userId, designatedByUserId, designatedUtc,
    // acceptedUtc, expiresUtc } when active. Champion only deploys
    // if the town has a built War Tent AND the defender accepted
    // AND expiresUtc is in the future.
    defenderChampion: null,
    // Phase 3: dungeon-dropped consumable that instantly clears the
    // oldest in-flight build cooldown in the town queue. Capped at 5
    // so a community doesn't hoard infinity Battle Plans and skip
    // the entire TH ladder.
    battlePlans: 0,
    // Phase 5: 16×16 grid + scattered obstacles + the town Engineer.
    // The Engineer is the special unit that clears obstacles; we
    // start with one slot — future Workshop upgrade can grow it.
    grid: { w: 16, h: 16 },
    obstacles: generateInitialObstacles(),
    engineers: { total: 1 },
    createdUtc: now,
    lastUpdatedUtc: now,
  };
  await putTown(env, guildId, town);
  await putTreasury(env, guildId, { bolts: 0, scrap: 50, cores: 0, capacity: 2000 });
  await putPrestige(env, guildId, town.prestige);
  await rebucketTown(env, guildId, 0);
  return town;
}

// ── Defender Champion (Phase 3) ──────────────────────────────────────
//
// Streamer/mod designates → user opts in. Designation auto-expires
// based on the town's War Tent level (longer-lived tent = longer
// designation TTL). Returning null in any of these helpers means the
// town has no active defender at this moment — raid resolver should
// fall back to garrison-only defense.

export async function getActiveDefenderChampion(env, guildId) {
  const town = await getTown(env, guildId);
  if (!town) return null;
  const d = town.defenderChampion;
  if (!d || !d.userId) return null;
  if (!d.acceptedUtc) return null;           // designated but not yet opted-in
  if (d.expiresUtc && d.expiresUtc < Date.now()) return null;   // stale
  // Must have a War Tent built (level >= 1).
  const hasTent = (town.buildings || []).some(b => b.kind === 'warTent' && b.level >= 1 && b.status !== 'building');
  if (!hasTent) return null;
  return d;
}

export const MAX_BATTLE_PLANS = 5;
export async function grantBattlePlan(env, guildId) {
  const town = await getTown(env, guildId);
  if (!town) return null;
  if ((town.battlePlans || 0) >= MAX_BATTLE_PLANS) return town;
  town.battlePlans = (town.battlePlans || 0) + 1;
  await putTown(env, guildId, town);
  return town;
}
export async function spendBattlePlan(env, guildId) {
  const town = await getTown(env, guildId);
  if (!town || (town.battlePlans || 0) <= 0) return null;
  town.battlePlans -= 1;
  await putTown(env, guildId, town);
  return town;
}

export async function putTown(env, guildId, town) {
  town.lastUpdatedUtc = Date.now();
  await env.LOADOUT_BOLTS.put('clash:town:' + guildId, JSON.stringify(town));
  // Layout/garrison edits invalidate the defense snapshot.
  await env.LOADOUT_BOLTS.delete('clash:def-snapshot:' + guildId);
}

// ── Treasury ─────────────────────────────────────────────────────────

export async function getTreasury(env, guildId) {
  const raw = await env.LOADOUT_BOLTS.get('clash:treasury:' + guildId, { type: 'json' });
  return raw || { bolts: 0, scrap: 0, cores: 0, capacity: 2000 };
}
export async function putTreasury(env, guildId, t) {
  await env.LOADOUT_BOLTS.put('clash:treasury:' + guildId, JSON.stringify(t));
}
export async function addTreasury(env, guildId, delta) {
  const t = await getTreasury(env, guildId);
  for (const k of ['bolts', 'scrap', 'cores']) {
    if (Number.isFinite(delta[k])) {
      t[k] = Math.max(0, (t[k] || 0) + delta[k]);
      if (k !== 'cores') t[k] = Math.min(t[k], t.capacity || 2000);
    }
  }
  await putTreasury(env, guildId, t);
  return t;
}

// ── Personal raider state ────────────────────────────────────────────

export async function getArmy(env, guildId, userId) {
  const raw = await env.LOADOUT_BOLTS.get(`clash:army:${guildId}:${userId}`, { type: 'json' });
  return raw || { troops: {}, scrap: 0, cores: 0 };
}
export async function putArmy(env, guildId, userId, a) {
  await env.LOADOUT_BOLTS.put(`clash:army:${guildId}:${userId}`, JSON.stringify(a));
}
export async function addTroops(env, guildId, userId, troopId, count) {
  const a = await getArmy(env, guildId, userId);
  a.troops[troopId] = (a.troops[troopId] || 0) + count;
  await putArmy(env, guildId, userId, a);
  return a;
}
export async function consumeTroops(env, guildId, userId, troopMap) {
  // troopMap: { troopId: count }. Returns null if any count is short.
  const a = await getArmy(env, guildId, userId);
  for (const [troopId, n] of Object.entries(troopMap)) {
    if ((a.troops[troopId] || 0) < n) return null;
  }
  for (const [troopId, n] of Object.entries(troopMap)) {
    a.troops[troopId] -= n;
    if (a.troops[troopId] <= 0) delete a.troops[troopId];
  }
  await putArmy(env, guildId, userId, a);
  return a;
}

// ── Trophies + prestige ──────────────────────────────────────────────

export async function getTrophies(env, guildId, userId) {
  const raw = await env.LOADOUT_BOLTS.get(`clash:trophies:${guildId}:${userId}`, { type: 'json' });
  return raw || { trophies: 0, tier: 'bronze', peak: 0 };
}
export async function putTrophies(env, guildId, userId, t) {
  await env.LOADOUT_BOLTS.put(`clash:trophies:${guildId}:${userId}`, JSON.stringify(t));
}
export async function adjustTrophies(env, guildId, userId, delta) {
  const t = await getTrophies(env, guildId, userId);
  t.trophies = Math.max(0, t.trophies + delta);
  if (t.trophies > (t.peak || 0)) t.peak = t.trophies;
  t.tier = tierForPrestige(t.trophies);
  await putTrophies(env, guildId, userId, t);
  return t;
}

export async function getPrestige(env, guildId) {
  const raw = await env.LOADOUT_BOLTS.get('clash:prestige:' + guildId, { type: 'json' });
  return raw || { score: 0, tier: 'bronze', peak: 0 };
}
export async function putPrestige(env, guildId, p) {
  await env.LOADOUT_BOLTS.put('clash:prestige:' + guildId, JSON.stringify(p));
}
export async function adjustPrestige(env, guildId, delta) {
  const p = await getPrestige(env, guildId);
  const oldTier = p.tier;
  p.score = Math.max(0, p.score + delta);
  if (p.score > (p.peak || 0)) p.peak = p.score;
  p.tier = tierForPrestige(p.score);
  await putPrestige(env, guildId, p);
  if (p.tier !== oldTier) await rebucketTown(env, guildId, p.score);
  return p;
}

// ── Matchmaking buckets ──────────────────────────────────────────────
//
// `clash:mm:tier:<tier>` is a JSON array of `{ guildId, score, lastActive }`.
// On each prestige adjustment we re-bucket. Listing kept small (<1k) by
// tier-shard; if a single tier ever exceeds that we can split further.
const MM_TIERS = ['bronze', 'silver', 'gold', 'platinum', 'diamond'];

async function rebucketTown(env, guildId, score) {
  const tier = tierForPrestige(score);
  // Remove from every other tier
  for (const t of MM_TIERS) {
    if (t === tier) continue;
    const key = 'clash:mm:tier:' + t;
    const list = (await env.LOADOUT_BOLTS.get(key, { type: 'json' })) || [];
    const filtered = list.filter(e => e.guildId !== guildId);
    if (filtered.length !== list.length) {
      await env.LOADOUT_BOLTS.put(key, JSON.stringify(filtered));
    }
  }
  // Upsert into target tier
  const key = 'clash:mm:tier:' + tier;
  const list = (await env.LOADOUT_BOLTS.get(key, { type: 'json' })) || [];
  const existing = list.find(e => e.guildId === guildId);
  if (existing) {
    existing.score = score;
    existing.lastActive = Date.now();
  } else {
    list.push({ guildId, score, lastActive: Date.now() });
  }
  await env.LOADOUT_BOLTS.put(key, JSON.stringify(list));
}

// Pick a raid target for a viewer. Excludes shielded towns, the
// viewer's own home channel, and any guildId whose owner is on the
// exclude list. Falls back to an NPC town if no human is available.
export async function pickRaidTarget(env, viewerGuildId, viewerTier) {
  const tierOrder = MM_TIERS.slice();
  // Search outward from the viewer's tier ±1
  const idx = tierOrder.indexOf(viewerTier);
  const order = [tierOrder[idx], tierOrder[idx - 1], tierOrder[idx + 1]].filter(Boolean);
  for (const tier of order) {
    const list = (await env.LOADOUT_BOLTS.get('clash:mm:tier:' + tier, { type: 'json' })) || [];
    // Filter
    const candidates = [];
    for (const entry of list) {
      if (entry.guildId === viewerGuildId) continue;
      const shield = await getShield(env, entry.guildId);
      if (shield && shield.endsAt > Date.now()) continue;
      if (await isTownExcluded(env, entry.guildId)) continue;
      // Honor a town's manual matchmaking pause (set via /clash town pause).
      const t = await getTown(env, entry.guildId);
      if (t?.matchmakingPaused) continue;
      candidates.push(entry);
    }
    if (candidates.length) {
      return { kind: 'town', guildId: candidates[Math.floor(Math.random() * candidates.length)].guildId };
    }
  }
  // Fallback NPC town — deterministic seed per attacker per day to give
  // a "different opponent every day" feel without storing rows.
  const seed = ((+viewerGuildId || 0) ^ Math.floor(Date.now() / 86_400_000)) >>> 0;
  return { kind: 'npc', seed };
}

// ── Shields ──────────────────────────────────────────────────────────

export async function getShield(env, guildId) {
  const raw = await env.LOADOUT_BOLTS.get('clash:shield:' + guildId, { type: 'json' });
  if (!raw) return null;
  if (raw.endsAt && raw.endsAt < Date.now()) {
    await env.LOADOUT_BOLTS.delete('clash:shield:' + guildId);
    return null;
  }
  return raw;
}
export async function setShield(env, guildId, durationMs, reason) {
  const s = { endsAt: Date.now() + durationMs, reason };
  await env.LOADOUT_BOLTS.put('clash:shield:' + guildId, JSON.stringify(s), {
    expirationTtl: Math.ceil(durationMs / 1000) + 60,
  });
  return s;
}

// ── Build / training queue cooldowns ─────────────────────────────────
//
// Town queue: clash:queue:<guildId> -> { items: [{ id, kind, target, endsAt, payload }] }
// Personal queue: clash:trainq:<guildId>:<userId> -> same shape

export async function getQueue(env, key) {
  const raw = await env.LOADOUT_BOLTS.get(key, { type: 'json' });
  return raw || { items: [] };
}

// Walk a queue, mark anything endsAt <= now as complete, and return
// the completed items. Caller applies the effects (e.g. increment
// troop counts, level up a building, fire a "complete" push). Pure
// read-time pattern — no background tick required.
export async function walkQueueComplete(env, key) {
  const q = await getQueue(env, key);
  const now = Date.now();
  const completed = [];
  const remaining = [];
  for (const item of q.items || []) {
    if (item.endsAt && item.endsAt <= now) completed.push(item);
    else remaining.push(item);
  }
  if (completed.length) {
    q.items = remaining;
    await env.LOADOUT_BOLTS.put(key, JSON.stringify(q));
  }
  return completed;
}

export async function enqueue(env, key, item) {
  const q = await getQueue(env, key);
  q.items = q.items || [];
  q.items.push(item);
  await env.LOADOUT_BOLTS.put(key, JSON.stringify(q));
  return q;
}

// ── Contributions (top donors per town) ──────────────────────────────

export async function recordContribution(env, guildId, userId, boltsDonated) {
  const key = `clash:contributions:${guildId}:${userId}`;
  const raw = (await env.LOADOUT_BOLTS.get(key, { type: 'json' })) || { lifetimeBolts: 0, lastDonationUtc: 0 };
  raw.lifetimeBolts += boltsDonated;
  raw.lastDonationUtc = Date.now();
  await env.LOADOUT_BOLTS.put(key, JSON.stringify(raw));
  return raw;
}

// ── Notify opt-ins ───────────────────────────────────────────────────
//
// Bitmask of subscribed event kinds, per viewer per channel.
//   bit 0  clash.raid.incoming
//   bit 1  clash.raid.lost
//   bit 2  clash.raid.won
//   bit 3  clash.raid.result
//   bit 4  clash.build.complete
//   bit 5  clash.war.declared      (Phase 2)
//   bit 6  clash.war.ended         (Phase 2)
//   bit 7  clash.shield.expiring
export const NOTIFY_KINDS = [
  'clash.raid.incoming', 'clash.raid.lost', 'clash.raid.won',
  'clash.raid.result', 'clash.build.complete',
  'clash.war.declared', 'clash.war.ended', 'clash.shield.expiring',
];
export const NOTIFY_DEFAULT_MASK = 0b1111_1111;   // opt-in to everything by default

export async function getNotifyMask(env, guildId, userId) {
  const raw = await env.LOADOUT_BOLTS.get(`clash:notify:${guildId}:${userId}`, { type: 'json' });
  if (!raw) return NOTIFY_DEFAULT_MASK;
  return raw.mask ?? NOTIFY_DEFAULT_MASK;
}
export async function setNotifyMask(env, guildId, userId, mask) {
  await env.LOADOUT_BOLTS.put(`clash:notify:${guildId}:${userId}`, JSON.stringify({ mask, updatedUtc: Date.now() }));
}

// ── Raid receipts + logs ─────────────────────────────────────────────

export async function putRaid(env, raid) {
  // 30-day TTL on raid receipts — long enough for the replay UI to
  // resolve any /clash log entry, short enough that we never have
  // unbounded growth.
  await env.LOADOUT_BOLTS.put(
    'clash:raid:' + raid.raidId, JSON.stringify(raid),
    { expirationTtl: 30 * 86400 }
  );
}
export async function getRaid(env, raidId) {
  return env.LOADOUT_BOLTS.get('clash:raid:' + raidId, { type: 'json' });
}

export async function appendRaidLog(env, key, raidId) {
  const raw = (await env.LOADOUT_BOLTS.get(key, { type: 'json' })) || { ids: [] };
  raw.ids.unshift(raidId);
  if (raw.ids.length > 50) raw.ids.length = 50;
  await env.LOADOUT_BOLTS.put(key, JSON.stringify(raw));
}
export async function readRaidLog(env, key) {
  const raw = await env.LOADOUT_BOLTS.get(key, { type: 'json' });
  return raw?.ids || [];
}

// ── Defense snapshot ─────────────────────────────────────────────────

export async function getDefenseSnapshot(env, guildId) {
  return env.LOADOUT_BOLTS.get('clash:def-snapshot:' + guildId, { type: 'json' });
}
export async function refreshDefenseSnapshot(env, guildId) {
  const town = await getTown(env, guildId);
  if (!town) return null;
  const snapshot = {
    guildId,
    layoutVersion: town.layoutVersion,
    thLevel: town.thLevel,
    buildings: town.buildings,
    garrison: { ...town.garrison },
    capturedUtc: Date.now(),
  };
  await env.LOADOUT_BOLTS.put('clash:def-snapshot:' + guildId, JSON.stringify(snapshot));
  return snapshot;
}

// ── Leaderboards (with exclusion filter) ─────────────────────────────

export async function topRaiders(env, limit = 10) {
  // Cross-guild ranking: lists every clash:trophies:* key and sorts.
  // KV list is paginated; cap at 5 pages (5k accounts).
  const out = [];
  let cursor;
  for (let i = 0; i < 5; i++) {
    const r = await env.LOADOUT_BOLTS.list({ prefix: 'clash:trophies:', cursor, limit: 1000 });
    for (const k of r.keys) {
      const [, , guildId, userId] = k.name.split(':');
      if (await isExcluded(env, guildId, userId)) continue;
      const t = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
      if (!t) continue;
      out.push({ guildId, userId, trophies: t.trophies || 0, tier: t.tier });
    }
    if (r.list_complete) break;
    cursor = r.cursor;
  }
  out.sort((a, b) => b.trophies - a.trophies);
  return out.slice(0, limit);
}

export async function topTowns(env, limit = 10) {
  const out = [];
  let cursor;
  for (let i = 0; i < 5; i++) {
    const r = await env.LOADOUT_BOLTS.list({ prefix: 'clash:prestige:', cursor, limit: 1000 });
    for (const k of r.keys) {
      const guildId = k.name.split(':')[2];
      if (await isTownExcluded(env, guildId)) continue;
      const p = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
      if (!p) continue;
      out.push({ guildId, score: p.score || 0, tier: p.tier });
    }
    if (r.list_complete) break;
    cursor = r.cursor;
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

// PROGRESSION (P2) — feature stats contract. Returns the account-
// wide Clash headline numbers. `guildId` filters to one town if set;
// null aggregates across every guild this user appears in.
export async function getStatsFor(env, userId, guildId = null) {
  let trophies = 0, peakTrophies = 0, tier = 'bronze';
  let raids = 0, wins = 0, defended = 0;
  if (guildId) {
    const t = await getTrophies(env, guildId, userId);
    trophies = t.trophies || 0;
    peakTrophies = t.peak || 0;
    tier = t.tier || 'bronze';
  } else {
    // Walk every clash:trophies:* this user shows up under.
    let cursor;
    for (let i = 0; i < 5; i++) {
      const r = await env.LOADOUT_BOLTS.list({ prefix: 'clash:trophies:', cursor, limit: 1000 });
      for (const k of r.keys) {
        if (!k.name.endsWith(':' + userId)) continue;
        const rec = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
        if (!rec) continue;
        trophies += (rec.trophies || 0);
        if ((rec.peak || 0) > peakTrophies) peakTrophies = rec.peak || 0;
        if (rec.trophies > (rec.peak || 0) / 2) tier = rec.tier || tier;
      }
      if (r.list_complete) break;
      cursor = r.cursor;
    }
  }
  // Raid count is harder — we don't keep a denormalised counter; show
  // peak as a proxy. The achievement engine will track exact counts.
  return {
    primary: { label: 'Trophies', value: trophies, tier },
    secondary: [
      { label: 'Peak', value: peakTrophies },
      { label: 'Tier', value: tier },
    ],
    iconKind: 'clash-shield',
  };
}

export async function topContributors(env, guildId, limit = 10) {
  const out = [];
  let cursor;
  for (let i = 0; i < 3; i++) {
    const r = await env.LOADOUT_BOLTS.list({
      prefix: `clash:contributions:${guildId}:`, cursor, limit: 1000,
    });
    for (const k of r.keys) {
      const userId = k.name.split(':')[3];
      if (await isExcluded(env, guildId, userId)) continue;
      const c = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
      if (!c) continue;
      out.push({ userId, lifetimeBolts: c.lifetimeBolts || 0 });
    }
    if (r.list_complete) break;
    cursor = r.cursor;
  }
  out.sort((a, b) => b.lifetimeBolts - a.lifetimeBolts);
  return out.slice(0, limit);
}
