using System;
using System.Linq;
using Loadout.Bus;
using Loadout.Patreon;
using Loadout.Sb;
using Loadout.Settings;

namespace Loadout.Modules
{
    /// <summary>
    /// Tracks goal progress and publishes <c>goal.updated</c> on the bus so an
    /// OBS overlay bar can fill in real time. Each goal lives in
    /// <see cref="GoalsConfig.Goals"/>; supported kinds:
    ///
    ///   followers   — increments on every "follow"
    ///   subs        — increments on sub / resub / giftSub
    ///   bits        — adds the bit count from each "cheer"
    ///   coins       — adds TikTok gift coin total
    ///   custom      — only changed via !goal &lt;name&gt; +N (mod-only)
    ///
    /// All free tier; the overlay is part of the same bus family as counters.
    /// </summary>
    public sealed class GoalsModule : IEventModule
    {
        public void OnTick() { }

        public void OnEvent(EventContext ctx)
        {
            var s = SettingsManager.Instance.Current;
            if (!s.Modules.Goals) return;

            switch (ctx.Kind)
            {
                case "follow":   Bump(s, "followers", 1); break;
                case "sub":
                case "resub":    Bump(s, "subs", 1); break;
                case "giftSub":  Bump(s, "subs", Math.Max(1, ctx.Get<int>("count", 1))); break;
                case "cheer":    Bump(s, "bits", ctx.Get<int>("bits", 0)); break;
                case "tiktokGift": Bump(s, "coins", ctx.Get<int>("coins", 0)); break;
                case "chat":     HandleCommand(s, ctx); break;
            }
        }

        private static void HandleCommand(LoadoutSettings s, EventContext ctx)
        {
            var msg = (ctx.Message ?? "").Trim();
            if (!msg.StartsWith("!goal", StringComparison.OrdinalIgnoreCase)) return;
            var u = (ctx.UserType ?? "").ToLowerInvariant();
            if (u != "broadcaster" && u != "moderator" && u != "mod") return;

            var rest = msg.Length > 5 ? msg.Substring(5).Trim() : "";
            if (string.IsNullOrEmpty(rest)) return;
            var parts = rest.Split(new[] { ' ' }, 2);
            if (parts.Length < 2) return;
            var name = parts[0];
            if (!int.TryParse(parts[1].TrimStart('+'), out var delta)) return;
            Bump(s, name, delta);
        }

        private static void Bump(LoadoutSettings s, string kind, int delta)
        {
            if (delta == 0) return;
            var hit = s.Goals.Goals.FirstOrDefault(g =>
                string.Equals(g.Kind, kind, StringComparison.OrdinalIgnoreCase) && g.Enabled);
            if (hit == null) return;

            hit.Current += delta;
            SettingsManager.Instance.Mutate(_ => { /* mutation already applied; trigger save */ });

            AquiloBus.Instance.Publish("goal.updated", new
            {
                name    = hit.Name,
                kind    = hit.Kind,
                current = hit.Current,
                target  = hit.Target,
                percent = hit.Target > 0 ? (int)Math.Round(100.0 * hit.Current / hit.Target) : 0
            });
        }
    }
}
