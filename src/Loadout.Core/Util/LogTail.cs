using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using Loadout.Settings;

namespace Loadout.Util
{
    /// <summary>
    /// Reads the tail of a log file without loading the whole thing into
    /// memory. Used by the in-app Logs tab to surface recent errors without
    /// the streamer having to dig in %APPDATA%.
    ///
    /// We open with FileShare.ReadWrite + Delete so we don't fight ErrorLog
    /// for the writer's handle - it's appending, we're reading.
    /// </summary>
    public static class LogTail
    {
        /// <summary>Default error log path (created lazily by ErrorLog.Write).</summary>
        public static string ErrorLogPath
        {
            get
            {
                var folder = SettingsManager.Instance.DataFolder;
                return string.IsNullOrEmpty(folder) ? null : Path.Combine(folder, "loadout-errors.log");
            }
        }

        /// <summary>
        /// Returns up to <paramref name="maxLines"/> lines from the end of the
        /// file. If the file doesn't exist, returns a single placeholder line.
        /// </summary>
        public static string ReadTail(string path, int maxLines = 200)
        {
            if (string.IsNullOrEmpty(path) || !File.Exists(path))
                return "(no log yet - errors will appear here when they happen.)";

            try
            {
                // Read the full file under shared access. Even on a busy
                // streamer's machine the error log is bounded by ErrorLog's
                // own rotation cap; we don't expect huge sizes.
                using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                using (var sr = new StreamReader(fs, Encoding.UTF8, true))
                {
                    var lines = new LinkedList<string>();
                    string line;
                    while ((line = sr.ReadLine()) != null)
                    {
                        lines.AddLast(line);
                        if (lines.Count > maxLines) lines.RemoveFirst();
                    }
                    if (lines.Count == 0)
                        return "(log is empty - nothing has thrown yet.)";
                    var sb = new StringBuilder();
                    foreach (var l in lines) sb.AppendLine(l);
                    return sb.ToString();
                }
            }
            catch (Exception ex)
            {
                return "(failed to read log: " + ex.Message + ")";
            }
        }

        /// <summary>
        /// Wipes the log file. Best-effort: if SB has the writer open
        /// exclusively (it shouldn't, but...) we silently bail.
        /// </summary>
        public static bool Clear(string path)
        {
            if (string.IsNullOrEmpty(path) || !File.Exists(path)) return true;
            try
            {
                File.WriteAllText(path, "");
                return true;
            }
            catch { return false; }
        }
    }
}
