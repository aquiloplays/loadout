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

        /// <summary>Apply a dungeon result: hp delta, xp + gold awarded, items dropped.</summary>
        public HeroState ApplyDungeonResult(string platform, string handle,
                                            int hpDelta, int xpGained, int goldGained,
                                            IList<InventoryItem> drops, bool survived,
                                            string dungeonName)
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

                h.HpCurrent = Math.Max(0, Math.Min(h.HpMax, h.HpCurrent + hpDelta));
                if (survived) h.DungeonsSurvived++;
                else          h.DungeonsFallen++;

                if (xpGained > 0)
                {
                    h.Xp += xpGained;
                    while (h.Xp >= DungeonContent.XpForLevel(h.Level))
                    {
                        h.Xp   -= DungeonContent.XpForLevel(h.Level);
                        h.Level++;
                        h.HpMax += 5;
                        h.HpCurrent = h.HpMax; // refill on level up
                    }
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

                h.LastUpdatedUtc = DateTime.UtcNow;
                Save();
                return Clone(h);
            }
        }

        public HeroState SetHp(string platform, string handle, int hpCurrent)
        {
            return Mutate(platform, handle, h =>
            {
                h.HpCurrent = Math.Max(0, Math.Min(h.HpMax, hpCurrent));
            });
        }

        public HeroState RecordDuel(string platform, string handle, bool won)
        {
            return Mutate(platform, handle, h =>
            {
                if (won) h.DuelsWon++; else h.DuelsLost++;
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
