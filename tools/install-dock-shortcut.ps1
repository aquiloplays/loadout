# Loadout — dock / taskbar shortcut installer.
#
# Creates a single-click "Loadout" shortcut that launches Streamer.bot
# (which then auto-boots Loadout via the Loadout: Boot action). The
# shortcut shows the Loadout icon, so when the user pins it to the
# Windows taskbar / Start menu it reads as a real "Loadout" app.
#
# Usage:
#   .\tools\install-dock-shortcut.ps1                        # Desktop + Start
#   .\tools\install-dock-shortcut.ps1 -PinToTaskbar          # also auto-pin (Win 10)
#   .\tools\install-dock-shortcut.ps1 -SbPath "C:\path\..."  # explicit SB.exe
#
# Notes:
#   * Windows 11 removed the COM verb that programmatically pins to the
#     taskbar. On Win 11 the script falls back to opening the folder
#     with the new .lnk selected so the user can right-click -> "Pin to
#     taskbar" in one extra step. The script always prints this
#     instruction explicitly.
[CmdletBinding()]
param(
    [string]$SbPath        = "",
    [switch]$PinToTaskbar,
    [switch]$NoStartMenu
)
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Find-StreamerBot {
    param([string]$Hint)
    $candidates = @()
    if ($Hint) { $candidates += $Hint }
    $candidates += @(
        "$env:USERPROFILE\Desktop\Streamerbot\Streamer.bot.exe",
        "$env:USERPROFILE\Desktop\Streamer.bot\Streamer.bot.exe",
        "$env:LOCALAPPDATA\Streamer.bot\Streamer.bot.exe",
        "C:\Streamer.bot\Streamer.bot.exe",
        "D:\Streamer.bot\Streamer.bot.exe"
    )
    foreach ($p in $candidates) {
        if ($p -and (Test-Path $p)) { return (Resolve-Path $p).Path }
    }
    # Last resort: scan common drives for Streamer.bot.exe under depth 4.
    foreach ($drive in @("C:\", "D:\")) {
        if (-not (Test-Path $drive)) { continue }
        $hits = Get-ChildItem -Path $drive -Filter "Streamer.bot.exe" -Recurse -ErrorAction SilentlyContinue -Depth 4 | Select-Object -First 1
        if ($hits) { return $hits.FullName }
    }
    return $null
}

# 1. Locate Streamer.bot.exe ─────────────────────────────────────────────
$sbExe = Find-StreamerBot -Hint $SbPath
if (-not $sbExe) {
    Write-Host "Streamer.bot.exe not found. Pass -SbPath 'C:\full\path\Streamer.bot.exe'." -ForegroundColor Red
    exit 1
}
Write-Host "Streamer.bot found at: $sbExe" -ForegroundColor Green

# 2. Locate the Loadout icon ─────────────────────────────────────────────
$icon = Join-Path $repoRoot "assets\Loadout.ico"
if (-not (Test-Path $icon)) {
    Write-Host "Loadout.ico missing at $icon" -ForegroundColor Red
    exit 1
}

# 3. Build the .lnk file ─────────────────────────────────────────────────
function New-LoadoutShortcut {
    param([string]$LnkPath)
    $dir = Split-Path $LnkPath -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($LnkPath)
    $lnk.TargetPath       = $sbExe
    $lnk.WorkingDirectory = Split-Path $sbExe -Parent
    $lnk.IconLocation     = "$icon,0"
    $lnk.Description      = "Loadout — Streamer.bot suite. Launches Streamer.bot which auto-boots Loadout."
    $lnk.WindowStyle      = 1
    $lnk.Save()
    # Mark as a "Loadout" target so the taskbar groups it under one icon.
    Write-Host "  -> $LnkPath" -ForegroundColor Gray
}

$desktop  = [Environment]::GetFolderPath('Desktop')
$startDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$desktopLnk = Join-Path $desktop 'Loadout.lnk'
$startLnk   = Join-Path $startDir 'Loadout.lnk'

Write-Host "Creating shortcuts..." -ForegroundColor Cyan
New-LoadoutShortcut -LnkPath $desktopLnk
if (-not $NoStartMenu) { New-LoadoutShortcut -LnkPath $startLnk }

# 4. Pin to taskbar (best-effort) ────────────────────────────────────────
$winBuild = try { [int](Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').CurrentBuild } catch { 0 }
$isWin11 = $winBuild -ge 22000

if ($PinToTaskbar) {
    if ($isWin11) {
        Write-Host ""
        Write-Host "Windows 11 detected. Microsoft removed the programmatic Pin-to-Taskbar verb." -ForegroundColor Yellow
        Write-Host "Right-click Loadout.lnk on your Desktop and choose 'Pin to taskbar'." -ForegroundColor Yellow
        try { Start-Process explorer.exe "/select,`"$desktopLnk`"" } catch {}
    } else {
        try {
            $sh = New-Object -ComObject Shell.Application
            $folder = $sh.Namespace((Split-Path $desktopLnk -Parent))
            $item = $folder.ParseName((Split-Path $desktopLnk -Leaf))
            $verb = $item.Verbs() | Where-Object { $_.Name -match 'Pin to tas[kc]bar' }
            if ($verb) { $verb.DoIt(); Write-Host "Pinned to taskbar." -ForegroundColor Green }
            else       { Write-Host "Pin verb not available; right-click the Desktop shortcut to pin manually." -ForegroundColor Yellow }
        } catch {
            Write-Host "Pin attempt failed: $_" -ForegroundColor Yellow
        }
    }
}

# 5. Final guidance ──────────────────────────────────────────────────────
Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "Single-click 'Loadout' on the Desktop (or Start menu) to launch Streamer.bot + Loadout." -ForegroundColor Gray
if (-not $PinToTaskbar) {
    Write-Host "To pin to the taskbar: right-click Loadout.lnk on the Desktop -> Pin to taskbar." -ForegroundColor Gray
}
