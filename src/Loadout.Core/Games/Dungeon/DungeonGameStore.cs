using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json;

namespace Loadout.Games.Dungeon
{
    /// <summary>
    /// JSON-persisted hero registry — one HeroState per viewer keyed by
    /// "platform:handle" lowercase. Mirrors ViewerProfileStore: lazy
    /// load, single-file save on every mutation, Clone-on-read so callers
    /// can't trample shared state.
    ///
    /// Lives in the Loadout data folder as <c>dungeon-heroes.json</c>.
    /// Bag size cap (50 items) prevents pathological growth from a long-
    /// running stream; oldest items get sold automatically when over cap.
    /// </summary>
    public sealed class DungeonGameStore
    {
        private const int BagCap = 50;

        private static DungeonGameStore _instance;
        public static DungeonGameStore Instance => _instance ?? (_instance = new DungeonGameStore());

        private readonly object _gate = new object();
        private Dictionary<string, HeroState> _heroes;
        private string _path;

        public void Initialize(string dataFolder)
        {
            _path = Path.Combine(dataFolder ?? ".", "dungeon-heroes.json");
            EnsureLoaded();
        }

        /// <summary>Returns a clone — mutations must go through helper methods below.</summary>
        public HeroState Get(string platform, string handle)
        {
            EnsureLoaded();
            var key = MakeKey(platform, handle);
            lock (_gate)
            {
                return _heroes.TryGetValue(key, out var h) ? Clone(h) : null;
            }
        }

        /// <summary>Loads or creates the hero — first dungeon run for a viewer auto-creates.</summary>
        public HeroState GetOrCreate(string platform, string handle)
        {
            EnsureLoaded();
            var key = MakeKey(platform, handle);
            lock (_gate)
            {
                if (!_heroes.TryGetValue(key, out var h))
                {
                    h = new HeroState
                    {
                        Platform = (platform ?? "twitch").ToLowerInvariant(),
                        Handle   = handle ?? "",
                        CreatedUtc = DateTime.UtcNow,
                        LastUpdatedUtc = DateTime.UtcNow
                    };
                    _heroes[key] = h;
                    Save();
                }
                return Clone(h);
            }
        }

        /// <summary>Apply a dungeon result: hp delta, xp + gold awarded,
        /// items dropped, dungeon-name tracking. Also triggers achievement
        /// checks; out param surfaces newly-unlocked achievements so the
        /// caller can broadcast them on the bus and award the bolts bonus.</summary>
        public HeroState ApplyDungeonResult(string platform, string handle,
                                            int hpDelta, int xpGained, int goldGained,
                                            IList<InventoryItem> drops, bool survived,
                                            string dungeonName,
                                            bool slewBoss,
                                            out List<string> newAchievements,
                                            out int achievementBoltsBonus)
        {
            EnsureLoaded();
            newAchievements = new List<string>();
            achievementBoltsBonus = 0;
            var key = MakeKey(platform, handle);
            lock (_gate)
            {
                if (!_heroes.TryGetValue(key, out var h))
                {
                    h = new HeroState
                    {
                        Platform = (platform ?? "twitch").ToLowerInvariant(),
                        Handle   = handle ?? "",
                        CreatedUtc = DateTime.UtcNow
                    };
                    _heroes[key] = h;
                }

                h.HpCurrent = Math.Max(0, Math.Min(h.HpMax, h.HpCurrent + hpDelta));
                if (survived) h.DungeonsSurvived++;
                else          h.DungeonsFallen++;
                if (slewBoss) h.BossesSlain++;

                if (!string.IsNullOrEmpty(dungeonName))
                {
                    if (h.DungeonsVisited == null) h.DungeonsVisited = new List<string>();
                    if (!h.DungeonsVisited.Contains(dungeonName, StringComparer.OrdinalIgnoreCase))
                        h.DungeonsVisited.Add(dungeonName);
                }

                if (xpGained > 0)
                {
                    h.Xp += xpGained;
                    while (h.Level < DungeonContent.MaxLevel &&
                           h.Xp >= DungeonContent.XpForLevel(h.Level))
                    {
                        h.Xp   -= DungeonContent.XpForLevel(h.Level);
                        h.Level++;
                        h.HpMax += 5;
                        h.HpCurrent = h.HpMax; // refill on level up
                    }
                    if (h.Level >= DungeonContent.MaxLevel) h.Xp = 0;
                }

                if (drops != null)
                {
                    foreach (var d in drops)
                    {
                        if (d == null) continue;
                        if (string.IsNullOrEmpty(d.Id)) d.Id = Guid.NewGuid().ToString("N");
                        d.FoundIn = string.IsNullOrEmpty(d.FoundIn) ? dungeonName : d.FoundIn;
                        d.FoundUtc = DateTime.UtcNow;
                        h.Bag.Add(d);
                        if (string.Equals(d.Rarity, "legendary", StringComparison.OrdinalIgnoreCase)) h.LegendariesFound++;
                        if (string.Equals(d.Rarity, "mythic",    StringComparison.OrdinalIgnoreCase)) h.MythicsFound++;
                    }
                    // Bag cap — auto-sell oldest items beyond the cap. The
                    // gold goes back to the hero so a packed bag isn't
                    // a grief surface.
                    while (h.Bag.Count > BagCap)
                    {
                        var oldest = h.Bag.OrderBy(i => i.FoundUtc).First();
                        h.Bag.Remove(oldest);
                        goldGained += Math.Max(1, oldest.GoldValue / 2);
                    }
                }

                // Achievement check — runs every dungeon apply because the
                // milestones depend on aggregate state (level, dungeons
                // survived, drops found). New unlocks bubble out so the
                // module can fire a celebratory bus event + credit the
                // achievement's BoltsReward.
                CheckAchievements(h, newAchievements, ref achievementBoltsBonus);

                h.LastUpdatedUtc = DateTime.UtcNow;
                Save();
                return Clone(h);
            }
        }

        /// <summary>Idempotent backwards-compat overload — older callsites
        /// don't pass slewBoss / newAchievements. Kept so DiscordSync push
        /// and any third-party caller that links the DLL keeps working.</summary>
        public HeroState ApplyDungeonResult(string platform, string handle,
                                            int hpDelta, int xpGained, int goldGained,
                                            IList<InventoryItem> drops, bool survived,
                                            string dungeonName)
            => ApplyDungeonResult(platform, handle, hpDelta, xpGained, goldGained,
                                  drops, survived, dungeonName, false, out _, out _);

        private static void CheckAchievements(HeroState h, List<string> newOnes, ref int boltsBonus)
        {
            if (h.Achievements == null) h.Achievements = new List<string>();
            // Use a list-of-tuples to evaluate conditions without a local
            // function closure (closures can't capture ref params in C#).
            var checks = new (string id, bool ok)[]
            {
                ("first-blood",    h.DungeonsSurvived >= 1),
                ("veteran",        h.DungeonsSurvived >= 10),
                ("dungeoneer",     h.DungeonsSurvived >= 50),
                ("duelist",        h.DuelsWon         >= 10),
                ("champion",       h.DuelsWon         >= 50),
                ("legendkiller",   h.BossesSlain      >= 1),
                ("lootmaster",     h.LegendariesFound >= 1),
                ("myth-touched",   h.MythicsFound     >= 1),
                ("ascended",       h.Level            >= 25),
                ("legendary-rank", h.Level            >= DungeonContent.MaxLevel),
                ("explorer",       (h.DungeonsVisited?.Count ?? 0) >= DungeonContent.DungeonTypes.Length)
            };
            foreach (var c in checks)
            {
                if (!c.ok) continue;
                if (h.Achievements.Contains(c.id, StringComparer.OrdinalIgnoreCase)) continue;
                h.Achievements.Add(c.id);
                newOnes.Add(c.id);
                var def = Array.Find(DungeonContent.Achievements, a => a.Id == c.id);
                if (def != null) boltsBonus += def.BoltsReward;
            }
        }

        public HeroState SetHp(string platform, string handle, int hpCurrent)
        {
            return Mutate(platform, handle, h =>
            {
                h.HpCurrent = Math.Max(0, Math.Min(h.HpMax, hpCurrent));
            });
        }

        /// <summary>Save the viewer's character avatar URL. Empty clears it.</summary>
        public HeroState SetAvatar(string platform, string handle, string url)
        {
            return Mutate(platform, handle, h => { h.Avatar = (url ?? "").Trim(); });
        }

        /// <summary>Switch class and re-base HpMax/HpCurrent so the HP bonus
        /// (DungeonContent.ClassByName(c).HpBonus) lands correctly even when
        /// switching mid-progression. Old class's HP bonus is removed first.</summary>
        public HeroState SetClass(string platform, string handle, string className)
        {
            return Mutate(platform, handle, h =>
            {
                var oldBonus = DungeonContent.ClassByName(h.ClassName)?.HpBonus ?? 0;
                var newClass = DungeonContent.ClassByName(className);
                var newBonus = newClass?.HpBonus ?? 0;
                int delta = newBonus - oldBonus;
                h.HpMax = Math.Max(1, h.HpMax + delta);
                h.HpCurrent = Math.Max(0, Math.Min(h.HpMax, h.HpCurrent + delta));
                h.ClassName = newClass?.Name ?? "";
            });
        }

        public HeroState RecordDuel(string platform, string handle, bool won)
        {
            return Mutate(platform, handle, h =>
            {
                if (won) h.DuelsWon++; else h.DuelsLost++;
                // Achievement re-check so the duelist / champion unlocks
                // fire on the duel that crosses the threshold, not on the
                // next dungeon run. Bonus is silently absorbed here — the
                // /loadout menu reads h.Achievements next time the viewer
                // looks. (Bolts payout for those is small enough that
                // not surfacing it inline is fine; achievements unlocked
                // mid-dungeon DO get surfaced via ApplyDungeonResult.)
                var ignored = new List<string>();
                int bonus = 0;
                CheckAchievements(h, ignored, ref bonus);
            });
        }

        /// <summary>Save / merge a per-key character customization value.
        /// Value of "" or null clears the key. Unknown keys are accepted
        /// (HeroState.Custom is a free-form dict, see the field comment).</summary>
        public HeroState SetCustom(string platform, string handle, string key, string value)
        {
            return Mutate(platform, handle, h =>
            {
                if (h.Custom == null) h.Custom = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                if (string.IsNullOrEmpty(key)) return;
                if (string.IsNullOrEmpty(value)) h.Custom.Remove(key);
                else                              h.Custom[key] = value;
            });
        }

        /// <summary>Equip an item from the bag into its slot. Returns the updated hero.</summary>
        public HeroState Equip(string platform, string handle, string itemId)
        {
            return Mutate(platform, handle, h =>
            {
                var item = h.Bag.FirstOrDefault(i => string.Equals(i.Id, itemId, StringComparison.OrdinalIgnoreCase));
                if (item == null) return;
                if (string.IsNullOrEmpty(item.Slot)) return;
                h.Equipped[item.Slot] = item.Id;
            });
        }

        public HeroState Unequip(string platform, string handle, string slot)
        {
            return Mutate(platform, handle, h => { h.Equipped.Remove(slot ?? ""); });
        }

        /// <summary>Sell an item from the bag back to the shop for half its GoldValue.</summary>
        public HeroState Sell(string platform, string handle, string itemId, out int goldRefunded)
        {
            int refund = 0;
            var hero = Mutate(platform, handle, h =>
            {
                var item = h.Bag.FirstOrDefault(i => string.Equals(i.Id, itemId, StringComparison.OrdinalIgnoreCase));
                if (item == null) return;
                refund = Math.Max(1, item.GoldValue / 2);
                h.Bag.Remove(item);
                // If currently equipped, unequip so the slot map stays consistent.
                foreach (var kv in h.Equipped.ToList())
                {
                    if (string.Equals(kv.Value, itemId, StringComparison.OrdinalIgnoreCase))
                        h.Equipped.Remove(kv.Key);
                }
            });
            goldRefunded = refund;
            return hero;
        }

        /// <summary>Grant a single item straight into a viewer's bag —
        /// used by reward paths outside a dungeon run (hype-train loot,
        /// future quest rewards). Auto-creates the hero if the viewer
        /// has never run a dungeon. Enforces the bag cap by auto-selling
        /// the oldest item (gold returned to the hero) so a reward
        /// never silently vanishes against a full bag. Bumps the
        /// legendary / mythic counters so achievements still track.</summary>
        public HeroState GrantLoot(string platform, string handle, InventoryItem item)
        {
            if (item == null) return null;
            return Mutate(platform, handle, h =>
            {
                if (string.IsNullOrEmpty(item.Id)) item.Id = Guid.NewGuid().ToString("N");
                item.FoundUtc = DateTime.UtcNow;
                if (string.IsNullOrEmpty(item.FoundIn)) item.FoundIn = "Hype Train";
                h.Bag.Add(item);
                if (string.Equals(item.Rarity, "legendary", StringComparison.OrdinalIgnoreCase)) h.LegendariesFound++;
                if (string.Equals(item.Rarity, "mythic",    StringComparison.OrdinalIgnoreCase)) h.MythicsFound++;
                while (h.Bag.Count > BagCap)
                {
                    var oldest = h.Bag.OrderBy(i => i.FoundUtc).First();
                    h.Bag.Remove(oldest);
                }
            });
        }

        public IReadOnlyList<KeyValuePair<string, HeroState>> RecentlyActive(int max = 50)
        {
            EnsureLoaded();
            lock (_gate)
            {
                return _heroes
                    .OrderByDescending(kv => kv.Value.LastUpdatedUtc)
                    .Take(Math.Max(1, max))
                    .Select(kv => new KeyValuePair<string, HeroState>(kv.Key, Clone(kv.Value)))
                    .ToList();
            }
        }

        // -------------------- internals --------------------

        private static string MakeKey(string platform, string handle) =>
            ((platform ?? "twitch") + ":" + (handle ?? "")).ToLowerInvariant();

        private void EnsureLoaded()
        {
            if (_heroes != null) return;
            lock (_gate)
            {
                if (_heroes != null) return;
                _heroes = new Dictionary<string, HeroState>(StringComparer.OrdinalIgnoreCase);
                if (!string.IsNullOrEmpty(_path) && File.Exists(_path))
                {
                    try
                    {
                        var json = File.ReadAllText(_path);
                        var loaded = JsonConvert.DeserializeObject<Dictionary<string, HeroState>>(json);
                        if (loaded != null)
                            foreach (var kv in loaded) _heroes[kv.Key] = kv.Value;
                    }
                    catch (Exception ex)
                    {
                        Util.ErrorLog.Write("DungeonGameStore.Load", ex);
                    }
                }
            }
        }

        private void Save()
        {
            if (string.IsNullOrEmpty(_path)) return;
            try
            {
                var json = JsonConvert.SerializeObject(_heroes, Formatting.Indented);
                File.WriteAllText(_path, json);
            }
            catch (Exception ex)
            {
                Util.ErrorLog.Write("DungeonGameStore.Save", ex);
            }
        }

        private HeroState Mutate(string platform, string handle, Action<HeroState> mut)
        {
            EnsureLoaded();
            var key = MakeKey(platform, handle);
            lock (_gate)
            {
                if (!_heroes.TryGetValue(key, out var h))
                {
                    h = new HeroState
                    {
                        Platform = (platform ?? "twitch").ToLowerInvariant(),
                        Handle   = handle ?? "",
                        CreatedUtc = DateTime.UtcNow
                    };
                    _heroes[key] = h;
                }
                mut(h);
                h.LastUpdatedUtc = DateTime.UtcNow;
                Save();
                return Clone(h);
            }
        }

        private static HeroState Clone(HeroState h)
        {
            // Cheap deep-clone via JSON round-trip — heroes are tiny (a
            // hundred bytes including a normal-sized bag) and this keeps
            // the surface free of nested-collection sharing bugs.
            var json = JsonConvert.SerializeObject(h);
            return JsonConvert.DeserializeObject<HeroState>(json);
        }
    }
}
