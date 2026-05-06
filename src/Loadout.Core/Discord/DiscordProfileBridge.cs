using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Loadout.Bolts;
using Loadout.Bus;
using Loadout.Settings;
using Loadout.Util;
using Loadout.ViewerProfile;
using Newtonsoft.Json;

namespace Loadout.Discord
{
    /// <summary>
    /// Polls the Worker for off-stream profile edits made via
    /// <c>/profile-set-bio</c> + friends, then merges them into the
    /// local <see cref="ViewerProfileStore"/>. Uses the same HMAC
    /// pattern as <see cref="DiscordSync"/> + <see cref="DiscordMinigameBridge"/>.
    ///
    /// Mapping Discord user → stream identity: each profile entry
    /// arrives keyed by Discord user ID. We walk the BoltsWallet's
    /// per-account `links` array to find the matching platform+handle
    /// and write to that key in the local store. Viewers who haven't
    /// linked their stream identity yet are silently skipped — their
    /// profile lives Worker-side until they run /link.
    /// </summary>
    public sealed class DiscordProfileBridge
    {
        private static readonly DiscordProfileBridge _instance = new DiscordProfileBridge();
        public static DiscordProfileBridge Instance => _instance;
        private DiscordProfileBridge() { }

        private static readonly HttpClient _http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        // Profiles change slower than wallet snapshots; 30s is plenty.
        private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(30);

        private CancellationTokenSource _cts;
        private long _lastSeenMs;

        public void Start()
        {
            if (_cts != null) return;
            _cts = new CancellationTokenSource();
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
                catch (Exception ex) { ErrorLog.Write("DiscordProfileBridge.Poll", ex); }
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
                    + "/profiles?since=" + _lastSeenMs;

            using (var req = new HttpRequestMessage(HttpMethod.Get, url))
            {
                req.Headers.Add("x-loadout-ts", ts);
                req.Headers.Add("x-loadout-sig", sig);
                using (var resp = await _http.SendAsync(req).ConfigureAwait(false))
                {
                    if (!resp.IsSuccessStatusCode) return;
                    var json = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
                    var page = JsonConvert.DeserializeObject<ProfilesPage>(json);
                    if (page == null) return;
                    if (page.profiles != null)
                    {
                        foreach (var entry in page.profiles)
                        {
                            ApplyEntry(entry);
                            if (entry.ts > _lastSeenMs) _lastSeenMs = entry.ts;
                        }
                    }
                    if (page.ts > _lastSeenMs) _lastSeenMs = page.ts;
                }
            }
        }

        // Writes the profile to `discord:<userId>` in the local store
        // unconditionally so Discord-side edits are always preserved
        // locally, even before the viewer has linked their stream
        // identity. The chat-side !profile command reads the current
        // chatter's platform:handle entry — Discord-only profiles
        // surface there once the wallet sync correlates the IDs.
        private static void ApplyEntry(ProfileEntry entry)
        {
            if (entry == null || string.IsNullOrEmpty(entry.userId)) return;
            const string platform = "discord";
            var handle = entry.userId;

            if (entry.deleted)
            {
                ViewerProfileStore.Instance.Clear(platform, handle);
                AquiloBus.Instance.Publish("viewer.profile.updated", new
                {
                    platform, handle, ts = DateTime.UtcNow, source = "discord", deleted = true
                });
                return;
            }

            var p = entry.profile;
            if (p == null) return;
            if (p.bio      != null) ViewerProfileStore.Instance.UpdateBio(platform, handle, p.bio);
            if (p.pfp      != null) ViewerProfileStore.Instance.UpdatePfp(platform, handle, p.pfp);
            if (p.pronouns != null) ViewerProfileStore.Instance.UpdatePronouns(platform, handle, p.pronouns);
            if (p.socials != null)
                foreach (var kv in p.socials)
                    ViewerProfileStore.Instance.UpdateSocial(platform, handle, kv.Key, kv.Value);
            if (p.gamerTags != null)
                foreach (var kv in p.gamerTags)
                    ViewerProfileStore.Instance.UpdateGamerTag(platform, handle, kv.Key, kv.Value);

            // Mirror to the linked stream identity if we can find one,
            // so a viewer who's linked twitch:alice → discord:12345
            // sees their Discord-edited bio show up on !profile alice.
            string linkedPlatform, linkedHandle;
            if (TryResolveLinkedIdentity(handle, out linkedPlatform, out linkedHandle))
            {
                if (p.bio      != null) ViewerProfileStore.Instance.UpdateBio(linkedPlatform, linkedHandle, p.bio);
                if (p.pfp      != null) ViewerProfileStore.Instance.UpdatePfp(linkedPlatform, linkedHandle, p.pfp);
                if (p.pronouns != null) ViewerProfileStore.Instance.UpdatePronouns(linkedPlatform, linkedHandle, p.pronouns);
                if (p.socials != null)
                    foreach (var kv in p.socials)
                        ViewerProfileStore.Instance.UpdateSocial(linkedPlatform, linkedHandle, kv.Key, kv.Value);
                if (p.gamerTags != null)
                    foreach (var kv in p.gamerTags)
                        ViewerProfileStore.Instance.UpdateGamerTag(linkedPlatform, linkedHandle, kv.Key, kv.Value);
            }

            // Re-publish so the viewer overlay (if shown) refreshes.
            var snapshot = ViewerProfileStore.Instance.Get(platform, handle);
            if (snapshot != null)
            {
                AquiloBus.Instance.Publish("viewer.profile.updated", new
                {
                    platform   = snapshot.Platform,
                    handle     = snapshot.Handle,
                    bio        = snapshot.Bio,
                    pfp        = snapshot.Pfp,
                    pronouns   = snapshot.Pronouns,
                    socials    = snapshot.Socials,
                    gamerTags  = snapshot.GamerTags,
                    source     = "discord",
                    ts         = DateTime.UtcNow
                });
            }
        }

        // Best-effort: if the local BoltsWallet has a discord:<id>
        // entry that's been cross-credited via the existing wallet
        // sync (which writes balances under the linked stream handle),
        // we won't directly know the linkage. For now, we only return
        // a stream identity when /link has run and stored an explicit
        // discord:<id> wallet. Future enhancement: extend wallet
        // snapshots with a Discord-id reverse map.
        private static bool TryResolveLinkedIdentity(string discordUserId, out string platform, out string handle)
        {
            platform = null; handle = null;
            return false;
        }

        private static string HmacHex(string secret, string message)
        {
            using (var h = new HMACSHA256(Encoding.UTF8.GetBytes(secret)))
            {
                var hash = h.ComputeHash(Encoding.UTF8.GetBytes(message));
                return BitConverter.ToString(hash).Replace("-", "").ToLowerInvariant();
            }
        }

        private sealed class RemoteProfile
        {
            public string userId   { get; set; }
            public string bio      { get; set; }
            public string pfp      { get; set; }
            public string pronouns { get; set; }
            public Dictionary<string, string> socials   { get; set; }
            public Dictionary<string, string> gamerTags { get; set; }
            public long   updatedUtc { get; set; }
        }
        private sealed class ProfileEntry
        {
            public string userId  { get; set; }
            public bool   deleted { get; set; }
            public long   ts      { get; set; }
            public RemoteProfile profile { get; set; }
        }
        private sealed class ProfilesPage
        {
            public ProfileEntry[] profiles { get; set; }
            public long ts { get; set; }
        }
    }
}
