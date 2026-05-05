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
            AquiloBus.Instance.Publish("commands.list", new
            {
                commands = list,
                ts       = DateTime.UtcNow
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
                if (!string.IsNullOrEmpty(s.InfoCommands.Discord))
                    list.Add(new CommandEntry("!discord", "info", "join the streamer's Discord"));
                if (!string.IsNullOrEmpty(s.InfoCommands.Socials))
                    list.Add(new CommandEntry("!socials", "info", "all social links"));
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
            }

            // ------ Clip ------
            if (s.Modules.Clips && s.Clips != null && s.Clips.Enabled)
            {
                var cmd = s.Clips.Command ?? "!clip";
                if (!cmd.StartsWith("!")) cmd = "!" + cmd;
                list.Add(new CommandEntry(cmd, "clip", "clip the last 30s and post the URL"));
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

        // POCO so Newtonsoft serializes camelCase via the bus envelope.
        private sealed class CommandEntry
        {
            public string name { get; }
            public string cat  { get; }
            public string desc { get; }
            public CommandEntry(string n, string c, string d) { name = n; cat = c; desc = d; }
        }
    }
}
