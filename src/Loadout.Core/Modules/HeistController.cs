using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Loadout.Bolts;
using Loadout.Bus;
using Loadout.Platforms;
using Loadout.Sb;
using Loadout.Settings;
using Loadout.Util;

namespace Loadout.Modules
{
    /// <summary>
    /// Community heist event — !heist starts a 60-second window where every
    /// viewer in chat can !join with their own stake. If the pot crosses
    /// HeistConfig.HeistTargetPot by deadline, the crew splits
    /// (TargetPot × PayoutMultiplier) proportional to each contributor's
    /// stake. If the pot falls short, every contribution is lost.
    ///
    /// Why a singleton: there's at most one heist running globally at a
    /// time (a chat-wide event, not per-platform), so a static
    /// controller with a single in-flight state field is the simplest
    /// model and matches how viewers experience it ("the heist is on" /
    /// "no heist is running").
    ///
    /// State transitions:
    ///   Idle         → Active   on !heist (if no heist + cooldown ok)
    ///   Active       → Settling on deadline tick
    ///   Settling     → Idle     after success/failure scenes published
    ///
    /// Bus events published (overlays subscribe + render):
    ///   bolts.heist.start       { initiator, target, deadlineUtc, multiplier }
    ///   bolts.heist.contribute  { user, stake, totalPot, target, contributors }
    ///   bolts.heist.success     { totalPot, payout, splits[{user,stake,payout}] }
    ///   bolts.heist.failure     { totalPot, target, splits[{user,stake}] }
    /// </summary>
    public sealed class HeistController
    {
        private static readonly Lazy<HeistController> _instance =
            new Lazy<HeistController>(() => new HeistController(), LazyThreadSafetyMode.ExecutionAndPublication);
        public static HeistController Instance => _instance.Value;

        private readonly object _gate = new object();
        private HeistState _active;                                       // null when idle
        private DateTime _lastEndedUtc = DateTime.MinValue;               // for global cooldown
        private readonly Dictionary<string, DateTime> _initiatorCooldowns = // platform:user → next-allowed UTC
            new Dictionary<string, DateTime>(StringComparer.OrdinalIgnoreCase);

        // Settlement timer — fires once per heist when the join window
        // closes. Stored on the controller so a re-entry attempt during
        // an active heist doesn't spawn duplicate settlements.
        private Timer _settleTimer;

        private HeistController() { }

        public void HandleStart(EventContext ctx, string rest, LoadoutSettings s)
        {
            // Wager parse — `!heist <amount>`. Amount must be in bounds
            // and the initiator must have enough bolts.
            if (!long.TryParse((rest ?? "").Trim(), out var stake) ||
                stake < s.Bolts.HeistMinStake || stake > s.Bolts.HeistMaxStake)
            {
                if (ChatGate.TrySend(ChatGate.Area.Bolts, "heist:usage", TimeSpan.FromSeconds(2)))
                    new MultiPlatformSender(CphPlatformSender.Instance).Send(ctx.Platform,
                        "@" + ctx.User + " usage: !heist <stake> (" +
                        s.Bolts.HeistMinStake + "-" + s.Bolts.HeistMaxStake + " " + s.Bolts.Emoji + ")",
                        s.Platforms);
                return;
            }

            DateTime now = DateTime.UtcNow;
            string userKey = ctx.Platform.ToShortName() + ":" + ctx.User.ToLowerInvariant();

            lock (_gate)
            {
                // Already running? Just route them into !join with that stake instead.
                if (_active != null)
                {
                    if (ChatGate.TrySend(ChatGate.Area.Bolts, "heist:already-running", TimeSpan.FromSeconds(2)))
                        new MultiPlatformSender(CphPlatformSender.Instance).Send(ctx.Platform,
                            "@" + ctx.User + " a heist is already on — type !join " + stake + " to chip in.",
                            s.Platforms);
                    return;
                }
                // Global cooldown — keeps back-to-back heists from
                // dominating chat (and gives the wallet a beat to recover).
                var sinceEnded = (now - _lastEndedUtc).TotalSeconds;
                if (sinceEnded < s.Bolts.HeistGlobalCooldownSec)
                {
                    var wait = (int)(s.Bolts.HeistGlobalCooldownSec - sinceEnded);
                    if (ChatGate.TrySend(ChatGate.Area.Bolts, "heist:cooldown-global", TimeSpan.FromSeconds(2)))
                        new MultiPlatformSender(CphPlatformSender.Instance).Send(ctx.Platform,
                            "@" + ctx.User + " the crew is laying low — " + wait + "s until the next heist.",
                            s.Platforms);
                    return;
                }
                // Per-initiator cooldown — same person can't keep starting
                // heists. The gate is on the INITIATOR; joining doesn't
                // add to the cooldown.
                if (_initiatorCooldowns.TryGetValue(userKey, out var until) && until > now)
                {
                    var wait = (int)(until - now).TotalSeconds;
                    if (ChatGate.TrySend(ChatGate.Area.Bolts, "heist:cooldown-user", TimeSpan.FromSeconds(2)))
                        new MultiPlatformSender(CphPlatformSender.Instance).Send(ctx.Platform,
                            "@" + ctx.User + " you can't start another heist for " + wait + "s.",
                            s.Platforms);
                    return;
                }

                // Charge the stake up-front. If they're broke, bail.
                var platform = ctx.Platform.ToShortName();
                if (!BoltsWallet.Instance.Spend(platform, ctx.User, stake, "heist:stake"))
                {
                    var bal = BoltsWallet.Instance.Balance(platform, ctx.User);
                    if (ChatGate.TrySend(ChatGate.Area.Bolts, "heist:nofunds:" + userKey, TimeSpan.FromSeconds(3)))
                        new MultiPlatformSender(CphPlatformSender.Instance).Send(ctx.Platform,
                            "@" + ctx.User + " not enough " + s.Bolts.Emoji +
                            " (" + bal + " / " + stake + " needed).",
                            s.Platforms);
                    return;
                }

                _active = new HeistState
                {
                    Initiator         = ctx.User,
                    InitiatorPlatform = platform,
                    StartedUtc        = now,
                    DeadlineUtc       = now.AddSeconds(s.Bolts.HeistJoinWindowSec),
                    TargetPot         = s.Bolts.HeistTargetPot,
                    PayoutMultiplier  = s.Bolts.HeistPayoutMultiplier,
                    Contributors      = new Dictionary<string, HeistContributor>(StringComparer.OrdinalIgnoreCase),
                };
                _active.Add(platform, ctx.User, stake);
                _initiatorCooldowns[userKey] = now.AddSeconds(s.Bolts.HeistPerUserCooldownSec);

                // Schedule settlement at deadline. Slight buffer so the
                // last !join right at the wire still gets in.
                var ms = (int)Math.Max(1000, (s.Bolts.HeistJoinWindowSec * 1000));
                _settleTimer?.Dispose();
                _settleTimer = new Timer(_ => SettleSafe(s), null, ms, Timeout.Infinite);

                AquiloBus.Instance.Publish("bolts.heist.start", new
                {
                    initiator    = ctx.User,
                    platform     = platform,
                    stake        = stake,
                    target       = _active.TargetPot,
                    deadlineUtc  = _active.DeadlineUtc,
                    deadlineMs   = (long)(_active.DeadlineUtc - DateTime.UtcNow).TotalMilliseconds,
                    multiplier   = _active.PayoutMultiplier,
                    totalPot     = _active.TotalPot
                });

                if (ChatGate.TrySend(ChatGate.Area.Bolts, "heist:start", TimeSpan.FromSeconds(2)))
                    new MultiPlatformSender(CphPlatformSender.Instance).Send(ctx.Platform,
                        "🦹 @" + ctx.User + " is pulling a heist! Pot " + stake + "/" + _active.TargetPot +
                        " " + s.Bolts.Emoji + " — type !join <stake> in the next " + s.Bolts.HeistJoinWindowSec + "s.",
                        s.Platforms);
            }
        }

        public void HandleJoin(EventContext ctx, string rest, LoadoutSettings s)
        {
            if (!long.TryParse((rest ?? "").Trim(), out var stake) ||
                stake < s.Bolts.HeistMinStake || stake > s.Bolts.HeistMaxStake)
            {
                if (ChatGate.TrySend(ChatGate.Area.Bolts, "heist:join:usage", TimeSpan.FromSeconds(2)))
                    new MultiPlatformSender(CphPlatformSender.Instance).Send(ctx.Platform,
                        "@" + ctx.User + " usage: !join <stake> (" +
                        s.Bolts.HeistMinStake + "-" + s.Bolts.HeistMaxStake + " " + s.Bolts.Emoji + ")",
                        s.Platforms);
                return;
            }

            lock (_gate)
            {
                if (_active == null)
                {
                    // Silent — !join without an active heist is just chatter,
                    // we don't want to spam "no heist" replies every time.
                    return;
                }
                if (DateTime.UtcNow >= _active.DeadlineUtc) return;     // window closed; settle is in flight

                var platform = ctx.Platform.ToShortName();
                if (!BoltsWallet.Instance.Spend(platform, ctx.User, stake, "heist:join"))
                {
                    if (ChatGate.TrySend(ChatGate.Area.Bolts, "heist:join:nofunds:" + ctx.User, TimeSpan.FromSeconds(3)))
                        new MultiPlatformSender(CphPlatformSender.Instance).Send(ctx.Platform,
                            "@" + ctx.User + " not enough " + s.Bolts.Emoji + " to join.",
                            s.Platforms);
                    return;
                }
                _active.Add(platform, ctx.User, stake);

                AquiloBus.Instance.Publish("bolts.heist.contribute", new
                {
                    user         = ctx.User,
                    platform     = platform,
                    stake        = stake,
                    totalPot     = _active.TotalPot,
                    target       = _active.TargetPot,
                    contributors = _active.Contributors.Count,
                    msRemaining  = (long)Math.Max(0, (_active.DeadlineUtc - DateTime.UtcNow).TotalMilliseconds)
                });

                // Tasteful chat reply — not every join, the bus event
                // drives the overlay update. Only confirm milestones
                // (50%, 100% of target) so chat doesn't drown.
                long potBefore = _active.TotalPot - stake;
                long target    = _active.TargetPot;
                bool crossedHalf = potBefore < (target / 2) && _active.TotalPot >= (target / 2);
                bool crossedFull = potBefore < target          && _active.TotalPot >= target;
                if ((crossedFull || crossedHalf) &&
                    ChatGate.TrySend(ChatGate.Area.Bolts, "heist:milestone", TimeSpan.FromSeconds(2)))
                {
                    new MultiPlatformSender(CphPlatformSender.Instance).Send(ctx.Platform,
                        crossedFull
                            ? "🦹 Pot's at " + _active.TotalPot + "/" + target + " " + s.Bolts.Emoji + " — heist's on track!"
                            : "🦹 Halfway there — " + _active.TotalPot + "/" + target + " " + s.Bolts.Emoji + ".",
                        s.Platforms);
                }
            }
        }

        private void SettleSafe(LoadoutSettings s)
        {
            try { Settle(s); }
            catch (Exception ex) { ErrorLog.Write("HeistController.Settle", ex); }
        }

        private void Settle(LoadoutSettings s)
        {
            HeistState state;
            lock (_gate)
            {
                state = _active;
                _active = null;
                _lastEndedUtc = DateTime.UtcNow;
            }
            if (state == null) return;

            bool success = state.TotalPot >= state.TargetPot;
            if (success)
            {
                // Each contributor's payout is proportional to their
                // stake share of the total pot. Total payout pool =
                // TargetPot × multiplier (NOT TotalPot × multiplier —
                // overshoot doesn't compound, otherwise viewers would
                // pile in to inflate their cut).
                long totalPayout = (long)Math.Round(state.TargetPot * state.PayoutMultiplier);
                long totalStake  = state.TotalPot;
                var splits = new List<object>();
                foreach (var c in state.Contributors.Values)
                {
                    long share = totalStake > 0
                        ? (long)Math.Round(totalPayout * (c.Stake / (double)totalStake))
                        : 0;
                    if (share > 0) BoltsWallet.Instance.Earn(c.Platform, c.User, share, "heist:payout");
                    splits.Add(new { user = c.User, platform = c.Platform, stake = c.Stake, payout = share });
                }
                AquiloBus.Instance.Publish("bolts.heist.success", new
                {
                    initiator    = state.Initiator,
                    totalPot     = state.TotalPot,
                    target       = state.TargetPot,
                    payout       = totalPayout,
                    contributors = state.Contributors.Count,
                    multiplier   = state.PayoutMultiplier,
                    splits       = splits
                });

                // Top-line chat summary — one ChatGate slot, doesn't
                // shout out every contributor (overlay covers that).
                if (ChatGate.TrySend(ChatGate.Area.Bolts, "heist:result", TimeSpan.FromSeconds(2)))
                    new MultiPlatformSender(CphPlatformSender.Instance).Send(
                        PlatformMaskExtensions.FromShortName(state.InitiatorPlatform),
                        "💰 HEIST SUCCESS — pot " + state.TotalPot + " " + s.Bolts.Emoji +
                        " split into " + totalPayout + " " + s.Bolts.Emoji +
                        " across " + state.Contributors.Count + " crewmates.",
                        s.Platforms);
            }
            else
            {
                var splits = state.Contributors.Values
                    .Select(c => (object)new { user = c.User, platform = c.Platform, stake = c.Stake })
                    .ToList();
                AquiloBus.Instance.Publish("bolts.heist.failure", new
                {
                    initiator    = state.Initiator,
                    totalPot     = state.TotalPot,
                    target       = state.TargetPot,
                    contributors = state.Contributors.Count,
                    splits       = splits
                });

                if (ChatGate.TrySend(ChatGate.Area.Bolts, "heist:result", TimeSpan.FromSeconds(2)))
                    new MultiPlatformSender(CphPlatformSender.Instance).Send(
                        PlatformMaskExtensions.FromShortName(state.InitiatorPlatform),
                        "🚨 HEIST FAILED — pot " + state.TotalPot + "/" + state.TargetPot + " " + s.Bolts.Emoji +
                        ". The crew got nothing.",
                        s.Platforms);
            }

            _settleTimer?.Dispose();
            _settleTimer = null;
        }

        // ── State types ────────────────────────────────────────────────
        private sealed class HeistState
        {
            public string   Initiator;
            public string   InitiatorPlatform;
            public DateTime StartedUtc;
            public DateTime DeadlineUtc;
            public long     TargetPot;
            public double   PayoutMultiplier;
            public Dictionary<string, HeistContributor> Contributors;
            public long TotalPot
            {
                get
                {
                    long t = 0;
                    foreach (var c in Contributors.Values) t += c.Stake;
                    return t;
                }
            }
            public void Add(string platform, string user, long stake)
            {
                var key = (platform ?? "?") + ":" + (user ?? "").ToLowerInvariant();
                if (Contributors.TryGetValue(key, out var existing))
                {
                    existing.Stake += stake;
                }
                else
                {
                    Contributors[key] = new HeistContributor { Platform = platform, User = user, Stake = stake };
                }
            }
        }

        private sealed class HeistContributor
        {
            public string Platform;
            public string User;
            public long   Stake;
        }
    }
}
