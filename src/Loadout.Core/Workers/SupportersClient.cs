using System;
using System.Collections.Concurrent;
using System.Net.Http;
using System.Threading.Tasks;
using Loadout.Settings;
using Newtonsoft.Json.Linq;

namespace Loadout.Workers
{
    /// <summary>
    /// Looks up a Patreon supporter's tier by platform + handle via the
    /// aquilo.gg link worker. Result cache is short — ~5 minutes — so newly
    /// claimed handles propagate quickly while we don't hammer the worker
    /// for every chat message.
    ///
    /// Negative cache (handle not found) gets a much shorter TTL because we
    /// expect most handles to never become supporters.
    /// </summary>
    public sealed class SupportersClient
    {
        private const string WorkerBase = "https://streamfusion-patreon-proxy.bisherclay.workers.dev";
        private static readonly TimeSpan PositiveTtl = TimeSpan.FromMinutes(5);
        private static readonly TimeSpan NegativeTtl = TimeSpan.FromMinutes(1);

        private static readonly Lazy<SupportersClient> _instance =
            new Lazy<SupportersClient>(() => new SupportersClient());
        public static SupportersClient Instance => _instance.Value;

        private readonly HttpClient _http = new HttpClient { Timeout = TimeSpan.FromSeconds(4) };
        private readonly ConcurrentDictionary<string, CacheEntry> _cache = new ConcurrentDictionary<string, CacheEntry>();

        private SupportersClient()
        {
            _http.DefaultRequestHeaders.UserAgent.ParseAdd("Loadout-Supporters/0.1");
        }

        /// <summary>
        /// Returns the tier ("tier1" / "tier2" / "tier3") or null if not a supporter
        /// or unreachable. Falls back to the local <see cref="PatreonSupportersConfig"/>
        /// list if the worker is offline.
        /// </summary>
        public async Task<string> LookupAsync(string platform, string handle)
        {
            if (string.IsNullOrEmpty(platform) || string.IsNullOrEmpty(handle)) return LocalLookup(platform, handle);
            var key = platform.ToLowerInvariant() + ":" + handle.ToLowerInvariant();
            if (_cache.TryGetValue(key, out var hit) && DateTime.UtcNow < hit.ExpiresUtc)
                return hit.Tier;

            string tier = null;
            try
            {
                var url = WorkerBase + "/api/link/lookup?platform=" + Uri.EscapeDataString(platform.ToLowerInvariant())
                                     + "&handle="   + Uri.EscapeDataString(handle.ToLowerInvariant());
                using var resp = await _http.GetAsync(url).ConfigureAwait(false);
                if (resp.IsSuccessStatusCode)
                {
                    var body = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
                    var json = JObject.Parse(body);
                    var t = (string)json["tier"];
                    if (!string.IsNullOrEmpty(t) && t != "none") tier = t;
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine("[Loadout] SupportersClient lookup failed: " + ex.Message);
                // Fall through to local lookup.
                return LocalLookup(platform, handle);
            }

            _cache[key] = new CacheEntry
            {
                Tier = tier,
                ExpiresUtc = DateTime.UtcNow + (tier == null ? NegativeTtl : PositiveTtl)
            };
            return tier ?? LocalLookup(platform, handle);
        }

        /// <summary>
        /// Synchronous-friendly wrapper for hot paths (event dispatch). Returns
        /// from cache if we have a fresh hit; otherwise kicks off a background
        /// refresh and returns the local list value (or null).
        /// </summary>
        public string LookupCachedOrFireAndForget(string platform, string handle)
        {
            if (string.IsNullOrEmpty(platform) || string.IsNullOrEmpty(handle)) return LocalLookup(platform, handle);
            var key = platform.ToLowerInvariant() + ":" + handle.ToLowerInvariant();
            if (_cache.TryGetValue(key, out var hit) && DateTime.UtcNow < hit.ExpiresUtc) return hit.Tier;
            _ = LookupAsync(platform, handle);
            return LocalLookup(platform, handle);
        }

        private static string LocalLookup(string platform, string handle)
        {
            if (string.IsNullOrEmpty(platform) || string.IsNullOrEmpty(handle)) return null;
            var s = SettingsManager.Instance.Current.PatreonSupporters.Supporters;
            for (int i = 0; i < s.Count; i++)
            {
                if (string.Equals(s[i].Platform, platform, StringComparison.OrdinalIgnoreCase) &&
                    string.Equals(s[i].Handle,   handle,   StringComparison.OrdinalIgnoreCase))
                    return s[i].Tier;
            }
            return null;
        }

        private struct CacheEntry { public string Tier; public DateTime ExpiresUtc; }
    }
}
