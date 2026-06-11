# Hangman - build the Streamer.bot import string (.sb / SBAE format).
#
# Sibling of build-scratchdrop-import.ps1 and follows its verified schema:
#   - 4-byte "SBAE" magic, then gzip-compressed JSON
#   - top-level { meta, manifest, data:{actions,...}, version: 23 }
#   - inline C# (Execute Code) = SubAction type 99999, byteCode = base64(UTF8(source))
#
# Both actions are trigger-less: the Hangman overlay invokes them over
# the WebSocket via DoAction with args. Streamers can also wire their
# own triggers afterwards; imports never overwrite user changes.
#
# Output:
#   streamerbot\hangman-import.bundle.json   (readable)
#   streamerbot\hangman-import.sb.txt        (paste into SB Import)
#   + a copy of the .sb.txt into aquilo-site\public\hangman\ for download
[CmdletBinding()]
param(
    [string]$Version = "1.0.0",
    [string]$SitePublic = "C:\Users\bishe\Desktop\aquilo-site\public\hangman"
)
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$outDir  = Join-Path $repoRoot "streamerbot"
$jsonOut = Join-Path $outDir "hangman-import.bundle.json"
$sbOut   = Join-Path $outDir "hangman-import.sb.txt"

$T_INLINE_CSHARP = 99999

function New-GuidStr { [guid]::NewGuid().ToString() }
function ConvertTo-Base64Utf8([string]$s) {
    return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s))
}

function New-InlineCSharpAction {
    param(
        [string]$Name,
        [string]$Code,
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
        group               = "Hangman"
        alwaysRun           = $false
        randomAction        = $false
        concurrent          = $false
        triggers            = @()
        subActions          = @(
            [ordered]@{
                name                  = $Name
                description           = $Description
                references            = @(
                    'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\mscorlib.dll',
                    'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.dll'
                )
                byteCode              = (ConvertTo-Base64Utf8 $Code)
                precompile            = $false
                delayStart            = $false
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

# ------------------------------------------------------------------------------
# Inline C# sources.
# ------------------------------------------------------------------------------

$CS_TIMEOUT = @'
using System;

public class CPHInline
{
    public bool Execute()
    {
        // Invoked by the Hangman overlay when a player loses:
        //   args: user (login), userId, duration (seconds), reason
        string user;
        if (!CPH.TryGetArg("user", out user) || string.IsNullOrWhiteSpace(user)) return true;
        string durS; CPH.TryGetArg("duration", out durS);
        int dur; if (!int.TryParse(durS, out dur) || dur < 1) dur = 60;
        if (dur > 1209600) dur = 1209600; // Twitch max: 2 weeks
        string reason;
        if (!CPH.TryGetArg("reason", out reason) || string.IsNullOrWhiteSpace(reason))
            reason = "Lost a game of Hangman";

        bool ok = false;
        try { ok = CPH.TwitchTimeoutUser(user, dur, reason); }
        catch (Exception ex) { CPH.LogInfo("Hangman timeout failed: " + ex.Message); }
        if (!ok)
        {
            // Mods and the broadcaster cannot be timed out by Twitch.
            try { CPH.SendMessage("Hangman: " + user + " walks free, the gallows have no power over them.", true); }
            catch (Exception) {}
        }
        return true;
    }
}
'@

$CS_ANNOUNCE = @'
using System;

public class CPHInline
{
    public bool Execute()
    {
        // Invoked by the Hangman overlay for game start / win / lose lines.
        string msg;
        if (!CPH.TryGetArg("message", out msg) || string.IsNullOrWhiteSpace(msg)) return true;
        try { CPH.SendMessage(msg, true); } catch (Exception) {}
        return true;
    }
}
'@

# ------------------------------------------------------------------------------
# Bundle
# ------------------------------------------------------------------------------
$actions = @(
    (New-InlineCSharpAction -Name "Hangman · Timeout" -Code $CS_TIMEOUT `
        -Description "Times out {user} for {duration}s with {reason}. Invoked by the Hangman overlay when a player loses; mods and the broadcaster get a chat note instead."),
    (New-InlineCSharpAction -Name "Hangman · Announce" -Code $CS_ANNOUNCE `
        -Description "Sends {message} to Twitch chat. Invoked by the Hangman overlay for game start, win and lose announcements.")
)

$manifest = [ordered]@{
    product        = "Hangman"
    packageVersion = $Version
    group          = "Hangman"
    generatedBy    = "tools/build-hangman-import.ps1"
    actionCount    = $actions.Count
    actions        = @($actions | ForEach-Object { $_.name })
    commands       = @()
    includes       = @("timeout", "announce")
}

$bundle = [ordered]@{
    meta = [ordered]@{
        name           = "Hangman"
        author         = "aquilo.gg"
        version        = $Version
        description    = "Hangman on stream: the loser eats a chat timeout. Prewired timeout + announce actions for the overlay. Free forever at aquilo.gg/hangman"
        autoRunAction  = $null
        minimumVersion = $null
    }
    manifest = $manifest
    data = [ordered]@{
        actions          = $actions
        queues           = @()
        commands         = @()
        websocketServers = @()
        websocketClients = @()
        timers           = @()
    }
    version        = 23
    exportedFrom   = "1.0.4"
    minimumVersion = "1.0.0-alpha.1"
}

$json = $bundle | ConvertTo-Json -Depth 50
Set-Content -Path $jsonOut -Value $json -Encoding utf8 -NoNewline
Write-Host "Bundle JSON written: $jsonOut ($($json.Length) chars)"

# Encode SBAE wrapper: "SBAE" + gzip(json), then base64.
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
Write-Host "Import string written: $sbOut ($($b64.Length) chars)"

if (Test-Path $SitePublic) {
    Copy-Item $sbOut (Join-Path $SitePublic "hangman-import.sb.txt") -Force
    Write-Host "Copied to site: $SitePublic\hangman-import.sb.txt"
} else {
    Write-Warning "Site public dir not found, skipped copy: $SitePublic"
}

# Round-trip self-check: decode, gunzip, parse, verify action names.
$check = [Convert]::FromBase64String((Get-Content $sbOut -Raw))
if ([Text.Encoding]::ASCII.GetString($check, 0, 4) -ne "SBAE") { throw "Self-check failed: SBAE magic missing" }
$ms2 = New-Object IO.MemoryStream
$ms2.Write($check, 4, $check.Length - 4)
$null = $ms2.Seek(0, 'Begin')
$gz2 = New-Object IO.Compression.GZipStream($ms2, [IO.Compression.CompressionMode]::Decompress)
$rd = New-Object IO.StreamReader($gz2, [Text.Encoding]::UTF8)
$roundtrip = $rd.ReadToEnd() | ConvertFrom-Json
if ($roundtrip.data.actions.Count -ne $actions.Count) { throw "Self-check failed: action count mismatch" }
$names = @($roundtrip.data.actions | ForEach-Object { $_.name })
if ($names -notcontains "Hangman · Timeout") { throw "Self-check failed: timeout action missing" }
Write-Host "Self-check OK: $($roundtrip.data.actions.Count) actions, meta '$($roundtrip.meta.name) v$($roundtrip.meta.version)'"
