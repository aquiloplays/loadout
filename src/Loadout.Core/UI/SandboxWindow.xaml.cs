using System;
using System.Text;
using System.Windows;
using System.Windows.Input;

namespace Loadout.UI
{
    /// <summary>
    /// Input sandbox window — receives keystrokes / clicks / wheel
    /// events and logs them. Lets a streamer verify a Game Interactions
    /// binding by clicking this window then firing the action via
    /// "Test selected" in Settings, without pointing at a real game.
    ///
    /// The window has no real outputs — it's purely a focus-receiver.
    /// We hook KeyDown / KeyUp on the WPF event model (not raw input)
    /// because that's what reaches the focused window via Windows'
    /// message pump, which is the same path SendInput takes. So what
    /// the sandbox sees IS what the game would see.
    /// </summary>
    public partial class SandboxWindow : Window
    {
        private readonly StringBuilder _log = new StringBuilder();
        private const int MaxLogChars = 8_000;

        public SandboxWindow()
        {
            InitializeComponent();
            Loaded += (_, __) =>
            {
                Activate();
                Focus();
                Append("[" + Now() + "] Sandbox ready - fire an action and watch the log.");
            };
            Activated   += (_, __) => UpdateFocusHint(true);
            Deactivated += (_, __) => UpdateFocusHint(false);
        }

        private void UpdateFocusHint(bool focused)
        {
            if (TxtFocusHint == null) return;
            TxtFocusHint.Text = focused
                ? "Focused — SendInput delivers keys here."
                : "Not focused — click the window to receive keys.";
        }

        private void OnKeyDown(object sender, KeyEventArgs e)
        {
            var mods = Keyboard.Modifiers;
            var parts = new System.Collections.Generic.List<string>();
            if ((mods & ModifierKeys.Control) != 0) parts.Add("Ctrl");
            if ((mods & ModifierKeys.Shift)   != 0) parts.Add("Shift");
            if ((mods & ModifierKeys.Alt)     != 0) parts.Add("Alt");
            if ((mods & ModifierKeys.Windows) != 0) parts.Add("Win");
            parts.Add(e.Key.ToString());
            Append("[" + Now() + "] KeyDown " + string.Join("+", parts) +
                   "  (vk=0x" + KeyInterop.VirtualKeyFromKey(e.Key).ToString("X2") + ")");
        }

        private void OnKeyUp(object sender, KeyEventArgs e)
        {
            Append("[" + Now() + "] KeyUp   " + e.Key);
        }

        private void OnMouseDown(object sender, MouseButtonEventArgs e)
        {
            Append("[" + Now() + "] Mouse   " + e.ChangedButton + " (" + e.ClickCount + "x)");
            Focus();   // ensure subsequent keys come to us
        }

        private void OnMouseWheel(object sender, MouseWheelEventArgs e)
        {
            Append("[" + Now() + "] Wheel   delta=" + e.Delta);
        }

        private void BtnClear_Click(object sender, RoutedEventArgs e)
        {
            _log.Clear();
            LogText.Text = "";
        }

        private void Append(string line)
        {
            _log.AppendLine(line);
            // Trim from the front to keep the buffer bounded.
            if (_log.Length > MaxLogChars)
                _log.Remove(0, _log.Length - MaxLogChars);
            LogText.Text = _log.ToString();
            LogScroll.ScrollToEnd();
        }

        private static string Now() => DateTime.Now.ToString("HH:mm:ss.fff");
    }
}
