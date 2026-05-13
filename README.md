# Loadout

> Cross-platform stream toolkit. One Streamer.bot import. One DLL. A real product.

Loadout drops a fully-loaded suite onto your Streamer.bot — info commands, multi-platform alerts, smart welcomes, an Apex top-viewer mode, a unified Bolts wallet, an off-stream Discord bot, eleven OBS overlays, a dungeon mini-RPG, daily quests, achievements, hype trains, weekly recap embeds, real-money tip integration, and more. **One import. One DLL. Configured entirely from a real settings UI.** Nothing to wire up by hand.

Built to run on the [Aquilo Bus](#aquilo-bus) — a local WebSocket nervous system — so every overlay, the Discord bot, and any future aquilo.gg product share the same event stream.

[![Latest release](https://img.shields.io/github/v/release/aquiloplays/loadout-downloads)](https://download.aquilo.gg/loadout)
[![Streamer.bot](https://img.shields.io/badge/streamer.bot-1.0.0%2B-9147ff)](https://streamer.bot)
[![.NET](https://img.shields.io/badge/.NET-4.8-512BD4)](https://dotnet.microsoft.com)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020)](https://workers.cloudflare.com)
[![Patreon](https://img.shields.io/badge/Patreon-support-FF424D)](https://patreon.com/aquiloplays)

---

## Table of contents

- [Quick install](#quick-install)
- [What's in the kit](#whats-in-the-kit)
- [Bolts economy](#bolts-economy)
- [Off-stream Discord bot](#off-stream-discord-bot)
- [Overlays](#overlays)
- [Daily quests + achievements](#daily-quests--achievements)
- [Tip integration](#tip-integration)
- [Weekly digest](#weekly-digest)
- [Aquilo Bus](#aquilo-bus)
- [Tiers](#tiers)
- [Architecture](#architecture)
- [Build from source](#build-from-source)
- [Contributing](#contributing)
- [License](#license)

---

## Quick install

1. **Download `Loadout.dll` and `loadout-import.sb.txt`** from the [latest release](https://download.aquilo.gg/loadout).
2. Drop `Loadout.dll` into `<Streamerbot>/data/Loadout/` (Loadout will also auto-download it on first boot if you skip this).
3. **In Streamer.bot, click Import (top-right) and paste the contents of `loadout-import.sb.txt`.**
4. Restart Streamer.bot — or right-click the `Loadout: Boot` action and Run Now.
5. The onboarding wizard pops up. Pick what you want enabled. Done.

That's it. No References-tab editing. No per-event action wiring. No manual trigger setup.

Detailed walkthrough: [INSTALL.md](INSTALL.md)

---

## What's in the kit

30+ modules, all off by default until you enable them in the onboarding wizard or Settings → Modules:

### Core
- **Info commands** — `!uptime`, `!followage`, `!accountage`, `!title`, `!game`, `!so`, `!lurk`/`!unlurk`, `!socials`, `!discord`, `!gamertags`, `!quote`, custom commands
- **Context-aware welcomes** — different greetings for first-time / returning / sub / VIP / mod / Patreon / TikTok fan-club / YouTube member / Kick sub
- **Alerts** — follow / sub / cheer / raid / super chat / membership / TikTok gift, themed and rate-limited
- **Auto-timed messages** — smart cadence with chat-activity gating, broadcaster-pause, randomized order
- **Goals** — follower/sub/bit/coin trackers with live overlay updates
- **Counters** — `!deaths`, `!wins`, custom counters with chat increment/decrement and live overlay

### Engagement loops
- **Bolts ⚡** — unified cross-platform wallet. Earn from chat / subs / cheers / raids / TikTok gifts / channel points. Multipliers from sub status, daily streak, Patreon tier. Spend via `!gift`, `!boltrain`, `!shop`. → [more below](#bolts-economy)
- **Daily Check-In** — overlay with avatar, sub flair, Patreon flair, rotating stream stats. Twitch channel-point reward OR `!checkin` command on any platform.
- **Daily Quests** — three viewer-side quests per UTC day. Show up / earn bolts / play minigames / win a heist / tip the streamer. → [more below](#daily-quests--achievements)
- **Achievements** — cross-product milestones (bolts, hype train, heists, tips). Unlock fires on the bus + bolt reward. → [more below](#daily-quests--achievements)
- **Hype train** — synthetic for TikFinity gifts (TikTok has none natively); aggregates fuel from Twitch + TikTok + YouTube + Kick simultaneously
- **Sub anniversary milestones** — auto-celebrates 3/6/12/18/24+ month subs when they chat

### Minigames
- **`!coinflip`** — 3D cylinder coin, 50/50
- **`!dice`** — true 6-sided cube with pips, 1/6 chance, 5× payout on hit
- **`!slots`** — 3-reel with spring-loaded lever animation, 3-of-a-kind jackpot
- **`!rps`** — rock/paper/scissors against the bot
- **`!roulette`** — red/black/green wheel with counter-rotating ball
- **`!heist`** — community heist event. Initiator stakes, 60-second join window, crew splits the pot if it crosses target. → [more below](#shop--minigames)

### Dungeon mini-RPG
- **`!dungeon`** — multi-viewer adventure with a 12-biome dungeon catalog, 35+ monsters, 5 boss tiers, 220+ loot items across 6 rarities, set bonuses, class affinity, ability-bearing gear (lifesteal / phoenix / boss-slayer / etc.)
- **`!duel`** — viewer vs viewer with stakes
- **`!hero`** / **`!equip`** / **`!sell`** / **`!shop`** — loadout management on stream and via Discord
- **Persistent levels (1–50)**, dungeon visited tracker, achievements, gear collection

### Smart features
- **Hate-raid detector** — pattern-based detection, broadcaster DM, no chat noise
- **Sub raid trains** — burst detection (3+/6+/10+/20+ subs in 60s), bus-driven overlay
- **Smart cooldowns** — chat-velocity tracker writes `loadout.chatVelocity` and `loadout.chatTier` globals
- **First-words celebration** — Twitch + YouTube native first-words events
- **Ad-break heads-up** — chat warning + countdown overlay
- **Auto-poll on category change** — chat reaction prompt
- **VIP rotation auto-magic** — weekly engagement-based promotion/demotion (Tier 3)

### Integrations
- **Discord live-status auto-poster** — go-live embed, edit on title/category change, archive on offline
- **Stream recap** — post-stream summary to Discord (top chatter, follows, subs, raids received, hype moments)
- **Weekly digest** — Monday morning Discord embed with last week's bolts/hype trains/heists/tips/top earners. → [more below](#weekly-digest)
- **Tip integration** — Streamlabs / StreamElements / Ko-fi webhook → bolts award + bus event + overlay celebration. → [more below](#tip-integration)
- **TikFinity bridge** — TikTok gifts unify with the Bolts wallet, hype train, Apex damage
- **Patreon entitlement** — shared Cloudflare Worker proxy with StreamFusion, single sign-in
- **Webhook inbox** — HTTP listener for Ko-fi / Throne / Patreon / custom; publishes to Aquilo Bus + can fire SB actions
- **Spotify rotation widget** — `!song` chat command, `!boltsong` priority requests
- **Cross-platform identity links** — `/loadout link` on Discord OR `!link` in chat unifies bolt earnings across Twitch / Kick / YouTube / TikTok

---

## Bolts economy

Single cross-platform points wallet. Default earn rates (May 2026 grindy rebalance, all configurable):

| Action | Bolts |
|---|---|
| Chat message | 1 (cap 3/min anti-AFK) |
| Sub / resub | 25 |
| Gifted sub | 15 each |
| Raid | 50 |
| Cheer | 1 per 200 bits |
| TikTok gift | 1 per 10 coins |
| Channel-point redeem | 1 per 25 |
| Daily check-in | 50 (×streak day, capped 10×) |
| Sub anniversary | 50 × month milestone |
| Tip | 100 per dollar (configurable) |

**Multipliers** (additive): sub +0.5 · Patreon Tier 1 +0.2 · Tier 2 +0.5 · Tier 3 +1.0 · daily streak +0.1/day capped at +1.0.

**Commands**: `!bolts [@user]` · `!leaderboard` · `!gift @user N` · `!boltrain N [count]` (mod) · `!shop` · `!buy <name>`.

**Overlay** at `widget.aquilo.gg/overlays/bolts` consolidates leaderboard ticker, earn toasts, bolt rain, streak banner, and gift bursts into one OBS browser source.

### Shop + minigames

**Streamer-configurable shop** with action verbs: `chat:` / `alert:` / `sb-action:<guid>` / `counter:<name>:±N`. Per-item stock caps + per-user caps. Default shop is empty — streamers seed their own personality (shoutouts / dares / nicknames / sound effects / VIP trials / counter pokes).

**Heist event** — `!heist <stake>` opens a 60-second window. Other viewers `!join <stake>` to chip in. If the pot crosses target, crew splits `target × 1.6×` proportional to their stake. If it falls short, every contribution is lost. Cooldowns gate spam (10-min per-initiator, 3-min global).

**Dungeon shop** (Discord-side, daily rotation): full catalog mirror of the dungeon loot table. Worker picks a deterministic 12-item subset each UTC day. Prices range from common (~40 bolts) to epic (~2400 bolts) with ability-bearing items at ~25% premium.

---

## Off-stream Discord bot

A Cloudflare Worker hosted at `https://loadout-discord.aquiloplays.workers.dev` (per-streamer's own deployment). Single `/loadout` command opens a menu with:

- **Wallet** — balance / lifetime / streak / linked accounts (rich Discord embed)
- **Daily** — claim daily bolts with streak progress bar
- **Leaderboard** — top 10 with medals
- **Gift** — pick a viewer + amount
- **Coinflip / Dice** — same minigames as on-stream, same wallet
- **Shop** — daily rotation, buy with bolts
- **Hero** — RPG character card (class / level / HP / XP bar / equipped gear)
- **Bag / Equip / Sell** — loadout management
- **Training** — spend bolts to grind HP / XP
- **Profile** — set bio / pfp / pronouns / socials / gamertags
- **Link** — connect a Twitch / Kick / YouTube / TikTok handle to your Discord account

KV-backed wallet with link-aware sync — bolts earned on stream propagate to the Discord wallet within 30 seconds, and Discord-side activity flows back to the DLL the same way.

---

## Overlays

Twelve OBS browser-source overlays, all served from `widget.aquilo.gg/overlays/<name>/`. Subscribe to the local Aquilo Bus over WebSocket. Shared design tokens at [`overlays/_shared/loadout-design.css`](aquilo-gg/overlays/_shared/loadout-design.css).

| Overlay | Bus kinds | OBS source size |
|---|---|---|
| `bolts` | `bolts.*` (leaderboard / earned / rain / streak / giftburst) | 1920×1080 |
| `counters` | `counter.updated` | 600×140 |
| `goals` | `goal.*` | 480×120 |
| `check-in` | `checkin.*` | 1920×1080 |
| `apex` | `apex.*` | 580×140 |
| `commands` | `commands.list` | 380×100 |
| `recap` | `recap.posted` | 1920×1080 |
| `viewer` | `viewer.profile.shown` | 380×280 |
| `hypetrain` | `hypetrain.*` | 400×120 |
| `minigames` | `bolts.minigame.*` + `bolts.heist.*` | 400×260 |
| `lobby` | `lobby.*` + `welcome.*` | 1920×1080 |
| `compact` | composite of all above + `tips.received` | 440×128 |
| `all` | iframe composite of every enabled overlay | 1920×1080 |

Premium glass design language — layered surfaces, top-edge accent stripes, multi-shadow depth, brand-tinted glows on win/lose/hype states. Inter / Segoe UI Variable font stack with tabular figures for numerics. Every overlay accepts `?accent=`, `?bg-opacity=`, `?font=`, `?fontScale=`, `?accent2=`, `?text=` URL params for live re-skinning without redeploys.

---

## Daily quests + achievements

**Daily quests** — three viewer-side quests refreshed each UTC day, deterministically seeded by viewer + date so a viewer always sees the same set across menu re-opens.

| Tier | Sample | Reward |
|---|---|---|
| Easy | "Send 5 chat messages" / "Earn 50 bolts" / "Play any minigame" | +25–50 ⚡ |
| Medium | "Win a `!coinflip`" / "Complete a `!dungeon`" / "Join a heist" | +50–100 ⚡ |
| Hard | "Slay a dungeon boss" / "Tip the streamer" / "Hit a sub anniversary" | +200–500 ⚡ |

**Achievements** — cross-product milestones that span every Loadout surface:

| Ladder | Stages |
|---|---|
| Bolts | First Spark (100) → Kilowatt (1k) → Power Grid (10k) → Supernova (100k) |
| Streak | Regular (3d) → Ironclad Habit (7d) → Always On (30d) |
| Hype train | Stoker (5 contribs) → Engineer (25) → Max Throttle (level-5 train) |
| Minigames | Gamer (10 plays) → High Roller (100) |
| Heist | First Heist → Made (10 successful) |
| Tipping | Patron (1 tip) → MVP Patron (10 tips) |

Each unlock fires `achievement.unlocked` on the bus → overlay celebration + bolt reward + optional Discord channel post.

The dungeon RPG keeps its own achievement list (first-blood, veteran, dungeoneer, legendkiller, lootmaster, myth-touched, set-collector, ascended) tracked on the hero state.

---

## Tip integration

Real-money tips flow into Loadout's economy. The streamer wires their tip provider's webhook (Streamlabs / StreamElements / Ko-fi / a generic webhook from any source) to the Worker:

```
POST /tips/<guildId>/<secret>
{
  "tipper": "rosie",
  "tipperPlatform": "twitch",
  "tipperHandle": "rosie_91",
  "amount": 5.00,
  "currency": "USD",
  "message": "love the stream",
  "source": "streamlabs",
  "tipId": "sl-12345"
}
```

The DLL polls `/sync/<guild>/tips?since=` every 30 seconds, awards bolts to the linked stream identity (default 100 bolts per dollar), and publishes `tips.received` on the local bus so:

- The compact overlay shows a pink-tinted celebration card
- The Patron / MVP Patron achievements track
- The Daily Quests `tip-stream` quest counts
- The weekly digest captures the biggest tip + total

Tip ID dedup prevents double-credits from webhook re-fires.

---

## Weekly digest

Once a week (default Monday 14:00 UTC) the DLL posts a Discord embed to a configured channel:

- Top 5 bolts earners (medal-ranked monospace table)
- Total bolts earned that week
- Hype trains run + peak level
- Heists succeeded + biggest pot/crew
- Total minigames played
- Tips received + biggest tipper
- Welcomes shown

Stats accumulate live via bus subscriptions (`bolts.earned`, `hypetrain.end`, `bolts.heist.success`, `welcomes.shown`, `tips.received`, etc.); a 1-minute scheduler tick checks for the configured day/hour and fires the post + resets the counter.

---

## Aquilo Bus

Localhost WebSocket pub/sub at `ws://127.0.0.1:7470/aquilo/bus/`. Per-machine shared secret at `%APPDATA%\Aquilo\bus-secret.txt`. Loadout hosts the server; every overlay, the Discord bot's polling loops, and any future aquilo.gg product subscribe. Versioned protocol, kind-glob filters, bidirectional reply support.

Published kinds:

```
bolts.earned / .gifted / .leaderboard / .rain / .streak
bolts.minigame.coinflip / .dice / .slots / .rps / .roulette
bolts.heist.start / .contribute / .success / .failure
hypetrain.start / .contribute / .level / .end
welcome.fired
counter.updated
goal.advanced
apex.crowned / .dethroned / .damaged / .state
checkin.shown
commands.list / .icons
recap.posted
viewer.profile.shown
quest.completed
achievement.unlocked
tips.received
lobby.config
discord.sync.completed
```

OBS overlays at `widget.aquilo.gg/overlays/<name>/?bus=ws://127.0.0.1:7470/aquilo/bus/&secret=...` connect back to the local bus — one URL per browser source, no per-stream config.

---

## Tiers

Loadout's free tier is fully functional. Patreon supporters at [patreon.com/aquiloplays](https://patreon.com/aquiloplays) unlock features Loadout would otherwise have to charge separately for; same campaign as StreamFusion, so a single sign-in covers both products.

| Tier | Unlocks |
|---|---|
| **Free** | Info commands · Twitch alerts · 3 timed messages · basic welcomes · `!link` · Bolts wallet · counters · sub anniversary · 3 minigames |
| **Tier 2 ($6) — Loadout Plus** | Multi-platform alerts · unlimited timers · all welcome tiers · alert sounds · webhook inbox · Discord live-status · stream recap · backup/restore · weekly digest · tip integration |
| **Tier 3 ($10) — Loadout Pro** | TikTok hype train · hate-raid detector · smart auto-clipper · VOD chapter markers · cross-platform Bolts · VIP rotation auto-magic · Apex animated flairs · dungeon RPG · daily quests · achievements · beta channel access |

---

## Architecture

- **`Loadout.dll`** — single .NET 4.8 WPF DLL. Settings UI, tray icon, onboarding wizard, update checker, Aquilo Bus host, 30+ modules.
- **Streamer.bot side** — 9 inline-C# trampoline actions that load `Loadout.dll` via reflection (no References-tab editing required).
- **Aquilo Bus** — localhost WebSocket pub/sub; cross-product nervous system.
- **OBS overlays** — static HTML/JS at `widget.aquilo.gg/overlays/*` (Cloudflare Pages auto-deploy from a private mirror repo) connecting back to your local bus.
- **Discord bot** — Cloudflare Worker at `loadout-discord.aquiloplays.workers.dev`. KV-backed wallet, slash command + menu surface, HMAC-signed sync to the DLL.
- **`aquilo-presence`** — Railway Node service holding Discord Gateway WebSockets so the HTTP-only Worker bot shows green-online.
- **Patreon entitlement** — shared Cloudflare Worker proxy with StreamFusion (same campaign + tier IDs), DPAPI-encrypted token storage.

Detailed: [CONFIG.md](CONFIG.md) · [PRIVACY.md](PRIVACY.md) · [HANDOFF.md](HANDOFF.md)

---

## Build from source

```powershell
# Requires .NET SDK 8 (any modern edition)
.\tools\build-dll.ps1            # builds Loadout.dll
.\tools\build-sb-import.ps1      # generates loadout-import.sb.txt
.\tools\install-dev.ps1          # copies DLL to your Streamer.bot data folder

# Worker (off-stream Discord bot)
cd discord-bot
npm install
npx wrangler deploy
```

CI runs on every push: [.github/workflows/build.yml](.github/workflows/build.yml).

---

## Contributing

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the code style + module-add walkthrough.

---

## License

Proprietary, all rights reserved. See [LICENSE](LICENSE). For permission requests reach out via [aquilo.gg](https://aquilo.gg).

---

## Credits

Built by [aquiloplays](https://github.com/aquiloplays). Streamer.bot host runtime by [Streamer.bot](https://streamer.bot). Identity icons via [simpleicons.org](https://simpleicons.org). Discord interactions verified via [`discord-interactions`](https://github.com/discord/discord-interactions-js).
