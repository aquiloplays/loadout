// Level-tier Discord roles — auto-granted as players cross XP-level
// thresholds. Four scaled-back tiers (was a bigger ladder in an
// earlier design; pared to these four per Clay).
//
//   L5   → Apprentice  (soft slate)
//   L25  → Veteran     (green)
//   L50  → Elite       (violet)
//   L100 → Mythic      (gold)
//
// Roles STACK — hitting Veteran does NOT remove Apprentice. So a
// Mythic player ends up with all four. Discord's role membership is
// idempotent on the REST side (PUT a role the user already has =
// 204), so re-granting is a safe no-op; we don't track which tiers
// we've already granted per-user.
//
// Per-guild role-id map at KV `level-tier-roles:<guildId>`:
//   { apprentice: '<id>', veteran: '<id>', elite: '<id>', mythic: '<id>' }
//
// Hook: event-bus.js consumes `xpResult.levelsCrossed` after every
// grantXp() and calls grantTierRolesForCrossedLevels() — that\'s
// where new-level grants land. The admin /ensure endpoint creates
// the roles + writes the map; the admin /backfill endpoint walks
// every pxp:* record and grants any tier the user has already
// earned (for the L5/25/50/100 users who hit the threshold before
// this feature shipped).

import { levelForXp } from './progression/xp.js';

const ROLE_MAP_KEY = (g) => `level-tier-roles:${g}`;
const BACKFILL_MARKER_KEY = (g) => `level-tier-roles:backfill-done:${g}`;

// Stable spec for the four tiers — order matters (lowest level
// first; admin /ensure creates in this order). Exported for tests.
export const LEVEL_TIER_SPECS = Object.freeze([
  { key: 'apprentice', name: 'Apprentice', color: 0x6a7488, level: 5   },
  { key: 'veteran',    name: 'Veteran',    color: 0x2f8f55, level: 25  },
  { key: 'elite',      name: 'Elite',      color: 0x5b46d2, level: 50  },
  { key: 'mythic',     name: 'Mythic',     color: 0xe6c474, level: 100 },
]);

// Pure: given a level + a role map, return the tier keys that should
// be held at that level. Stacking semantics — higher level includes
// all lower tiers. Exported for tests so the threshold logic is
// independently verifiable.
export function tiersForLevel(level) {
  const n = Number(level) || 0;
  const out = [];
  for (const s of LEVEL_TIER_SPECS) if (n >= s.level) out.push(s.key);
  return out;
}

// Given the levels just crossed and the user's NEW level after the
// crossing, return the tier keys whose threshold was crossed in
// THIS grant. Used by the level-up hook so we only PUT the roles
// the user just earned, not every tier they already have.
export function tiersCrossedBy(levelsCrossed) {
  if (!Array.isArray(levelsCrossed) || levelsCrossed.length === 0) return [];
  const out = [];
  for (const s of LEVEL_TIER_SPECS) {
    if (levelsCrossed.includes(s.level)) out.push(s.key);
  }
  return out;
}

export async function loadRoleMap(env, guildId) {
  if (!env || !env.LOADOUT_BOLTS) return {};
  try {
    const raw = await env.LOADOUT_BOLTS.get(ROLE_MAP_KEY(guildId), { type: 'json' });
    if (!raw || typeof raw !== 'object') return {};
    return raw;
  } catch { return {}; }
}

async function putRoleMap(env, guildId, map) {
  await env.LOADOUT_BOLTS.put(ROLE_MAP_KEY(guildId), JSON.stringify(map));
}

// ── Discord REST helpers ──────────────────────────────────────────

async function discordRest(env, method, path, body, extraHeaders) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, status: 503 };
  const r = await fetch('https://discord.com/api/v10' + path, {
    method,
    headers: {
      Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
      'Content-Type': 'application/json',
      'User-Agent':   'loadout-discord level-tier-roles',
      ...(extraHeaders || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed = null;
  try { parsed = await r.json(); } catch { /* not JSON */ }
  return { ok: r.ok, status: r.status, body: parsed };
}

async function putRoleOnUser(env, guildId, userId, roleId) {
  if (!roleId) return { skipped: 'no-role-id' };
  const r = await fetch(
    `https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`,
    {
      method: 'PUT',
      headers: {
        Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
        'User-Agent':  'loadout-discord level-tier-roles',
        'X-Audit-Log-Reason': 'aquilo level-tier role grant',
      },
    },
  );
  // 204 = added or already-held. Both are success.
  if (r.ok || r.status === 204) return { ok: true };
  if (r.status === 404) return { skipped: 'member-or-role-missing' };
  if (r.status === 403) return { skipped: 'forbidden' };
  return { ok: false, status: r.status };
}

// ── Public: per-event grant hook ──────────────────────────────────
//
// Called by event-bus.js right after grantXp() returns. Skips
// cleanly when:
//   - no levels crossed in this grant
//   - none of the crossed levels are a tier threshold
//   - no role map exists for the user's guild
//   - the user doesn't have a Discord id we can resolve (XP is
//     keyed by Discord userId so this is the userId we already
//     have; the "no guild" case is the one to worry about — XP
//     events emit without guildId when fired from web routes; in
//     that case fall back to AQUILO_VAULT_GUILD_ID).

export async function grantTierRolesForCrossedLevels(env, userId, levelsCrossed, guildIdHint) {
  if (!Array.isArray(levelsCrossed) || levelsCrossed.length === 0) {
    return { skipped: 'no-levels-crossed' };
  }
  const tiers = tiersCrossedBy(levelsCrossed);
  if (tiers.length === 0) return { skipped: 'no-tier-crossed', levelsCrossed };
  const guildId = String(guildIdHint || env.AQUILO_VAULT_GUILD_ID || '').trim();
  if (!guildId) return { skipped: 'no-guild-id' };
  const map = await loadRoleMap(env, guildId);
  if (!map || Object.keys(map).length === 0) return { skipped: 'no-role-map', tiers };

  const granted = [];
  const skipped = [];
  for (const key of tiers) {
    const rid = map[key];
    if (!rid) { skipped.push({ key, reason: 'no-mapping' }); continue; }
    const r = await putRoleOnUser(env, guildId, userId, rid);
    if (r.ok) granted.push({ key, id: rid });
    else skipped.push({ key, reason: r.skipped || ('http-' + r.status) });
  }
  return { ok: true, guildId, userId, tiers, granted, skipped };
}

// ── Admin: ensure the four roles exist + map them ─────────────────
//
// Mirrors onboarding.ensureBaselineRoles. Idempotent — checks
// existing roles for any whose name matches a spec, reuses if found,
// creates otherwise. Persists the flat {key: roleId} map.

export async function ensureLevelTierRoles(env, guildId) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  // Snapshot existing roles once so we can match each spec against
  // the same view.
  const listRes = await discordRest(env, 'GET',
    `/guilds/${encodeURIComponent(guildId)}/roles`);
  if (!listRes.ok) return { ok: false, error: 'roles-fetch-failed', status: listRes.status };
  const existing = listRes.body || [];

  const map = await loadRoleMap(env, guildId);
  const created = [];
  const reused = [];
  const failed = [];

  for (const spec of LEVEL_TIER_SPECS) {
    // Reuse: if the map already has this key + the id still exists
    // in the guild, keep it. Else match by EXACT name (case-insensitive)
    // against the live role list.
    const mapped = map[spec.key];
    const mappedStillExists = mapped && existing.find(r =>
      r && String(r.id) === String(mapped) && !r.managed
      && String(r.id) !== String(guildId),
    );
    if (mappedStillExists) {
      reused.push({ key: spec.key, id: mapped, name: mappedStillExists.name, source: 'kv-map' });
      continue;
    }
    const byName = existing.find(r =>
      r && r.name && r.id
      && String(r.id) !== String(guildId)
      && !r.managed
      && String(r.name).toLowerCase() === spec.name.toLowerCase(),
    );
    if (byName) {
      map[spec.key] = String(byName.id);
      reused.push({ key: spec.key, id: String(byName.id), name: byName.name, source: 'name-match' });
      continue;
    }
    // Create.
    const createRes = await discordRest(env, 'POST',
      `/guilds/${encodeURIComponent(guildId)}/roles`,
      {
        name:        spec.name,
        permissions: '0',
        color:       spec.color,
        hoist:       false,
        mentionable: false,
      },
      { 'X-Audit-Log-Reason': `aquilo level-tier role (${spec.key})` },
    );
    if (!createRes.ok) {
      failed.push({ key: spec.key, status: createRes.status, body: createRes.body });
      continue;
    }
    const id = String(createRes.body?.id || '');
    map[spec.key] = id;
    created.push({ key: spec.key, id, name: spec.name, color: spec.color, level: spec.level });
  }
  await putRoleMap(env, guildId, map);
  return { ok: true, map, created, reused, failed };
}

// ── Admin: backfill — grant tier roles to every player who's
//          already crossed the threshold. Idempotent via a KV
//          marker so re-running doesn't re-scan.
//
// Behavior:
//   - Walks every pxp:<userId> record (paginated, bounded)
//   - For each, computes the highest tier from levelForXp(xp)
//   - Calls putRoleOnUser for every tier they qualify for
//     (Discord PUT on an existing role is a 204 no-op, so stacking
//     is naturally idempotent)
//
// Stamps `level-tier-roles:backfill-done:<g>` after a clean pass so
// re-running just early-returns. Use `force: true` in opts to
// re-scan after granting + then revoking a tier role manually.

export async function backfillLevelTierRoles(env, guildId, opts = {}) {
  if (!env.LOADOUT_BOLTS || !env.DISCORD_BOT_TOKEN) {
    return { ok: false, error: 'unconfigured' };
  }
  if (!opts.force) {
    const done = await env.LOADOUT_BOLTS.get(BACKFILL_MARKER_KEY(guildId));
    if (done) return { ok: true, skipped: 'already-done', completedAt: Number(done) };
  }
  const map = await loadRoleMap(env, guildId);
  if (!map || Object.keys(map).length === 0) {
    return { ok: false, error: 'no-role-map', message: 'run ensureLevelTierRoles first' };
  }

  let scanned = 0;
  let granted = 0;
  let skipped = 0;
  let cursor;
  for (let page = 0; page < 10; page++) {
    const r = await env.LOADOUT_BOLTS.list({ prefix: 'pxp:', cursor, limit: 1000 });
    for (const k of r.keys) {
      if (k.name === 'pxp:table') continue;
      const rec = await env.LOADOUT_BOLTS.get(k.name, { type: 'json' });
      if (!rec) continue;
      const userId = k.name.slice('pxp:'.length);
      // Trust the rec.level if present, else recompute from xp.
      const level = rec.level || levelForXp(rec.xp || 0);
      scanned += 1;
      const tiers = tiersForLevel(level);
      for (const key of tiers) {
        const rid = map[key];
        if (!rid) { skipped += 1; continue; }
        const r2 = await putRoleOnUser(env, guildId, userId, rid);
        if (r2.ok) granted += 1;
        else skipped += 1;
      }
    }
    if (r.list_complete) break;
    cursor = r.cursor;
  }
  await env.LOADOUT_BOLTS.put(BACKFILL_MARKER_KEY(guildId), String(Date.now()));
  return { ok: true, scanned, granted, skipped };
}
