# Changelog

All notable changes to Loadout. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [SemVer](https://semver.org/).

---

## [Unreleased]

(Nothing queued — see [issues](https://github.com/aquiloplays/loadout/issues) for what's coming.)

---

## [0.1.0] — Initial public release

First release. The whole kit ships in one import string.

### Added

**Suite foundation**
- One-string Streamer.bot import bundle (`loadout-import.sb.txt`) with 9 trampoline actions; no References-tab editing required
- `Loadout.dll` (.NET Framework 4.8 WPF) — single-file install, downloaded automatically by the bootstrap action on first launch
- 8-step onboarding wizard (Welcome → Platforms → Modules → Discord → AI → Webhook → Patreon → Done) with Recommended / Enable-all / Disable-all preset buttons
- Tabbed Settings UI matching the StreamFusion / aquilo.gg brand palette (`#0E0E10` / `#3A86FF` / Segoe UI / 8 px radius)
- Branded multi-resolution tray icon with health-status row (Bus state · Patreon tier · enabled module count · quiet mode)
- DPAPI-encrypted Patreon token storage, sharing the StreamFusion campaign so Tier 2/3 supporters are recognized in both products with one sign-in
- Auto-update checker on a 6-hour cadence, channel-aware (stable / beta)

**Aquilo Bus**
- Localhost WebSocket pub/sub at `ws://127.0.0.1:7470/aquilo/bus/` — versioned protocol, kind-glob filters, bidirectional, secret-authenticated
- Per-machine shared secret at `%APPDATA%\Aquilo\bus-secret.txt` — auto-generated on first run, read by both Loadout and StreamFusion
- StreamFusion drop-in client (`integrations/streamfusion/aquilo-bus.js`) with main-process WebSocket + preload IPC bridge

**24 modules (all OFF by default; enabled via onboarding or Settings)**
- Info commands: `!uptime` · `!followage` · `!accountage` · `!title` · `!game` · `!so` · `!lurk` · `!unlurk` · `!socials` · `!discord` · `!quote add/get/random` · custom commands
- Context-aware welcomes (first-time / returning / sub / VIP / mod tiers — last three gated to Tier 2)
- Multi-platform alerts (follow / sub / cheer / raid / super chat / membership / TikTok gift) with per-kind 3 s coalescing
- Auto-timed messages with chat-activity gating, broadcaster-pause cooldown, and randomized order
- AI-personalized shoutouts on raids — Anthropic Claude or OpenAI, BYOK or Tier 3 bundled
- Discord live-status auto-poster — go-live embed, edit on title/category change, archive on offline
- Webhook inbox — HTTP listener (configurable port) with X-Loadout-Secret auth, Aquilo Bus broadcast, and SB action invocation per path mapping
- Stream recap to Discord on `streamOffline` — top chatters, follows, subs, raids, hype moments
- Hate-raid detector — pattern-based, no chat noise (Tier 3)
- Sub raid trains — burst detection at 3/6/10/20 subs in 60 s
- TikTok hype train — synthetic for TikFinity gifts (Tier 3)
- First-words celebration on Twitch + YouTube native events
- Ad-break heads-up on `TwitchUpcomingAd`
- Auto-poll on category change with chat reaction prompt
- VIP rotation auto-magic — weekly engagement-based, mod-overridable via `!viprotate` (Tier 3)
- Crowd Control coin tracker with `!cccoins` / `!cccoinsall` / `!mycoins` and engagement integration
- Sub anniversary milestone detector (3 / 6 / 12 / 18 / 24 / 36 / 48+ months)
- Counters — `!deaths`, `!wins`, custom counters with chat increment / decrement / reset and live overlay
- Daily Check-In — Twitch channel-point reward OR `!checkin` command on any platform; rotating stat overlay with avatar, sub flair, Patreon flair
- Goals — follower / sub / bit / coin trackers with live overlay updates
- Bolts ⚡ — unified cross-platform points wallet with sub & Patreon multipliers, daily streak bonus, anti-AFK chat cap; `!bolts`, `!leaderboard`, `!gift`, `!boltrain`
- Apex 👑 — top-viewer mode with cross-platform damage; TikTok gifts chip away at HP just like Twitch subs; finisher takes the crown; `!apex`, `!apex top`, `!apex set`, `!apex kill`
- Identity linker — `!link <platform> <user>` viewer self-claim, `!linkapprove` mod approval; canonical key shared across Bolts, Apex, and Engagement modules
- Engagement tracker — persistent per-viewer activity store (msg count, sub events, gifts, raids, bits, CC coins) backing the VIP rotation and CC leaderboard

**Chat noise reduction**
- `ChatGate` central rate limiter — per-key cooldowns + per-area enable flags + global 30 / minute cap + Quiet Mode master mute (`!loadout quiet`)
- All 24 modules route their chat output through ChatGate; under any combination of settings the suite cannot exceed 30 chat messages per minute total
- Counter chat acks support every-Nth and silent modes — overlays still update instantly via the bus

**OBS overlays at aquilo.gg/overlays/**
- `/check-in` — avatar, sub / VIP / mod / Patreon flairs, rotating stream stats, four animation themes
- `/counters` — configurable counter cards with three layouts and three themes
- `/goals` — kind-themed progress bars (sub purple→blue, bit gold, follower pink→blue, coin cyan)
- `/bolts` — unified Bolts overlay (leaderboard ticker + earn toasts + bolt rain + streak banner + gift bursts) in one OBS source
- `/apex` — Apex card with avatar, animated tier-shifting HP bar, reign timer, rolling damage feed, dethrone splash
- `/link` — Patreon supporter self-claim flow

**Cloudflare Worker**
- `aquilo-gg/worker/loadout-link-worker.js` — drop-in additive routes for the existing StreamFusion patreon-proxy; KV-backed handle mappings; `/api/link/exchange`, `/api/link/handles` (POST + DELETE), `/api/link/lookup` (anonymous tier check)

**Tooling**
- `tools/build-dll.ps1` — DLL build wrapper around `dotnet build`
- `tools/build-sb-import.ps1` — generates the SBAE-format import bundle (4-byte SBAE header + gzip + base64)
- `tools/build-icon.ps1` — multi-resolution `Loadout.ico` generator
- `tools/decode-sb-export.ps1` — debug helper for round-tripping bundles
- `tools/dump-sb-enums.ps1` — extracts `Streamer.bot.Common.Events.EventType` from the SB DLLs (used to verify all 30+ trigger numbers we ship)
- `tools/install-dev.ps1` — local dev install: builds + copies DLL to `<Streamerbot>/data/Loadout/`
- `tools/release.ps1` — version bump + build + package + tag + push

**Errors & ops**
- `loadout-errors.log` — append-only error log in the data folder, auto-rotates at 1 MB; every module-level exception in `SbEventDispatcher` writes a timestamped line
- `!loadout help` · `!loadout reload` · `!loadout settings` · `!loadout quiet` chat commands
