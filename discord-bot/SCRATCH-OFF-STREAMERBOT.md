# Scratch-off cards — Streamer.bot + Twitch bits wiring

The scratch-off subsystem (`scratch-off.js`) is fully working server-side:
viewers buy a card, scratch it open in the Twitch panel, and the worker
decides + reveals the outcome. Two things still need Clay's one-time setup
to close the loop on stream:

1. **Twitch bits product** so a "Buy" actually charges bits.
2. **Streamer.bot relay** so a `tamper` outcome actually messes with the
   game (invert mouse, swap WASD, mute mic, ...).

Neither blocks the demo: the panel mints through `/web/scratch/mint`, and
on localhost it mints without bits. Tampers already emit on the Aquilo Bus;
the relay just needs to listen and act.

---

## 1. Twitch bits product (SKU)

The panel calls `Twitch.ext.bits.useBits("scratch_card")`. Register a bits
product with that SKU:

- Twitch dev console → your Extension → **Monetization → Manage Bits Products**
- Create a product:
  - **SKU**: `scratch_card`  (the worker also accepts `scratch_card_100`
    and `aquilo_scratch_100` — see `SCRATCH_SKUS` in `scratch-off.js`)
  - **Cost**: `100` bits (or whatever you want; the worker records the
    receipt's amount)
  - **In development** until you submit the extension version for review.

On `onTransactionComplete` the panel POSTs the signed `transactionReceipt`
to `POST /web/scratch/mint`. The worker verifies that JWT when the
extension secret is set:

```
wrangler secret put TWITCH_EXT_SECRET     # base64 secret from the
                                          # extension's "Client Config"
```

`TWITCH_EXT_SECRET` is already set. Until/unless it is present the worker
decodes the receipt without verifying (so the test rig works) and tags the
ticket `verified:false`. **Set it before going live with real bits** so a
viewer cannot forge a receipt.

### Bit-purchase webhook (optional, server-to-server)

If you prefer Twitch's EBS transaction webhook over the panel receipt
path, point it at:

```
POST https://loadout-discord.aquiloplays.workers.dev/web/twitch/bit-purchase-webhook
header: x-scratch-webhook-secret: <SCRATCH_WEBHOOK_SECRET>
body:   { "userId", "userName", "sku", "bits", "transactionId" }
```

`SCRATCH_WEBHOOK_SECRET` is set as a worker secret (value in the gitignored
`discord-bot/.scratch-admin-token.local`). Repeated `transactionId`s are
idempotent — the same purchase returns the same ticket.

### Test without spending bits

```
# token = SCRATCH_ADMIN_TOKEN (gitignored .scratch-admin-token.local)
curl -X POST .../web/admin/scratch/test-mint \
  -H "x-scratch-token: $TOKEN" -H "content-type: application/json" \
  -d '{"userId":"me","userName":"Me"}'
```

---

## 2. Streamer.bot relay (tamper bridge)

When a scratched card hits a `tamper` outcome the worker emits on the
Aquilo Bus (activity DO):

```jsonc
// kind: "scratch.tamper"
{
  "kind": "scratch.tamper",
  "ticketId": "st_...",
  "viewer": "SomeViewer",
  "gameSlug": "fallout4",
  "actionKey": "invert_mouse",   // maps to a Streamer.bot action
  "durationSec": 60,
  "body": "Mouse inverted for 60 seconds. Good luck in the wasteland.",
  "forced": false                // true if fired via admin /trigger
}
```

`challenge` outcomes emit `scratch.challenge` (no actionKey — Clay performs
it; the panel/overlay just announces it).

### Turnkey path — reuse the existing overlay poller (no new relay needed)

The worker dual-publishes every hit (like `stream-checkin.js`):

- `publishActivity` → the site + community activity SSE (for the web viewer).
- `enqueueOverlay` → a `relay:overlay-*` KV trigger that **Clay's existing
  Streamer.bot poller already drains** via `GET /relay/pending?for=overlay`
  (RELAY_TOKEN-gated, deletes on read).

So the Streamer.bot side needs **no new process**. In the action that already
polls `/relay/pending?for=overlay`, branch on `trigger.type`:

```
trigger.type === "scratch_tamper"     -> run the action mapped from trigger.actionKey,
                                         for trigger.durationSec seconds
trigger.type === "scratch_challenge"  -> show trigger.body on the overlay / read it to chat
```

Trigger payloads:

```jsonc
{ "type":"scratch_tamper", "bus_kind":"scratch.tamper", "actionKey":"invert_mouse",
  "durationSec":60, "viewer":"SomeViewer", "gameSlug":"fallout4", "body":"...",
  "ticketId":"st_...", "forced":false, "ts":1780400000000 }
{ "type":"scratch_challenge", "bus_kind":"scratch.challenge", "body":"...",
  "durationSec":0, "viewer":"SomeViewer", "gameSlug":"fallout4", "ticketId":"st_...", "ts":... }
```

### Direct WS path (alternative)

Streamer.bot also exposes a local WebSocket server (default `ws://127.0.0.1:8080/`,
older builds `ws://127.0.0.1:21474/`). A standalone relay can instead subscribe
to the activity SSE and post a `DoAction` for the matching `actionKey`. Use this
only if you'd rather not extend the existing overlay poller.

### Action registry

The allowed `actionKey`s live in D1 `scratch_streamer_bot_action` (seeded
by `/web/admin/scratch/seed`). Map each one to a Streamer.bot action id:

| actionKey         | suggested Streamer.bot action                         |
|-------------------|-------------------------------------------------------|
| `invert_mouse`    | toggle invert Y (+X) for N seconds                    |
| `swap_wasd`       | remap W/S, A/D for N seconds                           |
| `lock_crouch`     | hold crouch key for N seconds                          |
| `force_jump`      | inject periodic jump presses                          |
| `mute_mic`        | mute mic input device for N seconds                   |
| `random_keys`     | inject random key presses                             |
| `mouse_drift`     | constant cursor nudge one direction                   |
| `force_walk`      | hold walk modifier                                    |
| `sensitivity_max` | spike look sensitivity                                |
| `flip_screen`     | OBS filter: flip game capture                         |
| `deafen`          | mute desktop/game audio output                        |
| `spam_emote`      | repeat in-game emote/taunt                            |

Most are AutoHotkey / vJoy / input-injection actions Clay already has or
can build; the timed ones use a Streamer.bot sub-action "wait N seconds"
then revert.

### Relay options

**A. Streamer.bot "Aquilo Bus" listener (recommended).** Run the tiny
Node relay (to be added under `streamerbot/`) that:

```
1. open an EventSource to the community SSE stream that already carries
   bus events (same one the site viewer uses)
2. on a scratch.tamper event, POST to the Streamer.bot WS:
     { "request":"DoAction",
       "action": { "name": "<mapped action for actionKey>" },
       "args": { "durationSec": <durationSec>, "viewer": <viewer> } }
```

**B. Stream Deck.** Bind a Streamer.bot action per `actionKey`; a Stream
Deck "Website" / "API" button or a Streamer.bot HTTP trigger fires it.
Manual but zero extra code.

### Admin trigger (challenges + manual re-fire)

`tamper` outcomes auto-fire on reveal. `challenge` outcomes wait for Clay
to confirm he performed them:

```
POST .../web/scratch/trigger/:ticketId   header x-scratch-token: $TOKEN
```

Re-emits the `scratch.tamper` / `scratch.challenge` bus event with
`forced:true` (handy to re-run a tamper, or to mark a challenge done).

---

## Bus event reference

| event              | when                                  | payload keys                                  |
|--------------------|---------------------------------------|-----------------------------------------------|
| `scratch.purchased`| ticket minted                         | ticketId, userId, viewer, gameSlug, bits      |
| `scratch.scratched`| viewer crosses 70% reveal             | ticketId, viewer, gameSlug, outcome, win      |
| `scratch.hit`      | revealed outcome is non-losing        | ticketId, viewer, gameSlug, kind2, body, durationSec |
| `scratch.tamper`   | a tamper fires (auto on reveal/forced)| ticketId, viewer, actionKey, durationSec, body, forced |
| `scratch.challenge`| a challenge announces/forced          | ticketId, viewer, body, durationSec, forced   |

All carry `kind` + `ts`. Subscribe via the same community SSE stream as the
other `activity-do` events.
