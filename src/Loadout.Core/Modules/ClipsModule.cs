using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Loadout.Bolts;
using Loadout.Bus;
using Loadout.Patreon;
using Loadout.Platforms;
using Loadout.Sb;
using Loadout.Settings;
using Loadout.Util;
using Newtonsoft.Json;

namespace Loadout.Modules
{
    /// <summary>
    /// Clip-on-demand module. Listens for the configured chat command (default
    /// !clip) and fires Streamer.bot's TwitchCreateClip via reflection. The
    /// returned URL is announced in chat (and optionally posted to a Discord
    /// webhook). Optionally awards Bolts to the clipper as a thank-you.
    ///
    /// Why this lives in a module rather than as an InfoCommands entry: clip
    /// creation needs platform-aware gating (only Twitch can create clips),
    /// per-user cooldowns measured in MINUTES not seconds, and a hook for the
    /// Bolts wallet. InfoCommands is for cheap text replies; this is heavier.
    ///
    /// Notes on Streamer.bot integration:
    ///   - CPH.TwitchClipCreate(useBotAccount, hasDelay) returns a ClipData
    ///     object with Id / EditUrl / Url depending on SB version.
    ///   - We call it via reflection (SbBridge.CreateClip) so the same DLL
    ///     works across SB versions where the method shape shifts.
    ///   - If the channel isn't currently live OR the user isn't on Twitch,
    ///     we politely refuse - no error spam.
    /// </summary>
    public sealed class ClipsModule : IEventModule
    {
        // Per-user cooldown tracking. Shared with the broadcaster's bypass
        // logic (mods/broadcaster have a separate, shorter cooldown).
        private readonly Dictionary<string, DateTime> _lastClipByUser =
            new Dictionary<string, DateTime>(StringComparer.OrdinalIgnoreCase);
        // Channel-wide cooldown (so a chat with 50 clip-spammers can't hammer
        // Twitch's clip API for 50 clips in 5 seconds).
        private DateTime _lastChannelClipUtc = DateTime.MinValue;

        // Lazy HttpClient for Discord webhook posts. Reused across calls.
        private static readonly HttpClient _http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };

        public void OnTick() { }

        public void OnEvent(EventContext ctx)
        {
            if (ctx.Kind != "chat") return;
            var s = SettingsManager.Instance.Current;
            if (!s.Modules.Clips || !s.Clips.Enabled) return;

            var msg = (ctx.Message ?? "").Trim();
            if (msg.Length < 2 || msg[0] != '!') return;

            // Match the command (case-insensitive). Anything after the first
            // space is treated as an optional clip title (some SB versions
            // accept titleHint via a second arg).
            var cfgCmd = (s.Clips.Command ?? "!clip").Trim();
            if (!cfgCmd.StartsWith("!")) cfgCmd = "!" + cfgCmd;
            var spaceIdx = msg.IndexOf(' ');
            var typed = (spaceIdx < 0 ? msg : msg.Substring(0, spaceIdx)).ToLowerInvariant();
            if (!string.Equals(typed, cfgCmd.ToLowerInvariant(), StringComparison.Ordinal)) return;

            // Only Twitch can create Twitch clips. Other platforms get a
            // single polite line if cross-platform messaging is enabled.
            if (ctx.Platform != PlatformMask.Twitch)
            {
                if (!ChatGate.TrySend(ChatGate.Area.InfoCommands, "clip:wrongplat", TimeSpan.FromSeconds(20))) return;
                new MultiPlatformSender(CphPlatformSender.Instance).Send(ctx.Platform,
                    "Clipping is Twitch-only - the streamer can clip from there 🎬", s.Platforms);
                return;
            }

            // Role gate. Default: anyone subbed/VIP/mod/broadcaster. Configurable.
            if (!RoleAllowed(ctx.UserType, s.Clips.AllowedRoles))
            {
                if (!ChatGate.TrySend(ChatGate.Area.InfoCommands, "clip:role:" + (ctx.User ?? ""), TimeSpan.FromSeconds(60))) return;
                new MultiPlatformSender(CphPlatformSender.Instance).Send(ctx.Platform,
                    "Clipping is reserved for: " + (s.Clips.AllowedRoles ?? "sub,vip,mod,broadcaster"), s.Platforms);
                return;
            }

            // Cooldowns. Mods/broadcaster get a shorter cooldown.
            var u = (ctx.UserType ?? "").ToLowerInvariant();
            var bypass = (u == "broadcaster" || u == "moderator" || u == "mod");
            var perUserCd = bypass
                ? TimeSpan.FromSeconds(Math.Max(0, s.Clips.ModCooldownSec))
                : TimeSpan.FromSeconds(Math.Max(0, s.Clips.PerUserCooldownSec));
            var channelCd = TimeSpan.FromSeconds(Math.Max(0, s.Clips.ChannelCooldownSec));

            lock (_lastClipByUser)
            {
                if (_lastClipByUser.TryGetValue(ctx.User ?? "", out var when))
                {
                    var since = DateTime.UtcNow - when;
                    if (since < perUserCd) return;
                }
                if ((DateTime.UtcNow - _lastChannelClipUtc) < channelCd) return;
                _lastChannelClipUtc = DateTime.UtcNow;
                _lastClipByUser[ctx.User ?? ""] = DateTime.UtcNow;
            }

            // Fire-and-forget; Twitch's clip API is async on their end and the
            // URL becomes available in ~3-7s. We let SbBridge handle the API
            // call via reflection, then post the URL.
            Task.Run(() => DoClip(ctx, s));
        }

        private void DoClip(EventContext ctx, LoadoutSettings s)
        {
            try
            {
                // Bus event so overlays / other tools see clip activity even
                // before the URL resolves.
                AquiloBus.Instance.Publish("clip.requested", new
                {
                    user     = ctx.User,
                    platform = ctx.Platform.ToShortName(),
                    role     = ctx.UserType,
                    ts       = DateTime.UtcNow
                });

                // Optional acknowledgement so the clipper knows we heard them.
                if (s.Clips.AckInChat && !string.IsNullOrEmpty(s.Clips.AckTemplate))
                {
                    if (ChatGate.TrySend(ChatGate.Area.InfoCommands, "clip:ack", TimeSpan.FromSeconds(2)))
                    {
                        var ack = s.Clips.AckTemplate.Replace("{user}", ctx.User ?? "");
                        new MultiPlatformSender(CphPlatformSender.Instance).Send(ctx.Platform, ack, s.Platforms);
                    }
                }

                var clipUrl = SbBridge.Instance.CreateTwitchClip(s.Clips.UseBotAccount, s.Clips.HasDelay);
                if (string.IsNullOrEmpty(clipUrl))
                {
                    if (!ChatGate.TrySend(ChatGate.Area.InfoCommands, "clip:fail", TimeSpan.FromSeconds(10))) return;
                    new MultiPlatformSender(CphPlatformSender.Instance).Send(ctx.Platform,
                        "Couldn't create that clip - is the channel live?", s.Platforms);
                    return;
                }

                // Persist the clip locally so a Stream Recap / clip browser can
                // surface it later. Lightweight: just append a JSONL line.
                ClipLog.Instance.Append(new ClipLog.Entry
                {
                    Url       = clipUrl,
                    User      = ctx.User,
                    Platform  = ctx.Platform.ToShortName(),
                    Title     = "",
                    CreatedAt = DateTime.UtcNow
                });

                // Post the URL on chat (gated).
                if (!string.IsNullOrEmpty(s.Clips.PostTemplate))
                {
                    if (ChatGate.TrySend(ChatGate.Area.InfoCommands, "clip:post", TimeSpan.FromSeconds(2)))
                    {
                        var line = s.Clips.PostTemplate
                            .Replace("{user}", ctx.User ?? "")
                            .Replace("{url}",  clipUrl);
                        new MultiPlatformSender(CphPlatformSender.Instance).Send(ctx.Platform, line, s.Platforms);
                    }
                }

                // Bolts reward (entitlement-aware: only if Bolts module is on).
                if (s.Modules.Bolts && s.Clips.AwardBolts > 0 && !string.IsNullOrEmpty(ctx.User))
                {
                    try
                    {
                        BoltsWallet.Instance.Initialize();
                        BoltsWallet.Instance.Earn(
                            ctx.Platform.ToShortName(), ctx.User,
                            s.Clips.AwardBolts, "clip:created");
                    }
                    catch (Exception ex)
                    {
                        ErrorLog.Write("ClipsModule.AwardBolts", ex);
                    }
                }

                // Discord webhook — posts the clip whenever a webhook is configured.
                if (!string.IsNullOrEmpty(s.Clips.DiscordWebhook))
                {
                    try { PostToDiscord(s.Clips.DiscordWebhook, ctx.User, clipUrl, s.Clips.DiscordTemplate); }
                    catch (Exception ex) { ErrorLog.Write("ClipsModule.PostDiscord", ex); }
                }

                AquiloBus.Instance.Publish("clip.created", new
                {
                    user     = ctx.User,
                    platform = ctx.Platform.ToShortName(),
                    url      = clipUrl,
                    ts       = DateTime.UtcNow
                });
            }
            catch (Exception ex)
            {
                ErrorLog.Write("ClipsModule.DoClip", ex);
            }
        }

        private static bool RoleAllowed(string userType, string allowedCsv)
        {
            if (string.IsNullOrEmpty(allowedCsv)) return true; // empty = anyone
            var u = (userType ?? "viewer").ToLowerInvariant();
            // Normalize SB's "moderator" vs our "mod".
            if (u == "moderator") u = "mod";
            foreach (var raw in allowedCsv.Split(','))
            {
                var r = raw.Trim().ToLowerInvariant();
                if (string.IsNullOrEmpty(r)) continue;
                if (r == "everyone" || r == "all" || r == "viewer" || r == "*") return true;
                if (r == u) return true;
                // Sub covers any tier (1000/2000/3000)
                if (r == "sub" && (u == "sub" || u == "subscriber")) return true;
            }
            return false;
        }

        private static void PostToDiscord(string webhookUrl, string user, string clipUrl, string template)
        {
            var content = string.IsNullOrEmpty(template)
                ? ("🎬 New clip by **" + (user ?? "viewer") + "**: " + clipUrl)
                : template.Replace("{user}", user ?? "").Replace("{url}", clipUrl);
            var payload = JsonConvert.SerializeObject(new { content });
            var req = new HttpRequestMessage(HttpMethod.Post, webhookUrl)
            {
                Content = new StringContent(payload, Encoding.UTF8, "application/json")
            };
            // Discord webhook responds 204 on success; we don't care about the body.
            using (var resp = _http.SendAsync(req).GetAwaiter().GetResult())
            {
                // Don't throw on non-success - Discord may be down, the clip
                // already posted to chat, that's the important thing.
            }
        }
    }

    /// <summary>
    /// Append-only log of clip URLs, persisted as JSONL so a future Stream
    /// Recap module can surface "best clips of the stream" without reaching
    /// back to Twitch's API.
    /// </summary>
    public sealed class ClipLog
    {
        private static ClipLog _instance;
        public static ClipLog Instance => _instance ?? (_instance = new ClipLog());

        public class Entry
        {
            public string Url       { get; set; }
            public string User      { get; set; }
            public string Platform  { get; set; }
            public string Title     { get; set; }
            public DateTime CreatedAt { get; set; }
        }

        private readonly object _gate = new object();
        private string _path;

        public void Append(Entry e)
        {
            try
            {
                if (_path == null)
                {
                    var data = SettingsManager.Instance.DataFolder ?? ".";
                    _path = Path.Combine(data, "clips.jsonl");
                }
                var line = JsonConvert.SerializeObject(e);
                lock (_gate) File.AppendAllText(_path, line + Environment.NewLine);
            }
            catch (Exception ex) { ErrorLog.Write("ClipLog.Append", ex); }
        }

        public IReadOnlyList<Entry> All()
        {
            try
            {
                if (_path == null)
                {
                    var data = SettingsManager.Instance.DataFolder ?? ".";
                    _path = Path.Combine(data, "clips.jsonl");
                }
                if (!File.Exists(_path)) return new List<Entry>();
                var list = new List<Entry>();
                lock (_gate)
                {
                    foreach (var raw in File.ReadAllLines(_path))
                    {
                        if (string.IsNullOrWhiteSpace(raw)) continue;
                        try { list.Add(JsonConvert.DeserializeObject<Entry>(raw)); }
                        catch { /* skip corrupt lines */ }
                    }
                }
                return list;
            }
            catch { return new List<Entry>(); }
        }
    }
}
