// PrinterBot - Render + Thermal Print
// Renders the receipt PNG via the configured renderer and pushes it
// to the thermal printer. Sets %printedImagePath% for the relay step
// to pick up. The actual render/print is delegated to PrinterBotEntry
// in the loaded Loadout.dll (which already handles the receipt layout
// + ESC/POS framing); this stub just bridges the SB args into it.
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
                if (!File.Exists(dll)) { CPH.LogWarn("[PrinterBot] DLL missing, render skipped."); return true; }
                _entry = Assembly.LoadFrom(dll).GetType("Loadout.PrinterBotEntry");
                if (_entry == null) { CPH.LogWarn("[PrinterBot] PrinterBotEntry type not found."); return true; }
            }
            var render = _entry.GetMethod("RenderAndPrint", BindingFlags.Public | BindingFlags.Static);
            if (render == null) { CPH.LogWarn("[PrinterBot] RenderAndPrint method not found."); return true; }
            var result = render.Invoke(null, new object[] { CPH, (IDictionary<string, object>)args }) as string;
            if (!string.IsNullOrEmpty(result))
            {
                CPH.SetArgument("printedImagePath", result);
            }
            return true;
        }
        catch (Exception ex)
        {
            CPH.LogError("[PrinterBot] Render/print failed: " + ex.Message);
            return true;
        }
    }
}
