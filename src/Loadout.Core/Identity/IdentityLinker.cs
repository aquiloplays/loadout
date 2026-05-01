using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Loadout.Settings;
using Newtonsoft.Json;

namespace Loadout.Identity
{
    /// <summary>
    /// Persisted store of cross-platform identity links. By design separate wallets
    /// per platform; users opt in via <c>!link &lt;platform&gt; &lt;username&gt;</c>
    /// (mod-approved to prevent abuse).
    ///
    /// Each link has a "primary" identity (the requesting user's current platform
    /// account) and one or more linked aliases. Wallet aggregation walks the link
    /// graph to find the canonical primary.
    /// </summary>
    public sealed class IdentityLinker
    {
        private static IdentityLinker _instance;
        public static IdentityLinker Instance => _instance ?? (_instance = new IdentityLinker());

        private readonly object _gate = new object();
        private string _path;
        private LinkStore _store;

        private IdentityLinker() { }

        public void Initialize(string dataFolder)
        {
            lock (_gate)
            {
                Directory.CreateDirectory(dataFolder);
                _path = Path.Combine(dataFolder, "identity.json");
                _store = LoadFromDisk();
            }
        }

        /// <summary>
        /// Request a link. Returns a <see cref="LinkRequest"/> the broadcaster/mods
        /// approve via the SettingsWindow or a chat command. Until approved, no
        /// wallet aggregation happens.
        /// </summary>
        public LinkRequest RequestLink(PlatformMask srcPlatform, string srcUser,
                                       PlatformMask dstPlatform, string dstUser)
        {
            lock (_gate)
            {
                EnsureLoaded();
                var req = new LinkRequest
                {
                    Id = Guid.NewGuid().ToString("N"),
                    CreatedUtc = DateTime.UtcNow,
                    SourcePlatform = srcPlatform,
                    SourceUser = (srcUser ?? "").Trim().ToLowerInvariant(),
                    TargetPlatform = dstPlatform,
                    TargetUser = (dstUser ?? "").Trim().ToLowerInvariant(),
                    Status = LinkStatus.Pending
                };
                _store.Requests.Add(req);
                Save();
                return req;
            }
        }

        public bool Approve(string requestId, string approvedBy)
        {
            lock (_gate)
            {
                EnsureLoaded();
                var req = _store.Requests.FirstOrDefault(r => r.Id == requestId);
                if (req == null || req.Status != LinkStatus.Pending) return false;
                req.Status = LinkStatus.Approved;
                req.ApprovedBy = approvedBy;
                req.ResolvedUtc = DateTime.UtcNow;
                _store.Links.Add(new IdentityLink
                {
                    A = new IdentityKey(req.SourcePlatform, req.SourceUser),
                    B = new IdentityKey(req.TargetPlatform, req.TargetUser),
                    LinkedUtc = DateTime.UtcNow
                });
                Save();
                return true;
            }
        }

        public bool Deny(string requestId, string deniedBy)
        {
            lock (_gate)
            {
                EnsureLoaded();
                var req = _store.Requests.FirstOrDefault(r => r.Id == requestId);
                if (req == null || req.Status != LinkStatus.Pending) return false;
                req.Status = LinkStatus.Denied;
                req.ApprovedBy = deniedBy;
                req.ResolvedUtc = DateTime.UtcNow;
                Save();
                return true;
            }
        }

        public IReadOnlyList<LinkRequest> PendingRequests()
        {
            lock (_gate)
            {
                EnsureLoaded();
                return _store.Requests.Where(r => r.Status == LinkStatus.Pending).ToList();
            }
        }

        /// <summary>
        /// Returns the canonical primary identity for a given platform user.
        /// Uses union-find over approved links.
        /// </summary>
        public IdentityKey GetPrimary(PlatformMask platform, string user)
        {
            var key = new IdentityKey(platform, (user ?? "").Trim().ToLowerInvariant());
            lock (_gate)
            {
                EnsureLoaded();
                // Walk the link graph BFS. Lexicographically smallest key wins as primary —
                // simple deterministic rule, swap to "first-linked" if you prefer.
                var visited = new HashSet<IdentityKey> { key };
                var frontier = new Queue<IdentityKey>();
                frontier.Enqueue(key);
                while (frontier.Count > 0)
                {
                    var cur = frontier.Dequeue();
                    foreach (var link in _store.Links)
                    {
                        if (link.A.Equals(cur) && visited.Add(link.B)) frontier.Enqueue(link.B);
                        else if (link.B.Equals(cur) && visited.Add(link.A)) frontier.Enqueue(link.A);
                    }
                }
                return visited.OrderBy(k => k.ToString(), StringComparer.Ordinal).First();
            }
        }

        private void EnsureLoaded()
        {
            if (_store == null) _store = LoadFromDisk();
        }

        private LinkStore LoadFromDisk()
        {
            try
            {
                if (string.IsNullOrEmpty(_path) || !File.Exists(_path)) return new LinkStore();
                var json = File.ReadAllText(_path);
                return JsonConvert.DeserializeObject<LinkStore>(json) ?? new LinkStore();
            }
            catch { return new LinkStore(); }
        }

        private void Save()
        {
            if (string.IsNullOrEmpty(_path)) return;
            try
            {
                File.WriteAllText(_path, JsonConvert.SerializeObject(_store, Formatting.Indented));
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine("[Loadout] Identity save failed: " + ex.Message);
            }
        }
    }

    public class LinkStore
    {
        public List<IdentityLink> Links { get; set; } = new List<IdentityLink>();
        public List<LinkRequest>  Requests { get; set; } = new List<LinkRequest>();
    }

    public class IdentityLink
    {
        public IdentityKey A { get; set; }
        public IdentityKey B { get; set; }
        public DateTime    LinkedUtc { get; set; }
    }

    public struct IdentityKey : IEquatable<IdentityKey>
    {
        public PlatformMask Platform { get; set; }
        public string       User     { get; set; }

        public IdentityKey(PlatformMask platform, string user)
        {
            Platform = platform;
            User = user;
        }

        public bool Equals(IdentityKey other) =>
            Platform == other.Platform &&
            string.Equals(User, other.User, StringComparison.OrdinalIgnoreCase);

        public override bool Equals(object obj) => obj is IdentityKey k && Equals(k);
        public override int GetHashCode() =>
            ((int)Platform * 397) ^ (User != null ? StringComparer.OrdinalIgnoreCase.GetHashCode(User) : 0);
        public override string ToString() => Platform.ToShortName() + ":" + (User ?? "");
    }

    public enum LinkStatus { Pending, Approved, Denied }

    public class LinkRequest
    {
        public string       Id              { get; set; }
        public DateTime     CreatedUtc      { get; set; }
        public DateTime     ResolvedUtc     { get; set; }
        public PlatformMask SourcePlatform  { get; set; }
        public string       SourceUser      { get; set; }
        public PlatformMask TargetPlatform  { get; set; }
        public string       TargetUser      { get; set; }
        public LinkStatus   Status          { get; set; }
        public string       ApprovedBy      { get; set; }
    }
}
