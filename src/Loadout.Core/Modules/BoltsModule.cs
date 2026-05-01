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
            }
        }

        public void OnTick()
        {
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
