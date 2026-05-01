using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
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
    /// Info / utility commands. All free-tier; this is the bread and butter
    /// every channel needs.
    ///
    /// Built-ins (each can be disabled in settings):
    ///   !uptime         — stream uptime, pulled from CPH
    ///   !followage      — viewer's follow age (Twitch only)
    ///   !accountage     — viewer's account age (Twitch only)
    ///   !title / !game  — current stream title / category
    ///   !so &lt;user&gt;     — shoutout (delegates to AI module if entitled, else template)
    ///   !lurk / !unlurk — viewer self-marks lurking
    ///   !commands       — lists configured commands
    ///   !socials        — broadcaster's links (configurable)
    ///   !discord        — alias for socials.discord
    ///   !quote add/get/random
    ///
    /// Custom commands: any entry in <see cref="InfoCommandsConfig.Custom"/>
    /// with a name and response template is matched too.
    /// </summary>
    public sealed class InfoCommandsModule : IEventModule
    {
        public void OnTick() { }

        public void OnEvent(EventContext ctx)
        {
            if (ctx.Kind != "chat") return;
            var s = SettingsManager.Instance.Current;
            if (!s.Modules.InfoCommands) return;

            var msg = (ctx.Message ?? "").Trim();
            if (msg.Length < 2 || msg[0] != '!') return;

            var spaceIdx = msg.IndexOf(' ');
            var cmd = (spaceIdx < 0 ? msg.Substring(1) : msg.Substring(1, spaceIdx - 1)).ToLowerInvariant();
            var rest = spaceIdx < 0 ? "" : msg.Substring(spaceIdx + 1).Trim();

            string reply = null;

            switch (cmd)
            {
                case "uptime":     reply = ReplyUptime(); break;
                case "followage":  reply = ReplyFollowage(ctx); break;
                case "accountage": reply = ReplyAccountAge(ctx); break;
                case "title":      reply = ReplyTitle(); break;
                case "game":       reply = ReplyGame(); break;
                case "so":         reply = ReplyShoutout(ctx, rest); break;
                case "lurk":       reply = "👋 Thanks for lurking, " + ctx.User + "! Catch you later."; break;
                case "unlurk":     reply = "🎉 Welcome back, " + ctx.User + "!"; break;
                case "commands":   reply = ReplyCommandsList(s); break;
                case "socials":    reply = s.InfoCommands.Socials; break;
                case "discord":    reply = s.InfoCommands.Discord; break;
                case "quote":      reply = ReplyQuote(s, rest, ctx); break;
                default:
                    var custom = s.InfoCommands.Custom.FirstOrDefault(c =>
                        string.Equals(c.Name, cmd, StringComparison.OrdinalIgnoreCase));
                    if (custom != null && !string.IsNullOrEmpty(custom.Response))
                        reply = custom.Response.Replace("{user}", ctx.User).Replace("{rest}", rest);
                    break;
            }

            if (string.IsNullOrEmpty(reply)) return;

            // Per-command cooldown so bored viewers can't spam !uptime / !title.
            // Mods + broadcaster always bypass — they have a reason to repeat.
            var u = (ctx.UserType ?? "").ToLowerInvariant();
            var bypass = (u == "broadcaster" || u == "moderator" || u == "mod");
            if (!bypass)
            {
                var cd = TimeSpan.FromSeconds(Math.Max(0, s.ChatNoise.InfoCommandCooldownSec));
                if (!ChatGate.TrySend(ChatGate.Area.InfoCommands, "info:" + cmd, cd)) return;
            }
            else
            {
                if (!ChatGate.TrySend(ChatGate.Area.InfoCommands)) return;
            }

            // Reply on the originating platform - replies don't cross-post.
            new MultiPlatformSender(CphPlatformSender.Instance).Send(ctx.Platform, reply, s.Platforms);
        }

        // -------------------- Per-command renderers --------------------

        private static string ReplyUptime()
        {
            // CPH usually exposes the start time as a global. Fall back to a friendly
            // default rather than a stack trace.
            var startStr = SbBridge.Instance.GetGlobal<string>("twitch.streamStart", null);
            if (DateTime.TryParse(startStr, out var startUtc))
            {
                var span = DateTime.UtcNow - startUtc.ToUniversalTime();
                return "Stream uptime: " + Format(span);
            }
            return "Stream uptime is unavailable right now.";
        }

        private static string ReplyTitle()
        {
            var t = SbBridge.Instance.GetGlobal<string>("twitch.streamTitle", null);
            return string.IsNullOrEmpty(t) ? "(no title set)" : "Title: " + t;
        }

        private static string ReplyGame()
        {
            var g = SbBridge.Instance.GetGlobal<string>("twitch.streamCategory", null);
            return string.IsNullOrEmpty(g) ? "(no category set)" : "Now playing: " + g;
        }

        private static string ReplyFollowage(EventContext ctx)
        {
            // CPH event args carry followDate / followedAt for the chatter on Twitch.
            // Cross-platform: bail with a polite message.
            var follow = ctx.Get<string>("followDate", ctx.Get<string>("followedAt", null));
            if (DateTime.TryParse(follow, out var when))
            {
                var span = DateTime.UtcNow - when.ToUniversalTime();
                return "@" + ctx.User + " has followed for " + Format(span) + ".";
            }
            return "@" + ctx.User + " — I can't see your follow date from here.";
        }

        private static string ReplyAccountAge(EventContext ctx)
        {
            var created = ctx.Get<string>("accountCreated", ctx.Get<string>("createdAt", null));
            if (DateTime.TryParse(created, out var when))
            {
                var span = DateTime.UtcNow - when.ToUniversalTime();
                return "@" + ctx.User + " — your account is " + Format(span) + " old.";
            }
            return "@" + ctx.User + " — I can't see your account age from here.";
        }

        private static string ReplyShoutout(EventContext ctx, string target)
        {
            target = (target ?? "").Trim().TrimStart('@');
            if (string.IsNullOrEmpty(target)) return "Usage: !so <username>";

            // Bus event so overlays / external products can react if they want
            // (e.g., a stream-deck shortcut to bring up the channel page on a
            // second monitor).
            AquiloBus.Instance.Publish("shoutout.requested", new { target, requestedBy = ctx.User, platform = ctx.Platform.ToShortName() });
            return "🎯 Go check out https://twitch.tv/" + target + " — they're awesome!";
        }

        private static string ReplyCommandsList(LoadoutSettings s)
        {
            var builtins = new List<string> { "!uptime", "!followage", "!accountage", "!title", "!game", "!so", "!lurk", "!unlurk", "!socials", "!discord", "!quote", "!link", "!loadout" };
            foreach (var c in s.InfoCommands.Custom) if (!string.IsNullOrEmpty(c.Name)) builtins.Add("!" + c.Name);
            foreach (var c in s.Counters.Counters)   if (!string.IsNullOrEmpty(c.Name)) builtins.Add("!" + c.Name);
            return "Commands: " + string.Join(" · ", builtins.Distinct(StringComparer.OrdinalIgnoreCase));
        }

        // -------------------- Quotes --------------------

        private static string ReplyQuote(LoadoutSettings s, string rest, EventContext ctx)
        {
            var quotes = QuoteStore.Instance.All();
            if (string.IsNullOrEmpty(rest) || rest.Equals("random", StringComparison.OrdinalIgnoreCase))
            {
                if (quotes.Count == 0) return "No quotes saved yet.";
                var rnd = new Random();
                var q = quotes[rnd.Next(quotes.Count)];
                return "#" + q.Id + ": \"" + q.Text + "\" — " + q.Author + " (" + q.Date.ToString("yyyy-MM-dd") + ")";
            }
            if (rest.StartsWith("add ", StringComparison.OrdinalIgnoreCase))
            {
                if (!IsModOrBroadcaster(ctx.UserType)) return "Only mods can add quotes.";
                var text = rest.Substring(4).Trim();
                if (string.IsNullOrEmpty(text)) return "Usage: !quote add <text>";
                var q = QuoteStore.Instance.Add(text, s.BroadcasterName ?? ctx.User);
                return "Quote #" + q.Id + " saved.";
            }
            if (int.TryParse(rest, out var id))
            {
                var q = quotes.FirstOrDefault(x => x.Id == id);
                return q == null ? "No quote with id " + id : ("#" + q.Id + ": \"" + q.Text + "\" — " + q.Author);
            }
            return "Usage: !quote [random|<id>|add <text>]";
        }

        private static bool IsModOrBroadcaster(string userType)
        {
            var u = (userType ?? "").ToLowerInvariant();
            return u == "broadcaster" || u == "moderator" || u == "mod";
        }

        // -------------------- Helpers --------------------

        private static string Format(TimeSpan ts)
        {
            if (ts.TotalDays >= 365) return Math.Floor(ts.TotalDays / 365) + " years, " + ((int)ts.TotalDays % 365) + " days";
            if (ts.TotalDays >= 30)  return Math.Floor(ts.TotalDays / 30)  + " months, " + ((int)ts.TotalDays % 30)  + " days";
            if (ts.TotalDays >= 1)   return (int)ts.TotalDays + "d " + ts.Hours + "h " + ts.Minutes + "m";
            if (ts.TotalHours >= 1)  return ts.Hours + "h " + ts.Minutes + "m";
            return ts.Minutes + "m " + ts.Seconds + "s";
        }
    }

    /// <summary>Persistent quote store (one JSON file in the Loadout data folder).</summary>
    public sealed class QuoteStore
    {
        private static QuoteStore _instance;
        public static QuoteStore Instance => _instance ?? (_instance = new QuoteStore());

        private readonly object _gate = new object();
        private List<Quote> _quotes;
        private string _path;

        public class Quote
        {
            public int      Id     { get; set; }
            public string   Text   { get; set; }
            public string   Author { get; set; }
            public DateTime Date   { get; set; }
        }

        public IReadOnlyList<Quote> All()
        {
            EnsureLoaded();
            lock (_gate) return _quotes.ToList();
        }

        public Quote Add(string text, string author)
        {
            EnsureLoaded();
            lock (_gate)
            {
                var nextId = _quotes.Count == 0 ? 1 : _quotes.Max(q => q.Id) + 1;
                var q = new Quote { Id = nextId, Text = text, Author = author ?? "anon", Date = DateTime.UtcNow };
                _quotes.Add(q);
                Save();
                return q;
            }
        }

        private void EnsureLoaded()
        {
            if (_quotes != null) return;
            lock (_gate)
            {
                if (_quotes != null) return;
                _path = Path.Combine(SettingsManager.Instance.DataFolder ?? ".", "quotes.json");
                if (File.Exists(_path))
                {
                    try { _quotes = JsonConvert.DeserializeObject<List<Quote>>(File.ReadAllText(_path)) ?? new List<Quote>(); }
                    catch { _quotes = new List<Quote>(); }
                }
                else _quotes = new List<Quote>();
            }
        }

        private void Save()
        {
            try { File.WriteAllText(_path, JsonConvert.SerializeObject(_quotes, Formatting.Indented)); }
            catch (Exception ex) { System.Diagnostics.Debug.WriteLine("[Loadout] Quote save failed: " + ex.Message); }
        }
    }
}
