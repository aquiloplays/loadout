using System;
using System.Collections.Generic;
using System.Linq;
using Loadout.Bus;
using Loadout.Sb;
using Loadout.Settings;

namespace Loadout.Modules
{
    /// <summary>
    /// Publishes the current set of viewer-facing commands on the Aquilo Bus
    /// (kind <c>commands.list</c>). The "Available commands" overlay
    /// subscribes and rotates one entry at a time as a tiny on-stream helper.
    ///
    /// Why a dedicated module: the command list is computed from several
    /// places (info commands, custom commands, counters, Bolts, !clip,
    /// check-in cross-platform command). Keeping the rendering logic here
    /// means there's exactly one source of truth, and it can re-run on
    /// every settings save without each individual module needing to know
    /// about the overlay.
    ///
    /// Lifecycle:
    ///   - Constructed by <see cref="SbEventDispatcher.RegisterDefaultModules"/>
    ///     after the bus is already up.
    ///   - Publishes once on construction (initial snapshot).
    ///   - Re-publishes on every <see cref="SettingsManager.SettingsChanged"/>.
    ///   - Replies to the bus message <c>commands.requestList</c> from a
    ///     freshly-connected overlay client.
    /// </summary>
    public sealed class CommandsBroadcaster : IEventModule
    {
        public CommandsBroadcaster()
        {
            // Re-publish whenever settings change. The handler runs synchronously
            // on the mutator's thread; Publish is fast (queues onto the bus's
            // outbound writer) so this is safe.
            SettingsManager.Instance.SettingsChanged += (s, e) => SafePublish();

            // Allow overlay clients (or any other tool) to ask for the snapshot
            // on connect rather than waiting for the next settings change.
            // The handler signature returns a reply BusMessage; we just want
            // the side effect of publishing, so reply null (the bus is fine
            // with that - it's just a synchronous rendezvous return value).
            AquiloBus.Instance.RegisterHandler("commands.requestList",
                (fromClient, incoming) => { SafePublish(); return null; });

            // Initial snapshot. May fire before any client has subscribed -
            // that's fine; the overlay will request a fresh list on connect.
            SafePublish();
        }

        public void OnEvent(EventContext ctx) { /* no-op */ }
        public void OnTick() { /* no-op */ }

        private static void SafePublish()
        {
            try { Publish(); }
            catch (Exception ex) { Util.ErrorLog.Write("CommandsBroadcaster.Publish", ex); }
        }

        private static void Publish()
        {
            var s = SettingsManager.Instance.Current;
            var list = BuildList(s);
            // Apply per-command ticker preferences (hide / group) AFTER
            // BuildList so the dynamic list (which depends on which
            // modules are enabled, custom commands, counters, etc.) is
            // the input to the rule set. Hidden first, then grouping
            // collapses anything matching a group's command list into
            // a single tile.
            list = ApplyTickerEntryPrefs(list, s.CommandsTickerEntries);
            AquiloBus.Instance.Publish("commands.list", new
            {
                commands = list,
                ts       = DateTime.UtcNow
            });

            // Per-category icon overrides. Overlays cache and use these
            // instead of their hardcoded emoji defaults. Re-published
            // alongside commands.list so a freshly-connected overlay
            // client gets both atomically.
            var icons = s.CommandsTickerIcons?.ByCategory ?? new Dictionary<string, string>();
            AquiloBus.Instance.Publish("commands.icons", new
            {
                byCategory = icons,
                ts         = DateTime.UtcNow
            });
        }

        /// <summary>
        /// Builds the canonical list of commands a viewer can use right now.
        /// Order matters - the overlay rotates in this order, so we put the
        /// "evergreen" commands first (uptime, commands, lurk) and the more
        /// niche ones (counters, anniversary) later.
        /// </summary>
        private static List<CommandEntry> BuildList(LoadoutSettings s)
        {
            var list = new List<CommandEntry>();

            // ------ Info / built-in (Modules.InfoCommands) ------
            if (s.Modules.InfoCommands)
            {
                list.Add(new CommandEntry("!commands",   "info", "list every command available"));
                list.Add(new CommandEntry("!uptime",     "info", "how long the stream has been live"));
                list.Add(new CommandEntry("!followage",  "info", "how long you have followed"));
                list.Add(new CommandEntry("!accountage", "info", "how old your account is"));
                list.Add(new CommandEntry("!title",      "info", "current stream title"));
                list.Add(new CommandEntry("!game",       "info", "current category being played"));
                list.Add(new CommandEntry("!so @user",   "info", "shoutout another streamer"));
                list.Add(new CommandEntry("!lurk",       "info", "mark yourself as lurking"));
                list.Add(new CommandEntry("!unlurk",     "info", "you're back from lurking"));
                // !discord — surface only when the streamer set a link
                // either via the structured SocialLinks["discord"] entry
                // or the legacy Discord string. Real Discord brand logo
                // shows up in the ticker via platforms=["discord"].
                var hasDiscord =
                    (s.InfoCommands.SocialLinks != null && s.InfoCommands.SocialLinks.TryGetValue("discord", out var dv) && !string.IsNullOrWhiteSpace(dv)) ||
                    !string.IsNullOrEmpty(s.InfoCommands.Discord);
                if (hasDiscord)
                    list.Add(new CommandEntry("!discord", "info", "join the streamer's Discord", new[] { "discord" }));

                // !socials — drives the badge from the streamer's actual
                // configured platforms. Up to ~4 logos render as a strip;
                // legacy single-string Socials still surfaces the command
                // but with no platforms array (falls back to default).
                var socialPlatforms = (s.InfoCommands.SocialLinks != null && s.InfoCommands.SocialLinks.Count > 0)
                    ? s.InfoCommands.SocialLinks
                        .Where(kv => !string.IsNullOrWhiteSpace(kv.Key) && !string.IsNullOrWhiteSpace(kv.Value))
                        .Select(kv => kv.Key.ToLowerInvariant())
                        .ToArray()
                    : null;
                if ((socialPlatforms != null && socialPlatforms.Length > 0) ||
                    !string.IsNullOrEmpty(s.InfoCommands.Socials))
                    list.Add(new CommandEntry("!socials", "info", "all my social links", socialPlatforms));

                // !gamertags — opt-in. Same multi-icon strip trick as
                // !socials, scoped to game platforms.
                if (s.InfoCommands.GamerTagsEnabled && s.InfoCommands.GamerTags != null && s.InfoCommands.GamerTags.Count > 0)
                {
                    var gtCmd = string.IsNullOrWhiteSpace(s.InfoCommands.GamerTagsCommand)
                        ? "!gamertags"
                        : (s.InfoCommands.GamerTagsCommand.StartsWith("!") ? s.InfoCommands.GamerTagsCommand : "!" + s.InfoCommands.GamerTagsCommand);
                    var gamePlatforms = s.InfoCommands.GamerTags
                        .Where(kv => !string.IsNullOrWhiteSpace(kv.Key) && !string.IsNullOrWhiteSpace(kv.Value))
                        .Select(kv => kv.Key.ToLowerInvariant())
                        .ToArray();
                    list.Add(new CommandEntry(gtCmd, "info", "friend the streamer on these platforms", gamePlatforms));
                }

                list.Add(new CommandEntry("!quote",      "info", "pull a saved quote"));
                list.Add(new CommandEntry("!profile",    "info", "show your stat card on stream"));
            }

            // ------ Custom commands ------
            if (s.Modules.InfoCommands && s.InfoCommands?.Custom != null)
            {
                foreach (var c in s.InfoCommands.Custom)
                {
                    if (string.IsNullOrEmpty(c.Name)) continue;
                    var firstLine = (c.Response ?? "").Trim();
                    // Trim very long custom responses so the overlay stays small.
                    var desc = firstLine.Length > 60 ? firstLine.Substring(0, 57) + "..." : firstLine;
                    list.Add(new CommandEntry("!" + c.Name, "custom", desc));
                }
            }

            // ------ Counters ------
            if (s.Modules.Counters && s.Counters?.Counters != null)
            {
                foreach (var c in s.Counters.Counters)
                {
                    if (string.IsNullOrEmpty(c.Name)) continue;
                    list.Add(new CommandEntry("!" + c.Name,
                        "counter", "current " + (c.Display ?? c.Name) + " (mods: ±N)"));
                }
            }

            // ------ Bolts wallet ------
            if (s.Modules.Bolts)
            {
                var b = s.Bolts;
                var bolts = (b?.DisplayName ?? "Bolts").ToLower();
                list.Add(new CommandEntry("!bolts",       "bolts", "your " + bolts + " balance"));
                list.Add(new CommandEntry("!leaderboard", "bolts", "top 5 " + bolts + " holders"));
                list.Add(new CommandEntry("!gift @user N","bolts", "send some " + bolts + " to a friend"));
                if (s.RotationIntegration != null && s.RotationIntegration.Enabled)
                {
                    var cmd  = s.RotationIntegration.Command ?? "!boltsong";
                    var cost = s.RotationIntegration.Cost;
                    list.Add(new CommandEntry(cmd + " <song>", "bolts",
                        "spend " + cost + " " + bolts + " to request a song"));
                }
                // ------ Bolts minigames ------
                // The three games are baked into BoltsModule and surface
                // through the same wallet, so they live under the "bolts"
                // category in the ticker. Streamers can hide them by
                // disabling the Bolts module entirely (the games can't
                // run without a wallet).
                list.Add(new CommandEntry("!coinflip <wager>",  "bolts", "50/50 double-or-nothing flip"));
                list.Add(new CommandEntry("!dice <wager> <1-6>","bolts", "roll a d6 against your target — 5x payout"));
                list.Add(new CommandEntry("!slots <wager>",     "bolts", "spin the reels — 3-of-a-kind jackpot"));
            }

            // ------ Clip ------
            if (s.Modules.Clips && s.Clips != null && s.Clips.Enabled)
            {
                var cmd = s.Clips.Command ?? "!clip";
                if (!cmd.StartsWith("!")) cmd = "!" + cmd;
                list.Add(new CommandEntry(cmd, "clip", "clip the last 30s and post the URL"));
            }

            // ------ Now playing (Rotation widget) ------
            if (s.RotationConnection != null && s.RotationConnection.SongCommandEnabled)
            {
                var cmd = s.RotationConnection.SongCommand ?? "!song";
                if (!cmd.StartsWith("!")) cmd = "!" + cmd;
                list.Add(new CommandEntry(cmd, "info", "what's playing on the streamer's Spotify"));
            }

            // ------ Viewer profile self-edit ------
            if (s.ViewerProfiles != null && s.ViewerProfiles.ChatCommandsEnabled)
            {
                list.Add(new CommandEntry("!profile [@user]",       "info", "show a viewer's profile + bolts"));
                list.Add(new CommandEntry("!setbio <text>",         "info", "save your own bio for !profile"));
                list.Add(new CommandEntry("!setpfp <url>",          "info", "set your !profile picture (PNG/JPG link)"));
                list.Add(new CommandEntry("!setpronouns <txt>",     "info", "save your pronouns"));
                list.Add(new CommandEntry("!setsocial <plat> <h>",  "info", "save a social handle (twitter/ig/bsky/...)"));
                list.Add(new CommandEntry("!setgamertag <plat> <t>","info", "save a gamer tag (psn/xbox/steam/...)"));
                list.Add(new CommandEntry("!clearprofile",          "info", "wipe your saved profile"));
            }

            // ------ Daily check-in ------
            if (s.Modules.DailyCheckIn && s.CheckIn != null)
            {
                var cmd = s.CheckIn.CrossPlatformCommand ?? "!checkin";
                if (!string.IsNullOrEmpty(cmd))
                    list.Add(new CommandEntry(cmd, "checkin", "show up on the daily check-in overlay"));
            }

            // ------ Identity ------
            // !link is always there - identity is a free, baseline feature.
            list.Add(new CommandEntry("!link <plat> <user>",       "info", "link your accounts across platforms"));
            list.Add(new CommandEntry("!linkapprove <id>",         "mod",  "(mod) approve a pending link"));

            return list;
        }

        /// <summary>Apply hide/group preferences from settings. Hide drops
        /// matching commands; groups collapse multiple commands into a
        /// single entry whose name is the joined list and desc is the
        /// group's Label. Order is preserved: a group lands at the
        /// position of its first matched member, subsequent matches are
        /// stripped.</summary>
        private static List<CommandEntry> ApplyTickerEntryPrefs(List<CommandEntry> input, CommandsTickerEntriesConfig prefs)
        {
            if (input == null || input.Count == 0) return input ?? new List<CommandEntry>();
            if (prefs == null) return input;

            // Build a fast-match lookup for hidden commands. Comparison
            // is case-insensitive on the entry's full name (which may
            // include the args hint, e.g. "!gift @user N") — a streamer
            // can paste the exact ticker text or the bare base name.
            var hidden = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (prefs.HiddenCommands != null)
            {
                foreach (var h in prefs.HiddenCommands)
                {
                    var t = (h ?? "").Trim();
                    if (t.Length == 0) continue;
                    hidden.Add(t);
                    // Also accept bare names without args (so "!gift" matches "!gift @user N")
                    var spaceIdx = t.IndexOf(' ');
                    if (spaceIdx > 0) hidden.Add(t.Substring(0, spaceIdx));
                }
            }

            // For groups: build per-group member sets + assign each member
            // to the FIRST group that claims it (earlier groups win on
            // overlap). The output entry replaces the first matched
            // member's slot and drops the rest.
            var groups = (prefs.Groups ?? new List<CommandsTickerGroup>())
                .Where(g => g != null && g.Commands != null && g.Commands.Count > 0)
                .ToList();
            var memberToGroup = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            for (int gi = 0; gi < groups.Count; gi++)
            {
                foreach (var c in groups[gi].Commands)
                {
                    var t = (c ?? "").Trim();
                    if (t.Length == 0) continue;
                    if (!memberToGroup.ContainsKey(t)) memberToGroup[t] = gi;
                    var spaceIdx = t.IndexOf(' ');
                    if (spaceIdx > 0)
                    {
                        var bare = t.Substring(0, spaceIdx);
                        if (!memberToGroup.ContainsKey(bare)) memberToGroup[bare] = gi;
                    }
                }
            }

            var output = new List<CommandEntry>(input.Count);
            // Track which groups have already been emitted so the second
            // matched member doesn't double-render the group tile.
            var emittedGroups = new HashSet<int>();
            // And which member commands actually appeared (so the joined
            // group name shows only the commands that are live this run).
            var matchedMembers = new Dictionary<int, List<string>>();

            // First pass: determine which commands match a group + collect
            // their canonical names. We need this before pass two so the
            // group tile's joined name reflects only the dynamically-live
            // commands (e.g. !discord drops out when no discord link is set).
            foreach (var entry in input)
            {
                if (entry == null || string.IsNullOrEmpty(entry.name)) continue;
                if (hidden.Contains(entry.name)) continue;
                int gi;
                if (TryFindGroup(entry.name, memberToGroup, out gi))
                {
                    if (!matchedMembers.TryGetValue(gi, out var list)) { list = new List<string>(); matchedMembers[gi] = list; }
                    list.Add(entry.name);
                }
            }

            // Second pass: emit the actual ticker list. Hidden commands
            // are dropped; the first member of a group gets replaced by
            // the group tile; subsequent members are dropped.
            foreach (var entry in input)
            {
                if (entry == null || string.IsNullOrEmpty(entry.name)) continue;
                if (hidden.Contains(entry.name))
                {
                    // Also catch the "!gift @user N" → "!gift" hidden case.
                    var spaceIdx = entry.name.IndexOf(' ');
                    if (spaceIdx <= 0) continue;
                }
                int gi;
                if (TryFindGroup(entry.name, memberToGroup, out gi))
                {
                    if (emittedGroups.Contains(gi)) continue;
                    emittedGroups.Add(gi);
                    var g = groups[gi];
                    var joinedName = string.Join(" / ", matchedMembers[gi]);
                    var groupCat   = string.IsNullOrWhiteSpace(g.Cat) ? "info" : g.Cat;
                    var label      = string.IsNullOrWhiteSpace(g.Label) ? joinedName : g.Label;
                    output.Add(new CommandEntry(joinedName, groupCat, label));
                    continue;
                }
                output.Add(entry);
            }
            return output;
        }

        private static bool TryFindGroup(string entryName, Dictionary<string, int> memberToGroup, out int groupIndex)
        {
            if (memberToGroup.TryGetValue(entryName, out groupIndex)) return true;
            var spaceIdx = entryName.IndexOf(' ');
            if (spaceIdx > 0 && memberToGroup.TryGetValue(entryName.Substring(0, spaceIdx), out groupIndex)) return true;
            groupIndex = -1;
            return false;
        }

        // POCO so Newtonsoft serializes camelCase via the bus envelope.
        // `platforms` is optional — when set, overlays render the brand
        // logo(s) instead of the category emoji (one platform = single
        // logo, multiple = icon strip in the badge slot).
        private sealed class CommandEntry
        {
            public string   name      { get; }
            public string   cat       { get; }
            public string   desc      { get; }
            public string[] platforms { get; set; }
            public CommandEntry(string n, string c, string d) { name = n; cat = c; desc = d; }
            public CommandEntry(string n, string c, string d, string[] p) { name = n; cat = c; desc = d; platforms = p; }
        }
    }
}
