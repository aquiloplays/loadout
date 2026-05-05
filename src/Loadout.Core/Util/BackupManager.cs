using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using Loadout.Settings;

namespace Loadout.Util
{
    /// <summary>
    /// One-click backup/restore for the entire Loadout user data folder. The
    /// archive is just a regular .zip containing every file under
    /// %APPDATA%\Loadout\ (settings.json, counters/games/quotes/clips/sub-anniv
    /// JSONLs, the wallet store, the error log). Restore overwrites the
    /// current files; the streamer is responsible for re-launching SB so
    /// modules pick up the fresh settings (or hitting "Reload settings"
    /// from the General tab).
    ///
    /// Why not back up DPAPI'd Patreon tokens too: they're encrypted with
    /// the local user's master key, so they don't restore on another
    /// machine anyway. We exclude the patreon-state file so a backup
    /// shared between rigs doesn't import junk; the user signs in to
    /// Patreon once on the new machine.
    /// </summary>
    public static class BackupManager
    {
        // Files we deliberately exclude from the backup. DPAPI-encrypted
        // tokens won't decrypt on another machine; the .new files are
        // staged updates that get swapped on next SB launch (irrelevant
        // after restore).
        private static readonly string[] _excluded =
        {
            "patreon-state.json",
            "Loadout.dll.new",
            "Newtonsoft.Json.dll.new",
        };

        /// <summary>
        /// Zips every file in <see cref="SettingsManager.DataFolder"/> into
        /// the given output path. Excluded files (see _excluded) are
        /// skipped. Returns the number of files written.
        /// </summary>
        public static int Export(string outZipPath)
        {
            if (string.IsNullOrEmpty(outZipPath)) throw new ArgumentNullException(nameof(outZipPath));
            // Flush any pending settings save before reading.
            SettingsManager.Instance.SaveNow();
            var folder = SettingsManager.Instance.DataFolder;
            if (string.IsNullOrEmpty(folder) || !Directory.Exists(folder))
                throw new InvalidOperationException("Loadout data folder not initialized.");

            // Overwrite the destination atomically: write to a temp file,
            // replace at the end, so a crash mid-export doesn't leave a
            // half-written zip with the user's only backup.
            var tmp = outZipPath + ".tmp";
            if (File.Exists(tmp)) File.Delete(tmp);
            int count = 0;
            using (var fs = new FileStream(tmp, FileMode.CreateNew))
            using (var zip = new ZipArchive(fs, ZipArchiveMode.Create))
            {
                // Manifest line so import can sanity-check the shape.
                var manifest = "loadout-backup\n" +
                               "version=1\n" +
                               "createdUtc=" + DateTime.UtcNow.ToString("o") + "\n" +
                               "source=" + folder + "\n";
                var mEntry = zip.CreateEntry("MANIFEST.txt");
                using (var ms = mEntry.Open())
                using (var sw = new StreamWriter(ms))
                    sw.Write(manifest);

                foreach (var path in Directory.GetFiles(folder, "*", SearchOption.AllDirectories))
                {
                    var name = Path.GetFileName(path);
                    if (_excluded.Any(x => string.Equals(x, name, StringComparison.OrdinalIgnoreCase))) continue;
                    if (name.EndsWith(".bak", StringComparison.OrdinalIgnoreCase)) continue; // skip rotated backups
                    if (name.EndsWith(".tmp", StringComparison.OrdinalIgnoreCase)) continue;

                    var rel = path.Substring(folder.Length).TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                    var entry = zip.CreateEntry(rel.Replace('\\', '/'), CompressionLevel.Optimal);
                    entry.LastWriteTime = File.GetLastWriteTime(path);
                    using (var es = entry.Open())
                    using (var src = File.OpenRead(path))
                        src.CopyTo(es);
                    count++;
                }
            }
            if (File.Exists(outZipPath)) File.Delete(outZipPath);
            File.Move(tmp, outZipPath);
            return count;
        }

        /// <summary>
        /// Restores from a previously-exported zip. Each file in the archive
        /// is written into the live data folder, overwriting whatever's
        /// there. Pre-existing files NOT in the zip are left alone (we
        /// don't wipe the folder first). Returns the number of files
        /// restored.
        /// </summary>
        public static int Import(string inZipPath)
        {
            if (string.IsNullOrEmpty(inZipPath) || !File.Exists(inZipPath))
                throw new FileNotFoundException("Backup not found", inZipPath ?? "");
            var folder = SettingsManager.Instance.DataFolder;
            if (string.IsNullOrEmpty(folder) || !Directory.Exists(folder))
                throw new InvalidOperationException("Loadout data folder not initialized.");

            int count = 0;
            using (var zip = ZipFile.OpenRead(inZipPath))
            {
                // Validate the manifest if present. Older / hand-crafted
                // zips might omit it - we accept those too, just less
                // confidently. The point is to refuse arbitrary zips
                // someone clicked by mistake.
                var manifest = zip.GetEntry("MANIFEST.txt");
                if (manifest != null)
                {
                    using (var ms = manifest.Open())
                    using (var sr = new StreamReader(ms))
                    {
                        var first = sr.ReadLine();
                        if (first == null || !first.StartsWith("loadout-backup", StringComparison.OrdinalIgnoreCase))
                            throw new InvalidDataException("Not a Loadout backup (manifest missing magic).");
                    }
                }

                foreach (var entry in zip.Entries)
                {
                    if (string.IsNullOrEmpty(entry.Name)) continue;     // directory entry
                    if (entry.FullName.Equals("MANIFEST.txt", StringComparison.OrdinalIgnoreCase)) continue;

                    // Block path traversal. Entry full names should never contain ..
                    if (entry.FullName.Contains("..")) continue;

                    var dest = Path.Combine(folder, entry.FullName.Replace('/', Path.DirectorySeparatorChar));
                    var destDir = Path.GetDirectoryName(dest);
                    if (!string.IsNullOrEmpty(destDir)) Directory.CreateDirectory(destDir);
                    entry.ExtractToFile(dest, overwrite: true);
                    count++;
                }
            }
            // Re-read settings from disk so the in-memory copy reflects
            // the freshly-restored settings.json.
            try { SettingsManager.Instance.Initialize(folder); } catch { }
            return count;
        }
    }
}
