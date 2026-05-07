using System;
using System.Collections.Generic;

namespace Loadout.Games.Dungeon
{
    /// <summary>
    /// Per-viewer RPG character state. JSON-serialized into the dungeon
    /// store keyed by "platform:handle" lowercase. Lives next to the
    /// Bolts wallet but kept separate so the wallet hot-path doesn't
    /// drag a 200-item inventory through every chat message.
    /// </summary>
    public sealed class HeroState
    {
        public string Platform   { get; set; } = "twitch";
        public string Handle     { get; set; } = "";

        // Per-viewer character look. Avatar is a URL (uploaded asset, the
        // viewer's Twitch profile picture, anything reachable from the
        // overlay's CEF). ClassName picks from DungeonContent.Classes —
        // drives a glyph + accent colour on the overlay and a tiny stat
        // bonus through Attack / Defense / HpMax. Both are cosmetic-by-
        // default — the hero still works if both are empty.
        public string Avatar     { get; set; } = "";
        public string ClassName  { get; set; } = "";

        // Free-form customization map — drives the composed pixel-art
        // sprite on the dungeon overlay. Known keys (extensible):
        //   skinTone     — fair / tan / olive / deep / pale-blue / pale-green
        //   hairColor    — black / brown / blonde / red / white / pink / blue / green
        //   hairStyle    — short / long / spiky / mohawk / braids / bald
        //   eyeColor     — brown / blue / green / amber / red
        //   primary      — class outfit primary hex (overrides class default)
        //   secondary    — class outfit secondary hex
        //   cape         — none / cloak / wing / scarf
        // Stored as a string dict so adding a new customization slider
        // doesn't bump the schema. Empty / missing key = use default.
        public Dictionary<string, string> Custom { get; set; } = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        public int    Level      { get; set; } = 1;
        public int    Xp         { get; set; } = 0;
        public int    HpMax      { get; set; } = 25;
        public int    HpCurrent  { get; set; } = 25;

        // Total dungeons survived; used for the "veteran" Discord title +
        // the summary card on the overlay.
        public int    DungeonsSurvived { get; set; } = 0;
        public int    DungeonsFallen   { get; set; } = 0;
        public int    DuelsWon         { get; set; } = 0;
        public int    DuelsLost        { get; set; } = 0;
        public int    BossesSlain      { get; set; } = 0;
        public int    LegendariesFound { get; set; } = 0;
        public int    MythicsFound     { get; set; } = 0;

        // Set of unlocked achievement ids (from DungeonContent.Achievements).
        // Held as a HashSet via List<string> for JSON-serializable simplicity.
        public List<string> Achievements { get; set; } = new List<string>();

        // Set of dungeon-type names visited at least once. Powers the
        // "Explorer" achievement and lets /loadout show progress toward
        // visiting every type.
        public List<string> DungeonsVisited { get; set; } = new List<string>();

        // The bag — every uncrafted item the hero owns. Equipped items
        // are duplicated by id-reference into Equipped.
        public List<InventoryItem> Bag      { get; set; } = new List<InventoryItem>();
        // slot -> item.Id. "weapon" / "head" / "chest" / "legs" / "boots"
        // / "trinket". Item must still exist in Bag.
        public Dictionary<string, string> Equipped { get; set; } = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        public DateTime LastUpdatedUtc { get; set; } = DateTime.UtcNow;
        public DateTime CreatedUtc     { get; set; } = DateTime.UtcNow;

        /// <summary>Total attack including equipped weapon + level scaling
        /// + class bonus + set bonus when the equipped pieces hit a set
        /// threshold.</summary>
        public int Attack(IReadOnlyDictionary<string, InventoryItem> bagById)
        {
            int gear = 0;
            foreach (var slot in Equipped)
            {
                if (bagById.TryGetValue(slot.Value, out var item)) gear += item.PowerBonus;
            }
            int classBonus = DungeonContent.ClassByName(ClassName)?.AtkBonus ?? 0;
            int setBonus   = SetBonus(bagById, b => b.AtkBonus);
            return 4 + (Level - 1) + gear + classBonus + setBonus;
        }

        /// <summary>Total defense including equipped armour + level scaling
        /// + class bonus + set bonus.</summary>
        public int Defense(IReadOnlyDictionary<string, InventoryItem> bagById)
        {
            int gear = 0;
            foreach (var slot in Equipped)
            {
                if (bagById.TryGetValue(slot.Value, out var item)) gear += item.DefenseBonus;
            }
            int classBonus = DungeonContent.ClassByName(ClassName)?.DefBonus ?? 0;
            int setBonus   = SetBonus(bagById, b => b.DefBonus);
            return (Level - 1) / 2 + gear + classBonus + setBonus;
        }

        /// <summary>Counts equipped pieces per set name, then adds the
        /// set's bonus selector when piece-count meets the threshold.
        /// Sums across every active set (a hero with full Ironclad +
        /// 3-piece Dragonscale would get both bonuses).</summary>
        public int SetBonus(IReadOnlyDictionary<string, InventoryItem> bagById, Func<DungeonContent.SetDef, int> selector)
        {
            var counts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            foreach (var kv in Equipped)
            {
                if (!bagById.TryGetValue(kv.Value, out var item)) continue;
                if (string.IsNullOrEmpty(item.SetName)) continue;
                counts[item.SetName] = counts.TryGetValue(item.SetName, out var c) ? c + 1 : 1;
            }
            int total = 0;
            foreach (var kv in counts)
            {
                var def = DungeonContent.SetByName(kv.Key);
                if (def == null) continue;
                if (kv.Value >= def.PiecesForBonus) total += selector(def);
            }
            return total;
        }

        /// <summary>List of currently-active set names (each one piece-
        /// count meets PiecesForBonus). Used for the /loadout Hero embed
        /// + the Set Collector achievement.</summary>
        public IReadOnlyList<string> ActiveSets(IReadOnlyDictionary<string, InventoryItem> bagById)
        {
            var counts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            foreach (var kv in Equipped)
            {
                if (!bagById.TryGetValue(kv.Value, out var item)) continue;
                if (string.IsNullOrEmpty(item.SetName)) continue;
                counts[item.SetName] = counts.TryGetValue(item.SetName, out var c) ? c + 1 : 1;
            }
            var list = new List<string>();
            foreach (var kv in counts)
            {
                var def = DungeonContent.SetByName(kv.Key);
                if (def != null && kv.Value >= def.PiecesForBonus) list.Add(def.Name);
            }
            return list;
        }
    }

    /// <summary>
    /// One stack-of-one inventory item. Items are unique instances (not
    /// stackable) so a viewer who finds two Steel Swords sees them as
    /// distinct entries — makes equipping / selling / trading
    /// straightforward through Discord slash commands.
    /// </summary>
    public sealed class InventoryItem
    {
        public string Id           { get; set; }   // GUID — assigned at drop time
        public string Slot         { get; set; }   // weapon | head | chest | legs | boots | trinket
        public string Rarity       { get; set; }   // common | uncommon | rare | epic | legendary | mythic
        public string Name         { get; set; }
        public string Glyph        { get; set; }
        public int    PowerBonus   { get; set; }
        public int    DefenseBonus { get; set; }
        public int    GoldValue    { get; set; }   // resale price baseline
        public string SetName      { get; set; }   // empty if not part of a set
        public int    EnchantLevel { get; set; }   // 0..3 — adds +1 ATK or +1 DEF per level (whichever is higher)
        public DateTime FoundUtc   { get; set; } = DateTime.UtcNow;
        public string FoundIn      { get; set; }   // e.g. "Crypt of Whispers" — the dungeon name
    }
}
