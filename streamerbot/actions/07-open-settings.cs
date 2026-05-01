// LOADOUT — Open Settings
// Manual run from the Streamer.bot UI (right-click → Run Now, or pin to
// favorites, or assign a hotkey). Opens the WPF Settings window.
using System;
using System.IO;
using System.Reflection;

public class CPHInline
{
    public bool Execute()
    {
        try
        {
            var dll = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "data", "Loadout", "Loadout.dll");
            if (!File.Exists(dll)) { CPH.LogError("[Loadout] DLL missing — run 'Loadout: Boot' first."); return false; }
            var entry = Assembly.LoadFrom(dll).GetType("Loadout.LoadoutEntry");
            entry.GetMethod("Boot", BindingFlags.Public | BindingFlags.Static).Invoke(null, new object[] { CPH });
            entry.GetMethod("OpenSettings", BindingFlags.Public | BindingFlags.Static).Invoke(null, null);
            return true;
        }
        catch (Exception ex)
        {
            CPH.LogError("[Loadout] OpenSettings failed: " + ex.Message);
            return false;
        }
    }
}
