using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Loadout.Bus;
using Loadout.Games.Interactions;
using Loadout.Platforms;
using Loadout.Sb;
using Loadout.Settings;
using Loadout.Util;

namespace Loadout.Modules
{
    /// <summary>
    /// "Crowd Control"-style game interactions. Wires three trigger
    /// sources (chat commands, Twitch channel-point redemptions, TikTok
    /// gifts) to keyboard / mouse actions sent via Win32 SendInput.
    ///
    /// Guard rails:
    ///   - Foreground-window match  (no typing into Discord on focus-loss)
    ///   - Per-action global + per-user cooldowns
    ///   - Role gate for command triggers
    ///   - Probability roll (randomized triggers)
    ///   - Channel-wide actions-per-second cap
    ///   - DryRun: log only, no real input
    ///   - Module enable + master Enabled inside GameInteractionsConfig
    ///
    /// Off by default. The streamer opts in once they've set up their
    /// first action in Settings -> Game Interactions.
    /// </summary>
    public sealed class GameInteractionsModule : IEventModule
    {
        private readonly Dictionary<string, DateTime> _globalCooldowns = new Dictionary<string, DateTime>(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, DateTime> _userCooldowns   = new Dictionary<string, DateTime>(StringComparer.OrdinalIgnoreCase);
        private readonly object _lock = new object();
        // Rolling-second action count for the rate limiter.
        private readonly LinkedList<DateTime> _recentFires = new LinkedList<DateTime>();
        // Per-viewer rolling fires for the per-viewer rate cap.
        private readonly Dictionary<string, LinkedList<DateTime>> _perViewerFires
            = new Dictionary<string, LinkedList<DateTime>>(StringComparer.OrdinalIgnoreCase);
        private readonly Random _rng = new Random();

        // Tracks SB's streamOnline / streamOffline. Default true so a
        // mid-stream Loadout reload doesn't accidentally drop every
        // action — the user can flip RequireStreamOnline off if they
        // want fires even when SB hasn't reported online.
        private volatile bool _streamOnline = true;

        // Active profile when ProfileAutoSwitch is on. null = fallback
        // to the global cfg.Actions list. Swapped by the polling timer.
        private volatile GameInteractionProfile _activeProfile = null;
        private System.Threading.Timer _profilePoller;
        private string _lastForegroundSeen = "";

        public GameInteractionsModule()
        {
            // Foreground-window poller. Starts a 1-second tick; the
            // actual swap cadence is driven by the per-config
            // ProfilePollSec (we tick fast + skip work when the window
            // hasn't changed, so changing the cadence doesn't need a
            // module restart).
            _profilePoller = new System.Threading.Timer(_ => PollProfile(),
                null, 1000, 1000);
        }

        private void PollProfile()
        {
            try
            {
                var s = SettingsManager.Instance.Current;
                var cfg = s.GameInteractions;
                if (cfg == null || !cfg.ProfileAutoSwitch) { _activeProfile = null; return; }
                var pollSec = System.Math.Max(1, cfg.ProfilePollSec);
                // Only re-poll once every PollSec ticks. The timer
                // still fires at 1s; we just no-op in between.
                if ((DateTime.UtcNow.Ticks / System.TimeSpan.TicksPerSecond) % pollSec != 0) return;

                var fg = NativeInput.ForegroundWindowTitle();
                if (string.Equals(fg, _lastForegroundSeen, System.StringComparison.OrdinalIgnoreCase))
                    return;
                _lastForegroundSeen = fg ?? "";

                GameInteractionProfile matched = null;
                if (cfg.Profiles != null)
                {
                    foreach (var p in cfg.Profiles)
                    {
                        if (p == null || string.IsNullOrWhiteSpace(p.WindowMatch)) continue;
                        if (fg.IndexOf(p.WindowMatch, System.StringComparison.OrdinalIgnoreCase) >= 0)
                        { matched = p; break; }
                    }
                }
                if (!ReferenceEquals(matched, _activeProfile))
                {
                    _activeProfile = matched;
                    AquiloBus.Instance.Publish("loadout.gameactions.profile", new
                    {
                        active   = matched?.Name,
                        match    = matched?.WindowMatch,
                        window   = fg
                    });
                }
            }
            catch (Exception ex) { ErrorLog.Write("GameInteractions.PollProfile", ex); }
        }

        // Panic-pause window. When set in the future, every fire is
        // skipped + logged. Tray menu sets via PausUntil(); cleared
        // automatically when the timestamp passes.
        private static DateTime _pauseUntilUtc = DateTime.MinValue;
        /// <summary>Tray-menu entry suspends all action fires for the
        /// given number of minutes. 0 = clear pause.</summary>
        public static void PauseFor(TimeSpan duration)
        {
            var pausing = duration > TimeSpan.Zero;
            _pauseUntilUtc = pausing ? DateTime.UtcNow + duration : DateTime.MinValue;
            // Hitting pause refunds the last 30s of charges so viewers
            // aren't out money for a streamer-side stop. Clearing the
            // pause (Resume now) does NOT refund — the history is empty
            // by then anyway since pause already drained it.
            (int v, int t) refund = (0, 0);
            if (pausing) refund = RefundRecentCharges();
            try
            {
                AquiloBus.Instance.Publish("loadout.gameactions.pause", new
                {
                    untilUtc        = pausing ? (DateTime?)_pauseUntilUtc : null,
                    minutes         = duration.TotalMinutes,
                    cleared         = !pausing,
                    refundedViewers = refund.v,
                    refundedBolts   = refund.t
                });
            }
            catch { /* bus may be down; pause still applies */ }
        }
        public static bool IsPaused =>
            _pauseUntilUtc != DateTime.MinValue && DateTime.UtcNow < _pauseUntilUtc;
        public static DateTime PausedUntilUtc => _pauseUntilUtc;

        // Rolling replay buffer. Every fire pushes a (action, ctx) pair
        // onto the deque (cap 50). The tray "Replay last N" sub-menu
        // pops them back through FireAction. Useful for ad-hoc
        // highlight-reel moments off-stream.
        private static readonly System.Collections.Generic.LinkedList<ReplayEntry> _replayBuffer
            = new System.Collections.Generic.LinkedList<ReplayEntry>();
        private const int ReplayBufferCap = 50;

        private sealed class ReplayEntry
        {
            public GameAction Action  { get; set; }
            public DateTime   FiredAt { get; set; }
        }

        private static void RecordReplay(GameAction a)
        {
            lock (_replayBuffer)
            {
                _replayBuffer.AddLast(new ReplayEntry { Action = a, FiredAt = DateTime.UtcNow });
                while (_replayBuffer.Count > ReplayBufferCap) _replayBuffer.RemoveFirst();
            }
        }

        /// <summary>Fire the last <paramref name="n"/> recorded actions
        /// (oldest first, with a 250ms gap between each). Tray menu
        /// drives this; runs on a thread so we don't block the UI.</summary>
        public static void ReplayLast(int n)
        {
            ReplayEntry[] snapshot;
            lock (_replayBuffer)
            {
                if (_replayBuffer.Count == 0) return;
                snapshot = _replayBuffer.ToArray();
            }
            int take = System.Math.Min(n, snapshot.Length);
            var slice = new ReplayEntry[take];
            System.Array.Copy(snapshot, snapshot.Length - take, slice, 0, take);

            System.Threading.Tasks.Task.Run(() =>
            {
                var cfg = SettingsManager.Instance.Current.GameInteractions;
                foreach (var entry in slice)
                {
                    try { FireAction(entry.Action, null, cfg); }
                    catch (Exception ex) { ErrorLog.Write("ReplayLast", ex); }
                    System.Threading.Thread.Sleep(250);
                }
            });
        }
        public static int ReplayBufferCount
        {
            get { lock (_replayBuffer) return _replayBuffer.Count; }
        }

        // --- Panic refund buffer -----------------------------------
        // Every successful Spend() lands here so PauseFor can refund
        // anyone who paid in the last RefundWindowSec seconds. Capped
        // small so a busy stream doesn't leak memory.
        private sealed class ChargeRecord
        {
            public string   Platform   { get; set; }
            public string   User       { get; set; }
            public int      Amount     { get; set; }
            public string   ActionName { get; set; }
            public DateTime ChargedAt  { get; set; }
        }
        private static readonly LinkedList<ChargeRecord> _chargeHistory = new LinkedList<ChargeRecord>();
        private const int ChargeHistoryCap = 200;
        private const int RefundWindowSec = 30;

        // Pulled into PauseFor() so any tray-triggered pause refunds
        // the last 30s of charges. Returns count + total refunded.
        private static (int viewers, int total) RefundRecentCharges()
        {
            var cutoff = DateTime.UtcNow.AddSeconds(-RefundWindowSec);
            var refunds = new Dictionary<string, (string platform, string user, int amount)>(
                StringComparer.OrdinalIgnoreCase);
            lock (_chargeHistory)
            {
                for (var node = _chargeHistory.Last; node != null;)
                {
                    var prev = node.Previous;
                    if (node.Value.ChargedAt < cutoff) break;   // history is append-order
                    var rec = node.Value;
                    var key = rec.Platform + ":" + rec.User;
                    if (refunds.TryGetValue(key, out var existing))
                        refunds[key] = (existing.platform, existing.user, existing.amount + rec.Amount);
                    else
                        refunds[key] = (rec.Platform, rec.User, rec.Amount);
                    _chargeHistory.Remove(node);
                    node = prev;
                }
            }
            int viewerCount = 0, totalRefunded = 0;
            foreach (var kv in refunds.Values)
            {
                try
                {
                    Loadout.Bolts.BoltsWallet.Instance.Earn(
                        kv.platform, kv.user, kv.amount, "panic-refund");
                    viewerCount++;
                    totalRefunded += kv.amount;
                }
                catch (Exception ex) { ErrorLog.Write("PanicRefund." + kv.user, ex); }
            }
            if (viewerCount > 0)
            {
                AquiloBus.Instance.Publish("loadout.gameactions.refund", new
                {
                    viewers = viewerCount,
                    total   = totalRefunded,
                    reason  = "panic-pause"
                });
            }
            return (viewerCount, totalRefunded);
        }

        public void OnTick() { }

        public void OnEvent(EventContext ctx)
        {
            // Track stream state regardless of module enable so the
            // guard is correct the moment the user flips Enabled on.
            if (ctx.Kind == "streamOnline")  _streamOnline = true;
            if (ctx.Kind == "streamOffline") _streamOnline = false;

            var s = SettingsManager.Instance.Current;
            if (s.Modules == null || !s.Modules.GameInteractions) return;
            var cfg = s.GameInteractions;
            if (cfg == null || !cfg.Enabled || cfg.Actions == null || cfg.Actions.Count == 0) return;

            // Built-in !actions discovery command — lists every active
            // chat-trigger action with its cost. Fires before the action
            // matcher so the streamer doesn't have to add a row for it.
            if (ctx.Kind == "chat" && IsActionsListQuery(ctx.Message))
            {
                ReplyActionsList(ctx, cfg);
                return;
            }

            // Active roulette? Capture this chat line as a vote BEFORE
            // the command matcher runs — otherwise typing "1" or a
            // child-action name might re-fire the matched action.
            if (ctx.Kind == "chat" && TryRecordRouletteVote(ctx, cfg)) return;

            // Map the inbound event kind to a TriggerKind shortcut. Any
            // event other than these three is ignored.
            string triggerKind;
            string triggerValue;
            switch (ctx.Kind)
            {
                case "chat":
                    var msg = (ctx.Message ?? "").Trim();
                    if (msg.Length < 2 || msg[0] != '!') return;
                    var spaceIdx = msg.IndexOf(' ');
                    triggerKind  = "command";
                    triggerValue = (spaceIdx < 0 ? msg.Substring(1) : msg.Substring(1, spaceIdx - 1)).ToLowerInvariant();
                    break;
                case "rewardRedemption":
                case "channelPointRedemption":
                    triggerKind  = "channelPoint";
                    triggerValue = (ctx.Get<string>("rewardName")
                                ?? ctx.Get<string>("rewardTitle")
                                ?? ctx.Get<string>("title")
                                ?? "").Trim();
                    if (string.IsNullOrEmpty(triggerValue)) return;
                    break;
                case "tiktokGift":
                case "tikTokGift":
                    triggerKind  = "tiktokGift";
                    triggerValue = (ctx.Get<string>("gift")
                                ?? ctx.Get<string>("giftName")
                                ?? ctx.Get<string>("name")
                                ?? "").Trim();
                    if (string.IsNullOrEmpty(triggerValue)) return;
                    break;
                default:
                    return;
            }

            // Find every matching action (a single trigger can map to
            // multiple actions — useful for "every !panic does A + B").
            // If a profile is active (ProfileAutoSwitch + matching window)
            // its action list takes precedence; the global cfg.Actions
            // is the fallback otherwise.
            var sourceActions = _activeProfile?.Actions ?? cfg.Actions;
            var matches = new List<GameAction>();
            foreach (var a in sourceActions)
            {
                if (a == null || !a.Enabled) continue;
                if (!string.Equals(a.TriggerKind, triggerKind, StringComparison.OrdinalIgnoreCase)) continue;
                var configured = (a.TriggerValue ?? "").Trim().TrimStart('!');
                if (!string.Equals(configured, triggerValue, StringComparison.OrdinalIgnoreCase)) continue;
                matches.Add(a);
            }
            if (matches.Count == 0) return;

            foreach (var action in matches)
            {
                // Panic-pause kill-switch — tray menu can suspend all
                // fires for a fixed window. Cheaper than offline guard;
                // checked first.
                if (IsPaused)
                {
                    LogSkip(action, "panic-pause until " + _pauseUntilUtc.ToLocalTime().ToString("HH:mm:ss"));
                    continue;
                }
                // Offline safety guard — checked first because it's
                // free and a chat-storm during pre-stream setup would
                // otherwise burn through cooldowns + rate-limit slots
                // for nothing.
                if (cfg.RequireStreamOnline && !_streamOnline && !action.AllowOffline)
                {
                    LogSkip(action, "stream offline");
                    continue;
                }
                if (!CheckTikTokTier(action, ctx))       continue;
                if (!CheckRoleGate(action, ctx))         continue;
                if (!CheckCooldown(action, ctx, cfg))    continue;
                if (!CheckProbability(action))           continue;
                if (!CheckForegroundWindow(cfg))         { LogSkip(action, "foreground window mismatch"); continue; }
                if (!CheckRateLimit(cfg))                { LogSkip(action, "rate-limited"); continue; }
                if (!CheckPerViewerRate(ctx, cfg))       { LogSkip(action, "viewer rate-limited"); continue; }
                // Bolts cost gate is intentionally LAST before fire so
                // we don't take a viewer's bolts only to drop the
                // action for foreground / rate-limit reasons. Returns
                // false if the viewer can't cover the cost; we send
                // the FailAckTemplate (if set) and skip.
                if (!ChargeBoltsIfNeeded(action, ctx))   continue;

                // Fire. SendInput is synchronous + can block for HoldMs;
                // do it on a thread so chat handlers stay snappy.
                var localAction = action;
                var localCtx = ctx;
                _ = Task.Run(() => FireAction(localAction, localCtx, cfg));
            }
        }

        /// <summary>
        /// Debits <see cref="GameAction.BoltsCost"/> from the viewer's
        /// wallet before the action runs. Returns false (and sends the
        /// FailAckTemplate if set) when the viewer can't cover the cost
        /// or no viewer can be identified.
        ///
        /// Skipped entirely when BoltsCost is 0, when the trigger
        /// source already paid (channelPoint / tiktokGift, unless
        /// ChargeOnAllTriggers is on), or when the invoker is a
        /// privileged role and ChargePrivilegedRoles is off.
        /// </summary>
        private static bool ChargeBoltsIfNeeded(GameAction a, EventContext ctx)
        {
            if (a.BoltsCost <= 0) return true;

            // Channel-point + TikTok gift triggers don't bill bolts by
            // default — the viewer already paid in channel-point coins
            // / gift coins to trip the trigger.
            var triggerKind = (a.TriggerKind ?? "").ToLowerInvariant();
            if (!a.ChargeOnAllTriggers && triggerKind != "command") return true;

            // Privileged bypass.
            var ut = (ctx.UserType ?? "").ToLowerInvariant();
            bool privileged = (ut == "broadcaster" || ut == "moderator" || ut == "mod");
            if (privileged && !a.ChargePrivilegedRoles) return true;

            // Need a viewer handle to debit. If the platform / user is
            // missing (synthetic events), don't charge and let the
            // action run — better than silently dropping.
            if (string.IsNullOrEmpty(ctx?.User)) return true;
            var platform = ctx.Platform.ToShortName();
            if (string.IsNullOrEmpty(platform)) platform = "twitch";

            // Apply per-role cost multiplier. "vip": 0.5 = half, "sub": 0 = free.
            int finalCost = ResolveCost(a, ut);
            if (finalCost <= 0) return true;

            bool ok = Loadout.Bolts.BoltsWallet.Instance.Spend(
                platform, ctx.User, finalCost, "gameaction:" + a.Name);

            // Record the charge for the panic-refund window so that if
            // the streamer hits "panic pause" within the next 30s
            // these viewers get their bolts back. Tracked AFTER the
            // Spend so we never refund a failed debit.
            if (ok)
            {
                lock (_chargeHistory)
                {
                    _chargeHistory.AddLast(new ChargeRecord
                    {
                        Platform = platform,
                        User     = ctx.User,
                        Amount   = finalCost,
                        ActionName = a.Name,
                        ChargedAt = DateTime.UtcNow
                    });
                    while (_chargeHistory.Count > ChargeHistoryCap) _chargeHistory.RemoveFirst();
                }
            }

            if (!ok)
            {
                // Failure ack (optional). Show the viewer their current
                // balance so they know how much they're short.
                if (!string.IsNullOrWhiteSpace(a.FailAckTemplate))
                {
                    try
                    {
                        var s = SettingsManager.Instance.Current;
                        long bal = Loadout.Bolts.BoltsWallet.Instance.Balance(platform, ctx.User);
                        var emoji = s.Bolts?.Emoji ?? "";
                        var msg = a.FailAckTemplate
                            .Replace("{user}",    ctx.User ?? "")
                            .Replace("{cost}",    a.BoltsCost.ToString())
                            .Replace("{balance}", bal.ToString())
                            .Replace("{emoji}",   emoji);
                        new MultiPlatformSender(CphPlatformSender.Instance)
                            .Send(ctx.Platform, msg, s.Platforms);
                    }
                    catch (Exception ex) { ErrorLog.Write("GameAction.FailAck", ex); }
                }
                LogSkip(a, "insufficient bolts (cost " + a.BoltsCost + ")");
                return false;
            }
            return true;
        }

        // --- Guard checks -------------------------------------------------

        private static bool CheckTikTokTier(GameAction a, EventContext ctx)
        {
            if (!string.Equals(a.TriggerKind, "tiktokGift", StringComparison.OrdinalIgnoreCase)) return true;
            if (a.TikTokMinCoins <= 0) return true;
            var coins = ctx.Get<int>("coins", 0);
            if (coins <= 0) coins = ctx.Get<int>("diamonds", 0);
            return coins >= a.TikTokMinCoins;
        }

        private static bool CheckRoleGate(GameAction a, EventContext ctx)
        {
            // Role gate only applies to command triggers — channel-point
            // and TikTok-gift triggers always pass (they were already
            // gated by Twitch / TikTok before reaching us).
            if (!string.Equals(a.TriggerKind, "command", StringComparison.OrdinalIgnoreCase)) return true;
            var roles = (a.AllowedRoles ?? "").Trim();
            if (string.IsNullOrEmpty(roles) || roles == "*" || roles.Equals("everyone", StringComparison.OrdinalIgnoreCase)) return true;
            var ut = (ctx.UserType ?? "viewer").ToLowerInvariant();
            if (ut == "broadcaster") return true;
            foreach (var raw in roles.Split(','))
            {
                var r = raw.Trim().ToLowerInvariant();
                if (r.Length == 0) continue;
                if (r == ut) return true;
                if (r == "mod" && (ut == "moderator" || ut == "mod")) return true;
            }
            return false;
        }

        private bool CheckCooldown(GameAction a, EventContext ctx, GameInteractionsConfig cfg)
        {
            var mult = cfg.GlobalCooldownMultiplier <= 0 ? 1.0 : cfg.GlobalCooldownMultiplier;
            var now  = DateTime.UtcNow;

            lock (_lock)
            {
                var ut = (ctx.UserType ?? "").ToLowerInvariant();
                bool privileged = (ut == "broadcaster" || ut == "moderator" || ut == "mod");

                // Per-user cooldown for this viewer's role. Falls back to
                // a.CooldownPerUserSec when no override matches.
                int perUserSec = ResolvePerUserCooldown(a, ut);

                if (a.CooldownGlobalSec > 0)
                {
                    var globalKey = "global:" + a.Name;
                    if (_globalCooldowns.TryGetValue(globalKey, out var when) &&
                        (now - when).TotalSeconds < a.CooldownGlobalSec * mult)
                        return false;
                }

                // Mods + broadcaster bypass per-user only when no
                // explicit override exists for their role. If the
                // streamer set CooldownOverrides[mod]=N, honor it.
                bool bypassPerUser = privileged && perUserSec < 0;
                if (!bypassPerUser && perUserSec > 0 && !string.IsNullOrEmpty(ctx.User))
                {
                    var userKey = "user:" + a.Name + ":" + ctx.User.ToLowerInvariant();
                    if (_userCooldowns.TryGetValue(userKey, out var when) &&
                        (now - when).TotalSeconds < perUserSec * mult)
                        return false;
                }

                if (a.CooldownGlobalSec > 0)
                    _globalCooldowns["global:" + a.Name] = now;
                if (!bypassPerUser && perUserSec > 0 && !string.IsNullOrEmpty(ctx.User))
                    _userCooldowns["user:" + a.Name + ":" + (ctx.User ?? "").ToLowerInvariant()] = now;
            }
            return true;
        }

        // Resolves the final bolts cost after the per-role multiplier.
        // Same role-priority order as cooldown overrides.
        private static int ResolveCost(GameAction a, string ut)
        {
            int baseCost = a.BoltsCost;
            if (baseCost <= 0) return 0;
            if (a.CostMultipliers == null || a.CostMultipliers.Count == 0) return baseCost;
            var order = new[] { "broadcaster", "mod", "vip", "sub", "viewer" };
            int startIdx = System.Array.IndexOf(order,
                ut == "moderator" ? "mod" : ut);
            if (startIdx < 0) startIdx = order.Length - 1;
            for (int i = startIdx; i < order.Length; i++)
            {
                if (a.CostMultipliers.TryGetValue(order[i], out var mult))
                    return System.Math.Max(0, (int)System.Math.Round(baseCost * mult));
            }
            return baseCost;
        }

        // Returns the effective per-user cooldown for the viewer's role.
        // -1 = no entry at all (caller treats privileged as bypass).
        // 0 = explicit "free for this role". >0 = use that value.
        private static int ResolvePerUserCooldown(GameAction a, string ut)
        {
            if (a.CooldownOverrides != null && a.CooldownOverrides.Count > 0)
            {
                // Priority: broadcaster > mod > vip > sub > viewer.
                // Fall through to the next role if a key is missing.
                var order = new[] { "broadcaster", "mod", "vip", "sub", "viewer" };
                int startIdx = System.Array.IndexOf(order,
                    ut == "moderator" ? "mod" : ut);
                if (startIdx < 0) startIdx = order.Length - 1;   // viewer
                for (int i = startIdx; i < order.Length; i++)
                {
                    if (a.CooldownOverrides.TryGetValue(order[i], out var sec))
                        return sec;
                }
            }
            return a.CooldownPerUserSec > 0 ? a.CooldownPerUserSec : -1;
        }

        private bool CheckProbability(GameAction a)
        {
            var p = a.Probability;
            if (p >= 1.0) return true;
            if (p <= 0.0) return false;
            return _rng.NextDouble() < p;
        }

        private static bool CheckForegroundWindow(GameInteractionsConfig cfg)
        {
            if (string.IsNullOrWhiteSpace(cfg.TargetWindowTitle)) return true;
            var fg = NativeInput.ForegroundWindowTitle();
            return fg.IndexOf(cfg.TargetWindowTitle, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private bool CheckRateLimit(GameInteractionsConfig cfg)
        {
            if (cfg.MaxActionsPerSecond <= 0) return true;
            var now = DateTime.UtcNow;
            var cutoff = now.AddSeconds(-1);
            lock (_recentFires)
            {
                while (_recentFires.First != null && _recentFires.First.Value < cutoff)
                    _recentFires.RemoveFirst();
                if (_recentFires.Count >= cfg.MaxActionsPerSecond) return false;
                _recentFires.AddLast(now);
            }
            return true;
        }

        /// <summary>Per-viewer rolling-window cap. Each chatter gets at
        /// most <c>MaxActionsPerViewerWindow</c> fires across all actions
        /// in the trailing <c>MaxActionsPerViewerWindowSec</c> seconds.
        /// Skipped when 0 (unlimited) or when the event has no user
        /// (synthetic events like the Settings Test button).</summary>
        private bool CheckPerViewerRate(EventContext ctx, GameInteractionsConfig cfg)
        {
            int cap = cfg.MaxActionsPerViewerWindow;
            if (cap <= 0 || ctx == null || string.IsNullOrEmpty(ctx.User)) return true;
            int windowSec = System.Math.Max(1, cfg.MaxActionsPerViewerWindowSec);
            var now = DateTime.UtcNow;
            var cutoff = now.AddSeconds(-windowSec);
            var key = ctx.User.ToLowerInvariant();
            lock (_perViewerFires)
            {
                if (!_perViewerFires.TryGetValue(key, out var list))
                {
                    list = new LinkedList<DateTime>();
                    _perViewerFires[key] = list;
                }
                while (list.First != null && list.First.Value < cutoff) list.RemoveFirst();
                if (list.Count >= cap) return false;
                list.AddLast(now);
            }
            return true;
        }

        // --- Dispatch -----------------------------------------------------

        public static void FireAction(GameAction a, EventContext ctx, GameInteractionsConfig cfg)
        {
            try
            {
                AquiloBus.Instance.Publish("loadout.gameaction.fired", new
                {
                    name      = a.Name,
                    type      = a.ActionType,
                    keys      = a.Keys,
                    trigger   = a.TriggerKind,
                    value     = a.TriggerValue,
                    user      = ctx?.User,
                    dryRun    = cfg.DryRun
                });
                EventStats.Instance.Hit("game.action.fired", nameof(GameInteractionsModule));

                if (cfg.DryRun)
                {
                    ErrorLog.Write("GameAction (dry-run)",
                        a.Name + " [" + a.ActionType + "] " + a.Keys);
                    SendAck(a, ctx, cfg);
                    return;
                }

                // Record live fires in the rolling replay buffer.
                // Dry-run fires are skipped — replays would just dry-run
                // again, which is pointless.
                RecordReplay(a);

                // Optional audio cue. "before" blocks for the WAV's
                // length; "parallel" / "after" don't block input.
                var when = (a.AudioCueWhen ?? "parallel").ToLowerInvariant();
                if (!string.IsNullOrWhiteSpace(a.AudioCuePath) && when == "before")
                    TryPlayCue(a.AudioCuePath, sync: true);
                else if (!string.IsNullOrWhiteSpace(a.AudioCuePath) && when == "parallel")
                    TryPlayCue(a.AudioCuePath, sync: false);

                switch ((a.ActionType ?? "key").ToLowerInvariant())
                {
                    case "key":
                        FireKey(a);
                        break;
                    case "mouseclick":
                        for (int i = 0; i < Math.Max(1, a.Repeat); i++)
                        {
                            NativeInput.MouseClick(a.MouseButton, a.HoldMs);
                            if (i < a.Repeat - 1) Thread.Sleep(Math.Max(0, a.RepeatDelayMs));
                        }
                        break;
                    case "mousemove":
                        NativeInput.MouseMove(a.MouseX, a.MouseY, a.MouseMode);
                        break;
                    case "scroll":
                        NativeInput.MouseScroll(a.ScrollDelta);
                        break;
                    case "sequence":
                        RunSequence(a.Sequence);
                        break;
                    case "controller":
                        FireController(a);
                        break;
                    case "sb-action":
                        if (!string.IsNullOrEmpty(a.SbActionId))
                            SbBridge.Instance.RunAction(a.SbActionId);
                        break;
                    case "chain":
                        RunChain(a, ctx, cfg);
                        break;
                    case "roulette":
                        StartRoulette(a, ctx, cfg);
                        break;
                    case "obs-scene":
                        if (!string.IsNullOrEmpty(a.ObsScene))
                            SbBridge.Instance.ObsSetScene(a.ObsScene, a.ObsConnection);
                        break;
                    case "obs-source":
                        if (!string.IsNullOrEmpty(a.ObsScene) && !string.IsNullOrEmpty(a.ObsSource))
                        {
                            bool? visible;
                            switch ((a.ObsVisibility ?? "toggle").ToLowerInvariant())
                            {
                                case "show": visible = true;  break;
                                case "hide": visible = false; break;
                                default:     visible = null;  break;   // toggle
                            }
                            SbBridge.Instance.ObsSetSourceVisibility(
                                a.ObsScene, a.ObsSource, visible, a.ObsConnection);
                        }
                        break;
                    default:
                        ErrorLog.Write("GameAction", "Unknown ActionType: " + a.ActionType);
                        return;
                }

                if (!string.IsNullOrWhiteSpace(a.AudioCuePath) &&
                    (a.AudioCueWhen ?? "").Equals("after", StringComparison.OrdinalIgnoreCase))
                    TryPlayCue(a.AudioCuePath, sync: false);

                SendAck(a, ctx, cfg);
            }
            catch (Exception ex)
            {
                ErrorLog.Write("GameInteractionsModule.Fire(" + a.Name + ")", ex);
            }
        }

        // --- Voted Roulette -----------------------------------------
        // One active vote at a time per channel. While a vote is open,
        // every chat line from a distinct user counts once: a leading
        // digit picks by index (1-based), otherwise full-name match.
        private sealed class RouletteVote
        {
            public GameAction Parent { get; set; }
            public List<string> Options { get; set; }
            public Dictionary<string, int> Votes { get; set; }     // user -> option index
            public DateTime ClosesAtUtc { get; set; }
        }
        private static RouletteVote _activeRoulette;
        private static readonly object _rouletteLock = new object();

        private static void StartRoulette(GameAction parent, EventContext ctx, GameInteractionsConfig cfg)
        {
            if (parent == null || string.IsNullOrWhiteSpace(parent.RouletteOptions)) return;
            // Refuse to start a second vote if one is still open; just
            // log so the streamer can see why it didn't fire.
            lock (_rouletteLock)
            {
                if (_activeRoulette != null && DateTime.UtcNow < _activeRoulette.ClosesAtUtc)
                {
                    ErrorLog.Write("Roulette", "Vote already open until " +
                        _activeRoulette.ClosesAtUtc.ToString("o"));
                    return;
                }
                var opts = new List<string>();
                foreach (var raw in parent.RouletteOptions.Split(';'))
                {
                    var t = raw.Trim();
                    if (t.Length > 0) opts.Add(t);
                }
                if (opts.Count == 0) return;
                int windowSec = System.Math.Max(5, parent.RouletteWindowSec);
                _activeRoulette = new RouletteVote
                {
                    Parent      = parent,
                    Options     = opts,
                    Votes       = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase),
                    ClosesAtUtc = DateTime.UtcNow.AddSeconds(windowSec)
                };

                // Announce the vote in chat. {options} is "1) name · 2) name".
                if (!string.IsNullOrWhiteSpace(parent.RouletteOpenTemplate))
                {
                    var optsLabel = new System.Text.StringBuilder();
                    for (int i = 0; i < opts.Count; i++)
                    {
                        if (i > 0) optsLabel.Append(" · ");
                        optsLabel.Append(i + 1).Append(") ").Append(opts[i]);
                    }
                    try
                    {
                        var s = SettingsManager.Instance.Current;
                        var line = parent.RouletteOpenTemplate
                            .Replace("{user}", ctx?.User ?? "")
                            .Replace("{window}", windowSec.ToString())
                            .Replace("{options}", optsLabel.ToString());
                        new MultiPlatformSender(CphPlatformSender.Instance)
                            .Send(ctx?.Platform ?? Settings.PlatformMask.None, line, s.Platforms);
                    }
                    catch (Exception ex) { ErrorLog.Write("Roulette.Announce", ex); }
                }

                AquiloBus.Instance.Publish("loadout.gameactions.roulette.open", new
                {
                    name = parent.Name, options = opts, closesAtUtc = _activeRoulette.ClosesAtUtc, windowSec
                });
            }

            // Resolve in a background task so we don't block the
            // dispatcher for the whole vote window.
            System.Threading.Tasks.Task.Run(async () =>
            {
                try
                {
                    var delayMs = (_activeRoulette.ClosesAtUtc - DateTime.UtcNow).TotalMilliseconds;
                    if (delayMs > 0) await System.Threading.Tasks.Task.Delay((int)delayMs).ConfigureAwait(false);
                    ResolveRoulette();
                }
                catch (Exception ex) { ErrorLog.Write("Roulette.Resolve", ex); }
            });
        }

        // Called for every chat line while we're matching. Returns true
        // (and consumes the chat) when the chat IS a vote — caller
        // shouldn't run the rest of OnEvent against it.
        private static bool TryRecordRouletteVote(EventContext ctx, GameInteractionsConfig cfg)
        {
            RouletteVote vote;
            lock (_rouletteLock) { vote = _activeRoulette; }
            if (vote == null || DateTime.UtcNow >= vote.ClosesAtUtc) return false;
            if (string.IsNullOrEmpty(ctx?.User)) return false;
            var msg = (ctx.Message ?? "").Trim().TrimStart('!');
            if (msg.Length == 0) return false;

            int idx = -1;
            // Numeric vote
            if (int.TryParse(msg, out var n) && n >= 1 && n <= vote.Options.Count) idx = n - 1;
            // Full-name match
            if (idx < 0)
            {
                for (int i = 0; i < vote.Options.Count; i++)
                {
                    if (string.Equals(vote.Options[i], msg, StringComparison.OrdinalIgnoreCase))
                    { idx = i; break; }
                }
            }
            if (idx < 0) return false;

            int[] tallySnapshot = null;
            int voterCount = 0;
            lock (_rouletteLock)
            {
                if (_activeRoulette == null) return false;
                // First vote wins per user (no flip-flopping). Reduces
                // bot-spam shenanigans.
                if (_activeRoulette.Votes.ContainsKey(ctx.User)) return true;
                _activeRoulette.Votes[ctx.User] = idx;

                tallySnapshot = new int[_activeRoulette.Options.Count];
                foreach (var v in _activeRoulette.Votes.Values)
                    if (v >= 0 && v < tallySnapshot.Length) tallySnapshot[v]++;
                voterCount = _activeRoulette.Votes.Count;
            }
            // Live tally broadcast — the dock's vote card animates its
            // bars off these. Published outside the lock so a slow bus
            // client can't stall vote recording.
            try
            {
                AquiloBus.Instance.Publish("loadout.gameactions.roulette.vote", new
                {
                    tally  = tallySnapshot,
                    voters = voterCount
                });
            }
            catch { /* non-fatal */ }
            return true;
        }

        private static void ResolveRoulette()
        {
            RouletteVote vote;
            lock (_rouletteLock)
            {
                vote = _activeRoulette;
                _activeRoulette = null;
            }
            if (vote == null) return;
            var tally = new int[vote.Options.Count];
            foreach (var v in vote.Votes.Values)
                if (v >= 0 && v < tally.Length) tally[v]++;
            // Pick the highest-tally option; tie goes to lower index
            // (which is the earlier-cast option in display order).
            int winnerIdx = 0; int winnerCount = -1;
            for (int i = 0; i < tally.Length; i++)
                if (tally[i] > winnerCount) { winnerIdx = i; winnerCount = tally[i]; }
            var winnerName = vote.Options[winnerIdx];

            AquiloBus.Instance.Publish("loadout.gameactions.roulette.close", new
            {
                name        = vote.Parent.Name,
                winner      = winnerName,
                winnerIndex = winnerIdx,
                tally       = tally,
                voters      = vote.Votes.Count
            });

            // Find + fire the winning child action. Skip if none, and
            // skip if it points at the parent (loop guard).
            var cfg = SettingsManager.Instance.Current?.GameInteractions;
            if (cfg == null || cfg.Actions == null) return;
            GameAction winner = null;
            foreach (var a in cfg.Actions)
                if (a != null && string.Equals(a.Name, winnerName, StringComparison.OrdinalIgnoreCase))
                { winner = a; break; }
            if (winner == null || winner == vote.Parent) return;
            FireAction(winner, null, cfg);
        }

        // Matches "!actions" / "!commands actions" / "!gameactions".
        private static bool IsActionsListQuery(string msg)
        {
            if (string.IsNullOrEmpty(msg)) return false;
            var m = msg.Trim().ToLowerInvariant();
            return m == "!actions" || m == "!gameactions" || m == "!chaos";
        }

        // Builds + sends a chat-line list of every chat-trigger action
        // the active source has. Quietly truncates at ~450 chars (most
        // platforms cap at 500) so a 30-action setup doesn't overflow.
        private static void ReplyActionsList(EventContext ctx, GameInteractionsConfig cfg)
        {
            try
            {
                var source = cfg.Actions;
                if (source == null || source.Count == 0) return;
                var parts = new System.Collections.Generic.List<string>();
                foreach (var a in source)
                {
                    if (a == null || !a.Enabled) continue;
                    if (!string.Equals(a.TriggerKind, "command", StringComparison.OrdinalIgnoreCase)) continue;
                    var trigger = (a.TriggerValue ?? "").TrimStart('!');
                    if (string.IsNullOrEmpty(trigger)) continue;
                    var label = "!" + trigger;
                    if (a.BoltsCost > 0) label += "(" + a.BoltsCost + ")";
                    parts.Add(label);
                }
                if (parts.Count == 0) return;
                var s = SettingsManager.Instance.Current;
                var head = "Chat-controlled actions" +
                           (string.IsNullOrEmpty(s.Bolts?.Emoji) ? "" : " " + s.Bolts.Emoji) +
                           ": ";
                var body = string.Join(" · ", parts);
                if ((head + body).Length > 450)
                    body = body.Substring(0, 450 - head.Length - 4) + " …";
                new MultiPlatformSender(CphPlatformSender.Instance)
                    .Send(ctx.Platform, head + body, s.Platforms);
            }
            catch (Exception ex) { ErrorLog.Write("ReplyActionsList", ex); }
        }

        /// <summary>
        /// Run a chain of child actions in sequence. Each step is the
        /// NAME of another GameAction in the active list, optionally
        /// followed by ":delayMs" (post-fire delay). The parent's
        /// gates were already checked, so children skip their own
        /// cost/cooldown/role/probability gates — otherwise a 5-step
        /// chain would re-bill the viewer 5x for one trigger.
        ///
        /// Synchronous and runs on the same Task.Run that fired the
        /// parent, so the chain blocks the parent's "fire" returning
        /// for the total step+delay duration — fine because that
        /// already runs off the dispatcher thread.
        /// </summary>
        private static void RunChain(GameAction parent, EventContext ctx, GameInteractionsConfig cfg)
        {
            if (parent == null || string.IsNullOrWhiteSpace(parent.ChainSteps)) return;
            // Build a fast lookup of action names in the currently-active
            // source (profile or fallback). Re-read each step so a long
            // chain doesn't hold a stale snapshot.
            foreach (var rawStep in parent.ChainSteps.Split(';'))
            {
                var step = rawStep.Trim();
                if (step.Length == 0) continue;
                var colon = step.IndexOf(':');
                var name  = colon < 0 ? step : step.Substring(0, colon).Trim();
                int delayMs = 0;
                if (colon >= 0)
                {
                    var rest = step.Substring(colon + 1).Trim().ToLowerInvariant();
                    if (rest.EndsWith("ms")) rest = rest.Substring(0, rest.Length - 2);
                    else if (rest.EndsWith("s")) { rest = rest.Substring(0, rest.Length - 1); delayMs *= 1000; }
                    int.TryParse(rest, out delayMs);
                }
                var source = SettingsManager.Instance.Current?.GameInteractions?.Actions;
                GameAction child = null;
                if (source != null)
                {
                    foreach (var c in source)
                    {
                        if (c != null && string.Equals(c.Name, name, StringComparison.OrdinalIgnoreCase))
                        { child = c; break; }
                    }
                }
                if (child == null)
                {
                    ErrorLog.Write("ChainStep", "Step '" + name + "' references no GameAction by that name");
                    continue;
                }
                if (child == parent)
                {
                    // Infinite-loop guard — a chain whose step names
                    // itself would recurse forever.
                    ErrorLog.Write("ChainStep", "Chain '" + parent.Name + "' references itself; skipping");
                    continue;
                }
                FireAction(child, ctx, cfg);
                if (delayMs > 0) System.Threading.Thread.Sleep(delayMs);
            }
        }

        /// <summary>
        /// Play a WAV via System.Media.SoundPlayer. Silently swallows
        /// errors (bad path, non-WAV file, audio device missing) so a
        /// broken audio cue can never block the actual game-input fire.
        /// </summary>
        private static void TryPlayCue(string path, bool sync)
        {
            try
            {
                if (!System.IO.File.Exists(path)) return;
                using (var p = new System.Media.SoundPlayer(path))
                {
                    if (sync) p.PlaySync();
                    else      p.Play();
                }
            }
            catch (Exception ex) { ErrorLog.Write("GameAction.Audio", ex); }
        }

        private static void FireController(GameAction a)
        {
            if (!Games.Interactions.ViGEmBridge.Initialize())
            {
                ErrorLog.Write("GameAction.Controller",
                    "ViGEm not ready (" + Games.Interactions.ViGEmBridge.Status +
                    "): " + Games.Interactions.ViGEmBridge.LastErrorMessage);
                return;
            }
            int repeats = System.Math.Max(1, a.Repeat);
            for (int i = 0; i < repeats; i++)
            {
                switch ((a.ControllerKind ?? "button").ToLowerInvariant())
                {
                    case "button":
                        if (!string.IsNullOrWhiteSpace(a.ControllerButton))
                            Games.Interactions.ViGEmBridge.TapButton(a.ControllerButton,
                                System.Math.Max(1, a.HoldMs));
                        break;
                    case "trigger":
                        Games.Interactions.ViGEmBridge.PullTrigger(a.ControllerTrigger,
                            (byte)System.Math.Max(0, System.Math.Min(255, a.ControllerValue)),
                            System.Math.Max(1, a.HoldMs));
                        break;
                    case "stick":
                        Games.Interactions.ViGEmBridge.MoveStick(a.ControllerStick,
                            a.StickX, a.StickY, System.Math.Max(1, a.HoldMs));
                        break;
                    default:
                        ErrorLog.Write("GameAction.Controller",
                            "Unknown ControllerKind '" + a.ControllerKind + "' on action " + a.Name);
                        return;
                }
                if (i < repeats - 1) System.Threading.Thread.Sleep(System.Math.Max(0, a.RepeatDelayMs));
            }
        }

        private static void FireKey(GameAction a)
        {
            int repeats = Math.Max(1, a.Repeat);
            for (int i = 0; i < repeats; i++)
            {
                if (a.Keys.IndexOf('+') >= 0)
                    NativeInput.KeyCombo(a.Keys, Math.Max(1, a.HoldMs));
                else
                    NativeInput.KeyTap(a.Keys, Math.Max(1, a.HoldMs));
                if (i < repeats - 1) Thread.Sleep(Math.Max(0, a.RepeatDelayMs));
            }
        }

        /// <summary>
        /// Step grammar (semicolon-separated):
        ///   W:2000ms         hold W for 2 seconds
        ///   Space            tap Space (default 50ms)
        ///   Ctrl+S:50ms      combo hold
        ///   pause:500ms      sleep 500ms
        ///   click:left       left-click at current cursor
        ///   move:50,-20      mouse-move relative (50, -20)
        ///   scroll:-3        wheel down 3 notches
        /// Whitespace around tokens is tolerated.
        /// </summary>
        public static void RunSequence(string sequence)
        {
            if (string.IsNullOrWhiteSpace(sequence)) return;
            foreach (var rawStep in sequence.Split(';'))
            {
                var step = rawStep.Trim();
                if (step.Length == 0) continue;
                try { RunStep(step); }
                catch (Exception ex)
                {
                    ErrorLog.Write("GameAction.Sequence(" + step + ")", ex);
                    // Continue with the next step rather than aborting
                    // the whole sequence — partial macros are useful.
                }
            }
        }

        private static void RunStep(string step)
        {
            var colon = step.IndexOf(':');
            var head  = colon < 0 ? step : step.Substring(0, colon).Trim();
            var tail  = colon < 0 ? ""   : step.Substring(colon + 1).Trim();

            // pause:500ms / pause:1s
            if (head.Equals("pause", StringComparison.OrdinalIgnoreCase))
            {
                Thread.Sleep(ParseDuration(tail, 100));
                return;
            }
            // pad:<button>[:duration]           -> tap a controller button
            // pad-trigger:LT|RT:0-255[:duration] -> pull a trigger
            // pad-stick:L|R:x,y[:duration]      -> push a stick
            if (head.Equals("pad", StringComparison.OrdinalIgnoreCase))
            {
                var pparts = (tail ?? "").Split(':');
                if (pparts.Length >= 1)
                {
                    var btn = pparts[0].Trim();
                    int padHold = pparts.Length > 1 ? ParseDuration(pparts[1], 50) : 50;
                    Games.Interactions.ViGEmBridge.TapButton(btn, padHold);
                }
                return;
            }
            if (head.Equals("pad-trigger", StringComparison.OrdinalIgnoreCase))
            {
                var tparts = (tail ?? "").Split(':');
                var trig = tparts.Length > 0 ? tparts[0].Trim() : "RT";
                byte v = 255;
                if (tparts.Length > 1 && byte.TryParse(tparts[1].Trim(), out var pv)) v = pv;
                int trigHold = tparts.Length > 2 ? ParseDuration(tparts[2], 200) : 200;
                Games.Interactions.ViGEmBridge.PullTrigger(trig, v, trigHold);
                return;
            }
            if (head.Equals("pad-stick", StringComparison.OrdinalIgnoreCase))
            {
                var sparts = (tail ?? "").Split(':');
                var stick = sparts.Length > 0 ? sparts[0].Trim() : "L";
                double sx = 0, sy = 0;
                if (sparts.Length > 1)
                {
                    var xy = sparts[1].Split(',');
                    if (xy.Length > 0) double.TryParse(xy[0].Trim(),
                        System.Globalization.NumberStyles.Float,
                        System.Globalization.CultureInfo.InvariantCulture, out sx);
                    if (xy.Length > 1) double.TryParse(xy[1].Trim(),
                        System.Globalization.NumberStyles.Float,
                        System.Globalization.CultureInfo.InvariantCulture, out sy);
                }
                int stickHold = sparts.Length > 2 ? ParseDuration(sparts[2], 300) : 300;
                Games.Interactions.ViGEmBridge.MoveStick(stick, sx, sy, stickHold);
                return;
            }
            // click:left / click:right / click
            if (head.Equals("click", StringComparison.OrdinalIgnoreCase))
            {
                NativeInput.MouseClick(string.IsNullOrEmpty(tail) ? "left" : tail);
                return;
            }
            // move:50,-20 / move:x,y[,mode]
            if (head.Equals("move", StringComparison.OrdinalIgnoreCase))
            {
                var parts = (tail ?? "").Split(',');
                int x = parts.Length > 0 && int.TryParse(parts[0].Trim(), out var xv) ? xv : 0;
                int y = parts.Length > 1 && int.TryParse(parts[1].Trim(), out var yv) ? yv : 0;
                string mode = parts.Length > 2 ? parts[2].Trim() : "relative";
                NativeInput.MouseMove(x, y, mode);
                return;
            }
            // scroll:-3
            if (head.Equals("scroll", StringComparison.OrdinalIgnoreCase))
            {
                int.TryParse(tail.Trim(), out var n);
                NativeInput.MouseScroll(n);
                return;
            }
            // Otherwise it's a key (possibly with duration): "W" or "Ctrl+S" or "W:2000ms".
            int hold = ParseDuration(tail, 50);
            if (head.IndexOf('+') >= 0) NativeInput.KeyCombo(head, hold);
            else                         NativeInput.KeyTap(head, hold);
        }

        private static int ParseDuration(string s, int defaultMs)
        {
            if (string.IsNullOrWhiteSpace(s)) return defaultMs;
            s = s.Trim().ToLowerInvariant();
            int mult = 1;
            if (s.EndsWith("ms")) { s = s.Substring(0, s.Length - 2); mult = 1; }
            else if (s.EndsWith("s")) { s = s.Substring(0, s.Length - 1); mult = 1000; }
            if (double.TryParse(s, System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture, out var n))
                return Math.Max(0, (int)(n * mult));
            return defaultMs;
        }

        private static void SendAck(GameAction a, EventContext ctx, GameInteractionsConfig cfg)
        {
            if (string.IsNullOrWhiteSpace(a.AckTemplate)) return;
            try
            {
                var s = SettingsManager.Instance.Current;
                var msg = a.AckTemplate
                    .Replace("{user}",  ctx?.User ?? "")
                    .Replace("{name}",  a.Name ?? "")
                    .Replace("{keys}",  a.Keys ?? "")
                    .Replace("{gift}",  ctx?.Get<string>("gift") ?? "")
                    .Replace("{coins}", (ctx?.Get<int>("coins", 0) ?? 0).ToString());
                new MultiPlatformSender(CphPlatformSender.Instance)
                    .Send(ctx != null ? ctx.Platform : Settings.PlatformMask.None, msg, s.Platforms);
            }
            catch (Exception ex) { ErrorLog.Write("GameAction.Ack(" + a.Name + ")", ex); }
        }

        private static void LogSkip(GameAction a, string reason)
        {
            ErrorLog.Write("GameAction skip",
                a.Name + " (" + a.TriggerKind + ":" + a.TriggerValue + ") - " + reason);
        }
    }
}
