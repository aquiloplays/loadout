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
                Bus.AquiloBus.Instance.Start();

                // Bridge select bus messages into the event dispatcher so
                // modules can react to rotation widget responses (etc.) via
                // their normal OnEvent path. Add new prefixes here when
                // future products need to push events into Loadout's modules.
                Bus.AquiloBus.Instance.RegisterHandler("rotation.song.accepted", BridgeBusToDispatcher);
                Bus.AquiloBus.Instance.RegisterHandler("rotation.song.rejected", BridgeBusToDispatcher);

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
                UpdateChecker.Instance.Start();

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

        private static void OnUpdateAvailable(object sender, UpdateAvailableEventArgs e)
        {
            // Tray operations must run on the UI thread.
            _dispatcher?.BeginInvoke(new Action(() => _tray?.NotifyUpdateAvailable(e.Release)));
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
