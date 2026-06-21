using System;
using System.Threading;
using System.Windows;
using System.Windows.Threading;
using Loadout.Settings;
using Loadout.Updates;
using Loadout.UI;

namespace Loadout.Host
{
    /// <summary>
    /// Owns the long-running WPF dispatcher thread. SB actions are short-lived,
    /// so we host our own STA thread + Application + Dispatcher loop that survives
    /// independent of any single action invocation.
    ///
    /// Application.Current is shared per AppDomain. SB itself doesn't run a
    /// System.Windows.Application (its UI is Avalonia/WinForms), so we create our
    /// own. If something else has already created one, we piggyback its dispatcher.
    ///
    /// Safe to call <see cref="EnsureStarted"/> repeatedly — only the first call
    /// spins up the thread.
    /// </summary>
    public static class LoadoutHost
    {
        private static readonly object _gate = new object();
        private static Thread _uiThread;
        private static Dispatcher _dispatcher;
        private static Application _app;
        private static TrayIcon _tray;
        private static bool _started;
        private static bool _ownsApp;
        private static Modules.PanelBridgeModule _panelBridge;
        private static System.IO.FileSystemWatcher _triggerWatcher;
        // Sentinel filename the dock-shortcut launcher drops in the data
        // folder. Kept short + lowercase + no spaces so the .ps1 / .vbs
        // wrapper can write it with the same literal we read here.
        public const string TriggerFileName = "open-settings.trigger";

        public static Dispatcher UiDispatcher
        {
            get { lock (_gate) return _dispatcher; }
        }

        public static void EnsureStarted(string dataFolder)
        {
            lock (_gate)
            {
                if (_started) return;

                SettingsManager.Instance.Initialize(dataFolder);
                Identity.IdentityLinker.Instance.Initialize(SettingsManager.Instance.DataFolder);
                Patreon.PatreonClient.Instance.Initialize(SettingsManager.Instance.DataFolder);
                ViewerProfile.ViewerProfileStore.Instance.Initialize(SettingsManager.Instance.DataFolder);
                Games.Dungeon.DungeonGameStore.Instance.Initialize(SettingsManager.Instance.DataFolder);
                Bus.AquiloBus.Instance.Start();

                // Bridge select bus messages into the event dispatcher so
                // modules can react to rotation widget responses (etc.) via
                // their normal OnEvent path. Add new prefixes here when
                // future products need to push events into Loadout's modules.
                Bus.AquiloBus.Instance.RegisterHandler("rotation.song.accepted", BridgeBusToDispatcher);
                Bus.AquiloBus.Instance.RegisterHandler("rotation.song.rejected", BridgeBusToDispatcher);
                // NowPlayingModule reads these to power the !song chat
                // command and the compact overlay's now-playing card.
                Bus.AquiloBus.Instance.RegisterHandler("rotation.song.playing", BridgeBusToDispatcher);
                Bus.AquiloBus.Instance.RegisterHandler("rotation.song.queued",  BridgeBusToDispatcher);

                // aquilo.gg overlay customizer page <-> local DLL.
                // Customizer reads loadout.overlay.snapshot.request to
                // populate controls, writes loadout.overlay.update to
                // mutate settings.json + republish a loadout.overlay.config
                // event for live overlay updates.
                Modules.OverlayCustomizeBridge.Register();

                // OBS dock write-path: counter bumps, quiet/module
                // toggles, chat sends, Game-Interactions pause, and
                // arbitrary SB action runs — all the dock's buttons
                // route through this one whitelisted dispatcher.
                Modules.DockCommandBridge.Register();

                var ready = new ManualResetEventSlim(false);
                _uiThread = new Thread(() =>
                {
                    if (Application.Current == null)
                    {
                        _app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
                        _ownsApp = true;
                    }
                    else
                    {
                        _app = Application.Current;
                        _ownsApp = false;
                    }

                    _dispatcher = Dispatcher.CurrentDispatcher;
                    // Flip every Loadout window's title bar dark via DWM
                    // so the OS chrome stops fighting our XAML dark mode.
                    // Has to be set up on the UI thread before any
                    // window is constructed.
                    Loadout.UI.WindowChrome.EnableForApp();
                    _tray = new TrayIcon();
                    _tray.Show();

                    ready.Set();

                    // _app.Run blocks until shutdown; Dispatcher.Run does the same on threads that
                    // don't own the Application. Either way this thread parks here for the lifetime
                    // of SB.
                    try
                    {
                        if (_ownsApp) _app.Run();
                        else Dispatcher.Run();
                    }
                    catch (Exception ex)
                    {
                        System.Diagnostics.Debug.WriteLine("[Loadout] UI thread exited: " + ex);
                    }
                })
                {
                    IsBackground = true,
                    Name = "Loadout-UI"
                };
                _uiThread.SetApartmentState(ApartmentState.STA);
                _uiThread.Start();
                if (!ready.Wait(TimeSpan.FromSeconds(5)))
                    System.Diagnostics.Debug.WriteLine("[Loadout] UI thread did not signal ready in 5s.");

                UpdateChecker.Instance.UpdateAvailable += OnUpdateAvailable;
                UpdateChecker.Instance.UpdateDownloaded += OnUpdateDownloaded;
                UpdateChecker.Instance.Start();

                // Auto-sync the Bolts wallet with the Discord Worker every
                // 30 seconds when the bot is enabled and bound to a guild.
                // This is what makes /balance and the Loadout UI agree —
                // before this timer existed, sync only ran when the user
                // clicked Push or Pull in Settings, so the two surfaces
                // drifted apart whenever a viewer used /coinflip etc.
                Discord.DiscordSync.Instance.StartAutoSync();

                // Tip bridge — polls the Worker for tip-provider webhooks
                // (Streamlabs / StreamElements / Ko-fi / generic) and
                // republishes them as `tips.received` on the local bus
                // while awarding bolts to the linked tipper. No-op if
                // the streamer hasn't enabled it in BoltsConfig.
                Discord.TipBridge.Instance.Start();

                // B3 panel-bridge — mirrors dungeon / mini-game bus state up
                // to the Twitch panel. Inert unless Clay's opt-in config file
                // (%APPDATA%\Aquilo\panel-bridge.json) is present.
                _panelBridge = Modules.PanelBridgeModule.StartIfConfigured();

                // Shortcut-trigger watcher. The dock .lnk drops a sentinel
                // file (open-settings.trigger) into the data folder; we
                // pop the Settings window on the UI thread and delete
                // the file. Works whether SB is already running (the
                // already-booted DLL sees the file) OR not (we check
                // for the file on initial boot too). One-click "open
                // SB + Loadout" UX without a separate launcher exe.
                StartTriggerWatcher();

                // Hook process exit so the tray icon (a WinForms NotifyIcon)
                // gets disposed before the CLR tears down the AppDomain. If we
                // don't, SB's exit can race with our background UI thread and
                // surface a "Fatal UI exception" on the way out: the WinForms
                // message pump tries to clean up while the dispatcher is mid-
                // shutdown, the NotifyIcon's hidden window has already gone,
                // and WPF's exception path catches the resulting access fault.
                // Keeping the handler narrow (Shutdown only, no work that can
                // throw) keeps process exit fast.
                try
                {
                    AppDomain.CurrentDomain.ProcessExit -= OnProcessExit;
                    AppDomain.CurrentDomain.ProcessExit += OnProcessExit;
                    AppDomain.CurrentDomain.DomainUnload -= OnProcessExit;
                    AppDomain.CurrentDomain.DomainUnload += OnProcessExit;
                }
                catch { /* non-fatal */ }

                _started = true;
            }
        }

        private static void OnProcessExit(object sender, EventArgs e)
        {
            try { Shutdown(); } catch { /* swallow - we're exiting anyway */ }
        }

        /// <summary>
        /// Watches the data folder for a sentinel file
        /// (<see cref="TriggerFileName"/>) and pops the Settings window
        /// when it appears. The dock shortcut's launcher script touches
        /// this file before / instead of starting SB, so a single click
        /// reliably opens Settings whether the DLL was already running
        /// or just cold-booted.
        ///
        /// We also process the file once on startup in case it landed
        /// before the watcher was wired (race: launcher writes the
        /// file, then SB starts, then the DLL boots — without this we'd
        /// miss the trigger).
        /// </summary>
        private static void StartTriggerWatcher()
        {
            try
            {
                var folder = Settings.SettingsManager.Instance.DataFolder;
                if (string.IsNullOrEmpty(folder)) return;
                try { System.IO.Directory.CreateDirectory(folder); } catch { }

                // Handle a trigger that was dropped before the DLL booted.
                var existing = System.IO.Path.Combine(folder, TriggerFileName);
                if (System.IO.File.Exists(existing))
                {
                    HandleTriggerAndDelete(existing);
                }

                _triggerWatcher = new System.IO.FileSystemWatcher(folder, TriggerFileName)
                {
                    NotifyFilter = System.IO.NotifyFilters.FileName |
                                   System.IO.NotifyFilters.CreationTime |
                                   System.IO.NotifyFilters.LastWrite,
                    EnableRaisingEvents = true
                };
                _triggerWatcher.Created += (_, evt) => HandleTriggerAndDelete(evt.FullPath);
                _triggerWatcher.Changed += (_, evt) => HandleTriggerAndDelete(evt.FullPath);
            }
            catch (Exception ex)
            {
                Util.ErrorLog.Write("StartTriggerWatcher", ex);
            }
        }

        private static void HandleTriggerAndDelete(string path)
        {
            // Hop to the UI thread before opening Settings — the
            // FileSystemWatcher fires on a thread-pool thread.
            try
            {
                _dispatcher?.BeginInvoke(new Action(() =>
                {
                    try { OpenSettings(); }
                    catch (Exception ex) { Util.ErrorLog.Write("Trigger.OpenSettings", ex); }
                }));
            }
            catch { /* dispatcher gone, fall through to cleanup */ }
            // Delete the trigger so we don't refire on every Changed
            // notification. Retry a couple of times in case the
            // launcher's write handle isn't closed yet.
            for (int i = 0; i < 3; i++)
            {
                try
                {
                    if (System.IO.File.Exists(path)) System.IO.File.Delete(path);
                    break;
                }
                catch
                {
                    try { System.Threading.Thread.Sleep(80); } catch { }
                }
            }
        }

        private static void OnUpdateAvailable(object sender, UpdateAvailableEventArgs e)
        {
            // Tray operations must run on the UI thread.
            _dispatcher?.BeginInvoke(new Action(() => _tray?.NotifyUpdateAvailable(e.Release)));
        }

        private static void OnUpdateDownloaded(object sender, UpdateAvailableEventArgs e)
        {
            _dispatcher?.BeginInvoke(new Action(() => _tray?.NotifyUpdateDownloaded(e.Release)));
        }

        public static void OpenSettings()
        {
            EnsureStarted(null);
            if (_dispatcher == null)
            {
                Util.ErrorLog.Write("LoadoutHost.OpenSettings", "dispatcher is null after EnsureStarted");
                return;
            }
            _dispatcher.BeginInvoke(new Action(() =>
            {
                // Each phase logs separately so the stack trace tells us EXACTLY
                // which call threw, not just "something in OpenSettings died".
                Loadout.UI.SettingsWindow win = null;
                try { win = Loadout.UI.SettingsWindow.GetOrCreate(); }
                catch (Exception ex) { Util.ErrorLog.Write("LoadoutHost.OpenSettings.GetOrCreate", ex); return; }

                try { win.Show(); }
                catch (Exception ex) { Util.ErrorLog.Write("LoadoutHost.OpenSettings.Show", ex); return; }

                try { win.Activate(); win.Topmost = true; win.Topmost = false; }
                catch (Exception ex) { Util.ErrorLog.Write("LoadoutHost.OpenSettings.Activate", ex); }
            }));
        }

        public static void OpenOnboarding()
        {
            EnsureStarted(null);
            _dispatcher?.BeginInvoke(new Action(() =>
            {
                try
                {
                    var win = new OnboardingWindow();
                    win.Show();
                    win.Activate();
                    win.Topmost = true;
                    win.Topmost = false;
                }
                catch (Exception ex)
                {
                    Util.ErrorLog.Write("LoadoutHost.OpenOnboarding", ex);
                }
            }));
        }

        // Funnels bus events into the regular dispatcher so modules see them
        // through OnEvent instead of having to subscribe to the bus separately.
        // Returns null because we don't owe the sending client a synchronous
        // reply for these notification-style messages.
        private static Bus.BusMessage BridgeBusToDispatcher(string fromClient, Bus.BusMessage incoming)
        {
            try
            {
                var args = new System.Collections.Generic.Dictionary<string, object>();
                if (incoming.Data is Newtonsoft.Json.Linq.JObject obj)
                    foreach (var p in obj.Properties())
                        args[p.Name] = p.Value?.ToObject<object>();
                Sb.SbEventDispatcher.Instance.DispatchEvent(incoming.Kind, args);
            }
            catch (Exception ex) { Util.ErrorLog.Write("BridgeBus", ex); }
            return null;
        }

        public static void Shutdown()
        {
            lock (_gate)
            {
                if (!_started) return;

                // Order matters here:
                //   1. Stop background timers so they don't fire mid-teardown.
                //   2. Dispose the tray icon ON THE UI THREAD (NotifyIcon's
                //      cleanup must run on the thread that owns the message
                //      pump, otherwise we get cross-thread access faults when
                //      the OS tries to remove the tray window).
                //   3. Stop the bus.
                //   4. Shut down the dispatcher.
                try { UpdateChecker.Instance.Stop(); } catch { }
                try { _panelBridge?.Dispose(); _panelBridge = null; } catch { }
                try { _triggerWatcher?.Dispose(); _triggerWatcher = null; } catch { }

                try
                {
                    var d = _dispatcher;
                    if (d != null && !d.HasShutdownStarted)
                    {
                        // Synchronous so we don't return before the icon is
                        // gone from the tray. If the dispatcher is already
                        // dead, fall back to a best-effort dispose on this
                        // thread - worst case we leak a ghost icon for a few
                        // seconds until Windows reaps it, which beats crashing.
                        try
                        {
                            d.Invoke(new Action(() => { try { _tray?.Dispose(); _tray = null; } catch { } }),
                                     DispatcherPriority.Send,
                                     System.Threading.CancellationToken.None,
                                     TimeSpan.FromSeconds(2));
                        }
                        catch { try { _tray?.Dispose(); _tray = null; } catch { } }
                    }
                    else
                    {
                        try { _tray?.Dispose(); _tray = null; } catch { }
                    }
                }
                catch { /* swallow */ }

                try { Bus.AquiloBus.Instance.Stop(); } catch { }

                try { _dispatcher?.BeginInvokeShutdown(DispatcherPriority.Normal); } catch { }
                _started = false;
            }
        }
    }
}
