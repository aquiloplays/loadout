# Releasing Loadout

How to ship a new Loadout build so every installed copy auto-updates to it.

---

## How auto-update works (end-user side)

A Streamer.bot DLL can't auto-install in-process, the file is locked by SB while it's loaded. Loadout uses the closest practical equivalent:

1. **`UpdateChecker` runs on Streamer.bot boot** (10s after start) and every 6h thereafter. Settings → Updates → "Check for updates on boot + every 6h" is on by default.
2. It polls `https://api.github.com/repos/aquiloplays/loadout-downloads/releases?per_page=10` and filters by channel (`stable` skips prereleases, `beta` includes them).
3. If a newer release is found and **Auto-download** is on (default), the new `Loadout.dll` (plus `Newtonsoft.Json.dll` if present) is downloaded straight to `<SB>/data/Loadout/Loadout.dll.new` in the background.
4. A tray-icon balloon fires: "Loadout update v1.X.Y downloaded, restart Streamer.bot to apply." The tray menu now reads "Restart Streamer.bot to apply v1.X.Y".
5. On next SB restart, `streamerbot/actions/00-boot.cs` (the boot action that's pinned to Streamer.bot Started) sees `Loadout.dll.new`, deletes the old `Loadout.dll`, moves `.new` into place, and `Assembly.LoadFrom`s it. The user sees nothing, they just restart SB once and they're on the new version.

The streamer's only required action is **restart Streamer.bot**. No manual download, no "Apply update" click (unless they opted out of Auto-download). Settings UI also has a manual "Check for updates now" button that bypasses the 6h timer.

### What if the streamer opts out of Auto-download?

Then step 3 doesn't happen automatically, the tray shows "Apply update to v1.X.Y" which downloads on click. Same end state, one extra click.

---

## Cutting a release

The release pipeline is already wired and CI-driven. There's nothing to set up beyond a one-time PAT.

### One-time setup

1. **Create a fine-grained PAT** at https://github.com/settings/personal-access-tokens with:
   - Resource owner: `aquiloplays`
   - Repository access: `loadout-downloads` (just that one)
   - Permissions: **Contents: Read and write**
2. On `aquiloplays/loadout` (the source repo): **Settings → Secrets and variables → Actions → New repository secret**:
   - Name: `LOADOUT_DOWNLOADS_TOKEN`
   - Value: paste the PAT
3. `.github/workflows/release.yml` uses it for the cross-repo `softprops/action-gh-release` upload.

### Ship a new version

From the repo root on your dev box:

```powershell
.\tools\release.ps1 -Version 2.0.0 -PushTag
```

The script:

1. Updates `<Version>` / `<AssemblyVersion>` / `<FileVersion>` in `src/Loadout.Core/Loadout.Core.csproj`.
2. Updates the `private const string Version = "..."` line in `streamerbot/actions/00-boot.cs` so first-run downloads pull the matching DLL URL.
3. Promotes `## [Unreleased]` in `CHANGELOG.md` to `## [2.0.0] - YYYY-MM-DD`.
4. Builds `Loadout.dll` in Release config (sanity check).
5. Regenerates `streamerbot/loadout-import.sb.txt`.
6. Stages a local zip at `dist/Loadout-v2.0.0.zip`.
7. Commits the version bumps and tags `v2.0.0`.
8. Pushes the commit and tag (`-PushTag`).

The push triggers `.github/workflows/release.yml` on GitHub. It rebuilds on a clean Windows runner, repackages, and creates a **draft** release on `aquiloplays/loadout-downloads` with:

- `Loadout.dll`
- `Newtonsoft.Json.dll`
- `loadout-import.sb.txt`
- `Loadout-v2.0.0.zip` (the all-in-one bundle for new installs)

### Publishing the release

1. Open the draft on https://github.com/aquiloplays/loadout-downloads/releases.
2. Polish the auto-generated release notes if you want (or paste from `CHANGELOG.md`).
3. Click **Publish release**.

The moment the release flips from draft → published, every running Loadout install's next 6h tick (or the streamer's next "Check for updates" click) will detect it, download the new DLL in the background, and prompt for an SB restart.

### If something goes wrong

- **Workflow failed at "Resolve tag + version"** → the tag doesn't match the csproj version. The release script keeps them in sync; this only fails if you tagged manually. Re-run `tools/release.ps1 -Version <correct>` to fix.
- **Workflow created a release but didn't upload assets** → `LOADOUT_DOWNLOADS_TOKEN` is missing, expired, or doesn't have `Contents: write` on `loadout-downloads`. Regenerate the PAT and update the secret.
- **Clients aren't picking up the update** → confirm the release is **published** (not draft), confirm `Loadout.dll` is among the assets (the checker matches that exact filename), and confirm the tag follows `v\d+\.\d+\.\d+` format. The version comparator strips any `-beta.N` suffix, so `v2.0.0-beta.1` is treated as `2.0.0` for the staying-current check on the stable channel, that's why prerelease tags should always go on the beta channel filter.

---

## What if a user is on an old version and won't update?

The streamer always has the choice to:

- Manually click "Check for updates" in tray or Settings.
- Download the new zip from https://download.aquilo.gg/loadout (resolved by the redirects worker to `aquiloplays/loadout-downloads/releases/latest`) and re-import.
- Skip a particular release, there's no force-update mechanism. If you ever need to push a security fix that absolutely cannot be skipped, the only path today is a Discord announcement asking everyone to restart SB. Worth designing a "minimum supported version" bump path if that ever becomes a real need.
