using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Loadout.Bolts;
using Loadout.Bus;
using Loadout.Identity;
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

        // Auto-sync timer — periodic Pull then Push when DiscordBot is
        // enabled and bound to a guild. Default cadence is 30 seconds,
        // which keeps the two surfaces close enough that a viewer who
        // earns bolts on stream sees them in /balance within ~30s and
        // vice versa. Running both halves in the same tick means a
        // single sync iteration converges (no flap) — Pull gets the
        // Worker's recent off-stream deltas into the DLL, then Push
        // tells the Worker about everything else.
        private Timer _autoSyncTimer;
        private int   _autoSyncRunning;          // 0/1 — re-entrancy guard
        private DateTime _autoSyncLastRunUtc;
        public  TimeSpan AutoSyncInterval { get; private set; } = TimeSpan.FromSeconds(30);

        /// <summary>Start the periodic auto-sync timer. Idempotent — calling
        /// this when the timer is already running is a no-op. Call from
        /// LoadoutHost startup so sync runs without anyone clicking a
        /// button. Stops automatically when DiscordBot.Enabled goes false
        /// (each tick checks the flag).
        ///
        /// Fires an immediate sync on startup before the periodic cadence
        /// takes over — bolts accumulate on the Worker side while the DLL
        /// is offline (Discord /coinflip, /daily, /shop-buy, vault credits)
        /// and waiting 30s after each launch was a noticeable drift window
        /// where /balance and the Loadout UI disagreed.</summary>
        public void StartAutoSync(TimeSpan? interval = null)
        {
            if (interval.HasValue && interval.Value.TotalSeconds >= 5)
                AutoSyncInterval = interval.Value;
            if (_autoSyncTimer != null) return;
            // Kick a sync immediately. Fire-and-forget; the re-entrancy
            // guard in AutoSyncTickAsync stops the periodic timer's first
            // scheduled tick from piling up if the immediate one's still
            // running. Errors are logged inside the tick — a slow startup
            // network never blocks the rest of the host boot.
            _ = AutoSyncTickAsync();
            // Periodic cadence resumes from one full interval out — not
            // 5s + interval. The immediate kick above covers the warm-up
            // case, so we don't need a short first delay anymore.
            _autoSyncTimer = new Timer(_ => _ = AutoSyncTickAsync(), null,
                AutoSyncInterval, AutoSyncInterval);
        }

        public void StopAutoSync()
        {
            _autoSyncTimer?.Dispose();
            _autoSyncTimer = null;
        }

        private async Task AutoSyncTickAsync()
        {
            // Re-entrancy guard so a slow tick can't pile up under a fast
            // interval setting. Interlocked.CompareExchange returns the
            // previous value; if it was 1 someone else is mid-sync.
            if (Interlocked.CompareExchange(ref _autoSyncRunning, 1, 0) != 0) return;
            try
            {
                var s = SettingsManager.Instance.Current.DiscordBot;
                if (s == null || !s.Enabled) return;
                if (string.IsNullOrEmpty(s.SyncSecret) || string.IsNullOrEmpty(s.GuildId)) return;
                _autoSyncLastRunUtc = DateTime.UtcNow;
                // Pull first — gets Worker's off-stream activity (e.g.
                // /coinflip, /daily) into the DLL — then push the merged
                // state back. This order means a single tick converges
                // even if both sides changed since the last run.
                await PullAsync().ConfigureAwait(false);
                await PushAsync().ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                ErrorLog.Write("DiscordSync.AutoSyncTick", ex);
            }
            finally
            {
                Interlocked.Exchange(ref _autoSyncRunning, 0);
            }
        }

        /// <summary>Streamer-initiated reset: zero every wallet (preserves
        /// links). Hits the Worker's <c>/sync/&lt;guild&gt;/reset-wallets</c>
        /// endpoint, then wipes the local DLL store. Returns
        /// (success, walletsClearedRemote, message).</summary>
        public async Task<(bool ok, int cleared, string message)> ResetAllWalletsAsync()
        {
            var s = SettingsManager.Instance.Current.DiscordBot;
            try
            {
                int remoteCleared = 0;
                if (s.Enabled && !string.IsNullOrEmpty(s.SyncSecret) && !string.IsNullOrEmpty(s.GuildId))
                {
                    var url = TrimUrl(s.WorkerUrl) + "/sync/" + Uri.EscapeDataString(s.GuildId) + "/reset-wallets";
                    var ts  = NowTs();
                    // POST with empty body — HMAC over ts+\n+"" so the
                    // signature scheme matches push (which signs ts+\n+body).
                    var sig = HmacHex(s.SyncSecret, ts + "\n");
                    using (var req = new HttpRequestMessage(HttpMethod.Post, url) { Content = new StringContent("", Encoding.UTF8, "application/json") })
                    {
                        req.Headers.Add("x-loadout-ts", ts);
                        req.Headers.Add("x-loadout-sig", sig);
                        using (var resp = await _http.SendAsync(req).ConfigureAwait(false))
                        {
                            if (!resp.IsSuccessStatusCode)
                                return (false, 0, "Worker reset failed: " + (int)resp.StatusCode);
                            var body = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
                            try
                            {
                                var parsed = JsonConvert.DeserializeObject<Dictionary<string, object>>(body);
                                if (parsed != null && parsed.TryGetValue("cleared", out var v))
                                    remoteCleared = Convert.ToInt32(v);
                            }
                            catch { /* tolerate response without cleared count */ }
                        }
                    }
                }
                // Wipe DLL-side wallet too. We zero balances rather than
                // delete accounts so the canonical-key map stays intact
                // for streak / first-seen tracking.
                int localCleared = BoltsWallet.Instance.ResetAll();
                Stamp("reset " + Math.Max(remoteCleared, localCleared));
                return (true, Math.Max(remoteCleared, localCleared),
                        "Reset " + remoteCleared + " Discord + " + localCleared + " local wallets.");
            }
            catch (Exception ex)
            {
                ErrorLog.Write("DiscordSync.ResetAllWallets", ex);
                return (false, 0, ex.Message);
            }
        }

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
                    }
                }

                // Piggyback dungeon hero state on the same push cadence —
                // separate endpoint so the wallet/profile path is unchanged
                // and a hero-side schema bump doesn't risk wallet writes.
                // Best-effort: a hero push failure doesn't fail the whole
                // sync since wallets already landed.
                int heroCount = await PushHeroesAsync(s).ConfigureAwait(false);

                return (true, snap.wallets.Count, "Pushed " + snap.wallets.Count + " wallets" +
                        (heroCount >= 0 ? ", " + heroCount + " heroes." : "."));
            }
            catch (Exception ex) { ErrorLog.Write("DiscordSync.Push", ex); return (false, 0, ex.Message); }
        }

        /// <summary>
        /// Push the dungeon hero registry (DungeonGameStore) up to the
        /// Worker so the /loadout menu's Hero / Bag views can render
        /// stream-earned gear without polling the DLL on every click.
        /// Worker stores the snapshot under d:hero-by-handle:&lt;guild&gt;:&lt;platform&gt;:&lt;handle&gt;
        /// and the menu does wallet → first-link → hero lookup. Returns
        /// item count, or -1 on failure (logged, not thrown — wallet
        /// push already committed by the time we get here).
        /// </summary>
        private async Task<int> PushHeroesAsync(Loadout.Settings.DiscordBotConfig s)
        {
            try
            {
                var heroes = Games.Dungeon.DungeonGameStore.Instance.RecentlyActive(500);
                if (heroes == null || heroes.Count == 0) return 0;
                var payload = new HeroSnapshotPush
                {
                    ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    heroes = new Dictionary<string, Games.Dungeon.HeroState>(StringComparer.OrdinalIgnoreCase)
                };
                foreach (var kv in heroes) payload.heroes[kv.Key] = kv.Value;

                var json = JsonConvert.SerializeObject(payload);
                var ts   = NowTs();
                var sig  = HmacHex(s.SyncSecret, ts + "\n" + json);
                var url  = TrimUrl(s.WorkerUrl) + "/sync/" + Uri.EscapeDataString(s.GuildId) + "/heroes";
                using (var req = new HttpRequestMessage(HttpMethod.Post, url) { Content = new StringContent(json, Encoding.UTF8, "application/json") })
                {
                    req.Headers.Add("x-loadout-ts", ts);
                    req.Headers.Add("x-loadout-sig", sig);
                    using (var resp = await _http.SendAsync(req).ConfigureAwait(false))
                    {
                        if (!resp.IsSuccessStatusCode) return -1;
                    }
                }
                return payload.heroes.Count;
            }
            catch (Exception ex) { ErrorLog.Write("DiscordSync.PushHeroes", ex); return -1; }
        }

        private sealed class HeroSnapshotPush
        {
            public long ts { get; set; }
            public Dictionary<string, Games.Dungeon.HeroState> heroes { get; set; }
        }

        // -------------------- Snapshot shapes + merge --------------------

        private sealed class RemoteWallet
        {
            public long balance { get; set; }
            public long lifetimeEarned { get; set; }
            public long lifetimeSpent { get; set; }
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
            // Pre-pass: any remote wallet with 2+ links represents a
            // viewer who has linked multiple stream identities to one
            // Discord account. Mirror those links into the local
            // IdentityLinker (auto-approved — the act of linking on
            // Discord IS the user's approval) and migrate any orphan
            // BoltsWallet entries into the canonical wallet. Without
            // this, the DLL keeps separate wallets per platform and
            // each platform's earnings push as an independent snapshot
            // entry; the Worker's per-entry max() merge then drops
            // contributions from all but the highest entry.
            ImportLinksFromRemote(snap);
            foreach (var kv in snap.wallets)
            {
                var rw = kv.Value;
                if (rw == null || rw.links == null || rw.links.Count == 0) continue;
                foreach (var link in rw.links)
                {
                    if (string.IsNullOrEmpty(link?.platform) || string.IsNullOrEmpty(link?.username)) continue;
                    // Use lifetime counters (which only grow) for the merge,
                    // not the absolute balance. Otherwise an off-stream
                    // /coinflip loss (which only the Worker knows about)
                    // would get clobbered by the next DLL push of a higher
                    // local balance. Counter-based merge composes correctly:
                    //   merged.lifetimeEarned = max(local, remote)
                    //   merged.lifetimeSpent  = max(local, remote)
                    //   merged.balance        = lifetimeEarned - lifetimeSpent
                    // (Worker now tracks lifetimeSpent too — added in the
                    // same May 2026 sync rebalance.)
                    var localAcct = BoltsWallet.Instance.Get(link.platform, link.username);
                    long localEarned = localAcct?.LifetimeEarned ?? 0;
                    long localSpent  = localAcct?.LifetimeSpent  ?? 0;
                    long localBalance = localAcct?.Balance        ?? 0;
                    long remoteEarned = rw.lifetimeEarned;
                    long remoteSpent  = rw.lifetimeSpent;
                    long mergedEarned, mergedSpent;
                    if (mode == "push")
                    {
                        // Push mode: DLL is authoritative — local values win.
                        mergedEarned = localEarned;
                        mergedSpent  = localSpent;
                    }
                    else if (mode == "pull")
                    {
                        // Pull mode: Worker is authoritative — remote wins.
                        mergedEarned = remoteEarned;
                        mergedSpent  = remoteSpent;
                    }
                    else
                    {
                        // Merge (default): each side's counters compose.
                        mergedEarned = Math.Max(localEarned, remoteEarned);
                        mergedSpent  = Math.Max(localSpent,  remoteSpent);
                    }
                    long targetBalance = Math.Max(0, mergedEarned - mergedSpent);
                    long balanceDelta  = targetBalance - localBalance;
                    long earnedDelta   = mergedEarned   - localEarned;
                    long spentDelta    = mergedSpent    - localSpent;
                    if (balanceDelta == 0 && earnedDelta == 0 && spentDelta == 0) continue;
                    // Apply via Earn/Spend so lifetime counters land on
                    // the right account. The "discord:reconcile" reason
                    // is a tripwire when reading the per-account log.
                    if (earnedDelta > 0)
                        BoltsWallet.Instance.Earn(link.platform, link.username, earnedDelta, "discord:reconcile");
                    if (spentDelta > 0 && BoltsWallet.Instance.Balance(link.platform, link.username) >= spentDelta)
                        BoltsWallet.Instance.Spend(link.platform, link.username, spentDelta, "discord:reconcile");
                    changed++;
                }
            }
            AquiloBus.Instance.Publish("discord.sync.completed", new { direction = "pull", mode, changed, ts = DateTime.UtcNow });
            return changed;
        }

        /// <summary>For every remote wallet with 2+ links, register the
        /// cross-platform pairs in the local IdentityLinker and migrate
        /// any orphan BoltsWallet accounts into their canonical entries.
        /// Idempotent — duplicate pairs are de-duped inside AddDirectLink,
        /// and MergeIntoCanonical no-ops when the account is already
        /// canonical. After this runs, future Earn/Spend on any of the
        /// linked platforms route through ResolveKey() to a single
        /// shared wallet, so the next push has one snapshot entry per
        /// linked Discord user (not one per platform).</summary>
        private static void ImportLinksFromRemote(RemoteSnapshot snap)
        {
            if (snap?.wallets == null) return;
            foreach (var kv in snap.wallets)
            {
                var rw = kv.Value;
                var links = rw?.links;
                if (links == null || links.Count < 2) continue;
                // Pair every link with every later link in the array
                // (n-2 calls for n links — fine since n is at most a
                // small handful per viewer). AddDirectLink dedupes so
                // re-running this every sync is cheap and idempotent.
                for (int i = 0; i < links.Count; i++)
                {
                    for (int j = i + 1; j < links.Count; j++)
                    {
                        var a = links[i]; var b = links[j];
                        if (a == null || b == null) continue;
                        if (string.IsNullOrEmpty(a.platform) || string.IsNullOrEmpty(a.username)) continue;
                        if (string.IsNullOrEmpty(b.platform) || string.IsNullOrEmpty(b.username)) continue;
                        var maskA = PlatformMaskExtensions.FromShortName(a.platform);
                        var maskB = PlatformMaskExtensions.FromShortName(b.platform);
                        if (maskA == PlatformMask.None || maskB == PlatformMask.None) continue;
                        try
                        {
                            Identity.IdentityLinker.Instance.AddDirectLink(maskA, a.username, maskB, b.username);
                        }
                        catch (Exception ex) { ErrorLog.Write("DiscordSync.ImportLinks", ex); }
                    }
                }
                // Migrate orphan wallets into the canonical entry. After
                // AddDirectLink runs, ResolveKey for every link returns
                // the same canonical key — the orphans (if any) hold
                // historical balances that were earned before the link
                // existed, and would otherwise be stranded.
                foreach (var l in links)
                {
                    if (l == null || string.IsNullOrEmpty(l.platform) || string.IsNullOrEmpty(l.username)) continue;
                    try { BoltsWallet.Instance.MergeIntoCanonical(l.platform, l.username); }
                    catch (Exception ex) { ErrorLog.Write("DiscordSync.MergeOrphan", ex); }
                }
            }
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
                    lifetimeSpent = acct.LifetimeSpent,
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
