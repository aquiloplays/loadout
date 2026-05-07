# handoff-snapshot.ps1 — produce a current-state snapshot of the Loadout
# product so a fresh Claude session can resume work without spelunking.
#
# Where loadout-up.ps1 reports LIVE state (Worker /health, presence, DLL
# install), this script captures REPO state (commits, dirty files, recent
# edits, build artifacts, Worker deploy version) and writes it to
# ~/Desktop/loadout-session-snapshot.md — paste alongside LOADOUT-HANDOFF.md
# into a new chat for a clean pickup point.
#
# Usage:
#   .\handoff-snapshot.ps1                  # write snapshot + print summary
#   .\handoff-snapshot.ps1 -StdoutOnly      # print only, no file write
#   .\handoff-snapshot.ps1 -Days 14         # widen recent-edits window
#   .\handoff-snapshot.ps1 -Open            # open the snapshot in default editor
#
# Pair with .\loadout-up.ps1 for runtime checks.

[CmdletBinding()]
param(
    [int]$Days = 7,
    [switch]$StdoutOnly,
    [switch]$Open
)
$ErrorActionPreference = "Continue"

# ── Theme ─────────────────────────────────────────────────────────────────
function Banner($t) {
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor DarkCyan
    Write-Host "  $t" -ForegroundColor Cyan
    Write-Host "============================================================" -ForegroundColor DarkCyan
}
function Step($t) { Write-Host ""; Write-Host ">> $t" -ForegroundColor Cyan }
function Ok($t)   { Write-Host "   + $t" -ForegroundColor Green }
function Warn($t) { Write-Host "   ! $t" -ForegroundColor Yellow }
function Fail($t) { Write-Host "   x $t" -ForegroundColor Red }
function Info($t) { Write-Host "     $t" -ForegroundColor DarkGray }

# ── Paths ─────────────────────────────────────────────────────────────────
$loadoutRepo  = 'C:\Users\bishe\Desktop\Loadout'
$widgetRepo   = 'C:\Users\bishe\Desktop\aquilo-widget'
$workerFolder = Join-Path $loadoutRepo 'discord-bot'
$liveDll      = 'C:\Users\bishe\Desktop\Streamerbot\data\Loadout\Loadout.dll'
$stagedDll    = $liveDll + '.new'
$builtDll     = Join-Path $loadoutRepo 'src\Loadout.Core\bin\Release\net48\Loadout.dll'
$distZip      = Join-Path $loadoutRepo 'dist\Loadout-fourthwall.zip'
$workerUrl    = 'https://loadout-discord.aquiloplays.workers.dev'
$presenceUrl  = 'https://aquilo-presence-production.up.railway.app'
$snapshotPath = "$env:USERPROFILE\Desktop\loadout-session-snapshot.md"

$ts = Get-Date

# Buffer for the markdown file. Each Add-Md call also echoes to console so
# the script reads as a live state report while it runs.
$md = New-Object System.Collections.Generic.List[string]
function Add-Md($line) { $md.Add($line) | Out-Null }
function Add-MdHeader($h, $line) { Add-Md ""; Add-Md ("#" * $h + " " + $line) }

# ── Header ────────────────────────────────────────────────────────────────
Banner "Loadout - session snapshot"
Write-Host $ts.ToString('yyyy-MM-dd HH:mm:ss') -ForegroundColor DarkGray

Add-Md "# Loadout - session snapshot"
Add-Md ""
Add-Md ("Generated " + $ts.ToString('yyyy-MM-dd HH:mm:ss zzz') + " by ``tools/handoff-snapshot.ps1``")
Add-Md ""
Add-Md "Pair this with ``LOADOUT-HANDOFF.md`` for a fresh Claude session - the handoff doc"
Add-Md "is the architectural map; this snapshot is the current state of the work tree."

# ── Git state for each repo ───────────────────────────────────────────────
function Capture-GitState($repoPath, $label) {
    Step "$label - git state"
    if (-not (Test-Path (Join-Path $repoPath '.git'))) {
        Warn "$repoPath has no .git folder"
        Add-MdHeader 2 "$label"
        Add-Md "_(not a git repo or not present at $repoPath)_"
        return
    }

    Push-Location $repoPath
    try {
        $branch = (git rev-parse --abbrev-ref HEAD 2>$null)
        $head   = (git rev-parse --short HEAD 2>$null)
        $headFull = (git rev-parse HEAD 2>$null)
        $headMsg  = (git log -1 --pretty=format:%s 2>$null)
        $headDate = (git log -1 --pretty=format:%ai 2>$null)

        $statusLines = @(git status --porcelain 2>$null)
        $dirty = $statusLines.Count -gt 0

        $upstream = (git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>$null)
        $aheadBehind = ""
        if ($upstream) {
            $ab = (git rev-list --left-right --count "$upstream...HEAD" 2>$null)
            if ($ab -match '^(\d+)\s+(\d+)$') {
                $behind = [int]$Matches[1]; $ahead = [int]$Matches[2]
                $parts = @()
                if ($ahead -gt 0)  { $parts += "$ahead ahead" }
                if ($behind -gt 0) { $parts += "$behind behind" }
                if ($parts.Count -gt 0) { $aheadBehind = " ($($parts -join ', ') vs $upstream)" }
                else                    { $aheadBehind = " (in sync with $upstream)" }
            }
        }

        Ok "Branch: $branch @ $head$aheadBehind"
        Info "$head $headMsg"
        Info "Last commit: $headDate"

        if ($dirty) {
            Warn "$($statusLines.Count) uncommitted change(s)"
            $statusLines | Select-Object -First 8 | ForEach-Object { Info "  $_" }
            if ($statusLines.Count -gt 8) { Info "  ... and $($statusLines.Count - 8) more" }
        } else {
            Ok "Working tree clean"
        }

        Add-MdHeader 2 "$label"
        Add-Md ""
        Add-Md "- **Branch:** ``$branch`` @ ``$head``$aheadBehind"
        Add-Md ("- **HEAD:** " + $head + "  - " + $headMsg)
        Add-Md ("- **Committed:** " + $headDate)
        if ($dirty) {
            Add-Md "- **Uncommitted changes ($($statusLines.Count)):**"
            Add-Md ""
            Add-Md '```'
            $statusLines | ForEach-Object { Add-Md $_ }
            Add-Md '```'
        } else {
            Add-Md "- Working tree clean"
        }

        # Last 10 commits (compact)
        $recent = git log --oneline -n 10 2>$null
        Add-Md ""
        Add-Md "Last 10 commits:"
        Add-Md ""
        Add-Md '```'
        $recent | ForEach-Object { Add-Md $_ }
        Add-Md '```'

        # Recently modified tracked files (last $Days days)
        $since = $ts.AddDays(-$Days).ToString('yyyy-MM-dd')
        $touched = git log --since="$since" --name-only --pretty=format: 2>$null |
                    Where-Object { $_.Trim() } |
                    Sort-Object -Unique
        if ($touched -and $touched.Count -gt 0) {
            Add-Md ""
            Add-Md "Files touched since $since ($($touched.Count)):"
            Add-Md ""
            Add-Md '```'
            $touched | Select-Object -First 40 | ForEach-Object { Add-Md $_ }
            if ($touched.Count -gt 40) { Add-Md "... +$($touched.Count - 40) more" }
            Add-Md '```'
        }
    } finally {
        Pop-Location
    }
}

Capture-GitState $loadoutRepo 'Loadout repo (~/Desktop/Loadout)'
Capture-GitState $widgetRepo  'aquilo-widget repo (~/Desktop/aquilo-widget)'

# ── Build / install artifacts ─────────────────────────────────────────────
Step "Build + install artifacts"
Add-MdHeader 2 "Build + install artifacts"
Add-Md ""

function Capture-File($path, $label) {
    if (Test-Path $path) {
        $f = Get-Item $path
        $kb = [Math]::Round($f.Length / 1KB, 1)
        Ok ("${label}: ${kb} KB @ " + $f.LastWriteTime)
        Add-Md ("- **" + $label + ":** ``" + $kb + " KB`` (modified " + $f.LastWriteTime.ToString('yyyy-MM-dd HH:mm') + ")")
        Add-Md "  ``$path``"
    } else {
        Warn "${label} not found"
        Add-Md ("- **" + $label + ":** _not present_ (``" + $path + "``)")
    }
}

Capture-File $builtDll  "Built Loadout.dll (Release)"
Capture-File $liveDll   "Live Loadout.dll (Streamer.bot data)"
Capture-File $stagedDll "Staged Loadout.dll.new (will swap on next SB launch)"
Capture-File $distZip   "Fourthwall release zip"

# Settings json + Bus secret presence
$settingsPath = Join-Path $env:APPDATA 'Loadout\settings.json'
$busSecretPath = Join-Path $env:APPDATA 'Aquilo\bus-secret.txt'
Capture-File $settingsPath "settings.json (%APPDATA%\Loadout)"
if (Test-Path $busSecretPath) {
    $len = (Get-Item $busSecretPath).Length
    if ($len -gt 0) { Ok "Bus secret: present ($len bytes)" }
    else            { Warn "Bus secret: empty file" }
    Add-Md "- **Aquilo Bus secret:** present ($len bytes) at ``$busSecretPath``"
} else {
    Warn "Bus secret missing"
    Add-Md "- **Aquilo Bus secret:** _missing_ - overlays can't connect until SB boots Loadout once"
}

# ── Worker / presence health ──────────────────────────────────────────────
Step "Worker + presence health"
Add-MdHeader 2 "Live infrastructure"
Add-Md ""

function Probe-Url($url, $label, $expectMatch = $null) {
    try {
        $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 8 -ErrorAction Stop
        $body = $r.Content.Trim()
        $match = if ($expectMatch) { $body -match $expectMatch } else { $true }
        if ($r.StatusCode -eq 200 -and $match) {
            Ok ("${label} -> 200 (" + ($body.Substring(0, [Math]::Min(80, $body.Length))) + ")")
            Add-Md ("- **" + $label + ":** ``200`` - ``" + $body + "``")
        } elseif ($r.StatusCode -eq 200) {
            Warn "${label} -> 200 (unexpected body)"
            Add-Md ("- **" + $label + ":** ``200`` (unexpected body: ``" + $body + "``)")
        } else {
            Warn "${label} -> $($r.StatusCode)"
            Add-Md ("- **" + $label + ":** ``" + $r.StatusCode + "``")
        }
    } catch {
        $msg = $_.Exception.Message.Split([char]10)[0]
        Fail "${label} unreachable: $msg"
        Add-Md ("- **" + $label + ":** _unreachable_ - ``" + $msg + "``")
    }
}

Probe-Url ($workerUrl + '/health')   "Worker /health"   'loadout-discord ok'
Probe-Url ($presenceUrl + '/health') "Presence /health"

# /interactions should return 401 for an unsigned PING (proves Ed25519 is on)
try {
    $r = Invoke-WebRequest -Uri ($workerUrl + '/interactions') -Method POST `
            -Body '{"type":1}' -ContentType 'application/json' `
            -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
    Warn "Worker /interactions -> $($r.StatusCode) (expected 401)"
    Add-Md "- **Worker /interactions:** ``$($r.StatusCode)`` (expected 401)"
} catch {
    $code = $_.Exception.Response.StatusCode.value__
    if ($code -eq 401) {
        Ok "Worker /interactions -> 401 (Ed25519 verification active)"
        Add-Md "- **Worker /interactions:** ``401`` (Ed25519 verification active)"
    } else {
        Warn "Worker /interactions -> $code (unexpected)"
        Add-Md "- **Worker /interactions:** ``$code`` (unexpected)"
    }
}

# ── Worker deploy info ────────────────────────────────────────────────────
Step "Worker deploy state"
if (Test-Path (Join-Path $workerFolder 'wrangler.toml')) {
    $cfg = Get-Content (Join-Path $workerFolder 'wrangler.toml') -Raw
    $name = if ($cfg -match 'name\s*=\s*"([^"]+)"') { $Matches[1] } else { "?" }
    $compat = if ($cfg -match 'compatibility_date\s*=\s*"([^"]+)"') { $Matches[1] } else { "?" }
    Ok "wrangler.toml: $name (compat $compat)"
    Add-Md "- **wrangler.toml:** ``$name`` (compatibility_date ``$compat``)"
} else {
    Warn "wrangler.toml not found in $workerFolder"
    Add-Md "- **wrangler.toml:** not found"
}

# ── Active issues from LOADOUT-HANDOFF.md ─────────────────────────────────
Step "Active issues (from LOADOUT-HANDOFF.md)"
$handoffDoc = "$env:USERPROFILE\Desktop\LOADOUT-HANDOFF.md"
if (Test-Path $handoffDoc) {
    $lines = Get-Content $handoffDoc
    $start = -1; $end = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($start -lt 0 -and $lines[$i] -match '^##\s*.*Active issues') { $start = $i; continue }
        if ($start -ge 0 -and $i -gt $start -and $lines[$i] -match '^##\s+') { $end = $i; break }
    }
    if ($start -ge 0) {
        $section = $lines[$start..($end - 1)] -join "`n"
        Info "extracted Active issues section ($($end - $start) lines)"
        Add-MdHeader 2 "Active issues (snapshot from LOADOUT-HANDOFF.md)"
        Add-Md ""
        $lines[($start + 1)..($end - 1)] | ForEach-Object { Add-Md $_ }
    } else {
        Warn "Couldn't locate Active issues section in $handoffDoc"
    }
} else {
    Warn "LOADOUT-HANDOFF.md not found at $handoffDoc"
}

# ── Queued for next session ───────────────────────────────────────────────
# Prioritised punch-list the user has already asked for but hasn't shipped
# yet. Edit this list as items get queued / completed across sessions —
# every snapshot regenerates from this single source of truth so the
# next Claude reads the latest queue.
$queuedItems = @(
    @{
        Title  = "3D-style dice on the dice-roll overlay"
        Detail = "Replace the flat 2D die in /overlays/minigames/ with a CSS / SVG 3D-cube " +
                 "render that tumbles between faces during the roll. Should land on the rolled " +
                 "value matching the bus payload's d.rolled. Same delay budget as today (~1.4s " +
                 "settle). Goal: the die READS as actually rolling rather than a flat number " +
                 "wiggling. Files: aquilo-gg/overlays/minigames/{index.html,style.css,main.js} " +
                 "(showDie function around line 119)."
    },
    @{
        Title  = "3D-style coin on the coinflip overlay"
        Detail = "Same overhaul for the coinflip visual: a CSS-3D rotateY flip on a two-faced " +
                 "disc, lands heads / tails per d.result. Currently the coin is a static H/T " +
                 "label that fades; want a 3D flip animation that lasts ~1.4s and ends with " +
                 "the correct face up. Files: showCoin around line 111."
    },
    @{
        Title  = "Minigame chat replies are now throttled + tightened (DONE)"
        Detail = "Replies now go through a global throttle (Bolts.GameReplyMinIntervalSec, " +
                 "default 4s) so a flood of !slots / !coinflip drops to one reply per window. " +
                 "Default templates were also slimmed (no balance, compact format). Streamers " +
                 "can re-add {balance} / {wager} via Settings."
        Done   = $true
    }
)

Add-MdHeader 2 "Queued for the next session"
Add-Md ""
Add-Md ("_(Maintained in tools/handoff-snapshot.ps1. Edit the queuedItems array " +
        "to add or remove tasks; every snapshot regenerates from that single list.)_")
Add-Md ""
foreach ($q in $queuedItems) {
    if ($q.Done) {
        Add-Md ("- [x] **" + $q.Title + "** -- " + $q.Detail)
    } else {
        Add-Md ("- [ ] **" + $q.Title + "**")
        Add-Md ("  " + $q.Detail)
    }
}

# ── Bootstrap prompt for the next session ─────────────────────────────────
Add-MdHeader 2 "Bootstrap prompt for the next Claude session"
Add-Md ""
Add-Md '```'
Add-Md "I'm continuing work on the Loadout product (Streamer.bot kit + off-stream"
Add-Md "Discord bot Worker + 11 OBS overlays + composite all-in-one). Read"
Add-Md "~/Desktop/LOADOUT-HANDOFF.md for the architecture, then"
Add-Md "~/Desktop/loadout-session-snapshot.md for the current work-tree state"
Add-Md "(repo HEADs, dirty files, build artifacts, Worker health, AND the"
Add-Md "queued-for-next-session punch-list at the bottom). Run"
Add-Md "~/Desktop/loadout-up.ps1 to confirm what's actually live, then start"
Add-Md "the next queued item (or ask me if you have a question first)."
Add-Md '```'

# ── Write the file ────────────────────────────────────────────────────────
if (-not $StdoutOnly) {
    Step "Writing snapshot"
    try {
        # UTF-8 without BOM so PowerShell 5.1 + downstream tools don't choke
        $text = ($md -join "`r`n") + "`r`n"
        [System.IO.File]::WriteAllText($snapshotPath, $text, (New-Object System.Text.UTF8Encoding $false))
        $size = [Math]::Round((Get-Item $snapshotPath).Length / 1KB, 1)
        Ok "Wrote $snapshotPath (${size} KB)"
    } catch {
        Fail "Couldn't write snapshot: $($_.Exception.Message)"
    }
}

# ── Summary ───────────────────────────────────────────────────────────────
Banner "Done"
Write-Host ""
if (-not $StdoutOnly) {
    Write-Host "  Snapshot: $snapshotPath" -ForegroundColor White
}
Write-Host @"

  Next steps:
  - Paste the snapshot path + the bootstrap prompt at the bottom of the
    snapshot into a fresh Claude session.
  - Run .\loadout-up.ps1 alongside for live runtime status.
  - For a workstation rebuild, see .\handoff.ps1 (in repo root) instead.

"@ -ForegroundColor DarkGray

if ($Open -and -not $StdoutOnly -and (Test-Path $snapshotPath)) {
    Start-Process $snapshotPath
}
