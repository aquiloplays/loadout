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

            string contentLine;
            if (archived)
            {
                contentLine = "~~" + (s.Discord.GoLiveTemplate ?? "")
                    .Replace("{broadcaster}", broadcaster)
                    .Replace("{title}",       title)
                    .Replace("{game}",        game)
                    .Replace("{url}",         url) + "~~  *(stream ended)*";
            }
            else
            {
                contentLine = (s.Discord.GoLiveTemplate ?? "🔴 **{broadcaster}** is now live!\n**{title}** — *{game}*\n{url}")
                    .Replace("{broadcaster}", broadcaster)
                    .Replace("{title}",       title)
                    .Replace("{game}",        game)
                    .Replace("{url}",         url);
            }

            return new
            {
                content = contentLine,
                allowed_mentions = new { parse = new string[] { } }
            };
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
