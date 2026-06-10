# ScratchDrop - build the Streamer.bot import string (.sb / SBAE format).
#
# Sibling of build-sb-import.ps1 and follows its verified schema exactly:
#   - 4-byte "SBAE" magic, then gzip-compressed JSON
#   - top-level { meta, manifest, data:{actions,...}, version: 23 }
#   - inline C# (Execute Code) = SubAction type 99999, byteCode = base64(UTF8(source))
#   - subaction field SHAPE AND ORDER must match SB's deserializer; two
#     fields (executeCodeFromCompiled, referencedAssemblies) must NOT exist
#
# All five actions are trigger-less: the ScratchDrop overlay/dock invoke
# them over the WebSocket via DoAction with args. Streamers can also wire
# their own triggers afterwards; imports never overwrite user changes.
#
# Output:
#   streamerbot\scratchdrop-import.bundle.json   (readable)
#   streamerbot\scratchdrop-import.sb.txt        (paste into SB Import)
#   + a copy of the .sb.txt into aquilo-site\public\scratchdrop\ for download
[CmdletBinding()]
param(
    [string]$Version = "1.1.0",
    [string]$SitePublic = "C:\Users\bishe\Desktop\aquilo-site\public\scratchdrop"
)
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$outDir  = Join-Path $repoRoot "streamerbot"
$jsonOut = Join-Path $outDir "scratchdrop-import.bundle.json"
$sbOut   = Join-Path $outDir "scratchdrop-import.sb.txt"

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
        group               = "ScratchDrop"
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
# versions (Kick send, VIP grant, websocket broadcast) so the import works
# everywhere and degrades to a chat note instead of throwing.
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

$CS_VIP = @'
using System;
using System.Reflection;

public class CPHInline
{
    public bool Execute()
    {
        string user;
        if (!CPH.TryGetArg("user", out user) || string.IsNullOrWhiteSpace(user)) return true;
        bool granted = false;
        try
        {
            MethodInfo m = CPH.GetType().GetMethod("TwitchAddVip", new Type[] { typeof(string) });
            if (m != null) { m.Invoke(CPH, new object[] { user }); granted = true; }
        }
        catch (Exception) {}
        try
        {
            if (granted) CPH.SendMessage("ScratchDrop: " + user + " is now a VIP!", true);
            else CPH.SendMessage("ScratchDrop: " + user + " won VIP - mods, grant it when you can!", true);
        }
        catch (Exception) {}
        return true;
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
        // Either pass soundPath as an action argument, or edit the
        // fallback below to a .wav/.mp3 on this PC.
        string fallback = @"";
        string path;
        if (!CPH.TryGetArg("soundPath", out path) || string.IsNullOrWhiteSpace(path)) path = fallback;
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            CPH.LogInfo("ScratchDrop - Play Sound: no soundPath arg and no fallback set; edit this action.");
            return true;
        }
        try { CPH.PlaySound(path, 1f, true); } catch (Exception) { try { CPH.PlaySound(path); } catch (Exception) {} }
        return true;
    }
}
'@

$CS_WEBHOOK = @'
using System;
using System.Net;
using System.Text;

public class CPHInline
{
    public bool Execute()
    {
        // Either pass webhookUrl as an action argument, or paste your
        // Discord webhook URL into the fallback below.
        string fallback = @"";
        string url;
        if (!CPH.TryGetArg("webhookUrl", out url) || string.IsNullOrWhiteSpace(url)) url = fallback;
        string msg;
        CPH.TryGetArg("message", out msg);
        if (string.IsNullOrWhiteSpace(url) || string.IsNullOrWhiteSpace(msg))
        {
            CPH.LogInfo("ScratchDrop - Discord Webhook: set webhookUrl (arg or fallback) and message.");
            return true;
        }
        try
        {
            string esc = msg.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n").Replace("\r", "");
            string body = "{\"content\":\"" + esc + "\"}";
            using (WebClient wc = new WebClient())
            {
                wc.Headers[HttpRequestHeader.ContentType] = "application/json";
                wc.Encoding = Encoding.UTF8;
                wc.UploadString(url, "POST", body);
            }
        }
        catch (Exception ex) { CPH.LogInfo("ScratchDrop webhook failed: " + ex.Message); }
        return true;
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
        // The dock invokes this with sdRelay = a JSON command string.
        // Broadcasting {"scratchdrop": <cmd>} over the SB websocket lets
        // the overlay receive dock commands even when the dock runs in a
        // different browser profile than OBS.
        string payload;
        if (!CPH.TryGetArg("sdRelay", out payload) || string.IsNullOrWhiteSpace(payload)) return true;
        string frame = "{\"scratchdrop\":" + payload + "}";
        if (Broadcast("WebsocketBroadcastJson", frame)) return true;
        if (Broadcast("WebsocketBroadcastString", frame)) return true;
        CPH.LogInfo("ScratchDrop - Relay: no websocket broadcast method on this SB build.");
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

$CS_GETEMOTES = @'
using System;
using System.Net;
using System.Reflection;
using System.Text;

public class CPHInline
{
    // Fetches this channel's native Twitch emotes (subscriber, follower,
    // bits-tier) from Helix using Streamer.bot's OWN broadcaster auth,
    // then broadcasts the raw Helix JSON back over the websocket as a
    // {"scratchdrop":{"kind":"emotes",...}} frame. The ScratchDrop
    // customizer invokes this and listens for the frame; no ScratchDrop
    // server is involved and the token never leaves this PC.
    public bool Execute()
    {
        string nonce; CPH.TryGetArg("req", out nonce);
        string bid; CPH.TryGetArg("broadcasterId", out bid);
        string clientId = GetProp("TwitchClientId");
        string token = GetProp("TwitchOAuthToken");
        if (string.IsNullOrWhiteSpace(bid)) bid = GetProp("TwitchBroadcasterId");
        if (string.IsNullOrWhiteSpace(clientId) || string.IsNullOrWhiteSpace(token) || string.IsNullOrWhiteSpace(bid))
        {
            Broadcast("{\"scratchdrop\":{\"kind\":\"emotes\",\"req\":\"" + J(nonce) + "\",\"error\":\"no-twitch-auth\"}}");
            return true;
        }
        try
        {
            ServicePointManager.SecurityProtocol = ServicePointManager.SecurityProtocol | SecurityProtocolType.Tls12;
            using (WebClient wc = new WebClient())
            {
                wc.Headers["Client-Id"] = clientId;
                wc.Headers["Authorization"] = "Bearer " + token;
                wc.Encoding = Encoding.UTF8;
                string json = wc.DownloadString("https://api.twitch.tv/helix/chat/emotes?broadcaster_id=" + Uri.EscapeDataString(bid));
                Broadcast("{\"scratchdrop\":{\"kind\":\"emotes\",\"req\":\"" + J(nonce) + "\",\"helix\":" + json + "}}");
            }
        }
        catch (Exception ex)
        {
            Broadcast("{\"scratchdrop\":{\"kind\":\"emotes\",\"req\":\"" + J(nonce) + "\",\"error\":\"" + J(ex.Message) + "\"}}");
        }
        return true;
    }

    private string GetProp(string name)
    {
        try
        {
            PropertyInfo p = CPH.GetType().GetProperty(name);
            if (p != null)
            {
                object v = p.GetValue(CPH, null);
                if (v != null) return v.ToString();
            }
        }
        catch (Exception) {}
        return "";
    }

    private void Broadcast(string frame)
    {
        try
        {
            MethodInfo m = CPH.GetType().GetMethod("WebsocketBroadcastJson", new Type[] { typeof(string) });
            if (m == null) m = CPH.GetType().GetMethod("WebsocketBroadcastString", new Type[] { typeof(string) });
            if (m != null) m.Invoke(CPH, new object[] { frame });
        }
        catch (Exception) {}
    }

    private string J(string s)
    {
        return (s == null ? "" : s).Replace("\\", "\\\\").Replace("\"", "\\\"");
    }
}
'@

# ------------------------------------------------------------------------------
# Bundle
# ------------------------------------------------------------------------------
$actions = @(
    (New-InlineCSharpAction -Name "ScratchDrop · Announce" -Code $CS_ANNOUNCE `
        -Description "Sends {message} to Twitch / YouTube / Kick chat. Invoked by the ScratchDrop overlay for ticket announcements."),
    (New-InlineCSharpAction -Name "ScratchDrop · Award VIP" -Code $CS_VIP `
        -Description "Grants Twitch VIP to {user} (falls back to a mod call-out in chat). Point a prize's action at this."),
    (New-InlineCSharpAction -Name "ScratchDrop · Play Sound" -Code $CS_SOUND `
        -Description "Plays {soundPath} or the fallback path inside the code. Point a prize's action at this."),
    (New-InlineCSharpAction -Name "ScratchDrop · Discord Webhook" -Code $CS_WEBHOOK `
        -Description "Posts {message} to a Discord webhook ({webhookUrl} arg or the fallback inside the code)."),
    (New-InlineCSharpAction -Name "ScratchDrop · Relay" -Code $CS_RELAY `
        -Description "Rebroadcasts dock commands to the overlay over the SB websocket. Leave as-is; ScratchDrop invokes it."),
    (New-InlineCSharpAction -Name "ScratchDrop · Get Emotes" -Code $CS_GETEMOTES `
        -Description "Sends this channel's native Twitch emotes (sub/follower/bits) to the ScratchDrop customizer, fetched with your own Twitch auth. Leave as-is; ScratchDrop invokes it.")
)

$manifest = [ordered]@{
    product        = "ScratchDrop"
    packageVersion = $Version
    group          = "ScratchDrop"
    generatedBy    = "tools/build-scratchdrop-import.ps1"
    actionCount    = $actions.Count
    actions        = @($actions | ForEach-Object { $_.name })
    commands       = @()
    includes       = @("announce", "award-vip", "play-sound", "discord-webhook", "relay", "get-emotes")
}

$bundle = [ordered]@{
    meta = [ordered]@{
        name           = "ScratchDrop"
        author         = "aquilo.gg"
        version        = $Version
        description    = "Scratch-off tickets on stream. Prewired actions for announcements, prizes and the dock relay. Free forever at aquilo.gg/scratchdrop"
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
    Copy-Item $sbOut (Join-Path $SitePublic "scratchdrop-import.sb.txt") -Force
    Write-Host "Copied to site: $SitePublic\scratchdrop-import.sb.txt"
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
