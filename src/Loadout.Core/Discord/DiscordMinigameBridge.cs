using System;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Loadout.Bus;
using Loadout.Settings;
using Loadout.Util;
using Newtonsoft.Json;

namespace Loadout.Discord
{
    /// <summary>
    /// Bridges Discord-side <c>/coinflip</c> and <c>/dice</c> results from
    /// the Worker into the local Aquilo Bus so the bolts minigames overlay
    /// renders them just like chat-side <c>!coinflip</c> / <c>!dice</c>.
    ///
    /// Cloudflare Workers can't push to <c>ws://127.0.0.1</c>, so the Worker
    /// stores recent results in a per-guild KV ring buffer (5-minute TTL)
    /// and we poll <c>GET /sync/:guildId/games?since=&lt;ms&gt;</c> on a
    /// short timer. Each unseen event is republished as
    /// <c>bolts.minigame.coinflip</c> / <c>bolts.minigame.dice</c> with the
    /// same shape <see cref="Loadout.Modules.BoltsModule"/> publishes for
    /// chat-side games — the overlay doesn't care about the source.
    /// </summary>
    public sealed class DiscordMinigameBridge
    {
        private static readonly DiscordMinigameBridge _instance = new DiscordMinigameBridge();
        public static DiscordMinigameBridge Instance => _instance;
        private DiscordMinigameBridge() { }

        private static readonly HttpClient _http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(5);

        private CancellationTokenSource _cts;
        private long _lastSeenMs;

        public void Start()
        {
            if (_cts != null) return;
            _cts = new CancellationTokenSource();
            // Start the polling cursor at "now" so we don't replay games that
            // happened while Loadout was off — those are stale by the time
            // OBS sees them anyway.
            _lastSeenMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
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
                catch (Exception ex) { ErrorLog.Write("DiscordMinigameBridge.Poll", ex); }
                try { await Task.Delay(PollInterval, token).ConfigureAwait(false); }
                catch (TaskCanceledException) { return; }
            }
        }

        private async Task PollOnceAsync()
        {
            var s = SettingsManager.Instance.Current.DiscordBot;
            if (s == null || !s.Enabled) return;
            if (string.IsNullOrEmpty(s.WorkerUrl) || string.IsNullOrEmpty(s.GuildId) || string.IsNullOrEmpty(s.SyncSecret))
                return;

            var ts  = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString();
            var sig = HmacHex(s.SyncSecret, ts + "\n");
            var url = (s.WorkerUrl ?? "").TrimEnd('/') + "/sync/" + Uri.EscapeDataString(s.GuildId)
                    + "/games?since=" + _lastSeenMs;

            using (var req = new HttpRequestMessage(HttpMethod.Get, url))
            {
                req.Headers.Add("x-loadout-ts", ts);
                req.Headers.Add("x-loadout-sig", sig);
                using (var resp = await _http.SendAsync(req).ConfigureAwait(false))
                {
                    if (!resp.IsSuccessStatusCode) return;
                    var json = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
                    var page = JsonConvert.DeserializeObject<GamesPage>(json);
                    if (page?.events == null || page.events.Length == 0) return;

                    foreach (var e in page.events)
                    {
                        if (e == null) continue;
                        Republish(e);
                        if (e.ts > _lastSeenMs) _lastSeenMs = e.ts;
                    }
                    if (page.ts > _lastSeenMs) _lastSeenMs = page.ts;
                }
            }
        }

        private static void Republish(GameEvent e)
        {
            // BoltsModule publishes minigame events with these shapes; we mirror
            // them so the overlay's existing scenes pick the Discord-origin
            // events up without any change. `source` is added to make the
            // origin obvious to anyone debugging an overlay.
            if (string.Equals(e.kind, "coinflip", StringComparison.OrdinalIgnoreCase))
            {
                AquiloBus.Instance.Publish("bolts.minigame.coinflip", new
                {
                    user    = e.user ?? "?",
                    wager   = e.wager,
                    result  = e.result ?? (e.won ? "heads" : "tails"),
                    won     = e.won,
                    payout  = e.payout,
                    balance = 0L,
                    source  = "discord",
                    ts      = DateTimeOffset.FromUnixTimeMilliseconds(e.ts).UtcDateTime
                });
            }
            else if (string.Equals(e.kind, "dice", StringComparison.OrdinalIgnoreCase))
            {
                AquiloBus.Instance.Publish("bolts.minigame.dice", new
                {
                    user    = e.user ?? "?",
                    wager   = e.wager,
                    target  = e.target,
                    rolled  = e.rolled,
                    won     = e.won,
                    payout  = e.payout,
                    balance = 0L,
                    source  = "discord",
                    ts      = DateTimeOffset.FromUnixTimeMilliseconds(e.ts).UtcDateTime
                });
            }
        }

        private static string HmacHex(string secret, string message)
        {
            using (var h = new HMACSHA256(Encoding.UTF8.GetBytes(secret)))
            {
                var hash = h.ComputeHash(Encoding.UTF8.GetBytes(message));
                return BitConverter.ToString(hash).Replace("-", "").ToLowerInvariant();
            }
        }

        private sealed class GameEvent
        {
            public string kind   { get; set; }
            public string user   { get; set; }
            public string userId { get; set; }
            public long   wager  { get; set; }
            public bool   won    { get; set; }
            public long   payout { get; set; }
            public string result { get; set; }   // coinflip
            public int    target { get; set; }   // dice
            public int    rolled { get; set; }   // dice
            public long   ts     { get; set; }   // ms
        }
        private sealed class GamesPage
        {
            public GameEvent[] events { get; set; }
            public long ts { get; set; }
        }
    }
}
