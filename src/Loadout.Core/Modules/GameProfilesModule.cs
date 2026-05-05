using System;
using System.Linq;
using Loadout.Bus;
using Loadout.Sb;
using Loadout.Settings;

namespace Loadout.Modules
{
    /// <summary>
    /// Per-game profile lookup. When the Twitch category changes (the
    /// streamOnline / streamUpdate / categoryChanged events all surface
    /// the new category), we pick the first profile whose GameName matches
    /// (case-insensitive) and stash it on a static for other modules to
    /// consult.
    ///
    /// Modules that opt into profile overrides:
    ///   - WelcomesModule reads ActiveProfile?.WelcomeFirstTime/Sub/Regular
    ///     and prefers a non-empty profile value over the global one.
    ///   - TimedMessagesModule filters timers by ActiveProfile.ActiveTimerGroups
    ///     when set, otherwise runs every timer (existing behavior).
    ///
    /// This module is purely a side-effect publisher; it does not handle
    /// chat or perform any output of its own.
    /// </summary>
    public sealed class GameProfilesModule : IEventModule
    {
        // Read by other modules. Plain field on a static so callers don't
        // need an extra dependency on this class.
        public static volatile GameProfile ActiveProfile;

        public void OnEvent(EventContext ctx)
        {
            string game = null;
            switch (ctx.Kind)
            {
                case "streamOnline":
                case "streamUpdate":
                case "categoryChanged":
                    game = ctx.Get<string>("category", ctx.Get<string>("game", null));
                    break;
                case "streamOffline":
                    SetActive(null);
                    return;
                default:
                    return;
            }
            if (string.IsNullOrEmpty(game)) return;
            ApplyForGame(game);
        }

        public void OnTick() { /* no-op */ }

        public static void ApplyForGame(string game)
        {
            var s = SettingsManager.Instance.Current;
            if (!s.GameProfiles.Enabled) { SetActive(null); return; }
            var match = s.GameProfiles.Profiles?.FirstOrDefault(p =>
                !string.IsNullOrEmpty(p.GameName) &&
                string.Equals(p.GameName, game, StringComparison.OrdinalIgnoreCase));
            SetActive(match);
        }

        private static void SetActive(GameProfile p)
        {
            var prev = ActiveProfile;
            ActiveProfile = p;
            if (!ReferenceEquals(prev, p))
            {
                AquiloBus.Instance.Publish("gameprofile.activated", new
                {
                    name  = p?.GameName,
                    notes = p?.Notes,
                    ts    = DateTime.UtcNow
                });
            }
        }
    }
}
