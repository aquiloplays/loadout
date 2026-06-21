using System;
using System.IO;
using System.Threading;
using Newtonsoft.Json;

namespace Loadout.Settings
{
    /// <summary>
    /// Loads and saves <see cref="LoadoutSettings"/> from disk with debounced writes
    /// and atomic file replacement. Thread-safe.
    /// </summary>
    public sealed class SettingsManager
    {
        private static readonly Lazy<SettingsManager> _instance =
            new Lazy<SettingsManager>(() => new SettingsManager(), LazyThreadSafetyMode.ExecutionAndPublication);

        public static SettingsManager Instance => _instance.Value;

        private readonly object _gate = new object();
        private LoadoutSettings _current;
        private string _path;
        private Timer _saveTimer;
        private const int SaveDebounceMs = 500;

        public event EventHandler SettingsChanged;

        // ObjectCreationHandling.Replace prevents Newtonsoft from appending
        // JSON array items to the property's collection-initializer default
        // (e.g. TimersConfig.Messages = new List<TimedMessage>{ ... }).
        // Without this, every load grew the list by the default size — that's
        // how settings.json ended up with 30+ duplicate "Follow reminder"
        // timers, duplicate counters, duplicate goals, etc.
        private static readonly JsonSerializerSettings _jsonSettings =
            new JsonSerializerSettings
            {
                ObjectCreationHandling = ObjectCreationHandling.Replace
            };

        private SettingsManager() { }

        /// <summary>
        /// Loadout.dll's assembly version, formatted as "MAJOR.MINOR.PATCH".
        /// Single source of truth = the csproj &lt;Version&gt; element, which
        /// AssemblyInfo.cs synthesizes into the assembly at build time.
        /// Used to stamp <see cref="LoadoutSettings.SuiteVersion"/> on
        /// every settings load so the tray + boot banner track the DLL.
        /// </summary>
        public static string AssemblyVersionString()
        {
            try
            {
                var v = System.Reflection.Assembly.GetExecutingAssembly().GetName().Version;
                if (v == null) return "0.0.0";
                // Build/Revision are usually 0 for our releases; trim them
                // off so the display reads "1.10.0" not "1.10.0.0".
                if (v.Build < 0 && v.Revision < 0) return v.Major + "." + v.Minor;
                if (v.Revision <= 0) return v.Major + "." + v.Minor + "." + Math.Max(0, v.Build);
                return v.ToString();
            }
            catch { return "0.0.0"; }
        }

        /// <summary>
        /// Initialize with a custom data folder. Defaults to %APPDATA%\Loadout if null.
        /// </summary>
        public void Initialize(string dataFolder = null)
        {
            lock (_gate)
            {
                if (string.IsNullOrWhiteSpace(dataFolder))
                {
                    dataFolder = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                        "Loadout");
                }

                Directory.CreateDirectory(dataFolder);
                _path = Path.Combine(dataFolder, "settings.json");
                _current = LoadFromDisk();
            }
        }

        public LoadoutSettings Current
        {
            get
            {
                lock (_gate)
                {
                    if (_current == null) Initialize();
                    return _current;
                }
            }
        }

        public string SettingsPath
        {
            get { lock (_gate) return _path; }
        }

        public string DataFolder
        {
            get { lock (_gate) return _path == null ? null : Path.GetDirectoryName(_path); }
        }

        /// <summary>
        /// Mutate settings under lock; debounced save fires automatically.
        /// </summary>
        public void Mutate(Action<LoadoutSettings> mutator)
        {
            if (mutator == null) throw new ArgumentNullException(nameof(mutator));
            lock (_gate)
            {
                if (_current == null) Initialize();
                mutator(_current);
                ScheduleSave();
            }
            SettingsChanged?.Invoke(this, EventArgs.Empty);
        }

        public void SaveNow()
        {
            lock (_gate)
            {
                _saveTimer?.Dispose();
                _saveTimer = null;
                WriteToDisk();
            }
        }

        private void ScheduleSave()
        {
            _saveTimer?.Dispose();
            _saveTimer = new Timer(_ =>
            {
                lock (_gate) WriteToDisk();
            }, null, SaveDebounceMs, Timeout.Infinite);
        }

        /// <summary>One-shot migrations applied to settings loaded from
        /// disk. Each migration is gated on the SchemaVersion field so a
        /// rebalance doesn't re-apply every launch. Migrations only
        /// touch fields that still match the OLD default — anything the
        /// streamer customized is left alone.</summary>
        private static void MigrateSchema(LoadoutSettings s)
        {
            if (s == null) return;
            // v2: May 2026 economy rebalance — halve bolt earn rates
            // for fields still at their previous defaults. Existing
            // installs were at SchemaVersion=1 (the previous baseline);
            // this is the first real migration. Channel-point coins
            // took the largest cut since they're the most farmable.
            if (s.SchemaVersion < 2)
            {
                if (s.Bolts != null)
                {
                    if (s.Bolts.PerSub                   == 50)  s.Bolts.PerSub                   = 25;
                    if (s.Bolts.PerGiftSub               == 30)  s.Bolts.PerGiftSub               = 15;
                    if (s.Bolts.PerRaidBrought           == 100) s.Bolts.PerRaidBrought           = 50;
                    if (s.Bolts.PerCheerBitDivisor       == 100) s.Bolts.PerCheerBitDivisor       = 200;
                    if (s.Bolts.PerCcCoinDivisor         == 10)  s.Bolts.PerCcCoinDivisor         = 25;
                    if (s.Bolts.PerDailyCheckIn          == 100) s.Bolts.PerDailyCheckIn          = 50;
                    if (s.Bolts.SubAnniversaryBonusBase  == 100) s.Bolts.SubAnniversaryBonusBase  = 50;
                    if (s.Bolts.MaxChatEarnsPerMinute    == 6)   s.Bolts.MaxChatEarnsPerMinute    = 3;
                }
                s.SchemaVersion = 2;
            }
            // v3: June 2026 — seed the new starter-pack custom commands
            // (waddup / hello / hug / hype / raid / specs / sens / etc.)
            // into existing installs that had an empty Custom list, AND
            // append any specific command names that are still missing so
            // an existing install picks up new defaults without losing
            // customizations. Never overwrites a command the streamer
            // already has under the same name.
            if (s.SchemaVersion < 3)
            {
                if (s.InfoCommands != null)
                {
                    if (s.InfoCommands.Custom == null)
                        s.InfoCommands.Custom = new System.Collections.Generic.List<CustomCommand>();
                    var seedDefaults = new LoadoutSettings().InfoCommands.Custom;
                    var existingNames = new System.Collections.Generic.HashSet<string>(
                        StringComparer.OrdinalIgnoreCase);
                    foreach (var c in s.InfoCommands.Custom)
                        if (!string.IsNullOrWhiteSpace(c?.Name)) existingNames.Add(c.Name.Trim());
                    foreach (var def in seedDefaults)
                    {
                        if (def == null || string.IsNullOrWhiteSpace(def.Name)) continue;
                        if (existingNames.Contains(def.Name)) continue;
                        s.InfoCommands.Custom.Add(def);
                    }
                }
                s.SchemaVersion = 3;
            }
            // Add future migrations here, each gated on the next version.
        }

        private LoadoutSettings LoadFromDisk()
        {
            try
            {
                if (!File.Exists(_path))
                {
                    var fresh = new LoadoutSettings();
                    File.WriteAllText(_path, JsonConvert.SerializeObject(fresh, Formatting.Indented));
                    return fresh;
                }

                var json = File.ReadAllText(_path);
                var loaded = JsonConvert.DeserializeObject<LoadoutSettings>(json, _jsonSettings);
                loaded = loaded ?? new LoadoutSettings();
                MigrateSchema(loaded);
                // SuiteVersion is a display value sourced from the DLL,
                // not a user-editable setting. The original default of
                // "0.1.0" got persisted on first install and never
                // refreshed when the DLL upgraded — so the tray label,
                // boot banner, and Settings header all showed a stale
                // version forever. Re-stamp on every load so the field
                // tracks the assembly, then WriteToDisk persists it.
                loaded.SuiteVersion = AssemblyVersionString();
                return loaded;
            }
            catch (Exception ex)
            {
                // Corrupt or unreadable settings — back up and start fresh.
                try
                {
                    if (File.Exists(_path))
                    {
                        var bak = _path + ".corrupt-" + DateTime.UtcNow.ToString("yyyyMMddHHmmss") + ".bak";
                        File.Copy(_path, bak, overwrite: true);
                    }
                }
                catch { /* ignore */ }
                System.Diagnostics.Debug.WriteLine("[Loadout] Settings load failed: " + ex.Message);
                return new LoadoutSettings();
            }
        }

        private void WriteToDisk()
        {
            if (_current == null || string.IsNullOrEmpty(_path)) return;
            try
            {
                var tmp = _path + ".tmp";
                var json = JsonConvert.SerializeObject(_current, Formatting.Indented);
                File.WriteAllText(tmp, json);

                // Atomic replace — File.Replace fails if target doesn't exist on net48.
                if (File.Exists(_path))
                    File.Replace(tmp, _path, null);
                else
                    File.Move(tmp, _path);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine("[Loadout] Settings save failed: " + ex.Message);
            }
        }
    }
}
