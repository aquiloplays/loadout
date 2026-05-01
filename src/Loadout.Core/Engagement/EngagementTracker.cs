using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using Loadout.Settings;
using Newtonsoft.Json;

namespace Loadout.Engagement
{
    /// <summary>
    /// Persistent per-viewer activity store. Used by VipRotationModule to pick
    /// promotion / demotion candidates and by the CC coin tracker for the
    /// long-term leaderboard. Living in a single JSON file keeps this simple;
    /// at the scale we expect (a few thousand uniques per channel per month)
    /// this is fine. Phase 2 can swap to SQLite if needed.
    ///
    /// Save is debounced to once per 5 seconds to keep the disk quiet during
    /// chat bursts.
    /// </summary>
    public sealed class EngagementTracker
    {
        private static readonly Lazy<EngagementTracker> _instance =
            new Lazy<EngagementTracker>(() => new EngagementTracker(), LazyThreadSafetyMode.ExecutionAndPublication);
        public static EngagementTracker Instance => _instance.Value;

        // Cap the persisted set so a viral moment doesn't bloat the file forever.
        // We evict by oldest LastSeen on save when over budget.
        private const int MaxEntries = 5000;

        private readonly object _gate = new object();
        private readonly Dictionary<string, ViewerActivity> _byKey =
            new Dictionary<string, ViewerActivity>(StringComparer.OrdinalIgnoreCase);
        private string _path;
        private Timer _saveTimer;
        private bool _dirty;

        public void Initialize()
        {
            lock (_gate)
            {
                if (_path != null) return;
                _path = Path.Combine(SettingsManager.Instance.DataFolder ?? ".", "engagement.json");
                LoadFromDisk();
            }
        }

        // ── Tracking surface (called from modules) ────────────────────────────

        public void TrackChat(string platform, string handle)
        {
            var v = Touch(platform, handle);
            if (v == null) return;
            v.MsgCount++;
        }

        public void TrackSub(string platform, string handle, int monthsTotal = 1)
        {
            var v = Touch(platform, handle);
            if (v == null) return;
            v.SubEvents++;
            if (monthsTotal > v.MaxSubMonths) v.MaxSubMonths = monthsTotal;
        }

        public void TrackGiftSub(string platform, string handle, int count)
        {
            var v = Touch(platform, handle);
            if (v == null) return;
            v.GiftedSubs += Math.Max(1, count);
        }

        public void TrackRaid(string platform, string handle, int viewers)
        {
            var v = Touch(platform, handle);
            if (v == null) return;
            v.RaidsBrought++;
            v.RaidViewerTotal += Math.Max(0, viewers);
        }

        public void TrackBits(string platform, string handle, int bits)
        {
            var v = Touch(platform, handle);
            if (v == null) return;
            v.BitsTotal += Math.Max(0, bits);
        }

        public void TrackCcCoins(string platform, string handle, int coins)
        {
            var v = Touch(platform, handle);
            if (v == null) return;
            v.CcCoinsAllTime += Math.Max(0, coins);
            v.CcCoinsThisStream += Math.Max(0, coins);
        }

        public void ResetThisStream()
        {
            lock (_gate)
            {
                foreach (var v in _byKey.Values) v.CcCoinsThisStream = 0;
                ScheduleSave();
            }
        }

        // ── Query surface (used by modules + UI) ─────────────────────────────

        public IReadOnlyList<ViewerActivity> All()
        {
            lock (_gate) return _byKey.Values.ToList();
        }

        public ViewerActivity Get(string platform, string handle)
        {
            if (string.IsNullOrEmpty(platform) || string.IsNullOrEmpty(handle)) return null;
            lock (_gate)
            {
                _byKey.TryGetValue(MakeKey(platform, handle), out var v);
                return v;
            }
        }

        /// <summary>
        /// Composite engagement score - weights chat, subs, raids, gifts, bits, CC.
        /// Tweak the weights here; modules just read Score().
        /// </summary>
        public static int Score(ViewerActivity v)
        {
            if (v == null) return 0;
            return v.MsgCount
                 + v.SubEvents      * 50
                 + v.GiftedSubs     * 80
                 + v.RaidsBrought   * 200
                 + v.BitsTotal      / 10
                 + v.CcCoinsAllTime / 50;
        }

        public List<ViewerActivity> TopBy(int n, Func<ViewerActivity, int> selector,
                                          Func<ViewerActivity, bool> filter = null)
        {
            lock (_gate)
            {
                var q = _byKey.Values.AsEnumerable();
                if (filter != null) q = q.Where(filter);
                return q.OrderByDescending(selector).Take(n).ToList();
            }
        }

        // ── Internals ─────────────────────────────────────────────────────────

        private ViewerActivity Touch(string platform, string handle)
        {
            if (string.IsNullOrEmpty(platform) || string.IsNullOrEmpty(handle)) return null;
            handle = handle.Trim().TrimStart('@');
            if (handle.Length == 0) return null;
            var key = MakeKey(platform, handle);

            lock (_gate)
            {
                if (!_byKey.TryGetValue(key, out var v))
                {
                    v = new ViewerActivity
                    {
                        Platform = platform.ToLowerInvariant(),
                        Handle   = handle.ToLowerInvariant(),
                        FirstSeenUtc = DateTime.UtcNow
                    };
                    _byKey[key] = v;
                }
                v.LastSeenUtc = DateTime.UtcNow;
                ScheduleSave();
                return v;
            }
        }

        private static string MakeKey(string platform, string handle) =>
            platform.ToLowerInvariant() + ":" + handle.Trim().TrimStart('@').ToLowerInvariant();

        private void ScheduleSave()
        {
            _dirty = true;
            _saveTimer?.Dispose();
            _saveTimer = new Timer(_ =>
            {
                lock (_gate) WriteToDisk();
            }, null, 5000, Timeout.Infinite);
        }

        private void LoadFromDisk()
        {
            if (string.IsNullOrEmpty(_path) || !File.Exists(_path)) return;
            try
            {
                var json = File.ReadAllText(_path);
                var loaded = JsonConvert.DeserializeObject<List<ViewerActivity>>(json) ?? new List<ViewerActivity>();
                _byKey.Clear();
                foreach (var v in loaded)
                {
                    if (string.IsNullOrEmpty(v.Platform) || string.IsNullOrEmpty(v.Handle)) continue;
                    _byKey[MakeKey(v.Platform, v.Handle)] = v;
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine("[Loadout] Engagement load failed: " + ex.Message);
            }
        }

        private void WriteToDisk()
        {
            if (!_dirty || string.IsNullOrEmpty(_path)) return;
            try
            {
                IEnumerable<ViewerActivity> snapshot = _byKey.Values;
                if (_byKey.Count > MaxEntries)
                {
                    // LRU eviction by LastSeen.
                    snapshot = _byKey.Values.OrderByDescending(v => v.LastSeenUtc).Take(MaxEntries);
                    _byKey.Clear();
                    foreach (var v in snapshot) _byKey[MakeKey(v.Platform, v.Handle)] = v;
                }
                File.WriteAllText(_path, JsonConvert.SerializeObject(snapshot.ToList(), Formatting.Indented));
                _dirty = false;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine("[Loadout] Engagement save failed: " + ex.Message);
            }
        }
    }

    public class ViewerActivity
    {
        public string   Platform          { get; set; }
        public string   Handle            { get; set; }
        public DateTime FirstSeenUtc      { get; set; }
        public DateTime LastSeenUtc       { get; set; }
        public int      MsgCount          { get; set; }
        public int      SubEvents         { get; set; }   // sub + resub events seen
        public int      MaxSubMonths      { get; set; }
        public int      GiftedSubs        { get; set; }
        public int      RaidsBrought      { get; set; }
        public int      RaidViewerTotal   { get; set; }
        public int      BitsTotal         { get; set; }
        public int      CcCoinsAllTime    { get; set; }
        [JsonIgnore]
        public int      CcCoinsThisStream { get; set; }   // resets each session
    }
}
