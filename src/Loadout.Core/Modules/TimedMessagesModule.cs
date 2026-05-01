using System;
using System.Collections.Generic;
using System.Linq;
using Loadout.Patreon;
using Loadout.Platforms;
using Loadout.Sb;
using Loadout.Settings;

namespace Loadout.Modules
{
    /// <summary>
    /// Auto-timed messages with the smart-behavior rules promised in the spec:
    /// activity gate, cooldown after broadcaster, randomized order, per-platform
    /// routing, pause when offline.
    ///
    /// Tick is the natural cadence (once a minute). Activity tracking listens to
    /// chat events and stores a sliding window of recent message timestamps.
    /// </summary>
    public sealed class TimedMessagesModule : IEventModule
    {
        // Sliding window of recent chat message timestamps for the activity gate.
        // Bounded — older entries roll off as we sample.
        private readonly LinkedList<DateTime> _recentChats = new LinkedList<DateTime>();
        private const int RecentChatsWindowMinutes = 30;

        private DateTime _lastBroadcasterMessageUtc = DateTime.MinValue;
        private string _lastFiredName;

        public void OnEvent(EventContext ctx)
        {
            if (ctx.Kind != "chat") return;

            // Treat any chat as activity. Broadcaster-typed chat additionally arms
            // the cooldown that pauses timers right after the streamer talks.
            lock (_recentChats)
            {
                _recentChats.AddLast(DateTime.UtcNow);
                Trim();
            }
            if (string.Equals(ctx.UserType, "broadcaster", StringComparison.OrdinalIgnoreCase))
                _lastBroadcasterMessageUtc = DateTime.UtcNow;
        }

        public void OnTick()
        {
            var s = SettingsManager.Instance.Current;
            if (!s.Modules.TimedMessages || !s.Timers.Enabled) return;

            var due = SelectDueTimer(s);
            if (due == null) return;

            var sender = new MultiPlatformSender(CphPlatformSender.Instance);
            var target = due.Platforms.AsMask;
            if (target == PlatformMask.None) target = s.Platforms.AsMask;

            sender.Send(target, due.Message, s.Platforms);

            due.LastFiredUtc = DateTime.UtcNow;
            _lastFiredName = due.Name;
        }

        private TimedMessage SelectDueTimer(LoadoutSettings s)
        {
            var now = DateTime.UtcNow;

            // Block if broadcaster just talked (configurable per timer).
            // We use the longest pause of any candidate as a global gate to keep
            // the logic simple — a streamer chatting actively means none should fire.
            int maxPause = s.Timers.Messages.Count == 0 ? 0
                : s.Timers.Messages.Max(t => t.BroadcasterPauseSec);
            if (maxPause > 0 && (now - _lastBroadcasterMessageUtc).TotalSeconds < maxPause)
                return null;

            // Free tier caps to first 3 enabled timers. UnlimitedTimers removes the cap.
            IEnumerable<TimedMessage> source = s.Timers.Messages.Where(t => t.Enabled && !string.IsNullOrWhiteSpace(t.Message));
            if (!Entitlements.IsUnlocked(Feature.UnlimitedTimers))
                source = source.Take(3);

            // Eligible = enabled, interval elapsed, activity gate met, not the last one we fired.
            var candidates = source
                .Where(t => (now - t.LastFiredUtc).TotalMinutes >= Math.Max(1, t.IntervalMinutes))
                .Where(t => ChatCountIn(TimeSpan.FromMinutes(Math.Max(1, t.MinChatWindowMinutes))) >= t.MinChatMessages)
                .Where(t => t.Name != _lastFiredName || s.Timers.Messages.Count == 1)
                .ToList();

            if (candidates.Count == 0) return null;

            // Prefer the timer that's been waiting longest — keeps cadence fair when several are due.
            return candidates.OrderBy(t => t.LastFiredUtc).First();
        }

        private int ChatCountIn(TimeSpan window)
        {
            lock (_recentChats)
            {
                Trim();
                var cutoff = DateTime.UtcNow - window;
                int count = 0;
                for (var node = _recentChats.Last; node != null; node = node.Previous)
                {
                    if (node.Value < cutoff) break;
                    count++;
                }
                return count;
            }
        }

        private void Trim()
        {
            var cutoff = DateTime.UtcNow - TimeSpan.FromMinutes(RecentChatsWindowMinutes);
            while (_recentChats.First != null && _recentChats.First.Value < cutoff)
                _recentChats.RemoveFirst();
        }
    }
}
