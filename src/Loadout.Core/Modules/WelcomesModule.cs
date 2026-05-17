using System;
using System.Collections.Generic;
using Loadout.Patreon;
using Loadout.Platforms;
using Loadout.Sb;
using Loadout.Settings;
using Loadout.Util;

namespace Loadout.Modules
{
    /// <summary>
    /// Greets viewers based on their role (first-time / returning / regular / sub
    /// / VIP / mod). Tracks who's been seen this session in memory — across
    /// sessions we rely on SB's ChatMessage args carrying isFirstChat or similar
    /// flags. Persistence of "ever seen" is intentionally out of scope here so
    /// we don't bloat settings.json; phase 2 adds a SQLite store.
    /// </summary>
    public sealed class WelcomesModule : IEventModule
    {
        // Cap memory growth on long streams — even big chats rarely exceed a few thousand uniques.
        private const int MaxSeenInSession = 5000;
        private readonly HashSet<string> _seenThisSession = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        public void OnTick() { }

        public void OnEvent(EventContext ctx)
        {
            if (ctx.Kind != "chat") return;
            var s = SettingsManager.Instance.Current;
            if (!s.Modules.ContextWelcomes || !s.Welcomes.Enabled) return;
            if (string.IsNullOrEmpty(ctx.User)) return;

            var key = ctx.Platform.ToShortName() + ":" + ctx.User.ToLowerInvariant();
            if (_seenThisSession.Contains(key)) return;

            // Cap the set; if we hit the limit, just stop tracking — better than evicting
            // randomly which would re-greet someone we already greeted.
            if (_seenThisSession.Count >= MaxSeenInSession) return;
            _seenThisSession.Add(key);

            var template = PickTemplate(ctx.UserType, s.Welcomes);
            if (string.IsNullOrEmpty(template)) return;
            var msg = template.Replace("{user}", ctx.User);

            // Welcomes need a per-user gate (we already dedup) plus the global cap
            // so a busy chat doesn't get swamped — we cap at one welcome per 4s to
            // keep the chat readable.
            if (!ChatGate.TrySend(ChatGate.Area.Welcomes, "welcome:burst", TimeSpan.FromSeconds(4))) return;

            // Reply on the platform that originated the chat — never cross-post welcomes.
            new MultiPlatformSender(CphPlatformSender.Instance)
                .Send(ctx.Platform, msg, s.Platforms);
            EventStats.Instance.Hit(ctx.Kind, nameof(WelcomesModule));
        }

        private static string PickTemplate(string userType, WelcomesConfig cfg)
        {
            // Per-game profile override: if a profile is active and has a
            // non-empty value for this role, prefer it over the global
            // template. Empty profile fields fall through.
            var p = GameProfilesModule.ActiveProfile;

            switch ((userType ?? "viewer").ToLowerInvariant())
            {
                case "broadcaster": return null;
                case "moderator":
                case "mod":         return cfg.Mod;
                case "vip":         return cfg.Vip;
                case "subscriber":
                case "sub":
                    return !string.IsNullOrEmpty(p?.WelcomeSub) ? p.WelcomeSub : cfg.Sub;
                default:
                    return !string.IsNullOrEmpty(p?.WelcomeFirstTime) ? p.WelcomeFirstTime : cfg.FirstTime;
            }
        }
    }
}
