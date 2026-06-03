# aquilo-gateway

Standalone Discord gateway listener that forwards real-time events to the
Loadout Cloudflare Worker (`discord-bot/`). Lives in this repo so the
worker side and the shim side can move together.

The worker can only receive Discord events via the interactions webhook
(slash commands + buttons). Anything else, member joins, message
activity, reactions, voice state, needs a long-lived gateway connection.
This shim is that connection.

## What it forwards

| Discord event              | Worker route        |
| -------------------------- | ------------------- |
| `GUILD_MEMBER_ADD`         | `POST /member/joined` |
| `MESSAGE_CREATE`           | `POST /counting/message` (channel-gated by `/forward-channels`) |
| `MESSAGE_REACTION_ADD/REMOVE` | `POST /reaction/event` (worker uses `action` to skip un-stars) |
| `VOICE_STATE_UPDATE`       | `POST /voice/state` + `POST /voice/empty` when a tracked VC empties |

## Required env vars

| Name | What it is |
| --- | --- |
| `AQUILO_DISCORD_BOT_TOKEN` | Bot token for the Aquilo Discord app (1500849448866025573) |
| `AQUILO_WORKER_URL`        | `https://loadout-discord.aquiloplays.workers.dev` |
| `AQUILO_GATEWAY_SECRET`    | Random hex; same value set as a worker secret of the same name |

## Optional env vars

| Name | Default | What it does |
| --- | --- | --- |
| `AQUILO_GUILD_ALLOWLIST` | _unset (all guilds)_ | Comma-separated guild IDs; only listed guilds forward |
| `PORT` | `8080` | Railway sets this; `/healthz` binds `0.0.0.0:$PORT` |
| `AQUILO_FORWARD_CHANNELS_TTL` | `300` | Seconds between `/forward-channels` polls |

## Auth

Every POST carries both:

- `x-counting-secret: <AQUILO_GATEWAY_SECRET>`, legacy shared-secret path
- `x-aquilo-gw-ts: <unix-seconds>` + `x-aquilo-gw-sig: <hmac>`, HMAC path

The worker's `verifyGatewaySig` (`discord-bot/auth.js`) accepts either.
HMAC is the preferred path; the shared-secret header is kept for back-compat.

## Discord application setup

In the Aquilo Discord app's Developer Portal, enable these **privileged
intents** under Bot → Privileged Gateway Intents:

- Server Members Intent  (needed for `GUILD_MEMBER_ADD`)
- Message Content Intent (needed for `/counting/message` payloads)

The Presence intent is NOT required.

## Deploy on Railway

1. Create a **new service** in Railway and point it at this repo.
2. In the service's **Settings → Root Directory**, set `aquilo-gateway`
   so Railway builds + runs from this subfolder rather than the repo root.
3. In **Variables**, set the three required env vars above.
4. Save, Railway will detect `requirements.txt` + `runtime.txt` + `Procfile`
   via Nixpacks and build automatically.
5. Once the service is up, hit `https://<service>.up.railway.app/healthz`, should return `{"ok": true, "service": "aquilo-gateway",
   "connectionState": "ready", ...}` once the gateway connects.

## Local development

```bash
cd aquilo-gateway
python -m venv .venv
source .venv/bin/activate   # PowerShell: .venv\Scripts\Activate.ps1
pip install -r requirements.txt

export AQUILO_DISCORD_BOT_TOKEN=...
export AQUILO_WORKER_URL=https://loadout-discord.aquiloplays.workers.dev
export AQUILO_GATEWAY_SECRET=...
python aquilo_gateway.py
```

`/healthz` will be on `http://localhost:8080/healthz`. Tail the process
output to see `[gateway] ready as Aquilo ...` once the Discord
connection is up.

## Observability

`GET /healthz` returns:

```json
{
  "ok": true,
  "service": "aquilo-gateway",
  "uptime": 3600,
  "lastEventTs": 1779800000,
  "connectionState": "ready",
  "eventsForwarded": 1234,
  "eventsFailed": 2,
  "eventsDropped": 0,
  "forwardChannels": 3,
  "allowlist": ["1504103035951906883"]
}
```

`eventsFailed` ticks when the worker returns non-2xx. `eventsDropped`
ticks when the in-process queue overflows (worker degraded for several
minutes). Both are useful Railway log signals.
