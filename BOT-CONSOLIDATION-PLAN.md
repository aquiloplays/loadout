# Bot consolidation plan, three bots into Loadout

> Status: **planning doc only, nothing built.** Multi-phase.
>
> Author: Loadout team · Date: 2026-05-20 · Owner: Clay
>
> Verbatim ask (Clay): *"Can we just move the aquilo.gg bot stuff and
> StreamFusion bot into Loadout?"*

---

## 1. Goal

Today there are three Discord applications running side-by-side, each
with its own token, invite URL, deployment, monitoring story, and
on-call surface area:

| Bot | App ID | Where it runs | What it does |
| --- | --- | --- | --- |
| **Loadout bot** | 1500849448866025573 | Cloudflare Worker (`discord-bot/` in this repo) | The big one, Bolts wallet, dungeon, leaderboard, schedule, /loadout hub, panel bridge |
| **aquilo-bot** | 1500929968002044075 | Cloudflare Worker (`aquilo-bot/worker/`), also has a legacy Railway Node service in `aquilo-bot/src/` | /announce + /broadcast posting; community-night poll → schedule embed → queue post; song rotation; achievements; counting; check-in; suggestions; passport; birthdays; trivia; shop; clip-of-the-week; tickets; self-roles; setup-wizard hub |
| **StreamFusion bot** | 1494759611922645003 | Railway Node service (`StreamFusion/bot-service/`) | Holds a Discord Gateway WebSocket; forwards `VOICE_STATE_UPDATE` / member-join / message events to subscribed SF clients via SSE; `/post-release` webhook for release notes |

The win for consolidating: **one bot per server**, one token to rotate,
one deployment surface, one slash-command table that's discoverable
end-to-end. Streamers stop being told "you also need to invite *this*
bot to use that feature."

The risk: **the StreamFusion bot needs a persistent outbound WebSocket
to Discord's Gateway** (§3). Cloudflare Workers can't hold that. This
is the only piece of the merge that doesn't fall out trivially, and
the rest of the doc is built around accepting that constraint instead
of pretending it away.

---

## 2. What each bot does today (quick map)

### Loadout bot, `discord-bot/`
Already a Cloudflare Worker on the `LOADOUT_BOLTS` KV namespace. Routes
`/interactions` and a fleet of sync/webhook endpoints. Slash commands:
`/loadout-claim`, `/loadout`, `/stocks`, `/bet`, `/hub`, `/admin`,
`/schedule`, `/games`. Cron handler runs the daily payout + leaderboard
work. Identity model: per-guild wallet keyed by `wallet:<guildId>:<userId>`
with a `links: []` array for cross-platform identities.

### aquilo-bot, `aquilo-bot/`
**Currently has two live editions:** an older Railway Node app in `src/`
(Express + discord.js v14, gateway connection) and the newer Cloudflare
Worker in `worker/` (interactions-based, KV `STATE` + D1 `aquilo_bot_db`
+ Durable Object `OverlayBroadcaster` for the stream-overlay socket).
The Worker edition is the canonical one going forward, the README
calls the `src/` version "Deploy on Railway" but the Worker has full
parity and much more (achievements, birthdays, daily polls, counting,
passport, shop, trivia, tickets, self-roles, etc.).

Worker-edition slash commands (from `worker/worker.js`): `/announce`,
`/hub`, `/setup`, `/suggest`, `/encounter`, `/passport`, `/birthday`,
`/shop`, `/sr-add`, `/sr-list`, `/sr-remove`, `/sr-clear`,
`/rotation-poll`. Plus a 30-min cron for the rolling schedule/poll
loop, and the `OverlayBroadcaster` Durable Object for live game-of-the-
night WebSocket push to overlays.

POST surfaces: `/announce`, `/broadcast`, `/fourthwall`,
`/counting/award-bolts`. Auth via `AQUILO_BOT_SECRET` shared secret.

### StreamFusion bot, `StreamFusion/bot-service/`
Node Express + `ws`. Holds **one** Discord Gateway connection with
intents `GUILDS | GUILD_MEMBERS | GUILD_VOICE_STATES | GUILD_MESSAGES`,
fans out events to SSE clients keyed by Patreon user, verifies each
SSE client against Patreon `/identity`. Endpoints: `/events` (SSE),
`/associate` (bind a user → guild), `/post-release` (CI webhook),
`/health`, `/bot-invite`. State is in-memory; survives nothing across
restarts but self-heals because SF clients re-`/associate` on
reconnect.

---

## 3. The hard constraint, voice/member events need a Gateway

Discord exposes two delivery models for events:

1. **HTTP Interactions**, Discord POSTs to your webhook URL per slash
   command / button click / modal submit. Stateless. Cloudflare
   Workers handle this beautifully (`/interactions` route, Ed25519
   signature verification). This is what both Loadout and the
   aquilo-bot Worker use.
2. **Gateway WebSocket**, your bot opens an outbound WebSocket to
   `wss://gateway.discord.gg`, sends an `IDENTIFY` with intents,
   receives a real-time event stream including `READY`, `GUILD_CREATE`,
   `GUILD_MEMBER_ADD`, `MESSAGE_CREATE`, **`VOICE_STATE_UPDATE`**, etc.,
   and heartbeats every ~41 seconds. This is the *only* delivery
   channel for voice events. Discord does not have an HTTP webhook
   equivalent.

**Cloudflare Workers cannot hold this connection.** They're
request-scoped; a Worker invocation gets a fresh context, runs for
seconds, and exits. There's no daemon mode. So a pure Worker can never
host SF's voice-join detector.

### Options for the Gateway piece

In rough order of "least disruptive" → "most ambitious":

#### Option A, Keep a minimal standalone gateway daemon
**Recommended for v1.** Strip `StreamFusion/bot-service/` down to just
the Gateway listener: connect, receive events, forward them by HTTP
POST to a new Loadout Worker endpoint (`/gateway/event`, HMAC-signed).
Everything else, SSE fanout, Patreon verification, `/associate`,
`/post-release`, moves into the Loadout Worker. The daemon becomes a
~150-line pure relay with no business logic.

- ✅ One Discord app token (the merged Loadout bot's), all logic in
      the Worker, SSE/auth/routing get the Loadout deployment story.
- ✅ Daemon stays small enough to run on Railway free tier or Fly.io
      Hobby ($0-5/mo). Restart is trivial; no state.
- ✅ If the daemon ever goes down, the *only* feature affected is
      voice-join detection, everything else (interactions, /announce,
      polls, schedule) keeps working because that's all on the
      Worker.
- ⚠️ Two deployments still. Not "one bot" infrastructurally.

#### Option B, Cloudflare Durable Object holding the Gateway
A Durable Object *can* open and hold an outbound WebSocket. With the
hibernation API (`acceptWebSocket()` on inbound, `WebSocket.setAttachment()`
for outbound state), a DO can in theory keep a Gateway connection alive
across hibernation cycles, with an `alarm()` driving the 41-second
heartbeat.

- ✅ "One deployment" achieved literally, everything in the Worker
      surface.
- ⚠️ **Unproven.** Cloudflare's hibernation API is documented for
      *inbound* WebSockets (your DO accepting clients), not outbound
      ones to a third-party gateway. There are community examples of
      Discord Gateway bots on DOs, but they're mostly toys; nothing
      battle-tested at multi-guild scale.
- ⚠️ Gateway requires precise heartbeat timing or Discord drops you.
      DO alarms have minute-level reliability, not second-level.
      Drift = disconnect cycles = missed voice events.
- ⚠️ Requires the Workers Paid plan ($5/mo), same as
      `aquilo-bot/worker/wrangler.toml` already does for
      `OverlayBroadcaster`, so not a new cost.
- ⚠️ Discord's rate limits + identify limits get harder to manage
      from a hibernating context. One bad deploy and you hit the
      daily IDENTIFY cap, locking you out for 24h.

#### Option C, Drop voice-join entirely
If SF's voice-join feature is rarely used, the cheapest collapse is to
remove it from the product. Then there's no Gateway requirement and
everything goes into the Worker.

- ✅ Truly one bot, one deployment.
- ⚠️ Reduces SF's EA value prop. Worth a separate conversation with
      SF EA users, is voice-join actually used?

#### Option D, Manual "I'm in voice" signal from the SF client
StreamFusion already runs on the user's machine. SF could detect when
the user's Discord client is in a voice channel locally (via Discord
RPC / IPC API on the desktop), then push that fact up to the Worker, no gateway listener at all. This sidesteps option A entirely.

- ✅ Truly serverless; one bot.
- ⚠️ Requires SF to integrate with the Discord RPC protocol; that's
      its own non-trivial project.
- ⚠️ Only detects when the user *themselves* is in voice; can't tell
      you when a *different* guild member joined voice (which is what
      the EA feature does today).

**Recommendation: Option A for the v1 merge, with Option B as a future
experiment if/when SF's user base wants tighter ops.** Option A
preserves the feature, keeps the engineering scope tight, and lets the
Worker absorb 95% of the surface.

---

## 4. What merges cleanly, what doesn't

### Trivial merges (Worker → Worker, just paste)
- aquilo-bot's `/announce`, `/broadcast`, `/fourthwall` webhooks +
  slash command. They're already interaction/HTTP-based, already on
  Cloudflare. Bring `products.js` + `embed.js` over wholesale.
- The 30-min cron loop (community-night poll → schedule embed →
  queue). Loadout's worker already has a cron trigger (daily payout +
  leaderboard); merge schedules into one cron dispatcher.
- `/setup`, `/suggest`, `/encounter`, `/passport`, `/birthday`,
  `/shop`, `/sr-*`, `/rotation-poll`. All interaction-driven.
- Counting / check-in: the worker-side state is in KV + D1; the
  ingest is HTTP-only (`/counting/award-bolts`, `/counting/message`).
- Tickets, self-roles, achievements, welcome, streak, trivia, daily
  poll, leaderboard channel, returning, clip-of-the-week,
  spotlight, recap, idle-msgs, viewer-hub.

### Merges with light adaptation
- `OverlayBroadcaster` Durable Object (live game-of-the-night socket).
  DO classes can move into the Loadout Worker but the `wrangler.toml`
  binding stays, just renamed and bound to the new Worker. **Existing
  socket subscribers need to be told to connect to the new hostname.**
- The legacy `aquilo-bot/src/` Railway Node service is fully
  superseded by the Worker edition. Decommission after the migration
  cuts over.
- Auth secrets, `AQUILO_BOT_SECRET`, `RELEASE_POST_SECRET`,
  `LOADOUT_BOLT_API_SECRET`, `COUNTING_WEBHOOK_SECRET` all live as
  Wrangler secrets on the merged Worker. Some can be consolidated
  (they all serve the same "trusted webhook caller" role), but
  rotating them at the same moment is risky, keep them separate
  through the migration and unify later.

### Blocked by the Gateway constraint (see §3)
- StreamFusion's voice-join detection and member-join detection.
- StreamFusion's SSE push fanout (can move to the Worker, but it
  needs the Gateway feed from somewhere).
- StreamFusion's Patreon-token verification on `/events` (can move
  to the Worker easily).
- StreamFusion's `/post-release` webhook (can move to the Worker;
  no Gateway required, it just posts a message via REST).

So the only piece that's actually *stuck* on a Node daemon is the
Gateway listener itself. Everything around it lifts cleanly.

---

## 5. One Discord application, or three?

This is the question that most affects the migration mechanics.

**Discord identities are not portable.** An app ID + bot token belong
to a specific application registration in the Developer Portal. You
cannot rename app 1500849448866025573 to inherit app 1500929968002044075's
identity. If you collapse to one app, every server using either of the
*other* two bots has to re-invite the surviving bot, and the discarded
bots have to be removed.

### Collapse to ONE app (the Loadout bot, app ID 1500849448866025573)

- ✅ One bot icon, one invite URL, one set of perms.
- ✅ Simplest mental model for streamers and EA users.
- ⚠️ Every server currently using aquilo-bot or SF-bot has to invite
     the Loadout bot afresh and remove the old one. There's no silent
     migration here; it's a coordinated cutover.
- ⚠️ The Loadout bot needs the **union** of intents and permissions:
     `GUILDS | GUILD_MEMBERS | GUILD_VOICE_STATES | GUILD_MESSAGES` for
     the Gateway side (via the Option-A relay), and the existing
     `Send Messages | Embed Links | Read History | Add Reactions |
     Manage Roles | Manage Channels | Manage Messages` for the
     features that need them. Some of these are **privileged intents**
     (`GUILD_MEMBERS`, `MESSAGE_CONTENT` if SF reads message text), they have to be turned on in the dev portal AND requested via
     a verification process once the bot is in 75+ servers.
- ⚠️ The Loadout bot's current presence string + avatar are
     Loadout-branded. If aquilo-bot's `/announce` is going to post as
     "Loadout", that's a brand decision, could feel weird in servers
     that use the bot purely for announcements.

### Keep ALL THREE app IDs (but collapse the *deployments*)

- ✅ Zero re-invite work for existing servers.
- ✅ Each bot keeps its own brand presence, "Loadout" in Loadout
     servers, "aquilo.gg" in aquilo announcement servers, "StreamFusion"
     in SF EA servers.
- ⚠️ The Worker `/interactions` endpoint has to multiplex three
     `DISCORD_PUBLIC_KEY` values (one per app) and dispatch to the
     right handler per app. Doable, verify all three signatures, the
     one that matches identifies the app, but it's an extra layer of
     complexity.
- ⚠️ Three bot tokens still in rotation, three Developer Portal apps
     to maintain.

### Recommendation
**Collapse to one app (the Loadout bot).** The brand benefit of "you
only ever need one bot" outweighs the one-time invite churn. The
re-invite work is one Discord oauth link sent to a handful of server
admins; not a real engineering cost. And the Loadout bot ID is the
most "platform-y" of the three, which is the right shape for the
merged product.

Branding note: in servers that primarily use the announcement
features, post via webhook (Discord's built-in channel webhooks) with
a customised display name + avatar rather than the bot user itself.
That way "aquilo.gg" still appears as the author on announcements even
though the underlying bot is the Loadout bot.

---

## 6. Slash command namespace audit

Top-level commands published today:

| Loadout (`discord-bot/commands-spec.js`) | aquilo-bot Worker (`aquilo-bot/worker/worker.js`) | SF bot |
| --- | --- | --- |
| `/loadout` | `/announce` | *(none, no slash commands, just `/post-release` webhook + Gateway listener)* |
| `/loadout-claim` | `/hub` | |
| `/stocks` | `/setup` | |
| `/bet` | `/suggest` | |
| `/hub` | `/encounter` | |
| `/admin` | `/passport` | |
| `/schedule` | `/birthday` | |
| `/games` | `/shop` | |
| | `/sr-add`, `/sr-list`, `/sr-remove`, `/sr-clear` | |
| | `/rotation-poll` | |

**Hard collision: `/hub`.** Loadout's `/hub` is the viewer-facing menu;
aquilo-bot's `/hub` is the streamer admin hub. Both names are good for
their respective use; both have stickered in viewer muscle memory.

**Functional overlap: `/admin` (Loadout) + `/setup` (aquilo).** Both
are streamer-only configuration UIs. Keeping both is confusing.

**No other collisions** based on direct name match, but a Discord app
has a flat command namespace, so we need a careful audit (some
overlapping verbs likely lurk in subcommands).

### Recommended resolution
- Rename aquilo-bot's `/hub` → `/aquilo-hub` (or fold it into a new
  `/hub` subcommand layout where `/hub aquilo` and `/hub loadout` are
  subgroups). Subcommand grouping is the cleaner long-term answer.
- Merge `/admin` + `/setup` into one `/admin` with subcommands
  `bolts`, `schedule`, `engagement`, `tickets`, `shop`, `roles`, etc.
- Audit subcommand names during phase 1.

---

## 7. Data migration

### KV namespaces
| Namespace | Owner today | Action |
| --- | --- | --- |
| `LOADOUT_BOLTS` | Loadout Worker | Keep as-is. Bind to merged Worker. |
| `STATE` (aquilo-bot, id `4db0dbf...`) | aquilo-bot Worker | Bind to merged Worker under a different binding name (e.g. `AQUILO_STATE`). **Do not** merge keys into `LOADOUT_BOLTS`, prefix collisions are easy, and KV namespaces are free. |

KV bindings are cheap. Add both namespaces to the merged Worker's
`wrangler.toml`. Migration is "wire up a binding", not "copy keys."

### D1 databases
| DB | Owner today | Action |
| --- | --- | --- |
| `aquilo_bot_db` (id `292de930...`) | aquilo-bot Worker | Bind to merged Worker as `DB`. Loadout Worker doesn't currently use D1, so no rename needed. |

D1 is bound the same way, add to `wrangler.toml`, no data movement.

### Durable Objects
| DO class | Owner today | Action |
| --- | --- | --- |
| `OverlayBroadcaster` | aquilo-bot Worker | Move source file in, add `[[durable_objects.bindings]]` entry to merged Worker, add a fresh `[[migrations]]` entry. Existing in-flight WebSocket clients will reconnect to the new host once DNS flips. |

### In-memory state on SF bot
Already lossy (Map of `guildId → users`, `userId → SSE conns`).
Self-heals on reconnect. Migration plan: just don't drop both old SF
bot and new merged bot at the same time, let SF clients reconnect to
the new endpoint with their existing Patreon tokens; they'll
re-`/associate` automatically.

### Secrets
Merged Worker needs these Wrangler secrets (some shared, some new):

```
DISCORD_BOT_TOKEN          # the surviving (Loadout) app's token
DISCORD_PUBLIC_KEY         # same
AQUILO_BOT_SECRET          # announcement webhook auth
RELEASE_POST_SECRET        # SF release-notes webhook auth
LOADOUT_BOLT_API_SECRET    # bolts-award webhook auth
COUNTING_WEBHOOK_SECRET    # counting/check-in forwarder auth
PATREON_CAMPAIGN_ID        # SF Patreon verification
# (Patreon OAuth secrets already on Loadout)
```

---

## 8. Phased migration path

Don't bundle. Each phase ships independently with a working rollback.

### Phase 0, Decisions + spike (1 week)
- Pick one-app vs three-apps (§5). The recommendation is one-app
  (Loadout) but Clay's call.
- Pick Option A vs B vs C vs D for the Gateway constraint (§3). The
  recommendation is **A, minimal standalone gateway daemon** that
  POSTs to a Loadout Worker endpoint.
- Spike: prove out the daemon-to-Worker event forwarding with a real
  voice-join event hitting an SSE client end-to-end. Throw away the
  prototype after; the point is to validate the model before we
  commit.

### Phase 1, Move aquilo-bot Worker into Loadout (2 weeks)
- Copy `aquilo-bot/worker/` contents into `discord-bot/aquilo/` (new
  subdir). Keep file boundaries, don't rewrite as part of the move.
- Add `wrangler.toml` bindings for `STATE` (renamed `AQUILO_STATE`),
  `DB`, `OverlayBroadcaster`, the schedule/poll channels, achievement
  roles, all the other `[vars]` from the aquilo-bot wrangler.
- Wire the cron handler, merged Worker's `scheduled()` dispatches
  Loadout cron tasks AND aquilo-bot cron tasks. Time-check
  separately, no shared state needed.
- Wire the interactions handler, `worker.js`'s slash command
  dispatcher gets the aquilo-bot command cases appended. Resolve the
  `/hub` collision (rename aquilo's to `/aquilo-hub` for v1, clean
  later).
- Wire the webhook endpoints, `/announce`, `/broadcast`,
  `/fourthwall`, `/counting/*`. Auth shim accepts the existing
  secrets unchanged so external callers (Fourthwall, presence
  forwarder, CMS) don't break.
- Re-register slash commands under the **Loadout app's** ID.
- **Cutover gate**: deploy merged Worker behind a feature flag,
  redirect `aquilo-bot.aquiloplays.workers.dev` → new hostname.
  Old aquilo-bot Worker stays deployed for one week as the rollback
  target.
- **End-of-phase**: aquilo-bot app retired. One fewer bot in every
  affected server (admins are messaged the new invite link).
- **Rollback**: revert DNS, redeploy old aquilo-bot Worker. KV/D1
  data is untouched because we never wrote to it from the new
  Worker until cutover.

### Phase 2, Move StreamFusion into Loadout (2 weeks)
- Build the minimal gateway daemon (Option A), fork
  `StreamFusion/bot-service/index.js` down to: connect to Gateway,
  receive events, POST to merged Worker's `/gateway/event` endpoint
  with HMAC. Strip everything else.
- Build the Worker-side of SF: `/events` SSE handler, `/associate`,
  `/post-release`, Patreon verification cache. SSE client state lives
  in a Durable Object (`SfFanout`) so multiple SF clients per user
  get the same events.
- Move release-notes posting (`/post-release`), pure REST call to
  Discord, no Gateway needed; this lifts straight into the Worker
  with no daemon dependency.
- **Cutover gate**: deploy daemon + Worker SSE alongside the existing
  SF bot service. Switch SF desktop client config to point at the new
  endpoint. Old service stays up for a week.
- **End-of-phase**: SF bot app retired. Only the minimal gateway
  daemon remains as a separate process; everything else is in the
  merged Worker.
- **Rollback**: flip SF desktop client back to the old endpoint.
  Daemon + new Worker code can stay deployed (no harm) while the
  bug is fixed.

### Phase 3, Cleanup + brand cohesion (1 week)
- Resolve `/hub` properly, refactor to `/hub` with subgroups
  `loadout` / `aquilo` so the namespace reflects the merged product.
- Resolve `/admin` + `/setup` overlap.
- Move announcement webhook customisation so posts can render as
  "aquilo.gg" via channel-webhook impersonation (§5).
- Decommission `aquilo-bot/src/` (legacy Node/Railway service). It's
  been superseded by the Worker edition already; consolidation is a
  good moment to finally delete it.
- Delete dead env-vars; rotate the now-shared webhook secrets if
  desired.

### Phase 4, Optional: try Option B
If the standalone gateway daemon is annoying enough to operate (Railway
bills, restart on deploy, etc.), prototype the Durable Object Gateway
approach in a sidecar. Run it in parallel with the daemon for a month
to validate disconnect/identify behavior, then cut over.

---

## 9. Anti-regression / rollback hygiene

- **Feature flag the cutover.** Add a `MERGED_BOT_ROUTING` env var
  on the merged Worker; until set to `1`, the new handlers are
  registered but old aquilo-bot Worker remains the live target.
- **Run both bots in parallel during cutover.** Discord lets two
  bots co-exist in the same server. For 24 hours after cutover, the
  merged Loadout bot handles all commands AND the old aquilo-bot
  stays online but with its slash commands de-registered. That gives
  a fast "deregister + re-register" rollback if the merged bot
  misbehaves.
- **Keep KV namespaces separate.** Tempting to consolidate into one
  KV per Worker. Don't, namespace boundaries are a free isolation
  layer. If a feature regresses, you can roll back that namespace's
  Worker module without touching the others.
- **Health checks.** Merged Worker `/health` should return the
  status of: interactions endpoint, all webhook secrets configured,
  KV/D1/DO bindings live, gateway daemon last-seen timestamp (via a
  KV key the daemon writes every 60s).

---

## 10. Open questions for Clay

1. **Which gateway option (§3) are you committing to?** Recommendation
   is **Option A, minimal standalone daemon, everything else in the
   Worker**. Confirm or pick a different path before we spike.
2. **One Discord app or three?** Recommendation is **one, the
   Loadout app survives, the other two retire**. Are you OK with the
   re-invite churn (every server using aquilo-bot or SF-bot has to
   invite the Loadout bot)?
3. **Does StreamFusion actually use voice-join detection in real EA
   workflows?** If almost nobody uses it, Option C (drop it) is a
   real choice and saves us the daemon entirely.
4. **Brand presence on `/announce`.** Should announcements still
   appear authored by "aquilo.gg" (via channel-webhook impersonation)
   or are you OK with the Loadout bot being the visible author in
   announcement channels too?
5. **`aquilo-bot/src/` (the Railway Node service).** Confirmed dead?
   If it's actually still serving production traffic, we need to
   migrate / decommission that explicitly, not assume the Worker
   edition has parity.
6. **`OverlayBroadcaster` clients.** Who today connects to the
   aquilo-bot DO over WebSocket? Are these only on streamer-owned
   OBS browser sources we control, or does anyone external connect?
   Affects the cutover messaging.
7. **Privileged intents.** The Loadout app currently doesn't request
   `GUILD_MEMBERS` or `MESSAGE_CONTENT`. The merged bot will, via the
   Gateway daemon. Discord requires verification for these once
   you're in 75+ servers. **Are we at that threshold yet, or
   approaching it?** Affects how soon we need to start the
   verification dance.
8. **Token rotation.** Should we rotate the Loadout bot's token at
   the moment of merge (clean break) or keep it through the
   migration (less risk of accidental downtime)? Recommendation:
   keep through, rotate at the end of phase 3.
9. **Patreon campaign ID.** SF and Loadout both verify against
   `PATREON_CAMPAIGN_ID`, is it the **same** campaign for both, or
   does each product map to its own Patreon tier within one
   campaign? Affects how `/events` (SF) and `/loadout` Patreon
   checks share code.
10. **Timeline.** The phased plan totals ~6 weeks of engineering at
    a relaxed pace. Is there a deadline (new EA cohort, branding
    launch tied to the aquilo.gg refresh, etc.) we should sequence
    around?
