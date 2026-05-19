# Loadout - build a standalone Streamer.bot import (.sb) for the
# Aquilo Check-in Relay action.
#
# The action is a 4-second timed poll of the Loadout Worker's
# /relay/pending?for=checkin endpoint; each pending check-in trigger is
# republished onto the local Aquilo Bus as a checkin.shown event so the
# OBS check-in overlay plays for panel-extension check-ins.
#
# SBAE container format + verified type numbers are documented in
# tools/build-sb-import.ps1 - this script reuses the same shapes for a
# single-action bundle so Clay can one-click import just this action.
[CmdletBinding()]
param([string]$Version = "1.0.0")
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$csPath = Join-Path $repoRoot "streamerbot\actions\aquilo-checkin-relay.cs"
$sbOut  = Join-Path $repoRoot "streamerbot\aquilo-checkin-relay.sb.txt"

if (-not (Test-Path $csPath)) { throw "C# source not found: $csPath" }
$code = Get-Content $csPath -Raw

$T_INLINE_CSHARP = 99999
$EVT_TIMED       = 701   # verified against Streamer.bot.Common EventType enum

function New-GuidStr { [guid]::NewGuid().ToString() }
function ConvertTo-Base64Utf8([string]$s) {
    return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s))
}

$actionId  = New-GuidStr
$subId     = New-GuidStr
$timerId   = New-GuidStr
$triggerId = New-GuidStr

$action = [ordered]@{
    id                 = $actionId
    queue              = "00000000-0000-0000-0000-000000000000"
    enabled            = $true
    excludeFromHistory = $false
    excludeFromPending = $false
    name               = "Aquilo Check-in Relay"
    group              = "Aquilo"
    alwaysRun          = $false
    randomAction       = $false
    concurrent         = $false
    triggers           = @(
        [ordered]@{
            id         = $triggerId
            type       = $EVT_TIMED
            enabled    = $true
            exclusions = @()
            timerId    = $timerId
        }
    )
    subActions         = @(
        [ordered]@{
            name                 = "Aquilo Check-in Relay"
            description          = "Polls /relay/pending?for=checkin; republishes checkin.shown on the Aquilo Bus."
            references           = @(
                'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\mscorlib.dll',
                'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.dll'
            )
            byteCode             = (ConvertTo-Base64Utf8 $code)
            precompile           = $false
            delayStart           = $false
            saveResultToVariable = $false
            saveToVariable       = ""
            id                   = $subId
            weight               = 0.0
            type                 = $T_INLINE_CSHARP
            parentId             = $null
            enabled              = $true
            index                = 0
        }
    )
    collapsedGroups    = @()
}

# interval is in SECONDS (verified: build-sb-import.ps1's Tick uses
# interval=60 for its documented "60-second tick"). 4s poll cadence.
$bundle = [ordered]@{
    meta = [ordered]@{
        name           = "Aquilo Check-in Relay"
        author         = "aquiloplays"
        version        = $Version
        description    = "4s poll of the Loadout relay; republishes check-ins onto the Aquilo Bus."
        autoRunAction  = $null
        minimumVersion = $null
    }
    data = [ordered]@{
        actions          = @($action)
        queues           = @()
        commands         = @()
        websocketServers = @()
        websocketClients = @()
        timers           = @(
            [ordered]@{
                id             = $timerId
                name           = "Aquilo Check-in Relay (4s)"
                enabled        = $true
                repeat         = $true
                interval       = 4
                randomInterval = $false
                upperInterval  = 0
                lines          = 0
                counter        = 0
            }
        )
    }
    version        = 23
    exportedFrom   = "1.0.4"
    minimumVersion = "1.0.0-alpha.1"
}

$json = $bundle | ConvertTo-Json -Depth 50
$jsonBytes = [Text.Encoding]::UTF8.GetBytes($json)
$gzMs = New-Object IO.MemoryStream
$gz = New-Object IO.Compression.GZipStream($gzMs, [IO.Compression.CompressionLevel]::Optimal, $true)
$gz.Write($jsonBytes, 0, $jsonBytes.Length)
$gz.Close()
$gzBytes = $gzMs.ToArray()

$header = [Text.Encoding]::ASCII.GetBytes("SBAE")
$final = New-Object byte[] ($header.Length + $gzBytes.Length)
[Array]::Copy($header, 0, $final, 0, $header.Length)
[Array]::Copy($gzBytes, 0, $final, $header.Length, $gzBytes.Length)

$b64 = [Convert]::ToBase64String($final)
Set-Content -Path $sbOut -Value $b64 -Encoding ascii -NoNewline
Write-Host "Import string written"
Write-Host "  path: $sbOut"
Write-Host "  size: $($b64.Length) chars / $($final.Length) raw bytes"
