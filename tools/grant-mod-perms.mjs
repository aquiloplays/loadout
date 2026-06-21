#!/usr/bin/env node
// Grant the moderator role its standard permissions on Aquilo's Discord
// servers, directly via the Discord API. Use this to give mods real powers
// WITHOUT deploying the Worker or clicking through Server Settings > Roles.
//
// Usage (PowerShell):
//   $env:DISCORD_BOT_TOKEN="xxxxx"; node tools/grant-mod-perms.mjs            # dry run, shows the plan
//   $env:DISCORD_BOT_TOKEN="xxxxx"; node tools/grant-mod-perms.mjs --apply    # actually update the roles
//
// Usage (bash):
//   DISCORD_BOT_TOKEN=xxxxx node tools/grant-mod-perms.mjs [--apply]
//
// The token is the same one the discord-bot Worker uses (wrangler secret
// DISCORD_BOT_TOKEN). It is read from the environment only and never written
// anywhere. Dry run is the default; nothing changes until you pass --apply.

const API = 'https://discord.com/api/v10';

// Standard moderator grant: kick, ban, timeout, manage messages/threads/
// nicknames, voice mute/deafen/move, view audit log. Deliberately NOT
// Administrator / Manage Guild / Manage Roles / Manage Channels. Mirrors
// MOD_PERMS in discord-bot/server-spec.js exactly.
const MOD_PERMS = (
  (1n << 1n)  | // KICK_MEMBERS
  (1n << 2n)  | // BAN_MEMBERS
  (1n << 7n)  | // VIEW_AUDIT_LOG
  (1n << 13n) | // MANAGE_MESSAGES
  (1n << 22n) | // MUTE_MEMBERS
  (1n << 23n) | // DEAFEN_MEMBERS
  (1n << 24n) | // MOVE_MEMBERS
  (1n << 27n) | // MANAGE_NICKNAMES
  (1n << 34n) | // MANAGE_THREADS
  (1n << 40n)   // MODERATE_MEMBERS (timeout)
).toString();

// guildId -> candidate mod-role names (first exact match wins; otherwise falls
// back to any non-@everyone role whose name contains "mod" or "staff").
const TARGETS = [
  { guildId: '1504103035951906883', label: 'Aquilo (main)',       names: ['\u{1F6E1}️ Moderator', 'Moderator'] },
  { guildId: '1516302043352928336', label: "Aquilo's Vault (FO76)", names: ['\u{1F6E1}️ Vault-Tec Staff', 'Vault-Tec Staff'] },
];

const PERM_BITS = {
  1: 'KICK_MEMBERS', 2: 'BAN_MEMBERS', 7: 'VIEW_AUDIT_LOG', 13: 'MANAGE_MESSAGES',
  22: 'MUTE_MEMBERS', 23: 'DEAFEN_MEMBERS', 24: 'MOVE_MEMBERS', 27: 'MANAGE_NICKNAMES',
  34: 'MANAGE_THREADS', 40: 'MODERATE_MEMBERS',
};

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error('ERROR: set DISCORD_BOT_TOKEN in the environment first.');
  process.exit(1);
}
const APPLY = process.argv.includes('--apply');

function decode(permStr) {
  const p = BigInt(permStr || '0');
  const have = [];
  for (const [bit, name] of Object.entries(PERM_BITS)) {
    if (p & (1n << BigInt(bit))) have.push(name);
  }
  const admin = (p & (1n << 3n)) ? '  [!! ADMINISTRATOR]' : '';
  return (have.join(', ') || '(none)') + admin;
}

async function dapi(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { ok: res.ok, status: res.status, body: json };
}

function findRole(roles, names) {
  for (const n of names) {
    const r = roles.find((x) => x.name === n);
    if (r) return r;
  }
  return roles.find((x) => x.name !== '@everyone' && /mod|staff/i.test(x.name)) || null;
}

console.log(APPLY ? '== APPLY mode: roles WILL be updated ==\n' : '== DRY RUN (pass --apply to write) ==\n');

let exit = 0;
for (const t of TARGETS) {
  console.log(`# ${t.label}  (guild ${t.guildId})`);
  const rolesRes = await dapi('GET', `/guilds/${t.guildId}/roles`);
  if (!rolesRes.ok) {
    console.log(`  ! could not fetch roles: ${rolesRes.status} ${JSON.stringify(rolesRes.body)}`);
    console.log('    (404/403 here usually means the bot is not in this guild.)\n');
    exit = 1;
    continue;
  }
  const role = findRole(rolesRes.body, t.names);
  if (!role) {
    console.log('  ! no Moderator/Staff role matched. Roles present:');
    for (const r of rolesRes.body) if (r.name !== '@everyone') console.log(`      - ${r.name}  (${r.id})`);
    console.log('    Edit TARGETS[].names in this script to match, then re-run.\n');
    exit = 1;
    continue;
  }
  console.log(`  role   : ${role.name}  (${role.id})`);
  console.log(`  current: ${decode(role.permissions)}`);
  console.log(`  target : ${decode(MOD_PERMS)}`);
  if (role.permissions === MOD_PERMS) {
    console.log('  -> already correct, nothing to do.\n');
    continue;
  }
  if (!APPLY) {
    console.log('  -> WOULD update (dry run).\n');
    continue;
  }
  const patch = await dapi('PATCH', `/guilds/${t.guildId}/roles/${role.id}`, { permissions: MOD_PERMS });
  if (patch.ok) {
    console.log(`  -> updated. now: ${decode(patch.body.permissions)}\n`);
  } else {
    console.log(`  ! PATCH failed: ${patch.status} ${JSON.stringify(patch.body)}`);
    console.log('    If 403: drag the bot role above the mod role in Server Settings > Roles, then re-run.\n');
    exit = 1;
  }
}
process.exit(exit);
