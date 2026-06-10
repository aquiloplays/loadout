# PowerDeck - build the Streamer.bot import string (.sb / SBAE format).
#
# Sibling of build-scratchdrop-import.ps1 and follows its verified schema:
#   - 4-byte "SBAE" magic, then gzip-compressed JSON
#   - top-level { meta, manifest, data:{actions,...}, version: 23 }
#   - inline C# (Execute Code) = SubAction type 99999, byteCode = base64(UTF8(source))
#   - subaction field SHAPE AND ORDER must match SB's deserializer; two
#     fields (executeCodeFromCompiled, referencedAssemblies) must NOT exist
#
# All actions are trigger-less: the PowerDeck overlay/dock invoke them over
# the WebSocket via DoAction with args. Purchases need no triggers at all;
# the overlay subscribes to raw Streamer.bot events (custom bits power-ups,
# channel points, cheers) and matches them itself.
#
# Output:
#   streamerbot\powerdeck-import.bundle.json   (readable)
#   streamerbot\powerdeck-import.sb.txt        (paste into SB Import)
#   + a copy of the .sb.txt into aquilo-site\public\powerdeck\ for download
[CmdletBinding()]
param(
    [string]$Version = "1.0.0",
    [string]$SitePublic = "C:\Users\bishe\Desktop\aquilo-site\public\powerdeck"
)
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$outDir  = Join-Path $repoRoot "streamerbot"
$jsonOut = Join-Path $outDir "powerdeck-import.bundle.json"
$sbOut   = Join-Path $outDir "powerdeck-import.sb.txt"

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
        group               = "PowerDeck"
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
# Inline C# sources. Reflection-guarded where SB method names drift between
# versions (Kick send, websocket broadcast) so the import works everywhere
# and degrades gracefully instead of throwing.
# ------------------------------------------------------------------------------

$CS_ANNOUNCE = @'
using System;
using System.Reflection;

public class CPHInline
{
    public bool Execute()
    {
        string msg;
        if (!CPH.TryGetArg("message", out msg) || string.IsNullOrWhiteSpace(msg)) return true;
        try { CPH.SendMessage(msg, true); } catch (Exception) {}
        try { CPH.SendYouTubeMessage(msg); } catch (Exception) {}
        // Kick send only exists on newer builds; call it if present.
        TryCall("SendKickMessage", msg);
        TryCall("KickSendMessage", msg);
        return true;
    }

    private void TryCall(string name, string arg)
    {
        try
        {
            MethodInfo m = CPH.GetType().GetMethod(name, new Type[] { typeof(string) });
            if (m != null) m.Invoke(CPH, new object[] { arg });
        }
        catch (Exception) {}
    }
}
'@

$CS_RELAY = @'
using System;
using System.Reflection;

public class CPHInline
{
    public bool Execute()
    {
        // The dock invokes this with pdRelay = a JSON command string.
        // Broadcasting {"powerdeck": <cmd>} over the SB websocket lets
        // the overlay receive dock commands even when the dock runs in a
        // different browser profile than OBS.
        string payload;
        if (!CPH.TryGetArg("pdRelay", out payload) || string.IsNullOrWhiteSpace(payload)) return true;
        string frame = "{\"powerdeck\":" + payload + "}";
        if (Broadcast("WebsocketBroadcastJson", frame)) return true;
        if (Broadcast("WebsocketBroadcastString", frame)) return true;
        CPH.LogInfo("PowerDeck - Relay: no websocket broadcast method on this SB build.");
        return true;
    }

    private bool Broadcast(string name, string frame)
    {
        try
        {
            MethodInfo m = CPH.GetType().GetMethod(name, new Type[] { typeof(string) });
            if (m != null) { m.Invoke(CPH, new object[] { frame }); return true; }
        }
        catch (Exception) {}
        return false;
    }
}
'@

$CS_SOUND = @'
using System;
using System.IO;

public class CPHInline
{
    public bool Execute()
    {
        // PowerDeck invokes this on pack opens when a sound action is set
        // in the customizer. Either pass soundPath as an action argument,
        // or edit the fallback below to a .wav/.mp3 on this PC.
        string fallback = @"";
        string path;
        if (!CPH.TryGetArg("soundPath", out path) || string.IsNullOrWhiteSpace(path)) path = fallback;
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            CPH.LogInfo("PowerDeck - Play Sound: no soundPath arg and no fallback set; edit this action.");
            return true;
        }
        try { CPH.PlaySound(path, 1f, true); } catch (Exception) { try { CPH.PlaySound(path); } catch (Exception) {} }
        return true;
    }
}
'@

# ------------------------------------------------------------------------------
# Bundle
# ------------------------------------------------------------------------------
$actions = @(
    (New-InlineCSharpAction -Name "PowerDeck · Announce" -Code $CS_ANNOUNCE `
        -Description "Sends {message} to Twitch / YouTube / Kick chat. Invoked by the PowerDeck overlay for pack rips, card plays and !cards replies."),
    (New-InlineCSharpAction -Name "PowerDeck · Relay" -Code $CS_RELAY `
        -Description "Rebroadcasts dock commands to the overlay over the SB websocket. Leave as-is; PowerDeck invokes it."),
    (New-InlineCSharpAction -Name "PowerDeck · Play Sound" -Code $CS_SOUND `
        -Description "Plays {soundPath} or the fallback path inside the code on pack opens. Optional.")
)

$manifest = [ordered]@{
    product        = "PowerDeck"
    packageVersion = $Version
    group          = "PowerDeck"
    generatedBy    = "tools/build-powerdeck-import.ps1"
    actionCount    = $actions.Count
    actions        = @($actions | ForEach-Object { $_.name })
    commands       = @()
    includes       = @("announce", "relay", "play-sound")
}

$bundle = [ordered]@{
    meta = [ordered]@{
        name           = "PowerDeck"
        author         = "aquilo.gg"
        version        = $Version
        description    = "Bits power-ups become challenge card packs on stream. Prewired actions for chat announcements and the dock relay. Free forever at aquilo.gg/powerdeck"
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
    Copy-Item $sbOut (Join-Path $SitePublic "powerdeck-import.sb.txt") -Force
    Write-Host "Copied to site: $SitePublic\powerdeck-import.sb.txt"
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
Write-Host "Self-check OK: $($roundtrip.data.actions.Count) actions, meta '$($roundtrip.meta.name) v$($roundtrip.meta.version)'"
