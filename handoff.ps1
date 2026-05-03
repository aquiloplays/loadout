# handoff.ps1 — one-shot setup for a fresh workstation. Verifies prereqs,
# installs what's missing, builds Loadout.dll, generates the SB import
# bundle, and copies the DLL into your local Streamer.bot data folder.
#
# Usage:
#   .\handoff.ps1                # full setup (idempotent — safe to re-run)
#   .\handoff.ps1 -Check         # verify everything is good, change nothing
#   .\handoff.ps1 -SkipInstall   # build + bundle but don't touch SB folder
#   .\handoff.ps1 -SbPath "<path>"  # if your SB lives somewhere unusual
#
# Exit codes: 0 = everything OK; non-zero = something needs your attention.
[CmdletBinding()]
param(
    [switch]$Check,
    [switch]$SkipInstall,
    [string]$SbPath = "$env:USERPROFILE\Desktop\Streamerbot",
    [string]$DotnetVersion = "8.0"
)
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repoRoot

function Step($t)  { Write-Host ""; Write-Host ">> $t" -ForegroundColor Cyan }
function Ok($t)    { Write-Host "   + $t" -ForegroundColor Green }
function Warn($t)  { Write-Host "   ! $t" -ForegroundColor Yellow }
function Fail($t)  { Write-Host "   x $t" -ForegroundColor Red }

# ── 1. Prereq: this is Windows ────────────────────────────────────────────
Step "Verifying environment"
if (-not [System.Environment]::OSVersion.Platform.ToString().StartsWith("Win")) {
    Fail "Loadout is Windows-only (targets .NET Framework 4.8 WPF + Streamer.bot)."
    exit 1
}
Ok "Running on Windows"

# ── 2. Prereq: git ────────────────────────────────────────────────────────
$git = (Get-Command git -ErrorAction SilentlyContinue)
if ($git) { Ok "git is on PATH ($($git.Source))" }
else {
    Warn "git not found on PATH. Install with:"
    Write-Host "    winget install Git.Git" -ForegroundColor White
    if (-not $Check) { exit 1 }
}

# ── 3. Prereq: gh CLI (optional but useful for releasing) ─────────────────
$gh = (Get-Command gh -ErrorAction SilentlyContinue)
if ($gh) { Ok "gh CLI on PATH" }
else { Warn "gh CLI not found (optional). Install: winget install GitHub.cli" }

# ── 4. .NET SDK ───────────────────────────────────────────────────────────
$localDotnet = "$env:LOCALAPPDATA\Microsoft\dotnet\dotnet.exe"
$systemDotnetCmd = Get-Command dotnet -ErrorAction SilentlyContinue
$systemDotnet = if ($systemDotnetCmd) { $systemDotnetCmd.Source } else { $null }
$dotnetExe = $null
foreach ($candidate in @($systemDotnet, $localDotnet)) {
    if (-not $candidate) { continue }
    if (-not (Test-Path $candidate)) { continue }
    try {
        $sdks = & $candidate --list-sdks 2>$null
        if ($sdks -match "^$([regex]::Escape($DotnetVersion))\.\d+") {
            $dotnetExe = $candidate; break
        }
    } catch { }
}

if ($dotnetExe) {
    Ok ".NET SDK $DotnetVersion present ($dotnetExe)"
} elseif ($Check) {
    Warn ".NET SDK $DotnetVersion not found"
} else {
    Step "Installing .NET SDK $DotnetVersion to user-local folder"
    $script = "$env:TEMP\dotnet-install.ps1"
    Invoke-WebRequest -Uri "https://dot.net/v1/dotnet-install.ps1" -OutFile $script -UseBasicParsing
    & $script -Channel $DotnetVersion -InstallDir "$env:LOCALAPPDATA\Microsoft\dotnet" -NoPath
    $dotnetExe = $localDotnet
    Ok "Installed .NET SDK $DotnetVersion"
}
$env:Path = (Split-Path -Parent $dotnetExe) + ";" + $env:Path

# ── 5. Edge (used by tools/build-icon.ps1 + promo-banner screenshots) ────
$edge = @(
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($edge) { Ok "Microsoft Edge present (for asset rendering)" }
else { Warn "Microsoft Edge not found - marketing image rendering will skip" }

# ── 6. Build Loadout.dll ──────────────────────────────────────────────────
if ($Check) {
    Step "Skipping build (-Check mode)"
} else {
    Step "Building Loadout.dll (Release)"
    $csproj = Join-Path $repoRoot "src\Loadout.Core\Loadout.Core.csproj"
    & $dotnetExe build $csproj -c Release --nologo
    if ($LASTEXITCODE -ne 0) { Fail "dotnet build failed (exit $LASTEXITCODE)"; exit 1 }
    $dll = Join-Path $repoRoot "src\Loadout.Core\bin\Release\net48\Loadout.dll"
    if (-not (Test-Path $dll)) { Fail "Expected DLL not found: $dll"; exit 1 }
    Ok "Loadout.dll built ($([Math]::Round((Get-Item $dll).Length / 1KB, 1)) KB)"
}

# ── 7. Generate SB import bundle ──────────────────────────────────────────
if ($Check) {
    Step "Skipping bundle generation (-Check mode)"
} else {
    Step "Generating SB import bundle"
    & (Join-Path $repoRoot "tools\build-sb-import.ps1") | Out-Null
    $bundle = Join-Path $repoRoot "streamerbot\loadout-import.sb.txt"
    if (-not (Test-Path $bundle)) { Fail "Bundle not produced"; exit 1 }
    Ok "loadout-import.sb.txt regenerated ($((Get-Item $bundle).Length) bytes)"
}

# ── 8. Install DLL into local Streamer.bot ────────────────────────────────
if ($SkipInstall -or $Check) {
    Step "Skipping local install"
} elseif (-not (Test-Path $SbPath)) {
    Warn "Streamer.bot not found at $SbPath - skipping local install"
    Warn "Pass -SbPath '<your path>' if it lives elsewhere"
} else {
    Step "Installing DLL into local Streamer.bot"
    $dataDir = Join-Path $SbPath "data\Loadout"
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
    $dll = Join-Path $repoRoot "src\Loadout.Core\bin\Release\net48\Loadout.dll"
    $nj  = Join-Path $repoRoot "src\Loadout.Core\bin\Release\net48\Newtonsoft.Json.dll"

    # If SB is running it will have the DLL locked - stage as .new for the
    # boot action's stage-and-swap on next SB launch.
    try {
        Copy-Item $dll (Join-Path $dataDir "Loadout.dll") -Force -ErrorAction Stop
        Copy-Item $nj  (Join-Path $dataDir "Newtonsoft.Json.dll") -Force -ErrorAction Stop
        Ok "DLL live-overwritten (SB not currently running)"
    } catch {
        Copy-Item $dll (Join-Path $dataDir "Loadout.dll.new") -Force
        Copy-Item $nj  (Join-Path $dataDir "Newtonsoft.Json.dll.new") -Force
        Ok "DLL staged at Loadout.dll.new (SB will swap on next start)"
    }
}

# ── 9. Final next-steps ───────────────────────────────────────────────────
Step "Done - what to do next"
Write-Host @"

  1. Open Streamer.bot.
  2. (First time only) Click Import top-right and paste:
       $repoRoot\streamerbot\loadout-import.sb.txt
  3. Right-click 'Loadout: Boot' and Run Now.
     (If SB was already running and we staged a .new file above, restart
      SB instead so it picks up the swap.)
  4. The onboarding wizard should open. Pick what you want enabled.

  Tray icon: bottom-right system tray, blue/cyan 'L' badge.
              Double-click to open Settings.

  Logs:       $env:APPDATA\Loadout\loadout-errors.log  (only if something throws)
  Settings:   $env:APPDATA\Loadout\settings.json
  Bus secret: $env:APPDATA\Aquilo\bus-secret.txt        (used by overlays)

  Re-run this script any time to rebuild + reinstall.

"@ -ForegroundColor White
