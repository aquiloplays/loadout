// LOADOUT — !linkapprove (mod-only)
// Mods run: !linkapprove <request-id-prefix>
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

            var approver = args.ContainsKey("user") ? args["user"]?.ToString() ?? "mod" : "mod";
            var rawInput = args.ContainsKey("rawInput") ? args["rawInput"]?.ToString() ?? "" : "";
            var prefix = rawInput.Trim();

            if (string.IsNullOrEmpty(prefix))
            {
                CPH.SendMessage("@" + approver + " usage: !linkapprove <id-prefix>");
                return false;
            }

            var ok = (bool)_entry.GetMethod("ApproveLink", BindingFlags.Public | BindingFlags.Static)
                .Invoke(null, new object[] { prefix, approver });

            CPH.SendMessage(ok
                ? "✅ Link " + prefix + " approved by " + approver + "."
                : "❌ No pending link with id " + prefix + ".");
            return ok;
        }
        catch (Exception ex)
        {
            CPH.LogError("[Loadout] !linkapprove failed: " + ex.Message);
            return false;
        }
    }
}
