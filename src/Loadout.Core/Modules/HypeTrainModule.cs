using System;
using Loadout.Patreon;
using Loadout.Platforms;
using Loadout.Sb;
using Loadout.Settings;

namespace Loadout.Modules
{
    /// <summary>
    /// Synthetic hype-train for TikTok (and any other platform that lacks one
    /// natively). Counts gift coin throughput in a sliding window — when it
    /// crosses tier thresholds, fires a hype-on/level-up event the overlay or
    /// other modules can react to.
    ///
    /// Placeholder logic for v1: just logs tier changes. Phase 2 wires a WS
    /// broadcast that an OBS overlay subscribes to.
    /// </summary>
    public sealed class HypeTrainModule : IEventModule
    {
        private const int WindowSeconds = 300;     // 5-minute rolling
        private static readonly int[] TierCoins = { 200, 500, 1500, 3000, 6000 };

        private DateTime _windowStartUtc = DateTime.UtcNow;
        private long _windowCoins;
        private int _currentTier;

        public void OnTick()
        {
            // Decay: if no gifts in the last window, reset.
            if ((DateTime.UtcNow - _windowStartUtc).TotalSeconds > WindowSeconds && _currentTier > 0)
            {
                SbBridge.Instance.LogInfo($"[Loadout] Hype train ended (was tier {_currentTier}).");
                _windowCoins = 0;
                _currentTier = 0;
            }
        }

        public void OnEvent(EventContext ctx)
        {
            if (ctx.Kind != "tiktokGift") return;
            var s = SettingsManager.Instance.Current;
            if (!s.Modules.TikTokHypeTrain) return;
            if (!Entitlements.IsUnlocked(Feature.TikTokHypeTrain)) return;

            var coins = ctx.Get<int>("coins", 0);
            if (coins <= 0) return;

            if ((DateTime.UtcNow - _windowStartUtc).TotalSeconds > WindowSeconds)
            {
                _windowStartUtc = DateTime.UtcNow;
                _windowCoins = 0;
                _currentTier = 0;
            }

            _windowCoins += coins;

            int newTier = 0;
            for (int i = TierCoins.Length - 1; i >= 0; i--)
                if (_windowCoins >= TierCoins[i]) { newTier = i + 1; break; }

            if (newTier > _currentTier)
            {
                _currentTier = newTier;
                SbBridge.Instance.LogInfo($"[Loadout] 🚂 Hype train tier {newTier} reached ({_windowCoins} coins in window).");
            }
        }
    }
}
