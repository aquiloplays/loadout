# Loadout — one-command product launcher.
#
# Wraps every safe-to-automate step into a single Confirm-prompted
# pipeline. Things requiring your credentials (GitHub push, Railway
# deploy, Fourthwall product creation) are NOT done here — those
# require interactive sign-in and the script just prints the exact
# commands at the end.
#
# Usage:
#   .\tools\launch.ps1                 # walks every step, asks per phase
#   .\tools\launch.ps1 -Yes            # autoconfirm safe steps
#   .\tools\launch.ps1 -Version 0.1.0  # bumps version + tags
#   .\tools\launch.ps1 -SkipBuild      # skip rebuild
#   .\tools\launch.ps1 -SkipImages     # skip Edge screenshots
[CmdletBinding()]
param(
    [string]$Version    = "0.1.0",
    [switch]$Yes,
    [switch]$SkipBuild,
    [switch]$SkipImages,
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

# ── 3. Render marketing images ─────────────────────────────────────────────
Heading "3. Render marketing images via headless Edge"
if ($SkipImages) {
  Write-Host "Skipped (-SkipImages)" -ForegroundColor Yellow
} elseif (Confirm "Render hero (1200x800) + og:image (1200x630) PNGs?") {
  $edge = @(
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1

  if (-not $edge) {
    Write-Host "Edge not found — skipping image render" -ForegroundColor Yellow
  } else {
    $banner = "$repoRoot\marketing\fourthwall\promo-banner.html"
    $bannerUrl = "file:///" + $banner.Replace('\','/')

    foreach ($spec in @(
      @{ name = "hero-1200x800.png"; w = 1200; h = 800 },
      @{ name = "og-1200x630.png";   w = 1200; h = 630 }
    )) {
      $out = Join-Path "$repoRoot\marketing\fourthwall" $spec.name
      if (Test-Path $out) { Remove-Item $out }
      & $edge --headless=new "--screenshot=$out" "--window-size=$($spec.w),$($spec.h)" --hide-scrollbars --default-background-color=00000000 $bannerUrl
      Start-Sleep -Seconds 2
      if (Test-Path $out) {
        $kb = [math]::Round((Get-Item $out).Length / 1KB, 1)
        Write-Host ("  + " + $out + " (" + $kb + " KB)") -ForegroundColor Gray
      }
    }
    Copy-Item "$repoRoot\marketing\fourthwall\og-1200x630.png" "$repoRoot\aquilo-gg\loadout\og.png" -Force
    Write-Host "  + copied og.png to landing page" -ForegroundColor Gray
  }
}

# ── 4. Stage Loadout git commit ────────────────────────────────────────────
Heading "4. Stage local git commits (no push)"
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

# ── 5. Stage aquilo-bot git commit ─────────────────────────────────────────
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

# ── 6. Tag local v$Version ─────────────────────────────────────────────────
Heading "6. Tag Loadout v$Version (local)"
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

# ── 7. Print handoff ────────────────────────────────────────────────────────
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

  Fourthwall products
    Use marketing/fourthwall/copy.md for descriptions
    Upload marketing/fourthwall/hero-1200x800.png as the hero
    Configure webhook → https://<railway>/fourthwall with X-Aquilo-Bot-Secret

"@ -ForegroundColor White

Write-Host "All done. Anything not on the handoff list, this script already handled." -ForegroundColor Green
