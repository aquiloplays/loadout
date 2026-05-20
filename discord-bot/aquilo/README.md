# aquilo-bot — Worker edition

Cloudflare Worker drop-in replacement for the Node service in `../src/`.
Same functional surface, zero hosting cost on free tier (100k req/day).

## What's the same vs the Railway version

| Surface | Status |
|---|---|
| `POST /announce` | identical |
| `POST /broadcast` | identical |
| `POST /fourthwall` | identical |
| `GET /health` | identical |
| `GET /` (landing page) | dropped (cosmetic only) |
| `/announce` slash command | identical, served via Discord HTTP interactions instead of the Discord.js Gateway |

Auth, payload shape, env config — all identical. Existing callers (the
GitHub Actions release workflow that posts to `/announce`, Fourthwall's
webhook config) need only to swap the URL.

## Migrate from Railway in 5 minutes

```bash
cd ~/Desktop/aquilo-bot/worker
npm install                              # installs wrangler
npx wrangler login                       # one-time auth

# Set secrets (these prompt for the value, never echoed to disk).
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put AQUILO_BOT_SECRET

# Edit wrangler.toml [vars] block:
#   DISCORD_APP_ID  = "<your app id>"
#   STAFF_ROLE_ID   = "<role id>"
#   PRODUCTS        = '{"loadout":{"channel":"...","role_ping":"..."}, ...}'
#   FOURTHWALL_SALES_CHANNEL = "<channel id>"

npx wrangler deploy

# Deploy prints a *.workers.dev URL. Update Discord developer portal:
#   General Information → Interactions Endpoint URL = <url>/interactions
# Update Fourthwall webhook config to point at <url>/fourthwall.
# Update your release workflow to POST <url>/announce.
```

After confirming everything works against the Worker, you can delete the
Railway service.

## Why the Worker version

- **Free.** 100k req/day covers any realistic announcement load.
- **No idle cost.** Railway charges $5/mo to keep the dyno warm 24/7.
- **No discord.js dependency.** ~280KB of node_modules → zero deps.
- **Faster.** Edge-deployed → slash commands feel snappier worldwide.
- **Simpler ops.** No container to monitor; CF restarts on deploy.

## What stays on Node

The original `../src/` Railway service still works — keep it deployed
during migration, point `wrangler dev` at a test Discord guild for the
slash command, validate everything moves cleanly, then cut over and
shut down Railway.
