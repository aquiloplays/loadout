using System;
using Loadout.Bus;
using Loadout.Patreon;
using Loadout.Platforms;
using Loadout.Sb;
using Loadout.Settings;

namespace Loadout.Modules
{
    /// <summary>
    /// "Sub raid train" — when several subs (real, resub, gift, or YouTube
    /// member) hit within 60 seconds, fire a synthetic train event the
    /// overlay can react to.
    ///
    /// Distinct from Twitch's hype-train (which is bits-only on most
    /// channels). Free tier; the overlay itself is part of the same OBS
    /// browser source family as check-in / counters.
    /// </summary>
    public sealed class SubRaidTrainModule : IEventModule
    {
        private const int WindowSeconds = 60;
        private const int MinSubsToFire = 3;
        private static readonly int[] TierThresholds = { 3, 6, 10, 20 };

        private DateTime _windowStartUtc = DateTime.MinValue;
        private int _subsInWindow;
        private int _currentTier;

        public void OnTick()
        {
            if (_currentTier > 0 && (DateTime.UtcNow - _windowStartUtc).TotalSeconds > WindowSeconds + 30)
            {
                AquiloBus.Instance.Publish("sub.train.ended", new
                {
                    finalTier = _currentTier,
                    subsInWindow = _subsInWindow,
                    durationSec = (int)(DateTime.UtcNow - _windowStartUtc).TotalSeconds
                });
                _currentTier = 0;
                _subsInWindow = 0;
            }
        }

        public void OnEvent(EventContext ctx)
        {
            if (ctx.Kind != "sub" && ctx.Kind != "resub" && ctx.Kind != "giftSub") return;

            var add = ctx.Kind == "giftSub" ? Math.Max(1, ctx.Get<int>("count", 1)) : 1;

            // Reset the rolling window if it expired.
            if ((DateTime.UtcNow - _windowStartUtc).TotalSeconds > WindowSeconds)
            {
                _windowStartUtc = DateTime.UtcNow;
                _subsInWindow = 0;
                if (_currentTier > 0)
                {
                    AquiloBus.Instance.Publish("sub.train.ended", new { finalTier = _currentTier, subsInWindow = _subsInWindow });
                    _currentTier = 0;
                }
            }

            _subsInWindow += add;
            if (_subsInWindow < MinSubsToFire) return;

            int newTier = 0;
            for (int i = TierThresholds.Length - 1; i >= 0; i--)
                if (_subsInWindow >= TierThresholds[i]) { newTier = i + 1; break; }

            if (newTier > _currentTier)
            {
                _currentTier = newTier;
                AquiloBus.Instance.Publish("sub.train.tier", new
                {
                    tier = newTier,
                    subsInWindow = _subsInWindow,
                    contributor = ctx.User
                });
            }
            else
            {
                AquiloBus.Instance.Publish("sub.train.contributed", new
                {
                    tier = _currentTier,
                    subsInWindow = _subsInWindow,
                    contributor = ctx.User
                });
            }
        }
    }
}
