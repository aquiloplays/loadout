// LOADOUT — CHAT TRAMPOLINE
// Triggered on every chat message across Twitch / YouTube / Kick. Forwards to
// the DLL which runs welcomes, hate-raid detection, copypasta filters, and
// activity tracking for timed messages.
using System;
using System.Collections.Generic;
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

            var dispatch = _entry.GetMethod("DispatchEvent", BindingFlags.Public | BindingFlags.Static);
            dispatch.Invoke(null, new object[] { CPH, "chat", (IDictionary<string, object>)args });
            return true;
        }
        catch (Exception ex)
        {
            CPH.LogError("[Loadout] Chat dispatch failed: " + ex.Message);
            return false;
        }
    }
}
