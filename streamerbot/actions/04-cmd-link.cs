// LOADOUT — !link
// Viewers run: !link <platform> <username>
// Creates a pending identity-link request that the broadcaster/mods approve via
// the Settings UI's Identity tab or with !linkapprove.
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

            var srcUser     = args.ContainsKey("user")        ? args["user"]?.ToString() ?? "" : "";
            var rawInput    = args.ContainsKey("rawInput")    ? args["rawInput"]?.ToString() ?? "" : "";
            var eventSource = args.ContainsKey("eventSource") ? args["eventSource"]?.ToString() ?? "twitch" : "twitch";

            var parts = rawInput.Trim().Split(new[] { ' ' }, 2, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 2)
            {
                CPH.SendMessage("@" + srcUser + " usage: !link <platform> <username>  (twitch, tiktok, youtube, kick)");
                return false;
            }

            var reqId = (string)_entry.GetMethod("RequestLink", BindingFlags.Public | BindingFlags.Static)
                .Invoke(null, new object[] { eventSource, srcUser, parts[0], parts[1] });

            if (string.IsNullOrEmpty(reqId))
            {
                CPH.SendMessage("@" + srcUser + " couldn't create link request — check the platform name and username.");
                return false;
            }

            var shortId = reqId.Substring(0, Math.Min(8, reqId.Length));
            CPH.SendMessage("@" + srcUser + " link request created (id " + shortId + "). A mod will approve it shortly.");
            return true;
        }
        catch (Exception ex)
        {
            CPH.LogError("[Loadout] !link failed: " + ex.Message);
            return false;
        }
    }
}
