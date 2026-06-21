using System;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Windows.Forms;
using Loadout.Settings;
using Loadout.UI;
using Loadout.Updates;

namespace Loadout.Host
{
    /// <summary>
    /// System tray icon for Loadout. Lives on the WPF UI thread alongside the
    /// dispatcher. Shows update badges, opens settings/onboarding, and provides
    /// quick toggles for the most-used switches without opening the full UI.
    /// </summary>
    internal sealed class TrayIcon : IDisposable
    {
        private NotifyIcon _icon;
        private ContextMenuStrip _menu;
        private System.Windows.Forms.Timer _hoverRefresh;
        private bool _hasUpdate;
        private bool _updateStaged;   // true once Loadout.dll.new is on disk
        private ReleaseInfo _pendingRelease;

        public void Show()
        {
            _icon = new NotifyIcon
            {
                Icon = LoadIcon(),
                Text = "Loadout",
                Visible = true
            };
            // Refresh the hover-tooltip with the latest 3 events every
            // 5s. NotifyIcon.Text is capped at 127 chars on Windows; we
            // pack a "v1.10.0 · L:cmd · W:sub · A:cheer" style line so
            // a streamer can hover the tray icon and see what just
            // fired without opening the dock. Using a Forms.Timer keeps
            // updates on the UI message-pump thread.
            _hoverRefresh = new System.Windows.Forms.Timer { Interval = 5000 };
            _hoverRefresh.Tick += (_, __) => RefreshHoverText();
            _hoverRefresh.Start();
            RefreshHoverText();

            _menu = new ContextMenuStrip();
            RebuildMenu();
            _icon.ContextMenuStrip = _menu;
            _icon.DoubleClick += (_, __) => LoadoutHost.OpenSettings();

            SettingsManager.Instance.SettingsChanged += (_, __) => RebuildMenu();

            // One-shot "Loadout is ready" toast so users notice it auto-loaded
            // on SB startup. The boot trigger fires every SB launch, but with
            // no UI on screen most streamers don't realize Loadout is up - they
            // assume they need to manually fire the action. The toast
            // disambiguates: see the balloon -> bot is running, just open
            // Settings from the tray. Suppressed in BalloonShown for re-runs.
            try
            {
                var s = SettingsManager.Instance.Current;
                var ready = s.OnboardingDone ? "ready" : "ready - first run, onboarding open";
                _icon.ShowBalloonTip(
                    5000,
                    "Loadout " + (s.SuiteVersion ?? "") + " " + ready,
                    "Double-click the tray icon to open Settings. Right-click for quick toggles.",
                    ToolTipIcon.Info);
            }
            catch { /* balloon tips occasionally fail on Win Server / minimal Win10; non-fatal */ }
        }

        public void NotifyUpdateAvailable(ReleaseInfo release)
        {
            _hasUpdate = true;
            _updateStaged = false;
            _pendingRelease = release;
            var autoDownload = SettingsManager.Instance.Current.Updates.AutoDownload;
            try
            {
                _icon.ShowBalloonTip(
                    8000,
                    "Loadout update available",
                    autoDownload
                        ? $"Version {release.TagName} is downloading in the background — restart Streamer.bot when it's ready."
                        : $"Version {release.TagName} is ready to install. Click the tray icon for details.",
                    ToolTipIcon.Info);
            }
            catch { /* balloon tips occasionally fail on some Windows builds; non-fatal */ }
            RebuildMenu();
        }

        /// <summary>
        /// Fired by <see cref="UpdateChecker"/> after AutoDownload has finished
        /// staging Loadout.dll.new on disk. Flips the menu from
        /// "Downloading…" to "Restart Streamer.bot to apply vX.Y.Z" so the
        /// streamer's next action is just an SB restart — no extra
        /// download-click step.
        /// </summary>
        public void NotifyUpdateDownloaded(ReleaseInfo release)
        {
            _hasUpdate = true;
            _updateStaged = true;
            _pendingRelease = release;
            try
            {
                _icon.ShowBalloonTip(
                    10000,
                    "Loadout update downloaded",
                    $"Restart Streamer.bot to apply {release.TagName}.",
                    ToolTipIcon.Info);
            }
            catch { /* non-fatal */ }
            RebuildMenu();
        }

        private void RebuildMenu()
        {
            if (_menu == null) return;
            _menu.Items.Clear();
            var s = SettingsManager.Instance.Current;
            // Health row — at-a-glance status. Disabled items are non-interactive labels.
            var busOk = Bus.AquiloBus.Instance.IsRunning;
            var patreonTier = Patreon.Entitlements.CurrentTierDisplay();
            var enabledModules = CountEnabledModules(s.Modules);

            var statusHeader = new ToolStripMenuItem("Loadout — " + (s.OnboardingDone ? "ready" : "not configured")) { Enabled = false };
            _menu.Items.Add(statusHeader);
            _menu.Items.Add(new ToolStripMenuItem("  • Bus: "      + (busOk ? "running on 7470" : "stopped")) { Enabled = false });
            _menu.Items.Add(new ToolStripMenuItem("  • Patreon: "  + patreonTier) { Enabled = false });
            _menu.Items.Add(new ToolStripMenuItem("  • Modules: "  + enabledModules + " enabled") { Enabled = false });
            _menu.Items.Add(new ToolStripMenuItem("  • Quiet mode: " + (s.ChatNoise.QuietMode ? "ON" : "off")) { Enabled = false });
            _menu.Items.Add(new ToolStripSeparator());

            var openSettings = new ToolStripMenuItem("Open Settings");
            openSettings.Click += (_, __) => LoadoutHost.OpenSettings();
            _menu.Items.Add(openSettings);

            var openOnboarding = new ToolStripMenuItem("Onboarding wizard");
            openOnboarding.Click += (_, __) => LoadoutHost.OpenOnboarding();
            _menu.Items.Add(openOnboarding);

            _menu.Items.Add(new ToolStripSeparator());

            var quickToggle = new ToolStripMenuItem("Quick toggles");
            quickToggle.DropDownItems.Add(MakeToggle("Timed messages",   s.Modules.TimedMessages,  v => SettingsManager.Instance.Mutate(x => x.Modules.TimedMessages = v)));
            quickToggle.DropDownItems.Add(MakeToggle("Welcomes",         s.Modules.ContextWelcomes,v => SettingsManager.Instance.Mutate(x => x.Modules.ContextWelcomes = v)));
            quickToggle.DropDownItems.Add(MakeToggle("Alerts",           s.Modules.Alerts,         v => SettingsManager.Instance.Mutate(x => x.Modules.Alerts = v)));
            quickToggle.DropDownItems.Add(MakeToggle("Hate raid detect", s.Modules.HateRaidDetector, v => SettingsManager.Instance.Mutate(x => x.Modules.HateRaidDetector = v)));
            _menu.Items.Add(quickToggle);

            // Panic-pause for Game Interactions — only show when the
            // module is actually enabled, since it's the only thing the
            // pause guards against. Each duration sets a hard cutoff
            // that the module checks before every fire; the
            // "Resume now" item clears the pause immediately.
            if (s.Modules.GameInteractions && s.GameInteractions?.Enabled == true)
            {
                bool paused = Modules.GameInteractionsModule.IsPaused;
                var pauseHeader = paused
                    ? "Paused until " + Modules.GameInteractionsModule.PausedUntilUtc.ToLocalTime().ToString("HH:mm")
                    : "Pause Game Interactions";
                var pause = new ToolStripMenuItem(pauseHeader);
                pause.DropDownItems.Add(MakePauseItem("1 minute",   TimeSpan.FromMinutes(1)));
                pause.DropDownItems.Add(MakePauseItem("5 minutes",  TimeSpan.FromMinutes(5)));
                pause.DropDownItems.Add(MakePauseItem("15 minutes", TimeSpan.FromMinutes(15)));
                pause.DropDownItems.Add(MakePauseItem("30 minutes", TimeSpan.FromMinutes(30)));
                if (paused)
                {
                    var resume = new ToolStripMenuItem("Resume now");
                    resume.Click += (_, __) => { Modules.GameInteractionsModule.PauseFor(TimeSpan.Zero); RebuildMenu(); };
                    pause.DropDownItems.Add(new ToolStripSeparator());
                    pause.DropDownItems.Add(resume);
                }
                _menu.Items.Add(pause);

                // Replay last-N — pulls from GameInteractionsModule's
                // rolling buffer. Only enabled when there's something
                // to replay (cap 50; lifetime of the DLL).
                int bufCount = Modules.GameInteractionsModule.ReplayBufferCount;
                var replay = new ToolStripMenuItem("Replay game actions"
                    + (bufCount > 0 ? " (" + bufCount + ")" : ""));
                replay.Enabled = bufCount > 0;
                replay.DropDownItems.Add(MakeReplayItem("Last 1",  1));
                replay.DropDownItems.Add(MakeReplayItem("Last 5",  5));
                replay.DropDownItems.Add(MakeReplayItem("Last 10", 10));
                replay.DropDownItems.Add(MakeReplayItem("All",     int.MaxValue));
                _menu.Items.Add(replay);
            }

            // Single-click "Loadout" launcher: create a desktop shortcut
            // that fires Streamer.bot, which boots Loadout via SB's
            // startup action. Pinning the .lnk to the taskbar gives the
            // streamer a real "Loadout" icon next to OBS / Discord on
            // their dock. Built directly here instead of shelling out
            // so the user doesn't need PowerShell exec policy enabled.
            var installShortcut = new ToolStripMenuItem("Install dock / taskbar shortcut...");
            installShortcut.Click += (_, __) => InstallDockShortcutInteractive();
            _menu.Items.Add(installShortcut);

            // OBS browser dock — opens aquilo.gg/dock/loadout/ in the
            // default browser with the local bus secret prefilled via
            // URL hash. The dock pages the user can copy into OBS as a
            // Custom Browser Dock for live wallet/counter/activity view.
            var openDock = new ToolStripMenuItem("Open Loadout OBS dock");
            openDock.Click += (_, __) => OpenLoadoutDockInteractive();
            _menu.Items.Add(openDock);

            // Diagnostic / support tools — surfaced in the tray so a
            // confused streamer doesn't have to dig through Settings
            // for "is this thing working?" verification.
            var diag = new ToolStripMenuItem("Diagnostics");
            var testChat = new ToolStripMenuItem("Send test chat message");
            testChat.Click += (_, __) => SendTestChatInteractive();
            diag.DropDownItems.Add(testChat);
            var openData = new ToolStripMenuItem("Open Loadout data folder");
            openData.Click += (_, __) =>
            {
                try { System.Diagnostics.Process.Start("explorer.exe", SettingsManager.Instance.DataFolder); }
                catch (Exception ex) { Util.ErrorLog.Write("OpenDataFolder", ex); }
            };
            diag.DropDownItems.Add(openData);
            var exportDiag = new ToolStripMenuItem("Export diagnostic bundle...");
            exportDiag.Click += (_, __) => ExportDiagnosticBundleInteractive();
            diag.DropDownItems.Add(exportDiag);
            _menu.Items.Add(diag);

            _menu.Items.Add(new ToolStripSeparator());

            // Three states for the update item:
            //   - no update detected → "Check for updates" (clickable)
            //   - update detected, staged file on disk → "Restart Streamer.bot
            //     to apply vX.Y.Z" (informational; SB swaps the DLL itself on
            //     next start via 00-boot.cs)
            //   - update detected, no staged file yet → "Apply update to
            //     vX.Y.Z" (clickable; downloads then flips to staged)
            //
            // When AutoDownload is on (default), the middle state is what
            // every streamer hits — the background download is already done
            // by the time they look at the tray. The third state only shows
            // when AutoDownload was turned off OR the auto-download failed.
            string updateLabel;
            if (!_hasUpdate)                        updateLabel = "Check for updates";
            else if (_updateStaged)                 updateLabel = "Restart Streamer.bot to apply " + (_pendingRelease?.TagName ?? "new version");
            else                                    updateLabel = "Apply update to " + (_pendingRelease?.TagName ?? "new version");
            var update = new ToolStripMenuItem(updateLabel);
            update.Click += async (_, __) =>
            {
                if (_hasUpdate && _updateStaged)
                {
                    // Nothing to do — SB restart is the only step left. Open
                    // the release page so the streamer can read the notes
                    // while they decide when to restart.
                    try { System.Diagnostics.Process.Start(_pendingRelease?.HtmlUrl ?? "https://github.com/aquiloplays/loadout-downloads/releases"); } catch { }
                }
                else if (_hasUpdate && _pendingRelease != null)
                {
                    update.Enabled = false;
                    update.Text = "Downloading...";
                    var ok = await UpdateChecker.Instance.DownloadUpdateAsync(_pendingRelease).ConfigureAwait(true);
                    update.Enabled = true;
                    if (ok)
                    {
                        _updateStaged = true;
                        try
                        {
                            _icon.ShowBalloonTip(10000,
                                "Loadout update downloaded",
                                "Restart Streamer.bot to apply " + _pendingRelease.TagName + ".",
                                ToolTipIcon.Info);
                        }
                        catch { }
                        update.Text = "Restart Streamer.bot to apply " + _pendingRelease.TagName;
                    }
                    else
                    {
                        try { System.Diagnostics.Process.Start(_pendingRelease.HtmlUrl ?? "https://github.com"); } catch { }
                        update.Text = "Apply update to " + _pendingRelease.TagName;
                    }
                }
                else
                {
                    try { await UpdateChecker.Instance.CheckNowAsync(); } catch { }
                }
            };
            _menu.Items.Add(update);

            var version = new ToolStripMenuItem("Version " + (s.SuiteVersion ?? "?")) { Enabled = false };
            _menu.Items.Add(version);

            _menu.Items.Add(new ToolStripSeparator());

            var hide = new ToolStripMenuItem("Hide tray icon");
            hide.Click += (_, __) => { if (_icon != null) _icon.Visible = false; };
            _menu.Items.Add(hide);
        }

        private static ToolStripMenuItem MakeToggle(string label, bool value, Action<bool> onClick)
        {
            var item = new ToolStripMenuItem(label) { Checked = value, CheckOnClick = true };
            item.CheckedChanged += (_, __) => onClick(item.Checked);
            return item;
        }

        private void RefreshHoverText()
        {
            if (_icon == null) return;
            try
            {
                var s = SettingsManager.Instance.Current;
                var sb = new System.Text.StringBuilder();
                sb.Append("Loadout v").Append(s.SuiteVersion ?? "?");
                if (s.ChatNoise?.QuietMode == true) sb.Append(" · quiet");
                if (s.DryRun)                       sb.Append(" · dry-run");
                var recent = Util.EventStats.Instance.RecentSnapshot(3);
                foreach (var r in recent)
                {
                    var age = (DateTime.UtcNow - r.Ts).TotalSeconds;
                    var ageLabel = age < 60 ? ((int)age).ToString() + "s" :
                                   age < 3600 ? ((int)(age / 60)).ToString() + "m" :
                                   ((int)(age / 3600)).ToString() + "h";
                    sb.Append(" · ").Append(r.Kind).Append('(').Append(ageLabel).Append(')');
                }
                // NotifyIcon.Text cap is 127 chars on Win10+; truncate.
                var text = sb.ToString();
                if (text.Length > 127) text = text.Substring(0, 124) + "...";
                _icon.Text = text;
            }
            catch { /* never let the hover refresh break the tray */ }
        }

        private ToolStripMenuItem MakePauseItem(string label, TimeSpan duration)
        {
            var item = new ToolStripMenuItem(label);
            item.Click += (_, __) =>
            {
                Modules.GameInteractionsModule.PauseFor(duration);
                RebuildMenu();
            };
            return item;
        }

        private ToolStripMenuItem MakeReplayItem(string label, int count)
        {
            var item = new ToolStripMenuItem(label);
            item.Click += (_, __) => Modules.GameInteractionsModule.ReplayLast(count);
            return item;
        }

        /// <summary>
        /// Open the OBS browser dock with the local Aquilo Bus secret
        /// prefilled in the URL hash. The dock reads it once, stows in
        /// localStorage, then strips the hash so the URL is shareable.
        /// </summary>
        private static void OpenLoadoutDockInteractive()
        {
            try
            {
                string secret = "";
                try
                {
                    // Bus secret lives at %APPDATA%\Aquilo\bus-secret.txt
                    // (NOT under Loadout\) — AquiloBus writes it there
                    // so other aquilo.gg products can find a known
                    // shared path on the same machine.
                    var path = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                        "Aquilo", "bus-secret.txt");
                    if (File.Exists(path)) secret = File.ReadAllText(path).Trim();
                }
                catch { /* leave secret empty - dock will prompt */ }

                var url = "https://aquilo.gg/dock/loadout/";
                if (!string.IsNullOrEmpty(secret))
                    url += "#secret=" + Uri.EscapeDataString(secret);
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
                {
                    FileName = url,
                    UseShellExecute = true   // default browser handler
                });
            }
            catch (Exception ex)
            {
                Util.ErrorLog.Write("OpenLoadoutDock", ex);
                MessageBox.Show("Couldn't open the dock:\n\n" + ex.Message,
                    "Loadout", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        /// <summary>
        /// Fire a single test message through the same MultiPlatformSender
        /// the rest of Loadout uses, so the streamer can verify their
        /// Twitch / YouTube / TikTok / Kick wiring without waiting for a
        /// real event. Shows a result MessageBox with the platform mask
        /// that actually accepted the message.
        /// </summary>
        private static void SendTestChatInteractive()
        {
            try
            {
                var s = SettingsManager.Instance.Current;
                var msg = "Loadout test message - if you see this in chat, outgoing send is working.";
                var sender = new Platforms.MultiPlatformSender(Platforms.CphPlatformSender.Instance);
                var sent = sender.Send(Settings.PlatformMask.All, msg, s.Platforms);
                if (sent == Settings.PlatformMask.None)
                {
                    MessageBox.Show(
                        "Loadout tried to send a test message but nothing went through.\n\n" +
                        "Check: 1) Streamer.bot is connected to your chat platforms.\n" +
                        "       2) The Platforms tab in Settings has the right boxes ticked.\n" +
                        "       3) The 'Loadout: Boot' action in SB has actually been run.",
                        "Loadout — test send",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Warning);
                }
                else
                {
                    MessageBox.Show(
                        "Test message sent to: " + sent + "\n\nCheck the chat tab for each connected platform.",
                        "Loadout — test send",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Information);
                }
            }
            catch (Exception ex)
            {
                Util.ErrorLog.Write("SendTestChat", ex);
                MessageBox.Show("Test send failed:\n\n" + ex.Message,
                    "Loadout", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        /// <summary>
        /// Wraps BackupManager.Export to drop a ZIP of the entire data
        /// folder on the Desktop with a timestamped filename, then opens
        /// Explorer pointing at it. Equivalent to the Backup tab's
        /// export but reachable in one tray click for support tickets.
        /// </summary>
        private static void ExportDiagnosticBundleInteractive()
        {
            try
            {
                var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
                var desktop = Environment.GetFolderPath(Environment.SpecialFolder.Desktop);
                var outZip = Path.Combine(desktop, "loadout-diagnostic-" + stamp + ".zip");
                var n = Util.BackupManager.Export(outZip);
                try { System.Diagnostics.Process.Start("explorer.exe", "/select,\"" + outZip + "\""); } catch { }
                MessageBox.Show(
                    "Diagnostic bundle written:\n\n" + outZip + "\n\n" +
                    n + " files. Patreon tokens and pending updates are excluded.\n" +
                    "Share this ZIP when reporting an issue.",
                    "Loadout — diagnostic bundle",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
            }
            catch (Exception ex)
            {
                Util.ErrorLog.Write("ExportDiagnostic", ex);
                MessageBox.Show("Could not write the diagnostic bundle:\n\n" + ex.Message,
                    "Loadout", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        /// <summary>
        /// Build a Windows shortcut on the Desktop (and Start menu) that
        /// launches BOTH Streamer.bot AND the Loadout Settings window
        /// in one click. The .lnk targets a small hidden-powershell
        /// launcher (loadout-launch.ps1, written next to settings.json)
        /// that:
        ///   1. Starts Streamer.bot.exe if it's not already running.
        ///   2. Drops a sentinel file (open-settings.trigger) the DLL's
        ///      FileSystemWatcher picks up to open the Settings window.
        /// Pinning the .lnk to the taskbar gives a real "Loadout" dock
        /// icon. Win 11 removed the programmatic Pin-to-Taskbar verb;
        /// we open Explorer with the new .lnk selected so the user is
        /// one right-click away from "Pin to taskbar".
        /// </summary>
        private static void InstallDockShortcutInteractive()
        {
            try
            {
                // Locate Streamer.bot.exe via the host process — the DLL
                // is loaded INTO Streamer.bot, so the EntryAssembly's
                // process is exactly the target we want to launch.
                string sbExe;
                try { sbExe = System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName; }
                catch { sbExe = null; }
                if (string.IsNullOrEmpty(sbExe) || !File.Exists(sbExe) ||
                    !sbExe.EndsWith("Streamer.bot.exe", StringComparison.OrdinalIgnoreCase))
                {
                    foreach (var cand in new[]
                    {
                        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Desktop", "Streamerbot", "Streamer.bot.exe"),
                        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Desktop", "Streamer.bot", "Streamer.bot.exe"),
                        @"C:\Streamer.bot\Streamer.bot.exe",
                        @"D:\Streamer.bot\Streamer.bot.exe"
                    })
                    {
                        if (File.Exists(cand)) { sbExe = cand; break; }
                    }
                }
                if (string.IsNullOrEmpty(sbExe) || !File.Exists(sbExe))
                {
                    MessageBox.Show(
                        "Couldn't find Streamer.bot.exe automatically.\n\nOpen the Loadout install folder and create a shortcut to Streamer.bot.exe by hand, then drag it to your taskbar.",
                        "Loadout — install shortcut",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Warning);
                    return;
                }

                var dataFolder = SettingsManager.Instance.DataFolder;
                Directory.CreateDirectory(dataFolder);

                // 1. Stash the Loadout icon next to settings.json so the
                //    .lnk + the taskbar can reference it without depending
                //    on the assembly resource at runtime. ALWAYS overwrite
                //    so a brand refresh (icon updated in the DLL) actually
                //    lands on existing installs — previously this was a
                //    one-shot copy that pinned the first-ever icon forever.
                var iconPath = Path.Combine(dataFolder, "Loadout.ico");
                try
                {
                    var asm = Assembly.GetExecutingAssembly();
                    using var src = asm.GetManifestResourceStream("Loadout.assets.Loadout.ico");
                    if (src != null)
                    {
                        using var dst = File.Create(iconPath);
                        src.CopyTo(dst);
                    }
                }
                catch { /* falling back to SB's own icon below is fine */ }
                if (!File.Exists(iconPath)) iconPath = sbExe;

                // 2. Write the launcher .ps1 that the .lnk invokes. The
                //    .lnk runs `powershell.exe -WindowStyle Hidden -File
                //    <launcher.ps1>` so no console window flashes.
                var launcherPath = Path.Combine(dataFolder, "loadout-launch.ps1");
                File.WriteAllText(launcherPath, BuildLauncherScript(sbExe, dataFolder));

                // 3. Drop the .lnk files. Target = powershell.exe,
                //    Arguments include -File <launcher.ps1>. Icon points
                //    at the Loadout.ico so the dock slot reads as
                //    "Loadout" rather than a generic powershell glyph.
                var psExe = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.System),
                    "WindowsPowerShell", "v1.0", "powershell.exe");
                if (!File.Exists(psExe)) psExe = "powershell.exe";

                var psArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + launcherPath + "\"";

                var desktop = Environment.GetFolderPath(Environment.SpecialFolder.Desktop);
                var startMenu = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                    "Microsoft", "Windows", "Start Menu", "Programs");

                var desktopLnk = Path.Combine(desktop, "Loadout.lnk");
                var startLnk   = Path.Combine(startMenu, "Loadout.lnk");

                WriteShortcut(desktopLnk, psExe, iconPath, psArgs, Path.GetDirectoryName(sbExe));
                WriteShortcut(startLnk,   psExe, iconPath, psArgs, Path.GetDirectoryName(sbExe));

                try { System.Diagnostics.Process.Start("explorer.exe", "/select,\"" + desktopLnk + "\""); }
                catch { /* non-fatal */ }

                MessageBox.Show(
                    "Loadout shortcut created on your Desktop and in the Start menu.\n\n" +
                    "Clicking it will:\n" +
                    "  1. Start Streamer.bot if it's not running.\n" +
                    "  2. Open the Loadout Settings window.\n\n" +
                    "To pin it to the taskbar:\n" +
                    "  1. Right-click 'Loadout' on the Desktop (just opened).\n" +
                    "  2. Choose 'Pin to taskbar'.\n" +
                    "     (Windows 11: 'Show more options' first, then Pin to taskbar.)",
                    "Loadout — dock shortcut ready",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
            }
            catch (Exception ex)
            {
                Util.ErrorLog.Write("InstallDockShortcut", ex);
                MessageBox.Show("Couldn't create the shortcut:\n\n" + ex.Message,
                    "Loadout", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        /// <summary>
        /// Builds the launcher .ps1 that the dock .lnk invokes. Hidden
        /// window. Touches the trigger file the DLL's FileSystemWatcher
        /// is looking for, then starts SB if it isn't already running.
        /// Ordering matters: writing the trigger first means the
        /// already-running DLL pops Settings immediately, while a cold
        /// boot picks it up via the boot-time scan in StartTriggerWatcher.
        /// </summary>
        private static string BuildLauncherScript(string sbExe, string dataFolder)
        {
            var trigger = Path.Combine(dataFolder, LoadoutHost.TriggerFileName);
            var sb = new System.Text.StringBuilder();
            sb.AppendLine("# Loadout dock launcher — autogenerated; do not edit by hand.");
            sb.AppendLine("# Click the Loadout .lnk -> this fires hidden, opens Settings,");
            sb.AppendLine("# and starts Streamer.bot if it isn't already running.");
            sb.AppendLine("$ErrorActionPreference = 'SilentlyContinue'");
            sb.AppendLine("$trigger = '" + EscapePsString(trigger) + "'");
            sb.AppendLine("$sbExe   = '" + EscapePsString(sbExe)   + "'");
            sb.AppendLine();
            sb.AppendLine("# Drop the trigger file so the (running OR cold-booting) DLL");
            sb.AppendLine("# opens Settings. Content is just a timestamp for debugging.");
            sb.AppendLine("try { New-Item -ItemType File -Force -Path $trigger | Out-Null;");
            sb.AppendLine("      Set-Content -Path $trigger -Value (Get-Date -Format 'o') } catch {}");
            sb.AppendLine();
            sb.AppendLine("# Start Streamer.bot if it isn't already running. Get-Process is");
            sb.AppendLine("# faster than spinning up a WMI query for this one check.");
            sb.AppendLine("$running = Get-Process -Name 'Streamer.bot' -ErrorAction SilentlyContinue");
            sb.AppendLine("if (-not $running) {");
            sb.AppendLine("    if (Test-Path $sbExe) {");
            sb.AppendLine("        Start-Process -FilePath $sbExe -WorkingDirectory (Split-Path $sbExe -Parent)");
            sb.AppendLine("    }");
            sb.AppendLine("} else {");
            sb.AppendLine("    # SB is already up — bring its window to the foreground so");
            sb.AppendLine("    # both 'open SB' and 'open Settings' visually happen.");
            sb.AppendLine("    try {");
            sb.AppendLine("        $sig = '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);'");
            sb.AppendLine("        $u32 = Add-Type -MemberDefinition $sig -Name Win32 -PassThru");
            sb.AppendLine("        $h = ($running | Select-Object -First 1).MainWindowHandle");
            sb.AppendLine("        if ($h -ne [IntPtr]::Zero) { [void]$u32::SetForegroundWindow($h) }");
            sb.AppendLine("    } catch {}");
            sb.AppendLine("}");
            return sb.ToString();
        }

        private static string EscapePsString(string s)
        {
            // Single-quoted PowerShell string: only the single-quote
            // needs escaping (doubled).
            return (s ?? "").Replace("'", "''");
        }

        /// <summary>
        /// Drop a .lnk file at <paramref name="lnkPath"/> targeting
        /// <paramref name="targetExe"/>. Uses the WScript.Shell COM
        /// object via reflection — it's been on every Windows since
        /// XP and doesn't require an external dependency.
        /// </summary>
        private static void WriteShortcut(string lnkPath, string targetExe, string iconPath,
                                          string arguments = "", string workingDirectory = null)
        {
            var dir = Path.GetDirectoryName(lnkPath);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

            var shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType == null) throw new InvalidOperationException("WScript.Shell unavailable");
            object shell = Activator.CreateInstance(shellType);
            object lnk = null;
            try
            {
                lnk = shellType.InvokeMember("CreateShortcut",
                    System.Reflection.BindingFlags.InvokeMethod, null, shell,
                    new object[] { lnkPath });
                var lnkType = lnk.GetType();
                void Set(string name, object value) =>
                    lnkType.InvokeMember(name,
                        System.Reflection.BindingFlags.SetProperty, null, lnk,
                        new[] { value });

                Set("TargetPath",       targetExe);
                Set("Arguments",        arguments ?? "");
                Set("WorkingDirectory", workingDirectory ?? Path.GetDirectoryName(targetExe) ?? "");
                Set("IconLocation",     iconPath + ",0");
                Set("Description",      "Loadout — opens Streamer.bot and the Loadout Settings window.");
                Set("WindowStyle",      1);
                lnkType.InvokeMember("Save",
                    System.Reflection.BindingFlags.InvokeMethod, null, lnk, null);
            }
            finally
            {
                try { if (lnk   != null) System.Runtime.InteropServices.Marshal.FinalReleaseComObject(lnk);   } catch { }
                try { System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shell); } catch { }
            }
        }

        private static int CountEnabledModules(ModulesConfig m)
        {
            // Count via reflection so adding a new module flag doesn't require
            // touching this method.
            int n = 0;
            foreach (var p in typeof(ModulesConfig).GetProperties())
            {
                if (p.PropertyType != typeof(bool)) continue;
                if (p.GetValue(m) is bool b && b) n++;
            }
            return n;
        }

        private static Icon LoadIcon()
        {
            // Try embedded icon "Loadout.ico" first; fall back to system icon.
            try
            {
                var asm = Assembly.GetExecutingAssembly();
                using var stream = asm.GetManifestResourceStream("Loadout.assets.Loadout.ico");
                if (stream != null) return new Icon(stream);
            }
            catch { /* ignore */ }
            return SystemIcons.Application;
        }

        public void Dispose()
        {
            if (_hoverRefresh != null)
            {
                _hoverRefresh.Stop();
                _hoverRefresh.Dispose();
                _hoverRefresh = null;
            }
            if (_icon != null)
            {
                _icon.Visible = false;
                _icon.Dispose();
                _icon = null;
            }
            _menu?.Dispose();
            _menu = null;
        }
    }
}
