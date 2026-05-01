using System;
using System.Collections.ObjectModel;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using Loadout.Bus;
using Loadout.Identity;
using Loadout.Patreon;
using Loadout.Settings;
using Loadout.Updates;

namespace Loadout.UI
{
    public partial class SettingsWindow : Window
    {
        private static SettingsWindow _instance;

        /// <summary>
        /// Singleton accessor — opening Settings repeatedly should focus the existing window
        /// rather than spawn duplicates.
        /// </summary>
        public static SettingsWindow GetOrCreate()
        {
            if (_instance == null || !_instance.IsLoaded)
                _instance = new SettingsWindow();
            return _instance;
        }

        // ObservableCollections are bound to the DataGrids; mutations are visible
        // in the UI immediately, and we copy back to settings on Save.
        private readonly ObservableCollection<Counter> _counters = new ObservableCollection<Counter>();
        private readonly ObservableCollection<PatreonSupporter> _supporters = new ObservableCollection<PatreonSupporter>();

        // Plays the window-open fade + slide-up storyboard from Styles.xaml.
        private void Window_Loaded(object sender, RoutedEventArgs e)
        {
            try
            {
                var sb = (System.Windows.Media.Animation.Storyboard)FindResource("WindowFadeIn");
                if (sb != null) sb.Begin(this);
            }
            catch { Opacity = 1; }
        }

        private SettingsWindow()
        {
            InitializeComponent();
            LoadFromSettings();
            RefreshVersionLine();
            RefreshPendingLinks();
            RefreshPatreonState();
            BindCountersAndCheckIn();

            PatreonClient.Instance.StateChanged += OnPatreonStateChanged;
            Closed += (_, __) => {
                PatreonClient.Instance.StateChanged -= OnPatreonStateChanged;
                _instance = null;
            };
        }

        private void BindCountersAndCheckIn()
        {
            var s = SettingsManager.Instance.Current;

            _counters.Clear();
            foreach (var c in s.Counters.Counters) _counters.Add(c);
            GrdCounters.ItemsSource = _counters;

            _supporters.Clear();
            foreach (var p in s.PatreonSupporters.Supporters) _supporters.Add(p);
            GrdSupporters.ItemsSource = _supporters;

            TxtCheckInReward.Text   = s.CheckIn.TwitchRewardName ?? "";
            TxtCheckInCommand.Text  = s.CheckIn.CrossPlatformCommand ?? "";
            TxtCheckInCooldown.Text = s.CheckIn.CooldownPerUserHours.ToString();
            TxtCheckInRotateSec.Text = s.CheckIn.RotateIntervalSec.ToString();
            TxtCheckInStats.Text    = string.Join(",", s.CheckIn.RotatingStats ?? new System.Collections.Generic.List<string>());

            ChkSubFlair.IsChecked     = s.CheckIn.ShowSubFlair;
            ChkVipModFlair.IsChecked  = s.CheckIn.ShowVipModFlair;
            ChkPatreonFlair.IsChecked = s.CheckIn.ShowPatreonFlair;

            switch ((s.CheckIn.AnimationTheme ?? "shimmer").ToLowerInvariant())
            {
                case "bounce":  CmbCheckInTheme.SelectedIndex = 1; break;
                case "glow":    CmbCheckInTheme.SelectedIndex = 2; break;
                case "minimal": CmbCheckInTheme.SelectedIndex = 3; break;
                default:        CmbCheckInTheme.SelectedIndex = 0; break;
            }
        }

        // -------------------- Counter buttons --------------------

        private void BtnCounterAdd_Click(object sender, RoutedEventArgs e)
        {
            _counters.Add(new Counter { Name = "newcounter", Display = "New counter", Value = 0 });
            GrdCounters.SelectedItem = _counters[_counters.Count - 1];
        }

        private void BtnCounterRemove_Click(object sender, RoutedEventArgs e)
        {
            if (GrdCounters.SelectedItem is Counter c) _counters.Remove(c);
        }

        private void BtnCounterPlus_Click(object sender, RoutedEventArgs e)
        {
            if (GrdCounters.SelectedItem is Counter c) { c.Value++; GrdCounters.Items.Refresh(); PublishCounter(c); }
        }

        private void BtnCounterMinus_Click(object sender, RoutedEventArgs e)
        {
            if (GrdCounters.SelectedItem is Counter c) { c.Value--; GrdCounters.Items.Refresh(); PublishCounter(c); }
        }

        private void BtnCounterReset_Click(object sender, RoutedEventArgs e)
        {
            if (GrdCounters.SelectedItem is Counter c) { c.Value = 0; GrdCounters.Items.Refresh(); PublishCounter(c); }
        }

        private static void PublishCounter(Counter c)
        {
            AquiloBus.Instance.Publish("counter.updated", new
            {
                name    = c.Name,
                display = c.Display,
                value   = c.Value,
                by      = "settings-ui"
            });
        }

        // -------------------- Supporter buttons --------------------

        private void BtnSupporterAdd_Click(object sender, RoutedEventArgs e)
        {
            _supporters.Add(new PatreonSupporter { Platform = "twitch", Handle = "username", Tier = "tier2" });
            GrdSupporters.SelectedItem = _supporters[_supporters.Count - 1];
        }

        private void BtnSupporterRemove_Click(object sender, RoutedEventArgs e)
        {
            if (GrdSupporters.SelectedItem is PatreonSupporter p) _supporters.Remove(p);
        }

        // -------------------- Test check-in --------------------

        private void BtnCheckInTest_Click(object sender, RoutedEventArgs e)
        {
            // Synthesize a payload identical in shape to the real one so an
            // overlay developer can iterate without poking SB.
            var s = SettingsManager.Instance.Current;
            AquiloBus.Instance.Publish("checkin.shown", new
            {
                user           = s.BroadcasterName ?? "test_user",
                userId         = "test",
                platform       = "twitch",
                role           = "sub",
                subTier        = "1000",
                patreonTier    = (string)null,
                pfp            = (string)null,
                animationTheme = s.CheckIn.AnimationTheme,
                showFlairs     = new { sub = s.CheckIn.ShowSubFlair, vipMod = s.CheckIn.ShowVipModFlair, patreon = s.CheckIn.ShowPatreonFlair },
                stats          = new object[]
                {
                    new { kind = "uptime",         label = "Uptime",   value = "1:23:45" },
                    new { kind = "viewers",        label = "Viewers",  value = "127" },
                    new { kind = "counter",        label = "Deaths",   value = "12" }
                },
                rotateSeconds  = s.CheckIn.RotateIntervalSec,
                source         = "test",
                ts             = DateTime.UtcNow
            });
            TxtSavedHint.Text = "Test event published.";
        }

        private void OnPatreonStateChanged(object sender, PatreonState e)
        {
            // The event can fire on a background thread; marshal back.
            Dispatcher.BeginInvoke(new Action(RefreshPatreonState));
        }

        private void RefreshPatreonState()
        {
            var s = PatreonClient.Instance.Current;
            TxtPatreonTier.Text = "Tier: " + Entitlements.CurrentTierDisplay();
            TxtPatreonName.Text = s.SignedIn && !string.IsNullOrEmpty(s.UserName)
                ? "Connected as " + s.UserName + (string.IsNullOrEmpty(s.Email) ? "" : " (" + s.Email + ")")
                : "Not connected.";
            TxtPatreonReason.Text = s.SignedIn && !string.IsNullOrEmpty(s.Reason) && s.Reason != "ok"
                ? "Status: " + s.Reason
                : "";

            BtnPatreonConnect.Visibility = s.SignedIn ? Visibility.Collapsed : Visibility.Visible;
            BtnPatreonRefresh.Visibility = s.SignedIn ? Visibility.Visible : Visibility.Collapsed;
            BtnPatreonSignOut.Visibility = s.SignedIn ? Visibility.Visible : Visibility.Collapsed;

            // Build the feature list with check / lock indicators.
            LstFeatures.Items.Clear();
            foreach (Feature f in Enum.GetValues(typeof(Feature)))
            {
                var unlocked = Entitlements.IsUnlocked(f);
                var prefix = unlocked ? "  ✓  " : "  🔒  ";
                var line = new TextBlock
                {
                    Text = prefix + f,
                    Margin = new Thickness(0, 2, 0, 2),
                    Foreground = unlocked
                        ? (Brush)FindResource("Brush.Fg.Primary")
                        : (Brush)FindResource("Brush.Fg.Muted")
                };
                if (!unlocked) line.ToolTip = Entitlements.GetLockReason(f);
                LstFeatures.Items.Add(line);
            }
        }

        private async void BtnPatreonConnect_Click(object sender, RoutedEventArgs e)
        {
            try
            {
                BtnPatreonConnect.IsEnabled = false;
                TxtPatreonReason.Text = "Opening browser… complete sign-in there.";
                await PatreonClient.Instance.StartSignInAsync();
            }
            catch (Exception ex)
            {
                TxtPatreonReason.Text = "Sign-in failed: " + ex.Message;
            }
            finally
            {
                BtnPatreonConnect.IsEnabled = true;
                RefreshPatreonState();
            }
        }

        private async void BtnPatreonRefresh_Click(object sender, RoutedEventArgs e)
        {
            BtnPatreonRefresh.IsEnabled = false;
            try { await PatreonClient.Instance.RefreshEntitlementAsync(); }
            finally { BtnPatreonRefresh.IsEnabled = true; RefreshPatreonState(); }
        }

        private void BtnPatreonSignOut_Click(object sender, RoutedEventArgs e)
        {
            PatreonClient.Instance.SignOut();
            RefreshPatreonState();
        }

        private void LoadFromSettings()
        {
            var s = SettingsManager.Instance.Current;
            TxtBroadcaster.Text  = s.BroadcasterName ?? "";

            ChkTwitch.IsChecked  = s.Platforms.Twitch;
            ChkTikTok.IsChecked  = s.Platforms.TikTok;
            ChkYouTube.IsChecked = s.Platforms.YouTube;
            ChkKick.IsChecked    = s.Platforms.Kick;

            CmbChannel.SelectedIndex = string.Equals(s.Updates.Channel, "beta", StringComparison.OrdinalIgnoreCase) ? 1 : 0;

            ModInfo.IsChecked     = s.Modules.InfoCommands;
            ModWelcomes.IsChecked = s.Modules.ContextWelcomes;
            ModLoyalty.IsChecked  = s.Modules.LoyaltyWallet;
            ModAlerts.IsChecked   = s.Modules.Alerts;
            ModTimers.IsChecked   = s.Modules.TimedMessages;
            ModAi.IsChecked       = s.Modules.AiShoutouts;
            ModHype.IsChecked     = s.Modules.TikTokHypeTrain;
            ModRecap.IsChecked    = s.Modules.StreamRecap;
            ModDiscord.IsChecked  = s.Modules.DiscordLiveStatus;
            ModWebhook.IsChecked  = s.Modules.WebhookInbox;
            ModMod.IsChecked      = s.Modules.Moderation;
            ModFun.IsChecked      = s.Modules.Fun;
            ModGoals.IsChecked    = s.Modules.Goals;

            TxtDiscordWebhook.Text  = s.Discord.LiveStatusWebhook ?? "";
            TxtDiscordRecap.Text    = s.Discord.RecapWebhook ?? "";
            TxtDiscordTemplate.Text = s.Discord.GoLiveTemplate ?? "";

            switch ((s.Ai.Provider ?? "anthropic").ToLowerInvariant())
            {
                case "openai": CmbAiProvider.SelectedIndex = 1; break;
                case "none":   CmbAiProvider.SelectedIndex = 2; break;
                default:       CmbAiProvider.SelectedIndex = 0; break;
            }
            TxtAiKey.Text   = s.Ai.ApiKey ?? "";
            TxtAiModel.Text = s.Ai.Model ?? "";

            TxtWebhookPort.Text   = s.Webhooks.Port.ToString();
            TxtWebhookSecret.Text = s.Webhooks.SharedSecret ?? "";
        }

        private void RefreshVersionLine()
        {
            var s = SettingsManager.Instance.Current;
            var lastChecked = s.Updates.LastCheckedUtc == DateTime.MinValue
                ? "never"
                : s.Updates.LastCheckedUtc.ToLocalTime().ToString("g");
            TxtVersionLine.Text = $"Version {s.SuiteVersion} — channel: {s.Updates.Channel} — last checked: {lastChecked}";
        }

        private void RefreshPendingLinks()
        {
            var pending = IdentityLinker.Instance.PendingRequests();
            TxtPendingLinks.Text = pending.Count == 0
                ? "No pending requests."
                : string.Join("\n", pending.Select(r =>
                    $"• {r.SourcePlatform.ToShortName()}:{r.SourceUser} ↔ {r.TargetPlatform.ToShortName()}:{r.TargetUser} (id {r.Id.Substring(0, 8)})"));
        }

        private void BtnSave_Click(object sender, RoutedEventArgs e)
        {
            SettingsManager.Instance.Mutate(s =>
            {
                s.BroadcasterName = (TxtBroadcaster.Text ?? "").Trim();

                s.Platforms.Twitch  = ChkTwitch.IsChecked  == true;
                s.Platforms.TikTok  = ChkTikTok.IsChecked  == true;
                s.Platforms.YouTube = ChkYouTube.IsChecked == true;
                s.Platforms.Kick    = ChkKick.IsChecked    == true;

                s.Updates.Channel = ((ComboBoxItem)CmbChannel.SelectedItem)?.Tag?.ToString() ?? "stable";

                s.Modules.InfoCommands     = ModInfo.IsChecked == true;
                s.Modules.ContextWelcomes  = ModWelcomes.IsChecked == true;
                s.Modules.LoyaltyWallet    = ModLoyalty.IsChecked == true;
                s.Modules.Alerts           = ModAlerts.IsChecked == true;
                s.Modules.TimedMessages    = ModTimers.IsChecked == true;
                s.Modules.AiShoutouts      = ModAi.IsChecked == true;
                s.Modules.TikTokHypeTrain  = ModHype.IsChecked == true;
                s.Modules.StreamRecap      = ModRecap.IsChecked == true;
                s.Modules.DiscordLiveStatus = ModDiscord.IsChecked == true;
                s.Modules.WebhookInbox     = ModWebhook.IsChecked == true;
                s.Modules.Moderation       = ModMod.IsChecked == true;
                s.Modules.Fun              = ModFun.IsChecked == true;
                s.Modules.Goals            = ModGoals.IsChecked == true;

                s.Discord.LiveStatusWebhook = (TxtDiscordWebhook.Text ?? "").Trim();
                s.Discord.RecapWebhook      = (TxtDiscordRecap.Text ?? "").Trim();
                s.Discord.GoLiveTemplate    = TxtDiscordTemplate.Text ?? s.Discord.GoLiveTemplate;

                s.Ai.Provider = ((ComboBoxItem)CmbAiProvider.SelectedItem)?.Tag?.ToString() ?? "anthropic";
                s.Ai.ApiKey   = (TxtAiKey.Text ?? "").Trim();
                s.Ai.Model    = (TxtAiModel.Text ?? "").Trim();

                if (int.TryParse(TxtWebhookPort.Text, out var port) && port > 0 && port < 65536)
                    s.Webhooks.Port = port;
                s.Webhooks.SharedSecret = (TxtWebhookSecret.Text ?? "").Trim();

                // Counters: replace the persisted list with the edited collection.
                s.Counters.Counters = _counters.ToList();

                // Patreon supporters: same.
                s.PatreonSupporters.Supporters = _supporters.ToList();

                // Check-In fields.
                s.CheckIn.TwitchRewardName     = (TxtCheckInReward.Text   ?? "").Trim();
                s.CheckIn.CrossPlatformCommand = (TxtCheckInCommand.Text  ?? "").Trim();
                if (int.TryParse(TxtCheckInCooldown.Text, out var cdh) && cdh >= 0)
                    s.CheckIn.CooldownPerUserHours = cdh;
                if (int.TryParse(TxtCheckInRotateSec.Text, out var rsec) && rsec > 0)
                    s.CheckIn.RotateIntervalSec = rsec;
                s.CheckIn.AnimationTheme = ((ComboBoxItem)CmbCheckInTheme.SelectedItem)?.Tag?.ToString() ?? "shimmer";
                s.CheckIn.ShowSubFlair     = ChkSubFlair.IsChecked     == true;
                s.CheckIn.ShowVipModFlair  = ChkVipModFlair.IsChecked  == true;
                s.CheckIn.ShowPatreonFlair = ChkPatreonFlair.IsChecked == true;
                s.CheckIn.RotatingStats = (TxtCheckInStats.Text ?? "")
                    .Split(',')
                    .Select(x => x.Trim())
                    .Where(x => !string.IsNullOrEmpty(x))
                    .ToList();
            });
            SettingsManager.Instance.SaveNow();
            TxtSavedHint.Text = "Saved at " + DateTime.Now.ToString("HH:mm:ss");
        }

        private void BtnClose_Click(object sender, RoutedEventArgs e) => Close();

        private void BtnReonboard_Click(object sender, RoutedEventArgs e)
        {
            new OnboardingWindow().Show();
            Close();
        }

        private async void BtnCheckUpdate_Click(object sender, RoutedEventArgs e)
        {
            TxtVersionLine.Text = "Checking for updates…";
            var result = await UpdateChecker.Instance.CheckNowAsync();
            RefreshVersionLine();
            if (result == UpdateCheckResult.NewerAvailable)
                TxtSavedHint.Text = "Update available — see tray icon or release page.";
            else if (result == UpdateCheckResult.UpToDate)
                TxtSavedHint.Text = "You're on the latest version.";
            else
                TxtSavedHint.Text = "Update check failed (" + result + ").";
        }
    }
}
