using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using Loadout.Settings;
using Newtonsoft.Json;

namespace Loadout.Games
{
    /// <summary>
    /// Persistent per-game stats. One row per Twitch category the broadcaster
    /// has streamed under since Loadout started tracking. Stats roll up
    /// session count, total stream time, last-streamed timestamp, and peak
    /// viewer count.
    ///
    /// Driven by <see cref="Modules.GameTrackerModule"/>:
    ///   streamOnline   → start a session for the current category
    ///   streamUpdate   → if category changed, close previous session + open new
    ///   streamOffline  → close the open session
    /// </summary>
    public sealed class GameStatsStore
    {
        private static readonly Lazy<GameStatsStore> _instance =
            new Lazy<GameStatsStore>(() => new GameStatsStore(), LazyThreadSafetyMode.ExecutionAndPublication);
        public static GameStatsStore Instance => _instance.Value;

        private readonly object _gate = new object();
        private string _path;
        private Dictionary<string, GameStat> _stats;
        private OpenSession _session;
        private Timer _saveTimer;

        public void Initialize()
        {
            lock (_gate)
            {
                if (_path != null) return;
                _path = Path.Combine(SettingsManager.Instance.DataFolder ?? ".", "games.json");
                LoadFromDisk();
            }
        }

        public IReadOnlyList<GameStat> All()
        {
            lock (_gate)
            {
                EnsureLoaded();
                // Apply any in-flight session duration on read so the UI shows
                // a live ticker without us having to flush every minute.
                var snapshot = _stats.Values.Select(g => Clone(g)).ToList();
                if (_session != null)
                {
                    var live = snapshot.FirstOrDefault(s => string.Equals(s.GameName, _session.GameName, StringComparison.OrdinalIgnoreCase));
                    if (live != null)
                        live.TotalDurationSeconds += (long)(DateTime.UtcNow - _session.StartedUtc).TotalSeconds;
                }
                return snapshot.OrderByDescending(s => s.LastStreamedUtc).ToList();
            }
        }

        public string CurrentGame
        {
            get { lock (_gate) return _session?.GameName; }
        }

        // ── Session lifecycle ────────────────────────────────────────────────

        public void OnStreamOnline(string game)
        {
            lock (_gate)
            {
                EnsureLoaded();
                CloseSessionLocked();
                StartSessionLocked(game);
            }
        }

        public void OnGameChanged(string newGame)
        {
            if (string.IsNullOrWhiteSpace(newGame)) return;
            lock (_gate)
            {
                EnsureLoaded();
                if (_session != null && string.Equals(_session.GameName, newGame, StringComparison.OrdinalIgnoreCase)) return;
                CloseSessionLocked();
                StartSessionLocked(newGame);
            }
        }

        public void OnStreamOffline()
        {
            lock (_gate)
            {
                EnsureLoaded();
                CloseSessionLocked();
            }
        }

        public void RecordViewerCount(int viewers)
        {
            if (viewers <= 0) return;
            lock (_gate)
            {
                EnsureLoaded();
                if (_session == null) return;
                if (!_stats.TryGetValue(KeyOf(_session.GameName), out var stat)) return;
                if (viewers > stat.PeakViewers) { stat.PeakViewers = viewers; ScheduleSave(); }
            }
        }

        public void Reset()
        {
            lock (_gate)
            {
                _stats = new Dictionary<string, GameStat>(StringComparer.OrdinalIgnoreCase);
                _session = null;
                ScheduleSave();
            }
        }

        // ── Internals ────────────────────────────────────────────────────────

        private void StartSessionLocked(string game)
        {
            if (string.IsNullOrWhiteSpace(game)) return;
            var key = KeyOf(game);
            if (!_stats.TryGetValue(key, out var stat))
            {
                stat = new GameStat
                {
                    GameName = game,
                    FirstStreamedUtc = DateTime.UtcNow
                };
                _stats[key] = stat;
            }
            stat.SessionCount++;
            stat.LastStreamedUtc = DateTime.UtcNow;
            _session = new OpenSession { GameName = game, StartedUtc = DateTime.UtcNow };
            ScheduleSave();
        }

        private void CloseSessionLocked()
        {
            if (_session == null) return;
            var key = KeyOf(_session.GameName);
            if (_stats.TryGetValue(key, out var stat))
            {
                stat.TotalDurationSeconds += (long)(DateTime.UtcNow - _session.StartedUtc).TotalSeconds;
                stat.LastStreamedUtc = DateTime.UtcNow;
            }
            _session = null;
            ScheduleSave();
        }

        private static string KeyOf(string game) => (game ?? "").Trim().ToLowerInvariant();

        private static GameStat Clone(GameStat s) => new GameStat
        {
            GameName = s.GameName,
            SessionCount = s.SessionCount,
            TotalDurationSeconds = s.TotalDurationSeconds,
            FirstStreamedUtc = s.FirstStreamedUtc,
            LastStreamedUtc = s.LastStreamedUtc,
            PeakViewers = s.PeakViewers,
            ResetCountersOnSwitch = s.ResetCountersOnSwitch
        };

        private void EnsureLoaded()
        {
            if (_stats == null) LoadFromDisk();
        }

        private void LoadFromDisk()
        {
            _stats = new Dictionary<string, GameStat>(StringComparer.OrdinalIgnoreCase);
            if (string.IsNullOrEmpty(_path) || !File.Exists(_path)) return;
            try
            {
                var list = JsonConvert.DeserializeObject<List<GameStat>>(File.ReadAllText(_path)) ?? new List<GameStat>();
                foreach (var s in list)
                {
                    if (string.IsNullOrEmpty(s.GameName)) continue;
                    _stats[KeyOf(s.GameName)] = s;
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine("[Loadout] GameStats load failed: " + ex.Message);
            }
        }

        private void ScheduleSave()
        {
            _saveTimer?.Dispose();
            _saveTimer = new Timer(_ => { lock (_gate) WriteToDisk(); }, null, 5000, Timeout.Infinite);
        }

        private void WriteToDisk()
        {
            if (string.IsNullOrEmpty(_path) || _stats == null) return;
            try
            {
                File.WriteAllText(_path, JsonConvert.SerializeObject(_stats.Values.ToList(), Formatting.Indented));
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine("[Loadout] GameStats save failed: " + ex.Message);
            }
        }

        private class OpenSession
        {
            public string GameName { get; set; }
            public DateTime StartedUtc { get; set; }
        }
    }

    public class GameStat
    {
        public string   GameName             { get; set; } = "";
        public int      SessionCount         { get; set; }
        public long     TotalDurationSeconds { get; set; }
        public DateTime FirstStreamedUtc     { get; set; }
        public DateTime LastStreamedUtc      { get; set; }
        public int      PeakViewers          { get; set; }
        // Per-game option: when the broadcaster switches AWAY from this game,
        // reset every counter (deaths, wins, etc.). Useful for game-specific
        // counters that shouldn't carry across categories.
        public bool     ResetCountersOnSwitch { get; set; }

        // UI-only convenience formatters (not serialized).
        [JsonIgnore]
        public string TotalHoursDisplay => TimeSpan.FromSeconds(TotalDurationSeconds).TotalHours.ToString("F1");
        [JsonIgnore]
        public string LastStreamedDisplay => LastStreamedUtc == default
            ? "—"
            : LastStreamedUtc.ToLocalTime().ToString("yyyy-MM-dd HH:mm");
    }
}
