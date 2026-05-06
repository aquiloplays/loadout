# Loadout - package a zip suitable for selling/listing on Fourthwall.
#
# Distinct from tools/release.ps1: this script does NOT bump versions, edit
# the csproj, modify the changelog, or touch git. It just builds the DLL,
# regenerates the SB import bundle, and stages a self-contained zip with
# Fourthwall-flavoured "READ-ME-FIRST" copy that points buyers to the
# Patreon tier upsell. Safe to re-run any time you push the listing.
#
# Usage:
#   .\tools\release-fourthwall.ps1
#   .\tools\release-fourthwall.ps1 -Configuration Debug    # uncommon, but supported
#
# Output:
#   dist/Loadout-fourthwall.zip
#
# What's inside the zip:
#   Loadout.dll                 - the kit
#   Newtonsoft.Json.dll         - if your SB install doesn't already ship one
#   loadout-import.sb.txt       - one-string Streamer.bot import
#   READ-ME-FIRST.txt           - 5-step quickstart + Patreon upsell
#   INSTALL.md                  - the full walkthrough
#   README.md                   - product overview
#   CHANGELOG.md                - history
#   LICENSE                     - MIT
[CmdletBinding()]
param(
    [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

Write-Host ("=" * 60) -ForegroundColor Cyan
Write-Host "Loadout: Fourthwall package" -ForegroundColor Cyan
Write-Host ("=" * 60) -ForegroundColor Cyan

# ── 1. Read current version (no bump) ──────────────────────────────────────
$csprojPath = "src/Loadout.Core/Loadout.Core.csproj"
$csproj = Get-Content $csprojPath -Raw
if ($csproj -notmatch '<Version>([^<]+)</Version>') {
    throw "Could not read <Version> from $csprojPath"
}
$Version = $matches[1]
Write-Host ("  + Version: {0}" -f $Version) -ForegroundColor Green

# ── 2. Build DLL ───────────────────────────────────────────────────────────
# Resolve dotnet.exe explicitly. Some shells (e.g. PowerShell launched
# from a bash subshell) don't have $env:Path populated with the dotnet
# install dir, so a bare `dotnet build` errors with "command not loaded".
# Same fallback chain loadout-up.ps1 uses.
$dotnet = "$env:LOCALAPPDATA\Microsoft\dotnet\dotnet.exe"
if (-not (Test-Path $dotnet)) { $dotnet = (Get-Command dotnet -ErrorAction SilentlyContinue).Source }
if (-not $dotnet) { throw "dotnet CLI not found - install .NET SDK or add it to PATH" }

Write-Host ("  > Building DLL ({0})..." -f $Configuration)
& $dotnet build $csprojPath -c $Configuration --nologo
if ($LASTEXITCODE -ne 0) { throw "dotnet build failed (exit $LASTEXITCODE)" }
$dllPath = "src/Loadout.Core/bin/$Configuration/net48/Loadout.dll"
if (-not (Test-Path $dllPath)) { throw "Expected DLL not found: $dllPath" }
$dllSize = [math]::Round((Get-Item $dllPath).Length / 1KB, 1)
Write-Host ("  + Loadout.dll built ({0} KB)" -f $dllSize) -ForegroundColor Green

# ── 3. Regenerate SB import bundle ─────────────────────────────────────────
& "$PSScriptRoot/build-sb-import.ps1" -Version $Version
if (-not (Test-Path "streamerbot/loadout-import.sb.txt")) {
    throw "Bundle generation failed - streamerbot/loadout-import.sb.txt missing"
}
Write-Host "  + Import bundle regenerated" -ForegroundColor Green

# ── 4. Stage zip ───────────────────────────────────────────────────────────
$distDir = "dist"
New-Item -ItemType Directory -Force -Path $distDir | Out-Null
$stage = Join-Path $distDir "stage-fourthwall"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null

Copy-Item $dllPath                                    $stage/
$nj = "src/Loadout.Core/bin/$Configuration/net48/Newtonsoft.Json.dll"
if (Test-Path $nj) { Copy-Item $nj $stage/ }
Copy-Item "streamerbot/loadout-import.sb.txt"         $stage/
Copy-Item "INSTALL.md"                                $stage/
Copy-Item "README.md"                                 $stage/
Copy-Item "CHANGELOG.md"                              $stage/
if (Test-Path "LICENSE") { Copy-Item "LICENSE"        $stage/ }

# ── 5. Fourthwall-flavoured READ-ME-FIRST ──────────────────────────────────
# Single-quoted here-string so $-prefixed text in the body doesn't get
# expanded. Closing '@ at column 0 (PowerShell parser requirement).
$readme = @'
============================================================
  LOADOUT v{VERSION}
  All-in-one Streamer.bot kit
============================================================

Thanks for grabbing Loadout.

This zip contains the free tier - the same DLL the open-source
project ships on GitHub, with full chat info commands, basic alerts,
welcomes, timers, counters, Bolts wallet, and 12 OBS overlays
(including a one-pane "compact" overlay and a Spotify integration
via the Rotation widget).

------------------------------------------------------------
  5-MINUTE INSTALL
------------------------------------------------------------

  1. Drop Loadout.dll into:
       <Streamerbot>/data/Loadout/Loadout.dll

     (If you don't have a Loadout folder there, create one. If
      Streamer.bot complains about Newtonsoft.Json missing, drop
      Newtonsoft.Json.dll in the same folder.)

  2. Open Streamer.bot. Click Import (top-right). Open
     loadout-import.sb.txt in a text editor, copy the entire
     contents, paste into the Import dialog. You should see 9
     actions previewed under the "Loadout" group. Click Import.

  3. Right-click "Loadout: Boot" in the actions panel and choose
     Run Now. (Or just restart Streamer.bot.)

  4. The tray icon appears (look for the blue/cyan "L" badge) and
     the onboarding wizard opens automatically. Walk through it -
     8 steps, most are skippable.

  5. Open Settings (right-click the tray icon -> Settings) and
     enable the modules you want. Default state is everything OFF
     so you opt in to whatever fits your channel.

INSTALL.md in this zip has the full walkthrough with screenshots
references and troubleshooting. README.md is the product overview.

------------------------------------------------------------
  WANT MORE? UPGRADE TO LOADOUT PLUS / PRO
------------------------------------------------------------

The free tier is genuinely useful. Plus and Pro unlock the features
built for cross-platform + community-heavy streamers:

  Plus  ($6/mo)  Cross-platform send (YouTube/Kick/TikTok), unlimited
                 timed messages, all welcome variants, alert sounds,
                 webhook inbox, Discord/Twitter auto-posters, settings
                 backup, stream recap card, unlimited counters, daily
                 check-in overlay event.

  Pro   ($10/mo) Everything in Plus + cross-platform hype train (TikTok
                 gifts fuel the train), hate-raid detector, smart
                 auto-clipper, VOD chapter markers, cross-platform Bolts
                 wallet, beta channel, animated check-in flairs,
                 automatic VIP rotation, Bolts cross-platform sync.

How to unlock:
  1. Open Loadout Settings -> click "Connect Patreon"
  2. Sign in to Patreon (browser pops, OAuth callback to localhost)
  3. Loadout reads your pledge tier and unlocks the right features.
     Re-checks every 6 hours and on Settings open.

Patreon: https://www.patreon.com/aquiloplays

Cancel anytime. Your settings + Bolts wallet stay; you just drop
back to free-tier limits.

------------------------------------------------------------
  SUPPORT
------------------------------------------------------------

  GitHub:   https://github.com/aquiloplays/loadout
  Issues:   https://github.com/aquiloplays/loadout/issues
  Discord:  see aquilo.gg for the latest invite

The code in this zip is the same binary the GitHub repo publishes -
Plus / Pro features are unlocked by your Patreon entitlement, not by
a different DLL. Source is browsable on GitHub for transparency
(report bugs, send patches), but the binary is proprietary; see the
LICENSE file in this zip for terms.

Thanks for streaming with Loadout.
- Aquilo
'@
$readme = $readme.Replace('{VERSION}', $Version)
$readme | Out-File "$stage/READ-ME-FIRST.txt" -Encoding utf8

# ── 6. Zip ─────────────────────────────────────────────────────────────────
$zipPath = Join-Path $distDir "Loadout-fourthwall.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path "$stage/*" -DestinationPath $zipPath
$zipSize = [math]::Round((Get-Item $zipPath).Length / 1KB, 1)
Write-Host ""
Write-Host ("  + dist/Loadout-fourthwall.zip ({0} KB)" -f $zipSize) -ForegroundColor Green
Write-Host ""
Write-Host "Upload this file to Fourthwall as the digital deliverable." -ForegroundColor Cyan
Write-Host "Re-run this script after every DLL change to refresh." -ForegroundColor Cyan

