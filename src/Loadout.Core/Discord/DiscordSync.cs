using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using Loadout.Bolts;
using Loadout.Bus;
using Loadout.Settings;
using Loadout.Util;
using Newtonsoft.Json;

namespace Loadout.Discord
{
    /// <summary>
    /// Talks to the shared Loadout Discord worker. Three jobs:
    ///   1. <see cref="MintClaimCodeAsync"/> — asks the worker for a fresh
    ///      8-char claim code. The streamer types <c>/loadout-claim &lt;code&gt;</c>
    ///      in their Discord server (where they invited the Loadout Bot)
    ///      and the worker binds the guild to the code's secret.
    ///   2. <see cref="PollClaimAsync"/> — polls the worker after a code is
    ///      issued, until the user has claimed it. Promotes the secret +
    ///      guildId into <see cref="DiscordBotConfig"/>.
    ///   3. <see cref="PullAsync"/>/<see cref="PushAsync"/> — wallet
    ///      reconciliation, HMAC-SHA-256 signed.
    /// </summary>
    public sealed class DiscordSync
    {
        private static readonly DiscordSync _instance = new DiscordSync();
        public static DiscordSync Instance => _instance;
        private DiscordSync() { }

        private static readonly HttpClient _http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };

        // -------------------- Claim flow --------------------

        public sealed class MintResult
        {
            public bool   Ok { get; set; }
            public string Code { get; set; }
            public string InviteUrl { get; set; }
            public int    ExpiresInSec { get; set; }
            public string Message { get; set; }
        }

        /// <summary>
        /// Requests a new claim code from the worker. The code goes into
        /// settings as <c>PendingClaimCode</c>; the user is then expected
        /// to invite the Loadout Bot (we surface the invite URL) and run
        /// <c>/loadout-claim &lt;code&gt;</c> in their server.
        /// </summary>
        public async Task<MintResult> MintClaimCodeAsync()
        {
            var s = SettingsManager.Instance.Current.DiscordBot;
            if (string.IsNullOrEmpty(s.WorkerUrl))
                return new MintResult { Ok = false, Message = "Worker URL is empty." };

            try
            {
                var body = JsonConvert.SerializeObject(new
                {
                    ownerName = SettingsManager.Instance.Current.BroadcasterName ?? ""
                });
                using (var req = new HttpRequestMessage(HttpMethod.Post, TrimUrl(s.WorkerUrl) + "/claim")
                       { Content = new StringContent(body, Encoding.UTF8, "application/json") })
                using (var resp = await _http.SendAsync(req).ConfigureAwait(false))
                {
                    var json = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
                    if (!resp.IsSuccessStatusCode)
                        return new MintResult { Ok = false, Message = "Worker rejected: " + (int)resp.StatusCode + " " + json };
                    var parsed = JsonConvert.DeserializeObject<MintResponse>(json);
                    if (parsed == null || string.IsNullOrEmpty(parsed.code))
                        return new MintResult { Ok = false, Message = "Worker returned an empty code." };

                    // Stash the code + secret locally. The secret stays in
                    // settings even before the claim is confirmed — once
                    // the user runs /loadout-claim, the worker's KV will
                    // store the same secret indexed by guildId, and our
                    // sync calls will work.
                    SettingsManager.Instance.Mutate(cfg =>
                    {
                        cfg.DiscordBot.PendingClaimCode = parsed.code;
                        cfg.DiscordBot.PendingClaimMintedUtc = DateTime.UtcNow;
                        cfg.DiscordBot.SyncSecret = parsed.secret;
                    });
                    SettingsManager.Instance.SaveNow();

                    return new MintResult
                    {
                        Ok = true, Code = parsed.code, InviteUrl = parsed.invite,
                        ExpiresInSec = parsed.expiresInSec, Message = "ready"
                    };
                }
            }
            catch (Exception ex)
            {
                ErrorLog.Write("DiscordSync.MintClaim", ex);
                return new MintResult { Ok = false, Message = ex.Message };
            }
        }
        private sealed class MintResponse
        {
            public string code { get; set; }
            public string secret { get; set; }
            public string invite { get; set; }
            public int    expiresInSec { get; set; }
        }

        /// <summary>
        /// Polls the worker once. If the code has been claimed, promotes
        /// the guild ID into config and returns true. The UI polls this
        /// in the background after MintClaimCodeAsync().
        /// </summary>
        public async Task<(bool claimed, string guildId, string message)> PollClaimAsync()
        {
            var s = SettingsManager.Instance.Current.DiscordBot;
            if (string.IsNullOrEmpty(s.PendingClaimCode))
                return (false, null, "No pending code.");
            try
            {
                var url = TrimUrl(s.WorkerUrl) + "/claim/" + Uri.EscapeDataString(s.PendingClaimCode) + "/status";
                using (var resp = await _http.GetAsync(url).ConfigureAwait(false))
                {
                    var json = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
                    if (!resp.IsSuccessStatusCode) return (false, null, "Status check failed: " + (int)resp.StatusCode);
                    var parsed = JsonConvert.DeserializeObject<StatusResponse>(json);
                    if (parsed?.status == "claimed" && !string.IsNullOrEmpty(parsed.guildId))
                    {
                        SettingsManager.Instance.Mutate(cfg =>
                        {
                            cfg.DiscordBot.GuildId = parsed.guildId;
                            cfg.DiscordBot.PendingClaimCode = "";
                            cfg.DiscordBot.LastSyncStatus = "claimed";
                            cfg.DiscordBot.LastSyncUtc    = DateTime.UtcNow;
                        });
                        SettingsManager.Instance.SaveNow();
                        return (true, parsed.guildId, "Claimed by guild " + parsed.guildId);
                    }
                    if (parsed?.status == "expired")
                    {
                        // Surface to the user so they know to mint a new code.
                        return (false, null, "expired");
                    }
                    return (false, null, "pending");
                }
            }
            catch (Exception ex)
            {
                ErrorLog.Write("DiscordSync.PollClaim", ex);
                return (false, null, ex.Message);
            }
        }
        private sealed class StatusResponse
        {
            public string status { get; set; }
            public string guildId { get; set; }
        }

        /// <summary>
        /// Unbinds the current guild. Tells the worker to drop the secret
        /// + guildowner record (proving ownership with the existing secret),
        /// then clears local state.
        /// </summary>
        public async Task<(bool ok, string message)> UnlinkAsync()
        {
            var s = SettingsManager.Instance.Current.DiscordBot;
            if (string.IsNullOrEmpty(s.GuildId) || string.IsNullOrEmpty(s.SyncSecret))
                return (false, "Nothing to unlink.");
            try
            {
                var body = JsonConvert.SerializeObject(new { action = "unlink", existingSecret = s.SyncSecret });
                using (var req = new HttpRequestMessage(HttpMethod.Post, TrimUrl(s.WorkerUrl) + "/sync/" + Uri.EscapeDataString(s.GuildId) + "/init")
                       { Content = new StringContent(body, Encoding.UTF8, "application/json") })
                using (var resp = await _http.SendAsync(req).ConfigureAwait(false))
                {
                    var rt = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
                    if (!resp.IsSuccessStatusCode) return (false, "Worker: " + (int)resp.StatusCode + " " + rt);
                }
                SettingsManager.Instance.Mutate(cfg =>
                {
                    cfg.DiscordBot.GuildId = "";
                    cfg.DiscordBot.SyncSecret = "";
                    cfg.DiscordBot.PendingClaimCode = "";
                    cfg.DiscordBot.LastSyncStatus = "unlinked";
                });
                SettingsManager.Instance.SaveNow();
                return (true, "Unlinked.");
            }
            catch (Exception ex)
            {
                ErrorLog.Write("DiscordSync.Unlink", ex);
                return (false, ex.Message);
            }
        }

        // -------------------- Push / Pull --------------------

        public async Task<(bool ok, int changed, string message)> PullAsync()
        {
            var s = SettingsManager.Instance.Current.DiscordBot;
            if (!s.Enabled) return (false, 0, "Discord bot disabled.");
            if (string.IsNullOrEmpty(s.SyncSecret) || string.IsNullOrEmpty(s.GuildId))
                return (false, 0, "Not bound to a guild yet.");

            try
            {
                var url = TrimUrl(s.WorkerUrl) + "/sync/" + Uri.EscapeDataString(s.GuildId);
                var ts  = NowTs();
                var sig = HmacHex(s.SyncSecret, ts + "\n");
                using (var req = new HttpRequestMessage(HttpMethod.Get, url))
                {
                    req.Headers.Add("x-loadout-ts", ts);
                    req.Headers.Add("x-loadout-sig", sig);
                    using (var resp = await _http.SendAsync(req).ConfigureAwait(false))
                    {
                        if (!resp.IsSuccessStatusCode) return (false, 0, "Pull failed: " + (int)resp.StatusCode);
                        var body = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
                        var snap = JsonConvert.DeserializeObject<RemoteSnapshot>(body);
                        if (snap?.wallets == null) return (true, 0, "Empty snapshot.");
                        int n = MergeFromRemote(snap, s.SyncMode);
                        Stamp("pulled " + n);
                        return (true, n, "Pulled " + n + " wallets.");
                    }
                }
            }
            catch (Exception ex) { ErrorLog.Write("DiscordSync.Pull", ex); return (false, 0, ex.Message); }
        }

        public async Task<(bool ok, int sent, string message)> PushAsync()
        {
            var s = SettingsManager.Instance.Current.DiscordBot;
            if (!s.Enabled) return (false, 0, "Discord bot disabled.");
            if (string.IsNullOrEmpty(s.SyncSecret) || string.IsNullOrEmpty(s.GuildId))
                return (false, 0, "Not bound to a guild yet.");

            try
            {
                BoltsWallet.Instance.Initialize();
                var snap = BuildPushSnapshot();
                var json = JsonConvert.SerializeObject(snap);
                var ts   = NowTs();
                var sig  = HmacHex(s.SyncSecret, ts + "\n" + json);
                var url  = TrimUrl(s.WorkerUrl) + "/sync/" + Uri.EscapeDataString(s.GuildId);
                using (var req = new HttpRequestMessage(HttpMethod.Post, url) { Content = new StringContent(json, Encoding.UTF8, "application/json") })
                {
                    req.Headers.Add("x-loadout-ts", ts);
                    req.Headers.Add("x-loadout-sig", sig);
                    using (var resp = await _http.SendAsync(req).ConfigureAwait(false))
                    {
                        if (!resp.IsSuccessStatusCode) return (false, 0, "Push failed: " + (int)resp.StatusCode);
                        Stamp("pushed " + snap.wallets.Count);
                        return (true, snap.wallets.Count, "Pushed " + snap.wallets.Count + " wallets.");
                    }
                }
            }
            catch (Exception ex) { ErrorLog.Write("DiscordSync.Push", ex); return (false, 0, ex.Message); }
        }

        // -------------------- Snapshot shapes + merge --------------------

        private sealed class RemoteWallet
        {
            public long balance { get; set; }
            public long lifetimeEarned { get; set; }
            public long lastEarnUtc { get; set; }
            public int  dailyStreak { get; set; }
            public List<RemoteLink> links { get; set; }
        }
        private sealed class RemoteLink
        {
            public string platform { get; set; }
            public string username { get; set; }
        }
        private sealed class RemoteSnapshot
        {
            public Dictionary<string, RemoteWallet> wallets { get; set; }
            public long ts { get; set; }
        }
        private sealed class PushSnapshot
        {
            public Dictionary<string, RemoteWallet> wallets { get; set; } = new Dictionary<string, RemoteWallet>();
            public long ts { get; set; }
        }

        private static int MergeFromRemote(RemoteSnapshot snap, string mode)
        {
            int changed = 0;
            BoltsWallet.Instance.Initialize();
            mode = (mode ?? "merge").ToLowerInvariant();
            foreach (var kv in snap.wallets)
            {
                var rw = kv.Value;
                if (rw == null || rw.links == null || rw.links.Count == 0) continue;
                foreach (var link in rw.links)
                {
                    if (string.IsNullOrEmpty(link?.platform) || string.IsNullOrEmpty(link?.username)) continue;
                    var localBalance = BoltsWallet.Instance.Balance(link.platform, link.username);
                    long target = rw.balance;
                    if (mode == "merge") target = Math.Max(localBalance, rw.balance);
                    else if (mode == "push") target = localBalance;
                    else if (mode == "pull") target = rw.balance;
                    var delta = target - localBalance;
                    if (delta == 0) continue;
                    if (delta > 0) BoltsWallet.Instance.Earn(link.platform, link.username, delta, "discord:reconcile");
                    else           BoltsWallet.Instance.Spend(link.platform, link.username, -delta, "discord:reconcile");
                    changed++;
                }
            }
            AquiloBus.Instance.Publish("discord.sync.completed", new { direction = "pull", mode, changed, ts = DateTime.UtcNow });
            return changed;
        }

        private static PushSnapshot BuildPushSnapshot()
        {
            var snap = new PushSnapshot { ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
            foreach (var acct in BoltsWallet.Instance.AllAccounts())
            {
                BoltsWallet.SplitKey(acct.Key, out var platform, out var handle);
                if (string.IsNullOrEmpty(handle)) continue;
                snap.wallets[acct.Key] = new RemoteWallet
                {
                    balance = acct.Balance,
                    lifetimeEarned = acct.LifetimeEarned,
                    lastEarnUtc = acct.LastActivityUtc.Ticks > 0 ? new DateTimeOffset(acct.LastActivityUtc, TimeSpan.Zero).ToUnixTimeMilliseconds() : 0,
                    dailyStreak = acct.StreakDays,
                    links = new List<RemoteLink> { new RemoteLink { platform = platform ?? "twitch", username = handle } }
                };
            }
            return snap;
        }

        // -------------------- Helpers --------------------

        private static string HmacHex(string secret, string message)
        {
            using (var h = new HMACSHA256(Encoding.UTF8.GetBytes(secret)))
            {
                var sig = h.ComputeHash(Encoding.UTF8.GetBytes(message));
                return BitConverter.ToString(sig).Replace("-", "").ToLowerInvariant();
            }
        }
        private static string NowTs() => DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString();
        private static string TrimUrl(string s) => (s ?? "").TrimEnd('/');
        private static void Stamp(string status)
        {
            SettingsManager.Instance.Mutate(cfg =>
            {
                cfg.DiscordBot.LastSyncUtc = DateTime.UtcNow;
                cfg.DiscordBot.LastSyncStatus = status;
            });
        }
    }
}
