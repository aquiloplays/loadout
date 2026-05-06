using System;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;

namespace Loadout.UI
{
    /// <summary>
    /// Applies Windows' built-in dark mode hint to a WPF window so the
    /// non-client area (title bar, system menu, close/min/max buttons)
    /// renders dark instead of fighting our otherwise-dark XAML chrome.
    ///
    /// Background: WPF doesn't ship a dark-mode title bar option, but the
    /// DWM exposes <c>DWMWA_USE_IMMERSIVE_DARK_MODE</c> on Windows 10 1809+
    /// to flip the chrome dark. The attribute number changed once between
    /// builds (19 on early Win10, 20 on later Win10 + Win11), so we try
    /// both — only one succeeds, the other is a silent no-op.
    ///
    /// Usage:
    ///   public override void OnSourceInitialized(EventArgs e) {
    ///     base.OnSourceInitialized(e);
    ///     Loadout.UI.WindowChrome.ApplyDarkTitleBar(this);
    ///   }
    ///
    /// Or: subscribe to <see cref="EnableForApp"/> at app startup once and
    /// every Loadout-owned Window picks it up automatically.
    /// </summary>
    public static class WindowChrome
    {
        // DWM attribute IDs. 20 is the modern (Win10 2004+ / Win11) one;
        // 19 was used between Win10 1809 and 1909. Setting an unknown
        // attribute returns E_INVALIDARG, which is fine — we just try
        // both and ignore failures.
        private const int DWMWA_USE_IMMERSIVE_DARK_MODE         = 20;
        private const int DWMWA_USE_IMMERSIVE_DARK_MODE_LEGACY  = 19;

        [DllImport("dwmapi.dll", PreserveSig = true)]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

        public static void ApplyDarkTitleBar(Window window)
        {
            if (window == null) return;
            var hwnd = new WindowInteropHelper(window).EnsureHandle();
            if (hwnd == IntPtr.Zero) return;
            try
            {
                int useDark = 1;
                // Try the current attribute first, fall back to the legacy
                // one if the OS doesn't recognize it (Win10 1809-1909).
                if (DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, ref useDark, sizeof(int)) != 0)
                    DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE_LEGACY, ref useDark, sizeof(int));
            }
            catch { /* DWM unavailable or pre-1809 — title bar stays light, oh well */ }
        }

        /// <summary>
        /// Hooks the application's window-creation pipeline so every WPF
        /// window opened by this app gets the dark title bar applied
        /// automatically. Call once at app startup.
        /// </summary>
        public static void EnableForApp()
        {
            EventManager.RegisterClassHandler(
                typeof(Window),
                FrameworkElement.LoadedEvent,
                new RoutedEventHandler((sender, e) =>
                {
                    if (sender is Window w) ApplyDarkTitleBar(w);
                }));
        }
    }
}
