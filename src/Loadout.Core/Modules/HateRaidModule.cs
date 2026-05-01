using System;
using System.Collections.Generic;
using System.Linq;
using Loadout.Patreon;
using Loadout.Sb;
using Loadout.Settings;

namespace Loadout.Modules
{
    /// <summary>
    /// Detects a hate-raid pattern: in a short window, several brand-new accounts
    /// post chat messages. Triggers a private DM/log to the broadcaster (no chat
    /// noise) and — phase 2 — flips followers-only mode automatically.
    ///
    /// Heuristic only. Account-age is read from CPH args when SB exposes it
    /// (Twitch + YouTube usually do); when missing we don't count the message.
    /// </summary>
    public sealed class HateRaidModule : IEventModule
    {
        private sealed class Hit { public DateTime Utc; public string User; }
        private readonly List<Hit> _recent = new List<Hit>();
        private DateTime _lastWarnUtc = DateTime.MinValue;

        public void OnTick() { }

        public void OnEvent(EventContext ctx)
        {
            if (ctx.Kind != "chat") return;
            var s = SettingsManager.Instance.Current;
            if (!s.Modules.HateRaidDetector) return;
            if (!Entitlements.IsUnlocked(Feature.HateRaidDetector)) return;

            // Pull account age in hours; if SB didn't supply it on this platform, abstain.
            var ageHours = ctx.Get<int>("accountAgeHours", -1);
            if (ageHours < 0 || ageHours > s.Moderation.HateRaidAccountAgeHrs) return;

            lock (_recent)
            {
                _recent.Add(new Hit { Utc = DateTime.UtcNow, User = ctx.User });
                var cutoff = DateTime.UtcNow - TimeSpan.FromSeconds(s.Moderation.HateRaidWindowSec);
                _recent.RemoveAll(h => h.Utc < cutoff);

                var distinct = _recent.Select(h => h.User).Distinct(StringComparer.OrdinalIgnoreCase).Count();
                if (distinct < s.Moderation.HateRaidMinAccounts) return;

                // Don't spam-warn — at most once per detection window.
                if ((DateTime.UtcNow - _lastWarnUtc).TotalSeconds < s.Moderation.HateRaidWindowSec) return;
                _lastWarnUtc = DateTime.UtcNow;
            }

            SbBridge.Instance.LogWarn(
                $"[Loadout] HATE RAID SUSPECTED: {_recent.Count} fresh accounts in {SettingsManager.Instance.Current.Moderation.HateRaidWindowSec}s. " +
                "Consider enabling followers-only mode.");
            // Phase 2: programmatically toggle followers-only via the SB API.
        }
    }
}
