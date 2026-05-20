# Aquilo Bus — Event Reference

The Aquilo Bus is the localhost pub/sub WebSocket at `ws://127.0.0.1:7470/aquilo/bus/`
hosted by the Loadout DLL. Every other Aquilo product (StreamFusion, Loadout
overlays, the Rotation widget, the Twitch panel via the panel-bridge) either
publishes events to it, subscribes to events from it, or both.

This file is the canonical surface. Add to it when you publish a new kind or
register a new handler. Source of truth is the code under
`src/Loadout.Core/Modules/` (server-side publishers) and the consumers under
`~/Desktop/Loadout/aquilo-gg/overlays/` + `~/Desktop/aquilo-widget/` +
`~/Desktop/StreamFusion/integrations/streamfusion/aquilo-bus.js`.

## Protocol crib

- Wire format: one JSON object per WebSocket frame.
- Outgoing event: `{ v: 1, kind: "<name>", data: <object> }`.
- Subscribe: `{ v: 1, kind: "subscribe", kinds: ["counter.*"] }` — glob suffix is
  the only wildcard supported.
- Auth: shared secret at `%APPDATA%\Aquilo\bus-secret.txt`; clients pass it as
  `?secret=<value>` on the connect URL.
- In-process observers: `AquiloBus.LocalPublished` event fires for every
  `Publish` call (used by `PanelBridgeModule` to mirror state to the Worker).
- In-process handlers: `RegisterHandler(kind, handler)` runs **only** for
  messages a connected client publishes — in-process `Publish` calls do **not**
  invoke handlers. This asymmetry is intentional: the handlers are for
  client-originated requests like `bolts.spend.request`.

## Event index by domain

### Loadout bolts wallet

| Kind | Producer (module) | Payload | Consumers |
|---|---|---|---|
| `bolts.earned` | `BoltsModule`, many | `{ user, platform, amount, source, balance }` | overlay `/bolts` (earn toast), `BoltsModule` re-handler (in-process) |
| `bolts.gifted` | `BoltsModule` | `{ fromUser, toUser, amount }` | overlay `/bolts` (gift burst) |
| `bolts.refunded` | `BoltsModule` | `{ user, amount, reason }` | overlay `/bolts` |
| `bolts.streak` | `BoltsModule` | `{ user, streak, payout }` | overlay `/bolts` (streak banner) |
| `bolts.leaderboard` | `BoltsModule` | `{ entries: [{ user, balance }, ...] }` | overlay `/bolts` (ticker), `bolts-leaderboard.html` |
| `bolts.rain` | `BoltsModule` | `{ user, amount, recipients }` | overlay `/bolts` (rain) |
| `bolts.shop.purchased` | `BoltsModule` (shop) | `{ user, item, cost }` | overlay `/bolts` |

**Request kinds (client-published, in-process handled):**

| Kind | Handler | Request → Response |
|---|---|---|
| `bolts.balance.query` | `BoltsModule` | `{ user }` → `bolts.balance.result {balance}` |
| `bolts.spend.request` | `BoltsModule` | `{ user, amount, reason }` → `bolts.spend.result {ok, balance, reason?}` |
| `bolts.refund` | `BoltsModule` | client request for a refund |

### Mini-games (in-engine)

All published by `BoltsModule`, consumed by the Bolts overlay + the Twitch
panel via `PanelBridgeModule` (which mirrors them up to the Worker).

| Kind | Payload |
|---|---|
| `bolts.minigame.coinflip` | `{ user, wager, result, won, payout, balance, source, ts }` |
| `bolts.minigame.dice` | `{ user, wager, target, rolled, won, payout, balance, source, ts }` |
| `bolts.minigame.slots` | `{ user, wager, reels, won, payout, balance, pool, ts }` |
| `bolts.minigame.rps` | `{ user, wager, viewer, bot, outcome, payout, balance, source, ts }` |
| `bolts.minigame.roulette` | `{ user, wager, pick, pocket, resultColor, won, payout, balance, source, ts }` |

### Bolts heist (multi-player chat event)

| Kind | Producer | Payload |
|---|---|---|
| `bolts.heist.start` | `HeistController` (BoltsModule) | `{ host, joinSec, pot }` |
| `bolts.heist.contribute` | `HeistController` | `{ user, stake, pot }` |
| `bolts.heist.success` | `HeistController` | `{ payouts, pot }` |
| `bolts.heist.failure` | `HeistController` | `{ reason }` |

### Dungeon

Produced by `DungeonModule`. The OBS dungeon overlay reads scenes timed by
`scene.delayMs` from the run start.

| Kind | Payload | When |
|---|---|---|
| `dungeon.recruiting` | `{ dungeonName, openSec, hostUser, joinCommand, party[] }` | new run opens |
| `dungeon.joined` | `{ user, platform, partySize, hero }` | each `!join` |
| `dungeon.started` | `{ dungeonName, partySize }` | join window closes |
| `dungeon.scene` | `{ delayMs, kind, text, glyph, targetUser, partyHp[], options[] }` | every scene in the run; `options[]` non-empty on the branching scene |
| `dungeon.cooldown` | `{ untilUtc, durationSec }` | `StartDungeon` (Phase BR polish) — panel-bridge surfaces the channel cooldown |
| `dungeon.vote` | `{ tally: { optionId: count } }` | every `!dungeon vote` (Phase BR live tally) |
| `dungeon.choice` | `{ optionId, votes, tally, viaTimeout, resolveText, glyph }` | end of vote window — branch resolved |
| `dungeon.completed` | `{ dungeonName, biome, hadBoss, partySize, outcomes[] }` | run finished |
| `achievement.unlocked` | `{ user, platform, id, name, description, glyph, bolts }` | a hero unlocks one |

### Duel

Same module (`DungeonModule`), shorter event chain.

| Kind | Payload |
|---|---|
| `duel.recruiting` | `{ challenger, target, openSec }` |
| `duel.started` | `{ challenger, defender, ... }` |
| `duel.scene` | `{ delayMs, kind, text, glyph, attackerHpAfter, defenderHpAfter }` |
| `duel.completed` | `{ winner, loser, reason?, xp, gold }` |

### Apex (top-viewer mode)

Produced by `ApexModule`, consumed by overlay `/apex`.

| Kind | Payload |
|---|---|
| `apex.state` | full state snapshot |
| `apex.crowned` | `{ user, prior }` |
| `apex.damaged` | `{ user, hpDelta, source }` |
| `apex.dethroned` | `{ user, dethronedBy }` |

### Check-ins + cheers (Tier 2 engagement)

| Kind | Producer | Payload | Consumers |
|---|---|---|---|
| `checkin.shown` | `CheckInModule` (DLL) **OR** Worker → SB `aquilo-relay` action | viewer payload | overlay `/check-in` |
| `checkin.enriched` | `CheckInModule` | adds avatar / sub flair / patreon flair on top | overlay `/check-in` |
| `cheer.shown` | Worker (`/ext/cheer` → relay queue → SB `aquilo-relay` → bus) | `{ emote, displayName }` | engagement overlay `cheer-emote` |

### Goals + counters

| Kind | Producer | Payload |
|---|---|---|
| `goal.updated` | `GoalsModule` | `{ kind, current, target, ... }` |
| `goal.advanced` | `GoalsModule` | when a goal ticks over a threshold |
| `counter.updated` | `CountersModule` | `{ name, value }` |
| `counter.reset.all` | `CountersModule` | `{}` |

### Channel-platform events (alerts, follows, subs, etc.)

These mirror native Streamer.bot events with cross-platform shape so the
overlays don't care which platform fired them.

| Kind | Producer | Notes |
|---|---|---|
| `welcome.fired` | `WelcomesModule` | per-tier welcome |
| `welcomes.shown` | (request handler) | overlay → module to mark shown |
| `alerts.fired` | `AlertsModule` | follow / sub / cheer / raid / etc. |
| `follows.batched` | `FollowBatchModule` | one batched payload per coalesce window |
| `firstwords.celebrated` | `FirstWordsModule` | viewer's first chat |
| `hypetrain.start` / `hypetrain.contribute` / `hypetrain.level` / `hypetrain.end` | `HypeTrainModule` | + TikTok hype synth |
| `sub.train.contributed` / `sub.train.tier` / `sub.train.ended` | `SubRaidTrainModule` | burst detection |
| `sub.anniversary` | `SubAnniversaryModule` | 3/6/12/18/24/36/48+ months |
| `ads.upcoming` | `AdBreakModule` | Twitch ad heads-up |
| `autopoll.requested` | `AutoPollModule` | category change → chat poll prompt |
| `chat.velocity` | `ChatVelocityModule` | running messages-per-minute |
| `channelpoints.redeemed` | `ChannelPointsModule` | normalized redemption |
| `tips.received` | `TipBridge` (Discord) | Streamlabs / SE / Ko-fi / generic webhook |
| `shoutout.requested` | `AlertsModule` | AI-personalized SO scheduled |
| `clip.created` / `clip.requested` | `ClipsModule` | |
| `webhook.received` | `WebhookInboxModule` | inbound HTTP listener fired |
| `gameprofile.activated` | `GameProfilesModule` | active profile switched |
| `game.session.started` / `.changed` / `.ended` | `GameTrackerModule` | per-game tracking |
| `vip.rotation.completed` | `VipRotationModule` | weekly engagement rotation |
| `viewer.profile.updated` / `viewer.profile.shown` | `ProfileModule` | !setbio, !setpfp, etc. |
| `quest.completed` | `DailyQuestsModule` | bus-driven quest tracker |
| `recap.posted` | `StreamRecapModule` | end-of-stream Discord embed |
| `discord.sync.completed` | `DiscordSync` | Bolts wallet sync settled |
| `cc.coins.spent` / `cc.coins.leaderboard` | `CcCoinTrackerModule` | Crowd Control |
| `commands.list` / `commands.icons` | `CommandsBroadcaster` | published commands catalog |

### Rotation (Songs)

Produced by the Rotation widget; the Loadout DLL bridges via
`RegisterHandler` so its `NowPlayingModule` can power `!song` chat command.

| Kind | Direction | Payload |
|---|---|---|
| `rotation.song.request` | Loadout DLL → bus (`!songrequest` → handler) | `{ user, query, paid }` |
| `rotation.song.queued` | Rotation widget → bus | `{ id, track }` |
| `rotation.song.accepted` | Rotation widget → bus | `{ id, ok: true }` |
| `rotation.song.rejected` | Rotation widget → bus | `{ id, reason }` |
| `rotation.song.playing` | Rotation widget → bus | `{ name, artist, album, durationMs, coverUrl, ... }` |
| `rotation.queue.snapshot` | Rotation widget → bus | `{ queue: [...] }` |

### ChatAnnouncementsModule observers (`AquiloBus.LocalPublished`)

Bus-driven chat announcements for game events that previously had no
chat reply. Sends via `MultiPlatformSender` (target = `PlatformMask.All`,
filtered to enabled platforms in `PlatformsConfig`, rate-limited).

| Kind subscribed | Chat line (defaults) | Toggle |
|---|---|---|
| `dungeon.recruiting` | `⚔️ A party is forming for <name>! Type !dungeon join to enter (Xs).` | `ChatAnnouncements.DungeonRecruiting` (on) |
| `dungeon.completed` | `🏆/🏁/💀 <name>: survived / N of M out / WIPED` | `ChatAnnouncements.DungeonCompleted` (on) |
| `duel.completed` | `🗡️ <winner> defeated <loser> in a duel! (+N bolts)` | `ChatAnnouncements.DuelCompleted` (on) |
| `bolts.minigame.*` | `🎰 <user> just won N bolts on <game>!` (only on win + payout ≥ threshold) | `ChatAnnouncements.MinigameBigWins` (off by default; threshold 250) |

Master kill-switch: `ChatAnnouncements.Enabled`. Heist start/success/
failure are NOT subscribed here -- `HeistController` already announces
its own lifecycle in chat.

### PanelBridgeModule observers (`AquiloBus.LocalPublished`)

These don't ride the bus directly — `PanelBridgeModule` taps the in-process
`LocalPublished` event and POSTs to the Loadout Worker's `/relay/dll-ingest`
endpoint with one of these `type` discriminators:

| `type` | Mirrors |
|---|---|
| `dungeon` | rolling snapshot of `dungeon.*` events |
| `duel` | rolling snapshot of `duel.*` events |
| `minigame` | rolling snapshot of `bolts.minigame.*` events |
| `cooldown` | one-shot `dungeon.cooldown` snapshot |

The Worker exposes corresponding `GET /ext/{dungeon,minigame,duel}/state` +
`GET /ext/dungeon/cooldown` routes the Twitch panel polls. See
`discord-bot/ext-panelbridge.js`.

## Adding a new event

1. Pick a `domain.action` name. Subscribe globs are suffix-only (`counter.*`
   matches every counter); choose the prefix accordingly.
2. Publish in the DLL via `AquiloBus.Instance.Publish(kind, data)`.
3. If a remote client should request it, expose a `RegisterHandler` server-side.
4. Add a row to this file under the right domain section. The grep
   `grep -rhoE 'Publish\("[^"]+"' src/Loadout.Core` should match your new kind.
