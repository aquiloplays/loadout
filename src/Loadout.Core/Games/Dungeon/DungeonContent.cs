using System;
using System.Collections.Generic;
using System.Linq;

namespace Loadout.Games.Dungeon
{
    /// <summary>
    /// Static content pools for the !dungeon mini-game. Kept in code (not
    /// JSON config) so a streamer can't accidentally delete the monster
    /// pool and brick the game; tweaks ride along with code updates.
    ///
    /// Encounter scenes are intentionally short (one sentence each). The
    /// overlay shows them as a typewriter-style text rotation while the
    /// party is "in the dungeon" so the streamer's chat reads like a
    /// shared adventure log without anyone needing to alt-tab.
    /// </summary>
    public static class DungeonContent
    {
        // Item rarities ordered by drop weight (common → mythic). Each
        // rarity carries a colour the overlay reads from a CSS variable.
        public static readonly string[] Rarities = { "common", "uncommon", "rare", "epic", "legendary" };

        // Equipment slots a hero can fill. Inventory items beyond what's
        // equipped sit in the bag (size capped per Discord-side decisions).
        public static readonly string[] Slots = { "weapon", "head", "chest", "legs", "boots", "trinket" };

        public sealed class ClassDef
        {
            public string Name;       // canonical key (lowercase) — stored in HeroState.ClassName
            public string DisplayName;
            public string Glyph;      // emoji rendered in the avatar circle when no avatar URL is set
            public string TintColor;  // hex used for the avatar ring + class chip on the overlay
            public int    AtkBonus;   // additive on top of level + gear
            public int    DefBonus;
            public int    HpBonus;    // additive on top of HpMax baseline (25 + level scaling)
        }

        // Five archetypes — narrow enough that the picker fits in one
        // ActionRow on Discord (5 buttons), wide enough that viewers
        // pick something they identify with. Bonuses are intentionally
        // small (+/- 2 at most) so a class doesn't overshadow gear.
        public static readonly ClassDef[] Classes = new[]
        {
            new ClassDef { Name = "warrior", DisplayName = "Warrior", Glyph = "⚔",  TintColor = "#F85149", AtkBonus = 2, DefBonus = 0, HpBonus = 0  },
            new ClassDef { Name = "mage",    DisplayName = "Mage",    Glyph = "🪄", TintColor = "#B452FF", AtkBonus = 1, DefBonus = 1, HpBonus = 0  },
            new ClassDef { Name = "rogue",   DisplayName = "Rogue",   Glyph = "🗡", TintColor = "#3FB950", AtkBonus = 2, DefBonus = -1, HpBonus = 0 },
            new ClassDef { Name = "ranger",  DisplayName = "Ranger",  Glyph = "🏹", TintColor = "#F0B429", AtkBonus = 1, DefBonus = 0, HpBonus = 0  },
            new ClassDef { Name = "healer",  DisplayName = "Healer",  Glyph = "✨", TintColor = "#00F2EA", AtkBonus = 0, DefBonus = 1, HpBonus = 5  }
        };

        public static ClassDef ClassByName(string name)
        {
            if (string.IsNullOrWhiteSpace(name)) return null;
            var k = name.Trim().ToLowerInvariant();
            foreach (var c in Classes) if (c.Name == k) return c;
            return null;
        }

        public sealed class MonsterDef
        {
            public string Name;
            public string Glyph;     // emoji shown on the overlay tile
            public int    Power;     // baseline damage range source
            public int    Hp;
            public int    GoldMin;
            public int    GoldMax;
            public int    XpMin;
            public int    XpMax;
        }

        public sealed class TrapDef
        {
            public string Name;
            public string Glyph;
            public int    DamageMin;
            public int    DamageMax;
            public string Verb;      // "spikes pierce", "flames lick", etc.
        }

        public sealed class LootDef
        {
            public string Slot;      // weapon / head / chest / legs / boots / trinket / consumable
            public string Rarity;
            public string Name;      // "Rusty Dagger", "Wyvern Helm"
            public string Glyph;     // emoji shown on overlay tile
            public int    PowerBonus;
            public int    DefenseBonus;
            public int    GoldValue; // resale price baseline (Discord shop)
        }

        public sealed class SceneDef
        {
            public string Kind;      // "encounter" | "trap" | "treasure" | "rest" | "peril" | "story"
            public string Template;  // {user}, {monster}, {damage}, {loot}, {xp}
            public int    Weight;    // pick weight inside its kind
        }

        // Distinct foe pool — slim enough that a 4-room run almost always
        // pulls 4 different glyphs, fat enough that two back-to-back runs
        // rarely repeat. Power is in the same scale as hero attack so the
        // outcome model below stays simple (attacker - defender = damage).
        public static readonly MonsterDef[] Monsters = new[]
        {
            new MonsterDef { Name = "Goblin Sneak",    Glyph = "👹", Power = 4,  Hp = 12, GoldMin = 5,  GoldMax = 15, XpMin = 8,  XpMax = 14 },
            new MonsterDef { Name = "Cave Bat",        Glyph = "🦇", Power = 3,  Hp = 8,  GoldMin = 3,  GoldMax = 10, XpMin = 6,  XpMax = 10 },
            new MonsterDef { Name = "Skeleton Archer", Glyph = "💀", Power = 5,  Hp = 14, GoldMin = 8,  GoldMax = 18, XpMin = 10, XpMax = 16 },
            new MonsterDef { Name = "Slime",           Glyph = "🟢", Power = 2,  Hp = 18, GoldMin = 4,  GoldMax = 12, XpMin = 7,  XpMax = 12 },
            new MonsterDef { Name = "Orc Brute",       Glyph = "🪓", Power = 7,  Hp = 22, GoldMin = 12, GoldMax = 24, XpMin = 14, XpMax = 22 },
            new MonsterDef { Name = "Lich",            Glyph = "🧙", Power = 9,  Hp = 28, GoldMin = 18, GoldMax = 36, XpMin = 22, XpMax = 32 },
            new MonsterDef { Name = "Wyvern",          Glyph = "🐉", Power = 11, Hp = 36, GoldMin = 28, GoldMax = 48, XpMin = 30, XpMax = 44 },
            new MonsterDef { Name = "Ancient Mimic",   Glyph = "📦", Power = 6,  Hp = 20, GoldMin = 24, GoldMax = 60, XpMin = 18, XpMax = 28 },
            new MonsterDef { Name = "Shadow Stalker",  Glyph = "🦂", Power = 8,  Hp = 18, GoldMin = 14, GoldMax = 26, XpMin = 16, XpMax = 24 },
            new MonsterDef { Name = "Stone Golem",     Glyph = "🗿", Power = 10, Hp = 40, GoldMin = 22, GoldMax = 40, XpMin = 24, XpMax = 36 }
        };

        public static readonly TrapDef[] Traps = new[]
        {
            new TrapDef { Name = "Spike Pit",      Glyph = "🪤", DamageMin = 4, DamageMax = 9,  Verb = "spikes pierce" },
            new TrapDef { Name = "Poison Dart",    Glyph = "🏹", DamageMin = 3, DamageMax = 7,  Verb = "darts strike" },
            new TrapDef { Name = "Falling Stones", Glyph = "🪨", DamageMin = 5, DamageMax = 11, Verb = "rocks crash down on" },
            new TrapDef { Name = "Fire Jet",       Glyph = "🔥", DamageMin = 4, DamageMax = 10, Verb = "flames lick" },
            new TrapDef { Name = "Cursed Rune",    Glyph = "♨️", DamageMin = 2, DamageMax = 8,  Verb = "a cursed rune flares against" },
            new TrapDef { Name = "Rusted Blade",   Glyph = "🗡️", DamageMin = 3, DamageMax = 8,  Verb = "a rusted blade swings into" }
        };

        // Loot pool — the rarity weights at the bottom drive how often
        // each tier rolls. Names + glyphs are paired so the overlay tile
        // and chat reply read the same.
        public static readonly LootDef[] Loot = new[]
        {
            // Common
            new LootDef { Slot = "weapon",  Rarity = "common",   Name = "Rusty Dagger",     Glyph = "🗡️", PowerBonus = 1, DefenseBonus = 0, GoldValue = 5  },
            new LootDef { Slot = "weapon",  Rarity = "common",   Name = "Wooden Club",      Glyph = "🏏", PowerBonus = 1, DefenseBonus = 0, GoldValue = 4  },
            new LootDef { Slot = "head",    Rarity = "common",   Name = "Leather Cap",      Glyph = "🧢", PowerBonus = 0, DefenseBonus = 1, GoldValue = 5  },
            new LootDef { Slot = "chest",   Rarity = "common",   Name = "Cloth Tunic",      Glyph = "👕", PowerBonus = 0, DefenseBonus = 1, GoldValue = 4  },
            new LootDef { Slot = "boots",   Rarity = "common",   Name = "Worn Boots",       Glyph = "🥾", PowerBonus = 0, DefenseBonus = 1, GoldValue = 4  },

            // Uncommon
            new LootDef { Slot = "weapon",  Rarity = "uncommon", Name = "Steel Sword",      Glyph = "⚔️", PowerBonus = 2, DefenseBonus = 0, GoldValue = 18 },
            new LootDef { Slot = "weapon",  Rarity = "uncommon", Name = "Hunter's Bow",     Glyph = "🏹", PowerBonus = 2, DefenseBonus = 0, GoldValue = 18 },
            new LootDef { Slot = "head",    Rarity = "uncommon", Name = "Iron Helm",        Glyph = "⛑️", PowerBonus = 0, DefenseBonus = 2, GoldValue = 18 },
            new LootDef { Slot = "chest",   Rarity = "uncommon", Name = "Chainmail",        Glyph = "🦺", PowerBonus = 0, DefenseBonus = 2, GoldValue = 20 },
            new LootDef { Slot = "trinket", Rarity = "uncommon", Name = "Lucky Charm",      Glyph = "🍀", PowerBonus = 1, DefenseBonus = 1, GoldValue = 22 },

            // Rare
            new LootDef { Slot = "weapon",  Rarity = "rare",     Name = "Frost Hammer",     Glyph = "🔨", PowerBonus = 4, DefenseBonus = 0, GoldValue = 60  },
            new LootDef { Slot = "weapon",  Rarity = "rare",     Name = "Shadow Staff",     Glyph = "🪄", PowerBonus = 4, DefenseBonus = 1, GoldValue = 65  },
            new LootDef { Slot = "chest",   Rarity = "rare",     Name = "Plated Cuirass",   Glyph = "🛡️", PowerBonus = 1, DefenseBonus = 4, GoldValue = 65  },
            new LootDef { Slot = "trinket", Rarity = "rare",     Name = "Healing Amulet",   Glyph = "📿", PowerBonus = 0, DefenseBonus = 3, GoldValue = 70  },

            // Epic
            new LootDef { Slot = "weapon",  Rarity = "epic",     Name = "Drakebane Sword",  Glyph = "🗡️", PowerBonus = 7, DefenseBonus = 1, GoldValue = 180 },
            new LootDef { Slot = "head",    Rarity = "epic",     Name = "Wyvern Crown",     Glyph = "👑", PowerBonus = 2, DefenseBonus = 5, GoldValue = 200 },
            new LootDef { Slot = "trinket", Rarity = "epic",     Name = "Phoenix Feather",  Glyph = "🪶", PowerBonus = 3, DefenseBonus = 4, GoldValue = 220 },

            // Legendary
            new LootDef { Slot = "weapon",  Rarity = "legendary", Name = "Aquilo's Edge",   Glyph = "⚡", PowerBonus = 12, DefenseBonus = 2, GoldValue = 600 },
            new LootDef { Slot = "trinket", Rarity = "legendary", Name = "Bolt Sigil",       Glyph = "💎", PowerBonus = 6,  DefenseBonus = 6, GoldValue = 700 }
        };

        /// <summary>
        /// Roll weights — picks an item rarity tier given the dungeon
        /// difficulty. Higher difficulty shifts the curve right; this is
        /// the only knob the streamer adjusts on the Settings card.
        /// </summary>
        public static string RollRarity(Random r, int difficulty)
        {
            // difficulty: 1..5
            // Common drops dominate at d=1; legendary tops out near 4% at d=5.
            int[] weights;
            if (difficulty <= 1)      weights = new[] { 70, 22, 6, 2, 0 };
            else if (difficulty == 2) weights = new[] { 55, 28, 12, 4, 1 };
            else if (difficulty == 3) weights = new[] { 40, 32, 18, 8, 2 };
            else if (difficulty == 4) weights = new[] { 28, 32, 24, 13, 3 };
            else                      weights = new[] { 18, 30, 28, 20, 4 };
            int total = 0; foreach (var w in weights) total += w;
            int pick  = r.Next(total);
            int acc   = 0;
            for (int i = 0; i < weights.Length; i++)
            {
                acc += weights[i];
                if (pick < acc) return Rarities[i];
            }
            return Rarities[0];
        }

        public static MonsterDef PickMonster(Random r, int difficulty)
        {
            // Stronger monsters more likely at higher difficulty — pick
            // by sliding window over the sorted-by-power Monsters list.
            int n = Monsters.Length;
            int floor = Math.Max(0, Math.Min(n - 3, (difficulty - 1) * 2));
            int top   = Math.Min(n, floor + 4);
            return Monsters[r.Next(floor, top)];
        }

        public static TrapDef PickTrap(Random r) => Traps[r.Next(Traps.Length)];

        public static LootDef PickLootByRarity(Random r, string rarity)
        {
            var pool = Loot.Where(l => l.Rarity == rarity).ToArray();
            if (pool.Length == 0) pool = Loot;
            return pool[r.Next(pool.Length)];
        }

        // ── Story scene templates ──────────────────────────────────────
        // Every dungeon run interleaves these between the mechanical
        // outcomes (combat / trap / loot) so the chat narrative doesn't
        // read as "fight, fight, fight". They're flavour-only — no HP /
        // XP / loot mutations come out of these.
        public static readonly string[] FlavourScenes = new[]
        {
            "The torches flicker as the party pushes deeper.",
            "Distant footsteps echo down the corridor.",
            "A draft carries the smell of old gold.",
            "Mossy bones crunch underfoot.",
            "Strange runes glow on the walls.",
            "Water drips somewhere far below.",
            "A door creaks open by itself.",
            "Whispers swirl just out of earshot.",
            "Cobwebs tangle on someone's torch.",
            "The walls feel warmer here..."
        };

        /// <summary>
        /// XP needed to advance to the next level. Quadratic-ish so a
        /// hero progresses fast at first, slows after L5. Pure function.
        /// </summary>
        public static int XpForLevel(int level)
        {
            if (level <= 1) return 50;
            return 50 + (level - 1) * 35 + (level - 1) * (level - 1) * 8;
        }
    }
}
