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
            if (ctx.Kind != "chat") return;

            var raw = (ctx.Message ?? "").Trim();
            if (raw.Length == 0) return;
            var lower = raw.ToLowerInvariant();
            var cfg = s.Dungeon ?? new DungeonConfig();

            // -- Spawn dungeon (broadcaster + mods only) --
            var dCmd = NormalizeCmd(cfg.DungeonCommand, "!dungeon");
            if (lower == dCmd || lower.StartsWith(dCmd + " ", StringComparison.Ordinal))
            {
                // Phase BR — `!dungeon vote <id>` lets chat (and the panel,
                // via PanelBridgeModule's synthesized chat events) tally a
                // viewer choice on an active branching run. Open to anyone,
                // not gated to mods — that's the whole point of the vote.
                var rest = (raw.Length > dCmd.Length ? raw.Substring(dCmd.Length).Trim() : "");
                if (rest.StartsWith("vote", StringComparison.OrdinalIgnoreCase))
                {
                    var optionId = rest.Length > 4 ? rest.Substring(4).Trim() : "";
                    CastBranchVote(ctx, optionId);
                    return;
                }
                // Phase BR — `!dungeon skip` clears the channel cooldown and
                // launches a new run immediately. Only trusted when the
                // event carries the panel-bridge skip flag (set by
                // PanelBridgeModule after the Worker validates a Bits or
                // bolts payment). Chat-typed `!dungeon skip` is treated as
                // a normal `!dungeon` and runs into the cooldown gate.
                if (rest.Equals("skip", StringComparison.OrdinalIgnoreCase)
                    && ctx.Get<bool>("loadout.panel.skip", false))
                {
                    // Payment is the authorization — any paying viewer can
                    // skip the cooldown. The Worker has already charged
                    // them (Bits or 500 bolts) before stamping the trust
                    // flag, so the mod gate doesn't apply here.
                    lock (_gate) { _lastDungeonStartUtc = DateTime.MinValue; }
                    StartDungeon(ctx, cfg);
                    return;
                }
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
            // not a thing. The host gets first-on-the-roster + the avatar
            // auto-resolve from the !dungeon chat event.
            AddPartyMember(recruit, ctx.Platform.ToShortName(), ctx.User, ctx);

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
                if (AddPartyMember(recruit, ctx.Platform.ToShortName(), ctx.User, ctx))
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

        private bool AddPartyMember(DungeonRecruit recruit, string platform, string user, EventContext ctx = null)
        {
            lock (recruit.Sync)
            {
                var key = (platform + ":" + (user ?? "")).ToLowerInvariant();
                if (recruit.Members.ContainsKey(key)) return false;
                var hero = DungeonGameStore.Instance.GetOrCreate(platform, user);

                // Best-effort auto-avatar — if the hero has no avatar set
                // AND the chat event SB just dispatched carries a Twitch /
                // YouTube / Kick profile-pic URL, store it. Means viewers
                // never need to paste a URL: their stream avatar shows up
                // on the dungeon overlay automatically.
                // (CheckInModule does the same thing for !checkin.)
                if (string.IsNullOrEmpty(hero.Avatar) && ctx != null)
                {
                    var pfp = TryReadProfilePic(ctx);
                    if (!string.IsNullOrEmpty(pfp))
                    {
                        hero = DungeonGameStore.Instance.SetAvatar(platform, user, pfp);
                    }
                }
                recruit.Members[key] = hero;
                return true;
            }
        }

        /// <summary>SB chat events expose the chatter's profile picture
        /// under different argument keys depending on the platform / SB
        /// version. Try the common ones in priority order.</summary>
        private static string TryReadProfilePic(EventContext ctx)
        {
            if (ctx == null) return null;
            foreach (var key in new[] { "userImage", "profileImageUrl",
                                        "userProfileImageUrl", "user_profile_image_url",
                                        "profilePictureUrl", "profilePicture",
                                        "userImageUrl" })
            {
                var v = ctx.Get<string>(key, null);
                if (!string.IsNullOrEmpty(v) && v.StartsWith("http", StringComparison.OrdinalIgnoreCase))
                    return v;
            }
            return null;
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
                        targetUser = scene.TargetUser,
                        // Per-scene HP for the Twitch panel — anonymous-typed
                        // so JSON property names match what panel.html reads.
                        partyHp    = (scene.PartyHp ?? new List<Loadout.Games.Dungeon.HpSnapshot>())
                                     .Select(h => new { name = h.Name, hp = h.Hp, hpMax = h.HpMax }),
                        // Phase BR — branching options (empty for linear scenes).
                        options    = (scene.Options ?? new List<SceneOption>())
                                     .Select(o => new { id = o.Id, label = o.Label }),
                    });
                }

                // Phase BR — when the engine added a branch finale, hold off
                // on outcomes + completion until the 30 s vote window has
                // resolved. The vote-state lives on the recruit so chat
                // votes (DungeonModule.OnEvent) and panel votes (the bridge
                // synthesizes them as chat events) both feed the same map.
                if (result.Branch != null && result.BranchEffects != null)
                {
                    lock (recruit.Sync)
                    {
                        recruit.Branch          = result.Branch;
                        recruit.BranchEffects   = result.BranchEffects;
                        recruit.BranchOpenedUtc = DateTime.UtcNow;
                        recruit.Votes.Clear();
                        recruit.VoteSeq.Clear();
                        recruit.VoteCounter = 0;
                    }
                    // Resolution fires after the branch scene's overlay time
                    // (DelayMs from start, already published above) + the
                    // 30 s vote window + a small settle buffer.
                    var waitMs = result.Branch.DelayMs + 30000 + 1500;
                    Task.Delay(waitMs).ContinueWith(_ =>
                        ResolveBranchAndComplete(recruit, result, cfg, party.Count));
                    return;
                }

                ApplyAndCompleteRun(recruit, result, cfg, party.Count);
            }
            catch (Exception ex)
            {
                ErrorLog.Write("DungeonModule.Run", ex);
                lock (_gate) { _activeDungeon = null; }
            }
        }

        // Resolves the vote (plurality, first-vote tiebreak, no-vote default
        // = first option), applies the winning BranchEffect to result.Outcomes,
        // publishes dungeon.choice with the chosen option + resolve text, and
        // then runs the normal outcome-apply + dungeon.completed path.
        private void ResolveBranchAndComplete(DungeonRecruit recruit, DungeonRunResult result, DungeonConfig cfg, int partySize)
        {
            try
            {
                string winnerId; long winnerVotes; bool viaTimeout;
                Dictionary<string, int> tally; Dictionary<string, string> snapshotVotes;
                lock (recruit.Sync)
                {
                    tally = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
                    foreach (var v in recruit.Votes.Values)
                    {
                        if (string.IsNullOrEmpty(v)) continue;
                        tally.TryGetValue(v, out var c); tally[v] = c + 1;
                    }
                    snapshotVotes = new Dictionary<string, string>(recruit.Votes, StringComparer.OrdinalIgnoreCase);

                    // First-vote tiebreak: pick the option with the highest
                    // count, breaking ties by lowest VoteSeq stamp among
                    // voters who picked that option.
                    string best = null; int bestCount = -1; long bestFirstSeq = long.MaxValue;
                    foreach (var kv in tally)
                    {
                        long firstSeq = long.MaxValue;
                        foreach (var v in recruit.Votes)
                            if (string.Equals(v.Value, kv.Key, StringComparison.OrdinalIgnoreCase)
                                && recruit.VoteSeq.TryGetValue(v.Key, out var seq) && seq < firstSeq) firstSeq = seq;
                        bool win = kv.Value > bestCount
                                || (kv.Value == bestCount && firstSeq < bestFirstSeq);
                        if (win) { best = kv.Key; bestCount = kv.Value; bestFirstSeq = firstSeq; }
                    }
                    if (best == null)
                    {
                        // No votes — default to the first option.
                        best = (recruit.Branch?.Options != null && recruit.Branch.Options.Count > 0)
                            ? recruit.Branch.Options[0].Id : null;
                        viaTimeout = true;
                    }
                    else viaTimeout = false;
                    winnerId    = best;
                    winnerVotes = bestCount > 0 ? bestCount : 0;
                }

                BranchEffect effect = null;
                if (winnerId != null && recruit.BranchEffects != null)
                    recruit.BranchEffects.TryGetValue(winnerId, out effect);

                if (effect != null)
                    ApplyBranchEffectToOutcomes(result.Outcomes, effect);

                Publish("dungeon.choice", new
                {
                    optionId    = winnerId,
                    votes       = winnerVotes,
                    tally       = tally,
                    viaTimeout  = viaTimeout,
                    resolveText = effect?.ResolveText ?? "",
                    glyph       = effect?.Glyph ?? "",
                });
            }
            catch (Exception ex)
            {
                ErrorLog.Write("DungeonModule.ResolveBranch", ex);
            }

            ApplyAndCompleteRun(recruit, result, cfg, partySize);
        }

        // Distributes a BranchEffect across the outcomes per the
        // TargetUser policy ("" = everyone evenly, "host" = the recruit
        // host, "lowest" = lowest-HP hero). Gold deltas apply per
        // survivor; HP deltas apply per affected hero.
        private static void ApplyBranchEffectToOutcomes(List<DungeonOutcome> outcomes, BranchEffect effect)
        {
            if (outcomes == null || outcomes.Count == 0 || effect == null) return;
            var target = (effect.TargetUser ?? "").Trim().ToLowerInvariant();
            List<DungeonOutcome> hpTargets;
            if (target == "lowest")
            {
                var sorted = outcomes.OrderBy(o => o.HpDelta).ToList();
                hpTargets = sorted.Count > 0 ? new List<DungeonOutcome> { sorted[0] } : outcomes;
            }
            else if (target == "host")
            {
                hpTargets = new List<DungeonOutcome> { outcomes[0] };
            }
            else
            {
                hpTargets = outcomes;
            }
            foreach (var o in hpTargets) o.HpDelta += effect.HpDelta;
            if (effect.GoldDelta != 0)
            {
                foreach (var o in outcomes)
                    if (o.Survived) o.GoldGained = Math.Max(0, o.GoldGained + (int)effect.GoldDelta);
            }
        }

        // Original "apply outcomes + publish completed" path, factored out
        // so both the linear and branching flows can call it.
        private void ApplyAndCompleteRun(DungeonRecruit recruit, DungeonRunResult result, DungeonConfig cfg, int partySize)
        {
            try
            {
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
                    partySize   = partySize,
                    outcomes    = result.Outcomes.Select(o =>
                    {
                        // Re-read the post-apply hero so the loot card has
                        // the avatar/class/custom state the viewer just
                        // configured (and to confirm the level-up if XP
                        // bumped them).
                        var refreshed = DungeonGameStore.Instance.Get(o.Platform, o.Handle)
                                        ?? new HeroState { Handle = o.Handle, Platform = o.Platform };
                        var cls = DungeonContent.ClassByName(refreshed.ClassName);
                        // Resolve equipped slots → small dicts the overlay
                        // sprite composer reads. Same shape HeroToPayload uses.
                        var refreshedEquipped = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
                        if (refreshed.Equipped != null && refreshed.Bag != null && refreshed.Equipped.Count > 0)
                        {
                            var byId = new Dictionary<string, InventoryItem>(StringComparer.OrdinalIgnoreCase);
                            foreach (var it in refreshed.Bag) if (!string.IsNullOrEmpty(it.Id)) byId[it.Id] = it;
                            foreach (var kv in refreshed.Equipped)
                            {
                                if (!byId.TryGetValue(kv.Value ?? "", out var item)) continue;
                                refreshedEquipped[kv.Key] = new
                                {
                                    slot    = item.Slot ?? "",
                                    rarity  = item.Rarity ?? "",
                                    name    = item.Name ?? "",
                                    glyph   = item.Glyph ?? "",
                                    setName = item.SetName ?? ""
                                };
                            }
                        }
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
                            equipped   = refreshedEquipped,
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
                    challengerEquipped = ResolveEquippedSnapshot(attacker),
                    defenderEquipped   = ResolveEquippedSnapshot(defender),
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

        // Phase BR — record a viewer's branch vote. One vote per voter
        // (subsequent votes overwrite — first-vote tiebreak still uses the
        // viewer's INITIAL VoteSeq, so changing a vote can't game ties).
        private void CastBranchVote(EventContext ctx, string optionId)
        {
            DungeonRecruit recruit;
            lock (_gate) { recruit = _activeDungeon; }
            if (recruit == null || recruit.Branch == null) return;
            optionId = (optionId ?? "").Trim().ToLowerInvariant();
            if (optionId.Length == 0) return;
            // Validate against the actual branch's options.
            var ok = false;
            foreach (var o in recruit.Branch.Options)
            {
                if (string.Equals(o.Id, optionId, StringComparison.OrdinalIgnoreCase)) { ok = true; break; }
            }
            if (!ok) return;
            var voterKey = (ctx.Platform.ToShortName() + ":" + (ctx.User ?? "")).ToLowerInvariant();
            lock (recruit.Sync)
            {
                recruit.Votes[voterKey] = optionId;
                if (!recruit.VoteSeq.ContainsKey(voterKey))
                    recruit.VoteSeq[voterKey] = ++recruit.VoteCounter;
            }
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
            // Routes the reply on the platform the command came from.
            try
            {
                new MultiPlatformSender(CphPlatformSender.Instance).Send(ctx.Platform, msg, SettingsManager.Instance.Current.Platforms);
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

        /// <summary>Build the slot→item-snapshot dict used by the overlay's
        /// pixel-art sprite composer. Same shape HeroToPayload emits but
        /// callable from the duel + outcome paths so we don't duplicate
        /// the bag-id lookup three times.</summary>
        private static Dictionary<string, object> ResolveEquippedSnapshot(HeroState h)
        {
            var equipped = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
            if (h?.Equipped == null || h.Bag == null || h.Equipped.Count == 0) return equipped;
            var byId = new Dictionary<string, InventoryItem>(StringComparer.OrdinalIgnoreCase);
            foreach (var it in h.Bag) if (!string.IsNullOrEmpty(it.Id)) byId[it.Id] = it;
            foreach (var kv in h.Equipped)
            {
                if (string.IsNullOrEmpty(kv.Value)) continue;
                if (!byId.TryGetValue(kv.Value, out var item)) continue;
                // Prefer the item's own stored WeaponType (set on drop
                // post-expansion); fall back to a catalog name-match for
                // pre-expansion bag entries that lack the field.
                string weaponType = item.WeaponType ?? "";
                if (string.IsNullOrEmpty(weaponType) &&
                    string.Equals(item.Slot, "weapon", StringComparison.OrdinalIgnoreCase))
                {
                    foreach (var def in DungeonContent.Loot)
                    {
                        if (string.Equals(def.Name, item.Name, StringComparison.OrdinalIgnoreCase))
                        { weaponType = def.WeaponType ?? ""; break; }
                    }
                }
                equipped[kv.Key] = new
                {
                    slot       = item.Slot    ?? "",
                    rarity     = item.Rarity  ?? "",
                    name       = item.Name    ?? "",
                    glyph      = item.Glyph   ?? "",
                    setName    = item.SetName ?? "",
                    weaponType
                };
            }
            return equipped;
        }

        /// <summary>Shared shape for every "hero on the wire" event so the
        /// overlay only needs one rendering path. Includes the custom
        /// map (skin / hair / outfit / cape) AND a slot→item dict for
        /// every equipped piece so the composed sprite can render the
        /// actual armour the viewer is wearing — ironclad helmet, dragon-
        /// scale plate, shadow cowl, etc. — instead of a generic class-
        /// default outfit.</summary>
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
                custom      = h.Custom     ?? new Dictionary<string, string>(),
                equipped    = ResolveEquippedSnapshot(h)
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
            // Phase BR — branch-vote state, populated by DungeonModule
            // while a branching run is mid-vote. Votes are stored as
            // (voterKey -> optionId) so the same viewer voting twice
            // doesn't multiply their weight; the first-wins tiebreak is
            // enforced by stamping VoteSeq alongside.
            public DungeonScene Branch;
            public Dictionary<string, BranchEffect> BranchEffects;
            public DateTime BranchOpenedUtc;
            public readonly Dictionary<string, string> Votes =
                new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            public readonly Dictionary<string, long> VoteSeq =
                new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
            public long VoteCounter;
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
