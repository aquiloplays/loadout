// LOADOUT — BOOT
// Triggered on Streamer.bot Started. Downloads Loadout.dll on first run, loads
// it via Assembly.LoadFrom (no References-tab editing needed), and calls
// LoadoutEntry.Boot(CPH). Idempotent — subsequent runs short-circuit.
using System;
using System.IO;
using System.Net;
using System.Reflection;

public class CPHInline
{
    private const string Repo    = "aquiloplays/loadout";
    private const string Version = "0.1.0";

    public bool Execute()
    {
        try
        {
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            var dataDir = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "data", "Loadout");
            Directory.CreateDirectory(dataDir);
            var dllPath = Path.Combine(dataDir, "Loadout.dll");

            if (!File.Exists(dllPath))
            {
                var url = "https://github.com/" + Repo + "/releases/download/v" + Version + "/Loadout.dll";
                CPH.LogInfo("[Loadout] Downloading DLL: " + url);
                using (var wc = new WebClient())
                {
                    wc.Headers.Add("User-Agent", "Loadout-Boot/" + Version);
                    wc.DownloadFile(url, dllPath);
                }
            }

            var asm = Assembly.LoadFrom(dllPath);
            var entry = asm.GetType("Loadout.LoadoutEntry", throwOnError: true);
            var boot = entry.GetMethod("Boot", BindingFlags.Public | BindingFlags.Static);
            var ok = (bool)boot.Invoke(null, new object[] { CPH });

            CPH.SetGlobalVar("loadout.booted", ok, true);
            CPH.SetGlobalVar("loadout.version", Version, true);
            return ok;
        }
        catch (Exception ex)
        {
            CPH.LogError("[Loadout] Boot failed: " + ex.Message);
            return false;
        }
    }
}
