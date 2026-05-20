# Changelog

All notable changes to Loadout. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [SemVer](https://semver.org/).

---

## [Unreleased]

(Nothing queued.)

---

## [1.7.0] - 2026-05-19

Phase BR-core — branching dungeons (vote + cooldown skip).

### Added

- `DungeonScene` gains `Options[]` and `DungeonRunResult` gains an optional `Branch` + `BranchEffects`. 20 % of non-wiped runs roll a branching finale picked from `DungeonContent.BranchScenes` (three sample scenes ship: Crossroads, Forge Antechamber, Treetop Glade).
- `DungeonModule.RunDungeonNow` is split into the existing publish path + a new `ApplyAndCompleteRun`. Branching runs `Task.Delay` for the scene's `DelayMs + 30 s` vote window + a small buffer, then resolve plurality (first-vote tiebreak, no-vote default = first option), apply the winning `BranchEffect` to outcomes, publish `dungeon.choice {optionId, votes, resolveText, ...}`, then complete.
- `!dungeon vote <id>` (any viewer) and `!dungeon skip` (Worker-validated only) chat commands on `DungeonModule.OnEvent`.

### Changed

- Worker `POST /ext/dungeon/skip-cooldown` accepts either a Bits receipt (SKU `dungeon_skip_cooldown`, 100 bits) **or** `{ bolts: true }` which debits 500 bolts via `wallet.spend`. On success the route enqueues a dungeon `skip` panel-bridge command; `PanelBridgeModule` stamps a `loadout.panel.skip` trust flag so `DungeonModule` honours the bypass exactly once.
- `dungeon.scene` payload now carries `options` (vote-button data) alongside `partyHp` and `target`.

---

## [1.6.0] - 2026-05-19

HP deltas mid-scene.

### Changed

- `dungeon.scene` events now carry a per-scene HP snapshot for every party member (`partyHp: [{name, hp, hpMax}, ...]`). The Twitch panel uses it to tick HP bars down live as the scene replay plays back, instead of freezing on the starting roster.
- Internal: new `HpSnapshot` type on `DungeonScene.PartyHp`, populated by `DungeonEngine.SnapshotHp` at every `Scenes.Add` site (opening flavour + main scene loop). `PanelBridgeModule` forwards the field as `scene.partyHp`.

---

## [1.5.0] - 2026-05-19

Tech-debt cleanup on the panel-bridge surface.

### Changed

- `dungeon.scene` snapshots now forward the engine's `targetUser` as `target`, so the Twitch panel can pulse the chip of whoever a scene happens to (spike trap, dragon strike, etc.).

### Docs

- Backfilled the bodyless CHANGELOG entries for 1.1.0 – 1.4.0 from the actual git history between release commits.

---

## [1.4.0] - 2026-05-19

B3 Panel Bridge sub-phase 2 — Commands UP.

### Added

- Twitch panel viewers can now drive dungeon and mini-game commands (Start dungeon · Join party · Duel · Coinflip / Dice / Slots / RPS / Roulette) directly from the extension; the DLL polls them back and replays each as a synthesized Twitch chat event, so the existing engines handle them with no engine changes.
- Worker routes `POST /ext/{dungeon,minigame}/cmd` (JWT-gated, per-action allowlist, queues to KV with ~90 s TTL) and `GET /relay/dll-pending` (X-Relay-Token gated, drains the queue oldest-first).
- `PanelBridgeModule` grows a ~2 s downstream poll loop against `/relay/dll-pending`; dispatched roles ride the JWT, so engine gates ("`!dungeon` is mods-only") still hold.

---

## [1.3.0] - 2026-05-19

B3 Panel Bridge sub-phase 1 — State DOWN.

### Added

- `PanelBridgeModule` mirrors in-process dungeon / mini-game bus state up to the Aquilo Worker so the Twitch panel can show a live, read-only view of a run. Opt-in + Clay-only: inert unless `%APPDATA%\Aquilo\panel-bridge.json` is present with `{enabled, relayToken, workerUrl}`.
- Dungeon runs are buffered and replayed on a `delayMs`-keyed timer, so the panel sees `recruiting → running (scenes advancing) → complete` in real time rather than jumping straight to "complete".
- Worker routes `POST /relay/dll-ingest` (token-gated, ~30 s effective TTL) and JWT-gated `GET /ext/{dungeon,minigame}/state` for the panel.
- `AquiloBus.LocalPublished` event lets in-process observers tap bus traffic without opening a self-WebSocket.

---

## [1.2.0] - 2026-05-18

### Added

- Twitch panel extension `/ext/*` route family on the Discord Worker: `/ext/hero`, `/ext/wallet`, `/ext/daily`, `/ext/checkin`, `/ext/leaderboard` (dual: bolts + check-ins), `/ext/recap`, `/ext/vods`, `/ext/goals`, `/ext/patron-corner`, `/ext/cheer`, plus the `/ext/loadout/*` Bag / Shop / Play surface.
- Rotation (Songs) integration — Spotify-backed search, `!songrequest` plumbing, viewer-state-aware request flow, relay queue scoped via `?for=` so check-in and rotation pollers don't race.
- Aquilo Check-in Relay action for Streamer.bot (bundled and standalone `.sb`).
- Streamer.bot Aquilo Relay action — unified, kind-agnostic relay for every Tier 2 overlay event.
- Tier 1 engagement read routes — VODs, goals, patron corner.
- Tier 2 feature A — tap-to-cheer (Worker route + transparent OBS engagement overlay).
- Rolling 24-hour per-viewer window for stream-recap stats.

### Changed

- Single Patron tier replaces the prior tiered model — every feature is included for any Patron.
- Discord bot consolidates duplicated CORS / JSON / debounce helpers into `ext-shared.js`, imported by all four `/ext` modules.

### Removed

- `/link` slash command — Patreon linking now flows through the Loadout settings UI.
- Unused `#panel` node and other unshipped scaffolding from the engagement overlay.

### Fixed

- `rotation.js` KV writes — clamp `expirationTtl` to the 60 s Cloudflare minimum.
- `/ext/loadout/shop` returned a spurious "debit failed" when the buy was actually successful.

---

## [1.1.0] - 2026-05-17

### Removed

- Feature paywalls — every module is now available to every Loadout user regardless of supporter tier. Patron multipliers on Bolts and shoutout polish stay as paid extras; everything else is free.

### Changed

- CI `release.yml` publishes binaries cross-repo to `aquiloplays/loadout-downloads` instead of attaching them to the source-repo release.

### Fixed

- `release.yml` YAML parse error that was blocking the publish job.

---

## [1.0.0] - 2026-05-13

First public release on `loadout-downloads`. Same kit as the prior 0.1.0 internal cut, repointed at the public binaries repo and auto-downloading via `download.aquilo.gg/loadout`.

### Changed

- Boot script (`00-boot.cs`) now downloads `Loadout.dll` from `aquiloplays/loadout-downloads` instead of the source repo so new installs work without source-repo access.

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
