using System;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using Loadout.Patreon;
using Loadout.Sb;
using Loadout.Settings;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Loadout.Modules
{
    /// <summary>
    /// Posts a "going live" embed to a Discord webhook on stream start, edits
    /// it in place when the title or category changes, and either deletes or
    /// strikes it through when the stream ends.
    ///
    /// Tracks the message id between SB sessions in <c>discord-live.json</c>
    /// next to settings, so a SB restart mid-stream picks up the existing
    /// message instead of double-posting.
    /// </summary>
    public sealed class DiscordLiveStatusModule : IEventModule
    {
        private static readonly HttpClient _http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };

        public void OnTick() { }

        public void OnEvent(EventContext ctx)
        {
            var s = SettingsManager.Instance.Current;
            if (!s.Modules.DiscordLiveStatus) return;
            if (!Entitlements.IsUnlocked(Feature.DiscordLiveStatus)) return;
            if (string.IsNullOrEmpty(s.Discord.LiveStatusWebhook)) return;

            switch (ctx.Kind)
            {
                case "streamOnline":  _ = PostLiveAsync(s, ctx);    return;
                case "streamUpdate":  _ = EditLiveAsync(s, ctx);    return;
                case "streamOffline": _ = ArchiveLiveAsync(s, ctx); return;
            }
        }

        // -------------------- HTTP --------------------

        private static async Task PostLiveAsync(LoadoutSettings s, EventContext ctx)
        {
            var existing = LoadState();
            // If we already have a live message, edit instead of duplicating.
            if (!string.IsNullOrEmpty(existing.MessageId))
            {
                await EditLiveAsync(s, ctx).ConfigureAwait(false);
                return;
            }

            var payload = BuildPayload(s, ctx, archived: false);
            var url = AppendQuery(s.Discord.LiveStatusWebhook, "wait=true");
            var req = new HttpRequestMessage(HttpMethod.Post, url) { Content = JsonContent(payload) };
            using var resp = await _http.SendAsync(req).ConfigureAwait(false);
            if (!resp.IsSuccessStatusCode)
            {
                SbBridge.Instance.LogWarn("[Loadout] Discord live post failed: " + (int)resp.StatusCode);
                return;
            }
            var body = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
            try
            {
                var json = JObject.Parse(body);
                var messageId = (string)json["id"];
                if (!string.IsNullOrEmpty(messageId)) SaveState(new LiveState { MessageId = messageId, StartedUtc = DateTime.UtcNow });
            }
            catch { /* webhook returned no JSON (Discord sometimes 204s) — we lose edit ability but the post succeeded */ }
        }

        private static async Task EditLiveAsync(LoadoutSettings s, EventContext ctx)
        {
            if (!s.Discord.AutoEditOnChange) return;
            var existing = LoadState();
            if (string.IsNullOrEmpty(existing.MessageId)) return;

            var payload = BuildPayload(s, ctx, archived: false);
            var editUrl = s.Discord.LiveStatusWebhook.TrimEnd('/') + "/messages/" + existing.MessageId;
            var req = new HttpRequestMessage(new HttpMethod("PATCH"), editUrl) { Content = JsonContent(payload) };
            using var resp = await _http.SendAsync(req).ConfigureAwait(false);
            if (!resp.IsSuccessStatusCode)
                SbBridge.Instance.LogWarn("[Loadout] Discord live edit failed: " + (int)resp.StatusCode);
        }

        private static async Task ArchiveLiveAsync(LoadoutSettings s, EventContext ctx)
        {
            var existing = LoadState();
            if (string.IsNullOrEmpty(existing.MessageId)) return;

            if (s.Discord.ArchiveOnOffline)
            {
                // "Archive" = edit to strikethrough title and add a went-offline footer.
                var archived = BuildPayload(s, ctx, archived: true);
                var editUrl = s.Discord.LiveStatusWebhook.TrimEnd('/') + "/messages/" + existing.MessageId;
                var req = new HttpRequestMessage(new HttpMethod("PATCH"), editUrl) { Content = JsonContent(archived) };
                using var resp = await _http.SendAsync(req).ConfigureAwait(false);
                if (!resp.IsSuccessStatusCode)
                    SbBridge.Instance.LogWarn("[Loadout] Discord archive edit failed: " + (int)resp.StatusCode);
            }
            else
            {
                var deleteUrl = s.Discord.LiveStatusWebhook.TrimEnd('/') + "/messages/" + existing.MessageId;
                using var resp = await _http.DeleteAsync(deleteUrl).ConfigureAwait(false);
            }

            ClearState();
        }

        // -------------------- Payload --------------------

        private static object BuildPayload(LoadoutSettings s, EventContext ctx, bool archived)
        {
            var broadcaster = string.IsNullOrEmpty(s.BroadcasterName) ? "the streamer" : s.BroadcasterName;
            var title = SbBridge.Instance.GetGlobal<string>("twitch.streamTitle",    "(no title)");
            var game  = SbBridge.Instance.GetGlobal<string>("twitch.streamCategory", "(no category)");
            var url   = "https://twitch.tv/" + broadcaster;

            string Sub(string raw) => (raw ?? "")
                .Replace("{broadcaster}", broadcaster)
                .Replace("{title}",       title)
                .Replace("{game}",        game)
                .Replace("{url}",         url);

            string contentLine;
            if (archived)
                contentLine = "~~" + Sub(s.Discord.GoLiveTemplate) + "~~  *(stream ended)*";
            else
                contentLine = Sub(s.Discord.GoLiveTemplate ?? "🔴 **{broadcaster}** is now live!\n**{title}** — *{game}*\n{url}");

            // Embed branch: when DiscordEmbedConfig.Use is true, ship a
            // structured embed instead of (or alongside) the plain content.
            // We always still include `content` because it's what edit-on-
            // change expects to update if the user later turns embeds off.
            var embed = s.Discord.Embed;
            if (embed != null && embed.Use)
            {
                int color;
                if (!TryParseHexColor(embed.ColorHex, out color)) color = 0x3A86FF;

                var embedObj = new System.Collections.Generic.Dictionary<string, object>
                {
                    ["title"]       = Sub(embed.Title),
                    ["description"] = Sub(embed.Description) + (archived ? "\n\n*(stream ended)*" : ""),
                    ["color"]       = color,
                    ["url"]         = url,
                    ["timestamp"]   = DateTime.UtcNow.ToString("o")
                };
                if (!string.IsNullOrEmpty(embed.ImageUrl)) embedObj["image"]     = new { url = embed.ImageUrl };
                if (!string.IsNullOrEmpty(embed.ThumbUrl)) embedObj["thumbnail"] = new { url = embed.ThumbUrl };
                if (!string.IsNullOrEmpty(embed.AuthorName))
                    embedObj["author"] = new { name = Sub(embed.AuthorName), icon_url = embed.AuthorIcon ?? "" };
                if (!string.IsNullOrEmpty(embed.FooterText))
                    embedObj["footer"] = new { text = Sub(embed.FooterText), icon_url = embed.FooterIcon ?? "" };

                return new
                {
                    content = contentLine,
                    embeds  = new[] { embedObj },
                    allowed_mentions = new { parse = new string[] { } }
                };
            }

            return new
            {
                content = contentLine,
                allowed_mentions = new { parse = new string[] { } }
            };
        }

        // Accepts "#3A86FF", "3A86FF", or a decimal int. Returns false on
        // garbage so the caller can fall back to the brand default.
        private static bool TryParseHexColor(string hex, out int color)
        {
            color = 0;
            if (string.IsNullOrEmpty(hex)) return false;
            hex = hex.Trim();
            if (hex.StartsWith("#")) hex = hex.Substring(1);
            // Try plain int first (Discord format).
            if (int.TryParse(hex, out color)) return true;
            return int.TryParse(hex, System.Globalization.NumberStyles.HexNumber,
                System.Globalization.CultureInfo.InvariantCulture, out color);
        }

        // -------------------- State persistence --------------------

        private class LiveState
        {
            public string   MessageId  { get; set; }
            public DateTime StartedUtc { get; set; }
        }

        private static string StatePath() =>
            Path.Combine(SettingsManager.Instance.DataFolder ?? ".", "discord-live.json");

        private static LiveState LoadState()
        {
            try
            {
                if (!File.Exists(StatePath())) return new LiveState();
                return JsonConvert.DeserializeObject<LiveState>(File.ReadAllText(StatePath())) ?? new LiveState();
            }
            catch { return new LiveState(); }
        }

        private static void SaveState(LiveState s)
        {
            try { File.WriteAllText(StatePath(), JsonConvert.SerializeObject(s)); } catch { }
        }

        private static void ClearState()
        {
            try { if (File.Exists(StatePath())) File.Delete(StatePath()); } catch { }
        }

        // -------------------- Utilities --------------------

        private static StringContent JsonContent(object body) =>
            new StringContent(JsonConvert.SerializeObject(body), Encoding.UTF8, "application/json");

        private static string AppendQuery(string url, string kv) =>
            url + (url.Contains("?") ? "&" : "?") + kv;
    }
}
