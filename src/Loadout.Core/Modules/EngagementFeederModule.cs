using Loadout.Engagement;
using Loadout.Sb;
using Loadout.Settings;

namespace Loadout.Modules
{
    /// <summary>
    /// Funnel for the EngagementTracker. Every other module listens for its
    /// own concern; this one exists purely to write to the tracker so we
    /// don't sprinkle <c>EngagementTracker.Instance.X</c> calls into ten
    /// other files.
    ///
    /// Order matters: register this BEFORE modules that read from the
    /// tracker (VIP rotation, CC coin tracker) so this round of events is
    /// already counted by the time their consumers run.
    /// </summary>
    public sealed class EngagementFeederModule : IEventModule
    {
        public void OnTick() { }

        public void OnEvent(EventContext ctx)
        {
            EngagementTracker.Instance.Initialize();
            var platform = ctx.Platform.ToShortName();
            switch (ctx.Kind)
            {
                case "chat":
                    EngagementTracker.Instance.TrackChat(platform, ctx.User);
                    return;
                case "sub":
                case "resub":
                    EngagementTracker.Instance.TrackSub(platform, ctx.User,
                        ctx.Get<int>("cumulativeMonths", ctx.Get<int>("months", 1)));
                    return;
                case "giftSub":
                    EngagementTracker.Instance.TrackGiftSub(platform, ctx.User,
                        ctx.Get<int>("count", 1));
                    return;
                case "raid":
                    EngagementTracker.Instance.TrackRaid(platform, ctx.User,
                        ctx.Get<int>("viewers", 0));
                    return;
                case "cheer":
                    EngagementTracker.Instance.TrackBits(platform, ctx.User,
                        ctx.Get<int>("bits", 0));
                    return;
                case "streamOnline":
                    EngagementTracker.Instance.ResetThisStream();
                    return;
            }
        }
    }
}
