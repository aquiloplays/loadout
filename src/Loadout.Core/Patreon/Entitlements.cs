using System;

namespace Loadout.Patreon
{
    /// <summary>
    /// Feature catalogue for the entitlement system. Every current feature is
    /// free for everyone — no module gates on this any more. Kept as dormant
    /// infrastructure so future early-access features can ship to Patreon
    /// supporters first.
    /// </summary>
    public enum Feature
    {
        // Feature catalogue. Every entry below is currently free for everyone;
        // members are retained so future early-access features have an enum
        // to gate on. Do not delete members — unused entries are harmless.
        InfoCommands,           // !uptime, !followage, !so, !lurk, etc.
        BasicTwitchAlerts,      // follow / sub / cheer / raid on Twitch
        BasicWelcomes,          // first-time + sub greetings
        ThreeTimers,            // timed messages
        IdentityLink,           // !link / !linkapprove
        UpdateNotifications,    // tray icon update prompts
        Bolts,                  // Bolts wallet - earn / leaderboard / gift

        MultiPlatformSend,      // YouTube + Kick + TikTok mirroring
        UnlimitedTimers,        // timed messages
        AllWelcomeTiers,        // VIP / mod / regular variants
        AlertSounds,            // attach .wav / .mp3 to alerts
        WebhookInbox,           // Ko-fi / Throne / Patreon endpoint
        DiscordLiveStatus,      // go-live auto-poster
        TwitterLiveStatus,      // X webhook auto-poster
        BackupRestore,          // zip-export of settings + viewer data
        StreamRecap,            // post-stream summary

        TikTokHypeTrain,        // synthetic hype train on TikTok gifts
        HateRaidDetector,       // pattern-based hate-raid alerts
        SmartAutoClipper,       // chat-velocity / sub-burst clip triggers (Phase 2)
        VodChapterMarkers,      // auto-mark scene/game changes (Phase 2)
        CrossPlatformWallet,    // loyalty currency that follows linked identities
        BetaAccess,             // early-access channel updates

        UnlimitedCounters,      // counters
        DailyCheckIn,           // Daily Check-In overlay event + Patreon flair
        DailyCheckInFlairsPro,  // animated flairs / Patreon flair
        VipRotationAuto,        // automatic weekly VIP rotation
        BoltsCrossPlatform,     // Patreon multipliers + cross-platform wallet sync
        DungeonGame             // Dungeon Crawler + Duel mini-game
    }

    /// <summary>
    /// Single source of truth for feature availability. Dormant today — every
    /// current feature is free for everyone — but retained so future
    /// early-access features can gate on Patreon tier before general rollout.
    /// </summary>
    public static class Entitlements
    {
        public static bool IsUnlocked(Feature f)
        {
            var tier = (PatreonClient.Instance.Current.Entitled
                ? PatreonClient.Instance.Current.Tier
                : "none") ?? "none";
            return IsUnlocked(f, tier);
        }

        public static bool IsUnlocked(Feature f, string tier)
        {
            switch (f)
            {
                // Always free
                case Feature.InfoCommands:
                case Feature.BasicTwitchAlerts:
                case Feature.BasicWelcomes:
                case Feature.ThreeTimers:
                case Feature.IdentityLink:
                case Feature.UpdateNotifications:
                case Feature.Bolts:
                case Feature.DungeonGame:
                    return true;

                // Tier 2 ($6) and up
                case Feature.MultiPlatformSend:
                case Feature.UnlimitedTimers:
                case Feature.AllWelcomeTiers:
                case Feature.AlertSounds:
                case Feature.WebhookInbox:
                case Feature.DiscordLiveStatus:
                case Feature.TwitterLiveStatus:
                case Feature.BackupRestore:
                case Feature.StreamRecap:
                case Feature.UnlimitedCounters:
                case Feature.DailyCheckIn:
                    return tier == "tier2" || tier == "tier3";

                // Tier 3 ($10) only
                case Feature.TikTokHypeTrain:
                case Feature.HateRaidDetector:
                case Feature.SmartAutoClipper:
                case Feature.VodChapterMarkers:
                case Feature.CrossPlatformWallet:
                case Feature.BetaAccess:
                case Feature.DailyCheckInFlairsPro:
                case Feature.VipRotationAuto:
                case Feature.BoltsCrossPlatform:
                    return tier == "tier3";

                default:
                    return false;
            }
        }

        /// <summary>
        /// One-liner describing a feature's availability, suitable for tooltips.
        /// Dormant: every current feature is free for everyone. Kept as
        /// infrastructure for future early-access features.
        /// </summary>
        public static string GetLockReason(Feature f)
        {
            if (IsUnlocked(f)) return null;
            return "This is an early-access feature for Patreon Tier 2 and Tier 3 supporters. It rolls out to everyone shortly after.";
        }

        public static string CurrentTierDisplay()
        {
            var s = PatreonClient.Instance.Current;
            if (!s.SignedIn) return "Free";
            switch (s.Tier ?? "none")
            {
                case "tier3":    return "Patreon Tier 3 supporter";
                case "tier2":    return "Patreon Tier 2 supporter";
                case "tier1":    return "Connected (Patreon Tier 1)";
                case "follower": return "Connected (Patreon follower)";
                default:         return "Connected (no active tier)";
            }
        }
    }
}
