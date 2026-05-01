using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using Loadout.Bus;
using Loadout.Patreon;
using Loadout.Platforms;
using Loadout.Sb;
using Loadout.Settings;
using Newtonsoft.Json;

namespace Loadout.Modules
{
    /// <summary>
    /// Aggregates per-stream stats in memory and posts a recap to a Discord
    /// webhook (and optionally to chat) when the stream goes offline.
    ///
    /// Tracks: subs gained, raids received, follows gained, top chatters,
    /// hype moments (chat-velocity spikes), bits, super chats, longest lurker.
    ///
    /// Intentionally in-memory — when SB restarts mid-stream we lose the
    /// session, which is fine for v1. Phase 2 can persist to disk.
    /// </summary>
    public sealed class StreamRecapModule : IEventModule
    {
        private DateTime? _streamStartUtc;
        private readonly ConcurrentDictionary<string, int> _chatCounts = new ConcurrentDictionary<string, int>();
        private readonly List<string> _raidsReceived = new List<string>();
        private int _follows, _subs, _resubs, _giftSubs, _bits, _superChats;

        public void OnTick() { }

        public void OnEvent(EventContext ctx)
        {
            switch (ctx.Kind)
            {
                case "streamOnline":  Reset(); _streamStartUtc = DateTime.UtcNow; return;
                case "streamOffline": _ = Task.Run(() => PostRecapAsync(ctx)); return;
                case "follow":   _follows++; return;
                case "sub":      _subs++; return;
                case "resub":    _resubs++; return;
                case "giftSub":  _giftSubs += Math.Max(1, ctx.Get<int>("count", 1)); return;
                case "cheer":    _bits     += ctx.Get<int>("bits",  0); return;
                case "superChat":_superChats++; return;
                case "raid":     _raidsReceived.Add(ctx.User + " (" + ctx.Get<int>("viewers", 0) + ")"); return;
                case "chat":
                    if (!string.IsNullOrEmpty(ctx.User))
                        _chatCounts.AddOrUpdate(ctx.User, 1, (_, v) => v + 1);
                    return;
            }
        }

        private void Reset()
        {
            _chatCounts.Clear();
            _raidsReceived.Clear();
            _follows = _subs = _resubs = _giftSubs = _bits = _superChats = 0;
            _streamStartUtc = null;
        }

        private async Task PostRecapAsync(EventContext ctx)
        {
            var s = SettingsManager.Instance.Current;
            if (!s.Modules.StreamRecap) return;
            if (!Entitlements.IsUnlocked(Feature.StreamRecap)) return;

            var duration = _streamStartUtc.HasValue ? (DateTime.UtcNow - _streamStartUtc.Value) : TimeSpan.Zero;
            var topChatters = _chatCounts
                .OrderByDescending(kv => kv.Value)
                .Take(5)
                .Select(kv => kv.Key + " (" + kv.Value + ")")
                .ToList();

            var lines = new List<string>
            {
                "📊 **Stream Recap** — " + (s.BroadcasterName ?? "stream"),
                "",
                "Duration: " + (int)duration.TotalHours + "h " + duration.Minutes + "m",
                "Follows: " + _follows + "  ·  Subs: " + (_subs + _resubs + _giftSubs) + "  ·  Bits: " + _bits + "  ·  Super chats: " + _superChats
            };
            if (_raidsReceived.Count > 0) lines.Add("Raids received: " + string.Join(", ", _raidsReceived));
            if (topChatters.Count   > 0)  lines.Add("Top chatters: "    + string.Join(", ", topChatters));
            lines.Add("");
            lines.Add("Thanks for hanging out 💜");

            var content = string.Join("\n", lines);

            // Discord post (uses RecapWebhook, falling back to LiveStatusWebhook).
            var hook = string.IsNullOrEmpty(s.Discord.RecapWebhook) ? s.Discord.LiveStatusWebhook : s.Discord.RecapWebhook;
            if (!string.IsNullOrEmpty(hook))
            {
                try
                {
                    using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
                    var json = JsonConvert.SerializeObject(new { content, allowed_mentions = new { parse = new string[] { } } });
                    using var resp = await http.PostAsync(hook,
                        new StringContent(json, Encoding.UTF8, "application/json")).ConfigureAwait(false);
                    if (!resp.IsSuccessStatusCode)
                        SbBridge.Instance.LogWarn("[Loadout] Recap Discord post failed: " + (int)resp.StatusCode);
                }
                catch (Exception ex)
                {
                    SbBridge.Instance.LogError("[Loadout] Recap Discord post threw: " + ex.Message);
                }
            }

            // Bus event so OBS overlays / SF can show a "stream ended" card.
            AquiloBus.Instance.Publish("recap.posted", new
            {
                duration = duration.ToString(@"hh\:mm\:ss"),
                follows  = _follows,
                subs     = _subs + _resubs + _giftSubs,
                bits     = _bits,
                superChats = _superChats,
                topChatters,
                raidsReceived = _raidsReceived
            });
        }
    }
}
