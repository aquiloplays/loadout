# Aquilo Stream Tuning script
# Run this once, then reboot. Safe to re-run. No changes to OBS or NVIDIA Control Panel.
# Right-click > "Run with PowerShell". If it asks about execution policy, paste this first:
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
# then run the script.

# Self-elevate if not admin
if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "Re-launching as administrator..."
    Start-Process powershell.exe "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
    exit
}

Write-Host ""
Write-Host "==========================================="
Write-Host "  Aquilo Stream Tuning"
Write-Host "  Targets: HAGS, Game DVR, Power Plan,"
Write-Host "          Defender exclusions"
Write-Host "==========================================="
Write-Host ""

# 1. Enable Hardware-Accelerated GPU Scheduling
Write-Host "[1/4] Enabling Hardware-Accelerated GPU Scheduling..."
$gdPath = "HKLM:\SYSTEM\CurrentControlSet\Control\GraphicsDrivers"
$current = (Get-ItemProperty -Path $gdPath -Name HwSchMode -ErrorAction SilentlyContinue).HwSchMode
if ($current -eq 2) {
    Write-Host "    Already enabled."
} else {
    Set-ItemProperty -Path $gdPath -Name HwSchMode -Value 2 -Type DWord
    Write-Host "    HAGS set to ENABLED. Takes effect after reboot."
}

# 2. Disable Game DVR (background recording)
Write-Host "[2/4] Disabling Game DVR background recording..."
$gameDvrPath1 = "HKCU:\System\GameConfigStore"
$gameDvrPath3 = "HKCU:\Software\Microsoft\Windows\CurrentVersion\GameDVR"
$gameDvrPath4 = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\GameDVR"

if (Test-Path $gameDvrPath1) {
    Set-ItemProperty -Path $gameDvrPath1 -Name GameDVR_Enabled -Value 0 -Type DWord -ErrorAction SilentlyContinue
    Set-ItemProperty -Path $gameDvrPath1 -Name GameDVR_FSEBehaviorMode -Value 2 -Type DWord -ErrorAction SilentlyContinue
    Set-ItemProperty -Path $gameDvrPath1 -Name GameDVR_HonorUserFSEBehaviorMode -Value 1 -Type DWord -ErrorAction SilentlyContinue
}
if (-not (Test-Path $gameDvrPath4)) { New-Item -Path $gameDvrPath4 -Force | Out-Null }
Set-ItemProperty -Path $gameDvrPath4 -Name AllowGameDVR -Value 0 -Type DWord
if (-not (Test-Path $gameDvrPath3)) { New-Item -Path $gameDvrPath3 -Force | Out-Null }
Set-ItemProperty -Path $gameDvrPath3 -Name AppCaptureEnabled -Value 0 -Type DWord
Write-Host "    Game DVR DISABLED."

# 3. Power plan to Ultimate Performance (creates it if not present, else High Performance)
Write-Host "[3/4] Setting power plan..."
$ultimate = powercfg /list | Select-String "Ultimate Performance"
if (-not $ultimate) {
    powercfg -duplicatescheme e9a42b02-d5df-448d-aa00-03f14749eb61 | Out-Null
    $ultimate = powercfg /list | Select-String "Ultimate Performance"
}
if ($ultimate) {
    $guid = ($ultimate.ToString() -split ":")[1].Trim().Split(" ")[0]
    powercfg /setactive $guid | Out-Null
    Write-Host "    Power plan set to Ultimate Performance."
} else {
    $hp = powercfg /list | Select-String "High performance"
    if ($hp) {
        $guid = ($hp.ToString() -split ":")[1].Trim().Split(" ")[0]
        powercfg /setactive $guid | Out-Null
        Write-Host "    Power plan set to High Performance."
    }
}

# 4. Defender exclusions for OBS + Videos folder + browser cache
Write-Host "[4/4] Adding Defender exclusions..."
$exclusions = @(
    "C:\Program Files\obs-studio",
    "C:\Users\bishe\AppData\Roaming\obs-studio",
    "C:\Users\bishe\AppData\Local\obs-studio",
    "C:\Users\bishe\Videos",
    "C:\Program Files\Streamer.bot",
    "C:\Users\bishe\AppData\Roaming\Streamer.bot"
)
foreach ($p in $exclusions) {
    try {
        Add-MpPreference -ExclusionPath $p -ErrorAction Stop
        Write-Host "    excluded: $p"
    } catch {
        Write-Host "    skipped (already excluded or path missing): $p"
    }
}
$processes = @("obs64.exe", "ffmpeg.exe", "Streamer.bot.exe")
foreach ($p in $processes) {
    try {
        Add-MpPreference -ExclusionProcess $p -ErrorAction Stop
        Write-Host "    process excluded: $p"
    } catch {
        Write-Host "    process skip: $p"
    }
}

Write-Host ""
Write-Host "==========================================="
Write-Host "  DONE."
Write-Host "  REBOOT NOW for HAGS to take effect."
Write-Host "==========================================="
Write-Host ""
Read-Host "Press Enter to close"
