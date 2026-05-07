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
    /// Content sizes (post-expansion):
    ///   12 dungeon types — each tied to a biome-specific monster pool
    ///   ~35 monsters     — including 5 boss-tier with guaranteed rare+ drops
    ///   16 traps         — biome-flavoured where it matters
    ///   ~60 loot items   — across 5 rarities, 6 slots, multiple set themes
    ///   ~50 scenes       — encounter / trap / treasure / story / npc /
    ///                      shrine / curse / miniboss (8 scene kinds)
    ///   50-cap leveling  — XP curve scales quadratically
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
        public static readonly string[] Rarities = { "common", "uncommon", "rare", "epic", "legendary", "mythic" };

        // Equipment slots a hero can fill. Inventory items beyond what's
        // equipped sit in the bag (size capped per Discord-side decisions).
        public static readonly string[] Slots = { "weapon", "head", "chest", "legs", "boots", "trinket" };

        // ── Classes ─────────────────────────────────────────────────────
        public sealed class ClassDef
        {
            public string Name;
            public string DisplayName;
            public string Glyph;
            public string TintColor;
            public int    AtkBonus;
            public int    DefBonus;
            public int    HpBonus;
        }

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

        // ── Monsters ────────────────────────────────────────────────────
        public sealed class MonsterDef
        {
            public string Name;
            public string Glyph;
            public int    Power;
            public int    Hp;
            public int    GoldMin;
            public int    GoldMax;
            public int    XpMin;
            public int    XpMax;
            public int    DifficultyTier;   // 1..5 — the floor where this monster starts appearing
            public string Biome;             // matches DungeonType.Biome ("undead", "elemental", etc.) or "any"
            public bool   IsBoss;            // bosses guarantee a rare+ drop and broadcast a special scene line
        }

        // Curated monster pool. Tier 1-5 governs when a monster starts
        // showing up; biome ties it to specific dungeon types so a
        // Wyvern's Hollow run never spawns a sky harpy. "any"-biome
        // monsters can show up in any dungeon — used for filler beasts
        // (slime, rat) so even an unusual biome has variety.
        public static readonly MonsterDef[] Monsters = new[]
        {
            // ── Tier 1 (any biome / weakest) ──
            new MonsterDef { Name = "Goblin Sneak",    Glyph = "👹", Power = 4,  Hp = 12, GoldMin = 5,  GoldMax = 15, XpMin = 8,  XpMax = 14, DifficultyTier = 1, Biome = "any" },
            new MonsterDef { Name = "Cave Bat",        Glyph = "🦇", Power = 3,  Hp = 8,  GoldMin = 3,  GoldMax = 10, XpMin = 6,  XpMax = 10, DifficultyTier = 1, Biome = "earth" },
            new MonsterDef { Name = "Slime",           Glyph = "🟢", Power = 2,  Hp = 18, GoldMin = 4,  GoldMax = 12, XpMin = 7,  XpMax = 12, DifficultyTier = 1, Biome = "any" },
            new MonsterDef { Name = "Plague Rat",      Glyph = "🐀", Power = 3,  Hp = 10, GoldMin = 4,  GoldMax = 11, XpMin = 7,  XpMax = 11, DifficultyTier = 1, Biome = "swamp" },
            new MonsterDef { Name = "Tomb Spider",     Glyph = "🕷", Power = 4,  Hp = 12, GoldMin = 6,  GoldMax = 14, XpMin = 9,  XpMax = 13, DifficultyTier = 1, Biome = "undead" },

            // ── Tier 2 ──
            new MonsterDef { Name = "Skeleton Archer", Glyph = "💀", Power = 5,  Hp = 14, GoldMin = 8,  GoldMax = 18, XpMin = 10, XpMax = 16, DifficultyTier = 2, Biome = "undead" },
            new MonsterDef { Name = "Bog Hag",         Glyph = "🧌", Power = 6,  Hp = 16, GoldMin = 10, GoldMax = 20, XpMin = 12, XpMax = 18, DifficultyTier = 2, Biome = "swamp" },
            new MonsterDef { Name = "Drowned Warrior", Glyph = "🧜", Power = 5,  Hp = 18, GoldMin = 9,  GoldMax = 19, XpMin = 11, XpMax = 17, DifficultyTier = 2, Biome = "water" },
            new MonsterDef { Name = "Fire Imp",        Glyph = "🔥", Power = 5,  Hp = 12, GoldMin = 10, GoldMax = 18, XpMin = 12, XpMax = 16, DifficultyTier = 2, Biome = "fire" },
            new MonsterDef { Name = "Ice Sprite",      Glyph = "❄️", Power = 4,  Hp = 14, GoldMin = 9,  GoldMax = 18, XpMin = 11, XpMax = 16, DifficultyTier = 2, Biome = "ice" },
            new MonsterDef { Name = "Wisp",            Glyph = "💡", Power = 4,  Hp = 12, GoldMin = 8,  GoldMax = 16, XpMin = 11, XpMax = 16, DifficultyTier = 2, Biome = "nature" },
            new MonsterDef { Name = "Dryad",           Glyph = "🌿", Power = 5,  Hp = 14, GoldMin = 9,  GoldMax = 18, XpMin = 11, XpMax = 17, DifficultyTier = 2, Biome = "nature" },
            new MonsterDef { Name = "Harpy",           Glyph = "🪶", Power = 5,  Hp = 14, GoldMin = 10, GoldMax = 18, XpMin = 12, XpMax = 17, DifficultyTier = 2, Biome = "sky" },

            // ── Tier 3 ──
            new MonsterDef { Name = "Orc Brute",       Glyph = "🪓", Power = 7,  Hp = 22, GoldMin = 12, GoldMax = 24, XpMin = 14, XpMax = 22, DifficultyTier = 3, Biome = "any" },
            new MonsterDef { Name = "Mummy",           Glyph = "🧟", Power = 7,  Hp = 24, GoldMin = 14, GoldMax = 26, XpMin = 16, XpMax = 24, DifficultyTier = 3, Biome = "undead" },
            new MonsterDef { Name = "Necromancer",     Glyph = "🧙‍♂️", Power = 8, Hp = 20, GoldMin = 16, GoldMax = 30, XpMin = 18, XpMax = 26, DifficultyTier = 3, Biome = "undead" },
            new MonsterDef { Name = "Treant",          Glyph = "🌳", Power = 6,  Hp = 32, GoldMin = 14, GoldMax = 26, XpMin = 16, XpMax = 24, DifficultyTier = 3, Biome = "nature" },
            new MonsterDef { Name = "Salamander",      Glyph = "🦎", Power = 8,  Hp = 22, GoldMin = 16, GoldMax = 28, XpMin = 18, XpMax = 26, DifficultyTier = 3, Biome = "fire" },
            new MonsterDef { Name = "Frost Troll",     Glyph = "❄️", Power = 9,  Hp = 26, GoldMin = 17, GoldMax = 29, XpMin = 20, XpMax = 28, DifficultyTier = 3, Biome = "ice" },
            new MonsterDef { Name = "Iron Sentinel",   Glyph = "🛡", Power = 8,  Hp = 30, GoldMin = 16, GoldMax = 28, XpMin = 18, XpMax = 26, DifficultyTier = 3, Biome = "construct" },
            new MonsterDef { Name = "Sky Knight",      Glyph = "🪽", Power = 9,  Hp = 24, GoldMin = 18, GoldMax = 32, XpMin = 20, XpMax = 28, DifficultyTier = 3, Biome = "sky" },
            new MonsterDef { Name = "Siren",           Glyph = "🎵", Power = 7,  Hp = 20, GoldMin = 16, GoldMax = 28, XpMin = 18, XpMax = 26, DifficultyTier = 3, Biome = "water" },
            new MonsterDef { Name = "Rotted Golem",    Glyph = "🪦", Power = 8,  Hp = 28, GoldMin = 16, GoldMax = 28, XpMin = 18, XpMax = 26, DifficultyTier = 3, Biome = "swamp" },
            new MonsterDef { Name = "Shadow Stalker",  Glyph = "🦂", Power = 8,  Hp = 18, GoldMin = 14, GoldMax = 26, XpMin = 16, XpMax = 24, DifficultyTier = 3, Biome = "any" },

            // ── Tier 4 ──
            new MonsterDef { Name = "Lich",            Glyph = "🧛",  Power = 9,  Hp = 28, GoldMin = 18, GoldMax = 36, XpMin = 22, XpMax = 32, DifficultyTier = 4, Biome = "undead" },
            new MonsterDef { Name = "Magma Elemental", Glyph = "🌋", Power = 10, Hp = 32, GoldMin = 22, GoldMax = 38, XpMin = 24, XpMax = 34, DifficultyTier = 4, Biome = "fire" },
            new MonsterDef { Name = "Storm Elemental", Glyph = "⛈",  Power = 10, Hp = 30, GoldMin = 22, GoldMax = 38, XpMin = 24, XpMax = 34, DifficultyTier = 4, Biome = "sky" },
            new MonsterDef { Name = "Yeti",            Glyph = "❄",  Power = 11, Hp = 36, GoldMin = 24, GoldMax = 40, XpMin = 26, XpMax = 36, DifficultyTier = 4, Biome = "ice" },
            new MonsterDef { Name = "Stone Golem",     Glyph = "🗿", Power = 10, Hp = 40, GoldMin = 22, GoldMax = 40, XpMin = 24, XpMax = 36, DifficultyTier = 4, Biome = "earth" },
            new MonsterDef { Name = "Clockwork Guard", Glyph = "⚙️",  Power = 11, Hp = 38, GoldMin = 24, GoldMax = 42, XpMin = 26, XpMax = 36, DifficultyTier = 4, Biome = "construct" },
            new MonsterDef { Name = "Plague Bringer",  Glyph = "☣",  Power = 10, Hp = 32, GoldMin = 22, GoldMax = 38, XpMin = 24, XpMax = 34, DifficultyTier = 4, Biome = "swamp" },
            new MonsterDef { Name = "Dragonkin",       Glyph = "🐲", Power = 11, Hp = 34, GoldMin = 26, GoldMax = 44, XpMin = 28, XpMax = 38, DifficultyTier = 4, Biome = "dragon" },
            new MonsterDef { Name = "Void Wraith",     Glyph = "👻", Power = 12, Hp = 28, GoldMin = 24, GoldMax = 42, XpMin = 28, XpMax = 38, DifficultyTier = 4, Biome = "void" },
            new MonsterDef { Name = "Ancient Mimic",   Glyph = "📦", Power = 10, Hp = 28, GoldMin = 36, GoldMax = 80, XpMin = 24, XpMax = 36, DifficultyTier = 4, Biome = "any" },

            // ── Tier 5 ──
            new MonsterDef { Name = "Wyvern",          Glyph = "🐉", Power = 13, Hp = 42, GoldMin = 32, GoldMax = 56, XpMin = 32, XpMax = 48, DifficultyTier = 5, Biome = "dragon" },
            new MonsterDef { Name = "Mind Flayer",     Glyph = "🧠", Power = 14, Hp = 38, GoldMin = 30, GoldMax = 54, XpMin = 32, XpMax = 48, DifficultyTier = 5, Biome = "void" },
            new MonsterDef { Name = "Kraken",          Glyph = "🐙", Power = 14, Hp = 50, GoldMin = 34, GoldMax = 60, XpMin = 34, XpMax = 50, DifficultyTier = 5, Biome = "water" },

            // ── BOSSES (each guarantees a rare+ drop) ──
            new MonsterDef { Name = "Lich King",       Glyph = "👑", Power = 16, Hp = 70, GoldMin = 80,  GoldMax = 140, XpMin = 60, XpMax = 90, DifficultyTier = 5, Biome = "undead",   IsBoss = true },
            new MonsterDef { Name = "Ancient Wyrm",    Glyph = "🐲", Power = 18, Hp = 90, GoldMin = 100, GoldMax = 180, XpMin = 70, XpMax = 110, DifficultyTier = 5, Biome = "dragon",   IsBoss = true },
            new MonsterDef { Name = "Voidlord",        Glyph = "🌑", Power = 19, Hp = 80, GoldMin = 110, GoldMax = 200, XpMin = 75, XpMax = 120, DifficultyTier = 5, Biome = "void",     IsBoss = true },
            new MonsterDef { Name = "Frostmother",     Glyph = "❄",  Power = 17, Hp = 80, GoldMin = 90,  GoldMax = 160, XpMin = 65, XpMax = 100, DifficultyTier = 5, Biome = "ice",      IsBoss = true },
            new MonsterDef { Name = "Eldritch Horror", Glyph = "👁",  Power = 20, Hp = 100, GoldMin = 120, GoldMax = 220, XpMin = 80, XpMax = 130, DifficultyTier = 5, Biome = "void",    IsBoss = true }
        };

        // ── Traps ────────────────────────────────────────────────────────
        public sealed class TrapDef
        {
            public string Name;
            public string Glyph;
            public int    DamageMin;
            public int    DamageMax;
            public string Verb;
            public string Biome;     // "any" or specific
        }

        public static readonly TrapDef[] Traps = new[]
        {
            new TrapDef { Name = "Spike Pit",      Glyph = "🪤", DamageMin = 4, DamageMax = 9,  Verb = "spikes pierce",                         Biome = "any" },
            new TrapDef { Name = "Poison Dart",    Glyph = "🏹", DamageMin = 3, DamageMax = 7,  Verb = "darts strike",                          Biome = "any" },
            new TrapDef { Name = "Falling Stones", Glyph = "🪨", DamageMin = 5, DamageMax = 11, Verb = "rocks crash down on",                   Biome = "earth" },
            new TrapDef { Name = "Fire Jet",       Glyph = "🔥", DamageMin = 4, DamageMax = 10, Verb = "flames lick",                           Biome = "fire" },
            new TrapDef { Name = "Cursed Rune",    Glyph = "♨️", DamageMin = 2, DamageMax = 8,  Verb = "a cursed rune flares against",          Biome = "undead" },
            new TrapDef { Name = "Rusted Blade",   Glyph = "🗡", DamageMin = 3, DamageMax = 8,  Verb = "a rusted blade swings into",            Biome = "any" },
            new TrapDef { Name = "Acid Pool",      Glyph = "🧪", DamageMin = 5, DamageMax = 10, Verb = "acid eats into",                        Biome = "swamp" },
            new TrapDef { Name = "Tripwire",       Glyph = "🪢", DamageMin = 2, DamageMax = 6,  Verb = "a tripwire snaps under",                Biome = "any" },
            new TrapDef { Name = "Pendulum Blade", Glyph = "🪓", DamageMin = 6, DamageMax = 12, Verb = "a pendulum blade swings through",       Biome = "construct" },
            new TrapDef { Name = "Lightning Coil", Glyph = "⚡", DamageMin = 4, DamageMax = 10, Verb = "a lightning coil arcs into",            Biome = "construct" },
            new TrapDef { Name = "Sleeping Gas",   Glyph = "💨", DamageMin = 1, DamageMax = 5,  Verb = "sleeping gas wafts over",               Biome = "any" },
            new TrapDef { Name = "Frost Floor",    Glyph = "🧊", DamageMin = 3, DamageMax = 7,  Verb = "the floor freezes beneath",             Biome = "ice" },
            new TrapDef { Name = "Mage Sigil",     Glyph = "✨", DamageMin = 4, DamageMax = 9,  Verb = "a mage sigil ignites under",            Biome = "any" },
            new TrapDef { Name = "Whirlwind",      Glyph = "🌀", DamageMin = 5, DamageMax = 9,  Verb = "a sudden whirlwind buffets",            Biome = "sky" },
            new TrapDef { Name = "Thorn Vine",     Glyph = "🥀", DamageMin = 3, DamageMax = 8,  Verb = "thorned vines lash",                    Biome = "nature" },
            new TrapDef { Name = "Void Tear",      Glyph = "🌑", DamageMin = 6, DamageMax = 12, Verb = "a tear in reality bites at",            Biome = "void" }
        };

        // ── Loot ────────────────────────────────────────────────────────
        public sealed class LootDef
        {
            public string Slot;
            public string Rarity;
            public string Name;
            public string Glyph;
            public int    PowerBonus;
            public int    DefenseBonus;
            public int    GoldValue;
            public string SetName;          // empty string if not part of a set
            // Visual + balance metadata. WeaponType is only meaningful
            // when Slot == "weapon" and drives which SVG the dungeon
            // overlay renders in the hero's hand. PreferredClass grants
            // a class-affinity bonus to that hero — items still equip
            // for any class, but matched items reward the right one.
            public string WeaponType;       // sword | axe | hammer | polearm | dagger | bow | crossbow | staff | wand | tome | orb | holy | sling
            public string PreferredClass;   // warrior / mage / rogue / ranger / healer (empty = no preference)
        }

        // ~220 items across 6 rarities + 10 set themes. Every weapon
        // carries a WeaponType so the overlay can render the actual
        // weapon shape in the hero's hand. PreferredClass on weapons
        // and armour grants a class-affinity bonus through
        // HeroState.Attack/Defense (matched items hit harder for the
        // right class). Generic items (no PreferredClass) work the
        // same for everyone.
        public static readonly LootDef[] Loot = new[]
        {
            // ─────────────────────────────── COMMON ───────────────────────────
            // Generic starter weapons — all classes can use, lower stats.
            new LootDef { Slot = "weapon", Rarity = "common", Name = "Wooden Sword",     Glyph = "🗡", PowerBonus = 1, DefenseBonus = 0, GoldValue = 4,  WeaponType = "sword",  PreferredClass = "warrior" },
            new LootDef { Slot = "weapon", Rarity = "common", Name = "Bronze Shortsword", Glyph = "🗡", PowerBonus = 1, DefenseBonus = 0, GoldValue = 6,  WeaponType = "sword",  PreferredClass = "warrior" },
            new LootDef { Slot = "weapon", Rarity = "common", Name = "Rusty Dagger",     Glyph = "🗡", PowerBonus = 1, DefenseBonus = 0, GoldValue = 5,  WeaponType = "dagger", PreferredClass = "rogue" },
            new LootDef { Slot = "weapon", Rarity = "common", Name = "Wooden Club",      Glyph = "🏏", PowerBonus = 1, DefenseBonus = 0, GoldValue = 4,  WeaponType = "hammer", PreferredClass = "warrior" },
            new LootDef { Slot = "weapon", Rarity = "common", Name = "Hand Axe",         Glyph = "🪓", PowerBonus = 1, DefenseBonus = 0, GoldValue = 5,  WeaponType = "axe",    PreferredClass = "warrior" },
            new LootDef { Slot = "weapon", Rarity = "common", Name = "Hunter's Sling",   Glyph = "🪨", PowerBonus = 1, DefenseBonus = 0, GoldValue = 5,  WeaponType = "sling",  PreferredClass = "ranger" },
            new LootDef { Slot = "weapon", Rarity = "common", Name = "Shortbow",         Glyph = "🏹", PowerBonus = 1, DefenseBonus = 0, GoldValue = 6,  WeaponType = "bow",    PreferredClass = "ranger" },
            new LootDef { Slot = "weapon", Rarity = "common", Name = "Apprentice Wand",  Glyph = "🪄", PowerBonus = 1, DefenseBonus = 0, GoldValue = 6,  WeaponType = "wand",   PreferredClass = "mage" },
            new LootDef { Slot = "weapon", Rarity = "common", Name = "Twigwand",         Glyph = "🌿", PowerBonus = 1, DefenseBonus = 0, GoldValue = 5,  WeaponType = "wand",   PreferredClass = "mage" },
            new LootDef { Slot = "weapon", Rarity = "common", Name = "Walking Staff",    Glyph = "🥢", PowerBonus = 1, DefenseBonus = 1, GoldValue = 6,  WeaponType = "staff",  PreferredClass = "healer" },
            new LootDef { Slot = "weapon", Rarity = "common", Name = "Throwing Knives",  Glyph = "🔪", PowerBonus = 1, DefenseBonus = 0, GoldValue = 5,  WeaponType = "dagger", PreferredClass = "rogue" },
            new LootDef { Slot = "weapon", Rarity = "common", Name = "Quarterstaff",     Glyph = "🥢", PowerBonus = 1, DefenseBonus = 1, GoldValue = 7,  WeaponType = "staff",  PreferredClass = "healer" },

            // Common armour — generic + start of the Wayfarer set (all-class friendly basics)
            new LootDef { Slot = "head",   Rarity = "common", Name = "Leather Cap",      Glyph = "🧢", PowerBonus = 0, DefenseBonus = 1, GoldValue = 5  },
            new LootDef { Slot = "head",   Rarity = "common", Name = "Cloth Hood",       Glyph = "👤", PowerBonus = 0, DefenseBonus = 1, GoldValue = 5  },
            new LootDef { Slot = "head",   Rarity = "common", Name = "Wayfarer Hat",     Glyph = "🎩", PowerBonus = 0, DefenseBonus = 1, GoldValue = 6,  SetName = "wayfarer" },
            new LootDef { Slot = "head",   Rarity = "common", Name = "Padded Coif",      Glyph = "🧣", PowerBonus = 0, DefenseBonus = 1, GoldValue = 5  },
            new LootDef { Slot = "chest",  Rarity = "common", Name = "Cloth Tunic",      Glyph = "👕", PowerBonus = 0, DefenseBonus = 1, GoldValue = 4  },
            new LootDef { Slot = "chest",  Rarity = "common", Name = "Hide Vest",        Glyph = "🦬", PowerBonus = 0, DefenseBonus = 1, GoldValue = 4  },
            new LootDef { Slot = "chest",  Rarity = "common", Name = "Wayfarer Vest",    Glyph = "👔", PowerBonus = 0, DefenseBonus = 1, GoldValue = 6,  SetName = "wayfarer" },
            new LootDef { Slot = "chest",  Rarity = "common", Name = "Quilted Doublet",  Glyph = "🧥", PowerBonus = 0, DefenseBonus = 1, GoldValue = 5  },
            new LootDef { Slot = "legs",   Rarity = "common", Name = "Hempen Trousers",  Glyph = "👖", PowerBonus = 0, DefenseBonus = 1, GoldValue = 4  },
            new LootDef { Slot = "legs",   Rarity = "common", Name = "Patchwork Greaves", Glyph = "🧱", PowerBonus = 0, DefenseBonus = 1, GoldValue = 5  },
            new LootDef { Slot = "legs",   Rarity = "common", Name = "Wayfarer Trousers", Glyph = "👖", PowerBonus = 0, DefenseBonus = 1, GoldValue = 6,  SetName = "wayfarer" },
            new LootDef { Slot = "boots",  Rarity = "common", Name = "Worn Boots",       Glyph = "🥾", PowerBonus = 0, DefenseBonus = 1, GoldValue = 4  },
            new LootDef { Slot = "boots",  Rarity = "common", Name = "Sandals",          Glyph = "🩴", PowerBonus = 0, DefenseBonus = 1, GoldValue = 3  },
            new LootDef { Slot = "boots",  Rarity = "common", Name = "Wayfarer Shoes",   Glyph = "👟", PowerBonus = 0, DefenseBonus = 1, GoldValue = 6,  SetName = "wayfarer" },
            new LootDef { Slot = "trinket", Rarity = "common", Name = "Crow Feather",    Glyph = "🪶", PowerBonus = 0, DefenseBonus = 1, GoldValue = 5  },
            new LootDef { Slot = "trinket", Rarity = "common", Name = "Wooden Charm",    Glyph = "🪵", PowerBonus = 0, DefenseBonus = 1, GoldValue = 4  },
            new LootDef { Slot = "trinket", Rarity = "common", Name = "Brass Ring",      Glyph = "💍", PowerBonus = 0, DefenseBonus = 1, GoldValue = 5  },
            new LootDef { Slot = "trinket", Rarity = "common", Name = "Lucky Coin",      Glyph = "🪙", PowerBonus = 1, DefenseBonus = 0, GoldValue = 6  },

            // ─────────────────────────────── UNCOMMON ─────────────────────────
            // Class-themed weapon variety (most weapons now class-preferred).
            new LootDef { Slot = "weapon", Rarity = "uncommon", Name = "Steel Longsword",  Glyph = "⚔",  PowerBonus = 2, DefenseBonus = 0, GoldValue = 60,  WeaponType = "sword",   PreferredClass = "warrior" },
            new LootDef { Slot = "weapon", Rarity = "uncommon", Name = "Knight's Sword",   Glyph = "⚔",  PowerBonus = 3, DefenseBonus = 0, GoldValue = 65,  WeaponType = "sword",   PreferredClass = "warrior" },
            new LootDef { Slot = "weapon", Rarity = "uncommon", Name = "Iron War Axe",     Glyph = "🪓", PowerBonus = 2, DefenseBonus = 0, GoldValue = 65,  WeaponType = "axe",     PreferredClass = "warrior" },
            new LootDef { Slot = "weapon", Rarity = "uncommon", Name = "Battle Axe",       Glyph = "🪓", PowerBonus = 3, DefenseBonus = 0, GoldValue = 70,  WeaponType = "axe",     PreferredClass = "warrior" },
            new LootDef { Slot = "weapon", Rarity = "uncommon", Name = "Steel Maul",       Glyph = "🔨", PowerBonus = 3, DefenseBonus = 0, GoldValue = 68,  WeaponType = "hammer",  PreferredClass = "warrior" },
            new LootDef { Slot = "weapon", Rarity = "uncommon", Name = "Iron Halberd",     Glyph = "⚔",  PowerBonus = 3, DefenseBonus = 1, GoldValue = 78,  WeaponType = "polearm", PreferredClass = "warrior" },
            new LootDef { Slot = "weapon", Rarity = "uncommon", Name = "Hunter's Bow",     Glyph = "🏹", PowerBonus = 2, DefenseBonus = 0, GoldValue = 60,  WeaponType = "bow",     PreferredClass = "ranger" },
            new LootDef { Slot = "weapon", Rarity = "uncommon", Name = "Yew Longbow",      Glyph = "🏹", PowerBonus = 3, DefenseBonus = 0, GoldValue = 70,  WeaponType = "bow",     PreferredClass = "ranger" },
            new LootDef { Slot = "weapon", Rarity = "uncommon", Name = "Hand Crossbow",    Glyph = "🎯", PowerBonus = 3, DefenseBonus = 0, GoldValue = 72,  WeaponType = "crossbow", PreferredClass = "ranger" },
            new LootDef { Slot = "weapon", Rarity = "uncommon", Name = "Stiletto",         Glyph = "🗡", PowerBonus = 2, DefenseBonus = 0, GoldValue = 60,  WeaponType = "dagger",  PreferredClass = "rogue" },
            new LootDef { Slot = "weapon", Rarity = "uncommon", Name = "Pair of Daggers",  Glyph = "🗡", PowerBonus = 3, DefenseBonus = 0, GoldValue = 70,  WeaponType = "dagger",  PreferredClass = "rogue" },
            new LootDef { Slot = "weapon", Rarity = "uncommon", Name = "Apprentice Tome",  Glyph = "📕", PowerBonus = 2, DefenseBonus = 0, GoldValue = 70,  WeaponType = "tome",    PreferredClass = "mage" },
            new LootDef { Slot = "weapon", Rarity = "uncommon", Name = "Crystal Wand",     Glyph = "🪄", PowerBonus = 3, DefenseBonus = 0, GoldValue = 75,  WeaponType = "wand",    PreferredClass = "mage" },
            new LootDef { Slot = "weapon", Rarity = "uncommon", Name = "Apprentice Staff", Glyph = "🥢", PowerBonus = 2, DefenseBonus = 1, GoldValue = 70,  WeaponType = "staff",   PreferredClass = "mage" },
            new LootDef { Slot = "weapon", Rarity = "uncommon", Name = "Glass Orb",        Glyph = "🔮", PowerBonus = 2, DefenseBonus = 1, GoldValue = 72,  WeaponType = "orb",     PreferredClass = "mage" },
            new LootDef { Slot = "weapon", Rarity = "uncommon", Name = "Healer's Cane",    Glyph = "🪄", PowerBonus = 1, DefenseBonus = 2, GoldValue = 68,  WeaponType = "staff",   PreferredClass = "healer" },
            new LootDef { Slot = "weapon", Rarity = "uncommon", Name = "Oaken Holy Symbol", Glyph = "✝",  PowerBonus = 2, DefenseBonus = 1, GoldValue = 70,  WeaponType = "holy",   PreferredClass = "healer" },

            // Ironclad set (warrior-preferred, 4 pieces — gates the warrior bonus when complete)
            new LootDef { Slot = "head",   Rarity = "uncommon", Name = "Iron Helm",        Glyph = "⛑",  PowerBonus = 0, DefenseBonus = 2, GoldValue = 55, SetName = "ironclad", PreferredClass = "warrior" },
            new LootDef { Slot = "chest",  Rarity = "uncommon", Name = "Chainmail",        Glyph = "🦺", PowerBonus = 0, DefenseBonus = 2, GoldValue = 60, SetName = "ironclad", PreferredClass = "warrior" },
            new LootDef { Slot = "legs",   Rarity = "uncommon", Name = "Iron Greaves",     Glyph = "🦿", PowerBonus = 0, DefenseBonus = 2, GoldValue = 55, SetName = "ironclad", PreferredClass = "warrior" },
            new LootDef { Slot = "boots",  Rarity = "uncommon", Name = "Iron Sabatons",    Glyph = "👢", PowerBonus = 0, DefenseBonus = 2, GoldValue = 55, SetName = "ironclad", PreferredClass = "warrior" },
            new LootDef { Slot = "trinket", Rarity = "uncommon", Name = "Iron Ring",       Glyph = "💍", PowerBonus = 0, DefenseBonus = 2, GoldValue = 75, SetName = "ironclad", PreferredClass = "warrior" },

            // Arcane set (mage-preferred — robes + circlet)
            new LootDef { Slot = "head",   Rarity = "uncommon", Name = "Mage's Circlet",   Glyph = "🔮", PowerBonus = 1, DefenseBonus = 1, GoldValue = 70, SetName = "arcane", PreferredClass = "mage" },
            new LootDef { Slot = "chest",  Rarity = "uncommon", Name = "Arcane Robes",     Glyph = "🥋", PowerBonus = 1, DefenseBonus = 1, GoldValue = 70, SetName = "arcane", PreferredClass = "mage" },
            new LootDef { Slot = "legs",   Rarity = "uncommon", Name = "Arcane Skirt",     Glyph = "🧣", PowerBonus = 1, DefenseBonus = 1, GoldValue = 65, SetName = "arcane", PreferredClass = "mage" },
            new LootDef { Slot = "boots",  Rarity = "uncommon", Name = "Arcane Slippers",  Glyph = "🥿", PowerBonus = 1, DefenseBonus = 1, GoldValue = 60, SetName = "arcane", PreferredClass = "mage" },

            // Forester set (ranger-preferred — leathers)
            new LootDef { Slot = "head",   Rarity = "uncommon", Name = "Forester's Cap",   Glyph = "🧢", PowerBonus = 1, DefenseBonus = 1, GoldValue = 60, SetName = "forester", PreferredClass = "ranger" },
            new LootDef { Slot = "chest",  Rarity = "uncommon", Name = "Hunter's Garb",    Glyph = "🦺", PowerBonus = 1, DefenseBonus = 1, GoldValue = 65, SetName = "forester", PreferredClass = "ranger" },
            new LootDef { Slot = "legs",   Rarity = "uncommon", Name = "Forest Trousers",  Glyph = "👖", PowerBonus = 1, DefenseBonus = 1, GoldValue = 60, SetName = "forester", PreferredClass = "ranger" },
            new LootDef { Slot = "boots",  Rarity = "uncommon", Name = "Soft Soles",       Glyph = "🥾", PowerBonus = 1, DefenseBonus = 1, GoldValue = 58, SetName = "forester", PreferredClass = "ranger" },

            // Vestal set (healer-preferred — white robes)
            new LootDef { Slot = "head",   Rarity = "uncommon", Name = "Holy Coif",        Glyph = "🥽", PowerBonus = 0, DefenseBonus = 2, GoldValue = 65, SetName = "vestal", PreferredClass = "healer" },
            new LootDef { Slot = "chest",  Rarity = "uncommon", Name = "Vestal Robes",     Glyph = "👘", PowerBonus = 0, DefenseBonus = 2, GoldValue = 70, SetName = "vestal", PreferredClass = "healer" },
            new LootDef { Slot = "legs",   Rarity = "uncommon", Name = "Vestal Skirt",     Glyph = "🧣", PowerBonus = 0, DefenseBonus = 2, GoldValue = 60, SetName = "vestal", PreferredClass = "healer" },
            new LootDef { Slot = "boots",  Rarity = "uncommon", Name = "Vestal Slippers",  Glyph = "🩰", PowerBonus = 0, DefenseBonus = 2, GoldValue = 55, SetName = "vestal", PreferredClass = "healer" },

            // Standalone uncommon trinkets
            new LootDef { Slot = "trinket", Rarity = "uncommon", Name = "Lucky Charm",     Glyph = "🍀", PowerBonus = 1, DefenseBonus = 1, GoldValue = 70 },
            new LootDef { Slot = "trinket", Rarity = "uncommon", Name = "Owl Pendant",     Glyph = "🦉", PowerBonus = 1, DefenseBonus = 1, GoldValue = 72 },
            new LootDef { Slot = "trinket", Rarity = "uncommon", Name = "Compass",         Glyph = "🧭", PowerBonus = 0, DefenseBonus = 2, GoldValue = 70 },

            // ─────────────────────────────── RARE ─────────────────────────────
            // Class-themed rare weapons. Each class gets 3-4 distinct types.
            new LootDef { Slot = "weapon", Rarity = "rare", Name = "Frost Hammer",       Glyph = "🔨", PowerBonus = 4, DefenseBonus = 0, GoldValue = 180, WeaponType = "hammer", PreferredClass = "warrior" },
            new LootDef { Slot = "weapon", Rarity = "rare", Name = "Flamberge",          Glyph = "⚔",  PowerBonus = 5, DefenseBonus = 0, GoldValue = 200, WeaponType = "sword",  PreferredClass = "warrior" },
            new LootDef { Slot = "weapon", Rarity = "rare", Name = "Greataxe",           Glyph = "🪓", PowerBonus = 5, DefenseBonus = 0, GoldValue = 195, WeaponType = "axe",    PreferredClass = "warrior" },
            new LootDef { Slot = "weapon", Rarity = "rare", Name = "Steel Halberd",      Glyph = "⚔",  PowerBonus = 4, DefenseBonus = 1, GoldValue = 200, WeaponType = "polearm", PreferredClass = "warrior" },
            new LootDef { Slot = "weapon", Rarity = "rare", Name = "Wraithblade",        Glyph = "🗡", PowerBonus = 4, DefenseBonus = 1, GoldValue = 195, WeaponType = "dagger", PreferredClass = "rogue" },
            new LootDef { Slot = "weapon", Rarity = "rare", Name = "Shadow Daggers",     Glyph = "🗡", PowerBonus = 5, DefenseBonus = 0, GoldValue = 210, WeaponType = "dagger", PreferredClass = "rogue", SetName = "shadow" },
            new LootDef { Slot = "weapon", Rarity = "rare", Name = "Silver Crossbow",    Glyph = "🎯", PowerBonus = 4, DefenseBonus = 0, GoldValue = 180, WeaponType = "crossbow", PreferredClass = "ranger" },
            new LootDef { Slot = "weapon", Rarity = "rare", Name = "Composite Longbow",  Glyph = "🏹", PowerBonus = 5, DefenseBonus = 0, GoldValue = 200, WeaponType = "bow",    PreferredClass = "ranger" },
            new LootDef { Slot = "weapon", Rarity = "rare", Name = "Shadow Staff",       Glyph = "🪄", PowerBonus = 4, DefenseBonus = 1, GoldValue = 195, WeaponType = "staff",  PreferredClass = "mage" },
            new LootDef { Slot = "weapon", Rarity = "rare", Name = "Druid's Staff",      Glyph = "🌿", PowerBonus = 3, DefenseBonus = 2, GoldValue = 195, WeaponType = "staff",  PreferredClass = "mage" },
            new LootDef { Slot = "weapon", Rarity = "rare", Name = "Crystal Orb",        Glyph = "🔮", PowerBonus = 4, DefenseBonus = 1, GoldValue = 200, WeaponType = "orb",    PreferredClass = "mage" },
            new LootDef { Slot = "weapon", Rarity = "rare", Name = "Forbidden Tome",     Glyph = "📕", PowerBonus = 4, DefenseBonus = 1, GoldValue = 205, WeaponType = "tome",   PreferredClass = "mage" },
            new LootDef { Slot = "weapon", Rarity = "rare", Name = "Sun Cross",          Glyph = "✝",  PowerBonus = 3, DefenseBonus = 2, GoldValue = 200, WeaponType = "holy",   PreferredClass = "healer" },
            new LootDef { Slot = "weapon", Rarity = "rare", Name = "Healing Staff",      Glyph = "🥢", PowerBonus = 2, DefenseBonus = 3, GoldValue = 200, WeaponType = "staff",  PreferredClass = "healer" },

            // Knight's set (warrior — proper plate, rare-tier)
            new LootDef { Slot = "head",   Rarity = "rare", Name = "Knight's Helm",       Glyph = "⛑",  PowerBonus = 1, DefenseBonus = 4, GoldValue = 200, SetName = "knights", PreferredClass = "warrior" },
            new LootDef { Slot = "chest",  Rarity = "rare", Name = "Knight's Cuirass",    Glyph = "🛡", PowerBonus = 1, DefenseBonus = 4, GoldValue = 220, SetName = "knights", PreferredClass = "warrior" },
            new LootDef { Slot = "legs",   Rarity = "rare", Name = "Knight's Tassets",    Glyph = "🦿", PowerBonus = 1, DefenseBonus = 4, GoldValue = 200, SetName = "knights", PreferredClass = "warrior" },
            new LootDef { Slot = "boots",  Rarity = "rare", Name = "Knight's Sabatons",   Glyph = "👢", PowerBonus = 1, DefenseBonus = 4, GoldValue = 195, SetName = "knights", PreferredClass = "warrior" },

            // Dragonscale set (warrior-preferred but mage-friendly — mixed armour)
            new LootDef { Slot = "head",   Rarity = "rare", Name = "Dragon Helm",         Glyph = "🐉", PowerBonus = 1, DefenseBonus = 4, GoldValue = 220, SetName = "dragonscale", PreferredClass = "warrior" },
            new LootDef { Slot = "chest",  Rarity = "rare", Name = "Dragonscale Plate",   Glyph = "🐲", PowerBonus = 2, DefenseBonus = 4, GoldValue = 240, SetName = "dragonscale", PreferredClass = "warrior" },
            new LootDef { Slot = "legs",   Rarity = "rare", Name = "Dragonscale Tassets", Glyph = "🐲", PowerBonus = 1, DefenseBonus = 4, GoldValue = 220, SetName = "dragonscale", PreferredClass = "warrior" },

            // Druidic set (ranger-preferred — leaf themed)
            new LootDef { Slot = "head",   Rarity = "rare", Name = "Antlered Hood",       Glyph = "🦌", PowerBonus = 2, DefenseBonus = 3, GoldValue = 200, SetName = "druidic", PreferredClass = "ranger" },
            new LootDef { Slot = "chest",  Rarity = "rare", Name = "Druidic Robes",       Glyph = "🌿", PowerBonus = 2, DefenseBonus = 3, GoldValue = 220, SetName = "druidic", PreferredClass = "ranger" },
            new LootDef { Slot = "legs",   Rarity = "rare", Name = "Druidic Pants",       Glyph = "🍃", PowerBonus = 2, DefenseBonus = 3, GoldValue = 200, SetName = "druidic", PreferredClass = "ranger" },
            new LootDef { Slot = "boots",  Rarity = "rare", Name = "Mossfoot Boots",      Glyph = "🍂", PowerBonus = 2, DefenseBonus = 3, GoldValue = 195, SetName = "druidic", PreferredClass = "ranger" },

            // Sun-touched set (healer — gold-trimmed white)
            new LootDef { Slot = "head",   Rarity = "rare", Name = "Sun Crown",           Glyph = "☀",  PowerBonus = 1, DefenseBonus = 4, GoldValue = 210, SetName = "suntouched", PreferredClass = "healer" },
            new LootDef { Slot = "chest",  Rarity = "rare", Name = "Sun-touched Robes",   Glyph = "👘", PowerBonus = 1, DefenseBonus = 4, GoldValue = 230, SetName = "suntouched", PreferredClass = "healer" },
            new LootDef { Slot = "legs",   Rarity = "rare", Name = "Sun-touched Skirt",   Glyph = "🧣", PowerBonus = 1, DefenseBonus = 4, GoldValue = 210, SetName = "suntouched", PreferredClass = "healer" },

            // Stormcaller set (mage — lightning-themed)
            new LootDef { Slot = "head",   Rarity = "rare", Name = "Stormcaller Cowl",    Glyph = "⛈", PowerBonus = 3, DefenseBonus = 2, GoldValue = 215, SetName = "stormcaller", PreferredClass = "mage" },
            new LootDef { Slot = "chest",  Rarity = "rare", Name = "Stormcaller Vest",    Glyph = "⚡", PowerBonus = 3, DefenseBonus = 2, GoldValue = 230, SetName = "stormcaller", PreferredClass = "mage" },
            new LootDef { Slot = "trinket", Rarity = "rare", Name = "Storm Sigil",        Glyph = "⚡", PowerBonus = 3, DefenseBonus = 2, GoldValue = 220, SetName = "stormcaller", PreferredClass = "mage" },

            // Standalone rare gear
            new LootDef { Slot = "chest",  Rarity = "rare", Name = "Plated Cuirass",      Glyph = "🛡", PowerBonus = 1, DefenseBonus = 4, GoldValue = 220 },
            new LootDef { Slot = "boots",  Rarity = "rare", Name = "Stormstride Boots",   Glyph = "⛈", PowerBonus = 1, DefenseBonus = 3, GoldValue = 200 },
            new LootDef { Slot = "trinket", Rarity = "rare", Name = "Healing Amulet",     Glyph = "📿", PowerBonus = 0, DefenseBonus = 3, GoldValue = 220 },
            new LootDef { Slot = "trinket", Rarity = "rare", Name = "Shadow Cloak Pin",   Glyph = "🎗", PowerBonus = 2, DefenseBonus = 2, GoldValue = 240, SetName = "shadow", PreferredClass = "rogue" },
            new LootDef { Slot = "trinket", Rarity = "rare", Name = "Phoenix Down",       Glyph = "🔥", PowerBonus = 2, DefenseBonus = 2, GoldValue = 230 },
            new LootDef { Slot = "trinket", Rarity = "rare", Name = "Wolf Tooth",         Glyph = "🐺", PowerBonus = 2, DefenseBonus = 2, GoldValue = 220 },
            new LootDef { Slot = "trinket", Rarity = "rare", Name = "Forest Pendant",     Glyph = "🍃", PowerBonus = 2, DefenseBonus = 2, GoldValue = 220, SetName = "druidic", PreferredClass = "ranger" },
            new LootDef { Slot = "trinket", Rarity = "rare", Name = "Vestal Pendant",     Glyph = "📿", PowerBonus = 1, DefenseBonus = 3, GoldValue = 220, SetName = "vestal", PreferredClass = "healer" },

            // ─────────────────────────────── EPIC ─────────────────────────────
            new LootDef { Slot = "weapon", Rarity = "epic", Name = "Drakebane Sword",     Glyph = "🗡", PowerBonus = 7, DefenseBonus = 1, GoldValue = 600, WeaponType = "sword",  PreferredClass = "warrior" },
            new LootDef { Slot = "weapon", Rarity = "epic", Name = "Soulreaver",          Glyph = "💀", PowerBonus = 8, DefenseBonus = 0, GoldValue = 650, WeaponType = "sword",  PreferredClass = "warrior" },
            new LootDef { Slot = "weapon", Rarity = "epic", Name = "Doomhammer",          Glyph = "🔨", PowerBonus = 8, DefenseBonus = 1, GoldValue = 660, WeaponType = "hammer", PreferredClass = "warrior" },
            new LootDef { Slot = "weapon", Rarity = "epic", Name = "Cleaver of Kings",    Glyph = "🪓", PowerBonus = 8, DefenseBonus = 0, GoldValue = 640, WeaponType = "axe",    PreferredClass = "warrior" },
            new LootDef { Slot = "weapon", Rarity = "epic", Name = "Stormcaller Staff",   Glyph = "⚡", PowerBonus = 7, DefenseBonus = 2, GoldValue = 680, WeaponType = "staff",  PreferredClass = "mage", SetName = "stormcaller" },
            new LootDef { Slot = "weapon", Rarity = "epic", Name = "Grimoire of Storms",  Glyph = "📘", PowerBonus = 7, DefenseBonus = 2, GoldValue = 680, WeaponType = "tome",   PreferredClass = "mage" },
            new LootDef { Slot = "weapon", Rarity = "epic", Name = "Voidcaller Wand",     Glyph = "🪄", PowerBonus = 8, DefenseBonus = 1, GoldValue = 690, WeaponType = "wand",   PreferredClass = "mage" },
            new LootDef { Slot = "weapon", Rarity = "epic", Name = "Vorpal Bow",          Glyph = "🏹", PowerBonus = 8, DefenseBonus = 0, GoldValue = 650, WeaponType = "bow",    PreferredClass = "ranger" },
            new LootDef { Slot = "weapon", Rarity = "epic", Name = "Skywatcher Crossbow", Glyph = "🎯", PowerBonus = 8, DefenseBonus = 0, GoldValue = 660, WeaponType = "crossbow", PreferredClass = "ranger" },
            new LootDef { Slot = "weapon", Rarity = "epic", Name = "Whisperblades",       Glyph = "🗡", PowerBonus = 8, DefenseBonus = 0, GoldValue = 660, WeaponType = "dagger", PreferredClass = "rogue" },
            new LootDef { Slot = "weapon", Rarity = "epic", Name = "Heartseeker",         Glyph = "🗡", PowerBonus = 9, DefenseBonus = 0, GoldValue = 700, WeaponType = "dagger", PreferredClass = "rogue" },
            new LootDef { Slot = "weapon", Rarity = "epic", Name = "Phoenix Staff",       Glyph = "🔥", PowerBonus = 6, DefenseBonus = 4, GoldValue = 700, WeaponType = "staff",  PreferredClass = "healer" },

            // Voidweave set (mage-preferred — full set epic-tier)
            new LootDef { Slot = "head",   Rarity = "epic", Name = "Voidweave Hood",      Glyph = "🌑", PowerBonus = 4, DefenseBonus = 3, GoldValue = 660, SetName = "voidweave", PreferredClass = "mage" },
            new LootDef { Slot = "chest",  Rarity = "epic", Name = "Voidweave Robe",      Glyph = "🌑", PowerBonus = 4, DefenseBonus = 4, GoldValue = 700, SetName = "voidweave", PreferredClass = "mage" },
            new LootDef { Slot = "legs",   Rarity = "epic", Name = "Voidweave Skirt",     Glyph = "🌑", PowerBonus = 4, DefenseBonus = 3, GoldValue = 660, SetName = "voidweave", PreferredClass = "mage" },
            new LootDef { Slot = "boots",  Rarity = "epic", Name = "Voidweave Slippers",  Glyph = "🌑", PowerBonus = 3, DefenseBonus = 3, GoldValue = 620, SetName = "voidweave", PreferredClass = "mage" },

            // Shadow set (rogue-preferred)
            new LootDef { Slot = "head",   Rarity = "epic", Name = "Shadow Cowl",         Glyph = "🥷", PowerBonus = 3, DefenseBonus = 4, GoldValue = 660, SetName = "shadow", PreferredClass = "rogue" },
            new LootDef { Slot = "chest",  Rarity = "epic", Name = "Shadow Cuirass",      Glyph = "🌙", PowerBonus = 3, DefenseBonus = 5, GoldValue = 700, SetName = "shadow", PreferredClass = "rogue" },
            new LootDef { Slot = "legs",   Rarity = "epic", Name = "Shadow Trousers",     Glyph = "🌑", PowerBonus = 3, DefenseBonus = 4, GoldValue = 660, SetName = "shadow", PreferredClass = "rogue" },
            new LootDef { Slot = "boots",  Rarity = "epic", Name = "Shadowstep Boots",    Glyph = "👞", PowerBonus = 4, DefenseBonus = 3, GoldValue = 680, SetName = "shadow", PreferredClass = "rogue" },

            // Highborn set (warrior — gilded plate, epic tier)
            new LootDef { Slot = "head",   Rarity = "epic", Name = "Highborn Helm",       Glyph = "👑", PowerBonus = 3, DefenseBonus = 5, GoldValue = 700, SetName = "highborn", PreferredClass = "warrior" },
            new LootDef { Slot = "chest",  Rarity = "epic", Name = "Highborn Plate",      Glyph = "🛡", PowerBonus = 3, DefenseBonus = 6, GoldValue = 740, SetName = "highborn", PreferredClass = "warrior" },
            new LootDef { Slot = "legs",   Rarity = "epic", Name = "Highborn Tassets",    Glyph = "🦿", PowerBonus = 3, DefenseBonus = 5, GoldValue = 700, SetName = "highborn", PreferredClass = "warrior" },
            new LootDef { Slot = "boots",  Rarity = "epic", Name = "Highborn Sabatons",   Glyph = "👢", PowerBonus = 3, DefenseBonus = 5, GoldValue = 680, SetName = "highborn", PreferredClass = "warrior" },

            // Standalone epic gear
            new LootDef { Slot = "head",   Rarity = "epic", Name = "Wyvern Crown",        Glyph = "👑", PowerBonus = 2, DefenseBonus = 5, GoldValue = 600 },
            new LootDef { Slot = "boots",  Rarity = "epic", Name = "Sevenleague Boots",   Glyph = "👢", PowerBonus = 2, DefenseBonus = 5, GoldValue = 660 },
            new LootDef { Slot = "trinket", Rarity = "epic", Name = "Phoenix Feather",    Glyph = "🪶", PowerBonus = 3, DefenseBonus = 4, GoldValue = 660 },
            new LootDef { Slot = "trinket", Rarity = "epic", Name = "Soul Lantern",       Glyph = "🏮", PowerBonus = 4, DefenseBonus = 3, GoldValue = 720 },
            new LootDef { Slot = "trinket", Rarity = "epic", Name = "Storm Heart",        Glyph = "⚡", PowerBonus = 4, DefenseBonus = 3, GoldValue = 700 },
            new LootDef { Slot = "trinket", Rarity = "epic", Name = "Voidstone",          Glyph = "🌑", PowerBonus = 5, DefenseBonus = 2, GoldValue = 680, SetName = "voidweave", PreferredClass = "mage" },
            new LootDef { Slot = "trinket", Rarity = "epic", Name = "Shadow Mask",        Glyph = "🎭", PowerBonus = 4, DefenseBonus = 3, GoldValue = 690, SetName = "shadow", PreferredClass = "rogue" },

            // ─────────────────────────────── LEGENDARY ────────────────────────
            new LootDef { Slot = "weapon", Rarity = "legendary", Name = "Aquilo's Edge",  Glyph = "⚡", PowerBonus = 12, DefenseBonus = 2, GoldValue = 1800, WeaponType = "sword",  PreferredClass = "warrior" },
            new LootDef { Slot = "weapon", Rarity = "legendary", Name = "Worldbreaker",   Glyph = "🌋", PowerBonus = 14, DefenseBonus = 1, GoldValue = 2100, WeaponType = "hammer", PreferredClass = "warrior" },
            new LootDef { Slot = "weapon", Rarity = "legendary", Name = "Dawnbreaker",    Glyph = "☀",  PowerBonus = 13, DefenseBonus = 2, GoldValue = 2000, WeaponType = "sword",  PreferredClass = "warrior" },
            new LootDef { Slot = "weapon", Rarity = "legendary", Name = "Staff of the Void", Glyph = "🌑", PowerBonus = 12, DefenseBonus = 4, GoldValue = 2150, WeaponType = "staff", PreferredClass = "mage" },
            new LootDef { Slot = "weapon", Rarity = "legendary", Name = "Tome of Eternity", Glyph = "📕", PowerBonus = 13, DefenseBonus = 3, GoldValue = 2050, WeaponType = "tome",  PreferredClass = "mage" },
            new LootDef { Slot = "weapon", Rarity = "legendary", Name = "Bow of the North Star", Glyph = "🌟", PowerBonus = 13, DefenseBonus = 2, GoldValue = 2100, WeaponType = "bow", PreferredClass = "ranger" },
            new LootDef { Slot = "weapon", Rarity = "legendary", Name = "Whisperdeath",   Glyph = "🗡", PowerBonus = 14, DefenseBonus = 0, GoldValue = 2050, WeaponType = "dagger", PreferredClass = "rogue" },
            new LootDef { Slot = "weapon", Rarity = "legendary", Name = "Sunlance",       Glyph = "✝",  PowerBonus = 11, DefenseBonus = 5, GoldValue = 2100, WeaponType = "holy",   PreferredClass = "healer" },

            // Standalone legendary
            new LootDef { Slot = "head",   Rarity = "legendary", Name = "Crown of Aeons", Glyph = "👑", PowerBonus = 4, DefenseBonus = 8, GoldValue = 2100 },
            new LootDef { Slot = "chest",  Rarity = "legendary", Name = "Aegis Plate",    Glyph = "🛡", PowerBonus = 3, DefenseBonus = 10, GoldValue = 2150 },
            new LootDef { Slot = "trinket", Rarity = "legendary", Name = "Bolt Sigil",    Glyph = "💎", PowerBonus = 6, DefenseBonus = 6, GoldValue = 2100 },

            // ─────────────────────────────── MYTHIC ───────────────────────────
            new LootDef { Slot = "weapon", Rarity = "mythic", Name = "Reality Splitter",   Glyph = "✨", PowerBonus = 20, DefenseBonus = 4, GoldValue = 5000, WeaponType = "sword", PreferredClass = "warrior" },
            new LootDef { Slot = "weapon", Rarity = "mythic", Name = "Voidpiercer",        Glyph = "🌑", PowerBonus = 18, DefenseBonus = 6, GoldValue = 5000, WeaponType = "staff", PreferredClass = "mage" },
            new LootDef { Slot = "weapon", Rarity = "mythic", Name = "Shadow of the End",  Glyph = "🗡", PowerBonus = 22, DefenseBonus = 2, GoldValue = 5200, WeaponType = "dagger", PreferredClass = "rogue" },
            new LootDef { Slot = "trinket", Rarity = "mythic", Name = "Heart of the Void", Glyph = "🖤", PowerBonus = 10, DefenseBonus = 10, GoldValue = 5000 },
            new LootDef { Slot = "trinket", Rarity = "mythic", Name = "Aquilo's Mark",     Glyph = "🌟", PowerBonus = 12, DefenseBonus = 8,  GoldValue = 5200 }
        };

        /// <summary>Picks a rarity bucket given dungeon difficulty (1..5).
        /// Higher difficulty pushes the curve right toward epic/legendary.
        /// Mythic is intentionally excluded — only bosses drop it.</summary>
        public static string RollRarity(Random r, int difficulty)
        {
            int[] weights;
            if (difficulty <= 1)      weights = new[] { 70, 22, 6, 2, 0, 0 };
            else if (difficulty == 2) weights = new[] { 55, 28, 12, 4, 1, 0 };
            else if (difficulty == 3) weights = new[] { 40, 32, 18, 8, 2, 0 };
            else if (difficulty == 4) weights = new[] { 28, 32, 24, 13, 3, 0 };
            else                      weights = new[] { 18, 30, 28, 20, 4, 0 };
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

        /// <summary>Pick a monster from the pool that fits both the dungeon
        /// biome and the difficulty tier. Falls back to "any"-biome if a
        /// pure biome filter would leave nothing in range.</summary>
        public static MonsterDef PickMonster(Random r, int difficulty, string biome = "any", bool boss = false)
        {
            var d = Math.Max(1, Math.Min(5, difficulty));
            var pool = Monsters
                .Where(m => m.IsBoss == boss)
                .Where(m => m.DifficultyTier <= d + 1)              // allow up to one tier above
                .Where(m => m.DifficultyTier >= Math.Max(1, d - 1)) // and one tier below
                .Where(m => string.IsNullOrEmpty(biome) || m.Biome == "any" || m.Biome == biome)
                .ToArray();
            // If the biome filter would empty the pool (e.g. tier-1 biome
            // with no biome-tagged monster), widen to "any" rather than
            // silently failing.
            if (pool.Length == 0)
                pool = Monsters.Where(m => m.IsBoss == boss && m.DifficultyTier <= d + 1).ToArray();
            if (pool.Length == 0) pool = new[] { Monsters[0] };
            return pool[r.Next(pool.Length)];
        }

        /// <summary>Pick a trap that fits the dungeon biome (or "any").</summary>
        public static TrapDef PickTrap(Random r, string biome = "any")
        {
            var pool = Traps.Where(t => t.Biome == "any" || t.Biome == biome).ToArray();
            if (pool.Length == 0) pool = Traps;
            return pool[r.Next(pool.Length)];
        }

        public static LootDef PickLootByRarity(Random r, string rarity)
        {
            var pool = Loot.Where(l => l.Rarity == rarity).ToArray();
            if (pool.Length == 0) pool = Loot;
            return pool[r.Next(pool.Length)];
        }

        // ── Dungeon types ──────────────────────────────────────────────
        public sealed class DungeonType
        {
            public string Name;
            public string Biome;
            public string Theme;        // short adjective for scene flavour ("an undead", "a frozen")
        }

        public static readonly DungeonType[] DungeonTypes = new[]
        {
            new DungeonType { Name = "Crypt of Whispers",    Biome = "undead",     Theme = "an undead" },
            new DungeonType { Name = "Sunken Vault",         Biome = "water",      Theme = "a flooded" },
            new DungeonType { Name = "Forgotten Catacombs",  Biome = "undead",     Theme = "a forgotten" },
            new DungeonType { Name = "Wyvern's Hollow",      Biome = "dragon",     Theme = "a dragon-haunted" },
            new DungeonType { Name = "Skyreach Spire",       Biome = "sky",        Theme = "a wind-swept" },
            new DungeonType { Name = "Bonemarsh Depths",     Biome = "swamp",      Theme = "a rotting" },
            new DungeonType { Name = "Howling Mines",        Biome = "earth",      Theme = "a deep" },
            new DungeonType { Name = "Iron Shrine",          Biome = "construct",  Theme = "an automaton" },
            new DungeonType { Name = "Ashfall Pits",         Biome = "fire",       Theme = "a burning" },
            new DungeonType { Name = "Frostpeak Caverns",    Biome = "ice",        Theme = "a frozen" },
            new DungeonType { Name = "Verdant Sanctum",      Biome = "nature",     Theme = "an overgrown" },
            new DungeonType { Name = "Void Reliquary",       Biome = "void",       Theme = "a void-touched" }
        };

        public static DungeonType PickDungeonType(Random r)
        {
            return DungeonTypes[r.Next(DungeonTypes.Length)];
        }

        // ── Scenes (story flavour) ─────────────────────────────────────
        // Story scenes are pure flavour — no HP/XP changes — woven between
        // mechanical scenes so the chat narrative reads as a journey, not
        // a slot machine.
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
            "The walls feel warmer here...",
            "A faint melody hums up from below.",
            "Old armour rattles in a forgotten corner.",
            "Glowing eyes blink and vanish.",
            "A prayer is scrawled on the stones.",
            "Something massive shifts in the dark.",
            "Wax pools from candles long since burned out.",
            "Petals from impossible flowers carpet the floor.",
            "A shrine to a forgotten god stands silent.",
            "Mushrooms light the path with pale blue.",
            "A gust of cold air races past the party.",
            "Crystal veins pulse in the walls.",
            "Bones arrange themselves into a circle.",
            "A skull on a pike turns to follow you.",
            "The ground here is unnaturally smooth.",
            "Distant thunder rumbles even underground.",
            "A locked grate blocks one passage.",
            "Coins from a dead empire scatter underfoot.",
            "Carved warnings line the next chamber.",
            "Statues seem to watch the party pass.",
            "Wind howls through unseen cracks."
        };

        // ── NPC encounters (a wandering merchant / prisoner / hero) ────
        public sealed class NpcDef
        {
            public string Name;
            public string Glyph;
            public string OfferKind;      // "trade" | "buff" | "join" | "warn"
            public string FlavorText;     // template with {user} placeholder
            public int    GoldDelta;      // for trade outcomes (negative = fee, positive = reward)
            public int    HpDelta;        // for buff/heal outcomes
        }

        public static readonly NpcDef[] Npcs = new[]
        {
            new NpcDef { Name = "Wandering Merchant", Glyph = "🧙", OfferKind = "trade", FlavorText = "A wandering merchant offers strange wares — the party haggles for a deal.", GoldDelta = 10, HpDelta = 0 },
            new NpcDef { Name = "Trapped Prisoner",   Glyph = "🔓", OfferKind = "join",  FlavorText = "The party frees a prisoner who slips them a small purse before fleeing.", GoldDelta = 18, HpDelta = 0 },
            new NpcDef { Name = "Old Healer",         Glyph = "💉", OfferKind = "buff",  FlavorText = "An old healer tends the party's wounds in exchange for a story.",        GoldDelta = 0,  HpDelta = 8  },
            new NpcDef { Name = "Lost Adventurer",    Glyph = "🗺", OfferKind = "warn",  FlavorText = "A wounded adventurer warns of dangers ahead and shares their map.",      GoldDelta = 5,  HpDelta = 0  },
            new NpcDef { Name = "Shrine Keeper",      Glyph = "⛩",  OfferKind = "buff",  FlavorText = "The shrine keeper blesses the party — wounds knit, spirits rise.",      GoldDelta = 0,  HpDelta = 12 },
            new NpcDef { Name = "Travelling Bard",    Glyph = "🎻", OfferKind = "buff",  FlavorText = "A travelling bard sings of heroes — the party feels emboldened.",       GoldDelta = 0,  HpDelta = 5  },
            new NpcDef { Name = "Goblin Tinker",      Glyph = "🛠",  OfferKind = "trade", FlavorText = "A goblin tinker swaps trinkets — coin clinks into the party's purse.",  GoldDelta = 14, HpDelta = 0  }
        };

        public static NpcDef PickNpc(Random r) => Npcs[r.Next(Npcs.Length)];

        // ── Shrines (random buffs) ─────────────────────────────────────
        public sealed class ShrineDef
        {
            public string Name;
            public string Glyph;
            public string FlavorText;
            public int    HpDelta;
            public int    XpDelta;
        }

        public static readonly ShrineDef[] Shrines = new[]
        {
            new ShrineDef { Name = "Shrine of Mending",   Glyph = "⛩",  FlavorText = "A glowing shrine restores the party's vitality.", HpDelta = 8,  XpDelta = 0  },
            new ShrineDef { Name = "Shrine of Wisdom",    Glyph = "🔮", FlavorText = "Ancient knowledge fills the party — they grow more capable.", HpDelta = 0, XpDelta = 12 },
            new ShrineDef { Name = "Shrine of the Star",  Glyph = "⭐", FlavorText = "A starlit shrine strengthens body and mind.",      HpDelta = 5,  XpDelta = 8 },
            new ShrineDef { Name = "Shrine of the Moon",  Glyph = "🌙", FlavorText = "Moonlight heals the party's deepest wounds.",     HpDelta = 12, XpDelta = 0 }
        };

        public static ShrineDef PickShrine(Random r) => Shrines[r.Next(Shrines.Length)];

        // ── Curses (negative buffs) ────────────────────────────────────
        public sealed class CurseDef
        {
            public string Name;
            public string Glyph;
            public string FlavorText;
            public int    HpDelta;       // typically negative
        }

        public static readonly CurseDef[] Curses = new[]
        {
            new CurseDef { Name = "Wraith's Whisper",   Glyph = "👻", FlavorText = "A wraith whispers the party's true names — they shudder.", HpDelta = -4 },
            new CurseDef { Name = "Hexed Coin",         Glyph = "💀", FlavorText = "Someone pockets a hexed coin — bad luck spreads through the party.", HpDelta = -3 },
            new CurseDef { Name = "Soul-Sap Sigil",     Glyph = "♨", FlavorText = "A soul-sap sigil drains the party's vitality.", HpDelta = -5 },
            new CurseDef { Name = "Nightmare Echo",     Glyph = "🌑", FlavorText = "Echoes of nightmares past chip at the party's resolve.", HpDelta = -3 }
        };

        public static CurseDef PickCurse(Random r) => Curses[r.Next(Curses.Length)];

        // ── Levelling ──────────────────────────────────────────────────
        // XP curve: 50 to L2, scales quadratically up to L50. Cap kept
        // at 50 because an active streamer's most-engaged viewers would
        // hit L10 in a couple of weeks at the old curve.
        public const int MaxLevel = 50;

        public static int XpForLevel(int level)
        {
            if (level <= 1) return 50;
            return 50 + (level - 1) * 35 + (level - 1) * (level - 1) * 8;
        }

        // ── Set bonuses ────────────────────────────────────────────────
        public sealed class SetDef
        {
            public string Name;
            public int    PiecesForBonus;     // typically 3-4
            public int    AtkBonus;
            public int    DefBonus;
            public int    HpBonus;
            public string DisplayName;
            // Class this set was designed for. When the wearer's
            // ClassName matches PreferredClass AND they have the full
            // piece count, the bonus is doubled — mismatched classes
            // get the base bonus only. Empty = no class affinity.
            public string PreferredClass;
        }

        public static readonly SetDef[] Sets = new[]
        {
            new SetDef { Name = "ironclad",    DisplayName = "Ironclad",    PiecesForBonus = 4, AtkBonus = 0, DefBonus = 4, HpBonus = 8,  PreferredClass = "warrior" },
            new SetDef { Name = "knights",     DisplayName = "Knight's",    PiecesForBonus = 4, AtkBonus = 2, DefBonus = 5, HpBonus = 5,  PreferredClass = "warrior" },
            new SetDef { Name = "highborn",    DisplayName = "Highborn",    PiecesForBonus = 4, AtkBonus = 3, DefBonus = 6, HpBonus = 10, PreferredClass = "warrior" },
            new SetDef { Name = "dragonscale", DisplayName = "Dragonscale", PiecesForBonus = 3, AtkBonus = 2, DefBonus = 3, HpBonus = 0,  PreferredClass = "warrior" },
            new SetDef { Name = "shadow",      DisplayName = "Shadow",      PiecesForBonus = 3, AtkBonus = 4, DefBonus = 1, HpBonus = 0,  PreferredClass = "rogue" },
            new SetDef { Name = "arcane",      DisplayName = "Arcane",      PiecesForBonus = 2, AtkBonus = 2, DefBonus = 2, HpBonus = 0,  PreferredClass = "mage" },
            new SetDef { Name = "voidweave",   DisplayName = "Voidweave",   PiecesForBonus = 4, AtkBonus = 5, DefBonus = 3, HpBonus = 0,  PreferredClass = "mage" },
            new SetDef { Name = "stormcaller", DisplayName = "Stormcaller", PiecesForBonus = 3, AtkBonus = 4, DefBonus = 2, HpBonus = 0,  PreferredClass = "mage" },
            new SetDef { Name = "forester",    DisplayName = "Forester",    PiecesForBonus = 4, AtkBonus = 2, DefBonus = 2, HpBonus = 5,  PreferredClass = "ranger" },
            new SetDef { Name = "druidic",     DisplayName = "Druidic",     PiecesForBonus = 4, AtkBonus = 3, DefBonus = 3, HpBonus = 5,  PreferredClass = "ranger" },
            new SetDef { Name = "vestal",      DisplayName = "Vestal",      PiecesForBonus = 4, AtkBonus = 0, DefBonus = 4, HpBonus = 10, PreferredClass = "healer" },
            new SetDef { Name = "suntouched",  DisplayName = "Sun-touched", PiecesForBonus = 3, AtkBonus = 2, DefBonus = 4, HpBonus = 10, PreferredClass = "healer" },
            new SetDef { Name = "wayfarer",    DisplayName = "Wayfarer",    PiecesForBonus = 4, AtkBonus = 1, DefBonus = 1, HpBonus = 3,  PreferredClass = "" }    // generic starter set
        };

        public static SetDef SetByName(string name)
        {
            if (string.IsNullOrWhiteSpace(name)) return null;
            var k = name.Trim().ToLowerInvariant();
            foreach (var s in Sets) if (s.Name == k) return s;
            return null;
        }

        // ── Achievements ───────────────────────────────────────────────
        public sealed class AchievementDef
        {
            public string Id;
            public string Name;
            public string Description;
            public string Glyph;
            public int    BoltsReward;
        }

        // Long-tail goals to chase. Tracked in HeroState.Achievements
        // (string set). Each unlock pays a one-time bolts bonus when
        // the condition first flips.
        public static readonly AchievementDef[] Achievements = new[]
        {
            new AchievementDef { Id = "first-blood",    Name = "First Blood",    Description = "Complete your first dungeon.",          Glyph = "🩸", BoltsReward = 25  },
            new AchievementDef { Id = "veteran",        Name = "Veteran",        Description = "Survive 10 dungeons.",                  Glyph = "🛡", BoltsReward = 100 },
            new AchievementDef { Id = "dungeoneer",     Name = "Dungeoneer",     Description = "Survive 50 dungeons.",                  Glyph = "🗺", BoltsReward = 500 },
            new AchievementDef { Id = "duelist",        Name = "Duelist",        Description = "Win 10 duels.",                          Glyph = "⚔",  BoltsReward = 75  },
            new AchievementDef { Id = "champion",       Name = "Champion",       Description = "Win 50 duels.",                          Glyph = "🏆", BoltsReward = 400 },
            new AchievementDef { Id = "legendkiller",   Name = "Legendkiller",   Description = "Slay a boss monster.",                   Glyph = "👑", BoltsReward = 200 },
            new AchievementDef { Id = "lootmaster",     Name = "Lootmaster",     Description = "Find a legendary item.",                Glyph = "💎", BoltsReward = 250 },
            new AchievementDef { Id = "myth-touched",   Name = "Myth-Touched",   Description = "Find a mythic item.",                   Glyph = "✨", BoltsReward = 1000 },
            new AchievementDef { Id = "set-collector",  Name = "Set Collector",  Description = "Equip a full armour set.",              Glyph = "🎽", BoltsReward = 200 },
            new AchievementDef { Id = "ascended",       Name = "Ascended",       Description = "Reach level 25.",                       Glyph = "🌟", BoltsReward = 600 },
            new AchievementDef { Id = "legendary-rank", Name = "Legendary",      Description = "Reach level 50.",                       Glyph = "🌠", BoltsReward = 2000 },
            new AchievementDef { Id = "explorer",       Name = "Explorer",       Description = "Visit every dungeon type.",             Glyph = "🧭", BoltsReward = 300 }
        };
    }
}
