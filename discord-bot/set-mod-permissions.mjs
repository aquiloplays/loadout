#!/usr/bin/env node
// One-shot admin script: PATCH the Aquilo Staff (mod) role on the
// configured guild with the best-practice moderator permission
// bitfield documented in MOD-PERMISSIONS.md.
//
// Run:
//   DISCORD_BOT_TOKEN=<bot-token> \
//   AQUILO_GUILD_ID=<guild-snowflake> \
//   MOD_ROLE_ID=1507973879442964660 \
//     node discord-bot/set-mod-permissions.mjs
//
// Flags:
//   --list       Dump every guild role (id, name, position, managed) so
//                you can confirm the mod role id + that the bot sits
//                above it. No PATCH. MOD_ROLE_ID not required.
//   --dry-run    Print the bitfield + intended PATCH body, do not call Discord.
//   --verify     After PATCH, GET the role back and confirm the
//                permissions field round-trips. (default: on)
//
// The bot token MUST belong to a bot with Manage Roles permission AND
// a role higher than MOD_ROLE_ID in the role hierarchy. Discord rejects
// the PATCH otherwise with 403 missing-permissions.
//
// NO secrets are echoed: the token is read from env, never logged.

// ── Best-practice mod permission map ──────────────────────────────
// Bit positions per Discord's permission flag table:
//   https://discord.com/developers/docs/topics/permissions
const ALLOW = Object.freeze({
  KICK_MEMBERS:              1,
  BAN_MEMBERS:               2, // permanent removal — granted to staff-lead mods
  MANAGE_CHANNELS:           4, // create / edit channels
  ADD_REACTIONS:             6,
  VIEW_AUDIT_LOG:            7,
  VIEW_CHANNEL:             10,
  SEND_MESSAGES:            11,
  MANAGE_MESSAGES:          13,
  EMBED_LINKS:              14,
  ATTACH_FILES:             15,
  READ_MESSAGE_HISTORY:     16,
  USE_EXTERNAL_EMOJIS:      18,
  MUTE_MEMBERS:             22,
  DEAFEN_MEMBERS:           23,
  MOVE_MEMBERS:             24,
  MANAGE_NICKNAMES:         27,
  MANAGE_ROLES:             28, // assign roles below their own position
  USE_APPLICATION_COMMANDS: 31, // "Use Slash Commands"
  MANAGE_EVENTS:            33,
  MANAGE_THREADS:           34,
  SEND_MESSAGES_IN_THREADS: 38,
  MODERATE_MEMBERS:         40, // "Timeout Members"
});

// Flags that must stay OFF on any mod role. Decoded after PATCH as a
// safety net so a typo in ALLOW never accidentally grants one of these.
// These are the genuinely account-owning / self-escalating perms that a
// mod (even a staff-lead) should never hold; reserve for the owner.
const FORBIDDEN = Object.freeze({
  ADMINISTRATOR:            3,
  MANAGE_GUILD:             5,
  MENTION_EVERYONE:        17,
  VIEW_GUILD_INSIGHTS:     19,
  MANAGE_WEBHOOKS:         29,
  MANAGE_GUILD_EXPRESSIONS:30,
});

function computeBitfield(flagMap) {
  let bf = 0n;
  for (const pos of Object.values(flagMap)) bf |= (1n << BigInt(pos));
  return bf;
}

function dumpFlags(bitfield, flagMap, label) {
  console.log(`-- ${label} --`);
  for (const [name, pos] of Object.entries(flagMap)) {
    const mask = 1n << BigInt(pos);
    const set = (bitfield & mask) !== 0n ? 'yes' : 'no ';
    console.log(`  ${name.padEnd(28)} bit=${String(pos).padStart(2)}  set=${set}`);
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run');
  const list   = args.has('--list');
  const verify = !args.has('--no-verify');

  const token  = process.env.DISCORD_BOT_TOKEN;
  const guild  = process.env.AQUILO_GUILD_ID;
  const role   = process.env.MOD_ROLE_ID;
  if (!token)  { console.error('Missing env DISCORD_BOT_TOKEN'); process.exit(1); }
  if (!guild)  { console.error('Missing env AQUILO_GUILD_ID');   process.exit(1); }

  // --list: dump every role (id, name, position, perms) so we can
  // confirm WHICH role the mods hold + verify the bot's own role sits
  // above it in the hierarchy. No PATCH, MOD_ROLE_ID not required.
  if (list) {
    const res = await fetch(`https://discord.com/api/v10/guilds/${encodeURIComponent(guild)}/roles`, {
      headers: { Authorization: 'Bot ' + token, 'User-Agent': 'loadout-discord set-mod-permissions' },
    });
    if (!res.ok) { console.error(`GET roles failed: ${res.status} ${(await res.text()).slice(0,300)}`); process.exit(3); }
    const roles = await res.json();
    roles.sort((a, b) => b.position - a.position); // highest first
    console.log('pos  managed  id                    name');
    for (const r of roles) {
      console.log(`${String(r.position).padStart(3)}  ${r.managed ? 'BOT ' : '    '}     ${r.id.padEnd(20)}  ${r.name}`);
    }
    console.log('\nThe bot can only PATCH a role BELOW its own "BOT"-managed role.');
    console.log('Set MOD_ROLE_ID to the role your mods hold, then re-run without --list.');
    return;
  }

  if (!role)   { console.error('Missing env MOD_ROLE_ID');       process.exit(1); }

  const bf = computeBitfield(ALLOW);
  const bfStr = bf.toString();

  console.log(`Target: guild=${guild}, role=${role}`);
  console.log(`Bitfield: ${bfStr}  (hex 0x${bf.toString(16)})`);
  console.log();
  dumpFlags(bf, ALLOW, 'ALLOW (all must be set)');
  console.log();
  dumpFlags(bf, FORBIDDEN, 'FORBIDDEN (none must be set)');

  // Self-verify before any network call.
  for (const [name, pos] of Object.entries(FORBIDDEN)) {
    const mask = 1n << BigInt(pos);
    if ((bf & mask) !== 0n) {
      console.error(`ABORT: forbidden flag ${name} is set in computed bitfield`);
      process.exit(2);
    }
  }
  for (const [name, pos] of Object.entries(ALLOW)) {
    const mask = 1n << BigInt(pos);
    if ((bf & mask) === 0n) {
      console.error(`ABORT: required flag ${name} is NOT set in computed bitfield`);
      process.exit(2);
    }
  }

  if (dryRun) {
    console.log();
    console.log('--dry-run set, no PATCH issued.');
    return;
  }

  const url = `https://discord.com/api/v10/guilds/${encodeURIComponent(guild)}/roles/${encodeURIComponent(role)}`;
  const body = JSON.stringify({ permissions: bfStr });
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: 'Bot ' + token,
      'Content-Type': 'application/json',
      'User-Agent': 'loadout-discord set-mod-permissions',
      'X-Audit-Log-Reason': 'aquilo: set best-practice mod permissions',
    },
    body,
  });
  if (!res.ok) {
    const txt = await res.text();
    console.error(`PATCH failed: ${res.status} ${txt.slice(0, 400)}`);
    process.exit(3);
  }
  const json = await res.json();
  console.log();
  console.log(`PATCH ok. Discord reports role permissions = ${json.permissions}`);

  if (verify) {
    const got = BigInt(json.permissions || '0');
    if (got !== bf) {
      console.error(`Verify FAILED: got ${got}, expected ${bf}`);
      process.exit(4);
    }
    console.log('Round-trip verify: ok.');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
