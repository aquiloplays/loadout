using System;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Loadout.Settings;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Loadout.Updates
{
    /// <summary>
    /// Polls the configured GitHub repo's releases API for newer builds.
    /// Honors the "stable" vs "beta" channel from settings — beta uses
    /// pre-release entries, stable filters them out.
    ///
    /// Background timer runs every <c>CheckIntervalHr</c>. UI threads can also
    /// call <see cref="CheckNowAsync"/> on demand.
    /// </summary>
    public sealed class UpdateChecker : IDisposable
    {
        private static UpdateChecker _instance;
        public static UpdateChecker Instance => _instance ?? (_instance = new UpdateChecker());

        public event EventHandler<UpdateAvailableEventArgs> UpdateAvailable;
        // Fires after a staged Loadout.dll.new lands on disk so the tray
        // can flip its menu from "Downloading…" to "Restart Streamer.bot
        // to apply vX.Y.Z" without the streamer having to click the
        // "Apply update" item first.
        public event EventHandler<UpdateAvailableEventArgs> UpdateDownloaded;

        private Timer _timer;
        private CancellationTokenSource _cts;
        private readonly HttpClient _http;

        // Tracks the version of the most-recently-staged Loadout.dll.new.
        // The 6h timer re-checks GitHub forever; without this guard we'd
        // re-download the same .new file on every tick until the user
        // restarts SB.
        private string _stagedTag;
        // Tracks the version we last fired UpdateAvailable for. Used so
        // subsequent ticks for the same release don't re-balloon the tray
        // notification every 6h.
        private string _notifiedTag;

        private UpdateChecker()
        {
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            _http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
            _http.DefaultRequestHeaders.UserAgent.ParseAdd("Loadout-UpdateChecker/0.1");
            _http.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
        }

        public void Start()
        {
            _cts = new CancellationTokenSource();
            // Initial check ~10s after start, then on the configured interval.
            _timer = new Timer(async _ => await SafeCheck().ConfigureAwait(false),
                null, TimeSpan.FromSeconds(10), TimeSpan.FromHours(SafeIntervalHours()));
        }

        public void Stop()
        {
            _cts?.Cancel();
            _timer?.Dispose();
            _timer = null;
        }

        private int SafeIntervalHours()
        {
            var hours = SettingsManager.Instance.Current.Updates.CheckIntervalHr;
            return hours < 1 ? 6 : Math.Min(hours, 24);
        }

        private async Task SafeCheck()
        {
            try { await CheckNowAsync().ConfigureAwait(false); }
            catch (Exception ex) { System.Diagnostics.Debug.WriteLine("[Loadout] Update check failed: " + ex.Message); }
        }

        public async Task<UpdateCheckResult> CheckNowAsync()
        {
            var settings = SettingsManager.Instance.Current;
            if (!settings.Updates.AutoCheck) return UpdateCheckResult.Skipped;

            var repo = (settings.Updates.GitHubRepo ?? "").Trim();
            if (string.IsNullOrEmpty(repo) || !repo.Contains("/")) return UpdateCheckResult.Skipped;

            var url = $"https://api.github.com/repos/{repo}/releases?per_page=10";
            string body;
            try
            {
                using var resp = await _http.GetAsync(url).ConfigureAwait(false);
                if (!resp.IsSuccessStatusCode) return UpdateCheckResult.NetworkError;
                body = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
            }
            catch { return UpdateCheckResult.NetworkError; }

            JArray releases;
            try { releases = JArray.Parse(body); }
            catch { return UpdateCheckResult.ParseError; }

            var preferBeta = string.Equals(settings.Updates.Channel, "beta", StringComparison.OrdinalIgnoreCase);
            var candidate = releases
                .OfType<JObject>()
                .Where(r => (bool?)r["draft"] != true)
                .Where(r => preferBeta || (bool?)r["prerelease"] != true)
                .Select(r => new ReleaseInfo
                {
                    TagName     = (string)r["tag_name"],
                    Name        = (string)r["name"],
                    HtmlUrl     = (string)r["html_url"],
                    Body        = (string)r["body"],
                    PublishedAt = (DateTime?)r["published_at"] ?? DateTime.MinValue,
                    IsPrerelease = (bool?)r["prerelease"] == true,
                    DllAssetUrl = ((JArray)r["assets"])?.OfType<JObject>()
                        .FirstOrDefault(a => string.Equals((string)a["name"], "Loadout.dll", StringComparison.OrdinalIgnoreCase))
                        ?["browser_download_url"]?.ToString()
                })
                .OrderByDescending(r => r.PublishedAt)
                .FirstOrDefault();

            SettingsManager.Instance.Mutate(s => s.Updates.LastCheckedUtc = DateTime.UtcNow);

            if (candidate == null) return UpdateCheckResult.UpToDate;

            var current = ParseVersion(settings.SuiteVersion);
            var latest  = ParseVersion(candidate.TagName);
            if (current >= latest) return UpdateCheckResult.UpToDate;

            // Suppress duplicate UpdateAvailable balloons for a release
            // we've already shown the streamer. The 6h re-check still runs
            // (so we'd catch a new release replacing this one), but the
            // tray won't keep popping for the same version on every tick.
            var alreadyNotified = string.Equals(_notifiedTag, candidate.TagName, StringComparison.OrdinalIgnoreCase);
            _notifiedTag = candidate.TagName;
            if (!alreadyNotified)
                UpdateAvailable?.Invoke(this, new UpdateAvailableEventArgs(candidate));

            // Auto-download path — mirrors electron-updater's autoDownload.
            // We only do the work once per release version per process; the
            // 00-boot.cs swap on SB restart resets _stagedTag implicitly
            // by virtue of the process going away.
            if (settings.Updates.AutoDownload
                && !string.IsNullOrEmpty(candidate.DllAssetUrl)
                && !string.Equals(_stagedTag, candidate.TagName, StringComparison.OrdinalIgnoreCase))
            {
                _ = Task.Run(async () =>
                {
                    var ok = await DownloadUpdateAsync(candidate).ConfigureAwait(false);
                    if (ok)
                    {
                        _stagedTag = candidate.TagName;
                        UpdateDownloaded?.Invoke(this, new UpdateAvailableEventArgs(candidate));
                    }
                });
            }

            return UpdateCheckResult.NewerAvailable;
        }

        private static Version ParseVersion(string tag)
        {
            if (string.IsNullOrWhiteSpace(tag)) return new Version(0, 0, 0);
            var clean = tag.TrimStart('v', 'V').Trim();
            // Strip any "-beta.1" suffix for comparison.
            var dash = clean.IndexOf('-');
            if (dash > 0) clean = clean.Substring(0, dash);
            return Version.TryParse(clean, out var v) ? v : new Version(0, 0, 0);
        }

        // -------------------- Apply update --------------------

        /// <summary>
        /// Downloads <see cref="ReleaseInfo.DllAssetUrl"/> to
        /// <c>&lt;data&gt;/Loadout.dll.new</c>. The boot action picks this up
        /// on next SB startup, swaps it for <c>Loadout.dll</c>, and loads
        /// the new build. The running DLL is locked while SB is alive, so
        /// we cannot replace it in-process — an SB restart is required.
        /// </summary>
        public async Task<bool> DownloadUpdateAsync(ReleaseInfo release)
        {
            if (release == null || string.IsNullOrEmpty(release.DllAssetUrl))
            {
                System.Diagnostics.Debug.WriteLine("[Loadout] DownloadUpdate: no DllAssetUrl on release");
                return false;
            }
            try
            {
                var dataDir = Settings.SettingsManager.Instance.DataFolder;
                if (string.IsNullOrEmpty(dataDir)) return false;
                var stagedPath = System.IO.Path.Combine(dataDir, "Loadout.dll.new");

                using var resp = await _http.GetAsync(release.DllAssetUrl).ConfigureAwait(false);
                if (!resp.IsSuccessStatusCode)
                {
                    System.Diagnostics.Debug.WriteLine("[Loadout] DownloadUpdate HTTP " + (int)resp.StatusCode);
                    return false;
                }
                var bytes = await resp.Content.ReadAsByteArrayAsync().ConfigureAwait(false);
                if (bytes == null || bytes.Length < 1024) return false;
                System.IO.File.WriteAllBytes(stagedPath, bytes);

                // Newtonsoft.Json sometimes ships alongside the DLL on releases.
                var njUrl = (release.DllAssetUrl ?? "").Replace("/Loadout.dll", "/Newtonsoft.Json.dll");
                if (njUrl != release.DllAssetUrl)
                {
                    try
                    {
                        using var njResp = await _http.GetAsync(njUrl).ConfigureAwait(false);
                        if (njResp.IsSuccessStatusCode)
                        {
                            var njBytes = await njResp.Content.ReadAsByteArrayAsync().ConfigureAwait(false);
                            if (njBytes != null && njBytes.Length > 1024)
                                System.IO.File.WriteAllBytes(System.IO.Path.Combine(dataDir, "Newtonsoft.Json.dll.new"), njBytes);
                        }
                    }
                    catch { /* optional asset */ }
                }
                return true;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine("[Loadout] DownloadUpdate failed: " + ex.Message);
                return false;
            }
        }

        public void Dispose() => Stop();
    }

    public class UpdateAvailableEventArgs : EventArgs
    {
        public ReleaseInfo Release { get; }
        public UpdateAvailableEventArgs(ReleaseInfo r) { Release = r; }
    }

    public class ReleaseInfo
    {
        public string   TagName      { get; set; }
        public string   Name         { get; set; }
        public string   HtmlUrl      { get; set; }
        public string   Body         { get; set; }
        public DateTime PublishedAt  { get; set; }
        public bool     IsPrerelease { get; set; }
        public string   DllAssetUrl  { get; set; }
    }

    public enum UpdateCheckResult
    {
        Skipped,
        UpToDate,
        NewerAvailable,
        NetworkError,
        ParseError
    }
}
