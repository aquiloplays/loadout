# Loadout

> The complete Streamer.bot suite. One import string, everything ready.

Loadout drops a fully-loaded suite of features onto your Streamer.bot — info commands, multi-platform alerts, smart timed messages, AI-personalized shoutouts, hate-raid detection, an Apex top-viewer mode, a unified Bolts wallet, the whole thing. **One import. One DLL. Configured entirely from a real settings UI.** Nothing to wire up by hand.

Built to run alongside [StreamFusion](https://github.com/aquiloplays/StreamFusion) on the [Aquilo Bus](#aquilo-bus) so they share Patreon entitlements, overlay events, and a unified bus across every aquilo.gg product.

[![Latest release](https://img.shields.io/github/v/release/aquiloplays/loadout)](https://github.com/aquiloplays/loadout/releases/latest)
[![Streamer.bot](https://img.shields.io/badge/streamer.bot-1.0.0%2B-9147ff)](https://streamer.bot)
[![Patreon](https://img.shields.io/badge/Patreon-support-FF424D)](https://patreon.com/aquiloplays)

---

## Quick install

1. **Download `Loadout.dll` and `loadout-import.sb.txt`** from the [latest release](https://github.com/aquiloplays/loadout/releases/latest).
2. Drop `Loadout.dll` into `<Streamerbot>/data/Loadout/` (Loadout will also auto-download it on first boot if you skip this).
3. **In Streamer.bot, click Import (top-right) and paste the contents of `loadout-import.sb.txt`.**
4. Restart Streamer.bot — or right-click the `Loadout: Boot` action and Run Now.
5. The onboarding wizard pops up. Pick what you want enabled. Done.

That's it. No References-tab editing. No per-event action wiring. No manual trigger setup.

Detailed walkthrough: [INSTALL.md](INSTALL.md)

---

## What's in the kit

24 modules, all off by default until you enable them in the onboarding wizard or Settings → Modules:

### Core
- **Info commands** — `!uptime`, `!followage`, `!accountage`, `!title`, `!game`, `!so`, `!lurk`/`!unlurk`, `!socials`, `!discord`, `!quote add/get/random`, custom commands
- **Context-aware welcomes** — different greetings for first-time / returning / sub / VIP / mod
- **Alerts** — follow / sub / cheer / raid / super chat / membership / TikTok gift, themed and rate-limited
- **Auto-timed messages** — smart cadence with chat-activity gating, broadcaster-pause, randomized order
- **Goals** — follower/sub/bit/coin trackers with live overlay updates

### Engagement
- **Bolts ⚡** — unified cross-platform wallet. Earn from chat / subs / cheers / raids / TikTok gifts / channel points / CC coins. Multipliers from sub status, daily streak, and Patreon tier. Spend via `!gift` and `!boltrain`. [More →](#bolts)
- **Apex 👑** — top-viewer mode with cross-platform damage. TikTok gifts chip away at the Apex viewer's HP just like Twitch subs. Finisher takes the crown. [More →](#apex)
- **Daily Check-In** — overlay with avatar, sub flair, Patreon flair, rotating stream stats. Twitch channel-point reward OR `!checkin` command on any platform.
- **Counters** — `!deaths`, `!wins`, custom counters with chat increment/decrement and live overlay
- **Sub anniversary milestones** — auto-celebrates 3/6/12/18/24+ month subs when they chat

### Smart features
- **AI-personalized shoutouts** on raids — Anthropic Claude or OpenAI, BYOK or Tier 3 bundled
- **Hate-raid detector** — pattern-based detection, broadcaster DM, no chat noise
- **Sub raid trains** — burst detection (3+/6+/10+/20+ subs in 60s), bus-driven overlay
- **TikTok hype train** — synthetic for TikFinity gifts (TikTok has none natively)
- **Smart cooldowns** — chat-velocity tracker writes `loadout.chatVelocity` and `loadout.chatTier` globals
- **First-words celebration** — Twitch + YouTube native first-words events
- **Ad-break heads-up** — chat warning + countdown overlay
- **Auto-poll on category change** — chat reaction prompt
- **VIP rotation auto-magic** — weekly engagement-based promotion/demotion (Tier 3)
- **Crowd Control coin tracker** — leaderboard for `!cccoins` / `!cccoinsall` / `!mycoins`

### Integrations
- **Discord live-status auto-poster** — go-live embed, edit on title/category change, archive on offline
- **Stream recap** — post-stream summary to Discord (top chatter, follows, subs, raids received, hype moments)
- **Webhook inbox** — HTTP listener for Ko-fi / Throne / Patreon / custom; publishes to Aquilo Bus + can fire SB actions
- **Aquilo Bus** — localhost WebSocket pub/sub for cross-product comms (Loadout + StreamFusion + future tools)

---

## Bolts

Single cross-platform points wallet. Default earn rates (configurable):

| Action | Bolts |
|---|---|
| Chat message | 1 |
| Sub / resub | 50 |
| Gifted sub | 30 each |
| Raid | 100 |
| Cheer | 1 per 100 bits |
| TikTok gift | 1 per 10 coins |
| CC coin spend | 1 per 10 |
| Daily check-in | 100 |
| Sub anniversary | 100 × month milestone |

**Multipliers** (additive): sub +0.5 · Patreon Tier 1 +0.2 · Tier 2 +0.5 · Tier 3 +1.0 · daily streak +0.1/day capped at +1.0.

**Commands**: `!bolts [@user]` · `!leaderboard` · `!gift @user N` · `!boltrain N [count]` (mod).

**Overlay** at `aquilo.gg/overlays/bolts` consolidates leaderboard ticker, earn toasts, bolt rain, streak banner, and gift bursts into one OBS browser source.

---

## Apex

Top-viewer mode with cross-platform damage. One viewer holds the spot at a time. Every spend event from anyone else chips away at their HP. When HP hits 0, the finisher takes the crown.

**Damage sources** (all configurable): Twitch sub/resub/gift/cheer · TikTok gifts (1 per coin) · Channel point redemptions · CC coin spend · Bolts spent via `!gift` or `!boltrain` · Daily Check-In · Raids.

**Cross-platform**: a TikTok viewer who's `!link`'d their Twitch handle holds one Apex slot, not two.

**Commands**: `!apex` · `!apex top` · `!apex set @user [hp]` (mod) · `!apex kill` (mod).

**Overlay** at `aquilo.gg/overlays/apex` shows the current Apex's avatar, animated HP bar with tier-shifting colors, reign timer, and rolling damage feed.

---

## Aquilo Bus

Localhost WebSocket pub/sub at `ws://127.0.0.1:7470/aquilo/bus/`. Per-machine shared secret at `%APPDATA%\Aquilo\bus-secret.txt`. Loadout hosts the server; StreamFusion and any future aquilo.gg product can subscribe. Versioned protocol, kind-glob filters, bidirectional.

OBS overlays at `aquilo.gg/overlays/{check-in,counters,goals,bolts,apex}` connect back to this local bus — one URL per browser source, no per-stream config.

StreamFusion drop-in client: [`integrations/streamfusion/aquilo-bus.js`](integrations/streamfusion/aquilo-bus.js).

---

## Tiers

Loadout's free tier is fully functional. Patreon supporters at [patreon.com/aquiloplays](https://patreon.com/aquiloplays) unlock features Loadout would otherwise have to charge separately for; same campaign as StreamFusion, so a single sign-in covers both products.

| Tier | Unlocks |
|---|---|
| **Free** | Info commands · Twitch alerts · 3 timed messages · basic welcomes · `!link` · Bolts wallet · counters · sub anniversary |
| **Tier 2 ($6) — Loadout Plus** | Multi-platform alerts · unlimited timers · all welcome tiers · alert sounds · webhook inbox · Discord live-status · stream recap · backup/restore |
| **Tier 3 ($10) — Loadout Pro** | AI shoutouts (bundled key) · TikTok hype train · hate-raid detector · smart auto-clipper · VOD chapter markers · cross-platform Bolts · VIP rotation auto-magic · Apex animated flairs · beta channel access |

AI shoutouts are also unlocked at the free tier with your own Anthropic / OpenAI API key.

---

## Architecture

- **`Loadout.dll`** — single .NET 4.8 WPF DLL. Settings UI, tray icon, onboarding wizard, update checker, Aquilo Bus host, 24 modules.
- **Streamer.bot side** — 9 inline-C# trampoline actions that load `Loadout.dll` via reflection (no References-tab editing required).
- **Aquilo Bus** — localhost WebSocket pub/sub; cross-product nervous system.
- **OBS overlays** — static HTML/JS at `aquilo.gg/overlays/*` connecting back to your local bus.
- **Patreon entitlement** — re-uses StreamFusion's existing Cloudflare Worker proxy (same campaign + tier IDs), DPAPI-encrypted token storage.

Detailed: [CONFIG.md](CONFIG.md) · [PRIVACY.md](PRIVACY.md)

---

## Build from source

```powershell
# Requires .NET SDK 8 (any modern edition)
.\tools\build-dll.ps1            # builds Loadout.dll
.\tools\build-sb-import.ps1      # generates loadout-import.sb.txt
.\tools\install-dev.ps1          # copies DLL to your Streamer.bot data folder
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

Built by [aquilo_plays](https://aquilo.gg) for streamers who don't want to spend a weekend wiring Streamer.bot actions.
