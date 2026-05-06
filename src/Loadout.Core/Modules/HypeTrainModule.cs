using System;
using Loadout.Bus;
using Loadout.Patreon;
using Loadout.Sb;
using Loadout.Settings;

namespace Loadout.Modules
{
    /// <summary>
    /// Cross-platform hype train. Aggregates "fuel" from sub / resub /
    /// gift-sub / cheer / raid / super-chat / TikTok-gift / Kick-sub events
    /// across every platform Loadout listens to. When the running fuel
    /// total crosses a level threshold, the train levels up; when fuel
    /// decays to zero (no contributions for a while), the train ends and
    /// a CooldownMinutes window opens during which contributions are
    /// ignored.
    ///
    /// Runs alongside Twitch's native hype train rather than replacing it
    /// — the streamer can have both visible at once. Independent of any
    /// platform-specific hype mechanic; even if no platform has a built-in
    /// hype train, this one works on raw spend.
    ///
    /// Bus events published:
    ///   hypetrain.start      { level, fuel, threshold, maxLevel }
    ///   hypetrain.contribute { user, kind, fuel, totalFuel, level }
    ///   hypetrain.level      { level, fuel, threshold, maxLevel, fromUser }
    ///   hypetrain.end        { finalLevel, totalFuel, durationMs, cooldownUntilUtc }
    /// </summary>
    public sealed class HypeTrainModule : IEventModule
    {
        private readonly object _gate = new object();

        private DateTime _trainStartUtc = DateTime.MinValue;
        private DateTime _lastContribUtc = DateTime.MinValue;
        private long _fuel;
        private int  _level;
        private bool _active;
        private DateTime _cooldownUntilUtc = DateTime.MinValue;

        public void OnEvent(EventContext ctx)
        {
            var s = SettingsManager.Instance.Current;
            if (!s.Modules.TikTokHypeTrain) return;
            if (!Entitlements.IsUnlocked(Feature.TikTokHypeTrain)) return;

            int fuel = FuelFromEvent(ctx);
            if (fuel <= 0) return;

            var now = DateTime.UtcNow;
            lock (_gate)
            {
                // Drop contributions during cooldown — no new train starts
                // and the existing (ended) train doesn't reignite.
                if (now < _cooldownUntilUtc) return;

                if (!_active)
                {
                    _active = true;
                    _trainStartUtc = now;
                    _fuel = fuel;
                    _level = 1;
                    _lastContribUtc = now;
                    AquiloBus.Instance.Publish("hypetrain.start", new
                    {
                        level     = _level,
                        fuel      = _fuel,
                        threshold = s.HypeTrain.LevelThreshold,
                        maxLevel  = s.HypeTrain.MaxLevel,
                        fromUser  = ctx.Get<string>("user", ""),
                        kind      = ctx.Kind,
                        ts        = now
                    });
                    return;
                }

                _fuel += fuel;
                _lastContribUtc = now;

                var threshold = Math.Max(1, s.HypeTrain.LevelThreshold);
                var newLevel = (int)(_fuel / threshold) + 1;
                if (newLevel > s.HypeTrain.MaxLevel) newLevel = s.HypeTrain.MaxLevel;

                if (newLevel > _level)
                {
                    _level = newLevel;
                    AquiloBus.Instance.Publish("hypetrain.level", new
                    {
                        level     = _level,
                        fuel      = _fuel,
                        threshold = s.HypeTrain.LevelThreshold,
                        maxLevel  = s.HypeTrain.MaxLevel,
                        fromUser  = ctx.Get<string>("user", ""),
                        kind      = ctx.Kind,
                        ts        = now
                    });
                    return;
                }

                AquiloBus.Instance.Publish("hypetrain.contribute", new
                {
                    user      = ctx.Get<string>("user", ""),
                    kind      = ctx.Kind,
                    fuel      = fuel,
                    totalFuel = _fuel,
                    level     = _level,
                    ts        = now
                });
                Util.EventStats.Instance.Hit(ctx.Kind, nameof(HypeTrainModule));
            }
        }

        public void OnTick()
        {
            var s = SettingsManager.Instance.Current;
            if (!s.Modules.TikTokHypeTrain) return;

            DateTime now = DateTime.UtcNow;
            lock (_gate)
            {
                if (!_active) return;

                // Idle decay: fuel drops at DecayPerMinute. If it bottoms,
                // end the train and start the cooldown.
                _fuel -= Math.Max(0, s.HypeTrain.DecayPerMinute);
                if (_fuel <= 0)
                {
                    var dur = (long)(now - _trainStartUtc).TotalMilliseconds;
                    var finalLevel = _level;
                    var cooldownEnds = now.AddMinutes(Math.Max(0, s.HypeTrain.CooldownMinutes));

                    _active = false;
                    _fuel = 0;
                    _level = 0;
                    _cooldownUntilUtc = cooldownEnds;

                    AquiloBus.Instance.Publish("hypetrain.end", new
                    {
                        finalLevel        = finalLevel,
                        durationMs        = dur,
                        cooldownUntilUtc  = cooldownEnds,
                        cooldownMinutes   = s.HypeTrain.CooldownMinutes,
                        ts                = now
                    });

                    if (s.HypeTrain.AnnounceEnd && !string.IsNullOrEmpty(s.HypeTrain.EndTemplate))
                    {
                        // Best-effort chat post; module is overlay-first so
                        // we don't fail the publish if chat isn't wired.
                        try
                        {
                            var msg = s.HypeTrain.EndTemplate.Replace("{level}", finalLevel.ToString());
                            var sender = new Loadout.Platforms.MultiPlatformSender(Loadout.Platforms.CphPlatformSender.Instance);
                            sender.Send(s.Platforms.AsMask, msg, s.Platforms);
                        }
                        catch { }
                    }
                }
            }
        }

        // Convert each platform's contribution into a fuel value. Tier-aware
        // for subs / gifts; conservative on raid + super-chat to avoid one
        // mega-event saturating the train instantly.
        private static int FuelFromEvent(EventContext ctx)
        {
            switch (ctx.Kind)
            {
                case "sub":
                case "resub":
                    return TierFuel(ctx.Get<string>("tier", "1"));

                case "giftSub":
                {
                    var count = ctx.Get<int>("count", 1);
                    var perGift = (int)(TierFuel(ctx.Get<string>("tier", "1")) * 0.8);
                    return Math.Max(1, perGift) * Math.Max(1, count);
                }

                case "cheer":
                    return ctx.Get<int>("bits", 0) / 10;

                case "raid":
                    return Math.Min(150, Math.Max(0, ctx.Get<int>("viewers", 0)));

                case "superChat":
                {
                    var amt = ctx.Get<string>("amount", "0");
                    var clean = (amt ?? "0").Trim().TrimStart('$').Replace(",", "");
                    if (decimal.TryParse(clean, System.Globalization.NumberStyles.Float,
                        System.Globalization.CultureInfo.InvariantCulture, out var d))
                        return (int)(d * 5m);
                    return 0;
                }

                case "tiktokGift":
                    return Math.Max(0, ctx.Get<int>("coins", 0));

                case "kickSub":
                    return 100;

                case "kickGift":
                    return 80 * Math.Max(1, ctx.Get<int>("count", 1));

                default:
                    return 0;
            }
        }

        private static int TierFuel(string tier)
        {
            switch ((tier ?? "1").Trim())
            {
                case "3":
                case "3000":
                    return 500;
                case "2":
                case "2000":
                    return 250;
                default:
                    return 100;
            }
        }
    }
}
