using System;

namespace Loadout.Settings
{
    /// <summary>
    /// Bitmask representing which platforms an action targets or listens to.
    /// </summary>
    [Flags]
    public enum PlatformMask
    {
        None    = 0,
        Twitch  = 1 << 0,
        TikTok  = 1 << 1,
        YouTube = 1 << 2,
        Kick    = 1 << 3,
        All     = Twitch | TikTok | YouTube | Kick
    }

    public static class PlatformMaskExtensions
    {
        public static bool Has(this PlatformMask mask, PlatformMask flag) =>
            (mask & flag) == flag;

        public static string ToShortName(this PlatformMask p) => p switch
        {
            PlatformMask.Twitch  => "twitch",
            PlatformMask.TikTok  => "tiktok",
            PlatformMask.YouTube => "youtube",
            PlatformMask.Kick    => "kick",
            _ => "unknown"
        };

        public static PlatformMask FromShortName(string name)
        {
            if (string.IsNullOrWhiteSpace(name)) return PlatformMask.None;
            switch (name.Trim().ToLowerInvariant())
            {
                case "twitch":  return PlatformMask.Twitch;
                case "tiktok":  return PlatformMask.TikTok;
                case "youtube":
                case "yt":      return PlatformMask.YouTube;
                case "kick":    return PlatformMask.Kick;
                default:        return PlatformMask.None;
            }
        }
    }
}
