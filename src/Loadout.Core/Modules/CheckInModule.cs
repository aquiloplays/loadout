using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Threading.Tasks;
using Loadout.Bus;
using Loadout.Patreon;
using Loadout.Platforms;
using Loadout.Sb;
using Loadout.Settings;
using Loadout.Workers;
using Newtonsoft.Json.Linq;

namespace Loadout.Modules
{
    /// <summary>
    /// Daily Check-In module.
    ///
    /// Trigger paths:
    ///   1. Twitch Channel Point redemption with title matching
    ///      <see cref="CheckInConfig.TwitchRewardName"/> (case-insensitive).
    ///      Native, instant, gets profile picture from CPH args / Helix.
    ///   2. Cross-platform fallback: <see cref="CheckInConfig.CrossPlatformCommand"/>
    ///      (default <c>!checkin</c>) on Twitch / YouTube / Kick / TikTok. Other
    ///      platforms have no native channel-points concept, so command is the
    ///      most reliable surface.
    ///
    /// Output: a single <c>checkin.shown</c> bus event with everything an OBS
    /// overlay needs to render — username, profile picture URL, role/sub flair,
    /// patreon flair, the rotating-stats list. Overlays subscribe to the bus
    /// from <c>aquilo.gg/overlays/check-in</c> and render the animation.
    ///
    /// Per-user cooldown enforced in-process; resets across SB restarts.
    /// </summary>
    public sealed class CheckInModule : IEventModule
    {
        private static readonly HttpClient _http = new HttpClient { Timeout = TimeSpan.FromSeconds(8) };
        private readonly ConcurrentDictionary<string, DateTime> _lastCheckIn = new ConcurrentDictionary<string, DateTime>();

        public void OnTick() { }

        public void OnEvent(EventContext ctx)
        {
            var s = SettingsManager.Instance.Current;
            if (!s.Modules.DailyCheckIn) return;

            // Twitch Channel Points path.
            if (ctx.Kind == "rewardRedemption")
            {
                // SB carries the title under different keys across versions / event types.
                var rewardName = FirstNonEmpty(
                    ctx.Get<string>("rewardName",  null),
                    ctx.Get<string>("rewardTitle", null),
                    ctx.Get<string>("reward",      null));
                if (!string.Equals(rewardName, s.CheckIn.TwitchRewardName, StringComparison.OrdinalIgnoreCase))
                    return;
                FireCheckIn(ctx, "twitch-reward");
                return;
            }

            // Cross-platform command path.
            if (ctx.Kind == "chat")
            {
                var msg = (ctx.Message ?? "").Trim().ToLowerInvariant();
                var cmd = (s.CheckIn.CrossPlatformCommand ?? "!checkin").Trim().ToLowerInvariant();
                if (msg == cmd || msg.StartsWith(cmd + " ", StringComparison.Ordinal))
                    FireCheckIn(ctx, "command");
            }
        }

        /// <summary>
        /// Pulls the streamer-/viewer-supplied text that should appear on the
        /// overlay card. Two paths:
        ///   - Chat command: everything after the command word (e.g.
        ///     "!checkin gn from Norway" -> "gn from Norway").
        ///   - Channel-Points reward: the redeemer's input text (the reward
        ///     prompt). SB exposes this under several keys depending on the
        ///     event source.
        /// Returns "" when nothing was supplied (overlay then hides the line).
        /// </summary>
        private static string ExtractUserMessage(EventContext ctx, string source)
        {
            if (source == "command")
            {
                var raw = ctx.Message ?? "";
                // Strip the command prefix using the original casing so the
                // viewer's typed text round-trips intact (preserves their
                // capitalization, emote tokens, punctuation).
                var cmd = (SettingsManager.Instance.Current.CheckIn.CrossPlatformCommand ?? "!checkin").Trim();
                if (raw.Length > cmd.Length &&
                    raw.StartsWith(cmd, StringComparison.OrdinalIgnoreCase) &&
                    char.IsWhiteSpace(raw[cmd.Length]))
                {
                    return raw.Substring(cmd.Length + 1).Trim();
                }
                return "";
            }

            // Reward redemption: the viewer's prompt input. Different SB
            // versions / event sources name this differently — try them all.
            return FirstNonEmpty(
                ctx.Get<string>("userInput",         null),
                ctx.Get<string>("input",             null),
                ctx.Get<string>("redemptionInput",   null),
                ctx.Get<string>("redemption.userInput", null),
                ctx.Get<string>("prompt",            null),
                ctx.Get<string>("rewardInput",       null),
                ctx.Get<string>("user_input",        null)) ?? "";
        }

        /// <summary>
        /// Best-effort emote extraction from the SB event args. Handles two
        /// shapes SB has used historically:
        ///   1. Flat numbered keys: emoteCount, emote0Name, emote0ImageUrl,
        ///      emote0StartIndex, emote0EndIndex (also accepts emote0Url /
        ///      emote0Id where the URL is missing — Twitch CDN URL is then
        ///      reconstructed).
        ///   2. A JArray under "emotes" with {Name, ImageUrl, StartIndex,
        ///      EndIndex} per item.
        /// Returns objects shaped {name, url, start, end} the overlay walks
        /// to splice <img> tags into the rendered message. Empty array if
        /// no emotes were typed (most check-ins).
        /// </summary>
        private static object[] ExtractEmotes(EventContext ctx)
        {
            var list = new List<object>();

            // Shape 1: numbered keys.
            var count = ctx.Get<int>("emoteCount", 0);
            for (int i = 0; i < count; i++)
            {
                var name = ctx.Get<string>("emote" + i + "Name", null);
                var url  = ctx.Get<string>("emote" + i + "ImageUrl",
                            ctx.Get<string>("emote" + i + "Url", null));
                var id   = ctx.Get<string>("emote" + i + "Id",
                            ctx.Get<string>("emote" + i + "ID", null));
                int start = ctx.Get<int>("emote" + i + "StartIndex", -1);
                int end   = ctx.Get<int>("emote" + i + "EndIndex", -1);
                if (string.IsNullOrEmpty(url) && !string.IsNullOrEmpty(id))
                    url = "https://static-cdn.jtvnw.net/emoticons/v2/" + id + "/default/dark/3.0";
                if (start < 0 || end < start) continue;
                list.Add(new { name = name ?? "", url = url ?? "", start = start, end = end });
            }

            // Shape 2: JArray.
            if (list.Count == 0)
            {
                var raw = ctx.Get<object>("emotes", null);
                if (raw is JArray arr)
                {
                    foreach (var t in arr)
                    {
                        var name = (string)t["Name"] ?? (string)t["name"] ?? "";
                        var url  = (string)t["ImageUrl"] ?? (string)t["imageUrl"]
                                ?? (string)t["Url"] ?? (string)t["url"] ?? "";
                        var id   = (string)t["Id"] ?? (string)t["id"] ?? (string)t["ID"];
                        int start = (int?)t["StartIndex"] ?? (int?)t["startIndex"] ?? -1;
                        int end   = (int?)t["EndIndex"]   ?? (int?)t["endIndex"]   ?? -1;
                        if (string.IsNullOrEmpty(url) && !string.IsNullOrEmpty(id))
                            url = "https://static-cdn.jtvnw.net/emoticons/v2/" + id + "/default/dark/3.0";
                        if (start < 0 || end < start) continue;
                        list.Add(new { name = name, url = url, start = start, end = end });
                    }
                }
            }

            // Sort by start index so the overlay can walk left-to-right
            // without re-sorting on every render.
            return list
                .OrderBy(e => (int)e.GetType().GetProperty("start").GetValue(e, null))
                .ToArray();
        }

        private void FireCheckIn(EventContext ctx, string source)
        {
            var s = SettingsManager.Instance.Current;
            var key = ctx.Platform.ToShortName() + ":" + (ctx.User ?? "").ToLowerInvariant();

            // Cooldown enforcement.
            var cooldown = TimeSpan.FromHours(Math.Max(1, s.CheckIn.CooldownPerUserHours));
            if (_lastCheckIn.TryGetValue(key, out var last) && (DateTime.UtcNow - last) < cooldown)
            {
                // Optional: whisper the cooldown to chat. Free-tier behavior is silent.
                return;
            }
            _lastCheckIn[key] = DateTime.UtcNow;

            // Capture the viewer-supplied text + Twitch-style emote tokens once,
            // then thread them through both the initial and the enriched payload
            // so the overlay's message line stays consistent if a late PFP lands.
            var userMessage = ExtractUserMessage(ctx, source);
            var emotes      = ExtractEmotes(ctx);

            // Resolve profile picture and other identity bits in the background;
            // we publish a fast initial event so the overlay shows immediately,
            // then enrich on a follow-up event if needed.
            var initialPayload = BuildPayload(ctx, source, profilePictureUrl: null, message: userMessage, emotes: emotes);
            AquiloBus.Instance.Publish("checkin.shown", initialPayload);

            // Re-dispatch as a "checkin" event kind so BoltsModule can credit
            // the daily payout + bump the streak. This keeps the wallet logic
            // out of CheckInModule.
            try { Sb.SbEventDispatcher.Instance.DispatchEvent("checkin", ctx.Raw); } catch { }

            _ = Task.Run(async () =>
            {
                var pfp = await TryResolveProfilePictureAsync(ctx).ConfigureAwait(false);
                if (string.IsNullOrEmpty(pfp)) return;
                AquiloBus.Instance.Publish("checkin.enriched", BuildPayload(ctx, source, pfp, userMessage, emotes));
            });

            // Best-effort chat ack on the platform the check-in came from.
            new MultiPlatformSender(CphPlatformSender.Instance)
                .Send(ctx.Platform, "✅ Checked in, " + ctx.User + "!", s.Platforms);
        }

        private static object BuildPayload(EventContext ctx, string source, string profilePictureUrl,
                                           string message, object[] emotes)
        {
            var s = SettingsManager.Instance.Current;
            var role = NormalizeRole(ctx.UserType);
            var patreonTier = ResolvePatreonTier(ctx.Platform, ctx.User);

            return new
            {
                user           = ctx.User,
                userId         = ctx.Get<string>("userId", ""),
                platform       = ctx.Platform.ToShortName(),
                role           = role,                       // viewer | sub | vip | mod | broadcaster
                subTier        = ctx.Get<string>("subTier", ""),     // 1000 | 2000 | 3000 (Twitch)
                patreonTier    = patreonTier,                // tier1 | tier2 | tier3 | null
                pfp            = profilePictureUrl,
                animationTheme = s.CheckIn.AnimationTheme,
                showFlairs = new
                {
                    sub      = s.CheckIn.ShowSubFlair,
                    vipMod   = s.CheckIn.ShowVipModFlair,
                    patreon  = s.CheckIn.ShowPatreonFlair && patreonTier != null
                },
                stats          = CollectStats(s),
                rotateSeconds  = s.CheckIn.RotateIntervalSec,
                // Viewer-supplied text + emote tokens. Empty string when the
                // viewer just typed "!checkin" with no message, or redeemed
                // the reward without filling in the prompt; overlay keys off
                // the empty string to skip rendering the message line.
                message        = message ?? "",
                emotes         = emotes ?? new object[0],
                source         = source,
                ts             = DateTime.UtcNow
            };
        }

        private static object CollectStats(LoadoutSettings s)
        {
            // Each entry: { kind, label, value }. Values are pre-rendered strings
            // so the overlay doesn't need to know how to format them.
            return s.CheckIn.RotatingStats.Select(stat => RenderStat(stat)).Where(x => x != null).ToArray();
        }

        private static object RenderStat(string spec)
        {
            if (string.IsNullOrWhiteSpace(spec)) return null;
            var bridge = SbBridge.Instance;
            switch (spec.ToLowerInvariant())
            {
                case "uptime":
                    // Phase 2: read from CPH directly. For now, the overlay can
                    // ignore "uptime" if no value is supplied.
                    return new { kind = "uptime", label = "Uptime", value = "—" };
                case "viewers":
                    return new { kind = "viewers", label = "Viewers", value = bridge.GetGlobal<int>("loadout.viewers", 0).ToString() };
                case "followers":
                    return new { kind = "followers", label = "Followers", value = bridge.GetGlobal<int>("loadout.followers", 0).ToString() };
                case "substhisstream":
                    return new { kind = "subsThisStream", label = "Subs this stream", value = bridge.GetGlobal<int>("loadout.subsThisStream", 0).ToString() };
                case "topchatter":
                    return new { kind = "topChatter", label = "Top chatter", value = bridge.GetGlobal<string>("loadout.topChatter", "—") };
                default:
                    if (spec.StartsWith("counter:", StringComparison.OrdinalIgnoreCase))
                    {
                        var name = spec.Substring("counter:".Length);
                        return new
                        {
                            kind = "counter",
                            label = name,
                            value = CountersModule.GetValue(name).ToString()
                        };
                    }
                    return null;
            }
        }

        private static string NormalizeRole(string userType)
        {
            var u = (userType ?? "viewer").ToLowerInvariant();
            if (u == "broadcaster") return "broadcaster";
            if (u == "moderator" || u == "mod") return "mod";
            if (u == "vip") return "vip";
            if (u == "subscriber" || u == "sub") return "sub";
            return "viewer";
        }

        /// <summary>
        /// Two-layer Patreon supporter lookup:
        ///   1. SupportersClient cache (worker-backed; viewers self-claim at aquilo.gg/link)
        ///   2. Local PatreonSupportersConfig (broadcaster-maintained fallback)
        /// The cached layer is sub-ms; cache miss kicks off a background fetch
        /// so the next check-in for that user has the tier ready.
        /// </summary>
        private static string ResolvePatreonTier(PlatformMask platform, string user)
        {
            if (string.IsNullOrEmpty(user)) return null;
            return SupportersClient.Instance.LookupCachedOrFireAndForget(platform.ToShortName(), user);
        }

        /// <summary>
        /// Best-effort PFP resolution. CPH typically supplies <c>userImage</c> /
        /// <c>profileImageUrl</c> on Twitch events; we fall back to a Twitch
        /// public Helix call if we have a userId, and bail otherwise (overlay
        /// keeps the placeholder).
        /// </summary>
        private static string FirstNonEmpty(params string[] values)
        {
            foreach (var v in values) if (!string.IsNullOrEmpty(v)) return v;
            return null;
        }

        private static async Task<string> TryResolveProfilePictureAsync(EventContext ctx)
        {
            // Twitch reward redemption args usually carry these.
            foreach (var key in new[] { "userImage", "profileImageUrl", "userProfileImageUrl", "user_profile_image_url" })
            {
                var v = ctx.Get<string>(key, null);
                if (!string.IsNullOrEmpty(v)) return v;
            }
            // YouTube args carry "userImage" in some SB versions.
            // Cross-platform fallback returns null - overlay shows initials/placeholder.
            await Task.CompletedTask;
            return null;
        }
    }
}
