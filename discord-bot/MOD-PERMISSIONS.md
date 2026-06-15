# Aquilo mod role permissions

Reproducible record of the best-practice permission bitfield applied
to the Aquilo Staff (mod) role on Discord.

## Target role

- Role name: Aquilo Staff
- Role id: `1507973879442964660`
- Applied via PATCH `https://discord.com/api/v10/guilds/{guild_id}/roles/{role_id}`

## Permission bitfield

```
1402470788290
```

Hex: `0x14689c5ecc2`

Computed by ORing the bit positions of the flags below. Reproduce with
`node discord-bot/set-mod-permissions.mjs --dry-run` (the script
self-verifies that every ALLOW flag is set and no FORBIDDEN flag is
set before issuing the PATCH).

## Flags granted (19)

| Flag                       | Bit | Why                                              |
|----------------------------|----:|--------------------------------------------------|
| View Channels              |  10 | See the channel they're modding                  |
| Send Messages              |  11 | Reply / warn in channel                          |
| Send Messages in Threads   |  38 | Reply inside forum / thread channels             |
| Embed Links                |  14 | Send rich responses, link to rule docs           |
| Attach Files               |  15 | Send screenshots in mod-log replies              |
| Add Reactions              |   6 | React on reports, signal "seen"                  |
| Use External Emojis        |  18 | Use server emojis in replies                     |
| Use Slash Commands         |  31 | Use mod tooling                                  |
| Read Message History       |  16 | See context before deleting / pinning            |
| Manage Messages            |  13 | Delete, pin, unpin messages from others          |
| Manage Threads             |  34 | Archive, rename, lock threads                    |
| Manage Nicknames           |  27 | Clean up spam display names                      |
| Manage Events              |  33 | Start, stop, edit events                         |
| View Audit Log             |   7 | Investigate when a report comes in               |
| Kick Members               |   1 | Remove rule-breakers (rejoinable)                |
| Timeout Members            |  40 | The big one: temporary mute without permaban     |
| Mute Members (voice)       |  22 | Server-wide voice mute                           |
| Deafen Members (voice)     |  23 | Server-wide voice deafen                         |
| Move Members (voice)       |  24 | Drag between voice channels                      |

## Flags explicitly NOT granted (9)

| Flag                       | Bit | Why withheld                                     |
|----------------------------|----:|--------------------------------------------------|
| Administrator              |   3 | Bypasses every other check, never to mods        |
| Ban Members                |   2 | Permanent; timeout + kick covers most cases      |
| Manage Guild               |   5 | Edits server settings                            |
| Manage Channels            |   4 | Create / delete channels                         |
| Manage Roles               |  28 | Privilege escalation risk                        |
| Manage Webhooks            |  29 | Webhooks can exfiltrate data                     |
| Manage Guild Expressions   |  30 | Emoji / sticker management, mods don't need it   |
| View Guild Insights        |  19 | Member analytics, privacy                        |
| Mention @everyone          |  17 | Avoid mass-ping mistakes                         |

Reserve Ban Members + Manage Guild + Manage Roles for the server owner
or staff-lead role only.

## How to apply

The script lives at `discord-bot/set-mod-permissions.mjs`. It reads the
bot token from the environment (never logs it), validates the bitfield
against ALLOW / FORBIDDEN sets, PATCHes the role, then GETs the role
back to round-trip verify.

### Dry run (no Discord call)

```
DISCORD_BOT_TOKEN=<bot-token> \
AQUILO_GUILD_ID=<guild-snowflake> \
MOD_ROLE_ID=1507973879442964660 \
  node discord-bot/set-mod-permissions.mjs --dry-run
```

Prints the bitfield, the ALLOW dump, the FORBIDDEN dump, then exits.

### Live apply

```
DISCORD_BOT_TOKEN=<bot-token> \
AQUILO_GUILD_ID=<guild-snowflake> \
MOD_ROLE_ID=1507973879442964660 \
  node discord-bot/set-mod-permissions.mjs
```

### Raw curl equivalent (if Node is unavailable)

```
curl -X PATCH \
  -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Audit-Log-Reason: aquilo: set best-practice mod permissions" \
  -d '{"permissions":"1402470788290"}' \
  "https://discord.com/api/v10/guilds/$AQUILO_GUILD_ID/roles/1507973879442964660"
```

## Prerequisites

The bot must:

1. Have the Manage Roles permission on the guild.
2. Have a role positioned above the mod role in the role list. Discord
   rejects PATCH with 403 otherwise.

## Post-apply verification

After running the script, manually verify:

- A user with the mod role can right-click a member and see Timeout.
- A user with the mod role can delete another member's message.
- A user with the mod role CANNOT manage roles (Server Settings >
  Roles is greyed out).
- A user with the mod role CANNOT ban (right-click member > Ban is
  greyed out / hidden).

Run `--dry-run` any time you want to confirm the intended bitfield
without touching Discord.
