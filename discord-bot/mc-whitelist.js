// Minecraft whitelist role, REMOVAL ONLY.
//
// Clay dropped Minecraft as a featured offering (2026-05-31). The old
// paid-Patreon "Minecraft Whitelist" role + its gating (ensure-role,
// per-user sync, daily sweep, revoke DMs) have been removed. The
// #smp-chat channel + the DiscordSRV bridge stay intact, only the
// Discord role and its gating were dropped.
//
// This module now exports a single one-shot helper used by the
// KV-token-gated /admin/_mc-role-delete endpoint to delete the role
// from Discord + clear its KV id. After the role is gone this module
// can be removed entirely.

const KV_ROLE_ID = (gid) => `mc-whitelist:role-id:${gid}`;
const ROLE_NAMES = ['minecraft whitelist', 'mc whitelist', 'minecraft player', 'patreon paid mc whitelist'];

async function discordREST(env, method, path) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, status: 503, body: 'no-bot-token' };
  const r = await fetch('https://discord.com/api/v10' + path, {
    method,
    headers: {
      'Authorization': 'Bot ' + env.DISCORD_BOT_TOKEN,
      'Content-Type':  'application/json',
      'User-Agent':    'loadout-discord mc-role-delete',
    },
  });
  let parsed = null;
  try { parsed = await r.json(); } catch { /* 204 No Content / non-json */ }
  return { ok: r.ok, status: r.status, body: parsed };
}

// Delete the MC whitelist role(s). Collects candidate role ids from
// (a) an explicit opts.roleId, (b) the KV-stored id, and (c) any guild
// role whose name matches a known MC-whitelist name. DELETEs each
// (404 = already gone = success) and clears the KV id. Returns a
// summary of what was deleted.
export async function deleteWhitelistRole(env, guildId, opts = {}) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  if (!guildId) return { ok: false, error: 'no-guild-id' };

  const targets = new Set();
  if (opts.roleId) targets.add(String(opts.roleId));
  try {
    const stored = await env.LOADOUT_BOLTS.get(KV_ROLE_ID(guildId));
    if (stored) targets.add(String(stored));
  } catch { /* ignore */ }

  // Discover by name so we also catch roles created out-of-band.
  const list = await discordREST(env, 'GET', `/guilds/${encodeURIComponent(guildId)}/roles`);
  const matchedNames = [];
  if (list.ok && Array.isArray(list.body)) {
    for (const role of list.body) {
      if (ROLE_NAMES.includes(String(role?.name || '').toLowerCase())) {
        targets.add(String(role.id));
        matchedNames.push({ id: String(role.id), name: role.name });
      }
    }
  }

  const deleted = [], failed = [];
  for (const roleId of targets) {
    const del = await discordREST(env, 'DELETE',
      `/guilds/${encodeURIComponent(guildId)}/roles/${encodeURIComponent(roleId)}`);
    // 204 = deleted, 404 = already gone, both are success.
    if (del.ok || del.status === 204 || del.status === 404) deleted.push({ roleId, status: del.status });
    else failed.push({ roleId, status: del.status, body: del.body });
  }

  // Clear the KV id so nothing references the dead role.
  try { await env.LOADOUT_BOLTS.delete(KV_ROLE_ID(guildId)); } catch { /* ignore */ }

  return {
    ok: failed.length === 0,
    guildId,
    deleted,
    failed,
    matchedByName: matchedNames,
  };
}
