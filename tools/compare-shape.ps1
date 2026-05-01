# Compare the shape of our generated bundle against a known-good SB export.
# Reports fields present in one but not the other.
[CmdletBinding()]
param(
    [string]$Mine     = (Join-Path $PSScriptRoot "verify-roundtrip.json"),
    [string]$Theirs   = (Join-Path $PSScriptRoot "decoded-sb-export.json")
)
$ErrorActionPreference = "Stop"
if (-not (Test-Path $Mine))   { throw "Generated bundle not found: $Mine" }
if (-not (Test-Path $Theirs)) { throw "Reference export not found: $Theirs" }

$mine = Get-Content $Mine -Raw | ConvertFrom-Json
$theirs = Get-Content $Theirs -Raw | ConvertFrom-Json

function Diff-Fields {
    param([string]$Label, [object]$M, [object]$T)
    Write-Host ""
    Write-Host $Label -ForegroundColor Cyan
    if ($null -eq $M -or $null -eq $T) {
        Write-Host "  one side is null; skipping" -ForegroundColor Yellow
        return
    }
    $mNames = @($M.PSObject.Properties | ForEach-Object { $_.Name })
    $tNames = @($T.PSObject.Properties | ForEach-Object { $_.Name })
    $all = @($mNames + $tNames | Sort-Object -Unique)
    foreach ($n in $all) {
        $inM = $mNames -contains $n
        $inT = $tNames -contains $n
        if ($inM -and $inT) { Write-Host ("  OK  " + $n) -ForegroundColor Green }
        elseif ($inM)       { Write-Host ("  +   " + $n + "   (only MINE)") -ForegroundColor Yellow }
        else                { Write-Host ("  -   " + $n + "   (only THEIRS)") -ForegroundColor Red }
    }
}

Diff-Fields "TOP-LEVEL"   $mine             $theirs
Diff-Fields "data.*"      $mine.data        $theirs.data

$myAction    = $mine.data.actions | Select-Object -First 1
$theirAction = $theirs.data.actions | Select-Object -First 1
Diff-Fields ("ACTION (mine[0]='" + $myAction.name + "', theirs[0]='" + $theirAction.name + "')") $myAction $theirAction

$myTrigger    = $myAction.triggers | Select-Object -First 1
$theirTrigger = $theirAction.triggers | Select-Object -First 1
Diff-Fields ("TRIGGER (mine.type=" + $myTrigger.type + ", theirs.type=" + $theirTrigger.type + ")") $myTrigger $theirTrigger

# Find the inline C# subaction in each, since type 99999 is what we care about.
function Find-99999 {
    param($a)
    foreach ($s in $a.subActions) {
        if ($s.type -eq 99999) { return $s }
        if ($s.subActions) { foreach ($n in $s.subActions) { if ($n.type -eq 99999) { return $n } } }
    }
    return $null
}
$mySa    = Find-99999 $myAction
# Theirs may not have a 99999 in the first action; scan all.
$theirSa = $null
foreach ($a in $theirs.data.actions) { $theirSa = Find-99999 $a; if ($theirSa) { break } }
Diff-Fields "SUBACTION 99999 (inline C#)" $mySa $theirSa

# Commands
if ($mine.data.commands -and $theirs.data.commands -and $mine.data.commands.Count -gt 0) {
    $myCmd = $mine.data.commands | Select-Object -First 1
    if ($theirs.data.commands -and $theirs.data.commands.Count -gt 0) {
        $theirCmd = $theirs.data.commands | Select-Object -First 1
        Diff-Fields "COMMAND" $myCmd $theirCmd
    } else {
        Write-Host "(theirs has no commands; cannot diff)" -ForegroundColor Yellow
    }
}
