using System;
using System.Collections.Generic;

namespace Loadout.Util
{
    /// <summary>
    /// Per-session counter of dispatched event kinds. Hooked from
    /// SbEventDispatcher so every event the suite handles increments a
    /// per-kind counter; Health tab reads Snapshot() to render an
    /// "Activity (this session)" card.
    ///
    /// Resets on Loadout reload — that's deliberate, "events handled
    /// today" is more useful as "events handled since you opened
    /// Loadout this morning" than as a nightly-reset metric (the
    /// latter would need a persisted store + clock).
    /// </summary>
    public sealed class EventStats
    {
        private static EventStats _instance;
        public static EventStats Instance => _instance ?? (_instance = new EventStats());

        private readonly Dictionary<string, int> _counts =
            new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        private readonly object _lock = new object();

        public DateTime SinceUtc { get; } = DateTime.UtcNow;

        public void Increment(string kind)
        {
            if (string.IsNullOrEmpty(kind)) return;
            lock (_lock)
            {
                _counts[kind] = (_counts.TryGetValue(kind, out var v) ? v : 0) + 1;
            }
        }

        public Dictionary<string, int> Snapshot()
        {
            lock (_lock)
            {
                return new Dictionary<string, int>(_counts, StringComparer.OrdinalIgnoreCase);
            }
        }

        public int Total
        {
            get { lock (_lock) { var t = 0; foreach (var v in _counts.Values) t += v; return t; } }
        }
    }
}
