using System;
using System.IO;
using System.Threading;
using Loadout.Settings;

namespace Loadout.Util
{
    /// <summary>
    /// One-line append-only error log at <c>&lt;data&gt;/loadout-errors.log</c>.
    /// Bounded — auto-rotates at 1 MB by trimming the oldest half.
    ///
    /// Modules already swallow exceptions to keep the stream alive; this gives
    /// the streamer a place to look when something silently isn't working.
    /// We log via Debug AND to disk so devs see things in the SB log too.
    /// </summary>
    public static class ErrorLog
    {
        private static readonly object _gate = new object();
        private const long MaxSizeBytes = 1024 * 1024;     // 1 MB

        public static void Write(string source, string message)
        {
            var line = DateTime.UtcNow.ToString("o") + "  [" + (source ?? "?") + "]  " + (message ?? "");
            System.Diagnostics.Debug.WriteLine("[Loadout-Err] " + line);
            try { Sb.SbBridge.Instance.LogError("[Loadout] " + source + ": " + message); } catch { }

            var folder = SettingsManager.Instance.DataFolder;
            if (string.IsNullOrEmpty(folder)) return;
            var path = Path.Combine(folder, "loadout-errors.log");

            lock (_gate)
            {
                try
                {
                    File.AppendAllText(path, line + Environment.NewLine);
                    if (new FileInfo(path).Length > MaxSizeBytes) Rotate(path);
                }
                catch { /* never let logging itself throw */ }
            }
        }

        public static void Write(string source, Exception ex)
        {
            if (ex == null) return;
            // Include the call stack so a bare "NullReferenceException" is
            // actually traceable. Stripping AT_System.Runtime / AT_xunit etc.
            // would be nice but the volume here is low - logging the full
            // stack uses < 2KB per failure and disambiguates everything.
            var inner = ex.InnerException == null
                ? ""
                : "  >> " + ex.InnerException.GetType().Name + ": " + ex.InnerException.Message;
            var stack = ex.StackTrace == null ? "" : "\n" + ex.StackTrace.TrimEnd();
            Write(source, ex.GetType().Name + ": " + ex.Message + inner + stack);
        }

        private static void Rotate(string path)
        {
            try
            {
                var lines = File.ReadAllLines(path);
                var keep = lines.Length / 2;
                File.WriteAllLines(path, lines, System.Text.Encoding.UTF8);
                using var sw = new StreamWriter(path, false);
                for (int i = lines.Length - keep; i < lines.Length; i++) sw.WriteLine(lines[i]);
            }
            catch { }
        }
    }
}
