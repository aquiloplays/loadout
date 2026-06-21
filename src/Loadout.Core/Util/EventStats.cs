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

        // Rolling buffer of the most recent (kind, module, ts) triples,
        // capped small. The tray-icon hover balloon renders the last 3
        // so "what just happened?" is a glance away.
        private readonly LinkedList<RecentHit> _recent = new LinkedList<RecentHit>();
        private const int RecentBufferCap = 12;
        public sealed class RecentHit
        {
            public string Kind   { get; set; }
            public string Module { get; set; }
            public DateTime Ts   { get; set; }
        }
        public List<RecentHit> RecentSnapshot(int n)
        {
            lock (_lock)
            {
                var list = new List<RecentHit>(System.Math.Min(n, _recent.Count));
                int taken = 0;
                for (var node = _recent.Last; node != null && taken < n; node = node.Previous, taken++)
                    list.Add(node.Value);
                return list;
            }
        }

        public void Increment(string kind)
        {
            if (string.IsNullOrEmpty(kind)) return;
            lock (_lock)
            {
                _counts[kind] = (_counts.TryGetValue(kind, out var v) ? v : 0) + 1;
            }
        }

        /// <summary>Record that <paramref name="module"/> took action in
        /// response to a <paramref name="kind"/> event. Also publishes a
        /// <c>loadout.module.activity</c> event on the local Aquilo Bus
        /// so the OBS dock / customizer / future tooling can render a
        /// live "what just fired" stream without sniffing every
        /// domain-specific event kind individually.</summary>
        public void Hit(string kind, string module)
        {
            if (string.IsNullOrEmpty(kind) || string.IsNullOrEmpty(module)) return;
            int count;
            int totalForModule;
            lock (_lock)
            {
                if (!_moduleCounts.TryGetValue(kind, out var inner))
                {
                    inner = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
                    _moduleCounts[kind] = inner;
                }
                count = (inner.TryGetValue(module, out var v) ? v : 0) + 1;
                inner[module] = count;

                // Lifetime count per module = sum across all kinds it has acted on.
                totalForModule = 0;
                foreach (var byKind in _moduleCounts.Values)
                    if (byKind.TryGetValue(module, out var sub)) totalForModule += sub;

                // Push to the rolling recent-hits buffer.
                _recent.AddLast(new RecentHit { Kind = kind, Module = module, Ts = DateTime.UtcNow });
                while (_recent.Count > RecentBufferCap) _recent.RemoveFirst();
            }

            // Fire-and-forget broadcast. The bus has its own threadpool
            // for serialization + fan-out; we never block the dispatcher
            // here. If the bus isn't running yet (early boot) Publish
            // silently no-ops, which is fine.
            try
            {
                Loadout.Bus.AquiloBus.Instance.Publish("loadout.module.activity", new
                {
                    kind,
                    module,
                    count,                              // count for this (kind, module)
                    moduleTotal = totalForModule,       // lifetime count across all kinds
                    ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                });
            }
            catch { /* never let a dock-feed publish kill module work */ }
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
