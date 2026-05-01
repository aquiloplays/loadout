using System;
using System.Collections.Concurrent;
using Loadout.Settings;

namespace Loadout.Util
{
    /// <summary>
    /// Centralized "should we actually send this to chat?" check. Every module
    /// that posts a chat message goes through here so the suite can't clog
    /// chat under any combination of settings.
    ///
    /// Three layers of suppression:
    ///   1. Per-key cooldown — keeps !uptime / counter ack / etc. from being
    ///      spammable by bored viewers. Keys are caller-defined.
    ///   2. Global rate cap — Loadout never sends more than
    ///      <see cref="ChatNoiseConfig.MaxChatPerMinute"/> messages/minute
    ///      total, regardless of which module asks.
    ///   3. Per-area enable flag + global Quiet Mode — broadcaster can
    ///      silence Bolts / Welcomes / Alerts / etc. from chat without
    ///      disabling the underlying module (overlays still update).
    ///
    /// All blocked sends are silently dropped — no error, no log spam. The
    /// underlying module logic still runs (overlays, persistence, bus events).
    /// </summary>
    public static class ChatGate
    {
        public enum Area
        {
            Alerts,
            Welcomes,
            InfoCommands,
            Counters,
            Bolts,
            Goals,
            Other
        }

        // Per-key last-fired UTC. Bounded — old keys evicted lazily on lookup.
        private static readonly ConcurrentDictionary<string, DateTime> _keyLastFired =
            new ConcurrentDictionary<string, DateTime>();

        // Sliding window for global rate cap.
        private static readonly object _windowLock = new object();
        private static readonly System.Collections.Generic.Queue<DateTime> _sentTimestamps =
            new System.Collections.Generic.Queue<DateTime>();
        private static readonly TimeSpan WindowSize = TimeSpan.FromMinutes(1);

        /// <summary>
        /// Combined check + record. Returns true if the caller should proceed
        /// with the send; false to suppress. Always records the timestamp on
        /// success so subsequent calls within the window count.
        /// </summary>
        public static bool TrySend(Area area, string key = null, TimeSpan? cooldown = null)
        {
            var s = SettingsManager.Instance.Current;
            var cfg = s.ChatNoise;

            // Layer 1: per-area enable + quiet mode.
            if (!IsAreaEnabled(area, cfg)) return false;
            if (cfg.QuietMode && area != Area.InfoCommands) return false;
            // Info commands stay on in quiet mode because they're explicit user requests
            // — silencing them looks broken. Quiet mode is for ambient chatter.

            // Layer 2: per-key cooldown.
            if (!string.IsNullOrEmpty(key) && cooldown.HasValue && cooldown.Value > TimeSpan.Zero)
            {
                if (_keyLastFired.TryGetValue(key, out var last) &&
                    (DateTime.UtcNow - last) < cooldown.Value)
                    return false;
            }

            // Layer 3: global rate cap.
            lock (_windowLock)
            {
                var cap = Math.Max(1, cfg.MaxChatPerMinute);
                var now = DateTime.UtcNow;
                while (_sentTimestamps.Count > 0 && (now - _sentTimestamps.Peek()) > WindowSize)
                    _sentTimestamps.Dequeue();
                if (_sentTimestamps.Count >= cap) return false;
                _sentTimestamps.Enqueue(now);
            }

            if (!string.IsNullOrEmpty(key))
                _keyLastFired[key] = DateTime.UtcNow;
            return true;
        }

        private static bool IsAreaEnabled(Area area, ChatNoiseConfig cfg)
        {
            switch (area)
            {
                case Area.Alerts:       return cfg.AlertsToChat;
                case Area.Welcomes:     return cfg.WelcomesToChat;
                case Area.InfoCommands: return cfg.InfoCommandsToChat;
                case Area.Counters:     return cfg.CountersToChat;
                case Area.Bolts:        return cfg.BoltsToChat;
                case Area.Goals:        return cfg.GoalsToChat;
                default:                return true;
            }
        }
    }
}
