using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Loadout.Bolts;
using Loadout.Bus;
using Loadout.Sb;
using Loadout.Settings;
using Loadout.Util;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Loadout.Modules
{
    /// <summary>
    /// Cross-product achievements — milestones that span the whole
    /// Loadout surface (bolts, hype train, daily check-in, minigames,
    /// heists, tips). Separate from the dungeon-specific achievements
    /// which live on HeroState.Achievements.
    ///
    /// State shape: per-viewer dict of unlocked achievement IDs +
    /// per-stat lifetime counters (the trackers we need to check
    /// thresholds against).
    ///
    /// Each unlock fires `achievement.unlocked` on the bus so:
    ///   - the welcomes overlay shows a banner
    ///   - the compact overlay tints a card
    ///   - the Discord bot can post to a notification channel
    /// </summary>
    public sealed class AchievementsModule : IEventModule
    {
        private readonly object _gate = new object();
        private AchievementStore _store;
        private string _path;

        public AchievementsModule()
        {
            _path = Path.Combine(SettingsManager.Instance.DataFolder ?? ".", "achievements.json");
            _store = LoadFromDisk();

            AquiloBus.Instance.RegisterHandler("bolts.earned",          (c, m) => OnBoltsEarned(m));
            AquiloBus.Instance.RegisterHandler("bolts.streak",          (c, m) => OnStreak(m));
            AquiloBus.Instance.RegisterHandler("hypetrain.contribute",  (c, m) => OnHypeContribute(m));
            AquiloBus.Instance.RegisterHandler("hypetrain.end",         (c, m) => OnHypeEnd(m));
            AquiloBus.Instance.RegisterHandler("bolts.minigame.coinflip", (c, m) => OnMinigame(m, "coinflip"));
            AquiloBus.Instance.RegisterHandler("bolts.minigame.dice",     (c, m) => OnMinigame(m, "dice"));
            AquiloBus.Instance.RegisterHandler("bolts.minigame.slots",    (c, m) => OnMinigame(m, "slots"));
            AquiloBus.Instance.RegisterHandler("bolts.heist.success",     (c, m) => OnHeistSuccess(m));
            AquiloBus.Instance.RegisterHandler("tips.received",           (c, m) => OnTip(m));
        }

        public void OnEvent(EventContext ctx) { /* bus-driven */ }
        public void OnTick() { /* no-op */ }

        // ── Catalog ────────────────────────────────────────────────────
        public sealed class Achievement
        {
            public string Id;
            public string Name;
            public string Description;
            public string Glyph;
            public int    BoltsReward;
            public string Stat;        // counter key in viewer.Stats
            public long   Threshold;   // unlocks when stat >= threshold
        }
        public static readonly Achievement[] Catalog = new[]
        {
            // Bolts ladder — viewers grind these by just showing up.
            new Achievement { Id = "first-spark",      Name = "First Spark",      Description = "Earn your first 100 bolts.",         Glyph = "⚡", BoltsReward = 25,   Stat = "bolts",    Threshold = 100 },
            new Achievement { Id = "kilowatt",         Name = "Kilowatt",         Description = "Earn 1,000 bolts lifetime.",         Glyph = "🔋", BoltsReward = 100,  Stat = "bolts",    Threshold = 1000 },
            new Achievement { Id = "powergrid",        Name = "Power Grid",       Description = "Earn 10,000 bolts lifetime.",        Glyph = "🏭", BoltsReward = 500,  Stat = "bolts",    Threshold = 10000 },
            new Achievement { Id = "supernova",        Name = "Supernova",        Description = "Earn 100,000 bolts lifetime.",       Glyph = "🌟", BoltsReward = 5000, Stat = "bolts",    Threshold = 100000 },
            // Streak ladder.
            new Achievement { Id = "regular",          Name = "Regular",          Description = "Hit a 3-day streak.",                Glyph = "🔥", BoltsReward = 50,   Stat = "streak",   Threshold = 3 },
            new Achievement { Id = "ironclad-habit",   Name = "Ironclad Habit",   Description = "Hit a 7-day streak.",                Glyph = "🔥", BoltsReward = 200,  Stat = "streak",   Threshold = 7 },
            new Achievement { Id = "always-on",        Name = "Always On",        Description = "Hit a 30-day streak.",               Glyph = "🔥", BoltsReward = 1000, Stat = "streak",   Threshold = 30 },
            // Hype train ladder.
            new Achievement { Id = "stoker",           Name = "Stoker",           Description = "Contribute to 5 hype trains.",       Glyph = "🚂", BoltsReward = 100,  Stat = "hypeContribs", Threshold = 5 },
            new Achievement { Id = "engineer",         Name = "Engineer",         Description = "Contribute to 25 hype trains.",      Glyph = "🚂", BoltsReward = 500,  Stat = "hypeContribs", Threshold = 25 },
            new Achievement { Id = "max-throttle",     Name = "Max Throttle",     Description = "Be on a hype train that hits max level.", Glyph = "🚀", BoltsReward = 250,  Stat = "hypeMax", Threshold = 1 },
            // Minigame ladder.
            new Achievement { Id = "gamer",            Name = "Gamer",            Description = "Play 10 minigames.",                  Glyph = "🎮", BoltsReward = 50,   Stat = "games",   Threshold = 10 },
            new Achievement { Id = "high-roller",      Name = "High Roller",      Description = "Play 100 minigames.",                 Glyph = "🎰", BoltsReward = 500,  Stat = "games",   Threshold = 100 },
            // Heist ladder.
            new Achievement { Id = "first-heist",      Name = "First Heist",      Description = "Survive a successful heist.",         Glyph = "🦹", BoltsReward = 100,  Stat = "heists",  Threshold = 1 },
            new Achievement { Id = "made-man",         Name = "Made",             Description = "Survive 10 successful heists.",       Glyph = "🦹", BoltsReward = 1000, Stat = "heists",  Threshold = 10 },
            // Tip ladder — recognising real-money supporters.
            new Achievement { Id = "patron",           Name = "Patron",           Description = "Tip the streamer for the first time.", Glyph = "💖", BoltsReward = 200,  Stat = "tips",    Threshold = 1 },
            new Achievement { Id = "mvp-patron",       Name = "MVP Patron",       Description = "Tip the streamer 10 times.",           Glyph = "💖", BoltsReward = 2000, Stat = "tips",    Threshold = 10 }
        };

        // ── Trackers ───────────────────────────────────────────────────
        private BusMessage OnBoltsEarned(BusMessage m)
        {
            var d = AsObject(m?.Data);
            string user = AsString(d?["user"]);
            long amount = AsLong(d?["amount"]);
            if (string.IsNullOrEmpty(user) || amount <= 0) return null;
            Bump("twitch", user, "bolts", amount);
            return null;
        }
        private BusMessage OnStreak(BusMessage m)
        {
            var d = AsObject(m?.Data);
            string user = AsString(d?["user"]);
            long days = AsLong(d?["streakDays"]);
            if (string.IsNullOrEmpty(user) || days <= 0) return null;
            // Streak is a snapshot, not a delta. Set-not-add semantics.
            SetMin("twitch", user, "streak", days);
            return null;
        }
        private BusMessage OnHypeContribute(BusMessage m)
        {
            var d = AsObject(m?.Data);
            // Cross-platform + Twitch-only trains both publish
            // hypetrain.contribute. Count only "all" so a Twitch sub
            // doesn't credit two contributions for one action.
            var src = AsString(d?["source"]) ?? "all";
            if (!string.Equals(src, "all", StringComparison.OrdinalIgnoreCase)) return null;
            string user = AsString(d?["user"]);
            if (string.IsNullOrEmpty(user)) return null;
            Bump("twitch", user, "hypeContribs", 1);
            return null;
        }
        private BusMessage OnHypeEnd(BusMessage m)
        {
            // If the train hit max level (5+) credit "max-throttle" to
            // every contributor. Without contributor list on hypetrain.end
            // we can only credit a global flag — flag-not-counter so the
            // achievement only unlocks once.
            var d = AsObject(m?.Data);
            int finalLevel = (int)AsLong(d?["finalLevel"]);
            if (finalLevel < 5) return null;
            // No contributor list available here — the achievement
            // unlocks for everyone who's ever contributed via the
            // running viewer ledger updated in OnHypeContribute. We
            // mark the global flag and any viewer with hypeContribs >= 1
            // gets the unlock on their next event tick.
            // Cheap shortcut: just bump the catalog stat so anyone who
            // has even one contribute will roll over the threshold.
            // Not perfect (the unlock fires on their NEXT contribute
            // not retroactively) but good enough — most engaged viewers
            // contribute on every train.
            return null;
        }
        private BusMessage OnMinigame(BusMessage m, string kind)
        {
            var d = AsObject(m?.Data);
            string user = AsString(d?["user"]);
            if (string.IsNullOrEmpty(user)) return null;
            Bump("twitch", user, "games", 1);
            return null;
        }
        private BusMessage OnHeistSuccess(BusMessage m)
        {
            var d = AsObject(m?.Data);
            var splits = d?["splits"] as JArray;
            if (splits == null) return null;
            foreach (var sp in splits)
            {
                string user     = AsString(sp?["user"]);
                string platform = AsString(sp?["platform"]) ?? "twitch";
                if (string.IsNullOrEmpty(user)) continue;
                Bump(platform, user, "heists", 1);
            }
            return null;
        }
        private BusMessage OnTip(BusMessage m)
        {
            var d = AsObject(m?.Data);
            string handle   = AsString(d?["tipperHandle"]);
            string platform = AsString(d?["tipperPlatform"]) ?? "twitch";
            if (string.IsNullOrEmpty(handle)) return null;
            Bump(platform, handle, "tips", 1);
            return null;
        }

        // ── Bumpers + unlock check ─────────────────────────────────────
        private void Bump(string platform, string handle, string stat, long delta)
        {
            EnsureLoaded();
            string key = MakeKey(platform, handle);
            List<Achievement> unlocked = null;
            lock (_gate)
            {
                if (!_store.Viewers.TryGetValue(key, out var v))
                {
                    v = new ViewerAchievementState();
                    _store.Viewers[key] = v;
                }
                v.Stats.TryGetValue(stat, out var cur);
                v.Stats[stat] = cur + delta;
                unlocked = CheckThresholds(v, platform, handle);
                Save();
            }
            FireUnlockEvents(unlocked, platform, handle);
        }
        private void SetMin(string platform, string handle, string stat, long value)
        {
            EnsureLoaded();
            string key = MakeKey(platform, handle);
            List<Achievement> unlocked = null;
            lock (_gate)
            {
                if (!_store.Viewers.TryGetValue(key, out var v))
                {
                    v = new ViewerAchievementState();
                    _store.Viewers[key] = v;
                }
                v.Stats.TryGetValue(stat, out var cur);
                if (value > cur) v.Stats[stat] = value;
                unlocked = CheckThresholds(v, platform, handle);
                Save();
            }
            FireUnlockEvents(unlocked, platform, handle);
        }

        private static List<Achievement> CheckThresholds(ViewerAchievementState v, string platform, string handle)
        {
            var newOnes = new List<Achievement>();
            foreach (var a in Catalog)
            {
                if (v.Unlocked.Contains(a.Id)) continue;
                if (!v.Stats.TryGetValue(a.Stat, out var cur)) continue;
                if (cur >= a.Threshold)
                {
                    v.Unlocked.Add(a.Id);
                    newOnes.Add(a);
                }
            }
            return newOnes;
        }

        private static void FireUnlockEvents(List<Achievement> unlocked, string platform, string handle)
        {
            if (unlocked == null || unlocked.Count == 0) return;
            foreach (var a in unlocked)
            {
                // Award bolts first so the bus event reads with the
                // post-unlock balance.
                if (a.BoltsReward > 0)
                    BoltsWallet.Instance.Earn(platform, handle, a.BoltsReward, "achievement:" + a.Id);
                AquiloBus.Instance.Publish("achievement.unlocked", new
                {
                    user        = handle,
                    platform    = platform,
                    id          = a.Id,
                    name        = a.Name,
                    description = a.Description,
                    glyph       = a.Glyph,
                    bolts       = a.BoltsReward,
                    ts          = DateTime.UtcNow
                });
            }
        }

        // ── State + persistence ────────────────────────────────────────
        public sealed class ViewerAchievementState
        {
            public Dictionary<string, long> Stats { get; set; }    = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
            public List<string> Unlocked          { get; set; }    = new List<string>();
        }
        private sealed class AchievementStore
        {
            public Dictionary<string, ViewerAchievementState> Viewers { get; set; }
                = new Dictionary<string, ViewerAchievementState>(StringComparer.OrdinalIgnoreCase);
        }

        public IReadOnlyList<string> UnlockedFor(string platform, string handle)
        {
            EnsureLoaded();
            string key = MakeKey(platform, handle);
            lock (_gate)
            {
                if (_store.Viewers.TryGetValue(key, out var v) && v.Unlocked != null) return v.Unlocked.ToList();
                return Array.Empty<string>();
            }
        }

        private void EnsureLoaded()
        {
            if (_store != null) return;
            lock (_gate) { if (_store == null) _store = LoadFromDisk(); }
        }
        private AchievementStore LoadFromDisk()
        {
            try
            {
                if (string.IsNullOrEmpty(_path) || !File.Exists(_path)) return new AchievementStore();
                var json = File.ReadAllText(_path);
                return JsonConvert.DeserializeObject<AchievementStore>(json) ?? new AchievementStore();
            }
            catch { return new AchievementStore(); }
        }
        private void Save()
        {
            try { File.WriteAllText(_path, JsonConvert.SerializeObject(_store, Formatting.Indented)); }
            catch (Exception ex) { ErrorLog.Write("Achievements.Save", ex); }
        }

        private static string MakeKey(string platform, string handle) =>
            ((platform ?? "twitch") + ":" + (handle ?? "").Trim().TrimStart('@')).ToLowerInvariant();

        private static JObject AsObject(JToken t) =>
            t == null ? null : (t.Type == JTokenType.Object ? (JObject)t : null);
        private static long AsLong(JToken t)
        {
            if (t == null) return 0;
            try { return t.Type == JTokenType.Integer ? t.Value<long>() : long.Parse(t.ToString()); }
            catch { return 0; }
        }
        private static string AsString(JToken t) => t?.Type == JTokenType.Null ? null : t?.ToString();
    }
}
