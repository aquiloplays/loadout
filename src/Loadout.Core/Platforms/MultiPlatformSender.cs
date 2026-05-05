using System;
using System.Collections.Generic;
using Loadout.Settings;

namespace Loadout.Platforms
{
    /// <summary>
    /// Routes a single message to multiple platforms based on a mask AND the
    /// user's enabled-platforms config. Honors per-platform rate limits with a
    /// simple sliding window so YouTube doesn't trip its strict caps.
    /// </summary>
    public sealed class MultiPlatformSender
    {
        private readonly IPlatformSender _sender;
        private readonly Dictionary<PlatformMask, RateLimiter> _limiters;

        // Per-platform per-minute caps. Conservative defaults.
        private static readonly Dictionary<PlatformMask, int> DefaultPerMinuteCaps =
            new Dictionary<PlatformMask, int>
            {
                { PlatformMask.Twitch,  90 },  // mod = 100/30s, regular = 20/30s. We aim safe.
                { PlatformMask.YouTube, 15 },  // YT live chat is much stricter
                { PlatformMask.Kick,    30 },
                { PlatformMask.TikTok,  6  }   // sent via PlatformsConfig.TikTokSendActionName (TikFinity bridge)
            };

        public MultiPlatformSender(IPlatformSender sender)
        {
            _sender = sender ?? throw new ArgumentNullException(nameof(sender));
            _limiters = new Dictionary<PlatformMask, RateLimiter>();
            foreach (var kv in DefaultPerMinuteCaps)
                _limiters[kv.Key] = new RateLimiter(kv.Value, TimeSpan.FromMinutes(1));
        }

        /// <summary>
        /// Send a message to every platform in <paramref name="target"/> that is also
        /// enabled in user settings and has capacity in its rate limiter.
        /// Returns the platforms actually sent to.
        /// </summary>
        public PlatformMask Send(PlatformMask target, string message, PlatformsConfig enabled)
        {
            if (string.IsNullOrEmpty(message)) return PlatformMask.None;

            // Dry-run mode: log what would have been sent and bail out.
            // Honors the per-platform enabled mask + 0-cap (read-only TikTok)
            // skip so the log mirrors the live path's destination set.
            if (SettingsManager.Instance.Current.DryRun)
            {
                var would = PlatformMask.None;
                foreach (var p in EnumeratePlatforms(target))
                {
                    if (!IsEnabled(p, enabled)) continue;
                    if (DefaultPerMinuteCaps.TryGetValue(p, out var dryCap) && dryCap == 0) continue;
                    would |= p;
                }
                Loadout.Util.ErrorLog.Write(
                    "DryRun.Send",
                    new Exception("[dry-run] would have sent to " + would + ": " + message));
                return would;
            }

            var sent = PlatformMask.None;
            foreach (var p in EnumeratePlatforms(target))
            {
                if (!IsEnabled(p, enabled)) continue;
                if (DefaultPerMinuteCaps.TryGetValue(p, out var cap) && cap == 0) continue;
                if (!_sender.IsConnected(p)) continue;
                if (!_limiters[p].TryAcquire()) continue;

                _sender.Send(p, message);
                sent |= p;
            }
            return sent;
        }

        private static bool IsEnabled(PlatformMask p, PlatformsConfig cfg) => p switch
        {
            PlatformMask.Twitch  => cfg.Twitch,
            PlatformMask.TikTok  => cfg.TikTok,
            PlatformMask.YouTube => cfg.YouTube,
            PlatformMask.Kick    => cfg.Kick,
            _ => false
        };

        private static IEnumerable<PlatformMask> EnumeratePlatforms(PlatformMask mask)
        {
            if (mask.Has(PlatformMask.Twitch))  yield return PlatformMask.Twitch;
            if (mask.Has(PlatformMask.TikTok))  yield return PlatformMask.TikTok;
            if (mask.Has(PlatformMask.YouTube)) yield return PlatformMask.YouTube;
            if (mask.Has(PlatformMask.Kick))    yield return PlatformMask.Kick;
        }
    }

    internal sealed class RateLimiter
    {
        private readonly int _max;
        private readonly TimeSpan _window;
        private readonly Queue<DateTime> _timestamps = new Queue<DateTime>();
        private readonly object _gate = new object();

        public RateLimiter(int max, TimeSpan window)
        {
            _max = max;
            _window = window;
        }

        public bool TryAcquire()
        {
            lock (_gate)
            {
                var now = DateTime.UtcNow;
                while (_timestamps.Count > 0 && (now - _timestamps.Peek()) > _window)
                    _timestamps.Dequeue();
                if (_timestamps.Count >= _max) return false;
                _timestamps.Enqueue(now);
                return true;
            }
        }
    }
}
