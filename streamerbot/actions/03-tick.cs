// LOADOUT — TICK
// Fires every 60 seconds via SB Timer trigger. Drives timed messages, hype
// train decay, and any future cadence-driven module. Keep this lightweight —
// it runs even when the streamer is offline.
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
            _entry.GetMethod("Tick", BindingFlags.Public | BindingFlags.Static)
                  .Invoke(null, new object[] { CPH });
            return true;
        }
        catch (Exception ex)
        {
            CPH.LogError("[Loadout] Tick failed: " + ex.Message);
            return false;
        }
    }
}
