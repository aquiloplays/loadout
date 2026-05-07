using System;
using System.Collections.Generic;
using System.Linq;

namespace Loadout.Games.Dungeon
{
    /// <summary>
    /// Pure-data result of running a dungeon for a party. Owned and
    /// produced by the engine; consumed by DungeonModule (publishes
    /// scenes on the bus + writes hero state) and the OBS overlay.
    /// </summary>
    public sealed class DungeonRunResult
    {
        public string DungeonName { get; set; }
        public List<DungeonScene>     Scenes  { get; set; } = new List<DungeonScene>();
        public List<DungeonOutcome>   Outcomes { get; set; } = new List<DungeonOutcome>();
    }

    public sealed class DungeonScene
    {
        public int    DelayMs   { get; set; }   // ms after run start to fire on the bus
        public string Kind      { get; set; }   // "encounter" | "trap" | "treasure" | "rest" | "story"
        public string Text      { get; set; }   // the line to render in the adventure log
        public string TargetUser { get; set; }  // optional — which hero this happened to
        public string Glyph     { get; set; }   // optional — emoji for the scene tile
    }

    public sealed class DungeonOutcome
    {
        public string Platform   { get; set; }
        public string Handle     { get; set; }
        public bool   Survived   { get; set; }
        public int    HpDelta    { get; set; }
        public int    XpGained   { get; set; }
        public int    GoldGained { get; set; }   // bolts awarded
        public List<InventoryItem> Loot { get; set; } = new List<InventoryItem>();
    }

    /// <summary>
    /// Runs a dungeon adventure as a deterministic-given-seed sequence
    /// of scenes. The DungeonModule schedules each scene's bus publish
    /// at <c>scene.DelayMs</c> after the start so chat sees the story
    /// unfold over the configured run length.
    ///
    /// The model is deliberately simple — every party member rolls
    /// against every encounter, gear adds attack / defense, level adds
    /// HP. There's no targeting / threat / aggro. Streamers won't read
    /// game theory; they'll watch chat hype each scene.
    /// </summary>
    public static class DungeonEngine
    {
        private static readonly string[] DungeonNames = new[]
        {
            "Crypt of Whispers",
            "Sunken Vault",
            "Forgotten Catacombs",
            "Wyvern's Hollow",
            "Skyreach Spire",
            "Bonemarsh Depths",
            "Howling Mines",
            "Iron Shrine"
        };

        public static DungeonRunResult Run(IList<HeroState> party,
                                           int difficulty,
                                           int runDurationSec,
                                           int sceneCount,
                                           Random r)
        {
            var result = new DungeonRunResult
            {
                DungeonName = DungeonNames[r.Next(DungeonNames.Length)]
            };
            if (party == null || party.Count == 0) return result;

            // Per-hero running state — we mutate copies so the store's
            // canonical state stays untouched until ApplyDungeonResult.
            var heroes = party.Select(h => new RunningHero(h)).ToList();
            difficulty = Math.Max(1, Math.Min(5, difficulty));
            runDurationSec = Math.Max(15, Math.Min(120, runDurationSec));
            sceneCount = Math.Max(3, Math.Min(8, sceneCount));

            // Opening flavour line.
            result.Scenes.Add(new DungeonScene
            {
                DelayMs = 200,
                Kind    = "story",
                Text    = "The party enters the " + result.DungeonName + "..."
            });

            // Schedule scenes evenly across the run, leaving a tail for
            // the loot reveal animation.
            int sceneSpacing = Math.Max(1500, (runDurationSec * 1000 - 4000) / sceneCount);
            int t = 1500;

            for (int i = 0; i < sceneCount; i++)
            {
                t += sceneSpacing;
                var pick = r.Next(100);
                DungeonScene scene;
                if      (pick < 50) scene = MakeEncounter(heroes, difficulty, r);
                else if (pick < 75) scene = MakeTrap     (heroes, r);
                else if (pick < 90) scene = MakeTreasure (heroes, difficulty, r);
                else                scene = MakeFlavour  (r);
                scene.DelayMs = t;
                result.Scenes.Add(scene);

                // A scene where everyone is at 0 HP is an end. Stop
                // scheduling more — the loot reveal will tell the chat
                // who survived.
                if (heroes.All(h => h.HpRemaining <= 0)) break;
            }

            // Each survivor rolls a final loot drop based on difficulty.
            // Fallen heroes get a half-XP consolation prize so a viewer
            // who joined for the meme isn't penalised hard.
            t += 1500;
            foreach (var rh in heroes)
            {
                var outcome = new DungeonOutcome
                {
                    Platform   = rh.Hero.Platform,
                    Handle     = rh.Hero.Handle,
                    Survived   = rh.HpRemaining > 0,
                    HpDelta    = rh.HpRemaining - rh.Hero.HpCurrent,
                    XpGained   = rh.XpGained,
                    GoldGained = rh.GoldGained
                };

                if (outcome.Survived)
                {
                    var rarity = DungeonContent.RollRarity(r, difficulty);
                    var def    = DungeonContent.PickLootByRarity(r, rarity);
                    outcome.Loot.Add(new InventoryItem
                    {
                        Id     = Guid.NewGuid().ToString("N"),
                        Slot   = def.Slot,
                        Rarity = def.Rarity,
                        Name   = def.Name,
                        Glyph  = def.Glyph,
                        PowerBonus   = def.PowerBonus,
                        DefenseBonus = def.DefenseBonus,
                        GoldValue    = def.GoldValue,
                        FoundIn      = result.DungeonName,
                        FoundUtc     = DateTime.UtcNow
                    });
                }
                else
                {
                    // Half XP consolation, no gold, no loot.
                    outcome.XpGained = Math.Max(2, rh.XpGained / 2);
                    outcome.GoldGained = 0;
                }
                result.Outcomes.Add(outcome);
            }

            return result;
        }

        // -------------------- scene builders --------------------

        private static DungeonScene MakeEncounter(IList<RunningHero> heroes, int difficulty, Random r)
        {
            var monster = DungeonContent.PickMonster(r, difficulty);
            // Random survivor is the protagonist of the encounter line.
            var alive = heroes.Where(h => h.HpRemaining > 0).ToList();
            if (alive.Count == 0)
            {
                return new DungeonScene { Kind = "encounter", Text = "Silence. The dungeon has claimed all." , Glyph = "💀" };
            }
            var hero = alive[r.Next(alive.Count)];

            // Group attack vs monster — every survivor contributes attack.
            int partyAttack = alive.Sum(h => h.Hero.Attack(BagIndex(h.Hero)));
            int monsterDamageTaken = Math.Max(2, partyAttack - r.Next(0, 4));
            // Counter-damage spread randomly across alive heroes.
            int monsterAttack = Math.Max(1, monster.Power + r.Next(0, 3) - r.Next(0, 2));
            var victim = alive[r.Next(alive.Count)];
            int victimDef = victim.Hero.Defense(BagIndex(victim.Hero));
            int dmg = Math.Max(0, monsterAttack - victimDef);
            victim.HpRemaining -= dmg;

            // Reward distributed among survivors (averaged + jittered).
            int gold = r.Next(monster.GoldMin, monster.GoldMax + 1);
            int xp   = r.Next(monster.XpMin, monster.XpMax + 1);
            int perGold = Math.Max(1, gold / alive.Count);
            int perXp   = Math.Max(1, xp   / alive.Count);
            foreach (var h in alive) { h.GoldGained += perGold; h.XpGained += perXp; }

            string text;
            if (victim.HpRemaining <= 0)
            {
                victim.HpRemaining = 0;
                text = victim.Hero.Handle + " falls to a " + monster.Name + "! The party defeats it for " + perGold + " bolts each.";
            }
            else
            {
                text = "A " + monster.Name + " ambushes the party! It strikes " + victim.Hero.Handle + " for " + dmg + " damage, but falls. (+" + perGold + " bolts, +" + perXp + " XP each)";
            }
            _ = monsterDamageTaken; // silence unused
            return new DungeonScene { Kind = "encounter", Text = text, Glyph = monster.Glyph, TargetUser = victim.Hero.Handle };
        }

        private static DungeonScene MakeTrap(IList<RunningHero> heroes, Random r)
        {
            var alive = heroes.Where(h => h.HpRemaining > 0).ToList();
            if (alive.Count == 0)
                return new DungeonScene { Kind = "trap", Text = "An old trap clicks against empty stone." , Glyph = "🪤" };
            var trap   = DungeonContent.PickTrap(r);
            var victim = alive[r.Next(alive.Count)];
            int dmg = Math.Max(1, r.Next(trap.DamageMin, trap.DamageMax + 1) - victim.Hero.Defense(BagIndex(victim.Hero)) / 2);
            victim.HpRemaining -= dmg;
            string text;
            if (victim.HpRemaining <= 0)
            {
                victim.HpRemaining = 0;
                text = "A " + trap.Name + "! " + trap.Verb + " " + victim.Hero.Handle + " — they don't get up.";
            }
            else
            {
                text = "A " + trap.Name + "! " + trap.Verb + " " + victim.Hero.Handle + " for " + dmg + " damage.";
            }
            return new DungeonScene { Kind = "trap", Text = text, Glyph = trap.Glyph, TargetUser = victim.Hero.Handle };
        }

        private static DungeonScene MakeTreasure(IList<RunningHero> heroes, int difficulty, Random r)
        {
            var alive = heroes.Where(h => h.HpRemaining > 0).ToList();
            if (alive.Count == 0)
                return new DungeonScene { Kind = "treasure", Text = "A pile of gold gleams, untouched." , Glyph = "💰" };
            int gold = r.Next(8, 18) * difficulty;
            int per  = Math.Max(2, gold / alive.Count);
            foreach (var h in alive) h.GoldGained += per;
            return new DungeonScene
            {
                Kind = "treasure",
                Text = "The party finds a hoard! Each survivor pockets " + per + " bolts.",
                Glyph = "💰"
            };
        }

        private static DungeonScene MakeFlavour(Random r)
        {
            return new DungeonScene
            {
                Kind = "story",
                Text = DungeonContent.FlavourScenes[r.Next(DungeonContent.FlavourScenes.Length)],
                Glyph = "📜"
            };
        }

        private static IReadOnlyDictionary<string, InventoryItem> BagIndex(HeroState h)
        {
            // Fast lookup of equipped items by id during the run.
            var d = new Dictionary<string, InventoryItem>(StringComparer.OrdinalIgnoreCase);
            if (h.Bag != null) foreach (var it in h.Bag) if (!string.IsNullOrEmpty(it.Id)) d[it.Id] = it;
            return d;
        }

        // ── Duels ───────────────────────────────────────────────────────
        public sealed class DuelResult
        {
            public string AttackerHandle;
            public string DefenderHandle;
            public string WinnerHandle;
            public string LoserHandle;
            public int    AttackerHpAfter;
            public int    DefenderHpAfter;
            public int    XpToWinner;
            public int    GoldToWinner;
            public List<DungeonScene> Scenes = new List<DungeonScene>();
        }

        public static DuelResult RunDuel(HeroState attacker, HeroState defender, Random r)
        {
            // Three-round skirmish — alternating swings, defense reduces
            // damage, KO ends the fight early. XP + gold scaled to defender
            // level so duelling a high-level hero is the bigger payout.
            var result = new DuelResult
            {
                AttackerHandle = attacker.Handle,
                DefenderHandle = defender.Handle,
                AttackerHpAfter = attacker.HpCurrent,
                DefenderHpAfter = defender.HpCurrent
            };

            int aAtk = attacker.Attack(BagIndex(attacker));
            int aDef = attacker.Defense(BagIndex(attacker));
            int dAtk = defender.Attack(BagIndex(defender));
            int dDef = defender.Defense(BagIndex(defender));

            result.Scenes.Add(new DungeonScene
            {
                DelayMs = 200, Kind = "duel-start", Glyph = "⚔️",
                Text = attacker.Handle + " challenges " + defender.Handle + " to a duel!"
            });

            int t = 1500;
            for (int round = 1; round <= 3 && result.AttackerHpAfter > 0 && result.DefenderHpAfter > 0; round++)
            {
                int aDmg = Math.Max(1, aAtk + r.Next(0, 3) - dDef);
                result.DefenderHpAfter = Math.Max(0, result.DefenderHpAfter - aDmg);
                result.Scenes.Add(new DungeonScene
                {
                    DelayMs = t, Kind = "duel-strike", Glyph = "⚔️",
                    Text = "Round " + round + ": " + attacker.Handle + " strikes for " + aDmg + "."
                });
                t += 1500;
                if (result.DefenderHpAfter <= 0) break;

                int dDmg = Math.Max(1, dAtk + r.Next(0, 3) - aDef);
                result.AttackerHpAfter = Math.Max(0, result.AttackerHpAfter - dDmg);
                result.Scenes.Add(new DungeonScene
                {
                    DelayMs = t, Kind = "duel-strike", Glyph = "⚔️",
                    Text = "Round " + round + ": " + defender.Handle + " counters for " + dDmg + "."
                });
                t += 1500;
            }

            if (result.AttackerHpAfter <= 0 && result.DefenderHpAfter <= 0)
            {
                // Tie — give the survivor (last to die) the W. With the
                // alternating model above, defender dies first if both go
                // to zero on the same round, so attacker wins ties.
                result.WinnerHandle = attacker.Handle;
                result.LoserHandle  = defender.Handle;
            }
            else if (result.DefenderHpAfter <= 0)
            {
                result.WinnerHandle = attacker.Handle;
                result.LoserHandle  = defender.Handle;
            }
            else if (result.AttackerHpAfter <= 0)
            {
                result.WinnerHandle = defender.Handle;
                result.LoserHandle  = attacker.Handle;
            }
            else
            {
                // No KO in 3 rounds — higher remaining HP wins.
                if (result.AttackerHpAfter >= result.DefenderHpAfter)
                {
                    result.WinnerHandle = attacker.Handle;
                    result.LoserHandle  = defender.Handle;
                }
                else
                {
                    result.WinnerHandle = defender.Handle;
                    result.LoserHandle  = attacker.Handle;
                }
            }

            // Scaling: defender level used as the "stake" so picking on
            // a low-level hero gives less reward.
            var winnerLevel = string.Equals(result.WinnerHandle, attacker.Handle, StringComparison.OrdinalIgnoreCase)
                ? defender.Level : attacker.Level;
            result.XpToWinner   = 8 + winnerLevel * 4;
            result.GoldToWinner = 6 + winnerLevel * 3;

            result.Scenes.Add(new DungeonScene
            {
                DelayMs = t + 800, Kind = "duel-end", Glyph = "🏆",
                Text = result.WinnerHandle + " wins the duel! +" + result.XpToWinner + " XP, +" + result.GoldToWinner + " bolts."
            });
            return result;
        }

        private sealed class RunningHero
        {
            public HeroState Hero;
            public int HpRemaining;
            public int XpGained;
            public int GoldGained;
            public RunningHero(HeroState h) { Hero = h; HpRemaining = h.HpCurrent; }
        }
    }
}
