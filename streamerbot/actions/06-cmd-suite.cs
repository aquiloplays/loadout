// LOADOUT — !loadout
// Public command: replies with version + settings location. Mod-only branches:
// !loadout settings (opens UI), !loadout reload (reloads settings.json).
using System;
using System.IO;
using System.Reflection;

public class CPHInline
{
    private static Type _entry;

    public bool Execute()
    {
        try
        {
            if (_entry == null)
            {
                var dll = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "data", "Loadout", "Loadout.dll");
                if (!File.Exists(dll)) return false;
                _entry = Assembly.LoadFrom(dll).GetType("Loadout.LoadoutEntry");
            }

            var rawInput = args.ContainsKey("rawInput") ? (args["rawInput"]?.ToString() ?? "").Trim() : "";
            var sub      = rawInput.Split(' ')[0].ToLowerInvariant();

            if (sub == "settings")
            {
                _entry.GetMethod("OpenSettings", BindingFlags.Public | BindingFlags.Static).Invoke(null, null);
                CPH.SendMessage("⚙️ Settings opened on the streamer's screen.");
                return true;
            }

            if (sub == "help" || sub == "?")
            {
                CPH.SendMessage("Loadout commands: !bolts · !leaderboard · !gift · !link · !loadout settings · !loadout quiet · !loadout reload (mod)");
                return true;
            }

            var role = (args.ContainsKey("userType") ? args["userType"]?.ToString() ?? "" : "").ToLowerInvariant();
            var isMod = role == "broadcaster" || role == "moderator" || role == "mod";

            // Mod-only chat noise toggle.
            if (sub == "quiet" || sub == "unquiet")
            {
                if (!isMod) return false;
                var nowQuiet = (bool)_entry.GetMethod("ToggleQuiet", BindingFlags.Public | BindingFlags.Static).Invoke(null, null);
                CPH.SendMessage(nowQuiet
                    ? "🔇 Loadout quiet mode ON — overlays still update; chat is calm."
                    : "🔊 Loadout quiet mode OFF.");
                return true;
            }

            // Mod-only: re-read settings.json without restarting SB.
            if (sub == "reload")
            {
                if (!isMod) return false;
                var ok = (bool)_entry.GetMethod("ReloadSettings", BindingFlags.Public | BindingFlags.Static).Invoke(null, null);
                CPH.SendMessage(ok ? "♻️ Loadout settings reloaded." : "❌ Reload failed — check logs.");
                return true;
            }

            var version = (string)_entry.GetMethod("Version", BindingFlags.Public | BindingFlags.Static).Invoke(null, null);
            CPH.SendMessage("🎒 Loadout v" + version + " — try !loadout help");
            return true;
        }
        catch (Exception ex)
        {
            CPH.LogError("[Loadout] !loadout failed: " + ex.Message);
            return false;
        }
    }
}
