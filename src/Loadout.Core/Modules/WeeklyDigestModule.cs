using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Loadout.Bus;
using Loadout.Sb;
using Loadout.Settings;
using Loadout.Util;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Loadout.Modules
{
    /// <summary>
    /// Accumulates a rolling weekly stats snapshot — bolts earned, top
    /// earners, hype trains, dungeon runs, biggest tipper — and posts
    /// it as a Discord embed once a week. The DLL is the source of
    /// truth for the stats (it sees every event); the Worker just
    /// receives the payload and forwards to Discord via the bot's
    /// own /channels/{id}/messages endpoint.
    ///
    /// Stats persist to <c>weekly-digest.json</c> in the data folder.
    /// On a successful post the snapshot is reset to zero. If the post
    /// fails the snapshot stays — next minute's tick will retry.
    ///
    /// Bus subscriptions feed the counters in near-real-time so a crash
    /// before the post never strands more than a minute of activity.
    /// </summary>
    public sealed class WeeklyDigestModule : IEventModule
    {
        private static readonly HttpClient _http = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };

        private readonly object _gate = new object();
        private WeeklyStats _stats;
        private string _path;
        // Last-attempted post timestamp — debounces multiple posts
        // within the same hour if the timer ticks fast.
        private DateTime _lastAttemptUtc = DateTime.MinValue;
        private Timer _scheduler;

        public WeeklyDigestModule()
        {
            // Load persisted stats. If the file doesn't exist (first
            // run) start with a fresh snapshot.
            _path = Path.Combine(SettingsManager.Instance.DataFolder ?? ".", "weekly-digest.json");
            _stats = LoadFromDisk();

            // Subscribe to bus events. Each handler bumps a counter;
            // none of them block — handlers return null since we don't
            // need to reply to the publisher.
            AquiloBus.Instance.RegisterHandler("bolts.earned",       HandleBoltsEarned);
            AquiloBus.Instance.RegisterHandler("hypetrain.end",      HandleHypeTrainEnd);
            AquiloBus.Instance.RegisterHandler("bolts.minigame.coinflip", HandleMinigame);
            AquiloBus.Instance.RegisterHandler("bolts.minigame.dice",     HandleMinigame);
            AquiloBus.Instance.RegisterHandler("bolts.minigame.slots",    HandleMinigame);
            AquiloBus.Instance.RegisterHandler("bolts.minigame.rps",      HandleMinigame);
            AquiloBus.Instance.RegisterHandler("bolts.minigame.roulette", HandleMinigame);
            AquiloBus.Instance.RegisterHandler("bolts.heist.success",     HandleHeistSuccess);
            AquiloBus.Instance.RegisterHandler("welcomes.shown",          HandleWelcome);
            AquiloBus.Instance.RegisterHandler("tips.received",           HandleTip);

            // Tick every 60s — cheap, and the wall-clock check decides
            // whether to actually post. First tick fires after 30s so
            // a fresh launch right at the digest hour still posts.
            _scheduler = new Timer(_ => _ = TickAsync(), null,
                TimeSpan.FromSeconds(30), TimeSpan.FromMinutes(1));
        }

        public void OnEvent(EventContext ctx) { /* no-op; bus-driven */ }
        public void OnTick() { /* no-op */ }

        // ── Bus handlers ───────────────────────────────────────────────
        private BusMessage HandleBoltsEarned(string fromClient, BusMessage incoming)
        {
            try
            {
                var d = AsObject(incoming?.Data);
                long amount = AsLong(d?["amount"]);
                string user = AsString(d?["user"]);
                if (amount <= 0) return null;
                lock (_gate)
                {
                    _stats.BoltsEarned += amount;
                    if (!string.IsNullOrEmpty(user))
                    {
                        if (_stats.TopEarners == null) _stats.TopEarners = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
                        _stats.TopEarners.TryGetValue(user, out var prev);
                        _stats.TopEarners[user] = prev + amount;
                    }
                    DirtySave();
                }
            }
            catch (Exception ex) { ErrorLog.Write("WeeklyDigest.Earned", ex); }
            return null;
        }

        private BusMessage HandleHypeTrainEnd(string fromClient, BusMessage incoming)
        {
            try
            {
                var d = AsObject(incoming?.Data);
                // Two trains publish hypetrain.end — only count the
                // cross-platform ("all") one so the digest doesn't
                // double a single hype moment.
                var src = AsString(d?["source"]) ?? "all";
                if (!string.Equals(src, "all", StringComparison.OrdinalIgnoreCase)) return null;
                int finalLevel = (int)AsLong(d?["finalLevel"]);
                lock (_gate)
                {
                    _stats.HypeTrains++;
                    if (finalLevel > _stats.HypeTrainMaxLevel) _stats.HypeTrainMaxLevel = finalLevel;
                    DirtySave();
                }
            }
            catch (Exception ex) { ErrorLog.Write("WeeklyDigest.HypeTrain", ex); }
            return null;
        }

        private BusMessage HandleMinigame(string fromClient, BusMessage incoming)
        {
            try
            {
                lock (_gate) { _stats.MinigamesPlayed++; DirtySave(); }
            }
            catch { }
            return null;
        }

        private BusMessage HandleHeistSuccess(string fromClient, BusMessage incoming)
        {
            try
            {
                var d = AsObject(incoming?.Data);
                long pot = AsLong(d?["totalPot"]);
                int crew = (int)AsLong(d?["contributors"]);
                lock (_gate)
                {
                    _stats.HeistsSucceeded++;
                    if (pot > _stats.BiggestHeistPot) _stats.BiggestHeistPot = pot;
                    if (crew > _stats.BiggestHeistCrew) _stats.BiggestHeistCrew = crew;
                    DirtySave();
                }
            }
            catch { }
            return null;
        }

        private BusMessage HandleWelcome(string fromClient, BusMessage incoming)
        {
            try { lock (_gate) { _stats.WelcomesShown++; DirtySave(); } } catch { }
            return null;
        }

        private BusMessage HandleTip(string fromClient, BusMessage incoming)
        {
            try
            {
                var d = AsObject(incoming?.Data);
                double amount = AsDouble(d?["amount"]);
                string tipper = AsString(d?["tipper"]);
                lock (_gate)
                {
                    _stats.TipsCount++;
                    _stats.TipsTotalUsd += amount;
                    if (amount > _stats.BiggestTipUsd)
                    {
                        _stats.BiggestTipUsd = amount;
                        _stats.BiggestTipper = tipper ?? "anonymous";
                    }
                    DirtySave();
                }
            }
            catch { }
            return null;
        }

        // ── Scheduler ──────────────────────────────────────────────────
        private async Task TickAsync()
        {
            try
            {
                var s = SettingsManager.Instance.Current;
                if (s?.Bolts == null || !s.Bolts.WeeklyDigestEnabled) return;
                if (s.DiscordBot == null || !s.DiscordBot.Enabled) return;
                if (string.IsNullOrEmpty(s.DiscordBot.SyncSecret) || string.IsNullOrEmpty(s.DiscordBot.GuildId)) return;
                if (string.IsNullOrEmpty(s.Bolts.WeeklyDigestChannelId)) return;

                var now = DateTime.UtcNow;
                if ((int)now.DayOfWeek != s.Bolts.WeeklyDigestDay) return;
                if (now.Hour != s.Bolts.WeeklyDigestHourUtc) return;
                // Single-fire-per-hour debounce. _lastAttemptUtc is set
                // on the first tick of the matching hour and stops
                // subsequent 60s ticks within the same hour from
                // re-posting. The re-arm happens automatically next
                // week when DayOfWeek + Hour first match again.
                if (_lastAttemptUtc.Year == now.Year &&
                    _lastAttemptUtc.DayOfYear == now.DayOfYear &&
                    _lastAttemptUtc.Hour == now.Hour) return;
                _lastAttemptUtc = now;

                WeeklyStats snapshot;
                lock (_gate) { snapshot = _stats.Clone(); }

                bool ok = await PostDigestAsync(s, snapshot).ConfigureAwait(false);
                if (ok)
                {
                    lock (_gate)
                    {
                        _stats = new WeeklyStats { WeekStartedUtc = DateTime.UtcNow };
                        WriteToDisk();
                    }
                }
            }
            catch (Exception ex) { ErrorLog.Write("WeeklyDigest.Tick", ex); }
        }

        private async Task<bool> PostDigestAsync(LoadoutSettings s, WeeklyStats snap)
        {
            try
            {
                // Top 5 earners by total. Sort descending; ties broken
                // alphabetically for determinism.
                var top = (snap.TopEarners ?? new Dictionary<string, long>())
                    .OrderByDescending(kv => kv.Value)
                    .ThenBy(kv => kv.Key, StringComparer.OrdinalIgnoreCase)
                    .Take(5)
                    .Select(kv => new { user = kv.Key, bolts = kv.Value })
                    .ToList();

                var payload = new
                {
                    channelId         = s.Bolts.WeeklyDigestChannelId,
                    streamerName      = s.BroadcasterName ?? "",
                    weekStartedUtc    = snap.WeekStartedUtc,
                    weekEndedUtc      = DateTime.UtcNow,
                    boltsEarned       = snap.BoltsEarned,
                    boltsEmoji        = s.Bolts.Emoji ?? "⚡",
                    boltsName         = s.Bolts.DisplayName ?? "Bolts",
                    topEarners        = top,
                    hypeTrains        = snap.HypeTrains,
                    hypeTrainMaxLevel = snap.HypeTrainMaxLevel,
                    minigamesPlayed   = snap.MinigamesPlayed,
                    heistsSucceeded   = snap.HeistsSucceeded,
                    biggestHeistPot   = snap.BiggestHeistPot,
                    biggestHeistCrew  = snap.BiggestHeistCrew,
                    welcomesShown     = snap.WelcomesShown,
                    tipsCount         = snap.TipsCount,
                    tipsTotalUsd      = snap.TipsTotalUsd,
                    biggestTipUsd     = snap.BiggestTipUsd,
                    biggestTipper     = snap.BiggestTipper ?? "",
                    accent            = "#3A86FF"
                };
                var json = JsonConvert.SerializeObject(payload);
                var ts   = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString();
                var sig  = HmacHex(s.DiscordBot.SyncSecret, ts + "\n" + json);
                var url  = (s.DiscordBot.WorkerUrl ?? "").TrimEnd('/') + "/sync/" + Uri.EscapeDataString(s.DiscordBot.GuildId) + "/digest";
                using (var req = new HttpRequestMessage(HttpMethod.Post, url) { Content = new StringContent(json, Encoding.UTF8, "application/json") })
                {
                    req.Headers.Add("x-loadout-ts", ts);
                    req.Headers.Add("x-loadout-sig", sig);
                    using (var resp = await _http.SendAsync(req).ConfigureAwait(false))
                    {
                        return resp.IsSuccessStatusCode;
                    }
                }
            }
            catch (Exception ex) { ErrorLog.Write("WeeklyDigest.Post", ex); return false; }
        }

        // ── Persistence ────────────────────────────────────────────────
        private void DirtySave()
        {
            // Save synchronously — stats files are tiny (<10kb) and the
            // protection against crash is worth more than the perf hit.
            try { WriteToDisk(); } catch { /* logged on retry */ }
        }
        private WeeklyStats LoadFromDisk()
        {
            try
            {
                if (string.IsNullOrEmpty(_path) || !File.Exists(_path))
                    return new WeeklyStats { WeekStartedUtc = DateTime.UtcNow };
                var json = File.ReadAllText(_path);
                return JsonConvert.DeserializeObject<WeeklyStats>(json) ?? new WeeklyStats { WeekStartedUtc = DateTime.UtcNow };
            }
            catch { return new WeeklyStats { WeekStartedUtc = DateTime.UtcNow }; }
        }
        private void WriteToDisk()
        {
            if (string.IsNullOrEmpty(_path)) return;
            File.WriteAllText(_path, JsonConvert.SerializeObject(_stats, Formatting.Indented));
        }

        // ── Helpers ────────────────────────────────────────────────────
        private static JObject AsObject(object o)
        {
            if (o == null) return null;
            if (o is JObject jo) return jo;
            if (o is JToken jt) return jt.Type == JTokenType.Object ? (JObject)jt : null;
            try { return JObject.FromObject(o); } catch { return null; }
        }
        private static long AsLong(JToken t)
        {
            if (t == null) return 0;
            try { return t.Type == JTokenType.Integer ? t.Value<long>() : long.Parse(t.ToString()); }
            catch { return 0; }
        }
        private static double AsDouble(JToken t)
        {
            if (t == null) return 0;
            try { return t.Value<double>(); } catch { return 0; }
        }
        private static string AsString(JToken t) => t?.Type == JTokenType.Null ? null : t?.ToString();

        private static string HmacHex(string secret, string message)
        {
            using (var h = new HMACSHA256(Encoding.UTF8.GetBytes(secret)))
            {
                var hash = h.ComputeHash(Encoding.UTF8.GetBytes(message));
                return BitConverter.ToString(hash).Replace("-", "").ToLowerInvariant();
            }
        }

        // ── State type ─────────────────────────────────────────────────
        private sealed class WeeklyStats
        {
            public DateTime WeekStartedUtc { get; set; } = DateTime.UtcNow;
            public long     BoltsEarned   { get; set; }
            public Dictionary<string, long> TopEarners { get; set; } = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
            public int      HypeTrains    { get; set; }
            public int      HypeTrainMaxLevel { get; set; }
            public int      MinigamesPlayed { get; set; }
            public int      HeistsSucceeded { get; set; }
            public long     BiggestHeistPot { get; set; }
            public int      BiggestHeistCrew { get; set; }
            public int      WelcomesShown { get; set; }
            public int      TipsCount     { get; set; }
            public double   TipsTotalUsd  { get; set; }
            public double   BiggestTipUsd { get; set; }
            public string   BiggestTipper { get; set; }

            public WeeklyStats Clone()
            {
                var c = new WeeklyStats
                {
                    WeekStartedUtc    = WeekStartedUtc,
                    BoltsEarned       = BoltsEarned,
                    TopEarners        = TopEarners == null
                        ? new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase)
                        : new Dictionary<string, long>(TopEarners, StringComparer.OrdinalIgnoreCase),
                    HypeTrains        = HypeTrains,
                    HypeTrainMaxLevel = HypeTrainMaxLevel,
                    MinigamesPlayed   = MinigamesPlayed,
                    HeistsSucceeded   = HeistsSucceeded,
                    BiggestHeistPot   = BiggestHeistPot,
                    BiggestHeistCrew  = BiggestHeistCrew,
                    WelcomesShown     = WelcomesShown,
                    TipsCount         = TipsCount,
                    TipsTotalUsd      = TipsTotalUsd,
                    BiggestTipUsd     = BiggestTipUsd,
                    BiggestTipper     = BiggestTipper,
                };
                return c;
            }
        }
    }
}
