# Bot consolidation — execution status

Companion to `BOT-CONSOLIDATION-PLAN.md`. Tracks what's actually shipped
during this consolidation pass.

> **Clay's voice-channel call (2026-05-20):** "forget the voice channel
> feature. Scrap it completely." That removes the only piece that
> needed a persistent Discord Gateway connection — every remaining
> feature can run inside Cloudflare Workers, so the standalone
> Node-on-Railway `StreamFusion/bot-service` daemon disappears
> entirely.

## What this pass shipped

### ✅ StreamFusion `bot-service` deleted from the SF repo
Commit `aquiloplays/StreamFusion@113194b` removes
`StreamFusion/bot-service/index.js`, `package.json`, and `README.md`.
The voice-channel detection, the SSE fan-out, the Patreon-identity
verification path, and the `/post-release` endpoint that all lived
there are gone. The Railway service that ran this daemon is now
unowned and can be decommissioned.

### ✅ `/sf/post-release` ported to the Loadout Worker
The one feature from `bot-service` that was actually worth keeping —
the GitHub-release-notes webhook — moved into the Loadout Worker.

- **New file:** `discord-bot/sf-release.js`
- **New route:** `POST https://loadout-discord.aquiloplays.workers.dev/sf/post-release`
- **Auth:** `X-SF-Release-Secret` header, value = `SF_RELEASE_SECRET`
  worker secret (set during deploy).
- **Default embed colour** flipped from the old SF blue
  (`0x3A86FF`) to aquilo violet (`0x7C5CFF`) so the embed colour
  matches the post-rebrand brand. Callers can still override.
- **Bot identity:** posts as the unified Loadout bot
  (`1500849448866025573`), not the retired StreamFusion app
  (`1494759611922645003`). That's by design — one bot is the whole
  point of the consolidation.

### Deferred (but planned + scoped — see below)

- `aquilo-bot/worker/` fold-in into the Loadout Worker.
- aquilo-bot app retirement.
- StreamFusion app retirement.
- PWA push subscription identity-linking (the other session has
  already shipped most of this — see "What's already done by the
  other session" below).

## Why aquilo-bot wasn't folded in this pass

The aquilo-bot Worker is substantial — ~40 modules, a KV namespace
(`STATE`), a D1 database (`aquilo_bot_db`), a Durable Object
(`OverlayBroadcaster` powering a live "today's game" WebSocket push),
hourly + half-hourly cron triggers, and a thirteen-slash-command
surface (`/announce`, `/hub`, `/setup`, `/suggest`, `/encounter`,
`/passport`, `/birthday`, `/shop`, `/sr-add`, `/sr-list`,
`/sr-remove`, `/sr-clear`, `/rotation-poll`).

Three concrete reasons a one-shot fold-in is risky:

1. **Durable Object identity is pinned to a Worker script.** Cloudflare
   DOs live attached to the Worker that declares the class — to
   migrate `OverlayBroadcaster` from the aquilo-bot Worker to the
   loadout-discord Worker requires creating a new DO class in
   loadout-discord, deploying a `[[migrations]]` block, optionally
   data-migrating, and re-pointing the overlay clients. Done
   incorrectly, the live "today's game" socket goes dark
   mid-broadcast. This is a careful operation with a rollback plan,
   not a one-shot deploy.

2. **Component `custom_id` prefix collision.** Loadout's viewer hub
   menu uses `hub:*` for every button click (`hub:home`,
   `hub:loadout`, `hub:stocks:portfolio`, etc.). The aquilo-bot
   admin hub uses the *same* `hub:*` prefix for its OWN button
   tree. Folding both into one Worker without renaming one side
   breaks every cached button in already-delivered Discord messages
   on the side we rename. The plan calls for renaming aquilo's to
   `aquilo:*` — safe at the new-worker level but it'll bork old
   admin-hub messages until those naturally roll out of
   message-cache.

3. **Cron-trigger limit.** Cloudflare's free Worker plan caps each
   Worker at 5 cron triggers. Loadout currently uses 4 (stocks :17,
   sports/bolts-feed/clash :23, queue-open EST and EDT). Adding
   aquilo-bot's `0,30 * * * *` would put us at exactly the limit
   (and the prior :13 9 Clash cron was already over) — workable, but
   it means **no further cron slots are available for anything
   else** without upgrading the plan or further folding.

Given those three, the safest move was: ship the small, isolable
piece (`/sf/post-release`) plus the cleanup that was already safe to
do (deleting `bot-service/`), and stage the aquilo-bot fold-in as a
properly-scoped follow-up.

## What's already done by the other session

The other session that's been working on aquilo-site has shipped
pieces that complement this consolidation — flagging them so we
don't redo work.

- **`functions/api/push/external.js`** with `audience.userIds`
  filtering — the canonical version that ships with master, gated
  by `AQUILO_SITE_WEB_SECRET` + `x-aquilo-web-ts/sig` headers.
  Loadout's `clash-push.js` was rewired to match this contract.
- **PWA push subscribe** appears to now store a Discord identity
  alongside each subscription endpoint, so `audience.userIds`
  actually filters fan-out. (See aquilo-site master commit
  `e3eae71`.)
- **`functions/api/clash/sync/[[route]].js`** — the aquilo-site
  read-through proxy that backs the future drag-and-drop base
  editor.

This means most of what was deferred at the end of Phase 4
("aquilo-site side") is in motion in the other session.

## Cutover steps that genuinely need Clay

### Immediate (so SF release-notes don't break)
1. **Update the StreamFusion release-publish workflow** to call the
   new endpoint:
   - Old URL: `https://<railway>/post-release`
   - New URL: `https://loadout-discord.aquiloplays.workers.dev/sf/post-release`
   - Old auth: JSON-body `secret` field
   - New auth: `X-SF-Release-Secret: <value>` header
   - New secret value (already set on the worker):
     `3e952f60b63f28195a01740e9607978f77a3ffb59fb841a992f6514bb5d15332`
2. **Decommission the `streamfusion-bot-service` Railway service.**
   It's serving nothing useful now.

### Soon (so consolidation completes)
3. **`DISCORD_BOT_TOKEN` rotation on the Loadout worker.** The current
   stored token is returning 401 from Discord when the worker tries
   to register slash commands (this is the same issue blocking
   `/clash` registration). Open the Discord developer portal → app
   `1500849448866025573` → Bot tab → Reset Token → paste new value
   into:
   ```
   cd discord-bot
   echo "<paste-token>" | npx wrangler secret put DISCORD_BOT_TOKEN
   ```
4. **Run command registration once** (via the CLI or the HMAC route)
   to push `/clash`, `/queue`, and the rest of the live command
   tree. This is the same fix that unblocks `/clash` in Discord.

### Phase 1.5 (the actual aquilo-bot fold-in — separate session)
5. Move `aquilo-bot/worker/*.js` into `discord-bot/aquilo/*.js`.
6. Rename `hub:*` `custom_id` prefixes in the moved files to
   `aquilo:*`; rename `/hub` slash command to `/aquilo-hub` (per
   the plan). Touch every modal `custom_id` for symmetry
   (`hub:modal:*` → `aquilo:modal:*`).
7. Add bindings to `discord-bot/wrangler.toml`:
   - `[[kv_namespaces]] binding = "STATE" id = "4db0dbf47be44d49a6186aeafc0bdb2d"`
   - `[[d1_databases]] binding = "DB" database_name = "aquilo_bot_db" database_id = "292de930-cfb3-49dd-aa65-e1d1d67ad3e4"`
   - `[[durable_objects.bindings]] name = "OVERLAY_DO" class_name = "OverlayBroadcaster"`
   - `[[migrations]] tag = "v1-overlay-do" new_sqlite_classes = ["OverlayBroadcaster"]`
8. Add the aquilo `[vars]` block to wrangler.toml (`SCHEDULE_CHANNEL_ID`,
   `POLL_CHANNEL_ID`, `QUEUE_CHANNEL_ID`, `QUEUE_ELIGIBLE_ROLES_JSON`,
   `PATREON_URL`, etc.).
9. Add the aquilo cron (`0,30 * * * *`) to `[triggers].crons`. This
   pushes us to 5 — the free-plan ceiling — so no further cron
   triggers are addable without upgrading.
10. Wire dispatchers: aquilo command cases in `commands.js`,
    component `aquilo:*` prefix routing, `MODAL_SUBMIT` prefix
    routing, `scheduled()` branch for the new cron.
11. Add the 13 aquilo command specs to `commands-spec.js`. Rename
    `/hub` → `/aquilo-hub`.
12. Test build (`node discord-bot/test/test-clash.mjs` for
    regression, smoke-test new aquilo modules where possible).
13. Deploy.
14. Re-register the unified command list with Discord.
15. **Decommission the aquilo-bot Worker** (`wrangler delete
    aquilo-bot` once the new fold-in is live and traffic has rolled
    over).

### Phase 2 (Discord app retirement)
16. Once aquilo-bot Worker is retired AND no servers depend on the
    StreamFusion or aquilo-bot Discord apps:
    - **Retire StreamFusion app** (`1494759611922645003`) in the
      Discord developer portal.
    - **Retire aquilo-bot app** (`1500929968002044075`).
    - Surviving Discord app: **Loadout** (`1500849448866025573`).
    - For every server that still had the old bots invited, ask
      admins to invite the Loadout bot and remove the old ones.
      One-shot DM to a handful of admins; no engineering work.

## File mapping reference (for the deferred fold-in)

When the aquilo-bot fold-in happens, the file moves are mechanical.
For tracking:

```
aquilo-bot/worker/worker.js          → discord-bot/aquilo/worker.js       (entrypoint; merged into discord-bot/worker.js dispatch)
aquilo-bot/worker/auth.js            → discord-bot/aquilo/auth.js         (or merge into discord-bot/auth.js — same verifyHmac)
aquilo-bot/worker/embed.js           → discord-bot/aquilo/embed.js
aquilo-bot/worker/products.js        → discord-bot/aquilo/products.js
aquilo-bot/worker/config.js          → discord-bot/aquilo/config.js
aquilo-bot/worker/hub.js             → discord-bot/aquilo/hub.js          (rename hub:* customIds to aquilo:*)
aquilo-bot/worker/setup.js           → discord-bot/aquilo/setup.js
aquilo-bot/worker/bootstrap.js       → discord-bot/aquilo/bootstrap.js
aquilo-bot/worker/util.js            → discord-bot/aquilo/util.js
aquilo-bot/worker/overlay-do.js      → discord-bot/aquilo/overlay-do.js   (Durable Object class — needs migration block)
aquilo-bot/worker/poll.js            → discord-bot/aquilo/poll.js
aquilo-bot/worker/daily-poll.js      → discord-bot/aquilo/daily-poll.js
aquilo-bot/worker/queue.js           → discord-bot/aquilo/aq-queue.js     (renamed — discord-bot already has queue.js for community-night queue)
aquilo-bot/worker/rotation-poll.js   → discord-bot/aquilo/rotation-poll.js
aquilo-bot/worker/song-prequeue.js   → discord-bot/aquilo/song-prequeue.js
aquilo-bot/worker/notify.js          → discord-bot/aquilo/notify.js
aquilo-bot/worker/recap.js           → discord-bot/aquilo/recap.js
aquilo-bot/worker/prompts.js         → discord-bot/aquilo/prompts.js
aquilo-bot/worker/countdown.js       → discord-bot/aquilo/countdown.js
aquilo-bot/worker/spotlight.js       → discord-bot/aquilo/spotlight.js
aquilo-bot/worker/cleanup.js         → discord-bot/aquilo/cleanup.js
aquilo-bot/worker/self-roles.js      → discord-bot/aquilo/self-roles.js
aquilo-bot/worker/counting.js        → discord-bot/aquilo/counting.js
aquilo-bot/worker/today-game.js      → discord-bot/aquilo/today-game.js
aquilo-bot/worker/checkin.js         → discord-bot/aquilo/checkin.js
aquilo-bot/worker/clipoftheweek.js   → discord-bot/aquilo/clipoftheweek.js
aquilo-bot/worker/passport.js        → discord-bot/aquilo/passport.js
aquilo-bot/worker/birthdays.js       → discord-bot/aquilo/birthdays.js
aquilo-bot/worker/trivia.js          → discord-bot/aquilo/trivia.js
aquilo-bot/worker/shop.js            → discord-bot/aquilo/shop.js
aquilo-bot/worker/streak.js          → discord-bot/aquilo/streak.js
aquilo-bot/worker/welcome.js         → discord-bot/aquilo/welcome.js
aquilo-bot/worker/returning.js       → discord-bot/aquilo/returning.js
aquilo-bot/worker/leaderboard-channel.js → discord-bot/aquilo/leaderboard-channel.js
aquilo-bot/worker/encounter.js       → discord-bot/aquilo/encounter.js
aquilo-bot/worker/suggestions.js     → discord-bot/aquilo/suggestions.js
aquilo-bot/worker/tickets.js         → discord-bot/aquilo/tickets.js
aquilo-bot/worker/idle-msgs.js       → discord-bot/aquilo/idle-msgs.js
aquilo-bot/worker/goals.js           → discord-bot/aquilo/goals.js
aquilo-bot/worker/viewer-hub.js      → discord-bot/aquilo/viewer-hub.js   (Loadout already has hub-menu.js — separate file)
aquilo-bot/worker/schedule.js        → discord-bot/aquilo/aq-schedule.js  (renamed — discord-bot already has schedule.js)
aquilo-bot/worker/games.js           → discord-bot/aquilo/aq-games.js     (renamed for the same reason)
aquilo-bot/worker/achievements.js    → discord-bot/aquilo/achievements.js
aquilo-bot/worker/bolts.js           → discord-bot/aquilo/bolts.js
aquilo-bot/worker/schema.sql         → discord-bot/aquilo/schema.sql
aquilo-bot/worker/migration-*.sql    → discord-bot/aquilo/migration-*.sql
```

Three filename collisions resolved via `aq-` prefix renames
(`queue.js`, `schedule.js`, `games.js`). All other modules keep
their names.
