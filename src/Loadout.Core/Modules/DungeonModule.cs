using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Loadout.Bolts;
using Loadout.Bus;
using Loadout.Games.Dungeon;
using Loadout.Patreon;
using Loadout.Platforms;
using Loadout.Sb;
using Loadout.Settings;
using Loadout.Util;

namespace Loadout.Modules
{
    /// <summary>
    /// Dungeon Crawler mini-game.
    ///
    /// Three commands:
    ///   !dungeon          (broadcaster cooldown) — spawn a party-recruit
    ///                     window. Viewers !join during the timer; their
    ///                     avatars line up on the dungeon overlay; then
    ///                     the party "enters" and the engine narrates a
    ///                     run for ~30 seconds. Survivors get bolts +
    ///                     XP + a loot drop into their dungeon-heroes
    ///                     bag (managed via the Discord bot).
    ///   !join             (during recruit window only) — adds the
    ///                     viewer to the party. Free.
    ///   !duel @user       (per-user cooldown) — challenges another
    ///                     viewer. They have N seconds to !join. Three-
    ///                     round skirmish, winner takes XP + bolts.
    ///
    /// All overlay rendering keys off bus events:
    ///   dungeon.recruiting  { dungeonName, openSec, party[], hostUser }
    ///   dungeon.joined      { user, platform, level, hero }
    ///   dungeon.scene       { delayMs, kind, text, glyph, targetUser }
    ///   dungeon.completed   { dungeonName, outcomes[], partySize }
    ///   duel.recruiting     { challenger, target, openSec }
    ///   duel.scene          { delayMs, ... }
    ///   duel.completed      { winner, loser, xp, gold }
    /// </summary>
    public sealed class DungeonModule : IEventModule
    {
        private readonly object _gate = new object();
        private DungeonRecruit _activeDungeon;
        private DateTime _lastDungeonStartUtc = DateTime.MinValue;

        private readonly Dictionary<string, DateTime> _userDuelCooldown = new Dictionary<string, DateTime>(StringComparer.OrdinalIgnoreCase);
        private DuelRecruit _activeDuel;

        private static readonly Random _rng = new Random();

        public void OnTick() { }

        public void OnEvent(EventContext ctx)
        {
            var s = SettingsManager.Instance.Current;
            if (!s.Modules.Dungeon) return;
            if (!Entitlements.IsUnlocked(Feature.DungeonGame)) return;
            if (ctx.Kind != "chat") return;

            var raw = (ctx.Message ?? "").Trim();
            if (raw.Length == 0) return;
            var lower = raw.ToLowerInvariant();
            var cfg = s.Dungeon ?? new DungeonConfig();

            // -- Spawn dungeon (broadcaster + mods only) --
            var dCmd = NormalizeCmd(cfg.DungeonCommand, "!dungeon");
            if (lower == dCmd || lower.StartsWith(dCmd + " ", StringComparison.Ordinal))
            {
                if (!IsModOrBroadcaster(ctx) && !IsAllowedHost(cfg, ctx))
                {
                    Reply(ctx, "Only mods can summon a dungeon. (" + dCmd + ")");
                    return;
                }
                StartDungeon(ctx, cfg);
                return;
            }

            // -- Join active dungeon party --
            var jCmd = NormalizeCmd(cfg.JoinCommand, "!join");
            if (lower == jCmd || lower.StartsWith(jCmd + " ", StringComparison.Ordinal))
            {
                JoinAttempt(ctx, cfg);
                return;
            }

            // -- Duel another viewer --
            var duCmd = NormalizeCmd(cfg.DuelCommand, "!duel");
            if (lower == duCmd || lower.StartsWith(duCmd + " ", StringComparison.Ordinal))
            {
                StartDuel(ctx, cfg, raw);
                return;
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // Dungeon spawn
        // ─────────────────────────────────────────────────────────────────

        private void StartDungeon(EventContext ctx, DungeonConfig cfg)
        {
            DungeonRecruit recruit = null;
            lock (_gate)
            {
                if (_activeDungeon != null)
                {
                    Reply(ctx, "A dungeon is already in progress!");
                    return;
                }

                var cooldown = TimeSpan.FromSeconds(Math.Max(0, cfg.DungeonCooldownSec));
                if (DateTime.UtcNow - _lastDungeonStartUtc < cooldown)
                {
                    var remaining = cooldown - (DateTime.UtcNow - _lastDungeonStartUtc);
                    Reply(ctx, "Dungeon on cooldown. " + Math.Ceiling(remaining.TotalSeconds) + "s left.");
                    return;
                }

                recruit = new DungeonRecruit
                {
                    DungeonName = "Crypt of Whispers", // chosen by engine; this is the placeholder for the recruit screen
                    HostUser    = ctx.User ?? "broadcaster",
                    HostPlatform = ctx.Platform.ToShortName(),
                    OpenedAtUtc = DateTime.UtcNow,
                    OpenSec     = Math.Max(10, Math.Min(180, cfg.JoinWindowSec))
                };
                _activeDungeon = recruit;
                _lastDungeonStartUtc = DateTime.UtcNow;
            }

            // Auto-include the host so the "summon-and-do-nothing" UX is
            // not a thing. The host gets first-on-the-roster.
            AddPartyMember(recruit, ctx.Platform.ToShortName(), ctx.User);

            Publish("dungeon.recruiting", new
            {
                dungeonName = recruit.DungeonName,
                openSec     = recruit.OpenSec,
                hostUser    = recruit.HostUser,
                joinCommand = NormalizeCmd(cfg.JoinCommand, "!join"),
                party       = SnapshotParty(recruit)
            });
            Reply(ctx, "⚔ A dungeon opens! Type " + NormalizeCmd(cfg.JoinCommand, "!join") +
                       " to join the party (" + recruit.OpenSec + "s).");

            // Schedule the run for after the join window closes.
            var openMs = recruit.OpenSec * 1000;
            Task.Delay(openMs + 200).ContinueWith(_ => RunDungeonNow(recruit, cfg));
        }

        private void JoinAttempt(EventContext ctx, DungeonConfig cfg)
        {
            DungeonRecruit recruit;
            DuelRecruit duel;
            lock (_gate) { recruit = _activeDungeon; duel = _activeDuel; }

            // !join goes to the active dungeon if there is one; otherwise
            // a duel that's waiting for an opponent if the caller is the
            // target. (Plain !join answers a duel call too.)
            if (recruit != null)
            {
                if (DateTime.UtcNow > recruit.OpenedAtUtc.AddSeconds(recruit.OpenSec))
                {
                    Reply(ctx, "Too late — the dungeon doors slammed shut.");
                    return;
                }
                if (recruit.PartySize >= cfg.MaxPartySize)
                {
                    Reply(ctx, "The party is full (" + cfg.MaxPartySize + ").");
                    return;
                }
                if (AddPartyMember(recruit, ctx.Platform.ToShortName(), ctx.User))
                {
                    Publish("dungeon.joined", new
                    {
                        user = ctx.User,
                        platform = ctx.Platform.ToShortName(),
                        partySize = recruit.PartySize,
                        hero = HeroSnapshot(ctx)
                    });
                }
                return;
            }

            if (duel != null)
            {
                if (DateTime.UtcNow > duel.OpenedAtUtc.AddSeconds(duel.OpenSec))
                {
                    Reply(ctx, "Too late — the duel was forfeited.");
                    return;
                }
                if (string.Equals(ctx.User, duel.Challenger, StringComparison.OrdinalIgnoreCase))
                {
                    Reply(ctx, "You can't accept your own duel.");
                    return;
                }
                // If a specific target was named, only they can accept;
                // otherwise the first taker wins the duel.
                if (!string.IsNullOrEmpty(duel.Target) &&
                    !string.Equals(ctx.User, duel.Target, StringComparison.OrdinalIgnoreCase))
                {
                    Reply(ctx, "This duel is between " + duel.Challenger + " and " + duel.Target + ".");
                    return;
                }
                AcceptDuel(duel, ctx);
                return;
            }
        }

        private bool AddPartyMember(DungeonRecruit recruit, string platform, string user)
        {
            lock (recruit.Sync)
            {
                var key = (platform + ":" + (user ?? "")).ToLowerInvariant();
                if (recruit.Members.ContainsKey(key)) return false;
                var hero = DungeonGameStore.Instance.GetOrCreate(platform, user);
                recruit.Members[key] = hero;
                return true;
            }
        }

        private void RunDungeonNow(DungeonRecruit recruit, DungeonConfig cfg)
        {
            try
            {
                List<HeroState> party;
                lock (recruit.Sync) { party = recruit.Members.Values.ToList(); }
                if (party.Count == 0)
                {
                    Publish("dungeon.completed", new { dungeonName = recruit.DungeonName, partySize = 0, outcomes = new object[0] });
                    return;
                }

                var result = DungeonEngine.Run(party, Math.Max(1, cfg.Difficulty), cfg.RunDurationSec, cfg.SceneCount, _rng);
                // Rename the result name to whatever the engine picked so
                // the overlay's title bar matches.
                Publish("dungeon.started", new { dungeonName = result.DungeonName, partySize = party.Count });

                foreach (var scene in result.Scenes)
                {
                    Publish("dungeon.scene", new
                    {
                        delayMs    = scene.DelayMs,
                        kind       = scene.Kind,
                        text       = scene.Text,
                        glyph      = scene.Glyph,
                        targetUser = scene.TargetUser
                    });
                }

                // Apply outcomes: hero state, then award bolts so survivors
                // see the +N bolts toast simultaneously with the loot reveal.
                // Achievement unlocks bubble out of ApplyDungeonResult and
                // get broadcast as their own bus event so the overlay can
                // render an inline 🏆 toast even after the loot reveal
                // settles.
                BoltsWallet.Instance.Initialize();
                foreach (var o in result.Outcomes)
                {
                    List<string> newAchievements;
                    int achievementBolts;
                    DungeonGameStore.Instance.ApplyDungeonResult(
                        o.Platform, o.Handle,
                        o.HpDelta, o.XpGained, o.GoldGained,
                        o.Loot, o.Survived, result.DungeonName,
                        o.SlewBoss,
                        out newAchievements, out achievementBolts);
                    int totalGold = o.GoldGained + achievementBolts;
                    if (totalGold > 0)
                    {
                        BoltsWallet.Instance.Earn(o.Platform, o.Handle, totalGold, "dungeon");
                    }
                    if (newAchievements != null && newAchievements.Count > 0)
                    {
                        foreach (var id in newAchievements)
                        {
                            var def = Array.Find(DungeonContent.Achievements, a => a.Id == id);
                            if (def == null) continue;
                            Publish("achievement.unlocked", new
                            {
                                user      = o.Handle,
                                platform  = o.Platform,
                                id        = def.Id,
                                name      = def.Name,
                                description = def.Description,
                                glyph     = def.Glyph,
                                bolts     = def.BoltsReward
                            });
                        }
                    }
                }

                Publish("dungeon.completed", new
                {
                    dungeonName = result.DungeonName,
                    biome       = result.Biome,
                    hadBoss     = result.HadBoss,
                    partySize   = party.Count,
                    outcomes    = result.Outcomes.Select(o =>
                    {
                        // Re-read the post-apply hero so the loot card has
                        // the avatar/class/custom state the viewer just
                        // configured (and to confirm the level-up if XP
                        // bumped them).
                        var refreshed = DungeonGameStore.Instance.Get(o.Platform, o.Handle)
                                        ?? new HeroState { Handle = o.Handle, Platform = o.Platform };
                        var cls = DungeonContent.ClassByName(refreshed.ClassName);
                        return new
                        {
                            user      = o.Handle,
                            platform  = o.Platform,
                            survived  = o.Survived,
                            slewBoss  = o.SlewBoss,
                            hpDelta   = o.HpDelta,
                            xpGained  = o.XpGained,
                            goldGained = o.GoldGained,
                            avatar     = refreshed.Avatar     ?? "",
                            className  = refreshed.ClassName  ?? "",
                            classGlyph = cls?.Glyph     ?? "",
                            classTint  = cls?.TintColor ?? "",
                            custom     = refreshed.Custom ?? new Dictionary<string, string>(),
                            loot      = o.Loot.Select(it => new
                            {
                                id     = it.Id,
                                slot   = it.Slot,
                                rarity = it.Rarity,
                                name   = it.Name,
                                glyph  = it.Glyph,
                                powerBonus   = it.PowerBonus,
                                defenseBonus = it.DefenseBonus,
                                goldValue    = it.GoldValue,
                                setName      = it.SetName ?? ""
                            }).ToArray()
                        };
                    }).ToArray()
                });
            }
            catch (Exception ex)
            {
                ErrorLog.Write("DungeonModule.Run", ex);
            }
            finally
            {
                lock (_gate) { _activeDungeon = null; }
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // Duel
        // ─────────────────────────────────────────────────────────────────

        private void StartDuel(EventContext ctx, DungeonConfig cfg, string raw)
        {
            var key = (ctx.Platform.ToShortName() + ":" + (ctx.User ?? "")).ToLowerInvariant();
            var cooldown = TimeSpan.FromSeconds(Math.Max(0, cfg.DuelCooldownSec));
            lock (_gate)
            {
                if (_activeDuel != null)
                {
                    Reply(ctx, "A duel is already underway!");
                    return;
                }
                if (_userDuelCooldown.TryGetValue(key, out var last) && DateTime.UtcNow - last < cooldown)
                {
                    var remaining = cooldown - (DateTime.UtcNow - last);
                    Reply(ctx, "Sheath your blade — duel cooldown " + Math.Ceiling(remaining.TotalSeconds) + "s.");
                    return;
                }
                _userDuelCooldown[key] = DateTime.UtcNow;
            }

            string target = "";
            // Optional named target: "!duel @bob" or "!duel bob"
            var bits = raw.Split(' ');
            if (bits.Length > 1)
            {
                var t = bits[1].Trim().TrimStart('@');
                if (!string.IsNullOrEmpty(t)) target = t;
            }

            DuelRecruit duel;
            lock (_gate)
            {
                duel = new DuelRecruit
                {
                    Challenger = ctx.User,
                    ChallengerPlatform = ctx.Platform.ToShortName(),
                    Target = target,
                    OpenedAtUtc = DateTime.UtcNow,
                    OpenSec = Math.Max(10, Math.Min(120, cfg.DuelJoinWindowSec))
                };
                _activeDuel = duel;
            }

            Publish("duel.recruiting", new
            {
                challenger = duel.Challenger,
                target     = duel.Target,
                openSec    = duel.OpenSec,
                joinCommand = NormalizeCmd(cfg.JoinCommand, "!join")
            });
            if (string.IsNullOrEmpty(target))
                Reply(ctx, "⚔ " + ctx.User + " calls for a duel! Type " + NormalizeCmd(cfg.JoinCommand, "!join") + " to accept.");
            else
                Reply(ctx, "⚔ " + ctx.User + " challenges " + target + "! " + NormalizeCmd(cfg.JoinCommand, "!join") + " to accept.");

            // Time-out the duel if no one accepts.
            var openMs = duel.OpenSec * 1000;
            Task.Delay(openMs + 200).ContinueWith(_ => DuelTimeoutCheck(duel));
        }

        private void DuelTimeoutCheck(DuelRecruit duel)
        {
            lock (_gate)
            {
                if (_activeDuel != duel) return;
                if (duel.Defender != null) return; // already accepted; runner will clear it
                _activeDuel = null;
            }
            Publish("duel.completed", new { winner = (string)null, loser = (string)null, reason = "no-acceptance", challenger = duel.Challenger });
        }

        private void AcceptDuel(DuelRecruit duel, EventContext ctx)
        {
            lock (_gate)
            {
                if (duel.Defender != null) return;
                duel.Defender = ctx.User;
                duel.DefenderPlatform = ctx.Platform.ToShortName();
            }

            try
            {
                var attacker = DungeonGameStore.Instance.GetOrCreate(duel.ChallengerPlatform, duel.Challenger);
                var defender = DungeonGameStore.Instance.GetOrCreate(duel.DefenderPlatform, duel.Defender);

                // Include both duelists' character bits so the duel panel
                // can render avatars + class-tinted rings instead of the
                // hardcoded ⚔ / 🛡 placeholders.
                var attClass = DungeonContent.ClassByName(attacker.ClassName);
                var defClass = DungeonContent.ClassByName(defender.ClassName);
                Publish("duel.started", new
                {
                    challenger        = duel.Challenger,
                    defender          = duel.Defender,
                    challengerAvatar  = attacker.Avatar    ?? "",
                    defenderAvatar    = defender.Avatar    ?? "",
                    challengerClass   = attacker.ClassName ?? "",
                    defenderClass     = defender.ClassName ?? "",
                    challengerGlyph   = attClass?.Glyph     ?? "",
                    defenderGlyph     = defClass?.Glyph     ?? "",
                    challengerTint    = attClass?.TintColor ?? "",
                    defenderTint      = defClass?.TintColor ?? "",
                    challengerCustom  = attacker.Custom ?? new Dictionary<string, string>(),
                    defenderCustom    = defender.Custom ?? new Dictionary<string, string>(),
                    challengerHpMax   = attacker.HpMax,
                    defenderHpMax     = defender.HpMax
                });

                var result = DungeonEngine.RunDuel(attacker, defender, _rng);
                foreach (var scene in result.Scenes)
                {
                    Publish("duel.scene", new
                    {
                        delayMs = scene.DelayMs,
                        kind    = scene.Kind,
                        text    = scene.Text,
                        glyph   = scene.Glyph
                    });
                }

                bool attackerWon = string.Equals(result.WinnerHandle, attacker.Handle, StringComparison.OrdinalIgnoreCase);
                DungeonGameStore.Instance.RecordDuel(attacker.Platform, attacker.Handle, attackerWon);
                DungeonGameStore.Instance.RecordDuel(defender.Platform, defender.Handle, !attackerWon);

                // Winner gets XP and bolts; loser gets nothing.
                BoltsWallet.Instance.Initialize();
                if (attackerWon)
                {
                    BoltsWallet.Instance.Earn(attacker.Platform, attacker.Handle, result.GoldToWinner, "duel-win");
                    DungeonGameStore.Instance.ApplyDungeonResult(attacker.Platform, attacker.Handle, 0, result.XpToWinner, 0, null, true, "duel");
                }
                else
                {
                    BoltsWallet.Instance.Earn(defender.Platform, defender.Handle, result.GoldToWinner, "duel-win");
                    DungeonGameStore.Instance.ApplyDungeonResult(defender.Platform, defender.Handle, 0, result.XpToWinner, 0, null, true, "duel");
                }

                Publish("duel.completed", new
                {
                    winner = result.WinnerHandle,
                    loser  = result.LoserHandle,
                    xp     = result.XpToWinner,
                    gold   = result.GoldToWinner
                });
            }
            catch (Exception ex)
            {
                ErrorLog.Write("DungeonModule.Duel", ex);
            }
            finally
            {
                lock (_gate) { _activeDuel = null; }
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // Helpers
        // ─────────────────────────────────────────────────────────────────

        private static bool IsModOrBroadcaster(EventContext ctx)
        {
            var u = (ctx.UserType ?? "viewer").ToLowerInvariant();
            return u == "broadcaster" || u == "mod" || u == "moderator";
        }

        private static bool IsAllowedHost(DungeonConfig cfg, EventContext ctx)
        {
            // Optional whitelist if the streamer wants a specific viewer
            // to be able to summon dungeons — comma-separated handles.
            if (string.IsNullOrEmpty(cfg.ExtraHosts)) return false;
            var allow = cfg.ExtraHosts.Split(new[] { ',', ';', ' ' }, StringSplitOptions.RemoveEmptyEntries);
            foreach (var a in allow)
                if (string.Equals(a.Trim().TrimStart('@'), ctx.User, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        private static string NormalizeCmd(string cfg, string fallback)
        {
            var c = (cfg ?? "").Trim();
            if (string.IsNullOrEmpty(c)) c = fallback;
            if (!c.StartsWith("!", StringComparison.Ordinal)) c = "!" + c;
            return c.ToLowerInvariant();
        }

        private static void Publish(string kind, object payload)
        {
            try { AquiloBus.Instance.Publish(kind, payload); } catch (Exception ex) { ErrorLog.Write("DungeonModule.Publish:" + kind, ex); }
        }

        private static void Reply(EventContext ctx, string msg)
        {
            // Free-tier respects the Twitch-only constraint; paid tier
            // routes via MultiPlatformSender.
            try
            {
                if (Entitlements.IsUnlocked(Feature.MultiPlatformSend) || ctx.Platform == PlatformMask.Twitch)
                {
                    new MultiPlatformSender(CphPlatformSender.Instance).Send(ctx.Platform, msg, SettingsManager.Instance.Current.Platforms);
                }
            }
            catch { }
        }

        private static object[] SnapshotParty(DungeonRecruit r)
        {
            lock (r.Sync)
            {
                return r.Members.Values.Select(h => HeroToPayload(h)).ToArray();
            }
        }

        private static object HeroSnapshot(EventContext ctx)
        {
            var h = DungeonGameStore.Instance.GetOrCreate(ctx.Platform.ToShortName(), ctx.User);
            return HeroToPayload(h);
        }

        /// <summary>Shared shape for every "hero on the wire" event so the
        /// overlay only needs one rendering path. Includes the custom
        /// map (skin / hair / outfit / cape) so the composed pixel-art
        /// sprite renders consistently in party tile / loot card / duel
        /// avatar.</summary>
        private static object HeroToPayload(HeroState h)
        {
            var cls = DungeonContent.ClassByName(h.ClassName);
            return new
            {
                user        = h.Handle,
                platform    = h.Platform,
                level       = h.Level,
                hpMax       = h.HpMax,
                hpCurrent   = h.HpCurrent,
                avatar      = h.Avatar     ?? "",
                className   = h.ClassName  ?? "",
                classGlyph  = cls?.Glyph     ?? "",
                classTint   = cls?.TintColor ?? "",
                custom      = h.Custom     ?? new Dictionary<string, string>()
            };
        }

        // -------------------- internal types --------------------

        private sealed class DungeonRecruit
        {
            public readonly object Sync = new object();
            public string DungeonName;
            public string HostUser;
            public string HostPlatform;
            public DateTime OpenedAtUtc;
            public int OpenSec;
            public Dictionary<string, HeroState> Members = new Dictionary<string, HeroState>(StringComparer.OrdinalIgnoreCase);
            public int PartySize { get { lock (Sync) return Members.Count; } }
        }

        private sealed class DuelRecruit
        {
            public string Challenger;
            public string ChallengerPlatform;
            public string Target;          // empty == open challenge
            public string Defender;
            public string DefenderPlatform;
            public DateTime OpenedAtUtc;
            public int OpenSec;
        }
    }
}
