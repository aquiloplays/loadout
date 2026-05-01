// LOADOUT — Open Onboarding
// Manual run to re-open the onboarding wizard (auto-opens on first boot).
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
            entry.GetMethod("OpenOnboarding", BindingFlags.Public | BindingFlags.Static).Invoke(null, null);
            return true;
        }
        catch (Exception ex)
        {
            CPH.LogError("[Loadout] OpenOnboarding failed: " + ex.Message);
            return false;
        }
    }
}
