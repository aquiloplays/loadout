using System;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using Loadout.Patreon;
using Loadout.Sb;
using Loadout.Settings;
using Loadout.Util;
using Newtonsoft.Json;

namespace Loadout.Modules
{
    /// <summary>
    /// Posts a "going live" tweet to a user-supplied webhook on stream-online,
    /// and (optionally) a "stream wrapped" tweet on stream-offline.
    ///
    /// Webhook-based on purpose: X charges $100/mo for the Basic API tier
    /// needed for OAuth user-context tweet writes, which would either eat
    /// every Patreon dollar we collect or force us to implement a token
    /// proxy. Letting the user wire their own posting service (Zapier, IFTTT,
    /// Make, n8n, custom Cloudflare Worker) keeps Loadout free of that
    /// recurring cost AND gives them the flexibility to do more than tweet
    /// (cross-post to Bluesky, file Airtable rows, page their phone, etc.).
    ///
    /// Payload sent to the configured webhook:
    ///   { "kind":"live.online" | "live.offline" | "live.update",
    ///     "broadcaster": "...", "title":"...", "game":"...",
    ///     "url":"https://twitch.tv/...", "rendered":"<full templated text>",
    ///     "ts":"<ISO 8601 UTC>" }
    /// </summary>
    public sealed class TwitterLiveStatusModule : IEventModule
    {
        private static readonly HttpClient _http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };

        public void OnTick() { }

        public void OnEvent(EventContext ctx)
        {
            var s = SettingsManager.Instance.Current;
            if (!s.Modules.TwitterLiveStatus) return;
            if (!Entitlements.IsUnlocked(Feature.TwitterLiveStatus)) return;
            if (string.IsNullOrEmpty(s.Twitter.LiveWebhook)) return;

            switch (ctx.Kind)
            {
                case "streamOnline":  _ = PostAsync(s, ctx, "live.online");  return;
                case "streamOffline": _ = PostAsync(s, ctx, "live.offline"); return;
                case "streamUpdate":
                    if (s.Twitter.PostOnUpdate) _ = PostAsync(s, ctx, "live.update");
                    return;
            }
        }

        private static async Task PostAsync(LoadoutSettings s, EventContext ctx, string kind)
        {
            try
            {
                var broadcaster = string.IsNullOrEmpty(s.BroadcasterName) ? "the streamer" : s.BroadcasterName;
                var title = SbBridge.Instance.GetGlobal<string>("twitch.streamTitle",    "");
                var game  = SbBridge.Instance.GetGlobal<string>("twitch.streamCategory", "");
                var url   = "https://twitch.tv/" + broadcaster;

                var template = kind == "live.offline" ? s.Twitter.OfflineTemplate : s.Twitter.LiveTemplate;
                var rendered = (template ?? "")
                    .Replace("{broadcaster}", broadcaster)
                    .Replace("{title}",       title)
                    .Replace("{game}",        game)
                    .Replace("{url}",         url);

                var payload = new
                {
                    kind,
                    broadcaster,
                    title,
                    game,
                    url,
                    rendered,
                    ts = DateTime.UtcNow.ToString("o")
                };
                var json = JsonConvert.SerializeObject(payload);
                using var resp = await _http.PostAsync(
                    s.Twitter.LiveWebhook,
                    new StringContent(json, Encoding.UTF8, "application/json"))
                    .ConfigureAwait(false);
                if (!resp.IsSuccessStatusCode)
                    ErrorLog.Write("TwitterLiveStatus", "Webhook returned " + (int)resp.StatusCode);
            }
            catch (Exception ex)
            {
                ErrorLog.Write("TwitterLiveStatus", ex);
            }
        }
    }
}
