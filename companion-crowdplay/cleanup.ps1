#requires -Version 5.1
<#
.SYNOPSIS
    Force-kill any orphan CrowdPlay engine + companion processes.

.DESCRIPTION
    Self-elevates (UAC prompt) so it can reach Node processes running in
    Session 0 / Services. Walks every Node + companion process on the box,
    keeps only the ones whose command line doesn't reference CrowdPlay,
    and terminates the rest. Reports each kill + verifies the engine ports
    (8787/8788/8789) are free at the end.

    Right-click cleanup.ps1 -> Run with PowerShell. (UAC will pop up; accept.)
#>

# ── self-elevate ────────────────────────────────────────────────────
$current = [Security.Principal.WindowsPrincipal]::new(
    [Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $current.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "[cleanup] re-launching with admin..." -ForegroundColor Yellow
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName  = (Get-Process -Id $PID).Path
    $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    $psi.Verb      = "RunAs"
    try {
        [System.Diagnostics.Process]::Start($psi) | Out-Null
    } catch {
        Write-Host "[cleanup] elevation denied; cannot proceed." -ForegroundColor Red
        Start-Sleep -Seconds 4
        exit 1
    }
    exit 0
}

Write-Host "[cleanup] running as admin." -ForegroundColor Green
Write-Host ""

# ── identify CrowdPlay processes ────────────────────────────────────
function Get-CrowdPlayProcesses {
    $hits = @()
    # node + node20 (NVM-style installs), plus the companion exe itself
    foreach ($name in @('node','node20','aquilo-crowdplay-companion')) {
        Get-CimInstance Win32_Process -Filter "Name='$name.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
            $cmd = $_.CommandLine
            # Companion + any Node whose command line points at our engine.
            if ($name -eq 'aquilo-crowdplay-companion' -or
                ($cmd -and ($cmd -match 'aquilo-crowdplay' -or $cmd -match 'AquiloCrowdPlay'))) {
                $hits += [PSCustomObject]@{
                    Pid     = $_.ProcessId
                    Name    = $_.Name
                    Cmd     = $cmd
                }
            }
        }
    }
    return $hits
}

$found = Get-CrowdPlayProcesses
if (-not $found) {
    Write-Host "[cleanup] no CrowdPlay processes found - nothing to do." -ForegroundColor Green
} else {
    Write-Host "[cleanup] found $($found.Count) CrowdPlay process(es):" -ForegroundColor Cyan
    foreach ($p in $found) {
        $cmd = if ($p.Cmd) { $p.Cmd.Substring(0,[Math]::Min(80,$p.Cmd.Length)) + '...' } else { '<no cmd>' }
        "  PID $($p.Pid)  $($p.Name)  $cmd"
    }
    Write-Host ""
    foreach ($p in $found) {
        try {
            Stop-Process -Id $p.Pid -Force -ErrorAction Stop
            Write-Host "  killed PID $($p.Pid) ($($p.Name))" -ForegroundColor Green
        } catch {
            Write-Host "  FAILED to kill PID $($p.Pid): $($_.Exception.Message)" -ForegroundColor Red
        }
    }
}

Start-Sleep -Milliseconds 750

# ── verify ports ────────────────────────────────────────────────────
Write-Host ""
Write-Host "=== Port check ==="
$any = $false
foreach ($port in 8787,8788,8789) {
    $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($c) {
        $pids = ($c | Select-Object -ExpandProperty OwningProcess -Unique) -join ','
        Write-Host "  port $port STILL HELD by PID $pids" -ForegroundColor Yellow
        $any = $true
    } else {
        Write-Host "  port $port free" -ForegroundColor Green
    }
}

Write-Host ""
if ($any) {
    Write-Host "[cleanup] some ports are still held - another app is using them." -ForegroundColor Yellow
    Write-Host "[cleanup] check Task Manager Details tab for the listed PIDs." -ForegroundColor Yellow
} else {
    Write-Host "[cleanup] all clear. You can launch the companion now." -ForegroundColor Green
}
Write-Host ""
Read-Host "Press Enter to close"
