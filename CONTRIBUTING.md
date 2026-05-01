# Contributing

Thanks for considering it. Loadout is private but PRs from invited collaborators are welcome.

## Build

```powershell
# Requires .NET SDK 8 (any modern edition; targets net48 from net8 SDK is fine)
.\tools\build-dll.ps1            # builds Loadout.dll
.\tools\build-sb-import.ps1      # generates loadout-import.sb.txt
.\tools\install-dev.ps1          # copies DLL to your Streamerbot data folder
```

CI runs `tools/build-dll.ps1` + `tools/build-sb-import.ps1` on every PR.

## Code style

- **C#:** 4-space indent, K&R braces, file-scoped `using`s grouped (System, third-party, Loadout). XML doc comments on public surfaces and on anything cross-cutting.
- **Comments:** explain *why* a thing exists or *why* a counterintuitive choice was made. Skip `// increment counter` style narration.
- **Identifiers:** `PascalCase` for types/methods/properties, `_camelCase` for private fields, `kCamel` not used.
- **Async:** every `Task`-returning method does `.ConfigureAwait(false)` unless it's a UI thread caller.
- **Exceptions:** module event handlers must never let an exception propagate to the dispatcher — write to `Util.ErrorLog` and bail.
- **WPF:** no MVVM frameworks, just code-behind. Brand colors come from `UI/Styles.xaml` — never hardcode.
- **Branding:** match the SF / aquilo.gg palette exactly (`#0E0E10` / `#3A86FF` / Segoe UI / 8 px radius). If you change a brand color in this repo, change it in StreamFusion too.

## Adding a module

1. Create `src/Loadout.Core/Modules/MyThingModule.cs` implementing `IEventModule`.
2. Add a toggle to `ModulesConfig` in `src/Loadout.Core/Settings/LoadoutSettings.cs` (default **false**).
3. If you need new persisted state, add a config class next to `ModulesConfig` and a property on `LoadoutSettings`.
4. If you need a new Patreon gate, add an entry to `Feature` enum in `src/Loadout.Core/Patreon/Entitlements.cs` and the tier mapping in `IsUnlocked`.
5. Register the module in `SbEventDispatcher.RegisterDefaultModules()`. Order matters — anything that *reads* tracker state should come AFTER the producer.
6. Add a checkbox to `OnboardingWindow.xaml` Step 3 + load/save/preset wiring in the `.cs`.
7. If you need a new SB event kind, extend `01-event.cs`'s `MapKind` and add the trigger type to `tools/build-sb-import.ps1`.
8. Build, test, regenerate the bundle, document in `CONFIG.md`.

## Adding an overlay

1. New folder under `aquilo-gg/overlays/<name>/`: `index.html`, `style.css`, `main.js`.
2. Subscribe to your bus kinds (e.g. `mything.*`).
3. Match the existing overlay structure: query-string config (`bus`, `secret`, `debug`), reconnecting WebSocket loop, transparent background.
4. Use the brand palette CSS variables from any existing overlay (copy the `:root` block).
5. Test with `?debug=1` for a static demo without needing the bus running.

## Adding a Streamer.bot trigger

1. Find the numeric type via `tools/dump-sb-enums.ps1` — it dumps `Streamer.bot.Common.Events.EventType` from your local SB install.
2. Add the constant to `tools/build-sb-import.ps1`.
3. Add the trigger to the appropriate event-trampoline action's trigger list.
4. Map it to a string `kind` in `streamerbot/actions/01-event.cs`'s `MapKind`.
5. Regenerate the bundle: `.\tools\build-sb-import.ps1`.

## Tests

There aren't any yet (sorry). The build is currently the only safety net. If you add tests, put them in `tests/Loadout.Core.Tests/` with xUnit, run via `dotnet test`.

## Releases

Tag-driven. See [tools/release.ps1](tools/release.ps1).

```powershell
.\tools\release.ps1 -Version 0.2.0
```

The script bumps version in `Loadout.Core.csproj` + `streamerbot/actions/00-boot.cs`, builds, regenerates the bundle, packages a zip with all assets, creates a git tag, and offers to push it. The `release.yml` workflow takes over from there: builds in CI, attaches the artifacts to a draft GitHub release.

## Commit hygiene

- **Subject lines:** imperative, ≤72 chars (`Add Apex damage threshold setting`, not `Added apex damage threshold setting`).
- **Body:** explain the *why* if it's not obvious from the change.
- **Scope:** keep commits focused — one logical change per commit. Refactor commits separate from feature commits.
- **No commit emoji.** Save them for chat.

## License

Contributions are accepted under the same proprietary license as the rest of the codebase. See [LICENSE](LICENSE).
