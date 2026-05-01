using System;
using System.Linq;
using Loadout.Bus;
using Loadout.Engagement;
using Loadout.Platforms;
using Loadout.Sb;
using Loadout.Settings;

namespace Loadout.Modules
{
    /// <summary>
    /// Tracks Crowd Control coin spend per viewer. Listens for the SB events
    /// CrowdControlEffectSuccess (20004) and CrowdControlCoinExchange (20009)
    /// — both carry a viewer name and a coin cost. Per-viewer totals roll into
    /// EngagementTracker (this-stream + all-time). Publishes leaderboard
    /// snapshots to the bus.
    ///
    /// Chat surface:
    ///   !cccoins        top 5 contributors this stream
    ///   !cccoinsall     top 5 all-time
    ///   !mycoins        your personal stats
    ///
    /// Free-tier feature.
    /// </summary>
    public sealed class CcCoinTrackerModule : IEventModule
    {
        private DateTime _lastBroadcastUtc = DateTime.MinValue;

        public void OnEvent(EventContext ctx)
        {
            switch (ctx.Kind)
            {
                case "ccEffectSuccess":
                case "ccCoinExchange":
                    HandleSpend(ctx);
                    return;
                case "ccGameSessionStart":
                    // Fresh game session = reset the per-stream rolling counter
                    // so the leaderboard reads as "this play session" rather
                    // than "since SB started".
                    EngagementTracker.Instance.ResetThisStream();
                    return;
                case "chat":
                    HandleChat(ctx);
                    return;
            }
        }

        public void OnTick()
        {
            // Snapshot top 5 to the bus once a minute so overlays can refresh.
            if ((DateTime.UtcNow - _lastBroadcastUtc).TotalSeconds < 60) return;
            _lastBroadcastUtc = DateTime.UtcNow;
            PublishLeaderboard();
        }

        private static void HandleSpend(EventContext ctx)
        {
            var s = SettingsManager.Instance.Current;
            if (!s.Modules.CcCoinTracker) return;
            var user = ctx.User;
            if (string.IsNullOrEmpty(user)) return;

            // CC events vary slightly across SB versions on the cost field name.
            var cost = ctx.Get<int>("cost",
                       ctx.Get<int>("coinCost",
                       ctx.Get<int>("price",
                       ctx.Get<int>("amount", 0))));
            if (cost <= 0) return;

            EngagementTracker.Instance.TrackCcCoins(ctx.Platform.ToShortName(), user, cost);

            AquiloBus.Instance.Publish("cc.coins.spent", new
            {
                user,
                platform = ctx.Platform.ToShortName(),
                cost,
                effect = ctx.Get<string>("effectName", ctx.Get<string>("effect", null))
            });
        }

        private static void HandleChat(EventContext ctx)
        {
            var s = SettingsManager.Instance.Current;
            if (!s.Modules.CcCoinTracker) return;
            var msg = (ctx.Message ?? "").Trim().ToLowerInvariant();

            if (msg == "!cccoins")
            {
                var top = EngagementTracker.Instance.TopBy(5,
                    v => v.CcCoinsThisStream, v => v.CcCoinsThisStream > 0);
                if (top.Count == 0) { Reply(ctx, "No CC coins spent yet this stream."); return; }
                Reply(ctx, "🪙 CC top this stream: " + string.Join(", ",
                    top.Select((v, i) => (i + 1) + ". " + v.Handle + " (" + v.CcCoinsThisStream + ")")));
                return;
            }
            if (msg == "!cccoinsall")
            {
                var top = EngagementTracker.Instance.TopBy(5,
                    v => v.CcCoinsAllTime, v => v.CcCoinsAllTime > 0);
                if (top.Count == 0) { Reply(ctx, "No CC coins tracked yet."); return; }
                Reply(ctx, "🪙 CC all-time: " + string.Join(", ",
                    top.Select((v, i) => (i + 1) + ". " + v.Handle + " (" + v.CcCoinsAllTime + ")")));
                return;
            }
            if (msg == "!mycoins")
            {
                var v = EngagementTracker.Instance.Get(ctx.Platform.ToShortName(), ctx.User);
                if (v == null || v.CcCoinsAllTime == 0) { Reply(ctx, "@" + ctx.User + " — no CC coin spend on record yet."); return; }
                Reply(ctx, "@" + ctx.User + " — " + v.CcCoinsThisStream + " coins this stream, " + v.CcCoinsAllTime + " all-time.");
                return;
            }
        }

        private static void Reply(EventContext ctx, string text)
        {
            var s = SettingsManager.Instance.Current;
            new MultiPlatformSender(CphPlatformSender.Instance).Send(ctx.Platform, text, s.Platforms);
        }

        private static void PublishLeaderboard()
        {
            var top = EngagementTracker.Instance.TopBy(5,
                v => v.CcCoinsThisStream, v => v.CcCoinsThisStream > 0);
            if (top.Count == 0) return;
            AquiloBus.Instance.Publish("cc.coins.leaderboard", new
            {
                top = top.Select(v => new { handle = v.Handle, coins = v.CcCoinsThisStream }).ToArray()
            });
        }
    }
}
