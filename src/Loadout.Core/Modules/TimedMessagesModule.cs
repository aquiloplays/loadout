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
        private DateTime _lastFiredUtc = DateTime.MinValue;
        private int _seqIndex;

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

            var due = SelectNextMessage(s);
            if (due == null) return;

            var sender = new MultiPlatformSender(CphPlatformSender.Instance);
            var target = due.Platforms.AsMask;
            if (target == PlatformMask.None) target = s.Platforms.AsMask;

            sender.Send(target, due.Message, s.Platforms);

            _lastFiredUtc = DateTime.UtcNow;
        }

        private TimedMessage SelectNextMessage(LoadoutSettings s)
        {
            var now = DateTime.UtcNow;

            // Global broadcaster pause: streamer just talked, so hold off.
            if (s.Timers.BroadcasterPauseSec > 0 &&
                (now - _lastBroadcasterMessageUtc).TotalSeconds < s.Timers.BroadcasterPauseSec)
                return null;

            // Global sequence interval: one message per IntervalMinutes.
            var interval = Math.Max(1, s.Timers.IntervalMinutes);
            if ((now - _lastFiredUtc).TotalMinutes < interval)
                return null;

            // Activity gate: chat must have had MinChatMessages in the last
            // MinChatWindowMinutes — keeps us from yelling into an empty room.
            var window = TimeSpan.FromMinutes(Math.Max(1, s.Timers.MinChatWindowMinutes));
            if (ChatCountIn(window) < s.Timers.MinChatMessages)
                return null;

            // Per-game profile group filter (unchanged behavior).
            var p = GameProfilesModule.ActiveProfile;
            string[] activeGroups = null;
            if (p != null && !string.IsNullOrEmpty(p.ActiveTimerGroups))
                activeGroups = p.ActiveTimerGroups.Split(',')
                    .Select(x => x.Trim()).Where(x => !string.IsNullOrEmpty(x)).ToArray();

            IEnumerable<TimedMessage> source = s.Timers.Messages
                .Where(t => t.Enabled && !string.IsNullOrWhiteSpace(t.Message));
            if (activeGroups != null && activeGroups.Length > 0)
                source = source.Where(t => activeGroups.Contains(t.Group ?? "Default", StringComparer.OrdinalIgnoreCase));

            var list = source.ToList();
            if (list.Count == 0) return null;

            // Sequential pick: cycle through in order; wrap when we hit the end.
            var msg = list[_seqIndex % list.Count];
            _seqIndex = (_seqIndex + 1) % list.Count;
            return msg;
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
