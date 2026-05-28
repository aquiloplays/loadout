// Minecraft SMP whitelist — paid-Patreon-only access.
//
// POLICY (Clay 2026-05-28 — PERMANENT):
//   Aquilo SMP access requires an ACTIVE paid Patreon pledge.
//   Free-tier Patreon links do NOT qualify. Pledge ends → access ends.
//   This replaces the previous unconditional / link-only access model.
//
// Architecture:
//   DiscordSRV runs on the MC server and reads role membership directly
//   from Discord. We maintain a "Minecraft Whitelist" Discord role on
//   the Aquilo guild; DSrv whitelists every member of that role + kicks
//   anyone removed from it. No Mojang API / RCON wiring needed — DSrv
//   bridges the role state. The MC server's `whitelist.json` is derived,
//   not authored here.
//
// Lifecycle:
//   1. POST /admin/mc-whitelist/ensure-role/:gid — provision (or reuse)
//      the "Minecraft Whitelist" role, store its id at KV
//      `mc-whitelist:role-id:<gid>`.
//   2. syncMcAccess(env, gid, userId) — check userHasPaidPatreon, add
//      or remove the role. DM the user on revoke. Idempotent.
//   3. Daily cron sweep — iterate every member currently holding the
//      role; downgrade anyone who flipped to non-paid (and DM them).
//   4. Patreon webhook (ext-patreon-link.js) calls syncMcAccess on
//      tier transitions so paid→free flips revoke immediately.
//
// KV:
//   mc-whitelist:role-id:<gid>     — the Discord role snowflake
//   mc-whitelist:dm-sent:<userId>  — '1' marker to throttle repeat
//                                    revoke DMs (TTL 7d so a user who
//                                    re-pledges + lapses again gets
//                                    re-notified)

import { userHasPaidPatreon } from './patreon-link.js';

const KV_ROLE_ID  = (gid)    => `mc-whitelist:role-id:${gid}`;
const KV_DM_SENT  = (userId) => `mc-whitelist:dm-sent:${userId}`;
const DM_TTL_S    = 7 * 24 * 60 * 60;

const ROLE_NAME   = 'Minecraft Whitelist';
const ROLE_COLOR  = 0x5bff95;   // aquilo aurora green — "earned access"

async function discordREST(env, method, path, body) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, status: 503, body: 'no-bot-token' };
  const r = await fetch('https://discord.com/api/v10' + path, {
    method,
    headers: {
      'Authorization': 'Bot ' + env.DISCORD_BOT_TOKEN,
      'Content-Type':  'application/json',
      'User-Agent':    'loadout-discord mc-whitelist',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed = null;
  try { parsed = await r.json(); } catch { /* not json */ }
  return { ok: r.ok, status: r.status, body: parsed };
}

// ── Role provisioning ────────────────────────────────────────────

export async function ensureWhitelistRole(env, guildId) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  if (!guildId) return { ok: false, error: 'no-guild-id' };
  // Reuse first: if the KV already has an id and Discord still has
  // a role by that id (cheap GET), keep it.
  let stored = null;
  try { stored = await env.LOADOUT_BOLTS.get(KV_ROLE_ID(guildId)); } catch { /* ignore */ }
  if (stored) {
    return { ok: true, roleId: stored, reused: true, source: 'kv' };
  }
  // Look for an existing role with the canonical name.
  const list = await discordREST(env, 'GET', `/guilds/${encodeURIComponent(guildId)}/roles`);
  if (list.ok && Array.isArray(list.body)) {
    const match = list.body.find(r =>
      String(r?.name || '').toLowerCase() === ROLE_NAME.toLowerCase());
    if (match?.id) {
      await env.LOADOUT_BOLTS.put(KV_ROLE_ID(guildId), String(match.id));
      return { ok: true, roleId: String(match.id), reused: true, source: 'discord-existing' };
    }
  }
  // Create fresh.
  const create = await discordREST(env, 'POST',
    `/guilds/${encodeURIComponent(guildId)}/roles`, {
      name: ROLE_NAME,
      color: ROLE_COLOR,
      hoist: false,
      mentionable: false,
      permissions: '0',
    });
  if (!create.ok || !create.body?.id) {
    return { ok: false, error: 'role-create-failed', status: create.status, body: create.body };
  }
  const roleId = String(create.body.id);
  await env.LOADOUT_BOLTS.put(KV_ROLE_ID(guildId), roleId);
  return { ok: true, roleId, reused: false, source: 'created' };
}

async function getRoleId(env, guildId) {
  try { return await env.LOADOUT_BOLTS.get(KV_ROLE_ID(guildId)); } catch { return null; }
}

// ── Sync one user ────────────────────────────────────────────────
//
// Check paid Patreon status; grant or revoke the MC whitelist role
// accordingly. DM on revoke (throttled to once per 7d to avoid
// spamming a user who repeatedly toggles).

const PATREON_URL_DEFAULT = 'https://www.patreon.com/cw/aquilo';

async function sendRevokeDM(env, userId, patreonUrl) {
  if (!env.DISCORD_BOT_TOKEN) return { sent: false, reason: 'no-bot-token' };
  // Throttle.
  try {
    const sent = await env.LOADOUT_BOLTS.get(KV_DM_SENT(userId));
    if (sent) return { sent: false, reason: 'throttled' };
  } catch { /* ignore */ }
  // Open DM channel.
  const ch = await discordREST(env, 'POST', '/users/@me/channels', { recipient_id: userId });
  if (!ch.ok || !ch.body?.id) return { sent: false, reason: 'dm-channel-failed', status: ch.status };
  const post = await discordREST(env, 'POST',
    `/channels/${ch.body.id}/messages`, {
      embeds: [{
        title: '🌲 Aquilo SMP access removed',
        description: [
          'Your Patreon pledge ended, so you\'ve been removed from the Aquilo SMP whitelist.',
          '',
          `Re-pledge to regain access → ${patreonUrl}`,
          '',
          'No worries if you\'re taking a break — your spot will be waiting whenever you\'re back.',
        ].join('\n'),
        color: 0x6e7588,   // subdued grey — not punitive
        footer: { text: 'Aquilo SMP · paid-Patreon-only since 2026-05' },
      }],
    });
  if (!post.ok) return { sent: false, reason: 'post-failed', status: post.status };
  try { await env.LOADOUT_BOLTS.put(KV_DM_SENT(userId), '1', { expirationTtl: DM_TTL_S }); }
  catch { /* ignore */ }
  return { sent: true, messageId: post.body?.id };
}

// Returns { ok, action: 'granted' | 'revoked' | 'unchanged', dm?: …, roleId, paid }
export async function syncMcAccess(env, guildId, userId) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  if (!guildId || !userId)   return { ok: false, error: 'missing-ids' };
  const roleId = await getRoleId(env, guildId);
  if (!roleId) return { ok: false, error: 'role-not-provisioned' };

  // Read current member roles to know if we need to add/remove.
  const m = await discordREST(env, 'GET',
    `/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(userId)}`);
  if (m.status === 404) {
    // User left the guild — nothing to do; DSrv will see them drop out
    // of the role automatically.
    return { ok: true, action: 'unchanged', reason: 'user-not-in-guild', roleId };
  }
  if (!m.ok) return { ok: false, error: 'member-fetch-failed', status: m.status };
  const memberRoles = Array.isArray(m.body?.roles) ? m.body.roles.map(String) : [];
  const hasRole = memberRoles.includes(String(roleId));

  const paid = await userHasPaidPatreon(env, userId);

  if (paid && !hasRole) {
    const add = await discordREST(env, 'PUT',
      `/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`);
    if (!add.ok && add.status !== 204) {
      return { ok: false, error: 'role-add-failed', status: add.status, body: add.body };
    }
    return { ok: true, action: 'granted', roleId, paid: true };
  }
  if (!paid && hasRole) {
    const del = await discordREST(env, 'DELETE',
      `/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`);
    if (!del.ok && del.status !== 204) {
      return { ok: false, error: 'role-remove-failed', status: del.status, body: del.body };
    }
    const dm = await sendRevokeDM(env, userId, env.PATREON_URL || PATREON_URL_DEFAULT);
    return { ok: true, action: 'revoked', roleId, paid: false, dm };
  }
  return { ok: true, action: 'unchanged', roleId, paid };
}

// ── Daily sweep ──────────────────────────────────────────────────
//
// Iterate every member currently holding the MC role; sync each.
// Idempotent — users who are still paid stay granted with no work,
// users who lapsed get revoked + DM'd. Caller (worker.js cron) hits
// this once per ET day via a marker so we don't loop hourly.
//
// Pagination cap: 50 pages × 1000 members = 50k max scan. Practical
// MC whitelist is tens of users; even 10k is fine.

export async function mcWhitelistDailySweep(env, guildId) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  const roleId = await getRoleId(env, guildId);
  if (!roleId) return { ok: false, error: 'role-not-provisioned' };

  let scanned = 0, granted = 0, revoked = 0, unchanged = 0, failed = 0;
  let after = '0';
  for (let page = 0; page < 50; page++) {
    const r = await discordREST(env, 'GET',
      `/guilds/${encodeURIComponent(guildId)}/members?limit=1000&after=${encodeURIComponent(after)}`);
    if (!r.ok || !Array.isArray(r.body) || r.body.length === 0) break;
    for (const m of r.body) {
      const uid = m.user?.id;
      if (!uid) continue;
      // Skip members who don't have the role — sweeping them would just
      // hit Patreon-check then conclude "not paid, no change" anyway.
      if (!Array.isArray(m.roles) || !m.roles.includes(String(roleId))) continue;
      scanned++;
      const out = await syncMcAccess(env, guildId, uid);
      if (!out.ok) failed++;
      else if (out.action === 'granted') granted++;
      else if (out.action === 'revoked') revoked++;
      else unchanged++;
    }
    after = r.body[r.body.length - 1].user?.id || after;
    if (r.body.length < 1000) break;
  }
  return { ok: true, roleId, scanned, granted, revoked, unchanged, failed };
}
