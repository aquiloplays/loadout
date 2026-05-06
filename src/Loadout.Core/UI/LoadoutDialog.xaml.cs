using System.Windows;

namespace Loadout.UI
{
    /// <summary>
    /// Loadout-themed replacement for <see cref="System.Windows.MessageBox"/>.
    /// The system MessageBox renders with the OS's light-mode style; this
    /// one uses the same XAML chrome as Settings + Onboarding so popups
    /// actually look like they belong to the app.
    ///
    /// Same call shape as MessageBox.Show: pass an owner, body text, and
    /// optional title + buttons; get a <see cref="MessageBoxResult"/> back.
    /// </summary>
    public partial class LoadoutDialog : Window
    {
        public MessageBoxResult Result { get; private set; } = MessageBoxResult.None;

        public LoadoutDialog()
        {
            InitializeComponent();
        }

        public static MessageBoxResult Show(Window owner, string body)
            => Show(owner, body, "Loadout", MessageBoxButton.OK, MessageBoxImage.None);

        public static MessageBoxResult Show(Window owner, string body, string title)
            => Show(owner, body, title, MessageBoxButton.OK, MessageBoxImage.None);

        public static MessageBoxResult Show(Window owner, string body, string title, MessageBoxButton buttons)
            => Show(owner, body, title, buttons, MessageBoxImage.None);

        public static MessageBoxResult Show(Window owner, string body, string title, MessageBoxButton buttons, MessageBoxImage icon)
        {
            var dlg = new LoadoutDialog
            {
                Owner = owner,
                Title = "Loadout"
            };
            dlg.TxtTitle.Text = title ?? "";
            dlg.TxtBody.Text  = body  ?? "";

            // Kicker line — a tiny coloured label (WARNING / ERROR /
            // INFO) that mimics the iconography of the system MessageBox
            // without needing a full SVG icon.
            switch (icon)
            {
                case MessageBoxImage.Warning:
                    dlg.TxtKicker.Text = "WARNING";
                    dlg.TxtKicker.Foreground = (System.Windows.Media.Brush)dlg.FindResource("Brush.Warn");
                    dlg.Kicker.Visibility = Visibility.Visible;
                    break;
                case MessageBoxImage.Error:   // alias of Stop / Hand
                    dlg.TxtKicker.Text = "ERROR";
                    dlg.TxtKicker.Foreground = (System.Windows.Media.Brush)dlg.FindResource("Brush.Error");
                    dlg.Kicker.Visibility = Visibility.Visible;
                    break;
                case MessageBoxImage.Question:
                    dlg.TxtKicker.Text = "CONFIRM";
                    dlg.TxtKicker.Foreground = (System.Windows.Media.Brush)dlg.FindResource("Brush.Accent");
                    dlg.Kicker.Visibility = Visibility.Visible;
                    break;
                case MessageBoxImage.Information:
                    dlg.TxtKicker.Text = "INFO";
                    dlg.TxtKicker.Foreground = (System.Windows.Media.Brush)dlg.FindResource("Brush.Accent");
                    dlg.Kicker.Visibility = Visibility.Visible;
                    break;
            }

            // Button visibility + labels match the system MessageBox.
            switch (buttons)
            {
                case MessageBoxButton.OKCancel:
                    dlg.BtnCancel.Visibility = Visibility.Visible;
                    dlg.BtnCancel.Content = "Cancel";
                    dlg.BtnOk.Content = "OK";
                    break;
                case MessageBoxButton.YesNo:
                    dlg.BtnCancel.Visibility = Visibility.Visible;
                    dlg.BtnCancel.Content = "No";
                    dlg.BtnOk.Content = "Yes";
                    break;
                case MessageBoxButton.YesNoCancel:
                    // For YesNoCancel we render OK = Yes, Cancel = No,
                    // and the X-close button counts as Cancel. Two-button
                    // layout in three-state semantics is a reasonable
                    // compromise; full three-button can come later.
                    dlg.BtnCancel.Visibility = Visibility.Visible;
                    dlg.BtnCancel.Content = "No";
                    dlg.BtnOk.Content = "Yes";
                    break;
                case MessageBoxButton.OK:
                default:
                    dlg.BtnCancel.Visibility = Visibility.Collapsed;
                    dlg.BtnOk.Content = "OK";
                    break;
            }

            dlg.ShowDialog();
            return dlg.Result == MessageBoxResult.None ? MessageBoxResult.Cancel : dlg.Result;
        }

        private void BtnOk_Click(object sender, RoutedEventArgs e)
        {
            Result = (BtnOk.Content?.ToString() == "Yes") ? MessageBoxResult.Yes : MessageBoxResult.OK;
            Close();
        }

        private void BtnCancel_Click(object sender, RoutedEventArgs e)
        {
            Result = (BtnCancel.Content?.ToString() == "No") ? MessageBoxResult.No : MessageBoxResult.Cancel;
            Close();
        }
    }
}
