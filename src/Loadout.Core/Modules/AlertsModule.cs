using System;
using Loadout.Patreon;
using Loadout.Platforms;
using Loadout.Sb;
using Loadout.Settings;
using Loadout.Util;

namespace Loadout.Modules
{
    /// <summary>
    /// Renders alert messages for follow/sub/cheer/raid/super-chat/etc. Templates
    /// live in <see cref="LoadoutSettings.Alerts"/>; the user edits them in the
    /// Settings → Alerts tab. Sending is multi-platform-aware (we mirror Twitch
    /// alerts to YouTube/Kick if those platforms are connected & enabled).
    /// </summary>
    public sealed class AlertsModule : IEventModule
    {
        public void OnTick() { }

        public void OnEvent(EventContext ctx)
        {
            var s = SettingsManager.Instance.Current;
            if (!s.Modules.Alerts) return;

            string template = null;
            switch (ctx.Kind)
            {
                case "follow":      template = If(s.Alerts.Follow);     break;
                case "sub":         template = If(s.Alerts.Sub);        break;
                case "resub":       template = If(s.Alerts.Resub);      break;
                case "giftSub":     template = If(s.Alerts.GiftSub);    break;
                case "cheer":       template = If(s.Alerts.Cheer);      break;
                case "raid":        template = If(s.Alerts.Raid);       break;
                case "superChat":   template = If(s.Alerts.SuperChat);  break;
                case "membership":  template = If(s.Alerts.Membership); break;
                case "kickSub":     template = If(s.Alerts.KickSub);    break;
                case "kickGift":    template = If(s.Alerts.KickGift);   break;
                case "tiktokGift":  template = If(s.Alerts.TikTokGift); break;
            }

            if (string.IsNullOrEmpty(template)) return;

            // Gate: free tier gets Twitch-only alert mirroring; multi-platform
            // send is a Plus feature.
            var target = Entitlements.IsUnlocked(Feature.MultiPlatformSend)
                ? PlatformMask.All
                : PlatformMask.Twitch;

            // Free tier additionally caps to "basic" alert kinds (follow/sub/cheer/raid).
            if (!Entitlements.IsUnlocked(Feature.MultiPlatformSend) &&
                ctx.Kind != "follow" && ctx.Kind != "sub" && ctx.Kind != "resub" &&
                ctx.Kind != "cheer" && ctx.Kind != "raid")
            {
                return;
            }

            // Coalesce alert spam: per-kind 3s cooldown so a sub burst posts one
            // line, not five. The underlying bus events fire normally so overlays
            // see every individual alert.
            if (!ChatGate.TrySend(ChatGate.Area.Alerts, "alert:" + ctx.Kind, TimeSpan.FromSeconds(3))) return;

            var rendered = Render(template, ctx);
            new MultiPlatformSender(CphPlatformSender.Instance).Send(target, rendered, s.Platforms);
        }

        private static string If(AlertTemplate t) =>
            t != null && t.Enabled ? t.Message : null;

        private static string Render(string template, EventContext ctx)
        {
            if (string.IsNullOrEmpty(template)) return template;
            return template
                .Replace("{user}",     Safe(ctx.User))
                .Replace("{tier}",     Safe(ctx.Get("tier",    "1")))
                .Replace("{months}",   Safe(ctx.Get("months",  "1")))
                .Replace("{gifter}",   Safe(ctx.Get("gifter",  ctx.User)))
                .Replace("{count}",    Safe(ctx.Get("count",   "1")))
                .Replace("{bits}",     Safe(ctx.Get("bits",    "0")))
                .Replace("{viewers}",  Safe(ctx.Get("viewers", "0")))
                .Replace("{amount}",   Safe(ctx.Get("amount",  "")))
                .Replace("{gift}",     Safe(ctx.Get("gift",    "")))
                .Replace("{coins}",    Safe(ctx.Get("coins",   "0")));
        }

        private static string Safe(object v) => v == null ? "" : v.ToString();
    }
}
