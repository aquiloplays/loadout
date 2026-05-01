# Loadout - build the Streamer.bot import string (.sb / SBAE format).
#
# All trigger / subaction type numbers below are VERIFIED against
# Streamer.bot.Common.dll's Streamer.bot.Common.Events.EventType enum
# (see tools/sb-enums.txt - regenerate via tools/dump-sb-enums.ps1).
#
# Schema reverse-engineered from a real SB export (tools/decoded-sb-export.json):
#   - 4-byte "SBAE" magic, then gzip-compressed JSON
#   - Top-level: { meta, data: { actions, queues, commands, websocketServers,
#                                  websocketClients, timers }, version: 23, ... }
#
# Inline C# (Execute Code) is SubAction type 99999. byteCode is base64(UTF-8(source)).
[CmdletBinding()]
param(
    [string]$Version = "0.1.0"
)
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$actionsDir = Join-Path $repoRoot "streamerbot\actions"
$outDir = Join-Path $repoRoot "streamerbot"
$jsonOut = Join-Path $outDir "loadout-import.bundle.json"
$sbOut   = Join-Path $outDir "loadout-import.sb.txt"

# ------------------------------------------------------------------------------
# Verified type numbers
# ------------------------------------------------------------------------------
$T_INLINE_CSHARP = 99999

# Twitch
$EVT_TWITCH_FOLLOW    = 101
$EVT_TWITCH_CHEER     = 102
$EVT_TWITCH_SUB       = 103
$EVT_TWITCH_RESUB     = 104
$EVT_TWITCH_GIFTSUB   = 105
$EVT_TWITCH_GIFTBOMB  = 106
$EVT_TWITCH_RAID      = 107
$EVT_TWITCH_REWARD    = 112
$EVT_TWITCH_STREAMUPD = 118
$EVT_TWITCH_FIRSTWORD = 120
$EVT_TWITCH_BROADCAST = 122
$EVT_TWITCH_CHATMSG   = 133
$EVT_TWITCH_STREAMONLINE  = 154
$EVT_TWITCH_STREAMOFFLINE = 155
$EVT_TWITCH_UPCOMINGAD= 186
$EVT_TWITCH_AUTOREWARD= 194
$EVT_TWITCH_SUBROLLOVER = 121
# Crowd Control
$EVT_CC_SESSION_START = 20001
$EVT_CC_EFFECT_SUCCESS = 20004
$EVT_CC_EFFECT_FAILURE = 20005
$EVT_CC_COIN_EXCHANGE = 20009
# YouTube
$EVT_YT_MESSAGE       = 4003
$EVT_YT_SUPERCHAT     = 4006
$EVT_YT_SUPERSTICKER  = 4007
$EVT_YT_NEWSPONSOR    = 4008
$EVT_YT_MILESTONE     = 4009
$EVT_YT_MEMBERGIFT    = 4014
$EVT_YT_FIRSTWORDS    = 4016
$EVT_YT_NEWSUB        = 4018
# General
$EVT_COMMAND          = 401
$EVT_TIMED            = 701
$EVT_SB_STARTED       = 706
# TikFinity rides on the WebSocket Custom Server channel
$EVT_WS_CUSTOM_MSG    = 2003

# ------------------------------------------------------------------------------
function New-GuidStr { [guid]::NewGuid().ToString() }

function ConvertTo-Base64Utf8([string]$s) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($s)
    return [Convert]::ToBase64String($bytes)
}

function New-InlineCSharpAction {
    param(
        [string]$Name,
        [string]$Group,
        [string]$Code,
        [object[]]$Triggers,
        [string]$Description = ""
    )
    $id = New-GuidStr
    $subId = New-GuidStr
    return [ordered]@{
        id                  = $id
        queue               = "00000000-0000-0000-0000-000000000000"
        enabled             = $true
        excludeFromHistory  = $false
        excludeFromPending  = $false
        name                = $Name
        group               = $Group
        alwaysRun           = $false
        randomAction        = $false
        concurrent          = $false
        triggers            = @($Triggers)
        subActions          = @(
            [ordered]@{
                name                  = $Name
                description           = $Description
                references            = @(
                    'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\mscorlib.dll',
                    'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.dll',
                    'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.Core.dll',
                    'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.Net.Http.dll'
                )
                byteCode              = (ConvertTo-Base64Utf8 $Code)
                precompile            = $false
                delayStart            = 0
                saveResultToVariable  = $false
                saveToVariable        = ""
                id                    = $subId
                weight                = 0.0
                type                  = $T_INLINE_CSHARP
                parentId              = $null
                enabled               = $true
                index                 = 0
            }
        )
        collapsedGroups     = @()
    }
}

function New-Trigger {
    param([int]$Type, [hashtable]$Extra = @{})
    $base = [ordered]@{
        id        = (New-GuidStr)
        type      = $Type
        enabled   = $true
        exclusions = @()
    }
    foreach ($k in $Extra.Keys) { $base[$k] = $Extra[$k] }
    return [PSCustomObject]$base
}

function New-CommandTrigger {
    param([string]$CommandId)
    return New-Trigger -Type $EVT_COMMAND -Extra @{ commandId = $CommandId }
}

function Read-CSharp([string]$file) {
    $path = Join-Path $actionsDir $file
    if (-not (Test-Path $path)) { throw "Action file not found: $path" }
    return (Get-Content $path -Raw)
}

# ------------------------------------------------------------------------------
# Commands need their own definitions in data.commands so the trigger can
# reference them by id. Match each Command entry to a CommandTrigger.
# ------------------------------------------------------------------------------
function New-Command {
    param([string]$CommandId, [string]$Name, [string[]]$Aliases, [string]$ActionId)
    return [ordered]@{
        id           = $CommandId
        name         = $Name
        commands     = $Aliases
        actionId     = $ActionId
        enabled      = $true
        ignoreInternal = $true
        ignoreBotAccount = $false
        useBotAccount = $false
        sources      = 7        # bitmask: 1 Twitch + 2 YouTube + 4 Trovo. SB widens this on import.
        permittedUserIds = @()
        excludedUserIds = @()
        accessLevel  = 0
        permittedUsers = @()
        permittedGroups = @()
        excludedUsers = @()
        excludedGroups = @()
        cooldown     = 0
        userCooldown = 0
        groupCooldown = 0
        case         = $false
        caseSensitive = $false
        commandSourceVersion = 1
    }
}

# ------------------------------------------------------------------------------
# Build actions
# ------------------------------------------------------------------------------
$timerId = New-GuidStr
$cmdLinkId = New-GuidStr
$cmdLinkApproveId = New-GuidStr
$cmdSuiteId = New-GuidStr

$actions = @()

# Boot - runs on Streamer.bot Started
$actBoot = New-InlineCSharpAction -Name "Loadout: Boot" -Group "Loadout" `
    -Code (Read-CSharp "00-boot.cs") `
    -Triggers @( (New-Trigger -Type $EVT_SB_STARTED) ) `
    -Description "Bootstrap. Downloads Loadout.dll on first run, opens onboarding."
$actions += $actBoot

# Event trampoline - every platform event funnels here
$eventTriggers = @(
    (New-Trigger -Type $EVT_TWITCH_FOLLOW),
    (New-Trigger -Type $EVT_TWITCH_SUB),
    (New-Trigger -Type $EVT_TWITCH_RESUB),
    (New-Trigger -Type $EVT_TWITCH_GIFTSUB),
    (New-Trigger -Type $EVT_TWITCH_GIFTBOMB),
    (New-Trigger -Type $EVT_TWITCH_CHEER),
    (New-Trigger -Type $EVT_TWITCH_RAID),
    (New-Trigger -Type $EVT_TWITCH_REWARD),
    (New-Trigger -Type $EVT_TWITCH_AUTOREWARD),
    (New-Trigger -Type $EVT_TWITCH_FIRSTWORD),
    (New-Trigger -Type $EVT_TWITCH_UPCOMINGAD),
    (New-Trigger -Type $EVT_TWITCH_STREAMUPD),
    (New-Trigger -Type $EVT_TWITCH_BROADCAST),
    (New-Trigger -Type $EVT_TWITCH_STREAMONLINE),
    (New-Trigger -Type $EVT_TWITCH_STREAMOFFLINE),
    (New-Trigger -Type $EVT_YT_NEWSPONSOR),
    (New-Trigger -Type $EVT_YT_MILESTONE),
    (New-Trigger -Type $EVT_YT_MEMBERGIFT),
    (New-Trigger -Type $EVT_YT_NEWSUB),
    (New-Trigger -Type $EVT_YT_SUPERCHAT),
    (New-Trigger -Type $EVT_YT_SUPERSTICKER),
    (New-Trigger -Type $EVT_YT_FIRSTWORDS),
    (New-Trigger -Type $EVT_TWITCH_SUBROLLOVER),
    (New-Trigger -Type $EVT_CC_SESSION_START),
    (New-Trigger -Type $EVT_CC_EFFECT_SUCCESS),
    (New-Trigger -Type $EVT_CC_EFFECT_FAILURE),
    (New-Trigger -Type $EVT_CC_COIN_EXCHANGE),
    (New-Trigger -Type $EVT_WS_CUSTOM_MSG)
)
$actions += New-InlineCSharpAction -Name "Loadout: Event" -Group "Loadout" `
    -Code (Read-CSharp "01-event.cs") `
    -Triggers $eventTriggers `
    -Description "Funnel for follows, subs, raids, super chats, TikTok gifts (via custom WS)."

# Chat trampoline
$chatTriggers = @(
    (New-Trigger -Type $EVT_TWITCH_CHATMSG),
    (New-Trigger -Type $EVT_YT_MESSAGE)
)
$actions += New-InlineCSharpAction -Name "Loadout: Chat" -Group "Loadout" `
    -Code (Read-CSharp "02-chat.cs") `
    -Triggers $chatTriggers `
    -Description "Every chat message - drives welcomes, hate-raid detection, activity gate."

# Tick - every 60s timer
$actions += New-InlineCSharpAction -Name "Loadout: Tick" -Group "Loadout" `
    -Code (Read-CSharp "03-tick.cs") `
    -Triggers @( (New-Trigger -Type $EVT_TIMED -Extra @{ timerId = $timerId }) ) `
    -Description "60-second tick. Drives timed messages and hype-train decay."

# Commands - each has a Command entry plus an Action with a CommandTriggered trigger
$actLink = New-InlineCSharpAction -Name "Loadout: !link" -Group "Loadout" `
    -Code (Read-CSharp "04-cmd-link.cs") `
    -Triggers @( (New-CommandTrigger -CommandId $cmdLinkId) ) `
    -Description "!link <platform> <user> - request cross-platform identity link."
$actions += $actLink

$actLinkApprove = New-InlineCSharpAction -Name "Loadout: !linkapprove" -Group "Loadout" `
    -Code (Read-CSharp "05-cmd-linkapprove.cs") `
    -Triggers @( (New-CommandTrigger -CommandId $cmdLinkApproveId) ) `
    -Description "!linkapprove <id> - mod-only approval of a link request."
$actions += $actLinkApprove

$actSuite = New-InlineCSharpAction -Name "Loadout: !loadout" -Group "Loadout" `
    -Code (Read-CSharp "06-cmd-suite.cs") `
    -Triggers @( (New-CommandTrigger -CommandId $cmdSuiteId) ) `
    -Description "!loadout - version, !loadout settings - opens UI."
$actions += $actSuite

# Manual-run actions
$actions += New-InlineCSharpAction -Name "Open Loadout Settings" -Group "Loadout" `
    -Code (Read-CSharp "07-open-settings.cs") -Triggers @() `
    -Description "Right-click and Run Now to open the Settings window."

$actions += New-InlineCSharpAction -Name "Open Loadout Onboarding" -Group "Loadout" `
    -Code (Read-CSharp "08-open-onboarding.cs") -Triggers @() `
    -Description "Right-click and Run Now to re-open the onboarding wizard."

# ------------------------------------------------------------------------------
# Bundle
# ------------------------------------------------------------------------------
$commands = @(
    (New-Command -CommandId $cmdLinkId        -Name "!link"        -Aliases @("!link")        -ActionId $actLink.id),
    (New-Command -CommandId $cmdLinkApproveId -Name "!linkapprove" -Aliases @("!linkapprove") -ActionId $actLinkApprove.id),
    (New-Command -CommandId $cmdSuiteId       -Name "!loadout"     -Aliases @("!loadout")     -ActionId $actSuite.id)
)

$bundle = [ordered]@{
    meta = [ordered]@{
        name           = "Loadout"
        author         = "aquiloplays"
        version        = $Version
        description    = "The ultimate Streamer.bot suite. One import, everything ready."
        autoRunAction  = $null
        minimumVersion = $null
    }
    data = [ordered]@{
        actions          = $actions
        queues           = @()
        commands         = $commands
        websocketServers = @()
        websocketClients = @()
        timers = @(
            [ordered]@{
                id              = $timerId
                name            = "Loadout: Tick (60s)"
                enabled         = $true
                repeat          = $true
                interval        = 60
                randomInterval  = $false
                upperInterval   = 0
                lines           = 0
                counter         = 0
            }
        )
    }
    version        = 23
    exportedFrom   = "1.0.4"
    minimumVersion = "1.0.0-alpha.1"
}

$json = $bundle | ConvertTo-Json -Depth 50
Set-Content -Path $jsonOut -Value $json -Encoding utf8 -NoNewline
$jsonLen = $json.Length
Write-Host "Bundle JSON written"
Write-Host "  path:  $jsonOut"
Write-Host "  size:  $jsonLen chars"

# Encode SBAE wrapper.
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
$b64Len = $b64.Length
$rawLen = $final.Length
Write-Host "Import string written"
Write-Host "  path:  $sbOut"
Write-Host "  size:  $b64Len chars / $rawLen raw bytes"
Write-Host ""
Write-Host "In Streamer.bot, click Import top-right and paste the contents of $sbOut"
