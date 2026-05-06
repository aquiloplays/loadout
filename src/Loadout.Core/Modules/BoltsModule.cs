using System;
using System.Collections.Generic;
using System.Linq;
using Loadout.Bolts;
using Loadout.Bus;
using Loadout.Engagement;
using Loadout.Patreon;
using Loadout.Platforms;
using Loadout.Sb;
using Loadout.Settings;
using Loadout.Util;
using Loadout.Workers;

namespace Loadout.Modules
{
    /// <summary>
    /// Bolts wallet module. Earns on every meaningful event, spends via chat
    /// commands. Multipliers stack additively (sub +0.5, patreon-tier3 +1.0,
    /// 5-day streak +0.5 → final 3.0×).
    ///
    /// Chat commands (every reply gated through ChatGate, so this can't clog
    /// chat regardless of how many viewers run !bolts):
    ///   !bolts                  show your balance
    ///   !bolts @user            show another viewer's balance
    ///   !leaderboard            top 5 balances
    ///   !gift @user N           transfer N bolts to another viewer
    ///   !boltrain N [count]     broadcaster/mod: split N bolts across [count] random active chatters
    ///
    /// Earn events fire the bus event <c>bolts.earned</c> with details so the
    /// unified overlay can render a small floating "+N Bolts" toast.
    /// </summary>
    public sealed class BoltsModule : IEventModule
    {
        // Anti-AFK: per-viewer chat earn timestamps within the last minute.
        private readonly Dictionary<string, Queue<DateTime>> _chatEarnTimes = new Dictionary<string, Queue<DateTime>>();
        // Track who's chatted recently for !boltrain recipient pool.
        private readonly Dictionary<string, DateTime> _activeChatters = new Dictionary<string, DateTime>(StringComparer.OrdinalIgnoreCase);
        private DateTime _lastLeaderboardBroadcastUtc = DateTime.MinValue;

        public BoltsModule()
        {
            // Register bus handlers so other aquilo.gg products (Rotation
            // music widget, future tools) can transact in Bolts.
            // Protocol:
            //   bolts.spend.request   { user, platform, amount, reason, requestId }
            //                         → bolts.spend.completed | bolts.spend.failed
            //   bolts.refund          { user, platform, amount, reason, requestId }
            //                         → bolts.refund.completed
            //   bolts.balance.query   { user, platform }
            //                         → bolts.balance.result { balance }
            AquiloBus.Instance.RegisterHandler("bolts.spend.request",  HandleSpendRequest);
            AquiloBus.Instance.RegisterHandler("bolts.refund",         HandleRefund);
            AquiloBus.Instance.RegisterHandler("bolts.balance.query",  HandleBalanceQuery);
        }

        public void OnEvent(EventContext ctx)
        {
            var s = SettingsManager.Instance.Current;
            if (!s.Modules.Bolts) return;
            BoltsWallet.Instance.Initialize();

            switch (ctx.Kind)
            {
                case "chat":
                    EarnChat(ctx, s);
                    HandleChatCommands(ctx, s);
                    return;
                case "sub":
                case "resub":
                    Earn(ctx, s.Bolts.PerSub, "sub", s);
                    return;
                case "giftSub":
                    var count = Math.Max(1, ctx.Get<int>("count", 1));
                    Earn(ctx, s.Bolts.PerGiftSub * count, "gift x" + count, s);
                    return;
                case "raid":
                    Earn(ctx, s.Bolts.PerRaidBrought, "raid", s);
                    return;
                case "cheer":
                    var bits = ctx.Get<int>("bits", 0);
                    if (bits > 0 && s.Bolts.PerCheerBitDivisor > 0)
                        Earn(ctx, bits / s.Bolts.PerCheerBitDivisor, "cheer", s);
                    return;
                case "ccCoinExchange":
                case "ccEffectSuccess":
                    var cost = ctx.Get<int>("cost", ctx.Get<int>("coinCost", 0));
                    if (cost > 0 && s.Bolts.PerCcCoinDivisor > 0)
                        Earn(ctx, cost / s.Bolts.PerCcCoinDivisor, "cc-coin", s);
                    return;
                case "subAnniversary":
                    var months = ctx.Get<int>("months", 0);
                    if (months > 0)
                        Earn(ctx, s.Bolts.SubAnniversaryBonusBase * months, "anniversary " + months + "mo", s);
                    return;
                // Daily check-in fires its own bus event we listen to indirectly via the dispatcher
                // (CheckInModule publishes "checkin.shown"; we credit bolts + bump streak there).
                case "checkin":
                    HandleCheckIn(ctx, s);
                    return;

                // Rotation widget sends these via the bus. Forwarded to us as
                // events from the dispatcher's bus → event bridge (registered
                // by AquiloBus on receipt of these specific kinds).
                case "rotation.song.accepted":
                    HandleRotationAck(ctx.Get<string>("requestId", ""), accepted: true,  reason: null);
                    return;
                case "rotation.song.rejected":
                    HandleRotationAck(ctx.Get<string>("requestId", ""), accepted: false,
                        reason: ctx.Get<string>("reason", "rejected"));
                    return;
            }
        }

        public void OnTick()
        {
            // Auto-refund any !boltsong that the Rotation widget never acknowledged
            // within the deadline. Failure mode = widget offline / wedged.
            List<string> toRefund = null;
            lock (_pendingBoltSongs)
            {
                foreach (var kv in _pendingBoltSongs)
                {
                    if (kv.Value.Done) continue;
                    if (DateTime.UtcNow < kv.Value.Deadline) continue;
                    (toRefund ??= new List<string>()).Add(kv.Key);
                }
            }
            if (toRefund != null)
                foreach (var id in toRefund) HandleRotationAck(id, accepted: false, reason: "no-ack");

            // Leaderboard snapshot once a minute for the overlay.
            if ((DateTime.UtcNow - _lastLeaderboardBroadcastUtc).TotalSeconds < 60) return;
            _lastLeaderboardBroadcastUtc = DateTime.UtcNow;
            PublishLeaderboard();
        }

        // ── Earn paths ────────────────────────────────────────────────────────

        private void EarnChat(EventContext ctx, LoadoutSettings s)
        {
            if (string.IsNullOrEmpty(ctx.User)) return;

            // Track active chatters for boltrain.
            _activeChatters[ctx.User] = DateTime.UtcNow;

            // Anti-AFK: cap chat earns per minute per viewer.
            var key = ctx.Platform.ToShortName() + ":" + ctx.User.ToLowerInvariant();
            if (!_chatEarnTimes.TryGetValue(key, out var window))
            {
                window = new Queue<DateTime>();
                _chatEarnTimes[key] = window;
            }
            var now = DateTime.UtcNow;
            while (window.Count > 0 && (now - window.Peek()).TotalMinutes >= 1) window.Dequeue();
            if (window.Count >= s.Bolts.MaxChatEarnsPerMinute) return;
            window.Enqueue(now);

            Earn(ctx, s.Bolts.PerChatMessage, "chat", s);
        }

        private static void Earn(EventContext ctx, long amount, string reason, LoadoutSettings s)
        {
            if (amount <= 0 || string.IsNullOrEmpty(ctx.User)) return;
            var multiplier = ComputeMultiplier(ctx, s);
            var awarded = (long)Math.Floor(amount * multiplier);
            if (awarded <= 0) return;

            var balance = BoltsWallet.Instance.Earn(
                ctx.Platform.ToShortName(), ctx.User, awarded, reason);

            AquiloBus.Instance.Publish("bolts.earned", new
            {
                user        = ctx.User,
                platform    = ctx.Platform.ToShortName(),
                amount      = awarded,
                reason,
                multiplier,
                balance,
                emoji       = s.Bolts.Emoji
            });
        }

        private static double ComputeMultiplier(EventContext ctx, LoadoutSettings s)
        {
            double m = 1.0;
            var role = (ctx.UserType ?? "").ToLowerInvariant();
            if (role == "subscriber" || role == "sub" || role == "vip" || role == "moderator" || role == "mod")
                m += s.Bolts.SubMultiplier;

            var tier = SupportersClient.Instance.LookupCachedOrFireAndForget(
                ctx.Platform.ToShortName(), ctx.User);
            if (tier == "tier1") m += s.Bolts.PatreonTier1Bonus;
            else if (tier == "tier2") m += s.Bolts.PatreonTier2Bonus;
            else if (tier == "tier3") m += s.Bolts.PatreonTier3Bonus;

            // Daily streak bonus (capped).
            var account = BoltsWallet.Instance.Get(ctx.Platform.ToShortName(), ctx.User);
            if (account != null && account.StreakDays > 1)
            {
                var streakBonus = Math.Min(s.Bolts.DailyStreakCap,
                    (account.StreakDays - 1) * s.Bolts.DailyStreakPerDay);
                m += streakBonus;
            }
            return m;
        }

        private static void HandleCheckIn(EventContext ctx, LoadoutSettings s)
        {
            if (string.IsNullOrEmpty(ctx.User)) return;
            var (streak, grew) = BoltsWallet.Instance.BumpStreak(ctx.Platform.ToShortName(), ctx.User);

            // Award the configured check-in payout (multiplied like everything else).
            Earn(ctx, s.Bolts.PerDailyCheckIn, "checkin", s);

            if (grew && streak > 1)
            {
                AquiloBus.Instance.Publish("bolts.streak", new
                {
                    user     = ctx.User,
                    platform = ctx.Platform.ToShortName(),
                    streakDays = streak
                });
            }
        }

        // ── Chat commands ─────────────────────────────────────────────────────

        private void HandleChatCommands(EventContext ctx, LoadoutSettings s)
        {
            var msg = (ctx.Message ?? "").Trim();
            if (msg.Length < 2 || msg[0] != '!') return;
            var spaceIdx = msg.IndexOf(' ');
            var cmd = (spaceIdx < 0 ? msg.Substring(1) : msg.Substring(1, spaceIdx - 1)).ToLowerInvariant();
            var rest = spaceIdx < 0 ? "" : msg.Substring(spaceIdx + 1).Trim();

            switch (cmd)
            {
                case "bolts":         CmdBolts(ctx, rest, s);       return;
                case "leaderboard":   CmdLeaderboard(ctx, s);       return;
                case "lb":            CmdLeaderboard(ctx, s);       return;
                case "gift":          CmdGift(ctx, rest, s);        return;
                case "boltrain":      CmdBoltRain(ctx, rest, s);    return;
                case "slots":         CmdSlots(ctx, rest, s);       return;
            }

            // Rotation widget integration: !boltsong <song> spends Bolts to
            // push a priority song request into the Rotation queue. Configurable
            // command name (default !boltsong).
            if (s.RotationIntegration.Enabled &&
                ("!" + cmd).Equals(s.RotationIntegration.Command, StringComparison.OrdinalIgnoreCase))
            {
                CmdBoltSong(ctx, rest, s);
            }
        }

        // Per-viewer cooldown for !boltsong so a single supporter can't queue
        // a hundred songs in a row.
        private readonly Dictionary<string, DateTime> _boltSongLastUse = new Dictionary<string, DateTime>(StringComparer.OrdinalIgnoreCase);

        private void CmdBoltSong(EventContext ctx, string rest, LoadoutSettings s)
        {
            if (string.IsNullOrWhiteSpace(rest))
            {
                if (ChatGate.TrySend(ChatGate.Area.Bolts, "bolts:boltsong-help", TimeSpan.FromSeconds(15)))
                    new MultiPlatformSender(CphPlatformSender.Instance).Send(ctx.Platform,
                        "@" + ctx.User + " usage: " + s.RotationIntegration.Command + " <artist - song>", s.Platforms);
                return;
            }

            // Per-user cooldown.
            var userKey = ctx.Platform.ToShortName() + ":" + ctx.User.ToLowerInvariant();
            if (_boltSongLastUse.TryGetValue(userKey, out var last))
            {
                var since = (DateTime.UtcNow - last).TotalSeconds;
                if (since < s.RotationIntegration.PerUserCooldownSec)
                {
                    var wait = (int)(s.RotationIntegration.PerUserCooldownSec - since);
                    if (ChatGate.TrySend(ChatGate.Area.Bolts, "bolts:boltsong-cd:" + userKey, TimeSpan.FromSeconds(20)))
                        new MultiPlatformSender(CphPlatformSender.Instance).Send(ctx.Platform,
                            "@" + ctx.User + " hold up — " + wait + "s before another " + s.RotationIntegration.Command + ".", s.Platforms);
                    return;
                }
            }

            // Charge Bolts up front. If the Rotation widget rejects the request,
            // the auto-refund timer below puts them back.
            var cost = Math.Max(1, s.RotationIntegration.Cost);
            var ok = BoltsWallet.Instance.Spend(ctx.Platform.ToShortName(), ctx.User, cost,
                "boltsong:" + rest);
            if (!ok)
            {
                if (ChatGate.TrySend(ChatGate.Area.Bolts, "bolts:boltsong-poor:" + userKey, TimeSpan.FromSeconds(8)))
                    new MultiPlatformSender(CphPlatformSender.Instance).Send(ctx.Platform,
                        "@" + ctx.User + " not enough " + s.Bolts.Emoji + " (" + cost + " needed).", s.Platforms);
                return;
            }
            _boltSongLastUse[userKey] = DateTime.UtcNow;
            var requestId = Guid.NewGuid().ToString("N");

            // Publish to the bus for Rotation to pick up. Priority flag so it
            // bypasses the widget's normal !sr cooldowns / gating.
            AquiloBus.Instance.Publish("rotation.song.request", new
            {
                requestId,
                user = ctx.User,
                displayName = ctx.User,
                platform = ctx.Platform.ToShortName(),
                text = rest,
                priority = true,
                paid = new { currency = "bolts", amount = cost }
            });

            // Schedule a refund check: if Rotation hasn't acknowledged with
            // rotation.song.accepted within RefundOnFailureSec, refund the
            // Bolts. Rotation can also actively reject by publishing
            // rotation.song.rejected — handled in OnEvent below.
            ScheduleRefundIfUnacknowledged(ctx, s, requestId, cost, rest);

            if (ChatGate.TrySend(ChatGate.Area.Bolts, "bolts:boltsong:" + userKey, TimeSpan.FromSeconds(2)))
                new MultiPlatformSender(CphPlatformSender.Instance).Send(ctx.Platform,
                    "🎵 " + ctx.User + " spent " + cost + " " + s.Bolts.Emoji + " for a song request — '" + rest + "'", s.Platforms);
        }

        // requestId → (user, platform, amount, songText, deadlineUtc, acknowledged)
        private readonly Dictionary<string, (string User, string Platform, int Amount, string Text, DateTime Deadline, bool Done)> _pendingBoltSongs
            = new Dictionary<string, (string, string, int, string, DateTime, bool)>();

        private void ScheduleRefundIfUnacknowledged(EventContext ctx, LoadoutSettings s, string requestId, int cost, string songText)
        {
            var deadline = DateTime.UtcNow.AddSeconds(Math.Max(5, s.RotationIntegration.RefundOnFailureSec));
            lock (_pendingBoltSongs)
                _pendingBoltSongs[requestId] = (ctx.User, ctx.Platform.ToShortName(), cost, songText, deadline, false);
        }

        // Called from OnEvent's rotation.song.accepted / .rejected handler below.
        private void HandleRotationAck(string requestId, bool accepted, string reason)
        {
            (string User, string Platform, int Amount, string Text, DateTime Deadline, bool Done) entry;
            lock (_pendingBoltSongs)
            {
                if (!_pendingBoltSongs.TryGetValue(requestId, out entry)) return;
                entry.Done = true;
                _pendingBoltSongs[requestId] = entry;
            }

            if (!accepted)
            {
                // Refund.
                BoltsWallet.Instance.Earn(entry.Platform, entry.User, entry.Amount,
                    "boltsong-refund:" + (reason ?? "rejected"));
                AquiloBus.Instance.Publish("bolts.refunded", new
                {
                    user = entry.User, platform = entry.Platform, amount = entry.Amount,
                    reason = "rotation-rejected:" + (reason ?? "")
                });
                var s = SettingsManager.Instance.Current;
                if (ChatGate.TrySend(ChatGate.Area.Bolts, "bolts:boltsong-refund", TimeSpan.FromSeconds(5)))
                    new MultiPlatformSender(CphPlatformSender.Instance).Send(PlatformMaskExtensions.FromShortName(entry.Platform),
                        "@" + entry.User + " song request couldn't queue (" + (reason ?? "rejected") + "). Bolts refunded.",
                        s.Platforms);
            }
        }

        private static void CmdBolts(EventContext ctx, string rest, LoadoutSettings s)
        {
            string lookupHandle = ctx.User;
            if (!string.IsNullOrEmpty(rest)) lookupHandle = rest.Trim().TrimStart('@');

            var balance = BoltsWallet.Instance.Balance(ctx.Platform.ToShortName(), lookupHandle);
            string text = balance <= 0
                ? "@" + ctx.User + " — " + lookupHandle + " has no Bolts yet."
                : "@" + ctx.User + " — " + lookupHandle + ": " + balance + " " + s.Bolts.Emoji;

            if (!ChatGate.TrySend(ChatGate.Area.Bolts, "bolts:bolts", TimeSpan.FromSeconds(8))) return;
            new MultiPlatformSender(CphPlatformSender.Instance).Send(ctx.Platform, text, s.Platforms);
        }

        private static void CmdLeaderboard(EventContext ctx, LoadoutSettings s)
        {
            var top = BoltsWallet.Instance.Top(5);
            if (top.Count == 0) return;
            var line = "🏆 Top Bolts: " + string.Join("  ", top.Select((a, i) =>
                (i + 1) + ". " + a.Display + " (" + a.Balance + ")"));

            if (!ChatGate.TrySend(ChatGate.Area.Bolts, "bolts:lb", TimeSpan.FromSeconds(30))) return;
            new MultiPlatformSender(CphPlatformSender.Instance).Send(ctx.Platform, line, s.Platforms);
        }

        private static void CmdGift(EventContext ctx, string rest, LoadoutSettings s)
        {
            var parts = (rest ?? "").Split(new[] { ' ' }, 2, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 2)
            {
                if (ChatGate.TrySend(ChatGate.Area.Bolts, "bolts:gift-help", TimeSpan.FromSeconds(20)))
                    new MultiPlatformSender(CphPlatformSender.Instance)
                        .Send(ctx.Platform, "@" + ctx.User + " usage: !gift @user <amount>", s.Platforms);
                return;
            }
            var target = parts[0].TrimStart('@');
            if (!long.TryParse(parts[1], out var amount) || amount < s.Bolts.GiftMinAmount) return;
            if (string.Equals(target, ctx.User, StringComparison.OrdinalIgnoreCase)) return;

            var ok = BoltsWallet.Instance.Transfer(
                ctx.Platform.ToShortName(), ctx.User,
                ctx.Platform.ToShortName(), target,
                amount);
            if (!ok) return;

            AquiloBus.Instance.Publish("bolts.gifted", new
            {
                from = ctx.User, to = target, amount,
                platform = ctx.Platform.ToShortName()
            });

            // Re-dispatch as a "boltsSpent" event so ApexModule (and any future
            // damage-counting module) can react. We forward the gifter's
            // identity so they get attribution for the damage.
            try
            {
                var spentArgs = new System.Collections.Generic.Dictionary<string, object>(ctx.Raw)
                {
                    ["amount"] = (int)amount
                };
                Sb.SbEventDispatcher.Instance.DispatchEvent("boltsSpent", spentArgs);
            }
            catch { }

            if (!ChatGate.TrySend(ChatGate.Area.Bolts, "bolts:gift", TimeSpan.FromSeconds(2))) return;
            new MultiPlatformSender(CphPlatformSender.Instance)
                .Send(ctx.Platform, "💝 " + ctx.User + " sent " + amount + " " + s.Bolts.Emoji + " to " + target + "!", s.Platforms);
        }

        // ── !slots <wager> ───────────────────────────────────────────────
        // Spends `wager` bolts, picks 3 random reels from the configured
        // image pool (or built-in defaults), publishes
        // bolts.minigame.slots so the minigames overlay animates the spin,
        // and pays out per BoltsConfig.SlotsPayoutAllSame / TwoSame.
        private static readonly string[] DefaultSlotsPool = new[]
        {
            "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0",
            "https://static-cdn.jtvnw.net/emoticons/v2/86/default/dark/2.0",
            "https://static-cdn.jtvnw.net/emoticons/v2/354/default/dark/2.0",
            "https://static-cdn.jtvnw.net/emoticons/v2/245/default/dark/2.0",
            "https://static-cdn.jtvnw.net/emoticons/v2/425618/default/dark/2.0",
            "https://static-cdn.jtvnw.net/emoticons/v2/305954156/default/dark/2.0"
        };

        private readonly Random _slotsRng = new Random();

        private void CmdSlots(EventContext ctx, string rest, LoadoutSettings s)
        {
            if (!long.TryParse((rest ?? "").Trim(), out var wager) ||
                wager < s.Bolts.SlotsMinWager || wager > s.Bolts.SlotsMaxWager)
            {
                if (ChatGate.TrySend(ChatGate.Area.Bolts, "bolts:slots:usage", TimeSpan.FromSeconds(2)))
                    new MultiPlatformSender(CphPlatformSender.Instance)
                        .Send(ctx.Platform,
                            "@" + ctx.User + " usage: !slots <wager> (" +
                            s.Bolts.SlotsMinWager + "-" + s.Bolts.SlotsMaxWager + " " + s.Bolts.Emoji + ")",
                            s.Platforms);
                return;
            }

            var platform = ctx.Platform.ToShortName();
            var spent = BoltsWallet.Instance.Spend(platform, ctx.User, wager, "slots");
            if (!spent)
            {
                if (ChatGate.TrySend(ChatGate.Area.Bolts, "bolts:slots:nofunds", TimeSpan.FromSeconds(2)))
                    new MultiPlatformSender(CphPlatformSender.Instance)
                        .Send(ctx.Platform,
                            "@" + ctx.User + " not enough " + s.Bolts.Emoji + " to slot " + wager + ".",
                            s.Platforms);
                return;
            }

            var pool = ResolveSlotsPool(s);
            var reels = new[]
            {
                pool[_slotsRng.Next(pool.Length)],
                pool[_slotsRng.Next(pool.Length)],
                pool[_slotsRng.Next(pool.Length)]
            };

            bool allSame = reels[0] == reels[1] && reels[1] == reels[2];
            bool twoSame = !allSame && (
                reels[0] == reels[1] ||
                reels[1] == reels[2] ||
                reels[0] == reels[2]);

            long payout = 0;
            if (allSame)
            {
                payout = wager * Math.Max(1, (long)s.Bolts.SlotsPayoutAllSame);
                BoltsWallet.Instance.Earn(platform, ctx.User, payout, "slots:jackpot");
            }
            else if (twoSame && s.Bolts.SlotsPayoutTwoSame > 0)
            {
                payout = wager * (long)s.Bolts.SlotsPayoutTwoSame;
                BoltsWallet.Instance.Earn(platform, ctx.User, payout, "slots:two");
            }

            var balance = BoltsWallet.Instance.Balance(platform, ctx.User);

            AquiloBus.Instance.Publish("bolts.minigame.slots", new
            {
                user    = ctx.User,
                wager,
                reels,
                won     = payout > 0,
                payout,
                balance,
                pool,
                ts      = DateTime.UtcNow
            });

            if (!ChatGate.TrySend(ChatGate.Area.Bolts, "bolts:slots:result", TimeSpan.FromSeconds(2))) return;
            string text;
            if (allSame)
                text = "🎰 JACKPOT @" + ctx.User + "! +" + payout + " " + s.Bolts.Emoji + " (×" + s.Bolts.SlotsPayoutAllSame + ")";
            else if (twoSame && payout > 0)
                text = "🎰 @" + ctx.User + " hit two — got " + payout + " " + s.Bolts.Emoji + " back";
            else
                text = "🎰 @" + ctx.User + " spun " + wager + " " + s.Bolts.Emoji + " — no match";
            new MultiPlatformSender(CphPlatformSender.Instance).Send(ctx.Platform, text, s.Platforms);
        }

        private static string[] ResolveSlotsPool(LoadoutSettings s)
        {
            var raw = s.Bolts.SlotsImagePool ?? "";
            if (string.IsNullOrWhiteSpace(raw)) return DefaultSlotsPool;
            var lines = raw.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            var trimmed = lines.Select(l => l.Trim()).Where(l => l.Length > 0).ToArray();
            return trimmed.Length >= 2 ? trimmed : DefaultSlotsPool;
        }

        private void CmdBoltRain(EventContext ctx, string rest, LoadoutSettings s)
        {
            var u = (ctx.UserType ?? "").ToLowerInvariant();
            if (u != "broadcaster" && u != "moderator" && u != "mod") return;

            var parts = (rest ?? "").Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 0) return;
            if (!long.TryParse(parts[0], out var total) || total < s.Bolts.BoltRainMinTotal) return;
            int recipientCap = parts.Length > 1 && int.TryParse(parts[1], out var c)
                ? Math.Min(c, s.Bolts.BoltRainMaxRecipients)
                : Math.Min(20, s.Bolts.BoltRainMaxRecipients);

            // Recent active chatters (last 5 minutes), excluding mods/broadcaster.
            var cutoff = DateTime.UtcNow.AddMinutes(-5);
            var pool = _activeChatters
                .Where(kv => kv.Value > cutoff)
                .Select(kv => kv.Key)
                .Where(name => !string.Equals(name, ctx.User, StringComparison.OrdinalIgnoreCase))
                .ToList();
            if (pool.Count == 0) return;

            // Random selection without replacement, capped.
            var rng = new Random();
            var picked = pool.OrderBy(_ => rng.Next()).Take(recipientCap).ToList();
            var per = Math.Max(1, total / picked.Count);

            foreach (var winner in picked)
                BoltsWallet.Instance.Earn(ctx.Platform.ToShortName(), winner, per, "boltrain");

            AquiloBus.Instance.Publish("bolts.rain", new
            {
                total,
                perRecipient = per,
                recipients = picked,
                by = ctx.User,
                platform = ctx.Platform.ToShortName()
            });

            // Re-dispatch a boltsSpent event so ApexModule deals damage from the broadcaster's spend.
            try
            {
                var spentArgs = new System.Collections.Generic.Dictionary<string, object>(ctx.Raw)
                {
                    ["amount"] = (int)total
                };
                Sb.SbEventDispatcher.Instance.DispatchEvent("boltsSpent", spentArgs);
            }
            catch { }

            if (!ChatGate.TrySend(ChatGate.Area.Bolts, "bolts:rain", TimeSpan.FromSeconds(5))) return;
            new MultiPlatformSender(CphPlatformSender.Instance)
                .Send(ctx.Platform, "⚡ Bolt rain! " + total + " " + s.Bolts.Emoji + " split across " + picked.Count + " active chatters.", s.Platforms);
        }

        // ── Cross-product bus handlers (#17) ─────────────────────────────────

        // Idempotency cache: requestId → (success, balanceAfter). Prevents
        // double-charging if a client retries a flaky request.
        private readonly Dictionary<string, (bool ok, long balance, string reason)> _spendIdempotency
            = new Dictionary<string, (bool, long, string)>();

        private Bus.BusMessage HandleSpendRequest(string fromClient, Bus.BusMessage incoming)
        {
            var s = SettingsManager.Instance.Current;
            BoltsWallet.Instance.Initialize();

            var data      = incoming.Data;
            var user      = (string)data?["user"];
            var platform  = (string)data?["platform"];
            var amount    = (long?)data?["amount"] ?? 0;
            var reason    = (string)data?["reason"] ?? "external";
            var requestId = (string)data?["requestId"];

            if (string.IsNullOrEmpty(user) || string.IsNullOrEmpty(platform) || amount <= 0)
                return Reply("bolts.spend.failed", new { requestId, error = "bad-request" });

            // Idempotency: if we've already processed this requestId, replay the result.
            if (!string.IsNullOrEmpty(requestId) && _spendIdempotency.TryGetValue(requestId, out var prior))
            {
                return Reply(prior.ok ? "bolts.spend.completed" : "bolts.spend.failed", new
                {
                    requestId, balance = prior.balance, reason = prior.reason, replay = true
                });
            }

            var ok = BoltsWallet.Instance.Spend(platform, user, amount, reason);
            var balance = BoltsWallet.Instance.Balance(platform, user);

            if (!string.IsNullOrEmpty(requestId))
                _spendIdempotency[requestId] = (ok, balance, ok ? reason : "insufficient");

            // Bus event so overlays can render.
            AquiloBus.Instance.Publish(ok ? "bolts.spent" : "bolts.spend.declined", new
            {
                user, platform, amount, reason, balance, by = fromClient
            });

            return Reply(ok ? "bolts.spend.completed" : "bolts.spend.failed", new
            {
                requestId,
                user, platform, amount, balance,
                error = ok ? null : "insufficient-funds"
            });
        }

        private Bus.BusMessage HandleRefund(string fromClient, Bus.BusMessage incoming)
        {
            BoltsWallet.Instance.Initialize();
            var data      = incoming.Data;
            var user      = (string)data?["user"];
            var platform  = (string)data?["platform"];
            var amount    = (long?)data?["amount"] ?? 0;
            var reason    = (string)data?["reason"] ?? "refund";
            var requestId = (string)data?["requestId"];

            if (string.IsNullOrEmpty(user) || string.IsNullOrEmpty(platform) || amount <= 0)
                return Reply("bolts.refund.failed", new { requestId, error = "bad-request" });

            var balance = BoltsWallet.Instance.Earn(platform, user, amount, "refund:" + reason);

            // Drop any earlier spend's idempotency so a retry doesn't double-spend
            // after a refund.
            if (!string.IsNullOrEmpty(requestId)) _spendIdempotency.Remove(requestId);

            AquiloBus.Instance.Publish("bolts.refunded", new
            {
                user, platform, amount, reason, balance, by = fromClient
            });
            return Reply("bolts.refund.completed", new { requestId, user, platform, amount, balance });
        }

        private Bus.BusMessage HandleBalanceQuery(string fromClient, Bus.BusMessage incoming)
        {
            BoltsWallet.Instance.Initialize();
            var data     = incoming.Data;
            var user     = (string)data?["user"];
            var platform = (string)data?["platform"];
            if (string.IsNullOrEmpty(user) || string.IsNullOrEmpty(platform))
                return Reply("bolts.balance.result", new { balance = 0L });
            var balance = BoltsWallet.Instance.Balance(platform, user);
            return Reply("bolts.balance.result", new { user, platform, balance });
        }

        private static Bus.BusMessage Reply(string kind, object data) => new Bus.BusMessage
        {
            V = 1,
            Kind = kind,
            Data = data == null ? null : Newtonsoft.Json.Linq.JToken.FromObject(data)
        };

        // ── Bus snapshots ─────────────────────────────────────────────────────

        private static void PublishLeaderboard()
        {
            var top = BoltsWallet.Instance.Top(10);
            if (top.Count == 0) return;
            AquiloBus.Instance.Publish("bolts.leaderboard", new
            {
                top = top.Select(a => new { handle = a.Display, balance = a.Balance }).ToArray()
            });
        }
    }
}
