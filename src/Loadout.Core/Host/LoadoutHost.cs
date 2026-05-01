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

                _started = true;
            }
        }

        private static void OnUpdateAvailable(object sender, UpdateAvailableEventArgs e)
        {
            // Tray operations must run on the UI thread.
            _dispatcher?.BeginInvoke(new Action(() => _tray?.NotifyUpdateAvailable(e.Release)));
        }

        public static void OpenSettings()
        {
            EnsureStarted(null);
            _dispatcher?.BeginInvoke(new Action(() =>
            {
                var win = SettingsWindow.GetOrCreate();
                win.Show();
                win.Activate();
                win.Topmost = true;
                win.Topmost = false;
            }));
        }

        public static void OpenOnboarding()
        {
            EnsureStarted(null);
            _dispatcher?.BeginInvoke(new Action(() =>
            {
                var win = new OnboardingWindow();
                win.Show();
                win.Activate();
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
                try { UpdateChecker.Instance.Stop(); } catch { }
                _dispatcher?.BeginInvokeShutdown(DispatcherPriority.Normal);
                _started = false;
            }
        }
    }
}
