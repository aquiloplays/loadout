# Loadout — Workstation Handoff

This repo is **the source of truth** for Loadout. Cloning it gives you everything needed to build, ship, and iterate. Nothing critical lives outside it except per-machine state (Patreon tokens, the Aquilo Bus secret, Streamer.bot's own data).

## TL;DR — fresh workstation

```powershell
# 1. Install prereqs
winget install Git.Git GitHub.cli

# 2. Clone (gh auth login first if not already)
gh auth login
gh repo clone aquiloplays/loadout
cd loadout

# 3. One-shot setup
.\handoff.ps1
```

`handoff.ps1` will install .NET SDK 8 to your user folder if missing, build `Loadout.dll`, regenerate the SB import bundle, and install the DLL into `<Streamerbot>\data\Loadout\` (auto-detects Desktop install). Then you import `streamerbot\loadout-import.sb.txt` in SB and click `Loadout: Boot`.

`.\handoff.ps1 -Check` verifies prereqs without changing anything.

## What you DON'T need to transfer

- ❌ **Patreon tokens** — DPAPI-encrypted in `%APPDATA%\Loadout\patreon-state.bin` per Windows account; you re-OAuth on a new machine via Settings → Patreon → Connect
- ❌ **Aquilo Bus secret** — auto-generated on first run at `%APPDATA%\Aquilo\bus-secret.txt`; share to overlays via the OBS browser-source URL
- ❌ **Loadout settings.json** — recreated by the onboarding wizard. Optional: copy `%APPDATA%\Loadout\` from old machine to skip re-onboarding
- ❌ **GitHub credentials** — `gh auth login` in browser
- ❌ **Cloudflare account state** — Worker auto-deploys on git push
- ❌ **Discord webhook URLs / API keys** — re-pasted in Settings on the new machine

## What IS in the repo

- `src/Loadout.Core/` — the DLL source (24 modules, settings, Aquilo Bus, Patreon, Apex, Bolts, …)
- `streamerbot/actions/` — 9 inline-C# trampoline action files
- `streamerbot/loadout-import.sb.txt` — the one-string SB import bundle (regenerated on every build)
- `aquilo-gg/overlays/` — 5 OBS overlays (check-in, counters, goals, bolts, apex)
- `aquilo-gg/loadout/` — landing-page source for `aquilo.gg/loadout`
- `aquilo-gg/worker/loadout-link-worker.js` — additive routes for the StreamFusion Patreon worker (KV-backed handle mappings)
- `marketing/fourthwall/` — Fourthwall product copy + FAQ + integration spec + hero PNG
- `integrations/streamfusion/` — drop-in Aquilo Bus client for SF (main + preload + IPC bridge)
- `tools/` — build/release/install/diagnostic PowerShell scripts
- `assets/Loadout.ico` + `Loadout.png` — branded multi-resolution icon

## What lives in OTHER repos / machines (and how they connect)

| Where | What | Wires to Loadout via |
|---|---|---|
| `~/Desktop/aquilo-bot/` | Multi-product Discord announcements bot | Posts release notes, `/announce` slash command, Fourthwall webhook handler |
| `~/Desktop/aquilo-widget/` | TV widget + Rotation music widget + Cloudflare sync worker | TV: subscribes to bus; Rotation: handles `rotation.song.request` (the `!boltsong` flow) |
| `~/Desktop/StreamFusion/` | Multi-chat viewer | Aquilo Bus client; Patreon shares the same campaign |
| `~/Desktop/StreamFusion/bot-service/` | SF release-notes Discord bot | Mirrored pattern — same `SF_RELEASE_POST_SECRET` powers both |
| Cloudflare Worker `streamfusion-patreon-proxy.bisherclay.workers.dev` | Patreon OAuth proxy + handle mappings | Loadout's PatreonClient + SupportersClient call it; `loadout-link-worker.js` adds the new routes |
| Railway | aquilo-bot + SF bot-service hosting | aquilo-bot: `https://<railway>/announce`, `/fourthwall` |

## Architecture in one paragraph

Streamer.bot imports a 14 KB bundle of 9 trampoline actions. Each action is plain inline C# that does `Assembly.LoadFrom(<sb>/data/Loadout/Loadout.dll)` and reflectively calls `LoadoutEntry.Boot(CPH)` / `DispatchEvent(...)`. The DLL spawns its own STA thread for the WPF UI (Settings + Onboarding + tray icon), starts the Aquilo Bus on `127.0.0.1:7470`, and registers 24 modules with the dispatcher. Modules listen for normalized event kinds (`chat`, `sub`, `raid`, `tiktokGift`, etc.) and react. OBS overlays connect to the bus over WebSocket and render. **No SB References-tab editing required, ever.**

## Where state lives

| File | Role |
|---|---|
| `%APPDATA%\Loadout\settings.json` | All configuration |
| `%APPDATA%\Loadout\bolts.json` | Wallet balances + streaks |
| `%APPDATA%\Loadout\engagement.json` | Per-viewer activity counters |
| `%APPDATA%\Loadout\apex.json` | Current Apex state + reign history |
| `%APPDATA%\Loadout\quotes.json` | Quote book |
| `%APPDATA%\Loadout\sub-anniversary.json` | Sub-start dates + last-fired milestones |
| `%APPDATA%\Loadout\identity.json` | Cross-platform `!link` mappings |
| `%APPDATA%\Loadout\patreon-state.bin` | **DPAPI-encrypted** Patreon tokens + tier |
| `%APPDATA%\Loadout\loadout-errors.log` | Module exceptions, auto-rotates at 1 MB |
| `%APPDATA%\Aquilo\bus-secret.txt` | Per-machine Aquilo Bus shared secret |

## Common dev tasks

```powershell
.\handoff.ps1                       # Build + bundle + install (idempotent)
.\tools\build-dll.ps1               # Just compile the DLL
.\tools\build-sb-import.ps1         # Just regenerate the import string
.\tools\install-dev.ps1             # Build + copy to <Streamerbot>\data\Loadout\
.\tools\release.ps1 -Version 0.2.0  # Bump version in csproj + boot action,
                                    # build, package, tag (use -PushTag to push)
.\tools\diff-sb-shape.ps1           # Inspect a real SB action's field shape
                                    # (for debugging import schema regressions)
.\tools\decode-sb-export.ps1 -Base64 "<sb-string>"   # Decode any SB export
```

After a rebuild while SB is running: the boot action stages `Loadout.dll.new` and the next SB restart swaps it in. Or close SB first, then rebuild.

## Pushing a release

```powershell
# 1. Bump version + build + tag (locally)
.\tools\release.ps1 -Version 0.2.0 -PushTag

# 2. CI does the rest: builds, packages, drafts a GitHub Release with assets
#    (.github/workflows/release.yml)

# 3. Publish the draft on github.com → triggers post-release-notes.yml
#    which posts to Discord via the SF bot
```

Required GitHub repo secrets (Settings → Secrets → Actions):

- `SF_RELEASE_POST_SECRET` — same as the SF repo (paste from there)
- `SF_RELEASE_PING_ROLE_ID` — optional Loadout-specific Discord role id
- `SF_RELEASE_EMBED_COLOR` — defaults to `0x3A86FF` Loadout blue, leave unset

## Key brand constants (sync with StreamFusion if changed)

| Use | Value |
|---|---|
| Background | `#0E0E10` |
| Surface | `#18181B` |
| Border | `#2A2A30` |
| Primary text | `#F5F5F7` |
| Muted text | `#B8BCC6` |
| Primary accent | `#3A86FF` |
| Twitch | `#9147FF` · YouTube `#FF0000` · Kick `#53FC18` · TikTok `#00F2EA` |
| Font | Segoe UI · 8 px radius |

Brushes live in `src/Loadout.Core/UI/Styles.xaml` (DLL UI), `aquilo-gg/loadout/style.css` (landing), and overlay `style.css` files. Same hex everywhere; if you change one, change all.

## Patreon shared infrastructure

Loadout reuses the StreamFusion Patreon campaign (id `3410750`). Tier 2 = Loadout Plus ($6, id `28147937`). Tier 3 = Loadout Pro ($10, id `28147942`). Single OAuth sign-in covers both products. Owner email `bisherclay@gmail.com` is hard-coded as Tier 3 in `PatreonClient.cs` so creator-self-test works without pledging.

The same Cloudflare Worker (`streamfusion-patreon-proxy.bisherclay.workers.dev`) handles OAuth for both products. `aquilo-gg/worker/loadout-link-worker.js` is **additive** — it adds new routes (`/api/link/*` and the lifetime-license routes from INTEGRATION.md) without touching SF's existing routes. Merge by dispatching path-prefix `/api/link/` and `/api/loadout-license/` to `handleLink(request, env)`.

## Aquilo Bus protocol cheat sheet

```
Server: ws://127.0.0.1:7470/aquilo/bus/?secret=<value>
Auth:   Per-machine secret at %APPDATA%\Aquilo\bus-secret.txt

→ hello       { client: "<name>" }
← hello.ack   { server: "loadout-X.Y.Z" }
→ subscribe   { kinds: ["counter.*", "checkin.*", ...] | ["*"] }

Pub/sub kinds Loadout publishes:
  bolts.{earned,spent,gifted,rain,leaderboard,streak}
  counter.updated · goal.updated · checkin.{shown,enriched}
  apex.{state,crowned,damaged,dethroned}
  cc.coins.{spent,leaderboard} · sub.train.{tier,contributed,ended}
  ads.upcoming · firstwords.celebrated · sub.anniversary
  recap.posted · vip.rotation.completed · webhook.received

Server-side handlers (request/response):
  bolts.spend.request   → bolts.spend.completed | bolts.spend.failed
  bolts.refund          → bolts.refund.completed
  bolts.balance.query   → bolts.balance.result
  rotation.song.{accepted,rejected}  ← bridged into dispatcher
```

Full spec lives in `src/Loadout.Core/Bus/AquiloBus.cs` doc-comment.

## What was last touched (top of stack)

- White-on-white UI fix: hard-set `Background`/`Foreground` on Window roots; defensive default styles for naked TextBlock/Label/ScrollViewer; bumped `Fg.Primary` to `#F5F5F7` for ~14:1 contrast
- Removed all AI features (no token-cost burden until there's revenue)
- Cross-product wallet bridge (`bolts.spend.request` / `.refund` / `.balance.query`)
- Twitter/X webhook live-status module (avoids X's $100/mo API tier)
- TV widget Aquilo Bus client (`aquilo-widget/tv/src/aquilo-bus.js`)
- Rotation widget bus integration + `!boltsong <song>` Bolt-spend command with auto-refund-on-failure (30s)

## Stack ranked of "things to do next"

1. **Push v0.1.0** — `gh repo create aquiloplays/loadout --private --source=. --push` then `git push origin v0.1.0`
2. **Deploy aquilo-bot to Railway** — `cd ~/Desktop/aquilo-bot && railway init && railway up`
3. **Create Fourthwall products** — copy from `marketing/fourthwall/copy.md`; hero is `marketing/fourthwall/hero-1200x800.png`
4. **Wire Fourthwall webhook** to `https://<railway>/fourthwall` with `X-Aquilo-Bot-Secret`
5. Anything from `README.md` Phase 2 wishlist

## Quick troubleshooting

| Symptom | Look at |
|---|---|
| Tray icon doesn't show after Boot | `%APPDATA%\Loadout\loadout-errors.log` |
| Onboarding window invisible | Was the white-on-white bug. Fixed in v0.1.0+. Re-run `handoff.ps1`. |
| `!command` doesn't respond | Per-command 30s cooldown; mods bypass. Or `Modules.<X>` is off |
| Bolts didn't credit | Anti-AFK caps chat earns at 6/min/viewer; check `BoltsConfig` defaults |
| Overlay shows "bus: connecting…" | Secret in URL must exactly match `%APPDATA%\Aquilo\bus-secret.txt` |
| Discord webhook silent | Discord usually rate-limited; wait 10 min; check error log |
| Patreon sign-in stalls | Loopback ports `17823–17825`; firewall may block. Same as StreamFusion. |

For SB import problems specifically, run `tools/diff-sb-shape.ps1` to compare against a real SB action's field shape. The schema is reverse-engineered from your local SB so it tracks whatever version you have installed.
