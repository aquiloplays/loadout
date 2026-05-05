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
        private bool _hasUpdate;
        private ReleaseInfo _pendingRelease;

        public void Show()
        {
            _icon = new NotifyIcon
            {
                Icon = LoadIcon(),
                Text = "Loadout",
                Visible = true
            };

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
            _pendingRelease = release;
            try
            {
                _icon.ShowBalloonTip(
                    8000,
                    "Loadout update available",
                    $"Version {release.TagName} is ready to install. Click the tray icon for details.",
                    ToolTipIcon.Info);
            }
            catch { /* balloon tips occasionally fail on some Windows builds; non-fatal */ }
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

            _menu.Items.Add(new ToolStripSeparator());

            var update = new ToolStripMenuItem(_hasUpdate
                ? "Apply update to " + (_pendingRelease?.TagName ?? "new version")
                : "Check for updates");
            update.Click += async (_, __) =>
            {
                if (_hasUpdate && _pendingRelease != null)
                {
                    update.Enabled = false;
                    update.Text = "Downloading...";
                    var ok = await UpdateChecker.Instance.DownloadUpdateAsync(_pendingRelease).ConfigureAwait(true);
                    update.Enabled = true;
                    if (ok)
                    {
                        try
                        {
                            _icon.ShowBalloonTip(10000,
                                "Loadout update downloaded",
                                "Restart Streamer.bot to apply " + _pendingRelease.TagName + ".",
                                ToolTipIcon.Info);
                        }
                        catch { }
                        update.Text = "Restart SB to apply " + _pendingRelease.TagName;
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
