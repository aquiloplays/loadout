using System;

namespace Loadout.Patreon
{
    /// <summary>
    /// One enum, one method - the only place modules ask "can the user use this?".
    /// </summary>
    public enum Feature
    {
        // ── Free tier ──────────────────────────────────────────────────────────
        InfoCommands,           // !uptime, !followage, !so, !lurk, etc.
        BasicTwitchAlerts,      // follow / sub / cheer / raid on Twitch only
        BasicWelcomes,          // first-time + sub greetings
        ThreeTimers,            // up to 3 timed messages
        IdentityLink,           // !link / !linkapprove
        UpdateNotifications,    // tray icon update prompts
        Bolts,                  // basic Bolts wallet (free tier - earn / leaderboard / gift)

        // ── Patreon Tier 2 ($6) ────────────────────────────────────────────────
        MultiPlatformSend,      // YouTube + Kick + TikTok mirroring
        UnlimitedTimers,        // beyond 3
        AllWelcomeTiers,        // VIP / mod / regular variants
        AlertSounds,            // attach .wav / .mp3 to alerts
        WebhookInbox,           // Ko-fi / Throne / Patreon endpoint
        DiscordLiveStatus,      // go-live auto-poster
        BackupRestore,          // zip-export of settings + viewer data
        StreamRecap,            // post-stream summary

        // ── Patreon Tier 3 ($10) ───────────────────────────────────────────────
        AiShoutouts,            // AI-personalized raid shoutouts (or BYOK in free)
        TikTokHypeTrain,        // synthetic hype train on TikTok gifts
        HateRaidDetector,       // pattern-based hate-raid alerts
        SmartAutoClipper,       // chat-velocity / sub-burst clip triggers (Phase 2)
        VodChapterMarkers,      // auto-mark scene/game changes (Phase 2)
        CrossPlatformWallet,    // loyalty currency that follows linked identities
        BetaAccess,             // beta channel updates + early features

        // ── New gates for this round ───────────────────────────────────────────
        UnlimitedCounters,      // free tier capped at 3 counters; Plus removes cap
        DailyCheckIn,           // Daily Check-In overlay event + Patreon flair
        DailyCheckInFlairsPro,  // animated flairs / Patreon flair (Tier 3)
        VipRotationAuto,        // automatic weekly VIP rotation (Tier 3)
        BoltsCrossPlatform      // Patreon multipliers + cross-platform wallet sync (Tier 3)
    }

    /// <summary>
    /// Single source of truth for whether a feature is unlocked. Modules call
    /// <see cref="IsUnlocked"/>; UI binds to <see cref="GetLockReason"/> for
    /// the upsell tooltip.
    /// </summary>
    public static class Entitlements
    {
        /// <summary>
        /// Allows BYOK to unlock <see cref="Feature.AiShoutouts"/> in free tier
        /// (the user pays their own API costs, we don't subsidize).
        /// </summary>
        public static bool HasOwnAiKey =>
            !string.IsNullOrWhiteSpace(Settings.SettingsManager.Instance.Current.Ai.ApiKey);

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
                    return true;

                // Tier 2 ($6) and up
                case Feature.MultiPlatformSend:
                case Feature.UnlimitedTimers:
                case Feature.AllWelcomeTiers:
                case Feature.AlertSounds:
                case Feature.WebhookInbox:
                case Feature.DiscordLiveStatus:
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

                // BYOK-eligible: Tier 3 OR your own API key
                case Feature.AiShoutouts:
                    return tier == "tier3" || HasOwnAiKey;

                default:
                    return false;
            }
        }

        /// <summary>One-liner explaining why the feature is locked, suitable for tooltips.</summary>
        public static string GetLockReason(Feature f)
        {
            if (IsUnlocked(f)) return null;

            var tier = PatreonClient.Instance.Current.Tier ?? "none";
            switch (f)
            {
                case Feature.AiShoutouts:
                    return tier == "tier2"
                        ? "Add your own AI API key (free) or upgrade to Tier 3 for the bundled key."
                        : "Add your own AI API key in Settings -> AI, or join Loadout Pro for the bundled key.";
                case Feature.TikTokHypeTrain:
                case Feature.HateRaidDetector:
                case Feature.SmartAutoClipper:
                case Feature.VodChapterMarkers:
                case Feature.CrossPlatformWallet:
                case Feature.BetaAccess:
                    return "Loadout Pro feature - join the Patreon Tier 3 to unlock.";
                case Feature.UnlimitedTimers:
                    return "Free tier is capped at 3 timers. Loadout Plus removes the limit.";
                default:
                    return "Loadout Plus feature - join the Patreon Tier 2 or above to unlock.";
            }
        }

        public static string CurrentTierDisplay()
        {
            var s = PatreonClient.Instance.Current;
            if (!s.SignedIn) return "Free";
            switch (s.Tier ?? "none")
            {
                case "tier3":    return "Loadout Pro (Tier 3)";
                case "tier2":    return "Loadout Plus (Tier 2)";
                case "tier1":    return "Connected (Tier 1 - upgrade to unlock)";
                case "follower": return "Connected (free follower - upgrade to unlock)";
                default:         return "Connected (no active tier)";
            }
        }
    }
}
