using System;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Loadout.Bolts;
using Loadout.Bus;
using Loadout.Settings;
using Loadout.Util;
using Newtonsoft.Json;

namespace Loadout.Discord
{
    /// <summary>
    /// Polls the Worker for tip events posted by the streamer's tip
    /// provider (Streamlabs / StreamElements / Ko-fi / a generic webhook),
    /// awards bolts to the tipper if their stream identity is linked,
    /// and republishes the tip on the Aquilo Bus as <c>tips.received</c>
    /// so overlays can render a celebration card.
    ///
    /// Same shape as <see cref="DiscordMinigameBridge"/> — Workers can't
    /// push to the local bus, so the DLL polls a per-guild KV ring buffer
    /// at <c>GET /sync/&lt;guild&gt;/tips?since=&lt;ms&gt;</c>. Cursor is
    /// initialized to startup time so backlogs from while the DLL was
    /// offline are claimed in one batch.
    /// </summary>
    public sealed class TipBridge
    {
        private static readonly TipBridge _instance = new TipBridge();
        public static TipBridge Instance => _instance;
        private TipBridge() { }

        private static readonly HttpClient _http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        // Tips arrive much less often than minigames, so we poll at a
        // calmer cadence — every 30s is plenty given the celebration
        // overlay tolerates a 30s delay.
        private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(30);

        private CancellationTokenSource _cts;
        // Start the cursor at "the DLL came online minus 5 minutes" so a
        // tip that landed right before launch isn't stranded. Older
        // tips (more than 5 min) are stale and don't get replayed.
        private long _lastSeenMs;

        public void Start()
        {
            if (_cts != null) return;
            _cts = new CancellationTokenSource();
            _lastSeenMs = DateTimeOffset.UtcNow.AddMinutes(-5).ToUnixTimeMilliseconds();
            var token = _cts.Token;
            Task.Run(() => RunAsync(token));
        }

        public void Stop()
        {
            try { _cts?.Cancel(); } catch { }
            _cts = null;
        }

        private async Task RunAsync(CancellationToken token)
        {
            while (!token.IsCancellationRequested)
            {
                try { await PollOnceAsync().ConfigureAwait(false); }
                catch (Exception ex) { ErrorLog.Write("TipBridge.Poll", ex); }
                try { await Task.Delay(PollInterval, token).ConfigureAwait(false); }
                catch (TaskCanceledException) { return; }
            }
        }

        private async Task PollOnceAsync()
        {
            var s = SettingsManager.Instance.Current;
            if (s == null || s.Bolts == null || !s.Bolts.TipsEnabled) return;
            var d = s.DiscordBot;
            if (d == null || !d.Enabled) return;
            if (string.IsNullOrEmpty(d.WorkerUrl) || string.IsNullOrEmpty(d.GuildId) || string.IsNullOrEmpty(d.SyncSecret))
                return;

            var ts  = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString();
            var sig = HmacHex(d.SyncSecret, ts + "\n");
            var url = (d.WorkerUrl ?? "").TrimEnd('/') + "/sync/" + Uri.EscapeDataString(d.GuildId)
                    + "/tips?since=" + _lastSeenMs;

            using (var req = new HttpRequestMessage(HttpMethod.Get, url))
            {
                req.Headers.Add("x-loadout-ts", ts);
                req.Headers.Add("x-loadout-sig", sig);
                using (var resp = await _http.SendAsync(req).ConfigureAwait(false))
                {
                    if (!resp.IsSuccessStatusCode) return;
                    var json = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
                    var page = JsonConvert.DeserializeObject<TipsPage>(json);
                    if (page?.tips == null || page.tips.Length == 0) return;

                    foreach (var t in page.tips)
                    {
                        if (t == null) continue;
                        ProcessTip(t, s);
                        if (t.ts > _lastSeenMs) _lastSeenMs = t.ts;
                    }
                    if (page.ts > _lastSeenMs) _lastSeenMs = page.ts;
                }
            }
        }

        private static void ProcessTip(TipEvent t, LoadoutSettings s)
        {
            // Floor — drop tips below the configured min so a 5¢ webhook
            // re-fire doesn't trigger an overlay celebration. Floor is
            // in dollars; we treat the amount field as already-USD-ish.
            // Currency conversion is out of scope (the streamer can
            // pre-convert in their tip-provider's webhook config).
            int minDollars = Math.Max(0, s.Bolts.TipMinDollars);
            if (t.amount < minDollars) return;

            // Bolt award: TipBoltsPerDollar × amount, rounded. If the
            // tipper's stream identity is provided, award bolts to that
            // wallet. Otherwise just publish the celebration without
            // awarding (anonymous tips still pop the overlay).
            long bolts = (long)Math.Round(s.Bolts.TipBoltsPerDollar * t.amount);
            string awardedTo = "";
            if (bolts > 0 &&
                !string.IsNullOrEmpty(t.tipperPlatform) &&
                !string.IsNullOrEmpty(t.tipperHandle))
            {
                BoltsWallet.Instance.Earn(t.tipperPlatform, t.tipperHandle, bolts, "tip:" + (t.source ?? ""));
                awardedTo = t.tipperPlatform + ":" + t.tipperHandle;
            }

            AquiloBus.Instance.Publish("tips.received", new
            {
                tipper         = t.tipper,
                tipperPlatform = t.tipperPlatform,
                tipperHandle   = t.tipperHandle,
                amount         = t.amount,
                currency       = t.currency,
                message        = t.message,
                bolts          = bolts,
                awardedTo      = awardedTo,
                source         = t.source,
                tipId          = t.tipId,
                ts             = DateTimeOffset.FromUnixTimeMilliseconds(t.ts).UtcDateTime
            });
        }

        private static string HmacHex(string secret, string message)
        {
            using (var h = new HMACSHA256(Encoding.UTF8.GetBytes(secret)))
            {
                var hash = h.ComputeHash(Encoding.UTF8.GetBytes(message));
                return BitConverter.ToString(hash).Replace("-", "").ToLowerInvariant();
            }
        }

        private sealed class TipEvent
        {
            public string tipper         { get; set; }
            public string tipperPlatform { get; set; }
            public string tipperHandle   { get; set; }
            public double amount         { get; set; }
            public string currency       { get; set; }
            public string message        { get; set; }
            public string source         { get; set; }
            public string tipId          { get; set; }
            public long   ts             { get; set; }
        }
        private sealed class TipsPage
        {
            public TipEvent[] tips { get; set; }
            public long ts { get; set; }
        }
    }
}
