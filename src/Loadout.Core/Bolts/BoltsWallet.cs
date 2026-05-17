using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using Loadout.Identity;
using Loadout.Settings;
using Newtonsoft.Json;

namespace Loadout.Bolts
{
    /// <summary>
    /// Persistent Bolts balance store with cross-platform aggregation.
    ///
    /// Storage: a flat map from canonical-identity-key → balance + streak. We
    /// resolve a viewer's canonical identity through <see cref="IdentityLinker"/>
    /// so a viewer who's run <c>!link</c> across platforms has one wallet.
    /// Without a link, each (platform, handle) tuple is its own wallet.
    ///
    /// Saves are debounced 5s like the engagement tracker.
    /// </summary>
    public sealed class BoltsWallet
    {
        private static readonly Lazy<BoltsWallet> _instance =
            new Lazy<BoltsWallet>(() => new BoltsWallet(), LazyThreadSafetyMode.ExecutionAndPublication);
        public static BoltsWallet Instance => _instance.Value;

        private readonly object _gate = new object();
        private Dictionary<string, BoltsAccount> _accounts;
        private string _path;
        private Timer _saveTimer;

        public void Initialize()
        {
            lock (_gate)
            {
                if (_path != null) return;
                _path = Path.Combine(SettingsManager.Instance.DataFolder ?? ".", "bolts.json");
                LoadFromDisk();
            }
        }

        // ── Read API ──────────────────────────────────────────────────────────

        public long Balance(string platform, string handle)
        {
            var key = ResolveKey(platform, handle);
            lock (_gate)
            {
                _accounts.TryGetValue(key, out var a);
                return a?.Balance ?? 0;
            }
        }

        public BoltsAccount Get(string platform, string handle)
        {
            var key = ResolveKey(platform, handle);
            lock (_gate)
            {
                _accounts.TryGetValue(key, out var a);
                return a;
            }
        }

        /// <summary>Top N balances. Used by !leaderboard and the overlay.</summary>
        public List<BoltsAccount> Top(int n)
        {
            lock (_gate)
            {
                return _accounts.Values
                    .Where(a => a.Balance > 0)
                    .OrderByDescending(a => a.Balance)
                    .Take(Math.Max(1, n))
                    .ToList();
            }
        }

        /// <summary>Snapshot of every wallet, sorted by balance desc. Used by
        /// the manual-adjust UI and the Discord sync push.</summary>
        public List<BoltsAccount> AllAccounts()
        {
            lock (_gate)
            {
                return _accounts.Values
                    .OrderByDescending(a => a.Balance)
                    .ToList();
            }
        }

        /// <summary>Splits a wallet key (e.g. "twitch:rosie") into its
        /// platform/handle pair. Returns nulls if malformed.</summary>
        public static void SplitKey(string key, out string platform, out string handle)
        {
            platform = null; handle = null;
            if (string.IsNullOrEmpty(key)) return;
            var idx = key.IndexOf(':');
            if (idx <= 0) { handle = key; return; }
            platform = key.Substring(0, idx);
            handle   = key.Substring(idx + 1);
        }

        // ── Mutation API ──────────────────────────────────────────────────────

        public long Earn(string platform, string handle, long amount, string reason)
        {
            if (amount <= 0 || string.IsNullOrEmpty(handle)) return 0;
            var key = ResolveKey(platform, handle);
            lock (_gate)
            {
                if (!_accounts.TryGetValue(key, out var a))
                {
                    a = new BoltsAccount
                    {
                        Key            = key,
                        Display        = handle,
                        FirstSeenUtc   = DateTime.UtcNow
                    };
                    _accounts[key] = a;
                }
                a.Balance += amount;
                a.LifetimeEarned += amount;
                a.LastActivityUtc = DateTime.UtcNow;
                a.LastReason = reason;
                ScheduleSave();
                return a.Balance;
            }
        }

        public bool Spend(string platform, string handle, long amount, string reason)
        {
            if (amount <= 0) return false;
            var key = ResolveKey(platform, handle);
            lock (_gate)
            {
                if (!_accounts.TryGetValue(key, out var a)) return false;
                if (a.Balance < amount) return false;
                a.Balance -= amount;
                a.LifetimeSpent += amount;
                a.LastActivityUtc = DateTime.UtcNow;
                a.LastReason = reason;
                ScheduleSave();
                return true;
            }
        }

        public bool Transfer(string fromPlatform, string fromHandle, string toPlatform, string toHandle, long amount)
        {
            if (amount <= 0) return false;
            var fromKey = ResolveKey(fromPlatform, fromHandle);
            var toKey   = ResolveKey(toPlatform,   toHandle);
            if (fromKey == toKey) return false;

            lock (_gate)
            {
                if (!_accounts.TryGetValue(fromKey, out var from) || from.Balance < amount) return false;
                if (!_accounts.TryGetValue(toKey, out var to))
                {
                    to = new BoltsAccount { Key = toKey, Display = toHandle, FirstSeenUtc = DateTime.UtcNow };
                    _accounts[toKey] = to;
                }
                from.Balance       -= amount;
                from.LifetimeSpent += amount;
                from.LastActivityUtc = DateTime.UtcNow;
                from.LastReason = "gift→" + toHandle;

                to.Balance         += amount;
                to.LifetimeEarned  += amount;
                to.LastActivityUtc  = DateTime.UtcNow;
                to.LastReason       = "gift←" + fromHandle;
                ScheduleSave();
                return true;
            }
        }

        /// <summary>After a new IdentityLinker link is registered, an
        /// existing wallet keyed by the now-non-canonical identity (the
        /// orphan) becomes unreachable through the normal Earn/Spend
        /// path — those routes resolve through GetPrimary() and land on
        /// the canonical wallet instead. This method migrates the orphan's
        /// balance + lifetime counters into the canonical wallet and
        /// drops the orphan entry. No-op when called for an identity
        /// whose canonical key IS the raw key (i.e. unlinked or already-
        /// primary identities).</summary>
        public bool MergeIntoCanonical(string platform, string handle)
        {
            if (string.IsNullOrEmpty(handle)) return false;
            // Compute the raw key (bypassing IdentityLinker) and the
            // canonical key (post-link resolution). If they match, this
            // identity is already canonical — nothing to merge.
            var rawKey = (platform ?? "?").ToLowerInvariant() + ":" + handle.Trim().TrimStart('@').ToLowerInvariant();
            var canonicalKey = ResolveKey(platform, handle);
            if (string.Equals(rawKey, canonicalKey, StringComparison.OrdinalIgnoreCase)) return false;

            bool merged = false;
            lock (_gate)
            {
                if (!_accounts.TryGetValue(rawKey, out var orphan)) return false;
                if (!_accounts.TryGetValue(canonicalKey, out var canonical))
                {
                    canonical = new BoltsAccount
                    {
                        Key = canonicalKey,
                        Display = orphan.Display ?? handle,
                        FirstSeenUtc = orphan.FirstSeenUtc
                    };
                    _accounts[canonicalKey] = canonical;
                }
                canonical.Balance        += orphan.Balance;
                canonical.LifetimeEarned += orphan.LifetimeEarned;
                canonical.LifetimeSpent  += orphan.LifetimeSpent;
                if (orphan.StreakDays > canonical.StreakDays)
                {
                    canonical.StreakDays    = orphan.StreakDays;
                    canonical.LastStreakUtc = orphan.LastStreakUtc;
                }
                if (orphan.LastActivityUtc > canonical.LastActivityUtc)
                    canonical.LastActivityUtc = orphan.LastActivityUtc;
                if (canonical.FirstSeenUtc == default(DateTime) ||
                    (orphan.FirstSeenUtc != default(DateTime) && orphan.FirstSeenUtc < canonical.FirstSeenUtc))
                    canonical.FirstSeenUtc = orphan.FirstSeenUtc;
                _accounts.Remove(rawKey);
                ScheduleSave();
                merged = true;
            }
            // Save synchronously so a crash before the 5s debounce ticks
            // doesn't leave the orphan re-appearing on next load.
            if (merged) try { lock (_gate) WriteToDisk(); } catch { /* logged on retry */ }
            return merged;
        }

        /// <summary>Streamer-initiated reset: zero balance + lifetime
        /// counters on every account. Keeps the Display name and
        /// FirstSeenUtc so we don't lose the canonical-key map; streaks
        /// reset to 0 along with the rest. Returns the wallet count.</summary>
        public int ResetAll()
        {
            int n;
            lock (_gate)
            {
                n = _accounts.Count;
                foreach (var a in _accounts.Values)
                {
                    a.Balance        = 0;
                    a.LifetimeEarned = 0;
                    a.LifetimeSpent  = 0;
                    a.StreakDays     = 0;
                    a.LastStreakUtc  = default(DateTime);
                    a.LastReason     = "reset";
                    a.LastActivityUtc = DateTime.UtcNow;
                }
                ScheduleSave();
            }
            // Save synchronously so the UI reflecting the reset doesn't
            // race against the 5s debounce.
            try { lock (_gate) WriteToDisk(); } catch { /* logged on retry */ }
            return n;
        }

        // ── Streak tracking (daily check-in driven) ───────────────────────────

        /// <summary>
        /// Update daily streak. Call once per check-in. Returns the new streak
        /// length and whether the multiplier increased.
        /// </summary>
        public (int newStreakDays, bool grew) BumpStreak(string platform, string handle)
        {
            var key = ResolveKey(platform, handle);
            lock (_gate)
            {
                if (!_accounts.TryGetValue(key, out var a))
                {
                    a = new BoltsAccount { Key = key, Display = handle, FirstSeenUtc = DateTime.UtcNow };
                    _accounts[key] = a;
                }
                var todayUtc = DateTime.UtcNow.Date;
                if (a.LastStreakUtc.Date == todayUtc) return (a.StreakDays, false);

                if (a.LastStreakUtc.Date == todayUtc.AddDays(-1)) a.StreakDays += 1;
                else                                              a.StreakDays = 1;
                a.LastStreakUtc = todayUtc;
                ScheduleSave();
                return (a.StreakDays, true);
            }
        }

        // ── Internals ─────────────────────────────────────────────────────────

        /// <summary>
        /// Canonical key = primary identity from <see cref="IdentityLinker"/>
        /// (so linked accounts share a wallet). Falls back to platform:handle
        /// when no link exists.
        /// </summary>
        private static string ResolveKey(string platform, string handle)
        {
            if (string.IsNullOrEmpty(handle)) return null;
            try
            {
                var mask = PlatformMaskExtensions.FromShortName(platform);
                if (mask != PlatformMask.None)
                {
                    var primary = IdentityLinker.Instance.GetPrimary(mask, handle);
                    return primary.ToString();
                }
            }
            catch { /* IdentityLinker uninitialized; fall back to raw key */ }
            return (platform ?? "?").ToLowerInvariant() + ":" + (handle ?? "").Trim().TrimStart('@').ToLowerInvariant();
        }

        private void ScheduleSave()
        {
            _saveTimer?.Dispose();
            _saveTimer = new Timer(_ => { lock (_gate) WriteToDisk(); }, null, 5000, Timeout.Infinite);
        }

        private void LoadFromDisk()
        {
            _accounts = new Dictionary<string, BoltsAccount>(StringComparer.OrdinalIgnoreCase);
            if (string.IsNullOrEmpty(_path) || !File.Exists(_path)) return;
            try
            {
                var loaded = JsonConvert.DeserializeObject<List<BoltsAccount>>(File.ReadAllText(_path)) ?? new List<BoltsAccount>();
                foreach (var a in loaded)
                {
                    if (string.IsNullOrEmpty(a.Key)) continue;
                    _accounts[a.Key] = a;
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine("[Loadout] Bolts load failed: " + ex.Message);
            }
        }

        private void WriteToDisk()
        {
            if (string.IsNullOrEmpty(_path)) return;
            try
            {
                File.WriteAllText(_path, JsonConvert.SerializeObject(_accounts.Values.ToList(), Formatting.Indented));
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine("[Loadout] Bolts save failed: " + ex.Message);
            }
        }
    }

    public class BoltsAccount
    {
        public string   Key             { get; set; }
        public string   Display         { get; set; }
        public long     Balance         { get; set; }
        public long     LifetimeEarned  { get; set; }
        public long     LifetimeSpent   { get; set; }
        public DateTime FirstSeenUtc    { get; set; }
        public DateTime LastActivityUtc { get; set; }
        public string   LastReason      { get; set; }
        // Daily streak (consecutive days the wallet was credited via check-in).
        public int      StreakDays      { get; set; }
        public DateTime LastStreakUtc   { get; set; }
    }
}
