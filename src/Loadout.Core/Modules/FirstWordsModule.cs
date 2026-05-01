using Loadout.Bus;
using Loadout.Platforms;
using Loadout.Sb;
using Loadout.Settings;

namespace Loadout.Modules
{
    /// <summary>
    /// Celebrates a viewer's very first message ever in the channel. Hooks the
    /// platform-native first-word events (Twitch event 120, YouTube 4016) -
    /// SB tracks the "ever-seen" set in firstwords.db, so we don't have to
    /// maintain that ourselves.
    ///
    /// Free tier - simple chat shoutout. Bus event also fires so an overlay
    /// can drop confetti or whatever.
    /// </summary>
    public sealed class FirstWordsModule : IEventModule
    {
        public void OnTick() { }

        public void OnEvent(EventContext ctx)
        {
            if (ctx.Kind != "firstWords") return;
            var s = SettingsManager.Instance.Current;
            if (!s.Modules.FirstWords) return;

            var msg = "🎉 First time chatting? Welcome " + ctx.User + "!";
            new MultiPlatformSender(CphPlatformSender.Instance).Send(ctx.Platform, msg, s.Platforms);

            AquiloBus.Instance.Publish("firstwords.celebrated", new
            {
                user     = ctx.User,
                platform = ctx.Platform.ToShortName(),
                message  = ctx.Message
            });
        }
    }
}
