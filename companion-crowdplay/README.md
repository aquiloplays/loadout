# aquilo.gg CrowdPlay Companion

Desktop app for **aquilo-crowdplay**. Pick a game, see whether the mod is
installed, start the session, watch live status. Like Crowd Control's launcher,
but for your stack.

The companion launches the `aquilo-crowdplay` Node engine under the hood. The
engine is what actually talks to the game adapter, Twitch chat, TikTok, the
OBS overlay, and the cloud relay. The companion is the GUI on top.

```
┌────────────────────────────────────────────────────────────┐
│  Aquilo CrowdPlay                                _ [] X    │
├────────────────────────────────────────────────────────────┤
│  STATUS                                                    │
│  ● Engine     ● Adapter     ● Relay     ● Token            │
├────────────────────────────────────────────────────────────┤
│  GAME                                                      │
│  [ Days Gone                                          ▼ ]  │
│  Adapter installed at:                                     │
│    C:\...\Days Gone\BendGame\Binaries\Win64\ue4ss\Mods\... │
│  [▶ Start session ]            [■ Stop ]                   │
├────────────────────────────────────────────────────────────┤
│  LOG                                  [Clear] [Copy]       │
│  [10:42:11] [ext-relay] up                                 │
│  [10:42:13] [tcp] +adapter (1)                             │
│  [10:42:30] [FIRE] spawn_freakers <- vote                  │
└────────────────────────────────────────────────────────────┘
   Settings   Open dock   Open project folder
```

## Run from source

```
cd Loadout/companion-crowdplay
python -m pip install -r requirements.txt
python -m companion_crowdplay
```

First launch:

1. Click **Settings**, point at your local `aquilo-crowdplay` folder, paste
   your Twitch channel + relay URL + relay token.
2. Pick a game. The Adapter pip turns green if the mod file is on disk; red
   if it's missing.
3. Click **Start session**. The log streams from the engine; pips update as
   the relay comes up and the in-game mod connects on `tcp://127.0.0.1:8788`
   (or `http://127.0.0.1:8789` for emulator/Python adapters).

## Build a standalone exe

```
pwsh -File build.ps1
```

Output is `dist/aquilo-crowdplay-companion.exe`. PyInstaller is configured
with `--runtime-tmpdir=.` so the bundle extracts next to the .exe instead of
%TEMP% (sidesteps the AV/CFA filter driver issue documented in
`memory/companion-streamkey-runtime-tmpdir.md`).

Pin the exe to the taskbar after first launch.

## What the pips mean

| Pip      | Green                              | Yellow                              | Red                                |
|----------|------------------------------------|-------------------------------------|------------------------------------|
| Engine   | `node src/index.js` running        | Engine starting                     | Engine crashed / not started       |
| Adapter  | Mod connected on TCP/HTTP          | Mod file present, not yet connected | Mod file missing on disk           |
| Relay    | `/web/crowdplay/state` reachable   | -                                   | `EXT_RELAY_URL/TOKEN` blank        |
| Token    | Relay token set in Settings        | Not set                             | -                                  |

## Tray + window behaviour

- The app is a **windowed** app first. Close button HIDES to tray so the
  engine keeps running mid-stream.
- Right-click the tray icon for Show / Start / Stop / Open dock / Quit.
- The window registers a stable Windows AppUserModelID, so pinning to the
  taskbar works without bucketing it under `python.exe`.

## Per-game adapter install

The **Install adapter** button on the Game card runs a per-harness plan
in a background thread, with a step-by-step progress dialog:

| Harness | What auto-install does |
|---|---|
| **UE4SS** (5 games) | Detect UE4SS + LuaSocket; copy `crowdplay/Scripts/main.lua` into `Mods/crowdplay/Scripts/`; append `crowdplay : 1` to `mods.txt` (idempotent). If UE4SS or LuaSocket are missing, opens the GitHub release pages. |
| **BizHawk** (Pokemon Platinum) | Opens the `adapters/pokemon-platinum/` folder so you can drag `crowdplay.lua` into BizHawk's Lua Console. |
| **ZHMModSDK** (Hitman: WoA) | Stages the C++ source under `Retail/mods/CrowdPlay-src/`; opens the build README + the ZHMModSDK GitHub page. Building `CrowdPlay.dll` still requires VS2022 + CMake. |
| **BepInEx** (Killer Bean) | Detects BepInEx; stages the C# source under `BepInEx/plugins/AquiloCrowdPlay-src/`; opens the build README. Building the DLL still requires dotnet SDK + the game's Managed/ assemblies. |
| **pymem** (Crimson Desert) | Runs `pip install pymem requests` in the companion's Python interpreter; opens the adapter folder. |

UE4SS / BepInEx / LuaSocket themselves are **not** auto-downloaded - they
vary per game build + anti-cheat surface, and a known-bad version on
disk is worse than a missing one. The install plan detects what's missing,
points you at the release page, and is safe to re-run.
