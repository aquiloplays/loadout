using System;
using System.Collections.Generic;
using System.Linq;
using Loadout.Bus;
using Loadout.Games.Dungeon;
using Loadout.Patreon;
using Loadout.Sb;
using Loadout.Settings;

namespace Loadout.Modules
{
    /// <summary>
    /// Hype train — actually TWO trains running side by side:
    ///
    ///   • Cross-platform  — fuelled by sub / resub / gift-sub / cheer /
    ///     raid / super-chat / TikTok-gift / Kick-sub from EVERY platform
    ///     Loadout listens to. Publishes <c>hypetrain.*</c> with
    ///     <c>source="all"</c>. This is the canonical train; it's the one
    ///     that drops dungeon loot to contributors when it ends.
    ///
    ///   • Twitch-only     — fuelled exclusively by Twitch-sourced events.
    ///     Publishes <c>hypetrain.*</c> with <c>source="twitch"</c> so a
    ///     dedicated overlay (?source=twitch) can render the native-Twitch
    ///     train independently of the aggregate. Display-only — it does
    ///     NOT drop loot (the cross-platform train already covers the
    ///     Twitch contributors). Gated by HypeTrainConfig.TwitchOnlyTrain.
    ///
    /// Each train is a self-contained <see cref="TrainState"/>: fuel /
    /// level / cooldown plus a contributor ledger so the end event can
    /// reward everyone who chipped in.
    ///
    /// Bus events (every event carries a "source" field — "all"|"twitch"):
    ///   hypetrain.start      { level, fuel, threshold, maxLevel, source }
    ///   hypetrain.contribute { user, kind, fuel, totalFuel, level, source }
    ///   hypetrain.level      { level, fuel, threshold, maxLevel, source }
    ///   hypetrain.end        { finalLevel, totalFuel, durationMs,
    ///                          cooldownUntilUtc, lootDrops[], source }
    /// </summary>
    public sealed class HypeTrainModule : IEventModule
    {
        private readonly TrainState _all    = new TrainState("all",    dropsLoot: true);
        private readonly TrainState _twitch = new TrainState("twitch", dropsLoot: false);

        public void OnEvent(EventContext ctx)
        {
            var s = SettingsManager.Instance.Current;
            if (!s.Modules.TikTokHypeTrain) return;

            int fuel = FuelFromEvent(ctx);
            if (fuel <= 0) return;

            var now      = DateTime.UtcNow;
            var user     = ctx.Get<string>("user", "");
            var platform = ctx.Platform.ToShortName();

            // Cross-platform train always sees the contribution.
            _all.Feed(s, now, fuel, user, platform, ctx);

            // Twitch-only train sees it only when the source platform is
            // Twitch. Uses a bitwise test so a multi-bit mask still
            // resolves correctly.
            if (s.HypeTrain.TwitchOnlyTrain && (ctx.Platform & PlatformMask.Twitch) != 0)
                _twitch.Feed(s, now, fuel, user, platform, ctx);

            Util.EventStats.Instance.Hit(ctx.Kind, nameof(HypeTrainModule));
        }

        public void OnTick()
        {
            var s = SettingsManager.Instance.Current;
            if (!s.Modules.TikTokHypeTrain) return;
            var now = DateTime.UtcNow;
            _all.Tick(s, now);
            if (s.HypeTrain.TwitchOnlyTrain) _twitch.Tick(s, now);
        }

        // ── One train's state machine ───────────────────────────────────
        private sealed class TrainState
        {
            private readonly object _gate = new object();
            private readonly string _source;     // "all" | "twitch"
            private readonly bool   _dropsLoot;

            private DateTime _trainStartUtc   = DateTime.MinValue;
            private DateTime _lastContribUtc  = DateTime.MinValue;
            private DateTime _cooldownUntilUtc = DateTime.MinValue;
            private long _fuel;
            private int  _level;
            private bool _active;
            // Contributor ledger — key "platform:user" → running fuel +
            // identity. Reset each train; consumed by the end event to
            // hand out bolts (recent-contributor reward) and dungeon loot.
            private readonly Dictionary<string, Contributor> _contributors =
                new Dictionary<string, Contributor>(StringComparer.OrdinalIgnoreCase);

            public TrainState(string source, bool dropsLoot)
            {
                _source = source;
                _dropsLoot = dropsLoot;
            }

            public void Feed(LoadoutSettings s, DateTime now, int fuel,
                             string user, string platform, EventContext ctx)
            {
                lock (_gate)
                {
                    if (now < _cooldownUntilUtc) return;   // cooldown — ignore

                    if (!_active)
                    {
                        _active = true;
                        _trainStartUtc = now;
                        _fuel = fuel;
                        _level = 1;
                        _lastContribUtc = now;
                        _contributors.Clear();
                        Record(user, platform, fuel);
                        AquiloBus.Instance.Publish("hypetrain.start", new
                        {
                            level     = _level,
                            fuel      = _fuel,
                            threshold = s.HypeTrain.LevelThreshold,
                            maxLevel  = s.HypeTrain.MaxLevel,
                            fromUser  = user,
                            kind      = ctx.Kind,
                            source    = _source,
                            ts        = now
                        });
                        return;
                    }

                    _fuel += fuel;
                    _lastContribUtc = now;
                    Record(user, platform, fuel);

                    var threshold = Math.Max(1, s.HypeTrain.LevelThreshold);
                    var newLevel  = (int)(_fuel / threshold) + 1;
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
                            fromUser  = user,
                            kind      = ctx.Kind,
                            source    = _source,
                            ts        = now
                        });
                        return;
                    }

                    AquiloBus.Instance.Publish("hypetrain.contribute", new
                    {
                        user      = user,
                        kind      = ctx.Kind,
                        fuel      = fuel,
                        totalFuel = _fuel,
                        level     = _level,
                        giftName  = ctx.Get<string>("giftName", null),
                        giftId    = ctx.Get<string>("giftId", null),
                        coins     = ctx.Get<int>("coins", 0),
                        source    = _source,
                        ts        = now
                    });
                }
            }

            public void Tick(LoadoutSettings s, DateTime now)
            {
                lock (_gate)
                {
                    if (!_active) return;

                    _fuel -= Math.Max(0, s.HypeTrain.DecayPerMinute);
                    if (_fuel > 0) return;

                    // Train ran out of fuel — end it.
                    var dur          = (long)(now - _trainStartUtc).TotalMilliseconds;
                    var finalLevel   = _level;
                    var cooldownEnds = now.AddMinutes(Math.Max(0, s.HypeTrain.CooldownMinutes));
                    var crew         = _contributors.Values.ToList();

                    _active = false;
                    _fuel = 0;
                    _level = 0;
                    _cooldownUntilUtc = cooldownEnds;
                    _contributors.Clear();

                    // Dungeon loot — only the loot-bearing (cross-platform)
                    // train hands out items, and only when the streamer
                    // hasn't opted out. Build the drop list before the
                    // publish so the end event can carry a summary.
                    List<object> lootSummary = null;
                    if (_dropsLoot && s.HypeTrain.DropDungeonLoot && finalLevel >= 1 && crew.Count > 0)
                        lootSummary = DropLoot(crew, finalLevel, s.HypeTrain.MaxLevel);

                    AquiloBus.Instance.Publish("hypetrain.end", new
                    {
                        finalLevel       = finalLevel,
                        durationMs       = dur,
                        cooldownUntilUtc = cooldownEnds,
                        cooldownMinutes  = s.HypeTrain.CooldownMinutes,
                        contributors     = crew.Count,
                        lootDrops        = lootSummary,
                        source           = _source,
                        ts               = now
                    });

                    if (s.HypeTrain.AnnounceEnd && !string.IsNullOrEmpty(s.HypeTrain.EndTemplate))
                    {
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

            private void Record(string user, string platform, int fuel)
            {
                if (string.IsNullOrEmpty(user)) return;
                var key = (platform ?? "?") + ":" + user.ToLowerInvariant();
                if (_contributors.TryGetValue(key, out var c)) c.Fuel += fuel;
                else _contributors[key] = new Contributor { Platform = platform, User = user, Fuel = fuel };
            }

            // Drop one dungeon item per contributor. Rarity scales with
            // the final train level; the loot picker reaches the hype-
            // train-exclusive legendaries/mythics for high trains.
            private List<object> DropLoot(List<Contributor> crew, int finalLevel, int maxLevel)
            {
                var summary = new List<object>();
                var rng = new Random();
                foreach (var c in crew)
                {
                    try
                    {
                        var def = DungeonContent.PickHypeTrainLoot(rng, finalLevel, maxLevel);
                        if (def == null) continue;
                        var item = new InventoryItem
                        {
                            Id           = Guid.NewGuid().ToString("N"),
                            Slot         = def.Slot,
                            Rarity       = def.Rarity,
                            Name         = def.Name,
                            Glyph        = def.Glyph,
                            PowerBonus   = def.PowerBonus,
                            DefenseBonus = def.DefenseBonus,
                            GoldValue    = def.GoldValue,
                            SetName        = def.SetName        ?? "",
                            PreferredClass = def.PreferredClass ?? "",
                            WeaponType     = def.WeaponType     ?? "",
                            Ability        = def.Ability        ?? "",
                            FoundIn      = "Hype Train",
                            FoundUtc     = DateTime.UtcNow
                        };
                        DungeonGameStore.Instance.GrantLoot(c.Platform, c.User, item);
                        summary.Add(new
                        {
                            user   = c.User,
                            item   = def.Name,
                            glyph  = def.Glyph,
                            rarity = def.Rarity
                        });
                    }
                    catch (Exception ex) { Util.ErrorLog.Write("HypeTrain.DropLoot", ex); }
                }
                return summary;
            }
        }

        private sealed class Contributor
        {
            public string Platform;
            public string User;
            public long   Fuel;
        }

        // ── Fuel valuation ──────────────────────────────────────────────
        // Convert each platform's contribution into a fuel value. Tier-
        // aware for subs / gifts; conservative on raid + super-chat so
        // one mega-event doesn't instantly saturate the train.
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
