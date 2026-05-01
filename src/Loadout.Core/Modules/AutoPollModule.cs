using System;
using Loadout.Bus;
using Loadout.Patreon;
using Loadout.Platforms;
using Loadout.Sb;
using Loadout.Settings;

namespace Loadout.Modules
{
    /// <summary>
    /// When the broadcaster changes category mid-stream, post a chat poll
    /// asking "Hyped for &lt;new game&gt;?" with a few options.
    ///
    /// CPH exposes <c>CreatePoll</c> on Twitch; we call it via the SB bridge.
    /// On other platforms we fall back to a chat message — polls aren't a
    /// thing there yet.
    ///
    /// Cooldown: at most one auto-poll per 30 minutes to avoid spam.
    /// </summary>
    public sealed class AutoPollModule : IEventModule
    {
        private DateTime _lastFiredUtc = DateTime.MinValue;
        private string _lastCategory;

        public void OnTick() { }

        public void OnEvent(EventContext ctx)
        {
            if (ctx.Kind != "streamUpdate") return;
            var s = SettingsManager.Instance.Current;
            if (!s.Modules.AutoPoll) return;

            var newGame = ctx.Get<string>("category", ctx.Get<string>("game", null));
            if (string.IsNullOrEmpty(newGame)) return;
            if (string.Equals(newGame, _lastCategory, StringComparison.OrdinalIgnoreCase)) return;
            _lastCategory = newGame;

            if ((DateTime.UtcNow - _lastFiredUtc).TotalMinutes < 30) return;
            _lastFiredUtc = DateTime.UtcNow;

            // Best-effort native poll on Twitch via CPH; falls back to a chat post.
            // CPH's signature varies between SB versions, so we keep this loose.
            try
            {
                // The SB API doesn't reliably expose CreatePoll across versions, so we
                // ship the chat fallback unconditionally. If you want native polls, add
                // a single SB sub-action subscribed to bus event "autopoll.requested".
                AquiloBus.Instance.Publish("autopoll.requested", new
                {
                    title = "Hyped for " + newGame + "?",
                    options = new[] { "Let's gooo 🚀", "Sure, why not", "Bring back the last game", "Just here to lurk" },
                    durationSec = 120
                });

                var msg = "📊 Switching to " + newGame + " — react in chat: 🚀 hype, 🤷 meh, ↩ bring back last game.";
                new MultiPlatformSender(CphPlatformSender.Instance).Send(PlatformMask.All, msg, s.Platforms);
            }
            catch (Exception ex) { SbBridge.Instance.LogError("[Loadout] AutoPoll: " + ex.Message); }
        }
    }
}
