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
        // (kind → module → count) for the Health tab's per-kind drill-down.
        // Modules call Hit() at the moment they actually take an action
        // (send a chat reply, publish to the bus, fire an alert) so the
        // numbers reflect work done, not "saw the dispatch".
        private readonly Dictionary<string, Dictionary<string, int>> _moduleCounts =
            new Dictionary<string, Dictionary<string, int>>(StringComparer.OrdinalIgnoreCase);
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

        /// <summary>Record that <paramref name="module"/> took action in
        /// response to a <paramref name="kind"/> event.</summary>
        public void Hit(string kind, string module)
        {
            if (string.IsNullOrEmpty(kind) || string.IsNullOrEmpty(module)) return;
            lock (_lock)
            {
                if (!_moduleCounts.TryGetValue(kind, out var inner))
                {
                    inner = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
                    _moduleCounts[kind] = inner;
                }
                inner[module] = (inner.TryGetValue(module, out var v) ? v : 0) + 1;
            }
        }

        public Dictionary<string, int> Snapshot()
        {
            lock (_lock)
            {
                return new Dictionary<string, int>(_counts, StringComparer.OrdinalIgnoreCase);
            }
        }

        /// <summary>Snapshot of (kind → module → count) for drill-down.</summary>
        public Dictionary<string, Dictionary<string, int>> SnapshotActions()
        {
            lock (_lock)
            {
                var copy = new Dictionary<string, Dictionary<string, int>>(StringComparer.OrdinalIgnoreCase);
                foreach (var kv in _moduleCounts)
                    copy[kv.Key] = new Dictionary<string, int>(kv.Value, StringComparer.OrdinalIgnoreCase);
                return copy;
            }
        }

        public int Total
        {
            get { lock (_lock) { var t = 0; foreach (var v in _counts.Values) t += v; return t; } }
        }
    }
}
