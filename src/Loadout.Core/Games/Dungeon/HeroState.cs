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

        // The bag — every uncrafted item the hero owns. Equipped items
        // are duplicated by id-reference into Equipped.
        public List<InventoryItem> Bag      { get; set; } = new List<InventoryItem>();
        // slot -> item.Id. "weapon" / "head" / "chest" / "legs" / "boots"
        // / "trinket". Item must still exist in Bag.
        public Dictionary<string, string> Equipped { get; set; } = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        public DateTime LastUpdatedUtc { get; set; } = DateTime.UtcNow;
        public DateTime CreatedUtc     { get; set; } = DateTime.UtcNow;

        /// <summary>Total attack including equipped weapon + level scaling.</summary>
        public int Attack(IReadOnlyDictionary<string, InventoryItem> bagById)
        {
            int gear = 0;
            foreach (var slot in Equipped)
            {
                if (bagById.TryGetValue(slot.Value, out var item)) gear += item.PowerBonus;
            }
            return 4 + (Level - 1) + gear;
        }

        /// <summary>Total defense including equipped armour + level scaling.</summary>
        public int Defense(IReadOnlyDictionary<string, InventoryItem> bagById)
        {
            int gear = 0;
            foreach (var slot in Equipped)
            {
                if (bagById.TryGetValue(slot.Value, out var item)) gear += item.DefenseBonus;
            }
            return (Level - 1) / 2 + gear;
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
        public string Rarity       { get; set; }   // common | uncommon | rare | epic | legendary
        public string Name         { get; set; }
        public string Glyph        { get; set; }
        public int    PowerBonus   { get; set; }
        public int    DefenseBonus { get; set; }
        public int    GoldValue    { get; set; }   // resale price baseline
        public DateTime FoundUtc   { get; set; } = DateTime.UtcNow;
        public string FoundIn      { get; set; }   // e.g. "Crypt of Whispers" — the dungeon name
    }
}
