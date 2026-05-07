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
        public string Biome       { get; set; }
        public List<DungeonScene>     Scenes  { get; set; } = new List<DungeonScene>();
        public List<DungeonOutcome>   Outcomes { get; set; } = new List<DungeonOutcome>();
        public bool   HadBoss     { get; set; }
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
        public bool   SlewBoss   { get; set; }    // for the legendkiller achievement
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
        public static DungeonRunResult Run(IList<HeroState> party,
                                           int difficulty,
                                           int runDurationSec,
                                           int sceneCount,
                                           Random r)
        {
            var dungeon = DungeonContent.PickDungeonType(r);
            var result = new DungeonRunResult
            {
                DungeonName = dungeon.Name,
                Biome       = dungeon.Biome
            };
            if (party == null || party.Count == 0) return result;

            // Per-hero running state — we mutate copies so the store's
            // canonical state stays untouched until ApplyDungeonResult.
            var heroes = party.Select(h => new RunningHero(h)).ToList();
            difficulty = Math.Max(1, Math.Min(5, difficulty));
            runDurationSec = Math.Max(15, Math.Min(120, runDurationSec));
            sceneCount = Math.Max(3, Math.Min(8, sceneCount));

            // Opening flavour line — biome-aware.
            result.Scenes.Add(new DungeonScene
            {
                DelayMs = 200,
                Kind    = "story",
                Text    = "The party enters " + dungeon.Theme + " " + dungeon.Name + "..."
            });

            // Schedule scenes evenly across the run, leaving a tail for
            // the loot reveal animation. Difficulty 4+ runs always end
            // with a boss encounter so the climactic moment lands at the
            // right beat.
            bool spawnBossFinale = difficulty >= 4;
            int sceneSpacing = Math.Max(1500, (runDurationSec * 1000 - 4000) / sceneCount);
            int t = 1500;

            for (int i = 0; i < sceneCount; i++)
            {
                t += sceneSpacing;
                bool isFinale = (i == sceneCount - 1);
                DungeonScene scene;
                if (spawnBossFinale && isFinale)
                {
                    // Big set-piece encounter — uses the boss monster pool.
                    scene = MakeBossEncounter(heroes, difficulty, r, dungeon.Biome);
                    result.HadBoss = true;
                }
                else
                {
                    var pick = r.Next(100);
                    if      (pick < 38) scene = MakeEncounter(heroes, difficulty, r, dungeon.Biome);
                    else if (pick < 60) scene = MakeTrap     (heroes, r, dungeon.Biome);
                    else if (pick < 75) scene = MakeTreasure (heroes, difficulty, r);
                    else if (pick < 84) scene = MakeNpc      (heroes, r);
                    else if (pick < 90) scene = MakeShrine   (heroes, r);
                    else if (pick < 94) scene = MakeCurse    (heroes, r);
                    else                scene = MakeFlavour  (r);
                }
                scene.DelayMs = t;
                result.Scenes.Add(scene);

                // A scene where everyone is at 0 HP is an end. Stop
                // scheduling more — the loot reveal will tell the chat
                // who survived.
                if (heroes.All(h => h.HpRemaining <= 0)) break;
            }

            // Each survivor rolls a final loot drop based on difficulty.
            // Fallen heroes get a half-XP consolation prize. Bosses
            // guarantee a rare-or-better drop on top, plus a small chance
            // of a mythic on max difficulty.
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
                    GoldGained = rh.GoldGained,
                    SlewBoss   = result.HadBoss && rh.HpRemaining > 0
                };

                if (outcome.Survived)
                {
                    var rarity = DungeonContent.RollRarity(r, difficulty);
                    // Boss kill upgrades the rarity by one tier — common→
                    // uncommon, uncommon→rare, etc. Mythic stays gated to
                    // a 5% roll on difficulty 5 boss kills.
                    if (result.HadBoss)
                    {
                        rarity = UpgradeRarity(rarity);
                        if (difficulty >= 5 && r.Next(100) < 5) rarity = "mythic";
                    }
                    var def = DungeonContent.PickLootByRarity(r, rarity);
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
                        SetName        = def.SetName        ?? "",
                        PreferredClass = def.PreferredClass ?? "",
                        WeaponType     = def.WeaponType     ?? "",
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

        private static string UpgradeRarity(string r)
        {
            switch ((r ?? "common").ToLowerInvariant())
            {
                case "common":    return "uncommon";
                case "uncommon":  return "rare";
                case "rare":      return "epic";
                case "epic":      return "legendary";
                case "legendary": return "legendary";
                default:          return "rare";
            }
        }

        // -------------------- scene builders --------------------

        private static DungeonScene MakeEncounter(IList<RunningHero> heroes, int difficulty, Random r, string biome)
        {
            var monster = DungeonContent.PickMonster(r, difficulty, biome, false);
            return RunMonsterFight(heroes, monster, r, isBoss: false);
        }

        private static DungeonScene MakeBossEncounter(IList<RunningHero> heroes, int difficulty, Random r, string biome)
        {
            var monster = DungeonContent.PickMonster(r, difficulty, biome, true);
            // Falls back to a tier-5 elite if no biome-tagged boss exists.
            if (monster == null) monster = DungeonContent.Monsters.First(m => m.IsBoss);
            return RunMonsterFight(heroes, monster, r, isBoss: true);
        }

        private static DungeonScene RunMonsterFight(IList<RunningHero> heroes, DungeonContent.MonsterDef monster, Random r, bool isBoss)
        {
            var alive = heroes.Where(h => h.HpRemaining > 0).ToList();
            if (alive.Count == 0)
            {
                return new DungeonScene { Kind = isBoss ? "miniboss" : "encounter", Text = "Silence. The dungeon has claimed all." , Glyph = "💀" };
            }

            int partyAttack = alive.Sum(h => h.Hero.Attack(BagIndex(h.Hero)));
            int monsterAttack = Math.Max(1, monster.Power + r.Next(0, 3) - r.Next(0, 2));
            var victim = alive[r.Next(alive.Count)];
            int victimDef = victim.Hero.Defense(BagIndex(victim.Hero));
            int dmg = Math.Max(0, monsterAttack - victimDef);
            victim.HpRemaining -= dmg;

            int gold = r.Next(monster.GoldMin, monster.GoldMax + 1);
            int xp   = r.Next(monster.XpMin, monster.XpMax + 1);
            int perGold = Math.Max(1, gold / alive.Count);
            int perXp   = Math.Max(1, xp   / alive.Count);
            foreach (var h in alive) { h.GoldGained += perGold; h.XpGained += perXp; }
            _ = partyAttack;

            string text;
            string prefix = isBoss ? "BOSS — " : "";
            if (victim.HpRemaining <= 0)
            {
                victim.HpRemaining = 0;
                text = prefix + victim.Hero.Handle + " falls to the " + monster.Name + "! The party slays it for " + perGold + " bolts each.";
            }
            else
            {
                text = prefix + "A " + monster.Name + " strikes! " + victim.Hero.Handle + " takes " + dmg + " damage but the party prevails. (+" + perGold + " bolts, +" + perXp + " XP each)";
            }
            return new DungeonScene
            {
                Kind = isBoss ? "miniboss" : "encounter",
                Text = text, Glyph = monster.Glyph, TargetUser = victim.Hero.Handle
            };
        }

        private static DungeonScene MakeTrap(IList<RunningHero> heroes, Random r, string biome)
        {
            var alive = heroes.Where(h => h.HpRemaining > 0).ToList();
            if (alive.Count == 0)
                return new DungeonScene { Kind = "trap", Text = "An old trap clicks against empty stone." , Glyph = "🪤" };
            var trap   = DungeonContent.PickTrap(r, biome);
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

        private static DungeonScene MakeNpc(IList<RunningHero> heroes, Random r)
        {
            var alive = heroes.Where(h => h.HpRemaining > 0).ToList();
            if (alive.Count == 0)
                return new DungeonScene { Kind = "story", Text = "A figure passes by, paying the dead no mind.", Glyph = "🚶" };
            var npc = DungeonContent.PickNpc(r);
            // Apply outcome to all survivors so the chat reads it as a
            // group event ("the party met …") not a single-target reward.
            int perGold = Math.Max(0, npc.GoldDelta);
            int hpDelta = npc.HpDelta;
            foreach (var h in alive)
            {
                h.GoldGained += perGold;
                if (hpDelta != 0) h.HpRemaining = Math.Min(h.Hero.HpMax, h.HpRemaining + hpDelta);
            }
            return new DungeonScene { Kind = "npc", Text = npc.FlavorText, Glyph = npc.Glyph };
        }

        private static DungeonScene MakeShrine(IList<RunningHero> heroes, Random r)
        {
            var alive = heroes.Where(h => h.HpRemaining > 0).ToList();
            if (alive.Count == 0)
                return new DungeonScene { Kind = "story", Text = "A shrine glows quietly over the fallen.", Glyph = "⛩" };
            var s = DungeonContent.PickShrine(r);
            foreach (var h in alive)
            {
                if (s.HpDelta > 0) h.HpRemaining = Math.Min(h.Hero.HpMax, h.HpRemaining + s.HpDelta);
                if (s.XpDelta > 0) h.XpGained += s.XpDelta;
            }
            return new DungeonScene { Kind = "shrine", Text = s.FlavorText, Glyph = s.Glyph };
        }

        private static DungeonScene MakeCurse(IList<RunningHero> heroes, Random r)
        {
            var alive = heroes.Where(h => h.HpRemaining > 0).ToList();
            if (alive.Count == 0)
                return new DungeonScene { Kind = "story", Text = "A faint hex echoes off the empty walls.", Glyph = "♨" };
            var c = DungeonContent.PickCurse(r);
            foreach (var h in alive) h.HpRemaining = Math.Max(0, h.HpRemaining + c.HpDelta);
            return new DungeonScene { Kind = "curse", Text = c.FlavorText, Glyph = c.Glyph };
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
