using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json;

namespace Loadout.ViewerProfile
{
    /// <summary>
    /// Per-viewer self-served profile data. Backed by a single JSON file
    /// (viewer-profiles.json in the Loadout data folder) keyed by
    /// "platform:handle" lowercase. Mirrors the BoltsWallet shape so a
    /// viewer's bolts balance + their profile sit side-by-side without
    /// cross-product joins.
    ///
    /// Why a separate store instead of folding into BoltsWallet: the
    /// Bolts wallet is hot-path (read on every chat message) and we
    /// don't want a long bio + 20 social handles loaded for every
    /// chatter. Profiles are read on demand (!profile, viewer overlay
    /// trigger, Discord sync).
    /// </summary>
    public sealed class ViewerProfileStore
    {
        private static ViewerProfileStore _instance;
        public static ViewerProfileStore Instance => _instance ?? (_instance = new ViewerProfileStore());

        private readonly object _gate = new object();
        private Dictionary<string, ViewerProfile> _profiles;
        private string _path;

        public void Initialize(string dataFolder)
        {
            _path = Path.Combine(dataFolder ?? ".", "viewer-profiles.json");
            EnsureLoaded();
        }

        public ViewerProfile Get(string platform, string handle)
        {
            EnsureLoaded();
            var key = MakeKey(platform, handle);
            lock (_gate)
            {
                return _profiles.TryGetValue(key, out var p) ? Clone(p) : null;
            }
        }

        public ViewerProfile UpdateBio(string platform, string handle, string bio)        => Mutate(platform, handle, p => p.Bio = (bio ?? "").Trim());
        public ViewerProfile UpdatePfp(string platform, string handle, string url)        => Mutate(platform, handle, p => p.Pfp = (url ?? "").Trim());
        public ViewerProfile UpdatePronouns(string platform, string handle, string txt)   => Mutate(platform, handle, p => p.Pronouns = (txt ?? "").Trim());
        public ViewerProfile UpdateSocial(string platform, string handle, string socialPlatform, string socialHandle)
            => Mutate(platform, handle, p =>
            {
                if (p.Socials == null) p.Socials = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                var k = (socialPlatform ?? "").Trim().ToLowerInvariant();
                var v = (socialHandle ?? "").Trim();
                if (string.IsNullOrEmpty(k)) return;
                if (string.IsNullOrEmpty(v)) p.Socials.Remove(k);
                else                          p.Socials[k] = v;
            });
        public ViewerProfile UpdateGamerTag(string platform, string handle, string gamePlatform, string tag)
            => Mutate(platform, handle, p =>
            {
                if (p.GamerTags == null) p.GamerTags = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                var k = (gamePlatform ?? "").Trim().ToLowerInvariant();
                var v = (tag ?? "").Trim();
                if (string.IsNullOrEmpty(k)) return;
                if (string.IsNullOrEmpty(v)) p.GamerTags.Remove(k);
                else                          p.GamerTags[k] = v;
            });

        public bool Clear(string platform, string handle)
        {
            EnsureLoaded();
            var key = MakeKey(platform, handle);
            lock (_gate)
            {
                if (!_profiles.Remove(key)) return false;
                Save();
                return true;
            }
        }

        public IReadOnlyList<KeyValuePair<string, ViewerProfile>> RecentlyUpdated(int max = 50)
        {
            EnsureLoaded();
            lock (_gate)
            {
                return _profiles
                    .OrderByDescending(kv => kv.Value.LastUpdatedUtc)
                    .Take(Math.Max(1, max))
                    .Select(kv => new KeyValuePair<string, ViewerProfile>(kv.Key, Clone(kv.Value)))
                    .ToList();
            }
        }

        // -------------------- internals --------------------

        private static string MakeKey(string platform, string handle) =>
            ((platform ?? "twitch") + ":" + (handle ?? "")).ToLowerInvariant();

        private ViewerProfile Mutate(string platform, string handle, Action<ViewerProfile> mut)
        {
            EnsureLoaded();
            var key = MakeKey(platform, handle);
            ViewerProfile snapshot;
            lock (_gate)
            {
                if (!_profiles.TryGetValue(key, out var existing))
                {
                    existing = new ViewerProfile { Platform = platform, Handle = handle };
                    _profiles[key] = existing;
                }
                mut(existing);
                existing.LastUpdatedUtc = DateTime.UtcNow;
                snapshot = Clone(existing);
                Save();
            }
            return snapshot;
        }

        private void EnsureLoaded()
        {
            if (_profiles != null) return;
            lock (_gate)
            {
                if (_profiles != null) return;
                _profiles = new Dictionary<string, ViewerProfile>(StringComparer.OrdinalIgnoreCase);
                if (!string.IsNullOrEmpty(_path) && File.Exists(_path))
                {
                    try
                    {
                        var text = File.ReadAllText(_path);
                        var loaded = JsonConvert.DeserializeObject<Dictionary<string, ViewerProfile>>(text);
                        if (loaded != null)
                        {
                            foreach (var kv in loaded)
                            {
                                if (string.IsNullOrEmpty(kv.Key) || kv.Value == null) continue;
                                _profiles[kv.Key.ToLowerInvariant()] = kv.Value;
                            }
                        }
                    }
                    catch (Exception ex)
                    {
                        System.Diagnostics.Debug.WriteLine("[Loadout] ViewerProfileStore.Load failed: " + ex.Message);
                    }
                }
            }
        }

        private void Save()
        {
            if (string.IsNullOrEmpty(_path)) return;
            try
            {
                var dir = Path.GetDirectoryName(_path);
                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
                var text = JsonConvert.SerializeObject(_profiles, Formatting.Indented);
                File.WriteAllText(_path, text);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine("[Loadout] ViewerProfileStore.Save failed: " + ex.Message);
            }
        }

        private static ViewerProfile Clone(ViewerProfile src)
        {
            if (src == null) return null;
            return new ViewerProfile
            {
                Platform       = src.Platform,
                Handle         = src.Handle,
                Bio            = src.Bio,
                Pfp            = src.Pfp,
                Pronouns       = src.Pronouns,
                Socials        = src.Socials   == null ? null : new Dictionary<string, string>(src.Socials,   StringComparer.OrdinalIgnoreCase),
                GamerTags      = src.GamerTags == null ? null : new Dictionary<string, string>(src.GamerTags, StringComparer.OrdinalIgnoreCase),
                LastUpdatedUtc = src.LastUpdatedUtc
            };
        }
    }

    public class ViewerProfile
    {
        public string Platform { get; set; }   // twitch | youtube | kick | tiktok | discord
        public string Handle   { get; set; }
        public string Bio      { get; set; } = "";
        public string Pfp      { get; set; } = "";   // image URL
        public string Pronouns { get; set; } = "";   // "she/her", "they/them", etc.
        public Dictionary<string, string> Socials   { get; set; } = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        public Dictionary<string, string> GamerTags { get; set; } = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        public DateTime LastUpdatedUtc { get; set; } = DateTime.UtcNow;
    }
}
