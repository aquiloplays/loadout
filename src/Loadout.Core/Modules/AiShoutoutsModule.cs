using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Threading.Tasks;
using Loadout.Bus;
using Loadout.Patreon;
using Loadout.Platforms;
using Loadout.Sb;
using Loadout.Settings;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Loadout.Modules
{
    /// <summary>
    /// AI-personalized shoutouts. Two trigger paths:
    ///   1. <c>raid</c> event — automatic shoutout for the raider.
    ///   2. <c>shoutout.requested</c> bus event — fired by the !so command.
    ///
    /// Provider switch: Anthropic Claude (Messages API) or OpenAI (Chat
    /// Completions). Free tier requires user's own API key (BYOK); Tier 3
    /// can use the bundled key (Phase 2 — for now BYOK is required for all
    /// because we haven't wired the bundled-key proxy yet).
    ///
    /// Falls back to a safe template message if the API call fails for any
    /// reason — the show must go on.
    /// </summary>
    public sealed class AiShoutoutsModule : IEventModule
    {
        private static readonly HttpClient _http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };

        public AiShoutoutsModule()
        {
            // The bus event from InfoCommandsModule.!so flows here.
            AquiloBus.Instance.Publish("ai.module.ready", new { });
        }

        public void OnTick() { }

        public void OnEvent(EventContext ctx)
        {
            if (ctx.Kind != "raid") return;
            var s = SettingsManager.Instance.Current;
            if (!s.Modules.AiShoutouts || !s.Ai.ShoutoutsEnabled) return;
            if (!Entitlements.IsUnlocked(Feature.AiShoutouts)) return;

            var raider = ctx.User;
            if (string.IsNullOrEmpty(raider)) return;

            // Pull category / title from CPH globals if available; fall back gracefully.
            var lastGame  = ctx.Get<string>("raiderGame",  ctx.Get<string>("raiderCategory", null));
            var lastTitle = ctx.Get<string>("raiderTitle", null);

            _ = Task.Run(async () =>
            {
                var msg = await GenerateAsync(s.Ai, raider, lastGame, lastTitle).ConfigureAwait(false);
                if (string.IsNullOrEmpty(msg))
                    msg = "🚀 RAID! Go follow https://twitch.tv/" + raider + " — they're a vibe!";
                new MultiPlatformSender(CphPlatformSender.Instance)
                    .Send(ctx.Platform, msg, s.Platforms);
            });
        }

        // -------------------- Provider implementations --------------------

        private static async Task<string> GenerateAsync(AiConfig cfg, string raider, string game, string title)
        {
            try
            {
                var prompt = BuildPrompt(cfg, raider, game, title);
                switch ((cfg.Provider ?? "").ToLowerInvariant())
                {
                    case "anthropic": return await AnthropicAsync(cfg, prompt).ConfigureAwait(false);
                    case "openai":    return await OpenAiAsync(cfg, prompt).ConfigureAwait(false);
                    default:          return null;
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine("[Loadout] AI shoutout failed: " + ex.Message);
                return null;
            }
        }

        private static string BuildPrompt(AiConfig cfg, string raider, string game, string title)
        {
            var sb = new StringBuilder();
            sb.AppendLine(string.IsNullOrWhiteSpace(cfg.ShoutoutPromptPrefix)
                ? "Write a short, hype Twitch shoutout (1-2 sentences) for the streamer below. No hashtags. No emojis at the start of the message. Just the message text — no preamble."
                : cfg.ShoutoutPromptPrefix);
            sb.AppendLine();
            sb.AppendLine("Streamer name: " + raider);
            if (!string.IsNullOrWhiteSpace(game))  sb.AppendLine("Last category: " + game);
            if (!string.IsNullOrWhiteSpace(title)) sb.AppendLine("Last title: "    + title);
            sb.AppendLine();
            sb.AppendLine("Always include the URL https://twitch.tv/" + raider + " in the message.");
            return sb.ToString();
        }

        private static async Task<string> AnthropicAsync(AiConfig cfg, string prompt)
        {
            if (string.IsNullOrEmpty(cfg.ApiKey)) return null;
            var body = new
            {
                model      = string.IsNullOrEmpty(cfg.Model) ? "claude-haiku-4-5" : cfg.Model,
                max_tokens = 200,
                messages   = new[] { new { role = "user", content = prompt } }
            };
            var req = new HttpRequestMessage(HttpMethod.Post, "https://api.anthropic.com/v1/messages")
            {
                Content = new StringContent(JsonConvert.SerializeObject(body), Encoding.UTF8, "application/json")
            };
            req.Headers.Add("x-api-key", cfg.ApiKey);
            req.Headers.Add("anthropic-version", "2023-06-01");

            using var resp = await _http.SendAsync(req).ConfigureAwait(false);
            var text = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
            if (!resp.IsSuccessStatusCode) return null;
            var json = JObject.Parse(text);
            // Messages API: content is an array of blocks, take the first text block.
            var first = ((JArray)json["content"])?.OfType<JObject>().FirstOrDefault(b => (string)b["type"] == "text");
            return ((string)first?["text"])?.Trim();
        }

        private static async Task<string> OpenAiAsync(AiConfig cfg, string prompt)
        {
            if (string.IsNullOrEmpty(cfg.ApiKey)) return null;
            var body = new
            {
                model = string.IsNullOrEmpty(cfg.Model) ? "gpt-4o-mini" : cfg.Model,
                messages = new[] { new { role = "user", content = prompt } },
                max_tokens = 200
            };
            var req = new HttpRequestMessage(HttpMethod.Post, "https://api.openai.com/v1/chat/completions")
            {
                Content = new StringContent(JsonConvert.SerializeObject(body), Encoding.UTF8, "application/json")
            };
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", cfg.ApiKey);

            using var resp = await _http.SendAsync(req).ConfigureAwait(false);
            var text = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
            if (!resp.IsSuccessStatusCode) return null;
            var json = JObject.Parse(text);
            return ((string)json.SelectToken("choices[0].message.content"))?.Trim();
        }
    }
}
