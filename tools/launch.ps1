# Loadout — one-command product launcher.
#
# Wraps every safe-to-automate step into a single Confirm-prompted
# pipeline. Things requiring your credentials (GitHub push, Railway
# deploy) are NOT done here — those require interactive sign-in and
# the script just prints the exact commands at the end.
#
# Usage:
#   .\tools\launch.ps1                 # walks every step, asks per phase
#   .\tools\launch.ps1 -Yes            # autoconfirm safe steps
#   .\tools\launch.ps1 -Version 0.1.0  # bumps version + tags
#   .\tools\launch.ps1 -SkipBuild      # skip rebuild
[CmdletBinding()]
param(
    [string]$Version    = "0.1.0",
    [switch]$Yes,
    [switch]$SkipBuild,
    [switch]$SkipImport,
    [string]$SbPath     = "$env:USERPROFILE\Desktop\Streamerbot",
    [string]$BotPath    = "$env:USERPROFILE\Desktop\aquilo-bot"
)
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Heading($t) {
  Write-Host ""
  Write-Host ("=" * 64) -ForegroundColor Cyan
  Write-Host ("  " + $t) -ForegroundColor Cyan
  Write-Host ("=" * 64) -ForegroundColor Cyan
}

function Confirm($prompt) {
  if ($Yes) { return $true }
  $r = Read-Host ($prompt + " [Y/n]")
  return ($r -eq "" -or $r -match '^(y|yes)$')
}

# ── 1. Build DLL + bundle ──────────────────────────────────────────────────
Heading "1. Build Loadout.dll + import bundle"
if ($SkipBuild) {
  Write-Host "Skipped (-SkipBuild)" -ForegroundColor Yellow
} elseif (Confirm "Build DLL (Release) and regenerate import bundle?") {
  $env:Path = "$env:LOCALAPPDATA\Microsoft\dotnet;" + $env:Path
  & dotnet build "src/Loadout.Core/Loadout.Core.csproj" -c Release --nologo
  if ($LASTEXITCODE -ne 0) { throw "Build failed" }
  & "$PSScriptRoot/build-sb-import.ps1" -Version $Version
}

# ── 2. Install DLL into local Streamer.bot ─────────────────────────────────
Heading "2. Install DLL into local Streamer.bot"
if (-not (Test-Path $SbPath)) {
  Write-Host "Streamer.bot not found at $SbPath — skipping local install" -ForegroundColor Yellow
} elseif (Confirm "Copy DLL to $SbPath\data\Loadout?") {
  $dataDir = Join-Path $SbPath "data\Loadout"
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  Copy-Item "src/Loadout.Core/bin/Release/net48/Loadout.dll" (Join-Path $dataDir "Loadout.dll") -Force
  Copy-Item "src/Loadout.Core/bin/Release/net48/Newtonsoft.Json.dll" (Join-Path $dataDir "Newtonsoft.Json.dll") -Force
  Write-Host "Installed to $dataDir" -ForegroundColor Green
}

# ── 3. Stage Loadout git commit ────────────────────────────────────────────
Heading "3. Stage local git commits (no push)"
if (Confirm "Stage and commit any uncommitted Loadout changes?") {
  Set-Location $repoRoot
  if (-not (Test-Path ".git")) { git init -b main; }
  git add . 2>&1 | Out-Null
  $hasChanges = (git status --porcelain) -ne $null
  if ($hasChanges) {
    git commit -m ("Release v" + $Version) | Out-Null
    Write-Host "  + Loadout: commit created" -ForegroundColor Gray
  } else {
    Write-Host "  + Loadout: no changes" -ForegroundColor Gray
  }
}

# ── 4. Stage aquilo-bot git commit ─────────────────────────────────────────
if ((Test-Path $BotPath) -and (Confirm "Stage and commit aquilo-bot?")) {
  Push-Location $BotPath
  try {
    if (-not (Test-Path ".git")) { git init -b main }
    git add . 2>&1 | Out-Null
    $hasChanges = (git status --porcelain) -ne $null
    if ($hasChanges) {
      git commit -m "Snapshot for launch prep" | Out-Null
      Write-Host "  + aquilo-bot: commit created" -ForegroundColor Gray
    } else {
      Write-Host "  + aquilo-bot: no changes" -ForegroundColor Gray
    }
  }
  finally { Pop-Location }
}

# ── 5. Tag local v$Version ─────────────────────────────────────────────────
Heading "5. Tag Loadout v$Version (local)"
if (Confirm "Create local tag v$Version on Loadout?") {
  Set-Location $repoRoot
  $existing = git tag --list ("v" + $Version)
  if ($existing) {
    Write-Host "Tag v$Version already exists" -ForegroundColor Yellow
  } else {
    git tag -a ("v" + $Version) -m ("Loadout v" + $Version)
    Write-Host "  + tag v$Version created" -ForegroundColor Gray
  }
}

# ── 6. Print handoff ────────────────────────────────────────────────────────
Heading "✓ Local prep complete — handoff steps below"
Write-Host @"

Things you need to do (require your credentials):

  Streamer.bot import (≈30 seconds)
    Open Streamer.bot. Click Import top-right. Paste:
      $repoRoot\streamerbot\loadout-import.sb.txt
    Right-click 'Loadout: Boot' and Run Now. Walk the wizard.

  Push Loadout to GitHub
    cd "$repoRoot"
    gh auth login                                    # one time
    gh repo create aquiloplays/loadout --private --source=. --push
    git push origin v$Version                        # triggers release.yml

  Push aquilo-bot to GitHub
    cd "$BotPath"
    gh repo create aquiloplays/aquilo-bot --private --source=. --push

  Deploy aquilo-bot on Railway
    railway login                                    # one time
    railway init                                     # link this folder
    railway up                                       # ships the Dockerfile
    Set env vars in Railway dashboard (.env.example has the list)

"@ -ForegroundColor White

Write-Host "All done. Anything not on the handoff list, this script already handled." -ForegroundColor Green
