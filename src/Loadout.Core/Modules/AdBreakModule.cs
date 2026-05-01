using Loadout.Bus;
using Loadout.Platforms;
using Loadout.Sb;
using Loadout.Settings;

namespace Loadout.Modules
{
    /// <summary>
    /// Twitch fires <c>UpcomingAd</c> ~30s before an ad break runs. We post a
    /// chat heads-up and emit a bus event for any "ad countdown" overlay to
    /// display a timer. Free tier - keeps community engaged through breaks.
    /// </summary>
    public sealed class AdBreakModule : IEventModule
    {
        public void OnTick() { }

        public void OnEvent(EventContext ctx)
        {
            if (ctx.Kind != "upcomingAd") return;
            var s = SettingsManager.Instance.Current;
            if (!s.Modules.AdBreak) return;

            // SB args expose: durationSeconds, scheduledAtUtc, isAutomatic.
            var duration = ctx.Get<int>("durationSeconds", ctx.Get<int>("length", 90));
            var msg = "⏸ Ad break in 30s (" + duration + "s long). See you on the other side! 💜";
            new MultiPlatformSender(CphPlatformSender.Instance).Send(PlatformMask.Twitch, msg, s.Platforms);

            AquiloBus.Instance.Publish("ads.upcoming", new
            {
                durationSeconds = duration,
                isAutomatic     = ctx.Get<bool>("isAutomatic", false),
                ts              = System.DateTime.UtcNow
            });
        }
    }
}
